'use strict';
/* ==================================================================
 * L'AUTO-FINANCEMENT DU CARBURANT DEPUIS LES FRAIS (vague 1, #6)
 * ==================================================================
 *
 * Le modele AgencyPad : « les frais de trading du jeton gardent l'agent en vie ».
 * Jusqu'ici le carburant d'un agent venait d'une dotation unique + des recharges
 * MANUELLES (le createur, ou le proprietaire en admin). Sans ce module, l'autonomie
 * dependait d'une main humaine : un agent finissait par dormir « out of fuel ».
 *
 * Ici, un passage periodique : pour chaque jeton, on lit NOTRE part de frais accumulee
 * DEPUIS LE DERNIER PASSAGE (lecture on-chain, injectee), on en prend `pctFuel` %, et on
 * l'affecte via la MEME cascade que la recharge manuelle (carburant d'abord, puis tresor,
 * puis rachat) — `deps.credite`, exactement la comptabilite de /agent/caisse/alimente.
 *
 * DEUX garde-fous, parce que ca touche la compta :
 *   - IDEMPOTENT : le curseur (bloc deja lu) n'avance QUE lorsqu'on a vraiment credite,
 *     donc on ne compte jamais deux fois les memes frais. En mode essai (applique=false),
 *     on ne credite rien et on n'avance pas le curseur : le vrai montant sera pris plus tard.
 *   - MESURER D'ABORD : par defaut `applique=false` (essai) — le passage JOURNALISE ce qu'il
 *     CREDITERAIT, sans rien crediter. Le proprietaire lit les montants, puis met
 *     AGENT_FEE_AUTO=1 (applique=true) en connaissance de cause. Fail-closed : une lecture
 *     de frais qui echoue (null) saute le jeton, jamais une fausse recharge.
 *
 * Pur + injectable : aucun essai ne sort de la machine, aucune cle ici. Le carburant est un
 * credit en dollars (il paie NOTRE API) : rien d'on-chain n'est signe ni deplace par ce module.
 * ================================================================== */

const r2 = (x) => Math.round(Number(x) * 100) / 100;

/**
 * alimente(deps) : un passage d'auto-financement.
 * deps : {
 *   tokens: [adresse…],
 *   pctFuel,                                   // part de NOTRE frais affectee (defaut 15)
 *   feesDepuis(token) -> { feeShareUsd, curseur } | null,   // NOTRE part de frais (USD) depuis le curseur, + le nouveau curseur
 *   credite(token, usd, 'fees') -> repartition,             // la cascade (carburant/tresor/rachat) — comme la recharge
 *   poseCurseur(token, curseur),               // avance le curseur durable (idempotence)
 *   applique,                                  // true = credite reellement ; false = essai (journalise seulement)
 * }
 * Rend { quand, applique, faits:[{token, feeShareUsd, credite?|auraitCredite, repartition?, erreur?}] }.
 */
async function alimente(deps) {
  deps = deps || {};
  const tokens = deps.tokens || [];
  const pct = Math.max(0, Math.min(100, Number(deps.pctFuel != null ? deps.pctFuel : 15)));
  const applique = !!deps.applique;
  const faits = [];
  for (const token of tokens) {
    let f = null;
    try { f = await deps.feesDepuis(token); } catch (e) { f = null; }
    if (!f || !(Number(f.feeShareUsd) > 0)) continue;   /* fail-closed : rien a crediter ou lecture muette */
    const usd = r2(Number(f.feeShareUsd) * pct / 100);
    if (!(usd > 0)) continue;
    if (!applique) { faits.push({ token, feeShareUsd: r2(f.feeShareUsd), auraitCredite: usd, essai: true }); continue; }
    let rep;
    try { rep = await deps.credite(token, usd, 'fees'); }
    catch (e) { faits.push({ token, erreur: String((e && e.message) || e).slice(0, 80) }); continue; }
    /* Le curseur n'avance QU'APRES un credit reussi : jamais deux fois les memes frais. */
    if (f.curseur != null && typeof deps.poseCurseur === 'function') { try { await deps.poseCurseur(token, f.curseur); } catch (e) {} }
    faits.push({ token, feeShareUsd: r2(f.feeShareUsd), credite: usd, repartition: rep });
  }
  return { quand: Date.now(), applique, faits };
}

module.exports = { alimente };
