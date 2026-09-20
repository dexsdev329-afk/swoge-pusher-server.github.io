'use strict';
/* ==========================================================================
 * DESSINER UNE IMAGE SANS UNE SEULE DEPENDANCE
 *
 * ---- POURQUOI CE FICHIER EXISTE ----
 *
 * Un lien partage sur X, Telegram ou Discord n affiche que ce que disent ses
 * balises `og:`. Le site est STATIQUE sur GitHub Pages et les robots ne
 * lisent pas le JavaScript : une carte dessinee dans la page ne sera jamais
 * vue par eux. Il faut donc une vraie image, servie par le serveur.
 *
 * Or ce depot a TROIS dependances — `ethers`, `ws`, `cannon-es` — et c est
 * une decision, pas un accident. `sharp`, `canvas`, `resvg` embarquent des
 * binaires natifs qu il faut recompiler a chaque changement de Node et qui
 * cassent un deploiement Railway un mardi soir sans prevenir.
 *
 * Alors on ecrit l image nous-memes. Un PNG, c est une signature, trois
 * blocs, et des lignes de pixels compressees par `zlib` — qui est DANS Node.
 * Il n y a rien a installer.
 *
 * ---- LE TEXTE, QUI EST LE VRAI TRAVAIL ----
 *
 * Dessiner un rectangle est trivial ; dessiner un « 4 » ne l est pas. Une
 * police bitmap tapee a la main serait laide a cote de la carte du navigateur.
 *
 * On prend donc les glyphes d une VRAIE police, rendus une fois pour toutes
 * par `outils/police.js` (Playwright, hors ligne, jamais en production) dans
 * un atlas d opacites. Le serveur ne fait que recopier ces opacites en les
 * teintant : la typographie est celle du site, et il n y a toujours rien a
 * installer.
 * ======================================================================== */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------- l image */

/** Une toile RGBA, en octets. Origine en haut a gauche, comme un canvas. */
function toile(l, h, fond) {
  const px = Buffer.alloc(l * h * 4);
  const t = { l, h, px };
  if (fond) rect(t, 0, 0, l, h, fond);
  return t;
}

/** `#rrggbb` → [r, g, b]. Une seule forme acceptee : on ne devine pas. */
function couleur(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(c));
  if (!m) throw new Error('couleur attendue en #rrggbb : ' + c);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rect(t, x, y, l, h, c) {
  const [r, g, b] = couleur(c);
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(t.l, Math.round(x + l)), y1 = Math.min(t.h, Math.round(y + h));
  for (let j = y0; j < y1; j++) {
    let o = (j * t.l + x0) * 4;
    for (let i = x0; i < x1; i++) { t.px[o] = r; t.px[o + 1] = g; t.px[o + 2] = b; t.px[o + 3] = 255; o += 4; }
  }
}

/** Un pixel pose par-dessus, selon son opacite. */
function pose(t, x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= t.l || y >= t.h) return;
  const o = (y * t.l + x) * 4;
  const A = a > 1 ? 1 : a;
  t.px[o] = Math.round(t.px[o] * (1 - A) + r * A);
  t.px[o + 1] = Math.round(t.px[o + 1] * (1 - A) + g * A);
  t.px[o + 2] = Math.round(t.px[o + 2] * (1 - A) + b * A);
  t.px[o + 3] = 255;
}

/* ------------------------------------------------------------ la police */

let POLICE = null;
function police() {
  if (POLICE) return POLICE;
  const f = path.join(__dirname, 'police_scan.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  /* L atlas est stocke deflate : il ne vit en memoire qu une fois. */
  const alpha = zlib.inflateSync(Buffer.from(j.atlas, 'base64'));
  POLICE = { taille: j.taille, l: j.l, h: j.h, glyphes: j.glyphes, alpha };
  return POLICE;
}

/** La largeur qu un texte occupera a cette taille. */
function largeur(texte, taille, gras) {
  const P = police();
  const k = taille / P.taille;
  let w = 0;
  for (const ch of String(texte)) {
    const g = P.glyphes[(gras ? 'b' : 'r') + ch] || P.glyphes[(gras ? 'b' : 'r') + ' '];
    if (g) w += g.av * k;
  }
  return w;
}

/**
 * Ecrit un texte. `y` est la LIGNE DE BASE, comme dans un canvas — sinon deux
 * tailles cote a cote ne s alignent pas et ca se voit tout de suite.
 * `al` vaut 'g' (gauche) ou 'd' (droite).
 */
function texte(t, s, x, y, taille, c, o) {
  const P = police();
  const [r, g, b] = couleur(c);
  const gras = !!(o && o.gras);
  const k = taille / P.taille;
  let px = (o && o.al === 'd') ? x - largeur(s, taille, gras) : x;
  for (const ch of String(s)) {
    const gl = P.glyphes[(gras ? 'b' : 'r') + ch];
    if (!gl) { px += largeur(' ', taille, gras); continue; }
    /* Echantillonnage bilineaire : l atlas est rendu grand, on le reduit.
       Au plus proche, les chiffres auraient des bords en escalier. */
    const dl = gl.w * k, dh = gl.h * k;
    const bx = px + gl.x * k, by = y + gl.y * k;
    for (let j = 0; j < Math.ceil(dh) + 1; j++) {
      for (let i = 0; i < Math.ceil(dl) + 1; i++) {
        const sx = i / k, sy = j / k;
        if (sx > gl.w || sy > gl.h) continue;
        const a = echantillon(P, gl, sx, sy);
        if (a > 0.004) pose(t, Math.round(bx + i), Math.round(by + j), r, g, b, a);
      }
    }
    px += gl.av * k;
  }
}

function echantillon(P, gl, sx, sy) {
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const a = (i, j) => {
    const X = gl.ax + Math.min(gl.w - 1, Math.max(0, i));
    const Y = gl.ay + Math.min(gl.h - 1, Math.max(0, j));
    return P.alpha[Y * P.l + X] / 255;
  };
  return a(x0, y0) * (1 - fx) * (1 - fy) + a(x0 + 1, y0) * fx * (1 - fy)
       + a(x0, y0 + 1) * (1 - fx) * fy + a(x0 + 1, y0 + 1) * fx * fy;
}

/* ------------------------------------------------------------ l encodage */

function bloc(type, donnees) {
  const l = Buffer.alloc(4); l.writeUInt32BE(donnees.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, donnees])) >>> 0, 0);
  return Buffer.concat([l, t, donnees, c]);
}
let TABLE = null;
function crc32(b) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); TABLE[i] = c; }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return c ^ -1;
}

/** La toile en PNG. Filtre 0 partout : `zlib` fait le travail, et c est lisible. */
function png(t) {
  const brut = Buffer.alloc((t.l * 4 + 1) * t.h);
  for (let j = 0; j < t.h; j++) {
    brut[j * (t.l * 4 + 1)] = 0;
    t.px.copy(brut, j * (t.l * 4 + 1) + 1, j * t.l * 4, (j + 1) * t.l * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(t.l, 0); ihdr.writeUInt32BE(t.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    bloc('IHDR', ihdr),
    bloc('IDAT', zlib.deflateSync(brut, { level: 9 })),
    bloc('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { toile, rect, texte, largeur, png, couleur, police };
