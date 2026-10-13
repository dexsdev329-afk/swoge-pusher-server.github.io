'use strict';
/* ==========================================================================
 * PLANCHES — LIRE ET ECRIRE LES IMAGES ET LES VIDEOS (ffmpeg, sans dependance)
 *
 * Tout passe par ffmpeg, deja dans l'image Railway (Dockerfile : apk add
 * ffmpeg) et dans ce conteneur : aucune bibliotheque d'image a installer, la
 * meme chaine tourne ici et sur le serveur. Une image en memoire est
 * { w, h, data: Uint8ClampedArray RGBA }.
 *
 * Ecriture : PNG en pur Node (zlib), WebP par ffmpeg/libwebp. Si l'encodeur
 * WebP manque (une image ffmpeg compilee sans libwebp), on garde le PNG et la
 * fiche le dit : jamais une planche perdue pour un format.
 * ======================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');

const FFMPEG = process.env.PLANCHES_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.PLANCHES_FFPROBE || 'ffprobe';

function image(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }

/* Lance un programme, rend sa sortie standard entiere (Buffer). */
function lance(prog, args, entree, delaiMs) {
  return new Promise((res, rej) => {
    const p = spawn(prog, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let fini = false;
    const t = setTimeout(() => { if (!fini) { p.kill('SIGKILL'); rej(new Error(prog + ' : delai depasse')); } }, delaiMs || 120000);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { if (err.length < 50) err.push(c); });
    p.on('error', (e) => { fini = true; clearTimeout(t); rej(e.code === 'ENOENT' ? new Error(prog + ' missing') : e); });
    p.on('close', (code) => {
      fini = true; clearTimeout(t);
      if (code !== 0) return rej(new Error(prog + ' ' + code + ' : ' + Buffer.concat(err).toString('utf8').slice(0, 300)));
      res(Buffer.concat(out));
    });
    p.stdin.on('error', () => {});
    if (entree) p.stdin.end(entree); else p.stdin.end();
  });
}

/** Largeur, hauteur, images/s, nombre d'images et duree d'une video. */
async function sonde(fichier) {
  const b = await lance(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,duration', '-of', 'json', fichier]);
  const s = JSON.parse(b.toString('utf8')).streams[0];
  const [a, d] = String(s.r_frame_rate).split('/').map(Number);
  const fps = d ? a / d : a;
  return { w: s.width, h: s.height, fps, n: Number(s.nb_read_frames) || 0, duree: Number(s.duration) || 0 };
}

/** Les images d'une video (ou d'une partie : crop {x,y,w,h}), en RGBA. */
async function images(fichier, crop) {
  const s = await sonde(fichier);
  let w = s.w, h = s.h;
  const args = ['-v', 'error', '-i', fichier];
  if (crop) {
    w = Math.max(2, Math.round(crop.w)); h = Math.max(2, Math.round(crop.h));
    args.push('-vf', 'crop=' + w + ':' + h + ':' + Math.round(crop.x) + ':' + Math.round(crop.y));
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
  const b = await lance(FFMPEG, args, null, 300000);
  const t = w * h * 4, n = Math.floor(b.length / t);
  const F = [];
  for (let i = 0; i < n; i++) F.push(new Uint8ClampedArray(b.buffer, b.byteOffset + i * t, t));
  return { w, h, fps: s.fps, frames: F, source: s };
}

/** Une image fixe (png, webp, jpeg) : chemin ou Buffer. */
async function lisImage(src) {
  let fichier = src, tmp = null;
  if (Buffer.isBuffer(src)) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planche-'));
    fichier = path.join(tmp, 'entree.img'); fs.writeFileSync(fichier, src);
  }
  try {
    const p = await lance(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', fichier]);
    const s = JSON.parse(p.toString('utf8')).streams[0];
    const b = await lance(FFMPEG, ['-v', 'error', '-i', fichier, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    if (b.length < s.width * s.height * 4) throw new Error('image illisible');
    return { w: s.width, h: s.height, data: new Uint8ClampedArray(b.buffer, b.byteOffset, s.width * s.height * 4) };
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ---- PNG en pur Node : 8 bits RGBA, filtre « Sub » par ligne, zlib 9. ---- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function morceau(type, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
}
function png(img) {
  const { w, h, data } = img;
  const brut = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1); brut[o] = 1;
    for (let x = 0; x < w * 4; x++) {
      const v = data[y * w * 4 + x], g = x >= 4 ? data[y * w * 4 + x - 4] : 0;
      brut[o + 1 + x] = (v - g) & 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), morceau('IHDR', ihdr),
    morceau('IDAT', zlib.deflateSync(brut, { level: 9 })), morceau('IEND', Buffer.alloc(0))]);
}
function ecrisPng(img, fichier) { fs.mkdirSync(path.dirname(fichier), { recursive: true }); fs.writeFileSync(fichier, png(img)); return fichier; }

/** WebP avec perte (qualite 90) et alpha sans perte. Rend le chemin ecrit, ou null si l'encodeur manque. */
async function ecrisWebp(img, fichier, qualite) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  try {
    await lance(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', img.w + 'x' + img.h, '-i', 'pipe:0',
      '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-quality', String(qualite || 90), '-pix_fmt', 'yuva420p', fichier],
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length));
    return fichier;
  } catch (e) { return null; }
}

/** Une video H.264 (yuv420p, 24 i/s) a partir d'images RGB(A) : pour les faux clips des essais. */
async function ecrisMp4(frames, w, h, fps, fichier) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const b = Buffer.alloc(frames.length * w * h * 3);
  let o = 0;
  for (const f of frames) for (let i = 0; i < w * h; i++) { b[o++] = f[i * 4]; b[o++] = f[i * 4 + 1]; b[o++] = f[i * 4 + 2]; }
  await lance(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', w + 'x' + h, '-r', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', fichier], b, 300000);
  return fichier;
}

/** ffmpeg sait-il ecrire du WebP ? (une fois par processus) */
let _webp = null;
function webpDispo() {
  if (_webp) return _webp;
  _webp = new Promise((res) => execFile(FFMPEG, ['-hide_banner', '-encoders'], (e, o) => res(!e && /libwebp/.test(String(o)))));
  return _webp;
}

module.exports = { image, sonde, images, lisImage, png, ecrisPng, ecrisWebp, ecrisMp4, webpDispo, lance };
