'use strict';
/* ==================================================================
 * LES LECTURES ROBINHOOD CHAIN VENDUES AUX AGENTS (27 septembre 2026)
 * ==================================================================
 *
 * Pourquoi : sur x402scan (30 jours, releve du 26/09), le vendeur x402 le plus
 * suivi apres AX1 est OneSource — 2 078 acheteurs, 17 205 paiements — qui
 * vend des lectures RPC, dont Robinhood Chain. Sa fiche /api/networks (lue le
 * 27/09) : robinhood « indexed: false » — des lectures brutes, a 0,001-0,01 $.
 * Notre chaine, notre noeud, et ce qu'ils n'ont pas : des reponses DECODEES
 * (symboles, decimales, prix, pouvoirs du code, swaps) et la colonie.
 *
 * Quatre outils, vendus par l'API seulement (pas offerts a l'agent de la page) :
 *   robinhood_rpc     une lecture JSON-RPC brute, sur liste blanche, bornee ;
 *   robinhood_token   ce qu'est un contrat : ERC-20, offre, proprietaire,
 *                     proxy EIP-1967, pouvoirs visibles dans le code, prix ;
 *   robinhood_wallet  l'ETH et jusqu'a 20 jetons d'une adresse, en UN appel
 *                     Multicall3, avec leur valeur en USD (DexScreener) ;
 *   robinhood_tx      une transaction : etat, frais, transferts ERC-20
 *                     decodes, swaps Uniswap v2/v3/v4 reperes.
 *
 * LE NOEUD EST CELUI DE LA COLONIE : elle passe avant. Un seau d'appels a part
 * (RH_LECTURES_PAR_SECONDE, 4 par seconde, rafale de 8 ; chaque outil reserve
 * d'un coup tout ce qu'il lira) : au-dela, l'outil
 * repond « occupe » sans rien facturer, au lieu de prendre le debit de la
 * colonie. Mesure du 27/09 sur le noeud public : 429 « Too Many Requests » des
 * quelques eth_getLogs rapproches. RH_LECTURES_RPC_URL permet un noeud dedie.
 *
 * Verifie sur la chaine le 27/09 : Multicall3 (0xcA11…CA11) est deploye sur
 * 4663 (eth_getCode non vide) ; un bloc toutes les ~100 ms (/api/networks de
 * OneSource) — 10 000 blocs, environ 17 minutes.
 * ================================================================== */

const { ethers } = require('ethers');
const { SELECTEURS, exposeUn } = require('./ai_colonie');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const SWOGE = '0x8a166fb41cd659a0a43396272ff73973ce29f817';
const JETONS_MAX = 20;
const LOGS_BLOCS_MAX = 10000;
const LOGS_MAX = 500;
const RESULTAT_CAR_MAX = 60000;
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';   /* EIP-1967 : keccak('eip1967.proxy.implementation') - 1 */
const SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';  /* EIP-1967 : keccak('eip1967.proxy.admin') - 1 */

const I_MC = new ethers.utils.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)']);
const I_20 = new ethers.utils.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function owner() view returns (address)']);
/* Un nom en bytes32 (vieux jetons, MKR) : lu aussi. */
const I_20B = new ethers.utils.Interface(['function name() view returns (bytes32)', 'function symbol() view returns (bytes32)']);

const TOPIC = {
  transfer: ethers.utils.id('Transfer(address,address,uint256)'),
  swapV2: ethers.utils.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  swapV3: ethers.utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  swapV4: ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
};

/* ---- LA LISTE BLANCHE DE robinhood_rpc ----
 * Lecture seule : aucune methode qui envoie, signe ou garde un etat cote noeud
 * (filtres, abonnements). Chaque parametre est verifie ici, le noeud ne voit
 * jamais une entree libre. */
const ADR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const QTE = /^0x[0-9a-fA-F]{1,64}$/;
const TAG = (x) => ['latest', 'safe', 'finalized', 'earliest'].includes(x) || (typeof x === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(x));
const appelOk = (o) => o && typeof o === 'object' && ADR.test(String(o.to || '')) && (o.data === undefined || (HEX.test(String(o.data)) && String(o.data).length <= 20002))
  && (o.from === undefined || ADR.test(String(o.from))) && (o.value === undefined || QTE.test(String(o.value)))
  && Object.keys(o).every((k) => ['to', 'data', 'from', 'value', 'input'].includes(k)) && (o.input === undefined || (HEX.test(String(o.input)) && String(o.input).length <= 20002));
