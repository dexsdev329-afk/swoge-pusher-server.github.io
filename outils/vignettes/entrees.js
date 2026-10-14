#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * VIGNETTES DU STUDIO — LES IMAGES D'ENTREE, CADREES PAR NOUS (gratuit, local)
 *
 *   node outils/vignettes/entrees.js --site /chemin/du/SWOGE.github.io
 *
 * Lit img/site/studio/vignettes.json (dans le depot du site), et pour chaque
 * carte ecrit img/site/studio/vignettes/<carte>.jpg puis remplit `image` et
 * `sha256` dans le fichier. Le serveur (vignettes.js) n'envoie a xAI QUE ces
 * fichiers, verifies au sha256.
 *
 * Pourquoi un JPEG cadre a l'avance, et pas le webp de la carte :
 *   - le JPEG est le format qu'xAI a deja accepte en production comme image de
 *     depart d'une video (derniere_image.js, data:image/jpeg, depuis le 27/09) ;
 *     le webp n'a jamais ete envoye a xAI par nous (studio_media.js le laisse
 *     passer, aucune mesure) : on ne paie pas pour le decouvrir ;
 *   - le format demande (16:9, valeur de VideoAspectRatio dans la spec xAI
 *     relue le 26/09, studio_media.js FORMATS_VIDEO) est EXACTEMENT celui de
 *     l'image : rien a deviner sur ce qu'xAI ferait d'une image 3:2 ou 9:16
 *     (rogner, bandes, etirer) ;
 *   - la fenetre est prise avec la MEME regle que object-position dans la
 *     carte (depart = p x (taille - fenetre)) : dans la boite 2:1 du bureau, le
 *     clip pose avec la meme `pos` montre exactement la region de l'image fixe
 *     (calcul : p(H - 9W/16) + p(9W/16 - W/2) = p(H - W/2)) ;
 *   - le proprietaire voit ce qui partira AVANT de payer (fichiers publies).
 * Sortie 854x480 (480p 16:9), JPEG qualite ffmpeg 2.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LARGE = 854, HAUTE = 480, RAPPORT = 16 / 9;
const slug = (carte) => String(carte).replace(/:/g, '-');

/** La fenetre 16:9 dans une image L x H, placee comme object-position « px% py% ». */
function fenetre(L, H, pos) {
  const m = /^(\d{1,3})% (\d{1,3})%$/.exec(pos || '50% 0%') || [0, '50', '0'];
  const px = Math.min(100, Number(m[1])) / 100, py = Math.min(100, Number(m[2])) / 100;
  let w = L, h = Math.round(L / RAPPORT);
  if (h > H) { h = H; w = Math.round(H * RAPPORT); }
  return { w, h, x: Math.round(px * (L - w)), y: Math.round(py * (H - h)) };
}

function principal() {
  const i = process.argv.indexOf('--site');
  const site = i > 0 ? process.argv[i + 1] : null;
  if (!site) { console.error('usage: node outils/vignettes/entrees.js --site <site dir>'); process.exit(2); }
  const fJson = path.join(site, 'img/site/studio/vignettes.json');
  const j = JSON.parse(fs.readFileSync(fJson, 'utf8'));
  const dos = path.join(site, 'img/site/studio/vignettes');
  fs.mkdirSync(dos, { recursive: true });
  for (const liste of Object.values(j.lots)) {
    for (const e of liste) {
      const src = path.join(site, 'img/site', e.source);
      const [L, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]).toString().trim().split(',').map(Number);
      const f = fenetre(L, H, e.pos);
      const rel = 'studio/vignettes/' + slug(e.carte) + '.jpg';
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'crop=' + f.w + ':' + f.h + ':' + f.x + ':' + f.y + ',scale=' + LARGE + ':' + HAUTE + ':flags=lanczos',
        '-frames:v', '1', '-q:v', '2', path.join(site, 'img/site', rel)]);
      e.image = rel;
      e.sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(site, 'img/site', rel))).digest('hex');
      console.log(e.carte + '  ' + L + 'x' + H + ' -> ' + f.w + 'x' + f.h + '+' + f.x + '+' + f.y + '  ' + rel);
    }
  }
  fs.writeFileSync(fJson, JSON.stringify(j, null, 2) + '\n');
}

module.exports = { fenetre, slug };
if (require.main === module) principal();
