'use strict';
/* ============================================================================
 * LA VIDEO ENTIERE PAR MORCEAUX (/studio/kling/entier), SUR UN VRAI SERVEUR
 *
 * Ce qu'elle DOIT tenir :
 *   1. sans session : 401 ; un autre portefeuille : 403 AVANT de lire le corps
 *      (rien ecrit, rien chez Kling) ; plus de 100 Mo annonces : 413 ;
 *   2. le proprietaire televerse le corps BRUT (video/mp4) ; le plan (morceaux,
 *      prix au pire, plafond) vient avant tout envoi ;
 *   3. un prix confirme different : 409, rien chez Kling ; le bon : Kling recoit
 *      chaque morceau par son URL PUBLIQUE (les octets du morceau, sans session),
 *      le corps (image_1) et le visage (image_2) par leurs URL, son d'origine ;
 *   4. le suivi (GET de l'etat) avance la passe jusqu'au resultat ; la video
 *      finale ne sort qu'avec la session du proprietaire (401 sans, 403 pour un
 *      autre), a la longueur de la source ; les morceaux ne sont plus servis ;
 *   5. le journal garde chaque envoi et chaque fin ; la cle ne sort jamais.
 * Kling et son CDN sont simules en remplacant `fetch` pour leurs seuls
 * domaines : aucun appel reel. ffmpeg est le vrai.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/kling-entier-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete';
process.env.KLING_TG = '0';
process.env.SITE_URL = 'https://site.example';
delete process.env.KLING_ENTIER_PLAFOND_USD; delete process.env.KLING_ENTIER_PARALLELE;
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;

let ffmpegOk = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { ffmpegOk = false; }
const VIDEO = path.join(process.env.DATA_DIR, 'source.mp4');
if (ffmpegOk) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '14', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-t', '14', '-i', 'sine=frequency=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VIDEO]);
}

/* Kling simule : il LIT le morceau a l'URL donnee, et le rend tel quel par « son CDN ». */
const recus = [], taches = {};
let etatTaches = 'processing', luParKling = [];
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.startsWith('https://p2-kling.klingai.com/')) {
    const id = /\/r\/(\w+)\.mp4$/.exec(url); const t = id && taches[id[1]];
    if (!t) return new Response('', { status: 404 });
    return new Response(t.octets, { status: 200, headers: { 'content-length': String(t.octets.length) } });
  }
  if (!url.startsWith('https://api-singapore.klingai.com')) return vraiFetch(u, o);
  recus.push({ url, o });
  const rep = (j) => ({ status: 200, ok: true, json: async () => j });
  const m = /\/tasks\?task_ids=(\w+)/.exec(url);
  if (m) {
    const t = taches[m[1]];
    return rep({ code: 0, data: t ? [etatTaches === 'succeeded'
      ? { id: m[1], status: 'succeeded', outputs: [{ type: 'video', url: 'https://p2-kling.klingai.com/r/' + m[1] + '.mp4', duration: String(t.duree) }], billing: [{ charge_type: 'unit', amount: '6.3', package_type: 'video' }] }
      : { id: m[1], status: etatTaches }] : [] });
  }
  if (/external_task_ids/.test(url)) return rep({ code: 0, data: [] });
  const b = JSON.parse(o.body);
  const v = b.contents.find((c) => c.type === 'base_video');
  const r = await vraiFetch(v.url);
  const octets = Buffer.from(await r.arrayBuffer());
  luParKling.push({ statut: r.status, octets, url: v.url });
  const id = 'E' + (Object.keys(taches).length + 1);
  taches[id] = { octets, duree: 7 };
  return rep({ code: 0, data: { id, status: 'submitted' } });
};

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });

async function connecte(port, w) {
  const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => s.on('open', r));
  const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  const auth = await attend('auth');
  return { s, H: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session } };
}

