'use strict';
/* ==========================================================================
 * PLANCHES — LE MANNEQUIN ISO (le guide de poses, a nous)
 *
 * Port en Node de guide_iso.py (scratchpad poses_dabord, ecrit pour le plan
 * du 12/10/2026) : un mannequin 3D en batons, projete en vue isometrique
 * (camera a 30 deg, losange 2:1), qui fixe pour chaque image la pose, la
 * taille, la ligne du sol et la VRAIE direction (une rotation, jamais un
 * miroir). Le membre DROIT est clair (224), le gauche plus sombre (150),
 * l'arme orange dans la main droite : le cote de l'arme se lit a l'image.
 * Mesures du 12/10/2026 qui ont fixe ces gris : 120/200 tombaient a 8 niveaux
 * d'une frontiere de l'histogramme de couleur (64 cases de 64 niveaux) et le
 * bruit H.264 les faisait changer de case ; 90/210 opposaient deux cases dont
 * la part bascule quand un membre passe derriere le torse (couleur 0,09-0,15
 * en course, contre 0,021-0,039 pour nos planches peintes). 224 et 150 sont
 * au milieu de leur case et le membre sombre partage celle du torse.
 * Membres epais : un mannequin en fils n'a que des bords, pas un corps.
 *
 * Trois usages :
 *   1. toilePoses() : les 4 vues de repos SE, SW, NW, NE (2048 x 1024,
 *      transparent), jointe a l'appel d'images OpenAI pour imposer la
 *      geometrie des directions (poses.js) ;
 *   2. clipFaux() : de faux clips a 24 i/s, sur fond de couleur cle, qui
 *      traversent toute la chaine dans les essais — a la place des sorties
 *      CC0 d'AutoSprite (relevé du 12/10 : on ne reprend RIEN de chez eux) ;
 *      chaque defaut des controles s'y fabrique sur demande ;
 *   3. reference() : les chiffres attendus (cote de l'arme, foulee).
 *
 * Rien ici n'appelle un fournisseur. Gratuit, deterministe.
 * ======================================================================== */

const ELEV = Math.PI / 6;              /* 30 deg : pente du losange 0,5 (2:1) */
const DIRS = { se: [1, 1], sw: [-1, 1], nw: [-1, -1], ne: [1, -1] };   /* (x est, z sud) ; le sud vient vers nous */
const ACTIONS = ['idle', 'walk', 'run', 'jump', 'attack'];
const HAUT_CORPS = 0.87;               /* hauteur projetee du mannequin (unites), du bas des pieds au haut du crane */

/* La pose de repos : TOUTES les actions partent d'elle et y reviennent (comme
   un clip epingle, image = last_frame). */
const REPOS = { pieds: { D: [0.03, 0.09, 0.04], G: [-0.03, -0.09, 0.04] }, bras: { D: [14, 0.2, 35], G: [8, 0.2, 15] },
                bassin: 0.493, tw: 0, yo: 0, pench: 0 };

const lerp = (a, b, t) => a + (b - a) * t;
const lisse = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
function melange(A, B, t) {
  const m = (x, y) => x.map((v, i) => lerp(v, y[i], t));
  return { pieds: { D: m(A.pieds.D, B.pieds.D), G: m(A.pieds.G, B.pieds.G) }, bras: { D: m(A.bras.D, B.bras.D), G: m(A.bras.G, B.bras.G) },
           bassin: lerp(A.bassin, B.bassin, t), tw: lerp(A.tw, B.tw, t), yo: lerp(A.yo, B.yo, t), pench: lerp(A.pench, B.pench, t) };
}

/* Un cycle de marche ou de course a la phase ph (0..1), foulee L. */
function cycle(ph, L, levee, appui, bras, rebond, pench) {
  const pied = (p) => {
    p = ((p % 1) + 1) % 1;
    if (p < appui) return [L / 2 - (p / appui) * L, 0.04];
    const s = (p - appui) / (1 - appui);
    return [-L / 2 + L * (0.5 - 0.5 * Math.cos(Math.PI * s)), 0.04 + levee * Math.sin(Math.PI * s)];
  };
  const [aD, yD] = pied(ph), [aG, yG] = pied(ph + 0.5);
  return { pieds: { D: [aD, 0.075, yD], G: [aG, -0.075, yG] },
           bras: { D: [-bras * aD / (L / 2) + 10, 0.15, 25], G: [-bras * aG / (L / 2) + 10, 0.15, 25] },
           bassin: 0.50 - rebond * Math.cos(4 * Math.PI * ph), tw: 6 * Math.sin(2 * Math.PI * ph), yo: 0, pench };
}

