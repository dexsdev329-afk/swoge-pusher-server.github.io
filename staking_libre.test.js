'use strict';
/*
 * La sortie du staking est libre.
 *
 * ---- ce qui a ete retire ----
 *
 * Sortir avant l'echeance faisait perdre la MOITIE du capital encore bloque.
 * Une part sur deux n'est pas une friction, c'est une perte seche, et elle
 * frappait exactement celui qui en avait besoin : celui qui doit reprendre son
 * argent avant terme. Desormais on entre et on sort quand on veut, et tout
 * revient.
 *
 * ---- ce que ce fichier verrouille ----
 *
 *   • TOUT revient, capital et rendement, sans attendre aucune date ;
 *   • rien n'est ANNONCE comme bloque — un verrou qui ne coute rien a franchir
 *     n'est pas un verrou, et l'afficher retiendrait quelqu'un qui pouvait
 *     partir ;
 *   • les positions DEJA PRISES, qui portent une echeance ecrite au depot,
 *     se deverrouillent sans migration : c'est le cas qui casse en silence le
 *     jour du deploiement, parce qu'aucune donnee de test fraiche ne le
 *     contient ;
 *   • le rendement reste PROPORTIONNEL au temps : entrer et ressortir tout de
 *     suite ne rapporte rien. C'est ce qui rendait le verrou inutile, et c'est
 *     donc ce qu'il faut prouver avant de l'enlever.
 *
 * Le dernier bloc remet la penalite en vigueur et verifie qu'elle refonctionne
 * : le reglage doit rester un reglage, pas une porte a sens unique.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

const A = '0x' + 'd1'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const nb = (s) => Number(s);

function joueur(g, a, solde) { const p = g._p(a); p.balance = W(solde); return p; }

// ====================================== le reglage dit bien « sortie libre »
{
  eq(cfg.STAKE_EARLY_PENALTY_BPS, 0,
     'la penalite de sortie anticipee vaut zero — c est la decision, en clair');
}

// ====================================== on sort tout de suite, et tout revient
{
  const g = new Game();
  joueur(g, A, 100000);
  g.stake(A, '60000');
  eq(g.balanceStr(A), '40000.0', 'le solde baisse de ce qui est mis');

  const r = g.unstakeAll(A);
  eq(r.returned, '60000.0', 'a la seconde suivante, TOUT le capital revient');
  eq(r.penalty, '0.0', 'et rien ne part a la maison');
  /* Il retrouve son solde de depart — et un cheveu de plus, le rendement des
     quelques millisecondes passees en staking. Comparer a l'egalite stricte
     ferait tomber le test sur ce cheveu-la, ce qui n'apprendrait rien. */
  const fin = Number(g.balanceStr(A));
  ok(fin >= 100000, `le joueur retrouve au moins son solde de depart (${fin})`);
  ok(fin - 100000 < 1, 'a un cheveu de rendement pres, rien de plus');
}

// ====================================== rien n est annonce comme bloque
{
  const g = new Game();
  joueur(g, A, 50000);
  g.stake(A, '50000');
  const e = g.stakeInfo(A);
  eq(nb(e.locked), 0, 'aucune part n est presentee comme bloquee');
  eq(nb(e.unlocked), 50000, 'tout est presente comme disponible');
  eq(e.nextUnlock, null, 'et il n y a aucune date a attendre a afficher');
  eq(e.penaltyBps, 0, 'la page recoit bien zero — c est elle qui ecrit le message');
}

// ============ LES POSITIONS DEJA PRISES : celles qui portent une vieille date
/* Le cas qui casse au deploiement et jamais en test : une position posee avant
   le changement a son echeance ecrite dans l'etat, et rien ne la reecrira. */
{
  const g = new Game();
  const p = joueur(g, A, 50000);
  g.stake(A, '50000');
  const dansUnAn = Date.now() + 365 * 86400000;
  for (const pos of p.stakes) pos.u = dansUnAn;      // comme avant le changement

  const e = g.stakeInfo(A);
  eq(nb(e.locked), 0, 'une position datee d il y a un an ne se dit plus bloquee');
  eq(nb(e.unlocked), 50000, 'elle est disponible comme les autres');

  const r = g.unstakeAll(A);
  eq(r.returned, '50000.0', 'et elle sort en entier, sans migration de l etat');
  eq(r.penalty, '0.0', 'sans rien laisser derriere');
}

// ================= le rendement reste proportionnel au temps passe
/* C'est ce qui rend le verrou inutile : une aller-retour immediat ne paie
   rien, donc il n'y a rien a empecher. */
{
  const g = new Game();
  joueur(g, A, 100000);
  g.stake(A, '100000');
  const r = g.unstakeAll(A);
  ok(Number(r.yield) < 1,
     `un aller-retour immediat ne rapporte quasiment rien (${r.yield}) — ` +
     'il n y a donc rien a fermer contre lui');

  /* Et sur une vraie duree, le rendement est bien la : on ne l a pas casse en
     enlevant la penalite. */
  const g2 = new Game();
  const p2 = joueur(g2, A, 100000);
  g2.stake(A, '100000');
  for (const pos of p2.stakes) pos.s -= 86400000 * 365;   // un an en arriere
  const r2 = g2.unstakeAll(A);
  ok(Number(r2.yield) > 90000,
     `apres un an a ${cfg.STAKE_APR_BPS / 100} %, le rendement est bien verse (${r2.yield})`);
  eq(r2.penalty, '0.0', 'et toujours sans penalite');
}

// ====================== la place est rendue a la salle, penalite ou pas
{
  const g = new Game();
  joueur(g, A, 100000);
  g.stake(A, '100000');
  ok(g.capaciteStaking().occupe > 0, 'la place est prise pendant le staking');
  g.unstakeAll(A);
  eq(g.capaciteStaking().occupe, 0, 'et rendue EN ENTIER a la sortie');
}

// ================= le reglage reste un reglage : on peut la remettre
/* Une porte a sens unique n'est pas un reglage. Si la penalite revient, le
   verrou revient avec elle — c'est la penalite qui DEFINIT le blocage. */
{
  const vrai = cfg.STAKE_EARLY_PENALTY_BPS;
  cfg.STAKE_EARLY_PENALTY_BPS = 5000;
  try {
    const g = new Game();
    const p = joueur(g, A, 100000);
    g.stake(A, '100000');
    const e = g.stakeInfo(A);
    eq(nb(e.locked), 100000, 'penalite remise : la position redevient bloquee');
    ok(e.nextUnlock !== null, 'et une date d echeance est de nouveau annoncee');

    const r = g.unstakeAll(A);
    eq(r.returned, '50000.0', 'sortir avant terme rend la moitie');
    eq(r.penalty, '50000.0', 'et l autre moitie reste a la maison');

    /* Et une position ARRIVEE A TERME sort toujours en entier, penalite ou
       non — sinon la penalite ne serait plus « anticipee », mais permanente. */
    const g2 = new Game();
    const p2 = joueur(g2, A, 100000);
    g2.stake(A, '100000');
    for (const pos of p2.stakes) pos.u = Date.now() - 1000;
    const r2 = g2.unstakeAll(A);
    eq(r2.returned, '100000.0', 'a terme echu, tout revient meme avec la penalite en vigueur');
    eq(r2.penalty, '0.0', 'et rien n est preleve');
  } finally {
    cfg.STAKE_EARLY_PENALTY_BPS = vrai;
  }
}

console.log(`staking_libre.test.js : ${n} verifications OK`);
