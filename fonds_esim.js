'use strict';
/* ==================================================================
 * LES IMAGES DE FOND DE LA PAGE eSIM (29 septembre 2026)
 * ==================================================================
 *
 * Demande du proprietaire : « generer des images pour decorer le fond de la
 * page eSIM — Kling, on a encore beaucoup de jetons ». TROIS images, faites
 * UNE fois par Kling Image 3.0 (0,028 $ l'une, grille lue le 27/09 : 0,084 $ en
 * tout), gardees dans DATA_DIR/fonds_esim et servies par /esim/fond/<n>.jpg.
 * Une image deja la n'est jamais refaite ; un echec est retente au prochain
 * demarrage, jamais en boucle. Aucun texte ni logo dans les images (consigne).
 * ================================================================== */
const fs = require('fs');
const path = require('path');

const CONSIGNE = 'No text, no letters, no logos, no watermark, no people facing the camera. Bright, airy, premium travel photography, soft natural light, calm composition with empty space in the middle.';
const IMAGES = [
  'Aerial view from an airplane window of a turquoise coastline and white clouds at golden hour, pale blue sky. ' + CONSIGNE,
  'A traveller\'s desk seen from above: an open paper world map, a passport, sunglasses and a smartphone, pastel blue and cream tones, shallow depth of field. ' + CONSIGNE,
  'A quiet city street at dusk in a European old town seen from a hill, warm lights turning on, soft blue hour sky, gentle haze. ' + CONSIGNE,
];

/** deps : { kling (kling.js : actif(), image(q)), dossier, telecharge?(url) → Buffer, journal?(texte) } */
function cree(deps) {
  const dossier = path.join(deps.dossier, 'fonds_esim');
  const fichier = (i) => path.join(dossier, (i + 1) + '.jpg');
  const journal = deps.journal || (() => {});
  const telecharge = deps.telecharge || (async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  });
  const MESURE = { faites: 0, echecs: 0, depenseUsd: 0 };
  let enCours = null;

  /** Fait les images qui manquent, une a la fois. Rend { faites, manquantes }. */
  function prepare() {
    if (enCours) return enCours;
    enCours = (async () => {
      if (!deps.kling || !deps.kling.actif()) return { faites: 0, manquantes: IMAGES.length, raison: 'Kling is not set up' };
      fs.mkdirSync(dossier, { recursive: true });
      let faites = 0;
      for (let i = 0; i < IMAGES.length; i++) {
        if (fs.existsSync(fichier(i))) continue;
        const r = await deps.kling.image({ prompt: IMAGES[i], format: '16:9', resolution: '2k' }).catch((e) => ({ ok: false, raison: String(e && e.message || e) }));
        if (!r || !r.ok || !r.url) { MESURE.echecs++; journal('[esim] background ' + (i + 1) + ' not made: ' + String((r && r.raison) || 'no picture').slice(0, 120)); continue; }
        MESURE.depenseUsd += Number(r.estimationUsd) || 0.028;
        try {
          const b = await telecharge(r.url);
          if (!b || b.length < 10000 || b[0] !== 0xff && b[0] !== 0x89) throw new Error('not a picture');
          fs.writeFileSync(fichier(i) + '.tmp', b); fs.renameSync(fichier(i) + '.tmp', fichier(i));
          faites++; MESURE.faites++;
        } catch (e) { MESURE.echecs++; journal('[esim] background ' + (i + 1) + ' not saved: ' + String(e && e.message || e).slice(0, 120)); }
      }
      return { faites, manquantes: IMAGES.filter((x, i) => !fs.existsSync(fichier(i))).length };
    })().finally(() => { enCours = null; });
    return enCours;
  }

  /** Une image par son numero (1 a 3) : Buffer ou null. */
  function lis(n) {
    const i = Number(n) - 1;
    if (!(i >= 0 && i < IMAGES.length) || !Number.isInteger(i)) return null;
    try { return fs.readFileSync(fichier(i)); } catch (e) { return null; }
  }
  const liste = () => IMAGES.map((x, i) => (fs.existsSync(fichier(i)) ? i + 1 : null)).filter(Boolean);

  return { prepare, lis, liste, MESURE, IMAGES };
}

module.exports = { cree, IMAGES };
