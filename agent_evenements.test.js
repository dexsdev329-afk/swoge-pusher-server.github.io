'use strict';
/* LES ÉVÉNEMENTS D'UN JETON (agent_evenements.js, 05/10/2026).
 *
 * Intention : l'agent poste QUAND il se passe quelque chose de réel et mesuré,
 * pas sur une minuterie. On tient les seuils (un petit mouvement est du bruit,
 * on ne déclenche pas) et le franchissement de palier (une fois, vers le haut).
 * Pur : aucun réseau. */

const ev = require('./agent_evenements');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- mouvement de prix : net seulement --');
ok(ev.detecte(null, { priceChangeH1: 15 }).evenement.type === 'price_up', '+15 %/h → price_up');
ok(ev.detecte(null, { priceChangeH1: -18 }).evenement.type === 'price_down', '-18 %/h → price_down');
ok(ev.detecte(null, { priceChangeH1: 4 }).evenement === null, '+4 %/h → rien (bruit sous le seuil)');
ok(ev.detecte(null, { priceChangeH1: -3 }).evenement === null, '-3 %/h → rien');

console.log('\n-- pression acheteuse : assez d observations ET nette domination --');
ok(ev.detecte(null, { buysH1: 120, sellsH1: 20 }).tous.some((e) => e.type === 'buy_pressure'), '120 achats / 20 ventes → buy_pressure');
ok(!ev.detecte(null, { buysH1: 120, sellsH1: 60 }).tous.some((e) => e.type === 'buy_pressure'), '120/60 (2:1) → pas assez domine : rien');
ok(!ev.detecte(null, { buysH1: 20, sellsH1: 1 }).tous.some((e) => e.type === 'buy_pressure'), '20 achats seulement → pas assez d observations : rien');

console.log('\n-- palier de holders : franchi une fois, vers le haut --');
ok(ev.detecte({ holders: 480 }, { holders: 520 }).tous.some((e) => e.type === 'holders_milestone' && e.detail.palier === 500), 'de 480 a 520 → palier 500 franchi');
ok(!ev.detecte({ holders: 520 }, { holders: 540 }).tous.some((e) => e.type === 'holders_milestone'), 'de 520 a 540 → aucun palier entre les deux : rien');
ok(!ev.detecte({ holders: 520 }, { holders: 500 }).tous.some((e) => e.type === 'holders_milestone'), 'qui baisse → jamais un palier (pas de fausse fete)');
ok(ev.detecte(null, { holders: 520 }).tous.every((e) => e.type !== 'holders_milestone'), 'sans instantane precedent → pas de palier (on ne sait pas d ou on vient)');

console.log('\n-- le plus saillant d abord, et une phrase factuelle --');
const r = ev.detecte({ holders: 480 }, { priceChangeH1: 35, buysH1: 200, sellsH1: 10, holders: 520 });
ok(r.evenement && r.tous.length >= 2 && r.tous[0].force >= r.tous[1].force, 'plusieurs evenements : trie par force decroissante');
ok(/last hour/.test(ev.phrase({ type: 'price_up', detail: { h1pct: 15 } })), 'phrase price_up lisible et factuelle');
ok(ev.phrase({ type: 'holders_milestone', detail: { palier: 500, holders: 520 } }).indexOf('500') >= 0, 'phrase holders cite le palier');
ok(ev.phrase(null) === null, 'pas d evenement → pas de phrase');

console.log('\n-- entrees absentes : aucun faux evenement --');
ok(ev.detecte(null, {}).evenement === null, 'instantane vide → rien');
ok(ev.detecte(null, { priceChangeH1: 'NaNish' }).evenement === null, 'valeur non numerique → ignoree, rien');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
