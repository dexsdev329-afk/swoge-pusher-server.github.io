'use strict';
/* ============================================================================
 * LA ROUTE D'EDITION KLING O1 (/studio/kling/edition), SUR UN VRAI SERVEUR
 *
 * Ce qu'elle DOIT tenir :
 *   1. sans session : 401 ; un autre portefeuille : 403 AVANT de lire le corps
 *      et avant Kling ;
 *   2. un clip trop gros, pas MP4, hors 3-10 s ou hors 700-2160 px est refuse
 *      AVANT Kling, et rien n'est ecrit ;
 *   3. le proprietaire envoie un clip de 5 s sans image : Kling recoit
 *      base_video = l'URL PUBLIQUE du clip (qui sert exactement les octets
 *      envoyes, sans session), refer_image = le corps (image_1) et le visage (image_2), son
 *      d'origine ; l'envoi est journalise avec son estimation ;
 *   4. le suivi (GET /studio/kling/<id>) rend la video ; a la fin, le clip est
 *      efface (404, plus de fichier) et la fin journalisee une seule fois ;
 *   5. la cle Kling ne sort jamais dans une reponse.
 * Kling est simule en remplacant `fetch` pour son seul domaine : aucun appel reel.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/kling-edition-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete';
process.env.KLING_TG = '0';
process.env.SITE_URL = 'https://site.example';
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;
/* un reste d'une edition interrompue : efface au demarrage */
const DOSSIER = path.join(process.env.DATA_DIR, 'kling_edition');
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(path.join(DOSSIER, 'f'.repeat(48) + '.mp4'), 'reste');

/* MP4 synthetique : ftyp, mdat, moov(mvhd v0, trak(tkhd v0 avec cotes)) */
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; };
const boite = (type, contenu) => Buffer.concat([u32(8 + contenu.length), Buffer.from(type, 'latin1'), contenu]);
const mvhd0 = (s) => { const c = Buffer.alloc(100); c.writeUInt32BE(1000, 12); c.writeUInt32BE(Math.round(s * 1000), 16); return boite('mvhd', c); };
const tkhd0 = (l, h) => { const c = Buffer.alloc(84); c.writeUInt32BE(l * 65536, 76); c.writeUInt32BE(h * 65536, 80); return boite('tkhd', c); };
const clip = (s, l, h, octets) => Buffer.concat([boite('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')),
  boite('mdat', Buffer.from(Array.from({ length: octets || 1000 }, (_, i) => (i * 37) & 255))), boite('moov', Buffer.concat([mvhd0(s), boite('trak', tkhd0(l || 720, h || 1280))]))]);
const dataUrl = (b) => 'data:video/mp4;base64,' + b.toString('base64');

