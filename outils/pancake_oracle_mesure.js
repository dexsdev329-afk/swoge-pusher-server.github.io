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
 * Pour chaque round : la reponse oracle deja publiee a (lock - L) — on ne garde que les rounds
 * ou le lockPrice etait DEJA connu a cet instant (updatedAt <= lock - L), sinon on
 * tricherait — et le prix Binance a (lock - L). Signal : le signe de (Binance - lockPrice).
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
      for (const x of k) m.set(Math.floor(x[0] / 1000), Number(x[4]));   /* cloture de chaque seconde */
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
  /* l'instant ou l'oracle a publie le lockPrice */
  for (let i = 0; i < bons.length; i += 50) {
    const res = await lot(bons.slice(i, i + 50).map((r) => ({ to: ORACLE, data: IO.encodeFunctionData('getRoundData', [r.lid]) })));
    res.forEach((x, k) => { const d = IO.decodeFunctionResult('getRoundData', x); bons[i + k].maj = d.updatedAt.toNumber(); bons[i + k].rep = Number(d.answer) / 1e8; });
  }
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
  const resultats = {};
  for (const L of LEADS) for (const th of SEUILS) {
    const paris = [];
    for (const r of bons) {
      if (!r.bn || r.maj > r.lock - L) continue;                 /* le lockPrice n'etait pas encore connu : on ne triche pas */
      const s = a(r.bn, r.lock - L); if (s == null) continue;
      const ecart = (s - r.lp) / r.lp;
      if (Math.abs(ecart) <= th || ecart === 0) continue;
      const camp = ecart > 0 ? 'BULL' : 'BEAR', pool = camp === 'BULL' ? r.bull : r.bear;
      const cote = (r.total + MISE) * (1 - FRAIS) / (pool + MISE);
      const gagne = camp === 'BULL' ? r.cp > r.lp : r.cp < r.lp;   /* egalite : perdue */
      paris.push({ epoch: r.epoch, gagne, cote, ev: (gagne ? cote : 0) - 1 - GAZ / MISE });
    }
    resultats['L' + L + '_seuil' + th] = stats(paris);
  }
  /* temoin : le meme calcul, camp tire au hasard (graine fixe) */
  let g = 42; const hasard = () => ((g = (g * 1103515245 + 12345) % 2147483648) / 2147483648);
  const t = bons.filter((r) => r.bn).map((r) => { const camp = hasard() < 0.5 ? 'BULL' : 'BEAR', pool = camp === 'BULL' ? r.bull : r.bear, cote = (r.total + MISE) * (1 - FRAIS) / (pool + MISE);
    const gagne = camp === 'BULL' ? r.cp > r.lp : r.cp < r.lp; return { gagne, cote, ev: (gagne ? cote : 0) - 1 - GAZ / MISE }; });
  resultats.temoin_hasard = stats(t);
  console.log('\n' + Object.entries(resultats).map(([k, v]) => k.padEnd(22) + JSON.stringify(v)).join('\n'));
  const dos = path.join(__dirname, '..', '_releves'); fs.mkdirSync(dos, { recursive: true });
  const f = path.join(dos, 'pancake_oracle_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json');
  fs.writeFileSync(f, JSON.stringify({ quand: new Date().toISOString(), epochs: [epochs[0], epochs[epochs.length - 1]], regles: bons.length, retardOracle: { mediane: retards[Math.floor(retards.length / 2)], p90: retards[Math.floor(retards.length * 0.9)] }, resultats }, null, 1));
  console.log('detail :', f);
})().catch((e) => { console.error(e); process.exit(1); });
