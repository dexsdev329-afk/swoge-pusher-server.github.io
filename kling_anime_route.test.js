'use strict';
/* ============================================================================
 * « ANIMATE MY STILL » SUR UN VRAI SERVEUR (/studio/kling/entier?mode=…, 15/10/2026)
 *
 * Ce qu'elle DOIT tenir :
 *   1. sans session : 401 ; un autre portefeuille : 403 AVANT de lire le corps,
 *      meme avec ?mode=anime ; un mode inconnu : 400, rien ecrit ;
 *   2. la page lit le mode (le texte du serveur, 10 s pour un clip, audio off) ;
 *   3. ?mode=anime-clip : le corps BRUT, UN morceau, le prix avant tout envoi ;
 *      sans image fixe : 400, rien chez Kling ;
 *   4. le bon prix et l'image fixe : Kling recoit first_frame (l'image, base64)
 *      + feature_video (le morceau a son URL PUBLIQUE, lu sans session), le corps
 *      et le visage SWOGE en refer_image image_2/image_3, settings { resolution,
 *      duration, audio: 'off' } — jamais base_video ;
 *   5. le resultat (Kling le rend SANS son) ne sort qu'avec la session, a la
 *      longueur du clip, AVEC le son d'origine ; la passe d'edition (`passe`)
 *      n'est pas touchee, celle-ci est `passeAnime` ;
 *   6. la cle Kling n'apparait dans aucune reponse.
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

process.env.DATA_DIR = fs.mkdtempSync('/tmp/kling-anime-route-');
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
const STILL = path.join(process.env.DATA_DIR, 'still.png');
if (ffmpegOk) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '8', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-t', '8', '-i', 'sine=frequency=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VIDEO]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=720x1280', '-frames:v', '1', STILL]);
}

/* Kling simule : il LIT le morceau a l'URL du feature_video et rend ce morceau SANS son. */
const recus = [], taches = {};
let etatTaches = 'processing';
const luParKling = [];
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
      ? { id: m[1], status: 'succeeded', outputs: [{ type: 'video', url: 'https://p2-kling.klingai.com/r/' + m[1] + '.mp4', duration: '8' }], billing: [{ charge_type: 'unit', amount: '7.2', package_type: 'video' }] }
      : { id: m[1], status: etatTaches }] : [] });
  }
  if (/external_task_ids/.test(url)) return rep({ code: 0, data: [] });
  const b = JSON.parse(o.body);
  const v = b.contents.find((c) => c.type === 'feature_video' || c.type === 'base_video');
  const r = await vraiFetch(v.url);
  const lu = Buffer.from(await r.arrayBuffer());
  luParKling.push({ statut: r.status, octets: lu, url: v.url });
  const fi = path.join(process.env.DATA_DIR, 'lu.mp4'), fo = path.join(process.env.DATA_DIR, 'rendu.mp4');
  fs.writeFileSync(fi, lu);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fi, '-an', '-c:v', 'copy', fo]);
  const id = 'N' + (Object.keys(taches).length + 1);
  taches[id] = { octets: fs.readFileSync(fo) };
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
const sonde = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', f]).toString());

