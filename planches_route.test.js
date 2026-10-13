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
 *   6. une video sur un hote qui n'est pas x.ai n'est pas telechargee ;
 *   7. aucun $SWOGE debite ; la cle xAI n'apparait dans aucune reponse ;
 *   8. (module) reprise apres redemarrage : un clip « sent » est suivi jusqu'a
 *      son cout ; un « envoi » sans reponse garde sa reserve ; un cout au-dela
 *      de sa reserve ARRETE tout.
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
  const fx = await fabrique({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'planches-clips-')), actions: ['idle', 'walk'] });
  const pose = fs.readFileSync(fx.pose), sha = crypto.createHash('sha256').update(pose).digest('hex');
  const mp4 = { idle: fs.readFileSync(fx.clips[0].fichier), walk: fs.readFileSync(fx.clips[1].fichier) };
  const D = (action, duree, extra) => Object.assign({ monstre: 'mannequin', action, mode: 'bande', modele: 'grok-imagine-video-1.5', duree, sha256: sha }, extra || {});
  const demandes = { lots: {
    pilote: [D('idle', 2), D('walk', 3)],
    gros: Array.from({ length: 24 }, () => D('walk', 4)),                     /* 24 x 0,40 $ = 9,60 $ > 7,50 $ */
    faux_sha: [D('idle', 2, { sha256: 'f'.repeat(64) })],
    hors_liste: [D('idle', 2, { prompt: 'anything I want' })],
    ailleurs: [D('idle', 1, { modele: 'grok-imagine-video-1.5-lite' })],
  } };

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
        actionDe[id] = { action: /walk in place/.test(corps.prompt) ? 'walk' : 'idle', duree: corps.duration, modele: corps.model };
        return r.end(JSON.stringify({ request_id: id }));
      }
      const m = /^\/v1\/videos\/(vid-\d+)$/.exec(q.url);
      if (m) {
        const a = actionDe[m[1]], prix = a.modele === 'grok-imagine-video-1.5' ? 0.08 : 0.02;
        const url = a.modele === 'grok-imagine-video-1.5-lite' ? 'https://evil.example/' + m[1] + '.mp4' : 'https://vidgen.x.ai/' + a.action + '.mp4';
        return r.end(JSON.stringify({ status: 'done', video: { url, duration: a.duree }, usage: { cost_in_usd_ticks: Math.round(prix * a.duree * 1e10) } }));
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
    if (url === 'https://site.example/img/nexus/monstres/iso/poses/demandes.json') return rep(JSON.stringify(demandes), 'application/json');
    if (url === 'https://site.example/img/nexus/monstres/iso/poses/mannequin.png') return rep(pose, 'image/png');
    if (url.startsWith('https://site.example/')) return new Response('', { status: 404 });
    const v = /^https:\/\/vidgen\.x\.ai\/(idle|walk)\.mp4$/.exec(url);
    if (v) { telecharges.push(url); return rep(mp4[v[1]], 'video/mp4'); }
    if (url.startsWith('https://evil.example/')) { telecharges.push(url); return rep(Buffer.from('nope'), 'video/mp4'); }
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
  ok(lp && lp.reserveUsd === 0.5 && lp.secondes === 5 && lg && lg.reserveUsd === 9.6, 'pire cas lu dans demandes.json : pilote 0,50 $ (2 s + 3 s a 0,08 $ x 1,25), gros 9,60 $');
  ok((v0.demandes.lots.find((l) => l.nom === 'hors_liste') || {}).invalide === 'unknown field prompt', 'une demande hors liste est marquee invalide');

  console.log('\n-- 3. refus SANS appel --');
  const rg = await api('/studio/planches', proprio.H, 'POST', { lot: 'gros' });
  ok(rg.http === 402 && /could cost up to 9\.60 \$/.test(rg.raison) && xaiPosts() === 0, 'lot de 9,60 $ au pire contre 7,50 $ de plafond : 402, xAI n a rien recu');
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
  for (let i = 0; i < 300; i++) { lot = await api('/studio/planches/lot/' + r.id, proprio.H); if (lot.statut === 'fini') break; await dort(200); }
  ok(lot.statut === 'fini' && lot.clips.every((c) => c.statut === 'done' && /^[0-9a-f]{48}\.mp4$/.test(c.fichier)), 'les 2 clips sont arrives et telecharges depuis x.ai');
  const J = fs.readFileSync(path.join(process.env.DATA_DIR, 'planches_essais.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.lot === r.id && l.idx === 0);
  ok(J.length === 3 && J[0].statut === 'envoi' && J[0].reserve === 0.2 && J[1].statut === 'sent' && J[1].rid === 'vid-1' && J[2].statut === 'done' && J[2].coutUsd === 0.16,
     'journal du clip 1 : envoi (reserve 0,20 $) AVANT, sent (vid-1), puis 0,16 $ lus dans les ticks');
  const pl = lot.planches && lot.planches[0];
  ok(pl && pl.monstre === 'mannequin' && pl.verdict === 'ok' && pl.fichiers.includes('mannequin.json') && pl.fichiers.includes('mannequin/walk.webp'), 'la finition a rendu une planche qui passe ses controles (' + (pl && (pl.verdict + ' ' + (pl.echecs || []).join(' '))) + ')');
  const fiche = await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json', { headers: proprio.H });
  const fj = await fiche.json().catch(() => ({}));
  ok(fiche.status === 200 && fj.format === 'swoge-planche-iso/1' && fj.actions.walk && fj.cout_usd === 0.4, 'le proprietaire lit la fiche (cout reel 0,40 $ dedans)');
  const img = await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin/walk.webp', { headers: proprio.H });
  ok(img.status === 200 && img.headers.get('content-type') === 'image/webp' && (await img.arrayBuffer()).byteLength > 1000, 'et la planche de marche (image/webp)');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json', { headers: proprio2.H })).status, 404, 'un autre proprietaire : 404');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json', { headers: bob.H })).status, 403, 'un non-proprietaire : 403');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/mannequin.json')).status, 401, 'sans session : 401');
  eq((await vraiFetch(base + '/studio/planches/fichier/' + r.id + '/..%2Fplanches_essais.json', { headers: proprio.H })).status, 404, 'un chemin hors du lot : 404');

  console.log('\n-- 6. un hote qui n est pas x.ai --');
  const ra = await api('/studio/planches', proprio.H, 'POST', { lot: 'ailleurs' });
  let la = null;
  for (let i = 0; i < 100; i++) { la = await api('/studio/planches/lot/' + ra.id, proprio.H); if (la.statut === 'fini') break; await dort(100); }
  ok(la.clips[0].statut === 'failed' && /refused host evil\.example/.test(la.clips[0].erreur) && !telecharges.some((u) => u.includes('evil')), 'video sur evil.example : refusee, jamais telechargee');
  ok(la.clips[0].coutUsd === 0.02 && vus.filter((v) => v.methode === 'POST').pop().corps.last_frame === undefined, 'son cout est quand meme compte (0,02 $), et lite part sans last_frame (1.5 seul l accepte)');

  console.log('\n-- 7. argent et cle --');
  const v1 = await api('/studio/planches', proprio.H);
  ok(Math.abs(v1.depenseUsd - 0.42) < 1e-9 && Math.abs(v1.resteUsd - 7.08) < 1e-9, 'depense = la somme des ticks : 0,42 $, reste 7,08 $');
  ok(!moteur || moteur.balanceStr(proprio.adr) === solde0, 'aucun $SWOGE debite');
  ok(!textes.some((t) => t.includes('xai-test-local')), 'la cle xAI n apparait dans aucune reponse');
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

  fauxXai.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
