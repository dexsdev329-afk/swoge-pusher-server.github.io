'use strict';
/*
 * Le plafond de staking PAR PORTEFEUILLE.
 *
 * Le rendement est une subvention : il est paye par la maison, donc par les
 * manches jouees par tout le monde. Un plafond global de 20 % laisse un seul
 * porteur le prendre en entier — et faire payer la salle pour une personne
 * n'est pas le but. Mesure du jour ou ce plafond a ete ecrit : sur quatre
 * portefeuilles qui stakaient, UN SEUL en tenait 92,6 %.
 *
 * La contrainte qui compte, et qui a ete demandee explicitement : ON NE TOUCHE
 * PAS A CEUX QUI ONT DEJA STAKE. Une position ouverte sous une autre regle
 * reste ouverte, meme au-dessus du plafond. On empeche d'AJOUTER, on ne retire
 * rien, on ne rogne rien, et le rendement deja acquis reste du.
 *
 * C'est la moitie du fichier : le reste verifie que le plafond mord bien pour
 * les nouvelles mises.
 */
const assert = require('assert');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/plafondj-test-');
process.env.RPC_URL = '';

const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20);

const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
function riche(g, a, v) { const p = g._p(a); p.balance = W(v); return p; }

/* Le plafond par portefeuille, en jetons, tel que la configuration le donne. */
const MAX = () => {
  const g = new Game();
  return f(g.plafondJoueur());
};

// ============================================ le plafond existe et se calcule
{
  const g = new Game();
  const salle = f(g.plafondStaking());
  const max = f(g.plafondJoueur());
  ok(max > 0, 'il y a bien un plafond par portefeuille', max);
  eq(Math.round(salle * cfg.STAKE_CAP_JOUEUR_BPS / 10000), Math.round(max),
     'et il vaut la part annoncee de la SALLE, pas de l offre');
  const mini = Math.ceil(salle / max);
  ok(mini >= 20, `il faut au moins ${mini} portefeuilles pour remplir la salle`);
}

// ================================== CE QU ON NE TOUCHE PAS : le deja-stake
/* La contrainte demandee. On installe quelqu'un TRES au-dessus du plafond,
   comme s'il avait stake avant la regle, et on verifie qu'il ne perd rien. */
{
  const g = new Game();
  const max = f(g.plafondJoueur());
  const enorme = max * 3;
  const p = riche(g, A, enorme + 1000);

  /* On l'installe directement, comme le ferait une position ouverte avant la
     regle : le plafond ne s'appliquait pas, elle est passee. */
  const t = Date.now();
  p.balance = p.balance.sub(W(enorme));
  p.stakes.push({ a: W(enorme), s: t, u: t + cfg.STAKE_LOCK_DAYS * 86400000 });

  const vu = g.stakeInfo(A);
  eq(Number(vu.staked), enorme, 'sa position est intacte, trois fois le plafond');
  eq(f(g.placeJoueur(A)), 0, 'il ne lui reste aucune place — c est tout');

  /* Le rendement continue de courir sur la TOTALITE : on ne punit pas
     quelqu'un pour une regle ecrite apres son engagement. */
  const p2 = g._p(A);
  p2.stakes[0].s = t - 86400000 * 30;              // trente jours en arriere
  const apres = g.stakeInfo(A);
  ok(Number(apres.pending) > 0, 'le rendement court toujours sur toute la position',
     apres.pending);
  const attendu = enorme * (cfg.STAKE_APR_BPS / 10000) * (30 / 365);
  ok(Math.abs(Number(apres.pending) - attendu) / attendu < 0.02,
     'et il court sur la position ENTIERE, pas sur la part sous plafond',
     [apres.pending, attendu]);

  /* Il peut reclamer ce rendement : rien n'est confisque. */
  const soldeAvant = f(g._p(A).balance);
  const gain = g.claimStake(A);
  ok(Number(gain) > 0, 'et il le touche');
  ok(f(g._p(A).balance) > soldeAvant, 'son solde augmente bien');

  /* Il peut aussi sortir, et il recupere TOUT. */
  const g2 = new Game();
  const q = riche(g2, B, enorme);
  const t2 = Date.now() - cfg.STAKE_LOCK_DAYS * 86400000 - 1000;   // verrou echu
  q.balance = q.balance.sub(W(enorme));
  q.stakes.push({ a: W(enorme), s: t2, u: t2 });
  const r = g2.unstakeAll(B);
  eq(Math.round(Number(r.returned)), Math.round(enorme),
     'et s il sort, il recupere l integralite, sans penalite ni rognage');
}

