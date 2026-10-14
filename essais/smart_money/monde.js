'use strict';
/* Un MONDE FIGE pour l'essai de bout en bout du detecteur smart money : trois
 * jetons de plus de 1 M$ (un deploye, un lance par une fabrique, une
 * migration), leurs 1res heures, des wallets aux roles connus d'avance, et
 * les reponses de GeckoTerminal / DexScreener / registre des actions.
 * 0,1 s par bloc (1 h = 36 000 blocs) ; l'heure d'un bloc est T0 + bloc/10.
 *
 * Les roles (ce que l'essai doit retrouver) :
 *   S1, S2      tot et gagnants sur J1, J2, J3, aucune marque  -> smart
 *   S3          gagnant sur J1 et J2, perdant sur J3           -> pas smart
 *   G1..G3      achat groupe sur J1 (meme bloc, meme mise), gagnants partout -> initie
 *   R1          relais sur J2 (100 % renvoye en 100 blocs), gagnant ailleurs -> initie
 *   F1          finance en WETH par C1 avant son achat de J1    -> initie
 *   L1..L4      perdants qui tiennent
 *   TARD        achete J1 apres la 1re heure                    -> pas « tot »
 *   C1          deploie J1 (puis l'achete et brule), lance J2 par la fabrique FAB
 *   OP          envoie la migration de J3 (ancien jeton J3V cree par C3 via LP0)
 */
const K = require('../../smart_calcul');
const { journal, pad } = require('./faux_noeud');

const T0 = 1780000000;
const horodatage = (b) => T0 + Math.floor(b / 10);
const A = (s) => '0x' + s.repeat(40 / s.length).slice(0, 40);
const P = (s) => '0x' + s.repeat(64 / s.length).slice(0, 64);
const E = 10n ** 18n;
const ADR = {
  J1: A('a1'), J2: A('a2'), J3: A('a3'), J3V: A('a9'), J4: A('a4'), J6: A('a6'),
  POOL1: P('b1'), POOL2: P('b2'), POOL3: P('b3'), POOL4: P('b4'), POOL6: P('b6'),
  C1: A('c1'), C3: A('c3'), OP: A('0e'), U: A('0f'), FAB: A('fa'), LP0: A('fb'), MIG: A('fc'), HOOK: A('44'), ROUTEUR: A('77'),
  S1: A('51'), S2: A('52'), S3: A('53'), G1: A('61'), G2: A('62'), G3: A('63'), R1: A('71'), R1B: A('72'), F1: A('81'),
  L1: A('91'), L2: A('92'), L3: A('93'), L4: A('94'), TARD: A('99'), LOIN: A('98'),
  STOCK: A('5c'), COPIE: '0xa1a' + 'b'.repeat(33) + 'a1a1', EXT: A('ee'),
};
const PM = K.ADR.POOL_MANAGER_V4;
const LANCE = { J1: 10000000, J2: 10500000, J3: 11000000 };
const POOL = { J1: ADR.POOL1, J2: ADR.POOL2, J3: ADR.POOL3, J4: ADR.POOL4, J6: ADR.POOL6 };
const POINTE = 12000000;

