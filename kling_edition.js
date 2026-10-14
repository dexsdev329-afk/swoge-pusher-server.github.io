'use strict';
/* ==========================================================================
 * KLING O1 — L'EDITION D'UN CLIP, ESSAI PROPRIETAIRE (14 octobre 2026)
 *
 * Demande du proprietaire, 14/10/2026 : remplacer UNE personne d'un clip court
 * par SWOGE (une image de reference), en gardant le son d'origine, pour
 * MESURER la qualite, l'attente et le cout reel avant de rien proposer aux
 * joueurs. L'appel lui-meme est dans kling.js (lanceEdition) ; ce module ne
 * tient que le clip :
 *   - Kling n'accepte une video que par URL (video-omni.md, lu le 14/10/2026) :
 *     le clip est ECRIT sous un nom tire au hasard (24 octets, 48 hexa), servi
 *     par ce nom tant que la tache est en cours, puis EFFACE des qu'elle
 *     reussit, echoue ou depasse le delai — comme essai_montage.js (c'est
 *     peut-etre l'extrait de quelqu'un). Au demarrage, tout reste est efface.
 *   - Avant tout envoi : taille (OCTETS_MAX), MP4 lisible, 3 a 10 s, 700 a
 *     2160 px de cote quand l'en-tete les donne (bornes de la doc), une edition
 *     a la fois par adresse.
 *   - Chaque edition laisse une ligne au journal kling_essais.jsonl a l'envoi
 *     (estimation d'apres la grille) et une a la fin (statut, `billing` lu).
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dureeMp4, enfants } = require('./essai_montage');
const K = require('./kling');

/* 20 Mo : un clip de 10 s en 1080p H.264 de telephone (~8-16 Mbit/s) tient
   dessous ; en base64 il en fait ~26,7, plus une reference de 6 Mo au plus
   (~8 en base64), sous le plafond de 36 Mo du corps de la route. Kling
   accepte 200 Mo, la borne est la notre (le corps JSON). */
const OCTETS_MAX = 20 * 1024 * 1024;
const IMAGE_OCTETS_MAX = 6 * 1024 * 1024;
const CORPS_MAX = 36 * 1024 * 1024;
const NOM = /^[0-9a-f]{48}\.mp4$/;
const VIDEO_PREFIXE = '/studio/kling-clip/';
/* La reference par defaut des editions Kling (clip et video entiere) : le
   « Swole Doge » choisi par le proprietaire le 14/10/2026 (shiba creme-beige,
   torse nu, muscles de culturiste ; pattes velues, griffes noires), JPEG
   832×1248, rapport 1:1,5, dans les bornes O1 (>= 300 px, 1:2,5 a 2,5:1).
   L'ancienne (img/site/swoge_reference.jpg, costume rouge) reste celle des
   autres usages (studio, Telegram). */
const REFERENCE_EDITION = '/img/site/swoge_swole_ref.jpg';
/* Et le VISAGE, en seconde reference (image_2) : le premier vrai resultat du
   proprietaire (14/10/2026) avait la mauvaise tete — un shiba orange realiste,
   gueule grande ouverte, pas le visage de SWOGE. Le visage officiel
   (img/site/ia/swoge_face.webp, 256 px) agrandi a 768×768 (lanczos, JPEG q 2) :
   >= 300 px, rapport 1:1, dans les bornes O1. */
const REFERENCE_VISAGE = '/img/site/swoge_face_ref.jpg';

/**
 * Largeur et hauteur de la premiere piste video d'un MP4 (moov > trak > tkhd),
 * ou null. tkhd v0 et v1 finissent tous deux par largeur puis hauteur en
 * virgule fixe 16.16 (ISO/IEC 14496-12) : on lit les 8 derniers octets.
 */
