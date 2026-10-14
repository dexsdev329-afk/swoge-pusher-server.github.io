'use strict';
/* ==========================================================================
 * PLANCHES — DETOURAGE, REPERES, PLACEMENT DANS LA CASE, MESURES DE BASE
 *
 * Images RGBA en Uint8ClampedArray (largeur w, hauteur h). Un masque est un
 * Uint8Array de 0/1 (alpha > 128, comme qc_planche.py).
 *
 * Detourage par couleur cle avec demelange des bords : seuils 60/140 de
 * distance RGB, repris de notre chaine/finition.py (scratchpad autosprite,
 * relance le 12/10/2026 sur ninja/grille.mp4 : aucun pixel coupe, controles
 * identiques aux valeurs stockees).
 * ======================================================================== */

const CLES = { magenta: [255, 0, 255], vert: [0, 255, 0], bleu: [0, 0, 255] };
const ALPHA = 128;

/** Alpha selon la distance a la couleur cle ; les bords semi-transparents sont demelanges. */
function detoure(src, w, h, cle, t0, t1, opts) {
  t0 = t0 == null ? 60 : t0; t1 = t1 == null ? 140 : t1;
  const [kr, kg, kb] = cle, out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4, r = src[o], g = src[o + 1], b = src[o + 2];
    const d = Math.sqrt((r - kr) * (r - kr) + (g - kg) * (g - kg) + (b - kb) * (b - kb));
    const a = Math.min(1, Math.max(0, (d - t0) / (t1 - t0)));
    if (a <= 0.02) continue;
    out[o] = (r - (1 - a) * kr) / a; out[o + 1] = (g - (1 - a) * kg) / a; out[o + 2] = (b - (1 - a) * kb) / a;
    out[o + 3] = a * 255;
  }
  /* Debordement de la cle (« spill ») : la video 4:2:0 etale la couleur de la cle
     sur ~2 px autour de la figure, qui reste opaque mais rosie (mannequin H.264 :
     4,1 % des pixels dans la case rose (3,2,3) de l'histogramme, 0,2 % dans la
     pose PNG, mesure du 12/10/2026). Sur une bande de 2 px au bord seulement (une
     robe violette au milieu du corps garde sa couleur), on retire la composante
     de chrominance dans la direction de la cle — la luminance ne bouge pas. */
  const m = (kr + kg + kb) / 3, ux0 = kr - m, uy0 = kg - m, uz0 = kb - m, un = Math.hypot(ux0, uy0, uz0) || 1;
  const ux = ux0 / un, uy = uy0 / un, uz = uz0 / un;
  const transp = (x, y) => x < 0 || y < 0 || x >= w || y >= h || out[(y * w + x) * 4 + 3] < 128;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (out[o + 3] === 0) continue;
    let bord = false;
    for (let dy = -2; dy <= 2 && !bord; dy++) for (let dx = -2; dx <= 2 && !bord; dx++) bord = transp(x + dx, y + dy);
    if (!bord) continue;
    const r = out[o], g = out[o + 1], b = out[o + 2], gm = (r + g + b) / 3;
    const p = (r - gm) * ux + (g - gm) * uy + (b - gm) * uz;
    if (p > 0) { out[o] = r - p * ux; out[o + 1] = g - p * uy; out[o + 2] = b - p * uz; }
  }
  if (opts && opts.chroma === false) return out;
  /* La chrominance du bord, reprise de l'INTERIEUR. En 4:2:0 la couleur n'existe qu'un
     pixel sur deux : au bord, elle melange la figure et la cle, et le demelange en fait
     une fausse couleur (liseré orange autour du rouge, cyan autour du bleu). Revue du
     13/10/2026 : 44 % des pixels opaques du bord a plus de 40 de toute couleur du
     mannequin, contre 2,8 % sans video. La LUMINANCE (pleine resolution en 4:2:0) reste
     celle du pixel ; Cb et Cr deviennent la moyenne de l'interieur voisin (pixels opaques
     a plus de 2 px du transparent, fenetre de 7 x 7). Une partie trop fine pour avoir un
     interieur (moins de 5 px) garde sa couleur. */
  const loin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (out[(y * w + x) * 4 + 3] < 128) continue;
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) ok = !transp(x + dx, y + dy);
    if (ok) loin[y * w + x] = 1;
  }
  const Y = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const maj = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    if (out[o + 3] === 0 || loin[i]) continue;
    let cb = 0, cr = 0, yi = 0, k = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || !loin[yy * w + xx]) continue;
      const q = (yy * w + xx) * 4, yq = Y(out[q], out[q + 1], out[q + 2]);
      cb += out[q + 2] - yq; cr += out[q] - yq; yi += yq; k++;
    }
    if (!k) continue;
    cb /= k; cr /= k; yi /= k;
    /* un pixel du liseré semi-transparent (alpha < 230) n'a qu'une couleur ESTIMEE (le
       demelange part d'un alpha lu sur une couleur deja melangee) : il prend aussi la
       luminance de l'interieur. Un pixel opaque garde la sienne (un contour dessine reste). */
    const y0 = out[o + 3] < 230 ? yi : Y(out[o], out[o + 1], out[o + 2]);
    /* R = Y + Cr', B = Y + Cb', G tire de Y = 0,299 R + 0,587 G + 0,114 B */
    const R = y0 + cr, B = y0 + cb, G = (y0 - 0.299 * R - 0.114 * B) / 0.587;
    maj.push([o, R, G, B]);
  }
  for (const [o, R, G, B] of maj) { out[o] = R; out[o + 1] = G; out[o + 2] = B; }
  return out;
}