/* L'attaque au corps a corps, main droite : prepare, arme, frappe, impact, tient, revient. */
const ATTAQUE = [[14, 35, 0, 0, 0.493], [-35, 60, -12, 0, 0.48], [-70, 110, -22, 0.02, 0.47], [100, 10, 18, 0.09, 0.455],
                 [60, 5, 25, 0.1, 0.45], [55, 10, 22, 0.09, 0.455], [30, 25, 10, 0.05, 0.475], [14, 35, 0, 0, 0.493]];
function attaque(ph) {
  const x = Math.max(0, Math.min(0.9999, ph)) * (ATTAQUE.length - 1), i = Math.floor(x), t = lisse(x - i);
  const k = ATTAQUE[i].map((v, j) => lerp(v, ATTAQUE[i + 1][j], t));
  const [e, c, tw, av, bassin] = k;
  return { pieds: { D: [0.03 + av, 0.09, 0.04], G: [-0.03 - av * 0.3, -0.09, 0.04] },
           bras: { D: [e < 0 ? 180 + e : e, 0.25, c], G: [10, 0.25, 15] }, bassin, tw, yo: 0, pench: av * 0.3 };
}

/* Le saut : accroupi, envol (tout le corps monte), reception, retour. */
function saut(ph) {
  const p = Object.assign({}, REPOS, { pieds: { D: REPOS.pieds.D.slice(), G: REPOS.pieds.G.slice() }, bras: { D: REPOS.bras.D.slice(), G: REPOS.bras.G.slice() } });
  const accroupi = ph < 0.2 ? lisse(ph / 0.2) : ph < 0.3 ? 1 - lisse((ph - 0.2) / 0.1) : ph < 0.7 ? 0 : ph < 0.8 ? lisse((ph - 0.7) / 0.1) : 1 - lisse((ph - 0.8) / 0.2);
  p.bassin = 0.493 - 0.07 * accroupi;
  if (ph > 0.25 && ph < 0.75) {
    const s = (ph - 0.25) / 0.5;
    p.yo = 0.22 * Math.sin(Math.PI * s);
    p.pieds.D[2] = 0.04 + 0.05 * Math.sin(Math.PI * s); p.pieds.G[2] = 0.04 + 0.05 * Math.sin(Math.PI * s);
    p.bras.D = [lerp(14, 95, Math.sin(Math.PI * s)), 0.3, 20]; p.bras.G = [lerp(8, 95, Math.sin(Math.PI * s)), 0.3, 20];
  }
  p.pench = 0.04 * accroupi;
  return p;
}

/** Les parametres de pose d'une action au temps t (s) d'un clip de duree D. */
function poseAu(action, t, D, opts) {
  opts = opts || {};
  if (action === 'idle') {
    const s = Math.sin(2 * Math.PI * t / D);
    return Object.assign({}, REPOS, { bassin: 0.493 + 0.009 * s, tw: 2.5 * s,
      bras: { D: [14 + 6 * s, 0.2, 35 + 4 * s], G: [8 - 5 * s, 0.2, 15] } });
  }
  if (action === 'walk' || action === 'run') {
    const course = action === 'run';
    const P = opts.periode || (course ? 0.66 : 1.0), L0 = opts.foulee || (course ? 0.45 : 0.30);
    const rampe = 0.35, env = opts.sansRampe ? 1 : Math.min(lisse(t / rampe), lisse((D - t) / rampe));
    /* defaut « boucle » : la foulee et la direction derivent, aucune periode ne se referme */
    const L = opts.derive ? L0 * (0.4 + 1.2 * t / D) : L0;
    const c = cycle(t / P, L, course ? 0.15 : 0.07, course ? 0.4 : 0.5, course ? 45 : 28, course ? 0.03 : 0.015, course ? 0.06 : 0);
    if (opts.jambesFigees) { c.pieds = { D: REPOS.pieds.D.slice(), G: REPOS.pieds.G.slice() }; }
    return melange(REPOS, c, env);
  }
  if (action === 'attack') {
    const a = 0.3, b = D - 0.4;
    return attaque((t - a) / (b - a));
  }
  if (action === 'jump') {
    const a = 0.2, b = D - 0.3;
    return t < a || t > b ? REPOS : saut((t - a) / (b - a));
  }
  return REPOS;
}

