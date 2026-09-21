'use strict';
/* ============================================================================
 * PERP — DECOUVERTE ET NORMALISATION
 *
 * On ne teste pas l internet : on injecte des reponses REELLES capturees des
 * exchanges et on verifie que la normalisation ramene tout a la forme unique.
 * Ce qui compte :
 *   1. un marche a la MEME forme quel que soit l exchange ;
 *   2. tous les champs demandes sont la quand la source les donne, null
 *      sinon — jamais une valeur inventee ;
 *   3. un exchange qui tombe n empeche pas les autres ;
 *   4. l OI et le volume sont comparables entre marches (notionnel USD).
 * ==========================================================================*/
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');
const M = require('./perp_marches');

/* Reponses reelles, capturees des exchanges (formes exactes, valeurs
   raccourcies). */
const HL = JSON.stringify([
  { universe: [
    { name: 'BTC', maxLeverage: 40, szDecimals: 5 },
    { name: 'ETH', maxLeverage: 25, szDecimals: 4 },
    { name: 'MORT', maxLeverage: 3, szDecimals: 0, isDelisted: true },
  ] },
  [
    { funding: '0.0000125', openInterest: '43260.85', prevDayPx: '80512.0', dayNtlVlm: '1779653610.44',
      oraclePx: '81408.0', markPx: '81440.0', midPx: '81442.5', impactPxs: ['81442.0', '81446.9'] },
    { funding: '-0.0000031', openInterest: '120000.0', prevDayPx: '3100.0', dayNtlVlm: '900000000.0',
      oraclePx: '3150.0', markPx: '3151.0', midPx: '3150.5', impactPxs: ['3150.4', '3150.6'] },
    { funding: '0', openInterest: '0', prevDayPx: '1', dayNtlVlm: '0', oraclePx: '1', markPx: '1', midPx: '1', impactPxs: ['1', '1'] },
  ],
]);
const OKX_INST = JSON.stringify({ data: [
  { instId: 'BTC-USDT-SWAP', instType: 'SWAP', settleCcy: 'USDT', ctValCcy: 'BTC', state: 'live' },
  { instId: 'ETH-USD-SWAP', instType: 'SWAP', settleCcy: 'ETH', ctValCcy: 'ETH', state: 'live' },  /* pas USDT : ecarte */
  { instId: 'OLD-USDT-SWAP', instType: 'SWAP', settleCcy: 'USDT', ctValCcy: 'OLD', state: 'suspend' }, /* pas live */
] });
const OKX_TICK = JSON.stringify({ data: [
  { instId: 'BTC-USDT-SWAP', last: '81500', bidPx: '81499', askPx: '81501', open24h: '80000', volCcy24h: '12345' },
] });

(async () => {

console.log('-- 1. Hyperliquid : la forme unique, tous les champs reels --');
{
  M._reseau({ post: async () => ({ code: 200, corps: HL }), get: async () => ({ code: 200, corps: '{"data":[]}' }) });
  M._videCache();
  const v = await M.decouvre(true);
  const hl = v.marches.filter((m) => m.exchange === 'Hyperliquid');
  eq(hl.length, 2, 'un perp delisted est ecarte, les deux vivants restent');
  const btc = hl.find((m) => m.base === 'BTC');
  eq(btc.symbole, 'BTC/USD:PERP', 'la cle inter-exchange est stable');
  eq(btc.last, 81442.5, 'last = midPx');
  eq(btc.bid, 81442, 'bid vient de impactPxs[0]');
  eq(btc.ask, 81446.9, 'ask vient de impactPxs[1]');
  eq(btc.markPrice, 81440, 'mark price');
  eq(btc.indexPrice, 81408, 'index price = oraclePx');
  eq(btc.fundingRate, 0.0000125, 'funding rate');
  eq(btc.volume24h, 1779653610.44, 'volume 24h en notionnel');
  /* OI en notionnel USD : 43260.85 BTC * 81440 mark, comparable entre marches. */
  eq(Math.round(btc.openInterest), Math.round(43260.85 * 81440), 'open interest en notionnel USD');
  ok(Math.abs(btc.variation24h - ((81442.5 - 80512) / 80512 * 100)) < 1e-9, 'variation 24h calculee du prevDayPx');
  /* funding negatif conserve son signe. */
  ok(hl.find((m) => m.base === 'ETH').fundingRate < 0, 'un funding negatif reste negatif');
}

console.log('\n-- 2. OKX : meme forme, filtres reels --');
{
  M._reseau({ post: async () => ({ code: 200, corps: '[[],[]]' }),
              get: async (u) => ({ code: 200, corps: /instruments/.test(u) ? OKX_INST : OKX_TICK }) });
  M._videCache();
  const v = await M.decouvre(true);
  const okx = v.marches.filter((m) => m.exchange === 'OKX');
  eq(okx.length, 1, 'seuls les swaps USDT vivants passent (ETH-USD et suspend ecartes)');
  eq(okx[0].symbole, 'BTC/USDT:PERP', 'meme forme que Hyperliquid, quote USDT');
  eq(okx[0].last, 81500, 'last du ticker');
  ok(Math.abs(okx[0].variation24h - ((81500 - 80000) / 80000 * 100)) < 1e-9, 'variation du open24h');
  /* Ce qu OKX ne donne pas dans ce lot reste null, jamais invente. */
  eq(okx[0].markPrice, null, 'un champ absent est null, pas devine');
  eq(okx[0].fundingRate, null, 'le funding absent aussi');
}

console.log('\n-- 3. un exchange qui tombe n arrete pas les autres --');
{
  M._reseau({ post: async () => { throw new Error('hyperliquid muet'); },
              get: async (u) => ({ code: 200, corps: /instruments/.test(u) ? OKX_INST : OKX_TICK }) });
  M._videCache();
  const v = await M.decouvre(true);
  const hl = v.exchanges.find((e) => e.nom === 'Hyperliquid');
  eq(hl.ok, false, 'Hyperliquid est note en echec');
  ok(/muet/.test(hl.erreur), '  avec sa raison');
  ok(v.marches.some((m) => m.exchange === 'OKX'), 'et OKX a quand meme rendu ses marches');
}

console.log('\n-- 4. l etat de chaque exchange est reel, jamais suppose --');
{
  const hl = M.SOURCES.find((s) => s.nom === 'Hyperliquid');
  ok(hl.wsVerifie === true, 'le WS Hyperliquid est marque VERIFIE (on a vu ses ticks)');
  const okx = M.SOURCES.find((s) => s.nom === 'OKX');
  ok(okx.wsVerifie === false, 'le WS OKX est marque NON verifie (il a expire depuis notre datacenter)');
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
