'use strict';
/*
 * SWOGEAGENTIC POUR LES AUTRES AGENTS — cles, API payee a l'appel, serveur MCP.
 *   1. les cles : montree une fois, seule l'empreinte est gardee, plafond par
 *      jour, au plus 5 vivantes, revoquees pour de bon ;
 *   2. l'API : devis sans debit ; appel debite le prix, rend un recu ; une
 *      entree invalide, un outil en panne ou un plafond atteint ne coutent
 *      RIEN ; `ask_agent` est facture au reel, borne par le plafond ;
 *   3. MCP, les deux epoques de la specification (relue le 26 septembre 2026) :
 *      heritee (initialize → tools/list → tools/call) et moderne (_meta par
 *      requete, en-tetes compares au corps, -32020 / -32022 / 404 -32601,
 *      server/discover) ; GET → 405 ; Origin hors liste → 403 ;
 *   4. aucune cle ne gere les cles, aucun outil n'achete ni ne signe.
 */
const fs = require('fs'), os = require('os'), path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
process.env.STUDIO_MARGE = '1.5';
delete process.env.AGENTIC_PRIX;

const K = require('./agentic_cles');
const A = require('./agentic');
const MCP = require('./agentic_mcp');
const COURS = 0.00002801;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-'));
const fichier = path.join(dir, 'agentic_cles.json');
let t = Date.UTC(2026, 8, 26, 12, 0, 0);
const cles = K.cree({ fichier, maintenant: () => t });
const ADDR = '0x' + 'ab'.repeat(20), AUTRE = '0x' + 'cd'.repeat(20);

/* Un solde qui se souvient de tout. */
const sol = { reserves: [], regles: [], refuse: false };
const solde = { reserve: (a, w) => { if (sol.refuse) return false; sol.reserves.push({ a, w: BigInt(String(w)) }); return true; },
                regle: (a, rw, fw) => { sol.regles.push({ a, rw: BigInt(String(rw)), fw: BigInt(String(fw)) }); return '1000'; } };
