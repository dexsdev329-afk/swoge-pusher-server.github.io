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
    if (q.image) {
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

  return { actif, lance, etat };
}

module.exports = { cree, prixUsd, MODELES, BASE, TEXTE_MAX };
