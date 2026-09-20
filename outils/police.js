'use strict';
/* ==========================================================================
 * L ATLAS DE GLYPHES — RENDU UNE FOIS, JAMAIS EN PRODUCTION
 *
 *   node outils/police.js
 *
 * Le serveur doit ecrire du texte dans une image sans aucune dependance. Une
 * police bitmap tapee a la main serait laide a cote de la carte que le
 * navigateur dessine ; embarquer un moteur de rendu ramenerait un binaire
 * natif, ce que ce depot refuse.
 *
 * On rend donc les glyphes UNE FOIS avec un vrai moteur — Playwright, qui est
 * deja la pour les essais de page — et on garde leurs OPACITES. Le serveur
 * n a plus qu a les recopier en les teintant : la typographie est celle du
 * site, et il n y a rien a installer.
 *
 * L atlas est deflate et range dans `police_scan.json`, a la racine. Il est
 * commite : un fichier qu il faut regenerer pour demarrer est un fichier
 * qu on oublie de regenerer.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const zlib = require('zlib');

/* Ce qu une carte de scan peut contenir : le nom d un jeton, des chiffres,
   des phrases anglaises, une adresse. Pas d accents — le texte montre aux
   joueurs est en anglais, et un glyphe qu on n ecrit jamais est du poids
   pour rien. */
const CARACTERES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                 + ' .,:;!?%+-_/()[]\'"#$&@×·…°=<>*';
const TAILLE = 96;          /* rendu grand, reduit a l usage : les petites tailles restent nettes */

(async () => {
  const nav = await chromium.launch();
  const page = await nav.newPage({ viewport: { width: 2048, height: 2048 }, deviceScaleFactor: 1 });
  /* ---- LA POLICE DU SITE, PAS CELLE DU SYSTEME ----
   * Sans cette page, `document.fonts.load('Outfit')` retombe en silence sur
   * la police du systeme : l atlas se genere, il a l air correct, et la carte
   * ne ressemble a rien de ce que le site affiche. Il faut donc la CHARGER,
   * et verifier qu elle est bien arrivee avant de mesurer quoi que ce soit. */
  await page.setContent('<!doctype html><meta charset="utf-8">'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;800&display=block">'
    + '<body style="font-family:Outfit">Outfit</body>', { waitUntil: 'networkidle' });
  const dispo = await page.evaluate(async () => {
    await document.fonts.load('800 96px Outfit');
    await document.fonts.load('600 96px Outfit');
    await document.fonts.ready;
    return document.fonts.check('800 96px Outfit');
  });
  if (!dispo) { await nav.close(); throw new Error('Outfit n a pas ete chargee : l atlas serait celui du systeme'); }
  console.log('Outfit chargee');

  /* Deux graisses : le chiffre en gras, la legende en maigre. C est tout ce
     que la carte utilise — en ajouter une troisieme doublerait le fichier
     pour un usage qui n existe pas. */
  const rendu = await page.evaluate(async ({ CARACTERES, TAILLE }) => {
    await document.fonts.load('800 ' + TAILLE + 'px Outfit');
    await document.fonts.load('600 ' + TAILLE + 'px Outfit');
    await document.fonts.ready;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const par = [];
    /* Une premiere passe pour mesurer, une seconde pour dessiner : on ne
       devine pas la taille de l atlas, on la calcule. */
    const marge = 3;
    let x = 0, y = 0, hLigne = 0, L = 2048;
    for (const gras of [false, true]) {
      g.font = (gras ? '800 ' : '600 ') + TAILLE + 'px Outfit, system-ui, sans-serif';
      for (const ch of CARACTERES) {
        const m = g.measureText(ch);
        const gauche = Math.ceil(m.actualBoundingBoxLeft) + marge;
        const droite = Math.ceil(m.actualBoundingBoxRight) + marge;
        const haut = Math.ceil(m.actualBoundingBoxAscent) + marge;
        const bas = Math.ceil(m.actualBoundingBoxDescent) + marge;
        const w = Math.max(1, gauche + droite), h = Math.max(1, haut + bas);
        if (x + w > L) { x = 0; y += hLigne; hLigne = 0; }
        par.push({ cle: (gras ? 'b' : 'r') + ch, ch, gras, ax: x, ay: y, w, h,
                   x: -gauche, y: -haut, av: m.width });
        x += w; if (h > hLigne) hLigne = h;
      }
    }
    const H = y + hLigne;
    c.width = L; c.height = H;
    const g2 = c.getContext('2d');
    g2.clearRect(0, 0, L, H);
    g2.fillStyle = '#fff'; g2.textBaseline = 'alphabetic'; g2.textAlign = 'left';
    for (const p of par) {
      g2.font = (p.gras ? '800 ' : '600 ') + TAILLE + 'px Outfit, system-ui, sans-serif';
      g2.fillText(p.ch, p.ax - p.x, p.ay - p.y);
    }
    const d = g2.getImageData(0, 0, L, H).data;
    /* On ne garde que l opacite : les glyphes sont blancs, la couleur est
       posee au moment de l ecriture. Quatre fois moins de donnees. */
    const a = new Uint8Array(L * H);
    for (let i = 0; i < L * H; i++) a[i] = d[i * 4 + 3];
    return { L, H, par, alpha: Array.from(a) };
  }, { CARACTERES, TAILLE });

  await nav.close();

  const glyphes = {};
  for (const p of rendu.par) glyphes[p.cle] = { ax: p.ax, ay: p.ay, w: p.w, h: p.h, x: p.x, y: p.y, av: p.av };
  const atlas = zlib.deflateSync(Buffer.from(rendu.alpha), { level: 9 });
  const sortie = { taille: TAILLE, l: rendu.L, h: rendu.H, glyphes, atlas: atlas.toString('base64') };
  const f = path.join(__dirname, '..', 'police_scan.json');
  fs.writeFileSync(f, JSON.stringify(sortie));
  console.log('atlas ' + rendu.L + '×' + rendu.H + ' · ' + Object.keys(glyphes).length + ' glyphes · '
              + Math.round(fs.statSync(f).size / 1024) + ' Ko sur le disque');
})();
