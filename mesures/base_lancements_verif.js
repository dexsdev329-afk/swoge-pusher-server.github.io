/* Contre-mesure de base_lancements.js, independante de son etat : la derniere heure de Base
   relue directement (lancements Clanker/Zora, puis les echanges de LEURS piscines par topic1).
   node mesures/base_lancements_verif.js  —  28/09/2026 : 26 lancements, 6 echanges apres le bloc. */
const B = require('../base_lancements');
const URL = 'https://mainnet.base.org';
let id = 0;
async function rpc(m, p) { const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; }
const hx = (n) => '0x' + n.toString(16);
(async () => {
  const tete = parseInt(await rpc('eth_blockNumber', []), 16);
  const de = tete - 1800;
  const lanc = [];
  for (let a = de; a <= tete; a += 500) {
    const l = await rpc('eth_getLogs', [{ fromBlock: hx(a), toBlock: hx(Math.min(tete, a + 499)), address: [B.CLANKER, B.ZORA], topics: [[B.T ? B.T.clanker : B.IFC.getEventTopic('TokenCreated'), B.IFC.getEventTopic('CoinCreatedV4'), B.IFC.getEventTopic('CreatorCoinCreated')]] }]);
    for (const x of l) { const e = B.IFC.parseLog(x); lanc.push({ bloc: parseInt(x.blockNumber, 16), sorte: e.name, pool: e.args.poolId || e.args.poolKeyHash, jeton: e.args.tokenAddress || e.args.coin }); }
  }
  console.log('tete', tete, 'lancements derniere heure', lanc.length, JSON.stringify(lanc.reduce((o, x) => (o[x.sorte] = (o[x.sorte] || 0) + 1, o), {})));
  // echanges par piscine, par topic1, en paquets
  const swap = B.IFC.getEventTopic('Swap'); let tot = 0, avec = 0, memeBloc = 0;
  const par = {};
  for (let i = 0; i < lanc.length; i += 20) {
    const pools = lanc.slice(i, i + 20).map((x) => x.pool);
    const l = await rpc('eth_getLogs', [{ fromBlock: hx(de), toBlock: hx(tete), address: B.POOL_MANAGER, topics: [swap, pools] }]);
    for (const x of l) par[x.topics[1]] = (par[x.topics[1]] || []).concat(parseInt(x.blockNumber, 16));
  }
  for (const x of lanc) { const b = par[x.pool] || []; const apres = b.filter((k) => k > x.bloc).length; memeBloc += b.filter((k) => k === x.bloc).length; tot += apres; if (apres) avec++; }
  console.log('echanges apres le bloc de lancement', tot, 'jetons avec au moins un echange', avec, '/', lanc.length, 'echanges dans le bloc de lancement', memeBloc);
  console.log(lanc.slice(0, 3));
})().catch((e) => console.error(e.message));
