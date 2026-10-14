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
 *   attack, jump    : n images a pas egaux de TEMPS sur le geste (du debut a la
 *                     fin du mouvement), l'image la plus loin du repos (l'impact)
 *                     gardee ; joue a un seul ips, le geste garde son rythme.
 *                     Revue du 13/10/2026 : a pas egaux de MOUVEMENT (avant), les
 *                     ecarts reels allaient de 42 a 458 ms pour une image jouee a
 *                     161 ms — le coup ralenti 3,8 fois, le retour accelere 2,8 fois.
 *
 * La recherche de foulee reprend notre chaine/finition.py (couture / mouvement
 * moyen de la fenetre ; sous 0,5 propre, au-dessus de 0,8 a refaire, regle de
 * Scenario citee au releve du 12/10/2026), periode entre 0,45 et 1,6 s.
 * Les images sont deja dans la case (meme repere pour toutes).
 * ======================================================================== */
const T = require('./traite');

/* Vecteur d'une direction a l'ecran (losange 2:1) : l'axe le long duquel les pieds s'ecartent. */
const AXE = { se: [2, 1], sw: [-2, 1], nw: [-2, -1], ne: [2, -1], e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1] };
/* Les pieds sont au SOL : on les ramene dans le plan du sol (camera a 30 deg, losange
   2:1 : x_sol = X, z_sol = 2 Y) ou l'avant f et la droite r = (-f.z, f.x) sont
   orthogonaux. A l'ecran ils ne le sont pas (SE (2,1) contre SW (-2,1) : cosinus -0,6),
   et l'ecart avant-arriere fuyait dans le cote (premier essai du 13/10/2026 : signe
   constant, 0 alternance sur le vrai mannequin). Hors iso (e, w, s, n), l'ecran. */
const SOL = { se: [1, 1], sw: [-1, 1], nw: [-1, -1], ne: [1, -1] };
const unite = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };
function axes(dir) {
  if (SOL[dir]) { const f = unite(SOL[dir]); return { iso: true, f, r: [-f[1], f[0]] }; }
  const f = unite(AXE[dir] || [1, 0]); return { iso: false, f, r: [-f[1], f[0]] };
}

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

/**
 * Le pied le plus BAS d'une image (le plus pres de la camera : en marche, celui de
 * devant face a nous, celui de derriere de dos — dans les deux cas il change a chaque
 * demi-foulee) : sa position LATERALE dans le plan du sol, par rapport au centre du
 * corps pose sur la ligne du sol (x du torse, solPx). Son signe dit si c'est le pied
 * droit ou le gauche. Les 3 % du bas de la silhouette (2 rangees au moins).
 * Mesure du 13/10/2026 sur le mannequin (24 images par cycle, 4 directions) : +-10 a
 * +-24 px d'un cote puis de l'autre en marche ; des ciseaux (la jambe droite toujours
 * devant) gardent le meme signe.
 */
function cotePied(m, C, b, dir, solPx) {
  if (!b) return null;
  const A = axes(dir), k = A.iso ? 2 : 1;
  const ya = Math.max(b.y0, b.y1 - Math.max(1, Math.round(0.03 * b.h)));
  let sx = 0, sy = 0, n = 0;
  for (let y = ya; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (m[y * C + x]) { sx += x; sy += y; n++; }
  if (!n) return null;
  const xt = T.torse(m, C, C, b);
  const gx = sx / n - xt, gz = k * (sy / n - solPx);
  return gx * A.r[0] + gz * A.r[1];
}

/* Combien de fois le pied le plus bas change de cote sur un cycle (images du clip
   s..s+P) : 2 pour une marche, 0 pour des ciseaux sur place (la meme jambe toujours
   devant). Les images ou le pied est presque au centre (moins de 30 % du plus grand
   ecart du cycle : le passage) ne comptent pas. */
function alternances(F, C, dir, s, P, solPx) {
  const c = [];
  for (let i = s; i < s + P && i < F.length; i++) {
    const m = T.masque(F[i], C, C), b = T.bbox(m, C, C), q = cotePied(m, C, b, dir, solPx);
    if (q != null) c.push(q);
  }
  /* le centre du corps au sol n'est pas connu au pixel pres (la pose est posee par le bas
     de la silhouette, la pointe du pied ; le centre est ~12 px plus haut a 128 px de corps,
     soit un biais lateral constant de ~17 px, mesure du 13/10/2026) : on retire la moyenne
     du cycle. Une marche oscille UNE fois par cycle (2 changements de signe) ; des ciseaux,
     deux fois (le meme pied revient devant a chaque demi-cycle : 4) ou pas du tout (0). */
  const moy = c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0;
  for (let i = 0; i < c.length; i++) c[i] -= moy;
  const mx = Math.max(0, ...c.map((q) => Math.abs(q)));
  const signes = c.filter((q) => Math.abs(q) >= 0.3 * mx && Math.abs(q) >= 1).map((q) => Math.sign(q));
  let n = 0;
  for (let i = 0; i < signes.length; i++) if (signes[i] !== signes[(i + 1) % signes.length]) n++;
  return { n: signes.length > 1 ? n : 0, lues: signes.length, ecart: Math.round(mx * 10) / 10 };
}

/* La derive du torse sur UNE periode : un balancement revient, une glissade non.
   Moyenne de |x(i+P) - x(i)| sur la partie du clip hors des rampes, rapportee a la
   hauteur du corps (en %). */
function derive(F, C, P, marge, h) {
  const tx = F.map((d) => { const m = T.masque(d, C, C); return T.torse(m, C, C); });
  const e = [];
  for (let i = marge; i + P < F.length - marge; i++) if (tx[i] != null && tx[i + P] != null) e.push(Math.abs(tx[i + P] - tx[i]));
  return e.length && h > 0 ? 100 * e.reduce((a, b) => a + b, 0) / e.length / h : null;
}

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
  return { s: s0, P: best.P, couture: best.sc, periodeS: best.P / fps, ecarts, mv, marge };
}

