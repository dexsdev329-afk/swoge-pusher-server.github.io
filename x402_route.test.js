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
 *   - la clé du portefeuille de gaz n'apparaît dans AUCUNE réponse ;
 *   - telegram_calls n'est ni annoncé (manifeste, prix, openapi) ni payable
 *     sans TG_APPELS_VENTE=1 : l'appeler répond comme un outil inconnu ;
 *   - (26 septembre 2026) le devis SANS clé porte les mêmes exigences que le
 *     402 et se paie tel quel ; MCP sans clé dit où payer en x402 ;
 *   - les compteurs durables : 402 émis, payés (maison / extérieur), échecs,
 *     le coût réel du gaz — et ils survivent au redémarrage du serveur ;
 *   - l'alerte du gaz : combien de règlements le portefeuille paie encore,
 *     estimé puis mesuré, et un avertissement sous 200.
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
const TRESOR_W = ethers.Wallet.createRandom();
/* Un portefeuille « de la maison » (COMPTEURS_MAISON) : ses paiements se comptent a part. */
const MAISON_W = ethers.Wallet.createRandom();
/* Les avertissements du serveur (l'alerte du gaz passe par console.warn). */
const avertis = [];
const warn0 = console.warn;
console.warn = (...a) => { avertis.push(a.map(String).join(' ')); warn0.apply(console, a); };
const TRESOR = TRESOR_W.address;
const X = require('./x402');
const PROXY_ABI = new ethers.utils.Interface([
  'function settle(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)',
  'function settleWithPermit((uint256 value,uint256 deadline,bytes32 r,bytes32 s,uint8 v) permit2612,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)']);
