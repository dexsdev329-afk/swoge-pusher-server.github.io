'use strict';
/*
 * Verification du Mines.
 *
 * Le jeu est de la combinatoire pure : on peut donc verifier EXACTEMENT, pas
 * approximativement. Pour les 24 nombres de bombes et toutes les longueurs de
 * partie possibles — 300 couples en tout — on compare la formule a un comptage
 * direct, puis on verifie que l'esperance vaut 1 au centieme pres sans
 * avantage maison. Une simulation ne prouverait rien d'aussi fort.
 */
const assert = require('assert');
const M = require('./mines');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} : ${a} vs ${b}`); n++; };

// --------------------------------------------------------------- comptage
/* chance(m,k) doit valoir C(25-m,k)/C(25,k) : la proportion de tirages de k
   cases qui evitent toutes les bombes. On calcule les binomiaux a part, sans
   passer par la formule du module. */
function binom(a, b) {
  if (b < 0 || b > a) return 0;
  let r = 1;
  for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1);
  return r;
}
for (let m = M.MINES_MIN; m <= M.MINES_MAX; m++) {
  for (let k = 0; k <= M.CASES - m; k++) {
    pres(M.chance(m, k), binom(M.CASES - m, k) / binom(M.CASES, k), 1e-9,
         `chance ${m} bombes ${k} cases`);
  }
}
// au-dela du nombre de cases sures, plus rien n'est possible
for (let m = 1; m <= 24; m++) eq(M.chance(m, M.CASES - m + 1), 0, `plus de case sure (${m})`);

// --------------------------------------------------------------- equite
/* Sans avantage, esperance = chance x multiplicateur = 1, exactement, pour
   TOUS les couples. Un multiplicateur faux se voit ici tout de suite. */
for (let m = M.MINES_MIN; m <= M.MINES_MAX; m++) {
  for (let k = 1; k <= M.CASES - m; k++) {
    const p = M.chance(m, k);
    const exact = 1 / p;
    pres(p * exact, 1, 1e-9, `equite exacte ${m}/${k}`);
    for (const bps of [0, 300, 1000]) {
      const mm = M.multiplicateur(m, k, bps);
      // l'arrondi vers le bas ne peut que RETIRER au joueur
      ok(mm <= exact * (1 - bps / 10000) + 1e-9, `arrondi jamais favorable ${m}/${k}/${bps}`);
      ok(mm >= exact * (1 - bps / 10000) - 0.01, `arrondi a moins d'un centieme ${m}/${k}/${bps}`);
    }
  }
}

// quelques valeurs verifiables de tete
eq(M.multiplicateur(1, 1, 0), 1.04, '1 bombe, 1 case : 25/24 = 1.041…');
eq(M.multiplicateur(24, 1, 0), 25, '24 bombes, 1 case : 25/1 = 25.00');
eq(M.multiplicateur(5, 0, 0), 1, 'zero case ouverte : on n a rien gagne');
eq(M.multiplicateur(12, 13, 0), M.maximum(12, 0), 'maximum = toutes les cases sures');

// --------------------------------------------------------------- placement
{
  // le bon nombre de bombes, sans doublon, toujours dans la grille
  for (let m = 1; m <= 24; m++) {
    const b = M.plateau('s', 'c', m, m);
    eq(b.length, m, `${m} bombes posees`);
    eq(new Set(b).size, m, 'aucune bombe en double');
    ok(b.every((x) => x >= 0 && x < 25), 'toutes dans la grille');
    ok(b.every((x, i) => i === 0 || x > b[i - 1]), 'liste triee');
  }
  M.MINES_MIN, assert.throws(() => M.plateau('s', 'c', 1, 0), /invalide/); n++;
  assert.throws(() => M.plateau('s', 'c', 1, 25), /invalide/); n++;
}

// --------------------------------------------- placement uniforme
/* Chaque case doit avoir la meme chance de porter une bombe. Un melange mal
   fait (ou un modulo brut) concentrerait les bombes sur le debut de grille. */
{
  const N = 120000, m = 5;
  const compte = new Array(25).fill(0);
  for (let i = 0; i < N; i++) M.plateau('u', 'c', i, m).forEach((c) => compte[c]++);
  const attendu = N * m / 25;
  const ecart = Math.max(...compte.map((c) => Math.abs(c - attendu) / attendu));
  ok(ecart < 0.05, `placement uniforme (ecart max ${(ecart * 100).toFixed(1)} %)`);
  eq(compte.filter((c) => c === 0).length, 0, 'les 25 cases peuvent porter une bombe');
}

