'use strict';
/* ============================================================================
 * LES VIGNETTES ANIMEES DU STUDIO (/studio/vignettes), SUR LE VRAI SERVEUR
 *
 * Contre un faux xAI local (XAI_BASE_URL) et un faux site (fetch intercepte
 * pour site.example et vidgen.x.ai seulement). Ce qu'elle DOIT tenir :
 *   1. sans session : 401 ; un autre portefeuille apprend « proprietaire:
 *      false » et rien d'autre ; son POST : 403 AVANT la lecture du corps ;
 *   2. le proprietaire voit SON plafond (1,25 $, pas les 7,50 $ des planches)
 *      et le pire cas de chaque lot au tarif lite 480p + l'image d'entree ;
 *   3. refus SANS appel : pire cas au-dela du plafond, sha256 faux, image qui
 *      n'est pas un JPEG, champ hors de la liste fermee (un texte libre, un
 *      modele), format hors de la spec, la meme carte deux fois ;
 *   4. le lot part pour l'adresse de la SESSION ; xAI recoit lite, 480p, 16:9,
 *      muet, SANS last_frame, l'image du site octet pour octet en JPEG, et
 *      NOTRE consigne ; un second lot pendant le premier : 429 sans appel ;
 *   5. journal : « envoi » (reserve) sur le disque AVANT l'appel, « sent »,
 *      puis le cout reel (ticks) ; la finition (vrai ffmpeg) rend la boucle
 *      aller-retour en MP4 et WebM, telechargeables par le SEUL proprietaire
 *      qui a lance le lot ;
 *   6. une video hors de x.ai n'est pas telechargee (son cout est compte) ;
 *   7. aucun $SWOGE debite ; la cle n'apparait dans aucune reponse ; deux Run
 *      simultanes : un seul lot ;
 *   8. (module) reprise apres redemarrage, ARRET sur un cout au-dela de sa
 *      reserve, 423 ensuite ;
 *   9. (module) pas de reponse / 5xx = reserve comptee + ARRET ; 4xx = 0 $ ;
 *      journal inecrivable = aucun appel ; VIGNETTES_PLAFOND_USD ne peut que
 *      baisser le plafond ;
 *  10. le fichier PUBLIE du site (img/site/studio/vignettes.json) : chaque
 *      entree valide, chaque sha256 juste, et la somme des pires cas tient
 *      dans le plafond.
 * ==========================================================================*/
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/vignettes-route-');
const AEFFACER = [process.env.DATA_DIR];
/* le tarif officiel ecrit ICI a la main (fiche de grok-imagine-video-1.5-lite, 13/10/2026) :
   0,02 $/s en 480p, 0,01 $ par image d'entree, une seule image (pas de last_frame en lite) */
