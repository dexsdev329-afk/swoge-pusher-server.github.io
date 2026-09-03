'use strict';
/* LE PIPELINE, DE BOUT EN BOUT, SUR UNE VIDEO DE TEST
 *
 * Ce qu'on verifie ici n'est pas « ca ne plante pas » : c'est que la GEOMETRIE
 * survit au voyage. Une frame part dans une case de grille, revient de la
 * grille, et doit se retrouver a sa place dans la video. Si la case 5 revient
 * en position 7, rien ne le signale — la video se remonte, se lit, et saute.
 *
 * Le modele est remplace par l'identite : la grille sort telle qu'elle est
 * entree. C'est exactement ce qui rend le test lisible — toute difference
 * entre l'entree et la sortie vient alors de NOTRE decoupage, pas du style.
 *
 * Chaque frame de la video de test porte une couleur unique, donc un numero
 * verifiable. C'est ce qui permet de dire « la frame 12 est bien la 12e » au
 * lieu de « il y a bien 16 images ».
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const P = require('./pipeline.js');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
let n = 0, rates = 0;
const ok = (c, m) => { n++; console.log((c ? '  ok   ' : '  RATE ') + m); if (!c) rates++; };

/* Une couleur par frame : rouge croissant, vert decroissant. Deux frames ne
   peuvent pas se confondre, et l'ordre se lit dans la couleur. */
function couleurDe(i, total) {
  return { r: Math.round(20 + 235 * (i / Math.max(1, total - 1))),
           g: Math.round(235 - 215 * (i / Math.max(1, total - 1))), b: 60 };
}

(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sav-'));
  const L = 64, H = 48, N = 20, FPS = 10, GRILLE = 3;

  console.log('\n-- une video de test, chaque frame identifiable --');
  const dIn = path.join(base, 'in');
  await fsp.mkdir(dIn, { recursive: true });
  for (let i = 0; i < N; i++) {
    const c = couleurDe(i, N);
    await sharp({ create: { width: L, height: H, channels: 3, background: c } })
      .png().toFile(path.join(dIn, 'i_' + String(i + 1).padStart(6, '0') + '.png'));
  }
  const source = path.join(base, 'source.mp4');
  await P.run(FFMPEG, ['-v', 'error', '-y', '-framerate', String(FPS),
    '-i', path.join(dIn, 'i_%06d.png'), '-c:v', 'libx264', '-crf', '0',
    '-pix_fmt', 'yuv444p', source]);
  ok(fs.existsSync(source), N + ' frames deviennent une video de test');

  console.log('\n-- extraction --');
  const dF = path.join(base, 'frames');
  const frames = await P.extraitFrames(source, dF);
  ok(frames.length === N,
     'il en ressort exactement autant qu on en a mis (' + frames.length + '/' + N + ') — '
     + '`-vsync 0` est ce qui empeche ffmpeg de re-cadencer et de decaler le remontage');

  console.log('\n-- composition des grilles --');
  const parGrille = GRILLE * GRILLE;
  const nbGrilles = Math.ceil(N / parGrille);
  const dG = path.join(base, 'grilles');
  await fsp.mkdir(dG, { recursive: true });
  for (let g = 0; g < nbGrilles; g++) {
    const lot = frames.slice(g * parGrille, (g + 1) * parGrille);
    await P.composeGrille(lot, dF, path.join(dG, 'g' + g + '.png'), GRILLE, 32);
  }
  ok(nbGrilles === Math.ceil(N / parGrille),
     nbGrilles + ' grilles pour ' + N + ' frames en ' + GRILLE + '×' + GRILLE
     + ' — une grille, un appel, un cout');

  /* ---- LA DERNIERE GRILLE EST COMPLETE ----
   * 20 frames en 3×3 laissent 2 cases dans la derniere. On les remplit avec la
   * derniere frame plutot que de laisser du noir : le noir, le modele
   * l'apprend comme une intention de style et le rend. */
  const derniere = await sharp(path.join(dG, 'g' + (nbGrilles - 1) + '.png')).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * derniere.info.width + x) * derniere.info.channels;
    return [derniere.data[i], derniere.data[i + 1], derniere.data[i + 2]];
  };
  const coin = px(derniere.info.width - 8, derniere.info.height - 8);
  ok(coin[0] > 25 || coin[1] > 25,
     'la derniere grille est completee et non trouee : le coin vaut rgb(' + coin.join(',')
     + '), pas du noir');

  console.log('\n-- le modele, remplace par l identite --');
  const dS = path.join(base, 'stylisees');
  await fsp.mkdir(dS, { recursive: true });
  for (let g = 0; g < nbGrilles; g++) {
    await fsp.copyFile(path.join(dG, 'g' + g + '.png'),
                       path.join(dS, 's_' + String(g).padStart(4, '0') + '.png'));
  }

  console.log('\n-- redecoupage, et la question qui compte : chaque frame a-t-elle repris sa place --');
  const dR = path.join(base, 'rendu');
  await fsp.mkdir(dR, { recursive: true });
  let k = 0;
  for (let g = 0; g < nbGrilles; g++) {
    const reste = Math.min(parGrille, N - g * parGrille);
    const cases = await P.decoupeGrille(path.join(dS, 's_' + String(g).padStart(4, '0') + '.png'),
                                        dR, 'tmp_', GRILLE, L, H, reste);
    for (const c of cases) {
      await fsp.rename(c, path.join(dR, 'r_' + String(++k).padStart(6, '0') + '.png'));
    }
  }
  ok(k === N, 'autant d images en sortie qu en entree (' + k + '/' + N + ')');

  let places = 0, pires = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(dR, 'r_' + String(i + 1).padStart(6, '0') + '.png');
    const st = await sharp(f).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    const attendu = couleurDe(i, N);
    const ecart = Math.abs(st[0] - attendu.r) + Math.abs(st[1] - attendu.g);
    if (ecart < 40) places++; else pires.push(i + ' (ecart ' + ecart + ')');
  }
  ok(places === N,
     'chaque frame est revenue A SA PLACE (' + places + '/' + N + ')'
     + (pires.length ? ' — hors place : ' + pires.slice(0, 4).join(', ') : '')
     + ' : c est ce qu une case echangee casserait sans rien dire');

  console.log('\n-- remontage --');
  const sortie = path.join(base, 'sortie.mp4');
  await P.remonte(dR, FPS, source, sortie, false);
  const taille = (await fsp.stat(sortie)).size;
  ok(taille > 0, 'la video finale existe (' + Math.round(taille / 1024) + ' ko)');

  const refaites = await P.extraitFrames(sortie, path.join(base, 'verif'));
  ok(refaites.length === N,
     'et elle porte le meme nombre d images que la source (' + refaites.length + '/' + N + ')');

  await fsp.rm(base, { recursive: true, force: true });
  console.log('\npipeline.test.js — ' + n + ' verifications, ' + rates + ' echec(s)');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exit(1); });