/* ---- geometrie 3D ---- */
const v3 = (x, y, z) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norme = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norme(a) || 1; return mul(a, 1 / n); };

function ik(h, c, l1, l2, avant) {
  const d = sub(c, h); let L = norme(d); L = Math.min(L, l1 + l2 - 1e-4);
  const u = unit(d), a = (l1 * l1 + L * L - l2 * l2) / (2 * L), hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let perp = sub(avant, mul(u, dot(avant, u))); perp = unit(perp);
  return add(add(h, mul(u, a)), mul(perp, hh));
}

function bras3(ep, f, r, elevDeg, ecart, coudeDeg) {
  const up = [0, 1, 0], a = elevDeg * Math.PI / 180, b = (elevDeg + coudeDeg) * Math.PI / 180;
  const d1 = unit(add(add(mul(f, Math.sin(a)), mul(up, -Math.cos(a))), mul(r, ecart)));
  const d2 = unit(add(add(mul(f, Math.sin(b)), mul(up, -Math.cos(b))), mul(r, ecart * 0.5)));
  const coude = add(ep, mul(d1, 0.16)), main = add(coude, mul(d2, 0.15));
  return { coude, main, d2 };
}

/** Les segments 3D d'une pose, face a f2 (x, z) tourne de lacet degres. */
function squelette(p, f2, lacet, arme) {
  let f = unit([f2[0], 0, f2[1]]);
  if (lacet) { const c = Math.cos(lacet * Math.PI / 180), s = Math.sin(lacet * Math.PI / 180); f = [f[0] * c - f[2] * s, 0, f[0] * s + f[2] * c]; }
  const r = [-f[2], 0, f[0]], up = [0, 1, 0];
  const P = (a, b, y) => add(add(mul(f, a), mul(r, b)), mul(up, y + p.yo));
  const t = p.tw * Math.PI / 180, fb = unit(add(mul(f, Math.cos(t)), mul(r, Math.sin(t)))), rb = [-fb[2], 0, fb[0]];
  const hD = P(0, 0.085, p.bassin), hG = P(0, -0.085, p.bassin);
  const avant = mul(fb, p.pench || 0);
  const eD = add(add(P(0, 0, 0.80), mul(rb, 0.14)), avant), eG = add(add(P(0, 0, 0.80), mul(rb, -0.14)), avant);
  const tete = add(P(0.01, 0, 0.905), avant);
  const seg = [], J = { tete };
  for (const cote of ['D', 'G']) {
    const [a, b, y] = p.pieds[cote], h = cote === 'D' ? hD : hG;
    const ch = P(a, b, y), g = ik(h, ch, 0.235, 0.235, f), orteil = add(add(ch, mul(f, 0.09)), [0, -0.03, 0]);
    seg.push([h, g, 0.10, 'jambe', cote], [g, ch, 0.085, 'jambe', cote], [ch, orteil, 0.07, 'pied', cote]);
    J['cheville' + cote] = ch;
  }
  for (const cote of ['D', 'G']) {
    const [e, ec, c] = p.bras[cote], ep = cote === 'D' ? eD : eG, rr = cote === 'D' ? rb : mul(rb, -1);
    const B = bras3(ep, fb, rr, e, ec, c);
    seg.push([ep, B.coude, 0.075, 'bras', cote], [B.coude, B.main, 0.065, 'bras', cote]);
    J['main' + cote] = B.main;
    if (cote === 'D' && arme !== false) { const pointe = add(B.main, mul(B.d2, 0.24)); seg.push([B.main, pointe, 0.04, 'arme', 'D']); J.pointe = pointe; }
  }
  return { seg, tronc: [hD, hG, eG, eD], J };
}

const proj = (p, ox, oy, s) => [ox + s * p[0], oy + s * (p[2] * Math.sin(ELEV) - p[1] * Math.cos(ELEV))];
const prof = (p) => p[1] * Math.sin(ELEV) + p[2] * Math.cos(ELEV);

