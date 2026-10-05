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
      vus.push({ hote: q.headers.host, url: q.url, auth: q.headers.authorization, entetes: q.headers, corps });
      /* La Search API de Perplexity (forme de sa specification). */
      if (q.url === '/search') {
        if (/panne/.test(corps.query)) { r.writeHead(500, { 'content-type': 'application/json' }); return r.end('{}'); }
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({ id: 's1', results: [
          { title: 'Doge news', url: 'https://news.example/doge', snippet: 'The doge lifted 500 kg today.', date: '2026-09-26' },
          { title: 'Bad scheme', url: 'javascript:alert(1)', snippet: 'x' },
          { title: 'Robinhood Chain', url: 'https://rh.example/chain', snippet: 'Chain 4663 launched.' }] }));
      }
      if (corps.model === 'modele-panne') { r.writeHead(429, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ error: { message: 'rate limited' } })); }
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      const xai = /grok/.test(corps.model);
      /* OpenRouter rend le cout exact dans usage.cost (credits = $). */
      const openrouter = /dolphin-mistral-24b-venice/.test(corps.model);
      const morceaux = [
        { model: corps.model, choices: [{ delta: { role: 'assistant', content: '' } }] },
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'SWOGE.' }, finish_reason: 'stop' }] },
        { choices: [], usage: Object.assign({ prompt_tokens: 1200, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 200 } },
          xai ? { cost_in_usd_ticks: 55555000 } : openrouter ? { cost: 0.0042 } : {}) },
      ];
      r.end(morceaux.map((x) => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n');
    });
  });
  const port = await libre(); await new Promise((r) => faux.listen(port, r));
  process.env.OPENAI_BASE_URL = process.env.XAI_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.OPENAI_API_KEY = 'sk-oa-test'; process.env.XAI_API_KEY = 'xai-test';
  /* Les modeles peu censures (05/10) visent le MEME faux serveur ; leurs bases
     sont choisies pour que base + chemin tombe sur l'URL de leur doc. */
  process.env.VENICE_BASE_URL = process.env.OPENROUTER_BASE_URL = process.env.MISTRAL_BASE_URL = process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.VENICE_API_KEY = 'vn-test'; process.env.OPENROUTER_API_KEY = 'or-test';
  process.env.DEEPSEEK_API_KEY = 'ds-test'; process.env.MISTRAL_API_KEY = 'ms-test';
  process.env.OPENROUTER_REFERER = 'https://swoleeswoge.dog';
  process.env.PERPLEXITY_API_KEY = 'pplx-test'; process.env.PERPLEXITY_BASE_URL = 'http://127.0.0.1:' + port;
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

  console.log('\n-- 1 bis. la recherche web pour GPT et Grok (Perplexity Search API) --');
  {
    let etape = 0;
    const r = await P.repond({ m: C.modele('grok-4-3'), recherche: true, surRecherche: () => { etape++; },
      messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'What did the doge lift?' }] });
    const vs = vus.filter((v) => v.url === '/search').pop();
    const vm = vus.filter((v) => v.url === '/v1/chat/completions').pop();
    ok(vs && vs.corps.query === 'What did the doge lift?' && vs.corps.max_results === 6 && vs.corps.max_tokens_per_page > 0, 'Perplexity recoit la DERNIERE question, 6 resultats, pages bornees — les champs de sa specification');
    eq(vs.auth, 'Bearer pplx-test', 'avec la cle Perplexity, depuis le serveur');
    eq(etape, 1, 'la page est prevenue qu une recherche est en cours');
    const derniere = vm.corps.messages[vm.corps.messages.length - 1].content;
    ok(/^What did the doge lift\?/.test(derniere) && /\[1\] Doge news/.test(derniere) && /https:\/\/news\.example\/doge/.test(derniere) && /cite each claim/.test(derniere), 'le modele recoit les resultats numerotes avec la consigne de citer');
    ok(vm.corps.messages[1].content === 'old question', 'l historique, lui, reste intact');
    eq(r.sources.map((x) => x.url).join(','), 'https://news.example/doge,https://rh.example/chain', 'les sources rendues a la page : https seulement, dans l ordre des numeros');
    eq(r.usage.recherches_perplexity, 1, 'et la recherche est comptee pour la facture');
    const sans = await P.repond({ m: C.modele('grok-4-3'), recherche: false, messages: [{ role: 'user', content: 'hi' }] });
    ok(sans.sources.length === 0 && sans.usage.recherches_perplexity === 0 && vus.filter((v) => v.url === '/search').length === 1, 'sans « Search » : aucune recherche, rien de facture');
    const rate = await P.repond({ m: C.modele('gpt-6-luna'), recherche: true, messages: [{ role: 'user', content: 'panne please' }] });
    ok(rate.texte === 'Hello SWOGE.' && rate.sources.length === 0 && rate.usage.recherches_perplexity === 0, 'une recherche ratee : on repond sans, et on ne la facture pas');
    const cat = C.catalogue(0.00002801, { anthropic: true, openai: true, xai: true, perplexity: false });
    ok(!cat.modeles.find((x) => x.id === 'grok-4-3').recherche && cat.modeles.find((x) => x.id === 'opus-5-5').recherche, 'sans cle Perplexity : « Search » eteint pour GPT et Grok, Claude garde le sien');
    const cat2 = C.catalogue(0.00002801, { anthropic: true, openai: true, xai: true, perplexity: true });
    ok(cat2.modeles.filter((x) => x.fournisseur !== 'anthropic').every((x) => x.recherche), 'avec la cle : « Search » pour tous les modeles');
  }

  console.log('\n-- 1 ter. les modeles peu censures : chemin, en-tetes, cout exact, texte seul (05/10) --');
  {
    /* Le piege central : base + chemin doit tomber JUSTE sur l'URL de la doc.
       On verifie les bases PAR DEFAUT (sans l'override du faux serveur). */
    const sauve = { v: process.env.VENICE_BASE_URL, o: process.env.OPENROUTER_BASE_URL, d: process.env.DEEPSEEK_BASE_URL, m: process.env.MISTRAL_BASE_URL };
    delete process.env.VENICE_BASE_URL; delete process.env.OPENROUTER_BASE_URL; delete process.env.DEEPSEEK_BASE_URL; delete process.env.MISTRAL_BASE_URL;
    const url = (f) => { const F = P.FOURNISSEURS[f]; return String(F.base()).replace(/\/$/, '') + (F.chemin || '/v1/chat/completions'); };
    eq(url('venice'), 'https://api.venice.ai/api/v1/chat/completions', 'Venice : base .../api + /v1/chat/completions = l URL de la doc');
    eq(url('openrouter'), 'https://openrouter.ai/api/v1/chat/completions', 'OpenRouter : base .../api + /v1/chat/completions');
    eq(url('deepseek'), 'https://api.deepseek.com/chat/completions', 'DeepSeek : base nue + chemin SANS /v1 (doc 05/10)');
    eq(url('mistral'), 'https://api.mistral.ai/v1/chat/completions', 'Mistral : base nue + /v1/chat/completions');
    process.env.VENICE_BASE_URL = sauve.v; process.env.OPENROUTER_BASE_URL = sauve.o; process.env.DEEPSEEK_BASE_URL = sauve.d; process.env.MISTRAL_BASE_URL = sauve.m;

    /* Chaque fournisseur frappe le bon chemin, avec sa cle. */
    const rv = await P.repond({ m: C.modele('venice-uncensored'), messages: [{ role: 'user', content: 'Hi' }] });
    const vv = vus.pop();
    ok(vv.url === '/v1/chat/completions' && vv.corps.model === 'venice-uncensored-1-2' && vv.auth === 'Bearer vn-test', 'Venice : /v1/chat/completions, le bon modele, la cle Venice');
    ok(rv.texte === 'Hello SWOGE.', 'Venice : le texte arrive au fil de l eau');

    const rd = await P.repond({ m: C.modele('deepseek-flash'), messages: [{ role: 'user', content: 'Hi' }] });
    const vd = vus.pop();
    ok(vd.url === '/chat/completions' && vd.corps.model === 'deepseek-flash' && vd.auth === 'Bearer ds-test', 'DeepSeek : /chat/completions (sans /v1), le bon modele, la cle DeepSeek');

    const rm = await P.repond({ m: C.modele('mistral-large'), messages: [{ role: 'user', content: 'Hi' }] });
    const vm = vus.pop();
    ok(vm.url === '/v1/chat/completions' && vm.corps.model === 'mistral-large-latest' && vm.auth === 'Bearer ms-test', 'Mistral : /v1/chat/completions, le bon modele, la cle Mistral');

    /* OpenRouter : les en-tetes d identite, et le cout EXACT lu dans usage.cost. */
    const ro = await P.repond({ m: C.modele('dolphin-venice'), messages: [{ role: 'user', content: 'Hi' }] });
    const vo = vus.pop();
    ok(vo.url === '/v1/chat/completions' && vo.corps.model === 'cognitivecomputations/dolphin-mistral-24b-venice-edition' && vo.auth === 'Bearer or-test', 'OpenRouter : /v1/chat/completions, le slug complet, la cle OpenRouter');
    ok(vo.entetes['http-referer'] === 'https://swoleeswoge.dog' && vo.entetes['x-title'] === 'SWOGE AI', 'OpenRouter : les en-tetes HTTP-Referer et X-Title identifient notre site');
    ok(Math.abs(ro.usage.coutExactUsd - 0.0042) < 1e-12 && !ro.usage.cost_in_usd_ticks, 'OpenRouter : usage.cost (credits = $) devient le cout EXACT');

    /* reasoning_effort n est PAS envoye (effort: false sur ces modeles). */
    const re = await P.repond({ m: C.modele('venice-uncensored'), effort: 'high', messages: [{ role: 'user', content: 'Hi' }] });
    ok(!('reasoning_effort' in vus.pop().corps), 'Venice : pas de reasoning_effort (effort false)');

    /* Texte seul : une photo jointe est refusee cote serveur (studio_chat.repond). */
    const cours = 0.00002801;
    const photo = Buffer.alloc(48); photo.writeUInt32BE(0x89504e47, 0); photo.write('IHDR', 12, 'latin1'); photo.writeUInt32BE(8, 16); photo.writeUInt32BE(8, 20);
    const rr = await C.repond({ addr: '0xpic', modele: 'venice-uncensored',
      messages: [{ role: 'user', content: 'what is this', pieces: [{ media: 'image/png', data: photo.toString('base64'), nom: 'p.png' }] }] },
      { cours: async () => cours, solde: { reserve: () => true, regle: () => '0' }, actif: () => true, fournisseur: (p) => P.repond(p) });
    ok(rr.code === 400 && /can't read photos/.test(rr.raison), 'Venice (texte seul) refuse une photo jointe, et le dit');
    const cat = C.catalogue(cours, { anthropic: true, venice: true, openrouter: true, deepseek: true, mistral: true });
    ok(cat.modeles.find((x) => x.id === 'venice-uncensored').pieces.images === false && cat.modeles.find((x) => x.id === 'opus-5-5').pieces.images === true, 'le catalogue : pas de photo pour les modeles texte seul, oui pour Claude');
    ok(cat.modeles.filter((x) => ['venice', 'openrouter', 'deepseek', 'mistral'].includes(x.fournisseur)).length === 5, 'les cinq modeles peu censures sont au catalogue');
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
    /* La recherche Perplexity s'ajoute au cout, meme au cout exact de xAI. */
    const sr = solde();
    const rr = await C.repond({ addr: '0xsearch', modele: 'grok-4-3', recherche: true, messages: [{ role: 'user', content: 'doge?' }] },
      { cours: async () => cours, solde: sr.o, actif: () => true, fournisseur: (p) => P.repond(p) });
    ok(rr.ok && Math.abs(rr.factureUsd - (0.0055555 + 0.005) * 1.5) < 1e-5 && rr.usage.recherches === 1 && rr.sources.length === 2,
       'Grok + recherche : facture = (cout exact xAI + 0,005 $ Perplexity) × 1,5, une recherche, deux sources [' + rr.factureUsd + ']');
    const s = solde(); let appel = false;
    const r = await C.repond({ addr: '0xoff', modele: 'grok-4-3', messages: [{ role: 'user', content: 'Hi' }] },
      { cours: async () => cours, solde: s.o, actif: (f) => f !== 'xai', fournisseur: () => { appel = true; } });
    ok(r.code === 503 && !appel && s.r.length === 0, 'la cle xAI manque : 503, rien de reserve, aucun appel');
  }

  faux.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
