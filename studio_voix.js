'use strict';
/* ==================================================================
 * SWOLEMIND — LE VOCAL DANS LE CHAT (transcription)
 * ==================================================================
 *
 * Demande du proprietaire (06/10) : « parler dans le chat, et qu'il comprenne ».
 * Les modeles de chat lisent du TEXTE (les modeles peu censures sont texte seul) :
 * il faut donc transcrire la voix en texte AVANT de l'envoyer au modele.
 *
 * Deux chemins, cote PAGE :
 *   1. le micro du navigateur (Web Speech API) : gratuit, aucune cle, rien ici ;
 *   2. le repli SERVEUR, quand le navigateur ne sait pas transcrire (Firefox,
 *      Safari iOS) : la page enregistre un clip et l'envoie ici. C'est CE module.
 *
 * Protocole « audio/transcriptions », compatible OpenAI, relu le 06/10 :
 *   - Groq (defaut) : POST api.groq.com/openai/v1/audio/transcriptions,
 *     multipart (file + model), modeles whisper-large-v3 / -turbo, minimum
 *     facturable 10 s. Tarif : turbo 0,04 $/h, large 0,111 $/h.
 *   - OpenAI : POST api.openai.com/v1/audio/transcriptions, meme forme,
 *     whisper-1 a 0,006 $/min (0,36 $/h).
 * On demande `response_format: verbose_json` : la reponse porte `duration` (la
 * duree reelle de l'audio) — c'est ELLE qui fait foi pour la facture, jamais la
 * duree annoncee par le client (qui pourrait mentir).
 *
 * MESURER / NE JAMAIS FACTURER SOUS LE COUT : la reserve compte le pire cas
 * (le clip au plafond), la facture le coute reel (duree rendue, bornee au
 * minimum facturable du fournisseur), le tout majore par STUDIO_MARGE comme le
 * chat. Fail-closed : pas de cle -> 503, aucune reserve. Aucune cle ici ;
 * aucun octet d'audio n'est garde apres la reponse. */

const studio = require('./studio');
const config = require('./config');
const { factureUsd } = require('./studio_chat');   /* une seule source pour la marge */

/* Plafonds : un clip de dictee, pas un podcast. La reserve se calcule dessus. */
const DUREE_MAX_S = 120;
const OCTETS_MAX = 8 * 1024 * 1024;

const FOURNISSEURS = {
  /* Groq : de loin le moins cher (turbo 0,04 $/h), compatible OpenAI. */
  groq: {
    base: () => process.env.VOIX_BASE_URL || 'https://api.groq.com/openai',
    cle: () => process.env.VOIX_API_KEY || process.env.GROQ_API_KEY || '',
    modele: () => process.env.VOIX_MODELE || 'whisper-large-v3-turbo',
    prixHeure: 0.04, minFacturableS: 10,
  },
  openai: {
    base: () => process.env.VOIX_BASE_URL || 'https://api.openai.com',
    cle: () => process.env.VOIX_API_KEY || process.env.OPENAI_API_KEY || '',
    modele: () => process.env.VOIX_MODELE || 'whisper-1',
    prixHeure: 0.36, minFacturableS: 0,
  },
};
function fournisseur() {
  return FOURNISSEURS[String(process.env.VOIX_FOURNISSEUR || 'groq').toLowerCase()] || FOURNISSEURS.groq;
}
function actif() { const F = fournisseur(); return !!String(F.cle()).trim(); }

/** Le prix a l'heure effectif : la grille du fournisseur, ou l'override. */
function prixHeure() {
  const o = Number(process.env.VOIX_PRIX_HEURE);
  return o > 0 ? o : fournisseur().prixHeure;
}
/** Le cout REEL d'une transcription, en USD, pour `secondes` d'audio : borne au
 *  minimum facturable du fournisseur (Groq facture au moins 10 s). AVANT marge. */
function coutUsd(secondes) {
  const F = fournisseur();
  const s = Math.max(Number(secondes) || 0, F.minFacturableS);
  return s / 3600 * prixHeure();
}

