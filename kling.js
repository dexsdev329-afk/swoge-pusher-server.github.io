'use strict';
/* ==========================================================================
 * KLING (Kuaishou) — VIDEO, EN ESSAI PROPRIETAIRE D'ABORD
 *
 * Demande du proprietaire, 27 septembre 2026 : « Kling, envoie les liens, je
 * recupere l'API, cree le module ». Meme demarche que l'essai de restylage xAI
 * (essai_montage.js) : AVANT de proposer Kling aux joueurs, le proprietaire
 * tourne quelques videos pour mesurer la qualite, l'attente et le cout reel.
 *
 * ---- CE QUI A ETE LU DANS LA DOCUMENTATION OFFICIELLE (27/09/2026) ----
 * kling.ai/document-api (index llms.txt) :
 *   domaine        https://api-singapore.klingai.com (l'ancien api.klingai.com
 *                  est remplace pour les serveurs hors de Chine)
 *   cle            « API Key », en-tete Authorization: Bearer <cle> ; les paires
 *                  AccessKey/SecretKey (JWT) ne valent que pour l'ancien standard
 *                  (le modele dans `model_name`) — la video est au nouveau
 *                  standard (le modele dans le chemin).
 *   creer          POST /text-to-video/<modele> ou /image-to-video/<modele>
 *                  { contents: [{type:'prompt',text}, {type:'first_frame',url}],
 *                    settings: {resolution, duration, audio}, options: {external_task_id} }
 *                  → { code: 0, data: { id, status } }
 *   suivre         GET /tasks?task_ids=<id> → data[0] { status: submitted |
 *                  processing | succeeded | failed, message, outputs[{type:'video',url,duration}] }
 *                  (les resultats sont effaces apres 30 jours)
 *   limites        texte 2 500 caracteres ; image >= 300 px, rapport 1:2,5 a 2,5:1, <= 50 Mo
 *   prix (grille « Video », par seconde) :
 *     kling-2.6        720p sans son 0,042 $ ; 1080p sans son 0,07 $ ; 1080p son natif 0,14 $ ; 5 ou 10 s
 *     kling-3.0-turbo  son natif toujours : 720p 0,112 $ ; 1080p 0,14 $ ; 3 a 15 s
 *   Pour comparer : la video Grok « Qualite » de SwoleMind se vend ~0,11 $/s marge comprise.
 *
 * ---- L'IMAGE (lu le 27/09/2026, api/image/3-0-omni/image-generation.md) ----
 *   Le proprietaire a pris le plan video ET image. L'image est a l'ANCIEN
 *   standard (le modele dans le corps), meme cle Bearer :
 *   creer   POST /v1/images/generations { model_name: 'kling-v3' (defaut) | 'kling-v2-1',
 *           prompt (<= 2 500), image (URL ou base64 SANS prefixe), image_reference:
 *           'subject' | 'face', resolution '1k' | '2k', n 1-9, aspect_ratio '16:9'…,
 *           external_task_id } → { code: 0, data: { task_id, task_status } }
 *   suivre  GET /v1/images/generations/<task_id> → data { task_status,
 *           task_status_msg, task_result: { images: [{ index, url }] } }
 *   prix    (pricing/base/image.md) Kling Image 3.0 : 0,028 $ l'image en 1K ou 2K.
 *
 * ---- L'EDITION D'UN CLIP, KLING O1 (lu le 14/10/2026) ----
 *   Demande du proprietaire, 14 octobre 2026 : remplacer UNE personne d'un clip
 *   court par SWOGE (une image de reference), en gardant le son d'origine.
 *   Doc : https://kling.ai/document-api/api/video/o1/video-omni.md
 *   creer   POST /omni-video/kling-o1 { contents: [{type:'prompt',text},
 *           {type:'refer_image', url (URL ou base64), id:'image_1'},
 *           {type:'base_video', url (URL SEULEMENT), id:'video_1'}],
 *           settings: { resolution '720p'|'1080p', audio 'original'|'off' },
 *           options: { external_task_id } } ; le texte cite @image_1 / @video_1.
 *           `aspect_ratio` n'est exige que « sans first frame ni video de
 *           reference » et `duration` n'apparait pas dans l'exemple base_video :
 *           ni l'un ni l'autre ne sont envoyes, la sortie suit le clip.
 *   video   .mp4/.mov, <= 200 Mo, 3 a 10 s (inclus), 700 a 2160 px de cote,
 *           24 a 60 i/s, une seule video ; un base_video n'accepte ni premiere
 *           ni derniere image.
 *   image   .jpg/.jpeg/.png, <= 50 Mo, >= 300 px, rapport 1:2,5 a 2,5:1 ; avec
 *           une video, images + elements <= 4.
 *   suivre  GET /tasks?task_ids= (etat()), qui rend aussi `billing[]`.
 *   prix    (pricing/base/video.md, lu le 14/10/2026) « Kling O1, With Video
 *           Input » : 0,9 unite (0,126 $) /s en 720p, 1,2 unite (0,168 $) /s en
 *           1080p. La page ne dit pas si la seconde entamee compte : on estime
 *           sur la seconde entamee (plafond), donc au pire.
 * ======================================================================== */
