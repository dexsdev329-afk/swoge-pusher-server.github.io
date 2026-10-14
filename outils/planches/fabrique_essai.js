'use strict';
/* ==========================================================================
 * PLANCHES — FAUX CLIPS POUR LES ESSAIS (gratuits, deterministes)
 *
 * Le mannequin (guide.js) anime sur fond magenta, encode en H.264 yuv420p a
 * 24 i/s par ffmpeg — comme un vrai clip : sous-echantillonnage de la couleur,
 * franges au bord, compression. La pose de repos est ecrite a part (la bande
 * que la chaine recoit avec les clips). Un defaut par controle se fabrique
 * sur demande (guide.clipFaux).
 *
 *   node outils/planches/fabrique_essai.js <dossier> [walk,idle,...] [defaut]
 * ======================================================================== */
const path = require('path');
const G = require('./guide');
const M = require('./media');

const DUREES = { idle: 2, walk: 3, run: 3, attack: 2, jump: 2 };

/* 960 x 384 : une bande 5:2 aux multiples de 16 (H.264) ; un emplacement fait
   240 x 384 et le corps ~154 px — au-dessus des 128 px de la case finale. */
async function fabrique({ dossier, actions, defauts, w, h, fps, pose, palette }) {
  w = w || 960; h = h || 384; fps = fps || 24; actions = actions || G.ACTIONS;
  const out = { pose: path.join(dossier, 'pose.png'), clips: [] };
  /* palette : 'perso' (droite et gauche de couleurs differentes) ou 'sym' (un vrai monstre) */
  if (pose !== false) M.ecrisPng(G.bandePose(2000, 800, null, null, palette), out.pose);
  for (const action of actions) {
    const F = G.clipFaux({ action, w, h, fps, duree: DUREES[action], defauts: Object.assign({ palette }, (defauts || {})[action] || {}) });
    const f = path.join(dossier, action + '.mp4');
    await M.ecrisMp4(F, w, h, fps, f);
    out.clips.push({ action, fichier: f, mode: 'bande' });
  }
  return out;
}

if (require.main === module) {
  const [dossier, liste, defaut] = process.argv.slice(2);
  if (!dossier) { console.error('usage : fabrique_essai.js <dossier> [actions] [defaut]'); process.exit(2); }
  const actions = liste ? liste.split(',') : G.ACTIONS;
  const defauts = {}; if (defaut) for (const a of actions) defauts[a] = { [defaut]: true };
  fabrique({ dossier, actions, defauts }).then((o) => console.log(JSON.stringify(o))).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { fabrique, DUREES };
