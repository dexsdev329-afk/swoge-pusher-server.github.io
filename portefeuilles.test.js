'use strict';
/* portefeuilles.js : qui avait achete avant le regard, juge au resultat du jeton.
   Un portefeuille n'a de verdict qu'a partir de 10 jetons, et contre la reference
   d'un acheteur pris au hasard ; une ombre plus vieille que la liste ne credite personne. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PFm = require('./portefeuilles');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const W = (i) => '0x' + i.toString(16).padStart(2, '0').repeat(20);
const J = (i) => '0xf' + i.toString(16).padStart(39, '0');
let horloge = 1e12;
const P = PFm.cree({ maintenant: () => horloge });

console.log('-- les acheteurs d une liste de trades --');
{
  const tr = [
    { kind: 'buy', tx_from_address: W(3).toUpperCase().replace('0X', '0x'), block_timestamp: '2026-09-28T06:31:00Z' },
    { kind: 'sell', tx_from_address: W(9), block_timestamp: '2026-09-28T06:30:00Z' },
    { kind: 'buy', tx_from_address: W(1), block_timestamp: '2026-09-28T06:20:00Z' },
    { kind: 'buy', tx_from_address: W(3), block_timestamp: '2026-09-28T06:25:00Z' },
    { kind: 'buy', tx_from_address: 'pas une adresse', block_timestamp: '2026-09-28T06:10:00Z' },
  ];
  const a = P.acheteursDe(tr);
  ok(a.length === 2 && a[0] === W(1) && a[1] === W(3), 'les acheteurs distincts, les plus anciens d abord, sans les vendeurs ni les adresses abimees : ' + a.join(','));
  const beaucoup = Array.from({ length: 150 }, (_, i) => ({ kind: 'buy', tx_from_address: W(i + 1), block_timestamp: new Date(Date.UTC(2026, 8, 28, 6, 0, 150 - i)).toISOString() }));
  const b = P.acheteursDe(beaucoup);
  ok(b.length === PFm.ACHETEURS_MAX && b[0] === W(150), 'au plus ' + PFm.ACHETEURS_MAX + ' par jeton, les premiers entres gardes');
}

console.log('\n-- un jeton juge credite ses acheteurs, une fois --');
{
  ok(P.note(J(0), 'AAA', [W(1), W(2)]) && !P.note(J(0), 'AAA', [W(3)]), 'la liste du premier regard seule compte');
  ok(P.juge(J(0), 50, horloge - 120e3) === 0 && P._etat().attente[J(0)], 'une ombre posee 2 min AVANT la liste ne credite personne, et la liste attend');
  ok(P.juge(J(0), 50, horloge) === 2 && P.juge(J(0), 50, horloge) === 0, 'l ombre du regard credite les 2 acheteurs, une seule fois');
  const f = P.fiche(W(1));
  ok(f.tokensJudged === 1 && f.risePct === 100 && f.verdict === 'not_enough_data' && /no verdict under 10/.test(f.note), 'un jeton : le chiffre, et le refus de conclure (« ' + f.note + ' »)');
  ok(P.fiche(W(77)).verdict === 'unknown', 'un portefeuille jamais vu : unknown');
  ok(P.juge(J(1), 10) === 0, 'un jeton sans liste : rien');
}

console.log('\n-- la reference, et le verdict contre elle --');
{
  P.vide();
  /* 300 jetons : 60 montent (20 %). W(1) les achete tous (reference), W(2) achete 12 jetons dont 10 montent, W(3) 12 jetons qui s effondrent. */
  let montes = [];
  for (let i = 0; i < 300; i++) {
    const r = i % 5 === 0 ? 40 : -10;
    const ach = [W(1)];
    if (r > 0 && montes.length < 10) { ach.push(W(2)); montes.push(i); }
    P.note(J(i), 'T' + i, ach);
    P.juge(J(i), r, horloge);
  }
  for (let i = 300; i < 302; i++) { P.note(J(i), 'T' + i, [W(2)]); P.juge(J(i), -10, horloge); }
  /* W(4) : 8 montees et 4 effondrements sur 12 — plus des deux. */
  for (let i = 500; i < 512; i++) { P.note(J(i), 'T' + i, [W(4)]); P.juge(J(i), i < 508 ? 60 : -80, horloge); }
  for (let i = 400; i < 412; i++) { P.note(J(i), 'T' + i, [W(3)]); P.juge(J(i), -95, horloge); }
  const R = P.reference();
  console.log('   reference : ' + JSON.stringify(R));
  ok(R.pairs === 300 + 12 + 12 + 12 && R.tokens === 300 + 2 + 12 + 12, 'la reference compte les couples (portefeuille, jeton) : ' + R.pairs + ', sur ' + R.tokens + ' jetons');
  const f2 = P.fiche(W(2)), f3 = P.fiche(W(3)), f1 = P.fiche(W(1));
  console.log('   W2 : ' + f2.note + ' (z ' + f2.z + ')\n   W3 : ' + f3.note + ' (z ' + f3.z + ')\n   W1 : ' + f1.note + ' (z ' + f1.z + ')');
  ok(f2.verdict === 'beats_random_buyers' && f2.z >= 2, '10 montees sur 12 contre ~19 % : bat le hasard');
  ok(f3.verdict === 'worse_than_random_buyers' && f3.collapsePct === 100 && f3.z > -2 && f3.zCollapse >= 2,
     '12 effondrements sur 12 : pire que le hasard — par les effondrements, les montees seules (z ' + f3.z + ') ne l auraient pas vu');
  ok(f1.verdict === 'no_measurable_edge', 'celui qui achete tout EST la reference : aucun avantage mesurable');
  ok(f2.recent.length === 3 && f2.recent[0].change30mPct === -10, 'ses trois derniers jetons, tels quels');
  const f4 = P.fiche(W(4));
  ok(f4.verdict === 'mixed' && f4.z >= 2 && f4.zCollapse >= 2, 'plus de montees ET plus d effondrements : mixed (' + f4.note + ')');
  const l = P.lit([W(3), W(77), W(2), W(1), W(4)]);
  ok(l.buyers === 5 && l.measured === 4 && l.mixed === 1 && l.beatRandom === 1 && l.worseThanRandom === 1 && l.wallets[0].address === W(2), 'les acheteurs d un jeton : les mesures d abord, le meilleur en tete');
  ok(P.meilleurs(5).length === 1 && P.meilleurs(5)[0].address === W(2), 'les meilleurs : seulement ceux qui battent le hasard');
}

