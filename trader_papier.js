'use strict';
/* ==================================================================
 * LA BOUCLE TRADER — EN PAPIER — relie les trois garde-fous
 * ==================================================================
 *
 * Phase 1, etape 8b-ii. L'esprit d'un agent PROPOSE un geste d'argent (buyback,
 * sell, airdrop, swap). Ici on le fait passer par toute la chaine d'AgencyPad,
 * EN PAPIER (rien ne bouge de crypto) :
 *
 *   1. PARE-FEU  — on nettoie la justification (texte) de l'esprit : adresses
 *      retirees, injections/usurpations bloquees. Le POOL cible ne vient JAMAIS
 *      de l'intention : il vient du registre (deps.pool). Un geste n'agit que
 *      sur le pool du jeton, jamais sur une adresse d'un message.
 *   2. POLICY    — plafonds action/heure/jour, impact, cooldown, tresor.
 *   3. SIGNER    — resimule (devis) et ne signe que l'approuve → transaction PAPIER.
 *   4. COMPTA    — le tresor papier du jeton est debite ; la politique note le geste.
 *
 * Rend une TRACE (chaque etape, son verdict) : c'est ce qu'on mesure avant de
 * jamais ouvrir l'execution reelle. Pur + injectable.
 *
 * L'EXECUTION REELLE (8c) se branche a l'etape 3, SANS toucher le reste : si
 * `deps.executeReel` est fourni ET actif (son propre verrou : drapeau + cle dediee),
 * c'est LUI qui agit a la place du signer papier — rachat-et-brule reel. Il garde ses
 * garde-fous (meme pool, devis reel, impact borne) et peut refuser (inerte tant que
 * l'envoyeur on-chain n'est pas cable). Sans lui, ou inerte, la chaine reste 100 %
 * papier : rien ne bouge de crypto. La policy NOTE le geste dans les deux cas (les
 * plafonds/cooldown s'appliquent au reel comme au papier) ; seul le tresor PAPIER est
 * debite en mode papier — le reel se compte sur la chaine (txHash), pas sur le papier.
 * ================================================================== */

/**
 * decide(intent, deps) : fait passer un geste propose par la chaine, en papier.
 * intent : { token, action, montantUsd, justification? }  (l'esprit propose)
 * deps : {
 *   pool,                       // le pool du jeton, LU AU REGISTRE (jamais de l'intention)
 *   tresor: { solde(token), debite(token, usd, raison) },
 *   policy,                     // policy_argent.cree(...)
 *   signer,                     // signer_papier.cree(...)
 *   devis(approuve) -> sim,     // la resimulation (injectee ; miroir plus tard)
 *   pareFeu,                    // pare_feu (optionnel) pour nettoyer la justification
 *   limites,                    // bornes de la politique (optionnel)
 * }
 * Rend { decide: 'signed-paper'|'rejected', etape, raison?, recu?, trace:[...] }.
 */
async function decide(intent, deps) {
  intent = intent || {}; deps = deps || {};
  const trace = [];
  const refus = (etape, raison) => { trace.push({ etape, ok: false, raison }); return { decide: 'rejected', etape, raison, trace }; };

  /* 1. pare-feu sur la justification de l'esprit (defensif : pas d'adresse, pas d'injection). */
  if (intent.justification && deps.pareFeu) {
    const pf = await deps.pareFeu.filtre(intent.justification);
    if (!pf.ok) return refus('firewall', pf.raison);
    trace.push({ etape: 'firewall', ok: true });
  }

  /* 2. l'intention approuvee : le POOL vient du registre, jamais de l'intention. */
  if (!deps.pool) return refus('intent', 'no pool for this token (registry)');
  const lim = deps.limites || (deps.policy && deps.policy.limites) || {};
  const approuve = { token: intent.token, action: intent.action, montantUsd: intent.montantUsd,
    pool: deps.pool, impactMaxPct: lim.impactMaxPct != null ? lim.impactMaxPct : 2 };

  /* 3. policy engine. */
  const tresorUsd = deps.tresor ? deps.tresor.solde(intent.token) : 0;
  const ev = deps.policy.evalue(approuve, { tresorUsd, limites: deps.limites });
  if (!ev.autorise) return refus('policy', ev.raison);
  trace.push({ etape: 'policy', ok: true, reste: ev.reste });

  /* 4a. EXECUTION REELLE (8c), si et seulement si un executeur reel est fourni ET actif.
     Il remplace alors le signer papier (rachat-et-brule reel). Inerte/refus => on rejette :
     on ne retombe JAMAIS en papier en douce quand le reel est demande mais refuse. */
  if (deps.executeReel && typeof deps.executeReel.actif === 'function' && deps.executeReel.actif()) {
    const er = await deps.executeReel.execute(approuve, { devis: deps.devis });
    if (!er || er.execute !== true) return refus('execute-real', (er && er.raison) || 'real execution refused');
    trace.push({ etape: 'execute-real', ok: true, recu: er.recu });
    /* Le reel se compte sur la chaine (txHash), pas sur le tresor papier : on NE debite PAS
       le papier. Mais la policy note le geste : plafonds/cooldown s'appliquent au reel. */
    deps.policy.note(approuve);
    return { decide: 'executed-real', etape: 'done', recu: er.recu, trace };
  }

  /* 4b. signer isole (papier) : resimule et ne signe que l'approuve. */
  const sg = await deps.signer.signe(approuve, { devis: deps.devis });
  if (!sg.signe) return refus('signer', sg.raison);
  trace.push({ etape: 'signer', ok: true, recu: sg.recu });

  /* 5. compta papier : debite le tresor, note le geste pour les fenetres/cooldown. */
  if (deps.tresor) deps.tresor.debite(intent.token, approuve.montantUsd, approuve.action);
  deps.policy.note(approuve);
  return { decide: 'signed-paper', etape: 'done', recu: sg.recu, trace };
}

module.exports = { decide };