// meme graine, meme grille ; coordonnees differentes, autre grille
{
  eq(M.plateau('a', 'b', 7, 4).join(), M.plateau('a', 'b', 7, 4).join(), 'grille reproductible');
  let differe = 0;
  for (let i = 0; i < 50; i++)
    if (M.plateau('a', 'b', i, 4).join() !== M.plateau('a', 'b', i + 1, 4).join()) differe++;
  ok(differe >= 48, 'le numero d ordre change bien la grille');
}

// --------------------------------------------------------------- deroule
{
  const e = M.ouvrir({ serverSeed: 'x', clientSeed: 'y', nonce: 1, mise: 100, nbMines: 3, edgeBps: 300 });
  eq(e.multi, 1, 'on part a 1x');
  eq(e.mise, 100, 'la mise est retenue');
  eq(e.bombes.length, 3, 'trois bombes');
  eq(e.fini, false, 'partie ouverte');

  assert.throws(() => M.jouer({ etat: e, position: -1 }), /hors grille/); n++;
  assert.throws(() => M.jouer({ etat: e, position: 25 }), /hors grille/); n++;

  // une case sure ouverte deux fois doit etre refusee, pas comptee deux fois
  const sure = [...Array(25).keys()].find((c) => e.bombes.indexOf(c) < 0);
  const r = M.jouer({ etat: e, position: sure });
  ok(r.sure, 'la case choisie etait sure');
  eq(r.etat.ouvertes.length, 1, 'une case ouverte');
  ok(r.etat.multi > 1, 'le multiplicateur a monte');
  assert.throws(() => M.jouer({ etat: r.etat, position: sure }), /deja ouverte/); n++;

  // une bombe ferme tout
  const b = M.jouer({ etat: r.etat, position: e.bombes[0] });
  eq(b.sure, false, 'la bombe est reconnue');
  eq(b.etat.fini, true, 'partie close');
  eq(b.etat.perdu, true, 'partie perdue');
  eq(b.etat.multi, 0, 'multiplicateur a zero');
  assert.throws(() => M.jouer({ etat: b.etat, position: sure }), /terminee/); n++;
  assert.throws(() => M.encaisser(b.etat), /terminee/); n++;
}

// le multiplicateur suit exactement le nombre de cases ouvertes
{
  for (const m of [1, 3, 5, 10, 24]) {
    let e = M.ouvrir({ serverSeed: 'suite', clientSeed: 'c', nonce: m, mise: 10, nbMines: m, edgeBps: 300 });
    const sures = [...Array(25).keys()].filter((c) => e.bombes.indexOf(c) < 0);
    for (let k = 0; k < sures.length; k++) {
      e = M.jouer({ etat: e, position: sures[k] }).etat;
      eq(e.multi, M.multiplicateur(m, k + 1, 300), `${m} bombes, ${k + 1} cases`);
    }
    eq(e.fini, true, `${m} bombes : la grille terminee ferme la partie`);
    eq(e.complet, true, `${m} bombes : marquee comme complete`);
    // une grille finie proprement s'encaisse quand meme
    const f = M.encaisser(e);
    eq(f.payout, Math.floor(10 * M.maximum(m, 300)), `${m} bombes : paiement maximum`);
  }
}

// --------------------------------------------------------------- taux de retour
/* Avec un avantage preleve UNE FOIS, le taux doit valoir (1 - avantage) quelle
   que soit la facon de jouer : peu de bombes ou beaucoup, une case ou vingt.
   C'est precisement ce qui distingue ce jeu du Hi-Lo, et ce qu'il faut prouver. */
/* L'ordre des cases est FIXE, et surtout independant du numero d'ordre de la
   partie. Une premiere version le melangeait avec une formule tiree de `i`,
   qui sert aussi a placer les bombes : les deux se correlaient et le taux de
   retour sortait a 100,9 % sans avantage, soit trois ecarts-types trop haut.
   La grille etant uniforme sur tous les sous-ensembles, ouvrir les cases dans
   un ordre arrete donne exactement la bonne probabilite de survie, sans
   aucun risque de correlation. */