console.log('\n-- sous 200 couples, la reference elle-meme ne conclut pas --');
{
  const Q = PFm.cree({ maintenant: () => horloge });
  for (let i = 0; i < 12; i++) { Q.note(J(i), 'X', [W(5)]); Q.juge(J(i), 40, horloge); }
  ok(Q.fiche(W(5)).verdict === 'not_enough_data' && /reference itself is too thin/.test(Q.fiche(W(5)).note), '12 montees sur 12, mais une reference de 12 couples : pas de verdict');
}

console.log('\n-- les bornes : attente oubliee, elagage, fichier --');
{
  const Q = PFm.cree({ maintenant: () => horloge });
  Q.note(J(1), 'X', [W(1)]);
  horloge += 5 * 3600e3;
  Q.note(J(2), 'Y', [W(2)]); Q.juge(J(2), 0, horloge);
  ok(!Q._etat().attente[J(1)] && Q._etat().mesure.oublies === 1, 'une liste non jugee en 4 h est oubliee');
  const E = Q._etat();
  for (let i = 0; i < PFm.PORTEFEUILLES_MAX + 5; i++) E.w['0x' + i.toString(16).padStart(40, '0')] = { n: i < 10 ? 20 : 1, montes: 0, effondres: 0, s: 0, t0: 0, t: i, d: [] };
  Q.note(J(3), 'Z', [W(3)]); Q.juge(J(3), 0, horloge);
  const k = Object.keys(E.w);
  ok(k.length <= PFm.PORTEFEUILLES_MAX && E.w['0x' + (5).toString(16).padStart(40, '0')], 'au-dela de ' + PFm.PORTEFEUILLES_MAX + ' : elague a ' + k.length + ', les portefeuilles mesures restent');
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  const f = path.join(dos, 'portefeuilles.json');
  const A = PFm.cree({ fichier: f, maintenant: () => horloge });
  A.note(J(4), 'S', [W(4)]); A.juge(J(4), 25, horloge); A.sauve(true);
  const B = PFm.cree({ fichier: f, maintenant: () => horloge }); B.charge();
  ok(B.fiche(W(4)).tokensJudged === 1 && B.reference().pairs === 1, 'relu depuis son fichier');
  fs.rmSync(dos, { recursive: true, force: true });
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
