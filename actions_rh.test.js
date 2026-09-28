'use strict';
/* actions_rh.js : l'action officielle, la copie, l'ecart a l'oracle (sans republier sa valeur). */
const { ethers } = require('ethers');
const A = require('./actions_rh');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d', AAPL = '0x' + 'aa'.repeat(20);
const COPIE = '0xdecf74e4aa6ff30b1612e65665aaf650bedecba3', AUTRE = '0x' + '77'.repeat(20);
const FEED_NVDA = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', FEED_TSLA = '0x4A1166a659A55625345e9515b32adECea5547C38';
let horloge = Date.UTC(2026, 8, 28, 18, 0);
const REG = { assets: [
  { tokenSymbol: 'NVDA', tokenName: 'NVIDIA • Robinhood Token', isin: 'US67066G1040', deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 }],
    currentMultiplier: '1.000775159164630595', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE', tradingCapabilities: { market: { whole: 'TRADING_STATUS_TRADABLE' }, overnight: { whole: 'TRADING_STATUS_HALTED' } } },
  { tokenSymbol: 'TSLA', tokenName: 'Tesla • Robinhood Token', deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', chainId: 4663 }],
    currentMultiplier: '1.0', pendingMultiplier: '1.02', status: 'ASSET_STATUS_ACTIVE' },
  { tokenSymbol: 'AAPL', tokenName: 'Apple • Robinhood Token', deployments: [{ contractAddress: AAPL, chainId: 4663 }], currentMultiplier: '1.0' },
  { tokenSymbol: 'XYZ', tokenName: 'Other chain only', deployments: [{ contractAddress: '0x' + '11'.repeat(20), chainId: 1 }] }] };
const FLUX = [{ name: 'Robinhood NVDA / USD', proxyAddress: FEED_NVDA, decimals: 8, heartbeat: 86400 }, { name: 'Robinhood TSLA / USD', proxyAddress: FEED_TSLA, decimals: 8, heartbeat: 86400 },
  { name: 'ETH / USD', proxyAddress: '0x' + '22'.repeat(20), decimals: 8 }];
const ORACLE = { [FEED_NVDA.toLowerCase()]: { px: 230.67, maj: horloge - 3600e3 }, [FEED_TSLA.toLowerCase()]: { px: 360, maj: horloge - 3 * 86400e3 } };
const PISCINES = [
  { baseToken: { address: NVDA }, quoteToken: { symbol: 'USDG' }, priceUsd: '230.42', liquidity: { usd: 5169580 }, pairAddress: '0xp1', dexId: 'uniswap' },
  { baseToken: { address: NVDA }, quoteToken: { symbol: 'WETH' }, priceUsd: '229', liquidity: { usd: 1000 }, pairAddress: '0xp2', dexId: 'uniswap' },
  { baseToken: { address: '0x' + '99'.repeat(20) }, quoteToken: { symbol: 'NVDA', address: NVDA }, priceUsd: '0.001', liquidity: { usd: 9e6 }, pairAddress: '0xmeme' },
  { baseToken: { address: TSLA }, quoteToken: { symbol: 'WETH' }, priceUsd: '363.6', liquidity: { usd: 363840 }, pairAddress: '0xp3', dexId: 'uniswap' },
  { baseToken: { address: COPIE }, quoteToken: { symbol: 'WETH' }, priceUsd: '0.000000324', liquidity: { usd: 30386 }, pairAddress: '0xcopie' }];
