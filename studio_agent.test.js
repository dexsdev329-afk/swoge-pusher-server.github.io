'use strict';
/*
 * SWOGEAGENTIC — la boucle d'outils (studio_agent.js), contre un faux client
 * Anthropic qui joue un scenario d'appels :
 *   1. les outils declares : forme de l'API Messages, recherche seulement si
 *      Perplexity est la ;
 *   2. la boucle : chaque tool_use recoit son tool_result (meme id), l'usage
 *      de CHAQUE appel est additionne, les sources et les cartes remontent ;
 *   3. les bornes : au plus OUTILS_PAR_ETAPE outils par appel, au plus
 *      ETAPES_MAX appels, le dernier avec tool_choice « none » ; une entree
 *      d'outil coupee par max_tokens ne s'execute jamais ; un outil en panne
 *      devient un resultat is_error, pas une tache cassee ;
 *   4. l'argent : via studio_chat, la reserve est le pire cas de l'agent, la
 *      facture le reel (recherches Perplexity comprises), jamais au-dessus ;
 *   5. l'agent ne fait que LIRE : aucun outil qui achete, vend ou signe.
 */
const fs = require('fs'), path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
delete process.env.OPENAI_API_KEY; delete process.env.XAI_API_KEY; delete process.env.GROK_API_KEY; delete process.env.PERPLEXITY_API_KEY;

const A = require('./studio_agent');
const C = require('./studio_chat');
const Jeton = require('./studio_jeton');

/* Un faux client : `tours` est la liste des reponses, une par appel. */
function faux(tours) {
  const vus = [];
  const msg = (t) => ({ content: t.content, stop_reason: t.stop, model: 'claude-sonnet-5', usage: t.usage || { input_tokens: 1000, output_tokens: 100 } });
  return { vus, messages: { stream: (p) => {
    vus.push(JSON.parse(JSON.stringify(p)));
    const t = tours[vus.length - 1] || { content: [{ type: 'text', text: 'done' }], stop: 'end_turn' };
    const evs = t.content.filter((b) => b.type === 'text').map((b) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } }));
    return { [Symbol.asyncIterator]: async function* () { yield* evs; }, finalMessage: async () => msg(t) };
  } } };
}
const ADR = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const fiche = { adresse: ADR, marche: { chaine: 'ethereum', sym: 'PEPE', nom: 'Pepe', dex: 'uniswap', piscines: 2, prixUsd: 0.0000044, liqUsd: 25e6, mcUsd: 1.8e9,
  vol24Usd: 1e6, var24h: 3, achats24: 1, ventes24: 1, ageJours: 900, url: 'https://dexscreener.com/ethereum/0xp' }, securite: { couverte: true, connu: false }, colonie: null, manque: [] };
const vue = { tours: 14726, tresor: 3174.6, depart: 1000, dernierTour: Date.now(), positions: [{ sym: 'TELEPAD', adr: '0xt', ouverteDepuis: 780000, latent: 25.7, mise: 94.97, mcAchat: 39078 }],
  signaux: [{ k: 'achat', sym: 'TELEPAD', adr: '0xt', mc: 40325, t: Date.now() }, { k: 'vente', sym: 'NOIR', adr: '0xn', r: -22.2, comment: 'Duration reached', t: Date.now() }],
  carnet: { tout: { n: 285, moyenne: 1.9, partGagnantes: 47 } }, reel: { n: 272, moyenne: -3.5 } };
const src = (extra) => Object.assign({ recherche: true, Jeton,
  fiche: async () => fiche, vue: () => vue, economie: async () => ({ offre: 1e9, brule: 13389118 }), cours: async () => 0.000028,
  cherche: async () => [{ url: 'https://news.example/a', titre: 'News', extrait: 'x', date: null }], contexteRecherche: (r) => 'RESULTS ' + r.length }, extra || {});
const m = C.modele('sonnet-5');

