'use strict';
/* ==================================================================
 * SWOGE AI CHAT — les fournisseurs « Chat Completions » : OpenAI, xAI,
 * et les modèles peu censurés (Venice, OpenRouter, DeepSeek, Mistral)
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : dans le chat, choisir les
 * modèles Claude, ChatGPT ET Grok. OpenAI et xAI parlent le même protocole —
 * `POST /v1/chat/completions` en streaming — relu le même jour :
 *   - OpenAI : pages de modèles gpt-6-astra / gpt-6-sol / gpt-6-luna
 *     (« Chat Completions v1/chat/completions : supported », streaming,
 *     `reasoning_effort` low/medium/high…) ;
 *   - xAI : spécification OpenAPI (`ChatRequest` : messages, stream,
 *     stream_options, max_completion_tokens, reasoning_effort ; `Usage` :
 *     prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens,
 *     et cost_in_usd_ticks — le coût EXACT, 1 $ = 1e10 ticks).
 * Avec `stream_options.include_usage`, le dernier morceau porte `usage`.
 *
 * Demande du propriétaire, le 5 octobre 2026 : ajouter des modèles PEU CENSURÉS.
 * Les quatre parlent le même protocole « Chat Completions », vérifié dans leur
 * doc le même jour :
 *   - Venice (api.venice.ai/api/v1/chat/completions) : OpenAI-compatible,
 *     `stream`, `max_completion_tokens`, `reasoning_effort` ; modèles
 *     « venice-uncensored » (Dolphin Mistral 24B, Venice edition).
 *   - OpenRouter (openrouter.ai/api/v1/chat/completions) : buffet de modèles,
 *     auth Bearer, `stream`. L'usage porte TOUJOURS `cost` (en crédits, 1 = 1 $) :
 *     c'est le coût EXACT, quel que soit le modèle amont (voir usageDe). Deux
 *     en-têtes optionnels (HTTP-Referer, X-Title) identifient notre site.
 *   - DeepSeek (api.deepseek.com) : OpenAI-compatible. ATTENTION, le chemin est
 *     `/chat/completions` SANS `/v1` (doc du 05/10) → `chemin` ci-dessous.
 *   - Mistral (api.mistral.ai/v1/chat/completions) : OpenAI-compatible, Bearer.
 *
 * Le chemin par défaut est `/v1/chat/completions` ; les bases sont donc choisies
 * pour que `base + chemin` tombe JUSTE sur l'URL de la doc (Venice → .../api,
 * OpenRouter → .../api), et DeepSeek pose son propre `chemin`.
 *
 * PAS DE FILTRE CÔTÉ APPLICATION pour l'instant (choix du propriétaire, 05/10 :
 * « le plancher légal, on le mettra plus tard, personne n'utilise le site »).
 * Le crochet est laissé — `filtreSortie` ci-dessous, aujourd'hui l'identité :
 * le jour venu, un garde-fou s'y branche sans toucher au reste. Les
 * fournisseurs amont gardent de toute façon LEUR propre plancher (contenu
 * illégal), que l'on ne contourne pas.
 *
 * Aucune logique d'argent ici (c'est `studio_chat.js`). On rend l'usage sous
 * la forme que la facturation lit déjà (celle d'Anthropic) : input_tokens,
 * output_tokens, cache_read_input_tokens — et `coutExactUsd` quand le
 * fournisseur le donne (xAI : ticks ; OpenRouter : cost). La recherche web
 * (`recherche`) passe par la Search API de Perplexity AVANT l'appel : voir
 * studio_recherche.js. */

const { SYSTEME } = require('./studio_claude');
const Rech = require('./studio_recherche');
const AlerteSolde = require('./alerte_solde');
const Pieces = require('./studio_pieces');

/* Chaque fournisseur : `base()` l'origine (sans le chemin), `cle()` sa clé
   d'environnement. `chemin` surcharge `/v1/chat/completions` quand la doc
   l'exige (DeepSeek). `entetes()` ajoute des en-têtes optionnels (OpenRouter). */
