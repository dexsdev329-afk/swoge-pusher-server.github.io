'use strict';
/* ==========================================================================
 * LA DERNIERE IMAGE D'UNE VIDEO — POUR QUE LA SCENE SUIVANTE LA CONTINUE
 *
 * Le proprietaire, 27/09/2026, apres la serie de 20 h 30 : « la seule facon de
 * faire une suite de scenes, c'est de prendre la derniere seconde de l'image
 * pour avoir une suite, car les episodes 1/2/3/4 ne se suivent pas ». Mesure
 * sur ses deux episodes : un SWOGE torse nu devant des canettes dans un gym
 * neon, puis un SWOGE en kimono dans un dojo dont le corps vire au rouge —
 * decor, tenue et corps changent d'un episode a l'autre, parce que chacun
 * partait d'une image NEUVE.
 *
 * On fait donc ce qu'il faisait a la main : la derniere image de la video
 * precedente devient la PREMIERE image de la suivante. ffmpeg (Dockerfile) ;
 * s'il manque, ou si la video est expiree, on rend null et la scene part
 * comme avant (texte et references) — jamais une erreur pour le joueur.
 *
 * Seules les videos des fournisseurs sont lues (x.ai, klingai.com) : le
 * serveur ne telecharge pas une adresse venue d'un message.
 * ======================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const OCTETS_MAX = 80 * 1024 * 1024;
const HOTES = [/(^|\.)x\.ai$/i, /(^|\.)klingai\.com$/i];

function cree(deps) {
  deps = deps || {};
  const ffmpeg = deps.ffmpeg || 'ffmpeg';
  const hoteOk = deps.hoteOk || ((h) => HOTES.some((re) => re.test(h)));
  const chercher = deps.fetch || ((u) => fetch(u, { signal: AbortSignal.timeout(60000) }));
  const MESURE = { demandes: 0, rendues: 0, refus: 0, echecs: 0, dernierEchec: null };

  const echoue = (m) => { MESURE.echecs++; MESURE.dernierEchec = String(m).slice(0, 120); return null; };

  /** L'adresse d'une video → 'data:image/jpeg;base64,…' de sa derniere image, ou null. */
  async function derniere(url) {
    MESURE.demandes++;
    let u;
    try { u = new URL(String(url || '')); } catch (e) { MESURE.refus++; return null; }
    if (u.protocol !== 'https:' && !deps.httpPermis) { MESURE.refus++; return null; }
    if (!hoteOk(u.hostname)) { MESURE.refus++; return null; }
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'derniere-'));
    const video = path.join(dossier, 'v.mp4'), image = path.join(dossier, 'f.jpg');
    try {
      const r = await chercher(u.toString());
      if (!r.ok) return echoue('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      if (!b.length || b.length > OCTETS_MAX) return echoue('size ' + b.length);
      fs.writeFileSync(video, b);
      /* -sseof : on se place a 0,1 s de la fin et on garde UNE image. */
      await new Promise((res, rej) => execFile(ffmpeg, ['-v', 'error', '-y', '-sseof', '-0.1', '-i', video, '-frames:v', '1', '-q:v', '3', image],
        { timeout: 30000 }, (e) => (e ? rej(e) : res())));
      const j = fs.readFileSync(image);
      if (j.length < 100 || j[0] !== 0xff || j[1] !== 0xd8) return echoue('not a JPEG');
      MESURE.rendues++;
      return 'data:image/jpeg;base64,' + j.toString('base64');
    } catch (e) {
      return echoue((e && (e.code === 'ENOENT' ? 'ffmpeg missing' : e.message)) || e);
    } finally {
      try { fs.rmSync(dossier, { recursive: true, force: true }); } catch (e) { /* rien */ }
    }
  }
  return { derniere, MESURE };
}

module.exports = { cree, HOTES };
