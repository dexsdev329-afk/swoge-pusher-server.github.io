'use strict';
/* LE PIPELINE : DE LA VIDEO AUX GRILLES, ET RETOUR
 *
 * Une video d'animation devient du live-action en passant par des grilles :
 * seize images assemblees en une seule, un appel au modele, puis on redecoupe.
 * Une grille = un appel = un cout. C'est toute l'economie de ce service, et
 * c'est pourquoi une grille deja stylisee sur le disque n'est JAMAIS refaite —
 * la refaire, ce serait la repayer.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp');

/* ---- OU SONT LES BINAIRES ----
 * Sur Railway ils viennent de `nixpacks.toml` et sont sur le PATH. Ailleurs —
 * une machine de developpement, un conteneur minimal — ils peuvent etre
 * n'importe ou. Les rendre configurables coute deux lignes et evite qu'un
 * service parfaitement sain refuse de demarrer parce qu'il cherche au mauvais
 * endroit. */
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

/* ---- LANCER UN OUTIL, ET SAVOIR POURQUOI IL A ECHOUE ----
 * `ffmpeg` ecrit tout sur stderr, y compris quand tout va bien. On garde la
 * fin de ce flux : c'est la seule chose qui explique un echec, et la jeter
 * laisserait « ffmpeg a echoue » comme unique diagnostic. */
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts || {});
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-200000); });
    /* ---- « ENOENT » NE DIT RIEN A CELUI QUI DEPLOIE ----
     * C'est l'erreur qu'on obtient quand ffmpeg n'est pas installe, et elle
     * ressemble a un bug du service. Elle nomme donc ce qui manque et ou le
     * declarer — c'est la panne de deploiement la plus probable de tout ce
     * projet. */
    p.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        return reject(new Error('« ' + cmd + ' » est introuvable. Ce service en a besoin : '
          + 'sur Railway il vient de `nixpacks.toml` (aptPkgs = ["ffmpeg"]), qui fournit '
          + 'ffmpeg ET ffprobe. Ailleurs, pointez FFMPEG_BIN / FFPROBE_BIN sur les binaires.'));
      }
      reject(e);
    });
    p.on('close', (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(cmd + ' a rendu ' + code + ' : ' + err.slice(-800)));
    });
  });
}

/* fps, largeur, hauteur, duree. Rien n'est suppose : une video verticale, une
   frequence a 23,976 ou un flux sans audio doivent tous se lire ici. */
async function sonde(fichier) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', fichier]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('Ce fichier ne contient aucune piste video.');
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '25/1').split('/');
  const fps = (Number(d) > 0) ? Number(n) / Number(d) : Number(n);
  return {
    fps: (isFinite(fps) && fps > 0) ? fps : 25,
    largeur: Number(v.width) || 0,
    hauteur: Number(v.height) || 0,
    duree: Number((j.format || {}).duration) || 0,
    audio: (j.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

/* `-vsync 0` : une image extraite par image du fichier, sans duplication ni
   suppression. Sans lui, ffmpeg re-cadence sur le fps demande et le nombre de
   frames extraites ne correspond plus a la video — le remontage decale. */
async function extraitFrames(entree, dossier) {
  await fsp.mkdir(dossier, { recursive: true });
  await run(FFMPEG, ['-v', 'error', '-i', entree, '-vsync', '0',
    path.join(dossier, 'f_%06d.png')]);
  const l = (await fsp.readdir(dossier)).filter((f) => /^f_\d+\.png$/.test(f)).sort();
  if (!l.length) throw new Error('Aucune image n\'a pu etre extraite de cette video.');
  return l;
}

/* ---- LA DERNIERE GRILLE EST COMPLETEE, PAS TROUEE ----
 * Une grille de seize cases dont quatre sont noires apprend au modele que le
 * noir fait partie du style, et il le rend. On repete la derniere image : elle
 * sera stylisee pour rien, mais elle ne ment pas sur ce qu'est la scene. */
async function composeGrille(frames, dossierFrames, sortie, n, cote) {
  const cases = frames.slice();
  while (cases.length < n * n) cases.push(cases[cases.length - 1]);
  const tuiles = [];
  for (let i = 0; i < n * n; i++) {
    const buf = await sharp(path.join(dossierFrames, cases[i]))
      .resize(cote, cote, { fit: 'fill' }).png().toBuffer();
    tuiles.push({ input: buf, left: (i % n) * cote, top: Math.floor(i / n) * cote });
  }
  await sharp({ create: { width: cote * n, height: cote * n, channels: 3,
                          background: { r: 0, g: 0, b: 0 } } })
    .composite(tuiles).png().toFile(sortie);
}

/* Le redecoupage. On repasse chaque case a la taille d'origine : le modele
   rend la grille a SA resolution, qui n'est pas forcement celle qu'on a
   envoyee. */
async function decoupeGrille(grille, dossier, prefixe, n, largeur, hauteur, combien) {
  const meta = await sharp(grille).metadata();
  const cw = Math.floor(meta.width / n), chh = Math.floor(meta.height / n);
  const out = [];
  for (let i = 0; i < combien; i++) {
    const f = path.join(dossier, prefixe + String(i).padStart(6, '0') + '.png');
    await sharp(grille)
      .extract({ left: (i % n) * cw, top: Math.floor(i / n) * chh, width: cw, height: chh })
      .resize(largeur, hauteur, { fit: 'fill' })
      .png().toFile(f);
    out.push(f);
  }
  return out;
}

/* ---- LE REMONTAGE, AVEC L'AUDIO D'ORIGINE ----
 * L'audio vient de l'entree 1 — le fichier source — et non des images. `-shortest`
 * evite qu'une piste audio plus longue que la video n'etire le resultat.
 * `crf 16` : on vient de payer un appel par grille, ce n'est pas le moment de
 * detruire le resultat a la compression. */
async function remonte(dossierRendu, fps, source, sortie, avecAudio) {
  const args = ['-v', 'error', '-y', '-framerate', String(fps),
                '-i', path.join(dossierRendu, 'r_%06d.png')];
  if (avecAudio) args.push('-i', source);
  args.push('-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p');
  if (avecAudio) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-shortest');
  args.push(sortie);
  await run(FFMPEG, args);
}

module.exports = { run, sonde, FFMPEG, FFPROBE, extraitFrames, composeGrille, decoupeGrille, remonte };
