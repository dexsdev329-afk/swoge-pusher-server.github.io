'use strict';
/* ==========================================================================
 * PLANCHES — LES MEMES MESURES SUR N'IMPORTE QUELLE PLANCHE (une grille commune)
 *
 * Revue du 13/10/2026 : « ne rien conclure sur la qualite avant la sonde ;
 * comparer sur une grille commune : les memes mesures sur les planches de
 * reference et sur les notres ». Cet outil lit une planche en grille (colonnes x
 * rangees de cases carrees), sans rien savoir de son origine, et rend pour
 * chaque case et pour la planche :
 *   - la hauteur de la figure en pixels (et en part de la case) : le detail
 *     qu'on aura a l'ecran ;
 *   - les cases ou la figure TOUCHE le bord (une arme coupee) ;
 *   - le halo (semi-transparents detaches), les miettes de detourage ;
 *   - la memoire decodee de la planche (Mo).
 * Lecture seule ; aucune image n'est ecrite, aucun appel exterieur.
 *
 *   node outils/planches/grille.js <planche.webp|png> <colonnes>x<rangees> [...]
 * ======================================================================== */
const M = require('./media');
const T = require('./traite');
const Q = require('./controles');

async function mesure(fichier, cols, rangs) {
  const im = await M.lisImage(fichier), C = Math.floor(im.w / cols);
  if (Math.floor(im.h / rangs) !== C) throw new Error('cases non carrees : ' + im.w + 'x' + im.h + ' pour ' + cols + 'x' + rangs);
  const cases = [];
  for (let r = 0; r < rangs; r++) for (let c = 0; c < cols; c++) {
    const d = new Uint8ClampedArray(C * C * 4);
    for (let y = 0; y < C; y++) d.set(im.data.subarray(((r * C + y) * im.w + c * C) * 4, ((r * C + y) * im.w + c * C + C) * 4), y * C * 4);
    const m = T.masque(d, C, C), b = T.bbox(m, C, C);
    if (!b) { cases.push({ r, c, vide: true }); continue; }
    let bord = false; for (let k = 0; k < C && !bord; k++) bord = m[k] || m[(C - 1) * C + k] || m[k * C] || m[k * C + C - 1];
    cases.push({ r, c, h: b.h, bord, halo: Q.halo(d, C), miettes: Q.composantes(m, C, C).miettes });
  }
  const pleines = cases.filter((x) => !x.vide), hs = pleines.map((x) => x.h).sort((a, b) => a - b);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    fichier, case: C, colonnes: cols, rangees: rangs, cases: cases.length, vides: cases.length - pleines.length,
    figure_px: { med: hs[hs.length >> 1], min: hs[0], max: hs[hs.length - 1] },
    figure_part_case: r3(hs[hs.length >> 1] / C),
    au_bord: pleines.filter((x) => x.bord).length,
    halo_max: r3(Math.max(...pleines.map((x) => x.halo))), cases_halo_03: pleines.filter((x) => x.halo > 0.03).length,
    miettes_max: r3(Math.max(...pleines.map((x) => x.miettes))),
    memoire_mo: Math.round(im.w * im.h * 4 / 1e5) / 10,
  };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length < 2 || a.length % 2) { console.error('usage : grille.js <planche> <colonnes>x<rangees> [<planche> <colonnes>x<rangees> ...]'); process.exit(2); }
  (async () => {
    for (let i = 0; i < a.length; i += 2) {
      const [c, r] = a[i + 1].split('x').map(Number);
      console.log(JSON.stringify(await mesure(a[i], c, r)));
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { mesure };
