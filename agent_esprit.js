'use strict';
/* ==================================================================
 * L'ESPRIT D'UN AGENT — la boucle d'outils autonome (sans humain)
 * ==================================================================
 *
 * Modele AgencyPad : a chaque pulsation, l'esprit d'un jeton recoit son etat et
 * une BOITE A OUTILS, et DECIDE lui-meme quoi faire — lire son marche, verifier
 * qu'on peut revendre, chercher sur le web, poster, proposer un rachat. Aucun
 * humain dans la boucle.
 *
 * Les outils sont de deux natures :
 *   - LECTURE (sans argent, sans risque) : scan_token, can_i_sell, market,
 *     read_feed, web_search. L'esprit les enchaine pour se renseigner.
 *   - ACTION : post(texte) → passe par le mur/X (nos garde-fous d'image/pattes) ;
 *     propose_buyback(usd) → passe par la BOUCLE TRADER (pare-feu → policy →
 *     signer), donc EN PAPIER tant que l'etage reel n'est pas ouvert, et
 *     seulement si le createur a active le rachat.
 *
 * Bornes dures : au plus `maxEtapes` pensees, au plus 1 post et 1 proposition
 * d'argent par pulsation, et CHAQUE pensee coute du carburant (agent_fuel) — a
 * sec, l'esprit dort. L'esprit n'a AUCUN outil qui prend une adresse, ne detient
 * aucune cle : il ne fait que choisir des outils, jamais signer.
 *
 * `modele` et `outils` sont injectes : aucun essai ne sort de la machine, le vrai
 * LLM (tool-use Anthropic via studio) et les vraies lectures se branchent cote serveur.
 * ================================================================== */

/* La boite a outils, decrite pour le modele. `agir` = modifie le monde (borne). */
const OUTILS = [
  { nom: 'scan_token', agir: false, desc: 'Read your own token: security flags, market, holders.' },
  { nom: 'can_i_sell', agir: false, desc: 'Check your token is sellable right now (round-trip, LP).' },
  { nom: 'market', agir: false, desc: 'Read live price, liquidity, 24h volume for your token.' },
  { nom: 'read_feed', agir: false, desc: 'Read your own recent posts (do not repeat them).' },
  { nom: 'web_search', agir: false, desc: 'Search the web for context (news, narratives).' },
  { nom: 'post', agir: true, desc: 'Publish a post in your persona. Facts only, never invent numbers.' },
  { nom: 'propose_buyback', agir: true, desc: 'Propose a buy-back-and-burn (goes through policy + signer).' },
  { nom: 'wait', agir: true, desc: 'Do nothing this pulse.' },
];
const PAR_NOM = Object.fromEntries(OUTILS.map((o) => [o.nom, o]));
const MAX_ETAPES = 4;

/**
 * pense(agent, deps) : une pulsation de l'esprit.
 * deps : {
 *   modele(ctx) -> { outil, args } | { fin },   // le LLM (injecte). ctx porte l'agent + ce qui a ete lu/fait.
 *   outils: { scan_token, can_i_sell, market, read_feed, web_search },  // impls de LECTURE (async)
 *   poste(agent, { texte }) -> { surX, url },    // l'action post (mur/X)
 *   traite(intent) -> { decide, recu? },         // propose_buyback -> boucle trader (papier)
 *   fuel, coutParPenseeUsd, plancherUsd,         // le carburant : a sec, on dort
 *   maxEtapes, maintenant,
 * }
 * Rend { dort?, etapes, actions:[...], lectures:[...], trace:[...] }.
 */
async function pense(agent, deps) {
  deps = deps || {};
  const max = deps.maxEtapes || MAX_ETAPES;
  const cout = Number(deps.coutParPenseeUsd || 0);
  const trace = [], actions = [], lectures = [];
  let aPoste = false, aPropose = false;

  for (let i = 0; i < max; i++) {
    /* carburant : chaque pensee coute ; a sec, l'esprit dort. */
    if (deps.fuel && !deps.fuel.peutPenser(agent.token, cout, deps.plancherUsd)) {
      if (i === 0) return { dort: true, raison: 'out of fuel', etapes: 0, actions, lectures, trace };
      break;
    }
    let d;
    try { d = await deps.modele({ agent: agent, lectures, actions, outils: OUTILS }); }
    catch (e) { trace.push({ etape: i, erreur: 'model: ' + String((e && e.message) || e).slice(0, 80) }); break; }
    if (deps.fuel && cout > 0) { try { deps.fuel.debite(agent.token, cout, 'thought'); } catch (e) {} }
    if (!d || d.fin || !d.outil) { trace.push({ etape: i, fin: true }); break; }
    const spec = PAR_NOM[d.outil];
    if (!spec) { trace.push({ etape: i, inconnu: d.outil }); continue; }

    if (!spec.agir) {                              /* ---- un outil de LECTURE ---- */
      let res = null;
      if (deps.outils && typeof deps.outils[d.outil] === 'function') {
        try { res = await deps.outils[d.outil](d.args || {}); } catch (e) { res = { erreur: String((e && e.message) || e).slice(0, 80) }; }
      }
      lectures.push({ outil: d.outil, res });
      trace.push({ etape: i, outil: d.outil, lu: true });
      continue;
    }
    /* ---- une ACTION, bornee ---- */
    if (d.outil === 'wait') { trace.push({ etape: i, outil: 'wait' }); break; }
    if (d.outil === 'post') {
      if (aPoste) { trace.push({ etape: i, outil: 'post', saute: 'deja poste ce tour' }); continue; }
      const texte = String((d.args && d.args.texte) || '').trim();
      if (!texte) { trace.push({ etape: i, outil: 'post', saute: 'texte vide' }); continue; }
      let r = { surX: false };
      if (typeof deps.poste === 'function') { try { r = await deps.poste(agent, { texte }); } catch (e) { r = { surX: false, erreur: String((e && e.message) || e).slice(0, 80) }; } }
      aPoste = true; actions.push({ action: 'post', surX: !!r.surX, url: r.url || null });
      trace.push({ etape: i, outil: 'post', ok: true });
      continue;
    }
    if (d.outil === 'propose_buyback') {
      if (!(agent.rachat && agent.rachat.actif)) { trace.push({ etape: i, outil: 'propose_buyback', refus: 'buyback not enabled by creator' }); continue; }
      if (aPropose) { trace.push({ etape: i, outil: 'propose_buyback', saute: 'deja propose ce tour' }); continue; }
      aPropose = true;
      let r = { decide: 'rejected', raison: 'no trader wired' };
      if (typeof deps.traite === 'function') {
        try { r = await deps.traite({ token: agent.token, action: 'buyback', montantUsd: Number(d.args && d.args.montantUsd), justification: d.args && d.args.justification }); }
        catch (e) { r = { decide: 'rejected', raison: String((e && e.message) || e).slice(0, 80) }; }
      }
      actions.push({ action: 'propose_buyback', decide: r.decide, recu: r.recu || null, raison: r.raison || null });
      trace.push({ etape: i, outil: 'propose_buyback', decide: r.decide });
      continue;
    }
  }
  return { etapes: trace.length, actions, lectures, trace };
}

module.exports = { pense, OUTILS, MAX_ETAPES };
