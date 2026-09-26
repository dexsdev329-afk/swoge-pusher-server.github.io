'use strict';
/* ==================================================================
 * SWOGE AI CHAT — les fournisseurs « Chat Completions » : OpenAI et xAI
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
 * Aucune logique d'argent ici (c'est `studio_chat.js`). On rend l'usage sous
 * la forme que la facturation lit déjà (celle d'Anthropic) : input_tokens,
 * output_tokens, cache_read_input_tokens — et `coutExactUsd` quand le
 * fournisseur le donne (xAI). La recherche web (`recherche`) passe par la
 * Search API de Perplexity AVANT l'appel : voir studio_recherche.js. */

const { SYSTEME } = require('./studio_claude');
const Rech = require('./studio_recherche');
const Pieces = require('./studio_pieces');

const FOURNISSEURS = {
  openai: { base: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com', cle: () => process.env.OPENAI_API_KEY || '' },
  xai: { base: () => process.env.XAI_BASE_URL || 'https://api.x.ai', cle: () => process.env.XAI_API_KEY || process.env.GROK_API_KEY || '' },
};
function actif(f) { return !!(FOURNISSEURS[f] && String(FOURNISSEURS[f].cle()).trim()); }

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
  return o;
}

/**
 * Une réponse en streaming. `m.fournisseur` : 'openai' | 'xai'. `surTexte`
 * reçoit le texte au fil de l'eau ; `surReflexion` est appelé une fois quand le
 * modèle raisonne avant d'écrire (on ne voit pas son raisonnement).
 */
async function repond({ m, messages, recherche, effort, surTexte, surReflexion, surRecherche }) {
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
    } catch (e) { console.warn('[chat] recherche web ratee (' + String(e.message || e).slice(0, 80) + ') : reponse sans'); }
  }
  const corps = {
    model: m.api, stream: true, stream_options: { include_usage: true },
    max_completion_tokens: m.maxTokens,
    /* Une photo jointe devient une partie `image_url` (data URL) ; jamais de PDF ici. */
    messages: [{ role: 'system', content: SYSTEME }].concat(envoyes.map(Pieces.pourCompat)),
  };
  if (effort && m.effort) corps.reasoning_effort = effort;
  if (surReflexion) surReflexion();
  const r = await fetch(String(F.base()).replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + F.cle() },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok || !r.body) {
    let msg = '';
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { /* corps illisible */ }
    throw new Error(m.fournisseur + ' ' + r.status + (msg ? ' — ' + String(msg).slice(0, 160) : ''));
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
        texte += c.delta.content;
        if (surTexte) surTexte(c.delta.content);
      }
      if (c && c.finish_reason) stop = c.finish_reason;
    }
  }
  return { texte, sources, usage: Object.assign(usageDe(m.fournisseur, usage), { recherches_perplexity: recherches }),
           stop: stop === 'content_filter' ? 'refusal' : stop, servi };
}

module.exports = { repond, actif, usageDe };
