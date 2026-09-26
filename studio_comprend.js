'use strict';
/* ==================================================================
 * SWOLEMIND — COMPRENDRE UNE DEMANDE D'IMAGE AVANT DE LA DESSINER
 * ==================================================================
 *
 * Signalé par le propriétaire, le 26 septembre 2026, captures à l'appui :
 *   1. « crée-moi une image de swoge sur un bateau » → un chien quelconque :
 *      le générateur ne sait pas à quoi ressemble SWOGE ;
 *   2. il envoie SWOGE en photo, « swoge ressemble à ça, refais l'image » →
 *      SWOGE, mais plus de bateau : chaque demande partait SEULE, sans ce qui
 *      avait été demandé avant ;
 *   3. il faut renvoyer la photo ET redire « sur un bateau » pour l'avoir.
 *
 * Deux corrections, chacune là où elle se décide :
 *   - LA RÉFÉRENCE : une demande qui nomme SWOGE part avec l'image officielle
 *     (celle que le propriétaire a donnée, `img/site/swoge_reference.jpg` sur
 *     le site) comme image de départ, quand le joueur n'a rien joint.
 *   - LA MÉMOIRE : quand le fil porte déjà des demandes d'image, un petit
 *     modèle (Claude Haiku 4.5, le moins cher) réécrit la dernière en UNE
 *     consigne complète, en reprenant ce qui a été demandé avant quand la
 *     dernière y renvoie (« refais », « pareil mais », « sur un bateau »).
 *     Sans historique, on n'appelle rien : la demande part telle quelle.
 *
 * Le coût de cette réécriture est RÉEL et facturé avec l'image (voir
 * studio_media.js) : ~0,002 $ au pire, réservé à RESERVE_USD.
 * ================================================================== */

const MODELE = 'claude-haiku-4-5';
const PRIX = { entree: 1, sortie: 5 };        /* $ par million de jetons, grille publique relue le 24 septembre */
const SORTIE_MAX = 300;
const CONTEXTE_MAX = 6;
const CAR_MAX = 400;
/* Le pire cas : consigne ~250 jetons + 6 demandes × 400 car. + la demande, à
   un jeton pour deux caractères (la règle des réserves), + la sortie maximale. */
const RESERVE_USD = ((250 + Math.ceil((CONTEXTE_MAX + 1) * CAR_MAX / 2)) * PRIX.entree + SORTIE_MAX * PRIX.sortie) / 1e6;
const REFERENCE_CHEMIN = '/img/site/swoge_reference.jpg';
const REFERENCE_TTL_MS = 3600e3;
const SWOGE_DECRIT = 'SWOGE, the character in the reference image: a muscular shiba inu in a red suit with a red silk scarf — keep his face, fur, build and outfit';

const SYSTEME = [
  'You turn the LATEST image request of a chat into ONE standalone prompt for an image generator, in English.',
  'Use the earlier requests only when the latest one refers to them (e.g. "do it again", "same but…", "make it on a boat", "he looks like this", "redo the image").',
  'Keep every concrete detail the user asked for: subject, setting, action, style, text to write.',
  'If a reference image is attached, say to keep the character from the reference image.',
  'Reply with the prompt only: no preamble, no quotes, at most 120 words.',
].join(' ');

const nomme = (s) => /\bswoge\b/i.test(String(s || ''));
/** La demande parle-t-elle de SWOGE — elle, ou le fil auquel elle renvoie ? */
function parleDeSwoge(prompt, contexte) { return nomme(prompt) || (contexte || []).some(nomme); }

/** Le contexte envoyé par la page : les demandes d'image précédentes du fil, bornées. */
function contexteDe(x) {
  return (Array.isArray(x) ? x : []).filter((s) => typeof s === 'string' && s.trim())
    .slice(-CONTEXTE_MAX).map((s) => s.trim().slice(0, CAR_MAX));
}

/**
 * Réécrit la demande avec son contexte. Rend { prompt, coutUsd } ; sans
 * contexte, ne coûte rien et rend la demande telle quelle. En cas d'échec, la
 * demande d'origine part (on ne bloque pas une image pour une réécriture).
 */
async function comprend({ prompt, contexte, reference }, deps) {
  const ctx = contexteDe(contexte);
  const base = String(prompt || '').trim();
  const ajoute = (p) => (reference === 'swoge' && !/reference image/i.test(p) ? p + ' — ' + SWOGE_DECRIT + '.' : p);
  if (!ctx.length) return { prompt: ajoute(base), coutUsd: 0, reecrit: false };
  try {
    const c = deps.client;
    const r = await c.messages.create({ model: MODELE, max_tokens: SORTIE_MAX, system: SYSTEME, messages: [{ role: 'user', content:
      'Earlier image requests in this chat, oldest first:\n' + ctx.map((s, i) => (i + 1) + '. ' + s).join('\n')
      + '\n\nLatest request: ' + base
      + '\nReference image attached: ' + (reference === 'swoge' ? 'yes — the official SWOGE character' : reference === 'jointe' ? 'yes — a photo the user attached' : 'no') }] });
    const texte = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^["“]|["”]$/g, '');
    const u = r.usage || {};
    const coutUsd = ((u.input_tokens || 0) * PRIX.entree + (u.output_tokens || 0) * PRIX.sortie) / 1e6;
    return { prompt: ajoute(texte.slice(0, 1500) || base), coutUsd, reecrit: !!texte };
  } catch (e) {
    console.warn('[image] reecriture ratee (' + String(e && e.message || e).slice(0, 80) + ') : la demande part telle quelle');
    return { prompt: ajoute(base), coutUsd: 0, reecrit: false };
  }
}

/* L'image officielle, lue sur le site et gardée une heure. */
let ref = { t: 0, v: null };
async function referenceSwoge(deps) {
  const t = Date.now();
  if (ref.v && t - ref.t < REFERENCE_TTL_MS) return ref.v;
  try {
    const lit = (deps && deps.lit) || (async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('reference ' + r.status); return Buffer.from(await r.arrayBuffer()); });
    const site = String((deps && deps.site) || process.env.SITE_URL || 'https://swoleeswoge.dog').replace(/\/+$/, '');
    const b = await lit(site + REFERENCE_CHEMIN);
    if (!b || b.length < 1000 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
    ref = { t, v: 'data:image/jpeg;base64,' + b.toString('base64') };
    return ref.v;
  } catch (e) {
    console.warn('[image] reference SWOGE illisible : ' + String(e && e.message || e).slice(0, 80));
    return ref.v;          /* la derniere bonne, si on en a une */
  }
}
function _oublie() { ref = { t: 0, v: null }; }

module.exports = { comprend, referenceSwoge, parleDeSwoge, contexteDe, _oublie,
  MODELE, RESERVE_USD, SORTIE_MAX, CONTEXTE_MAX, SWOGE_DECRIT, REFERENCE_CHEMIN };
