'use strict';
/* ==================================================================
 * SWOLEMIND — LA RECHERCHE WEB POUR TOUS LES MODÈLES (Perplexity Search API)
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : « la recherche web pour
 * tous les modèles — c'est la promesse de Perplexity ». Claude cherche seul
 * (son outil serveur `web_search`) ; GPT-6 et Grok n'ont pas d'outil branché
 * ici. On leur donne donc les résultats d'une recherche faite AVANT, et ils
 * répondent en citant [1], [2]… — les mêmes pastilles de sources que Claude.
 *
 * Le choix de l'API, relu dans la documentation de Perplexity le même jour :
 * la Router API n'a PAS de recherche web (« No web grounding ») ; la Search API
 * rend des résultats bruts classés, à donner à n'importe quel modèle. C'est
 * elle. Spécification OpenAPI :
 *   POST https://api.perplexity.ai/search, Authorization: Bearer
 *   { query, max_results (≤ 20), max_tokens_per_page, search_type web|fast }
 *   → { id, results: [{ title, url, snippet, date, last_updated }] }
 * Prix : 5 $ les 1 000 requêtes réussies (0,005 $), aucun jeton facturé ;
 * une requête en échec ou limitée n'est pas facturée. La clé :
 * `PERPLEXITY_API_KEY` ; `PERPLEXITY_BASE_URL` remplace l'hôte dans l'essai.
 * ================================================================== */

const PRIX_USD = 0.005;
const MAX_RESULTATS = 6;
const JETONS_PAR_PAGE = 500;
/* Le pire cas de ce que la recherche ajoute à l'entrée du modèle, en jetons :
   six pages de 500 jetons, plus les titres, adresses et consignes. */
const JETONS_CONTEXTE = MAX_RESULTATS * JETONS_PAR_PAGE + 1500;

function cle() { return (process.env.PERPLEXITY_API_KEY || '').trim(); }
function actif() { return !!cle(); }
const BASE = () => (process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai').replace(/\/$/, '');

/** La question à chercher : le dernier message du joueur, borné. */
function requeteDe(messages) {
  const d = (messages || []).filter((m) => m.role === 'user').pop();
  return String((d && d.content) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** Cherche ; rend les résultats (https seulement), ou lève. */
async function cherche(requete) {
  const r = await fetch(BASE() + '/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cle() },
    body: JSON.stringify({ query: requete, max_results: MAX_RESULTATS, max_tokens_per_page: JETONS_PAR_PAGE }),
    signal: AbortSignal.timeout(20000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const e = new Error('perplexity search ' + r.status);
    e.statut = r.status;
    throw e;
  }
  return ((j && j.results) || []).filter((x) => x && /^https?:\/\//.test(String(x.url || '')))
    .slice(0, MAX_RESULTATS)
    .map((x) => ({ url: String(x.url), titre: String(x.title || '').slice(0, 160),
                   extrait: String(x.snippet || '').slice(0, 4000), date: x.date || x.last_updated || null }));
}

/** Les résultats, mis en texte pour le modèle, numérotés comme les pastilles de la page. */
function contexte(resultats) {
  return ['Web search results (use them, and cite each claim with its number like [1] or [2]; say so when they do not answer the question):']
    .concat(resultats.map((x, i) => '[' + (i + 1) + '] ' + x.titre + (x.date ? ' (' + x.date + ')' : '') + '\n' + x.url + '\n' + x.extrait))
    .join('\n\n');
}

module.exports = { actif, cherche, contexte, requeteDe, PRIX_USD, JETONS_CONTEXTE, MAX_RESULTATS };
