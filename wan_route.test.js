'use strict';
/* ============================================================================
 * LA ROUTE WAN (/studio/kling/wan), SUR UN VRAI SERVEUR
 *
 * Ce qu'elle DOIT tenir :
 *   1. sans session : 401 ; un autre portefeuille : 403 avant le corps et avant fal ;
 *   2. un clip refuse (pas MP4, hors 3-10 s) ne part pas chez fal ;
 *   3. le proprietaire lance : fal recoit video_url = l'URL PUBLIQUE du clip a
 *      16 i/s (servie sans session), image_url = SWOGE du site, et la cle en
 *      « Authorization: Key » seulement ;
 *   4. le suivi rend le resultat ; la video finale (son remis) ne sort que pour
 *      le proprietaire avec sa session ; les entrees sont effacees (404) ;
 *   5. la cle fal ne sort dans aucune reponse.
 * fal est simule en remplacant `fetch` pour ses seuls domaines ; ffmpeg est le vrai.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/wan-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete'; process.env.KLING_TG = '0';
process.env.FAL_KEY = 'cle-fal-secrete';
process.env.SITE_URL = 'https://site.example';
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-route-clips-'));
const CLIP = path.join(tmp, 'clip.mp4'), MUET = path.join(tmp, 'muet.mp4');
let ffmpegOk = true;
try {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', CLIP]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=16:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', MUET]);
} catch (e) { ffmpegOk = false; }

/* fal simule : la file, et le CDN des resultats ; fal LIT le clip pendant la requete */
const recus = [];
let statut = { status: 'IN_PROGRESS' }, luParFal = null;
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.startsWith('https://v3.fal.media/')) return new Response(fs.readFileSync(MUET), { status: 200 });
  if (!url.startsWith('https://queue.fal.run')) return vraiFetch(u, o);
  recus.push({ url, o });
  const rep = (j) => ({ status: 200, ok: true, json: async () => j });
  if (o && o.method === 'POST') {
    const b = JSON.parse(o.body);
    const r = await vraiFetch(b.video_url); luParFal = { statut: r.status, octets: Buffer.from(await r.arrayBuffer()), url: b.video_url };
    return rep({ request_id: 'req-9', status_url: 'https://queue.fal.run/fal-ai/wan/requests/req-9/status', response_url: 'https://queue.fal.run/fal-ai/wan/requests/req-9' });
  }
  if (/\/status$/.test(url)) return rep(statut);
  return rep({ video: { url: 'https://v3.fal.media/files/x/res.mp4' }, prompt: 'p', seed: 3 });
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
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const textes = [];
  const appel = async (chemin, H, corps) => {
    const r = await vraiFetch(B + chemin, { method: corps ? 'POST' : 'GET', headers: H || {}, body: corps ? JSON.stringify(corps) : undefined });
    const t = await r.text(); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return { statut: r.status, j };
  };
  const du = (b) => 'data:video/mp4;base64,' + b.toString('base64');
  const clip = fs.readFileSync(CLIP);

  console.log('-- 1. qui peut --');
  ok((await appel('/studio/kling/wan', { 'content-type': 'application/json' }, { video: du(clip) })).statut === 401, 'sans session : 401');
  const autre = await connecte(port, ethers.Wallet.createRandom());
  ok((await appel('/studio/kling/wan', autre.H, { video: du(clip) })).statut === 403 && recus.length === 0, 'un autre portefeuille : 403, rien chez fal');

  console.log('\n-- 2. le proprietaire --');
  const moi = await connecte(port, OWNER);
  const v = await appel('/studio/kling', moi.H);
  ok(v.j.wan && v.j.wan.actif === true && v.j.wan.prixParSeconde['720p'] === 0.08 && v.j.wan.fps === 16, 'la page lit la grille Wan (0,08 $/s en 720p, 16 i/s)');
  ok((await appel('/studio/kling/wan', moi.H, { video: 'data:video/mp4;base64,' + Buffer.from('hello').toString('base64') })).statut === 400 && recus.length === 0, 'pas un MP4 : 400, rien chez fal');
  const r = await appel('/studio/kling/wan', moi.H, { video: du(clip), resolution: '720p', audio: 'original' });
  ok(r.statut === 200 && r.j.ok && r.j.images === 64 && r.j.estimationUsd === 0.32, 'accepte : 64 images a 16 i/s, ~0,32 $ [' + JSON.stringify(r.j) + ']');
  const post = recus.find((x) => x.o && x.o.method === 'POST');
  const b = JSON.parse(post.o.body);
  ok(post.url === 'https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace' && post.o.headers.authorization === 'Key cle-fal-secrete', 'POST queue.fal.run, Authorization: Key');
  ok(new RegExp('^' + B.replace(/\./g, '\\.') + '/studio/wan-clip/[0-9a-f]{48}\\.mp4$').test(b.video_url) && luParFal.statut === 200 && luParFal.octets.length > 1000, 'video_url publique, lue sans session par fal');
  ok(b.image_url === 'https://site.example/img/site/swoge_reference.jpg', 'image_url : SWOGE du site');
  const s1 = await appel('/studio/kling/wan/' + r.j.id, moi.H);
  ok(s1.j.statut === 'processing', 'en cours');
  ok((await appel('/studio/kling/wan/' + r.j.id, autre.H)).statut === 403, 'le suivi est refuse a un autre portefeuille');
  statut = { status: 'COMPLETED' };
  const s2 = await appel('/studio/kling/wan/' + r.j.id, moi.H);
  ok(s2.j.statut === 'succeeded' && s2.j.son === true && s2.j.video === '/studio/kling/wan/' + r.j.id + '/video', 'fini, avec le son');
  const sans = await vraiFetch(B + s2.j.video);
  ok(sans.status === 401, 'la video finale sans session : 401');
  const fv = await vraiFetch(B + s2.j.video, { headers: { authorization: moi.H.authorization } });
  const octets = Buffer.from(await fv.arrayBuffer());
  const F = path.join(tmp, 'fin.mp4'); fs.writeFileSync(F, octets);
  const aSon = String(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', F])).trim();
  ok(fv.status === 200 && fv.headers.get('content-type') === 'video/mp4' && aSon === 'audio', 'avec sa session : la video finale, piste son comprise');
  ok((await vraiFetch(luParFal.url)).status === 404, 'l entree publique est effacee (404)');
  const j = fs.readFileSync(path.join(process.env.DATA_DIR, 'kling_essais.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  ok(j.length === 2 && j[0].moteur === 'wan' && j[0].estimationUsd === 0.32 && j[1].statut === 'succeeded', 'envoi et fin journalises dans kling_essais.jsonl');
  ok(textes.every((t) => !t.includes('cle-fal-secrete')), 'la cle fal n apparait dans aucune reponse');

  autre.s.close(); moi.s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