function cree() {
  const logs = [], recus = {}, txs = {};
  let k = 0;
  const nouvelleTx = (bloc, from, to, extra) => {
    const h = '0x' + (++k).toString(16).padStart(64, '0');
    const t = { hash: h, from, to, input: '0x', blockNumber: '0x' + bloc.toString(16) };
    txs[h] = t;
    recus[h] = Object.assign({ transactionHash: h, blockNumber: '0x' + bloc.toString(16), from, to, contractAddress: null, status: '0x1', logs: [] }, extra || {});
    return h;
  };
  const ajoute = (h, l) => { logs.push(l); recus[h].logs.push(l); };
  let idx = 0;
  const transfer = (h, bloc, jeton, de, vers, v) => ajoute(h, journal(jeton, [K.TOPIC.TRANSFER, pad(de), pad(vers)], [v], bloc, h, idx++));
  const swap = (h, bloc, pool, u0, u1, sqrtP) => ajoute(h, journal(PM, [K.TOPIC.SWAP_V4, pool, pad(ADR.ROUTEUR)], [u0, u1, sqrtP, 10n ** 20n, 0n, 10000n], bloc, h, idx++));
  const init = (h, bloc, pool, jeton) => ajoute(h, journal(PM, [K.TOPIC.INIT_V4, pool, pad(K.ADR.ETH_NATIF), pad(jeton)], [10000n, 200n, BigInt(ADR.HOOK), 1n << 96n, 0n], bloc, h, idx++));
  const modif = (h, bloc, pool, delta) => ajoute(h, journal(PM, ['0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec', pool, pad(ADR.ROUTEUR)], [0n, 0n, delta, 0n], bloc, h, idx++));
  const SQ = (k2) => (1n << 96n) * k2;           // jetons par ETH = k2^2
  /** un achat : `eth` paye, jetons = eth x 1e6 (99 % a l'acheteur, 1 % au crochet) */
  const achat = (jeton, qui, bloc, eth, sq) => {
    const h = nouvelleTx(bloc, qui, ADR.ROUTEUR);
    const jet = eth * 1000000n;
    swap(h, bloc, POOL[jeton], -eth, jet, sq || SQ(1000n));
    transfer(h, bloc, ADR[jeton], PM, ADR.HOOK, jet / 100n);
    transfer(h, bloc, ADR[jeton], PM, ADR.ROUTEUR, jet - jet / 100n);
    transfer(h, bloc, ADR[jeton], ADR.ROUTEUR, qui, jet - jet / 100n);
    return { h, jet: jet - jet / 100n };
  };
  /* une vente : le Swap rend `eth`, le crochet en RETIENT 1 % en ETH (evenement
     0xc532c43b hors du Swap, comme 0x332f… sur NILF : revue C1) ; le wallet
     recoit donc 99 % */
  const fraisCrochet = (h, bloc, pool, montant) => ajoute(h, journal(ADR.HOOK, [K.TOPIC.FRAIS_CROCHET, pool], [0n, montant, 0n], bloc, h, idx++));
  const vente = (jeton, qui, bloc, jet, eth, sq) => {
    const h = nouvelleTx(bloc, qui, ADR.ROUTEUR);
    swap(h, bloc, POOL[jeton], eth, -jet, sq || SQ(1000n));
    fraisCrochet(h, bloc, POOL[jeton], eth / 100n);
    transfer(h, bloc, ADR[jeton], qui, PM, jet);
    return h;
  };
  const OFFRE = 10n ** 27n;
  /* ---- J1 : deploye par C1 (contractAddress), piscine initialisee plus tard ---- */
  {
    const h = nouvelleTx(9990000, ADR.C1, null, { contractAddress: ADR.J1 });
    transfer(h, 9990000, ADR.J1, K.ADR.ETH_NATIF, ADR.C1, OFFRE);
    const hp = nouvelleTx(LANCE.J1, ADR.C1, PM);
    init(hp, LANCE.J1, POOL.J1, ADR.J1); modif(hp, LANCE.J1, POOL.J1, 10n ** 24n);
    transfer(hp, LANCE.J1, ADR.J1, ADR.C1, PM, OFFRE / 2n);
    /* C1 finance F1 en WETH avant son achat */
    const hw = nouvelleTx(LANCE.J1 - 500, ADR.C1, K.ADR.WETH);
    transfer(hw, LANCE.J1 - 500, K.ADR.WETH, ADR.C1, ADR.F1, E);
  }
  /* ---- J2 : lance par C1 via la fabrique FAB (la tx frappe le jeton) ---- */
  {
    const hp = nouvelleTx(LANCE.J2, ADR.C1, ADR.FAB);
    transfer(hp, LANCE.J2, ADR.J2, K.ADR.ETH_NATIF, PM, OFFRE);
    init(hp, LANCE.J2, POOL.J2, ADR.J2); modif(hp, LANCE.J2, POOL.J2, 10n ** 24n);
  }
  /* ---- J3 : migration envoyee par OP ; l'ancien J3V lance par C3 via LP0 ---- */
  {
    const hv = nouvelleTx(5000000, ADR.C3, ADR.LP0);
    transfer(hv, 5000000, ADR.J3V, K.ADR.ETH_NATIF, ADR.LP0, OFFRE);
    const hm = nouvelleTx(10900000, ADR.OP, K.ADR.FABRIQUE_MIGRATIONS);
    ajoute(hm, journal(K.ADR.FABRIQUE_MIGRATIONS, [K.TOPIC.MIGRATOR_CREATED, pad(ADR.MIG), pad(ADR.J3V), pad(ADR.J3)], [], 10900000, hm, idx++));
    const hp = nouvelleTx(LANCE.J3, ADR.OP, ADR.MIG);
    transfer(hp, LANCE.J3, ADR.J3, K.ADR.ETH_NATIF, PM, OFFRE);
    init(hp, LANCE.J3, POOL.J3, ADR.J3); modif(hp, LANCE.J3, POOL.J3, 10n ** 24n);
  }
  /* ---- les 1res heures ---- */
  const sacs = {};
  const garde = (j, q, x) => { sacs[j + q] = (sacs[j + q] || 0n) + x; };
  for (const j of ['J1', 'J2', 'J3']) {
    const L = LANCE[j];
    for (const [q, d] of [['S1', 300], ['S2', 600], ['S3', 900]]) { const a = achat(j, ADR[q], L + d, E / 2n); garde(j, q, a.jet); }
    if (j === 'J1') {
      /* le groupe : meme bloc, meme mise */
      for (const q of ['G1', 'G2', 'G3']) { const a = achat(j, ADR[q], L + 1200, E / 5n); garde(j, q, a.jet); }
      const f = achat(j, ADR.F1, L + 1500, E / 4n); garde(j, 'F1', f.jet);
      /* C1 achete puis brule */
      const c = achat(j, ADR.C1, L + 1800, E / 10n);
      const hb = nouvelleTx(L + 1900, ADR.C1, ADR.J1); transfer(hb, L + 1900, ADR.J1, ADR.C1, ADR_MORT(), c.jet);
      const t = achat(j, ADR.TARD, L + 40000, E / 2n); garde(j, 'TARD', t.jet);
    } else {
      /* le groupe ailleurs : blocs et mises differents */
      let d = 1300;
      for (const q of ['G1', 'G2', 'G3']) { const a = achat(j, ADR[q], L + d, E / 5n + BigInt(d) * 10n ** 13n); garde(j, q, a.jet); d += 50; }
    }
    if (j === 'J2') {
      const r = achat(j, ADR.R1, L + 2000, (3n * E) / 10n);
      const hr = nouvelleTx(L + 2100, ADR.R1, ADR.J2); transfer(hr, L + 2100, ADR.J2, ADR.R1, ADR.R1B, r.jet);
      vente(j, ADR.R1B, L + 50000, r.jet, E);
    } else {
      const r = achat(j, ADR.R1, L + 2000, (3n * E) / 10n); garde(j, 'R1', r.jet);
    }
    let d = 2500;
    for (const q of ['L1', 'L2', 'L3', 'L4']) { const a = achat(j, ADR[q], L + d, E); garde(j, q, a.jet); d += 100; }
    /* les ventes, apres l'heure */
    for (const q of ['S1', 'S2', 'S3', 'G1', 'G2', 'G3', 'R1', 'F1']) {
      const sac = sacs[j + q]; if (!sac) continue;
      const perd = (q === 'S3' && j === 'J3');
      const paye = q[0] === 'G' ? E / 5n : q === 'R1' ? (3n * E) / 10n : q === 'F1' ? E / 4n : E / 2n;
      vente(j, ADR[q], L + 60000 + q.charCodeAt(1), sac, perd ? paye / 2n : paye * 2n);
      sacs[j + q] = 0n;
    }
    /* le dernier Swap : un petit achat d'un passant, au prix bas (les L tiennent a perte) */
    achat(j, A('ab'), L + 90000, 10n ** 15n, SQ(10000n));
    /* J1 : un acheteur LOIN du lancement (~53 h : apres 24 h, avant 72 h), au
       meme prix bas que le passant (revue C5 : la lecture par acheteur
       s'arretait a 24 h) */
    if (j === 'J1') achat(j, ADR.LOIN, L + 1900000, E / 50n, SQ(10000n));
  }
  return { logs, recus, txs, sacs, nouvelleTx, ajoute, achat, transfer, init, idxRef: () => idx };
}
const ADR_MORT = () => K.ADR.MORT;

