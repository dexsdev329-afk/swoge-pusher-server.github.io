'use strict';
/* Le relais JSON-RPC de Robinhood Chain (relais_rpc.js, 18/10/2026), contre un
   FAUX noeud local qui, comme le vrai vu depuis un navigateur le 18/10, rend
   ses reponses avec un en-tete CORS en double. Ce que le relais doit tenir :
   lecture seule (liste fermee, eth_sendRawTransaction jamais transmis), bornes
   (corps, lot, plage de 10 M de blocs), debit par IP, un seul en-tete CORS,
   erreurs du noeud rendues telles quelles, cache des seules plages fermees,
   l'URL du noeud jamais dans une reponse. Puis la route du vrai serveur. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./relais_rpc');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

/* Le faux noeud : pointe 0x5000000 (83 886 080), journaux factices, erreurs a la demande. */
function fauxNoeud() {
  const vus = [];
  let mode = 'normal';
  const srv = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const j = JSON.parse(b); vus.push(j.method);
      if (mode === 'http500') { r.writeHead(500, { 'content-type': 'text/html' }); return r.end('<html>bad gateway</html>'); }
      if (mode === 'coupe') { r.destroy(); return; }
      let rep;
      if (j.method === 'eth_chainId') rep = { result: '0x1237' };
      else if (j.method === 'eth_blockNumber') rep = { result: '0x5000000' };
      else if (j.method === 'eth_getLogs') rep = { result: [{ address: j.params[0].address || '0x0', blockNumber: j.params[0].fromBlock, data: '0x', topics: [], logIndex: '0x0' }] };
      else if (j.method === 'eth_call' && j.params[0].data === '0xdead') rep = { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } };
      else if (j.method === 'eth_call') rep = { result: '0x' + '00'.repeat(31) + '2a' };
      else rep = { result: '0x0' };
      /* Le defaut observe : deux fois le meme en-tete. Le relais ne doit jamais le recopier. */
      r.setHeader('access-control-allow-origin', ['*', '*']);
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify(Object.assign({ jsonrpc: '2.0', id: j.id }, rep)));
    });
  });
  return { srv, vus, mode: (m) => { mode = m; } };
}
const ecoute = (srv) => new Promise((ok2) => srv.listen(0, '127.0.0.1', () => ok2('http://127.0.0.1:' + srv.address().port)));
async function poste(url, corps, entetes) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, entetes || {}), body: typeof corps === 'string' ? corps : JSON.stringify(corps) });
  const texte = await r.text();
  let j = null; try { j = JSON.parse(texte); } catch (e) { /* rien */ }
  return { status: r.status, h: r.headers, j, texte };
}
const appel = (method, params, id) => ({ jsonrpc: '2.0', id: id == null ? 1 : id, method, params: params || [] });

