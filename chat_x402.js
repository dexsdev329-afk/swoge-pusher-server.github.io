'use strict';
/* ==================================================================
 * CHAT_COMPLETION — LES MODELES D'IA PAYES A L'APPEL (27 septembre 2026)
 * ==================================================================
 *
 * Pourquoi : sur x402scan (30 jours, releve du 26/09), BlockRun — « the
 * routing & payment layer for AI » — compte 322 acheteurs et 199 088
 * paiements : un point d'entree au format OpenAI vers des dizaines de modeles,
 * paye a l'appel en USDC. Sa regle (llms.txt lu le 27/09) : le prix de l'appel
 * est un DEVIS avant l'appel (jetons estimes), aucune marge sur les jetons,
 * 0,001 $ de frais par transaction, 0,002 $ au minimum.
 *
 * Les notres : les 10 modeles du chat SwoleMind (studio_chat.MODELES), le
 * modele BRUT (le message systeme de l'appelant, pas la persona SwoleMind),
 * texte seul, sans outils ni recherche web.
 *
 * LE PRIX (decision du proprietaire du 27/09, « option 2 ») : le pire cas de
 * CETTE demande — l'entree comptee a un jeton pour deux caracteres ASCII (bien
 * plus que les ~4 caracteres par jeton reels en anglais) et a un jeton par OCTET
 * UTF-8 pour le reste (un jeton BPE couvre au moins un octet : c'est une borne
 * dure ; un ideogramme, 3 octets, en coute ~1-1,5 en realite) — plus
 * `max_tokens` de sortie, raisonnement compris — fois X402_CHAT_MARGE (1,1).
 * x402 ajoute ses frais de reglement (0,001 $ Coinbase, 0,002 $ Solana, le
 * gaz sur Robinhood Chain) et son plancher (0,005 $ sur Base et Solana). Le
 * paiement « exact » se fait AVANT : l'appel ne peut pas couter plus que le
 * devis, puisque le fournisseur ne rend jamais plus de `max_tokens`.
 * Un appel rate (fournisseur en panne, aucun texte) n'est pas regle.
 * ================================================================== */

const Chat = require('./studio_chat');

const MESSAGES_MAX = 50;
const ENTREE_MAX_CAR = 24000;         /* comme l'historique du chat (studio_chat.ENTREE_MAX_CAR) */
const JETONS_PAR_MESSAGE = 8;         /* l'enveloppe d'un message (role, separateurs), comptee large */
const SORTIE_DEFAUT = 1024;
const DEFAUT = 'haiku-4-5';
const marge = () => { const v = Number(process.env.X402_CHAT_MARGE); return v >= 1 ? v : 1.1; };

/** La demande, lue et bornee, ou { erreur }. */
function lis(a) {
  a = a || {};
  const m = Chat.modele(a.model === undefined ? DEFAUT : String(a.model));
  if (!m) return { erreur: 'model must be one of ' + Chat.MODELES.map((x) => x.id).join(', ') };
  if (!Array.isArray(a.messages) || !a.messages.length) return { erreur: 'messages is required: [{ role, content }], the last one from the user' };
  if (a.messages.length > MESSAGES_MAX) return { erreur: 'at most ' + MESSAGES_MAX + ' messages' };
  const systemes = [], echanges = [];
  let car = 0, jetons = 0;
  for (const x of a.messages) {
    if (!x || !['system', 'user', 'assistant'].includes(x.role) || typeof x.content !== 'string') return { erreur: 'each message needs role system, user or assistant and a text content' };
    car += x.content.length;
    const nonAscii = x.content.replace(/[\x00-\x7f]/g, '');
    jetons += (x.content.length - nonAscii.length) / 2 + Buffer.byteLength(nonAscii, 'utf8');
    if (x.role === 'system') { systemes.push(x.content); continue; }
    /* Deux messages du meme role de suite : fusionnes (tous les fournisseurs l'acceptent ainsi). */
    const der = echanges[echanges.length - 1];
    if (der && der.role === x.role) der.content += '\n\n' + x.content; else echanges.push({ role: x.role, content: x.content });
  }
  if (car > ENTREE_MAX_CAR) return { erreur: 'messages total ' + car.toLocaleString('en-US') + ' characters; at most ' + ENTREE_MAX_CAR.toLocaleString('en-US') };
  if (!echanges.length || echanges[echanges.length - 1].role !== 'user' || !echanges[echanges.length - 1].content.trim()) return { erreur: 'the last message must come from the user and not be empty' };
  if (echanges[0].role !== 'user') echanges.unshift({ role: 'user', content: '(conversation continues)' });
  const max = a.max_tokens === undefined ? Math.min(SORTIE_DEFAUT, m.maxTokens) : Number(a.max_tokens);
  if (!Number.isInteger(max) || max < 16 || max > m.maxTokens) return { erreur: 'max_tokens must be an integer from 16 to ' + m.maxTokens + ' for ' + m.id };
  return { m, messages: echanges, systeme: systemes.join('\n\n'), max, car, jetons: Math.ceil(jetons), n: a.messages.length };
}