const crypto = require('crypto');

const BASE = 'https://api-singapore.klingai.com';
const MODELES = {
  'kling-2.6': { durees: [5, 10], prix: { '720p': { off: 0.042 }, '1080p': { off: 0.07, native: 0.14 } }, audioReglable: true },
  'kling-3.0-turbo': { durees: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], prix: { '720p': { native: 0.112 }, '1080p': { native: 0.14 } }, audioReglable: false },
};
const TEXTE_MAX = 2500;
const IMAGE_MAX_OCTETS = 50 * 1024 * 1024;
const DELAI_MS = 30000;

/* ---- L'edition O1 : les bornes de la doc (video-omni.md, 14/10/2026) ---- */
const EDITION_MODELE = 'kling-o1';
const EDITION_PRIX = { '720p': 0.126, '1080p': 0.168 };   /* $ par seconde, « With Video Input » */
const EDITION_DUREE = { min: 3, max: 10 };
const EDITION_COTE = { min: 700, max: 2160 };
const REF_IMAGE_COTE_MIN = 300;
const REF_IMAGE_RAPPORT_MAX = 2.5;

/** Le prix estime d'une edition : la seconde entamee compte (le pire cas), ou null. */
function prixEdition(resolution, dureeS) {
  const p = EDITION_PRIX[resolution]; const d = Number(dureeS);
  if (!(p > 0) || !(d >= EDITION_DUREE.min && d <= EDITION_DUREE.max)) return null;
  return Math.round(p * Math.ceil(d - 1e-9) * 1000) / 1000;
}

/**
 * Le format et la taille d'une image PNG ou JPEG lus dans ses octets, ou null.
 * PNG : signature 8 octets, puis IHDR (largeur u32 a 16, hauteur u32 a 20).
 * JPEG : FFD8, puis les segments jusqu'a un SOFn (C0-C3, C5-C7, C9-CB, CD-CF),
 * hauteur u16 a +5, largeur u16 a +7. Le type annonce par la page ne prouve rien.
 */
function dimensionsImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504E47 && buf.readUInt32BE(4) === 0x0D0A1A0A && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { format: 'png', largeur: buf.readUInt32BE(16), hauteur: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let o = 2;
    while (o + 4 <= buf.length) {
      if (buf[o] !== 0xFF) return null;
      const mq = buf[o + 1];
      if (mq === 0xFF) { o++; continue; }
      if (mq === 0xD8 || mq === 0x01 || (mq >= 0xD0 && mq <= 0xD7)) { o += 2; continue; }
      const l = buf.readUInt16BE(o + 2);
      if (l < 2) return null;
      if (mq >= 0xC0 && mq <= 0xCF && mq !== 0xC4 && mq !== 0xC8 && mq !== 0xCC) {
        if (o + 9 > buf.length) return null;
        return { format: 'jpeg', largeur: buf.readUInt16BE(o + 7), hauteur: buf.readUInt16BE(o + 5) };
      }
      o += 2 + l;
    }
  }
  return null;
}

/** Le prix en dollars d'une video, ou null si la combinaison n'existe pas. */
function prixUsd(modele, resolution, audio, duree) {
  const m = MODELES[modele]; if (!m) return null;
  const a = m.audioReglable ? (audio === 'native' ? 'native' : 'off') : 'native';
  const p = m.prix[resolution] && m.prix[resolution][a];
  if (!(p > 0) || !m.durees.includes(Number(duree))) return null;
  return Math.round(p * Number(duree) * 1000) / 1000;
}

/**
 * deps : { cle() → la KLING_API_KEY (environnement, jamais ailleurs), fetch?, base? }
 */
