'use strict';
/*
 * SWOGEAGENTIC POUR LES AUTRES AGENTS — de bout en bout, sur le VRAI serveur :
 * un joueur signe avec un vrai wallet, cree une cle dans la page (session),
 * un « agent » appelle l'API et le serveur MCP avec cette cle.
 *   - une cle ne cree ni ne revoque de cle ; une adresse glissee dans le corps
 *     ne change rien : c'est l'adresse de la CLE qui paie ;
 *   - le solde baisse exactement du prix annonce ; un devis ne coute rien ;
 *   - MCP par en-tete et par chemin ; GET → 405 ; Origin etranger → 403 ;
 *   - revoquee, la cle ne sert plus ;
 *   - scan_token (sur de faux DexScreener/GoPlus locaux) porte « Powered by
 *     Go+ Security » en donnees et en texte, par l'API comme par MCP ;
 *   - telegram_calls n'est offert NULLE PART sans TG_APPELS_VENTE=1 (catalogue,
 *     MCP, openapi.json, llms.txt, agent des joueurs), et l'appeler repond
 *     comme un outil inconnu, sans rien debiter ; allume, il revient partout ;
 *   - SANS CLE (26 septembre 2026) : un devis est servi, gratuit, par REST et
 *     par MCP, sans rien debiter ; un appel recoit la marche a suivre exacte ;
 *     une cle PRESENTEE mais revoquee reste un 401, devis compris ; les devis
 *     sans cle sont bornes a 60 par minute et par IP ;
 *   - les compteurs durables comptent devis, refus et paiements par canal, et
 *     /agentic/x402 en publie le resume (`jours`) meme x402 eteint — sans l'IP ;
 *   - /favicon.ico renvoie (301) vers celle du site.
 */
const net = require('net');
const http = require('http');
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
/* Le reglage par defaut : telegram_calls n'est pas vendu (section 6). */
delete process.env.TG_APPELS_VENTE;
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

/* De faux DexScreener et GoPlus locaux (formes de studio_jeton.test.js) : un
   scan_token REEL, sans sortir sur le reseau. */
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const fauxMarche = http.createServer((q, r) => {
  const rend = (j) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(j)); };
  if (q.url === '/latest/dex/tokens/' + PEPE) return rend({ pairs: [{ chainId: 'ethereum', dexId: 'uniswap', url: 'https://dexscreener.com/ethereum/0xp',
    baseToken: { address: PEPE, symbol: 'PEPE', name: 'Pepe' }, priceUsd: '0.0000044', liquidity: { usd: 25000000 }, marketCap: 1.8e9, volume: { h24: 9e6 }, priceChange: { h24: 3 }, txns: { h24: { buys: 1, sells: 1 } } }] });
  if (q.url === '/api/v1/token_security/1?contract_addresses=' + PEPE) return rend({ code: 1, result: { [PEPE]: { is_honeypot: '0', transfer_pausable: '1', buy_tax: '0', sell_tax: '0', holder_count: '593837', holders: [] } } });
  r.writeHead(404); r.end('{}');
});