(async () => {
  if (!ffmpegOk) { console.log('ffmpeg absent : essai ignore'); return; }
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;   /* Kling simule lit les morceaux ici */
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const textes = [];
  const appel = async (chemin, H, corps, methode, brut) => {
    const r = await vraiFetch(B + chemin, { method: methode || (corps || brut ? 'POST' : 'GET'), headers: H || {}, body: brut || (corps ? JSON.stringify(corps) : undefined) });
    const t = await r.text(); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return { statut: r.status, j, t };
  };
  const journal = () => { try { return fs.readFileSync(path.join(process.env.DATA_DIR, 'kling_essais.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch (e) { return []; } };
  const DOSSIER = path.join(process.env.DATA_DIR, 'kling_entier');
  const passes = () => { try { return fs.readdirSync(DOSSIER); } catch (e) { return []; } };
  const octets = fs.readFileSync(VIDEO);

  console.log('-- 1. qui peut --');
  ok((await appel('/studio/kling/entier', { 'content-type': 'video/mp4' }, null, 'POST', octets)).statut === 401, 'sans session : 401');
  const autre = await connecte(port, ethers.Wallet.createRandom());
  const suspendu = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/kling/entier', method: 'POST',
      headers: { 'content-type': 'video/mp4', authorization: autre.H.authorization, 'content-length': String(60 * 1024 * 1024) } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
    });
    q.on('error', () => res({ statut: 0 }));
    q.write(octets.slice(0, 4096));
  });
  ok(suspendu.statut === 403 && recus.length === 0 && passes().length === 0, 'un autre portefeuille : 403 sans que le corps soit lu, rien ecrit, rien chez Kling');
  const moi = await connecte(port, OWNER);
  const HV = { 'content-type': 'video/mp4', authorization: moi.H.authorization };
  const trop = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/kling/entier', method: 'POST',
      headers: Object.assign({}, HV, { 'content-length': String(101 * 1024 * 1024) }) }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
    });
    q.on('error', () => res({ statut: 0 }));
    q.write(octets.slice(0, 4096));
  });
  ok(trop.statut === 413 && /100 MB max/.test(trop.corps), 'plus de 100 Mo annonces : 413 [' + trop.corps.slice(0, 80) + ']');

  console.log('\n-- 2. le plan --');
  const v = await appel('/studio/kling', moi.H);
  ok(v.j.entier && v.j.entier.plafondUsd === 20 && v.j.entier.parallele === 2 && v.j.entier.imagesMax === 4 && v.j.entier.dureeMaxS === 10 && v.j.entier.octetsMax === 100 * 1024 * 1024,
     'la page lit le plafond (20 $), le parallele (2), 4 images, les bornes');
  const c = await appel('/studio/kling/entier', HV, null, 'POST', octets);
  ok(c.statut === 200 && c.j.ok && /^[0-9a-f]{24}$/.test(c.j.id) && c.j.statut === 'decoupe', 'televerse brut : decoupage en fond');
  const id = c.j.id;
  let e = null;
  for (let k = 0; k < 200; k++) { e = await appel('/studio/kling/entier/' + id, moi.H); if (e.j.statut !== 'decoupe') break; await new Promise((r) => setTimeout(r, 100)); }
  ok(e.j.statut === 'pret' && e.j.morceaux.length === 2 && e.j.morceaux.every((m) => Math.abs(m.duree - 7) < 0.05) && e.j.prixPire['720p'] === 1.764 && e.j.prixPire['1080p'] === 2.352,
     'plan : 2 morceaux de 7 s, au pire 1,764 $ (720p) / 2,352 $ (1080p) [' + JSON.stringify(e.j.morceaux.map((m) => m.duree)) + ']');
  ok(recus.length === 0, 'rien chez Kling avant le clic');
  ok((await appel('/studio/kling/entier/' + id, autre.H)).statut === 403, 'l etat : 403 pour un autre portefeuille');

  console.log('\n-- 3. la confirmation --');
  const PROMPT = 'Replace only the singer with @image_1 in @video_1.';
  const faux = await appel('/studio/kling/entier/' + id + '/lance', moi.H, { prompt: PROMPT, resolution: '720p', confirmeUsd: 1.5 });
  ok(faux.statut === 409 && /1\.764/.test(faux.j.raison) && recus.length === 0, 'un autre prix confirme : 409, rien chez Kling');
  ok((await appel('/studio/kling/entier/' + id + '/lance', autre.H, { prompt: PROMPT, confirmeUsd: 1.764 })).statut === 403, 'lancer : 403 pour un autre portefeuille');
  const l = await appel('/studio/kling/entier/' + id + '/lance', moi.H, { prompt: PROMPT, resolution: '720p', confirmeUsd: 1.764 });
  ok(l.statut === 200 && l.j.statut === 'en_cours' && l.j.morceaux.every((m) => m.statut === 'processing'), 'confirme : les 2 morceaux chez Kling');
  const envois = recus.filter((x) => /omni-video/.test(x.url)).map((x) => JSON.parse(x.o.body));
  ok(envois.length === 2 && envois.every((b) => b.contents[0].text === PROMPT && b.contents[1].type === 'refer_image' && b.contents[1].url === 'https://site.example/img/site/swoge_meme_ref.jpg'
     && b.contents[1].id === 'image_1' && b.contents[2].type === 'refer_image' && b.contents[2].url === 'https://site.example/img/site/swoge_face_ref.jpg' && b.contents[2].id === 'image_2'
     && b.contents[3].id === 'video_1' && b.settings.audio === 'original' && b.settings.resolution === '720p'),
     'chaque envoi : le meme texte, le corps (image_1) et le visage (image_2) par URL, son d origine, 720p');
  ok(luParKling.length === 2 && luParKling.every((x) => x.statut === 200 && new RegExp('^' + B.replace(/\./g, '\\.') + '/studio/kling-entier-clip/[0-9a-f]{48}\\.mp4$').test(x.url) && x.octets.length > 1000),
     'Kling lit chaque morceau a son URL publique, sans session');

  console.log('\n-- 4. le suivi et le resultat --');
  etatTaches = 'succeeded';
  for (let k = 0; k < 300; k++) { e = await appel('/studio/kling/entier/' + id, moi.H); if (['fini', 'incomplet'].includes(e.j.statut)) break; await new Promise((r) => setTimeout(r, 100)); }
  ok(e.j.statut === 'fini' && e.j.video === '/studio/kling/entier/' + id + '/video', 'fini : la video est annoncee [' + e.j.statut + ' ' + (e.j.message || '') + ']');
  ok((await vraiFetch(luParKling[0].url)).status === 404, 'les morceaux ne sont plus servis');
  ok((await appel(e.j.video, {})).statut === 401 && (await appel(e.j.video, autre.H)).statut === 403, 'le resultat : 401 sans session, 403 pour un autre');
  const r = await vraiFetch(B + e.j.video, { headers: { authorization: moi.H.authorization } });
  const fin = Buffer.from(await r.arrayBuffer());
  const f = path.join(process.env.DATA_DIR, 'fin.mp4'); fs.writeFileSync(f, fin);
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  ok(r.status === 200 && r.headers.get('content-type') === 'video/mp4' && Math.abs(d - 14) <= 0.1, 'le proprietaire recoit la video recollee : ' + d + ' s pour 14 s');
  const j = journal().filter((x) => x.entier === id);
  ok(j.filter((x) => x.edition && x.estimationUsd === 0.882 && !x.statut).length === 2 && j.filter((x) => x.edition && x.statut === 'succeeded' && x.facturation && x.facturation[0].montant === '6.3').length === 2,
     'journal : 2 envois (0,882 $ chacun), 2 fins avec la facturation lue');
  ok(j.some((x) => x.plan) && j.some((x) => x.lance) && j.some((x) => x.statut === 'fini'), 'journal : le plan, le lancement, la fin');
  ok(textes.every((t) => !t.includes('cle-kling-secrete')), 'la cle Kling n apparait dans aucune reponse');

  autre.s.close(); moi.s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
