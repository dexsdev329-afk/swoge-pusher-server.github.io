'use strict';
/*
 * LE MOTEUR DU CHENIL TIENT-IL SES COMPTES ?
 *
 * Les essais qui suivent verifient ce qu'un joueur pourrait CONTESTER : que
 * les symboles tombent la ou les regles le disent, que les lignes paient ce
 * que le bareme annonce, que le bonus ne se redeclenche pas, et que le
 * retour publie n'a pas derive du moteur.
 */
const chenil = require('./chenil.js');
const {
  ROULEAUX, RANGEES, CASES, PAYANTS, WILD, BONUS, LIGNES, BAREME,
  ROULEAUX_WILD, ROULEAUX_BONUS, BONUS_POUR_TOURS, BONUS_PAIE, GAIN_MAX,
  MULTIS_WILD, CASES_TIRAGE, TIRAGE_TOURS, gainsDe, joue, mesure, RTP,
} = chenil;

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- les vingt lignes --');
ok(LIGNES.length === 20, 'il y a bien vingt lignes');
ok(LIGNES.every((l) => l.length === ROULEAUX),
   'chacune visite les cinq rouleaux');
ok(LIGNES.every((l) => l.every((y) => y >= 0 && y < RANGEES)),
   'et ne sort jamais des trois rangees');
{
  const vues = new Set(LIGNES.map((l) => l.join('')));
  ok(vues.size === LIGNES.length,
     'aucune n est le doublon d une autre — une ligne repetee paierait DEUX FOIS'
     + ' la meme combinaison sans que rien ne le dise (' + vues.size + ' distinctes)');
}

console.log('\n-- ou tombent les symboles --');
{
  let horsWild = 0, horsBonus = 0, cases = 0;
  for (let i = 1; i <= 40000; i++) {
    const g = joue({ serverSeed: 's', clientSeed: 'c', nonce: i, mise: 10 }).base.grille;
    for (let y = 0; y < RANGEES; y++) for (let r = 0; r < ROULEAUX; r++) {
      const s = g[y * ROULEAUX + r]; cases++;
      if (s === WILD && ROULEAUX_WILD.indexOf(r) < 0) horsWild++;
      if (s === BONUS && ROULEAUX_BONUS.indexOf(r) < 0) horsBonus++;
    }
  }
  ok(horsWild === 0, 'le Wild ne tombe QUE sur les rouleaux 2, 3 et 4 (' + cases + ' cases vues)');
  ok(horsBonus === 0, 'le Bonus ne tombe QUE sur les rouleaux 1, 3 et 5');
}

console.log('\n-- ce que paie une ligne --');
{
  /* On FABRIQUE une grille plutot que d'attendre qu'elle tombe : c'est la
     seule facon de verifier un paiement exact. */
  const g = new Array(CASES).fill('dix');
  for (let r = 0; r < ROULEAUX; r++) g[1 * ROULEAUX + r] = 'collier';   // rangee du milieu
  const r1 = gainsDe(g, new Array(ROULEAUX).fill(0));
  const l0 = r1.lignes.find((l) => l.ligne === 0);
  ok(l0 && l0.symbole === 'collier' && l0.rouleaux === 5
       && Math.abs(l0.gain - BAREME.collier[5]) < 1e-9,
     'cinq colliers sur la ligne du milieu paient ' + BAREME.collier[5]
     + 'x, sans multiplicateur');

  /* Le meme, avec un Wild a x3 sur le rouleau 2. */
  const g2 = g.slice(); g2[1 * ROULEAUX + 1] = WILD;
  const m2 = new Array(ROULEAUX).fill(0); m2[1] = 3;
  const l2 = gainsDe(g2, m2).lignes.find((l) => l.ligne === 0);
  ok(l2 && Math.abs(l2.gain - BAREME.collier[5] * 3) < 1e-9,
     'et avec un Wild a x3 sur la ligne, trois fois plus (' + l2.gain.toFixed(2) + ')');

  /* DEUX Wilds : les multiplicateurs S'ADDITIONNENT, ils ne se multiplient
     pas. C'est la regle du jeu de reference, et l'inverse de DEAD SWOGE. */
  const g3 = g2.slice(); g3[1 * ROULEAUX + 2] = WILD;
  const m3 = m2.slice(); m3[2] = 2;
  const l3 = gainsDe(g3, m3).lignes.find((l) => l.ligne === 0);
  ok(l3 && Math.abs(l3.gain - BAREME.collier[5] * 5) < 1e-9,
     'deux Wilds a x3 et x2 font x5 — ils S ADDITIONNENT (' + l3.gain.toFixed(2)
     + '), le produit aurait fait ' + (BAREME.collier[5] * 6).toFixed(2));

  /* Un multiplicateur ne compte QUE si la ligne passe sur le Wild. */
  const g4 = g.slice(); g4[0 * ROULEAUX + 1] = WILD;   // Wild en rangee du HAUT
  const m4 = new Array(ROULEAUX).fill(0); m4[1] = 3;
  const l4 = gainsDe(g4, m4).lignes.find((l) => l.ligne === 0);
  ok(l4 && Math.abs(l4.gain - BAREME.collier[5]) < 1e-9,
     'un Wild pose AILLEURS sur le rouleau ne multiplie pas la ligne : le'
     + ' rouleau porte le multiplicateur, mais la ligne doit passer dessus');
}