/* La teinte de la cle restee DANS la figure, guidee par la palette de la pose. Le flou
   de mouvement d'un saut melange la figure et le fond sur plusieurs pixels : ces
   pixels passent opaques mais roses, loin du bord (le debordement ci-dessus ne
   traite que 2 px). Pirate, lot ce307577 du 14/10/2026, saut : residus 0,052-0,114
   et franges 0,206-0,296 (seuils 0,03 et 0,15) ; la piratesse 0,086-0,107 et
   0,295-0,388. Un pixel dont la couleur est DANS la palette de la pose ne bouge pas
   (la chemise rouge du pirate tire aussi vers le magenta) ; un autre perd la
   composante de chrominance dans la direction de la cle, par quarts, jusqu'a tomber
   dans la palette — la luminance ne bouge pas. Meme chose
   dans l'autre sens (teinte verte laissee par un demelange trop fort).
   `pal` pour l'interieur, `palBord` (l'interieur des poses) pour le bord a 1 px. */
function nettoieCle(d, w, h, cle, pal, palBord) {
  if (!pal) return 0;
  const [kr, kg, kb] = cle, m0 = (kr + kg + kb) / 3, un = Math.hypot(kr - m0, kg - m0, kb - m0) || 1;
  const ux = (kr - m0) / un, uy = (kg - m0) / un, uz = (kb - m0) / un;
  const cas = (r, g, b) => (Math.max(0, Math.min(255, Math.round(r))) >> 4) * 256 + (Math.max(0, Math.min(255, Math.round(g))) >> 4) * 16 + (Math.max(0, Math.min(255, Math.round(b))) >> 4);
  const transp = (x, y) => x < 0 || y < 0 || x >= w || y >= h || d[(y * w + x) * 4 + 3] <= ALPHA;
  let nb = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (d[o + 3] <= ALPHA) continue;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const bord = transp(x - 1, y) || transp(x + 1, y) || transp(x, y - 1) || transp(x, y + 1);
    const P = bord && palBord ? palBord : pal;
    if (P[cas(r, g, b)]) continue;
    const gm = (r + g + b) / 3, p = (r - gm) * ux + (g - gm) * uy + (b - gm) * uz;
    /* p < 0 : le demelange du bord a retire TROP de cle (alpha lu sur une couleur deja
       floue) et le pixel tire vers le vert, l'anti-magenta — meme traitement, en rendant */
    if (Math.abs(p) <= 8) continue;
    /* seulement si un pas TOMBE dans la palette : un pixel que rien ne ramene a une
       couleur de la pose garde la sienne (le baton fin du mannequin synthetique,
       planches_chaine.test.js : franges de course 0,111 sans nettoyage, 0,151 quand
       tout pixel hors palette perdait toute sa composante — le reechantillonnage
       melangeait ces gris aux voisins) */
    let q = null;
    for (const f of [0.25, 0.5, 0.75, 1]) { if (P[cas(r - f * p * ux, g - f * p * uy, b - f * p * uz)]) { q = f * p; break; } }
    if (q == null) continue;
    d[o] = r - q * ux; d[o + 1] = g - q * uy; d[o + 2] = b - q * uz;
    nb++;
  }
  return nb;
}