let panne = false, agentAppele = null;
const outils = {
  scan_token: async (e) => (panne ? (() => { throw new Error('dex down'); })() : { texte: 'Token ' + e.address + ': ...', carte: { sym: 'PEPE' }, sources: [{ url: 'https://dexscreener.com/x' }] }),
  colony_activity: async () => ({ texte: JSON.stringify({ status: 'running', openPositions: [] }) }),
  swoge_economy: async () => ({ erreur: 'rpc down' }),
  web_search: async () => ({ texte: 'RESULTS', sources: [{ url: 'https://n.example' }], recherche: 1 }),
};
let imageAppele = null;
const api = A.cree({ cles, cours: async () => COURS, solde, outils, actifs: () => ({ recherche: true }),
  agent: async (q) => { agentAppele = q; return { ok: true, texte: 'Answer.', sources: [], factureSwoge: '321.5', factureUsd: 0.009, solde: '999', etapes: 3 }; },
  image: async (q) => { imageAppele = q; return { ok: true, urls: ['/studio/media/fichier/' + 'a'.repeat(48) + '.jpg', 'https://imgen.x.ai/b.png'], factureSwoge: '4284.18', factureUsd: 0.12, solde: '900', compris: 'SWOGE on a boat', reference: 'swoge' }; },
  urlPublique: (u) => (/^\/studio\//.test(u) ? 'https://srv.example' + u : u) });

(async () => {
  console.log('-- 1. les cles --');
  const r1 = cles.nouvelle(ADDR, 'my <bot>', 50000);
  ok(r1.ok && /^swg_[A-Za-z0-9_-]{43}$/.test(r1.cle), 'une cle est creee par la session, montree en clair UNE fois');
  const disque = fs.readFileSync(fichier, 'utf8');
  ok(!disque.includes(r1.cle) && disque.includes(K.empreinte(r1.cle)), 'le disque ne garde que son empreinte SHA-256, jamais la cle');
  ok(!JSON.stringify(cles.liste(ADDR)).includes(r1.cle) && cles.liste(ADDR)[0].nom === 'my bot', 'la liste ne rend jamais la cle ; le nom est nettoye');
  eq(cles.resout(r1.cle).addr, ADDR, 'la cle resout vers l adresse de la session qui l a creee');
  eq(cles.resout('swg_faux'), null, 'une cle inconnue ne resout rien');
  ok(cles.nouvelle(ADDR, 'x', 0).code === 400 && cles.nouvelle(ADDR, 'x', 1e12).code === 400, 'le plafond par jour est obligatoire et borne');
  const enClair = {};
  for (let i = 0; i < 4; i++) enClair['k' + i] = cles.nouvelle(ADDR, 'k' + i, 100).cle;
  eq(cles.nouvelle(ADDR, 'sixieme', 100).code, 409, 'au plus ' + K.MAX_ACTIVES + ' cles vivantes par adresse');
  ok(cles.nouvelle(AUTRE, 'autre', 100).ok, 'une autre adresse a les siennes');
  const k2 = cles.liste(ADDR).find((c) => c.nom === 'k0');
  ok(cles.revoque(AUTRE, k2.id).code === 404, 'une adresse ne revoque pas la cle d une autre');
  ok(cles.resout(enClair.k0) && cles.revoque(ADDR, k2.id).ok, 'revoquer');
  eq(cles.resout(enClair.k0), null, 'une cle revoquee ne resout plus');

  console.log('\n-- 2. l API payee a l appel --');
  const cle = cles.resout(r1.cle);
  const cat = await api.catalogue();
  const sc = cat.outils.find((o) => o.name === 'scan_token');
  ok(sc.prix.usd === 0.01 && Math.abs(sc.prix.swoge - 0.01 / COURS) < 1, 'le catalogue dit le prix de chaque outil, en $ et en $SWOGE [' + sc.prix.swoge + ']');
  ok(cat.outils.find((o) => o.name === 'web_search').prix.usd === 0.0075, 'la recherche web se vend a son cout Perplexity × 1,5');
  ok(cat.outils.find((o) => o.name === 'ask_agent').prix.variable === true, 'ask_agent : cout reel, avec son maximum');
  const d = await api.appelle({ cle, outil: 'scan_token', args: { address: '0x' + '1'.repeat(40) }, devis: true });
  ok(d.ok && d.devis.swoge === sc.prix.swoge && sol.reserves.length === 0, 'un devis rend le prix SANS rien reserver');
  const r = await api.appelle({ cle, outil: 'scan_token', args: { address: '0x' + '1'.repeat(40) } });
  ok(r.ok && r.resultat.token.sym === 'PEPE' && /Token 0x1111/.test(r.texte) && /^[0-9a-f]{16}$/.test(r.recu), 'l appel rend les donnees, le texte, un recu');
  ok(sol.regles[0].fw === sol.reserves[0].w && sol.reserves[0].a === ADDR, 'debite le prix exact, sur l adresse de la CLE');
  eq(cles.recus(ADDR)[0].id, r.recu, 'le recu est garde, lisible par le joueur');
  const nReg = sol.regles.length;
  const bad = await api.appelle({ cle, outil: 'scan_token', args: { address: 'pepe' } });
  ok(bad.code === 400 && sol.regles.length === nReg && sol.reserves.length === 1, 'une entree invalide est refusee AVANT tout debit');
  panne = true;
  const p = await api.appelle({ cle, outil: 'scan_token', args: { address: '0x' + '2'.repeat(40) } });
  panne = false;
  ok(p.code === 502 && sol.regles[sol.regles.length - 1].fw === 0n, 'un outil en panne : tout est rendu');
  const e = await api.appelle({ cle, outil: 'swoge_economy', args: {} });
  ok(e.code === 400 && sol.regles[sol.regles.length - 1].fw === 0n, 'un outil qui rend une erreur : tout est rendu, rien facture');
  ok((await api.appelle({ cle: null, outil: 'scan_token', args: {} })).code === 401, 'sans cle : 401');
  ok((await api.appelle({ cle, outil: 'buy_token', args: {} })).code === 404, 'un outil qui n existe pas : 404 (et il n existe aucun outil d achat)');
  const col = await api.appelle({ cle, outil: 'colony_activity', args: {} });
  ok(col.ok && col.resultat.status === 'running', 'les donnees JSON reviennent en objet');
  sol.refuse = true;
  ok((await api.appelle({ cle, outil: 'colony_activity', args: {} })).code === 402, 'solde insuffisant : 402');
  sol.refuse = false;

  /* Le plafond par jour. */
  const petite = cles.nouvelle(AUTRE, 'petite', 400);
  const cp = cles.resout(petite.cle);
  const a1 = await api.appelle({ cle: cp, outil: 'scan_token', args: { address: '0x' + '3'.repeat(40) } });
  const a2 = await api.appelle({ cle: cp, outil: 'scan_token', args: { address: '0x' + '3'.repeat(40) } });
  ok(a1.ok && a2.code === 402 && /daily spending cap/.test(a2.raison), 'le plafond de 400 $SWOGE par jour tient : le deuxieme scan (357 chacun) est refuse');
  t += 864e5;
  ok((await api.appelle({ cle: cp, outil: 'scan_token', args: { address: '0x' + '3'.repeat(40) } })).ok, 'et il repart le lendemain');

  /* La tache entiere. */
  const aa = await api.appelle({ cle, outil: 'ask_agent', args: { task: 'what is the colony doing?' } });
  ok(aa.ok && agentAppele.addr === ADDR && aa.facture.swoge === '321.5' && aa.resultat.steps === 3, 'ask_agent : la tache part au nom de l adresse de la cle, facturee au reel');
  const aq = await api.appelle({ cle, outil: 'ask_agent', args: { task: 'x' }, devis: true });
  ok(aq.ok && aq.devis.variable && aq.devis.maxSwoge > 0, 'et son devis dit le maximum');
  ok((await api.appelle({ cle: cp, outil: 'ask_agent', args: { task: 'x' } })).code === 402, 'une cle dont le plafond ne couvre pas le maximum de la tache est refusee avant de lancer l agent');
  ok((await api.appelle({ cle, outil: 'ask_agent', args: { task: 'x', model: 'gpt-6-sol' } })).code === 400, 'ask_agent ne tourne que sur Claude');

  /* Les outils ajoutes le 26 septembre : prix, entrees refusees avant debit, image au reel. */
  ok(cat.outils.find((o) => o.name === 'new_launches').prix.usd === 0.005 && cat.outils.find((o) => o.name === 'wallet_intel').prix.usd === 0.02 && cat.outils.find((o) => o.name === 'osint_lookup').prix.usd === 0.02,
     'lancements 0,005 $, lanceur 0,02 $, OSINT 0,02 $ (prix de depart)');
  const nReg2 = sol.regles.length;
  ok((await api.appelle({ cle, outil: 'wallet_intel', args: { address: 'x' } })).code === 400 && (await api.appelle({ cle, outil: 'generate_image', args: { prompt: 'x', count: 3 } })).code === 400
     && sol.regles.length === nReg2, 'une entree invalide (adresse, nombre d images) est refusee avant tout debit');
  const iq = await api.appelle({ cle, outil: 'generate_image', args: { prompt: 'swoge on a boat', provider: 'openai' }, devis: true });
  ok(iq.ok && iq.devis.variable && Number(iq.devis.maxSwoge) > 0 && imageAppele === null, 'le devis d une image : son maximum, sans rien generer');
  const im = await api.appelle({ cle, outil: 'generate_image', args: { prompt: 'swoge on a boat', count: 2 } });
  ok(im.ok && imageAppele.addr === ADDR && imageAppele.fournisseur === 'grok' && imageAppele.n === 2, 'l image part au nom de l adresse de la cle, Grok par defaut, le nombre demande');
  ok(im.resultat.images[0] === 'https://srv.example/studio/media/fichier/' + 'a'.repeat(48) + '.jpg' && im.resultat.understoodAs === 'SWOGE on a boat', 'une image rangee chez nous revient en adresse ABSOLUE, avec la demande comprise');
  ok(im.facture.swoge === '4284.18' && cles.recus(ADDR)[0].outil === 'generate_image', 'facturee au reel, avec son recu');
  const petite2 = cles.resout(cles.nouvelle(AUTRE, 'mini', 50).cle);
  ok((await api.appelle({ cle: petite2, outil: 'generate_image', args: { prompt: 'x' } })).code === 402, 'un plafond qui ne couvre pas le maximum de l image : refuse avant de generer');

  console.log('\n-- 3. MCP, epoque heritee (initialize) --');
  const deps = { agentic: api, actifs: () => ({ recherche: true }) };
  const post = (corps, entetes, c) => MCP.traite({ methode: 'POST', entetes: entetes || {}, corps: JSON.stringify(corps), cle: c === undefined ? cle : c, origines: ['https://claude.ai'] }, deps);
  const lit = (x) => JSON.parse(x.corps);
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  const ir = lit(init).result;
  ok(init.status === 200 && ir.protocolVersion === '2025-06-18' && ir.capabilities.tools && ir.serverInfo.name === 'swogeagentic', 'initialize : la version demandee est rendue, avec la capacite tools');
  eq(lit(await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).result.protocolVersion, '2025-11-25', 'une version inconnue : la plus recente des heritees');
  ok(!init.entetes['mcp-session-id'], 'aucun identifiant de session emis');
  eq((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202, 'une notification : 202 sans corps');
  const tl = lit(await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools;
  ok(tl.length === A.definitions({ recherche: true }).length && tl.every((x) => x.inputSchema && x.inputSchema.type === 'object' && x.annotations.readOnlyHint === true), 'tools/list : tous les outils du catalogue, schemas objets, marques lecture seule');
  ok(tl.every((x) => x.inputSchema.properties.quote), 'chaque outil accepte « quote » pour connaitre son prix');
  const tc = lit(await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scan_token', arguments: { address: '0x' + '4'.repeat(40) } } })).result;
  ok(tc.isError === false && /Token 0x4444/.test(tc.content[0].text) && /billed .* \$SWOGE/.test(tc.content[0].text) && tc.structuredContent.receipt, 'tools/call : le texte pour le modele, la facture et le recu');
  const tq = lit(await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'scan_token', arguments: { address: '0x' + '4'.repeat(40), quote: true } } })).result;
  ok(/^Price: \d+(\.\d+)? \$SWOGE/.test(tq.content[0].text), 'quote : le prix, sans rien payer');
  const sans = lit(await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'scan_token', arguments: { address: '0x' + '4'.repeat(40) } } }, {}, null)).result;
  ok(sans.isError && /Authorization: Bearer swg_/.test(sans.content[0].text), 'sans cle : une erreur d outil que le modele peut lire, qui dit quoi faire');
  const inv = lit(await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } }));
  ok(inv.error && inv.error.code === -32602, 'outil inconnu : erreur de protocole -32602');
  eq(lit(await post({ jsonrpc: '2.0', id: 8, method: 'ping' })).result && 'ok', 'ok', 'ping');

  console.log('\n-- 4. MCP, epoque moderne (2026-07-28) --');
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const H = (method, name) => Object.assign({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method }, name ? { 'Mcp-Name': name } : {});
  const disc = await post({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta } }, H('server/discover'));
  const dr = lit(disc).result;
  ok(disc.status === 200 && dr.resultType === 'complete' && dr.supportedVersions[0] === '2026-07-28' && dr.supportedVersions.includes('2025-11-25') && dr._meta['io.modelcontextprotocol/serverInfo'].name === 'swogeagentic',
     'server/discover : versions servies (les deux epoques), capacites, identite dans _meta');
  const ml = lit(await post({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: meta } }, H('tools/list'))).result;
  ok(ml.resultType === 'complete' && ml.tools.length === tl.length, 'tools/list moderne');
  const mc = lit(await post({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { _meta: meta, name: 'colony_activity', arguments: {} } }, H('tools/call', 'colony_activity'))).result;
  ok(mc.resultType === 'complete' && mc.isError === false, 'tools/call moderne');
  const b64 = lit(await post({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { _meta: meta, name: 'colony_activity', arguments: {} } }, H('tools/call', '=?base64?' + Buffer.from('colony_activity').toString('base64') + '?='))).result;
  ok(b64 && b64.isError === false, 'un Mcp-Name en base64 « sentinelle » est decode avant comparaison');
  const mis = await post({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { _meta: meta, name: 'colony_activity', arguments: {} } }, H('tools/call', 'scan_token'));
  ok(mis.status === 400 && lit(mis).error.code === -32020, 'Mcp-Name different du corps : 400 HeaderMismatch (-32020)');
  const manq = await post({ jsonrpc: '2.0', id: 13, method: 'tools/list', params: { _meta: meta } }, {});
  ok(manq.status === 400 && lit(manq).error.code === -32020, 'en-tetes obligatoires absents : 400 -32020');
  const ver = await post({ jsonrpc: '2.0', id: 14, method: 'tools/list', params: { _meta: Object.assign({}, meta, { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }) } },
    { 'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'tools/list' });
  ok(ver.status === 400 && lit(ver).error.code === -32022 && lit(ver).error.data.supported.includes('2026-07-28'), 'version non servie : 400 -32022 avec les versions servies');
  const inc = await post({ jsonrpc: '2.0', id: 15, method: 'prompts/list', params: { _meta: meta } }, H('prompts/list'));
  ok(inc.status === 404 && lit(inc).error.code === -32601, 'methode inconnue : 404 -32601');

  console.log('\n-- 5. le transport --');
  eq((await MCP.traite({ methode: 'GET', entetes: {}, corps: '', cle, origines: [] }, deps)).status, 405, 'GET : 405 (aucun flux ouvert par le serveur)');
  eq((await MCP.traite({ methode: 'DELETE', entetes: {}, corps: '', cle, origines: [] }, deps)).status, 405, 'DELETE : 405 (aucune session)');
  eq((await MCP.traite({ methode: 'POST', entetes: { Origin: 'https://evil.example' }, corps: '{}', cle, origines: ['https://claude.ai'] }, deps)).status, 403, 'Origin hors liste : 403 (rebinding DNS)');
  eq((await MCP.traite({ methode: 'POST', entetes: {}, corps: 'nope', cle, origines: [] }, deps)).status, 400, 'JSON illisible : 400');
  eq((await MCP.traite({ methode: 'POST', entetes: {}, corps: '[]', cle, origines: [] }, deps)).status, 400, 'un lot (tableau) : 400, un message par POST');

  console.log('\n-- 6. ce que la route garantit --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const i = src.indexOf("path === '/agentic/tools' ||"), bloc = src.slice(i, src.indexOf('SWOGEAGENTIC — UN AGENT AUX OUTILS', i));
    ok(/API keys cannot manage keys/.test(bloc) && /const session = !cleTexte && porteur \? sessionJoueur\.lire/.test(bloc), 'une cle d API ne cree ni ne revoque de cle : seule la session signee le fait');
    const code = ['agentic.js', 'agentic_mcp.js', 'agentic_cles.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    ok(!/require\('\.\/miroir'\)|surAchat|sendTransaction|signTransaction/.test(code), 'aucun outil n achete, ne vend ni ne signe');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
