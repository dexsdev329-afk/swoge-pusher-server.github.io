'use strict';
/*
 * BASE DE BOUT EN BOUT, SUR LE VRAI SERVEUR (lot Base, contrat §F.3, 27 septembre 2026).
 * Un vrai serveur, un faux nœud Robinhood (comme x402_route.test.js), un FAUX
 * Coinbase local qui VÉRIFIE nos jetons avec la clé publique de l'essai, un
 * faux RPC de Base (lecture). Une clé CDP jetable, faite ici.
 *   1. la sonde /supported part du rappel de `listen`, AVANT toute requête ;
 *      Base s'allume (base.etat === 'on') ;
 *   2. REST : le 402 propose Base d'abord ; un paiement Base rend 200 ;
 *      /agentic/x402 dit base, networks, encaisse.USDC_BASE (6 décimales),
 *      `network` et `payTo` inchangés ; /openapi.json, le prix Base en minimum ;
 *      ask_agent (X402_AGENT=1) : 541000 sur Base, 300 s ; une tâche trop longue
 *      ou un autre modèle : 400 AVANT tout 402 ;
 *   3. MCP, les deux époques : la demande de paiement (isError,
 *      structuredContent, content[0], _meta x402/error), payer par OBJET, par
 *      base64 et par l'en-tête PAYMENT-SIGNATURE ; le même paiement rejoué ;
 *      un règlement raté ne laisse AUCUN texte d'outil ; « en attente » sans
 *      aucun accepts, le hash dans _meta ; une clé valide est débitée, x402
 *      jamais touché ; tools/list sans outputSchema ; X402_MCP=0 → le lot #28 ;
 *   4. le secret CDP, tout jeton (eyJ…) et toute valeur Authorization
 *      n'apparaissent dans AUCUNE réponse, ni dans le journal du serveur.
 */
const net = require('net');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { ethers } = require('ethers');
const WebSocket = require('ws');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const de64 = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const dort = (ms) => new Promise((r) => setTimeout(r, ms));
const X = require('./x402');

/* Tout ce que le serveur écrit au journal : on y cherchera le secret et les jetons. */
const journal = [];
for (const k of ['log', 'warn', 'error']) { const o = console[k]; console[k] = (...a) => { journal.push(a.map(String).join(' ')); o.apply(console, a); }; }

const SWOGE = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817';
const GAZ = ethers.Wallet.createRandom();
const TRESOR_W = ethers.Wallet.createRandom();
const TRESOR = TRESOR_W.address;
const PAYEUR = ethers.Wallet.createRandom();

/* ---- LA CLÉ CDP JETABLE (Ed25519, le défaut de Coinbase : base64 de graine || clé publique) ---- */
const paire = crypto.generateKeyPairSync('ed25519');
const jwk = paire.privateKey.export({ format: 'jwk' });
const SECRET = Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64');
const KID = crypto.randomUUID();

