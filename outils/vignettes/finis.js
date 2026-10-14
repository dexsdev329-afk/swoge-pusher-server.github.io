#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * VIGNETTES DU STUDIO — LA FINITION D'UN CLIP : BOUCLE ALLER-RETOUR, WEB
 *
 * Le modele lite ne prend pas last_frame (planches.js, EPINGLE) : un clip ne
 * revient pas a sa premiere image. On le boucle donc nous-memes en aller-
 * retour : f1..fN puis fN-1..f0, et la lecture en boucle repart sur f1 —
 * aucune image doublee a l'une ou l'autre couture, aucun saut.
 *
 * Sortie : H.264 (libx264, high, yuv420p), MUET (-an), 480 de haut au plus,
 * faststart (la lecture commence avant la fin du telechargement) ; plus un
 * VP9 (WebM) a cote, que la page propose EN PREMIER : le Chromium sans codecs
 * proprietaires (celui de Playwright, mesure le 14/10/2026 : canPlayType
 * avc1 = '' , vp9 = 'probably') ne lit pas le H.264 ; Safari ancien prend le MP4.
 * Mesure du 14/10/2026 (ffmpeg 6.1.1, clip de 3 s 848x480 24 i/s fabrique
 * depuis accueil/hero.webp avec un zoom lent) : 72 images -> 142 images,
 * 5,92 s, 244 Ko en H.264 crf 26 preset slow (le brut crf 18 : 429 Ko) ;
 * VP9 crf 38 depuis le meme brut : 160 Ko (8 s d'encodage). Le WebM est facultatif : s'il
 * echoue, le MP4 reste et la page passe a la source suivante.
 *
 * ffmpeg est dans l'image Railway (Dockerfile, « apk add ffmpeg ») ; le meme
 * fichier sert en ligne de commande pour refaire la finition a la main sur un
 * clip brut telecharge depuis la page proprietaire :
 *   node outils/vignettes/finis.js <brut.mp4> <sortie.mp4> [<sortie.webm>]
 * ======================================================================== */
const fs = require('fs');
const { execFile } = require('child_process');

const CRF = 26;
const CRF_VP9 = 38;
const HAUT = 480;

const lance = (ffmpeg, args) => new Promise((res, rej) => execFile(ffmpeg || 'ffmpeg', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => {
  if (e) return rej(new Error(e.code === 'ENOENT' ? 'ffmpeg missing' : ('ffmpeg: ' + String(err || e.message).trim().split('\n').pop()).slice(0, 160)));
  return res();
}));

/** brut -> sortie .mp4 (+ sortieWebm facultative), boucle aller-retour.
 *  Rend { octets, webm: octets|null, erreurWebm }. Leve une erreur courte si le MP4 echoue. */
async function finis({ entree, sortie, sortieWebm, ffmpeg }) {
  const graphe = '[0:v]scale=-2:\'min(' + HAUT + ',ih)\':flags=lanczos,format=yuv420p,split[a][b];'
    + '[a]trim=start_frame=1,setpts=PTS-STARTPTS[f];'
    + '[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];'
    + '[f][r]concat=n=2:v=1:a=0[v]';
  const avant = ['-v', 'error', '-y', '-i', entree, '-filter_complex', graphe, '-map', '[v]', '-an'];
  await lance(ffmpeg, avant.concat(['-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sortie]));
  const b = fs.readFileSync(sortie);
  /* un MP4 commence par une boite « ftyp » (octets 4..8) */
  if (b.length < 1000 || b.toString('latin1', 4, 8) !== 'ftyp') throw new Error('output is not an MP4');
  let webm = null, erreurWebm = null;
  if (sortieWebm) {
    try {
      await lance(ffmpeg, avant.concat(['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(CRF_VP9), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', sortieWebm]));
      const w = fs.readFileSync(sortieWebm);
      /* un WebM commence par l'en-tete EBML 1A 45 DF A3 */
      if (w.length < 1000 || w.readUInt32BE(0) !== 0x1a45dfa3) throw new Error('output is not a WebM');
      webm = w.length;
    } catch (e) { erreurWebm = String(e.message).slice(0, 160); try { fs.unlinkSync(sortieWebm); } catch (x) { /* rien */ } }
  }
  return { octets: b.length, webm, erreurWebm };
}

module.exports = { finis, CRF, CRF_VP9, HAUT };

if (require.main === module) {
  const [entree, sortie, sortieWebm] = process.argv.slice(2);
  if (!entree || !sortie) { console.error('usage: node outils/vignettes/finis.js <raw.mp4> <out.mp4> [<out.webm>]'); process.exit(2); }
  finis({ entree, sortie, sortieWebm }).then((r) => { console.log(JSON.stringify(Object.assign({ ok: true, sortie, sortieWebm: sortieWebm || null }, r))); },
    (e) => { console.error(e.message); process.exit(1); });
}
