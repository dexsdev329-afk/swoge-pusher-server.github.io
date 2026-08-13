'use strict';
/*
 * Le moteur est verifie a part (puissance4.test.js). Ici on verifie le
 * RACCORDEMENT a l'argent, et c'est le point delicat de tout le jeu : deux
 * mises partent, une seule somme revient, et entre les deux la partie peut
 * finir de quatre facons — alignement, grille pleine, temps ecoule, abandon.
 *
 * Le controle qui compte est la CONSERVATION : a la fin, ce que les joueurs
 * ont plus ce que la maison a prelevé doit valoir exactement ce qu'ils avaient
 * avant. Un jeton cree ou perdu quelque part se voit la, meme s'il se cache.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const P = require('./puissance4');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const sol = (g, a) => Number(g.balanceStr(a));

function neuf(credit = 1000000) {
  const g = new Game();
  for (const a of [A, B, C])
    g._p(a).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}

/** Joue les coups donnes, en alternant, sans jamais depasser l'echeance. */
function joue(g, id, coups, t0) {
  let t = t0;
  for (const [addr, col] of coups) { g.p4Jouer(addr, id, col, t); t += 1000; }
  return t;
}

// ------------------------------------------------- la mise part a la creation
{
  const g = neuf();
  const avant = sol(g, A);
  const m = g.p4Creer(A, 100, 1000);
  eq(sol(g, A), avant - 100, 'la mise est debitee des la creation');
  eq(m.phase, P.ATTENTE, 'la table attend un adversaire');
  eq(g.p4Lobby().length, 1, 'elle apparait dans les tables ouvertes');
  eq(g.p4Lobby()[0].mise, 100, 'avec sa mise');

  // on ne tient qu'une partie a la fois
  jete(() => g.p4Creer(A, 50, 1100), /already have a match/, 'une seule partie par joueur');
  // ni rejoindre la sienne
  jete(() => g.p4Rejoindre(A, m.id, 1100), /your own match/, 'on ne rejoint pas sa propre table');

  // bornes de mise
  jete(() => g.p4Creer(B, cfg.P4_MIN - 1, 1100), /minimum bet/, 'mise trop petite');
  jete(() => g.p4Creer(B, cfg.P4_MAX + 1, 1100), /maximum bet/, 'mise trop grande');
  const c = sol(g, C);
  g._p(C).balance = ethers.utils.parseUnits('5', cfg.DECIMALS);
  jete(() => g.p4Creer(C, 100, 1100), /not enough/, 'pas assez de $SWOGE');
  g._p(C).balance = ethers.utils.parseUnits(String(c), cfg.DECIMALS);

  // l'adversaire paie la meme mise
  const avantB = sol(g, B);
  g.p4Rejoindre(B, m.id, 2000);
  eq(sol(g, B), avantB - 100, 'l adversaire paie la meme mise');
  eq(m.phase, P.EN_COURS, 'la partie demarre');
  eq(g.p4Lobby().length, 0, 'elle sort des tables ouvertes');
}

// ------------------------------------------- le gagnant ramasse, moins 5 %
{
  const g = neuf();
  const avantA = sol(g, A), avantB = sol(g, B);
  const m = g.p4Creer(A, 100, 1000);
  g.p4Rejoindre(B, m.id, 2000);

  // A aligne quatre en bas : colonnes 0,1,2,3 ; B empile ailleurs
  const r = g.p4Jouer(A, m.id, 0, 3000).partie;
  joue(g, m.id, [[B, 6], [A, 1], [B, 6], [A, 2], [B, 6]], 4000);
  const fin = g.p4Jouer(A, m.id, 3, 10000);

  eq(fin.partie.phase, P.FINIE, 'la partie est finie');
  eq(fin.partie.gagnant, 1, 'A gagne');
  eq(fin.reglement.pot, 200, 'le pot vaut les deux mises');
  eq(fin.reglement.rake, 10, 'la maison prend 5 % du pot');
  eq(fin.reglement.gain, 190, 'le gagnant repart avec 190');
  eq(sol(g, A), avantA - 100 + 190, 'le solde du gagnant');
  eq(sol(g, B), avantB - 100, 'le perdant a paye sa mise');
  eq((avantA + avantB) - (sol(g, A) + sol(g, B)), 10,
     'CONSERVATION : il manque exactement la commission');

  // et on ne paie pas deux fois
  jete(() => g.p4Jouer(A, m.id, 4, 11000), /not running/, 'on ne joue plus');
  eq(g._p4Regle(fin.partie), null, 'un second reglement ne paie rien');
  eq(sol(g, A), avantA - 100 + 190, 'le solde n a pas bouge');
}

// --------------------------------------------------- l abandon paie l autre
{
  const g = neuf();
  const avantA = sol(g, A), avantB = sol(g, B);
  const m = g.p4Creer(A, 1000, 1000);
  g.p4Rejoindre(B, m.id, 2000);
  const r = g.p4Abandonner(A, m.id, 3000);
  eq(r.partie.gagnant, 2, 'celui qui reste gagne');
  eq(r.reglement.gain, 1900, '5 % de 2000 laissent 1900');
  eq(sol(g, B), avantB - 1000 + 1900, 'B encaisse');
  eq((avantA + avantB) - (sol(g, A) + sol(g, B)), 100, 'CONSERVATION');
}