(async () => {
  await new Promise((r) => fauxMarche.listen(0, '127.0.0.1', r));
  process.env.DEXSCREENER_BASE_URL = process.env.GOPLUS_BASE_URL = 'http://127.0.0.1:' + fauxMarche.address().port;
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
  /* Sans TG_APPELS_VENTE=1, les appels Telegram ne sont pas vendus (conditions de Telegram, 26 septembre 2026). */
  ok(cat.status === 200 && cat.b.outils.map((o) => o.name).join(',') === 'scan_token,can_i_sell,colony_activity,swoge_economy,new_launches,wallet_intel,osint_lookup,chat_completion,robinhood_token,robinhood_wallet,robinhood_tx,robinhood_rpc,token_verdict,fair_commit,fair_draw,fair_verify,roast_token,ask_agent,generate_image,generate_video,video_status',
     'les outils et leurs prix (sans cle Perplexity : pas de recherche web ; sans TG_APPELS_VENTE : pas d appels Telegram) [' + cat.b.outils.map((o) => o.name).join(',') + ']');
  ok(/Powered by Go\+ Security, https:\/\/gopluslabs\.io/.test(cat.b.outils[0].description), 'le catalogue : scan_token dit « Powered by Go+ Security » avec son lien');

  const lt = await fetch(base + '/llms.txt');
  const ltxt = await lt.text();
  ok(lt.status === 200 && /text\/plain/.test(lt.headers.get('content-type')) && /^# SwogeAgentic/.test(ltxt) && /`new_launches\(limit\?\)`/.test(ltxt), '/llms.txt en direct, depuis le catalogue');
  ok(!/telegram_calls/.test(ltxt) && /^- `scan_token\(address\)`.*Powered by Go\+ Security, https:\/\/gopluslabs\.io/m.test(ltxt), '/llms.txt : pas d appels Telegram ; la ligne scan_token porte l attribution GoPlus');

  eq((await fetch(base + '/.well-known/x402')).status, 404, 'x402 eteint : pas de manifeste (rien de promis)');
  const oa = await (await fetch(base + '/openapi.json')).json();
  ok(oa.openapi === '3.1.0' && Object.values(oa.paths).every((p) => !(p.post && p.post['x-payment-info'])), '/openapi.json sans x402 : les appels par cle, aucun paiement sans cle promis');
  ok(!oa.paths['/agentic/call/telegram_calls'] && /Powered by Go\+ Security/.test(oa.paths['/agentic/call/scan_token'].post.description), '/openapi.json : aucun chemin telegram_calls ; scan_token porte l attribution GoPlus');
  const ag = await J('/studio/agent/catalogue');
  ok(ag.status === 200 && ag.b.outils.some((o) => o.nom === 'scan_token') && !ag.b.outils.some((o) => o.nom === 'telegram_calls'), 'l agent des joueurs (facture a l usage) ne propose pas les appels Telegram');

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
  /* Les eSIM (achats.js, 28/09) : la route ne connait que la SESSION ; ici sans AGENT_BUDGET_CLE, eteinte et le dit. */
  eq((await J('/studio/agent/achats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"confirme","id":"x"}' })).status, 401, 'achats : sans session, rien ne se confirme');
  eq((await J('/studio/agent/achats', { headers: K })).status, 401, 'achats : une cle d API (swg_) n est pas une session');
  const ach = await J('/studio/agent/achats', { method: 'POST', headers: S, body: '{"action":"confirme","id":"x"}' });
  ok(ach.status === 200 && ach.b.ok === true && ach.b.actif === false, 'achats : avec la session mais sans portefeuille d agent, eteints — rien paye');
  ok((await J('/studio/agent/catalogue')).b.achats.actif === false && !(await J('/studio/agent/catalogue')).b.outils.some((o) => /esim/.test(o.nom)), 'le catalogue de l agent dit les achats eteints, sans leurs outils');
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
  const sansCle = await J('/agentic/call/colony_activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(sansCle.status === 401 && /Authorization: Bearer swg_/.test(sansCle.b.raison) && /swogeagentic\.html/.test(sansCle.b.raison) && /"quote": true/.test(sansCle.b.raison) && sansCle.b.howToPay,
     'sans cle : 401, et la reponse dit comment payer (la cle, ou elle se cree, le devis gratuit)');
  ok(!/x402/.test(sansCle.b.raison), 'x402 eteint : il n est pas propose');
  const avantDv = moteur.balanceStr(adr);
  const dvSans = await J('/agentic/call/colony_activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quote: true }) });
  ok(dvSans.status === 200 && dvSans.b.ok && dvSans.b.quote === true && dvSans.b.tool === 'colony_activity' && dvSans.b.priceUsd === 0.005 && dvSans.b.devis.swoge === dv.b.devis.swoge,
     'un devis SANS cle : 200, le prix par cle (0,005 $ = ' + (dvSans.b.devis && dvSans.b.devis.swoge) + ' $SWOGE, le meme qu avec une cle)');
  ok(/swogeagentic\.html/.test(dvSans.b.howToPay) && !dvSans.b.x402 && moteur.balanceStr(adr) === avantDv, 'avec la marche a suivre, sans x402 (eteint), et rien debite');
  const dvQ = await J('/agentic/call/scan_token?quote=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(dvQ.status === 200 && dvQ.b.priceUsd === 0.01, '?quote=1 sans cle ni arguments : le prix de scan_token (0,01 $) — une question de prix n a pas a etre valide');
  eq((await J('/agentic/call/nope_tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quote: true }) })).status, 404, 'le devis d un outil inconnu : 404');
  const nl = await J('/agentic/call/new_launches', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { limit: 5 } }) });
  ok(nl.status === 200 && Array.isArray(nl.b.resultat.fresh) && Array.isArray(nl.b.resultat.watched), 'new_launches sur le vrai serveur : les listes de la colonie');
  /* Ses verdicts du Warden sont des phrases GoPlus : la mention part avec le resultat vendu, en donnees et en texte. */
  ok(JSON.stringify(nl.b.resultat.attribution) === JSON.stringify({ security: 'Powered by Go+ Security', url: 'https://gopluslabs.io' })
     && /Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(nl.b.texte),
     'new_launches vendu : « Powered by Go+ Security » et son lien, en donnees et dans le texte');
  /* scan_token REEL (faux DexScreener/GoPlus locaux) : la licence GoPlus veut « Powered by Go+ Security ». */
  const avantS = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);
  const sc = await J('/agentic/call/scan_token', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { address: PEPE } }) });
  ok(sc.status === 200 && sc.b.resultat.token.sym === 'PEPE' && sc.b.resultat.token.alertes.includes('Pausable'), 'scan_token sur le vrai serveur : la fiche lue (marche + securite GoPlus)');
  ok(JSON.stringify(sc.b.resultat.attribution) === JSON.stringify({ security: 'Powered by Go+ Security', url: 'https://gopluslabs.io' })
     && /Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(sc.b.texte) && sc.b.resultat.token.attribution.url === 'https://gopluslabs.io',
     'scan_token paye : « Powered by Go+ Security » en donnees (attribution), dans la carte, et dans le texte que lit l agent');
  eq(avantS.sub(ethers.utils.parseUnits(moteur.balanceStr(adr), 18)).toString(), ethers.utils.parseUnits(sc.b.facture.swoge, 18).toString(), 'et facture exactement son prix');
  const people = await J('/agentic/call/osint_lookup', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { target: 'someone@example.com' } }) });
  ok(people.status === 400 && /not people/.test(people.b.raison), 'osint_lookup refuse une personne, sans rien facturer');
  /* Les videos (26 septembre 2026) : sans xAI allume, rien ne part et rien n'est debite ; relire une video est gratuit. */
  const avantV = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);
  const gv = await J('/agentic/call/generate_video', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { prompt: 'a dog surfing' } }) });
  ok(gv.status === 402 && /daily cap/.test(gv.b.raison) && ethers.utils.parseUnits(moteur.balanceStr(adr), 18).eq(avantV),
     'generate_video au-dela du plafond du jour de la cle (5 000 $SWOGE < le maximum d une video) : 402 AVANT de lancer quoi que ce soit, rien debite');
  const dvV = await J('/agentic/call/generate_video', { method: 'POST', headers: K, body: JSON.stringify({ quote: true, arguments: { prompt: 'x', quality: 'quality', duration: 10 } }) });
  ok(dvV.status === 200 && dvV.b.devis.variable && dvV.b.devis.maxUsd === 3.6, 'le devis d une video dit son maximum (Quality 10 s : 3,60 $)');
  eq((await J('/agentic/call/video_status', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { id: 'nope' } }) })).status, 400, 'video_status : un id mal forme, 400');
  eq((await J('/agentic/call/video_status', { method: 'POST', headers: K, body: JSON.stringify({ arguments: { id: 'a'.repeat(24) } }) })).status, 404, 'video_status : la video d un autre (ou inconnue) — 404, jamais lue');
  ok(ethers.utils.parseUnits(moteur.balanceStr(adr), 18).eq(avantV), 'et rien de tout cela n a coute');
  const recus = await J('/agentic/recus', { headers: S });
  ok(recus.b.recus.some((x) => x.id === r.b.recu), 'le joueur lit ses recus depuis la page');

  console.log('\n-- 4. le serveur MCP --');
  const mcp = (chemin, corps, en) => fetch(base + chemin, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, en || {}), body: JSON.stringify(corps) });
  const ini = await (await mcp('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  eq(ini.result.protocolVersion, '2025-11-25', 'initialize sur le vrai serveur');
  const tc = await (await mcp('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'colony_activity', arguments: {} } }, { authorization: 'Bearer ' + c1.b.cle, 'mcp-protocol-version': '2025-11-25' })).json();
  ok(tc.result && tc.result.isError === false && /billed/.test(tc.result.content[0].text), 'tools/call avec la cle en en-tete : servi et facture');
  const tk = await (await mcp('/mcp/k/' + encodeURIComponent(c1.b.cle), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'colony_activity', arguments: { quote: true } } })).json();
  ok(tk.result && /^Price:/.test(tk.result.content[0].text), 'la cle dans le chemin, pour les clients sans en-tete');
  const hk = { authorization: 'Bearer ' + c1.b.cle, 'mcp-protocol-version': '2025-11-25' };
  const tlm = await (await mcp('/mcp', { jsonrpc: '2.0', id: 20, method: 'tools/list' }, hk)).json();
  ok(tlm.result.tools.some((x) => x.name === 'scan_token') && !tlm.result.tools.some((x) => x.name === 'telegram_calls'), 'MCP tools/list : pas d appels Telegram');
  const tgm = await (await mcp('/mcp', { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'telegram_calls', arguments: {} } }, hk)).json();
  const inm = await (await mcp('/mcp', { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'nope_tool', arguments: {} } }, hk)).json();
  ok(tgm.error && tgm.error.code === -32602 && tgm.error.code === inm.error.code, 'MCP tools/call telegram_calls : -32602, comme un outil inconnu');
  const scm = await (await mcp('/mcp', { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'scan_token', arguments: { address: PEPE } } }, hk)).json();
  ok(scm.result && scm.result.isError === false && /Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(scm.result.content[0].text) && scm.result.structuredContent.result.attribution.url === 'https://gopluslabs.io',
     'MCP scan_token : l attribution GoPlus dans le texte et dans structuredContent');
  /* Sans cle (26 septembre 2026) : le devis promis par les instructions, et un refus qui dit quoi faire. */
  const hs = { 'mcp-protocol-version': '2025-11-25' };
  const iniS = await (await mcp('/mcp', { jsonrpc: '2.0', id: 40, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  ok(/No key needed/.test(iniS.result.instructions) && /\{"quote": true\}/.test(iniS.result.instructions) && /POST https?:\/\/\S+\/agentic\/call\/<tool>/.test(iniS.result.instructions), 'les instructions MCP disent : devis sans cle, cle pour etre servi, x402 en REST a cette adresse');
  const avantM = moteur.balanceStr(adr);
  const qm = await (await mcp('/mcp', { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'scan_token', arguments: { quote: true } } }, hs)).json();
  ok(qm.result && qm.result.isError === false && /^Price: /.test(qm.result.content[0].text) && qm.result.structuredContent.quote === true
     && qm.result.structuredContent.priceUsd === 0.01 && qm.result.structuredContent.tool === 'scan_token', 'MCP sans cle, quote: true : le devis (texte + structuredContent), isError false');
  const cm = await (await mcp('/mcp', { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'colony_activity', arguments: {} } }, hs)).json();
  ok(cm.result && cm.result.isError === true && /Authorization: Bearer swg_/.test(cm.result.content[0].text) && /swogeagentic\.html/.test(cm.result.content[0].text)
     && !/missing or revoked/.test(cm.result.content[0].text), 'MCP sans cle, un appel : isError, et le texte dit comment avoir acces (plus le seul « missing or revoked API key »)');
  eq(moteur.balanceStr(adr), avantM, 'et rien de tout cela n a coute');
  eq((await fetch(base + '/mcp')).status, 405, 'GET /mcp : 405');
  eq((await mcp('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { origin: 'https://evil.example' })).status, 403, 'Origin etranger : 403');

  console.log('\n-- 5. revoquee, la cle ne sert plus --');
  const id = liste.b.cles[0].id;
  ok((await J('/agentic/cles/' + id, { method: 'DELETE', headers: K })).status === 401, 'une cle ne peut pas se revoquer elle-meme (seule la session)');
  ok((await J('/agentic/cles/' + id, { method: 'DELETE', headers: S })).status === 200, 'la session revoque');
  eq((await J('/agentic/call/colony_activity', { method: 'POST', headers: K, body: '{}' })).status, 401, 'la cle revoquee est refusee');
  const dvRev = await J('/agentic/call/colony_activity', { method: 'POST', headers: K, body: JSON.stringify({ quote: true }) });
  ok(dvRev.status === 401 && /invalid or revoked/.test(dvRev.b.raison), 'une cle PRESENTEE mais revoquee : 401, meme pour un devis (jamais le devis gratuit)');
  const mRev = await (await mcp('/mcp', { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'colony_activity', arguments: { quote: true } } }, { authorization: 'Bearer ' + c1.b.cle, 'mcp-protocol-version': '2025-11-25' })).json();
  ok(mRev.result.isError === true && /invalid or revoked/.test(mRev.result.content[0].text), 'MCP : la cle revoquee est refusee aussi');

  console.log('\n-- 5 bis. les compteurs durables, publics sans identite --');
  {
    const et = await J('/agentic/x402');
    const jr = et.b.jours || {};
    const tot = jr.total || {};
    ok(et.status === 200 && et.b.actif === false && jr.parJour && jr.parJour[0].jour === new Date().toISOString().slice(0, 10), 'x402 eteint : /agentic/x402 publie quand meme les compteurs du jour');
    ok(tot.devis && tot.devis.canaux.rest >= 4 && tot.devis.canaux.mcp >= 2, 'les devis comptes par canal : REST ' + (tot.devis && tot.devis.canaux.rest) + ', MCP ' + (tot.devis && tot.devis.canaux.mcp));
    ok(tot.refus_sans_cle && tot.refus_sans_cle.canaux.rest >= 1 && tot.refus_sans_cle.canaux.mcp >= 1, 'les refus faute de cle, REST et MCP');
    ok(tot.paye_cle && tot.paye_cle.n >= 5 && jr.outils.colony_activity.paye_cle.n >= 2 && jr.outils.scan_token.paye_cle.usd > 0, 'les appels payes par cle, par outil (' + (tot.paye_cle && tot.paye_cle.n) + ')');
    ok(tot.echec && tot.echec.n >= 2, 'les echecs apres la cle (plafond d une video, outil qui refuse une personne) : ' + (tot.echec && tot.echec.n));
    ok(tot.paye_cle.maison.n === 0 && tot.paye_cle.exterieur.n === tot.paye_cle.n, 'un joueur qui n est pas a nous : dehors');
    /* Le fichier du jour : ecrit au plus 5 s apres le premier compte non ecrit. */
    const dossier = BAC + '/compteurs', fj = dossier + '/' + new Date().toISOString().slice(0, 10) + '.json';
    for (let i = 0; i < 70 && !fs.existsSync(fj); i++) await new Promise((r) => setTimeout(r, 100));
    ok(fs.existsSync(fj) && JSON.parse(fs.readFileSync(fj, 'utf8')).evenements.devis.n >= 6, 'le fichier du jour est sur le disque (DATA_DIR/compteurs), au plus 5 s apres');
    const disque = fs.readdirSync(dossier).map((f) => fs.readFileSync(dossier + '/' + f, 'utf8')).join('\n');
    ok(!disque.includes('127.0.0.1') && !JSON.stringify(et.b).includes('127.0.0.1') && !disque.toLowerCase().includes(adr.slice(2)), 'ni l IP de l essai ni l adresse du joueur, sur le disque comme dans la reponse');
  }

  console.log('\n-- 5 ter. /favicon.ico --');
  {
    const f = await fetch(base + '/favicon.ico', { redirect: 'manual' });
    ok(f.status === 301 && f.headers.get('location') === 'https://swoleeswoge.dog/favicon.ico', '/favicon.ico : 301 vers celle du site (et plus le JSON du jeu)');
  }

  console.log('\n-- 5 quater. les devis sans cle sont bornes par IP --');
  {
    let premier429 = 0;
    for (let i = 1; i <= 70 && !premier429; i++) {
      const r = await fetch(base + '/agentic/call/swoge_economy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"quote":true}' });
      if (r.status === 429) premier429 = i;
    }
    ok(premier429 > 0 && premier429 <= 61, 'au-dela de 60 devis sans cle par minute depuis la meme IP : 429 (le ' + premier429 + 'e de cette serie)');
  }

  s.close();
  console.log('\n-- 6. les appels Telegram : pas vendus sans TG_APPELS_VENTE=1 ; allumes, suivi eteint (colonie eteinte dans l essai) --');
  {
    const cle = (await J('/agentic/cles', { method: 'POST', headers: S, body: JSON.stringify({ nom: 'tg', plafondSwoge: 5000 }) })).b.cle;
    const KT = { authorization: 'Bearer ' + cle, 'content-type': 'application/json' };
    const avantT = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);
    /* Eteint (le defaut) : l'appeler = appeler un nom invente, avec ou sans cle, et rien n'est debite. */
    const off = await J('/agentic/call/telegram_calls', { method: 'POST', headers: KT, body: JSON.stringify({ arguments: { hours: 12 } }) });
    const inv = await J('/agentic/call/nope_tool', { method: 'POST', headers: KT, body: JSON.stringify({ arguments: { hours: 12 } }) });
    ok(off.status === 404 && inv.status === 404 && off.b.raison === 'unknown tool: telegram_calls' && inv.b.raison === 'unknown tool: nope_tool'
       && JSON.stringify(Object.keys(off.b)) === JSON.stringify(Object.keys(inv.b)), 'eteint, avec une cle : 404 « unknown tool », la meme reponse qu un nom invente');
    const offS = await J('/agentic/call/telegram_calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const invS = await J('/agentic/call/nope_tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    /* Depuis le 26 septembre 2026, sans cle, l'outil est cherche AVANT la cle : un nom inconnu
       rend 404 « unknown tool: <nom> » (et non plus le 401 commun). L'intention tient : rien ne
       distingue l'outil eteint d'un nom invente, sinon le nom qu'on a soi-meme envoye. */
    ok(offS.status === 404 && invS.status === 404 && offS.b.raison === 'unknown tool: telegram_calls' && invS.b.raison === 'unknown tool: nope_tool'
       && JSON.stringify(Object.keys(offS.b)) === JSON.stringify(Object.keys(invS.b)), 'eteint, sans cle : la meme reponse qu un nom invente [' + offS.status + ']');
    ok(ethers.utils.parseUnits(moteur.balanceStr(adr), 18).eq(avantT), 'eteint : rien debite');

    /* Allume : il revient partout, a sa place ; la couverture d'avant tient (suivi eteint dans l essai). */
    process.env.TG_APPELS_VENTE = '1';
    const cat1 = await J('/agentic/tools');
    ok(cat1.b.outils.map((o) => o.name).join(',') === 'scan_token,can_i_sell,colony_activity,swoge_economy,new_launches,wallet_intel,osint_lookup,telegram_calls,chat_completion,robinhood_token,robinhood_wallet,robinhood_tx,robinhood_rpc,token_verdict,fair_commit,fair_draw,fair_verify,roast_token,ask_agent,generate_image,generate_video,video_status',
       'TG_APPELS_VENTE=1 : au catalogue, a sa place');
    const oa1 = await (await fetch(base + '/openapi.json')).json();
    ok(oa1.paths['/agentic/call/telegram_calls'] && /`telegram_calls\(channel\?, hours\?, limit\?\)`/.test(await (await fetch(base + '/llms.txt')).text()), 'TG_APPELS_VENTE=1 : dans /openapi.json et /llms.txt');
    const tl1 = await (await mcp('/mcp', { jsonrpc: '2.0', id: 30, method: 'tools/list' }, { authorization: 'Bearer ' + cle, 'mcp-protocol-version': '2025-11-25' })).json();
    ok(tl1.result.tools.some((x) => x.name === 'telegram_calls') && (await J('/studio/agent/catalogue')).b.outils.some((o) => o.nom === 'telegram_calls'), 'TG_APPELS_VENTE=1 : dans tools/list MCP et chez l agent des joueurs');
    const r = await J('/agentic/call/telegram_calls', { method: 'POST', headers: KT, body: JSON.stringify({ arguments: { hours: 12 } }) });
    ok(r.status === 400 && /not switched on/.test(r.b.raison) && ethers.utils.parseUnits(moteur.balanceStr(adr), 18).eq(avantT), 'suivi eteint : refuse, et rien debite');
    eq((await J('/agentic/call/telegram_calls', { method: 'POST', headers: KT, body: JSON.stringify({ arguments: { hours: 999 } }) })).status, 400, 'des heures hors [1 ; 168] : 400');
    delete process.env.TG_APPELS_VENTE;
  }
  fauxMarche.close();

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
