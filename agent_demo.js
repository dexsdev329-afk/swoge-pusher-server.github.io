'use strict';
/* ==================================================================
 * APERÇU D'UN POST D'AGENT — relie le tout, ne publie RIEN
 * ==================================================================
 *
 * Phase 1, étape 4. Pour un jeton lancé qui a un agent (agent_jeton), produit
 * un APERÇU de ce que son agent posterait : registre → récolte de faits
 * (agent_faits) → compositeur (agent_poste) → image optionnelle (x_post,
 * contrôle pattes-de-chien). Rien n'est publié : c'est ce que la route démo
 * et l'ordonnanceur appelleront, le premier pour montrer, le second pour
 * ensuite téléverser et poster.
 *
 * Tout est injectable (registre, recolte, compose, image) : aucun essai ne
 * sort de la machine, et l'IA n'est appelée que si une clé est fournie.
 * ================================================================== */

const aj = require('./agent_jeton');

/* Le prompt d'image, dérivé de la persona : SWOGE en scène, pattes de chien
   (le contrôle verifiePattes de x_post refuse les mains humaines). */
function promptImage(persona, symbole) {
  const p = aj.PERSONAS[String(persona || '').toLowerCase()] || aj.PERSONAS.analyst;
  const scenes = {
    stoic: 'sitting calmly like a stone monk on a mountain at dawn',
    analyst: 'at a glowing trading desk studying charts, focused',
    contrarian: 'walking the opposite way through a crowd, confident smirk',
    hype: 'surfing a green candle wave, arms up, crowd cheering',
    builder: 'welding a glowing token in a neon workshop at night',
  };
  return `a very buff Shiba Inu (SWOGE), ${scenes[String(persona).toLowerCase()] || scenes.analyst}; `
    + `furry dog paws, never human hands or fingers; cinematic lighting`
    + (symbole ? `; a small holographic "$${symbole}" sign in the scene` : '')
    + ` — in the "${p.label}" mood`;
}

/**
 * Produit l'aperçu du prochain post d'un agent de jeton.
 * o : { token, symbole?, nom?, precedents?, lien?, avecImage?, maintenant? }
 * deps : {
 *   registre,                      // agent_jeton.cree(...) — obligatoire
 *   recolte(token)→{faits,sources},// defaut : agent_faits.recolte sans adaptateur = aucun fait
 *   compose(o,posteDeps)→{texte,via}, posteDeps,  // defaut : agent_poste.compose
 *   image(prompt)→{png,controle},  // optionnel ; appele seulement si avecImage
 * }
 * Rend { ok, agent, faits, post, image? } ou { ok:false, code, raison }.
 */
async function apercu(o, deps) {
  o = o || {}; deps = deps || {};
  const registre = deps.registre;
  if (!registre || typeof registre.parJeton !== 'function') throw new Error('apercu : il faut un registre');
  const agent = registre.parJeton(o.token);
  if (!agent) return { ok: false, code: 404, raison: 'no agent for this token' };
  if (!agent.actif) return { ok: false, code: 409, raison: 'this token\'s agent is paused' };

  const recolte = deps.recolte || require('./agent_faits').recolte;
  const compose = deps.compose || require('./agent_poste').compose;

  let faits = [];
  try { const r = await recolte(o.token, deps.recolteDeps); if (r && Array.isArray(r.faits)) faits = r.faits; }
  catch (e) { /* pas de faits : le compositeur postera en caractère sans citer de chiffre */ }

  const post = await compose({
    persona: agent.persona, objectif: agent.objectif, langue: agent.langue,
    symbole: o.symbole, nom: o.nom, faits, precedents: o.precedents || [], lien: o.lien,
  }, deps.posteDeps);

  const res = { ok: true, agent, faits, post };

  if (o.avecImage && typeof deps.image === 'function') {
    try {
      const g = await deps.image(promptImage(agent.persona, o.symbole));
      if (g && g.png) res.image = { octets: g.png.length, controle: g.controle || null };
    } catch (e) { res.imageErreur = String(e && e.message || e).slice(0, 120); }
  }
  return res;
}

module.exports = { apercu, promptImage };