// ------------------------------------------------- le temps ecoule tranche
{
  const g = neuf();
  const avantA = sol(g, A), avantB = sol(g, B);
  const m = g.p4Creer(A, 500, 1000);
  g.p4Rejoindre(B, m.id, 2000);
  // A ne joue jamais : passe l'echeance, il perd
  const evs = g.p4Tick(2000 + cfg.P4_COUP_MS + 1);
  eq(evs.length, 1, 'un evenement de fin');
  eq(evs[0].partie.raison, 'temps', 'la raison est le temps');
  eq(evs[0].partie.gagnant, 2, 'B gagne sans jouer');
  eq(sol(g, B), avantB - 500 + 950, 'B encaisse le pot moins 5 %');
  eq((avantA + avantB) - (sol(g, A) + sol(g, B)), 50, 'CONSERVATION');
}

// ------------------------------- une table sans preneur rend la mise
{
  const g = neuf();
  const avant = sol(g, A);
  const m = g.p4Creer(A, 250, 1000);
  eq(sol(g, A), avant - 250, 'la mise est partie');
  const evs = g.p4Tick(1000 + cfg.P4_ATTENTE_MS + 1);
  ok(evs.some((e) => e.type === 'p4Expire'), 'la table expire');
  eq(sol(g, A), avant, 'la mise est rendue en entier');
  eq(g.p4Lobby().length, 0, 'elle ne figure plus dans les tables ouvertes');
}

// ------------------------------------------ CONSERVATION sur 60 parties
/* Le controle qui attrape tout : soixante parties menees jusqu'au bout, par
   les quatre chemins de fin. Ce que les joueurs ont perdu doit valoir
   exactement ce que la maison a preleve. */
{
  const g = neuf();
  const depart = sol(g, A) + sol(g, B);
  let rakeAttendu = 0, parties = 0;
  let t = 100000;

  for (let k = 0; k < 60; k++) {
    const mise = [10, 100, 1000, 10000][k % 4];
    const m = g.p4Creer(A, mise, t); t += 100;
    g.p4Rejoindre(B, m.id, t); t += 100;
    parties++;

    if (k % 4 === 0) {
      // alignement : A gagne en bas
      g.p4Jouer(A, m.id, 0, t); t += 100;
      for (const [q, c] of [[B, 6], [A, 1], [B, 6], [A, 2], [B, 6]]) { g.p4Jouer(q, m.id, c, t); t += 100; }
      g.p4Jouer(A, m.id, 3, t); t += 100;
      rakeAttendu += Math.floor(mise * 2 * cfg.P4_RAKE_BPS / 10000);
    } else if (k % 4 === 1) {
      g.p4Abandonner(B, m.id, t); t += 100;
      rakeAttendu += Math.floor(mise * 2 * cfg.P4_RAKE_BPS / 10000);
    } else if (k % 4 === 2) {
      t += cfg.P4_COUP_MS + 1; g.p4Tick(t);
      rakeAttendu += Math.floor(mise * 2 * cfg.P4_RAKE_BPS / 10000);
    } else {
      g.p4Abandonner(A, m.id, t); t += 100;
      rakeAttendu += Math.floor(mise * 2 * cfg.P4_RAKE_BPS / 10000);
    }
    t += 200000;   // on laisse le menage effacer la partie finie
    g.p4Tick(t);
  }

  eq(parties, 60, 'soixante parties jouees');
  const fin = sol(g, A) + sol(g, B);
  eq(depart - fin, rakeAttendu,
     `CONSERVATION : ${depart - fin} manquants pour ${rakeAttendu} de commission attendue`);
  ok(g.p4.size === 0 || [...g.p4.values()].every((m) => m.phase === P.FINIE),
     'aucune partie ne reste en cours');
  const jx = g._p(A).jeux.p4;
  ok(jx && jx.n === 60, 'les soixante manches sont comptees au bon jeu');
}

// ------------------------------------------------------- ce que voit le client
{
  const g = neuf();
  const m = g.p4Creer(A, 100, 1000);
  g.p4Rejoindre(B, m.id, 2000);
  const e = g.p4Etat(m.id, 2500);
  eq(e.grille.length, 42, 'la grille complete est envoyee');
  eq(e.tour, 1, 'le tour est annonce');
  eq(e.rakeBps, cfg.P4_RAKE_BPS, 'la commission est annoncee');
  eq(e.noms.length, 2, 'les deux noms sont la');
  ok(e.reste > 0 && e.reste <= cfg.P4_COUP_MS, 'le temps restant est annonce');
  eq(g.p4Etat('inconnue', 2500), null, 'une partie inconnue rend null');
  eq(g.p4Mienne(A).id, m.id, 'un joueur retrouve sa partie');
  eq(g.p4Mienne(C), null, 'un tiers n en a pas');
}

console.log(`puissance4_game.test.js : ${n} verifications OK`);