// ------------------------------------ mais il ne peut plus rien AJOUTER
{
  const g = new Game();
  const max = f(g.plafondJoueur());
  const p = riche(g, A, max * 3);
  const t = Date.now();
  p.balance = p.balance.sub(W(max * 2));
  p.stakes.push({ a: W(max * 2), s: t, u: t + 1 });

  jete(() => g.stake(A, '1'), /per-wallet staking cap/,
       'au-dessus du plafond, on n ajoute plus rien');
  /* Le refus doit dire que ce qu'il a n'est PAS menace : sans cette phrase,
     le joueur croit qu'on va lui prendre quelque chose. */
  let msg = '';
  try { g.stake(A, '1'); } catch (e) { msg = e.message; }
  ok(/stays untouched/.test(msg), 'et le dit : sa position n est pas menacee', msg);
  eq(Number(g.stakeInfo(A).staked), max * 2, 'sa position n a effectivement pas bouge');
  eq(f(g._p(A).balance), max, 'et son solde non plus');
}

// ============================================ le plafond mord pour les neufs
{
  const g = new Game();
  const max = f(g.plafondJoueur());
  riche(g, A, max * 4);

  g.stake(A, String(max / 2));
  eq(Number(g.stakeInfo(A).staked), max / 2, 'la moitie du plafond passe');
  eq(f(g.placeJoueur(A)), max / 2, 'et il reste l autre moitie');

  jete(() => g.stake(A, String(max)), /you can stake/,
       'demander plus que la place restante est refuse');
  /* Le refus porte le chiffre exact : « plafond atteint » tout seul fait
     ecrire au support, « il vous reste 1 000 000 » fait retaper 1 000 000. */
  let msg = '';
  try { g.stake(A, String(max)); } catch (e) { msg = e.message; }
  ok(/[\d,]{4,}/.test(msg), 'en donnant le chiffre exact qui reste', msg);

  g.stake(A, String(max / 2));
  eq(Number(g.stakeInfo(A).staked), max, 'jusqu au plafond, ca passe');
  eq(f(g.placeJoueur(A)), 0, 'et la place tombe a zero');
  jete(() => g.stake(A, '1'), /per-wallet staking cap/, 'un jeton de plus, non');
}

// ---------------------------------- sortir rend la place, a lui et a la salle
{
  const g = new Game();
  const max = f(g.plafondJoueur());
  const p = riche(g, A, max * 2);
  const t = Date.now() - cfg.STAKE_LOCK_DAYS * 86400000 - 1000;
  p.balance = p.balance.sub(W(max));
  p.stakes.push({ a: W(max), s: t, u: t });

  eq(f(g.placeJoueur(A)), 0, 'plein');
  g.unstakeAll(A);
  eq(f(g.placeJoueur(A)), max, 'apres etre sorti, la place lui revient');
  g.stake(A, String(max));
  eq(Number(g.stakeInfo(A).staked), max, 'et il peut de nouveau entrer');
}

// ================================ la subvention atteint plus de portefeuilles
/* Le but de la mesure, verifie comme un resultat et non comme une intention :
   avec le plafond, un seul portefeuille ne peut plus prendre la salle. */
{
  const g = new Game();
  const salle = f(g.plafondStaking());
  const max = f(g.plafondJoueur());
  riche(g, A, salle * 2);
  jete(() => g.stake(A, String(salle)), /per-wallet staking cap|you can stake/,
       'un seul portefeuille ne peut plus prendre la salle entiere');
  g.stake(A, String(max));
  const part = Number(g.stakeInfo(A).staked) / salle * 100;
  ok(part <= cfg.STAKE_CAP_JOUEUR_BPS / 100 + 0.001,
     `au maximum il en tient ${part.toFixed(2)} %, pas 92,6 %`);
}

// ------------------------------------------ la page le dit AVANT la saisie
{
  const g = new Game();
  const max = f(g.plafondJoueur());
  riche(g, A, max * 2);
  g.stake(A, String(max / 4));

  const c = g.stakeInfo(A).capacite;
  eq(c.plafondJoueur, max, 'la capacite annonce le plafond par portefeuille');
  eq(c.dejaJoueur, max / 4, 'ce que CE joueur a deja');
  eq(c.libreJoueur, max - max / 4, 'et ce qu il lui reste');
  ok(c.partSalle > 0, 'avec la part de la salle que ca represente', c.partSalle);

  /* Sans adresse — le tableau de bord, la diffusion publique — on ne doit pas
     laisser fuiter la position de quelqu'un. */
  const pub = g.capaciteStaking();
  eq(pub.dejaJoueur, undefined, 'sans adresse, aucune position individuelle n est publiee');
  eq(pub.libreJoueur, undefined, 'ni la place restante de qui que ce soit');
  eq(pub.plafondJoueur, max, 'mais la regle, elle, reste publique');
}

// --------------------------------------------- desactivable, comme le global
{
  const avant = cfg.STAKE_CAP_JOUEUR_BPS;
  cfg.STAKE_CAP_JOUEUR_BPS = 0;
  const g = new Game();
  eq(g.plafondJoueur(), null, 'a zero, il n y a plus de plafond par portefeuille');
  eq(g.placeJoueur(A), null, 'et plus de place a calculer');
  riche(g, A, 5000000);
  g.stake(A, '5000000');
  eq(Number(g.stakeInfo(A).staked), 5000000, 'tout passe, comme avant');
  cfg.STAKE_CAP_JOUEUR_BPS = avant;
}

console.log(`plafond_joueur.test.js : ${n} verifications OK`);
