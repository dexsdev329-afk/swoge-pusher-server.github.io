'use strict';
/* ==========================================================================
 * PLANCHES — LES CONTROLES, AVEC UN VERDICT
 *
 * Chaque controle rend { id, action?, dir?, valeur, seuil, sens, n, ok }.
 * `n` = le nombre d'images sur lequel porte la valeur. La planche passe si
 * TOUS passent ; sinon elle est « a revoir » et la fiche dit lesquels.
 *
 * LES SEUILS SONT PROVISOIRES. Ils viennent des mesures de qc_planche.py sur
 * 13 planches (8 du jeu, 5 refaites en essai, 2 personnages), releve du
 * 12/10/2026 (qc_mesures.json, wuwvxcq70.output), et du mannequin de cette
 * chaine (planches_chaine.test.js). A reecrire avec leur date et leur n
 * apres le pilote (plan, etape 6).
 * ======================================================================== */
const T = require('./traite');
const { ecartPieds } = require('./choix');

const SEUILS = {
  /* hauteur dans une ligne, mesuree du sommet a la ligne du SOL (fixe) et non au bas
     de la silhouette : en iso le pied avant descend a l'ecran a chaque foulee.
     « 5 % au plus » (releve 12/10), nos planches 1,3-7,0 % ; 6 % */
  taille_ligne: 6,
  /* ligne des pieds (bas de la silhouette) : 4 % de profil, 8 % de face au releve
     (AutoSprite 0,6-3,4 % / 7-11 %). En iso la marche la fait varier PAR CONSTRUCTION
     (le pied avant passe sous la ligne du sol) : mannequin du 12/10/2026, 4 directions
     x 8 images, marche 10,4-12,5 %, course 11,5-17,7 %. Pieds poses (repos, attaque) : 6 % */
  pieds: { idle: 6, attack: 6, walk: 14, run: 20 },
  /* glisse du torse, % de la hauteur : le pirate a 6,9 % est le defaut vise (releve 12/10) ;
     mannequin : 0,1-2,7 % (marche, repos), jusqu'a 4,5 % en course (bras devant le torse) */
  glisse: 6,
  /* jambes / torse (XOR, bande 75-100 % contre 15-60 %) : lieutenant droite 0,96 = jambes immobiles ;
     nos bonnes lignes 1,35-5,2. Ecart des pieds le long de l'axe de marche, max/min : brasier 1,01-1,04 immobile */
  jambes_ratio: 1.3, jambes_ecart: 1.25,
  /* couture de la foulee sur le clip : < 0,5 propre, > 0,8 a refaire (regle de Scenario, releve 12/10) */
  couture_clip: 0.8,
  /* couture sur les 8 images (7 -> 0) rapportee au pas moyen 0->1->...->7 : nos planches 0,46-1,51 sur 4 images */
  couture_8: 1.8,
  /* geste : la derniere image revient pres de la premiere (part de l'ecart maximal) */
  geste_retour: 0.35, geste_ampleur: 12,
  /* repos : un mouvement non nul (XOR moyen entre images voisines) — sinon c'est une image figee */
  repos_mouvement: 0.002,
  /* sol colle : base continue (plus long segment opaque des 4 % du bas / hauteur) — rodeur 0,35-0,51, les autres 0,04-0,29 */
  sol_base: 0.32,
  /* halo : part des pixels semi-transparents (alpha 8-200) qui NE touchent PAS un pixel
     opaque — le bord anti-crenele d'une figure nette est exclu, une ombre ou une lueur
     detachee compte. Mesure du 12/10/2026 sur les 40 planches du jeu (160 lignes) :
     l'ancienne mesure (tous les semi-transparents, seuil 0,12 du releve) rejetait 12
     planches sur 40, dont les spectres translucides PAR DESSIN (oracle 0,24-0,28,
     veilleur 0,23-0,24) ; rodeur (0,23) n'en sortait pas du lot. Le halo : 26/40
     a 0,03 au plus, spectres et lave 0,07-0,14 (leur style). Le seuil est donc
     RELATIF a l'ancienne planche du meme monstre quand elle existe (+0,03),
     0,03 sinon. Le sol colle, lui, est le controle `sol`. */
  halo: 0.03,
  /* debris : part des pixels opaques dans des taches de moins de 2 % de la figure.
     Le releve demandait « la plus grosse tache >= 99 % » ; mais une pointe d'arme
     cachee derriere la tete est une tache a part LEGITIME (mannequin, attaque NW :
     0,858). Ce qui est vise, ce sont les miettes de detourage : <= 1 % */
  tache: 0.01,
  /* couleur de chaque image contre la moyenne de sa ligne (Hellinger, 64 cases). Le
     releve du 12/10 donnait 0,08 sur des planches PEINTES (nos planches 0,021-0,039) ;
     une image tiree d'une video 4:2:0 melange la couleur a chaque frontiere entre deux
     pieces de couleurs vives : faux clips du mannequin colore (H.264 yuv420p, 12/10/2026),
     5 actions x 4 directions x 8 images = 160 images, 0,027-0,110. Le ninja refait par
     AutoSprite (video aussi) : 0,115-0,132, « a verifier a l'oeil ». Seuil 0,12 :
     au-dessus de tout le mannequin, sous le pire du ninja. */
  couleur: 0.12,
  /* premiere image du clip contre notre pose PNG (un clip non epingle part d'ailleurs) :
     le seul passage en video coute 0,143-0,158 au mannequin colore (20 lignes) */
  depart: 0.20,
  /* taille entre directions et entre actions : nos planches 1,03-1,07, AutoSprite 1,27-1,58 (rejete) */
  taille_dirs: 1.15,
  /* copie miroir : part des pixels qui concordent (forme ET couleur, recales) avec le
     miroir de la meilleure image du clip voisin. Mannequin colore, 12/10/2026 : vraies
     vues 0,22-0,38 (5 actions x 2 paires, n = 8 images chacune) ; SW = SE retourne et
     decale de 5 images : 0,867 (le vieux controle a 4 images laissait passer 0,859 et
     0,944 sous 0,97). Seuil a mi-chemin. PROVISOIRE : une creature symetrique et
     unie peut monter plus haut en vraie vue — a remesurer au pilote. */
  miroir: 0.6,
};

