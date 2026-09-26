'use strict';
/*
 * SWOGEAGENTIC POUR LES AUTRES AGENTS — de bout en bout, sur le VRAI serveur :
 * un joueur signe avec un vrai wallet, cree une cle dans la page (session),
 * un « agent » appelle l'API et le serveur MCP avec cette cle.
 *   - une cle ne cree ni ne revoque de cle ; une adresse glissee dans le corps
 *     ne change rien : c'est l'adresse de la CLE qui paie ;
 *   - le solde baisse exactement du prix annonce ; un devis ne coute rien ;
 *   - MCP par en-tete et par chemin ; GET → 405 ; Origin etranger → 403 ;
 *   - revoquee, la cle ne sert plus.
 */
const net = require('net');
const fs = require('fs');
const ethers = require('ethers');
const WebSocket = require('ws');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

const BAC = fs.mkdtempSync('/tmp/agentic-route-');
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
delete process.env.AGENTIC_PRIX; delete process.env.PERPLEXITY_API_KEY;
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  require('./config');
  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const base = 'http://127.0.0.1:' + port;
  const J = async (u, o) => { const r = await fetch(base + u, o); let b = null; try { b = await r.json(); } catch (e) { b = null; } return { status: r.status, b }; };

  console.log('-- 1. le catalogue, public --');
  const cat = await J('/agentic/tools');
  ok(cat.status === 200 && cat.b.outils.map((o) => o.name).join(',') === 'scan_token,colony_activity,swoge_economy,ask_agent', 'les outils et leurs prix (sans cle Perplexity : pas de recherche web)');

  console.log('\n-- 2. un joueur signe et cree une cle --');
  const w = ethers.Wallet.createRandom();
  const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => s.on('open', r));
  const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  const auth = await attend('auth');
  const adr = w.address.toLowerCase();
  moteur._p(adr).balance = ethers.utils.parseUnits('200000', 18);
  const S = { authorization: 'Bearer ' + auth.session, 'content-type': 'application/json' };
  eq((await J('/agentic/cles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nom":"x","plafondSwoge":1000}' })).status, 401, 'sans session : aucune cle');
  const c1 = await J('/agentic/cles', { method: 'POST', headers: S, body: JSON.stringify({ nom: 'my agent', plafondSwoge: 5000 }) });
  ok(c1.status === 200 && /^swg_/.test(c1.b.cle), 'la session cree une cle, montree une fois');
  const K = { authorization: 'Bearer ' + c1.b.cle, 'content-type': 'application/json' };
  const parCle = await J('/agentic/cles', { method: 'POST', headers: K, body: JSON.stringify({ nom: 'evil', plafondSwoge: 100000000 }) });
  ok(parCle.status === 401 && /cannot manage keys/.test(parCle.b.raison), 'une cle ne peut PAS creer de cle');
  const liste = await J('/agentic/cles', { headers: S });
  ok(liste.b.cles.length === 1 && !JSON.stringify(liste.b).includes(c1.b.cle), 'la liste ne rend jamais la cle');

  console.log('\n-- 3. l agent appelle l API --');
  const autre = ethers.Wallet.createRandom().address.toLowerCase();
  const autreAvant = moteur.balanceStr(autre);
  const avant = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);
  const dv = await J('/agentic/call/colony_activity', { method: 'POST', headers: K, body: JSON.stringify({ quote: true }) });
  ok(dv.status === 200 && dv.b.devis.swoge > 0 && ethers.utils.parseUnits(moteur.balanceStr(adr), 18).eq(avant), 'un devis : le prix, rien de debite');
  const r = await J('/agentic/call/colony_activity', { method: 'POST', headers: K, body: JSON.stringify({ addr: autre, arguments: {} }) });
  ok(r.status === 200 && r.b.ok && r.b.resultat && r.b.recu, 'l appel rend les donnees de la colonie et un recu');
  const apres = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);
  ok(typeof r.b.facture.swoge === 'string', 'le montant annonce est une chaine exacte, pas un nombre arrondi');
  eq(avant.sub(apres).toString(), ethers.utils.parseUnits(r.b.facture.swoge, 18).toString(), 'le solde du joueur baisse EXACTEMENT du prix annonce, au wei pres');
  eq(r.b.facture.swoge, dv.b.devis.swoge, 'et c est exactement le prix du devis');
  eq(moteur.balanceStr(autre), autreAvant, 'l adresse glissee dans le corps n est pas touchee');
  ok((await J('/agentic/call/scan_token', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { address: 'nope' } }) })).status === 400
     && ethers.utils.parseUnits(moteur.balanceStr(adr), 18).eq(apres), 'une entree invalide : 400, rien debite');
  eq((await J('/agentic/call/colony_activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'sans cle : 401');
  const recus = await J('/agentic/recus', { headers: S });
  eq(recus.b.recus[0].id, r.b.recu, 'le joueur lit ses recus depuis la page');

  console.log('\n-- 4. le serveur MCP --');
  const mcp = (chemin, corps, en) => fetch(base + chemin, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, en || {}), body: JSON.stringify(corps) });
  const ini = await (await mcp('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  eq(ini.result.protocolVersion, '2025-11-25', 'initialize sur le vrai serveur');
  const tc = await (await mcp('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'colony_activity', arguments: {} } }, { authorization: 'Bearer ' + c1.b.cle, 'mcp-protocol-version': '2025-11-25' })).json();
  ok(tc.result && tc.result.isError === false && /billed/.test(tc.result.content[0].text), 'tools/call avec la cle en en-tete : servi et facture');
  const tk = await (await mcp('/mcp/k/' + encodeURIComponent(c1.b.cle), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'colony_activity', arguments: { quote: true } } })).json();
  ok(tk.result && /^Price:/.test(tk.result.content[0].text), 'la cle dans le chemin, pour les clients sans en-tete');
  eq((await fetch(base + '/mcp')).status, 405, 'GET /mcp : 405');
  eq((await mcp('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { origin: 'https://evil.example' })).status, 403, 'Origin etranger : 403');

  console.log('\n-- 5. revoquee, la cle ne sert plus --');
  const id = liste.b.cles[0].id;
  ok((await J('/agentic/cles/' + id, { method: 'DELETE', headers: K })).status === 401, 'une cle ne peut pas se revoquer elle-meme (seule la session)');
  ok((await J('/agentic/cles/' + id, { method: 'DELETE', headers: S })).status === 200, 'la session revoque');
  eq((await J('/agentic/call/colony_activity', { method: 'POST', headers: K, body: '{}' })).status, 401, 'la cle revoquee est refusee');

  s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
