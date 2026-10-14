'use strict';
/* ============================================================================
 * LA ROUTE DES PLANCHES (/studio/planches), SUR LE VRAI SERVEUR
 *
 * Contre un faux xAI local (XAI_BASE_URL) et un faux site (SITE_URL, fetch
 * intercepte pour site.example et vidgen.x.ai seulement). Ce qu'elle DOIT tenir :
 *   1. sans session : 401 ; OPTIONS sans session (CORS) ; un autre portefeuille
 *      apprend « proprietaire: false » et RIEN d'autre, tout autre geste : 403
 *      AVANT la lecture du corps ; il ne lit aucun fichier ;
 *   2. le proprietaire voit le plafond, la depense et le pire cas de chaque lot
 *      publie dans demandes.json ;
 *   3. un lot dont le pire cas depasse le plafond est refuse SANS appel ; une
 *      demande hors de la liste fermee, une pose dont le sha256 ne correspond
 *      pas : refusees sans appel ;
 *   4. le lot part pour l'adresse de la SESSION (pas celle du corps) ; xAI
 *      recoit image = last_frame (la pose), 720p, 5:2, generate_audio false,
 *      la duree demandee et NOTRE consigne ; un second lot attend (429) ;
 *   5. journal : « envoi » (reserve) avant l'appel, « sent » (request_id), puis
 *      le cout reel (ticks) ; la finition tourne et rend une planche que le
 *      proprietaire — et lui seul — telecharge ;
 *   6. une video sur un hote qui n'est pas x.ai n'est pas telechargee, meme au
 *      bout d'une redirection depuis x.ai ;
 *   7. aucun $SWOGE debite ; la cle xAI n'apparait dans aucune reponse ; deux
 *      « Run » simultanes : un seul lot part, l'autre recoit 429 sans appel ;
 *   8. (module) reprise apres redemarrage : un clip « sent » est suivi jusqu'a
 *      son cout ; un « envoi » sans reponse garde sa reserve ; un cout au-dela
 *      de sa reserve ARRETE tout ; un redemarrage pendant la finition la refait ;
 *   9. (module) l'argent quand ca casse : pas de reponse d'xAI = reserve comptee
 *      et ARRET (un 4xx seul vaut 0 $) ; journal inecrivable = aucun appel ; une
 *      depense qui monte entre le controle du lot et l'appel = refus « cap » ; un
 *      clip deja fini quand le suivant est refuse = le lot se termine quand meme ;
 *      PLANCHES_PLAFOND_USD ne peut que baisser le plafond.
 *
 * Le pire cas est le TARIF OFFICIEL DE LA RESOLUTION ENVOYEE, plus 0,01 $ par
 * image d'entree, x 1,25 (fiches des modeles xAI relues le 13/10/2026 : 1.5 =
 * 0,14 $/s en 720p, 0,08 en 480p ; lite = 0,03 en 720p ; image 0,01 $).
 * ==========================================================================*/
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/planches-route-');
const AEFFACER = [process.env.DATA_DIR];
/* le tarif officiel (fiches des modeles, 13/10/2026), ecrit ICI a la main : un retour au prix sans resolution se verrait */
const TARIF = { 'grok-imagine-video-1.5': { '480p': 0.08, '720p': 0.14 }, 'grok-imagine-video-1.5-lite': { '480p': 0.02, '720p': 0.03 } };
const IMAGES = { 'grok-imagine-video-1.5': 2, 'grok-imagine-video-1.5-lite': 1 };       /* image, + last_frame en 1.5 */
const reel = (m, d, res) => Math.round((TARIF[m][res || '720p'] * d + 0.01 * IMAGES[m]) * 1e6) / 1e6;
const pireDe = (m, d, res) => Math.round(reel(m, d, res) * 1.25 * 1e4) / 1e4;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0'; process.env.KLING_TG = '0';
process.env.STUDIO_VIDEO_POLL_MS = '200';
process.env.PUBLIC_URL = 'https://srv.example';
process.env.SITE_URL = 'https://site.example';
delete process.env.GROK_API_KEY; delete process.env.PLANCHES_PLAFOND_USD;
const OWNER = ethers.Wallet.createRandom(), OWNER2 = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address + ',' + OWNER2.address;

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

async function connecte(port, w) {
  const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => s.on('open', r));
  const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  const auth = await attend('auth');
  return { adr: w.address.toLowerCase(), s, H: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session } };
}

