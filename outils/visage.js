'use strict';
/* ==========================================================================
 * LE VISAGE DE SWOGE POUR LES CARTES — RENDU UNE FOIS, JAMAIS EN PRODUCTION
 *
 *   node outils/visage.js [chemin/vers/icone-512.png]
 *
 * La carte du roast (roast.js) montre SWOGE. Le serveur ne decode aucune
 * image (carte_png.js n a pas de dependance, c est voulu) : on lit donc UNE
 * FOIS l icone officielle du site (img/site/icone-512.png, PNG 8 bits RGB
 * sans entrelacement), on la reduit de moitie en moyennant chaque carre de
 * 2×2 pixels, et on range les octets RGB deflate dans `visage_swoge.json`, a
 * la racine. Il est commite, comme `police_scan.json`.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCE = process.argv[2] || path.join(__dirname, '..', '..', 'SWOGE.github.io', 'img', 'site', 'icone-512.png');

/** Un PNG 8 bits RGB ou RGBA, non entrelace : { l, h, rgb } (RGB, sans alpha). */
function decode(b) {
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, l = 0, h = 0, prof = 0, type = 0, entrelace = 0;
  const idat = [];
  while (o < b.length) {
    const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.slice(o + 8, o + 8 + n);
    if (t === 'IHDR') { l = d.readUInt32BE(0); h = d.readUInt32BE(4); prof = d[8]; type = d[9]; entrelace = d[12]; }
    if (t === 'IDAT') idat.push(d);
    if (t === 'IEND') break;
    o += 12 + n;
  }
  if (prof !== 8 || (type !== 2 && type !== 6) || entrelace) throw new Error('only 8-bit RGB/RGBA non-interlaced PNG');
  const bpp = type === 6 ? 4 : 3, ligne = l * bpp;
  const brut = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(ligne * h);
  for (let y = 0; y < h; y++) {
    const f = brut[y * (ligne + 1)], src = y * (ligne + 1) + 1, dst = y * ligne;
    for (let x = 0; x < ligne; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, up = y ? px[dst - ligne + x] : 0, c = (x >= bpp && y) ? px[dst - ligne + x - bpp] : 0;
      let v = brut[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c); }
      px[dst + x] = v & 255;
    }
  }
  const rgb = Buffer.alloc(l * h * 3);
  for (let i = 0; i < l * h; i++) { rgb[i * 3] = px[i * bpp]; rgb[i * 3 + 1] = px[i * bpp + 1]; rgb[i * 3 + 2] = px[i * bpp + 2]; }
  return { l, h, rgb };
}

/** Reduit de moitie : chaque pixel est la moyenne d un carre 2×2. */
function moitie(im) {
  const l = im.l >> 1, h = im.h >> 1, rgb = Buffer.alloc(l * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < l; x++) for (let k = 0; k < 3; k++) {
    const p = (yy, xx) => im.rgb[((2 * y + yy) * im.l + (2 * x + xx)) * 3 + k];
    rgb[(y * l + x) * 3 + k] = (p(0, 0) + p(0, 1) + p(1, 0) + p(1, 1) + 2) >> 2;
  }
  return { l, h, rgb };
}

if (require.main === module) {
  const v = moitie(decode(fs.readFileSync(SOURCE)));
  const sortie = path.join(__dirname, '..', 'visage_swoge.json');
  fs.writeFileSync(sortie, JSON.stringify({ source: 'img/site/icone-512.png, reduit de moitie', l: v.l, h: v.h, rgb: zlib.deflateSync(v.rgb, { level: 9 }).toString('base64') }));
  console.log('visage_swoge.json : ' + v.l + '×' + v.h + ', ' + fs.statSync(sortie).size + ' octets');
}

module.exports = { decode, moitie };