/* ---- trace anti-crenele dans une image RGBA (couverture par distance signee) ---- */
function melangePx(d, w, h, x, y, cov, c) {
  if (cov <= 0 || x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4, a = Math.min(1, cov) * (c[3] == null ? 1 : c[3] / 255), da = d[o + 3] / 255, na = a + da * (1 - a);
  if (na <= 0) return;
  for (let k = 0; k < 3; k++) d[o + k] = (c[k] * a + d[o + k] * da * (1 - a)) / na;
  d[o + 3] = na * 255;
}
function capsule(d, w, h, A, B, rad, c) {
  const x0 = Math.floor(Math.min(A[0], B[0]) - rad - 1), x1 = Math.ceil(Math.max(A[0], B[0]) + rad + 1);
  const y0 = Math.floor(Math.min(A[1], B[1]) - rad - 1), y1 = Math.ceil(Math.max(A[1], B[1]) + rad + 1);
  const vx = B[0] - A[0], vy = B[1] - A[1], L2 = vx * vx + vy * vy || 1e-9;
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
    const px = x + 0.5 - A[0], py = y + 0.5 - A[1], t = Math.max(0, Math.min(1, (px * vx + py * vy) / L2));
    const dd = Math.hypot(px - t * vx, py - t * vy) - rad;
    melangePx(d, w, h, x, y, Math.max(0, Math.min(1, 0.5 - dd)), c);
  }
}
function ellipse(d, w, h, cx, cy, rx, ry, c) {
  for (let y = Math.max(0, Math.floor(cy - ry - 1)); y <= Math.min(h - 1, Math.ceil(cy + ry + 1)); y++)
    for (let x = Math.max(0, Math.floor(cx - rx - 1)); x <= Math.min(w - 1, Math.ceil(cx + rx + 1)); x++) {
      const qx = (x + 0.5 - cx) / rx, qy = (y + 0.5 - cy) / ry, dd = (Math.hypot(qx, qy) - 1) * Math.min(rx, ry);
      melangePx(d, w, h, x, y, Math.max(0, Math.min(1, 0.5 - dd)), c);
    }
}
function enveloppe(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function polygone(d, w, h, P, c) {
  const E = enveloppe(P); if (E.length < 3) return;
  const xs = E.map((q) => q[0]), ys = E.map((q) => q[1]);
  /* sens de parcours : l'aire signee dit de quel cote est l'interieur */
  let aire = 0; for (let i = 0; i < E.length; i++) { const a = E[i], b = E[(i + 1) % E.length]; aire += a[0] * b[1] - b[0] * a[1]; }
  const sg = aire > 0 ? 1 : -1;
  for (let y = Math.max(0, Math.floor(Math.min(...ys) - 1)); y <= Math.min(h - 1, Math.ceil(Math.max(...ys) + 1)); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs) - 1)); x <= Math.min(w - 1, Math.ceil(Math.max(...xs) + 1)); x++) {
      let dd = -Infinity;
      for (let i = 0; i < E.length; i++) {
        const a = E[i], b = E[(i + 1) % E.length], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
        dd = Math.max(dd, sg * ((x + 0.5 - a[0]) * ey - (y + 0.5 - a[1]) * ex) / L);
      }
      melangePx(d, w, h, x, y, Math.max(0, Math.min(1, 0.5 - dd)), c);
    }
}

/** Dessine une pose dans d (w x h), pieds en (ox, oy), s pixels par unite. */
/* Deux habits. « guide » : gris, membre DROIT clair et gauche sombre, arme orange
   — la toile jointe a l'appel d'images, ou seul le cote compte. « perso » : un
   personnage colore pour les faux clips. Mesure du 12/10/2026 : en gris, trois
   cases d'histogramme seulement, et la part du membre clair bascule de 0,17 a
   0,29 quand il passe derriere le torse — `couleur` montait a 0,13 en course,
   la ou nos planches peintes font 0,021-0,039. Le perso garde un droit et un
   gauche DIFFERENTS (34 niveaux d'ecart moyen, au-dessus des 24 de concorde())
   mais dans la MEME case de 64 niveaux : un membre cache ne change pas sa palette. */
