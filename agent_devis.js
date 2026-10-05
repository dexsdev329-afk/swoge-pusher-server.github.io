'use strict';
/* ==================================================================
 * LE VRAI DEVIS D'UN GESTE — LECTURE SEULE (etape 8c, piece 1/6)
 * ==================================================================
 *
 * Remplace le placeholder papier (impact 1 %) par un devis REEL, via le quoter
 * du miroir (miroir.js : routeDe + devisJambe/devisRoute, QuoterV3/V4). AUCUNE
 * signature, aucun gaz, aucune cle : c'est de la LECTURE. Tant que l'executeur
 * reel (piece 2, derriere son drapeau) n'est pas pose, ce devis ne sert qu'a
 * rendre la decision papier EXACTE.
 *
 * L'impact-prix est estime proprement : on demande le prix a TAILLE REELLE et le
 * prix a une taille minuscule (le prix marginal, ~spot), et l'ecart est l'impact.
 * Un gros ordre sur une piscine mince ressort avec un gros impact — c'est ce que
 * la policy et le signer bornent.
 *
 * `quote(entree)` est INJECTE (le serveur le cable sur le miroir) : aucun essai
 * ne sort de la machine. Tout en nombres (meme unite entree/sortie) : pour un
 * RATIO d'impact, c'est exact et sans dependance BigNumber.
 * ================================================================== */

const rond = (x, d) => { const p = Math.pow(10, d == null ? 6 : d); return Math.round(Number(x) * p) / p; };

/**
 * devis(o, deps) : le devis reel d'un geste, en lecture seule.
 * o : { pool, entree, refEntree? }  (entree = ce qu'on met, p. ex. du WETH pour un buyback)
 * deps : { quote(entree) -> sortie }  (lie a un pool et un sens par le serveur, via le miroir)
 * Rend { ok, pool, sortie, impactPct, prixSpot } ou { ok:false, raison }.
 */
async function devis(o, deps) {
  o = o || {}; deps = deps || {};
  if (typeof deps.quote !== 'function') return { ok: false, raison: 'no quoter' };
  const entree = Number(o.entree);
  if (!(entree > 0)) return { ok: false, raison: 'entree must be positive' };
  const ref = Number(o.refEntree) > 0 ? Number(o.refEntree) : entree / 1000;   /* une taille minuscule : le prix marginal */
  let sortie, sortieRef;
  try { sortie = Number(await deps.quote(entree)); sortieRef = Number(await deps.quote(ref)); }
  catch (e) { return { ok: false, raison: 'quote failed: ' + String((e && e.message) || e).slice(0, 80) }; }
  if (!(sortie > 0) || !(sortieRef > 0)) return { ok: false, raison: 'quote returned zero (no liquidity?)' };
  const prix = sortie / entree;              /* sortie par unite d'entree, a taille reelle */
  const prixSpot = sortieRef / ref;          /* ~ le prix marginal (spot) */
  const impactPct = Math.max(0, rond((1 - prix / prixSpot) * 100, 4));
  return { ok: true, pool: o.pool, sortie: rond(sortie), impactPct, prixSpot: rond(prixSpot, 12) };
}

module.exports = { devis };
