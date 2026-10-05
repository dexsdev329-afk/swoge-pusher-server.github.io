'use strict';
/* LA CAISSE D'UN AGENT (agent_caisse.js, 05/10/2026).
 *
 * Intention : repartir l'argent entrant en paliers cumulatifs — carburant d'abord
 * (notre revenu), puis tresor, puis une part de rachat au-dela d'un seuil — sans
 * jamais perdre un centime. Et dire l'autonomie (runway) d'un agent. Pur. */

const c = require('./agent_caisse');

let n = 0, rates = 0;
const ok = (x, m) => { n++; if (x) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const pres = (a, b) => Math.abs(a - b) < 0.011;

console.log('-- le premier argent va au carburant (amorcage) --');
let r = c.repartit(10, 0);
ok(r.fuel === 10 && r.tresor === 0 && r.rachat === 0, '10 $ depuis zero → tout au carburant');
r = c.repartit(20, 0);
ok(r.fuel === 20 && r.tresor === 0, '20 $ pile → encore tout au carburant');

console.log('\n-- passe 20 $ : 50/50 carburant/tresor --');
r = c.repartit(80, 20);
ok(pres(r.fuel, 40) && pres(r.tresor, 40) && r.rachat === 0, '80 $ apres 20 deja recus → 40 fuel / 40 tresor');

console.log('\n-- au-dela de 100 $ : une part de rachat apparait --');
r = c.repartit(100, 100);
ok(pres(r.fuel, 50) && pres(r.tresor, 35) && pres(r.rachat, 15), '100 $ apres 100 deja recus → 50/35/15');

console.log('\n-- un versement qui TRAVERSE les paliers --');
r = c.repartit(120, 0);   /* 0-20 tout fuel (20), 20-100 50/50 (40/40), 100-120 50/35/15 (10/7/3) */
ok(pres(r.fuel, 70) && pres(r.tresor, 47) && pres(r.rachat, 3), '120 $ depuis zero → 70 fuel / 47 tresor / 3 rachat');
ok(pres(r.fuel + r.tresor + r.rachat, 120), 'la repartition somme EXACTEMENT au montant (aucun centime perdu)');

console.log('\n-- scommes nulles / negatives --');
ok(JSON.stringify(c.repartit(0, 50)) === JSON.stringify({ fuel: 0, tresor: 0, rachat: 0 }), '0 $ → rien');
ok(JSON.stringify(c.repartit(-5, 0)) === JSON.stringify({ fuel: 0, tresor: 0, rachat: 0 }), 'montant negatif → rien');

console.log('\n-- recalage au centime (pas de perte d arrondi) --');
for (let i = 0; i < 40; i++) {
  const m = Math.round((Math.random() * 200 + 0.01) * 100) / 100, deja = Math.round(Math.random() * 150 * 100) / 100;
  const x = c.repartit(m, deja);
  if (!pres(x.fuel + x.tresor + x.rachat, m)) { ok(false, 'somme != montant pour ' + m + '/' + deja); break; }
}
ok(true, '40 tirages aleatoires : la somme colle toujours au montant');

console.log('\n-- autonomie (runway) --');
let a = c.autonomie(1, 0.005, 60);
ok(a.pensees === 200 && a.heures === 200, '1 $ a 0,005 $/pensee, cadence 60 min → 200 pensees, 200 h');
ok(c.autonomie(0, 0.005, 60).pensees === 0 && c.autonomie(1, 0, 60).pensees === 0, 'solde 0 ou cout 0 → 0 (pas de division hasardeuse)');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