const METHODES = {
  eth_blockNumber: (p) => p.length === 0,
  eth_chainId: (p) => p.length === 0,
  eth_gasPrice: (p) => p.length === 0,
  eth_getBalance: (p) => p.length === 2 && ADR.test(p[0]) && TAG(p[1]),
  eth_getCode: (p) => p.length === 2 && ADR.test(p[0]) && TAG(p[1]),
  eth_getTransactionCount: (p) => p.length === 2 && ADR.test(p[0]) && TAG(p[1]),
  eth_getStorageAt: (p) => p.length === 3 && ADR.test(p[0]) && QTE.test(p[1]) && TAG(p[2]),
  eth_call: (p) => p.length === 2 && appelOk(p[0]) && TAG(p[1]),
  eth_estimateGas: (p) => (p.length === 1 || (p.length === 2 && TAG(p[1]))) && appelOk(p[0]),
  eth_getTransactionByHash: (p) => p.length === 1 && HASH.test(p[0]),
  eth_getTransactionReceipt: (p) => p.length === 1 && HASH.test(p[0]),
  /* Les en-tetes seuls : `true` (transactions completes) peut peser des megaoctets. */
  eth_getBlockByNumber: (p) => p.length === 2 && TAG(p[0]) && p[1] === false,
  eth_getBlockByHash: (p) => p.length === 2 && HASH.test(p[0]) && p[1] === false,
  eth_getLogs: (p) => p.length === 1 && filtreOk(p[0]),
};
function filtreOk(f) {
  if (!f || typeof f !== 'object' || f.blockHash !== undefined) return false;
  if (!Object.keys(f).every((k) => ['address', 'topics', 'fromBlock', 'toBlock'].includes(k))) return false;
  const adrs = f.address === undefined ? [] : Array.isArray(f.address) ? f.address : [f.address];
  if (adrs.length > 10 || !adrs.every((a) => ADR.test(String(a)))) return false;
  if (f.topics !== undefined && !(Array.isArray(f.topics) && f.topics.length <= 4
    && f.topics.every((t) => t === null || HASH.test(String(t)) || (Array.isArray(t) && t.length <= 10 && t.every((x) => HASH.test(String(x))))))) return false;
  /* Une plage NUMERIQUE, bornee : « latest » seul ne dit pas d'ou l'on part. */
  return /^0x[0-9a-fA-F]{1,16}$/.test(String(f.fromBlock || '')) && (f.toBlock === 'latest' || /^0x[0-9a-fA-F]{1,16}$/.test(String(f.toBlock || '')));
}

