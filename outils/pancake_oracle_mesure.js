'use strict';
/* ==========================================================================
 * MESURE : LE RETARD DE L'ORACLE PREDIT-IL UN ROUND PANCAKESWAP ? (29/09/2026)
 *
 * Demande du proprietaire : « ameliore pancake swap prediction ». Ce qui est deja mesure
 * (EXPLOITATION.md) : la direction BNB a 5 min du moteur est une piece (49,1 % sur 7 876
 * bougies ; en production 713 rounds, -6,7 %/pari ; l'inverse -0,8 % ; l'outsider -0,03 %).
 *
 * Idee testee ici, STRUCTURELLE et non technique : le prix de depart d'un round
 * (lockPrice) est la derniere reponse de l'oracle Chainlink BNB/USD au moment du lock, et
 * l'issue est la reponse de l'oracle au close. Si, quelques secondes avant le lock, le prix
 * du marche (Binance, bougies d'une seconde) est deja loin de la reponse de l'oracle, le
 * round demarre sur un prix EN RETARD : le close, lui, aura rattrape le marche.
 *
 * Pour chaque round : la reponse oracle publiee a (lock - L) et le prix Binance a (lock - L).
 * Signal : le signe de (Binance - reponse connue). Juge sur les VRAIS lockPrice et closePrice.
 *
 * 03/10/2026 — v2, DEUX INFORMATIONS DU FUTUR RETIREES (recherche du 03/10, verifiee dans ce code) :
 *   1. la v1 ne gardait que les rounds ou la reponse DEVENUE lockPrice etait deja publiee a lock - L :
 *      un conditionnement sur « pas de rafraichissement avant l'execution », connu seulement apres, et
 *      plus rare justement quand l'ecart est grand (declencheur de deviation de Chainlink). La v2 prend
 *      la derniere reponse publiee a lock - L (on remonte les rounds Chainlink), parie que le round soit
 *      rafraichi ensuite ou non, et publie les deux moities ;
 *   2. chaque bougie d'une seconde etait rangee a son heure d'OUVERTURE avec son prix de CLOTURE : le
 *      « prix a lock - L » etait celui de lock - L + 1 s. Elle est rangee a son heure de cloture.
 * La v1 est gardee a cote (« v1, biaise ») pour mesurer ce que le biais valait.
 * Paye a la cote FINALE reelle du camp (pools finaux + notre mise, 3 % de frais), gaz reel
 * 0,00002 BNB par aller-retour (recus du 24/09), egalite perdue, round annule exclu.
 *
 *   node outils/pancake_oracle_mesure.js [nombre de rounds, 3000 par defaut]
 * Ecrit le detail dans _releves/pancake_oracle_<date>.json (hors depot).
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'];
const PRED = '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const BINANCE = 'https://data-api.binance.vision/api/v3/klines';
const MISE = 0.002, GAZ = 0.00002, FRAIS = 0.03;
const LEADS = [3, 8, 15, 30];                 /* secondes avant le lock ou l'on deciderait */
const SEUILS = [0, 0.0002, 0.0005, 0.001];    /* ecart relatif minimal Binance / oracle */
const N = Math.max(100, Number(process.argv[2] || 3000));

const IP = new ethers.utils.Interface(['function currentEpoch() view returns (uint256)', 'function oracle() view returns (address)',
  'function rounds(uint256) view returns (uint256 epoch,uint256 startTimestamp,uint256 lockTimestamp,uint256 closeTimestamp,int256 lockPrice,int256 closePrice,uint256 lockOracleId,uint256 closeOracleId,uint256 totalAmount,uint256 bullAmount,uint256 bearAmount,uint256 rewardBaseCalAmount,uint256 rewardAmount,bool oracleCalled)']);
const IO = new ethers.utils.Interface(['function getRoundData(uint80) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcI = 0;
async function lot(appels) {
  for (let essai = 0; essai < 8; essai++) {
    const url = RPCS[rpcI++ % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(appels.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))),
        signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!Array.isArray(j) || j.some((x) => x.error)) throw new Error('lot incomplet');
      return j.sort((a, b) => a.id - b.id).map((x) => x.result);
    } catch (e) { await dort(500 * 2 ** essai); }
  }
  throw new Error('RPC indisponible');
}

