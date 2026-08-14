'use strict';
/*
 * Les comptes du projet ne sont pas une dette.
 *
 * ---- ce qui etait faux ----
 *
 * Le tableau de bord comptait le compte du developpeur comme celui de
 * n'importe quel joueur. Son solde et son staking apparaissaient donc dans
 * « du aux joueurs » — de l'argent que la maison se doit a elle-meme. Deux
 * consequences, toutes deux dans le mauvais sens :
 *
 *   • la dette affichee etait plus grosse que la vraie ;
 *   • le rendement de SON staking comptait comme une fuite quotidienne, ce
 *     qui rapprochait la date d'epuisement pour de l'argent qui ne sort de
 *     nulle part.
 *
 * ---- ce qu'on ne change PAS, et pourquoi ----
 *
 * Le « surplus retirable » continue de se calculer sur la dette TOTALE,
 * comptes du projet inclus. Ces jetons peuvent encore sortir par un retrait
 * de joueur ordinaire : les retirer du calcul autoriserait a vider le coffre
 * deux fois, une fois par ownerWithdraw et une fois par le compte lui-meme.
 * Le tableau les montre a cote ; il ne les ajoute pas a ce qu'on peut prendre.
 * C'est le test le plus important du fichier — c'est celui qui protege
 * l'argent des joueurs si quelqu'un « simplifie » plus tard.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));

const DEV = '0x960b8687d019c971eb483ad114df3f4fc5bcf0f0';
const JOUEUR = '0x' + '77'.repeat(20);

// ================================ l adresse du projet est bien reconnue
{
  ok(cfg.MAISON_ADRESSES.includes(DEV),
     'le compte du projet est dans la configuration');
  ok(Game.estMaison(DEV), 'et il est reconnu comme compte maison');
  ok(Game.estMaison(DEV.toUpperCase()), 'quelle que soit la casse — une adresse se recopie a la main');
  ok(!Game.estMaison(JOUEUR), 'un joueur ordinaire ne l est pas');
  ok(!Game.estMaison(''), 'ni une adresse vide');
  ok(!Game.estMaison(null), 'ni rien du tout');
}

// ================================ la dette se separe en deux
{
  const g = new Game();
  g._p(JOUEUR).balance = W(100000);
  g._p(DEV).balance = W(5000000);
  /* Le plafond par portefeuille s'applique AUSSI au compte du projet : on
     reste dessous, comme en vrai. */
  g.stake(DEV, '2000000');
  g.stake(JOUEUR, '40000');

  const b = g.owedBreakdown();

  /* Les TOTAUX ne bougent pas : c'est la vraie obligation du coffre, et c'est
     eux que l'alarme de solvabilite regarde. */
  eq(f(b.balances), 3060000, 'le total des soldes comprend toujours celui du projet');
  eq(f(b.staked), 2040000, 'le total en staking aussi');

  // Et la part du projet est isolee.
  eq(f(b.maison.balances), 3000000, 'le solde du projet est identifie');
  eq(f(b.maison.staked), 2000000, 'son staking aussi');
  /* Arrondi : le rendement court a la seconde, et `total` le comprend. Une
     egalite stricte tomberait sur les quelques millionniemes accumulees entre
     le depot et la lecture, ce qui n'apprendrait rien. */
  eq(Math.round(f(b.maison.total)), 5000000, 'et leur somme');

  /* Ce qu'on doit VRAIMENT : le total moins les comptes du projet. La reserve
     du jackpot y reste — elle est due a celui qui le decrochera, et ce n'est
     pas le projet. */
  const jackpot = f(b.jackpot);
  const duReel = f(b.balances.add(b.staked).add(b.pending).add(b.jackpot).sub(b.maison.total));
  eq(Math.round(duReel), 100000 + Math.round(jackpot),
     `ce qu on doit VRAIMENT aux joueurs : 100 000 de solde et de staking, ` +
     `plus les ${jackpot} de la reserve du jackpot`);
}

// ============ LE SURPLUS RETIRABLE NE GONFLE PAS. C est le garde-fou.
/* Si un jour quelqu'un retire les comptes du projet du calcul du surplus, ce
   test tombe — et c'est exactement ce qu'on veut, parce que ce jour-la le
   coffre pourrait etre vide deux fois. */
{
  const g = new Game();
  g._p(JOUEUR).balance = W(100000);
  g._p(DEV).balance = W(900000);

  const jackpot = f(g.jackpotPot);
  const du = f(g.totalOwed());
  eq(du, 1000000 + jackpot,
     'la dette totale — celle qui sert au surplus — comprend le compte du projet');

  const coffre = W(1200000);
  const surplus = f(coffre) - du;
  eq(surplus, 200000 - jackpot,
     'le surplus retirable reste ce qui depasse la dette TOTALE, pas la dette reelle');
  ok(surplus < f(coffre) - 100000,
     'il est volontairement plus PETIT que si l on ne comptait que les vrais joueurs : ' +
     'ces jetons peuvent encore sortir par un retrait ordinaire');
}

// ================ le staking du projet ne compte pas comme une fuite
{
  const g = new Game();
  g._p(JOUEUR).balance = W(200000);
  g._p(DEV).balance = W(10000000);
  g.stake(JOUEUR, '100000');
  g.stake(DEV, '2000000');

  const a = g.autonomie(W(50000000));
  eq(a.stakedMaison, 2000000, 'le staking du projet est identifie');
  eq(a.stakedJoueurs, 100000, 'et celui des joueurs a part');

  const attendu = 100000 * (cfg.STAKE_APR_BPS / 10000) / 365;
  ok(Math.abs(a.rendementJour - attendu) < 1,
     `le cout quotidien ne porte QUE le staking des joueurs (${a.rendementJour} ≈ ${attendu.toFixed(2)})`);

  /* La preuve par l'absurde : si le staking du projet comptait, le cout
     quotidien serait vingt et une fois plus gros, et l'alarme d'epuisement
     sonnerait pour de l'argent que personne ne reclamera jamais. */
  const sansSeparation = 2100000 * (cfg.STAKE_APR_BPS / 10000) / 365;
  ok(a.rendementJour < sansSeparation / 5,
     `et pas ${sansSeparation.toFixed(0)}/jour — vingt et une fois plus, sur de l argent ` +
     'que le projet se doit a lui-meme');
}

// ================================ sans compte maison, rien ne change
/* La configuration peut etre vide. Le tableau doit alors se comporter
   exactement comme avant, sans ligne fantome a zero. */
{
  const vrai = cfg.MAISON_ADRESSES;
  cfg.MAISON_ADRESSES = [];
  try {
    const g = new Game();
    g._p(JOUEUR).balance = W(100000);
    g.stake(JOUEUR, '50000');
    const b = g.owedBreakdown();
    eq(f(b.maison.total), 0, 'aucun compte du projet : la part maison vaut zero');
    const a = g.autonomie(W(1000000));
    eq(a.stakedMaison, 0, 'et rien n est retire du cout quotidien');
    eq(a.stakedJoueurs, a.staked, 'tout le staking est celui des joueurs');
  } finally {
    cfg.MAISON_ADRESSES = vrai;
  }
}

console.log(`maison.test.js : ${n} verifications OK`);
