'use strict';
/* ============================================================================
 * « ANIMATE MY STILL » — KLING O1, first_frame + feature_video (15/10/2026)
 *
 * Ce qui DOIT tenir :
 *   1. La forme de la requete (video-omni.md) : POST /omni-video/kling-o1,
 *      contents [prompt, element?, first_frame image_1, refer_image image_2..,
 *      feature_video video_1] — JAMAIS de base_video ; settings { resolution,
 *      duration (la seconde entamee, 3-10), audio: 'off' }, sans aspect_ratio.
 *   2. « images + elements <= 4 » avec une video, l'image fixe COMPTEE : refuse
 *      AVANT tout envoi au-dela ; le texte cite @image_1, @video_1 (et @element_1).
 *   3. Un refus de Kling rend son message EXACT et son code (le premier clic).
 *   4. Un clip seul (3-10 s) : UN morceau, meme a 9,8 s ; le son d'origine remis
 *      et le resultat ramene a la longueur EXACTE du clip (vrai ffmpeg).
 *   5. La video entiere : le morceau 1 part de l'image fixe ; le morceau n part
 *      de la DERNIERE image du resultat n-1 TEL QU'IL EST RECOLLE (coupe a la
 *      longueur de son morceau source), extraite par le vrai ffmpeg ; un seul
 *      morceau chez Kling a la fois ; un morceau rate bloque ceux d'apres ; sa
 *      relance reprend la MEME image.
 *   6. Un redemarrage reprend : l'image fixe et les images d'enchainement sont
 *      sur le disque, le morceau suivant part de la bonne.
 *   7. Le service public (SWOGE Swap) n'anime jamais une image envoyee par la page : depuis le
 *      15/10/2026 (soir, v2) il a ce mode, mais sa premiere image ne peut etre qu'un apercu fait
 *      par le serveur pour CETTE passe (swap_apercu.js) ; une `still` de la page est refusee.
 * Kling est simule : aucun appel reel. ffmpeg est le vrai.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const KE = require('./kling_entier');
const K = require('./kling');
const ST = require('./swoge_texte');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const proche = (a, b, e) => Math.abs(a - b) <= e;

const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const sonde = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', f]).toString());
const duree = (f) => Number(sonde(f).format.duration);
const dureeAudio = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).toString());

/* Une image PNG/JPEG reelle (ffmpeg), d'une couleur. */
function image(f, l, h, couleur) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + couleur + ':s=' + l + 'x' + h, '-frames:v', '1', f]);
  return fs.readFileSync(f);
}
/* La couleur moyenne d'une image (1×1 px, rgb24). */
function couleur(octets, dossier) {
  const f = path.join(dossier, 'c_' + Math.random().toString(16).slice(2) + '.jpg');
  fs.writeFileSync(f, octets);
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [b[0], b[1], b[2]];
}
const rouge = (c) => c[0] > 180 && c[1] < 70 && c[2] < 70;
const vert = (c) => c[1] > 100 && c[0] < 70 && c[2] < 70;
/* Un clip source : mire + son. */
function clip(f, d, o) {
  o = o || {};
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', String(d), '-i', 'testsrc2=size=' + (o.l || 720) + 'x' + (o.h || 1280) + ':rate=30',
    '-f', 'lavfi', '-t', String(d), '-i', 'sine=frequency=440:sample_rate=44100', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return f;
}
/* Le « resultat » de Kling pour un morceau de `d` s : bleu, puis ROUGE sur la derniere seconde
   du morceau, puis VERT APRES sa longueur (Kling rend la seconde entamee) — sans son, 24 i/s.
   La bonne image d'enchainement est rouge ; « la derniere image du fichier » serait verte. */
function resultat(f, d, l, h) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', (d - 1).toFixed(3), '-i', 'color=c=blue:s=' + l + 'x' + h + ':r=24',
    '-f', 'lavfi', '-t', '1', '-i', 'color=c=red:s=' + l + 'x' + h + ':r=24', '-f', 'lavfi', '-t', '1.5', '-i', 'color=c=green:s=' + l + 'x' + h + ':r=24',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
  return fs.readFileSync(f);
}

