'use strict';
/*
 * LE COURS DU $SWOGE SUR LA CHAÎNE (cours_chaine.js), quand DexScreener rend
 * `pairs: null` — relevé du 26 septembre 2026, qui fermait SwoleMind :
 *   1. la piscine V2 connue donne le prix en WETH, l'ETH vient des piscines
 *      WETH de Robinhood Chain ;
 *   2. une piscine qui n'est pas WETH/$SWOGE, une piscine vidée, un ETH
 *      absurde : pas de cours plutôt qu'un faux ;
 *   3. dans coursSwoge : DexScreener muet → la chaîne ; et un cours pompé ne
 *      fait pas payer moins (le plus bas du moment et de la médiane).
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const CC = require('./cours_chaine');
const SWOGE = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817';
const e18 = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

/* Les réserves relevées le 26 septembre 2026 : 2,469 WETH contre 266 258 666 $SWOGE. */
const lit = (o) => async (adresse, fn) => {
  const c = Object.assign({ token0: CC.WETH, token1: SWOGE, r0: e18(2.469266), r1: e18(266258666.17) }, o || {});
  if (fn === 'token0') return c.token0; if (fn === 'token1') return c.token1;
  return [c.r0.toString(), c.r1.toString()];
};
const dex = (prix, extra) => async (url) => ({ json: async () => (/0x0Bd7/i.test(url)
  ? { pairs: [{ chainId: 'robinhood', baseToken: { address: CC.WETH }, priceUsd: String(prix), liquidity: { usd: 19067699 } }].concat(extra || []) }
  : { schemaVersion: '1.0.0', pairs: null }) });

(async () => {
  console.log('-- 1. la piscine et l ETH --');
  const w = await CC.prixEnWeth({ lit: lit(), pool: CC.POOL, swoge: SWOGE, weth: CC.WETH });
  ok(Math.abs(w - 2.469266 / 266258666.17) < 1e-15, 'le prix en WETH est le rapport des reserves [' + w + ']');
  const v = await CC.cours({ lit: lit(), prendre: dex(2688.57), swoge: SWOGE });
  ok(Math.abs(v - 0.00002493) < 2e-8, 'le cours en $ : ' + v.toExponential(4) + ' (releve : 0,0000249)');
  const inverse = await CC.prixEnWeth({ lit: lit({ token0: SWOGE, token1: CC.WETH, r0: e18(266258666.17), r1: e18(2.469266) }), pool: CC.POOL, swoge: SWOGE, weth: CC.WETH });
  ok(Math.abs(inverse - w) < 1e-18, 'que WETH soit token0 ou token1');
  const eth = await CC.ethUsd(dex(2688.57, [{ chainId: 'base', baseToken: { address: CC.WETH }, priceUsd: '1', liquidity: { usd: 9e9 } }]));
  ok(eth === 2688.57, 'l ETH vient de la piscine la plus profonde de ROBINHOOD CHAIN, pas d une autre chaine');

  console.log('\n-- 2. pas de cours plutot qu un faux --');
  const CLONE = '0xDB87393727b666c43f5aecB03d8B419bA54D9b03';
  ok(await CC.prixEnWeth({ lit: lit({ token1: CLONE }), pool: CC.POOL, swoge: SWOGE, weth: CC.WETH }) === null, 'une piscine d un AUTRE jeton (le clone 0xDB87…, memes nom et symbole) : null');
  ok(await CC.prixEnWeth({ lit: lit({ r0: e18(0.2) }), pool: CC.POOL, swoge: SWOGE, weth: CC.WETH }) === null, 'une piscine sous ' + CC.MIN_WETH + ' WETH : null (elle se manipule pour rien)');
  ok(await CC.ethUsd(dex(5)) === null && await CC.ethUsd(dex(9e6)) === null, 'un ETH hors de [100 ; 100 000] $ : null');
  ok(await CC.cours({ lit: lit(), prendre: dex(5), swoge: SWOGE }) === null, 'et sans ETH, pas de cours');

  console.log('\n-- 3. dans coursSwoge --');
  delete process.env.STUDIO_DEX; delete process.env.SWOGE_PRIX_USD;
  const C = require('./studio_chat');
  C.COURS.v = null; C.COURS.t = 0; C.COURS.hist.length = 0;
  let t = 1e12;
  const c1 = await C.coursSwoge(dex(2688.57), t, lit());
  ok(Math.abs(c1 - 0.00002493) < 2e-8 && C.COURS.source === 'chaine', 'DexScreener muet sur le $SWOGE : le cours vient de la chaine, le chat reste ouvert');
  for (let i = 0; i < 5; i++) { t += 61000; await C.coursSwoge(dex(2688.57), t, lit()); }
  t += 61000;
  const pompe = await C.coursSwoge(dex(2688.57), t, lit({ r0: e18(24.69) }));
  ok(Math.abs(pompe - c1) < 2e-8, 'une piscine pompee x10 le temps d une lecture ne fait pas payer moins : ' + pompe.toExponential(4));
  C.COURS.v = null; C.COURS.t = 0; C.COURS.hist.length = 0;
  process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801';
  ok(await C.coursSwoge(dex(2688.57), t + 1e6, async () => { throw new Error('ne doit pas lire'); }) === 0.00002801, 'STUDIO_DEX=0 (essais) : aucune lecture reseau, le reglage');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
