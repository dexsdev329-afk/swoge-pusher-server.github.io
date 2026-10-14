'use strict';
/* ============================================================================
 * WAN 2.2 ANIMATE REPLACE (fal) — wan_remplace.js
 *
 * Ce qui DOIT tenir (docs fal lues le 14/10/2026, voir l'en-tete du module) :
 *   1. Le prix : images ÷ 16 × grille (exemple de fal : 5 s a 60 i/s = 300
 *      images = 18,75 s facturees = 1,50 $ en 720p).
 *   2. Rien ne part sans cle, sans ffmpeg, hors 3-10 s, au-dela de 20 Mo, ni
 *      avec une reference qui n'est pas un PNG/JPEG de 300 px.
 *   3. Le clip part REECHANTILLONNE a 16 i/s et muet, par URL publique ;
 *      l'estimation compte ses images reelles ; POST https://queue.fal.run/
 *      fal-ai/wan/v2.2-14b/animate/replace, « Authorization: Key ».
 *   4. A la fin : le resultat muet de fal + le son d'origine = le fichier final
 *      (piste son presente, meme longueur), entrees effacees, servi a la seule
 *      adresse qui l'a lance ; un echec, un hote de resultat inconnu ou le
 *      delai effacent aussi les entrees. Restes purges au demarrage.
 * fal est simule (fetch remplace) ; ffmpeg est le vrai (absent : essai ignore).
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const W = require('./wan_remplace');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const rep = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y'].concat(args));
const sonde = (f, q) => String(execFileSync('ffprobe', ['-v', 'error'].concat(q, [f]))).trim();
function png(l, h) { const b = Buffer.alloc(40); b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; }

(async () => {
  try { execFileSync('ffmpeg', ['-version']); } catch (e) { console.log('ffmpeg absent : essai ignore'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-essai-'));
  /* un clip de telephone : 4 s, 30 i/s, 720×1280, avec du son ; et le « resultat » muet de fal a 16 i/s */
  const CLIP = path.join(tmp, 'clip.mp4'), MUET = path.join(tmp, 'muet.mp4'), LONG = path.join(tmp, 'long.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', CLIP]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=16:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', MUET]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=11', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', LONG]);
  const clip = fs.readFileSync(CLIP);
  const du = (b) => 'data:video/mp4;base64,' + b.toString('base64');

  console.log('-- 1. le prix --');
  ok(W.prixUsd('720p', 300) === 1.5, 'l exemple de fal : 300 images en 720p = 1,50 $');
  ok(W.prixUsd('720p', 64) === 0.32 && W.prixUsd('480p', 160) === 0.4 && W.prixUsd('580p', 16) === 0.06 && W.prixUsd('1080p', 16) === null, '64 images 720p = 0,32 $ ; 480p 10 s = 0,40 $ ; 1080p : null');

  /* le faux fal */
  const vus = [];
  let statut = { status: 'IN_QUEUE', queue_position: 2 }, sortie = { video: { url: 'https://v3.fal.media/files/lion/res.mp4' }, prompt: 'p', seed: 1 }, lu = null;
  let M = null;
  const fauxFetch = async (u, o) => {
    vus.push({ u, o });
    if (u === W.QUEUE + '/' + W.MODELE && o.method === 'POST') {
      const b = JSON.parse(o.body); const nom = b.video_url.split('/').pop();
      const f = M.fichier(nom); lu = f && f.octets;   /* fal lit le clip pendant la requete */
      return rep(200, { request_id: 'req-1', status_url: W.QUEUE + '/fal-ai/wan/requests/req-1/status', response_url: W.QUEUE + '/fal-ai/wan/requests/req-1', cancel_url: 'x' });
    }
    if (/\/status$/.test(u)) return rep(200, statut);
    if (/\/requests\/req-1$/.test(u)) return rep(200, sortie);
    return rep(404, { detail: 'not found' });
  };
  const fauxCdn = async (u) => (/^https:\/\/v3\.fal\.media\//.test(u) ? new Response(fs.readFileSync(MUET), { status: 200 }) : new Response('', { status: 404 }));
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-dossier-'));
  fs.writeFileSync(path.join(dossier, 'a'.repeat(48) + '.mp4'), 'reste'); fs.writeFileSync(path.join(dossier, 'x.orig.mp4'), 'reste');
  fs.writeFileSync(path.join(dossier, 'b'.repeat(24) + '.final.mp4'), 'vieux'); fs.utimesSync(path.join(dossier, 'b'.repeat(24) + '.final.mp4'), new Date(Date.now() - 25 * 3600e3), new Date(Date.now() - 25 * 3600e3));
  fs.writeFileSync(path.join(dossier, 'c'.repeat(24) + '.final.mp4'), 'recent');
  let t = Date.now();
  const lignes = [];
  const mk = (extra) => W.cree(Object.assign({ dossier, cle: () => 'cle-fal-secrete', fetch: fauxFetch, fetchCdn: fauxCdn, urlPublique: (nom) => 'https://srv.example' + W.VIDEO_PREFIXE + nom,
    imageDefaut: 'https://site.example/img/site/swoge_reference.jpg', journal: (o) => lignes.push(o), maintenant: () => t, pollMs: 1e9, maxMs: 60000 }, extra || {}));
  M = mk();
  const restes = fs.readdirSync(dossier).sort();
  ok(restes.length === 1 && restes[0] === 'c'.repeat(24) + '.final.mp4', 'au demarrage : entrees et resultats de plus de 24 h effaces, le resultat recent garde ' + JSON.stringify(restes));

  console.log('\n-- 2. ce qui ne part pas --');
  const A = '0xabc';
  ok((await mk({ cle: () => '' }).lance({ addr: A, octets: clip })).code === 503, 'sans FAL_KEY : 503');
  ok((await mk({ ffmpeg: '/nulle/part/ffmpeg' }).lance({ addr: A, octets: clip })).code === 503, 'sans ffmpeg : 503');
  ok((await M.lance({ addr: null, octets: clip })).code === 401, 'sans adresse : 401');
  ok((await M.lance({ addr: A, octets: Buffer.alloc(W.OCTETS_MAX + 1) })).code === 413, 'plus de 20 Mo : 413');
  ok((await M.lance({ addr: A, octets: Buffer.from('pas une video') })).code === 400, 'pas un MP4 : 400');
  ok((await M.lance({ addr: A, octets: fs.readFileSync(LONG) })).code === 400, '11 s : 400');
  ok((await M.lance({ addr: A, octets: clip, image: 'data:image/webp;base64,UklGRgAAAABXRUJQ' })).code === 400, 'une WebP : 400');
  ok((await M.lance({ addr: A, octets: clip, image: 'data:image/png;base64,' + png(200, 400).toString('base64') })).code === 400, 'une image de 200 px : 400');
  ok(vus.length === 0 && fs.readdirSync(dossier).length === 1, 'aucun appel a fal, aucun fichier ecrit');

  console.log('\n-- 3. l envoi --');
  const r = await M.lance({ addr: A, octets: clip, resolution: '720p' });
  const post = vus.find((v) => v.o.method === 'POST');
  const b = post && JSON.parse(post.o.body);
  ok(r.ok && r.statut === 'queued' && /^[0-9a-f]{24}$/.test(r.id), 'accepte : un identifiant a nous');
  ok(post && post.u === 'https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace' && post.o.headers.authorization === 'Key cle-fal-secrete', 'POST queue.fal.run/<modele>, « Authorization: Key »');
  ok(/^https:\/\/srv\.example\/studio\/wan-clip\/[0-9a-f]{48}\.mp4$/.test(b.video_url) && b.image_url === 'https://site.example/img/site/swoge_reference.jpg' && b.resolution === '720p' && Object.keys(b).length === 3,
     'video_url publique, image_url = SWOGE du site, 720p, rien d autre ' + JSON.stringify(Object.keys(b)));
  const LU = path.join(tmp, 'lu.mp4'); fs.writeFileSync(LU, lu || Buffer.alloc(0));
  ok(lu && sonde(LU, ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0']) === '16/1', 'le clip lu par fal est a 16 i/s');
  ok(lu && sonde(LU, ['-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0']) === '', 'et muet');
  ok(r.images === 64 && r.estimationUsd === 0.32, 'estimation sur les images reelles : 64 images (4 s a 16 i/s) = 0,32 $ en 720p, au lieu de 0,60 $ a 30 i/s [' + r.images + ', ' + r.estimationUsd + ']');
  ok(lignes.length === 1 && lignes[0].moteur === 'wan' && lignes[0].rid === 'req-1' && lignes[0].estimationUsd === 0.32, 'l envoi est journalise (request_id, estimation)');
  ok((await M.lance({ addr: A, octets: clip })).code === 429, 'un remplacement a la fois');
  ok(!JSON.stringify(r).includes('cle-fal'), 'la cle n est pas dans la reponse');

  console.log('\n-- 4. le suivi, le son, la fin --');
  let e = await M.rafraichit(r.id, A);
  ok(e.ok && e.statut === 'queued' && vus.some((v) => v.u === W.QUEUE + '/fal-ai/wan/requests/req-1/status'), 'en file : le suivi lit le status_url rendu par fal');
  ok((await M.rafraichit(r.id, '0xautre')).code === 404, 'une autre adresse : 404');
  statut = { status: 'COMPLETED', request_id: 'req-1' };
  e = await M.rafraichit(r.id, A);
  ok(e.statut === 'succeeded' && e.son === true && e.video === '/studio/kling/wan/' + r.id + '/video', 'fini : resultat avec son [' + JSON.stringify(e) + ']');
  const fin = M.resultat(r.id, A);
  const FIN = path.join(tmp, 'fin.mp4'); fs.writeFileSync(FIN, fin ? fin.octets : Buffer.alloc(0));
  ok(fin && sonde(FIN, ['-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0']) === 'audio', 'le fichier final porte la piste son d origine');
  const dv = Number(sonde(FIN, ['-show_entries', 'format=duration', '-of', 'csv=p=0']));
  ok(Math.abs(dv - 4) < 0.15, 'et la meme longueur (' + dv + ' s)');
  ok(M.resultat(r.id, '0xautre') === null, 'le resultat ne sort pas pour une autre adresse');
  ok(M.fichier(b.video_url.split('/').pop()) === null && fs.readdirSync(dossier).filter((f) => W.ENTREE.test(f) || /orig|tmp/.test(f)).length === 0, 'les entrees sont effacees');
  ok(lignes.length === 2 && lignes[1].statut === 'succeeded' && lignes[1].son === true && lignes[1].urlFal === 'https://v3.fal.media/files/lion/res.mp4', 'la fin est journalisee (son, URL fal)');

  console.log('\n-- 5. echecs --');
  statut = { status: 'IN_PROGRESS' };
  const img = png(600, 900);
  const r2 = await M.lance({ addr: A, octets: clip, resolution: '480p', image: 'data:image/png;base64,' + img.toString('base64'), audio: 'off' });
  const b2 = JSON.parse(vus.filter((v) => v.o.method === 'POST').pop().o.body);
  ok(r2.ok && /\/studio\/wan-clip\/[0-9a-f]{48}\.png$/.test(b2.image_url) && b2.resolution === '480p' && r2.estimationUsd === 0.16, 'une image fournie part par URL publique (.png) ; 480p = 0,16 $');
  const nomImg = b2.image_url.split('/').pop();
  ok(M.fichier(nomImg) && M.fichier(nomImg).octets.equals(img) && M.fichier(nomImg).type === 'image/png', 'et sert exactement ses octets');
  statut = { status: 'COMPLETED', error: 'Face not detected', error_type: 'invalid_input' };
  const e2 = await M.rafraichit(r2.id, A);
  ok(e2.statut === 'failed' && /Face not detected/.test(e2.message) && M.fichier(nomImg) === null, 'fal echoue : raison rendue, entrees effacees');
  statut = { status: 'IN_QUEUE' };
  const r3 = await M.lance({ addr: A, octets: clip });
  t += 61000;
  const e3 = await M.rafraichit(r3.id, A);
  ok(e3.statut === 'timeout' && fs.readdirSync(dossier).filter((f) => W.ENTREE.test(f)).length === 0, 'au dela du delai : « timeout », entrees effacees');
  statut = { status: 'COMPLETED' }; sortie = { video: { url: 'https://evil.example/res.mp4' } };
  const r4 = await M.lance({ addr: A, octets: clip });
  const e4 = await M.rafraichit(r4.id, A);
  ok(e4.statut === 'failed' && /refused host/.test(e4.message), 'un resultat hors des CDN fal n est pas telecharge');
  sortie = { video: { url: 'https://v3.fal.media/files/lion/res.mp4' } };
  const r5 = await M.lance({ addr: A, octets: clip, audio: 'off', garderSon: false });
  const e5 = await M.rafraichit(r5.id, A);
  const F5 = path.join(tmp, 'f5.mp4'); fs.writeFileSync(F5, M.resultat(r5.id, A).octets);
  ok(e5.statut === 'succeeded' && e5.son === false && sonde(F5, ['-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0']) === '', 'son decoche : le resultat reste muet');
  ok(!lignes.some((l) => JSON.stringify(l).includes('cle-fal')), 'la cle n est dans aucune ligne du journal');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