function cree(deps) {
  deps = deps || {};
  const maintenant = deps.maintenant || Date.now;
  const parSeconde = () => { const v = Number(process.env.RH_LECTURES_PAR_SECONDE); return v > 0 ? v : 4; };
  const MESURE = { appels: 0, occupe: 0, erreurs: 0, parOutil: {} };
  let seau = { jetons: 8, t: maintenant() };
  /* Le seau : `n` appels au noeud, ou rien. */
  function prend(n) {
    const t = maintenant(), cap = 2 * parSeconde();
    seau = { jetons: Math.min(cap, seau.jetons + (t - seau.t) / 1000 * parSeconde()), t };
    if (seau.jetons < n) { MESURE.occupe++; return false; }
    seau.jetons -= n;
    MESURE.appels += n;
    return true;
  }
  const OCCUPE = { erreur: 'the Robinhood Chain node is busy serving the SWOGE AI colony - try again in a few seconds (nothing was charged)' };
  async function rpc(m, p) {
    try { return await deps.rpc(m, p); } catch (e) { MESURE.erreurs++; throw e; }
  }
  async function multicall(appels) {
    const data = I_MC.encodeFunctionData('aggregate3', [appels.map((a) => ({ target: a.cible, allowFailure: true, callData: a.data }))]);
    const r = await rpc('eth_call', [{ to: MULTICALL3, data }, 'latest']);
    return I_MC.decodeFunctionResult('aggregate3', r)[0].map((x, i) => {
      if (!x.success || x.returnData === '0x') return null;
      try { return appels[i].lit(x.returnData); } catch (e) { return null; }
    });
  }
  const lecture = (cible, iface, fn, args) => ({ cible, data: iface.encodeFunctionData(fn, args || []), lit: (d) => iface.decodeFunctionResult(fn, d)[0] });
  const texteB32 = (cible, fn) => ({ cible, data: I_20B.encodeFunctionData(fn), lit: (d) => ethers.utils.parseBytes32String(I_20B.decodeFunctionResult(fn, d)[0]) });

  /* Les prix DexScreener (la piscine la plus profonde de chaque jeton), 30 au plus par demande. */
  async function prix(adresses) {
    const out = {};
    if (!adresses.length || !deps.fetch) return out;
    try {
      const r = await deps.fetch((process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com').replace(/\/$/, '') + '/tokens/v1/robinhood/' + adresses.slice(0, 30).join(','),
        { signal: AbortSignal.timeout(8000) });
      const l = await r.json();
      for (const p of Array.isArray(l) ? l : []) {
        const a = String((p.baseToken || {}).address || '').toLowerCase(), liq = Number((p.liquidity || {}).usd) || 0;
        if (!a || (out[a] && out[a].liquidityUsd >= liq)) continue;
        out[a] = { priceUsd: Number(p.priceUsd) || null, liquidityUsd: liq || null, pool: p.pairAddress || null, url: /^https:\/\//.test(p.url || '') ? p.url : null };
      }
    } catch (e) { /* sans prix : les soldes restent vrais */ }
    return out;
  }
  const unites = (v, d) => (v == null || d == null ? null : Number(ethers.utils.formatUnits(v, d)));
  const arrondi = (x, k) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** (k || 2)) / 10 ** (k || 2));

  async function metaJetons(adresses) {
    const l = [];
    for (const a of adresses) l.push(lecture(a, I_20, 'symbol'), texteB32(a, 'symbol'), lecture(a, I_20, 'decimals'));
    const r = await multicall(l);
    const m = {};
    adresses.forEach((a, i) => { m[a.toLowerCase()] = { symbol: r[3 * i] || r[3 * i + 1] || null, decimals: r[3 * i + 2] == null ? null : Number(r[3 * i + 2]) }; });
    return m;
  }

  /* ---- robinhood_rpc ---- */
  async function brut(e) {
    const methode = String((e && e.method) || '');
    const params = e && e.params === undefined ? [] : e && e.params;
    if (!METHODES[methode]) return { erreur: 'method must be one of ' + Object.keys(METHODES).join(', ') + ' (read-only)' };
    if (!Array.isArray(params) || !METHODES[methode](params)) return { erreur: 'invalid params for ' + methode + ' (addresses 0x + 40 hex, hashes 0x + 64 hex, block tags latest/safe/finalized/earliest or hex numbers; eth_getLogs needs a numeric fromBlock)' };
    if (methode === 'eth_getLogs') {
      const f = params[0];
      if (!prend(1)) return OCCUPE;
      const tete = f.toBlock === 'latest' ? parseInt(await rpc('eth_blockNumber', []), 16) : parseInt(f.toBlock, 16);
      if (tete - parseInt(f.fromBlock, 16) > LOGS_BLOCS_MAX) return { erreur: 'eth_getLogs covers ' + LOGS_BLOCS_MAX.toLocaleString('en-US') + ' blocks at most (about 17 minutes of Robinhood Chain)' };
    }
    if (!prend(1)) return OCCUPE;
    let r;
    try { r = await rpc(methode, params); } catch (x) { return { erreur: 'the node refused: ' + String(x && x.message || x).slice(0, 160) + ' (nothing was charged)' }; }
    let tronque = false;
    if (methode === 'eth_getLogs' && Array.isArray(r) && r.length > LOGS_MAX) { r = r.slice(0, LOGS_MAX); tronque = true; }
    const d = { chain: 'robinhood', chainId: 4663, method: methode, result: r === undefined ? null : r, truncated: tronque };
    let t = JSON.stringify(d);
    if (t.length > RESULTAT_CAR_MAX) return { erreur: 'the answer is larger than ' + RESULTAT_CAR_MAX.toLocaleString('en-US') + ' characters - narrow the query (nothing was charged)' };
    return { donnees: d, texte: t };
  }

  /* ---- robinhood_token ---- */
  async function jeton(e) {
    const a = String((e && e.address) || '');
    if (!ADR.test(a)) return { erreur: 'address must be 0x followed by 40 hex characters' };
    /* Tout le budget d'un coup (code, 2 emplacements, Multicall3, code de l'implementation) :
       a court en chemin, les pouvoirs se seraient lus en silence dans le code du proxy. */
    if (!prend(5)) return OCCUPE;
    const [code, impl, admin] = await Promise.all([rpc('eth_getCode', [a, 'latest']), rpc('eth_getStorageAt', [a, SLOT_IMPL, 'latest']), rpc('eth_getStorageAt', [a, SLOT_ADMIN, 'latest'])]);
    const hex = String(code || '0x').slice(2).toLowerCase();
    if (!hex) return { donnees: { chain: 'robinhood', address: a.toLowerCase(), isContract: false, note: 'no code at this address: a wallet (or a contract not deployed yet)' },
      texte: a + ' on Robinhood Chain has no code: it is a wallet, not a contract.' };
    const [nom, sym, dec, offre, proprio, nomB, symB] = await multicall([lecture(a, I_20, 'name'), lecture(a, I_20, 'symbol'), lecture(a, I_20, 'decimals'),
      lecture(a, I_20, 'totalSupply'), lecture(a, I_20, 'owner'), texteB32(a, 'name'), texteB32(a, 'symbol')]);
    const adrSlot = (s) => { const x = '0x' + String(s || '').slice(-40); return /^0x0{40}$/.test(x) || !ADR.test(x) ? null : ethers.utils.getAddress(x); };
    const implementation = adrSlot(impl);
    /* Le code d'un proxy est celui du proxy : les pouvoirs se lisent chez l'implementation. */
    let hexPouvoirs = hex, pouvoirsDe = 'contract';
    if (implementation) {
      const ci = await rpc('eth_getCode', [implementation, 'latest']).catch(() => null);
      if (typeof ci === 'string' && ci.length > 2) { hexPouvoirs = ci.slice(2).toLowerCase(); pouvoirsDe = 'implementation'; }
    }
    const decimales = dec == null ? null : Number(dec);
    const px = (await prix([a.toLowerCase()]))[a.toLowerCase()] || null;
    const offreN = unites(offre, decimales);
    const d = {
      chain: 'robinhood', address: a.toLowerCase(), isContract: true, codeBytes: hex.length / 2,
      erc20: sym != null || symB != null ? { name: nom || nomB || null, symbol: sym || symB || null, decimals: decimales, totalSupply: offre == null ? null : offre.toString(), totalSupplyUnits: offreN } : null,
      owner: proprio ? (/^0x0{40}$/.test(proprio.slice(2)) || proprio === ethers.constants.AddressZero ? 'renounced (zero address)' : proprio) : null,
      proxy: implementation ? { standard: 'EIP-1967', implementation, admin: adrSlot(admin) } : null,
      /* Un selecteur present dans le code, pas une preuve d'usage : un contrat sans `mint` ne peut pas emettre, c'est ce qui est sur. */
      powers: { readFrom: pouvoirsDe, mint: exposeUn(hexPouvoirs, SELECTEURS.mint), blacklist: exposeUn(hexPouvoirs, SELECTEURS.liste),
        pause: exposeUn(hexPouvoirs, SELECTEURS.pause), feeSetter: exposeUn(hexPouvoirs, SELECTEURS.frais),
        note: 'function selectors exposed by the dispatcher: a power the code has, not proof it is used' },
      market: px ? Object.assign({}, px, { marketCapUsd: px.priceUsd && offreN ? arrondi(px.priceUsd * offreN, 0) : null }) : null,
    };
    const P = d.powers, pv = ['mint', 'blacklist', 'pause', 'feeSetter'].filter((k) => P[k]);
    const t = 'Robinhood Chain contract ' + d.address + (d.erc20 ? ': $' + d.erc20.symbol + ' "' + d.erc20.name + '", ' + (d.erc20.totalSupplyUnits == null ? '?' : d.erc20.totalSupplyUnits.toLocaleString('en-US')) + ' supply, ' + d.erc20.decimals + ' decimals' : ' (not an ERC-20)')
      + '. Owner: ' + (d.owner || 'no owner() function') + '. ' + (d.proxy ? 'Upgradeable proxy (EIP-1967), implementation ' + d.proxy.implementation + '. ' : 'Not an EIP-1967 proxy. ')
      + 'Powers in the ' + P.readFrom + ' code: ' + (pv.length ? pv.join(', ') : 'no mint, blacklist, pause or fee setter') + '.'
      + (d.market ? ' Price $' + d.market.priceUsd + ', liquidity $' + Math.round(d.market.liquidityUsd || 0).toLocaleString('en-US') + ' (DexScreener).' : ' No DexScreener pool.');
    return { donnees: d, texte: t };
  }

  /* ---- robinhood_wallet ---- */
  async function portefeuille(e) {
    const a = String((e && e.address) || '');
    if (!ADR.test(a)) return { erreur: 'address must be 0x followed by 40 hex characters' };
    const demandes = e.tokens === undefined ? [SWOGE, USDG] : e.tokens;
    if (!Array.isArray(demandes) || demandes.length > JETONS_MAX || !demandes.every((x) => ADR.test(String(x)))) return { erreur: 'tokens must be a list of at most ' + JETONS_MAX + ' token addresses' };
    const jetons = [...new Set(demandes.map((x) => String(x).toLowerCase()))];
    if (!prend(1)) return OCCUPE;
    const l = [{ cible: MULTICALL3, data: I_MC.encodeFunctionData('getEthBalance', [a]), lit: (d) => I_MC.decodeFunctionResult('getEthBalance', d)[0] }];
    for (const j of jetons) l.push(lecture(j, I_20, 'balanceOf', [a]), lecture(j, I_20, 'symbol'), texteB32(j, 'symbol'), lecture(j, I_20, 'decimals'));
    const r = await multicall(l);
    const px = await prix(jetons.concat(deps.weth ? [deps.weth.toLowerCase()] : []));
    const ethUsd = deps.ethUsd ? await Promise.resolve().then(() => deps.ethUsd()).catch(() => null) : null;
    const eth = r[0] == null ? null : Number(ethers.utils.formatEther(r[0]));
    const lignes = jetons.map((j, i) => {
      const bal = r[1 + 4 * i], dec = r[4 + 4 * i] == null ? null : Number(r[4 + 4 * i]);
      const u = unites(bal, dec), p = px[j] && px[j].priceUsd;
      return { token: j, symbol: r[2 + 4 * i] || r[3 + 4 * i] || null, decimals: dec, balance: bal == null ? null : bal.toString(), balanceUnits: u,
        priceUsd: p || null, valueUsd: u != null && p ? arrondi(u * p) : null, readable: bal != null };
    });
    const total = (eth != null && ethUsd ? eth * ethUsd : 0) + lignes.reduce((s, x) => s + (x.valueUsd || 0), 0);
    const d = { chain: 'robinhood', address: a.toLowerCase(), eth: { balance: eth, priceUsd: ethUsd || null, valueUsd: eth != null && ethUsd ? arrondi(eth * ethUsd) : null },
      tokens: lignes, totalValueUsd: arrondi(total), note: 'balances read on-chain in one Multicall3 call; prices from DexScreener (deepest pool), null when unknown - an unknown price is not zero' };
    const t = 'Wallet ' + d.address + ' on Robinhood Chain: ' + (eth == null ? '? ETH' : eth + ' ETH') + (d.eth.valueUsd != null ? ' ($' + d.eth.valueUsd + ')' : '') + '; '
      + lignes.map((x) => (x.readable ? x.balanceUnits : '?') + ' ' + (x.symbol || x.token) + (x.valueUsd != null ? ' ($' + x.valueUsd + ')' : '')).join('; ')
      + '. Total with known prices: $' + d.totalValueUsd + '.';
    return { donnees: d, texte: t };
  }

  /* ---- robinhood_tx ---- */
  async function transaction(e) {
    const h = String((e && e.hash) || '');
    if (!HASH.test(h)) return { erreur: 'hash must be 0x followed by 64 hex characters' };
    if (!prend(3)) return OCCUPE;          /* la transaction, son recu, les symboles */
    const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [h]), rpc('eth_getTransactionReceipt', [h])]);
    if (!tx) return { erreur: 'no such transaction on Robinhood Chain (nothing was charged)' };
    const logs = (rc && rc.logs) || [];
    const transferts = logs.filter((l) => (l.topics || [])[0] === TOPIC.transfer && l.topics.length === 3).slice(0, 50);
    const jetonsVus = [...new Set(transferts.map((l) => l.address.toLowerCase()))].slice(0, 10);
    const meta = jetonsVus.length ? await metaJetons(jetonsVus).catch(() => ({})) : {};
    const px = await prix(jetonsVus);
    const adrTopic = (t) => ethers.utils.getAddress('0x' + String(t).slice(-40));
    const transfers = transferts.map((l) => {
      const m = meta[l.address.toLowerCase()] || {}, v = ethers.BigNumber.from(l.data === '0x' ? 0 : l.data);
      const u = unites(v, m.decimals), p = (px[l.address.toLowerCase()] || {}).priceUsd;
      return { token: l.address.toLowerCase(), symbol: m.symbol || null, from: adrTopic(l.topics[1]), to: adrTopic(l.topics[2]), amount: v.toString(), amountUnits: u,
        valueUsdNow: u != null && p ? arrondi(u * p) : null };
    });
    const swaps = logs.map((l) => { const t0 = (l.topics || [])[0];
      const v = t0 === TOPIC.swapV2 ? 'v2' : t0 === TOPIC.swapV3 ? 'v3' : t0 === TOPIC.swapV4 ? 'v4' : null;
      return v ? { uniswap: v, pool: v === 'v4' ? l.topics[1] : l.address.toLowerCase() } : null; }).filter(Boolean);
    const gazPrix = rc && (rc.effectiveGasPrice || tx.gasPrice);
    const fraisEth = rc && gazPrix ? Number(ethers.utils.formatEther(ethers.BigNumber.from(rc.gasUsed).mul(ethers.BigNumber.from(gazPrix)))) : null;
    const ethUsd = deps.ethUsd ? await Promise.resolve().then(() => deps.ethUsd()).catch(() => null) : null;
    const d = { chain: 'robinhood', hash: h.toLowerCase(), status: !rc ? 'pending' : rc.status === '0x1' ? 'success' : 'reverted',
      block: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null, from: tx.from, to: tx.to || null, contractCreated: rc && rc.contractAddress ? rc.contractAddress : null,
      valueEth: Number(ethers.utils.formatEther(tx.value || '0x0')), method: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null,
      gasUsed: rc ? parseInt(rc.gasUsed, 16) : null, feeEth: fraisEth, feeUsd: fraisEth != null && ethUsd ? arrondi(fraisEth * ethUsd, 4) : null,
      transfers, transfersTruncated: logs.filter((l) => (l.topics || [])[0] === TOPIC.transfer && l.topics.length === 3).length > 50, swaps, logCount: logs.length,
      note: 'valueUsdNow uses today\'s DexScreener price, not the price at the time of the transaction' };
    const t = 'Robinhood Chain transaction ' + d.hash + ': ' + d.status.toUpperCase() + ', from ' + d.from + ' to ' + (d.to || 'contract creation')
      + (d.valueEth ? ', ' + d.valueEth + ' ETH' : '') + (d.feeEth != null ? ', fee ' + d.feeEth + ' ETH' + (d.feeUsd != null ? ' ($' + d.feeUsd + ')' : '') : '') + '. '
      + (transfers.length ? transfers.length + ' token transfer' + (transfers.length > 1 ? 's' : '') + ': ' + transfers.slice(0, 5).map((x) => (x.amountUnits ?? x.amount) + ' ' + (x.symbol || x.token) + ' ' + x.from.slice(0, 8) + '→' + x.to.slice(0, 8)).join('; ') + '. ' : 'No token transfer. ')
      + (swaps.length ? swaps.length + ' Uniswap swap' + (swaps.length > 1 ? 's' : '') + ' (' + [...new Set(swaps.map((s) => s.uniswap))].join(', ') + ').' : '');
    return { donnees: d, texte: t };
  }

  const envelope = (nom, f) => async (e) => {
    MESURE.parOutil[nom] = (MESURE.parOutil[nom] || 0) + 1;
    try { return await f(e || {}); } catch (x) { MESURE.erreurs++; return { erreur: 'the Robinhood Chain read failed (' + String(x && x.message || x).slice(0, 120) + ') - nothing was charged' }; }
  };
  return { robinhood_rpc: envelope('robinhood_rpc', brut), robinhood_token: envelope('robinhood_token', jeton),
    robinhood_wallet: envelope('robinhood_wallet', portefeuille), robinhood_tx: envelope('robinhood_tx', transaction), MESURE };
}

module.exports = { cree, METHODES, TOPIC, MULTICALL3, JETONS_MAX, LOGS_BLOCS_MAX, LOGS_MAX, SLOT_IMPL };