console.log('\n-- seule la meilleure combinaison de chaque ligne est payee --');
{
  const g = new Array(CASES).fill('dix');
  for (let r = 0; r < ROULEAUX; r++) g[1 * ROULEAUX + r] = 'a';
  const res = gainsDe(g, new Array(ROULEAUX).fill(0));
  const surLigne0 = res.lignes.filter((l) => l.ligne === 0);
  ok(surLigne0.length === 1,
     'une ligne ne rend qu UN gain, meme quand plusieurs symboles s y alignent');
}

console.log('\n-- le bonus --');
{
  let series = 0, redecl = 0, bonusPendant = 0, hors = 0;
  for (let i = 1; i <= 200000 && series < 300; i++) {
    const r = joue({ serverSeed: 's', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.ouvre) continue;
    series++;
    if (r.gratuits.tours.length !== r.toursGratuits) redecl++;
    for (const t of r.gratuits.tours)
      if (t.grille.indexOf(BONUS) >= 0) bonusPendant++;
    if (r.toursGratuits < CASES_TIRAGE
        || r.toursGratuits > CASES_TIRAGE * Math.max(...TIRAGE_TOURS.map((t) => t.n))) hors++;
  }
  ok(series > 0, series + ' series jouees');
  ok(bonusPendant === 0,
     'aucun Bonus ne TOMBE pendant la serie : il est retire du tirage, pas'
     + ' seulement ignore au comptage — sinon il s afficherait sans rien faire');
  ok(redecl === 0, 'et la serie fait exactement le nombre de tours tire');
  ok(hors === 0,
     'le nombre tire reste entre ' + CASES_TIRAGE + ' et '
     + CASES_TIRAGE * Math.max(...TIRAGE_TOURS.map((t) => t.n)) + ' tours');
}
{
  /* Les Wilds COLLENT dans leur case, et leur multiplicateur ne bouge plus. */
  let colle = null, bouge = null;
  for (let i = 1; i <= 200000 && !(colle && bouge !== null); i++) {
    const r = joue({ serverSeed: 'k', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.ouvre) continue;
    const t = r.gratuits.tours;
    for (let k = 1; k < t.length; k++) {
      const avant = new Map(t[k - 1].wilds.map((w) => [w.case, w.multi]));
      for (const w of t[k].wilds) {
        if (avant.has(w.case)) {
          if (!colle) colle = { c: w.case, m: w.multi };
          if (avant.get(w.case) !== w.multi) bouge = { c: w.case, a: avant.get(w.case), b: w.multi };
        }
      }
      for (const [c] of avant) if (!t[k].wilds.some((w) => w.case === c)) bouge = bouge || { perdu: c };
    }
  }
  ok(!!colle, 'un Wild reste dans SA CASE d un tour gratuit au suivant'
     + (colle ? ' (case ' + colle.c + ', x' + colle.m + ')' : ''));
  ok(!bouge, 'et ni son multiplicateur ni sa place ne changent'
     + (bouge ? ' — ' + JSON.stringify(bouge) : ''));
}

console.log('\n-- les bornes --');
{
  let max = 0, negatif = 0;
  for (let i = 1; i <= 120000; i++) {
    const r = joue({ serverSeed: 'b', clientSeed: 'c', nonce: i, mise: 100 });
    if (r.multi > max) max = r.multi;
    if (r.payout < 0 || !isFinite(r.multi)) negatif++;
  }
  ok(negatif === 0, 'aucune manche ne rend un gain negatif ou infini');
  ok(max <= GAIN_MAX, 'et aucune ne depasse le plafond de ' + GAIN_MAX
     + 'x (la plus grosse vue : ' + max.toFixed(2) + 'x)');
}

console.log('\n-- le retour publie --');
{
  const G = 14, N = 250000;
  const r = [];
  for (let i = 0; i < G; i++) r.push(100 * mesure(N, 'z' + i).rtp);
  const moy = r.reduce((a, b) => a + b, 0) / G;
  const ec = Math.sqrt(r.reduce((a, b) => a + (b - moy) ** 2, 0) / (G - 1));
  const em = 1.96 * ec / Math.sqrt(G);
  ok(Math.abs(moy - RTP) < 1.5,
     'le chiffre publie (' + RTP.toFixed(2) + ' %) tient face a une remesure : '
     + moy.toFixed(2) + ' % ±' + em.toFixed(2) + ' sur ' + G + 'x' + (N / 1000) + 'k tours');
}

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'chenil.test.js : ' + n + ' verifications OK'));
process.exit(rates ? 1 : 0);
