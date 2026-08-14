'use strict';
/*
 * Ce qui est joue, par jeu et par jour.
 *
 * ---- pourquoi ce fichier existe ----
 *
 * Treize jeux tournent et personne ne savait lequel servait. La comptabilite
 * compte l'ARGENT, par mois ; elle ne dit pas d'ou il vient. Le jour ou le
 * bareme du Coin Pusher a ete rerregle, aucun chiffre n'a pu dire ensuite si
 * ca avait change quoi que ce soit — et c'est cette impossibilite-la qu'on
 * repare.
 *
 * ---- ce qui est verifie ----
 *
 *   • le comptage passe par le SEUL point ou toutes les manches se reglent :
 *     un jeu qui l'oublierait ne compterait deja pas dans le reste ;
 *   • les JOUEURS DISTINCTS, pas seulement les manches — mille manches d'une
 *     personne et mille manches de cent sont deux mondes que le total confond ;
 *   • la borne : passe le plafond d'adresses retenues, on compte ce qui
 *     deborde au lieu de gonfler l'etat sans fin, et on le DIT ;
 *   • la survie au redemarrage. Une mesure qui repart de zero a chaque
 *     deploiement ne permet jamais de comparer un avant et un apres, ce qui
 *     est precisement son seul emploi.
 */
const assert = require('assert');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/usage-test-');
process.env.RPC_URL = '';

const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const jour = () => new Date().toISOString().slice(0, 10);

function joueur(g, a) { const p = g._p(a); p.balance = W(1000000); return p; }

// ============================================ on compte ce qui se joue
{
  const g = new Game();
  const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
  const pa = joueur(g, A), pb = joueur(g, B);

  g._manche(pa, 'plinko', 100, 90);
  g._manche(pa, 'plinko', 100, 250);
  g._manche(pb, 'plinko', 50, 0);
  g._manche(pa, 'crash', 200, 0);

  const l = g.usageJour(jour());
  eq(l.length, 2, 'deux jeux ont ete joues aujourd hui');
  eq(l[0].jeu, 'plinko', 'et le plus joue est en tete');
  eq(l[0].manches, 3, 'trois manches de plinko');
  eq(l[0].joueurs, 2, 'par DEUX joueurs distincts — c est ce que le total ne dit pas');
  eq(l[0].mise, 250, 'la somme des mises');
  eq(l[0].rendu, 340, 'la somme des rendus');
  eq(l[0].net, -90, 'et le net de la maison, negatif quand elle a paye');
  eq(l[0].retour, 136, 'avec le retour du jour en pourcentage');
  eq(l[1].jeu, 'crash', 'le second jeu suit');
  eq(l[1].joueurs, 1, 'avec son propre compte de joueurs');

  /* Un jeu qu'on n'a pas joue n'apparait pas : une ligne a zero se confond
     avec une ligne oubliee, et on ne saurait plus laquelle est laquelle. */
  ok(!l.some((x) => x.jeu === 'bj'), 'un jeu non joue n apparait pas du tout');
}

// ================================ le passage OBLIGE : toutes les manches
/* On ne verifie pas que « plinko appelle noteJeu » — on verifie que le point
   de reglage commun compte, quel que soit le nom du jeu. Un jeu ajoute demain
   est mesure sans que personne n'y pense. */
{
  const g = new Game();
  const p = joueur(g, '0x' + 'cc'.repeat(20));
  for (const jeu of ['smash', 'spin', 'bj', 'mines', 'hilo', 'holdem', 'three',
                     'p4', 'pusher', 'mp', 'dm', 'crash', 'plinko']) {
    g._manche(p, jeu, 10, 5);
  }
  const l = g.usageJour(jour());
  eq(l.length, 13, 'les treize jeux comptent, sans liste a tenir a jour');
  ok(l.every((x) => x.manches === 1 && x.joueurs === 1), 'chacun avec sa manche et son joueur');
}

// ============================================ la borne sur les adresses
{
  const g = new Game();
  const plafond = Game.PLAFOND_VUS;
  for (let i = 0; i < plafond + 25; i++) {
    const a = '0x' + String(i).padStart(40, '0');
    g._manche(g._p(a), 'plinko', 1, 0);
  }
  const l = g.usageJour(jour());
  eq(l[0].manches, plafond + 25, 'toutes les manches sont comptees');
  eq(l[0].joueurs, plafond, 'mais on ne retient que le plafond d adresses');
  eq(l[0].auDela, 25, 'et ce qui deborde est COMPTE, pas perdu en silence');
}

// ============================================ ca survit au redemarrage
/* Le seul emploi de cette mesure est de comparer un avant et un apres. Une
   mesure qui repart de zero a chaque deploiement ne le permet jamais. */
{
  const g = new Game();
  const p = joueur(g, '0x' + 'dd'.repeat(20));
  g._manche(p, 'pusher', 1, 0);
  g._manche(p, 'pusher', 1, 25);

  const instantane = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(instantane);

  const l = g2.usageJour(jour());
  eq(l.length, 1, 'le jeu est toujours la apres relecture');
  eq(l[0].manches, 2, 'avec ses manches');
  eq(l[0].joueurs, 1, 'et ses joueurs distincts');
  eq(l[0].rendu, 25, 'et ses chiffres, au jeton pres');
}

// ============================================ on n empile pas sans fin
{
  const g = new Game();
  g.usage = {};
  /* On fabrique cent vingt jours anciens a la main, puis on joue : l elagage
     doit ramener a la fenetre, sans toucher au jour courant. */
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10);
    g.usage[d] = { plinko: { m: 1, mise: 1, rendu: 0, vus: {}, plus: 0 } };
  }
  g._manche(joueur(g, '0x' + 'ee'.repeat(20)), 'plinko', 5, 0);
  const jours = g.usageJours();
  ok(jours.length <= Game.JOURS_USAGE,
     `on garde au plus ${Game.JOURS_USAGE} jours, pas ${jours.length}`);
  eq(jours[0], jour(), 'et le plus recent est bien aujourd hui');
  eq(g.usageJour(jour())[0].manches, 1, 'dont la manche qu on vient de jouer');
}

console.log(`usage.test.js : ${n} verifications OK`);