async function prixBinance(t0, t1) {
  for (let essai = 0; essai < 6; essai++) {
    try {
      const r = await fetch(BINANCE + '?symbol=BNBUSDT&interval=1s&startTime=' + t0 * 1000 + '&endTime=' + t1 * 1000 + '&limit=1000', { signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status === 418) { await dort(5000 * (essai + 1)); continue; }
      const k = await r.json();
      const m = new Map();
      for (const x of k) m.set(Math.floor(x[0] / 1000) + 1, Number(x[4]));   /* rangee a l'heure ou elle se FERME (v2) */
      return m;
    } catch (e) { await dort(1000 * (essai + 1)); }
  }
  return null;
}
/* Le prix a la seconde t : la derniere seconde echangee a ou avant t (une seconde sans echange n'a pas de bougie). */
function a(m, t) { for (let d = 0; d <= 10; d++) if (m.has(t - d)) return m.get(t - d); return null; }

function wilson(k, n) { if (!n) return [0, 0]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), e = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - e) / d, (c + e) / d]; }
function stats(l) {
  const n = l.length; if (!n) return { n: 0 };
  const g = l.filter((x) => x.gagne).length, ev = l.map((x) => x.ev), m = ev.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(ev.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const h = Math.floor(n / 2), m1 = ev.slice(0, h).reduce((s, x) => s + x, 0) / Math.max(1, h), m2 = ev.slice(h).reduce((s, x) => s + x, 0) / Math.max(1, n - h);
  const w = wilson(g, n);
  return { n, taux: +(100 * g / n).toFixed(1), wilson: [+(100 * w[0]).toFixed(1), +(100 * w[1]).toFixed(1)], evPct: +(100 * m).toFixed(2), sePct: +(100 * se).toFixed(2), t: +(m / (se || 1e-9)).toFixed(2),
    moitie1: +(100 * m1).toFixed(2), moitie2: +(100 * m2).toFixed(2), coteMoy: +(l.reduce((s, x) => s + x.cote, 0) / n).toFixed(3) };
}

(async () => {
  const [ce, orc] = await lot([{ to: PRED, data: IP.encodeFunctionData('currentEpoch') }, { to: PRED, data: IP.encodeFunctionData('oracle') }]);
  const cur = IP.decodeFunctionResult('currentEpoch', ce)[0].toNumber(), ORACLE = IP.decodeFunctionResult('oracle', orc)[0];
  console.log('epoch courant', cur, '— oracle', ORACLE, '— rounds mesures', N);
  const epochs = []; for (let e = cur - 2 - N; e < cur - 2; e++) epochs.push(e);
  const rounds = [];
  for (let i = 0; i < epochs.length; i += 50) {
    const res = await lot(epochs.slice(i, i + 50).map((e) => ({ to: PRED, data: IP.encodeFunctionData('rounds', [e]) })));
    res.forEach((x) => { const r = IP.decodeFunctionResult('rounds', x); rounds.push({ epoch: r.epoch.toNumber(), lock: r.lockTimestamp.toNumber(), close: r.closeTimestamp.toNumber(),
      lp: Number(r.lockPrice) / 1e8, cp: Number(r.closePrice) / 1e8, lid: r.lockOracleId, bull: Number(ethers.utils.formatEther(r.bullAmount)), bear: Number(ethers.utils.formatEther(r.bearAmount)),
      total: Number(ethers.utils.formatEther(r.totalAmount)), oc: r.oracleCalled }); });
    if (i % 500 === 0) process.stdout.write('  rounds ' + rounds.length + '\r');
  }
  const bons = rounds.filter((r) => r.oc && r.lp > 0 && r.cp > 0 && r.lock > 0);
  /* l'instant ou l'oracle a publie le lockPrice, et les trois reponses d'avant (v2 : la reponse CONNUE a lock - L) */
  for (let i = 0; i < bons.length; i += 12) {
    const tranche = bons.slice(i, i + 12);
    const appels = [];
    for (const r of tranche) for (let d = 0; d < 4; d++) appels.push({ to: ORACLE, data: IO.encodeFunctionData('getRoundData', [r.lid.sub(d)]) });
    let res;
    try { res = await lot(appels); } catch (e) { res = null; }
    tranche.forEach((r, k) => {
      r.reps = [];
      for (let d = 0; d < 4; d++) {
        try { const x = IO.decodeFunctionResult('getRoundData', res[k * 4 + d]); r.reps.push({ maj: x.updatedAt.toNumber(), rep: Number(x.answer) / 1e8 }); } catch (e) { /* debut de phase */ }
      }
      if (r.reps[0]) { r.maj = r.reps[0].maj; r.rep = r.reps[0].rep; }
    });
  }
  /** v2 : la derniere reponse publiee a t, et si une plus recente est arrivee ensuite. */
  const connueA = (r, t) => { const c = (r.reps || []).find((x) => x.maj <= t); return c ? { prix: c.rep, rafraichi: !!(r.reps[0] && r.reps[0].maj > t) } : null; };
  console.log('\nrounds regles', bons.length, '— lockPrice = reponse de l oracle :', bons.filter((r) => Math.abs(r.rep - r.lp) < 1e-9).length);
  const retards = bons.map((r) => r.lock - r.maj).sort((x, y) => x - y);
  console.log('age de la reponse oracle au lock : mediane', retards[Math.floor(retards.length / 2)], 's, p90', retards[Math.floor(retards.length * 0.9)], 's, max', retards[retards.length - 1], 's');

  /* Binance, une fenetre de 40 s avant chaque lock (5 requetes en parallele, sans depasser la limite) */
  let faits = 0;
  for (let i = 0; i < bons.length; i += 5) {
    await Promise.all(bons.slice(i, i + 5).map(async (r) => { r.bn = await prixBinance(r.lock - 45, r.lock + 1); }));
    faits += 5; if (faits % 250 === 0) process.stdout.write('  binance ' + faits + '/' + bons.length + '\r');
    await dort(120);
  }
  const pari = (r, camp) => {
    const pool = camp === 'BULL' ? r.bull : r.bear;
    const cote = (r.total + MISE) * (1 - FRAIS) / (pool + MISE);
    const gagne = camp === 'BULL' ? r.cp > r.lp : r.cp < r.lp;   /* egalite : perdue */
    return { epoch: r.epoch, gagne, cote, ev: (gagne ? cote : 0) - 1 - GAZ / MISE };
  };
  const resultats = {}, v1 = {};
  for (const L of LEADS) for (const th of SEUILS) {
    const paris = [], oui = [], non = [], biais = [];
    for (const r of bons) {
      if (!r.bn) continue;
      /* v1, biaise, gardee pour la comparaison : bougie a l'ouverture (+1 s du futur) et filtre sur le futur */
      const s1 = a(r.bn, r.lock - L + 1);
      if (s1 != null && !(r.maj > r.lock - L)) { const e1 = (s1 - r.lp) / r.lp; if (Math.abs(e1) > th && e1 !== 0) biais.push(pari(r, e1 > 0 ? 'BULL' : 'BEAR')); }
      /* v2 : seulement ce qui etait connu a lock - L */
      const k = connueA(r, r.lock - L); if (!k) continue;
      const s = a(r.bn, r.lock - L); if (s == null) continue;
      const ecart = (s - k.prix) / k.prix;
      if (Math.abs(ecart) <= th || ecart === 0) continue;
      const p = pari(r, ecart > 0 ? 'BULL' : 'BEAR');
      paris.push(p); (k.rafraichi ? oui : non).push(p);
    }
    resultats['L' + L + '_seuil' + th] = Object.assign(stats(paris), { rafraichisPct: paris.length ? +(100 * oui.length / paris.length).toFixed(1) : null, rafraichis: stats(oui), nonRafraichis: stats(non) });
    v1['L' + L + '_seuil' + th] = stats(biais);
  }
  /* temoin : le meme calcul, camp tire au hasard (graine fixe) */
  let g = 42; const hasard = () => ((g = (g * 1103515245 + 12345) % 2147483648) / 2147483648);
  const t = bons.filter((r) => r.bn).map((r) => { const camp = hasard() < 0.5 ? 'BULL' : 'BEAR', pool = camp === 'BULL' ? r.bull : r.bear, cote = (r.total + MISE) * (1 - FRAIS) / (pool + MISE);
    const gagne = camp === 'BULL' ? r.cp > r.lp : r.cp < r.lp; return { gagne, cote, ev: (gagne ? cote : 0) - 1 - GAZ / MISE }; });
  resultats.temoin_hasard = stats(t);
  const court = (v) => v && v.n ? 'n=' + v.n + ' gagnes=' + v.taux + '% ev=' + v.evPct + '% t=' + v.t + ' cote=' + v.coteMoy : 'n=0';
  console.log('\nreglage                v2 (connu a lock - L)                                 | rafraichis | v1, biaise');
  for (const k of Object.keys(v1)) { const r = resultats[k]; console.log(k.padEnd(22), court(r).padEnd(52), '|', String(r.rafraichisPct) + '% (' + court(r.rafraichis) + ' / non : ' + court(r.nonRafraichis) + ')', '|', court(v1[k])); }
  console.log('temoin_hasard          ' + court(resultats.temoin_hasard));
  const dos = path.join(__dirname, '..', '_releves'); fs.mkdirSync(dos, { recursive: true });
  const f = path.join(dos, 'pancake_oracle_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json');
  fs.writeFileSync(f, JSON.stringify({ quand: new Date().toISOString(), epochs: [epochs[0], epochs[epochs.length - 1]], regles: bons.length, retardOracle: { mediane: retards[Math.floor(retards.length / 2)], p90: retards[Math.floor(retards.length * 0.9)] }, resultats, v1Biaise: v1 }, null, 1));
  console.log('detail :', f);
})().catch((e) => { console.error(e); process.exit(1); });
