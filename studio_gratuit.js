'use strict';
/* ==================================================================
 * SWOGE STUDIO — LES IMAGES GRATUITES (18 octobre 2026)
 * ==================================================================
 *
 * Demande du propriétaire : « laisser le modèle free ici pour les images », dans
 * le choix de fournisseur de la page des agents. Deux services qui répondent
 * SANS compte, essayés le 18/10 depuis la machine de travail :
 *
 *   - « Fast » : Pollinations, GET image.pollinations.ai/prompt/<texte> —
 *     4,4 à 6,7 s, trois demandes en parallèle tenues (5,3 / 6,1 / 6,7 s),
 *     JPEG 768×768 (modèle « sana », le seul ouvert sans clé : flux, kontext et
 *     gptimage rendent 401/402/403). Un FILIGRANE « pollinations.ai » en bas à
 *     droite, que `nologo` n'enlève pas sans clé : on le garde (leurs
 *     conditions), la page le dit. `safe=true` : une demande sexuelle (« a naked
 *     woman on a beach ») a rendu une image habillée sans rapport — filtre vérifié.
 *   - « SDXL » : OVHcloud AI Endpoints, POST /v1/images/generations au format
 *     OpenAI (b64_json), ~66 s pour une 1024×1024, tailles acceptées : 1024x1024,
 *     1536x1024, 1024x1536, 1792x1024, 1024x1792 (le 422 du 18/10 les énumère).
 *     AUCUN filtre de sortie : la demande passe donc d'abord par Qwen3Guard
 *     (OVH, gratuit aussi) et ne part que jugée « Safe » — essai du 18/10 :
 *     « a cute shiba inu lifting weights » → Safe ; « a naked woman on a beach »
 *     → Controversial / Sexual Content. Un garde muet (limite, panne) refuse
 *     SDXL ; Pollinations, qui filtre lui-même, part quand même.
 *
 * Écartés le 18/10 : Hugging Face (FLUX.1-schnell, l'API Gradio rend une
 * erreur sans compte), AI Horde (anonyme, 512 px, 1 à 2 min).
 *
 * Aucune logique d'argent ici : c'est studio_media.js qui sait que c'est
 * gratuit (ni réserve, ni facture) et qui tient le quota par joueur.
 * ================================================================== */

const POLLINATIONS = () => (process.env.GRATUIT_POLLINATIONS_URL || 'https://image.pollinations.ai').replace(/\/$/, '');
const OVH = () => (process.env.GRATUIT_BASE_URL || 'https://oai.endpoints.kepler.ai.cloud.ovh.net').replace(/\/$/, '');
const GARDE_MODELE = 'Qwen3Guard-Gen-8B';
const SDXL_MODELE = 'stable-diffusion-xl-base-v10';
const OCTETS_MAX = 8 * 1024 * 1024;

/* Le format demandé, en pixels chez Pollinations, en taille permise chez OVH. */
const TAILLES_POLL = { auto: [1024, 1024], '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344],
  '4:3': [1152, 864], '3:4': [864, 1152], '3:2': [1216, 832], '2:3': [832, 1216] };
const TAILLES_SDXL = { auto: '1024x1024', '1:1': '1024x1024', '16:9': '1792x1024', '9:16': '1024x1792',
  '4:3': '1536x1024', '3:4': '1024x1536', '3:2': '1536x1024', '2:3': '1024x1536' };

function entetesOvh() {
  const cle = String(process.env.OVH_AI_KEY || '').trim();
  return Object.assign({ 'content-type': 'application/json' }, cle ? { authorization: 'Bearer ' + cle } : {});
}

/** Le jugement de Qwen3Guard sur une demande : 'Safe' | 'Controversial' | 'Unsafe' | null (muet). */
async function juge(prompt, prendre) {
  const f = prendre || fetch;
  try {
    const r = await f(OVH() + '/v1/chat/completions', { method: 'POST', headers: entetesOvh(),
      body: JSON.stringify({ model: GARDE_MODELE, max_tokens: 60, messages: [{ role: 'user', content: String(prompt).slice(0, 2000) }] }),
      signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const j = await r.json();
    const t = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    const m = /Safety:\s*(Safe|Controversial|Unsafe)/i.exec(t);
    return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
  } catch (e) { return null; }
}

/** Les octets d'une réponse, bornés, en data-URL. */
async function enDataUrl(r, type) {
  const b = Buffer.from(await r.arrayBuffer());
  if (!b.length || b.length > OCTETS_MAX) throw new Error('image vide ou trop lourde (' + b.length + ' octets)');
  return 'data:' + type + ';base64,' + b.toString('base64');
}

async function pollinations({ prompt, format }, prendre) {
  const f = prendre || fetch;
  const [w, h] = TAILLES_POLL[format] || TAILLES_POLL.auto;
  const graine = Math.floor(Math.random() * 1e9);
  const url = POLLINATIONS() + '/prompt/' + encodeURIComponent(String(prompt).slice(0, 1500))
    + '?width=' + w + '&height=' + h + '&nologo=true&safe=true&seed=' + graine;
  const r = await f(url, { signal: AbortSignal.timeout(90000) });
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
  if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(type)) throw Object.assign(new Error('pollinations ' + r.status + ' ' + type), { statut: r.status });
  return enDataUrl(r, type);
}

async function sdxl({ prompt, format }, prendre) {
  const f = prendre || fetch;
  const r = await f(OVH() + '/v1/images/generations', { method: 'POST', headers: entetesOvh(),
    body: JSON.stringify({ model: SDXL_MODELE, prompt: String(prompt).slice(0, 1500), size: TAILLES_SDXL[format] || TAILLES_SDXL.auto }),
    signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw Object.assign(new Error('ovh sdxl ' + r.status), { statut: r.status });
  const j = await r.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64 || b64.length * 0.75 > OCTETS_MAX) throw new Error('ovh sdxl : pas d\'image');
  return 'data:image/png;base64,' + b64;
}

/**
 * Le fournisseur, à la forme que studio_media attend : images({ api, prompt, n, format }) →
 * { urls, usage: null, garde }. `api` : 'pollinations' | 'sdxl'. Une demande jugée
 * dangereuse lève une erreur `refus` (studio_media la rend telle quelle, sans « panne »).
 */
function cree(deps) {
  const prendre = deps && deps.fetch;
  return {
    actif: () => process.env.STUDIO_GRATUIT !== '0',
    async images({ api, prompt, format }) {
      const g = await juge(prompt, prendre);
      if (g === 'Unsafe' || (api === 'sdxl' && g !== 'Safe')) {
        throw Object.assign(new Error('garde : ' + (g || 'muet')), { refus: true,
          raison: g === null ? 'the free safety check is busy — try again in a minute' : 'this request was refused by the free model\'s safety check' });
      }
      const url = api === 'sdxl' ? await sdxl({ prompt, format }, prendre) : await pollinations({ prompt, format }, prendre);
      return { urls: [url], usage: null, garde: g };
    },
  };
}

module.exports = { cree, juge, pollinations, sdxl, TAILLES_POLL, TAILLES_SDXL, GARDE_MODELE, SDXL_MODELE };