/**
 * Une transcription : reserve le pire cas, appelle, facture la duree reelle.
 *   q    = { addr, audio (base64), mime, secondesEstimees }
 *   deps = { cours: async()->number|null,
 *            solde: { reserve(addr, wei)->bool, regle(addr, reserveWei, factureWei)->solde },
 *            fournit: async ({ audio:Buffer, mime, nom, signal })->{ texte, secondes },
 *            canal }
 * Rend { ok, texte, secondes, factureUsd, factureSwoge, solde } — jamais d'exception
 * pour un refus attendu.
 */
async function repond(q, deps) {
  const addr = q && q.addr;
  if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
  if (!actif()) return { ok: false, code: 503, raison: 'Voice is not switched on yet — type your message, or use your browser mic.' };
  let audio;
  try { audio = Buffer.from(String(q.audio || ''), 'base64'); } catch (e) { audio = null; }
  if (!audio || !audio.length) return { ok: false, code: 400, raison: 'no audio received' };
  if (audio.length > OCTETS_MAX) return { ok: false, code: 413, raison: 'this clip is too long (keep it under 2 minutes)' };

  const cours = await deps.cours();
  if (!(cours > 0)) return { ok: false, code: 503, raison: 'the $SWOGE price is unavailable — try again shortly' };
  const dec = config.DECIMALS || 18;
  const reserveUsd = factureUsd(coutUsd(DUREE_MAX_S));
  const reserveWei = studio.montantBaseDe(reserveUsd, cours, dec);
  if (!deps.solde.reserve(addr, reserveWei)) {
    return { ok: false, code: 402, raison: 'balance too low for voice', requisSwoge: studio.formateBase(reserveWei, dec) };
  }

  let res;
  try {
    res = await deps.fournit({ audio, mime: String(q.mime || 'audio/webm'), nom: 'clip', signal: q.signal });
  } catch (e) {
    deps.solde.regle(addr, reserveWei, 0n);   /* echec avant tout texte : on rend tout */
    return { ok: false, code: 502, raison: 'transcription failed — you were not charged', detail: String((e && e.message) || e).slice(0, 160) };
  }
  const texte = String((res && res.texte) || '').trim();
  const secondes = Number(res && res.secondes) || 0;
  const cout = coutUsd(secondes);
  const facture = factureUsd(cout);
  let factureWei = studio.montantBaseDe(facture, cours, dec);
  if (factureWei > reserveWei) factureWei = reserveWei;   /* jamais plus que la reserve */
  const solde = deps.solde.regle(addr, reserveWei, factureWei);
  return { ok: true, texte, secondes: Number(secondes.toFixed(2)),
    factureSwoge: studio.formateBase(factureWei, dec), factureUsd: Number(facture.toFixed(5)), solde };
}

/** L'appel reel au fournisseur (compatible OpenAI, multipart). Injecte dans
 *  `deps.fournit` ; isole pour que l'essai le remplace par un faux. */
async function transcris({ audio, mime, nom, signal }) {
  const F = fournisseur();
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), (nom || 'clip') + '.webm');
  form.append('model', F.modele());
  form.append('response_format', 'verbose_json');   /* porte `duration` : la facture s'y appuie */
  form.append('temperature', '0');
  const r = await fetch(String(F.base()).replace(/\/$/, '') + '/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + F.cle() },   /* le boundary multipart est pose par fetch */
    body: form,
    signal: signal && AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(120000), signal]) : AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    let msg = '';
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { /* illisible */ }
    throw new Error('voice ' + r.status + (msg ? ' — ' + String(msg).slice(0, 160) : ''));
  }
  const j = await r.json();
  return { texte: String(j.text || '').trim(), secondes: Number(j.duration) || 0 };
}

/** Ce que la page LIT pour montrer (ou cacher) le repli serveur et son prix. */
function etat(cours) {
  const a = actif();
  const prixTypiqueUsd = factureUsd(coutUsd(15));   /* un clip de 15 s, repere indicatif */
  return {
    actif: a,
    dureeMaxS: DUREE_MAX_S,
    prixTypiqueUsd: Number(prixTypiqueUsd.toFixed(5)),
    prixTypiqueSwoge: cours > 0 ? Math.ceil(prixTypiqueUsd / cours) : null,
  };
}

module.exports = { repond, transcris, etat, actif, coutUsd, fournisseur, DUREE_MAX_S, OCTETS_MAX, FOURNISSEURS };
