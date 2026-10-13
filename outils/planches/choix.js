'use strict';
/* ==========================================================================
 * PLANCHES — QUELLES IMAGES DU CLIP GARDER (n = 8 par action)
 *
 *   idle            : n images a intervalles egaux sur tout le clip (le clip
 *                     epingle part de la pose et y revient : la boucle est la)
 *   walk, run       : la foulee (debut s, periode P) qui ferme le mieux la
 *                     boucle, cherchee HORS des 0,4 s du debut et de la fin
 *                     (le clip epingle y demarre et s'arrete) ; n images a
 *                     P/n, la premiere au contact (pieds les plus ecartes)
 *   attack, jump    : n images cles a pas egaux de MOUVEMENT cumule, la
 *                     premiere et la derniere au repos (un geste, pas une boucle)
 *
 * La recherche de foulee reprend notre chaine/finition.py (couture / mouvement
 * moyen de la fenetre ; sous 0,5 propre, au-dessus de 0,8 a refaire, regle de
 * Scenario citee au releve du 12/10/2026), periode entre 0,45 et 1,6 s.
 * Les images sont deja dans la case (meme repere pour toutes).
 * ======================================================================== */
const T = require('./traite');

/* Vecteur d'une direction a l'ecran (losange 2:1) : l'axe le long duquel les pieds s'ecartent. */
const AXE = { se: [2, 1], sw: [-2, 1], nw: [-2, -1], ne: [2, -1], e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1] };

/* L'ecart des pieds le long de l'axe de marche : etendue des pixels opaques
   des 12 % du bas de la silhouette, projetee sur l'axe. */
function ecartPieds(d, C, dir) {
  const m = T.masque(d, C, C), b = T.bbox(m, C, C);
  if (!b) return 0;
  const a = AXE[dir] || [1, 0], L = Math.hypot(a[0], a[1]), ux = a[0] / L, uy = a[1] / L;
  let lo = Infinity, hi = -Infinity;
  for (let y = Math.max(b.y0, b.y1 - Math.round(0.12 * b.h)); y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
    if (!m[y * C + x]) continue;
    const p = x * ux + y * uy; if (p < lo) lo = p; if (p > hi) hi = p;
  }
  return hi > lo ? hi - lo : 0;
}

function mouvements(Fh, nh) { const mv = []; for (let i = 0; i + 1 < Fh.length; i++) mv.push(T.ecart(Fh[i], Fh[i + 1], nh)); return mv; }

function boucle(F, Fh, C, fps, dir) {
  const L = F.length, nh = (C >> 1) * (C >> 1);
  const marge = Math.round(0.4 * fps), pmin = Math.max(6, Math.round(0.45 * fps)), pmax = Math.round(1.6 * fps);
  const mv = mouvements(Fh, nh);
  let best = null;
  for (let s = marge; s < L; s++) for (let P = pmin; P <= pmax; P++) {
    if (s + P > L - 1 - marge) break;
    let base = 0; for (let i = s; i < s + P; i++) base += mv[i]; base /= P;
    if (base <= 0) continue;
    const sc = T.ecart(Fh[s], Fh[s + P], nh) / base;
    /* a egalite (0,03 pres), la periode la plus COURTE : deux foulees prises
       pour une donneraient 4 images par pas */
    if (!best || sc < best.sc - 0.03 || (Math.abs(sc - best.sc) <= 0.03 && P < best.P)) best = { sc, s, P };
  }
  if (!best) return null;
  /* le debut decale au contact : les pieds les plus ecartes dans la demi-periode */
  let s0 = best.s, e0 = -1;
  for (let i = best.s; i < best.s + Math.max(1, best.P >> 1); i++) { const e = ecartPieds(F[i], C, dir); if (e > e0) { e0 = e; s0 = i; } }
  if (s0 + best.P > L - 1) s0 -= best.P;
  if (s0 < 0) s0 = best.s;
  const ecarts = []; for (let i = s0; i < s0 + best.P && i < L; i++) ecarts.push(ecartPieds(F[i], C, dir));
  return { s: s0, P: best.P, couture: best.sc, periodeS: best.P / fps, ecarts, mv };
}

/** Les n images d'une action, et ce qu'on a mesure en les choisissant. */
function choisis(action, F, Fh, C, fps, dir, n) {
  const L = F.length, nh = (C >> 1) * (C >> 1);
  if (action === 'walk' || action === 'run') {
    const b = boucle(F, Fh, C, fps, dir);
    if (b) {
      const idx = []; for (let k = 0; k < n; k++) idx.push(Math.min(L - 1, b.s + Math.round(k * b.P / n)));
      const pasPx = 2 * (Math.max(...b.ecarts) - Math.min(...b.ecarts));
      return { idx, ips: n / b.periodeS, boucle: true, couture: b.couture, periodeS: b.periodeS, pasCase: pasPx / C };
    }
    /* clip trop court pour une foulee : rien de propre a rendre */
    const idx = []; for (let k = 0; k < n; k++) idx.push(Math.round(k * (L - 1) / n));
    return { idx, ips: n * fps / L, boucle: true, couture: Infinity, periodeS: null, pasCase: null };
  }
  if (action === 'attack' || action === 'jump') {
    const mv = mouvements(Fh, nh), mx = Math.max(...mv, 0);
    let a = 0, b = L - 1;
    if (mx > 0) {
      const seuil = 0.15 * mx;
      a = Math.max(0, mv.findIndex((x) => x > seuil));
      let z = mv.length - 1; while (z > 0 && mv[z] <= seuil) z--;
      b = Math.min(L - 1, z + 1);
    }
    const cum = [0]; for (let i = a; i < b; i++) cum.push(cum[cum.length - 1] + mv[i]);
    const tot = cum[cum.length - 1] || 1, idx = [];
    for (let k = 0; k < n; k++) {
      const cible = tot * k / (n - 1);
      let j = 0; while (j < cum.length - 1 && cum[j] < cible - 1e-9) j++;
      idx.push(a + j);
    }
    const dureeS = (b - a + 1) / fps;
    return { idx, ips: Math.max(6, Math.min(24, n / dureeS)), boucle: false, gesteS: dureeS };
  }
  /* idle : le clip entier, a pas egaux */
  const idx = []; for (let k = 0; k < n; k++) idx.push(Math.min(L - 1, Math.round(k * L / n)));
  return { idx, ips: n * fps / L, boucle: true };
}

module.exports = { choisis, ecartPieds, AXE };