/* Kling simule : il LIT le clip a l'URL donnee pendant la requete, comme le vrai. */
const recus = [];
let etatTache = 'processing', luParKling = null;
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (!url.startsWith('https://api-singapore.klingai.com')) return vraiFetch(u, o);
  recus.push({ url, o });
  const rep = (j) => ({ status: 200, ok: true, json: async () => j });
  if (/\/tasks\?/.test(url)) {
    return rep({ code: 0, data: [etatTache === 'succeeded'
      ? { id: 'O1T', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling.example/o1.mp4', duration: '5' }], billing: [{ charge_type: 'unit', amount: '4.5', package_type: 'video' }] }
      : { id: 'O1T', status: etatTache }] });
  }
  const b = JSON.parse(o.body);
  const v = b.contents.find((c) => c.type === 'base_video');
  if (v) { const r = await vraiFetch(v.url); luParKling = { statut: r.status, octets: Buffer.from(await r.arrayBuffer()) }; }
  return rep({ code: 0, data: { id: 'O1T', status: 'submitted' } });
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
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;   /* Kling simule lit le clip ici */
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const textes = [];
  const appel = async (chemin, H, corps, methode) => {
    const r = await vraiFetch(B + chemin, { method: methode || (corps ? 'POST' : 'GET'), headers: H || {}, body: corps ? JSON.stringify(corps) : undefined });
    const t = await r.text(); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return { statut: r.status, j };
  };
  const journal = () => { try { return fs.readFileSync(path.join(process.env.DATA_DIR, 'kling_essais.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch (e) { return []; } };
  const clips = () => fs.readdirSync(DOSSIER).filter((x) => /\.mp4$/.test(x));

  ok(clips().length === 0, 'au demarrage : le clip reste d une edition interrompue est efface');

  console.log('-- 1. qui peut --');
  const bon = clip(5, 720, 1280);
  ok((await appel('/studio/kling/edition', { 'content-type': 'application/json' }, { video: dataUrl(bon) })).statut === 401, 'sans session : 401');
  const autre = await connecte(port, ethers.Wallet.createRandom());
  /* un autre portefeuille annonce 30 Mo et n'envoie rien : la reponse vient quand meme (403 avant le corps) */
  const suspendu = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/kling/edition', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: autre.H.authorization, 'content-length': String(30 * 1024 * 1024) } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
    });
    q.on('error', () => res({ statut: 0 }));
    q.write('{"video":"data:video/mp4;base64,AAAA');
  });
  ok(suspendu.statut === 403 && recus.length === 0, 'un autre portefeuille : 403 sans que le corps soit lu, rien chez Kling');

  console.log('\n-- 2. les refus avant Kling --');
  const moi = await connecte(port, OWNER);
  const v = await appel('/studio/kling', moi.H);
  ok(v.j.edition && v.j.edition.modele === 'kling-o1' && v.j.edition.dureeMinS === 3 && v.j.edition.dureeMaxS === 10 && v.j.edition.prixParSeconde['720p'] === 0.126,
     'la page lit les bornes et la grille de l edition');
  const gros = await appel('/studio/kling/edition', moi.H, { video: dataUrl(clip(5, 720, 1280, 21 * 1024 * 1024)) });
  ok(gros.statut === 413 && /20 MB/.test(gros.j.raison), 'un clip de 21 Mo : 413 [' + gros.j.raison + ']');
  const pasMp4 = await appel('/studio/kling/edition', moi.H, { video: 'data:video/mp4;base64,' + Buffer.from('hello, not a video').toString('base64') });
  ok(pasMp4.statut === 400 && /not an MP4/.test(pasMp4.j.raison), 'pas un MP4 : 400');
  const long = await appel('/studio/kling/edition', moi.H, { video: dataUrl(clip(11, 720, 1280)) });
  ok(long.statut === 400 && /11\.00 s/.test(long.j.raison), '11 s : 400 [' + long.j.raison + ']');
  ok((await appel('/studio/kling/edition', moi.H, { video: dataUrl(clip(2, 720, 1280)) })).statut === 400, '2 s : 400');
  const petit = await appel('/studio/kling/edition', moi.H, { video: dataUrl(clip(5, 640, 360)) });
  ok(petit.statut === 400 && /640×360/.test(petit.j.raison), '640×360 : 400 (700 px au moins)');
  ok((await appel('/studio/kling/edition', moi.H, { video: dataUrl(bon), image: 'data:image/webp;base64,UklGRgAAAABXRUJQVlA4IAAAAAA=', prompt: 'x' })).statut === 400, 'une reference WebP : 400');
  ok(recus.length === 0 && clips().length === 0, 'aucun refus n est parti chez Kling ni n a laisse de clip');

  console.log('\n-- 3. le proprietaire lance --');
  const prompt = 'Replace only the singer with the character from @image_1. Keep everything else in @video_1.';
  const r = await appel('/studio/kling/edition', moi.H, { video: dataUrl(bon), prompt, resolution: '720p', audio: 'original' });
  ok(r.statut === 200 && r.j.ok && r.j.id === 'O1T' && r.j.reference === 'swoge' && r.j.estimationUsd === 0.63, 'acceptee : tache O1T, reference SWOGE, 5 s × 0,126 $ = ' + r.j.estimationUsd);
  const envoi = recus.find((x) => /omni-video/.test(x.url));
  const b = envoi && JSON.parse(envoi.o.body);
  ok(envoi && envoi.url === 'https://api-singapore.klingai.com/omni-video/kling-o1', 'POST /omni-video/kling-o1');
  const bv = b.contents.find((c) => c.type === 'base_video'), ri = b.contents.find((c) => c.type === 'refer_image');
  ok(new RegExp('^' + B.replace(/\./g, '\\.') + '/studio/kling-clip/[0-9a-f]{48}\\.mp4$').test(bv.url) && bv.id === 'video_1', 'base_video : l URL publique du clip [' + bv.url + ']');
  ok(luParKling && luParKling.statut === 200 && luParKling.octets.equals(bon), 'cette URL sert exactement le clip envoye, sans session');
  const ris = b.contents.filter((c) => c.type === 'refer_image');
  ok(ris.length === 2 && ri.url === 'https://site.example/img/site/swoge_meme_ref.jpg' && ri.id === 'image_1' && ris[1].url === 'https://site.example/img/site/swoge_face_ref.jpg' && ris[1].id === 'image_2',
     'refer_image : le corps (le meme Swole Doge, image_1) puis le visage (image_2), par leurs URL — aucun element tant qu il n existe pas');
  ok(b.settings.audio === 'original' && b.settings.resolution === '720p' && b.contents[0].text === prompt, 'son d origine, 720p, le texte tel quel');
  ok((await appel('/studio/kling/edition', moi.H, { video: dataUrl(bon), prompt })).statut === 429, 'une seconde edition pendant la premiere : 429');
  const j1 = journal();
  ok(j1.length === 1 && j1[0].edition && j1[0].id === 'O1T' && j1[0].estimationUsd === 0.63 && j1[0].image === 'swoge', 'l envoi est journalise avec son estimation');

  console.log('\n-- 4. le suivi et la fin --');
  const s1 = await appel('/studio/kling/O1T', moi.H);
  ok(s1.statut === 200 && s1.j.statut === 'processing' && s1.j.edition === true && clips().length === 1, 'en cours : le clip est toujours la');
  etatTache = 'succeeded';
  const s2 = await appel('/studio/kling/O1T', moi.H);
  ok(s2.j.statut === 'succeeded' && s2.j.url === 'https://cdn.kling.example/o1.mp4', 'fini : le suivi rend la video');
  ok(clips().length === 0 && (await vraiFetch(bv.url)).status === 404, 'et le clip est efface (fichier parti, URL en 404)');
  await appel('/studio/kling/O1T', moi.H);
  const j2 = journal();
  ok(j2.length === 2 && j2[1].statut === 'succeeded' && j2[1].edition && j2[1].facturation[0].montant === '4.5', 'la fin est journalisee une fois, avec la facturation lue');
  const r2 = await appel('/studio/kling/edition', moi.H, { video: dataUrl(clip(4, 1080, 1920)), prompt: 'x', image: 'data:image/png;base64,' + (() => { const p = Buffer.alloc(40); p.writeUInt32BE(0x89504E47, 0); p.writeUInt32BE(0x0D0A1A0A, 4); p.write('IHDR', 12, 'latin1'); p.writeUInt32BE(800, 16); p.writeUInt32BE(800, 20); return p.toString('base64'); })() });
  const b2 = JSON.parse(recus.filter((x) => /omni-video/.test(x.url)).pop().o.body);
  ok(r2.statut === 200 && r2.j.reference === 'upload' && !/^https?:/.test(b2.contents.find((c) => c.type === 'refer_image').url), 'apres la fin, une nouvelle edition avec une image fournie (base64) passe');
  ok(textes.every((t) => !t.includes('cle-kling-secrete')), 'la cle Kling n apparait dans aucune reponse');

  autre.s.close(); moi.s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