(async () => {
  const noeud = fauxNoeud();
  const URL_NOEUD = await ecoute(noeud.srv);
  let horloge = 1e12;
  const relais = R.cree({ amont: URL_NOEUD + '/v2/CLE-SECRETE-XYZ', maintenant: () => horloge });
  const front = http.createServer((q, r) => relais.sert(q, r, String(q.headers['x-ip'] || '1.1.1.1')));
  const BASE = await ecoute(front);

  console.log('-- la liste fermee : lecture seule --');
  {
    let r = await poste(BASE, appel('eth_chainId'));
    ok(r.status === 200 && r.j.result === '0x1237' && r.j.id === 1, 'eth_chainId : rendu, meme id');
    const avant = noeud.vus.length;
    for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_accounts',
      'eth_newFilter', 'eth_subscribe', 'debug_traceTransaction', 'admin_peers', 'txpool_content', 'anvil_setBalance', 'eth_getTransactionCount']) {
      r = await poste(BASE, appel(m, ['0x02f8']));
      ok(r.status === 200 && r.j.error && r.j.error.code === -32601 && /read-only/.test(r.j.error.message), m + ' : refusee (-32601, read-only)');
    }
    ok(noeud.vus.length === avant && !noeud.vus.includes('eth_sendRawTransaction'), 'aucune methode refusee n a atteint le noeud');
    r = await poste(BASE, [appel('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x06fdde03' }, 'latest'], 7), appel('eth_sendRawTransaction', ['0x02f8'], 8)]);
    ok(Array.isArray(r.j) && r.j[0].id === 7 && r.j[0].result && r.j[1].id === 8 && r.j[1].error && r.j[1].error.code === -32601,
      'lot : eth_call rendu, eth_sendRawTransaction refuse a cote, chacun sous son id');
    ok(!noeud.vus.includes('eth_sendRawTransaction'), 'meme glisse dans un lot, eth_sendRawTransaction ne part pas');
    r = await poste(BASE, appel('eth_getBlockByNumber', ['latest', true]));
    ok(r.j.error && r.j.error.code === -32602, 'un bloc avec ses transactions completes : refuse');
    r = await poste(BASE, '{pas du json');
    ok(r.status === 400 && r.j.error.code === -32700, 'corps illisible : 400, -32700');
    r = await poste(BASE, { method: 'eth_chainId', id: 1 });
    ok(r.j.error && r.j.error.code === -32600, 'sans jsonrpc 2.0 : -32600');
  }

  console.log('\n-- les bornes --');
  {
    let r = await poste(BASE, appel('eth_getLogs', [{ address: '0x' + '22'.repeat(20), fromBlock: '0x0', toBlock: '0x' + (10000000).toString(16) }]));
    ok(r.j.error && r.j.error.code === -32005 && /10,000,000/.test(r.j.error.message), 'eth_getLogs sur 10 000 001 blocs : refuse (10 000 000 au plus, la limite du noeud)');
    r = await poste(BASE, appel('eth_getLogs', [{ address: '0x' + '22'.repeat(20), fromBlock: '0x0', toBlock: '0x' + (9999999).toString(16) }]));
    ok(Array.isArray(r.j.result), 'eth_getLogs sur 10 000 000 blocs exactement : rendu');
    r = await poste(BASE, appel('eth_getLogs', [{ address: '0x' + '22'.repeat(20), fromBlock: 'earliest', toBlock: 'latest' }]));
    ok(r.j.error && r.j.error.code === -32005, 'eth_getLogs de earliest a latest (83 M blocs) : refuse');
    r = await poste(BASE, appel('eth_getLogs', [{ address: '0x' + '22'.repeat(20), fromBlock: '0x' + (0x5000000 - 100).toString(16) }]));
    ok(Array.isArray(r.j.result), 'eth_getLogs sans toBlock, 100 blocs avant la pointe : rendu');
    r = await poste(BASE, appel('eth_getLogs', [{ fromBlock: 'hier' }]));
    ok(r.j.error && r.j.error.code === -32602, 'une borne illisible : -32602');
    const lot = []; for (let i = 0; i < R.DEFAUTS.LOT_MAX + 1; i++) lot.push(appel('eth_chainId', [], i));
    r = await poste(BASE, lot);
    ok(r.status === 400 && /at most 25/.test(r.j.error.message), 'un lot de 26 : 400');
    r = await poste(BASE, lot.slice(0, 25));
    ok(r.status === 200 && r.j.length === 25 && r.j.every((x, i) => x.id === i && x.result === '0x1237'), 'un lot de 25 : 25 reponses, dans l ordre, chacune sous son id');
    r = await poste(BASE, []);
    ok(r.status === 400, 'un lot vide : 400');
    r = await poste(BASE, JSON.stringify(appel('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x' + 'ab'.repeat(70000) }, 'latest'])));
    ok(r.status === 413 && r.j && r.j.error, 'un corps de plus de 128 Kio : 413');
    ok(r.h.get('access-control-allow-origin') === '*', 'et meme le refus porte l en-tete CORS (le navigateur doit pouvoir lire le refus)');
  }

  console.log('\n-- CORS : un seul en-tete, celui du relais --');
  {
    const brut = await new Promise((ok2) => {
      const q = http.request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => ok2(r.rawHeaders)); });
      q.end(JSON.stringify(appel('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }])));
    });
    const acao = []; for (let i = 0; i < brut.length; i += 2) if (brut[i].toLowerCase() === 'access-control-allow-origin') acao.push(brut[i + 1]);
    ok(acao.length === 1 && acao[0] === '*', 'le noeud envoie « *, * » ; le relais renvoie un seul access-control-allow-origin: * (lu : ' + JSON.stringify(acao) + ')');
    const o = await fetch(BASE, { method: 'OPTIONS', headers: { origin: 'https://swoleeswoge.dog', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    ok(o.status === 204 && o.headers.get('access-control-allow-origin') === '*' && /POST/.test(o.headers.get('access-control-allow-methods'))
      && /content-type/.test(o.headers.get('access-control-allow-headers')), 'OPTIONS (pre-vol) : 204, POST et content-type permis');
    const r = await poste(BASE, appel('eth_chainId'));
    ok(r.h.get('cache-control') === 'no-store', 'no-store');
    const g = await fetch(BASE);
    ok(g.status === 405, 'GET : 405');
  }

  console.log('\n-- les erreurs du noeud, telles quelles ; une panne, sans URL --');
  {
    let r = await poste(BASE, appel('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0xdead' }, 'latest'], 'x'));
    ok(r.j.id === 'x' && r.j.error && r.j.error.code === 3 && r.j.error.message === 'execution reverted' && r.j.error.data === '0x08c379a0',
      'un revert : code, message et data du noeud rendus tels quels (ethers decode la raison)');
    noeud.mode('http500');
    r = await poste(BASE, appel('eth_getBalance', ['0x' + '11'.repeat(20), 'latest']));
    ok(r.status === 200 && r.j.error && r.j.error.code === -32603 && /HTTP 500/.test(r.j.error.message), 'le noeud rend une page HTML 500 : -32603 « upstream node HTTP 500 »');
    noeud.mode('coupe');
    r = await poste(BASE, appel('eth_getBalance', ['0x' + '11'.repeat(20), 'latest']));
    ok(r.j.error && /unreachable/.test(r.j.error.message), 'le noeud coupe la connexion : « upstream node unreachable »');
    noeud.mode('normal');
    ok(!/CLE-SECRETE|127\.0\.0\.1:\d+\/v2/.test(r.texte) && !/CLE-SECRETE/.test(JSON.stringify(relais.etat())), 'ni la reponse ni l etat ne contiennent l URL du noeud (ni sa cle)');
  }

  console.log('\n-- le cache : seulement les plages fermees --');
  {
    const F = { address: '0x' + '33'.repeat(20), topics: ['0x' + 'aa'.repeat(32)] };
    const compte = () => noeud.vus.filter((m) => m === 'eth_getLogs').length;
    const ferme = () => poste(BASE, appel('eth_getLogs', [Object.assign({ fromBlock: '0x100', toBlock: '0x200' }, F)]));
    let a = compte(); await ferme(); await ferme(); await ferme();
    ok(compte() - a === 1, 'une plage fermee lue trois fois : un seul appel au noeud');
    const ouvert = () => poste(BASE, appel('eth_getLogs', [Object.assign({ fromBlock: '0x' + (0x5000000 - 10).toString(16), toBlock: '0x5000000' }, F)]));
    a = compte(); await ouvert(); await ouvert();
    ok(compte() - a === 2, 'une plage qui touche les 64 derniers blocs : relue a chaque fois');
    a = noeud.vus.filter((m) => m === 'eth_chainId').length;
    await poste(BASE, appel('eth_chainId')); await poste(BASE, appel('eth_chainId'));
    ok(noeud.vus.filter((m) => m === 'eth_chainId').length === a, 'eth_chainId : plus jamais redemande au noeud');
    a = noeud.vus.filter((m) => m === 'eth_blockNumber').length;
    for (let i = 0; i < 5; i++) await poste(BASE, appel('eth_blockNumber'));
    ok(noeud.vus.filter((m) => m === 'eth_blockNumber').length - a <= 1, 'eth_blockNumber x5 en moins de 2 s : au plus un appel au noeud');
    horloge += 3000;
    await poste(BASE, appel('eth_blockNumber'));
    ok(noeud.vus.filter((m) => m === 'eth_blockNumber').length - a >= 1, 'apres 2 s : la pointe est relue');
  }

  console.log('\n-- le debit par IP --');
  {
    horloge += 3600 * 1000;                      // seaux pleins
    const ip = { 'x-ip': '9.9.9.9' };
    const lot = []; for (let i = 0; i < 25; i++) lot.push(appel('eth_chainId', [], i));
    let codes = [];
    for (let i = 0; i < 12; i++) codes.push((await poste(BASE, lot, ip)).status);   // 300 appels = le seau
    ok(codes.every((c) => c === 200), '300 appels d une IP d un coup : tous servis (le seau)');
    const r = await poste(BASE, appel('eth_chainId', [], 'z'), ip);
    ok(r.status === 429 && r.j.error.code === -32005 && r.j.id === 'z' && r.h.get('retry-after') && r.h.get('access-control-allow-origin') === '*',
      'le 301e : 429, -32005, retry-after, et lisible par le navigateur (CORS)');
    const autre = await poste(BASE, appel('eth_chainId'), { 'x-ip': '8.8.8.8' });
    ok(autre.status === 200, 'une autre IP n est pas touchee');
    horloge += 2000;
    ok((await poste(BASE, lot.slice(0, 10), ip)).status === 200, '2 s plus tard : 10 appels de nouveau (5 par seconde)');
    ok((await poste(BASE, lot.slice(0, 5), ip)).status === 429, 'mais pas 15');
    const e = relais.etat();
    ok(e.refus_debit >= 2 && e.refus_methode >= 13 && e.refus_plage >= 2 && e.cache >= 2, 'l etat compte les refus (debit ' + e.refus_debit + ', methode ' + e.refus_methode + ', plage ' + e.refus_plage + ') et le cache (' + e.cache + ')');
  }

  console.log('\n-- le debit de tout le serveur protege le noeud de la colonie --');
  {
    const r2 = R.cree({ amont: URL_NOEUD, maintenant: () => horloge, limites: { TOUS_SEAU: 40, TOUS_PAR_S: 1 } });
    const lot = []; for (let i = 0; i < 20; i++) lot.push(appel('eth_chainId', [], i));
    const a = await r2.traite(JSON.stringify(lot), '1.0.0.1'), b = await r2.traite(JSON.stringify(lot), '1.0.0.2'), c = await r2.traite(JSON.stringify(lot), '1.0.0.3');
    ok(a.status === 200 && b.status === 200 && c.status === 429, 'trois IP de 20 appels avec un seau commun de 40 : la troisieme a 429');
  }

  noeud.srv.close(); front.close();

  console.log('\n-- la route du vrai serveur --');
  {
    const n2 = fauxNoeud();
    const U2 = await ecoute(n2.srv);
    process.env.PORT = String(8920 + (process.pid % 50));
    process.env.RPC_URL = '';
    process.env.RH_RELAIS_RPC_URL = U2 + '/cle-du-noeud';
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relais-rpc-'));
    process.env.AI_COLONIE = '0';
    process.env.SMART_MONEY = '';
    for (const k of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_BACKUP_CHAT_ID', 'TG_BACKUP_ID', 'SMART_RPC_URL', 'ANTHROPIC_API_KEY']) delete process.env[k];
    const l = console.log, w = console.warn, er = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try { require('./server.js'); await new Promise((r) => setTimeout(r, 2500)); } finally { console.log = l; console.warn = w; console.error = er; }
    const S = 'http://127.0.0.1:' + process.env.PORT + '/rpc/rh';
    let r = await poste(S, appel('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]));
    ok(r.status === 200 && Array.isArray(r.j.result), 'POST /rpc/rh : eth_getLogs relaye au noeud RH_RELAIS_RPC_URL');
    ok(r.h.get('access-control-allow-origin') === '*' && r.h.get('cache-control') === 'no-store', 'un seul « * » (le noeud en envoyait deux), no-store');
    r = await poste(S, appel('eth_sendRawTransaction', ['0x02f8']));
    ok(r.j.error && r.j.error.code === -32601 && !n2.vus.includes('eth_sendRawTransaction'), 'eth_sendRawTransaction : refuse par le vrai serveur, jamais transmis');
    const o = await fetch(S, { method: 'OPTIONS' });
    ok(o.status === 204 && o.headers.get('access-control-allow-origin') === '*', 'OPTIONS /rpc/rh : 204');
    const et = await fetch(S + '/etat').then((x) => x.text());
    ok(/"refus_methode":1/.test(et) && !/cle-du-noeud/.test(et), '/rpc/rh/etat : les compteurs, sans l URL');
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* rien */ }
  }

  if (rates) { console.log(`RATES : ${rates}/${n}`); process.exit(1); }
  console.log(`relais_rpc.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