/** Le pire cas de CETTE demande, en USD, avant marge : il borne ce que l'appel peut couter. */
function pireCasUsd(d) {
  const entree = d.jetons + d.n * JETONS_PAR_MESSAGE;
  return entree * d.m.entree / 1e6 + d.max * d.m.sortie / 1e6;
}
/** Le prix d'un appel (x402 ajoute ses frais de reglement et son plancher). Une demande invalide : le devis de la demande la plus courte. */
function prixUsd(a) {
  const d = lis(a);
  const base = d.erreur ? { m: Chat.modele(DEFAUT), car: 1, jetons: 1, n: 1, max: Math.min(SORTIE_DEFAUT, Chat.modele(DEFAUT).maxTokens) } : d;
  return Math.ceil(pireCasUsd(base) * marge() * 1e6) / 1e6;
}

function cree(deps) {
  const MESURE = { appels: 0, echecs: 0, coutUsd: 0, factureUsd: 0, parModele: {} };
  /** Un appel : le modele brut, borne a max_tokens. Rend { ok, resultat, texte, coutUsd } ou { ok:false, raison }. */
  async function appelle(a) {
    const d = lis(a);
    if (d.erreur) return { ok: false, code: 400, raison: d.erreur };
    if (deps.actif && !deps.actif(d.m.fournisseur)) return { ok: false, code: 503, raison: d.m.id + ' is not available right now - nothing was charged' };
    MESURE.appels++;
    const pm = (MESURE.parModele[d.m.id] = MESURE.parModele[d.m.id] || { appels: 0, coutUsd: 0 });
    pm.appels++;
    let r;
    try { r = await deps.fournisseur({ m: Object.assign({}, d.m, { maxTokens: d.max }), messages: d.messages, systeme: d.systeme }); }
    catch (e) { MESURE.echecs++; return { ok: false, code: 502, raison: 'the ' + d.m.id + ' provider failed - nothing was charged' }; }
    const cout = Chat.coutUsd(d.m, r && r.usage);
    MESURE.coutUsd += cout; pm.coutUsd += cout;
    const texte = String((r && r.texte) || '');
    if (!texte.trim()) { MESURE.echecs++; return { ok: false, code: 502, raison: 'the model returned no text' + (r && r.stop === 'max_tokens' ? ' (max_tokens reached, reasoning included: raise it)' : '') + ' - nothing was charged', coutUsd: cout }; }
    const u = (r && r.usage) || {};
    const entree = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || u.prompt_tokens || 0;
    const sortie = u.output_tokens || u.completion_tokens || 0;
    const fin = r.stop === 'max_tokens' || r.stop === 'length' ? 'length' : 'stop';
    /* Le format de reponse d'OpenAI (chat.completion) : un client OpenAI le lit tel quel. */
    const resultat = { id: 'chatcmpl-' + require('crypto').randomBytes(12).toString('hex'), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: d.m.id, served: r.servi || d.m.api, choices: [{ index: 0, message: { role: 'assistant', content: texte }, finish_reason: fin }],
      usage: { prompt_tokens: entree, completion_tokens: sortie, total_tokens: entree + sortie } };
    return { ok: true, resultat, texte, coutUsd: cout };
  }
  return { appelle, MESURE };
}

module.exports = { cree, lis, prixUsd, pireCasUsd, marge, DEFAUT, MESSAGES_MAX, ENTREE_MAX_CAR, SORTIE_DEFAUT };