/** La cle la plus loin du personnage : part des pixels opaques a moins de 140 de chaque cle. */
function choisitCle(img) {
  const parts = {};
  for (const [nom, k] of Object.entries(CLES)) {
    let n = 0, pres = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const o = i * 4;
      if (img.data[o + 3] <= ALPHA) continue;
      n++;
      const d = Math.hypot(img.data[o] - k[0], img.data[o + 1] - k[1], img.data[o + 2] - k[2]);
      if (d < 140) pres++;
    }
    parts[nom] = n ? pres / n : 1;
  }
  const nom = Object.keys(parts).sort((a, b) => parts[a] - parts[b])[0];
  return { nom, cle: CLES[nom], parts };
}

function masque(d, w, h) { const m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3] > ALPHA ? 1 : 0; return m; }

function bbox(m, w, h) {
  let y0 = h, y1 = -1, x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return y1 < 0 ? null : { y0, y1, x0, x1, h: y1 - y0 + 1, w: x1 - x0 + 1 };
}

/* Le centre du torse : x moyen des pixels opaques entre 15 et 60 % de la hauteur
   (une arme qui balance ne deplace pas le corps — finition.py:93-97). */
function torse(m, w, h, b) {
  b = b || bbox(m, w, h); if (!b) return null;
  let s = 0, n = 0;
  for (let y = Math.floor(b.y0 + 0.15 * b.h); y <= Math.floor(b.y0 + 0.6 * b.h); y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { s += x; n++; }
  return n ? s / n : (b.x0 + b.x1) / 2;
}

/** Les reperes d'une figure : haut, pieds, torse, hauteur (pixels de l'image donnee). */
function reperes(d, w, h) {
  const m = masque(d, w, h), b = bbox(m, w, h);
  if (!b) return null;
  return { haut: b.y0, pied: b.y1 + 1, tx: torse(m, w, h, b), h: b.h, x0: b.x0, x1: b.x1 + 1 };
}

/* ---- Placement : une image source -> la case C x C, par une echelle k et
   une ancre (ax, ay) de la source posee en (C/2, sol*C). Filtre triangle dont
   le support grandit avec la reduction (pas de crenelage quand on divise par 3).
   Alpha premultiplie : pas de franges sombres. */
function poids(nOut, k, ancreSrc, ancreOut, nSrc) {
  const r = Math.max(1, 1 / k), L = [];
  for (let u = 0; u < nOut; u++) {
    const x = ancreSrc + (u + 0.5 - ancreOut) / k;
    const i0 = Math.max(0, Math.floor(x - r - 0.5)), i1 = Math.min(nSrc - 1, Math.ceil(x + r - 0.5));
    const ws = []; let s = 0;
    for (let i = i0; i <= i1; i++) { const p = Math.max(0, 1 - Math.abs(i + 0.5 - x) / r); ws.push(p); s += p; }
    L.push({ i0, ws: s > 0 ? ws.map((p) => p / s) : ws, plein: s > 0 && x >= -0.5 && x <= nSrc + 0.5 });
  }
  return L;
}

function place(src, sw, sh, k, ax, ay, C, sol) {
  const out = new Uint8ClampedArray(C * C * 4);
  const PX = poids(C, k, ax, C / 2, sw), PY = poids(C, k, ay, sol * C, sh);
  const H = new Float32Array(sh * C * 4);   /* passe horizontale, premultipliee */
  let ymin = sh, ymax = -1;
  for (const p of PY) if (p.ws.length) { ymin = Math.min(ymin, p.i0); ymax = Math.max(ymax, p.i0 + p.ws.length - 1); }
  for (let y = Math.max(0, ymin); y <= Math.min(sh - 1, ymax); y++) {
    for (let u = 0; u < C; u++) {
      const p = PX[u]; if (!p.plein) continue;
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < p.ws.length; j++) {
        const o = (y * sw + p.i0 + j) * 4, wa = p.ws[j] * src[o + 3];
        r += wa * src[o]; g += wa * src[o + 1]; b += wa * src[o + 2]; a += wa;
      }
      const q = (y * C + u) * 4; H[q] = r; H[q + 1] = g; H[q + 2] = b; H[q + 3] = a;
    }
  }
  for (let v = 0; v < C; v++) {
    const p = PY[v]; if (!p.plein) continue;
    for (let u = 0; u < C; u++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < p.ws.length; j++) {
        const q = ((p.i0 + j) * C + u) * 4, wj = p.ws[j];
        r += wj * H[q]; g += wj * H[q + 1]; b += wj * H[q + 2]; a += wj * H[q + 3];
      }
      if (a < 0.5) continue;
      const o = (v * C + u) * 4;
      out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a;
    }
  }
  /* ce qui tombe hors de la case est compte (F4 : aucun pixel coupe) */
  let coupes = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (src[(y * sw + x) * 4 + 3] <= ALPHA) continue;
    const u = (x + 0.5 - ax) * k + C / 2, v = (y + 0.5 - ay) * k + sol * C;
    if (u < 0 || u >= C || v < 0 || v >= C) coupes++;
  }
  return { data: out, coupes: Math.round(coupes * k * k) };
}

