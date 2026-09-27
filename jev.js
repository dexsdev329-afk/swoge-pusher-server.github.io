'use strict';
/* ==========================================================================
 * JEV (TypeSafe AI) — DES DECISIONS TYPEES, EN MESURE D'ABORD
 *
 * Demande du proprietaire, 27 septembre 2026. Jev n'ecrit pas de texte : on lui
 * donne une situation (`state`) et des questions fermees, il rend des
 * probabilites. Documentation officielle lue le meme jour (docs.typesafe.ai,
 * « API reference ») :
 *   POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <cle>
 *   { state: texte | objet, model: 'jev-latest', questions: { <id>: {
 *       type: 'noul' | 'choice' | 'score', instructions, criteria? } } }
 *   → { model, answers: { <id>: { type, noul?, choice?, score?, confidence,
 *       probabilities? } }, usage: { input_tokens, output_tokens } }
 * Il ne lit que du texte, ne calcule pas, n'explique pas (docs, « Jev with
 * coding agents »). Prix publie par un article du 27/09 (flaviocopes.com/jev) :
 * 0,042 $ par million de jetons d'entree, sortie gratuite — A CONFIRMER sur la
 * console TypeSafe ; le cout compte ici l'est a ce tarif, reglable
 * (JEV_USD_PAR_M).
 *
 * Premier usage : l'observatoire lui demande, pour chaque jeton, la probabilite
 * qu'il monte de 20 % en 30 min et celle qu'il disparaisse ; ses reponses
 * deviennent un trait, juge a 30 min comme les autres. Aucune decision n'en
 * depend tant que ce trait n'a pas montre qu'il separe quelque chose.
 * ======================================================================== */
const URL_API = 'https://api.typesafe.ai/v1/systemone';
const DELAI_MS = 10000;

function cree(deps) {
  deps = deps || {};
  const cle = () => String((deps.cle ? deps.cle() : process.env.TYPESAFE_API_KEY) || '').trim();
  const chercher = deps.fetch || ((u, o) => fetch(u, Object.assign({ signal: AbortSignal.timeout(DELAI_MS) }, o || {})));
  const usdParM = () => (Number(process.env.JEV_USD_PAR_M) > 0 ? Number(process.env.JEV_USD_PAR_M) : 0.042);
  const MESURE = { appels: 0, echecs: 0, jetonsEntree: 0, coutUsd: 0, dernierEchec: null };
  const actif = () => !!cle();

  /** Pose des questions. Rend { ok, answers, usage, coutUsd } ou { ok:false, raison } — jamais d'exception. */
  async function demande(state, questions) {
    if (!actif()) return { ok: false, raison: 'Jev is not set up (TYPESAFE_API_KEY)' };
    MESURE.appels++;
    try {
      const r = await chercher(URL_API, { method: 'POST',
        headers: { authorization: 'Bearer ' + cle(), 'content-type': 'application/json' },
        body: JSON.stringify({ state, model: 'jev-latest', questions }) });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok || !j || !j.answers) {
        MESURE.echecs++;
        /* Le motif : un code HTTP ou le message du service, borne — jamais la cle. */
        MESURE.dernierEchec = String((j && (j.error && (j.error.message || j.error) || j.message)) || ('HTTP ' + r.status)).slice(0, 120);
        return { ok: false, raison: MESURE.dernierEchec };
      }
      const entree = Number(j.usage && j.usage.input_tokens) || 0;
      const cout = entree * usdParM() / 1e6;
      MESURE.jetonsEntree += entree; MESURE.coutUsd += cout;
      return { ok: true, modele: j.model || null, answers: j.answers, usage: j.usage || null, coutUsd: cout };
    } catch (e) {
      MESURE.echecs++; MESURE.dernierEchec = String((e && (e.name || e.message)) || 'error').slice(0, 60);
      return { ok: false, raison: MESURE.dernierEchec };
    }
  }

  return { actif, demande, MESURE };
}

module.exports = { cree, URL_API };