(async () => {
  console.log('-- 1. les outils declares --');
  {
    const d = A.definitions({ recherche: true });
    ok(d.every((x) => x.name && x.description && x.input_schema && x.input_schema.type === 'object'), 'forme de l API Messages : name, description, input_schema');
    eq(d.map((x) => x.name).join(','), 'scan_token,colony_activity,swoge_economy,new_launches,wallet_intel,osint_lookup,web_search', 'sept outils avec Perplexity (trois ajoutes le 26 septembre : lancements, lanceur, OSINT)');
    ok(Math.ceil(JSON.stringify(d).length / 2) <= A.OUTILS_JETONS && Math.ceil(A.SYSTEME.length / 2) <= A.SYSTEME_JETONS,
       'le pire cas couvre les definitions et la consigne, a un jeton pour deux caracteres [' + Math.ceil(JSON.stringify(d).length / 2) + ' ≤ ' + A.OUTILS_JETONS + ']');
    ok(!A.definitions({ recherche: false }).some((x) => x.name === 'web_search'), 'sans cle Perplexity : pas de recherche web');
  }

  console.log('\n-- 2. la boucle --');
  {
    const cl = faux([
      { stop: 'tool_use', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'scan_token', input: { address: ADR } },
        { type: 'tool_use', id: 't2', name: 'colony_activity', input: { token: 'TELEPAD' } }], usage: { input_tokens: 2000, output_tokens: 150 } },
      { stop: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'web_search', input: { query: 'pepe news' } }], usage: { input_tokens: 5000, output_tokens: 80 } },
      { stop: 'end_turn', content: [{ type: 'text', text: 'PEPE has $25M liquidity [1].' }], usage: { input_tokens: 7000, output_tokens: 400 } }]);
    const outils = [], resultats = []; let texte = '';
    const r = await A.repond({ m, messages: [{ role: 'user', content: 'check pepe and the colony' }], surTexte: (t) => { texte += t; },
      surOutil: (o) => outils.push(o), surResultat: (o) => resultats.push(o) }, { client: cl, src: src() });
    eq(cl.vus.length, 3, 'trois appels : deux tours d outils, puis la reponse');
    const t2 = cl.vus[1].messages;
    ok(t2[1].role === 'assistant' && t2[2].role === 'user' && t2[2].content.map((x) => x.tool_use_id).join(',') === 't1,t2', 'chaque tool_use recoit son tool_result, sous le meme id');
    ok(/Token 0x6982/.test(t2[2].content[0].content) && /TELEPAD/.test(t2[2].content[1].content) && !/NOIR/.test(t2[2].content[1].content), 'le scan rend la fiche du jeton ; l activite de la colonie est filtree sur le jeton demande');
    ok(r.usage.input_tokens === 14000 && r.usage.output_tokens === 630 && r.usage.recherches_perplexity === 1, 'l usage de CHAQUE appel est additionne, la recherche comptee');
    ok(r.sources.map((x) => x.url).join(',') === 'https://dexscreener.com/ethereum/0xp,https://news.example/a' && r.jetons.length === 1 && r.jetons[0].sym === 'PEPE', 'les sources et la carte du jeton remontent');
    ok(outils.map((x) => x.nom).join(',') === 'scan_token,colony_activity,web_search' && resultats.every((x) => x.ok), 'la page voit chaque outil appele et son resultat');
    eq(texte, 'Let me look.\n\nPEPE has $25M liquidity [1].', 'le texte arrive au fil de l eau, les etapes separees');
    ok(cl.vus.every((p) => p.tools && p.tools.length === A.definitions({ recherche: true }).length && !p.tool_choice), 'les outils sont declares a chaque appel, sans forcer');
  }

  console.log('\n-- 2 bis. les lancements, le lanceur, l OSINT d infrastructure --');
  {
    const vues = [];
    const S = src({ vue: () => ({ candidats: [{ sym: 'OLD', addr: '0xo', minutes: 40, liq: 20000, mc: 90000, ch_m5: 1, score: 60, refus: null, origine: 'pools' },
                                             { sym: 'NEW', addr: '0xn', minutes: 1, liq: 8000, mc: 9000, ch_m5: 65, score: 48, refus: '$8000 pool: below the buy floor ($13000)', origine: 'pools' }],
                                surveillance: [{ sym: 'TALIS', addr: '0xt', vu: 29, liq: 53366, verdict: 'too old (819 min): watched only, never bought' }] }),
      detecte: (x) => (/@/.test(x) ? { type: 'email', valeur: x } : /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x) ? { type: 'domaine', valeur: x } : null),
      osint: async (type, valeur) => { vues.push([type, valeur]); return { cible: { type, valeur }, faits: [{ predicat: 'LAUNCHED TOKENS ON', valeur: 'pons × 4', sources: ['pons registry'] }],
        constats: [{ etiquette: 'HIGH', dit: 'This address is a repeat launcher, and repeat launchers measure worse.' }] }; } });
    const O = A.outils(S);
    const nl = JSON.parse((await O.new_launches({ limit: 1 })).texte);
    ok(nl.fresh.length === 1 && nl.fresh[0].sym === 'NEW' && /below the buy floor/.test(nl.fresh[0].decision) && nl.watched[0].verdict.startsWith('too old'),
       'new_launches : le plus frais d abord, avec la decision de la colonie, et ce qu elle surveille');
    ok((await O.wallet_intel({ address: 'nope' })).erreur && vues.length === 0, 'wallet_intel : une adresse hors forme ne touche aucun service');
    const wi = await O.wallet_intel({ address: '0x' + 'AB'.repeat(20) });
    ok(vues[0][0] === 'adresse' && vues[0][1] === '0x' + 'ab'.repeat(20) && /repeat launcher/.test(wi.texte) && /pons × 4 \(source: pons registry\)/.test(wi.texte),
       'wallet_intel : l OSINT de l adresse, constats d abord, chaque fait avec sa source');
    const mail = await O.osint_lookup({ target: 'someone@example.com' });
    ok(mail.erreur && /not people/.test(mail.erreur) && vues.length === 1, 'osint_lookup refuse une personne (e-mail) : aucun service interroge');
    const dom = await O.osint_lookup({ target: 'example.com' });
    ok(!dom.erreur && vues[1][0] === 'domaine', 'et accepte un domaine');
    ok(A.OSINT_TYPES.join(',') === 'domaine,ip,url,asn,cve', 'l OSINT offert ne vise que l infrastructure');
  }

  console.log('\n-- 3. les bornes --');
  {
    const cl = faux([{ stop: 'tool_use', content: [
      { type: 'tool_use', id: 'a', name: 'scan_token', input: { address: 'not-an-address' } },
      { type: 'tool_use', id: 'b', name: 'swoge_economy', input: {} },
      { type: 'tool_use', id: 'c', name: 'colony_activity', input: {} },
      { type: 'tool_use', id: 'd', name: 'swoge_economy', input: {} }] }]);
    let fiches = 0;
    await A.repond({ m, messages: [{ role: 'user', content: 'x' }] }, { client: cl, src: src({ fiche: async () => { fiches++; return fiche; } }) });
    const res = cl.vus[1].messages[2].content;
    ok(res[0].is_error && /40 hex/.test(res[0].content) && fiches === 0, 'une adresse hors forme : erreur rendue au modele, aucun appel au service');
    ok(res[3].is_error && /at most 3 tools/.test(res[3].content) && !res[1].is_error, 'au-dela de ' + A.OUTILS_PAR_ETAPE + ' outils dans un appel : les suivants sont refuses');

    const boucle = faux(Array(10).fill({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'swoge_economy', input: {} }] }));
    const rb = await A.repond({ m, messages: [{ role: 'user', content: 'loop forever' }] }, { client: boucle, src: src() });
    ok(boucle.vus.length === A.ETAPES_MAX && boucle.vus[A.ETAPES_MAX - 1].tool_choice.type === 'none' && rb.stop === 'max_steps',
       'un modele qui boucle s arrete a ' + A.ETAPES_MAX + ' appels, le dernier avec tool_choice « none »');

    let appele = false;
    const coupe = faux([{ stop: 'max_tokens', content: [{ type: 'tool_use', id: 'z', name: 'scan_token', input: { address: ADR.slice(0, 20) } }] }]);
    await A.repond({ m, messages: [{ role: 'user', content: 'x' }] }, { client: coupe, src: src({ fiche: async () => { appele = true; return fiche; } }) });
    ok(!appele && coupe.vus.length === 1, 'une entree d outil coupee par max_tokens ne s execute jamais');

    const panne = faux([{ stop: 'tool_use', content: [{ type: 'tool_use', id: 'p', name: 'swoge_economy', input: {} }] }]);
    const rp = await A.repond({ m, messages: [{ role: 'user', content: 'x' }] }, { client: panne, src: src({ economie: async () => { throw new Error('rpc down'); } }) });
    ok(panne.vus[1].messages[2].content[0].is_error && /rpc down/.test(panne.vus[1].messages[2].content[0].content) && rp.texte === 'done', 'un outil en panne devient une erreur rendue au modele, la tache continue');
  }

  console.log('\n-- 4. l argent, par studio_chat --');
  {
    const cours = 0.00002801;
    const s = { r: [] }; const solde = { reserve: (a, w) => { s.r.push(BigInt(String(w))); return true; }, regle: (a, rw, fw) => { s.r.push(BigInt(String(fw))); return '0'; } };
    const cl = faux([{ stop: 'tool_use', content: [{ type: 'tool_use', id: 'w', name: 'web_search', input: { query: 'q' } }], usage: { input_tokens: 3000, output_tokens: 100 } },
      { stop: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 4000, output_tokens: 300 } }]);
    const r = await C.repond({ addr: '0xag', modele: 'sonnet-5', messages: [{ role: 'user', content: 'task' }] },
      { cours: async () => cours, solde, actif: () => true, pireCas: (mm, msgs) => A.pireCasUsd(mm, msgs, true), fournisseur: (p) => A.repond(p, { client: cl, src: src() }) });
    const usd = (w) => Number(w) / 1e18 * cours;
    const cout = (7000 * m.entree + 400 * m.sortie) / 1e6 + 0.005;
    ok(r.ok && Math.abs(r.factureUsd - cout * 1.5) < 1e-5, 'facture = (jetons des deux appels + une recherche) × 1,5 [' + r.factureUsd + ' $]');
    ok(Math.abs(usd(s.r[0]) - C.factureUsd(A.pireCasUsd(m, [{ content: 'task' }], true))) < 1e-6 && s.r[1] < s.r[0], 'la reserve est le pire cas de l AGENT, la facture en dessous');
    ok(r.jetons !== undefined && r.etapes === 2, 'la reponse dit combien d appels la tache a pris');

    /* Le pire cas tient : un scenario qui touche chaque borne est facture sous la reserve. */
    const sortie = Math.min(m.maxTokens, A.SORTIE_MAX);
    const base = Math.ceil('task'.length / 2) + 500 + 1500, parEtape = sortie + A.OUTILS_PAR_ETAPE * A.RESULTAT_CAR_MAX / 2;
    const pire = faux(Array.from({ length: A.ETAPES_MAX }, (_, k) => ({ stop: k < A.ETAPES_MAX - 1 ? 'tool_use' : 'end_turn',
      content: k < A.ETAPES_MAX - 1 ? [0, 1, 2].map((i) => ({ type: 'tool_use', id: 'k' + k + i, name: 'web_search', input: { query: 'q' } })) : [{ type: 'text', text: 'end' }],
      usage: { input_tokens: base + k * parEtape, output_tokens: sortie } })));
    const s2 = { r: [] }; const solde2 = { reserve: (a, w) => { s2.r.push(BigInt(String(w))); return true; }, regle: (a, rw, fw) => { s2.r.push(BigInt(String(fw))); return '0'; } };
    const before = C.MESURE.depassements;
    await C.repond({ addr: '0xpire', modele: 'sonnet-5', messages: [{ role: 'user', content: 'task' }] },
      { cours: async () => cours, solde: solde2, actif: () => true, pireCas: (mm, msgs) => A.pireCasUsd(mm, msgs, true), fournisseur: (p) => A.repond(p, { client: pire, src: src() }) });
    ok(C.MESURE.depassements === before && s2.r[1] <= s2.r[0], 'chaque borne touchee (' + A.ETAPES_MAX + ' appels, 3 outils, sortie maximale) : facture sous la reserve, aucun depassement');
  }

  console.log('\n-- 5. l agent ne fait que lire --');
  {
    const code = fs.readFileSync(path.join(__dirname, 'studio_agent.js'), 'utf8');
    ok(!/require\('\.\/miroir'\)|surAchat|surVente|sendTransaction|signTransaction|x_post|telegram/.test(code), 'aucun outil n achete, ne vend, ne signe ni ne poste');
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const i = srv.indexOf("path === '/studio/agent' ||"), bloc = srv.slice(i, srv.indexOf('SWOLEMIND — L\'HISTORIQUE', i));
    ok(/sessionJoueur\.lire\(game\.sessionSecret, jeton\)/.test(bloc) && /fournisseur !== 'anthropic'/.test(bloc) && !/q\.addr|q\.adresse/.test(bloc),
       'la route prend l adresse dans la session, jamais dans le corps, et ne sert que Claude');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