function dimensionsMp4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const haut = enfants(buf, 0, buf.length);
  const moov = haut && haut.find((b) => b.type === 'moov');
  const dans = moov && enfants(buf, moov.contenu, moov.fin);
  if (!dans) return null;
  for (const trak of dans.filter((b) => b.type === 'trak')) {
    const sous = enfants(buf, trak.contenu, trak.fin);
    const tkhd = sous && sous.find((b) => b.type === 'tkhd');
    if (!tkhd || tkhd.fin - tkhd.contenu < 84) continue;
    const l = buf.readUInt32BE(tkhd.fin - 8) >>> 16, h = buf.readUInt32BE(tkhd.fin - 4) >>> 16;
    if (l > 0 && h > 0) return { largeur: l, hauteur: h };
  }
  return null;
}

function cree({ dossier, kling, urlPublique, journal, imageDefaut, imagesDefaut, maintenant, pollMs, maxMs }) {
  /* sans image fournie : les references par defaut, dans l'ordre (corps = image_1, visage = image_2) */
  const DEFAUT = Array.isArray(imagesDefaut) && imagesDefaut.length ? imagesDefaut.slice(0, K.EDITION_IMAGES_MAX) : [imageDefaut];
  const temps = () => (maintenant ? maintenant() : Date.now());
  const POLL = pollMs != null ? Math.max(1, Number(pollMs)) : 10000;
  /* 20 min : une edition O1 de 10 s n'a pas encore de mesure d'attente ; le
     double des 10 min de nos videos Kling 2.6 les plus longues. */
  const MAX = maxMs != null ? Number(maxMs) : 20 * 60 * 1000;
  const note = (o) => { try { if (journal) journal(o); } catch (e) { /* jamais bloquant */ } };
  /* par nom de fichier : le job, servi tant qu'il est la */
  const EN_COURS = new Map();
  /* les taches Kling deja conclues ici (leur fin est au journal une seule fois) */
  const CONCLUES = new Set();
  try { for (const f of fs.readdirSync(dossier)) if (NOM.test(f)) fs.unlinkSync(path.join(dossier, f)); }
  catch (e) { /* pas encore de dossier */ }

  const efface = (job) => { try { fs.unlinkSync(path.join(dossier, job.nom)); } catch (e) { /* deja parti */ } EN_COURS.delete(job.nom); };
  const parTache = (id) => { for (const j of EN_COURS.values()) if (j.rid === String(id)) return j; return null; };

  /** La fin d'une tache (reussie, ratee, trop longue) : le clip part, une ligne au journal. */
  function conclut(id, e) {
    const job = parTache(id);
    if (!job) return false;
    efface(job);
    CONCLUES.add(job.rid);
    note({ id: job.rid, edition: true, statut: e.statut, duree: e.duree || null, message: e.message || null,
           facturation: e.facturation || null, secondes: Math.round((temps() - job.t) / 100) / 10 });
    return true;
  }

  /** Un pas de suivi en arriere-plan : le clip part meme si la page est fermee. */
  async function avance(job) {
    if (!EN_COURS.has(job.nom)) return;
    let e = null;
    try { e = await kling.etat(job.rid); } catch (x) { e = null; }
    if (!EN_COURS.has(job.nom)) return;
    if (e && e.ok && (e.statut === 'succeeded' || e.statut === 'failed')) conclut(job.rid, e);
    else if (temps() - job.t > MAX) conclut(job.rid, { statut: 'timeout', message: 'no answer from Kling after ' + Math.round(MAX / 60000) + ' min — the clip was deleted' });
  }
  function suit(job) {
    const tour = async () => { await avance(job); if (EN_COURS.has(job.nom)) setTimeout(tour, POLL).unref(); };
    setTimeout(tour, POLL).unref();
  }

  /**
   * Lance UNE edition pour `addr` (l'adresse de la SESSION, jamais un corps).
   * Controles dans l'ordre : adresse, taille, MP4, longueur, cotes, une a la
   * fois, Kling branche ; puis kling.lanceEdition refait les siens (texte, image).
   */
  async function lance({ addr, octets, image, prompt, resolution, audio }) {
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    const buf = Buffer.isBuffer(octets) ? octets : Buffer.alloc(0);
    if (!buf.length) return { ok: false, code: 400, raison: 'choose an MP4 clip first' };
    if (buf.length > OCTETS_MAX) return { ok: false, code: 413, raison: 'the clip is ' + (buf.length / 1048576).toFixed(1) + ' MB — ' + (OCTETS_MAX / 1048576) + ' MB max' };
    const d = dureeMp4(buf);
    if (d == null) return { ok: false, code: 400, raison: 'not an MP4 video (or its length could not be read)' };
    const { min, max } = K.EDITION_DUREE;
    if (d < min || d > max) return { ok: false, code: 400, raison: 'the clip is ' + d.toFixed(2) + ' s long — Kling edits ' + min + ' to ' + max + ' s' };
    const dim = dimensionsMp4(buf);
    const C = K.EDITION_COTE;
    if (dim && (Math.min(dim.largeur, dim.hauteur) < C.min || Math.max(dim.largeur, dim.hauteur) > C.max)) {
      return { ok: false, code: 400, raison: 'the clip is ' + dim.largeur + '×' + dim.hauteur + ' px — Kling needs ' + C.min + ' to ' + C.max + ' px on each side' };
    }
    if (image != null && image !== '' && !/^https:\/\//i.test(String(image)) && Buffer.byteLength(String(image)) > Math.ceil(IMAGE_OCTETS_MAX * 4 / 3) + 64) {
      return { ok: false, code: 413, raison: 'the reference picture is too large (' + (IMAGE_OCTETS_MAX / 1048576) + ' MB max)' };
    }
    for (const j of EN_COURS.values()) if (j.addr === addr) return { ok: false, code: 429, raison: 'one edit at a time — wait for the current one' };
    if (!kling.actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const nom = crypto.randomBytes(24).toString('hex') + '.mp4';
    try { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(path.join(dossier, nom), buf); }
    catch (e) { console.error('[kling-edition] ' + e.message); return { ok: false, code: 500, raison: 'the server could not store the clip' }; }
    /* Pose AVANT l'appel : Kling peut lire le clip pendant la requete. */
    const job = { nom, addr, t: temps(), rid: null };
    EN_COURS.set(nom, job);
    const parDefaut = image == null || image === '';
    let r;
    try {
      r = await kling.lanceEdition(Object.assign({ videoUrl: urlPublique(nom), prompt, resolution, audio, dureeS: d }, parDefaut ? { images: DEFAUT } : { image }));
    } catch (e) { r = { ok: false, code: 502, raison: 'Kling refused: ' + (e && e.message) }; }
    if (!r || !r.ok) { efface(job); return r || { ok: false, code: 502, raison: 'Kling refused' }; }
    job.rid = r.id;
    note({ id: r.id, edition: true, modele: r.modele, dureeS: r.dureeS, resolution: r.resolution, audio: r.audio,
           image: parDefaut ? 'swoge' : r.image, octets: buf.length, cotes: dim ? dim.largeur + 'x' + dim.hauteur : null, estimationUsd: r.estimationUsd });
    suit(job);
    return Object.assign({}, r, { reference: parDefaut ? 'swoge' : 'upload' });
  }

  /** Le clip d'une edition EN COURS, par son nom (48 hexa) : rien d'autre ne sort. */
  function fichier(nom) {
    const n = String(nom || '');
    if (!NOM.test(n) || !EN_COURS.has(n)) return null;
    try { return { octets: fs.readFileSync(path.join(dossier, n)), type: 'video/mp4' }; }
    catch (e) { return null; }
  }

  /** Ce que la page lit : les bornes et la grille. */
  function vue(addr) {
    return { modele: K.EDITION_MODELE, prixParSeconde: K.EDITION_PRIX, dureeMinS: K.EDITION_DUREE.min, dureeMaxS: K.EDITION_DUREE.max,
             octetsMax: OCTETS_MAX, imageOctetsMax: IMAGE_OCTETS_MAX, enCours: [...EN_COURS.values()].filter((j) => j.addr === addr && j.rid).map((j) => j.rid) };
  }

  return { lance, conclut, connue: (id) => CONCLUES.has(String(id)) || !!parTache(id), fichier, vue, avance, EN_COURS };
}

module.exports = { cree, dimensionsMp4, OCTETS_MAX, IMAGE_OCTETS_MAX, CORPS_MAX, NOM, VIDEO_PREFIXE, REFERENCE_EDITION, REFERENCE_VISAGE };
