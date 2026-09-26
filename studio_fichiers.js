'use strict';
/* ==================================================================
 * SWOGE STUDIO — les images générées, rangées chez nous
 * ==================================================================
 *
 * OpenAI rend ses images en base64, jamais en adresse ; xAI rend des
 * adresses qui peuvent expirer. Renvoyer quatre images de plusieurs centaines
 * de ko dans chaque réponse, et les garder en mémoire pour la reprise après
 * rechargement, ne tient pas. On les écrit donc sur le volume
 * (`DATA_DIR/studio_media/`), sous un nom tiré au hasard (24 octets : il ne se
 * devine pas), et la page reçoit une adresse chez nous. Elles sont effacées
 * après GARDE_JOURS : la page propose de les télécharger.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const GARDE_JOURS = Math.max(1, Number(process.env.STUDIO_FICHIERS_JOURS || 7));
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const NOM = /^[0-9a-f]{48}\.(png|jpg|webp)$/;
const PREFIXE = '/studio/media/fichier/';

function dossier() { return path.join(cfg.DATA_DIR || process.env.DATA_DIR || '.', 'studio_media'); }

/** Range un data-URL d'image ; rend son adresse relative (chez nous). */
function range(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  fs.mkdirSync(dossier(), { recursive: true });
  const nom = crypto.randomBytes(24).toString('hex') + '.' + EXT[m[1]];
  fs.writeFileSync(path.join(dossier(), nom), Buffer.from(m[2], 'base64'));
  return PREFIXE + nom;
}

/** Le fichier demandé, ou null. Le nom est vérifié : rien ne sort du dossier. */
function lit(nom) {
  if (!NOM.test(String(nom || ''))) return null;
  try { return { octets: fs.readFileSync(path.join(dossier(), nom)), type: TYPE[nom.split('.').pop()] }; }
  catch (e) { return null; }
}

/** Efface ce qui a plus de GARDE_JOURS. */
function menage(maintenant) {
  const t = maintenant || Date.now();
  let n = 0;
  try {
    for (const f of fs.readdirSync(dossier())) {
      if (!NOM.test(f)) continue;
      const p = path.join(dossier(), f);
      if (t - fs.statSync(p).mtimeMs > GARDE_JOURS * 864e5) { fs.unlinkSync(p); n++; }
    }
  } catch (e) { /* pas encore de dossier */ }
  return n;
}

module.exports = { range, lit, menage, PREFIXE, GARDE_JOURS, dossier };