const PALETTES = {
  guide: { jambe: { D: [224, 224, 224], G: [150, 150, 150] }, pied: { D: [224, 224, 224], G: [150, 150, 150] },
           bras: { D: [224, 224, 224], G: [150, 150, 150] }, arme: { D: [215, 96, 32] }, tronc: [170, 170, 170], tete: [180, 180, 180] },
  perso: { jambe: { D: [40, 100, 250], G: [10, 70, 200] }, pied: { D: [120, 90, 50], G: [80, 70, 20] },
           bras: { D: [235, 60, 50], G: [200, 20, 10] }, arme: { D: [215, 96, 32] }, tronc: [200, 50, 40], tete: [230, 180, 140] },
};

function dessine(d, w, h, pose, dir, ox, oy, s, opts) {
  opts = opts || {};
  const pal = PALETTES[opts.palette || 'guide'];
  const { seg, tronc, J } = squelette(pose, DIRS[dir], opts.lacet || 0, opts.arme);
  const items = seg.map((q) => [prof(mul(add(q[0], q[1]), 0.5)), 'seg', q]);
  items.push([prof(mul(tronc.reduce((a, b) => add(a, b), [0, 0, 0]), 0.25)) - 0.02, 'tronc', tronc]);
  items.push([prof(J.tete) + 0.01, 'tete', J.tete]);
  items.sort((a, b) => a[0] - b[0]);
  if (opts.ombre) ellipse(d, w, h, ox, oy + 0.01 * s, 0.34 * s, 0.11 * s, [60, 40, 25, 255]);
  for (const [, k, v] of items) {
    if (k === 'seg') {
      const col = pal[v[3]][v[4]] || pal[v[3]].D;
      capsule(d, w, h, proj(v[0], ox, oy, s), proj(v[1], ox, oy, s), Math.max(1, v[2] * s / 2), col);
    } else if (k === 'tronc') polygone(d, w, h, v.map((p) => proj(p, ox, oy, s)), pal.tronc);
    else { const p = proj(v, ox, oy, s), rr = 0.085 * s; ellipse(d, w, h, p[0], p[1], rr, rr * 1.1, pal.tete); }
  }
  const P = {};
  for (const [nom, p] of Object.entries(J)) P[nom] = proj(p, ox, oy, s);
  P.tronc = [tronc.map((p) => proj(p, ox, oy, s)[0]).reduce((a, b) => a + b, 0) / 4];
  return P;
}

/* La disposition d'une bande 5:2 : 4 emplacements cote a cote, pieds a 85 % de
   la hauteur, corps de 0,40 x la hauteur. Le plan disait 0,6 (480 px sur 800) ;
   mesure du 12/10/2026 sur ce mannequin (5 actions x 4 directions, 24 i/s,
   toutes les images) : la pointe de l'arme s'ecarte du torse de 0,74 u en
   attaque (0,85 hauteur de corps), et un emplacement de bande ne fait que
   0,625 x sa hauteur de large. A 0,6, l'arme sortait de l'emplacement en NE
   (vu a l'image). A 0,40, la demi-largeur tient 0,64 u. PROVISOIRE : a
   remesurer sur les vrais clips (sonde #5 du plan). */
const DISPO = { pieds: 0.85, corps: 0.40 };
function emplacements(w, h, dirs) {
  const n = dirs.length, lw = w / n;
  return dirs.map((dir, i) => ({ dir, x: i * lw, w: lw, ox: (i + 0.5) * lw, oy: DISPO.pieds * h, s: DISPO.corps * h / HAUT_CORPS }));
}

function fond(w, h, c) { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; } return d; }

/** La pose de repos dans la disposition de la chaine (ce qu'on enverrait a xAI). */
function bandePose(w, h, dirs, cle) {
  dirs = dirs || Object.keys(DIRS);
  const d = fond(w, h, cle || [255, 0, 255]);
  for (const e of emplacements(w, h, dirs)) dessine(d, w, h, REPOS, e.dir, e.ox, e.oy, e.s, { palette: 'perso' });
  return { w, h, data: d };
}

/**
 * Un faux clip : images RGBA (opaques, fond cle) d'une action pour 4 figures.
 * defauts (un essai par controle) :
 *   miroir: true      -> SW est le MIROIR de SE, decale en phase (piege F6)
 *   echelle: {nw:1.3} -> une direction plus grande que sa pose (taille entre directions)
 *   jambesFigees      -> les pieds ne bougent pas pendant la marche (jambes)
 *   ombre             -> une ombre opaque collee sous les pieds (sol)
 *   derive            -> foulee et direction qui derivent : aucune boucle (boucle)
 *   glisse            -> la figure traverse son emplacement (glisse)
 */