(async () => {
  /* ---- les faux clips (le mannequin) et la pose, comme le site les publierait ---- */
  const { fabrique } = require('./outils/planches/fabrique_essai');
  const dClips = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-clips-')); AEFFACER.push(dClips);
  const fx = await fabrique({ dossier: dClips, actions: ['idle', 'walk'] });
  /* l'ancienne planche du jeu (img/nexus/monstres/mannequin.webp) : la reference du halo */
  const G = require('./outils/planches/guide'), M = require('./outils/planches/media');
  const fAncienne = path.join(dClips, 'ancienne.webp');
  await M.ecrisWebp({ w: 1024, h: 1024, data: G.toilePoses(1024, 1024).data }, fAncienne, 90);
  const ancienne = fs.readFileSync(fAncienne);
  const pose = fs.readFileSync(fx.pose), sha = crypto.createHash('sha256').update(pose).digest('hex');
  const mp4 = { idle: fs.readFileSync(fx.clips[0].fichier), walk: fs.readFileSync(fx.clips[1].fichier) };
  const D = (action, duree, extra) => Object.assign({ monstre: 'mannequin', action, mode: 'bande', modele: 'grok-imagine-video-1.5', duree, sha256: sha }, extra || {});
  const demandes = { lots: {
    pilote: [D('idle', 2), D('walk', 3)],
    gros: Array.from({ length: 24 }, () => D('walk', 4)),                     /* 24 x 0,40 $ = 9,60 $ > 7,50 $ */
    faux_sha: [D('idle', 2, { sha256: 'f'.repeat(64) })],
    hors_liste: [D('idle', 2, { prompt: 'anything I want' })],
    ailleurs: [D('idle', 1, { modele: 'grok-imagine-video-1.5-lite' })],
    redirige: [D('idle', 2, { modele: 'grok-imagine-video-1.5-lite' })],
    bas: [D('idle', 2, { resolution: '480p' })],
    haut: [D('idle', 2, { resolution: '1080p' })],
  } };
  let lenteurSite = 0;

  /* ---- le faux xAI ---- */
  const vus = [];
  let nGen = 0;
  const actionDe = {};
  const fauxXai = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      const corps = b ? JSON.parse(b) : null;
      vus.push({ methode: q.method, url: q.url, auth: q.headers.authorization, corps });
      r.writeHead(200, { 'content-type': 'application/json' });
      if (q.method === 'POST' && q.url === '/v1/videos/generations') {
        const id = 'vid-' + (++nGen);
        actionDe[id] = { action: /walk in place/.test(corps.prompt) ? 'walk' : 'idle', duree: corps.duration, modele: corps.model, resolution: corps.resolution };
        return r.end(JSON.stringify({ request_id: id }));
      }
      const m = /^\/v1\/videos\/(vid-\d+)$/.exec(q.url);
      if (m) {
        const a = actionDe[m[1]];
        const url = a.modele === 'grok-imagine-video-1.5-lite' ? (a.duree === 2 ? 'https://vidgen.x.ai/redirige.mp4' : 'https://evil.example/' + m[1] + '.mp4') : 'https://vidgen.x.ai/' + a.action + '.mp4';
        return r.end(JSON.stringify({ status: 'done', video: { url, duration: a.duree }, usage: { cost_in_usd_ticks: Math.round(reel(a.modele, a.duree, a.resolution) * 1e10) } }));
      }
      r.end('{}');
    });
  });
  const pX = await libre(); await new Promise((r) => fauxXai.listen(pX, r));
  process.env.XAI_API_KEY = 'xai-test-local';
  process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pX;

  /* ---- le faux site et le CDN video d'xAI : seuls ces deux hotes sont interceptes ---- */
  const vraiFetch = globalThis.fetch, telecharges = [];
  const rep = (b, type) => new Response(b, { status: 200, headers: { 'content-type': type } });
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url === 'https://site.example/img/nexus/monstres/iso/poses/demandes.json') { if (lenteurSite) await dort(lenteurSite); return rep(JSON.stringify(demandes), 'application/json'); }
    if (url === 'https://site.example/img/nexus/monstres/iso/poses/mannequin.png') return rep(pose, 'image/png');
    if (url === 'https://site.example/img/nexus/monstres/mannequin.webp') return rep(ancienne, 'image/webp');
    if (url.startsWith('https://site.example/')) return new Response('', { status: 404 });
    const v = /^https:\/\/vidgen\.x\.ai\/(idle|walk)\.mp4$/.exec(url);
    if (v) { telecharges.push(url); return rep(mp4[v[1]], 'video/mp4'); }
    if (url === 'https://vidgen.x.ai/redirige.mp4') { telecharges.push(url); return new Response(null, { status: 302, headers: { location: 'http://evil.example/interne' } }); }
    if (url.startsWith('https://evil.example/') || url.startsWith('http://evil.example/')) { telecharges.push(url); return rep(Buffer.from('nope'), 'video/mp4'); }
    return vraiFetch(u, o);
  };

  const port = await libre();
  process.env.PORT = String(port);
  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
  require('./server');
  await dort(900);
  const base = 'http://127.0.0.1:' + port;
  const textes = [];
  const api = async (chemin, H, methode, corps) => {
    const r = await vraiFetch(base + chemin, { method: methode || 'GET', headers: H, body: corps ? JSON.stringify(corps) : undefined });
    const t = await r.text(); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return Object.assign({ cles: Object.keys(j) }, j, { http: r.status });
  };
  const xaiPosts = () => vus.filter((v) => v.methode === 'POST').length;

  console.log('-- 1. la session, et rien d autre --');
  eq((await api('/studio/planches', {})).http, 401, 'sans session : GET 401');
  eq((await api('/studio/planches', { 'content-type': 'application/json' }, 'POST', { lot: 'pilote' })).http, 401, 'sans session : POST 401');
  const pre = await vraiFetch(base + '/studio/planches', { method: 'OPTIONS' });
  ok(pre.status === 204 && /authorization/.test(pre.headers.get('access-control-allow-headers') || ''), 'OPTIONS : 204 avec CORS, sans session');
  const proprio = await connecte(port, OWNER), proprio2 = await connecte(port, OWNER2), bob = await connecte(port, ethers.Wallet.createRandom());
  const gb = await api('/studio/planches', bob.H);
  ok(gb.http === 200 && gb.proprietaire === false && gb.cles.sort().join(',') === 'ok,proprietaire', 'un autre portefeuille : proprietaire false, AUCUN autre champ');
  const suspendu = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/planches', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bob.H.authorization, 'content-length': String(1024 * 1024) } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
    });
    q.on('error', () => {});
    q.write('{"lot":"pil');   /* le reste n arrive jamais */
    setTimeout(() => { res({ delai: true }); q.destroy(); }, 3000);
  });
  ok(suspendu.statut === 403 && xaiPosts() === 0, 'son POST est refuse (403) sans attendre le corps, rien chez xAI [' + (suspendu.statut || 'delai') + ']');

  console.log('\n-- 2. ce que voit le proprietaire --');
  const v0 = await api('/studio/planches', proprio.H);
  ok(v0.http === 200 && v0.proprietaire === true && v0.actif === true && v0.plafondUsd === 7.5 && v0.depenseUsd === 0, 'proprietaire, xAI branche, plafond 7,50 $, rien depense');
  const lp = (v0.demandes.lots || []).find((l) => l.nom === 'pilote'), lg = (v0.demandes.lots || []).find((l) => l.nom === 'gros');
  const pPilote = Math.round((pireDe('grok-imagine-video-1.5', 2) + pireDe('grok-imagine-video-1.5', 3)) * 1e4) / 1e4, pGros = Math.round(24 * pireDe('grok-imagine-video-1.5', 4) * 1e4) / 1e4;
  ok(lp && Math.abs(lp.reserveUsd - pPilote) < 1e-9 && lp.secondes === 5 && lg && Math.abs(lg.reserveUsd - pGros) < 1e-9,
     'le pire cas est le tarif officiel de la resolution envoyee (720p) + les images d entree : pilote ' + (lp && lp.reserveUsd) + ' $ (attendu ' + pPilote + '), gros ' + (lg && lg.reserveUsd) + ' $');
  const lb = (v0.demandes.lots || []).find((l) => l.nom === 'bas');
  ok(lb && Math.abs(lb.reserveUsd - pireDe('grok-imagine-video-1.5', 2, '480p')) < 1e-9 && lb.detail[0].resolution === '480p', 'une demande en 480p est comptee au tarif 480p (' + (lb && lb.reserveUsd) + ' $)');
  ok((v0.demandes.lots.find((l) => l.nom === 'hors_liste') || {}).invalide === 'unknown field prompt' && (v0.demandes.lots.find((l) => l.nom === 'haut') || {}).invalide === 'resolution', 'une demande hors liste (un texte libre, du 1080p) est marquee invalide');

  console.log('\n-- 3. refus SANS appel --');
  const rg = await api('/studio/planches', proprio.H, 'POST', { lot: 'gros' });
  ok(rg.http === 402 && rg.raison.includes('could cost up to ' + pGros.toFixed(2) + ' $') && xaiPosts() === 0, 'lot de ' + pGros.toFixed(2) + ' $ au pire contre 7,50 $ de plafond : 402, xAI n a rien recu');
  const rs = await api('/studio/planches', proprio.H, 'POST', { lot: 'faux_sha' });
  ok(rs.http === 409 && xaiPosts() === 0, 'pose dont le sha256 ne correspond pas : 409, rien envoye');
  const rh = await api('/studio/planches', proprio.H, 'POST', { lot: 'hors_liste' });
  ok(rh.http === 400 && /unknown field/.test(rh.raison) && xaiPosts() === 0, 'champ hors de la liste fermee (un texte libre) : 400, rien envoye');
  ok((await api('/studio/planches', proprio.H, 'POST', { lot: '../etc' })).http === 400 && (await api('/studio/planches', proprio.H, 'POST', { lot: 'absent' })).http === 404, 'nom de lot invalide : 400 ; lot absent : 404');

  console.log('\n-- 4. le lot part --');
  const solde0 = moteur && moteur.balanceStr(proprio.adr);
  const r = await api('/studio/planches', proprio.H, 'POST', { lot: 'pilote', addr: bob.adr });
  ok(r.http === 200 && r.lances === 2 && /^[0-9a-f]{24}$/.test(r.id), 'pilote lance : 2 clips');
  const posts = vus.filter((v) => v.methode === 'POST');
  const c1 = posts[0].corps, c2 = posts[1].corps;
  ok(c1.model === 'grok-imagine-video-1.5' && c1.image.url === c1.last_frame.url && /^data:image\/png;base64,/.test(c1.image.url), 'image = last_frame = la pose (data PNG) : boucle epinglee');
  ok(Buffer.from(c1.image.url.split(',')[1], 'base64').equals(pose), 'et c est bien la pose du site, octet pour octet');
  ok(c1.resolution === '720p' && c1.aspect_ratio === '5:2' && c1.generate_audio === false && c1.duration === 2 && c2.duration === 3, '720p, 5:2, muet, 2 s puis 3 s');
  ok(/treadmill/.test(c2.prompt) && /magenta/.test(c1.prompt) && /No floor, no shadow/.test(c1.prompt), 'la consigne vient de NOTRE table (marche sur place, fond magenta, ni sol ni ombre)');
  ok(posts.every((p) => p.auth === 'Bearer xai-test-local'), 'la cle part vers xAI seulement');
  eq((await api('/studio/planches/lot/' + r.id, proprio2.H)).http, 404, 'le lot est a la SESSION qui l a lance (un autre proprietaire ne le voit pas, et l adresse du corps est ignoree)');
  const r2 = await api('/studio/planches', proprio.H, 'POST', { lot: 'pilote' });
  ok(r2.http === 429 && xaiPosts() === 2, 'un second lot pendant le premier : 429, rien envoye');

  console.log('\n-- 5. journal, finition, fichiers --');
  let lot = null;
  /* la finition (planche du jeu ET HD) tourne dans un processus a part : jusqu'a 3 min ici */
  for (let i = 0; i < 900; i++) { lot = await api('/studio/planches/lot/' + r.id, proprio.H); if (lot.statut === 'fini') break; await dort(200); }
  ok(lot.statut === 'fini' && lot.clips.every((c) => c.statut === 'done' && /^[0-9a-f]{48}\.mp4$/.test(c.fichier)), 'les 2 clips sont arrives et telecharges depuis x.ai');
  const J = fs.readFileSync(path.join(process.env.DATA_DIR, 'planches_essais.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.lot === r.id && l.idx === 0);
  ok(J.length === 3 && J[0].statut === 'envoi' && J[0].reserve === pireDe('grok-imagine-video-1.5', 2) && J[0].resolution === '720p' && J[1].statut === 'sent' && J[1].rid === 'vid-1' && J[2].statut === 'done' && J[2].coutUsd === reel('grok-imagine-video-1.5', 2),
     'journal du clip 1 : envoi (reserve ' + (J[0] && J[0].reserve) + ' $, 720p) AVANT, sent (vid-1), puis ' + (J[2] && J[2].coutUsd) + ' $ lus dans les ticks');
  ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'planches', 'ARRET')), 'le cout reel au tarif 720p tient dans sa reserve : aucun ARRET');
  const pl = lot.planches && lot.planches[0];
  ok(pl && pl.monstre === 'mannequin' && pl.verdict === 'ok' && pl.fichiers.includes('mannequin.json') && pl.fichiers.includes('mannequin/walk.webp') && pl.fichiers.includes('mannequin/walk_hd.webp'), 'la finition a rendu une planche qui passe ses controles, et sa HD (' + (pl && (pl.verdict + ' ' + (pl.echecs || []).join(' '))) + ')');
  const fiche = await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json', { headers: proprio.H });
  const fj = await fiche.json().catch(() => ({}));
  const coutPilote = Math.round((reel('grok-imagine-video-1.5', 2) + reel('grok-imagine-video-1.5', 3)) * 1e4) / 1e4;
  ok(fiche.status === 200 && fj.format === 'swoge-planche-iso/1' && fj.actions.walk && fj.cout_usd === coutPilote, 'le proprietaire lit la fiche (cout reel ' + fj.cout_usd + ' $ dedans)');
  ok(fj.sources && /\.webp$/.test(fj.sources.ancienne || '') && Number.isFinite(fj.sources.halo_ancienne), 'la finition a recu l ancienne planche du jeu (reference du halo : ' + (fj.sources && fj.sources.halo_ancienne) + ')');
  const img = await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin/walk.webp', { headers: proprio.H });
  ok(img.status === 200 && img.headers.get('content-type') === 'image/webp' && (await img.arrayBuffer()).byteLength > 1000, 'et la planche de marche (image/webp)');
  const ihd = await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin/walk_hd.webp', { headers: proprio.H });
  ok(ihd.status === 200 && (await ihd.arrayBuffer()).byteLength > 1000 && fj.actions.walk.hd && fj.actions.walk.hd.case === 512, 'et sa HD (cases de 512, ' + (fj.actions.walk.hd && fj.actions.walk.hd.n) + ' images)');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json', { headers: proprio2.H })).status, 404, 'un autre proprietaire : 404');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json', { headers: bob.H })).status, 403, 'un non-proprietaire : 403');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json')).status, 401, 'sans session : 401');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/..%2Fplanches_essais.json', { headers: proprio.H })).status, 404, 'un chemin hors du lot : 404');
  /* refaire la finition sur les clips deja payes : proprietaire du lot seulement, AUCUN appel xAI */
  const postsAvantRefait = xaiPosts();
  eq((await vraiFetch(base + '/studio/planches/refinition/' + r.id, { method: 'POST', headers: bob.H })).status, 403, 'refaire la finition : un non-proprietaire 403');
  eq((await vraiFetch(base + '/studio/planches/refinition/' + r.id, { method: 'POST', headers: proprio2.H })).status, 404, 'un autre proprietaire : 404');
  eq((await vraiFetch(base + '/studio/planches/refinition/' + r.id, { method: 'POST' })).status, 401, 'sans session : 401');
  const rf = await vraiFetch(base + '/studio/planches/refinition/' + r.id, { method: 'POST', headers: proprio.H });
  const rfj = await rf.json().catch(() => ({}));
  ok(rf.status === 200 && rfj.statut === 'finition', 'le proprietaire relance la finition (' + rf.status + ', ' + rfj.statut + ')');
  let rfl = null;
  for (let i = 0; i < 1200; i++) { rfl = await api('/studio/planches/lot/' + r.id, proprio.H); if (rfl.statut === 'fini') break; await dort(100); }
  ok(rfl.statut === 'fini' && rfl.planches.length === 1 && (rfl.planches[0].prises || []).length === 2 && xaiPosts() === postsAvantRefait,
     'refaite : planche rendue, ' + ((rfl.planches[0] || {}).prises || []).join(', ') + ', aucun appel xAI de plus');

  console.log('\n-- 6. un hote qui n est pas x.ai --');
  const ra = await api('/studio/planches', proprio.H, 'POST', { lot: 'ailleurs' });
  let la = null;
  for (let i = 0; i < 100; i++) { la = await api('/studio/planches/lot/' + ra.id, proprio.H); if (la.statut === 'fini') break; await dort(100); }
  ok(la.clips[0].statut === 'failed' && /refused host evil\.example/.test(la.clips[0].erreur) && !telecharges.some((u) => u.includes('evil')), 'video sur evil.example : refusee, jamais telechargee');
  ok(la.clips[0].coutUsd === reel('grok-imagine-video-1.5-lite', 1) && vus.filter((v) => v.methode === 'POST').pop().corps.last_frame === undefined, 'son cout est quand meme compte (' + la.clips[0].coutUsd + ' $), et lite part sans last_frame (1.5 seul l accepte)');
  const rr = await api('/studio/planches', proprio.H, 'POST', { lot: 'redirige' });
  let lr = null;
  for (let i = 0; i < 100; i++) { lr = await api('/studio/planches/lot/' + rr.id, proprio.H); if (lr.statut === 'fini') break; await dort(100); }
  ok(lr.clips[0].statut === 'failed' && /refused host evil\.example/.test(lr.clips[0].erreur || '') && !telecharges.some((u) => u.startsWith('http://evil')),
     'video sur vidgen.x.ai redirigee (302) vers http://evil.example : la redirection n est PAS suivie (' + lr.clips[0].erreur + ')');

  console.log('\n-- 7. argent et cle --');
  const v1 = await api('/studio/planches', proprio.H);
  const depAttendue = Math.round((coutPilote + reel('grok-imagine-video-1.5-lite', 1) + reel('grok-imagine-video-1.5-lite', 2)) * 1e4) / 1e4;
  ok(Math.abs(v1.depenseUsd - depAttendue) < 1e-9 && Math.abs(v1.resteUsd - (7.5 - depAttendue)) < 1e-9, 'depense = la somme des ticks : ' + v1.depenseUsd + ' $, reste ' + v1.resteUsd + ' $');
  ok(!moteur || moteur.balanceStr(proprio.adr) === solde0, 'aucun $SWOGE debite');
  ok(!textes.some((t) => t.includes('xai-test-local')), 'la cle xAI n apparait dans aucune reponse');
  /* deux « Run » au meme moment (le site repond en 150 ms) : un seul lot */
  lenteurSite = 150;
  const postsAvant = xaiPosts();
  const [ca, cb] = await Promise.all([api('/studio/planches', proprio.H, 'POST', { lot: 'ailleurs' }), api('/studio/planches', proprio.H, 'POST', { lot: 'ailleurs' })]);
  lenteurSite = 0;
  const codes = [ca.http, cb.http].sort().join(',');
  ok(codes === '200,429' && xaiPosts() - postsAvant === 1, 'deux Run simultanes : ' + codes + ', ' + (xaiPosts() - postsAvant) + ' appel chez xAI (le second n en fait aucun)');
  const gagnant = ca.http === 200 ? ca : cb;
  for (let i = 0; i < 100; i++) { const x = await api('/studio/planches/lot/' + gagnant.id, proprio.H); if (x.statut === 'fini') break; await dort(100); }
  proprio.s.close(); proprio2.s.close(); bob.s.close();

  console.log('\n-- 8. le module : redemarrage et ARRET --');
  const P = require('./planches');
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-reprise-')), jr = path.join(dos, 'j.jsonl');
  const idl = 'a'.repeat(24);
  fs.writeFileSync(path.join(dos, idl + '.json'), JSON.stringify({ id: idl, t: Date.now(), addr: '0xabc', lot: 'x', statut: 'lance', poses: {},
    clips: [{ monstre: 'm', action: 'idle', mode: 'bande', modele: 'grok-imagine-video-1.5', duree: 2, reserve: 0.2, statut: 'sent', t: Date.now() },
            { monstre: 'm', action: 'walk', mode: 'bande', modele: 'grok-imagine-video-1.5', duree: 3, reserve: 0.3, statut: 'envoi', t: Date.now() }] }));
  fs.writeFileSync(jr, [{ type: 'clip', lot: idl, idx: 0, statut: 'envoi', reserve: 0.2 }, { type: 'clip', lot: idl, idx: 0, statut: 'sent', rid: 'r0' },
                        { type: 'clip', lot: idl, idx: 1, statut: 'envoi', reserve: 0.3 }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const lus = [];
  const fourn = { actif: () => true, lanceVideo: async () => { lus.push('lance'); return 'r9'; },
                  litVideo: async (id) => { lus.push(id); return { status: 'done', video: { url: 'https://vidgen.x.ai/idle.mp4' }, usage: { cost_in_usd_ticks: 5e9 } }; } };
  const mod = P.cree({ dossier: dos, journal: jr, fournisseur: fourn, site: 'https://site.example', pollMs: 20, plafondUsd: 7.5,
                       finition: async () => ({ qc: { verdict: 'ok', echecs: [] }, actions: {} }) });
  ok(mod.depense() === 0.5, 'au demarrage : les deux reserves en vol sont comptees (0,50 $)');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dos, 'ARRET')); i++) await dort(20);
  const fin0 = fs.readFileSync(jr, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.idx === 0).pop();
  ok(lus.includes('r0') && fin0.statut === 'done' && fin0.coutUsd === 0.5, 'le clip « sent » est repris et son cout reel journalise (0,50 $)');
  ok(Math.abs(mod.depense() - 0.8) < 1e-9, 'l « envoi » sans reponse garde sa reserve (cout inconnu = cout plein) : 0,50 + 0,30 $');
  ok(fs.existsSync(path.join(dos, 'ARRET')), '0,50 $ pour une reserve de 0,20 $ : ARRET ecrit');
  const ar = await mod.lance({ addr: '0xabc', lot: 'pilote' });
  ok(!ar.ok && ar.code === 423 && !lus.includes('lance'), 'apres ARRET, un nouveau lot est refuse (423) sans appel');

  /* un redemarrage PENDANT la finition : le lot ne reste pas « finition » pour toujours */
  const dosF = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-reprise-')); AEFFACER.push(dosF);
  const idf = 'b'.repeat(24), jrF = path.join(dosF, 'j.jsonl');
  fs.writeFileSync(path.join(dosF, idf + '.json'), JSON.stringify({ id: idf, t: Date.now(), addr: '0xabc', lot: 'x', statut: 'finition', poses: {},
    clips: [{ monstre: 'm', action: 'idle', mode: 'bande', modele: 'grok-imagine-video-1.5', duree: 2, reserve: 0.375, statut: 'done', coutUsd: 0.3, fichier: 'c'.repeat(48) + '.mp4' }] }));
  fs.writeFileSync(jrF, [{ type: 'clip', lot: idf, idx: 0, statut: 'envoi', reserve: 0.375 }, { type: 'clip', lot: idf, idx: 0, statut: 'sent', rid: 'r0' },
                         { type: 'clip', lot: idf, idx: 0, statut: 'done', coutUsd: 0.3, fichier: 'c'.repeat(48) + '.mp4' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  let finitionsF = 0;
  const modF = P.cree({ dossier: dosF, journal: jrF, fournisseur: fourn, site: 'https://site.example', pollMs: 20, plafondUsd: 7.5,
                        finition: async () => { finitionsF++; return { qc: { verdict: 'ok', echecs: [] }, actions: {} }; } });
  for (let i = 0; i < 50 && modF.etat(idf, '0xabc').statut !== 'fini'; i++) await dort(20);
  const eF = modF.etat(idf, '0xabc');
  ok(eF.statut === 'fini' && finitionsF === 1 && eF.planches.length === 1 && modF.enCours() === null, 'redemarrage pendant la finition : elle est refaite (' + eF.statut + ', ' + finitionsF + ' finition)');

  console.log('\n-- 9. le module : l argent quand ca casse --');
  const Dm = (action, duree) => ({ monstre: 'mannequin', action, mode: 'bande', modele: 'grok-imagine-video-1.5', duree, sha256: sha });
  const demM = { lots: { deux: [Dm('idle', 2), Dm('walk', 2)], un: [Dm('idle', 2)] } };
  const repM = (b) => ({ ok: true, status: 200, arrayBuffer: async () => b });
  const chargeM = async (u) => (/demandes\.json$/.test(u) ? repM(Buffer.from(JSON.stringify(demM))) : /\.png$/.test(u) ? repM(pose) : { ok: false, status: 404 });
  const neuf = (opts) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-reprise-')); AEFFACER.push(d);
    return Object.assign({ d }, P.cree(Object.assign({ dossier: d, journal: path.join(d, 'j.jsonl'), site: 'https://site.example', pollMs: 10, plafondUsd: 7.5, charge: chargeM,
      finition: async () => ({ qc: { verdict: 'ok', echecs: [] }, actions: {} }) }, opts))); };
  const r1clip = pireDe('grok-imagine-video-1.5', 2);
  const derniere = (d) => fs.readFileSync(path.join(d, 'j.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();

  /* a. pas de reponse : xAI a peut-etre recu la demande et lance le travail */
  let appA = 0;
  const xa = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { appA++; throw new TypeError('fetch failed'); }, litVideo: async () => ({}) } });
  const ra9 = await xa.lance({ addr: '0xp', lot: 'deux' });
  const la9 = derniere(xa.d);
  ok(!ra9.ok && appA === 1 && la9.statut === 'inconnu' && la9.coutUsd === r1clip && xa.depense() === r1clip && fs.existsSync(path.join(xa.d, 'ARRET')),
     'coupure pendant l appel : statut inconnu, la reserve (' + r1clip + ' $) reste comptee, ARRET, le clip suivant ne part pas [' + la9.statut + ' ' + la9.coutUsd + ']');
  ok((await xa.lance({ addr: '0xp', lot: 'un' })).code === 423 && appA === 1, 'et le lot suivant est refuse (423) sans appel');
  const x5 = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { const e = new Error('xAI 503 - busy'); e.statut = 503; throw e; }, litVideo: async () => ({}) } });
  await x5.lance({ addr: '0xp', lot: 'un' });
  ok(x5.depense() === r1clip && fs.existsSync(path.join(x5.d, 'ARRET')), 'un 503 : pareil, la reserve reste comptee et ARRET');
  /* le vrai client studio_xai.js contre un faux xAI qui coupe la connexion apres avoir tout lu */
  let recusCoupe = 0;
  const coupe = http.createServer((q2) => { q2.on('data', () => {}); q2.on('end', () => { recusCoupe++; q2.socket.destroy(); }); });
  const pC = await libre(); await new Promise((r9) => coupe.listen(pC, '127.0.0.1', r9));
  const baseAvant = process.env.XAI_BASE_URL; process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pC;
  const xs = neuf({ fournisseur: require('./studio_xai') });
  await xs.lance({ addr: '0xp', lot: 'un' });
  process.env.XAI_BASE_URL = baseAvant; coupe.close();
  ok(recusCoupe === 1 && xs.depense() === r1clip && fs.existsSync(path.join(xs.d, 'ARRET')), 'studio_xai contre une connexion coupee apres reception : reserve comptee, ARRET (' + xs.depense() + ' $)');
  const x4 = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { const e = new Error('xAI 400 - moderation'); e.statut = 400; throw e; }, litVideo: async () => ({}) } });
  const r4 = await x4.lance({ addr: '0xp', lot: 'un' });
  ok(!r4.ok && x4.depense() === 0 && !fs.existsSync(path.join(x4.d, 'ARRET')) && /moderation/.test(r4.raison), 'un 400 recu : 0 $, pas d ARRET (' + r4.raison + ')');

  /* b. journal inecrivable : l appel ne part pas */
  let appB = 0;
  const xb = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { appB++; return 'r'; }, litVideo: async () => ({ status: 'pending' }) } });
  fs.mkdirSync(path.join(xb.d, 'j.jsonl'));     /* le journal est un dossier : EISDIR */
  const rb9 = await xb.lance({ addr: '0xp', lot: 'un' });
  ok(!rb9.ok && appB === 0 && /journal/.test(rb9.raison || ''), 'journal inecrivable : AUCUN appel (' + rb9.raison + ')');

  /* c. la depense monte entre le controle du lot et l appel (un autre processus a ecrit une reserve) */
  let appC = 0, xc = null;
  xc = neuf({ plafondUsd: 1.0, fournisseur: { actif: () => true, litVideo: async () => ({ status: 'pending' }),
    lanceVideo: async () => { appC++; fs.appendFileSync(path.join(xc.d, 'j.jsonl'), JSON.stringify({ type: 'clip', lot: 'f'.repeat(24), idx: 0, statut: 'envoi', reserve: 0.5 }) + '\n'); return 'rc' + appC; } } });
  const rc9 = await xc.lance({ addr: '0xp', lot: 'deux' });
  ok(rc9.ok && rc9.lances === 1 && appC === 1 && rc9.raison === 'stopped before the cap', 'la depense monte pendant le lot : le clip suivant est refuse au plafond AVANT l appel (' + rc9.lances + ' lance, ' + rc9.raison + ')');

  /* d. le clip 0 finit pendant l appel du clip 1, que xAI refuse : le lot se termine */
  let appD = 0, finD = 0;
  const xd = neuf({ fournisseur: { actif: () => true,
    lanceVideo: async () => { appD++; if (appD === 2) { await dort(120); const e = new Error('xAI 400 moderation'); e.statut = 400; throw e; } return 'rd' + appD; },
    litVideo: async () => ({ status: 'failed', erreur: 'failed early', usage: { cost_in_usd_ticks: 0 } }) },
    finition: async () => { finD++; return { qc: { verdict: 'ok', echecs: [] }, actions: {} }; } });
  const rd9 = await xd.lance({ addr: '0xp', lot: 'deux' });
  for (let i = 0; i < 50 && xd.enCours(); i++) await dort(20);
  const ed = xd.etat(rd9.id, '0xp');
  ok(ed.statut === 'fini' && xd.enCours() === null && /moderation/.test(rd9.raison || ''), 'clip 0 fini pendant l appel du clip 1, refuse : lot ' + ed.statut + ', plus en cours, raison du BON clip (' + rd9.raison + ')');
  ok((await xd.lance({ addr: '0xp', lot: 'un' })).code !== 429, 'et le lot suivant n est pas bloque en 429');

  /* e. deux « Run » simultanes sur le module : un 429, zero appel de sa part */
  let appE = 0;
  const xe = neuf({ charge: async (u) => { await dort(50); return chargeM(u); }, fournisseur: { actif: () => true, lanceVideo: async () => { appE++; return 're' + appE; }, litVideo: async () => ({ status: 'pending' }) } });
  const [e1, e2] = await Promise.all([xe.lance({ addr: '0xp', lot: 'deux' }), xe.lance({ addr: '0xp', lot: 'deux' })]);
  ok([e1.code || 200, e2.code || 200].sort().join(',') === '200,429' && appE === 2, 'module : deux lance() simultanes, ' + [e1.code || 200, e2.code || 200].join(' et ') + ', ' + appE + ' appels (un seul lot)');

  console.log('\n-- 10. refaire la finition : la meilleure prise, les autres lots du meme monstre, 0 $ --');
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-reprise-')); AEFFACER.push(d);
    const jr10 = path.join(d, 'j.jsonl'); fs.writeFileSync(jr10, '');
    const poseA = 'p'.repeat(48) + '.png', poseB = 'q'.repeat(48) + '.png', poseX = 'x'.repeat(48) + '.png';
    fs.writeFileSync(path.join(d, poseA), pose); fs.writeFileSync(path.join(d, poseB), pose); fs.writeFileSync(path.join(d, poseX), Buffer.concat([pose, Buffer.from('autre')]));
    const clip = (action, modele, f) => ({ monstre: 'pirate', action, mode: 'bande', modele, duree: 2, reserve: 0.4, statut: 'done', coutUsd: 0.3, fichier: f.repeat(48) + '.mp4' });
    const idA = '1'.repeat(24), idB = '2'.repeat(24), idX = '3'.repeat(24), idC = '4'.repeat(24);
    const ecrit10 = (m) => fs.writeFileSync(path.join(d, m.id + '.json'), JSON.stringify(m));
    /* A : marche 1.5 puis marche lite (la lite est la DERNIERE), attaque ; B : la sonde (repos, meme pose) ;
       X : un saut sur une AUTRE pose ; C : une course qui a echoue (pas de fichier) */
    ecrit10({ id: idA, t: 2000, addr: '0xp', lot: 'pirate', statut: 'fini', poses: { pirate: poseA },
              clips: [clip('walk', 'grok-imagine-video-1.5', 'a'), clip('attack', 'grok-imagine-video-1.5', 'b'), clip('walk', 'grok-imagine-video-1.5-lite', 'c')] });
    ecrit10({ id: idB, t: 1000, addr: '0xp', lot: 'sonde', statut: 'fini', poses: { pirate: poseB }, clips: [clip('idle', 'grok-imagine-video-1.5', 'd')] });
    ecrit10({ id: idX, t: 3000, addr: '0xp', lot: 'autre', statut: 'fini', poses: { pirate: poseX }, clips: [clip('jump', 'grok-imagine-video-1.5', 'e')] });
    ecrit10({ id: idC, t: 4000, addr: '0xp', lot: 'encore', statut: 'fini', poses: { pirate: poseA }, clips: [Object.assign(clip('run', 'grok-imagine-video-1.5', 'f'), { statut: 'failed', fichier: null })] });
    let appels10 = 0, recu = null, attente = null;
    const m10 = P.cree({ dossier: d, journal: jr10, site: 'https://site.example', pollMs: 10, plafondUsd: 7.5,
      fournisseur: { actif: () => true, lanceVideo: async () => { appels10++; return 'r'; }, litVideo: async () => { appels10++; return {}; } },
      finition: async (o) => { recu = o; await new Promise((r9) => { attente = r9; }); return { qc: { verdict: 'ok', echecs: [] }, actions: {} }; } });
    eq(m10.refais(idA, '0xautre').code, 404, 'refaire le lot d un autre : 404');
    eq(m10.refais('zz', '0xp').code, 404, 'un identifiant invalide : 404');
    const r10 = m10.refais(idA, '0xp');
    ok(r10.ok && r10.statut === 'finition', 'refaire le lot A : accepte');
    for (let i = 0; i < 50 && !recu; i++) await dort(10);
    eq(m10.refais(idB, '0xp').code, 429, 'pendant ce temps, un autre « refaire » : 429');
    const pris = recu ? recu.clips.map((c) => c.action + '=' + path.basename(c.fichier).slice(0, 1)).sort().join(' ') : '';
    eq(pris, 'attack=b idle=d walk=a', 'la marche 1.5 (a) gardee contre la lite (c) arrivee apres ; le repos de la sonde (d, meme pose) ajoute ; le saut d une AUTRE pose (e) et la course ratee (f) ignores');
    if (attente) attente();
    for (let i = 0; i < 50 && m10.enCours(); i++) await dort(10);
    const e10 = m10.etat(idA, '0xp');
    ok(e10.statut === 'fini' && m10.enCours() === null && appels10 === 0 && m10.depense() === 0, 'lot A fini de nouveau, verrou rendu, zero appel xAI, 0 $ (' + appels10 + ' appels)');
    ok((e10.planches[0].prises || []).join(',') === 'walk 1.5,attack 1.5,idle 1.5', 'la page voit les prises gardees (' + (e10.planches[0].prises || []).join(', ') + ')');
  }

  /* f. le plafond ne peut que baisser */
  const dPf = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-reprise-')); AEFFACER.push(dPf);
  process.env.PLANCHES_PLAFOND_USD = '1000';
  ok(P.cree({ dossier: dPf, journal: path.join(dPf, 'j.jsonl'), fournisseur: fourn, site: 'https://s' }).PLAFOND === 7.5, 'PLANCHES_PLAFOND_USD=1000 : le plafond reste 7,50 $');
  process.env.PLANCHES_PLAFOND_USD = '2';
  ok(P.cree({ dossier: dPf, journal: path.join(dPf, 'j.jsonl'), fournisseur: fourn, site: 'https://s' }).PLAFOND === 2, 'PLANCHES_PLAFOND_USD=2 : il baisse a 2 $');
  delete process.env.PLANCHES_PLAFOND_USD;

  fauxXai.close();
  /* rien ne reste dans /tmp (63 dossiers et 29 Mo apres une vingtaine d'executions, revue du 13/10/2026) */
  AEFFACER.push(dos);
  for (const d of AEFFACER) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* rien */ } }
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