/* Kling simule : lanceAnime garde la requete et lit le morceau a son URL ; le resultat est
   fabrique par resultat() a la taille du morceau. */
function faux(M, dossier, o) {
  o = o || {};
  const F = { envois: [], taches: {}, enVolMax: 0, refus: o.refus || [], externes: {}, editions: 0 };
  F.kling = {
    actif: () => true,
    lanceEdition: async () => { F.editions++; return { ok: false, code: 400, raison: 'pas ici' }; },
    lanceAnime: async (q) => {
      const nom = q.videoUrl.split('/').pop();
      const f = M().fichier(nom);
      F.envois.push(Object.assign({}, q, { lu: !!f }));
      if (F.refus.length) return F.refus.shift();
      const id = 'A' + F.envois.length;
      F.taches[id] = { statut: 'processing', nom, dureeS: q.dureeS };
      if (q.externe) F.externes[q.externe] = id;
      F.enVolMax = Math.max(F.enVolMax, Object.values(F.taches).filter((t) => t.statut === 'processing').length);
      return { ok: true, id, externe: q.externe, modele: 'kling-o1', anime: true, resolution: q.resolution, audio: 'off', duree: K.dureeAnime(q.dureeS), dureeS: q.dureeS,
               estimationUsd: Math.round(K.EDITION_PRIX[q.resolution] * K.dureeAnime(q.dureeS) * 1000) / 1000, images: (q.images || []).map(() => 'url'), element: q.element || null };
    },
    etat: async (id) => {
      const t = F.taches[id]; if (!t) return { ok: false, code: 404 };
      if (t.statut === 'succeeded') return { ok: true, id, statut: 'succeeded', url: 'https://p2-kling.klingai.com/r/' + id + '.mp4', duree: K.dureeAnime(t.dureeS) };
      if (t.statut === 'failed') return { ok: true, id, statut: 'failed', message: 'content risk' };
      return { ok: true, id, statut: 'processing' };
    },
    etatExterne: async (x) => (F.externes[x] ? F.kling.etat(F.externes[x]) : { ok: false, code: 404, raison: 'unknown task' }),
  };
  F.fetchCdn = async (u) => {
    const id = /\/r\/(A\d+)\.mp4$/.exec(u); const t = id && F.taches[id[1]];
    if (!t) return { status: 404, ok: false, headers: { get: () => null } };
    if (!t.octets) t.octets = resultat(path.join(dossier, 'kling_' + id[1] + '.mp4'), t.dureeS, 720, 1280);
    const b = t.octets;
    return { status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(b.length) : null) }, arrayBuffer: async () => b };
  };
  F.finit = (statut, quoi) => { for (const [id, t] of Object.entries(F.taches)) if (t.statut === 'processing' && (!quoi || quoi(id, t))) t.statut = statut; };
  return F;
}

async function attendStatut(M, id, addr, statuts, max) {
  for (let k = 0; k < (max || 600); k++) {
    const e = M.etat(id, addr);
    if (statuts.includes(e.statut)) return e;
    await M.attend(id); await new Promise((r) => setTimeout(r, 20));
  }
  return M.etat(id, addr);
}
/* Fait tourner les tours jusqu'a `fin()`. */
async function tourne(M, fin, max) {
  for (let k = 0; k < (max || 200); k++) { if (fin()) return true; await M.tour(); }
  return fin();
}