const FOURNISSEURS = {
  openai: { base: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com', cle: () => process.env.OPENAI_API_KEY || '' },
  xai: { base: () => process.env.XAI_BASE_URL || 'https://api.x.ai', cle: () => process.env.XAI_API_KEY || process.env.GROK_API_KEY || '' },
  /* base .../api → + /v1/chat/completions = api.venice.ai/api/v1/chat/completions (doc 05/10). */
  venice: { base: () => process.env.VENICE_BASE_URL || 'https://api.venice.ai/api', cle: () => process.env.VENICE_API_KEY || '' },
  /* base .../api → + /v1/chat/completions = openrouter.ai/api/v1/chat/completions ; en-têtes d'identité. */
  openrouter: { base: () => process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api', cle: () => process.env.OPENROUTER_API_KEY || '',
    entetes: () => ({ 'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://swoleeswoge.dog', 'X-Title': 'SWOGE AI' }) },
  /* DeepSeek : chemin SANS /v1 (doc 05/10) → base nue + chemin explicite. */
  deepseek: { base: () => process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', cle: () => process.env.DEEPSEEK_API_KEY || '', chemin: '/chat/completions' },
  /* base nue → + /v1/chat/completions = api.mistral.ai/v1/chat/completions. */
  mistral: { base: () => process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai', cle: () => process.env.MISTRAL_API_KEY || '' },
};
function actif(f) { return !!(FOURNISSEURS[f] && String(FOURNISSEURS[f].cle()).trim()); }

/* Le crochet du plancher légal, laissé volontairement NEUTRE (05/10) : il voit
   le texte au fil de l'eau et le rend tel quel. Le jour où le propriétaire pose
   le garde-fou, c'est ici qu'il se branche — sans toucher au reste du flux. */
function filtreSortie(morceau) { return morceau; }

/* L'usage d'un fournisseur « Chat Completions », mis dans la forme lue par la
   facturation. Le cache n'est remisé qu'à OpenAI (0,1× l'entrée sur GPT-6,
   comme Anthropic) ; chez xAI la remise est moindre (0,25× sur Grok 4.7) : on
   compte tout au plein tarif, et c'est le coût exact rendu qui fait foi. */
function usageDe(f, u) {
  if (!u) return {};
  const entree = Number(u.prompt_tokens) || 0;
  const cache = f === 'openai' ? (Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0) : 0;
  const o = { input_tokens: entree - cache, cache_read_input_tokens: cache, output_tokens: Number(u.completion_tokens) || 0 };
  if (Number.isFinite(Number(u.cost_in_usd_ticks)) && Number(u.cost_in_usd_ticks) > 0) o.coutExactUsd = Number(u.cost_in_usd_ticks) / 1e10;
  /* OpenRouter rend TOUJOURS `cost` (crédits, 1 = 1 $) : le coût EXACT du modèle
     amont, quel qu'il soit. Il fait foi — on ne devine pas le prix d'un buffet. */
  if (f === 'openrouter' && Number.isFinite(Number(u.cost)) && Number(u.cost) > 0) o.coutExactUsd = Number(u.cost);
  return o;
}

/**
 * Une réponse en streaming. `m.fournisseur` : 'openai' | 'xai'. `surTexte`
 * reçoit le texte au fil de l'eau ; `surReflexion` est appelé une fois quand le
 * modèle raisonne avant d'écrire (on ne voit pas son raisonnement).
 */
async function repond({ m, messages, recherche, effort, surTexte, surReflexion, surRecherche, signal, systeme }) {
  const F = FOURNISSEURS[m.fournisseur];
  if (!F) throw new Error('fournisseur inconnu : ' + m.fournisseur);
  /* La recherche web, faite AVANT : ses résultats rejoignent la question, et
     deviennent les pastilles de sources. Une requête réussie est facturée par
     Perplexity même vide ; une requête ratée ne l'est pas — on répond alors
     sans, et on ne la facture pas non plus. */
  let envoyes = messages, sources = [], recherches = 0;
  if (recherche && m.recherche === 'perplexity') {
    if (surRecherche) surRecherche();
    try {
      const res = await Rech.cherche(Rech.requeteDe(messages));
      recherches = 1;
      if (res.length) {
        sources = res.map((x) => ({ url: x.url, titre: x.titre }));
        const der = messages[messages.length - 1];
        envoyes = messages.slice(0, -1).concat([Object.assign({}, der, { content: der.content + '\n\n---\n' + Rech.contexte(res) })]);
      }
    } catch (e) {
      console.warn('[chat] recherche web ratee (' + String(e.message || e).slice(0, 80) + ') : reponse sans');
      /* un 401 de Perplexity : cle refusee OU compte sans credit (indistinguables) */
      AlerteSolde.erreur('perplexity', e);
    }
  }
  const corps = {
    model: m.api, stream: true, stream_options: { include_usage: true },
    max_completion_tokens: m.maxTokens,
    /* Une photo jointe devient une partie `image_url` (data URL) ; jamais de PDF ici. */
    /* `systeme` (chat_x402, 27/09) : celui de l'appelant ; '' : aucun. */
    messages: (typeof systeme === 'string' ? (systeme ? [{ role: 'system', content: systeme }] : []) : [{ role: 'system', content: SYSTEME }]).concat(envoyes.map(Pieces.pourCompat)),
  };
  if (effort && m.effort) corps.reasoning_effort = effort;
  if (surReflexion) surReflexion();
  /* Le chemin par défaut `/v1/chat/completions`, surchargé là où la doc l'exige
     (DeepSeek : `/chat/completions`). Les en-têtes optionnels d'un fournisseur
     (OpenRouter) rejoignent les en-têtes de base. */
  const chemin = F.chemin || '/v1/chat/completions';
  const entetes = Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + F.cle() },
    (typeof F.entetes === 'function' ? F.entetes() : null) || {});
  const r = await fetch(String(F.base()).replace(/\/$/, '') + chemin, {
    method: 'POST',
    headers: entetes,
    body: JSON.stringify(corps),
    /* L'arrêt du joueur OU le délai : AbortSignal.any (Node ≥ 20.3) ; sans lui, le délai seul (l'arrêt libère quand même la place). */
    signal: signal && AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(180000), signal]) : AbortSignal.timeout(180000),
  });
  /* Venice donne son solde sur CHAQUE reponse (x-venice-balance-usd, « before the
     request was processed », docs.venice.ai/api-reference/api-spec) : l'alerte de
     solde bas le lit au passage (09/10/2026). */
  if (m.fournisseur === 'venice') AlerteSolde.venice(r.headers.get('x-venice-balance-usd'));
  if (!r.ok || !r.body) {
    let msg = '', code = null, type = null;
    try {
      const j = await r.json();
      msg = (j.error && (j.error.message || j.error)) || j.message || '';
      if (j.error && typeof j.error === 'object') { code = j.error.code || null; type = j.error.type || null; }
    } catch (e) { /* corps illisible */ }
    /* statut, code et type gardes sur l'erreur : l'alerte de solde les classe
       sur ce que la doc du fournisseur ecrit (alerte_solde.classe), au lieu d'un
       simple texte (09/10/2026). */
    throw Object.assign(new Error(m.fournisseur + ' ' + r.status + (msg ? ' — ' + String(msg).slice(0, 160) : '')),
      { statut: r.status, code: code === null ? null : String(code), type, message_fournisseur: String(msg).slice(0, 300) });
  }
  const lecteur = r.body.getReader(), dec = new TextDecoder();
  let tampon = '', texte = '', usage = null, stop = null, servi = m.api;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    tampon += dec.decode(value, { stream: true });
    const lignes = tampon.split('\n'); tampon = lignes.pop();
    for (const l of lignes) {
      const x = l.trim();
      if (!x.startsWith('data:')) continue;
      const d = x.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch (e) { continue; }
      if (j.model) servi = j.model;
      if (j.usage) usage = j.usage;
      const c = j.choices && j.choices[0];
      if (c && c.delta && typeof c.delta.content === 'string' && c.delta.content) {
        const morceau = filtreSortie(c.delta.content);
        if (morceau) { texte += morceau; if (surTexte) surTexte(morceau); }
      }
      if (c && c.finish_reason) stop = c.finish_reason;
    }
  }
  return { texte, sources, usage: Object.assign(usageDe(m.fournisseur, usage), { recherches_perplexity: recherches }),
           stop: stop === 'content_filter' ? 'refusal' : stop, servi };
}

module.exports = { repond, actif, usageDe, filtreSortie, FOURNISSEURS };