function clipFaux({ action, w, h, fps, duree, dirs, cle, defauts }) {
  dirs = dirs || Object.keys(DIRS); defauts = defauts || {};
  const n = Math.round(duree * fps), E = emplacements(w, h, dirs), F = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps, d = fond(w, h, cle || [255, 0, 255]);
    for (const e of E) {
      let te = t, dirDessin = e.dir, mir = false;
      if (defauts.miroir && e.dir === 'sw') { dirDessin = 'se'; mir = true; te = t + 5 / fps; }
      const pose = poseAu(action, Math.min(te, duree), duree, { derive: !!defauts.derive, jambesFigees: !!defauts.jambesFigees });
      const k = defauts.echelle && defauts.echelle[e.dir] ? defauts.echelle[e.dir] : 1;
      const dx = defauts.glisse ? (t / duree - 0.5) * 0.45 * e.w : 0;
      const lacet = defauts.derive ? 40 * t / duree : 0;
      if (!mir) { dessine(d, w, h, pose, dirDessin, e.ox + dx, e.oy, e.s * k, { ombre: !!defauts.ombre, lacet, palette: 'perso' }); continue; }
      /* le miroir : la figure SE dessinee a part, retournee dans l'emplacement SW */
      const tmp = fond(Math.ceil(e.w), h, [0, 0, 0]); for (let q = 3; q < tmp.length; q += 4) tmp[q] = 0;
      dessine(tmp, Math.ceil(e.w), h, pose, dirDessin, e.w / 2, e.oy, e.s * k, { lacet, palette: 'perso' });
      const lw = Math.ceil(e.w);
      for (let y = 0; y < h; y++) for (let x = 0; x < lw; x++) {
        const s = (y * lw + (lw - 1 - x)) * 4, a = tmp[s + 3] / 255, X = Math.floor(e.x) + x;
        if (a <= 0 || X >= w) continue;
        const o = (y * w + X) * 4;
        for (let c = 0; c < 3; c++) d[o + c] = tmp[s + c] * a + d[o + c] * (1 - a);
      }
    }
    F.push(d);
  }
  return F;
}

/** Les 4 vues de repos, transparentes, pour l'appel d'images (2048 x 1024 par defaut). */
function toilePoses(w, h) {
  w = w || 2048; h = h || 1024;
  const d = new Uint8ClampedArray(w * h * 4), dirs = Object.keys(DIRS), points = {};
  /* corps a 0,42 de la hauteur : au repos l'arme s'ecarte de 0,45 u du torse ; a 0,55
     (premier essai) la pointe de SW entrait dans le quart de SE (vu a l'image, 12/10) */
  const lw = w / dirs.length, s = 0.42 * h / HAUT_CORPS;
  dirs.forEach((dir, i) => { points[dir] = dessine(d, w, h, REPOS, dir, (i + 0.5) * lw, 0.85 * h, s); });
  return { w, h, data: d, points, echelle: s };
}

/** Les chiffres attendus : cote de l'arme au repos (main droite - tronc, en
    fraction de la hauteur du corps) et foulee projetee par cycle. */
function reference() {
  const t = toilePoses(2048, 1024), H = HAUT_CORPS * t.echelle, main = {};
  for (const dir of Object.keys(DIRS)) main[dir] = Math.round(1000 * (t.points[dir].mainD[0] - t.points[dir].tronc[0]) / H) / 1000;
  const diag = Math.sqrt(0.5 + 0.5 * Math.sin(ELEV) ** 2);
  return { main_droite_moins_tronc_sur_corps: main,
           pas_cycle_sur_corps: { walk: Math.round(2 * 0.30 * diag / HAUT_CORPS * 1000) / 1000, run: Math.round(2 * 0.45 * diag / HAUT_CORPS * 1000) / 1000 } };
}

module.exports = { PALETTES, ELEV, DIRS, ACTIONS, REPOS, HAUT_CORPS, DISPO, poseAu, squelette, dessine, emplacements, bandePose, clipFaux, toilePoses, reference, fond };