function composantes(m, w, h) {
  const vu = new Uint8Array(w * h), tailles = [], pile = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || vu[i]) continue;
    let n = 0; pile.push(i); vu[i] = 1;
    while (pile.length) {
      const j = pile.pop(); n++;
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && m[j - 1] && !vu[j - 1]) { vu[j - 1] = 1; pile.push(j - 1); }
      if (x < w - 1 && m[j + 1] && !vu[j + 1]) { vu[j + 1] = 1; pile.push(j + 1); }
      if (y > 0 && m[j - w] && !vu[j - w]) { vu[j - w] = 1; pile.push(j - w); }
      if (y < h - 1 && m[j + w] && !vu[j + w]) { vu[j + w] = 1; pile.push(j + w); }
    }
    tailles.push(n);
  }
  const s = tailles.reduce((a, b) => a + b, 0);
  return { n: tailles.length, grosse: s ? Math.max(...tailles) / s : 0, miettes: s ? tailles.filter((t) => t < 0.02 * s).reduce((a, b) => a + b, 0) / s : 0 };
}

function histo(d, n) {
  const h = new Float64Array(64); let s = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] > T.ALPHA) { h[(d[i * 4] >> 6) * 16 + (d[i * 4 + 1] >> 6) * 4 + (d[i * 4 + 2] >> 6)]++; s++; }
  if (s) for (let k = 0; k < 64; k++) h[k] /= s;
  return h;
}
function hellinger(p, q) { let s = 0; for (let k = 0; k < 64; k++) s += Math.sqrt(p[k] * q[k]); return Math.sqrt(Math.max(0, 1 - s)); }

/** Le halo d'une image : semi-transparents sans voisin opaque (alpha >= 200), sur les pixels visibles. */
function halo(d, C) {
  let a = 0, h = 0;
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    const v = d[(y * C + x) * 4 + 3];
    if (v <= 8) continue;
    a++;
    if (v >= 200) continue;
    let pres = false;
    for (let dy = -1; dy <= 1 && !pres; dy++) for (let dx = -1; dx <= 1 && !pres; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < C && yy < C) pres = d[(yy * C + xx) * 4 + 3] >= 200;
    }
    if (!pres) h++;
  }
  return a ? h / a : 0;
}

function plusLong(m, w, y) { let best = 0, cur = 0; for (let x = 0; x < w; x++) { cur = m[y * w + x] ? cur + 1 : 0; if (cur > best) best = cur; } return best; }
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const r2 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);

/* XOR moyen entre images voisines sur une bande de hauteur [lo, hi] de la silhouette (boucle comprise). */
function bande(M, B, C, lo, hi, boucle) {
  const r = [], N = M.length;
  for (let i = 0; i < (boucle ? N : N - 1); i++) {
    const j = (i + 1) % N, t = Math.min(B[i].y0, B[j].y0), h = Math.max(B[i].h, B[j].h);
    r.push(T.xor(M[i], M[j], Math.floor(t + lo * h) * C, Math.min(C, Math.floor(t + hi * h) + 1) * C));
  }
  return r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
}

