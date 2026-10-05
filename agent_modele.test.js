'use strict';
/* LE MODELE DE L ESPRIT (tool-use Anthropic).
 *
 * Intention : le modele CHOISIT un outil (tool_use -> { outil, args }) ou s arrete
 * (-> { fin }) ; le systeme porte la persona et les regles dures ; la demande
 * resume ce qui a ete lu/fait ; sans cle ou sur erreur -> { fin } (fail-safe) ;
 * les schemas d outils exposent l option media du post. fetch + cle injectes.
 */
const M = require('./agent_modele');
const E = require('./agent_esprit');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const agent = { token: '0x' + '1'.repeat(40), persona: 'hype', symbole: 'FOO', objectif: 'make them laugh' };

function fetchTool(name, input) { return async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name, input }] }) }); }

(async () => {
  console.log('-- 1. le modele choisit un outil --');
  let vu = null;
  const f = async (u, o) => { vu = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'market', input: {} }] }) }; };
  let d = await M.decide({ agent, outils: E.OUTILS, lectures: [], actions: [] }, { cleAnthropic: 'k', fetch: f });
  ok(d.outil === 'market' && d.args && typeof d.args === 'object', 'un tool_use « market » -> { outil, args }');
  ok(/Hype/.test(vu.system) && /never invent a number/i.test(vu.system) && /\$FOO/.test(vu.system), 'le systeme porte la persona, la regle « no invented number », le symbole');
  ok(vu.tools.some((t) => t.name === 'post' && t.input_schema.properties.media), 'l outil post expose bien l option media (image/video)');

  console.log('\n-- 2. le modele choisit de poster avec une image --');
  d = await M.decide({ agent, outils: E.OUTILS, lectures: [{ outil: 'market', res: { liqUsd: 5000 } }], actions: [] },
    { cleAnthropic: 'k', fetch: fetchTool('post', { texte: 'liquidity looking solid 🐾', media: 'image' }) });
  ok(d.outil === 'post' && d.args.media === 'image' && /liquidity/.test(d.args.texte), 'tool_use post avec media:image bien transmis');

  console.log('\n-- 3. la demande resume lectures et actions --');
  const dem = M.demande({ lectures: [{ outil: 'market', res: { liqUsd: 5000 } }], actions: [{ action: 'post' }] });
  ok(/read market/.test(dem) && /did post/.test(dem), 'la demande liste ce qui a ete lu et fait ce tour');

  console.log('\n-- 4. fail-safe : sans cle, sur erreur, ou sans tool_use -> fin --');
  ok((await M.decide({ agent, outils: E.OUTILS }, { cleAnthropic: '', fetch: fetchTool('market', {}) })).fin === true, 'sans cle : fin (l esprit ne fera rien)');
  ok((await M.decide({ agent, outils: E.OUTILS }, { cleAnthropic: 'k', fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) })).fin === true, 'HTTP 500 : fin');
  ok((await M.decide({ agent, outils: E.OUTILS }, { cleAnthropic: 'k', fetch: async () => { throw new Error('net'); } })).fin === true, 'reseau coupe : fin');
  ok((await M.decide({ agent, outils: E.OUTILS }, { cleAnthropic: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) }) })).fin === true, 'pas de tool_use (juste du texte) : fin');

  console.log('\n-- 5. bout en bout : l esprit utilise ce vrai modele --');
  /* un modele scripte via fetch : d abord market, puis post, puis wait */
  let etape = 0;
  const fSeq = async () => { etape++; const seq = [
    { content: [{ type: 'tool_use', name: 'market', input: {} }] },
    { content: [{ type: 'tool_use', name: 'post', input: { texte: 'gm 🐾', media: 'none' } }] },
    { content: [{ type: 'tool_use', name: 'wait', input: {} }] },
  ]; return { ok: true, status: 200, json: async () => seq[etape - 1] || { content: [] } }; };
  const posts = [];
  const r = await E.pense(agent, { modele: (ctx) => M.decide(ctx, { cleAnthropic: 'k', fetch: fSeq }),
    outils: { market: async () => ({ liqUsd: 5000 }) }, poste: async (a, p) => { posts.push(p); return { surX: false }; }, fuel: { peutPenser: () => true, debite: () => {} } });
  ok(posts.length === 1 && posts[0].media === 'none' && r.actions.some((x) => x.action === 'post'), 'l esprit, avec le vrai modele (fetch simule), a lu puis poste tout seul');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
