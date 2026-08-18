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

// ================== 2. RIEN N'EST INVENTE : LE COMPTE EST CONSERVE
/*
 * La propriete qui compte. Le surplus doit monter EXACTEMENT de ce que tient
 * la maison — ni plus, ni moins. Plus, et on affiche de l'argent qui n'existe
 * pas ; moins, et le reglage ne sert a rien.
 */
{
  const g = new Game();
  g._p(J).balance = WEI(1000000);
  const duAvant = f(g.totalOwed());

  g._p(MAISON).balance = WEI(9000000);
  const duApres = f(g.totalOwed());
  const b = g.owedBreakdown();

  eq(duApres, duAvant, 'ajouter neuf millions sur un compte maison ne change PAS ce qu on doit');
  eq(f(b.maison), 9000000, 'et ces neuf millions sont comptes a part, en clair');
  eq(b.maisonN, 1, 'un seul compte concerne');

  /* Le meme montant sur un joueur ordinaire, lui, EST une dette. */
  const g2 = new Game();
  g2._p(J).balance = WEI(1000000);
  const d0 = f(g2.totalOwed());
  g2._p(AUTRE).balance = WEI(9000000);
  pres(f(g2.totalOwed()) - d0, 9000000, 0.01,
       'la meme somme sur un compte ordinaire monte bien la dette de neuf millions');
}

// ================== 3. L'AUTRE MOITIE : IL NE RETIRE PAS
{
  const g = new Game();
  const p = g._p(MAISON);
  p.balance = WEI(9000000); p.hasDeposited = true;
  assert.throws(() => g.requestWithdraw(MAISON, '50000'), /do not withdraw/); n++;
  eq(f(p.balance), 9000000, 'et le refus ne prend rien au passage');

  /* Un joueur ordinaire, lui, retire normalement : le verrou vise ce compte
     et pas le mecanisme. */
  const q = g._p(J);
  q.balance = WEI(9000000); q.hasDeposited = true;
  const avant = f(q.balance);
  g.requestWithdraw(J, '50000');
  pres(avant - f(q.balance), 50000, 0.01, 'un joueur ordinaire retire toujours');
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
  eq(a.maisonN, 1, 'l administration recoit le nombre de comptes exclus');
  eq(a.maison, 9000000, 'et le montant exclu, pour l afficher a cote du surplus');
  ok(a.surplus > 0, `le surplus est calcule (${a.surplus})`);

  /* Sans compte maison, la ligne n'a rien a dire. */
  const g2 = new Game();
  g2._p(J).balance = WEI(1000000);
  eq(g2.autonomie(WEI(50000000)).maisonN, 0, 'sans compte maison, rien a signaler');
  eq(g2.autonomie(WEI(50000000)).maison, 0, 'et rien d exclu');

  /* LE SURPLUS MONTE EXACTEMENT DE CE QUI EST EXCLU. */
  const pot = WEI(50000000);
  const g3 = new Game(); g3._p(J).balance = WEI(1000000);
  const sansMaison = g3.autonomie(pot).surplus;
  const g4 = new Game(); g4._p(J).balance = WEI(1000000);
  g4._p(MAISON).balance = WEI(9000000);
  pres(g4.autonomie(pot).surplus, sansMaison, 0.01,
       'poser neuf millions sur un compte maison ne CREE pas de surplus — ' +
       'il ne fait que ne pas en retirer');
}

// ================== 6. UNE CONFIGURATION SALE NE CASSE RIEN
{
  const garde = cfg.COMPTES_MAISON;
  cfg.COMPTES_MAISON = [];
  const g = new Game();
  eq(g.estMaison(MAISON), false, 'liste vide : plus aucun compte maison');
  g._p(MAISON).balance = WEI(9000000);
  pres(f(g.totalOwed()), 9000000, 1100000,
       'et ses jetons redeviennent une dette — le reglage est reversible');
  cfg.COMPTES_MAISON = garde;
}

console.log(`maison.test.js : ${n} verifications OK`);
