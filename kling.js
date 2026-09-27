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
      const e = new Error(m); e.code = j && j.code; e.statut = r.status; throw e;
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
      return { ok: true, id: String(t.id), statut: t.status, message: t.message || null,
               url: v && /^https:\/\//.test(String(v.url)) ? v.url : null, duree: v && v.duration ? Number(v.duration) : null };
    } catch (e) { return { ok: false, code: 502, raison: 'Kling: ' + e.message }; }
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

  return { actif, lance, etat, lanceImage, etatImage, image, video };
}

const IMAGE_MODELES = ['kling-v3', 'kling-v2-1'];
const IMAGE_FORMATS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
const IMAGE_PRIX_USD = 0.028;

module.exports = { cree, prixUsd, MODELES, BASE, TEXTE_MAX, IMAGE_PRIX_USD };
