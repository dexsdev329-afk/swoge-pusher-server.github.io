'use strict';
/* ==================================================================
 * L'ORDONNANCEUR DES AGENTS DE JETON — « ils postent tout seuls »
 * ==================================================================
 *
 * Phase 1, etape 7. Un tour regarde quels agents sont DUS (agent_jeton.dus,
 * selon leur cadence), fait composer leur post (agent_poste) a partir de leurs
 * faits (agent_faits), puis ROUTE la publication :
 *   - si le jeton a un compte X relie (opt-in, injecte via deps.poste) → sur X ;
 *   - sinon → seulement sur le mur du jeton (agent_feed). Jamais le compte maison.
 * Le post est TOUJOURS ecrit sur le mur, qu'il parte sur X ou non.
 *
 * Tout est injecte (registre, feed, recolte, compose, poste) : aucun essai ne
 * sort de la machine, l'IA n'est appelee qu'avec une cle. Un agent qui echoue
 * n'arrete pas les autres. L'ordonnanceur NE DEMARRE PAS tout seul : le serveur
 * le branche derriere un drapeau (AGENT_HORLOGE=1), donc rien ne poste en prod
 * tant qu'il n'est pas allume.
 * ================================================================== */

const MAX_PAR_TOUR = 8;

/**
 * Un tour de l'ordonnanceur.
 * deps : {
 *   registre,                         // agent_jeton.cree(...)
 *   feed,                             // agent_feed.cree(...)
 *   recolte(agent)→{faits},           // par agent (le serveur monte les adaptateurs sur son pool)
 *   compose(o,posteDeps)→{texte,via}, posteDeps,
 *   poste(agent,post)→{surX,url},     // optionnel : publie sur le compte X du jeton si relie
 *   max, maintenant,
 * }
 * Rend { tour, agis, faits:[{token, surX, erreur?}] }.
 */
async function tour(deps) {
  deps = deps || {};
  if (!deps.registre || !deps.feed) throw new Error('tour : il faut un registre et un feed');
  const now = deps.maintenant ? deps.maintenant() : Date.now();
  const compose = deps.compose || require('./agent_poste').compose;
  const dus = deps.registre.dus(now).slice(0, deps.max || MAX_PAR_TOUR);
  const coutPost = Number(deps.coutPostUsd || 0);
  const faits = [];
  for (const a of dus) {
    try {
      /* Le budget de posts du jour (regle par le createur) : atteint → l'agent DORT.
         (le mur garde l'heure de chaque post ; on compte ceux des dernieres 24 h.) */
      if (a.postsParJourMax && typeof deps.feed.depuis === 'function' && deps.feed.depuis(a.token, 86400000, now) >= a.postsParJourMax) {
        faits.push({ token: a.token, dort: true, raison: 'daily post budget reached' });
        continue;
      }
      /* Le carburant (agent_fuel) : sous le cout, l'agent DORT — on ne pense jamais a credit.
         Garde optionnelle : sans deps.fuel, l'ordonnanceur se comporte comme avant. */
      if (deps.fuel && !deps.fuel.peutPenser(a.token, coutPost, deps.plancherUsd)) {
        faits.push({ token: a.token, dort: true, raison: 'out of fuel' });
        continue;
      }
      let liste = [];
      if (typeof deps.recolte === 'function') { try { const r = await deps.recolte(a); if (r && Array.isArray(r.faits)) liste = r.faits; } catch (e) { /* pas de faits */ } }
      const precedents = deps.feed.recent(a.token, 3).map((e) => e.texte);
      const post = await compose({ persona: a.persona, objectif: a.objectif, langue: a.langue,
        symbole: a.symbole, nom: a.nom, faits: liste, precedents }, deps.posteDeps);
      let surX = false, url = null;
      if (typeof deps.poste === 'function') {
        try { const p = await deps.poste(a, post); if (p && p.surX) { surX = true; url = p.url || null; } }
        catch (e) { /* X en echec : on garde le post sur le mur, on ne perd rien */ }
      }
      deps.feed.ajoute(a.token, { texte: post.texte, via: post.via, surX, url, faits: liste });
      deps.registre.noteGeste(a.token, 'post', now);
      if (deps.fuel && coutPost > 0) { try { deps.fuel.debite(a.token, coutPost, 'post'); } catch (e) { /* la compta ne fait pas rater le post */ } }
      faits.push({ token: a.token, surX, via: post.via });
    } catch (e) {
      faits.push({ token: a.token, erreur: String((e && e.message) || e).slice(0, 120) });
    }
  }
  return { tour: now, agis: faits.filter((f) => !f.erreur && !f.dort).length, dorment: faits.filter((f) => f.dort).length, faits };
}

/** Branche un tour periodique. NE FAIT RIEN sans `actif` (le serveur passe le
 *  drapeau AGENT_HORLOGE). Rend { arrete() }. Le premier tour est differe. */
function planifie(deps, opts) {
  opts = opts || {};
  if (!opts.actif) return { arrete() {} };
  const periodeMs = Math.max(60000, opts.periodeMs || 5 * 60000);
  const tourNer = () => tour(deps).catch((e) => console.error('[agent] horloge : ' + (e && e.message || e)));
  const premier = setTimeout(tourNer, opts.premierMs || 120000);
  const minuterie = setInterval(tourNer, periodeMs);
  return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
}

module.exports = { tour, planifie, MAX_PAR_TOUR };
