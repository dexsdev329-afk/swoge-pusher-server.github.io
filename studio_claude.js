'use strict';
/* ==================================================================
 * SWOGE AI CHAT — le fournisseur Anthropic (Claude)
 * ==================================================================
 *
 * Un seul rôle : envoyer la conversation à Claude par le SDK officiel
 * (`@anthropic-ai/sdk`), relayer le texte au fil de l'eau, et rendre ce que
 * la facturation a besoin de lire — `usage`, la raison d'arrêt, le modèle qui
 * a réellement servi. Aucune logique d'argent ici : c'est `studio_chat.js`
 * qui réserve, facture et rend. Chaque fournisseur (OpenAI, Grok…) aura SON
 * fichier, avec SON SDK : on ne mélange pas deux SDK dans un même module.
 *
 * Choix posés d'après la référence de l'API (relue le 24 septembre 2026) :
 *   - pas de paramètre `thinking` : Opus 5.5 et Fable 5.1 réfléchissent
 *     toujours (le désactiver est un 400), Sonnet 5 part en adaptatif, Haiku
 *     4.5 sans réflexion. La profondeur se règle par `output_config.effort`.
 *   - la recherche web est l'outil serveur `web_search` (version par modèle,
 *     voir `studio_chat.MODELES`), au plus RECHERCHE_MAX appels : c'est ce
 *     qui donne des réponses sourcées façon Perplexity.
 *   - Fable 5.1 porte le repli côté serveur recommandé (vers Opus 4.8) : un
 *     refus de ses classifieurs relance la même requête au lieu de s'arrêter.
 *   - streaming partout : les réponses longues ne butent pas sur un délai
 *     HTTP, et le joueur voit le texte arriver. */

const AnthropicMod = require('@anthropic-ai/sdk');
const Anthropic = AnthropicMod.default || AnthropicMod;
const { RECHERCHE_MAX } = require('./studio_chat');

const SYSTEME = [
  'You are SWOGE AI, the assistant of SWOGE WORLD.',
  'Answer in the language the user writes in. Be accurate, direct and useful; use Markdown when it helps (lists, tables, code blocks).',
  'When you used web search, base your claims on the sources you found and say when something is uncertain.',
  'Never give financial advice, price predictions or buy/sell calls about any token or asset, $SWOGE included.',
].join(' ');

let client = null;
function leClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 180000 });
  return client;
}
function actif() { return !!process.env.ANTHROPIC_API_KEY; }

/** Les sources d'une réponse : résultats de recherche et citations, sans doublon. */
function sourcesDe(content) {
  const vu = new Map();
  const ajoute = (url, titre) => {
    if (!url || vu.has(url) || vu.size >= 8) return;
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return; } catch (e) { return; }
    vu.set(url, { url, titre: String(titre || '').slice(0, 160) });
  };
  for (const b of content || []) {
    /* Une erreur d'outil serveur arrive en OBJET, un succès en LISTE. */
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.type === 'web_search_result') ajoute(r.url, r.title);
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c && c.url) ajoute(c.url, c.title);
    }
  }
  return Array.from(vu.values());
}

/**
 * Une réponse en streaming. `surTexte(delta)` reçoit le texte au fil de
 * l'eau ; `surReflexion()` et `surRecherche()` signalent ce que fait le
 * modèle pendant les silences. `deps.client` remplace le SDK dans l'essai.
 */
async function repond({ m, messages, recherche, effort, surTexte, surReflexion, surRecherche }, deps) {
  const c = (deps && deps.client) || leClient();
  const params = { model: m.api, max_tokens: m.maxTokens, system: SYSTEME, messages };
  if (effort) params.output_config = { effort };
  if (recherche) params.tools = [{ type: m.recherche, name: 'web_search', max_uses: RECHERCHE_MAX }];
  const stream = m.repli
    ? c.beta.messages.stream(Object.assign({}, params, {
      betas: ['server-side-fallback-2026-06-01'], fallbacks: [{ model: m.repli }] }))
    : c.messages.stream(params);

  for await (const ev of stream) {
    if (ev.type === 'content_block_start' && ev.content_block) {
      if (ev.content_block.type === 'thinking' && surReflexion) surReflexion();
      if (ev.content_block.type === 'server_tool_use' && surRecherche) surRecherche();
    }
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && surTexte) {
      surTexte(ev.delta.text);
    }
  }
  const fin = await stream.finalMessage();
  const texte = (fin.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    texte,
    sources: sourcesDe(fin.content),
    usage: fin.usage || {},
    stop: fin.stop_reason || null,
    servi: fin.model || m.api,
  };
}

module.exports = { repond, actif, sourcesDe, SYSTEME };
