'use strict';
/*
 * LES COMPTES DE LA MAISON.
 *
 * ---- ce qui se joue ici ----
 *
 * Le surplus retirable, c'est « ce que contient le coffre moins ce qu'on
 * doit ». Sortir un compte du « doit » le fait monter d'autant. C'est
 * legitime — les jetons de la maison sont deja a la maison — mais UNIQUEMENT
 * si ce compte ne peut plus retirer.
 *
 * Sinon les memes jetons sont comptes deux fois : une fois comme surplus que
 * le proprietaire peut sortir, une fois comme creance que le compte peut
 * sortir. Le coffre se retrouve court, et on l'apprend le jour ou un vrai
 * joueur ne peut plus retirer.
 *
 * Les deux moities sont donc testees ENSEMBLE. Un test qui ne verifierait que
 * l'exclusion validerait exactement le trou.
 */
const assert = require('assert');
const ethers = require('ethers');
const cfg = require('./config');
const MAISON = '0x960b8687d019c971eb483ad114df3f4fc5bcf0f0';
const AUTRE = '0x' + 'ab'.repeat(20);
cfg.COMPTES_MAISON = [MAISON];
const { Game } = require('./game');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, t, m) => { assert.ok(Math.abs(a - b) <= t, `${m} (${a} vs ${b})`); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
const J = '0x' + '11'.repeat(20);

// ================== 1. RECONNAITRE LE COMPTE
{
  const g = new Game();
  eq(g.estMaison(MAISON), true, 'l adresse configuree est reconnue');
  eq(g.estMaison(MAISON.toUpperCase()), true, 'en majuscules aussi — une adresse ne se compare pas a la casse');
  eq(g.estMaison(J), false, 'un joueur ordinaire ne l est pas');
  eq(g.estMaison(''), false, 'ni une chaine vide');
  eq(g.estMaison(null), false, 'ni rien du tout');
}

// ================== 2. LES DEUX MOITIES, ET ELLES SONT INDISSOCIABLES
/*
 * L'exclusion du « du » et le verrou de retrait ne se testent pas separement,
 * parce qu'ils ne se DEPLOIENT pas separement. Le danger n'est pas dans la
 * formule — a tout instant l'exclusion est juste — il est dans l'ORDRE DES
 * GESTES : le proprietaire lit « surplus 92 M » et le retire, le coffre tombe
 * a ce qu'on doit aux joueurs, et la fiche du compte maison porte toujours une
 * creance de 81 M que `requestWithdraw` ne saurait pas refuser.
 *
 * Ce bloc echoue si l'une des deux disparait.
 */
{
  const g = new Game();
  g._p(J).balance = WEI(1000000);
  const duAvant = f(g.totalOwed());

  g._p(MAISON).balance = WEI(9000000);
  const duApres = f(g.totalOwed());
  const b = g.owedBreakdown();

  eq(duApres, duAvant, 'MOITIE 1 : les jetons d un compte maison ne sont pas une dette');
  eq(f(b.maison), 9000000, 'et ils sont comptes a part, pour l affichage');
  eq(b.maisonN, 1, 'un seul compte concerne');

  const p = g._p(MAISON); p.hasDeposited = true;
  assert.throws(() => g.requestWithdraw(MAISON, '50000'), /do not withdraw/); n++;
  eq(f(p.balance), 9000000,
     'MOITIE 2 : et il ne peut pas les retirer. Sans ce refus, la moitie 1 ' +
     'annonce un surplus que la fiche peut encore reclamer');

  /* Un joueur ordinaire retire toujours : le verrou vise ce compte, pas le
     mecanisme. */
  const q = g._p(J); q.balance = WEI(9000000); q.hasDeposited = true;
  const avant = f(q.balance);
  g.requestWithdraw(J, '50000');
  pres(avant - f(q.balance), 50000, 0.01, 'un joueur ordinaire retire normalement');
}

// ================== 3. UN VIREMENT VERS UN JOUEUR SE CORRIGE TOUT SEUL
/*
 * Le compte maison peut envoyer des jetons — c'est meme sa raison d'etre.
 * Aucun trou : les jetons quittent un compte exclu pour un compte compte, donc
 * la dette monte du meme montant a l'instant ou ils arrivent. Le surplus
 * baisse tout seul, sans qu'on ait rien a ecrire.
 */
{
  const g = new Game();
  const p = g._p(MAISON); p.balance = WEI(9000000); p.hasDeposited = true;
  g._p(J).balance = WEI(0);
  const du0 = f(g.totalOwed());
  g.transfere(MAISON, J, '1000000');
  pres(f(g.totalOwed()) - du0, 1000000, 0.01,
       'un million envoye a un joueur devient un million de dette — immediatement');
  pres(f(g.owedBreakdown().maison), 8000000, 0.01, 'et la maison n en tient plus que huit');
}

// ================== 4. IL JOUE COMME TOUT LE MONDE
/* C'est sa raison d'etre : on ne teste pas une salle sans y jouer. Le reglage
   ne touche qu'a la comptabilite et au retrait, a rien d'autre. */
{
  const g = new Game();
  const p = g._p(MAISON);
  p.balance = WEI(9000000); p.hasDeposited = true;

  const av = f(p.balance);
  g.boutiqueAchat(MAISON, 'bois');
  ok(f(p.balance) < av, 'il peut ouvrir un coffre, et il est debite comme tout le monde');
  ok(Object.keys(p.objets).length > 0, 'et il recoit l objet');

  const r = g.transfere(MAISON, J, '20000');
  eq(r.vers, J.toLowerCase(), 'il peut envoyer des jetons a un joueur');

  const st = g.questState(MAISON);
  ok(Array.isArray(st) && st.length > 0, 'il a ses quetes du jour');
  ok(g.niveau(MAISON).niveau >= 0, 'et son niveau se calcule');
}

// ================== 5. LE PANNEAU LE DIT
/* Un chiffre de solvabilite qui monte de neuf millions sans explication ne
   vaut rien. L'exclusion doit se lire a cote du surplus. */
{
  const g = new Game();
  g._p(J).balance = WEI(1000000);
  g._p(MAISON).balance = WEI(9000000);
  const a = g.autonomie(WEI(50000000));
  eq(a.maisonN, 1, 'l administration recoit le nombre de comptes maison');
  eq(a.maison, 9000000, 'et ce qu ils tiennent, pour l afficher a cote du surplus');
  ok(a.surplus > 0, `le surplus au pire est calcule (${a.surplus})`);
  pres(a.surplus - a.surplusHorsMaison, 9000000, 0.01,
       'le second chiffre dit ce que vaudrait le surplus SANS cet argent — ' +
       'exactement le premier moins ce que la maison tient');

  /* Sans compte maison, la ligne n'a rien a dire. */
  const g2 = new Game();
  g2._p(J).balance = WEI(1000000);
  eq(g2.autonomie(WEI(50000000)).maisonN, 0, 'sans compte maison, rien a signaler');
  eq(g2.autonomie(WEI(50000000)).maison, 0, 'et rien a compter a part');

  /* LE CAS QUI JUSTIFIE LE SECOND CHIFFRE : le coffre ne tient QUE grace a
     l'argent de la maison. Le surplus affiche quatre-vingts millions et
     pourtant, sans cet argent, on ne pourrait pas payer les joueurs. C'est
     exactement ce qu'on decouvre trop tard si personne ne l'affiche. */
  const g5 = new Game();
  g5._p(J).balance = WEI(13500000);
  g5._p(MAISON).balance = WEI(81500000);
  const a5 = g5.autonomie(WEI(95000000));
  ok(a5.surplus > 79000000, `le surplus affiche ${Math.round(a5.surplus).toLocaleString('fr')}`);
  ok(a5.surplusHorsMaison < 0,
     `et pourtant, sans la maison, il manquerait ${Math.round(-a5.surplusHorsMaison).toLocaleString('fr')} ` +
     'pour payer les joueurs — le second chiffre existe pour ce cas-la');
}

// ================== 6. UNE CONFIGURATION SALE NE CASSE RIEN
{
  const garde = cfg.COMPTES_MAISON;
  cfg.COMPTES_MAISON = [];
  const g = new Game();
  eq(g.estMaison(MAISON), false, 'liste vide : plus aucun compte maison');
  g._p(MAISON).balance = WEI(9000000);
  eq(g.autonomie(WEI(50000000)).maisonN, 0, 'et plus rien n est signale a part');
  cfg.COMPTES_MAISON = garde;
}

// ================== 7. LE RENDEMENT QUE LA MAISON SE VERSE N'EST PAS UN DRAIN
/*
 * Le staking de la maison tourne en rond : elle se paie a elle-meme. Le
 * compter comme un cout quotidien donnait une autonomie de quelques jours
 * alors que RIEN ne quitte le coffre.
 */
{
  const g = new Game();
  const p = g._p(MAISON);
  p.stakes = [{ a: WEI(81390000), s: Date.now() - 86400000, u: Date.now() - 86400000 }];
  const q = g._p(J);
  q.stakes = [{ a: WEI(1000000), s: Date.now() - 86400000, u: Date.now() - 86400000 }];

  const a = g.autonomie(WEI(200000000));
  pres(a.maisonStaked, 81390000, 1, 'le panneau sait combien la maison a mise au staking');
  ok(a.rendementJour > a.rendementJoueurs,
     `le cout brut (${Math.round(a.rendementJour)}/j) depasse le cout reel (${Math.round(a.rendementJoueurs)}/j)`);
  const attendu = 1000000 * (cfg.STAKE_APR_BPS / 10000) / 365;
  pres(a.rendementJoueurs, attendu, 1,
       'le cout reel ne porte que sur le staking DES JOUEURS');
  ok(a.rendementJoueurs < a.rendementJour / 10,
     'ici la maison porte plus de neuf dixiemes du staking : sans cette separation, ' +
     'le panneau annoncait un drain quatre-vingts fois trop gros');
}

console.log(`maison.test.js : ${n} verifications OK`);
