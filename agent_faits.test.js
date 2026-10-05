'use strict';
/* LES FAITS LIVE D'UN JETON.
 *
 * Intention (à tenir si un changement contredit l'essai) : on ne cite QUE ce
 * qu'une source a donné — une valeur absente ne produit jamais de fait (pas de
 * chiffre inventé) ; GoPlus est tri-état (inconnu ≠ vert) ; une source qui
 * tombe n'efface pas les autres ; les faits sont courts, en anglais, sans doublon.
 */
const F = require('./agent_faits');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- 1. usd : compact et jamais trompeur --');
ok(F.usd(13989475) === '$14M', '13 989 475 → $14M');
ok(F.usd(544573) === '$544.6K', '544 573 → $544.6K');
ok(F.usd(0) === '$0' && F.usd(-5) === null, '0 → $0 ; un négatif → null (pas de fait)');
ok(/^\$0\.0000/.test(F.usd(0.00002785)), 'un petit prix garde ses chiffres significatifs');

console.log('\n-- 2. composeFaits : une valeur absente ne crée aucun fait --');
let f = F.composeFaits({ priceUsd: 0.0000278, liqUsd: 14900, vol24Usd: 12700000 });
ok(f.some((x) => /price \$/.test(x)) && f.some((x) => /liquidity \$14.9K/.test(x)) && f.some((x) => /24h volume \$12.7M/.test(x)), 'prix, liquidité et volume présents → trois faits');
ok(!f.some((x) => /market cap|holder|honeypot|tax|renounced|LP/.test(x)), 'rien d autre : aucun fait inventé');
f = F.composeFaits({});
ok(f.length === 0, 'sources vides → aucun fait');

console.log('\n-- 3. GoPlus tri-état : inconnu n est pas vert --');
ok(F.deGoPlus({ is_honeypot: '0', is_mintable: '0', owner_address: '0x0000000000000000000000000000000000000000', buy_tax: '0', sell_tax: '0', holder_count: '3' }).taxConnue === true, 'taxe connue quand buy/sell sont fournis');
let g = F.deGoPlus({ is_honeypot: '0', buy_tax: [], sell_tax: [] });
ok(g.honeypot === false && g.taxConnue === undefined, 'honeypot vert, mais taxe en [] = inconnue → pas de taxConnue');
f = F.composeFaits(g);
ok(f.includes('not a honeypot (GoPlus)') && !f.some((x) => /tax/.test(x)), 'on affiche « not a honeypot » mais JAMAIS « 0% tax » quand la taxe est inconnue');
f = F.composeFaits(F.deGoPlus({ is_honeypot: '0', is_mintable: '0', owner_address: '0x0000000000000000000000000000000000000000', buy_tax: '0', sell_tax: '0' }));
ok(f.includes('0% buy/sell tax') && f.includes('ownership renounced') && f.includes('not mintable'), 'taxe connue nulle + renoncé + non mintable → trois faits verts');

console.log('\n-- 4. deMarche : âge calculé, mcap = marketCap sinon fdv --');
let m = F.deMarche({ priceUsd: '0.01', liquidity: { usd: '5000' }, fdv: '99999', pairCreatedAt: Date.parse('2026-10-01T00:00:00Z') }, Date.parse('2026-10-05T00:00:00Z'));
ok(m.mcapUsd === 99999 && m.ageDays === 4, 'fdv sert de mcap faute de marketCap ; âge = 4 jours');

console.log('\n-- 5. recolte : une source qui tombe n efface pas les autres --');
(async () => {
  let r = await F.recolte('0xabc', {
    marche: async () => ({ priceUsd: '0.01', liquidity: { usd: 5000 } }),
    goplus: async () => { throw new Error('GoPlus muet'); },
    cansell: async () => ({ allerRetourPct: 98.7, lpVerrouille: true }),
    maintenant: () => Date.parse('2026-10-05T00:00:00Z'),
  });
  ok(r.faits.some((x) => /liquidity \$5K/.test(x)), 'le marché passe malgré GoPlus en panne');
  ok(r.faits.some((x) => /round-trip/.test(x)) && r.faits.includes('LP locked forever'), 'can_i_sell : revente ~99% et LP verrouillée');
  ok(!r.faits.some((x) => /honeypot|tax/.test(x)), 'GoPlus tombé : aucun fait de sécurité inventé');

  r = await F.recolte('0xabc', {});
  ok(r.faits.length === 0, 'aucun adaptateur : aucun fait, aucune erreur');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