(async () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-anime-'));

  console.log('-- 1. la requete envoyee a Kling (kling.lanceAnime) --');
  {
    const corps = [];
    let reponse = { code: 0, data: { id: 'T1', status: 'submitted' } };
    const fetch = async (u, o) => { corps.push({ u, b: JSON.parse(o.body), h: o.headers }); return { status: 200, json: async () => reponse }; };
    const kl = K.cree({ cle: () => 'cle-test', fetch });
    const png = (l, h) => { const b = Buffer.alloc(40); b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; };
    const STILL = 'data:image/png;base64,' + png(720, 1280).toString('base64');
    const TEXTE = ST.texteAnime('images', '');
    const r = await kl.lanceAnime({ videoUrl: 'https://srv.example/studio/kling-entier-clip/' + 'a'.repeat(48) + '.mp4', premiere: STILL,
      images: ['https://site.example/img/site/swoge_meme_ref.jpg', 'https://site.example/img/site/swoge_face_ref.jpg'], prompt: TEXTE, resolution: '720p', dureeS: 9.4 });
    const b = corps[0] && corps[0].b;
    ok(r.ok && corps.length === 1 && /\/omni-video\/kling-o1$/.test(corps[0].u) && corps[0].h.authorization === 'Bearer cle-test', 'POST /omni-video/kling-o1, cle en Bearer');
    ok(b && JSON.stringify(b.contents.map((c) => c.type + ':' + (c.id || ''))) === JSON.stringify(['prompt:', 'first_frame:image_1', 'refer_image:image_2', 'refer_image:image_3', 'feature_video:video_1']),
       'contents : prompt, first_frame image_1, refer_image image_2/3, feature_video video_1 ' + JSON.stringify(b && b.contents.map((c) => c.type)));
    ok(b && !b.contents.some((c) => c.type === 'base_video' || c.type === 'last_frame'), 'jamais de base_video ni de last_frame');
    ok(b && b.contents[1].url === png(720, 1280).toString('base64'), 'la premiere image part en base64 SANS prefixe');
    ok(b && b.contents[4].url === 'https://srv.example/studio/kling-entier-clip/' + 'a'.repeat(48) + '.mp4', 'le clip part par son URL publique');
    ok(b && JSON.stringify(b.settings) === JSON.stringify({ resolution: '720p', duration: 10, audio: 'off' }) && !('aspect_ratio' in b.settings),
       'settings : 720p, duration 10 (9,4 s entamees), audio off, pas d aspect_ratio ' + JSON.stringify(b && b.settings));
    ok(r.estimationUsd === 1.26 && r.duree === 10 && r.audio === 'off' && r.anime === true, 'estimation : 10 s × 0,126 $ = 1,26 $');
    ok(/^[0-9a-f]{24}$/.test(b.options.external_task_id), 'un identifiant externe (reprise apres redemarrage)');
    ok(K.dureeAnime(3) === 3 && K.dureeAnime(3.01) === 4 && K.dureeAnime(10) === 10 && K.dureeAnime(2.99) === null && K.dureeAnime(10.01) === null, 'duration : la seconde entamee, 3 a 10, sinon refus');

    corps.length = 0;
    const re = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, element: '161', prompt: ST.texteAnime('element', ''), resolution: '1080p', dureeS: 5 });
    const be = corps[0] && corps[0].b;
    ok(re.ok && be && JSON.stringify(be.contents.map((c) => c.type)) === JSON.stringify(['prompt', 'element', 'first_frame', 'feature_video']) && be.contents[1].element_id === '161' && be.contents[1].id === 'element_1',
       'avec l element : l ordre de l exemple de la doc (prompt, element element_1, first_frame, feature_video)');
    ok(be && be.settings.resolution === '1080p' && be.settings.duration === 5 && re.estimationUsd === 0.84, '1080p, 5 s : 0,84 $');

    corps.length = 0;
    const quatre = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, images: [STILL, STILL, STILL], prompt: TEXTE, dureeS: 5 });
    const cinq = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, images: [STILL, STILL, STILL], element: '161', prompt: TEXTE + ' @element_1', dureeS: 5 });
    const cinqB = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, images: [STILL, STILL, STILL, STILL], prompt: TEXTE, dureeS: 5 });
    ok(quatre.ok && !cinq.ok && !cinqB.ok && /4 pictures and elements at most/.test(cinq.raison) && corps.length === 1,
       'la regle des 4 : image fixe + 3 references passe ; + element ou + une 4e reference : refuse AVANT envoi');
    corps.length = 0;
    const sansCite = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, prompt: 'Animate this.', dureeS: 5 });
    const sansEl = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, element: '161', prompt: TEXTE, dureeS: 5 });
    const webp = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: 'data:image/webp;base64,UklGRg==', prompt: TEXTE, dureeS: 5 });
    const court = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, prompt: TEXTE, dureeS: 2.5 });
    ok(!sansCite.ok && /@image_1/.test(sansCite.raison) && !sansEl.ok && /@element_1/.test(sansEl.raison) && !webp.ok && /^still:/.test(webp.raison) && !court.ok && corps.length === 0,
       'refus avant envoi : texte sans @image_1/@video_1, element non cite, image WebP, clip de 2,5 s');
    reponse = { code: 1201, message: 'duration is not supported with feature_video' };
    const refus = await kl.lanceAnime({ videoUrl: 'https://srv.example/c.mp4', premiere: STILL, prompt: TEXTE, dureeS: 5 });
    ok(!refus.ok && refus.raison === 'Kling refused (code 1201, HTTP 200): duration is not supported with feature_video' && refus.klingCode === 1201,
       'un refus de Kling : son message EXACT et son code [' + refus.raison + ']');
    ok(!JSON.stringify(refus).includes('cle-test'), 'la cle ne sort jamais');
  }

  console.log('\n-- 2. le texte --');
  {
    const t = ST.texteAnime('images', 'slow zoom in\u0000');
    const te = ST.texteAnime('element', '');
    ok(/^Start exactly from @image_1/.test(t) && /Keep every character exactly as it looks in @image_1/.test(t) && /motion, gestures, timing and camera movement of @video_1/.test(t) && /Keep the background/.test(t),
       'le texte : partir de @image_1, garder chaque personnage, suivre @video_1 (mouvement, gestes, rythme, camera), garder le decor');
    ok(/@image_2 \(full body\) and @image_3 \(face\)/.test(t) && !/@element_1/.test(t) && /@element_1/.test(te) && !/@image_2/.test(te), 'references : @image_2/@image_3 sans element, @element_1 avec');
    ok(/never human skin, human hands or a human body/.test(t), 'les defauts mesures le 15/10 nommes : peau, mains, corps humains');
    ok(/ slow zoom in$/.test(t) && t.length < K.TEXTE_MAX && ST.texteAnime(null, 'x'.repeat(5000)).length < K.TEXTE_MAX, 'la direction du proprietaire en fin, bornee (' + ST.NOTE_ANIME_MAX + ')');
  }

  if (!ffmpegOk) { console.log('ffmpeg absent : la suite est ignoree'); return fin(); }

  /* blanche : ni rouge ni verte, on la distingue d'une image d'enchainement */
  const STILL_PNG = image(path.join(D, 'still.png'), 720, 1280, 'white');
  const STILL = 'data:image/png;base64,' + STILL_PNG.toString('base64');
  const IMG = ['https://site.example/img/site/swoge_meme_ref.jpg', 'https://site.example/img/site/swoge_face_ref.jpg'];
  const ADDR = '0xproprio';

  console.log('\n-- 3. un clip seul : un morceau, son d origine, longueur exacte --');
  {
    const dossier = path.join(D, 'clip');
    let M = null; let element = null;
    const F = faux(() => M, D);
    M = KE.cree({ dossier, kling: F.kling, urlPublique: (n) => 'https://srv.example/studio/kling-entier-clip/' + n, imagesDefaut: IMG, journal: () => {}, fetchCdn: F.fetchCdn, pollMs: 5,
                  element: () => element });
    const src = clip(path.join(D, 'clip98.mp4'), 9.8);
    const c = await M.cree(ADDR, fs.createReadStream(src), fs.statSync(src).size, { anime: true, clip: true });
    const e = await attendStatut(M, c.id, ADDR, ['pret', 'erreur']);
    ok(e.statut === 'pret' && e.morceaux.length === 1 && proche(e.morceaux[0].duree, 9.8, 0.06) && e.anime && e.anime.clip === true && e.parallele === 1,
       'un clip de 9,8 s : UN morceau (la video entiere en ferait deux) [' + e.statut + ' ' + (e.message || '') + ' ' + JSON.stringify(e.morceaux && e.morceaux.map((m) => m.duree)) + ']');
    ok(e.prixPire['720p'] === 1.26 && e.prixPire['1080p'] === 1.68, 'prix au pire : 10 s entamees, 1,26 $ (720p) / 1,68 $ (1080p)');
    ok(F.envois.length === 0, 'rien chez Kling avant le clic');
    const sans = await M.lance(c.id, ADDR, { resolution: '720p', confirmeUsd: 1.26 });
    const faux1 = await M.lance(c.id, ADDR, { still: STILL, resolution: '720p', confirmeUsd: 1 });
    const lien = await M.lance(c.id, ADDR, { still: 'https://x.example/a.png', resolution: '720p', confirmeUsd: 1.26 });
    ok(!sans.ok && /choose your still/.test(sans.raison) && !faux1.ok && faux1.code === 409 && !lien.ok && /not a link/.test(lien.raison) && F.envois.length === 0,
       'sans image fixe, un autre prix, une URL au lieu de l image : refuse, rien chez Kling');
    const l = await M.lance(c.id, ADDR, { still: STILL, resolution: '720p', confirmeUsd: 1.26, note: 'He smiles at the end.' });
    ok(l.ok && F.envois.length === 1 && F.envois[0].lu, 'lance : le morceau part, Kling le lit a son URL');
    const q = F.envois[0];
    ok(q.premiere === STILL_PNG.toString('base64') && JSON.stringify(q.images) === JSON.stringify(IMG) && !q.element && /He smiles at the end\.$/.test(q.prompt) && q.prompt.startsWith('Start exactly from @image_1'),
       'morceau 1 : l image fixe en premiere image, le corps et le visage SWOGE, le texte et la direction');
    ok(F.editions === 0, 'jamais lanceEdition (base_video) dans ce mode');
    ok(fs.existsSync(path.join(dossier, c.id, 'still.png')), 'l image fixe est sur le disque (relances, redemarrage)');
    F.finit('succeeded');
    const f = await tourne(M, () => M.etat(c.id, ADDR).statut === 'fini');
    const r = M.resultat(c.id, ADDR);
    const s = r && sonde(r.chemin);
    ok(f && r && s.streams.some((x) => x.codec_type === 'audio'), 'fini : le son d origine est remis (Kling a rendu sans son)');
    ok(r && proche(duree(r.chemin), duree(src), 0.05) && proche(dureeAudio(r.chemin), duree(src), 0.06),
       'a la longueur EXACTE du clip : ' + (r && duree(r.chemin)) + ' s pour ' + duree(src) + ' s (Kling a rendu 10 s)');
    /* un clip court : Kling rend plus court, le resultat est prolonge */
    const src2 = clip(path.join(D, 'clip4.mp4'), 4.3);
    const c2 = await M.cree(ADDR, fs.createReadStream(src2), fs.statSync(src2).size, { anime: true, clip: true });
    await attendStatut(M, c2.id, ADDR, ['pret', 'erreur']);
    await M.lance(c2.id, ADDR, { still: STILL, resolution: '720p', confirmeUsd: 0.63 });
    const t2 = Object.keys(F.taches).pop(); F.taches[t2].octets = resultat(path.join(D, 'court.mp4'), 3.5, 720, 1280);
    F.finit('succeeded');
    await tourne(M, () => M.etat(c2.id, ADDR).statut === 'fini');
    const r2 = M.resultat(c2.id, ADDR);
    ok(r2 && proche(duree(r2.chemin), 4.3, 0.05), 'Kling rend 3,5 s pour 4,3 s : prolonge a ' + (r2 && duree(r2.chemin)) + ' s');
    /* 12 s en clip seul : refuse au plan */
    const src3 = clip(path.join(D, 'clip12.mp4'), 12);
    const c3 = await M.cree(ADDR, fs.createReadStream(src3), fs.statSync(src3).size, { anime: true, clip: true });
    const e3 = await attendStatut(M, c3.id, ADDR, ['pret', 'erreur']);
    ok(e3.statut === 'erreur' && /one clip is 3 to 10 s/.test(e3.message), 'un clip de 12 s : refuse (Whole video) [' + e3.message + ']');
    /* l element SWOGE : a la place des deux images ; l image fixe + l element = 2 <= 4 */
    element = '161';
    const c4 = await M.cree(ADDR, fs.createReadStream(src2), fs.statSync(src2).size, { anime: true, clip: true });
    await attendStatut(M, c4.id, ADDR, ['pret', 'erreur']);
    await M.lance(c4.id, ADDR, { still: STILL, resolution: '720p', confirmeUsd: 0.63 });
    const q4 = F.envois[F.envois.length - 1];
    ok(q4.element === '161' && q4.images.length === 0 && /@element_1/.test(q4.prompt) && !/@image_2/.test(q4.prompt), 'avec l element : element_1 seul, le texte le cite');
    F.finit('failed'); await tourne(M, () => M.etat(c4.id, ADDR).statut === 'incomplet');
    M.abandonne(c4.id, ADDR);
  }

  console.log('\n-- 4. la video entiere : morceaux enchaines, un a la fois --');
  let dossierE, idE, srcE;
  {
    dossierE = path.join(D, 'entier');
    let M = null;
    const F = faux(() => M, D);
    const journal = [];
    M = KE.cree({ dossier: dossierE, kling: F.kling, urlPublique: (n) => 'https://srv.example/studio/kling-entier-clip/' + n, imagesDefaut: IMG, journal: (o) => journal.push(o), fetchCdn: F.fetchCdn, pollMs: 5, parallele: 3 });
    srcE = clip(path.join(D, 'entier20.mp4'), 20);
    const c = await M.cree(ADDR, fs.createReadStream(srcE), fs.statSync(srcE).size, { anime: true });
    idE = c.id;
    const e = await attendStatut(M, c.id, ADDR, ['pret', 'erreur']);
    ok(e.statut === 'pret' && e.morceaux.length === 3 && e.anime && e.anime.clip === false && e.anime.sequentiel === true && e.parallele === 1,
       '20 s : 3 morceaux, sequentiel, un a la fois (meme avec parallele: 3) [' + JSON.stringify(e.morceaux.map((m) => m.duree)) + ']');
    const prix = e.prixPire['720p'];
    const l = await M.lance(c.id, ADDR, { still: STILL, resolution: '720p', confirmeUsd: prix });
    ok(l.ok && F.envois.length === 1 && l.morceaux[1].statut === 'waiting' && l.morceaux[2].statut === 'waiting', 'lance : SEUL le morceau 1 part, 2 et 3 attendent');
    await M.tour(); await M.tour();
    ok(F.envois.length === 1, 'tant que le morceau 1 est chez Kling, le 2 ne part pas');
    ok(F.envois[0].premiere === STILL_PNG.toString('base64'), 'morceau 1 : l image fixe');
    F.finit('succeeded');
    await tourne(M, () => F.envois.length >= 2);
    const q2 = F.envois[1];
    const chaine2 = path.join(dossierE, c.id, 'chaine_001.jpg');
    ok(F.envois.length === 2 && fs.existsSync(chaine2) && q2.premiere === fs.readFileSync(chaine2).toString('base64'),
       'morceau 2 : part de chaine_001.jpg, extraite par ffmpeg du resultat 1');
    const c2 = couleur(Buffer.from(q2.premiere, 'base64'), D);
    ok(rouge(c2), 'cette image est la DERNIERE du resultat 1 coupe a la longueur de son morceau (rouge), pas la derniere du fichier (vert) ' + JSON.stringify(c2));
    ok(K.dimensionsImage(Buffer.from(q2.premiere, 'base64')).largeur === 720, 'a la taille du resultat (720×1280)');
    ok(F.enVolMax === 1, 'jamais plus d un morceau chez Kling a la fois');
    /* le morceau 2 rate : le 3 ne part pas, la passe attend la relance */
    F.finit('failed');
    const inc = await tourne(M, () => M.etat(c.id, ADDR).statut === 'incomplet');
    const ei = M.etat(c.id, ADDR);
    ok(inc && F.envois.length === 2 && ei.morceaux[2].statut === 'waiting' && ei.morceaux[2].bloque === true && /part 2 failed — retry it/.test(ei.message),
       'le morceau 2 rate : le 3 attend (bloque), la passe le dit [' + ei.message + ']');
    const rl = await M.relance(c.id, ADDR, 1);
    ok(rl.ok && F.envois.length === 3 && F.envois[2].premiere === q2.premiere, 'relance du morceau 2 : la MEME image d enchainement');
    F.finit('succeeded');
    await tourne(M, () => F.envois.length >= 4);
    const c3 = couleur(Buffer.from(F.envois[3].premiere, 'base64'), D);
    ok(F.envois.length === 4 && rouge(c3) && F.envois[3].premiere !== STILL_PNG.toString('base64'), 'morceau 3 : part de la derniere image du resultat 2');
    /* arret ICI : le morceau 3 est chez Kling ; on garde la passe pour la section 5 */
    M.arrete();
    ok(journal.filter((x) => x.anime && x.chaine === true).length === 3 && journal.some((x) => x.lance && x.anime === true), 'journal : chaque envoi enchaine, le lancement marque anime');
  }

  console.log('\n-- 5. le redemarrage --');
  {
    /* un nouveau processus sur le meme dossier : la tache 3 (A4) est connue de Kling */
    let M = null;
    const F = faux(() => M, D);
    F.taches.A4 = { statut: 'succeeded', nom: null, dureeS: 6.667 };
    M = KE.cree({ dossier: dossierE, kling: F.kling, urlPublique: (n) => 'https://srv.example/studio/kling-entier-clip/' + n, imagesDefaut: IMG, journal: () => {}, fetchCdn: F.fetchCdn, pollMs: 5 });
    const e = M.etat(idE, ADDR);
    ok(e.ok && e.statut === 'en_cours' && e.anime && e.morceaux[0].statut === 'done' && e.morceaux[2].statut === 'processing', 'relue au demarrage : morceaux 1-2 faits, 3 chez Kling');
    const f = await tourne(M, () => M.etat(idE, ADDR).statut === 'fini');
    const r = M.resultat(idE, ADDR);
    ok(f && r && proche(duree(r.chemin), duree(srcE), 0.06) && sonde(r.chemin).streams.some((x) => x.codec_type === 'audio'), 'reprise jusqu au recollage : ' + (r && duree(r.chemin)) + ' s, son d origine');
    ok(F.envois.length === 0, 'rien de renvoye a Kling apres le redemarrage');
    const reste = fs.readdirSync(path.join(dossierE, idE));
    ok(!reste.some((x) => /^chaine_|^still\./.test(x)), 'a la fin, image fixe et images d enchainement effacees [' + reste.join(',') + ']');

    /* un redemarrage ENTRE deux morceaux : le suivant part de la bonne image */
    const d2 = path.join(D, 'entier2');
    let M2 = null; const F2 = faux(() => M2, D);
    M2 = KE.cree({ dossier: d2, kling: F2.kling, urlPublique: (n) => 'https://srv.example/studio/kling-entier-clip/' + n, imagesDefaut: IMG, journal: () => {}, fetchCdn: F2.fetchCdn, pollMs: 5 });
    const src = clip(path.join(D, 'entier14.mp4'), 14);
    const c = await M2.cree(ADDR, fs.createReadStream(src), fs.statSync(src).size, { anime: true });
    const p = await attendStatut(M2, c.id, ADDR, ['pret']);
    await M2.lance(c.id, ADDR, { still: STILL, resolution: '720p', confirmeUsd: p.prixPire['720p'] });
    F2.finit('succeeded');
    await tourne(M2, () => M2.etat(c.id, ADDR).morceaux[0].statut === 'done' || F2.envois.length > 1, 50);
    M2.arrete();
    /* le morceau 2 a peut-etre deja ete envoye dans le meme tour : on reconstruit l etat « 1 fait, 2 en attente » */
    const fe = path.join(d2, c.id, 'etat.json');
    const P = JSON.parse(fs.readFileSync(fe, 'utf8'));
    P.segments[1] = Object.assign(P.segments[1], { statut: 'attente', rid: null, externe: null, essais: 0 });
    try { fs.unlinkSync(path.join(d2, c.id, 'chaine_001.jpg')); } catch (e) { /* pas encore la */ }
    fs.writeFileSync(fe, JSON.stringify(P));
    let M3 = null; const F3 = faux(() => M3, D);
    M3 = KE.cree({ dossier: d2, kling: F3.kling, urlPublique: (n) => 'https://srv.example/studio/kling-entier-clip/' + n, imagesDefaut: IMG, journal: () => {}, fetchCdn: F3.fetchCdn, pollMs: 5 });
    await tourne(M3, () => F3.envois.length >= 1, 20);
    ok(F3.envois.length === 1 && rouge(couleur(Buffer.from(F3.envois[0].premiere, 'base64'), D)) && F3.envois[0].prompt.startsWith('Start exactly from @image_1'),
       'redemarre entre deux morceaux : le 2 part de la derniere image du 1, refaite depuis le resultat garde sur le disque');
    M3.arrete();
  }

  console.log('\n-- 6. le service public n anime jamais une image de la page --');
  {
    /* l'intention d'avant (« jamais en public ») : aucune image fournie par un joueur ne devient la
       premiere image chez Kling. Depuis la v2, le mode existe, la premiere image vient de l'apercu. */
    const envois = [];
    const kl = { actif: () => true, lanceAnime: async (q) => { envois.push(q); return { ok: true, id: 'X1', estimationUsd: 1 }; }, etat: async () => ({ ok: true, statut: 'processing' }), etatExterne: async () => ({ ok: false, code: 404 }) };
    const reserves = [];
    const pub = { droitsTexte: 'I own it', resolutions: ['720p', '1080p'], prixClient: (x) => Math.ceil(x * 2 * 100 - 1e-9) / 100, passesMax: 2, plafondJourUsd: 50, relancesGratuites: 1, decoupesMax: 3,
      pretMaxMs: 3600e3, incompletMaxMs: 3600e3, marge: 2, urlVideo: (id) => '/v/' + id, catalogue: () => ({}), imageVerifiee: () => null,
      paie: { reserve: (a, usd) => { reserves.push(usd); return 'r1'; }, regle: () => '0', solde: () => 100 },
      stillApercu: (id, addr, k) => (String(k) === '0' ? { ok: true, base64: image(path.join(D, 'apercu.jpg'), 720, 1280, 'red').toString('base64'), perso: 'swoge', cible: 'gauche', k: 0 } : { ok: false, code: 400, raison: 'create the preview picture first' }) };
    const M = KE.cree({ dossier: path.join(D, 'pub'), kling: kl, urlPublique: (n) => 'https://srv.example/c/' + n, imagesDefaut: IMG, journal: () => {}, public: pub });
    const src = path.join(D, 'clip4.mp4');
    const r = await M.cree('0xjoueur', fs.createReadStream(src), fs.statSync(src).size, { droits: true, anime: true });
    await M.attend(r.id);
    const e = M.etat(r.id, '0xjoueur');
    ok(r.ok && e.statut === 'pret' && e.morceaux.length === 1 && e.anime && e.anime.clip === true, 'SWOGE Swap v2 : ?mode=anime ouvert, un clip de 4 s = UN morceau (clip seul automatique)');
    const prix = e.prixUsdParResolution['720p'];
    const stillPage = 'data:image/png;base64,' + image(path.join(D, 'page.png'), 720, 1280, 'blue').toString('base64');
    const l1 = await M.lance(r.id, '0xjoueur', { still: stillPage, apercu: 0, confirmeUsd: prix });
    ok(!l1.ok && l1.code === 400 && /preview made here/.test(l1.raison) && envois.length === 0 && reserves.length === 0, 'une image envoyee par la page : 400, rien reserve, rien chez Kling');
    const l2 = await M.lance(r.id, '0xjoueur', { confirmeUsd: prix });
    ok(!l2.ok && l2.code === 400 && envois.length === 0 && reserves.length === 0, 'sans apercu : 400, rien reserve, rien chez Kling');
    const l3 = await M.lance(r.id, '0xjoueur', { apercu: 0, confirmeUsd: prix });
    ok(l3.ok && envois.length === 1 && rouge(couleur(Buffer.from(envois[0].premiere, 'base64'), D)) && reserves[0] === prix && envois[0].images.length === 2 && envois[0].prompt.startsWith('Start exactly from @image_1'),
       'l apercu 0 du serveur : premiere image = l apercu (rouge), SWOGE en refer_image, prix reserve');
    M.arrete();
  }
  fin();
  function fin() {
    console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
    process.exit(rates ? 1 : 0);
  }
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
