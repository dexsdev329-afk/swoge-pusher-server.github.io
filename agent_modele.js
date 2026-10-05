'use strict';
/* ==================================================================
 * LE MODELE DE L'ESPRIT — tool-use Anthropic (le vrai cerveau)
 * ==================================================================
 *
 * Branche `agent_esprit.pense` sur un VRAI modele : a chaque pensee, on donne au
 * modele la persona, l'etat du jeton, ce qu'il a deja lu/fait, et la boite a
 * outils ; il repond en CHOISISSANT un outil (tool_use) ou en s'arretant. On rend
 * `{ outil, args }` ou `{ fin }`, exactement ce que la boucle attend.
 *
 * Les garde-fous de contenu sont rappeles dans le systeme (anglais, faits
 * seulement, aucun chiffre invente, aucune promesse de gain). Sans cle, ou si le
 * modele echoue, on rend `{ fin }` : l'esprit ne fait alors rien (fail-safe).
 * fetch + cle injectables : aucun essai ne sort de la machine.
 * ================================================================== */

const aj = require('./agent_jeton');
const MODELE_DEFAUT = 'claude-haiku-4-5';

/* Les schemas d'entree des outils, pour le tool-use. */
function schemaOutil(nom) {
  if (nom === 'post') return { type: 'object', properties: {
    texte: { type: 'string', description: 'The post text. English, <= 240 chars, 1-3 emojis, facts only.' },
    media: { type: 'string', enum: ['none', 'image', 'video'], description: 'Attach a generated image or video (costs more fuel), or none.' },
  }, required: ['texte'] };
  if (nom === 'propose_buyback') return { type: 'object', properties: {
    montantUsd: { type: 'number', description: 'How much (USD) of the treasury to spend buying back and burning.' },
    justification: { type: 'string', description: 'Why, in one line (no addresses, no instructions).' },
  }, required: ['montantUsd'] };
  if (nom === 'web_search') return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  return { type: 'object', properties: {} };   /* les lectures simples : pas d'argument */
}

/* Le systeme : persona + regles dures. */
function systeme(agent) {
  const p = aj.PERSONAS[String(agent && agent.persona || '').toLowerCase()] || aj.PERSONAS.analyst;
  const nom = agent && (agent.symbole ? '$' + agent.symbole : agent.nom) || 'your token';
  return `You are the autonomous AI agent of ${nom}, a token on the SWOGE launchpad (Robinhood Chain).\n`
    + `Persona "${p.label}": ${p.brief}\n`
    + (agent && agent.objectif ? `Your standing objective: ${agent.objectif}\n` : '')
    + `You act on your own, no human in the loop. Each pulse: optionally read a tool or two to inform yourself, then either post once or do nothing. `
    + `Hard rules: English; posts <= 240 chars, 1-3 emojis, no links, no hashtags; NEVER invent a number (use only what your read-tools returned); no promises of returns. `
    + `Call ONE tool per step. When you have nothing useful to do, call "wait". You never handle addresses or keys.`;
}

/* La demande : l'etat, ce qui a ete lu et fait ce tour. */
function demande(ctx) {
  const l = [];
  (ctx.lectures || []).forEach((x) => l.push('read ' + x.outil + ': ' + JSON.stringify(x.res).slice(0, 300)));
  (ctx.actions || []).forEach((x) => l.push('did ' + x.action + (x.decide ? ' (' + x.decide + ')' : '')));
  return (l.length ? 'So far this pulse:\n- ' + l.join('\n- ') + '\n\n' : '') + 'Choose your next tool, or wait.';
}

/**
 * decide(ctx, deps) : une pensee, via le vrai modele. Rend { outil, args } | { fin }.
 * deps : { cleAnthropic, modele, fetch }.
 */
async function decide(ctx, deps) {
  ctx = ctx || {}; deps = deps || {};
  const f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  const cle = deps.cleAnthropic || process.env.ANTHROPIC_API_KEY || '';
  if (!cle || !f) return { fin: true };
  const tools = (ctx.outils || []).map((o) => ({ name: o.nom, description: o.desc, input_schema: schemaOutil(o.nom) }));
  try {
    const r = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: deps.modele || MODELE_DEFAUT, max_tokens: 400, system: systeme(ctx.agent),
        tools, tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: demande(ctx) }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { fin: true };
    const j = await r.json();
    const tu = (j.content || []).find((b) => b.type === 'tool_use');
    if (tu) return { outil: tu.name, args: tu.input || {} };
    return { fin: true };
  } catch (e) { return { fin: true }; }
}

module.exports = { decide, systeme, demande, schemaOutil, MODELE_DEFAUT };