function cree(deps) {
  const cle = () => String((deps.cle ? deps.cle() : process.env.KLING_API_KEY) || '').trim();
  const chercher = deps.fetch || ((u, o) => fetch(u, Object.assign({ signal: AbortSignal.timeout(DELAI_MS) }, o || {})));
  const base = deps.base || BASE;
  const actif = () => !!cle();

  async function appel(chemin, o) {
    const r = await chercher(base + chemin, Object.assign({}, o, { headers: Object.assign({ authorization: 'Bearer ' + cle(), 'content-type': 'application/json' }, (o && o.headers) || {}) }));
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.code !== 0) {
      /* Le message du fournisseur (solde, contenu refuse, cle) est rendu tel quel, borne ; jamais la cle. */
      const m = String((j && (j.message || j.msg)) || ('HTTP ' + r.status)).slice(0, 200);
      const e = new Error(m); e.code = j && j.code; e.statut = r.status;
      /* 1102 pack epuise, 1101 compte en impaye (doc Kling) : alerte privee (09/10) */
      require('./alerte_solde').erreur('kling', e);
      throw e;
    }
    return j.data;
  }

  /** Lance une video. Rend { ok, id, estimationUsd, … } ou { ok:false, code, raison } — rien n'est envoye sur une entree refusee. */
  async function lance(q) {
    q = q || {};
    if (!actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const modele = MODELES[q.modele] ? q.modele : 'kling-2.6';
    const texte = String(q.prompt || '').trim();
    if (!texte) return { ok: false, code: 400, raison: 'write what happens in the video' };
    if (texte.length > TEXTE_MAX) return { ok: false, code: 400, raison: 'prompt too long (' + TEXTE_MAX + ' characters at most)' };
    const resolution = q.resolution === '1080p' ? '1080p' : '720p';
    const audio = q.audio === 'native' ? 'native' : 'off';
    const duree = Number(q.duree) || MODELES[modele].durees[0];
    const estimationUsd = prixUsd(modele, resolution, audio, duree);
    if (estimationUsd === null) return { ok: false, code: 400, raison: modele + ' does not offer ' + duree + ' s at ' + resolution + (MODELES[modele].audioReglable ? ' with audio ' + audio : '') };
    let image = null;
    if (q.image && /^https:\/\//.test(String(q.image))) image = String(q.image);   /* la doc : URL ou base64 nu */
    else if (q.image) {
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,/i.exec(String(q.image));
      if (!m) return { ok: false, code: 400, raison: 'the first frame must be a PNG, JPEG or WebP picture' };
      image = String(q.image).slice(m[0].length);
      if (Buffer.byteLength(image, 'base64') > IMAGE_MAX_OCTETS) return { ok: false, code: 400, raison: 'picture too large (50 MB at most)' };
    }
    const contents = [{ type: 'prompt', text: texte }];
    if (image) contents.push({ type: 'first_frame', url: image });
    const settings = { resolution, duration: duree };
    if (MODELES[modele].audioReglable) settings.audio = audio;
    const externe = crypto.randomBytes(12).toString('hex');
    try {
      const d = await appel('/' + (image ? 'image-to-video' : 'text-to-video') + '/' + modele,
        { method: 'POST', body: JSON.stringify({ contents, settings, options: { external_task_id: externe } }) });
      if (!d || !d.id) return { ok: false, code: 502, raison: 'Kling returned no task id' };
      return { ok: true, id: String(d.id), externe, statut: d.status || 'submitted', modele, resolution, audio: MODELES[modele].audioReglable ? audio : 'native', duree, estimationUsd, image: !!image };
    } catch (e) { return { ok: false, code: 502, raison: 'Kling refused: ' + e.message }; }
  }

  /** L'etat d'une tache : { ok, statut, url?, duree?, message? }. */
  async function etat(id) {
    if (!actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(String(id || ''))) return { ok: false, code: 400, raison: 'unknown task' };
    try {
      const d = await appel('/tasks?task_ids=' + encodeURIComponent(id), { method: 'GET' });
      const t = Array.isArray(d) ? d[0] : null;
      if (!t) return { ok: false, code: 404, raison: 'unknown task' };
      const v = (t.outputs || []).find((x) => x && x.type === 'video');
      /* `billing[]` (doc O1) : ce que Kling a reellement deduit — garde, borne, pour la mesure. */
      const facturation = Array.isArray(t.billing) ? t.billing.slice(0, 4).map((b) => ({ type: String(b && b.charge_type || '').slice(0, 16),
        montant: String(b && b.amount || '').slice(0, 24), devise: String(b && (b.currency || b.package_type) || '').slice(0, 16) })) : null;
      return { ok: true, id: String(t.id), statut: t.status, message: t.message || null,
               url: v && /^https:\/\//.test(String(v.url)) ? v.url : null, duree: v && v.duration ? Number(v.duration) : null, facturation };
    } catch (e) { return { ok: false, code: 502, raison: 'Kling: ' + e.message }; }
  }

  /**
   * L'EDITION O1 : un clip existant (base_video, par URL publique SEULEMENT —
   * la doc n'accepte pas de base64 pour une video) refait d'apres une image de
   * reference (refer_image : URL https, data-URL PNG/JPEG ou base64 nu).
   * q : { videoUrl, image, prompt, resolution, audio, dureeS }. `dureeS` (lue
   * dans l'en-tete du MP4 par l'appelant) sert a l'estimation et au refus des
   * clips hors 3-10 s. Tout refus est rendu AVANT le moindre envoi.
   */
  async function lanceEdition(q) {
    q = q || {};
    if (!actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const texte = String(q.prompt || '').trim();
    if (!texte) return { ok: false, code: 400, raison: 'write what to change in the clip' };
    if (texte.length > TEXTE_MAX) return { ok: false, code: 400, raison: 'prompt too long (' + TEXTE_MAX + ' characters at most)' };
    const videoUrl = String(q.videoUrl || '');
    if (!/^https?:\/\/[^\s]+$/i.test(videoUrl)) return { ok: false, code: 400, raison: 'the clip must be reachable at a public URL' };
    const resolution = q.resolution === '1080p' ? '1080p' : '720p';
    const audio = q.audio === 'off' ? 'off' : 'original';
    const dureeS = Number(q.dureeS);
    const estimationUsd = prixEdition(resolution, dureeS);
    if (estimationUsd === null) return { ok: false, code: 400, raison: 'the clip must last ' + EDITION_DUREE.min + ' to ' + EDITION_DUREE.max + ' s (Kling limit)' };
    let image = null, imageSource = null;
    const brute = q.image == null ? '' : String(q.image);
    if (!brute) return { ok: false, code: 400, raison: 'a reference picture is needed' };
    if (/^https:\/\//i.test(brute)) { image = brute; imageSource = 'url'; }
    else {
      const m = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(brute);
      const nu = m ? brute.slice(m[0].length) : brute;
      if (!/^[A-Za-z0-9+/=\s]+$/.test(nu)) return { ok: false, code: 400, raison: 'the reference must be a PNG or JPEG picture' };
      const octets = Buffer.from(nu, 'base64');
      if (octets.length > IMAGE_MAX_OCTETS) return { ok: false, code: 400, raison: 'picture too large (50 MB at most)' };
      const dim = dimensionsImage(octets);
      if (!dim) return { ok: false, code: 400, raison: 'the reference must be a PNG or JPEG picture (Kling takes no WebP here)' };
      const petit = Math.min(dim.largeur, dim.hauteur), grand = Math.max(dim.largeur, dim.hauteur);
      if (petit < REF_IMAGE_COTE_MIN) return { ok: false, code: 400, raison: 'the reference is ' + dim.largeur + '×' + dim.hauteur + ' px — ' + REF_IMAGE_COTE_MIN + ' px at least on each side' };
      if (grand / petit > REF_IMAGE_RAPPORT_MAX) return { ok: false, code: 400, raison: 'the reference is too narrow (between 1:2.5 and 2.5:1)' };
      image = octets.toString('base64'); imageSource = dim.format;
    }
    const contents = [{ type: 'prompt', text: texte }, { type: 'refer_image', url: image, id: 'image_1' }, { type: 'base_video', url: videoUrl, id: 'video_1' }];
    const externe = crypto.randomBytes(12).toString('hex');
    try {
      const d = await appel('/omni-video/' + EDITION_MODELE, { method: 'POST', body: JSON.stringify({ contents, settings: { resolution, audio }, options: { external_task_id: externe } }) });
      if (!d || !d.id) return { ok: false, code: 502, raison: 'Kling returned no task id' };
      return { ok: true, id: String(d.id), externe, statut: d.status || 'submitted', modele: EDITION_MODELE, edition: true,
               resolution, audio, dureeS: Math.round(dureeS * 1000) / 1000, estimationUsd, image: imageSource };
    } catch (e) { return { ok: false, code: 502, raison: 'Kling refused: ' + e.message }; }
  }

  /* ---- L'IMAGE ----
   * `image` (une URL https ou du base64 sans prefixe) sert de reference ; si
   * Kling refuse `image_reference` sur ce modele, on redemande SANS ce champ
   * plutot que de perdre l'image — le refus est garde dans `essais`. */
  async function lanceImage(q) {
    q = q || {};
    if (!actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const texte = String(q.prompt || '').trim();
    if (!texte) return { ok: false, code: 400, raison: 'write what the picture shows' };
    if (texte.length > TEXTE_MAX) return { ok: false, code: 400, raison: 'prompt too long (' + TEXTE_MAX + ' characters at most)' };
    const corps = { model_name: IMAGE_MODELES.includes(q.modele) ? q.modele : 'kling-v3', prompt: texte,
      resolution: q.resolution === '2k' ? '2k' : '1k', n: 1,
      aspect_ratio: IMAGE_FORMATS.includes(q.format) ? q.format : '1:1',
      external_task_id: crypto.randomBytes(12).toString('hex') };
    if (q.image) {
      if (!/^https:\/\//.test(String(q.image)) && !/^[A-Za-z0-9+/=]+$/.test(String(q.image))) return { ok: false, code: 400, raison: 'the reference must be an https URL or raw base64' };
      corps.image = String(q.image);
      if (q.reference === 'subject' || q.reference === 'face') corps.image_reference = q.reference;
    }
    const essais = [];
    for (;;) {
      try {
        const d = await appel('/v1/images/generations', { method: 'POST', body: JSON.stringify(corps) });
        if (!d || !d.task_id) return { ok: false, code: 502, raison: 'Kling returned no task id', essais };
        return { ok: true, id: String(d.task_id), statut: d.task_status || 'submitted', modele: corps.model_name,
                 estimationUsd: IMAGE_PRIX_USD, reference: corps.image ? (corps.image_reference || 'image') : null, essais };
      } catch (e) {
        essais.push(e.message);
        if (corps.image_reference) { delete corps.image_reference; continue; }
        return { ok: false, code: 502, raison: 'Kling refused: ' + e.message, essais };
      }
    }
  }

  /** L'etat d'une image : { ok, statut, url?, message? }. */
  async function etatImage(id) {
    if (!actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(String(id || ''))) return { ok: false, code: 400, raison: 'unknown task' };
    try {
      const d = await appel('/v1/images/generations/' + encodeURIComponent(id), { method: 'GET' });
      const im = d && d.task_result && Array.isArray(d.task_result.images) ? d.task_result.images[0] : null;
      return { ok: true, id: String(d.task_id || id), statut: d.task_status, message: d.task_status_msg || null,
               url: im && /^https:\/\//.test(String(im.url)) ? im.url : null };
    } catch (e) { return { ok: false, code: 502, raison: 'Kling: ' + e.message }; }
  }

  /** Lance puis attend l'image (toutes les `pasMs`, au plus `maxMs`). */
  async function image(q, o) {
    o = o || {};
    const dort = o.dort || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const l = await lanceImage(q);
    if (!l.ok) return l;
    const fin = Date.now() + (o.maxMs || 6 * 60e3);
    for (;;) {
      await dort(o.pasMs || 5000);
      const e = await etatImage(l.id);
      if (e.ok && e.statut === 'succeed' && e.url) return Object.assign({}, l, { ok: true, statut: 'succeed', url: e.url });
      if (e.ok && e.statut === 'failed') return Object.assign({}, l, { ok: false, code: 502, raison: 'Kling failed: ' + (e.message || 'no reason given') });
      if (Date.now() > fin) return Object.assign({}, l, { ok: false, code: 504, raison: 'Kling did not finish in time (last status: ' + (e.statut || e.raison) + ')' });
    }
  }

  /** Lance puis attend la video (toutes les `pasMs`, au plus `maxMs`). */
  async function video(q, o) {
    o = o || {};
    const dort = o.dort || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const l = await lance(q);
    if (!l.ok) return l;
    const fin = Date.now() + (o.maxMs || 12 * 60e3);
    for (;;) {
      await dort(o.pasMs || 10000);
      const e = await etat(l.id);
      if (e.ok && e.statut === 'succeeded' && e.url) return Object.assign({}, l, { ok: true, statut: 'succeeded', url: e.url });
      if (e.ok && e.statut === 'failed') return Object.assign({}, l, { ok: false, code: 502, raison: 'Kling failed: ' + (e.message || 'no reason given') });
      if (Date.now() > fin) return Object.assign({}, l, { ok: false, code: 504, raison: 'Kling did not finish in time (last status: ' + (e.statut || e.raison) + ')' });
    }
  }

  return { actif, lance, etat, lanceEdition, lanceImage, etatImage, image, video };
}

const IMAGE_MODELES = ['kling-v3', 'kling-v2-1'];
const IMAGE_FORMATS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
const IMAGE_PRIX_USD = 0.028;

module.exports = { cree, prixUsd, prixEdition, dimensionsImage, MODELES, BASE, TEXTE_MAX, IMAGE_PRIX_USD,
  EDITION_MODELE, EDITION_PRIX, EDITION_DUREE, EDITION_COTE };
