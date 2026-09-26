'use strict';
/*
 * SWOGE AI CHAT — ChatGPT et Grok (Chat Completions), mis à l'essai contre un
 * faux fournisseur local (OPENAI_BASE_URL / XAI_BASE_URL) :
 *   1. la requête porte ce que les spécifications demandent : modèle, stream,
 *      stream_options.include_usage, max_completion_tokens, le message
 *      système ; reasoning_effort seulement là où il est supporté ;
 *   2. le texte arrive au fil de l'eau, l'usage du dernier morceau est lu ;
 *   3. xAI : le coût EXACT (cost_in_usd_ticks) fait foi ; OpenAI : les jetons
 *      × grille, cache remisé ; jamais facturé sous le coût, jamais plus que
 *      la réserve ;
 *   4. un modèle dont la clé manque répond 503 sans rien réserver.
 */
const http = require('http');
const net = require('net');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });

process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';

(async () => {
  const vus = [];
  const faux = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      const corps = JSON.parse(b || '{}');
      vus.push({ hote: q.headers.host, url: q.url, auth: q.headers.authorization, corps });
      if (corps.model === 'modele-panne') { r.writeHead(429, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ error: { message: 'rate limited' } })); }
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      const xai = /grok/.test(corps.model);
      const morceaux = [
        { model: corps.model, choices: [{ delta: { role: 'assistant', content: '' } }] },
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'SWOGE.' }, finish_reason: 'stop' }] },
        { choices: [], usage: Object.assign({ prompt_tokens: 1200, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 200 } },
          xai ? { cost_in_usd_ticks: 55555000 } : {}) },
      ];
      r.end(morceaux.map((x) => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n');
    });
  });
  const port = await libre(); await new Promise((r) => faux.listen(port, r));
  process.env.OPENAI_BASE_URL = process.env.XAI_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.OPENAI_API_KEY = 'sk-oa-test'; process.env.XAI_API_KEY = 'xai-test';
  const P = require('./studio_compat');
  const C = require('./studio_chat');

  console.log('-- 1. la requete, telle que les specifications la demandent --');
  {
    let recu = '';
    const m = C.modele('gpt-6-sol');
    const r = await P.repond({ m, messages: [{ role: 'user', content: 'Hi' }], effort: 'high', surTexte: (t) => { recu += t; } });
    const v = vus.pop();
    ok(v.url === '/v1/chat/completions' && v.corps.model === 'gpt-6-sol' && v.corps.stream === true && v.corps.stream_options.include_usage === true, 'OpenAI : chat/completions, modele, stream, include_usage');
    ok(v.corps.max_completion_tokens === m.maxTokens && v.corps.reasoning_effort === 'high', 'max_completion_tokens borne la sortie, reasoning_effort part (supporte par GPT-6)');
    ok(v.corps.messages[0].role === 'system' && /SwoleMind/.test(v.corps.messages[0].content) && v.corps.messages[1].content === 'Hi', 'le message systeme de SwoleMind, puis la conversation');
    eq(v.auth, 'Bearer sk-oa-test', 'la cle OpenAI, depuis le serveur');
    ok(recu === 'Hello SWOGE.' && r.texte === 'Hello SWOGE.', 'le texte arrive au fil de l eau');
    ok(r.usage.input_tokens === 1000 && r.usage.cache_read_input_tokens === 200 && r.usage.output_tokens === 900 && !r.usage.coutExactUsd, 'l usage OpenAI est lu, le cache mis a part');

    const g = await P.repond({ m: C.modele('grok-4-7'), messages: [{ role: 'user', content: 'Hi' }], effort: 'high' });
    const vg = vus.pop();
    ok(vg.corps.model === 'grok-4.7' && !('reasoning_effort' in vg.corps), 'xAI : grok-4.7, sans reasoning_effort (non branche pour Grok)');
    eq(vg.auth, 'Bearer xai-test', 'la cle xAI');
    ok(g.usage.input_tokens === 1200 && g.usage.cache_read_input_tokens === 0 && Math.abs(g.usage.coutExactUsd - 0.0055555) < 1e-12, 'xAI : tout au plein tarif, et le cout EXACT (ticks) est rendu');
    let panne = false;
    try { await P.repond({ m: Object.assign({}, C.modele('gpt-6-luna'), { api: 'modele-panne' }), messages: [{ role: 'user', content: 'x' }] }); }
    catch (e) { panne = /openai 429 — rate limited/.test(e.message); }
    ok(panne, 'une erreur du fournisseur remonte avec son code et son message');
  }

  console.log('\n-- 2. la facture : jamais sous le cout, le cout exact quand il est rendu --');
  {
    const cours = 0.00002801;
    const solde = () => { const s = { r: [] }; s.o = { reserve: () => true, regle: (a, rw, fw) => { s.r.push({ rw: BigInt(String(rw)), fw: BigInt(String(fw)) }); return '0'; } }; return s; };
    const usd = (w) => Number(w) / 1e18 * cours;
    for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'grok-4-7', 'grok-4-20-reasoning', 'grok-4-3']) {
      const m = C.modele(id); const s = solde();
      const r = await C.repond({ addr: '0x' + id, modele: id, messages: [{ role: 'user', content: 'Hi' }] },
        { cours: async () => cours, solde: s.o, actif: () => true, fournisseur: (p) => P.repond(p) });
      const cout = m.fournisseur === 'xai' ? 0.0055555 : (1000 * m.entree + 200 * m.entree * 0.1 + 900 * m.sortie) / 1e6;
      ok(r.ok && usd(s.r[0].fw) >= cout * 1.5 - 1e-9 && s.r[0].fw <= s.r[0].rw, m.nom + ' : facture ' + usd(s.r[0].fw).toFixed(5) + ' $ ≥ cout ' + cout.toFixed(5) + ' × 1,5, sous la reserve');
    }
    const s = solde(); let appel = false;
    const r = await C.repond({ addr: '0xoff', modele: 'grok-4-3', messages: [{ role: 'user', content: 'Hi' }] },
      { cours: async () => cours, solde: s.o, actif: (f) => f !== 'xai', fournisseur: () => { appel = true; } });
    ok(r.code === 503 && !appel && s.r.length === 0, 'la cle xAI manque : 503, rien de reserve, aucun appel');
  }

  faux.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