/** Les n images d'une action, et ce qu'on a mesure en les choisissant. nHD (facultatif) :
    le meme choix pour la planche HD (memes debut, periode ou geste ; en boucle, les images
    du jeu sont une sur deux de celles de la HD quand nHD = 2 n). */
function choisis(action, F, Fh, C, fps, dir, n, sol, nHD) {
  const r = choisis1(action, F, Fh, C, fps, dir, n, sol);
  if (nHD) {
    const L = F.length, idx = [];
    if (r.boucle && r.s != null) { for (let k = 0; k < nHD; k++) idx.push(Math.min(L - 1, r.s + Math.round(k * r.P / nHD))); r.ipsHD = nHD / r.periodeS; }
    else if (r.geste) {
      for (let k = 0; k < nHD; k++) idx.push(Math.round(r.a + k * (r.b - r.a) / Math.max(1, nHD - 1)));
      let kp = 0; for (let k = 1; k < nHD; k++) if (Math.abs(idx[k] - r.pic) < Math.abs(idx[kp] - r.pic)) kp = k;
      if (kp > 0 && kp < nHD - 1) idx[kp] = r.pic;
      const pasS = (r.b - r.a) / Math.max(1, nHD - 1) / fps; r.ipsHD = pasS > 0 ? 1 / pasS : 8;
    } else { for (let k = 0; k < nHD; k++) idx.push(Math.min(L - 1, Math.round(k * L / nHD))); r.ipsHD = nHD * fps / L; }
    r.idxHD = idx;
  }
  return r;
}

function choisis1(action, F, Fh, C, fps, dir, n, sol) {
  const solPx = (sol == null ? 0.88 : sol) * C;
  const L = F.length, nh = (C >> 1) * (C >> 1);
  if (action === 'walk' || action === 'run') {
    const b = boucle(F, Fh, C, fps, dir);
    if (b) {
      const idx = []; for (let k = 0; k < n; k++) idx.push(Math.min(L - 1, b.s + Math.round(k * b.P / n)));
      const pasPx = 2 * (Math.max(...b.ecarts) - Math.min(...b.ecarts));
      const hs = []; for (let i = b.s; i < b.s + b.P && i < L; i++) { const bb = T.bbox(T.masque(F[i], C, C), C, C); if (bb) hs.push(bb.h); }
      const hmed = hs.length ? hs.sort((x, y) => x - y)[hs.length >> 1] : 0;
      return { idx, s: b.s, P: b.P, ips: n / b.periodeS, boucle: true, couture: b.couture, periodeS: b.periodeS, pasCase: pasPx / C,
               alternances: alternances(F, C, dir, b.s, b.P, solPx), derive: derive(F, C, b.P, b.marge, hmed) };
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
    /* a pas egaux de TEMPS entre a et b ; l'image la plus loin de a (l'impact, le haut
       du saut) remplace celle qui en est la plus proche : au plus une demi-image de decalage */
    const idx = []; for (let k = 0; k < n; k++) idx.push(Math.round(a + k * (b - a) / Math.max(1, n - 1)));
    let pic = a, ePic = -1; for (let i = a; i <= b; i++) { const e = T.ecart(Fh[i], Fh[a], nh); if (e > ePic) { ePic = e; pic = i; } }
    let kp = 0; for (let k = 1; k < n; k++) if (Math.abs(idx[k] - pic) < Math.abs(idx[kp] - pic)) kp = k;
    if (kp > 0 && kp < n - 1) idx[kp] = pic;
    const pasS = (b - a) / Math.max(1, n - 1) / fps;
    /* l'ips EST le pas de temps : chaque image dure ce qu'elle dure dans le clip */
    return { idx, ips: pasS > 0 ? 1 / pasS : 8, boucle: false, geste: true, a, b, pic, gesteS: (b - a) / fps, pasMs: Math.round(pasS * 1000) };
  }
  /* idle : le clip entier, a pas egaux */
  const idx = []; for (let k = 0; k < n; k++) idx.push(Math.min(L - 1, Math.round(k * L / n)));
  return { idx, ips: n * fps / L, boucle: true };
}

module.exports = { choisis, ecartPieds, cotePied, alternances, AXE };
