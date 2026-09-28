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
 *   4. aucune cle ne gere les cles, aucun outil n'achete ni ne signe ;
 *   7. (lot Base, 27 septembre 2026) ask_agent en x402 derriere X402_AGENT=1 :
 *      prix fixe, bornes avant tout paiement, registre des pertes durable,
 *      payeur bloque refuse a la verification ; la forme MCP des reponses x402.
 */
const fs = require('fs'), os = require('os'), path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
process.env.STUDIO_MARGE = '1.5';
delete process.env.AGENTIC_PRIX;
/* Le reglage par defaut : telegram_calls n'est pas vendu (section 5 quater). */
delete process.env.TG_APPELS_VENTE;

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
  /* La licence GoPlus : « Powered by Go+ Security », avec un lien, sur chaque resultat vendu. */
  eq(JSON.stringify(r.resultat.attribution), JSON.stringify({ security: 'Powered by Go+ Security', url: 'https://gopluslabs.io' }), 'scan_token paye : l attribution GoPlus en donnees');
  ok(/Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(r.texte) && r.texte.split('Powered by Go+ Security').length === 2,
     'et dans le texte que lit l agent, une fois (ajoutee si la fiche ne la portait pas)');
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
  ok(cat.outils.find((o) => o.name === 'new_launches').prix.usd === 0.005 && cat.outils.find((o) => o.name === 'wallet_intel').prix.usd === 0.008 && cat.outils.find((o) => o.name === 'osint_lookup').prix.usd === 0.008,
     'lancements 0,005 $, lanceur 0,008 $, OSINT 0,008 $ (la baisse du 28/09, par cle)');
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
  ok(/Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(tc.content[0].text) && tc.structuredContent.result.attribution.url === 'https://gopluslabs.io',
     'MCP : scan_token porte « Powered by Go+ Security » dans le texte ET dans structuredContent');
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

  console.log('\n-- 5 ter. videos et images pour les agents (26 septembre 2026) --');
  {
    let lance = null;
    const JOB = { id: 'f'.repeat(24) };
    const apiV = A.cree({ cles, cours: async () => COURS, solde, outils, actifs: () => ({ recherche: true }),
      image: async (q) => { imageAppele = q; return { ok: true, urls: ['https://imgen.x.ai/c.png'], factureSwoge: '10', factureUsd: 0.05, solde: '1' }; },
      video: async (q) => { lance = q; return { ok: true, id: JOB.id, status: 'pending', duree: q.duree, resolution: '480p' }; },
      etatVideo: (id, addr) => (id === JOB.id && addr === ADDR ? { ok: true, id, status: 'done', progress: 100, url: '/studio/media/fichier/' + 'v'.repeat(48) + '.mp4', duree: 6, factureSwoge: '20000', factureUsd: 0.5 } : { ok: false, code: 404, raison: 'unknown video' }),
      imageHorsSolde: async (q) => { imageAppele = q; return { ok: true, urls: ['https://imgen.x.ai/d.png'] }; },
      urlPublique: (u) => (/^\/studio\//.test(u) ? 'https://srv.example' + u : u) });
    const kv = cles.nouvelle(ADDR, 'video bot', 200000).cle;
    const cle = cles.resout(kv);
    const soldeAvant = sol.reserves.length;
    const v = await apiV.appelle({ cle, outil: 'generate_video', args: { prompt: 'SWOGE surfing', quality: 'quality', duration: 10, aspect_ratio: '16:9' } });
    ok(v.ok && v.resultat.id === JOB.id && v.resultat.poll === 'video_status' && v.facture.aLArrivee, 'generate_video : un id a suivre, facture a l arrivee');
    ok(lance && lance.addr === ADDR && lance.modele === 'qualite' && lance.duree === 10 && lance.format === '16:9', 'lancee au nom de l adresse de la CLE, avec les reglages demandes');
    eq(sol.reserves.length, soldeAvant, 'l API ne reserve rien elle-meme : c est studio_media qui reserve, suit et regle (meme fonction que la page)');
    const recu = cles.recus(ADDR).find((x) => x.video === JOB.id);
    ok(recu && recu.maximum === true && Number(recu.swoge) > 0, 'le plafond du jour compte le MAXIMUM de la video tout de suite (recu marque « maximum »)');
    const st = await apiV.appelle({ cle, outil: 'video_status', args: { id: JOB.id } });
    ok(st.ok && st.resultat.status === 'done' && /^https:\/\/srv\.example\/studio\/media\/fichier\//.test(st.resultat.url) && st.facture.swoge === '0', 'video_status : l URL publique, et c est gratuit');
    const autreCle = cles.resout(cles.nouvelle(AUTRE, 'x', 1000).cle);
    ok((await apiV.appelle({ cle: autreCle, outil: 'video_status', args: { id: JOB.id } })).code === 404, 'la video d un AUTRE : 404, jamais lue');
    const im = await apiV.appelle({ cle, outil: 'generate_image', args: { prompt: 'a cat', quality: 'speed', aspect_ratio: '1:1' } });
    ok(im.ok && imageAppele.modele === 'rapide' && imageAppele.format === '1:1', 'generate_image : qualite et format passent jusqu au fournisseur');
    ok((await apiV.appelle({ cle, outil: 'generate_image', args: { prompt: 'x', aspect_ratio: '5:1' } })).code === 400, 'un format inconnu : 400, rien facture');
    const hs = await apiV.sertSansFacture({ outil: 'generate_image', args: { prompt: 'a cat', count: 2 }, payeur: '0xAbC' + '0'.repeat(37) });
    ok(hs.ok && imageAppele.addr === 'x402:0xabc' + '0'.repeat(37) && imageAppele.n === 2 && imageAppele.prixUsd === A.prixX402Usd('generate_image', { prompt: 'a cat', count: 2 }),
       'payee d avance (x402) : generee HORS SOLDE au nom du payeur, avec le prix encaisse (pour mesurer le cout reel contre lui)');
    ok(apiV.x402Payable('generate_image') && !apiV.x402Payable('generate_video') && !apiV.x402Payable('video_status') && !apiV.x402Payable('ask_agent'),
       'x402 : les images oui (prix fixe par demande) ; video, statut et agent non');
    ok(A.prixX402Usd('generate_image', { prompt: 'x', count: 4 }) > 3 * A.prixX402Usd('generate_image', { prompt: 'x', count: 1 }), 'le prix x402 d une image suit le nombre');
  }

  console.log('\n-- 5 bis. llms.txt --');
  {
    const U = { api: 'https://api.example', site: 'https://site.example', page: 'https://site.example/swogeagentic.html', docs: 'https://site.example/swogeagentic_api.html' };
    const txt = A.llmsTxt(await api.catalogue(), Object.assign({ swoge: true }, U));
    ok(/^# SwogeAgentic\n\n> /.test(txt) && !/^#{3,} /m.test(txt), 'format llmstxt.org : H1, resume en citation, pas de titre plus profond');
    eq(txt.split('\n').filter((l) => /^## /.test(l)).join(','), '## Docs,## Optional', 'les liens sous des H2, « Optional » en dernier');
    ok(A.definitions({ recherche: true }).every((d) => txt.includes('`' + d.name + '(')), 'chaque outil du catalogue y est, avec ses arguments');
    ok(/\$0\.01 \(\d+(\.\d+)? \$SWOGE\)/.test(txt) && !/\$0\.01 \(/.test(A.llmsTxt(await api.catalogue(), Object.assign({ swoge: false }, U))), 'la version en direct dit le prix en $SWOGE ; la copie du site, en $ seulement');
    /* La copie publiee sur le site ne doit pas vieillir en silence : memes outils que le catalogue. */
    const site = path.join(__dirname, '..', 'SWOGE.github.io', 'llms.txt');
    if (fs.existsSync(site)) {
      const publie = fs.readFileSync(site, 'utf8');
      const noms = (t) => (t.match(/^- `([a-z_]+)\(/gm) || []).map((x) => x.slice(3, -1)).join(',');
      eq(noms(publie), noms(txt), 'le llms.txt du site liste exactement les outils du catalogue (sinon : node outils/llms_site.js > ../SWOGE.github.io/llms.txt)');
      /* Mot pour mot : une description qui change (l'attribution GoPlus, le 26 septembre 2026) doit y arriver aussi. */
      const genere = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'outils', 'llms_site.js')], { env: process.env, encoding: 'utf8' });
      ok(publie === genere, 'le llms.txt du site = la sortie de outils/llms_site.js, mot pour mot (sinon : le regenerer)');
    }
  }

  console.log('\n-- 5 quater. telegram_calls : pas vendu sans TG_APPELS_VENTE=1 (conditions de Telegram, 26 septembre 2026) --');
  {
    let lus = 0;
    const outilsT = Object.assign({}, outils, { telegram_calls: async () => { lus++; return { texte: JSON.stringify({ calls: [], channels: [] }) }; } });
    const apiT = A.cree({ cles, cours: async () => COURS, solde, outils: outilsT, actifs: () => ({ recherche: true }) });
    const cleT = cles.resout(cles.nouvelle('0x' + 'ef'.repeat(20), 'tg', 100000).cle);
    const U = { api: 'https://api.example', site: 'https://site.example', page: 'https://site.example/p', docs: 'https://site.example/d' };
    const depsT = { agentic: apiT, actifs: () => ({ recherche: true }) };
    const mcpT = async (corps) => JSON.parse((await MCP.traite({ methode: 'POST', entetes: {}, corps: JSON.stringify(corps), cle: cleT, origines: [] }, depsT)).corps);
    const nRes = sol.reserves.length;
    /* Eteint (le defaut) : absent de tout ce qui se lit, et l'appeler = un outil inconnu, mot pour mot. */
    const catT = await apiT.catalogue();
    ok(!catT.outils.some((o) => o.name === 'telegram_calls') && !A.definitions({ recherche: true }).some((d) => d.name === 'telegram_calls'), 'eteint : absent du catalogue et des definitions publiques');
    ok(!A.llmsTxt(catT, U).includes('telegram_calls'), 'eteint : absent de llms.txt');
    const tg = await apiT.appelle({ cle: cleT, outil: 'telegram_calls', args: { hours: 12 } });
    const inc = await apiT.appelle({ cle: cleT, outil: 'nope_tool', args: { hours: 12 } });
    ok(tg.code === 404 && tg.raison === 'unknown tool: telegram_calls' && JSON.stringify(Object.keys(tg)) === JSON.stringify(Object.keys(inc)) && inc.code === 404,
       'eteint : appele par une cle, 404 « unknown tool », la meme reponse qu un nom invente');
    ok((await apiT.appelle({ cle: cleT, outil: 'telegram_calls', args: {}, devis: true })).code === 404, 'eteint : pas de devis non plus');
    ok((await apiT.sertSansFacture({ outil: 'telegram_calls', args: {}, payeur: '0x' + '9'.repeat(40) })).code === 404 && !apiT.x402Payable('telegram_calls'), 'eteint : ni payable ni servi en x402');
    ok(sol.reserves.length === nRes && lus === 0, 'eteint : rien reserve, rien debite, le suivi jamais lu');
    const lT = (await mcpT({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
    const cT = await mcpT({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'telegram_calls', arguments: {} } });
    const cI = await mcpT({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope_tool', arguments: {} } });
    ok(!lT.some((x) => x.name === 'telegram_calls') && cT.error && cT.error.code === -32602 && cT.error.code === cI.error.code, 'eteint : absent de tools/list MCP ; tools/call → -32602 comme un outil inconnu');
    /* Allume : il revient partout, au prix de depart, et se facture comme les autres. */
    process.env.TG_APPELS_VENTE = '1';
    const catOn = await apiT.catalogue();
    const tgc = catOn.outils.find((o) => o.name === 'telegram_calls');
    ok(tgc && tgc.prix.usd === 0.01 && A.llmsTxt(catOn, U).includes('`telegram_calls(channel?, hours?, limit?)`'), 'TG_APPELS_VENTE=1 : au catalogue (0,01 $) et dans llms.txt');
    const on = await apiT.appelle({ cle: cleT, outil: 'telegram_calls', args: { hours: 12 } });
    ok(on.ok && lus === 1 && sol.reserves.length === nRes + 1 && apiT.x402Payable('telegram_calls'), 'TG_APPELS_VENTE=1 : servi, facture, payable en x402');
    ok((await mcpT({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.some((x) => x.name === 'telegram_calls'), 'TG_APPELS_VENTE=1 : dans tools/list MCP');
    ok((await apiT.appelle({ cle: cleT, outil: 'telegram_calls', args: { hours: 999 } })).code === 400, 'TG_APPELS_VENTE=1 : des heures hors [1 ; 168] refusees avant debit');
    delete process.env.TG_APPELS_VENTE;
  }

  console.log('\n-- 5 quinquies. x402 : scan_token porte aussi l attribution GoPlus --');
  {
    const x = await api.sertSansFacture({ outil: 'scan_token', args: { address: '0x' + '5'.repeat(40) }, payeur: '0x' + '9'.repeat(40) });
    ok(x.ok && x.resultat.attribution && x.resultat.attribution.security === 'Powered by Go+ Security' && /Powered by Go\+ Security/.test(x.texte), 'paye d avance (x402) : la meme attribution, en donnees et en texte');
  }

  console.log('\n-- 5 sexies. sans cle : le devis gratuit, le refus qui dit comment payer, les compteurs (26 septembre 2026) --');
  {
    const notes = [];
    let ouvert = true, devisX = 0;
    const apiS = A.cree({ cles, cours: async () => COURS, solde, outils, actifs: () => ({ recherche: true }),
      note: (e, i) => notes.push(Object.assign({ e }, i)), urls: { page: 'https://site.example/swogeagentic.html', api: 'https://api.example' },
      x402: { actif: () => ouvert, devis: async (o) => { devisX++; return { x402Version: 2, accepts: [{ scheme: 'exact', amount: '20056', extra: { assetTransferMethod: 'eip3009' } }], resource: { url: 'https://api.example/agentic/call/' + o } }; } } });
    const nRes = sol.reserves.length, nReg = sol.regles.length;
    const q = await apiS.appelle({ cle: null, outil: 'scan_token', args: {}, devis: true, canal: 'rest', qui: 'ip:1' });
    ok(q.ok && q.quote === true && q.tool === 'scan_token' && q.priceUsd === 0.01 && q.devis.usd === 0.01 && q.x402.accepts[0].amount === '20056' && devisX === 1,
       'devis sans cle ni arguments : le prix par cle (0,01 $) et, x402 ouvert, ses exigences');
    ok(sol.reserves.length === nRes && sol.regles.length === nReg, 'rien reserve, rien regle');
    ok(/https:\/\/site\.example\/swogeagentic\.html/.test(q.howToPay) && q.howToPay.includes('POST https://api.example/agentic/call/scan_token'), 'howToPay : la page des cles, et x402 a l adresse de l outil');
    const aq = await apiS.appelle({ cle: null, outil: 'ask_agent', args: {}, devis: true, qui: 'ip:1' });
    ok(aq.ok && aq.priceUsd === aq.devis.maxUsd && !aq.x402 && /needs an API key/.test(aq.howToPay), 'ask_agent (prix variable) : son maximum, pas de x402 — la cle seulement');
    const vs = await apiS.appelle({ cle: null, outil: 'video_status', args: {}, devis: true, qui: 'ip:1' });
    ok(vs.ok && vs.priceUsd === 0 && vs.devis.gratuit, 'video_status : un devis a 0, sans rien lire');
    const refus = await apiS.appelle({ cle: null, outil: 'colony_activity', args: {}, canal: 'mcp', qui: 'ip:2' });
    ok(refus.code === 401 && refus.sansCle && /Authorization: Bearer swg_/.test(refus.raison) && refus.raison.includes('POST https://api.example/agentic/call/colony_activity') && /"quote": true/.test(refus.raison),
       'un appel sans cle : 401 qui dit tout — la cle, x402 a cette adresse, le devis gratuit');
    ouvert = false;
    ok(!/x402/.test((await apiS.appelle({ cle: null, outil: 'colony_activity', args: {}, qui: 'ip:2' })).raison), 'x402 eteint : il n est pas propose');
    ok((await apiS.appelle({ cle: null, clePresentee: true, outil: 'scan_token', args: {}, devis: true })).code === 401, 'une cle PRESENTEE mais inconnue : 401, meme pour un devis');
    ok((await apiS.appelle({ cle: null, outil: 'nope', args: {}, devis: true })).code === 404, 'un outil inconnu : 404, cle ou pas');
    let premier = 0;
    for (let i = 1; i <= 70 && !premier; i++) if ((await apiS.appelle({ cle: null, outil: 'swoge_economy', args: {}, devis: true, qui: 'ip:3' })).code === 429) premier = i;
    ok(premier === A.DEVIS_PAR_MINUTE + 1 && (await apiS.appelle({ cle: null, outil: 'swoge_economy', args: {}, devis: true, qui: 'ip:4' })).ok,
       'au plus ' + A.DEVIS_PAR_MINUTE + ' devis sans cle par minute et par IP (le ' + premier + 'e : 429) ; une autre IP n est pas touchee');
    /* Les compteurs : devis (qui = l IP sans cle, l adresse avec), refus, paye par cle, echec. */
    notes.length = 0;
    await apiS.appelle({ cle, outil: 'scan_token', args: { address: '0x' + '6'.repeat(40) }, devis: true, canal: 'mcp' });
    await apiS.appelle({ cle, outil: 'scan_token', args: { address: '0x' + '6'.repeat(40) }, canal: 'rest' });
    panne = true; await apiS.appelle({ cle, outil: 'scan_token', args: { address: '0x' + '7'.repeat(40) }, canal: 'rest' }); panne = false;
    const r0 = notes.map((x) => x.e + ':' + x.canal + ':' + (x.qui === ADDR) + ':' + (x.usd === undefined ? '-' : x.usd) + (x.sorte ? ':' + x.sorte : '')).join(' | ');
    eq(r0, 'devis:mcp:true:- | paye_cle:rest:true:0.01 | echec:rest:true:-:outil', 'les compteurs recoivent : le devis, le paiement par cle (0,01 $), l echec — avec le canal et l adresse de la CLE');
    const mcpS = async (corps, req) => JSON.parse((await MCP.traite(Object.assign({ methode: 'POST', entetes: {}, corps: JSON.stringify(corps), cle: null, origines: [] }, req || {}), { agentic: apiS, actifs: () => ({ recherche: true }), api: 'https://api.example' })).corps);
    ouvert = true;
    const mq = (await mcpS({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'colony_activity', arguments: { quote: true } } }, { qui: 'ip:5' })).result;
    ok(mq.isError === false && mq.structuredContent.quote === true && mq.structuredContent.priceUsd === 0.005 && mq.structuredContent.x402 && /^Price: .*Without an account \(x402\): USDG 0\.020056/.test(mq.content[0].text),
       'MCP sans cle, quote: true : le devis, isError false, x402 dans le texte et structuredContent');
    const mr = (await mcpS({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'colony_activity', arguments: {} } }, { qui: 'ip:5' })).result;
    ok(mr.isError === true && mr.content[0].text.includes('POST https://api.example/agentic/call/colony_activity') && !/^Error: missing/.test(mr.content[0].text), 'MCP sans cle, un appel : isError, avec la marche a suivre');
    const mk = (await mcpS({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'colony_activity', arguments: { quote: true } } }, { clePresentee: true })).result;
    ok(mk.isError === true && /invalid or revoked API key/.test(mk.content[0].text), 'MCP, cle presentee mais inconnue : refusee, devis compris');
    const ini = JSON.parse((await MCP.traite({ methode: 'POST', entetes: {}, corps: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-11-25' } }), cle: null, origines: [] }, { agentic: apiS, actifs: () => ({ recherche: true }), api: 'https://api.example' })).corps).result;
    ok(/No key needed/.test(ini.instructions) && ini.instructions.includes('POST https://api.example/agentic/call/<tool>') && ini.serverInfo.version === '1.0.1', 'les instructions MCP : devis sans cle, x402 en REST a cette adresse ; version 1.0.1');
  }

  console.log('\n-- 6. ce que la route garantit --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const i = src.indexOf("path === '/agentic/tools' ||"), bloc = src.slice(i, src.indexOf('SWOGEAGENTIC — UN AGENT AUX OUTILS', i));
    ok(/API keys cannot manage keys/.test(bloc) && /const session = !cleTexte && porteur \? sessionJoueur\.lire/.test(bloc), 'une cle d API ne cree ni ne revoque de cle : seule la session signee le fait');
    const code = ['agentic.js', 'agentic_mcp.js', 'agentic_cles.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    ok(!/require\('\.\/miroir'\)|surAchat|sendTransaction|signTransaction/.test(code), 'aucun outil n achete, ne vend ni ne signe');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  /* ==================================================================
   * 7. ASK_AGENT EN x402 ET x402 SUR MCP (lot Base, contrat §C, §D, §F.3, 27 septembre 2026)
   * ================================================================== */
  console.log('\n-- 7. ask_agent en x402 (X402_AGENT=1), et x402 sur MCP --');
  {
    const R = require('./x402_agent');
    const Agent = require('./studio_agent');
    const fr = path.join(dir, 'x402_agent.json');
    let tR = Date.UTC(2026, 8, 27, 12, 0, 0);
    const reg = R.cree({ fichier: fr, maintenant: () => tR });
    let anthropic = false, agentX = null, repAgent = null;
    const apiX = A.cree({ cles, cours: async () => COURS, solde, outils, actifs: () => ({ recherche: true }),
      agentX402: { actif: () => anthropic, registre: reg },
      agentHorsSolde: async (q) => { agentX = q; return repAgent; } });
    delete process.env.X402_AGENT;
    ok(!apiX.x402Payable('ask_agent') && A.prixX402Usd('ask_agent') === null, 'sans X402_AGENT=1 : ask_agent n est pas payable en x402, pas de prix (cle seulement, comme avant)');
    process.env.X402_AGENT = '1';
    ok(!apiX.x402Payable('ask_agent'), 'X402_AGENT=1 mais Anthropic eteint : pas payable');
    anthropic = true;
    ok(apiX.x402Payable('ask_agent'), 'X402_AGENT=1 et Anthropic allume : payable');
    eq(A.prixX402Usd('ask_agent'), 0.54, 'le prix FIXE : plafond 0,36 $ × STUDIO_MARGE 1,5, au cent superieur');
    process.env.X402_AGENT_BUDGET_USD = '0.313';
    eq(A.prixX402Usd('ask_agent'), 0.47, 'un autre plafond (0,313 $ : sans recherche, contrat §D.3) : 0,47 $');
    delete process.env.X402_AGENT_BUDGET_USD;
    /* Les bornes x402, AVANT toute demande de paiement. */
    ok(/too long for x402 \(max 2000/.test(A.entreeInvalideX402('ask_agent', { task: 'x'.repeat(2001) })) && A.entreeInvalideX402('ask_agent', { task: 'x'.repeat(2000) }) === null,
       'tache de plus de 2 000 caracteres : refusee en x402 (2 000 passent)');
    ok(/model must be sonnet-5/.test(A.entreeInvalideX402('ask_agent', { task: 'x', model: 'haiku-4-5' })) && A.entreeInvalideX402('ask_agent', { task: 'x', model: 'sonnet-5' }) === null,
       'un autre modele que sonnet-5 : refuse en x402');
    ok(A.entreeInvalide('ask_agent', { task: 'x'.repeat(4000), model: 'haiku-4-5' }) === null && A.entreeInvalideX402('scan_token', { address: 'nope' }) === A.entreeInvalide('scan_token', { address: 'nope' }),
       'avec une cle : rien ne change (4 000 caracteres, tout modele Claude) ; les autres outils : memes refus');
    /* L'execution payee d'avance. */
    repAgent = { ok: true, texte: 'Answer [1].', sources: [{ url: 'https://a.example', titre: 'A' }], jetons: [], etapes: 3, stop: 'end_turn', coutUsd: 0.21, arretBudget: false };
    const s1 = await apiX.sertSansFacture({ outil: 'ask_agent', args: { task: 'is LOBSTER worth a look?' }, payeur: '0x' + 'AB'.repeat(20) });
    ok(s1.ok && s1.resultat.answer === 'Answer [1].' && s1.resultat.steps === 3 && s1.resultat.stoppedByBudget === false && s1._coutUsd === 0.21
       && agentX.addr === 'x402:0x' + 'ab'.repeat(20) && agentX.limites === Agent.LIMITES_X402 && agentX.budgetUsd === 0.36 && agentX.prixUsd === 0.54,
       'servi hors solde, au nom du payeur verifie, avec LIMITES_X402 et le plafond 0,36 $ ; le cout reel garde a part (_coutUsd, jamais rendu)');
    repAgent = { ok: true, texte: '', coutUsd: 0.05, arretBudget: true, stop: 'budget' };
    const s2 = await apiX.sertSansFacture({ outil: 'ask_agent', args: { task: 'x' }, payeur: '0x' + '12'.repeat(20) });
    ok(!s2.ok && s2.code === 502 && /nothing was charged/.test(s2.raison) && reg.pertes24h() === 0.05, 'sans texte : 502, rien encaisse, et ce qu il a coute va au registre des pertes');
    repAgent = { ok: true, texte: 'I cannot help.', stop: 'refusal', coutUsd: 0.01 };
    ok(!(await apiX.sertSansFacture({ outil: 'ask_agent', args: { task: 'x' }, payeur: '0x' + '12'.repeat(20) })).ok && reg.pertes24h() === 0.06, 'un refus du modele : pas un succes, perte inscrite');
    eq((await apiX.sertSansFacture({ outil: 'ask_agent', args: { task: 'x', model: 'haiku-4-5' }, payeur: '0x' + '12'.repeat(20) })).code, 400, 'le chemin paye revérifie les bornes x402 (400)');
    /* Une panne du fournisseur APRES une depense, de bout en bout (studio_agent → studio_chat →
       sertSansFacture) : le cout reel arrive au registre (contrat §D.6 ; revue du 27 septembre 2026). */
    {
      const C = require('./studio_chat'), Jeton = require('./studio_jeton');
      const regP = R.cree({ fichier: path.join(dir, 'x402_agent_panne.json'), maintenant: () => tR });
      const cher = { input_tokens: 30000, output_tokens: 4000 };
      let appelsP = 0;
      const client = { messages: {
        countTokens: async () => ({ input_tokens: 30000 }),
        stream: () => {
          appelsP++;
          if (appelsP === 1) {
            const fin = { content: [{ type: 'text', text: 'step' }, { type: 'tool_use', id: 't1', name: 'colony_activity', input: {} }], stop_reason: 'tool_use', model: 'claude-sonnet-5', usage: cher };
            return { [Symbol.asyncIterator]: async function* () { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'step' } }; }, finalMessage: async () => fin };
          }
          const err = Object.assign(new Error('overloaded'), { status: 529 });
          return { [Symbol.asyncIterator]: async function* () { throw err; }, finalMessage: async () => { throw err; } };
        } } };
      const apiP = A.cree({ cles, cours: async () => COURS, solde, outils, actifs: () => ({ recherche: true }),
        agentX402: { actif: () => true, registre: regP },
        agentHorsSolde: (q) => C.repond({ addr: q.addr, modele: 'sonnet-5', messages: [{ role: 'user', content: q.tache }] }, { horsSolde: true, prixUsd: q.prixUsd,
          pireCas: (mm, msgs) => Agent.pireCasUsd(mm, msgs, false, q.limites),
          fournisseur: (p) => Agent.repond(p, { client, src: { recherche: false, Jeton, vue: () => ({}) }, limites: q.limites, budgetUsd: q.budgetUsd }) }) });
      const sP = await apiP.sertSansFacture({ outil: 'ask_agent', args: { task: 'x' }, payeur: '0x' + '78'.repeat(20) });
      const premier = Agent.coutAppelUsd(C.modele('sonnet-5'), cher);
      ok(!sP.ok && sP.code === 502 && appelsP === 2 && regP.pertes24h() >= premier - 1e-9 && regP.pertes24h() <= Agent.BUDGET_X402_USD + 1e-9,
         '529 au 2e appel apres un 1er a ' + premier.toFixed(2) + ' $ : 502, rien encaisse, et ' + regP.pertes24h() + ' $ au registre des pertes (avant : 0)');
    }
    /* Le registre : plafond du jour, payeurs bloques, et un redemarrage ne perd rien. */
    reg.perte(1.95, 'settlement failed');
    ok(!apiX.x402Payable('ask_agent') && reg.pertes24h() >= 2, 'pertes des 24 h au plafond (2,00 $) : ask_agent n est plus payable en x402');
    reg.bloque('0x' + '34'.repeat(20));
    const reg2 = R.cree({ fichier: fr, maintenant: () => tR });
    ok(reg2.pertes24h() === reg.pertes24h() && reg2.estBloque('0x' + '34'.repeat(20)) && !reg2.estBloque('0x' + '56'.repeat(20)) && !fs.readdirSync(dir).some((f) => /x402_agent\.json\.tmp$/.test(f)),
       'relu depuis le disque (un redeploiement) : memes pertes, meme payeur bloque (ecrit par temporaire + rename)');
    tR += 24 * 3600 * 1000 + 1;
    ok(reg2.pertes24h() === 0 && !reg2.estBloque('0x' + '34'.repeat(20)), '24 h plus tard : pertes et blocage oublies (fenetre GLISSANTE)');
    /* Un payeur bloque : refuse a la VERIFICATION, l'agent jamais lance (x402.js, vraie signature USDG). */
    {
      const X = require('./x402');
      const { ethers } = require('ethers');
      const BLOQUE = ethers.Wallet.createRandom(), TRESOR = ethers.Wallet.createRandom().address;
      const reg3 = R.cree({});
      reg3.bloque(BLOQUE.address);
      const B = ethers.BigNumber;
      const chaine = { gazPrix: async () => B.from(28000000), soldeGaz: async () => ethers.utils.parseEther('1'), soldeUsdg: async () => B.from(1e9), autorisationLibre: async () => true,
        simule: async () => [], regle: async () => ({ ok: true, hash: '0x' + '1'.repeat(64) }) };
      let lance = 0;
      const x = X.cree({ asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', usdg: X.USDG, payTo: TRESOR, chaine, cours: async () => COURS, ethUsd: async () => 2688,
        prixOutilUsd: (o) => A.prixX402Usd(o), agent: { dureeMaxS: 150, enVolMax: 3, bloque: (a) => reg3.estBloque(a) } });
      const q = JSON.parse(Buffer.from((await x.traite({ outil: 'ask_agent', url: 'u', args: { task: 'x' }, sert: async () => ({ ok: true }) })).entetes['payment-required'], 'base64').toString());
      const acc = q.accepts[0], s = Math.floor(Date.now() / 1000);
      const auth = { from: BLOQUE.address, to: acc.payTo, value: acc.amount, validAfter: String(s - 600), validBefore: String(s + 250), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
      const sig = await BLOQUE._signTypedData(Object.assign({ chainId: X.CHAIN_ID, verifyingContract: X.USDG }, X.DOMAINE_USDG), X.TYPES_3009, auth);
      const r = await x.traite({ outil: 'ask_agent', url: 'u', args: { task: 'x' }, entete: X.b64({ x402Version: 2, accepted: acc, payload: { signature: sig, authorization: auth } }), sert: async () => { lance++; return { ok: true }; } });
      ok(r.status === 402 && JSON.parse(r.corps).raison === 'payer_blocked' && /paused for this address for 24 h/.test(JSON.parse(r.corps).detail) && lance === 0 && acc.maxTimeoutSeconds === 300,
         'un payeur bloque (24 h) : refuse a la verification (payer_blocked), l agent JAMAIS lance ; ask_agent annonce 300 s');
      /* Au plus X402_AGENT_EN_VOL executions : la suivante « occupe » AVANT de verifier. */
      const x1 = X.cree({ asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', usdg: X.USDG, payTo: TRESOR, chaine, cours: async () => COURS, ethUsd: async () => 2688,
        prixOutilUsd: (o) => A.prixX402Usd(o), agent: { dureeMaxS: 150, enVolMax: 1, bloque: () => false } });
      let libere;
      const pend = x1.paie({ outil: 'ask_agent', url: 'u', args: { task: 'x' }, paiement: 'e30=', sert: async () => new Promise((res) => { libere = res; }) });
      const occ = await x1.traite({ outil: 'ask_agent', url: 'u', args: { task: 'x' }, entete: 'e30=', sert: async () => ({ ok: true }) });
      await pend;
      ok(occ.status === 503 && /busy/.test(JSON.parse(occ.corps).raison), 'X402_AGENT_EN_VOL atteint : la suivante recoit 503 « busy » avant toute verification');
      void libere;
    }
    delete process.env.X402_AGENT;

    /* ---- x402 sur MCP : la forme des reponses (x402-foundation specs/transports-v2/mcp.md) ---- */
    const PR = { x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', resource: { url: 'https://api/mcp' },
      accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '20000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x' + '1'.repeat(40), maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } },
        { scheme: 'exact', network: 'eip155:4663', amount: '24086', asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', payTo: '0x' + '1'.repeat(40), maxTimeoutSeconds: 120, extra: { assetTransferMethod: 'eip3009' } },
        { scheme: 'exact', network: 'eip155:4663', amount: '966103', asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', payTo: '0x' + '1'.repeat(40), maxTimeoutSeconds: 120, extra: { assetTransferMethod: 'permit2' } }] };
    const m1 = MCP.versMcp({ etape: 'exige', exige: PR }, 'scan_token', { api: 'https://api' });
    ok(m1.isError === true && JSON.stringify(m1.structuredContent) === JSON.stringify(PR) && m1.content[0].text === JSON.stringify(m1.structuredContent) && m1._meta['x402/error'] === m1.structuredContent,
       'MCP, sans paiement : resultat isError, structuredContent = PaymentRequired, content[0] = le meme en JSON, _meta["x402/error"] identique (Cloudflare)');
    ok(/Price: USDC 0\.02 on Base, or USDG 0\.024086 on Robinhood Chain, or 966103 base units of \$SWOGE on Robinhood Chain\./.test(m1.content[1].text) && /https:\/\/api\/agentic\/call\/scan_token/.test(m1.content[1].text)
       && !/[^\x20-\x7e]/.test(m1.content[1].text), 'la phrase de prix nomme reseau ET actif (plus « base units of $SWOGE » pour de l USDC) et l adresse HTTP, en ASCII');
    const m2 = MCP.versMcp({ etape: 'attente', reponse: { success: false, errorReason: 'settlement_pending', transaction: '0x' + 'ab'.repeat(32), network: 'eip155:8453', payer: '0x1' } }, 'scan_token', {});
    ok(m2.isError && !JSON.stringify(m2).includes('accepts') && !m2.structuredContent && !m2._meta['x402/error'] && m2._meta['x402/payment-response'].transaction === '0x' + 'ab'.repeat(32),
       'MCP, en attente : AUCUN accepts nulle part (Cloudflare paierait une 2e fois), le hash dans _meta["x402/payment-response"]');
    const m3 = MCP.versMcp({ etape: 'reglement', exige: PR, raison: 'x', detail: 'invalid_payload', reponse: { success: false }, resultat: { texte: 'SECRET TOOL OUTPUT' } }, 'scan_token', {});
    ok(m3.isError && /Settlement failed: invalid_payload/.test(m3.structuredContent.error) && !JSON.stringify(m3).includes('SECRET TOOL OUTPUT'), 'MCP, reglement rate : l erreur de paiement, JAMAIS le resultat de l outil');
    const m4 = MCP.versMcp({ etape: 'paye', resultat: { texte: 'Token X', resultat: { token: 1 } }, reponse: { success: true, transaction: '0xt', network: 'eip155:8453', payer: '0x1' },
      recu: { transaction: '0xt', network: 'eip155:8453', amount: '20000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } }, 'scan_token', {});
    ok(m4.isError === false && m4.structuredContent.result.token === 1 && m4.structuredContent.x402.amount === '20000' && m4._meta['x402/payment-response'].success === true
       && /paid \$0\.02 in USDC \(eip155:8453\), tx 0xt/.test(m4.content[0].text), 'MCP, paye : le resultat, le recu, _meta["x402/payment-response"]');
    ok(MCP.outilsMcp(A.definitions({ recherche: true })).every((o) => !('outputSchema' in o) && !o._meta), 'tools/list : aucun outputSchema (le SDK MCP le verifierait meme sur une erreur), pas d indice de prix x402 eteint');
    const avecPrix = MCP.outilsMcp(A.definitions({ recherche: true }), (nom) => (nom === 'scan_token' ? 0.02 : null));
    ok(avecPrix.find((o) => o.name === 'scan_token')._meta['agents-x402/priceUSD'] === 0.02 && !avecPrix.find((o) => o.name === 'ask_agent')._meta, 'x402 sur MCP allume : l indice de prix (Cloudflare) sur les outils payables seulement');
    ok(!/x402 over MCP/.test(MCP.instructions('https://api')) && /x402 over MCP \(_meta\["x402\/payment"\], USDC on Base first\)/.test(MCP.instructions('https://api', true)), 'les instructions ne parlent de x402 sur MCP que s il est allume');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