/* ---- LE FAUX NŒUD ROBINHOOD (4663), comme x402_route.test.js ---- */
function fauxNoeud() {
  const envoyees = [];
  let bloc = 1000;
  const recus = new Map();
  const PROXY_ABI = new ethers.utils.Interface(['function settle(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)']);
  const USDG_ABI = new ethers.utils.Interface(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
    'function authorizationState(address,bytes32) view returns (bool)']);
  const LECT = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function nonces(address) view returns (uint256)', 'function nonceBitmap(address,uint256) view returns (uint256)']);
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const q = JSON.parse(b);
      const un = (m) => {
        const p = m.params || [];
        const r = (result) => ({ jsonrpc: '2.0', id: m.id, result });
        switch (m.method) {
          case 'eth_chainId': return r('0x1237');
          case 'net_version': return r('4663');
          case 'eth_gasPrice': return r('0x' + (28000000).toString(16));
          case 'eth_blockNumber': return r('0x' + (bloc++).toString(16));
          case 'eth_getBalance': return r(ethers.utils.parseEther('0.01').toHexString());
          case 'eth_getTransactionCount': return r('0x' + envoyees.length.toString(16));
          case 'eth_getBlockByNumber': return r({ number: '0x' + bloc.toString(16), hash: '0x' + 'ab'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
            gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [], difficulty: '0x0', nonce: '0x0000000000000000' });
          case 'eth_call': {
            const to = String(p[0].to).toLowerCase(), data = p[0].data, sel = data.slice(0, 10);
            if (to === X.PROXY.toLowerCase()) return r('0x');
            if (to === X.USDG.toLowerCase() && sel === USDG_ABI.getSighash('transferWithAuthorization')) return r('0x');
            if (to === X.USDG.toLowerCase() && sel === USDG_ABI.getSighash('authorizationState')) return r(ethers.utils.defaultAbiCoder.encode(['bool'], [false]));
            const f = LECT.parseTransaction({ data }).name;
            const v = f === 'balanceOf' ? ethers.utils.parseEther('100000000') : f === 'allowance' ? ethers.constants.MaxUint256 : ethers.constants.Zero;
            return r(ethers.utils.defaultAbiCoder.encode(['uint256'], [v]));
          }
          case 'eth_estimateGas': return r('0x30000');
          case 'eth_sendRawTransaction': {
            const tx = ethers.utils.parseTransaction(p[0]);
            envoyees.push(tx);
            recus.set(tx.hash, { transactionHash: tx.hash, blockHash: '0x' + 'cd'.repeat(32), blockNumber: '0x' + bloc.toString(16), transactionIndex: '0x0',
              from: tx.from, to: tx.to, gasUsed: '0x' + (91234).toString(16), cumulativeGasUsed: '0x' + (91234).toString(16), effectiveGasPrice: '0x' + (28000000).toString(16),
              logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1', contractAddress: null, type: '0x0' });
            return r(tx.hash);
          }
          case 'eth_getTransactionReceipt': { const x = recus.get(p[0]); if (x) x.blockNumber = '0x' + (bloc - 2).toString(16); return r(x || null); }
          case 'eth_getTransactionByHash': return r(null);
          default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'faux noeud : ' + m.method } };
        }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(q) ? q.map(un) : un(q)));
    });
  });
  return { srv, envoyees };
}

/* ---- LE FAUX COINBASE : vérifie chaque jeton avec la clé publique de l'essai ---- */
function fauxCoinbase() {
  const S = { requetes: [], refus: 0, verify: null, settle: [], auths: [] };
  const jetonOk = (tok, attendu) => {
    try {
      const [h, c, sg] = String(tok).split('.');
      const en = JSON.parse(Buffer.from(h, 'base64url')), co = JSON.parse(Buffer.from(c, 'base64url'));
      const t = Math.floor(Date.now() / 1000);
      return en.alg === 'EdDSA' && en.kid === KID && en.typ === 'JWT' && /^[0-9a-f]{32}$/.test(en.nonce) && co.sub === KID && co.iss === 'cdp'
        && JSON.stringify(co.uris) === JSON.stringify([attendu]) && co.exp > t && co.exp - co.nbf === 120
        && crypto.verify(null, Buffer.from(h + '.' + c), paire.publicKey, Buffer.from(sg, 'base64url'));
    } catch (e) { return false; }
  };
  const srv = http.createServer((req, res) => {
    const bouts = [];
    req.on('data', (d) => bouts.push(d));
    req.on('end', () => {
      const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
      S.auths.push(String(req.headers.authorization || ''));
      if (!jetonOk(tok, req.method + ' ' + req.headers.host + req.url)) { S.refus++; res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Unauthorized\n'); }
      const op = req.url.split('/').pop();
      const corps = Buffer.concat(bouts).toString();
      S.requetes.push({ op, t: Date.now(), corps: corps ? JSON.parse(corps) : null });
      const envoie = (st, o) => { res.writeHead(st, { 'content-type': 'application/json', 'extension-responses': Buffer.from(JSON.stringify({ bazaar: { status: 'processing' } })).toString('base64') }); res.end(JSON.stringify(o)); };
      if (op === 'supported') return envoie(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: ['bazaar'], signers: {} });
      if (op === 'verify') return envoie(200, S.verify || { isValid: true, payer: PAYEUR.address });
      const r = S.settle.length ? S.settle.shift() : { st: 200, o: { success: true, payer: PAYEUR.address, transaction: '0x' + crypto.randomBytes(32).toString('hex'), network: 'eip155:8453', amount: '20000' } };
      return envoie(r.st, r.o);
    });
  });
  return { srv, S };
}

