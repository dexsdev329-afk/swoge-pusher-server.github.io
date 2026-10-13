'use strict';
/* ==========================================================================
 * PLANCHES — LA BANDE DE POSES QUE NOUS ENVOYONS A xAI
 *
 * Entree : l'image d'OpenAI (2048 x 1024, transparente, 4 vues SE SW NW NE
 * cote a cote). Sortie : une bande 2000 x 800 sur fond de couleur cle, 4
 * emplacements de 500 x 800, chaque figure remise a la MEME hauteur (corps =
 * 0,40 x 800, guide.js DISPO), pieds a 85 % de la hauteur, torse au centre.
 * C'est cette bande qui devient la premiere et la derniere image de chaque
 * clip (image = last_frame) : la chaine connait donc au pixel pres la place,
 * la taille et les pieds de chaque figure (chaine.js : reperes de la pose).
 *
 * Controles P (gratuits, avant tout clip paye) :
 *   P1 quatre figures, une par quart          P2 pas de sol ni d'ombre collee
 *   P3 tailles des 4 vues (avant remise a niveau, pour information et seuil)
 *   P6 SW n'est pas SE retourne, NW n'est pas NE retourne (concorde, comme F6)
 *   P7 la couleur cle choisie est loin du monstre (< 0,5 % de pixels proches)
 * Le cote de l'arme (P4/P5 du plan) ne se mesure pas sur un monstre quelconque
 * sans reperes : il se juge a l'oeil sur l'apercu, contre la toile du mannequin.
 *
 *   node outils/planches/compose.js <openai.png> <sortie.png>   -> imprime la fiche JSON
 * ======================================================================== */
const fs = require('fs');
const crypto = require('crypto');
const M = require('./media');
const T = require('./traite');
const Q = require('./controles');
const G = require('./guide');

const BANDE = { w: 2000, h: 800 };
const DIRS = ['se', 'sw', 'nw', 'ne'];

/* Retire les taches de moins de 2 % de la figure d'un quart (un bout d'arme de la
   vue voisine qui depasse dans ce quart, une poussiere) ; rend le nombre de pixels retires. */
function nettoie(d, w, h) {
  const lab = new Int32Array(w * h).fill(-1), tailles = [];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] >= 0 || d[i * 4 + 3] <= T.ALPHA) continue;
    const id = tailles.length, pile = [i]; lab[i] = id; let n = 0;
    while (pile.length) {
      const j = pile.pop(); n++;
      const x = j % w, y = (j / w) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && lab[k] < 0 && d[k * 4 + 3] > T.ALPHA) { lab[k] = id; pile.push(k); }
      }
    }
    tailles.push(n);
  }
  const tot = tailles.reduce((a, b) => a + b, 0); let retires = 0;
  for (let i = 0; i < w * h; i++) {
    const l = lab[i];
    if (l >= 0 && tailles[l] < 0.02 * tot) { d[i * 4 + 3] = 0; retires++; }
    else if (l < 0 && d[i * 4 + 3] > 0) {
      /* un bord semi-transparent isole (aucun voisin opaque) part avec sa tache */
      const x = i % w, y = (i / w) | 0; let voisin = false;
      for (let dy = -1; dy <= 1 && !voisin; dy++) for (let dx = -1; dx <= 1 && !voisin; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const ll = lab[yy * w + xx]; voisin = ll >= 0 && tailles[ll] >= 0.02 * tot;
      }
      if (!voisin) d[i * 4 + 3] = 0;
    }
  }
  return retires;
}

