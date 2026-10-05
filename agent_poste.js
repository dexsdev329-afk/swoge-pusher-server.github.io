'use strict';
/* ==================================================================
 * L'AGENT D'UN JETON ÉCRIT UN POST — le compositeur, pas le posteur
 * ==================================================================
 *
 * Phase 1 d'AgencyPad-sur-Robinhood : chaque jeton lancé a un agent (voir
 * agent_jeton.js). Ici, cet agent COMPOSE un post dans sa persona, à partir
 * des FAITS live de son jeton — il n'invente aucun chiffre, ne promet aucun
 * gain. Ce module ne publie rien : il rend un texte. L'ordonnanceur (à venir)
 * le passera à x_post (téléversement + publication), avec le contrôle
 * pattes-de-chien déjà en place pour l'image.
 *
 * Réutilise la plomberie de x_post :
 *   - même appel Anthropic Messages, fetch injectable (`deps.fetch`) pour les
 *     essais : aucun test ne sort de la machine ;
 *   - `nettoie` de x_post pour la longueur (≤ 240 + lien) et le ménage ;
 *   - sans clé, ou si le modèle se tait, une phrase de RÉSERVE déterministe,
 *     bâtie seulement sur les faits reçus (jamais un chiffre inventé).
 *
 * Le texte montré aux joueurs est en anglais (langue 'en' par défaut) ; les
 * commentaires du code en français.
 * ================================================================== */

const xp = require('./x_post');
const aj = require('./agent_jeton');

const MODELE_DEFAUT = 'claude-haiku-4-5';

/* Les règles dures, communes à toutes les personas. Elles priment sur la
   persona : une persona « hype » ne promet toujours aucun gain. */
const REGLES = [
  'You ARE this token\'s own AI agent, posting on its behalf. Speak in the first person as the token/its agent.',
  'English only, unless told the language is French.',
  'Maximum 240 characters. Shorter is better.',
  '1 to 3 emojis, no more. No links. No hashtags.',
  'NEVER invent a number. Use only numbers present in the Facts given to you; if a fact is not given, do not state it.',
  'No promises of returns, no "guaranteed", no price targets, no financial advice.',
  'Stay in your persona. Do not repeat the openings, structure or jokes of the previous posts shown to you.',
].join('\n');

/** Le prompt système de la persona : son caractère + les règles dures. */
function systeme(persona) {
  const p = aj.PERSONAS[String(persona || '').toLowerCase()] || aj.PERSONAS.analyst;
  return `You are the "${p.label}" character of a token launched on the SWOGE launchpad (Robinhood Chain).\nCharacter: ${p.brief}\n\nHard rules:\n${REGLES}`;
}

/* La requête utilisateur : identité du jeton, objectif, faits, posts passés. */
function demande(o) {
  const l = [];
  if (o.symbole || o.nom) l.push(`Token: ${[o.nom, o.symbole ? '$' + o.symbole : ''].filter(Boolean).join(' ')}`.trim());
  if (o.objectif) l.push(`Your standing objective (set by the creator): ${o.objectif}`);
  l.push((o.faits && o.faits.length)
    ? `Facts you may use (do not go beyond them):\n- ${o.faits.join('\n- ')}`
    : 'No fresh facts are available this round — post in character without stating any number.');
  if (o.precedents && o.precedents.length) l.push(`Previous posts (do not repeat them):\n- ${o.precedents.join('\n- ')}`);
  if (o.langue === 'fr') l.push('Write in French this time.');
  return l.join('\n');
}

/* La phrase de réserve : déterministe, sans modèle, sans chiffre inventé.
   Elle n'utilise QUE ce qu'on lui donne (nom/symbole, objectif, un fait court). */
function reserve(o) {
  const nom = o.symbole ? '$' + o.symbole : (o.nom || 'This token');
  const p = String(o.persona || '').toLowerCase();
  if (o.objectif) return `${nom}: ${o.objectif}`;
  const air = { stoic: 'Still here. Still building. 🪨', analyst: 'Reading the charts, not the hype. 📊',
    contrarian: 'Everyone zigs. We read the data. 🧭', hype: 'The community keeps showing up 🐾🔥',
    builder: 'Shipping in public, one block at a time. 🔧' };
  return `${nom} — ${air[p] || 'live on Robinhood Chain. 🐾'}`;
}

/**
 * Compose un post pour l'agent d'un jeton.
 * o : { persona, objectif, langue, nom, symbole, faits:[], precedents:[], lien, maintenant }
 * deps : { cleAnthropic, modele, fetch } — tout injectable pour les essais.
 * Rend { texte, via:'modele'|'reserve' }.
 */
async function compose(o, deps) {
  o = o || {}; deps = deps || {};
  const f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  const cle = deps.cleAnthropic || process.env.ANTHROPIC_API_KEY || '';
  const lien = o.lien || false;
  if (cle && f) {
    try {
      const r = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: deps.modele || MODELE_DEFAUT, max_tokens: 200, system: systeme(o.persona),
                               messages: [{ role: 'user', content: demande(o) }] }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const brut = ((j.content || []).find((b) => b.type === 'text') || {}).text || '';
      if (brut.trim()) return { texte: xp.nettoie(brut, lien, null), via: 'modele' };
      throw new Error('reponse vide');
    } catch (err) {
      /* une panne du modèle ne doit pas tuer le tour : phrase de réserve */
      console.error('[agent] ' + (o.symbole || o.nom || 'token') + ' : modele muet (' + (err.message || err) + '), reserve');
    }
  }
  return { texte: xp.nettoie(reserve(o), lien, null), via: 'reserve' };
}

module.exports = { compose, systeme, demande, reserve, REGLES, MODELE_DEFAUT };