/** Les soldes rejoues (ce que balanceOf rendrait). */
function soldes(logs) {
  const s = new Map();
  for (const l of logs) {
    const e = K.decode(l);
    if (!e || e.genre !== 'transfer') continue;
    const k1 = e.jeton + e.de, k2 = e.jeton + e.vers;
    s.set(k1, (s.get(k1) || 0n) - e.valeur); s.set(k2, (s.get(k2) || 0n) + e.valeur);
  }
  return s;
}

/** Les sources : GeckoTerminal, DexScreener, registre des actions. */
function sources(o) {
  const tok = (a, sym) => ({ id: 'robinhood_' + a, type: 'token', attributes: { address: a, symbol: sym, decimals: 18 } });
  const pool = (adr, base, quote, fdv, actifs, extra) => ({ id: 'robinhood_' + adr, type: 'pool', attributes: Object.assign({ address: adr, fdv_usd: String(fdv), market_cap_usd: null, base_token_price_usd: String(fdv / 1e9),
    volume_usd: { h24: '50000' }, transactions: { h24: { buyers: actifs / 2, sellers: actifs / 2 } }, reserve_in_usd: '100000', pool_created_at: '2026-06-01T00:00:00Z' }, extra || {}),
    relationships: { base_token: { data: { id: 'robinhood_' + base } }, quote_token: { data: { id: 'robinhood_' + quote } }, dex: { data: { id: 'uniswap-v4-robinhood' } } } });
  const page = {
    data: [
      pool(ADR.POOL1, ADR.J1, K.ADR.ETH_NATIF, 2.5e6, 400),
      pool(ADR.POOL2, ADR.J2, K.ADR.ETH_NATIF, 1.4e6, 120),
      pool(ADR.POOL3, ADR.J3, K.ADR.ETH_NATIF, 3e5, 80),
      pool('0x' + '5'.repeat(40), K.ADR.WETH, K.ADR.USDG, 9e8, 9000),
      pool('0x' + '6'.repeat(40), ADR.STOCK, K.ADR.USDG, 5e7, 900),
      pool('0x' + '7'.repeat(40), ADR.COPIE, ADR.STOCK, 3e7, 10),
      pool('0x' + '8'.repeat(40), ADR.EXT, K.ADR.WETH, 2e6, 300, { market_cap_usd: '9e8' }),
    ],
    included: [tok(ADR.J1, 'ONE'), tok(ADR.J2, 'TWO'), tok(ADR.J3, 'THREE'), tok(K.ADR.WETH, 'WETH'), tok(K.ADR.USDG, 'USDG'), tok(K.ADR.ETH_NATIF, 'ETH'), tok(ADR.STOCK, 'NVDA'), tok(ADR.COPIE, 'ONE'), tok(ADR.EXT, 'U')],
  };
  /* la copie a le meme symbole que J1 ET les memes caracteres 3-5 et 4 derniers */
  const ohlcv = (jeton, base) => ({ data: { attributes: { ohlcv_list: [[T0 + 86400 * 2, 1, 2.2e-3, 1, 1.5e-3, 1], [T0 + 86400, 1, 9e-3, 1, 1.6e-3, 1]] } }, meta: { base: { address: base || jeton }, quote: { address: K.ADR.ETH_NATIF } } });
  const paire = (j, pool, sym, creeeBloc) => ({ chainId: 'robinhood', dexId: 'uniswap', pairAddress: pool, labels: ['v4'], baseToken: { address: j, symbol: sym }, quoteToken: { address: K.ADR.ETH_NATIF, symbol: 'ETH' },
    priceUsd: '0.001', priceNative: '0.0000004', fdv: 1e6, marketCap: 1e6, liquidity: { quote: 10 }, pairCreatedAt: horodatage(creeeBloc) * 1000, txns: { h24: { buys: 50, sells: 50 } } });
  const journalHttp = [];
  const reponses = {
    gt(url) {
      if (/new_pools/.test(url)) return { data: [], included: [] };
      if (/networks\/robinhood\/pools\?/.test(url)) return /page=1(&|$)/.test(url) ? page : { data: [], included: [] };
      const m = url.match(/ohlcv\/day\?.*token=(0x[0-9a-f]+)/);
      if (m) return ohlcv(m[1], o && o.ohlcvInverse ? K.ADR.WETH : null);
      return null;
    },
    ds(url) {
      const m = url.match(/token-pairs\/v1\/robinhood\/(0x[0-9a-f]+)/);
      if (m) { const j = m[1]; const n = j === ADR.J1 ? 'J1' : j === ADR.J2 ? 'J2' : j === ADR.J3 ? 'J3' : null; return n ? [paire(j, POOL[n], n === 'J1' ? 'ONE' : n === 'J2' ? 'TWO' : 'THREE', LANCE[n])] : []; }
      const o2 = url.match(/orders\/v1\/robinhood\/(0x[0-9a-f]+)/);
      if (o2) return o2[1] === ADR.J1 ? { orders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: (horodatage(LANCE.J1) + 3600) * 1000 }], boosts: [] } : { orders: [], boosts: [] };
      if (/tokens\/v1/.test(url)) return [];
      return null;
    },
  };
  return { reponses, journalHttp, actions: async () => new Map([[ADR.STOCK, { symbole: 'NVDA' }]]) };
}

module.exports = { cree, soldes, sources, ADR, LANCE, POOL, POINTE, T0, horodatage, E, PM };
