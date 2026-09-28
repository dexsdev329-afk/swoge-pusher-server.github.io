'use strict';
/* ==================================================================
 * LES ACTIONS TOKENISEES DE ROBINHOOD CHAIN : L'OFFICIELLE, LA COPIE, L'ECART
 * (28 septembre 2026, etape 3 du plan)
 * ==================================================================
 *
 * Le fait qui decide l'outil (deja note au miroir le 8/09, releve le 28/09) :
 * les lancements de cette chaine se cotent CONTRE des actions tokenisees, et
 * trois adresses portent le symbole NVDA — une seule est l'officielle. Le
 * 28/09, la recherche DexScreener « NVDA » sur Robinhood Chain rendait une
 * copie a 0,000000324 $ avec 30 386 $ de liquidite. Robinhood l'ecrit :
 * « a token with a matching name/ticker but a different contract address is
 * not a Robinhood Stock Token » (docs.robinhood.com/chain/contracts).
 *
 * Sources (toutes lues le 28/09, rien de devine) :
 *   - la liste OFFICIELLE : https://api.robinhood.com/rhj/assets, celle que la
 *     page de Robinhood affiche (lu dans son code) — 195 actifs, adresse,
 *     multiplicateur courant et EN ATTENTE (une operation sur titre a venir),
 *     statut, ISIN ;
 *   - le flux Chainlink de chaque action sur la chaine : repertoire
 *     https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
 *     (58 flux ; la source que docs.chain.link cite), lu par latestRoundData()
 *     — valeur par jeton, multiplicateur compris (docs.robinhood.com/chain/
 *     oracles-and-price-feeds) ;
 *   - le prix sur la chaine : la piscine la plus profonde (DexScreener), le jeton
 *     en BASE de la paire.
 * Le 28/09 : NVDA a 230,42 $ sur la piscine USDG (5,2 M$ de liquidite), soit
 * -0,1 % de son flux.
 *
 * Ce qu'on publie de l'oracle : l'ECART (notre mesure), l'adresse du flux et
 * l'heure de sa derniere mise a jour — pas sa valeur brute. Les conditions de
 * Chainlink n'ont pas pu etre lues le 28/09 (page rendue en JavaScript) : on
 * ne republie pas une donnee dont on n'a pas lu la licence ; l'adresse permet
 * a chacun de la relire sur la chaine.
 * Hors seance, le flux ne bouge pas : l'ecart d'un week-end est celui de la
 * piscine contre la cloture. Un ecart est une mesure, jamais un signal.
 * ================================================================== */
const { ethers } = require('ethers');

const REGISTRE = 'https://api.robinhood.com/rhj/assets';
const FLUX = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CHAINE = 4663;
const REGISTRE_TTL = 6 * 3600e3, FLUX_TTL = 24 * 3600e3, ECARTS_TTL = 60e3;
const LIQ_MIN_USD = 10000;
const I_MC = new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const I_AGG = new ethers.utils.Interface(['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)']);
const I_20 = new ethers.utils.Interface(['function symbol() view returns (string)', 'function name() view returns (string)']);
const net = (s, n) => String(s || '').replace(/[^\x20-\x7e•]/g, '').trim().slice(0, n || 60);
const normSym = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');