function simule({ nbMines, cases, edgeBps, parties = 200000, graine = 'rtp', ordre }) {
  const suite = ordre || [...Array(25).keys()];
  let mise = 0, rendu = 0;
  for (let i = 0; i < parties; i++) {
    const ss = graine + ':' + (i >> 12);
    let e = M.ouvrir({ serverSeed: ss, clientSeed: 'c', nonce: i, mise: 100, nbMines, edgeBps });
    mise += 100;
    for (let c = 0; c < cases; c++) {
      e = M.jouer({ etat: e, position: suite[c] }).etat;
      if (e.fini) break;
    }
    if (!e.perdu && e.ouvertes.length) rendu += M.encaisser(e).payout;
  }
  return rendu / mise;
}

{
  const E = 300;
  const cas = [
    { nbMines: 1, cases: 5 }, { nbMines: 1, cases: 20 },
    { nbMines: 3, cases: 1 }, { nbMines: 3, cases: 10 },
    { nbMines: 5, cases: 3 }, { nbMines: 10, cases: 5 },
    { nbMines: 24, cases: 1 },
  ];
  console.log('  taux de retour (avantage 3 % preleve une fois) :');
  for (const c of cas) {
    const t = simule({ ...c, edgeBps: E });
    console.log('    %s bombes, %s cases : %s %',
      String(c.nbMines).padStart(2), String(c.cases).padStart(2), (t * 100).toFixed(2));
    pres(t, 0.97, 0.02, `${c.nbMines} bombes / ${c.cases} cases rend 97 %`);
    ok(t < 1, 'la maison garde un avantage');
  }
  /* Meme grille, meme longueur, ordre de cases completement different : le
     taux ne doit pas bouger. C'est ce qui prouve qu'aucune facon de cliquer
     n'est meilleure qu'une autre. */
  const droit = simule({ nbMines: 5, cases: 6, edgeBps: E, graine: 'ordre' });
  const disperse = simule({ nbMines: 5, cases: 6, edgeBps: E, graine: 'ordre',
                            ordre: [12, 0, 24, 4, 20, 6, 18, 2, 22, 10, 14, 8, 16, 1, 23, 3, 21, 5, 19, 7, 17, 9, 15, 11, 13] });
  console.log('    ordre lineaire %s %% contre ordre disperse %s %%',
    (droit * 100).toFixed(2), (disperse * 100).toFixed(2));
  pres(droit, disperse, 0.015, 'l ordre des clics ne change pas le taux de retour');
}

// sans avantage, le jeu doit revenir a 100 % : si ce n'est pas le cas, l'erreur
// est ailleurs que dans le reglage de l'avantage
{
  for (const c of [{ nbMines: 3, cases: 8 }, { nbMines: 12, cases: 4 }]) {
    const t = simule({ ...c, edgeBps: 0, parties: 400000, graine: 'neutre' });
    console.log('    sans avantage (%d bombes, %d cases) : %s %', c.nbMines, c.cases, (t * 100).toFixed(2));
    pres(t, 1, 0.012, `sans avantage, ${c.nbMines}/${c.cases} est equitable`);
  }
}

// --------------------------------------------------------------- encaissement
{
  let e = M.ouvrir({ serverSeed: 'enc', clientSeed: 'c', nonce: 7, mise: 250, nbMines: 3, edgeBps: 0 });
  assert.throws(() => M.encaisser(e), /aucune case/); n++;   // rien d'ouvert, rien a prendre
  const sure = [...Array(25).keys()].find((c) => e.bombes.indexOf(c) < 0);
  e = M.jouer({ etat: e, position: sure }).etat;
  const r = M.encaisser(e);
  eq(r.payout, Math.floor(250 * e.multi), 'payout = mise x multiplicateur');
  eq(r.net, r.payout - 250, 'net = payout - mise');
  eq(r.etat.fini, true, 'la partie se ferme');
  assert.throws(() => M.encaisser(r.etat), /terminee/); n++;
  assert.throws(() => M.jouer({ etat: r.etat, position: sure + 1 }), /terminee/); n++;
  // arrondi entier vers le bas
  const f = M.encaisser({ ...e, mise: 333, multi: 1.07 });
  eq(f.payout, Math.floor(333 * 1.07), 'arrondi entier vers le bas');
}

console.log(`mines.test.js : ${n} verifications OK`);
