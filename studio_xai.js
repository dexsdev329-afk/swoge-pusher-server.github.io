'use strict';
/* ==================================================================
 * SWOGE STUDIO — le fournisseur xAI (Grok Imagine) : images et vidéos
 * ==================================================================
 *
 * Un seul rôle : parler à l'API REST d'xAI et rendre ce que la facturation
 * lit. Aucune logique d'argent ici (c'est `studio_media.js`).
 *
 * Tout vient de la spécification OpenAPI d'xAI, relue le 26 septembre 2026
 * (https://api.x.ai/api-docs/openapi.json), pas de mémoire :
 *   - POST /v1/images/generations {model, prompt, n ≤ 10, aspect_ratio,
 *     resolution, response_format} → {data: [{url}], usage}
 *   - POST /v1/images/edits  {model, prompt, image: {url: data-URL}, n,
 *     aspect_ratio} → même réponse
 *   - POST /v1/videos/generations {model, prompt, image?, duration 1–15,
 *     aspect_ratio, resolution 480p|720p|1080p} → {request_id}
 *   - GET  /v1/videos/{request_id} → {status: pending|done|failed|expired,
 *     progress, video: {url, duration, respect_moderation}, usage, error}
 *   - `usage.cost_in_usd_ticks` : le coût RÉEL, 1 $ = 10 000 000 000 ticks.
 * `XAI_BASE_URL` remplace l'hôte dans l'essai (un faux serveur local). */

const BASE = () => (process.env.XAI_BASE_URL || 'https://api.x.ai').replace(/\/$/, '');
function cle() { return (process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim(); }
function actif() { return !!cle(); }

async function appel(chemin, corps, methode) {
  const r = await fetch(BASE() + chemin, {
    method: methode || 'POST',
    headers: Object.assign({ authorization: 'Bearer ' + cle() }, corps ? { 'content-type': 'application/json' } : {}),
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const msg = j && (j.error && (j.error.message || j.error) || j.message || j.detail);
    const e = new Error('xAI ' + r.status + (msg ? ' — ' + String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 160) : ''));
    e.statut = r.status;
    throw e;
  }
  return j || {};
}

/** Des images, générées ou retouchées (une image fournie = une retouche). */
async function images({ api, prompt, n, format, image }) {
  const corps = { model: api, prompt, n };
  if (format && format !== 'auto') corps.aspect_ratio = format;
  if (image) corps.image = { url: image, type: 'image_url' };
  const j = await appel(image ? '/v1/images/edits' : '/v1/images/generations', corps);
  const urls = (j.data || []).map((d) => d && (d.url || (d.b64_json ? 'data:' + (d.mime_type || 'image/png') + ';base64,' + d.b64_json : null))).filter(Boolean);
  return { urls, usage: j.usage || null };
}

/** Lance une vidéo (asynchrone) : rend l'identifiant à interroger. */
async function lanceVideo({ api, prompt, duree, resolution, format, image }) {
  const corps = { model: api, duration: duree, resolution };
  if (prompt) corps.prompt = prompt;
  if (format && format !== 'auto') corps.aspect_ratio = format;
  if (image) corps.image = { url: image };
  const j = await appel('/v1/videos/generations', corps);
  if (!j.request_id) throw new Error('xAI : no request_id');
  return j.request_id;
}

/** L'état d'une vidéo. La réponse peut être plate ou enveloppée dans `response`. */
async function litVideo(id) {
  const j = await appel('/v1/videos/' + encodeURIComponent(id), null, 'GET');
  const v = j.response && j.response.status ? j.response : j;
  return { status: v.status || j.status, progress: v.progress, video: v.video || null,
           usage: v.usage || null, erreur: v.error ? String(v.error.message || v.error.code || '') : null };
}

module.exports = { actif, images, lanceVideo, litVideo };
