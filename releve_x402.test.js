'use strict';
/* releve_x402.js : l'experience de prix jugee sans aller au-dela des nombres. */
const R = require('./releve_x402');
const { EXPERIENCE_PRIX: X } = require('./agentic');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };
const jour = (j, outils) => ({ jour: j, outils: Object.fromEntries(Object.entries(outils).map(([o, [d, p]]) =>
  [o, { demande402: { n: d + 5, exterieur: { n: d, usd: 0 } }, paye_x402: { n: p + 1, exterieur: { n: p, usd: p * 0.01 } } }])) });
const doc = (jours) => ({ jours: { parJour: jours } });

{
  const r = R.analyse(doc([jour('2026-09-27', { can_i_sell: [100, 1], scan_token: [900, 5] }), jour('2026-09-28', { can_i_sell: [5000, 900] }),
    jour('2026-09-29', { can_i_sell: [300, 3], scan_token: [400, 2] })]));
  ok(r.baisses.avant.dem === 100 && r.baisses.apres.dem === 300 && r.temoins.avant.dem === 900 && r.temoins.apres.dem === 400, 'avant, apres, et le jour de la baisse (mixte) exclu des deux');
  ok(r.baisses.avant.pay === 1 && r.baisses.apres.usd === 0.03, 'seulement l exterieur (la maison ne compte pas)');
  ok(/pas assez de demandes/.test(r.verdict), 'sous 1 000 demandes par groupe : rien a conclure');
}
{
  const r = R.analyse(doc([jour('2026-09-30', { can_i_sell: [2000, 100], scan_token: [2000, 10] })]));
  ok(/MIEUX/.test(r.verdict), 'baisses 5 % contre temoins 0,5 %, intervalles disjoints : mieux');
  const r2 = R.analyse(doc([jour('2026-09-30', { can_i_sell: [2000, 10], scan_token: [2000, 100] })]));
  ok(/MOINS/.test(r2.verdict), 'l inverse : moins bien');
  const r3 = R.analyse(doc([jour('2026-09-30', { can_i_sell: [2000, 11], scan_token: [2000, 10] })]));
  ok(/aucune difference/.test(r3.verdict), '0,55 % contre 0,5 % : aucune difference mesurable');
}
ok(JSON.stringify(R.wilson(1, 100)) === '[0.18,5.45]', 'Wilson 1/100 : [0,18 ; 5,45] %');
ok(X.baisses.includes('can_i_sell') && X.temoins.includes('scan_token') && !X.baisses.some((o) => X.temoins.includes(o)), 'les deux groupes sont disjoints');

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
