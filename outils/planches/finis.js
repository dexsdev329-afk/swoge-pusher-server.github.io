'use strict';
/* ==========================================================================
 * PLANCHES — LA FINITION EN LIGNE DE COMMANDE (ici ou sur le serveur)
 *
 *   node outils/planches/finis.js --nom pirate --pose pose.png --sortie <dossier> \
 *        --clip idle=idle.mp4 --clip walk=walk.mp4 --clip attack=attack.mp4 \
 *        [--clip walk:d:se=walk_se.mp4:pose_se.png] [--cle magenta] [--ancienne skeleton.webp] [--index] [--sans-hd]
 *
 * --sans-hd : la planche du jeu seulement (cases de 256, 8 images), pas la HD.
 *
 * Ecrit <sortie>/<nom>/<action>.webp et <sortie>/<nom>.json, imprime la fiche.
 * Code de sortie 0 si la planche passe tous les controles, 3 sinon (la planche
 * est quand meme ecrite : le proprietaire la juge sur sprite_lab.html).
 * Gratuit : aucun appel exterieur.
 * ======================================================================== */
const path = require('path');
const { finis, indexe } = require('./chaine');

function args(v) {
  const o = { clips: [] };
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    if (a === '--clip') {
      const [g, d] = v[++i].split('='); const [action, mode, dir] = g.split(':');
      const [fichier, pose] = d.split(':');
      o.clips.push({ action, fichier: path.resolve(fichier), mode: mode || 'bande', dir: dir || null, pose: pose ? path.resolve(pose) : null });
    } else if (a === '--index') o.index = true;
    else if (a === '--sans-hd') o.sansHd = true;
    else if (a.startsWith('--')) o[a.slice(2)] = v[++i];
  }
  return o;
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  if (!o.nom || !/^[a-z_0-9]{1,32}$/.test(o.nom) || !o.sortie || !o.clips.length) {
    console.error('usage : finis.js --nom <nom> --pose <png> --sortie <dossier> --clip <action>=<mp4> ...'); process.exit(2);
  }
  finis({ nom: o.nom, pose: o.pose && path.resolve(o.pose), clips: o.clips, sortie: path.resolve(o.sortie), cle: o.cle || 'magenta', ancienne: o.ancienne ? path.resolve(o.ancienne) : null,
          coutUsd: o.cout == null ? null : Number(o.cout), hd: o.sansHd ? false : undefined })
    .then((f) => { if (o.index) indexe(path.resolve(o.sortie)); console.log(JSON.stringify(f)); process.exit(f.qc.verdict === 'ok' ? 0 : 3); })
    .catch((e) => { console.error('finition : ' + (e && e.message || e)); process.exit(1); });
}

module.exports = { args };
