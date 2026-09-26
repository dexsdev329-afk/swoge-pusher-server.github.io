'use strict';
/*
 * x402 DE BOUT EN BOUT, SUR LE VRAI SERVEUR — un agent sans clé ni compte
 * paie un outil en signant, le serveur règle sur une FAUSSE chaîne (un nœud
 * JSON-RPC local qui décode ce qu'on lui envoie avec l'ABI du proxy) :
 *   - éteint sans X402_PAYTO + X402_CLE : sans clé, c'est 401 comme avant ;
 *   - allumé : 402 + PAYMENT-REQUIRED, entrée invalide refusée AVANT le 402,
 *     outil à prix variable jamais en x402 ;
 *   - payé : la transaction envoyée par le portefeuille de GAZ appelle
 *     settle(owner = le payeur, witness.to = la trésorerie, montant = le devis),
 *     et le résultat revient avec PAYMENT-RESPONSE ;
 *   - la clé du portefeuille de gaz n'apparaît dans AUCUNE réponse.
 */
const net = require('net');
const http = require('http');
const fs = require('fs');
const { ethers } = require('ethers');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const de64 = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

const SWOGE = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817';
const GAZ = ethers.Wallet.createRandom();
const TRESOR = ethers.Wallet.createRandom().address;
const X = require('./x402');
const PROXY_ABI = new ethers.utils.Interface([
  'function settle(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)',
  'function settleWithPermit((uint256 value,uint256 deadline,bytes32 r,bytes32 s,uint8 v) permit2612,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)']);
const LECT = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function nonces(address) view returns (uint256)', 'function nonceBitmap(address,uint256) view returns (uint256)']);