async function compose(entree, sortie) {
  const img = await M.lisImage(entree);
  const cle = T.choisitCle(img);
  const q = img.w / 4, vues = [], controles = [];
  for (let i = 0; i < 4; i++) {
    const x0 = Math.round(i * q), w = Math.round((i + 1) * q) - x0, d = new Uint8ClampedArray(w * img.h * 4);
    for (let y = 0; y < img.h; y++) d.set(img.data.subarray((y * img.w + x0) * 4, (y * img.w + x0 + w) * 4), y * w * 4);
    const miettes = nettoie(d, w, img.h);
    vues.push({ dir: DIRS[i], d, w, h: img.h, r: T.reperes(d, w, img.h), miettes });
  }
  controles.push({ id: 'P1_figures', valeur: vues.filter((v) => v.r && v.r.h > 0.2 * img.h).length, seuil: 4, sens: '>=', n: 4 });
  const hs = vues.filter((v) => v.r).map((v) => v.r.h);
  controles.push({ id: 'P3_tailles', valeur: hs.length ? Math.round(Math.max(...hs) / Math.min(...hs) * 1000) / 1000 : null, seuil: Q.SEUILS.taille_dirs, sens: '<=', n: hs.length });
  controles.push({ id: 'P7_cle', valeur: Math.round(cle.parts[cle.nom] * 10000) / 10000, seuil: 0.005, sens: '<=', n: 1, cle: cle.nom });
  /* la bande : chaque vue a la meme hauteur de corps, pieds a 85 %, torse centre */
  const B = G.fond(BANDE.w, BANDE.h, cle.cle), lw = BANDE.w / 4, corpsPx = G.DISPO.corps * BANDE.h;
  const fiche = { format: 'swoge-pose-iso/1', w: BANDE.w, h: BANDE.h, cle: cle.nom, dirs: DIRS, emplacements: [] };
  const cases = {};
  for (const [i, v] of vues.entries()) {
    if (!v.r) continue;
    const k = corpsPx / v.r.h, C = Math.round(lw);
    /* une case carree de 500, le bas de la bande en dessous : on place dans 800 x 800 puis on recadre */
    const pl = T.place(v.d, v.w, v.h, k, v.r.tx, v.r.pied, BANDE.h, G.DISPO.pieds);
    const ox = Math.round(i * lw) - Math.round((BANDE.h - C) / 2);
    for (let y = 0; y < BANDE.h; y++) for (let x = 0; x < BANDE.h; x++) {
      const X = ox + x; if (X < Math.round(i * lw) || X >= Math.round((i + 1) * lw)) continue;
      const s = (y * BANDE.h + x) * 4, a = pl.data[s + 3] / 255; if (!a) continue;
      const o = (y * BANDE.w + X) * 4;
      for (let c = 0; c < 3; c++) B[o + c] = pl.data[s + c] * a + B[o + c] * (1 - a);
    }
    fiche.emplacements.push({ dir: v.dir, x: Math.round(i * lw), w: C, corps_px: Math.round(corpsPx), pieds_y: Math.round(G.DISPO.pieds * BANDE.h), echelle: Math.round(k * 1000) / 1000, coupes: pl.coupes, miettes_retirees: v.miettes });
    cases[v.dir] = T.moitie(T.place(v.d, v.w, v.h, 128 / v.r.h, v.r.tx, v.r.pied, 256, 0.88).data, 256, 256);
  }
  /* P2 : sol colle (base continue des 4 % du bas), comme le controle `sol` */
  const sols = vues.filter((v) => v.r).map((v) => {
    const m = T.masque(v.d, v.w, v.h), b = T.bbox(m, v.w, v.h); let best = 0;
    for (let y = Math.max(0, b.y1 - Math.max(1, Math.round(0.04 * b.h))); y <= b.y1; y++) { let cur = 0; for (let x = 0; x < v.w; x++) { cur = m[y * v.w + x] ? cur + 1 : 0; if (cur > best) best = cur; } }
    return best / b.h;
  });
  controles.push({ id: 'P2_sol', valeur: sols.length ? Math.round(Math.max(...sols) * 1000) / 1000 : null, seuil: Q.SEUILS.sol_base, sens: '<=', n: sols.length });
  for (const [a, b] of [['se', 'sw'], ['ne', 'nw']]) {
    if (!cases[a] || !cases[b]) continue;
    const v = Q.concorde(cases[b], T.miroir(cases[a], 128, 128), 128);
    controles.push({ id: 'P6_miroir', dir: b + '/' + a, valeur: Math.round(v * 1000) / 1000, seuil: Q.SEUILS.miroir, sens: '<=', n: 1 });
  }
  for (const c of controles) c.ok = c.valeur != null && (c.sens === '<=' ? c.valeur <= c.seuil : c.valeur >= c.seuil);
  M.ecrisPng({ w: BANDE.w, h: BANDE.h, data: B }, sortie);
  fiche.controles = controles;
  fiche.verdict = controles.every((c) => c.ok) ? 'ok' : 'a_revoir';
  fiche.sha256 = crypto.createHash('sha256').update(fs.readFileSync(sortie)).digest('hex');
  return fiche;
}

if (require.main === module) {
  const [e, s] = process.argv.slice(2);
  if (!e || !s) { console.error('usage : compose.js <openai.png> <sortie.png>'); process.exit(2); }
  compose(e, s).then((f) => { console.log(JSON.stringify(f, null, 1)); process.exit(f.verdict === 'ok' ? 0 : 3); }).catch((x) => { console.error(x.message); process.exit(1); });
}

module.exports = { compose, BANDE };