const reel = (d) => Math.round((0.02 * d + 0.01) * 1e6) / 1e6;
const pireDe = (d) => Math.round(reel(d) * 1.25 * 1e4) / 1e4;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0'; process.env.KLING_TG = '0';
process.env.STUDIO_VIDEO_POLL_MS = '200';
process.env.PUBLIC_URL = 'https://srv.example';
process.env.SITE_URL = 'https://site.example';
delete process.env.GROK_API_KEY; delete process.env.VIGNETTES_PLAFOND_USD;
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
  const V = require('./vignettes');
  /* ---- l'image d'entree (un vrai JPEG 16:9) et un vrai clip brut de 1 s (ffmpeg) ---- */
  const dFx = fs.mkdtempSync(path.join(os.tmpdir(), 'vignettes-fx-')); AEFFACER.push(dFx);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=854x480', '-frames:v', '1', '-q:v', '3', path.join(dFx, 'a.jpg')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=848x480:rate=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dFx, 'brut.mp4')]);
  const jpg = fs.readFileSync(path.join(dFx, 'a.jpg')), sha = crypto.createHash('sha256').update(jpg).digest('hex');
  const brut = fs.readFileSync(path.join(dFx, 'brut.mp4'));
  const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(64)]), shaWebp = crypto.createHash('sha256').update(webp).digest('hex');
  const E = (carte, duree, extra) => Object.assign({ carte, source: 'accueil/ia.webp', pos: '50% 0%', image: 'studio/vignettes/a.jpg', sha256: sha, format: '16:9', duree }, extra || {});
  const fichierSite = { lots: {
    sonde: [E('grok:rapide', 3), E('kling-i', 2)],
    gros: Array.from({ length: 16 }, (x, i) => E('c' + i, 4)),                       /* 16 x 0,1125 $ = 1,80 $ > 1,25 $ */
    faux_sha: [E('grok:rapide', 3, { sha256: 'f'.repeat(64) })],
    pas_jpeg: [E('grok:rapide', 3, { image: 'studio/vignettes/b.jpg', sha256: shaWebp })],
    texte_libre: [E('grok:rapide', 3, { prompt: 'anything I want' })],
    modele: [E('grok:rapide', 3, { modele: 'grok-imagine-video-1.5' })],
    format: [E('grok:rapide', 3, { format: '5:2' })],
    double: [E('grok:rapide', 3), E('grok:rapide', 2)],
    ailleurs: [E('veo', 1)],
  } };
  let lenteurSite = 0;

  /* ---- le faux xAI ---- */
  const vus = [];
  let nGen = 0;
  const dureeDe = {};
  const fauxXai = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      const corps = b ? JSON.parse(b) : null;
      vus.push({ methode: q.method, url: q.url, auth: q.headers.authorization, corps,
                 journal: fs.existsSync(path.join(process.env.DATA_DIR, 'vignettes_essais.jsonl')) ? fs.readFileSync(path.join(process.env.DATA_DIR, 'vignettes_essais.jsonl'), 'utf8') : '' });
      r.writeHead(200, { 'content-type': 'application/json' });
      if (q.method === 'POST' && q.url === '/v1/videos/generations') { const id = 'vid-' + (++nGen); dureeDe[id] = corps.duration; return r.end(JSON.stringify({ request_id: id })); }
      const m = /^\/v1\/videos\/(vid-\d+)$/.exec(q.url);
      if (m) {
        const d = dureeDe[m[1]];
        const url = d === 1 ? 'https://evil.example/' + m[1] + '.mp4' : 'https://vidgen.x.ai/' + m[1] + '.mp4';
        return r.end(JSON.stringify({ status: 'done', video: { url, duration: d }, usage: { cost_in_usd_ticks: Math.round(reel(d) * 1e10) } }));
      }
      r.end('{}');
    });
  });
  const pX = await libre(); await new Promise((r) => fauxXai.listen(pX, r));
  process.env.XAI_API_KEY = 'xai-test-local';
  process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pX;

  const vraiFetch = globalThis.fetch, telecharges = [];
  const rep = (b, type) => new Response(b, { status: 200, headers: { 'content-type': type } });
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url === 'https://site.example/img/site/studio/vignettes.json') { if (lenteurSite) await dort(lenteurSite); return rep(JSON.stringify(fichierSite), 'application/json'); }
    if (url === 'https://site.example/img/site/studio/vignettes/a.jpg') return rep(jpg, 'image/jpeg');
    if (url === 'https://site.example/img/site/studio/vignettes/b.jpg') return rep(webp, 'image/jpeg');
    if (url.startsWith('https://site.example/')) return new Response('', { status: 404 });
    if (/^https:\/\/vidgen\.x\.ai\/vid-\d+\.mp4$/.test(url)) { telecharges.push(url); return rep(brut, 'video/mp4'); }
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
  const attendsLot = async (id, H) => { let l = null; for (let i = 0; i < 600; i++) { l = await api('/studio/vignettes/lot/' + id, H); if (l.statut === 'fini') break; await dort(100); } return l; };

  console.log('-- 1. la session, et rien d autre --');
  eq((await api('/studio/vignettes', {})).http, 401, 'sans session : GET 401');
  eq((await api('/studio/vignettes', { 'content-type': 'application/json' }, 'POST', { lot: 'sonde' })).http, 401, 'sans session : POST 401');
  const pre = await vraiFetch(base + '/studio/vignettes', { method: 'OPTIONS' });
  ok(pre.status === 204 && /authorization/.test(pre.headers.get('access-control-allow-headers') || ''), 'OPTIONS : 204 avec CORS, sans session');
  const proprio = await connecte(port, OWNER), proprio2 = await connecte(port, OWNER2), bob = await connecte(port, ethers.Wallet.createRandom());
  const gb = await api('/studio/vignettes', bob.H);
  ok(gb.http === 200 && gb.proprietaire === false && gb.cles.sort().join(',') === 'ok,proprietaire', 'un autre portefeuille : proprietaire false, AUCUN autre champ');
  const suspendu = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/vignettes', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bob.H.authorization, 'content-length': String(1024 * 1024) } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode }); q.destroy(); });
    });
    q.on('error', () => {});
    q.write('{"lot":"son');
    setTimeout(() => { res({ delai: true }); q.destroy(); }, 3000);
  });
  ok(suspendu.statut === 403 && xaiPosts() === 0, 'son POST est refuse (403) sans attendre le corps, rien chez xAI [' + (suspendu.statut || 'delai') + ']');

  console.log('\n-- 2. ce que voit le proprietaire --');
  const v0 = await api('/studio/vignettes', proprio.H);
  ok(v0.http === 200 && v0.proprietaire === true && v0.actif === true && v0.plafondUsd === 1.25 && v0.depenseUsd === 0 && v0.modele === 'grok-imagine-video-1.5-lite' && v0.resolution === '480p',
     'proprietaire : plafond 1,25 $ (le sien, pas celui des planches), rien depense, lite 480p');
  const ls = (v0.vignettes.lots || []).find((l) => l.nom === 'sonde'), lg = (v0.vignettes.lots || []).find((l) => l.nom === 'gros');
  const pSonde = Math.round((pireDe(3) + pireDe(2)) * 1e4) / 1e4;
  ok(ls && Math.abs(ls.reserveUsd - pSonde) < 1e-9 && ls.secondes === 5 && lg && Math.abs(lg.reserveUsd - 16 * pireDe(4)) < 1e-9,
     'pire cas = (0,02 $/s x duree + 0,01 $) x 1,25 : sonde ' + (ls && ls.reserveUsd) + ' $ (attendu ' + pSonde + '), gros ' + (lg && lg.reserveUsd) + ' $');
  const inv = (nom) => ((v0.vignettes.lots || []).find((l) => l.nom === nom) || {}).invalide;
  ok(inv('texte_libre') === 'unknown field prompt' && inv('modele') === 'unknown field modele' && inv('format') === 'format', 'un texte libre, un modele, un format hors spec : marques invalides');

  console.log('\n-- 3. refus SANS appel --');
  const rg = await api('/studio/vignettes', proprio.H, 'POST', { lot: 'gros' });
  ok(rg.http === 402 && /could cost up to 1\.8000 \$/.test(rg.raison) && xaiPosts() === 0, 'lot de 1,80 $ au pire contre 1,25 $ : 402, xAI n a rien recu (' + rg.raison + ')');
  ok((await api('/studio/vignettes', proprio.H, 'POST', { lot: 'faux_sha' })).http === 409 && xaiPosts() === 0, 'sha256 qui ne correspond pas : 409, rien envoye');
  const rpj = await api('/studio/vignettes', proprio.H, 'POST', { lot: 'pas_jpeg' });
  ok(rpj.http === 400 && /not a JPEG/.test(rpj.raison) && xaiPosts() === 0, 'un WebP sous un nom .jpg : 400, rien envoye (' + rpj.raison + ')');
  for (const l of ['texte_libre', 'modele', 'format', 'double']) {
    const x = await api('/studio/vignettes', proprio.H, 'POST', { lot: l });
    ok(x.http === 400 && xaiPosts() === 0, l + ' : 400, rien envoye (' + x.raison + ')');
  }
  ok((await api('/studio/vignettes', proprio.H, 'POST', { lot: '../etc' })).http === 400 && (await api('/studio/vignettes', proprio.H, 'POST', { lot: 'absent' })).http === 404, 'nom de lot invalide : 400 ; lot absent : 404');

  console.log('\n-- 4. le lot part --');
  const solde0 = moteur && moteur.balanceStr(proprio.adr);
  const r = await api('/studio/vignettes', proprio.H, 'POST', { lot: 'sonde', addr: bob.adr });
  ok(r.http === 200 && r.lances === 2 && /^[0-9a-f]{24}$/.test(r.id), 'sonde lancee : 2 clips');
  const posts = vus.filter((v) => v.methode === 'POST');
  const c1 = posts[0].corps, c2 = posts[1].corps;
  ok(c1.model === 'grok-imagine-video-1.5-lite' && c1.resolution === '480p' && c1.aspect_ratio === '16:9' && c1.generate_audio === false && c1.last_frame === undefined && c1.duration === 3 && c2.duration === 2,
     'lite, 480p, 16:9, muet, sans last_frame, 3 s puis 2 s');
  ok(/^data:image\/jpeg;base64,/.test(c1.image.url) && Buffer.from(c1.image.url.split(',')[1], 'base64').equals(jpg), 'l image envoyee est le JPEG du site, octet pour octet');
  ok(c1.prompt === V.CONSIGNE && /no text/.test(c1.prompt) && /does not move/.test(c1.prompt) && c2.prompt === c1.prompt, 'la consigne est NOTRE constante, la meme pour chaque carte');
  ok(posts.every((p) => p.auth === 'Bearer xai-test-local'), 'la cle part vers xAI seulement');
  const envoiAvant = (p, idx) => p.journal.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((l) => l.lot === r.id && l.idx === idx && l.statut === 'envoi' && l.reserve > 0);
  ok(envoiAvant(posts[0], 0) && envoiAvant(posts[1], 1), 'quand xAI recoit chaque appel, sa ligne « envoi » (avec reserve) est DEJA dans le journal');
  eq((await api('/studio/vignettes/lot/' + r.id, proprio2.H)).http, 404, 'le lot est a la SESSION qui l a lance (l adresse du corps est ignoree)');
  const r2 = await api('/studio/vignettes', proprio.H, 'POST', { lot: 'sonde' });
  ok(r2.http === 429 && xaiPosts() === 2, 'un second lot pendant le premier : 429, rien envoye');

  console.log('\n-- 5. journal, finition, fichiers --');
  const lot = await attendsLot(r.id, proprio.H);
  ok(lot.statut === 'fini' && lot.clips.every((c) => c.statut === 'done' && /^[0-9a-f]{48}\.mp4$/.test(c.fichier)), 'les 2 clips sont arrives depuis x.ai');
  const J = fs.readFileSync(path.join(process.env.DATA_DIR, 'vignettes_essais.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.lot === r.id && l.idx === 0);
  ok(J.length === 3 && J[0].statut === 'envoi' && J[0].reserve === pireDe(3) && J[1].statut === 'sent' && J[1].rid === 'vid-1' && J[2].statut === 'done' && J[2].coutUsd === reel(3),
     'journal du clip 1 : envoi (' + (J[0] && J[0].reserve) + ' $), sent (vid-1), puis ' + (J[2] && J[2].coutUsd) + ' $ lus dans les ticks');
  ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'vignettes', 'ARRET')), 'le cout reel tient dans sa reserve : aucun ARRET');
  const k = lot.clips[0];
  ok(k.fini === 'grok-rapide.mp4' && k.finiWebm === 'grok-rapide.webm' && lot.clips[1].fini === 'kling-i.mp4' && !k.erreurFinition, 'finition : grok-rapide.mp4 et .webm, kling-i.mp4 (' + (k.erreurFinition || 'sans erreur') + ')');
  const fm = await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/grok-rapide.mp4', { headers: proprio.H });
  const bm = Buffer.from(await fm.arrayBuffer());
  const fMp4 = path.join(dFx, 'fini.mp4'); fs.writeFileSync(fMp4, bm);
  const images = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', fMp4]).toString().trim());
  const sons = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', fMp4]).toString().trim();
  ok(fm.status === 200 && fm.headers.get('content-type') === 'video/mp4' && images === 46 && sons === '', 'le MP4 fini : aller-retour (24 images -> 23 + 23 = ' + images + '), muet');
  const fw = await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/grok-rapide.webm', { headers: proprio.H });
  const bw = Buffer.from(await fw.arrayBuffer());
  ok(fw.status === 200 && fw.headers.get('content-type') === 'video/webm' && bw.readUInt32BE(0) === 0x1a45dfa3, 'et le WebM (video/webm, en-tete EBML)');
  eq((await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/' + k.fichier, { headers: proprio.H })).status, 200, 'le clip brut aussi (pour refaire la finition a la main)');
  eq((await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/grok-rapide.mp4', { headers: proprio2.H })).status, 404, 'un autre proprietaire : 404');
  eq((await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/grok-rapide.mp4', { headers: bob.H })).status, 403, 'un non-proprietaire : 403');
  eq((await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/grok-rapide.mp4')).status, 401, 'sans session : 401');
  eq((await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/..%2Fvignettes_essais.mp4', { headers: proprio.H })).status, 404, 'un chemin hors du lot : 404');
  eq((await vraiFetch(base + '/studio/vignettes/fichier/' + r.id + '/veo.mp4', { headers: proprio.H })).status, 404, 'une carte qui n est pas dans le lot : 404');

  console.log('\n-- 6. un hote qui n est pas x.ai --');
  const ra = await api('/studio/vignettes', proprio.H, 'POST', { lot: 'ailleurs' });
  const la = await attendsLot(ra.id, proprio.H);
  ok(la.clips[0].statut === 'failed' && /refused host evil\.example/.test(la.clips[0].erreur) && !telecharges.some((u) => u.includes('evil')), 'video sur evil.example : refusee, jamais telechargee');
  ok(la.clips[0].coutUsd === reel(1), 'son cout est quand meme compte (' + la.clips[0].coutUsd + ' $)');

  console.log('\n-- 7. argent et cle --');
  const v1 = await api('/studio/vignettes', proprio.H);
  const dep = Math.round((reel(3) + reel(2) + reel(1)) * 1e6) / 1e6;
  ok(Math.abs(v1.depenseUsd - dep) < 1e-9 && Math.abs(v1.resteUsd - (1.25 - dep)) < 1e-9, 'depense = la somme des ticks : ' + v1.depenseUsd + ' $, reste ' + v1.resteUsd + ' $');
  const vPl = await api('/studio/planches', proprio.H);
  ok(vPl.depenseUsd === 0 && vPl.plafondUsd === 7.5, 'le budget des planches n a pas bouge (' + vPl.depenseUsd + ' $ sur ' + vPl.plafondUsd + ')');
  ok(!moteur || moteur.balanceStr(proprio.adr) === solde0, 'aucun $SWOGE debite');
  ok(!textes.some((t) => t.includes('xai-test-local')), 'la cle xAI n apparait dans aucune reponse');
  lenteurSite = 150;
  const postsAvant = xaiPosts();
  const [ca, cb] = await Promise.all([api('/studio/vignettes', proprio.H, 'POST', { lot: 'ailleurs' }), api('/studio/vignettes', proprio.H, 'POST', { lot: 'ailleurs' })]);
  lenteurSite = 0;
  const codes = [ca.http, cb.http].sort().join(',');
  ok(codes === '200,429' && xaiPosts() - postsAvant === 1, 'deux Run simultanes : ' + codes + ', ' + (xaiPosts() - postsAvant) + ' appel chez xAI');
  await attendsLot((ca.http === 200 ? ca : cb).id, proprio.H);
  proprio.s.close(); proprio2.s.close(); bob.s.close();

  console.log('\n-- 8. le module : redemarrage et ARRET --');
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'vignettes-reprise-')), jr = path.join(dos, 'j.jsonl'); AEFFACER.push(dos);
  const idl = 'a'.repeat(24);
  fs.writeFileSync(path.join(dos, idl + '.json'), JSON.stringify({ id: idl, t: Date.now(), addr: '0xabc', lot: 'x', statut: 'lance',
    clips: [{ carte: 'grok:rapide', duree: 3, format: '16:9', reserve: 0.0875, statut: 'sent', t: Date.now() },
            { carte: 'veo', duree: 2, format: '16:9', reserve: 0.0625, statut: 'envoi', t: Date.now() }] }));
  fs.writeFileSync(jr, [{ type: 'clip', lot: idl, idx: 0, statut: 'envoi', reserve: 0.0875 }, { type: 'clip', lot: idl, idx: 0, statut: 'sent', rid: 'r0' },
                        { type: 'clip', lot: idl, idx: 1, statut: 'envoi', reserve: 0.0625 }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const lus = [];
  let finitions = 0;
  const fourn = { actif: () => true, lanceVideo: async () => { lus.push('lance'); return 'r9'; },
                  litVideo: async (id) => { lus.push(id); return { status: 'done', video: { url: 'https://vidgen.x.ai/vid-1.mp4' }, usage: { cost_in_usd_ticks: 2e9 } }; } };
  const mod = V.cree({ dossier: dos, journal: jr, fournisseur: fourn, site: 'https://site.example', pollMs: 20, plafondUsd: 1.25,
                       finition: async () => { finitions++; return { octets: 1, webm: null }; } });
  ok(Math.abs(mod.depense() - 0.15) < 1e-9, 'au demarrage : les deux reserves en vol sont comptees (0,15 $)');
  for (let i = 0; i < 100 && mod.etat(idl, '0xabc').statut !== 'fini'; i++) await dort(20);
  const fin0 = fs.readFileSync(jr, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.idx === 0).pop();
  ok(lus.includes('r0') && fin0.statut === 'done' && fin0.coutUsd === 0.2 && finitions === 1, 'le clip « sent » est repris, son cout reel journalise (0,20 $), et il est fini');
  ok(Math.abs(mod.depense() - 0.2625) < 1e-9 && mod.etat(idl, '0xabc').clips[1].statut === 'inconnu', 'l « envoi » sans reponse garde sa reserve : 0,20 + 0,0625 $');
  ok(fs.existsSync(path.join(dos, 'ARRET')), '0,20 $ pour une reserve de 0,0875 $ : ARRET ecrit');
  const ar = await mod.lance({ addr: '0xabc', lot: 'sonde' });
  ok(!ar.ok && ar.code === 423 && !lus.includes('lance'), 'apres ARRET, un nouveau lot est refuse (423) sans appel');

  console.log('\n-- 9. le module : l argent quand ca casse --');
  const repM = (b) => ({ ok: true, status: 200, arrayBuffer: async () => b });
  const chargeM = async (u) => (/vignettes\.json$/.test(u) ? repM(Buffer.from(JSON.stringify(fichierSite))) : /a\.jpg$/.test(u) ? repM(jpg) : { ok: false, status: 404 });
  const neuf = (opts) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vignettes-reprise-')); AEFFACER.push(d);
    return Object.assign({ d }, V.cree(Object.assign({ dossier: d, journal: path.join(d, 'j.jsonl'), site: 'https://site.example', pollMs: 10, plafondUsd: 1.25, charge: chargeM,
      finition: async () => ({ octets: 1, webm: null }) }, opts))); };
  const derniere = (d) => fs.readFileSync(path.join(d, 'j.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  let appA = 0;
  const xa = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { appA++; throw new TypeError('fetch failed'); }, litVideo: async () => ({}) } });
  const ra9 = await xa.lance({ addr: '0xp', lot: 'sonde' });
  const la9 = derniere(xa.d);
  ok(!ra9.ok && appA === 1 && la9.statut === 'inconnu' && la9.coutUsd === pireDe(3) && xa.depense() === pireDe(3) && fs.existsSync(path.join(xa.d, 'ARRET')),
     'coupure pendant l appel : inconnu, reserve (' + pireDe(3) + ' $) comptee, ARRET, le clip suivant ne part pas');
  ok((await xa.lance({ addr: '0xp', lot: 'sonde' })).code === 423 && appA === 1, 'et le lot suivant est refuse (423) sans appel');
  const x5 = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { const e = new Error('xAI 503 - busy'); e.statut = 503; throw e; }, litVideo: async () => ({}) } });
  await x5.lance({ addr: '0xp', lot: 'sonde' });
  ok(x5.depense() === pireDe(3) && fs.existsSync(path.join(x5.d, 'ARRET')), 'un 503 : reserve comptee et ARRET');
  /* le vrai client studio_xai.js contre une connexion coupee apres reception */
  let recusCoupe = 0;
  const coupe = http.createServer((q2) => { q2.on('data', () => {}); q2.on('end', () => { recusCoupe++; q2.socket.destroy(); }); });
  const pC = await libre(); await new Promise((r9) => coupe.listen(pC, '127.0.0.1', r9));
  const baseAvant = process.env.XAI_BASE_URL; process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pC;
  const xs = neuf({ fournisseur: require('./studio_xai') });
  await xs.lance({ addr: '0xp', lot: 'sonde' });
  process.env.XAI_BASE_URL = baseAvant; coupe.close();
  ok(recusCoupe === 1 && xs.depense() === pireDe(3) && fs.existsSync(path.join(xs.d, 'ARRET')), 'studio_xai, connexion coupee apres reception : reserve comptee, ARRET');
  const x4 = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { const e = new Error('xAI 400 - moderation'); e.statut = 400; throw e; }, litVideo: async () => ({}) } });
  const r4 = await x4.lance({ addr: '0xp', lot: 'sonde' });
  ok(!r4.ok && x4.depense() === 0 && !fs.existsSync(path.join(x4.d, 'ARRET')) && /moderation/.test(r4.raison), 'un 400 recu : 0 $, pas d ARRET (' + r4.raison + ')');
  let appB = 0;
  const xb = neuf({ fournisseur: { actif: () => true, lanceVideo: async () => { appB++; return 'r'; }, litVideo: async () => ({ status: 'pending' }) } });
  fs.mkdirSync(path.join(xb.d, 'j.jsonl'));
  const rb9 = await xb.lance({ addr: '0xp', lot: 'sonde' });
  ok(!rb9.ok && appB === 0 && /journal/.test(rb9.raison || ''), 'journal inecrivable : AUCUN appel (' + rb9.raison + ')');
  let appE = 0;
  const xe = neuf({ charge: async (u) => { await dort(50); return chargeM(u); }, fournisseur: { actif: () => true, lanceVideo: async () => { appE++; return 're' + appE; }, litVideo: async () => ({ status: 'pending' }) } });
  const [e1, e2] = await Promise.all([xe.lance({ addr: '0xp', lot: 'sonde' }), xe.lance({ addr: '0xp', lot: 'sonde' })]);
  ok([e1.code || 200, e2.code || 200].sort().join(',') === '200,429' && appE === 2, 'module : deux lance() simultanes, un 429, ' + appE + ' appels (un seul lot)');
  const dPf = fs.mkdtempSync(path.join(os.tmpdir(), 'vignettes-reprise-')); AEFFACER.push(dPf);
  process.env.VIGNETTES_PLAFOND_USD = '1000';
  ok(V.cree({ dossier: dPf, journal: path.join(dPf, 'j.jsonl'), fournisseur: fourn, site: 'https://s' }).PLAFOND === 1.25, 'VIGNETTES_PLAFOND_USD=1000 : le plafond reste 1,25 $');
  process.env.VIGNETTES_PLAFOND_USD = '0.5';
  ok(V.cree({ dossier: dPf, journal: path.join(dPf, 'j.jsonl'), fournisseur: fourn, site: 'https://s' }).PLAFOND === 0.5, 'VIGNETTES_PLAFOND_USD=0.5 : il baisse a 0,50 $');
  delete process.env.VIGNETTES_PLAFOND_USD;

  console.log('\n-- 10. le fichier publie du site --');
  const site = [process.env.SITE_DIR, path.join(__dirname, '..', 'SWOGE.github.io'), '/home/user/SWOGE.github.io'].filter(Boolean)
    .find((d) => fs.existsSync(path.join(d, 'img/site/studio/vignettes.json')));
  if (!site) ok(false, 'img/site/studio/vignettes.json introuvable (SITE_DIR=<depot du site>)');
  else {
    const pub = JSON.parse(fs.readFileSync(path.join(site, 'img/site/studio/vignettes.json'), 'utf8'));
    const toutes = [].concat(...Object.values(pub.lots));
    const bads = toutes.map((d) => [d.carte, V.valideEntree(d)]).filter((x) => x[1]);
    ok(!bads.length, toutes.length + ' entrees publiees, toutes valides' + (bads.length ? ' — ' + JSON.stringify(bads) : ''));
    const faux = toutes.filter((d) => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(site, 'img/site', d.image))).digest('hex') !== d.sha256; } catch (e) { return true; } });
    ok(!faux.length, 'chaque sha256 est celui du JPEG publie' + (faux.length ? ' — faux : ' + faux.map((d) => d.carte).join(', ') : ''));
    ok(new Set(toutes.map((d) => d.carte)).size === toutes.length, 'chaque carte une seule fois, tous lots confondus');
    const total = Math.round(toutes.reduce((s, d) => s + V.reserveDe(d.duree), 0) * 1e4) / 1e4;
    const attendu = Math.round(toutes.reduce((s, d) => s + reel(d.duree), 0) * 1e4) / 1e4;
    ok(total <= 1.25 + 1e-9, 'tous les lots ensemble : ' + total + ' $ au pire (' + attendu + ' $ au tarif) pour 1,25 $ de plafond');
  }

  fauxXai.close();
  for (const d of AEFFACER) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* rien */ } }
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