/* Le faux nœud : Robinhood Chain (4663), gaz à 0,028 gwei, et le relevé des transactions reçues. */
function fauxNoeud() {
  const envoyees = [], appels = [];
  let bloc = 1000;
  const recus = new Map();
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
          case 'eth_getBalance': return r(ethers.utils.parseEther('0.001').toHexString());
          case 'eth_getTransactionCount': return r('0x' + envoyees.length.toString(16));
          case 'eth_getBlockByNumber': return r({ number: '0x' + bloc.toString(16), hash: '0x' + 'ab'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
            gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [], difficulty: '0x0', nonce: '0x0000000000000000' });
          case 'eth_call': {
            const to = String(p[0].to).toLowerCase(), data = p[0].data, sel = data.slice(0, 10);
            appels.push({ to, sel });
            if (to === X.PROXY.toLowerCase()) { PROXY_ABI.parseTransaction({ data }); return r('0x'); }   /* la simulation passe si l'ABI se décode */
            const f = LECT.parseTransaction({ data }).name;
            const v = f === 'balanceOf' ? ethers.utils.parseEther('100000000') : f === 'allowance' ? ethers.constants.MaxUint256 : ethers.constants.Zero;
            return r(ethers.utils.defaultAbiCoder.encode(['uint256'], [v]));
          }
          case 'eth_estimateGas': return r('0x30000');
          case 'eth_sendRawTransaction': {
            const tx = ethers.utils.parseTransaction(p[0]);
            envoyees.push(Object.assign({ decode: PROXY_ABI.parseTransaction({ data: tx.data }) }, tx));
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
  return { srv, envoyees, appels };
}

const BAC = fs.mkdtempSync('/tmp/x402-route-');
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002493'; process.env.ETH_PRIX_USD = '2688.57'; process.env.STUDIO_MARGE = '1.5';
delete process.env.AGENTIC_PRIX; delete process.env.PERPLEXITY_API_KEY;
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const noeud = fauxNoeud();
  const pn = await libre();
  await new Promise((r) => noeud.srv.listen(pn, '127.0.0.1', r));
  process.env.X402_RPC = 'http://127.0.0.1:' + pn;
  process.env.X402_PAYTO = TRESOR;
  process.env.X402_CLE = GAZ.privateKey;
  const port = await libre();
  process.env.PORT = String(port);
  require('./config');
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const base = 'http://127.0.0.1:' + port;
  const appel = (outil, corps, en) => fetch(base + '/agentic/call/' + outil, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, en || {}), body: JSON.stringify(corps || {}) });
  const tout = [];     /* chaque corps de réponse, pour vérifier que la clé n'y est jamais */
  const lis = async (r) => { const t = await r.text(); tout.push(t, JSON.stringify([...r.headers])); return t; };

  console.log('-- 1. l etat public --');
  const cat = JSON.parse(await lis(await fetch(base + '/agentic/tools')));
  ok(cat.x402 && cat.x402.actif && cat.x402.network === 'eip155:4663' && cat.x402.payTo === TRESOR && cat.x402.asset === SWOGE, 'le catalogue annonce x402 : reseau, tresorerie, le vrai $SWOGE');
  const et = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  ok(et.porteGaz === GAZ.address && et.soldeGazEth === 0.001, 'l etat montre l ADRESSE du portefeuille de gaz et son solde (' + et.soldeGazEth + ' ETH)');
  const col = (et.outils || []).find((o) => o.name === 'colony_activity');
  ok(col && Math.abs(col.usd - Math.max(0.02, 0.005 + col.gazUsd)) < 1e-6 && col.usd >= 0.02 && !et.outils.some((o) => o.name === 'ask_agent' || o.name === 'generate_image'),
     'les prix x402 du moment : colony_activity = max(0,02 $ ; 0,005 $ + gaz ' + (col && col.gazUsd) + ' $) = ' + (col && col.usd) + ' $ ; aucun outil a prix variable');
  const eco = (et.outils || []).find((o) => o.name === 'swoge_economy');
  eq(eco && eco.usd, 0.02, 'swoge_economy (0,001 $ + gaz) : le minimum de 0,02 $');
  const lt = await lis(await fetch(base + '/llms.txt'));
  ok(/x402/.test(lt) && /PAYMENT-SIGNATURE/.test(lt), '/llms.txt dit aux agents qu ils peuvent payer sans compte');

  console.log('\n-- 2. le 402 --');
  const r1 = await appel('colony_activity', { arguments: {} });
  await lis(r1.clone());
  eq(r1.status, 402, 'sans cle ni paiement : 402 (et non plus 401)');
  const exi = de64(r1.headers.get('payment-required'));
  ok(exi.accepts[0].payTo === TRESOR && exi.accepts[0].network === 'eip155:4663' && /\/agentic\/call\/colony_activity$/.test(exi.resource.url),
     'PAYMENT-REQUIRED : la tresorerie, le reseau, la ressource');
  ok(/payment-required/.test(r1.headers.get('access-control-expose-headers') || ''), 'l en-tete est expose aux navigateurs (CORS)');
  const bad = await appel('scan_token', { arguments: { address: 'nope' } });
  ok(bad.status === 400 && !bad.headers.get('payment-required'), 'une entree invalide : 400 AVANT tout 402 — on ne fait pas signer pour une erreur');
  eq((await appel('ask_agent', { arguments: { task: 'x' } })).status, 401, 'un outil a prix variable reste reserve aux cles');

  console.log('\n-- 3. un agent paie --');
  const payeur = ethers.Wallet.createRandom();
  const acc = exi.accepts[0];
  const s = Math.floor(Date.now() / 1000);
  const auth = { from: payeur.address, permitted: { token: acc.asset, amount: acc.amount }, spender: X.PROXY, nonce: '424242',
    deadline: String(s + 110), witness: { to: acc.payTo, validAfter: String(s - 600) } };
  const signature = await payeur._signTypedData(X.domainePermit2(), X.TYPES_PERMIT2, { permitted: auth.permitted, spender: auth.spender, nonce: auth.nonce, deadline: auth.deadline, witness: auth.witness });
  const entete = X.b64({ x402Version: 2, resource: exi.resource, accepted: acc, payload: { signature, permit2Authorization: auth } });
  const r2 = await appel('colony_activity', { arguments: {} }, { 'payment-signature': entete });
  const c2 = JSON.parse(await lis(r2.clone()));
  eq(r2.status, 200, 'paye : 200');
  ok(c2.ok && c2.resultat && c2.x402 && c2.x402.amount === acc.amount, 'le resultat de la colonie, et le montant paye');
  const pr = de64(r2.headers.get('payment-response'));
  ok(pr.success && pr.payer === payeur.address && pr.transaction === noeud.envoyees[0].hash, 'PAYMENT-RESPONSE : la transaction reellement envoyee');
  eq(noeud.envoyees.length, 1, 'une transaction envoyee');
  const tx = noeud.envoyees[0], d = tx.decode;
  ok(tx.from === GAZ.address && tx.to === X.PROXY && tx.chainId === 4663, 'envoyee PAR le portefeuille de gaz, AU proxy canonique, sur la chaine 4663');
  ok(d.name === 'settle' && d.args.owner === payeur.address && d.args.witness.to === TRESOR && d.args.permit.permitted.amount.toString() === acc.amount
     && d.args.permit.permitted.token === SWOGE && d.args.signature === signature, 'settle decode : owner = le payeur, to = la tresorerie, le montant du devis, sa signature');
  ok(noeud.appels.some((x) => x.to === X.PROXY.toLowerCase()), 'le reglement a ete simule (eth_call au proxy) avant d etre envoye');
  const rej = await appel('colony_activity', { arguments: {} }, { 'payment-signature': entete });
  ok(rej.status === 402 && noeud.envoyees.length === 1, 'la meme signature rejouee : 402, aucune seconde transaction');
  const jr = fs.readFileSync(BAC + '/x402.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  ok(jr.length === 1 && jr[0].payer === payeur.address && jr[0].gasUsed === '91234', 'le journal DATA_DIR/x402.jsonl note le paiement et le gaz reel');
  const et2 = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  ok(et2.mesure.payes === 1 && et2.mesure.gasUsedMedian === 91234, 'la mesure du gaz reel est publique (' + et2.mesure.gasUsedMedian + ' contre ' + et2.mesure.gazUnitesEstimees + ' estimes)');

  console.log('\n-- 4. la cle du portefeuille de gaz --');
  const k = GAZ.privateKey.slice(2).toLowerCase();
  ok(!tout.some((t) => t.toLowerCase().includes(k)), 'la cle privee n apparait dans AUCUNE reponse (' + tout.length + ' corps et en-tetes lus)');

  noeud.srv.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