const USDG_ABI = new ethers.utils.Interface(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address,bytes32) view returns (bool)']);
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
            if (to === X.USDG.toLowerCase() && sel === USDG_ABI.getSighash('transferWithAuthorization')) { USDG_ABI.parseTransaction({ data }); return r('0x'); }
            if (to === X.USDG.toLowerCase() && sel === USDG_ABI.getSighash('authorizationState')) return r(ethers.utils.defaultAbiCoder.encode(['bool'], [false]));
            const f = LECT.parseTransaction({ data }).name;
            const v = f === 'balanceOf' ? ethers.utils.parseEther('100000000') : f === 'allowance' ? ethers.constants.MaxUint256 : ethers.constants.Zero;
            return r(ethers.utils.defaultAbiCoder.encode(['uint256'], [v]));
          }
          case 'eth_estimateGas': return r('0x30000');
          case 'eth_sendRawTransaction': {
            const tx = ethers.utils.parseTransaction(p[0]);
            envoyees.push(Object.assign({ decode: (tx.to.toLowerCase() === X.USDG.toLowerCase() ? USDG_ABI : PROXY_ABI).parseTransaction({ data: tx.data }) }, tx));
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
delete process.env.TG_APPELS_VENTE;   /* le defaut : telegram_calls pas vendu (section 3 quinquies) */
process.env.COMPTEURS_MAISON = MAISON_W.address;
delete process.env.X402_GAZ_ALERTE;
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
  /* L'adresse publique du serveur, et la preuve de propriete que le proprietaire
     signerait avec sa tresorerie (plus une fausse, qui doit etre ecartee). */
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
  const PREUVE = await TRESOR_W.signMessage('http://127.0.0.1:' + port);
  process.env.X402_PREUVE = PREUVE + ',' + (await ethers.Wallet.createRandom().signMessage('http://127.0.0.1:' + port));
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
  /* Le Telegram du proprietaire, branche le temps de cette lecture : l'alerte du gaz doit y partir UNE fois. */
  const TG = require.cache[tg].exports, envoyes = [];
  TG.enabled = () => true; TG.notify = (t) => envoyes.push(t);
  const et = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  const et1b = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  TG.enabled = () => false; TG.notify = () => {};
  ok(envoyes.length === 1 && /x402 gas alert/.test(envoyes[0]) && /178 settlements/.test(envoyes[0]) && et1b.gaz.alerte === true,
     'une notification Telegram, pas deux : le solde n est relu qu au plus toutes les 10 min');
  ok(JSON.parse(fs.readFileSync(BAC + '/x402_alerte_gaz.json', 'utf8')).paiementsRestants === 178, 'l heure de la derniere notification est gardee sur le disque (une par 24 h, redemarrage compris)');
  ok(et.porteGaz === GAZ.address && et.soldeGazEth === 0.001, 'l etat montre l ADRESSE du portefeuille de gaz et son solde (' + et.soldeGazEth + ' ETH)');
  /* 0,001 ETH / (200 000 gaz × 0,028 gwei) = 178,6 : sous le seuil de 200. */
  ok(et.gaz && et.gaz.source === 'estimated' && et.gaz.gazParPaiement === 200000 && et.gaz.mesures === 0 && et.gaz.soldeEth === 0.001 && et.gaz.prixGazGwei === 0.028
     && et.gaz.paiementsRestants === 178 && et.gaz.alerte === true && et.gaz.seuil === 200,
     'le gaz, sans aucune mesure : 200 000 gaz estimes par reglement → ' + (et.gaz && et.gaz.paiementsRestants) + ' reglements, sous 200 : alerte');
  ok(avertis.some((l) => /^\[x402\] gas wallet .*about 178 settlements \(200000 gas each, estimated\)/.test(l)), 'et un avertissement dans le journal du serveur');
  const col = (et.outils || []).find((o) => o.name === 'colony_activity');
  ok(col && Math.abs(col.usd - Math.max(0.02, 0.005 + col.gazUsd)) < 1e-6 && col.usd >= 0.02 && !et.outils.some((o) => ['ask_agent', 'generate_video', 'video_status'].includes(o.name)),
     'les prix x402 du moment : colony_activity = max(0,02 $ ; 0,005 $ + gaz ' + (col && col.gazUsd) + ' $) = ' + (col && col.usd) + ' $ ; ni agent, ni video (prix inconnu d avance)');
  const img = et.outils.find((o) => o.name === 'generate_image');
  ok(img && Math.abs(img.usd - (0.18 + img.gazUsd)) < 2e-6, 'une image Grok Quality : prix FIXE = le pire cas (0,18 $) + gaz = ' + (img && img.usd) + ' $');
  const eco = (et.outils || []).find((o) => o.name === 'swoge_economy');
  eq(eco && eco.usd, 0.02, 'swoge_economy (0,001 $ + gaz) : le minimum de 0,02 $');
  const lt = await lis(await fetch(base + '/llms.txt'));
  ok(/x402/.test(lt) && /PAYMENT-SIGNATURE/.test(lt), '/llms.txt dit aux agents qu ils peuvent payer sans compte');

  console.log('\n-- 2. le 402 --');
  const r1 = await appel('colony_activity', { arguments: {} });
  await lis(r1.clone());
  eq(r1.status, 402, 'sans cle ni paiement : 402 (et non plus 401)');
  const exi = de64(r1.headers.get('payment-required'));
  ok(exi.accepts.map((a) => a.extra.assetTransferMethod).join() === 'eip3009,permit2' && exi.accepts[0].asset === X.USDG, 'deux facons de payer : USDG (eip3009) d abord, puis $SWOGE (permit2)');
  ok(exi.accepts[0].payTo === TRESOR && exi.accepts[0].network === 'eip155:4663' && /\/agentic\/call\/colony_activity$/.test(exi.resource.url),
     'PAYMENT-REQUIRED : la tresorerie, le reseau, la ressource');
  ok(/payment-required/.test(r1.headers.get('access-control-expose-headers') || ''), 'l en-tete est expose aux navigateurs (CORS)');
  const bad = await appel('scan_token', { arguments: { address: 'nope' } });
  ok(bad.status === 400 && !bad.headers.get('payment-required'), 'une entree invalide : 400 AVANT tout 402 — on ne fait pas signer pour une erreur');
  const aa = await appel('ask_agent', { arguments: { task: 'x' } });
  const caa = JSON.parse(await lis(aa.clone()));
  ok(aa.status === 401 && /needs an API key/.test(caa.raison), 'un outil a prix variable reste reserve aux cles, et la reponse le dit');

  console.log('\n-- 2 bis. le devis sans cle, x402 allume --');
  const devisAvant = JSON.parse(await lis(await fetch(base + '/agentic/x402'))).mesure.devis;
  const q1 = await appel('colony_activity', { quote: true });
  const cq = JSON.parse(await lis(q1.clone()));
  ok(q1.status === 200 && cq.quote === true && cq.tool === 'colony_activity' && cq.priceUsd === 0.005 && cq.x402 && cq.x402.x402Version === 2
     && cq.x402.accepts.map((a) => a.extra.assetTransferMethod).join() === 'eip3009,permit2', 'devis sans cle : 200, le prix par cle (0,005 $) ET les exigences x402');
  ok(cq.x402.accepts[0].payTo === TRESOR && cq.x402.accepts[0].amount === exi.accepts[0].amount && cq.x402.accepts[1].amount === exi.accepts[1].amount,
     'les MEMES exigences que le 402 de cet appel (tresorerie, montants USDG et $SWOGE)');
  ok(!q1.headers.get('payment-required') && JSON.parse(await lis(await fetch(base + '/agentic/x402'))).mesure.devis === devisAvant, 'un devis n est pas un 402 : ni en-tete a signer, ni compte comme 402 emis');
  ok(cq.howToPay.includes('POST ' + base + '/agentic/call/colony_activity') && /PAYMENT-SIGNATURE/.test(cq.howToPay) && /Authorization: Bearer swg_/.test(cq.howToPay),
     'howToPay : une cle, ou x402 sur cette meme adresse');
  const mcp = (corps) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(corps) });
  const mc = JSON.parse(await lis(await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'colony_activity', arguments: {} } })));
  ok(mc.result && mc.result.isError === true && mc.result.content[0].text.includes('POST ' + base + '/agentic/call/colony_activity') && /Authorization: Bearer swg_/.test(mc.result.content[0].text),
     'MCP sans cle : isError, et la marche a suivre exacte — une cle, ou x402 en REST a l adresse de l outil');
  const mq = JSON.parse(await lis(await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scan_token', arguments: { quote: true } } })));
  ok(mq.result && mq.result.isError === false && mq.result.structuredContent.x402.accepts.length === 2 && /Without an account \(x402\): USDG /.test(mq.result.content[0].text),
     'MCP sans cle, devis : le prix x402 dans le texte et les exigences dans structuredContent');

  console.log('\n-- 3. un agent paie --');
  const payeur = ethers.Wallet.createRandom();
  const acc = exi.accepts.find((a) => a.extra.assetTransferMethod === 'permit2');
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
  ok(!tx.type && !tx.maxFeePerGas && tx.gasPrice && tx.gasPrice.eq(28000000 * 12 / 10), 'au prix du gaz LU +20 % (0,0336 gwei), en transaction classique — pas les 1,5 gwei de pourboire par defaut d ethers');
  ok(d.name === 'settle' && d.args.owner === payeur.address && d.args.witness.to === TRESOR && d.args.permit.permitted.amount.toString() === acc.amount
     && d.args.permit.permitted.token === SWOGE && d.args.signature === signature, 'settle decode : owner = le payeur, to = la tresorerie, le montant du devis, sa signature');
  ok(noeud.appels.some((x) => x.to === X.PROXY.toLowerCase()), 'le reglement a ete simule (eth_call au proxy) avant d etre envoye');
  const rej = await appel('colony_activity', { arguments: {} }, { 'payment-signature': entete });
  ok(rej.status === 402 && noeud.envoyees.length === 1, 'la meme signature rejouee : 402, aucune seconde transaction');
  const jr = fs.readFileSync(BAC + '/x402.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  ok(jr.length === 1 && jr[0].payer === payeur.address && jr[0].gasUsed === '91234', 'le journal DATA_DIR/x402.jsonl note le paiement et le gaz reel');
  const et2 = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  ok(et2.mesure.payes === 1 && et2.mesure.gasUsedMedian === 91234, 'la mesure du gaz reel est publique (' + et2.mesure.gasUsedMedian + ' contre ' + et2.mesure.gazUnitesEstimees + ' estimes)');

  console.log('\n-- 3 bis. un agent paie en USDG --');
  const r3 = await appel('new_launches', { arguments: { limit: 3 } });
  const exi3 = de64(r3.headers.get('payment-required'));
  const au = exi3.accepts.find((a) => a.extra.assetTransferMethod === 'eip3009');
  const s3 = Math.floor(Date.now() / 1000);
  const m3 = { from: payeur.address, to: au.payTo, value: au.amount, validAfter: String(s3 - 600), validBefore: String(s3 + 110), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
  const sig3 = await payeur._signTypedData(Object.assign({ chainId: 4663, verifyingContract: au.asset }, X.DOMAINE_USDG), X.TYPES_3009, m3);
  const e3 = X.b64({ x402Version: 2, resource: exi3.resource, accepted: au, payload: { signature: sig3, authorization: m3 } });
  const p3 = await appel('new_launches', { arguments: { limit: 3 } }, { 'payment-signature': e3 });
  const c3 = JSON.parse(await lis(p3.clone()));
  ok(p3.status === 200 && c3.x402.asset === X.USDG && Array.isArray(c3.resultat.fresh), 'paye en USDG : 200, les lancements, le recu dit USDG');
  ok(c3.resultat.attribution && c3.resultat.attribution.security === 'Powered by Go+ Security' && c3.resultat.attribution.url === 'https://gopluslabs.io'
     && /Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(c3.texte), 'new_launches paye en x402 : ses verdicts GoPlus portent « Powered by Go+ Security », en donnees et en texte');
  const t3 = noeud.envoyees[1], sp3 = ethers.utils.splitSignature(sig3);
  ok(t3 && t3.from === GAZ.address && t3.to === X.USDG && t3.decode.name === 'transferWithAuthorization' && t3.decode.args.from === payeur.address
     && t3.decode.args.to === TRESOR && t3.decode.args.value.toString() === au.amount && t3.decode.args.nonce === m3.nonce && t3.decode.args.v === sp3.v && t3.decode.args.r === sp3.r,
     'envoyee au contrat USDG : transferWithAuthorization(le payeur → la tresorerie, le montant du devis, v, r, s)');
  const et3 = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  ok(et3.encaisse.USDG && et3.encaisse.USDG.paiements === 1 && et3.encaisse.USDG.montant === ethers.utils.formatUnits(au.amount, 6)
     && et3.encaisse.SWOGE.paiements === 1, 'l etat public dit ce qui a ete encaisse, par jeton (USDG ' + (et3.encaisse.USDG && et3.encaisse.USDG.montant) + ' $) — la base d un rachat de $SWOGE');
  ok(et3.gazParMethode.transferWithAuthorization && et3.gazParMethode.settle, 'le gaz reel, par methode');
  ok(et3.outils.every((o) => /^[0-9]+$/.test(o.amountUsdg)) && et3.assets.map((a) => a.symbol).join() === 'USDG,SWOGE', 'chaque outil a son prix en USDG ; les deux jetons sont annonces');

  console.log('\n-- 3 ter. une image payee d avance --');
  const i1 = await appel('generate_image', { arguments: { prompt: 'a cat', count: 1 } });
  const i4 = await appel('generate_image', { arguments: { prompt: 'a cat', count: 4 } });
  const a1 = de64(i1.headers.get('payment-required')).accepts[0], a4 = de64(i4.headers.get('payment-required')).accepts[0];
  ok(i1.status === 402 && Number(a4.amount) > 3 * Number(a1.amount), 'le 402 d une image depend de la demande : 1 image ' + a1.amount + ', 4 images ' + a4.amount + ' (USDG)');
  const i3 = await appel('generate_image', { arguments: { prompt: 'a cat', count: 3 } });
  ok(i3.status === 400 && !i3.headers.get('payment-required'), 'une demande invalide (3 images) : 400 avant tout 402');
  const s4 = Math.floor(Date.now() / 1000);
  const m4 = { from: payeur.address, to: a1.payTo, value: a1.amount, validAfter: String(s4 - 600), validBefore: String(s4 + 110), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
  const sig4 = await payeur._signTypedData(Object.assign({ chainId: 4663, verifyingContract: a1.asset }, X.DOMAINE_USDG), X.TYPES_3009, m4);
  const e4 = X.b64({ x402Version: 2, resource: {}, accepted: a1, payload: { signature: sig4, authorization: m4 } });
  const envAvant = noeud.envoyees.length;
  const tri = await appel('generate_image', { arguments: { prompt: 'a cat', count: 4 } }, { 'payment-signature': e4 });
  ok(tri.status === 402 && noeud.envoyees.length === envAvant, 'payer le devis d UNE image en demandant QUATRE : refuse, aucune transaction');
  const off = await appel('generate_image', { arguments: { prompt: 'a cat', count: 1 } }, { 'payment-signature': e4 });
  const co = JSON.parse(await lis(off.clone()));
  ok(off.status === 502 && /not switched on/.test(co.raison) && /nothing was charged/.test(co.raison) && noeud.envoyees.length === envAvant,
     'le bon paiement, mais le fournisseur d images eteint : 502, la signature n est JAMAIS soumise');

  console.log('\n-- 3 quater. se faire trouver --');
  const oa = JSON.parse(await lis(await fetch(base + '/openapi.json')));
  ok(oa.openapi === '3.1.0' && oa.servers[0].url === base && oa.paths['/agentic/call/scan_token'].post['x-payment-info'], '/openapi.json en direct : les outils, et x-payment-info sur les payables');
  eq(JSON.stringify(oa['x-discovery']), JSON.stringify({ ownershipProofs: [PREUVE] }), 'la preuve de propriete VERIFIEE est publiee ; la fausse est ecartee');
  const wk = await fetch(base + '/.well-known/x402');
  const wkb = JSON.parse(await lis(wk.clone()));
  ok(wk.status === 200 && wk.headers.get('access-control-allow-origin') === '*' && wkb.version === 1 && wkb.resources.includes(base + '/agentic/call/scan_token') && wkb.ownershipProofs[0] === PREUVE,
     '/.well-known/x402 : les ressources payables et la preuve, lisibles de partout (CORS)');
  const sonde = await appel('scan_token', {});
  ok(sonde.status === 402 && sonde.headers.get('payment-required'), 'une SONDE sans arguments atteint le 402 avant la validation (exige par la spec de decouverte)');
  /* L'extension bazaar du 402 (audit AgentCash du 26 septembre 2026 : 16 erreurs
     « Input/Output schema is missing », toutes a extensions.bazaar) : branchee
     dans server.js, exemple d'entree fixe et valide meme pour une sonde. */
  const hSonde = sonde.headers.get('payment-required') || '';
  const bzS = (de64(hSonde).extensions || {}).bazaar;
  ok(bzS && bzS.schema.properties.input.properties.body.properties.arguments.properties.address && bzS.schema.properties.output.properties.example.properties.resultat.properties.token
     && /^0x[0-9a-fA-F]{40}$/.test(((bzS.info.input.body || {}).arguments || {}).address || ''),
     'le 402 d une sonde porte extensions.bazaar : schemas d entree et de sortie, et un exemple d entree VALIDE (une adresse, pas {})');
  /* Mesure du 26 septembre 2026 (essai local) : 6 481 caracteres pour scan_token,
     2 241 sans l'extension. 8 Ko : ce que bien des mandataires acceptent par en-tete. */
  ok(hSonde.length > 2241 && hSonde.length < 8192, 'en-tete PAYMENT-REQUIRED de scan_token avec bazaar : ' + hSonde.length + ' caracteres, sous 8 Ko');
  const ACHETEUR = '0x' + 'ee'.repeat(20);
  const vraie = await appel('scan_token', { arguments: { address: ACHETEUR } });
  const corpsVraie = await lis(vraie.clone());
  ok(vraie.status === 402 && (de64(vraie.headers.get('payment-required')).extensions || {}).bazaar
     && !Buffer.from(vraie.headers.get('payment-required'), 'base64').toString('utf8').toLowerCase().includes(ACHETEUR.slice(2)) && !corpsVraie.toLowerCase().includes(ACHETEUR.slice(2)),
     'le 402 d une vraie demande : l adresse de l acheteur ne voyage ni dans l en-tete ni dans le corps (un facilitateur peut publier info)');
  eq((await appel('scan_token', { arguments: { address: 'nope' } })).status, 400, 'une vraie demande aux arguments invalides : toujours 400 avant tout 402');
  const sj = JSON.parse(await lis(await fetch(base + '/server.json')));
  ok(sj.remotes[0].url === base + '/mcp' && sj.description.length <= 100, '/server.json : la fiche du registre MCP, prete a publier');

  console.log('\n-- 3 quinquies. telegram_calls : ni annonce ni payable sans TG_APPELS_VENTE=1 (conditions de Telegram) --');
  {
    const res = (w) => (w.resources || []).some((u) => /telegram_calls/.test(u));
    const wk0 = JSON.parse(await lis(await fetch(base + '/.well-known/x402')));
    const et0 = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
    const oa0 = JSON.parse(await lis(await fetch(base + '/openapi.json')));
    ok(!res(wk0) && !et0.outils.some((o) => o.name === 'telegram_calls') && !oa0.paths['/agentic/call/telegram_calls'],
       'eteint : absent de /.well-known/x402, des prix x402 du moment et de /openapi.json');
    const tg0 = await appel('telegram_calls', {}), in0 = await appel('nope_tool', {});
    const b0 = JSON.parse(await lis(tg0.clone())), bi = JSON.parse(await lis(in0.clone()));
    /* Depuis le 26 septembre 2026, un nom inconnu rend 404 « unknown tool: <nom> » avant toute
       question de cle : l'intention tient — l'outil eteint repond comme un nom invente (au nom
       envoye pres), et jamais par un 402 a signer. */
    ok(tg0.status === 404 && in0.status === 404 && !tg0.headers.get('payment-required') && b0.raison === 'unknown tool: telegram_calls' && bi.raison === 'unknown tool: nope_tool'
       && JSON.stringify(Object.keys(b0)) === JSON.stringify(Object.keys(bi)),
       'eteint : une sonde sans cle recoit la reponse d un outil inconnu [' + tg0.status + '], jamais un 402 a signer');
    process.env.TG_APPELS_VENTE = '1';
    const wk1 = JSON.parse(await lis(await fetch(base + '/.well-known/x402')));
    const et1 = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
    const p1 = et1.outils.find((o) => o.name === 'telegram_calls');
    ok(res(wk1) && p1 && Math.abs(p1.usd - Math.max(0.02, 0.01 + p1.gazUsd)) < 1e-6, 'TG_APPELS_VENTE=1 : annonce, au prix de l outil + gaz (' + (p1 && p1.usd) + ' $)');
    const tg1 = await appel('telegram_calls', {});
    ok(tg1.status === 402 && tg1.headers.get('payment-required'), 'TG_APPELS_VENTE=1 : une sonde atteint le 402');
    delete process.env.TG_APPELS_VENTE;
  }

  console.log('\n-- 3 sexies. la maison paie, avec les exigences d un DEVIS --');
  const qm = JSON.parse(await lis(await appel('colony_activity', { quote: true })));
  const am = qm.x402.accepts.find((a) => a.extra.assetTransferMethod === 'eip3009');
  const s6 = Math.floor(Date.now() / 1000);
  const m6 = { from: MAISON_W.address, to: am.payTo, value: am.amount, validAfter: String(s6 - 600), validBefore: String(s6 + 110), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
  const sig6 = await MAISON_W._signTypedData(Object.assign({ chainId: 4663, verifyingContract: am.asset }, X.DOMAINE_USDG), X.TYPES_3009, m6);
  const pm = await appel('colony_activity', { arguments: {} }, { 'payment-signature': X.b64({ x402Version: 2, resource: qm.x402.resource, accepted: am, payload: { signature: sig6, authorization: m6 } }) });
  await lis(pm.clone());
  eq(pm.status, 200, 'paye avec les exigences du devis sans cle, sans 402 avant : le devis se paie tel quel');

  console.log('\n-- 3 septies. les compteurs durables --');
  const e7 = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  const t7 = e7.jours.total;
  ok(t7.paye_x402 && t7.paye_x402.n === 3 && t7.paye_x402.exterieur.n === 2 && t7.paye_x402.maison.n === 1 && e7.jours.parJour[0].evenements.paye_x402.distincts === 2,
     'paye en x402 : 3 (2 dehors, 1 de la maison — COMPTEURS_MAISON), 2 payeurs distincts');
  const attendu = col.usd + Number(au.amount) / 1e6 + Number(am.amount) / 1e6;
  ok(Math.abs(t7.paye_x402.usd - attendu) < 1e-5 && Math.abs(t7.paye_x402.maison.usd - Number(am.amount) / 1e6) < 1e-9,
     'les montants : exacts en USDG, le prix du devis en $SWOGE (' + t7.paye_x402.usd + ' $)');
  const coutUn = 91234 * 28e6 / 1e18 * 2688.57;
  ok(t7.paye_x402.coutN === 3 && Math.abs(t7.paye_x402.coutUsd - 3 * coutUn) < 1e-5, 'le cout reel : le gaz de chaque reglement (91 234 × 0,028 gwei × ETH = ' + coutUn.toFixed(5) + ' $)');
  ok(t7.demande402 && t7.demande402.n >= 5 && t7.demande402.exterieur.n === t7.demande402.n && e7.jours.outils.colony_activity.demande402.n >= 1 && e7.jours.outils.colony_activity.paye_x402.n === 2,
     'les 402 emis, par outil (' + (t7.demande402 && t7.demande402.n) + ' ; colony_activity : 402 puis 2 payes)');
  ok(t7.echec && t7.echec.n >= 3, 'les echecs : signature rejouee, devis d une image paye pour quatre, fournisseur d images eteint (' + (t7.echec && t7.echec.n) + ')');
  ok(t7.devis && t7.devis.canaux.rest >= 2 && t7.devis.canaux.mcp >= 1 && t7.refus_sans_cle && t7.refus_sans_cle.canaux.mcp >= 1, 'les devis et refus sans cle, REST et MCP');
  ok(e7.gaz.source === 'measured' && e7.gaz.gazParPaiement === 91234 && e7.gaz.mesures === 3 && e7.gaz.paiementsRestants === 391 && e7.gaz.alerte === false,
     'le gaz MESURE remplace l estimation : 91 234 par reglement (3 mesures) → ' + e7.gaz.paiementsRestants + ' reglements, plus d alerte [' + JSON.stringify(e7.gaz) + ']');

  console.log('\n-- 3 octies. un redemarrage ne perd rien --');
  {
    const fj = BAC + '/compteurs/' + new Date().toISOString().slice(0, 10) + '.json';
    const lu = () => { try { return JSON.parse(fs.readFileSync(fj, 'utf8')); } catch (e) { return null; } };
    for (let i = 0; i < 70 && !((lu() || { evenements: {} }).evenements.paye_x402 || {}).n; i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 70 && (lu().evenements.paye_x402.n !== 3); i++) await new Promise((r) => setTimeout(r, 100));
    const disque = fs.readdirSync(BAC + '/compteurs').map((f) => fs.readFileSync(BAC + '/compteurs/' + f, 'utf8')).join('\n');
    ok(lu() && lu().evenements.paye_x402.n === 3 && !disque.includes('127.0.0.1') && !disque.toLowerCase().includes(payeur.address.slice(2).toLowerCase()),
       'sur le disque au plus 5 s apres : les comptes, jamais l IP de l essai ni l adresse d un payeur');
    const p2 = await libre();
    const code = "const tg = require.resolve('./telegram');"
      + "require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };"
      + "require('./config'); require('./server');"
      + "setTimeout(async () => { const r = await fetch('http://127.0.0.1:" + p2 + "/agentic/x402'); process.stdout.write(await r.text()); process.exit(0); }, 1500);";
    const sortie = await new Promise((res) => {
      const env = Object.assign({}, process.env, { PORT: String(p2), PUBLIC_URL: 'http://127.0.0.1:' + p2 });
      require('child_process').execFile(process.execPath, ['-e', code], { cwd: __dirname, env, maxBuffer: 1 << 24, timeout: 60000 }, (e, out) => res(String(out || '')));
    });
    tout.push(sortie);   /* la sortie du second serveur passe aussi a la recherche de la cle (section 4) */
    let e8 = null; try { e8 = JSON.parse(sortie.slice(sortie.indexOf('{"ok"'))); } catch (e) { e8 = null; }
    ok(e8 && e8.jours && e8.jours.total.paye_x402.n === 3 && e8.jours.total.paye_x402.maison.n === 1 && e8.jours.total.demande402.n === t7.demande402.n
       && e8.jours.parJour[0].evenements.paye_x402.distincts === 2,
       'un NOUVEAU serveur sur le meme DATA_DIR relit les compteurs : 3 payes (1 maison), ' + (e8 && e8.jours && e8.jours.total.demande402.n) + ' 402, 2 payeurs distincts');
    ok(e8 && e8.gaz && e8.gaz.source === 'measured' && e8.gaz.mesures === 3, 'et le gaz mesure (relu dans x402.jsonl) aussi');
  }

  console.log('\n-- 4. la cle du portefeuille de gaz --');
  const k = GAZ.privateKey.slice(2).toLowerCase();
  ok(!tout.some((t) => t.toLowerCase().includes(k)), 'la cle privee n apparait dans AUCUNE reponse (' + tout.length + ' corps et en-tetes lus)');

  noeud.srv.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