/* ---- LE FAUX RPC DE BASE (lecture : code, reçus, journaux) ---- */
function fauxRpcBase() {
  const R = { recus: {}, logs: [], appels: [] };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const m = JSON.parse(b), p = m.params || [];
      R.appels.push(m.method);
      const r = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
      if (m.method === 'eth_blockNumber') return r('0x1388');
      if (m.method === 'eth_getCode') return r('0x');
      if (m.method === 'eth_getTransactionReceipt') return r(R.recus[p[0]] || null);
      if (m.method === 'eth_getLogs') return r(R.logs.filter((l) => l.address.toLowerCase() === String(p[0].address).toLowerCase() && p[0].topics.every((t, i) => !t || String(l.topics[i]).toLowerCase() === String(t).toLowerCase())));
      return r(null);
    });
  });
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  R.paye = (h, from, nonce, to, montant) => {
    const logs = [{ address: X.USDC_BASE, topics: [X.TOPIC_AUTH_USED, pad(from), nonce], data: '0x', transactionHash: h },
      { address: X.USDC_BASE, topics: [X.TOPIC_TRANSFER, pad(from), pad(to)], data: ethers.utils.hexZeroPad(ethers.BigNumber.from(montant).toHexString(), 32), transactionHash: h }];
    R.recus[h] = { status: '0x1', transactionHash: h, logs };
    R.logs.push(...logs);
  };
  return { srv, R };
}