/**
 * Les controles d'une ligne (une action, une direction).
 * F : les n images gardees (RGBA C x C) ; info : ce que le choix a mesure ;
 * pose : la case de la pose de cette direction (reference de couleur) ;
 * coupes : pixels sortis de la case ; sortie : images ou la figure touche le
 * bord de son emplacement dans la video.
 */
function ligne(action, dir, F, C, info, pose, coupes, sortie, sol, ref0, haloRef) {
  const solPx = (sol == null ? 0.88 : sol) * C;
  const n = F.length, N = C * C, out = [];
  const M = F.map((d) => T.masque(d, C, C)), B = M.map((m) => T.bbox(m, C, C));
  const add = (id, valeur, seuil, sens, extra) => out.push(Object.assign({ id, action, dir, valeur: r2(valeur), seuil, sens, n,
    ok: Number.isFinite(valeur) && (sens === '<=' ? valeur <= seuil : valeur >= seuil) }, extra || {}));
  if (B.some((b) => !b)) { add('vide', 1, 0, '<='); return { controles: out, mesures: {} }; }
  const H = B.map((b) => b.h), BOT = B.map((b) => b.y1), TX = M.map((m, i) => T.torse(m, C, C, B[i]));
  const HS = B.map((b) => solPx - b.y0);   /* du sommet a la ligne du sol */
  const hm = H.reduce((a, b) => a + b, 0) / n;
  const boucle = action === 'idle' || action === 'walk' || action === 'run';
  const mesures = { h_med: med(HS), pied_med: med(BOT) };

  if (boucle) {
    add('taille_ligne', 100 * (Math.max(...HS) - Math.min(...HS)) / med(HS), SEUILS.taille_ligne, '<=');
    add('glisse', 100 * (Math.max(...TX) - Math.min(...TX)) / hm, SEUILS.glisse, '<=');
    const pas = []; for (let i = 0; i < n - 1; i++) pas.push(T.ecart(F[i], F[i + 1], N));
    add('boucle', T.ecart(F[n - 1], F[0], N) / Math.max(1e-6, pas.reduce((a, b) => a + b, 0) / pas.length), SEUILS.couture_8, '<=');
  }
  if (SEUILS.pieds[action]) add('pieds', 100 * (Math.max(...BOT) - Math.min(...BOT)) / hm, SEUILS.pieds[action], '<=');
  if (action === 'walk' || action === 'run') {
    add('boucle_clip', info.couture, SEUILS.couture_clip, '<=', { periodeS: r2(info.periodeS) });
    const jambes = bande(M, B, C, 0.75, 1.0, true), torse = bande(M, B, C, 0.15, 0.6, true);
    add('jambes', torse > 0 ? jambes / torse : 0, SEUILS.jambes_ratio, '>=');
    const e = F.map((d) => ecartPieds(d, C, dir));
    add('jambes_ecart', Math.max(...e) / Math.max(1, Math.min(...e)), SEUILS.jambes_ecart, '>=');
  }
  if (action === 'idle') {
    let s = 0; for (let i = 0; i < n; i++) s += T.xor(M[i], M[(i + 1) % n]);
    add('repos_mouvement', s / n, SEUILS.repos_mouvement, '>=');
  }
  if (action === 'attack' || action === 'jump') {
    const e = F.map((d) => T.ecart(d, F[0], N)), mx = Math.max(...e);
    add('geste_ampleur', mx, SEUILS.geste_ampleur, '>=');
    add('geste_retour', mx > 0 ? e[n - 1] / mx : 1, SEUILS.geste_retour, '<=');
  }
  /* sol colle et halo */
  const base = M.map((m, i) => { let b = 0; for (let y = Math.max(0, B[i].y1 - Math.max(1, Math.round(0.04 * H[i]))); y <= B[i].y1; y++) b = Math.max(b, plusLong(m, C, y)); return b / H[i]; });
  add('sol', med(base), SEUILS.sol_base, '<=');
  add('halo', F.reduce((a, d) => a + halo(d, C), 0) / n, Math.round(((haloRef == null ? 0 : haloRef) + SEUILS.halo) * 1000) / 1000, '<=');
  /* rien de coupe, rien au bord, une seule figure */
  let bord = 0;
  for (const m of M) { let t = false; for (let k = 0; k < C && !t; k++) t = m[k] || m[(C - 1) * C + k] || m[k * C] || m[k * C + C - 1]; if (t) bord++; }
  add('coupes', coupes + bord + (sortie || 0), 0, '<=', { px_coupes: coupes, images_au_bord: bord, images_hors_emplacement: sortie || 0 });
  add('taches', Math.max(...M.map((m) => composantes(m, C, C).miettes)), SEUILS.tache, '<=');
  /* identite : chaque image contre la MOYENNE de sa ligne (la mesure de qc_planche.py:89-90,
     celle qui a donne 0,021-0,039 sur nos planches), et la premiere image du clip
     contre notre pose (un clip non epingle peut partir d'ailleurs) */
  const hs = F.map((d) => histo(d, N)), moy = new Float64Array(64);
  for (const h of hs) for (let k = 0; k < 64; k++) moy[k] += h[k] / n;
  add('couleur', Math.max(...hs.map((h) => hellinger(h, moy))), SEUILS.couleur, '<=');
  if (ref0 && pose) add('depart', hellinger(histo(ref0, N), histo(pose, N)), SEUILS.depart, '<=', { n: 1 });
  return { controles: out, mesures };
}

