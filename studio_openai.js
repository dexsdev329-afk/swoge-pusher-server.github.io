'use strict';
/* ==================================================================
 * SWOGE STUDIO — le fournisseur OpenAI (« ChatGPT Image »)
 * ==================================================================
 *
 * Un seul rôle : parler à l'API d'images d'OpenAI et rendre ce que la
 * facturation lit (`usage`). Aucune logique d'argent ici.
 *
 * Relu le 26 septembre 2026 dans la spécification OpenAPI d'OpenAI et sa page
 * de modèles, pas de mémoire :
 *   - POST /v1/images/generations (JSON) {model, prompt, n 1–10, size
 *     1024x1024 | 1536x1024 | 1024x1536 | auto, quality low|medium|high,
 *     output_format png|jpeg|webp, output_compression}
 *   - POST /v1/images/edits (multipart/form-data) {model, prompt, image
 *     (fichier), n, size, quality}
 *   - la réponse porte data[].b64_json — JAMAIS une adresse pour les modèles
 *     gpt-image — et `usage` : input_tokens (dont text_tokens / image_tokens)
 *     et output_tokens.
 *   - gpt-image-2 : « state-of-the-art », servi sur les deux routes. Le compte
 *     sert déjà gpt-image-1.5 aux posts X depuis le 18 septembre.
 * `OPENAI_BASE_URL` remplace l'hôte dans l'essai. */

const BASE = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const MODELE = () => (process.env.STUDIO_OPENAI_IMAGE || 'gpt-image-2').trim();
function cle() { return (process.env.OPENAI_API_KEY || '').trim(); }
function actif() { return !!cle(); }

/* Le format demandé, ramené aux trois tailles que l'API accepte. */
function taille(format) {
  if (['16:9', '3:2', '4:3'].includes(format)) return '1536x1024';
  if (['9:16', '2:3', '3:4'].includes(format)) return '1024x1536';
  if (format === '1:1') return '1024x1024';
  return 'auto';
}

async function lis(r) {
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const msg = j && j.error && j.error.message;
    const e = new Error('OpenAI ' + r.status + (msg ? ' — ' + String(msg).slice(0, 160) : ''));
    e.statut = r.status;
    throw e;
  }
  return j || {};
}

/** Des images, générées ou retouchées (une image fournie = une retouche).
 *  Rend des data-URL : c'est l'appelant qui les range sur le disque. */
async function images({ api, prompt, n, format, image, qualite }) {
  const model = api || MODELE();
  const size = taille(format);
  let r;
  if (image) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image);
    if (!m) throw new Error('image jointe illisible');
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', prompt); fd.append('n', String(n));
    fd.append('size', size); fd.append('quality', qualite);
    fd.append('image', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'photo.' + m[1].split('/')[1]);
    r = await fetch(BASE() + '/v1/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + cle() },
      body: fd, signal: AbortSignal.timeout(240000) });
  } else {
    r = await fetch(BASE() + '/v1/images/generations', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cle() },
      body: JSON.stringify({ model, prompt, n, size, quality: qualite, output_format: 'jpeg', output_compression: 90 }),
      signal: AbortSignal.timeout(240000) });
  }
  const j = await lis(r);
  const urls = (j.data || []).map((d) => {
    if (!d || !d.b64_json) return null;
    const type = /^\/9j\//.test(d.b64_json) ? 'image/jpeg' : /^UklGR/.test(d.b64_json) ? 'image/webp' : 'image/png';
    return 'data:' + type + ';base64,' + d.b64_json;
  }).filter(Boolean);
  return { urls, usage: j.usage || null };
}

module.exports = { actif, images, taille, MODELE };