/** Miroir horizontal d'une image RGBA C x C. */
function miroir(d, w, h) {
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (y * w + x) * 4, b = (y * w + (w - 1 - x)) * 4;
    o[a] = d[b]; o[a + 1] = d[b + 1]; o[a + 2] = d[b + 2]; o[a + 3] = d[b + 3];
  }
  return o;
}

/** Reduction par 2 (moyenne), pour les recherches rapides (foulee, mouvement). */
function moitie(d, w, h) {
  const W = w >> 1, H = h >> 1, o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const i = ((2 * y + dy) * w + 2 * x + dx) * 4, aa = d[i + 3];
      r += d[i] * aa; g += d[i + 1] * aa; b += d[i + 2] * aa; a += aa;
    }
    const q = (y * W + x) * 4;
    if (a > 0) { o[q] = r / a; o[q + 1] = g / a; o[q + 2] = b / a; o[q + 3] = a / 4; }
  }
  return o;
}

/* Ecart entre deux images (finition.py:ecart_rgb) : couleur moyenne sur
   l'union des masques + 255 x part de pixels ou un seul des deux est opaque. */
function ecart(f, g, n) {
  let u = 0, x = 0, s = 0;
  for (let i = 0; i < n; i++) {
    const a = f[i * 4 + 3] > ALPHA, b = g[i * 4 + 3] > ALPHA;
    if (!a && !b) continue;
    u++;
    if (a !== b) x++;
    s += Math.abs(f[i * 4] - g[i * 4]) + Math.abs(f[i * 4 + 1] - g[i * 4 + 1]) + Math.abs(f[i * 4 + 2] - g[i * 4 + 2]);
  }
  return u ? s / (3 * u) + 255 * x / u : 0;
}

function xor(a, b, i0, i1) { let u = 0, x = 0; for (let i = i0 || 0, n = i1 == null ? a.length : i1; i < n; i++) { if (a[i] | b[i]) { u++; if (a[i] !== b[i]) x++; } } return u ? x / u : 0; }
function iou(a, b) { let u = 0, k = 0; for (let i = 0; i < a.length; i++) { if (a[i] | b[i]) { u++; if (a[i] & b[i]) k++; } } return u ? k / u : 0; }

module.exports = { CLES, ALPHA, detoure, nettoieCle, choisitCle, masque, bbox, torse, reperes, place, miroir, moitie, ecart, xor, iou };