/* Concordance forme + couleur de deux images (demi-resolution) : 1 = la meme image.
   Les deux figures sont d'abord recalees sur leurs centres de masse (chaque direction a
   sa propre ancre, tiree de SA pose : un SE retourne pose dans l'emplacement SW n'a ni
   le meme torse ni les memes pieds que le vrai SW — premier essai sans recalage, le
   miroir decale passait a 0,33), puis +-1 px autour. */
function centre(d, w) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > T.ALPHA) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n] : [w / 2, w / 2];
}
function concorde(a, b, w, ca, cb) {
  ca = ca || centre(a, w); cb = cb || centre(b, w);
  const bx = Math.round(cb[0] - ca[0]), by = Math.round(cb[1] - ca[1]);
  let best = 0;
  for (let dy = by - 1; dy <= by + 1; dy++) for (let dx = bx - 1; dx <= bx + 1; dx++) {
    let u = 0, k = 0;
    for (let y = 0; y < w; y++) {
      const yb = y + dy; if (yb < 0 || yb >= w) continue;
      for (let x = 0; x < w; x++) {
        const xb = x + dx; if (xb < 0 || xb >= w) continue;
        const i = (y * w + x) * 4, j = (yb * w + xb) * 4, pa = a[i + 3] > T.ALPHA, pb = b[j + 3] > T.ALPHA;
        if (!pa && !pb) continue;
        u++;
        if (pa && pb && (Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2])) / 3 < 24) k++;
      }
    }
    if (u && k / u > best) best = k / u;
  }
  return best;
}

/**
 * Les controles de la planche entiere.
 * L : { action: { dir: { F (gardees), Fh (tout le clip, demi-resolution), mesures } } }
 */
function planche(L, C, dirs) {
  const out = [], w = C >> 1;
  /* taille entre directions (par action en boucle) et entre actions (par direction) */
  for (const action of Object.keys(L)) {
    if (!['idle', 'walk', 'run'].includes(action)) continue;
    const h = dirs.filter((d) => L[action][d]).map((d) => L[action][d].mesures.h_med);
    if (h.length > 1) { const v = Math.max(...h) / Math.min(...h); out.push({ id: 'taille_dirs', action, valeur: r2(v), seuil: SEUILS.taille_dirs, sens: '<=', n: h.length * 8, ok: v <= SEUILS.taille_dirs }); }
  }
  for (const dir of dirs) {
    const h = ['idle', 'walk', 'run'].filter((a) => L[a] && L[a][dir]).map((a) => L[a][dir].mesures.h_med);
    if (h.length > 1) { const v = Math.max(...h) / Math.min(...h); out.push({ id: 'taille_actions', dir, valeur: r2(v), seuil: SEUILS.taille_dirs, sens: '<=', n: h.length * 8, ok: v <= SEUILS.taille_dirs }); }
  }
  /* miroir : SW n'est pas SE retourne, NW n'est pas NE retourne — compare a TOUTES
     les images du clip voisin (un miroir decale en phase ne passe plus : defaut 3
     de qc_planche.py au releve du 12/10, 0,859 / 0,944 sous le seuil de 0,97) */
  const paires = [['se', 'sw'], ['ne', 'nw'], ['e', 'w']];
  for (const action of Object.keys(L)) for (const [a, b] of paires) {
    const A = L[action][a], Bq = L[action][b];
    if (!A || !Bq) continue;
    const mirA = A.Fh.map((d) => T.miroir(d, w, w)), cA = mirA.map((d) => centre(d, w));
    const pas = Math.max(1, Math.floor(mirA.length / 48));
    const v = med(Bq.Fg.map((d) => { const cd = centre(d, w); let m = 0; for (let j = 0; j < mirA.length; j += pas) m = Math.max(m, concorde(d, mirA[j], w, cd, cA[j])); return m; }));
    out.push({ id: 'miroir', action, dir: b + '/' + a, valeur: r2(v), seuil: SEUILS.miroir, sens: '<=', n: Bq.Fg.length, ok: v <= SEUILS.miroir });
  }
  return out;
}

module.exports = { SEUILS, ligne, planche, concorde, composantes, hellinger, histo, halo };