/**
 * deps : { rpc(methode, params) (Robinhood Chain), fetch, maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const C = { reg: null, regT: 0, flux: null, fluxT: 0, ecarts: null, ecartsT: 0 };
  const MESURE = { verifications: 0, copies: 0, ecarts: 0, erreurs: 0 };
  const json = async (u) => { const r = await deps.fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };

  /** La liste officielle : adresse → fiche, symbole → adresse. */
  async function registre() {
    if (C.reg && maintenant() - C.regT < REGISTRE_TTL) return C.reg;
    const d = await json(REGISTRE);
    const parAdr = new Map(), parSym = new Map();
    for (const a of (d && d.assets) || []) {
      const dep = (a.deployments || []).find((x) => Number(x.chainId) === CHAINE);
      if (!dep || !/^0x[0-9a-fA-F]{40}$/.test(String(dep.contractAddress || ''))) continue;
      const f = { adresse: dep.contractAddress.toLowerCase(), symbole: net(a.tokenSymbol, 16), nom: net(a.tokenName, 80), isin: net(a.isin, 16) || null,
        multiplicateur: net(a.currentMultiplier, 40) || null, multiplicateurAVenir: net(a.pendingMultiplier, 40) || null, statut: net(a.status, 40) || null,
        seances: a.tradingCapabilities ? Object.keys(a.tradingCapabilities).filter((k) => /TRADABLE$/.test(String((a.tradingCapabilities[k] || {}).whole || ''))) : [] };
      parAdr.set(f.adresse, f); parSym.set(normSym(f.symbole), f);
    }
    if (!parAdr.size) throw new Error('empty registry');
    C.reg = { parAdr, parSym, t: maintenant() }; C.regT = maintenant();
    return C.reg;
  }
  /** Les flux Chainlink de la chaine : symbole → { proxy, decimales, heartbeat }. */
  async function flux() {
    if (C.flux && maintenant() - C.fluxT < FLUX_TTL) return C.flux;
    const d = await json(FLUX);
    const m = new Map();
    for (const f of Array.isArray(d) ? d : []) {
      const x = /^Robinhood (\S+) \/ USD$/.exec(String(f.name || ''));
      if (!x || !/^0x[0-9a-fA-F]{40}$/.test(String(f.proxyAddress || ''))) continue;
      m.set(normSym(x[1]), { proxy: f.proxyAddress, decimales: Number(f.decimals) || 8, heartbeat: Number(f.heartbeat) || 86400 });
    }
    C.flux = m; C.fluxT = maintenant();
    return m;
  }
  async function multicall(appels) {
    if (!appels.length) return [];
    const data = I_MC.encodeFunctionData('aggregate3', [appels.map((a) => ({ target: a.cible, allowFailure: true, callData: a.data }))]);
    const r = await deps.rpc('eth_call', [{ to: MULTICALL3, data }, 'latest']);
    return I_MC.decodeFunctionResult('aggregate3', r)[0].map((x, i) => {
      if (!x.success || x.returnData === '0x') return null;
      try { return appels[i].lit(x.returnData); } catch (e) { return null; }
    });
  }
  /** Les oracles de plusieurs symboles, en UN appel. */
  async function oracles(symboles) {
    const F = await flux();
    const l = symboles.map((s) => F.get(s)).map((f) => (f ? { cible: f.proxy, data: I_AGG.encodeFunctionData('latestRoundData'), lit: (d) => I_AGG.decodeFunctionResult('latestRoundData', d) } : null));
    const r = await multicall(l.filter(Boolean));
    const out = new Map();
    let k = 0;
    symboles.forEach((s, i) => {
      if (!l[i]) return;
      const x = r[k++], f = F.get(s);
      if (!x || !(Number(x.answer) > 0)) return;
      const maj = Number(x.updatedAt) * 1000;
      out.set(s, { prix: Number(x.answer) / 10 ** f.decimales, proxy: f.proxy, majA: maj, perime: maintenant() - maj > f.heartbeat * 1000 });
    });
    return out;
  }
  /** La piscine la plus profonde de chaque jeton (en base de la paire), 30 par demande. */
  async function piscines(adresses) {
    const out = new Map();
    for (let i = 0; i < adresses.length; i += 30) {
      let l;
      try { l = await json((process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com').replace(/\/$/, '') + '/tokens/v1/robinhood/' + adresses.slice(i, i + 30).join(',')); } catch (e) { continue; }
      for (const p of Array.isArray(l) ? l : []) {
        const a = String((p.baseToken || {}).address || '').toLowerCase(), liq = Number((p.liquidity || {}).usd) || 0, px = Number(p.priceUsd);
        if (!a || !(px > 0) || (out.get(a) && out.get(a).liquiditeUsd >= liq)) continue;
        out.set(a, { prixUsd: px, liquiditeUsd: liq, piscine: p.pairAddress || null, cotation: net((p.quoteToken || {}).symbol, 16), dex: net(p.dexId, 20) });
      }
    }
    return out;
  }
  const ecartPct = (dex, o) => (dex && o ? Math.round((dex.prixUsd / o.prix - 1) * 10000) / 100 : null);
  const vueOracle = (o) => (o ? { feed: o.proxy, updatedAt: new Date(o.majA).toISOString(), stale: o.perime } : null);
  const vueOfficielle = (f) => ({ address: f.adresse, symbol: f.symbole, name: f.nom, isin: f.isin, status: f.statut, multiplier: f.multiplicateur,
    pendingMultiplier: f.multiplicateurAVenir, corporateActionPending: !!(f.multiplicateurAVenir && f.multiplicateurAVenir !== f.multiplicateur), sessions: f.seances });

  /** Une adresse (ou un symbole) : l'officielle, une copie, ou rien a voir ; l'ecart a l'oracle. */
  async function verifie(a) {
    a = a || {};
    MESURE.verifications++;
    let R;
    try { R = await registre(); } catch (e) { MESURE.erreurs++; return { erreur: 'the official Robinhood stock token list did not answer - try again' }; }
    let officielle = null, lu = null, verdict;
    const adr = String(a.address || '').trim().toLowerCase();
    if (adr) {
      if (!/^0x[0-9a-f]{40}$/.test(adr)) return { erreur: 'address must be 0x followed by 40 hex characters' };
      officielle = R.parAdr.get(adr) || null;
      if (officielle) verdict = 'official';
      else {
        let r = [];
        try { r = await multicall([{ cible: adr, data: I_20.encodeFunctionData('symbol'), lit: (d) => I_20.decodeFunctionResult('symbol', d)[0] },
          { cible: adr, data: I_20.encodeFunctionData('name'), lit: (d) => I_20.decodeFunctionResult('name', d)[0] }]); } catch (e) { r = []; }
        lu = { symbol: net(r[0], 24) || null, name: net(r[1], 80) || null };
        const imite = R.parSym.get(normSym(lu.symbol)) || [...R.parAdr.values()].find((f) => lu.name && f.nom && lu.name.toLowerCase() === f.nom.toLowerCase());
        if (imite) { verdict = 'impostor'; officielle = imite; MESURE.copies++; } else verdict = 'not_a_stock_token';
      }
    } else {
      officielle = R.parSym.get(normSym(a.symbol)) || null;
      if (!officielle) return { erreur: 'no official Robinhood stock token with the symbol "' + net(a.symbol, 16) + '"' };
      verdict = 'official';
    }
    const out = { verdict, checked: adr || null, onchain: lu, official: officielle ? vueOfficielle(officielle) : null };
    if (verdict === 'impostor') out.warning = 'This contract copies the ticker or name of ' + officielle.symbole + ' but is NOT the Robinhood Stock Token. The official contract is ' + officielle.adresse + '.';
    if (officielle) {
      const s = normSym(officielle.symbole);
      const [O, D] = await Promise.all([oracles([s]).catch(() => new Map()), piscines(verdict === 'impostor' ? [officielle.adresse, adr] : [officielle.adresse])]);
      const o = O.get(s), d = D.get(officielle.adresse);
      out.market = { pool: d ? { priceUsd: d.prixUsd, liquidityUsd: Math.round(d.liquiditeUsd), address: d.piscine, quotedIn: d.cotation, dex: d.dex } : null,
        oracle: vueOracle(o), premiumToOraclePct: ecartPct(d, o) };
      if (verdict === 'impostor') { const c = D.get(adr); out.impostorPool = c ? { priceUsd: c.prixUsd, liquidityUsd: Math.round(c.liquiditeUsd), address: c.piscine } : null; }
    }
    out.note = NOTE;
    return out;
  }

  /** Les actions dont la piscine s'ecarte le plus de l'oracle (liquidite minimale), mises en cache 60 s. */
  async function ecarts(a) {
    a = a || {};
    MESURE.ecarts++;
    const n = Math.max(1, Math.min(50, Math.floor(Number(a.limit) || 15)));
    const liqMin = Number(a.min_liquidity_usd) >= 0 ? Number(a.min_liquidity_usd) : LIQ_MIN_USD;
    if (!C.ecarts || maintenant() - C.ecartsT > ECARTS_TTL) {
      let R;
      try { R = await registre(); } catch (e) { MESURE.erreurs++; return { erreur: 'the official Robinhood stock token list did not answer - try again' }; }
      const liste = [...R.parAdr.values()];
      const [O, D] = await Promise.all([oracles(liste.map((f) => normSym(f.symbole))).catch(() => new Map()), piscines(liste.map((f) => f.adresse))]);
      C.ecarts = liste.map((f) => ({ f, o: O.get(normSym(f.symbole)), d: D.get(f.adresse) })).filter((x) => x.o && x.d);
      C.ecartsT = maintenant();
      C.total = liste.length; C.avecOracle = O.size;
    }
    const l = C.ecarts.filter((x) => x.d.liquiditeUsd >= liqMin).map((x) => ({ address: x.f.adresse, symbol: x.f.symbole, name: x.f.nom, premiumToOraclePct: ecartPct(x.d, x.o),
      poolPriceUsd: x.d.prixUsd, liquidityUsd: Math.round(x.d.liquiditeUsd), quotedIn: x.d.cotation, oracle: vueOracle(x.o), corporateActionPending: !!(x.f.multiplicateurAVenir && x.f.multiplicateurAVenir !== x.f.multiplicateur) }))
      .sort((x, y) => Math.abs(y.premiumToOraclePct) - Math.abs(x.premiumToOraclePct));
    return { tokens: l.slice(0, n), compared: l.length, officialTokens: C.total, withOracle: C.avecOracle, minLiquidityUsd: liqMin, measuredAt: new Date(C.ecartsT).toISOString(), note: NOTE };
  }

  /** L'identite d'un jeton deja lu (symbole et nom de DexScreener) : officiel, copie, ou rien —
      sans appel de plus que la liste officielle (en cache 6 h). null si la liste ne repond pas. */
  async function identite(adresse, sym, nom) {
    let R;
    try { R = await registre(); } catch (e) { return null; }
    const a = String(adresse || '').toLowerCase();
    const f = R.parAdr.get(a);
    if (f) return { officielle: true, symbole: f.symbole, adresse: f.adresse };
    const s = normSym(sym), n = String(nom || '').trim().toLowerCase();
    const imite = (s && R.parSym.get(s)) || (n ? [...R.parAdr.values()].find((x) => x.nom && x.nom.toLowerCase() === n) : null);
    return imite ? { imposteur: true, symbole: imite.symbole, adresse: imite.adresse } : null;
  }

  return { verifie, ecarts, registre, identite, MESURE };
}
const NOTE = 'Official list: Robinhood (api.robinhood.com/rhj/assets). Oracle: the Chainlink Robinhood feed on Robinhood Chain (value per token, multiplier included); its value is not republished here, read it at the feed address. '
  + 'Pool: the deepest DexScreener pool with the token as base. Off market hours the oracle does not move. A premium is a measurement, never a trade signal.';

module.exports = { cree, REGISTRE, FLUX, NOTE, normSym };