(async () => {
  if (!ffmpegOk) { console.log('ffmpeg absent : essai ignore'); return; }
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
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
  const DOSSIER = path.join(process.env.DATA_DIR, 'kling_entier');
  const passes = () => { try { return fs.readdirSync(DOSSIER).filter((x) => /^[0-9a-f]{24}$/.test(x)); } catch (e) { return []; } };
  const octets = fs.readFileSync(VIDEO);
  const stillB64 = fs.readFileSync(STILL).toString('base64');

  console.log('-- 1. qui peut --');
  ok((await appel('/studio/kling/entier?mode=anime-clip', { 'content-type': 'video/mp4' }, null, 'POST', octets)).statut === 401, 'sans session : 401');
  const autre = await connecte(port, ethers.Wallet.createRandom());
  const suspendu = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/kling/entier?mode=anime', method: 'POST',
      headers: { 'content-type': 'video/mp4', authorization: autre.H.authorization, 'content-length': String(40 * 1024 * 1024) } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
    });
    q.on('error', () => res({ statut: 0 }));
    q.write(octets.slice(0, 4096));
  });
  ok(suspendu.statut === 403 && recus.length === 0 && passes().length === 0, 'un autre portefeuille, ?mode=anime : 403 sans que le corps soit lu, rien ecrit');
  const moi = await connecte(port, OWNER);
  const HV = { 'content-type': 'video/mp4', authorization: moi.H.authorization };
  const inconnu = await appel('/studio/kling/entier?mode=swap', HV, null, 'POST', octets);
  ok(inconnu.statut === 400 && /unknown mode/.test(inconnu.j.raison) && passes().length === 0, 'un mode inconnu : 400, rien ecrit');

  console.log('\n-- 2. ce que la page lit --');
  const v = await appel('/studio/kling', moi.H);
  const a = v.j.entier && v.j.entier.anime;
  ok(a && a.clipMaxS === 10 && a.audio === 'off' && a.stillOctetsMax === 6 * 1024 * 1024 && /^Start exactly from @image_1/.test(a.texte) && a.swoge === 'images', 'le mode : 10 s par clip, audio off, 6 Mo, le texte du serveur, SWOGE en images');
  ok(v.j.entier.passeAnime === null && v.j.entier.passe === null, 'aucune passe encore');

  console.log('\n-- 3. le plan d un clip --');
  const c = await appel('/studio/kling/entier?mode=anime-clip', HV, null, 'POST', octets);
  ok(c.statut === 200 && c.j.ok && /^[0-9a-f]{24}$/.test(c.j.id), 'televerse brut, ?mode=anime-clip');
  const id = c.j.id;
  let e = null;
  for (let k = 0; k < 200; k++) { e = await appel('/studio/kling/entier/' + id, moi.H); if (e.j.statut !== 'decoupe') break; await new Promise((r) => setTimeout(r, 100)); }
  ok(e.j.statut === 'pret' && e.j.morceaux.length === 1 && e.j.anime && e.j.anime.clip === true && e.j.parallele === 1 && e.j.prixPire['720p'] === 1.008 && e.j.prixPire['1080p'] === 1.344,
     'plan : UN morceau de 8 s, 1,008 $ (720p) / 1,344 $ (1080p) [' + e.j.statut + ' ' + (e.j.message || '') + ']');
  const sans = await appel('/studio/kling/entier/' + id + '/lance', moi.H, { resolution: '720p', confirmeUsd: 1.008 });
  ok(sans.statut === 400 && /still/.test(sans.j.raison) && recus.length === 0, 'sans image fixe : 400, rien chez Kling');
  ok((await appel('/studio/kling/entier/' + id + '/lance', autre.H, { still: 'data:image/png;base64,' + stillB64, confirmeUsd: 1.008 })).statut === 403, 'lancer : 403 pour un autre portefeuille');

  console.log('\n-- 4. la requete --');
  const l = await appel('/studio/kling/entier/' + id + '/lance', moi.H, { still: 'data:image/png;base64,' + stillB64, resolution: '720p', confirmeUsd: 1.008, note: 'He waves at the end.' });
  ok(l.statut === 200 && l.j.statut === 'en_cours' && l.j.morceaux[0].statut === 'processing', 'confirme : le morceau chez Kling');
  const envois = recus.filter((x) => /omni-video\/kling-o1$/.test(x.url)).map((x) => JSON.parse(x.o.body));
  const b = envois[0];
  ok(envois.length === 1 && JSON.stringify(b.contents.map((x) => x.type + ':' + (x.id || ''))) === JSON.stringify(['prompt:', 'first_frame:image_1', 'refer_image:image_2', 'refer_image:image_3', 'feature_video:video_1']),
     'contents : prompt, first_frame, refer_image ×2, feature_video ' + JSON.stringify(b && b.contents.map((x) => x.type)));
  ok(b.contents[1].url === stillB64 && b.contents[2].url === 'https://site.example/img/site/swoge_meme_ref.jpg' && b.contents[3].url === 'https://site.example/img/site/swoge_face_ref.jpg',
     'l image fixe en base64, le corps et le visage SWOGE par leur URL');
  ok(!b.contents.some((x) => x.type === 'base_video') && JSON.stringify(b.settings) === JSON.stringify({ resolution: '720p', duration: 8, audio: 'off' }),
     'jamais base_video ; settings ' + JSON.stringify(b.settings));
  ok(/^Start exactly from @image_1/.test(b.contents[0].text) && / He waves at the end\.$/.test(b.contents[0].text), 'le texte du serveur, la direction du proprietaire en fin');
  ok(luParKling.length === 1 && luParKling[0].statut === 200 && new RegExp('^' + B.replace(/\./g, '\\.') + '/studio/kling-entier-clip/[0-9a-f]{48}\\.mp4$').test(luParKling[0].url),
     'Kling lit le morceau a son URL publique, sans session');

  console.log('\n-- 5. le resultat --');
  etatTaches = 'succeeded';
  for (let k = 0; k < 300; k++) { e = await appel('/studio/kling/entier/' + id, moi.H); if (['fini', 'incomplet'].includes(e.j.statut)) break; await new Promise((r) => setTimeout(r, 100)); }
  ok(e.j.statut === 'fini' && e.j.video === '/studio/kling/entier/' + id + '/video', 'fini [' + e.j.statut + ' ' + (e.j.message || '') + ']');
  ok((await appel(e.j.video, {})).statut === 401 && (await appel(e.j.video, autre.H)).statut === 403, 'le resultat : 401 sans session, 403 pour un autre');
  const r = await vraiFetch(B + e.j.video, { headers: { authorization: moi.H.authorization } });
  const f = path.join(process.env.DATA_DIR, 'fin.mp4'); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  const s = sonde(f);
  ok(r.status === 200 && Math.abs(Number(s.format.duration) - 8) <= 0.06 && s.streams.some((x) => x.codec_type === 'audio'),
     'le proprietaire recoit le clip anime : ' + s.format.duration + ' s pour 8 s, avec le son d origine (Kling l a rendu sans)');
  const v2 = await appel('/studio/kling', moi.H);
  ok(v2.j.entier.passeAnime === id && v2.j.entier.passeAnimeClip === true && v2.j.entier.passe === null, 'la page retrouve la passe en passeAnime ; `passe` (l edition) n est pas touchee');
  ok(textes.every((t) => !t.includes('cle-kling-secrete')), 'la cle Kling n apparait dans aucune reponse');

  autre.s.close(); moi.s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