const I_MC = new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const I_AGG = new ethers.utils.Interface(['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)']);
const I_20 = new ethers.utils.Interface(['function symbol() view returns (string)', 'function name() view returns (string)']);
const JETONS = { [COPIE]: { symbol: 'NVDA', name: 'NVDA' }, [AUTRE]: { symbol: 'DOGE2', name: 'Doge Two' } };
const vus = { reg: 0, flux: 0, dex: 0, rpc: 0 };
async function rpc(m, p) {
  vus.rpc++;
  if (m !== 'eth_call') throw new Error(m);
  const appels = I_MC.decodeFunctionData('aggregate3', p[0].data)[0];
  return I_MC.encodeFunctionResult('aggregate3', [appels.map((c) => {
    const cible = c.target.toLowerCase(), sel = c.callData.slice(0, 10);
    if (ORACLE[cible] && sel === I_AGG.getSighash('latestRoundData')) {
      const o = ORACLE[cible];
      return [true, I_AGG.encodeFunctionResult('latestRoundData', [1, Math.round(o.px * 1e8), 0, Math.floor(o.maj / 1000), 1])];
    }
    const j = JETONS[cible];
    if (j && sel === I_20.getSighash('symbol')) return [true, I_20.encodeFunctionResult('symbol', [j.symbol])];
    if (j && sel === I_20.getSighash('name')) return [true, I_20.encodeFunctionResult('name', [j.name])];
    return [false, '0x'];
  })]);
}
let registreEnPanne = false;
async function fetch(u) {
  const rep = (x) => ({ ok: true, json: async () => x });
  if (u === A.REGISTRE) { vus.reg++; if (registreEnPanne) return { ok: false, status: 503, json: async () => ({}) }; return rep(REG); }
  if (u === A.FLUX) { vus.flux++; return rep(FLUX); }
  if (/\/tokens\/v1\/robinhood\//.test(u)) { vus.dex++; const adrs = u.split('/').pop().split(','); return rep(PISCINES.filter((p) => adrs.includes(p.baseToken.address) || adrs.includes((p.quoteToken || {}).address))); }
  throw new Error('url ' + u);
}

(async () => {
  const X = A.cree({ rpc, fetch, maintenant: () => horloge });

  console.log('\n-- l officielle --');
  const v = await X.verifie({ symbol: 'nvda' });
  ok(v.verdict === 'official' && v.official.address === NVDA && v.official.isin === 'US67066G1040' && v.official.sessions.join() === 'market', 'par symbole : l adresse officielle, l ISIN, les seances ouvertes');
  ok(v.market.pool.priceUsd === 230.42 && v.market.pool.liquidityUsd === 5169580 && v.market.pool.quotedIn === 'USDG', 'la piscine la plus profonde, le jeton en BASE (pas le memecoin cote en NVDA)');
  ok(v.market.premiumToOraclePct === -0.11 && v.market.oracle.feed === FEED_NVDA && !v.market.oracle.stale, 'l ecart a l oracle : -0,11 % ; l adresse du flux, frais');
  ok(!JSON.stringify(v).includes('230.67') && !('price' in v.market.oracle) && !('priceUsd' in v.market.oracle), 'la valeur brute de l oracle n est PAS republiee (licence non lue) : seulement l ecart et l adresse');
  ok((await X.verifie({ address: NVDA.toUpperCase().replace('0X', '0x') })).verdict === 'official', 'par adresse, casse indifferente');

  console.log('\n-- la copie --');
  const c = await X.verifie({ address: COPIE });
  ok(c.verdict === 'impostor' && c.official.address === NVDA && /NOT the Robinhood Stock Token/.test(c.warning) && c.onchain.symbol === 'NVDA', 'meme symbole, autre adresse : imposteur, et l officielle donnee');
  ok(c.impostorPool && c.impostorPool.priceUsd === 0.000000324 && c.market.pool.priceUsd === 230.42, 'la piscine de la copie a cote de celle de l officielle');
  const r = await X.verifie({ address: AUTRE });
  ok(r.verdict === 'not_a_stock_token' && r.official === null && !r.market, 'un jeton sans rapport : pas une action, rien d invente');
  ok(/no official/.test((await X.verifie({ symbol: 'XYZ' })).erreur), 'un symbole deploye sur une autre chaine seulement : inconnu ici');

  console.log('\n-- les operations sur titre, la fraicheur --');
  const t = await X.verifie({ symbol: 'TSLA' });
  ok(t.official.corporateActionPending && t.official.pendingMultiplier === '1.02', 'un multiplicateur en attente : une operation sur titre a venir, dite');
  ok(t.market.oracle.stale === true && t.market.premiumToOraclePct === 1, 'un flux plus vieux que son heartbeat : dit perime (+1 % contre une valeur ancienne)');
  const sans = await X.verifie({ symbol: 'AAPL' });
  ok(sans.market.oracle === null && sans.market.pool === null && sans.market.premiumToOraclePct === null, 'sans flux ni piscine : null, jamais zero');

  console.log('\n-- les ecarts de toutes les actions --');
  const e = await X.ecarts({ limit: 10 });
  ok(e.tokens.map((x) => x.symbol).join() === 'TSLA,NVDA' && e.officialTokens === 3 && e.withOracle === 2 && e.compared === 2, 'triees par ecart absolu ; combien d officielles, combien avec oracle');
  ok((await X.ecarts({ min_liquidity_usd: 1e6 })).tokens.map((x) => x.symbol).join() === 'NVDA', 'la liquidite minimale filtre');
  const n0 = vus.dex; await X.ecarts({}); ok(vus.dex === n0, 'une seconde demande dans la minute : le cache, aucun appel');
  ok(vus.reg === 1 && vus.flux === 1, 'la liste officielle et les flux lus une fois (6 h et 24 h de cache)');

  console.log('\n-- l identite d un jeton deja lu (pour scan_token et token_verdict) --');
  ok((await X.identite(NVDA, 'NVDA', 'NVIDIA')).officielle === true, 'l adresse officielle : officielle');
  const id = await X.identite(COPIE, 'NVDA', 'NVDA');
  ok(id && id.imposteur && id.adresse === NVDA && id.symbole === 'NVDA', 'meme symbole, autre adresse : imposteur, l officielle donnee');
  ok((await X.identite(AUTRE, 'X', 'Tesla \u2022 Robinhood Token')).adresse === TSLA, 'le NOM officiel copie : imposteur aussi');
  ok((await X.identite(AUTRE, 'DOGE2', 'Doge Two')) === null, 'un jeton sans rapport : rien');

  console.log('\n-- les pannes --');
  horloge += 7 * 3600e3; registreEnPanne = true;
  ok(/did not answer/.test((await X.verifie({ symbol: 'NVDA' })).erreur), 'la liste officielle en panne (cache expire) : dit, rien d invente');
  registreEnPanne = false;
  ok(/address must be/.test((await X.verifie({ address: '0x12' })).erreur), 'une adresse mal formee : refusee');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
