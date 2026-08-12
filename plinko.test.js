'use strict';
/*
 * Verification du Plinko.
 *
 * Le jeu se calcule exactement : 8, 12 ou 16 rangees, donc 256, 4096 ou 65536
 * chemins possibles. On les ENUMERE TOUS, on compte ou ils arrivent, et on
 * compare a la formule. Aucune approximation, aucune simulation pour etablir
 * les probabilites — la simulation ne sert qu'a verifier que le tirage reel
 * suit bien la loi qu'on vient de prouver.
 */
const assert = require('assert');
const P = require('./plinko');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} : ${a} vs ${b}`); n++; };

const CIBLE = 0.97;          // 3 % d'avantage maison
const BPS = 300;

// ------------------------------------------------- enumeration exhaustive
/* Pour chaque nombre de rangees on parcourt les 2^n chemins et on compte les
   arrivees. Si la formule binomiale dit autre chose, c'est elle qui a tort. */
for (const rangees of P.RANGEES) {
  const compte = new Array(rangees + 1).fill(0);
  const total = Math.pow(2, rangees);
  for (let masque = 0; masque < total; masque++) {
    let k = 0;
    for (let i = 0; i < rangees; i++) k += (masque >> i) & 1;
    compte[k]++;
  }
  for (let k = 0; k <= rangees; k++) {
    eq(compte[k], P.binom(rangees, k), `${rangees} rangees : C(${rangees},${k}) compte`);
    pres(P.chance(rangees, k), compte[k] / total, 1e-12, `${rangees} rangees : chance case ${k}`);
  }
  let s = 0;
  for (let k = 0; k <= rangees; k++) s += P.chance(rangees, k);
  pres(s, 1, 1e-12, `${rangees} rangees : les probabilites somment a 1`);
}

// ------------------------------------------------------- forme des tables
for (const rangees of P.RANGEES) {
  for (const risque of P.RISQUES) {
    const t = P.table(rangees, risque, BPS);
    eq(t.length, rangees + 1, `${rangees}/${risque} : une case de plus que de rangees`);
    ok(t.every((x) => x > 0), `${rangees}/${risque} : aucun multiplicateur nul`);
    // symetrique : le plateau l'est, la table doit l'etre
    for (let k = 0; k <= rangees; k++)
      eq(t[k], t[rangees - k], `${rangees}/${risque} : symetrie case ${k}`);
    // croissante du centre vers le bord — sinon viser le centre serait un pari
    const mid = rangees / 2;
    for (let k = Math.ceil(mid); k < rangees; k++)
      ok(t[k + 1] >= t[k], `${rangees}/${risque} : croissante vers le bord (${k})`);
    ok(Math.min(...t) === t[mid], `${rangees}/${risque} : le minimum est au centre`);
    ok(Math.max(...t) === t[0], `${rangees}/${risque} : le maximum est au bord`);
  }
}

// ------------------------------------------------------ taux de retour exact
/* La propriete qui compte : l'esperance, ARRONDIS COMPRIS, ne depasse jamais
   la cible. L'ajustement d'echelle peut remonter un multiplicateur au-dessus
   de sa valeur ideale — c'est permis, tant que la SOMME reste sous la cible. */
let pireArrondi = 0;
console.log('  taux de retour exact (avantage 3 %) :');
for (const rangees of P.RANGEES) {
  for (const risque of P.RISQUES) {
    const r = P.retour(rangees, risque, BPS);
    const t = P.table(rangees, risque, BPS);
    console.log('    %s rangees, %s : %s %  (de %s a %s)',
      String(rangees).padStart(2), risque.padEnd(6), (100 * r).toFixed(2),
      Math.min(...t).toFixed(2), Math.max(...t).toFixed(2));
    ok(r <= CIBLE + 1e-12, `${rangees}/${risque} : ne depasse JAMAIS la cible (${r})`);
    ok(r >= CIBLE - 0.004, `${rangees}/${risque} : l arrondi coute moins de 0,4 % (${r})`);
    pireArrondi = Math.max(pireArrondi, CIBLE - r);
  }
}

/* Ce que coute l'arrondi a deux decimales, dit en clair plutot que cache
   derriere un seuil : c'est de l'argent que le joueur perd en plus de
   l'avantage annonce, et il doit rester negligeable. Le pire cas est le petit
   plateau, ou neuf cases seulement laissent peu de marge d'ajustement. */
console.log('    cout de l arrondi : %s %% au pire', (100 * pireArrondi).toFixed(3));
ok(pireArrondi < 0.003, `l arrondi coute moins de 0,3 % partout (${pireArrondi})`);

// sans avantage, le jeu doit revenir a 100 % : si ce n'est pas le cas, l'erreur
// est ailleurs que dans le reglage de l'avantage
{
  let pire = 1;
  for (const rangees of P.RANGEES) {
    for (const risque of P.RISQUES) {
      const r = P.retour(rangees, risque, 0);
      ok(r <= 1 + 1e-12, `${rangees}/${risque} : jamais au-dessus de 100 %`);
      ok(r >= 0.997, `${rangees}/${risque} : equitable a 0,3 % pres (${r})`);
      pire = Math.min(pire, r);
    }
  }
  console.log('  sans avantage : %s %% au pire, 100 %% au mieux', (100 * pire).toFixed(3));
}

// ---------------------------------------------- la maison peut payer
/* Un multiplicateur de bord a 5000x sur une mise plafonnee serait un gain que
   la caisse ne pourrait pas honorer. La forme borne ce rapport ; on le verifie
   plutot que de l'esperer. */
{
  const PLAFOND = 10000;                       // CASINO_MAX_BET
  for (const rangees of P.RANGEES) {
    for (const risque of P.RISQUES) {
      const max = Math.max(...P.table(rangees, risque, BPS));
      ok(max <= 150, `${rangees}/${risque} : multiplicateur maximum tenable (${max})`);
      ok(max * PLAFOND <= 1500000, `${rangees}/${risque} : gain maximum tenable`);
    }
  }
}

// ------------------------------------------------------------- reglages
{
  assert.throws(() => P.table(9, 'low', 0), /rangees invalide/); n++;
  assert.throws(() => P.table(16, 'extreme', 0), /risque inconnu/); n++;
  // plus de risque = bords plus hauts et centre plus bas, a rangees egales
  for (const rangees of P.RANGEES) {
    const b = P.table(rangees, 'low', BPS), m = P.table(rangees, 'medium', BPS), h = P.table(rangees, 'high', BPS);
    ok(h[0] > m[0] && m[0] > b[0], `${rangees} : les bords montent avec le risque`);
    const c = rangees / 2;
    ok(h[c] < m[c] && m[c] < b[c], `${rangees} : le centre baisse avec le risque`);
  }
}

// ---------------------------------------------------------------- tirage
{
  // le chemin fait bien une decision par rangee, et la case en est la somme
  for (const rangees of P.RANGEES) {
    for (let i = 0; i < 50; i++) {
      const c = P.chemin('s', 'c', i, rangees);
      eq(c.length, rangees, `${rangees} rangees : un bit par picot`);
      ok(c.every((b) => b === 0 || b === 1), 'des bits, rien d autre');
      const k = P.caseDe(c);
      ok(k >= 0 && k <= rangees, 'case dans le plateau');
      eq(k, c.reduce((s, b) => s + b, 0), 'la case est la somme du chemin');
    }
  }
  // reproductible, et separe par le numero d'ordre
  eq(P.chemin('a', 'b', 7, 16).join(), P.chemin('a', 'b', 7, 16).join(), 'chemin reproductible');
  let differe = 0;
  for (let i = 0; i < 50; i++)
    if (P.chemin('a', 'b', i, 16).join() !== P.chemin('a', 'b', i + 1, 16).join()) differe++;
  ok(differe >= 49, 'le numero d ordre change le chemin');
}

// -------------------------------- le tirage reel suit bien la loi prouvee
{
  const rangees = 16, N = 400000;
  const compte = new Array(rangees + 1).fill(0);
  for (let i = 0; i < N; i++) compte[P.caseDe(P.chemin('u', 'c', i, rangees))]++;
  let pireEcart = 0;
  for (let k = 0; k <= rangees; k++) {
    const attendu = P.chance(rangees, k) * N;
    if (attendu < 200) continue;                     // trop rare pour conclure
    pireEcart = Math.max(pireEcart, Math.abs(compte[k] - attendu) / attendu);
  }
  ok(pireEcart < 0.06, `le tirage suit la loi binomiale (ecart max ${(100 * pireEcart).toFixed(1)} %)`);
  // les bits eux-memes doivent tomber a pile ou face
  let uns = 0, tot = 0;
  for (let i = 0; i < 40000; i++) { const c = P.chemin('b', 'c', i, 16); uns += P.caseDe(c); tot += 16; }
  pres(uns / tot, 0.5, 0.01, 'un bit sur deux, gauche ou droite');
}

// --------------------------------------------------------------- une bille
{
  const r = P.lancer({ serverSeed: 'x', clientSeed: 'y', nonce: 1, mise: 100,
                       rangees: 16, risque: 'medium', edgeBps: BPS });
  eq(r.chemin.length, 16, 'le chemin complet est renvoye');
  eq(r.case, P.caseDe(r.chemin), 'la case annoncee est celle du chemin');
  eq(r.multi, r.table[r.case], 'le multiplicateur est celui de la case');
  eq(r.payout, Math.floor(100 * r.multi), 'payout = mise x multiplicateur');
  eq(r.net, r.payout - 100, 'net = payout - mise');
  // arrondi entier vers le bas
  const f = P.lancer({ serverSeed: 'x', clientSeed: 'y', nonce: 1, mise: 333,
                       rangees: 16, risque: 'medium', edgeBps: BPS });
  eq(f.payout, Math.floor(333 * f.multi), 'arrondi entier vers le bas');
  eq(f.case, r.case, 'meme graine, meme case, quelle que soit la mise');
}

// ------------------------- le tirage suit la loi, a toutes les tailles
/* Dernier filet. On NE simule PAS le taux de retour : sur une table a 36x, le
   gain tient presque entier sur une case tiree une fois sur 256, et 1,5 million
   de billes laissent encore 0,27 % d'incertitude — l'estimation ne saurait pas
   distinguer une erreur reelle d'un ecart de deux ecarts-types (c'est ce qui
   est arrive : +0,53 %, entierement explique par 246 passages de trop sur les
   deux cases de bord).
   On verifie donc ce qui SE MESURE bien — la distribution des cases — et on
   calcule le retour a partir d'elle, exactement. Si la loi est bonne et la
   table juste, le retour l'est aussi ; il n'y a rien a estimer. */
{
  for (const [rangees, N] of [[8, 400000], [12, 400000], [16, 400000]]) {
    const compte = new Array(rangees + 1).fill(0);
    for (let i = 0; i < N; i++) compte[P.caseDe(P.chemin('loi:' + (i >> 12), 'c', i, rangees))]++;
    let pire = 0, pireCase = -1;
    for (let k = 0; k <= rangees; k++) {
      const p = P.chance(rangees, k), attendu = N * p;
      if (attendu < 60) continue;                    // trop rare pour conclure
      const sigma = Math.sqrt(N * p * (1 - p));
      const ecart = Math.abs(compte[k] - attendu) / sigma;
      if (ecart > pire) { pire = ecart; pireCase = k; }
    }
    console.log('    %s rangees : ecart maximum %s ecarts-types (case %s)',
      String(rangees).padStart(2), pire.toFixed(2), pireCase);
    ok(pire < 4, `${rangees} rangees : la distribution suit la loi (${pire.toFixed(2)} sigma)`);
    // et la somme des comptes fait bien le compte
    eq(compte.reduce((a, b) => a + b, 0), N, `${rangees} rangees : aucune bille perdue`);
  }

  /* Le seul retour qu'on mesure est celui d'une table PLATE, ou aucune case
     rare ne domine : la mesure y est assez fine pour dire quelque chose. */
  const N = 400000;
  let mise = 0, rendu = 0;
  for (let i = 0; i < N; i++) {
    const r = P.lancer({ serverSeed: 'plat:' + (i >> 12), clientSeed: 'c', nonce: i,
                         mise: 1000, rangees: 16, risque: 'low', edgeBps: BPS });
    mise += 1000; rendu += r.payout;
  }
  const mesure = rendu / mise, exact = P.retour(16, 'low', BPS);
  console.log('    16/low sur %s billes : mesure %s %% contre %s %% calcule',
    N, (100 * mesure).toFixed(2), (100 * exact).toFixed(2));
  pres(mesure, exact, 0.004, 'sur une table plate, mesure et calcul se rejoignent');
}

console.log(`plinko.test.js : ${n} verifications OK`);