const BAC = fs.mkdtempSync('/tmp/x402-base-route-');
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002493'; process.env.ETH_PRIX_USD = '2688.57'; process.env.STUDIO_MARGE = '1.5';
delete process.env.AGENTIC_PRIX; delete process.env.PERPLEXITY_API_KEY; delete process.env.TG_APPELS_VENTE; delete process.env.X402_MCP; delete process.env.X402_BASE;
/* ask_agent vendu en x402 : seulement pour les refus d'entree et le 402 (aucun appel au modele ici). */
process.env.X402_AGENT = '1';
process.env.ANTHROPIC_API_KEY = 'essai-jamais-appele';
process.env.X402_BASE_ATTENTE_MS = '300';
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const noeud = fauxNoeud(), cb = fauxCoinbase(), rpc = fauxRpcBase();
  const [pn, pc, pr] = [await libre(), await libre(), await libre()];
  await new Promise((r) => noeud.srv.listen(pn, '127.0.0.1', r));
  await new Promise((r) => cb.srv.listen(pc, '127.0.0.1', r));
  await new Promise((r) => rpc.srv.listen(pr, '127.0.0.1', r));
  process.env.X402_RPC = 'http://127.0.0.1:' + pn;
  process.env.X402_PAYTO = TRESOR;
  process.env.X402_CLE = GAZ.privateKey;
  process.env.CDP_API_KEY_ID = KID;
  process.env.X402_PAYAI = '0';   /* le chemin Coinbase ; PayAI (second facilitateur) a ses cas dans x402.test.js */
  process.env.CDP_API_KEY_SECRET = SECRET;
  process.env.CDP_FACILITATOR_URL = 'http://127.0.0.1:' + pc + '/platform/v2/x402/';     /* barre finale : tolérée */
  process.env.X402_BASE_RPC = 'http://127.0.0.1:' + pr;
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
  require('./config');
  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
  require('./server');
  const base = 'http://127.0.0.1:' + port;
  const tout = [];     /* chaque corps et en-tête de réponse : on y cherchera secret et jetons */
  const lis = async (r) => { const t = await r.text(); tout.push(t, JSON.stringify([...r.headers])); return t; };
  const J = async (u, o) => { const r = await fetch(base + u, o); const t = await lis(r); let b = null; try { b = JSON.parse(t); } catch (e) { b = null; } return { status: r.status, b, h: r.headers }; };

  console.log('-- 1. la sonde /supported, depuis le rappel de listen --');
  for (let i = 0; i < 100 && !cb.S.requetes.some((q) => q.op === 'supported'); i++) await dort(20);
  const premiere = Date.now();
  const sup = cb.S.requetes.find((q) => q.op === 'supported');
  ok(sup && sup.t <= premiere && cb.S.refus === 0, 'GET /supported est parti au demarrage, AVANT la premiere requete de l essai, avec un jeton accepte (barre finale toleree)');
  let et = null;
  for (let i = 0; i < 100; i++) { et = (await J('/agentic/x402')).b; if (et && et.base && et.base.etat === 'on') break; await dort(30); }
  ok(et && et.base && et.base.etat === 'on' && et.base.actif === true && et.base.facilitateur === 'cdp' && et.base.payTo === TRESOR && et.base.network === 'eip155:8453',
     '/agentic/x402 : base.etat = on, la tresorerie en payTo de Base');
  ok(journal.some((l) => /^\[x402\] Base on - USDC on eip155:8453 to 0x[0-9a-fA-F]{40}, settled by the CDP facilitator$/.test(l)), 'le journal : « [x402] Base on - USDC on eip155:8453 to 0x…, settled by the CDP facilitator »');
  ok(journal.some((l) => /no ownership proof for 0x[0-9a-fA-F]{40} - confirm you control this address on Base/.test(l)), 'sans X402_PREUVE : l avertissement de preuve de propriete pour l adresse Base');

  console.log('\n-- 2. REST --');
  const appel = (outil, corps, en) => fetch(base + '/agentic/call/' + outil, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, en || {}), body: JSON.stringify(corps || {}) });
  const sonde = await appel('scan_token', {});
  await lis(sonde.clone());
  const q0 = de64(sonde.headers.get('payment-required'));
  ok(sonde.status === 402 && q0.accepts[0].network === 'eip155:8453' && q0.accepts[0].asset === X.USDC_BASE && q0.accepts[0].amount === '20000' && q0.accepts[0].payTo === TRESOR
     && q0.accepts.slice(1).map((a) => a.extra.assetTransferMethod).join() === 'eip3009,permit2', 'une sonde de scan_token : 402, Base d abord (20000 USDC), puis USDG et $SWOGE');
  ok(sonde.headers.get('payment-required').length < 8192, 'en-tete PAYMENT-REQUIRED : ' + sonde.headers.get('payment-required').length + ' caracteres, sous 8 192');
  const signeBase = async (req, o) => {
    o = o || {};
    const acc = req.accepts.find((a) => a.network === 'eip155:8453');
    const s = Math.floor(Date.now() / 1000);
    const auth = { from: PAYEUR.address, to: acc.payTo, value: acc.amount, validAfter: String(s - 600), validBefore: String(s + (o.duree || 100)), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
    const signature = await PAYEUR._signTypedData(Object.assign({ chainId: 8453, verifyingContract: X.USDC_BASE }, X.DOMAINE_USDC_BASE), X.TYPES_3009, auth);
    const objet = { x402Version: 2, resource: req.resource, accepted: acc, payload: { signature, authorization: auth }, extensions: req.extensions };
    return { objet, b64: X.b64(objet), auth };
  };
  const ADR = '0x' + 'ee'.repeat(20);
  const r1 = await appel('colony_activity', { arguments: {} });
  const q1 = de64(r1.headers.get('payment-required'));
  const s1 = await signeBase(q1);
  const p1 = await appel('colony_activity', { arguments: {} }, { 'payment-signature': s1.b64 });
  const b1 = JSON.parse(await lis(p1.clone()));
  const rep1 = de64(p1.headers.get('payment-response'));
  ok(p1.status === 200 && b1.ok && b1.resultat && rep1.success === true && rep1.network === 'eip155:8453' && rep1.payer === PAYEUR.address && b1.x402.network === 'eip155:8453',
     'un paiement Base en REST : 200, le resultat, PAYMENT-RESPONSE eip155:8453');
  const v1 = cb.S.requetes.filter((q) => q.op === 'verify').pop(), g1 = cb.S.requetes.filter((q) => q.op === 'settle').pop();
  ok(v1 && g1 && v1.corps.x402Version === 2 && v1.corps.paymentPayload.resource.url === base + '/agentic/call/colony_activity' && v1.corps.paymentPayload.extensions.bazaar
     && JSON.stringify(v1.corps.paymentRequirements) === JSON.stringify(g1.corps.paymentRequirements) && v1.corps.paymentRequirements.payTo === TRESOR,
     'Coinbase a recu verify puis settle : notre ressource REST, notre bloc bazaar, nos conditions (la tresorerie)');
  ok(noeud.envoyees.length === 0, 'rien envoye sur Robinhood Chain (le gaz de Base, c est Coinbase)');
  const et2 = (await J('/agentic/x402')).b;
  ok(et2.network === 'eip155:4663' && et2.payTo === TRESOR && et2.asset === SWOGE && JSON.stringify(et2.networks) === '["eip155:8453","eip155:4663"]'
     && et2.assets[0].symbol === 'USDC' && et2.assets[0].network === 'eip155:8453' && et2.assets.every((a) => a.network),
     '/agentic/x402 : network et payTo INCHANGES (la page les lit), networks = [Base, Robinhood], l USDC d abord, chaque actif dit son reseau');
  ok(et2.encaisse.USDC_BASE && et2.encaisse.USDC_BASE.paiements === 1 && et2.encaisse.USDC_BASE.montant === '0.02' && et2.encaisse.USDC_BASE.decimales === 6,
     'encaisse.USDC_BASE : 1 paiement, 0.02, 6 decimales (plus compte comme du $SWOGE a 18)');
  const sc = et2.outils.find((o) => o.name === 'scan_token');
  ok(sc && sc.usdBase === 0.02 && sc.amountBase === '20000' && sc.usd > 0 && et2.mesure.parReseau['eip155:8453'].payes === 1 && et2.base.bazaar.processing === 2,
     'les outils : usdBase et amountBase ; MESURE par reseau ; EXTENSION-RESPONSES compte (processing : verify + settle)');
  const oa = (await J('/openapi.json')).b;
  ok(oa.paths['/agentic/call/scan_token'].post['x-payment-info'].price.min === '0.020000' && /USDC on Base/.test(oa.info['x-guidance']), '/openapi.json : le prix Base en minimum, Base dans x-guidance');
  const lt = await (await fetch(base + '/llms.txt')).text();
  tout.push(lt);
  ok(/first option: USDC on Base/.test(lt) && /no gas on either network/.test(lt) && /ask_agent` at a flat price/.test(lt), '/llms.txt : Base d abord, personne ne paie de gaz, ask_agent a prix fixe');
  const dv = (await J('/agentic/call/scan_token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quote: true, arguments: { address: ADR } }) })).b;
  ok(dv.x402 && dv.x402.accepts[0].network === 'eip155:8453' && /USDC on Base first/.test(dv.howToPay) && /no gas on either network/.test(dv.howToPay), 'le devis sans cle : Base d abord, et la marche a suivre le dit');
  /* ask_agent (X402_AGENT=1) : prix fixe, 300 s, bornes AVANT tout 402. */
  const aa = await appel('ask_agent', {});
  await lis(aa.clone());
  const qa = aa.headers.get('payment-required') ? de64(aa.headers.get('payment-required')) : null;
  ok(aa.status === 402 && qa && qa.accepts[0].amount === '541000' && qa.accepts.every((a) => a.maxTimeoutSeconds === 300), 'ask_agent en x402 : 402, 541000 USDC sur Base (0,541 $), 300 s sur chaque option');
  const bzA = qa && qa.extensions.bazaar.schema.properties.input.properties.body.properties.arguments.properties;
  ok(bzA && JSON.stringify(bzA.model.enum) === '["sonnet-5"]' && bzA.task.maxLength === 2000, 'son bloc bazaar : sonnet-5 seul, 2 000 caracteres');
  const long = await appel('ask_agent', { arguments: { task: 'x'.repeat(2001) } });
  const autre = await appel('ask_agent', { arguments: { task: 'x', model: 'haiku-4-5' } });
  const bl = JSON.parse(await lis(long.clone())), ba = JSON.parse(await lis(autre.clone()));
  ok(long.status === 400 && !long.headers.get('payment-required') && /too long for x402/.test(bl.raison) && autre.status === 400 && !autre.headers.get('payment-required') && /model must be sonnet-5/.test(ba.raison),
     'tache > 2 000 caracteres ou autre modele : 400 AVANT toute demande de paiement');

  console.log('\n-- 3. MCP --');
  const mcp = async (corps, o) => {
    o = o || {};
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (o.moderne) Object.assign(h, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': corps.method }, corps.method === 'tools/call' ? { 'mcp-name': corps.params.name } : {});
    else h['mcp-protocol-version'] = '2025-11-25';
    Object.assign(h, o.entetes || {});
    if (o.moderne) corps.params = Object.assign({}, corps.params, { _meta: Object.assign({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }, (corps.params || {})._meta || {}) });
    const r = await fetch(base + '/mcp', { method: 'POST', headers: h, body: JSON.stringify(corps) });
    return JSON.parse(await lis(r));
  };
  const appelMcp = (nom, args, meta, o) => mcp({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: Object.assign({ name: nom, arguments: args }, meta ? { _meta: meta } : {}) }, o);
  let vuTexte = [];
  for (const moderne of [false, true]) {
    const ep = moderne ? 'moderne (2026-07-28)' : 'heritee (2025-11-25)';
    const o = { moderne };
    const d = await appelMcp('scan_token', { address: ADR }, null, o);
    const R = d.result || {};
    ok(R.isError === true && R.structuredContent && R.structuredContent.x402Version === 2 && Array.isArray(R.structuredContent.accepts) && R.content[0].text === JSON.stringify(R.structuredContent)
       && JSON.stringify(R._meta['x402/error']) === JSON.stringify(R.structuredContent) && R.structuredContent.accepts[0].network === 'eip155:8453' && R.structuredContent.resource.url === base + '/mcp',
       ep + ' : sans paiement, un resultat isError portant le PaymentRequired (structuredContent, content[0], _meta x402/error), Base d abord, ressource /mcp');
    ok(moderne ? R.resultType === 'complete' : R.resultType === undefined, ep + ' : resultType « complete » en epoque moderne seulement');
    for (const forme of ['objet', 'base64', 'en-tete']) {
      const sg = await signeBase(R.structuredContent);
      const rr = forme === 'objet' ? await appelMcp('scan_token', { address: ADR }, { 'x402/payment': sg.objet }, o)
        : forme === 'base64' ? await appelMcp('scan_token', { address: ADR }, { 'x402/payment': sg.b64 }, o)
          : await appelMcp('scan_token', { address: ADR }, null, Object.assign({ entetes: { 'payment-signature': sg.b64 } }, o));
      const x = rr.result || {};
      ok(x.isError === false && x._meta && x._meta['x402/payment-response'].success === true && x._meta['x402/payment-response'].network === 'eip155:8453' && x.structuredContent.x402.amount === '20000'
         && /paid \$0\.02 in USDC \(eip155:8453\)/.test(x.content[0].text), ep + ' : paye par ' + forme + ' — _meta["x402/payment-response"].success, le recu');
      if (forme === 'objet') {
        const re = await appelMcp('scan_token', { address: ADR }, { 'x402/payment': sg.objet }, o);
        ok(re.result.isError === true && re.result.structuredContent.accepts && /already presented/.test(re.result.structuredContent.error), ep + ' : le MEME paiement renvoye → une nouvelle demande de paiement, pas le resultat');
      }
    }
  }
  const v0 = cb.S.requetes.filter((q) => q.op === 'verify').length;
  const vMcp = cb.S.requetes.filter((q) => q.op === 'verify').pop();
  ok(vMcp.corps.paymentPayload.resource.url === base + '/mcp' && vMcp.corps.paymentPayload.extensions.bazaar.info.input.type === 'mcp' && vMcp.corps.paymentPayload.extensions.bazaar.info.input.toolName === 'scan_token',
     'Coinbase recoit l adresse /mcp et le bloc bazaar MCP (type mcp, toolName)');
  /* Un reglement rate : aucun texte d'outil nulle part. */
  {
    const d = await appelMcp('colony_activity', {}, null);
    const sg = await signeBase(d.result.structuredContent);
    cb.S.settle.push({ st: 400, o: { success: false, errorReason: 'invalid_payload', errorMessage: 'nonce used', transaction: '', network: 'eip155:8453', payer: PAYEUR.address } });
    const r = await appelMcp('colony_activity', {}, { 'x402/payment': sg.objet });
    const t = JSON.stringify(r);
    /* Le texte que l'outil rend quand il est paye (lu sur le paiement REST plus haut) : absent. */
    const marque = String(b1.texte || '').slice(0, 80);
    ok(marque.length > 40 && r.result.isError === true && /Settlement failed: invalid_payload/.test(r.result.structuredContent.error) && !t.includes(marque) && !t.includes(JSON.stringify(b1.resultat).slice(0, 80))
       && r.result._meta['x402/error'].accepts,
       'un reglement rate (400 invalid_payload) : la demande de paiement, AUCUN texte ni donnee de l outil');
  }
  /* En attente : aucun accepts, le hash dans _meta ; puis la chaine confirme. */
  {
    const d = await appelMcp('colony_activity', {}, null);
    const sg = await signeBase(d.result.structuredContent);
    const H = '0x' + 'a7'.repeat(32);
    cb.S.settle.push({ st: 500, o: { success: false, errorReason: 'settlement_pending', transaction: H, network: 'eip155:8453' } }, { st: 500, o: { success: false, errorReason: 'settlement_pending', transaction: H, network: 'eip155:8453' } });
    const nSettle = cb.S.requetes.filter((q) => q.op === 'settle').length;
    const r = await appelMcp('colony_activity', {}, { 'x402/payment': sg.objet });
    const t = JSON.stringify(r);
    ok(r.result.isError === true && !/accepts/.test(t) && !r.result.structuredContent && !r.result._meta['x402/error'] && r.result._meta['x402/payment-response'].transaction === H
       && r.result._meta['x402/payment-response'].errorReason === 'settlement_pending' && cb.S.requetes.filter((q) => q.op === 'settle').length === nSettle + 2,
       'en attente (500 settlement_pending, renvoye une fois) : AUCUN accepts nulle part, le hash dans _meta["x402/payment-response"]');
    rpc.R.paye(H, PAYEUR.address, sg.auth.nonce, TRESOR, sg.objet.accepted.amount);
    const r2 = await appelMcp('colony_activity', {}, { 'x402/payment': sg.objet });
    ok(r2.result.isError === false && r2.result._meta['x402/payment-response'].transaction === H && cb.S.requetes.filter((q) => q.op === 'settle').length === nSettle + 2,
       'le meme paiement represente apres confirmation sur la chaine : le resultat, sans nouveau settle');
  }
  /* Une cle valide : le solde est debite, x402 jamais touche. */
  {
    const w = ethers.Wallet.createRandom();
    const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    await new Promise((r) => s.on('open', r));
    const attend = (ty) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === ty).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + ty)); setTimeout(tour, 25); })(); });
    const h = await attend('hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    const auth = await attend('auth');
    moteur._p(w.address.toLowerCase()).balance = ethers.utils.parseUnits('200000', 18);
    const c = await J('/agentic/cles', { method: 'POST', headers: { authorization: 'Bearer ' + auth.session, 'content-type': 'application/json' }, body: JSON.stringify({ nom: 'mcp', plafondSwoge: 5000 }) });
    const avant = cb.S.requetes.length;
    const r = await appelMcp('colony_activity', {}, null, { entetes: { authorization: 'Bearer ' + c.b.cle } });
    ok(r.result.isError === false && r.result.structuredContent.billed && r.result.structuredContent.receipt && cb.S.requetes.length === avant && !r.result._meta,
       'avec une cle valide : le solde est debite (billed, receipt), x402 jamais utilise (Coinbase pas appele)');
    s.close();
    tout.push(c.b.cle);   /* (la cle apparait dans SA reponse, c'est voulu : on l'ecarte de la recherche des jetons CDP) */
    tout.pop();
  }
  /* tools/list : aucun outputSchema, l'indice de prix Base. */
  const tl = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
  ok(tl.result.tools.every((t) => !('outputSchema' in t)) && tl.result.tools.find((t) => t.name === 'scan_token')._meta['agents-x402/priceUSD'] === 0.02
     && !tl.result.tools.find((t) => t.name === 'generate_video')._meta, 'tools/list : aucun outputSchema ; l indice de prix Base sur les outils payables');
  const ini = await mcp({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  ok(/x402 over MCP \(_meta\["x402\/payment"\], USDC on Base first\)/.test(ini.result.instructions), 'les instructions MCP le disent');
  process.env.X402_MCP = '0';
  const off = await appelMcp('colony_activity', {}, null);
  ok(off.result.isError === true && off.result.content[0].text.includes('POST ' + base + '/agentic/call/colony_activity') && /Authorization: Bearer swg_/.test(off.result.content[0].text) && !off.result.structuredContent,
     'X402_MCP=0 : /mcp revient exactement au lot #28 (la marche a suivre, pas de demande x402)');
  delete process.env.X402_MCP;
  void v0; void vuTexte;

  console.log('\n-- 4. le secret CDP, les jetons, les en-tetes Authorization --');
  const cherche = tout.join('\n') + '\n' + journal.join('\n');
  const auths = [...new Set(cb.S.auths)].filter(Boolean);
  ok(auths.length > 5 && auths.every((a) => /^Bearer eyJ/.test(a)), 'le faux Coinbase a recu ' + auths.length + ' en-tetes Authorization distincts (un jeton neuf par requete)');
  ok(!cherche.includes(SECRET) && !cherche.includes(SECRET.slice(0, 24)) && !auths.some((a) => cherche.includes(a.slice(7))) && !/eyJ[A-Za-z0-9_-]{10,}\.eyJ/.test(cherche) && !cherche.includes(GAZ.privateKey.slice(2)),
     'ni le secret CDP, ni un jeton (eyJ…), ni une valeur Authorization, ni la cle du gaz, dans AUCUNE reponse (' + tout.length + ' corps et en-tetes) ni dans le journal du serveur (' + journal.length + ' lignes)');

  noeud.srv.close(); cb.srv.close(); rpc.srv.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
