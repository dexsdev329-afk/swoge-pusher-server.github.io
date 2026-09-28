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
 *   5. l'agent ne fait que LIRE : aucun outil qui achete, vend ou signe ;
 *   7. (lot Base, 27 septembre 2026) ask_agent vendu en x402 : bornes
 *      LIMITES_X402, pire cas sous le plafond, chaque appel compte AVANT
 *      (countTokens), final force par le budget ou a 105 s, recherche refusee
 *      au-dela du plafond, a 150 s la tache rend ce qu'elle a.
 */
const fs = require('fs'), path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
delete process.env.OPENAI_API_KEY; delete process.env.XAI_API_KEY; delete process.env.GROK_API_KEY; delete process.env.PERPLEXITY_API_KEY;
/* Le reglage par defaut : telegram_calls n'est pas offert (voir la section 6). */
delete process.env.TG_APPELS_VENTE;

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
    eq(d.map((x) => x.name).join(','), 'scan_token,can_i_sell,colony_activity,swoge_economy,new_launches,wallet_intel,osint_lookup,web_search',
       'huit outils avec Perplexity (lancements, lanceur, OSINT ajoutes le 26 septembre ; l epreuve de sortie can_i_sell le 27, juste apres scan_token) ; les appels Telegram ne sont PAS offerts sans TG_APPELS_VENTE=1 (conditions de Telegram)');
    process.env.TG_APPELS_VENTE = '1';
    const dv = A.definitions({ recherche: true });
    delete process.env.TG_APPELS_VENTE;
    eq(dv.map((x) => x.name).join(','), 'scan_token,can_i_sell,colony_activity,swoge_economy,new_launches,wallet_intel,osint_lookup,telegram_calls,web_search',
       'TG_APPELS_VENTE=1 : les appels Telegram reviennent a leur place (neuf outils)');
    /* La borne se juge sur le catalogue le plus long : reglage allume. */
    ok(Math.ceil(JSON.stringify(dv).length / 2) <= A.OUTILS_JETONS && Math.ceil(A.SYSTEME.length / 2) <= A.SYSTEME_JETONS,
       'le pire cas couvre les definitions et la consigne, a un jeton pour deux caracteres [' + Math.ceil(JSON.stringify(dv).length / 2) + ' ≤ ' + A.OUTILS_JETONS + ']');
    const sc = d.find((x) => x.name === 'scan_token').description;
    ok(/Powered by Go\+ Security, https:\/\/gopluslabs\.io/.test(sc.split('. ')[0]),
       'scan_token dit « Powered by Go+ Security » avec son lien, dans sa PREMIERE phrase (celle que reprennent llms.txt et openapi)');
    ok(!A.definitions({ recherche: false }).some((x) => x.name === 'web_search'), 'sans cle Perplexity : pas de recherche web');
    /* ---- QUAND APPELER (decouverte, 26 septembre 2026) ----
     * Un annuaire d'outils se parcourt par la tache : la PREMIERE phrase de
     * chaque description vendue (celle que reprennent openapi.json et llms.txt)
     * dit quand appeler. Juge sur l'intention, pas mot pour mot — et sur ce
     * qui est PUBLIE (agentic.definitions : /agentic/tools, MCP tools/list,
     * openapi, llms.txt), pas sur une constante : jugee sur DESCRIPTIONS_API
     * seule, la regle passait alors que 4 outils publies ne la suivaient pas. */
    process.env.TG_APPELS_VENTE = '1';
    const publiees = require('./agentic').definitions({ recherche: true });
    delete process.env.TG_APPELS_VENTE;
    const toutes = publiees.map((x) => [x.name, x.description]);
    const sansQuand = toutes.filter(([, t]) => !/\bwhen\b|\buse this\b/i.test(t.split('. ')[0])).map(([k]) => k);
    ok(toutes.length === 27 && !sansQuand.length, 'les ' + toutes.length + ' descriptions PUBLIEES (agentic.definitions) disent QUAND appeler dans leur premiere phrase' + (sansQuand.length ? ' — manque : ' + sansQuand.join(', ') : ''));
    const apiNoms = Object.keys(A.DESCRIPTIONS_API);
    const nonBranchees = apiNoms.filter((k) => (publiees.find((x) => x.name === k) || {}).description !== A.DESCRIPTIONS_API[k]);
    ok(apiNoms.length === 18 && !nonBranchees.length, 'les 18 descriptions (token_verdict, les 4 lectures Robinhood et chat_completion le 27/09, roast_token, les 3 outils du hasard prouvable, les 2 des lancements de Base et les 2 des actions tokenisees le 28/09) de l API (DESCRIPTIONS_API) sont celles que agentic.definitions publie' + (nonBranchees.length ? ' — non branchees : ' + nonBranchees.join(', ') : ''));
    const verdict = toutes.filter(([, t]) => /\b(safe|rug|scam)\b/i.test(t)).map(([k]) => k);
    ok(!verdict.length, 'aucune ne promet un verdict (« safe », « rug ») : des mesures' + (verdict.length ? ' — ' + verdict.join(', ') : ''));
    const courtes = toutes.filter(([, t]) => t.split('. ').length < 2 || t.split('. ')[0].length > 240).map(([k]) => k);
    ok(!courtes.length, 'apres la phrase « quand », au moins une phrase sur ce qui revient ; premiere phrase lisible (≤ 240 caracteres)' + (courtes.length ? ' — ' + courtes.join(', ') : ''));
    ok(toutes.every(([, t]) => !/[àâçéèêëîïôûùüÿœ]/i.test(t)), 'en anglais : aucun caractere accentue du francais');
    ok(/Powered by Go\+ Security/.test(dv.find((x) => x.name === 'new_launches').description), 'new_launches cite aussi GoPlus : ses decisions en dependent');
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
    ok(/Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(t2[2].content[0].content) && r.jetons[0].attribution && r.jetons[0].attribution.url === 'https://gopluslabs.io',
       'GoPlus a repondu : le modele lit « Powered by Go+ Security » avec le lien, et la carte porte l attribution pour la page');
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
    /* La licence GoPlus : un refus du Warden EST la phrase GoPlus (vetoWarden). Le
       resultat vendu la credite, en donnees ET dans la note que lit le modele. */
    const Sw = src({ vue: () => ({ candidats: [{ sym: 'HP', addr: '0xh', minutes: 2, liq: 9000, mc: 12000, ch_m5: 3, score: 40, refus: 'honeypot', quiRefuse: 'warden', origine: 'pools' },
                                              { sym: 'TX', addr: '0xx', minutes: 3, liq: 9000, mc: 12000, ch_m5: 3, score: 40, refus: 'sell tax 25%', quiRefuse: 'warden', origine: 'pools' }], surveillance: [] }) });
    const hp = (await A.outils(Sw).new_launches({})).texte, hpj = JSON.parse(hp);
    ok(hpj.fresh.map((x) => x.decision).join('|') === 'not bought: honeypot|not bought: sell tax 25%'
       && JSON.stringify(hpj.attribution) === JSON.stringify({ security: 'Powered by Go+ Security', url: 'https://gopluslabs.io' })
       && /Powered by Go\+ Security \(https:\/\/gopluslabs\.io\)/.test(hpj.note),
       'new_launches : un refus du Warden (« honeypot », donnee GoPlus) part avec « Powered by Go+ Security » et son lien, en donnees ET dans la note du modele');
    ok(JSON.parse((await O.new_launches({ limit: 1 })).texte).attribution.url === 'https://gopluslabs.io',
       'et toujours, meme sans refus du Warden : la note et « passed the colony s gates » tiennent compte de GoPlus');
    ok((await O.wallet_intel({ address: 'nope' })).erreur && vues.length === 0, 'wallet_intel : une adresse hors forme ne touche aucun service');
    const wi = await O.wallet_intel({ address: '0x' + 'AB'.repeat(20) });
    /* En DONNEES depuis le 26 septembre 2026 (l'API rendait `resultat: null`
       pour un texte libre) : l'intention ne change pas — constats d'abord,
       chaque fait avec sa source. */
    const wij = JSON.parse(wi.texte);
    ok(vues[0][0] === 'adresse' && vues[0][1] === '0x' + 'ab'.repeat(20) && Object.keys(wij).indexOf('findings') < Object.keys(wij).indexOf('facts')
       && /repeat launcher/.test(wij.findings[0].text) && wij.findings[0].severity === 'HIGH'
       && JSON.stringify(wij.facts[0]) === JSON.stringify({ predicate: 'LAUNCHED TOKENS ON', value: 'pons × 4', sources: ['pons registry'] }),
       'wallet_intel : l OSINT de l adresse, en donnees, constats d abord, chaque fait avec sa source');
    ok(JSON.stringify(wij.target) === JSON.stringify({ type: 'address', value: '0x' + 'ab'.repeat(20) }) && wij.passive === true && wij.factCount === 1,
       'la cible en anglais (address), « passive », et le nombre de faits');
    const mail = await O.osint_lookup({ target: 'someone@example.com' });
    ok(mail.erreur && /not people/.test(mail.erreur) && vues.length === 1, 'osint_lookup refuse une personne (e-mail) : aucun service interroge');
    const dom = await O.osint_lookup({ target: 'example.com' });
    ok(!dom.erreur && vues[1][0] === 'domaine', 'et accepte un domaine');
    ok(A.OSINT_TYPES.join(',') === 'domaine,ip,url,asn,cve', 'l OSINT offert ne vise que l infrastructure');

    /* ---- scan_token : les cases de la colonie en anglais, sans doublon, et les liens de la carte ----
     * Releve reel du 26 septembre 2026 (LOBSTER) : quatre cases du bytecode,
     * meme mesure (+16,9 %, 2 395 a 2 398 observations), sous leurs cles
     * francaises — l'agent qui payait les lisait telles quelles. */
    const ficheRH = Object.assign({}, fiche, { marche: Object.assign({}, fiche.marche, { chaine: 'robinhood' }),
      colonie: { observations: 147292, echeance: 30, scan: 'https://site.example/swoge_scan.html?t=' + ADR, faits: [],
        cases: [{ trait: 'octEmit', case: 'code : sans emission', n: 2395, moyenne: 16.9, assez: true }, { trait: 'octListe', case: 'code : sans liste noire', n: 2398, moyenne: 16.9, assez: true },
                { trait: 'octPause', case: 'code : sans pause', n: 2396, moyenne: 16.9, assez: true }, { trait: 'octFrais', case: 'code : frais fixes', n: 2398, moyenne: 16.9, assez: true },
                { trait: 'mc', case: 'mc <10k', n: 32821, moyenne: -4.3, assez: true }, { trait: 'age×mc', case: '2-6 h × mc <10k', n: 12, moyenne: -1.7, assez: false }] } });
    const L = (a) => ({ card: 'https://api.example/scan/carte/' + a + '.png', share: 'https://api.example/s/' + a, page: 'https://site.example/swoge_scan.html?t=' + a });
    const st = await A.outils(src({ fiche: async () => ficheRH, liensScan: L })).scan_token({ address: ADR });
    const cs = st.carte.colonie.cases;
    eq(cs.map((c) => c.trait + ' = ' + c.case + ' (' + c.n + ')').join(' | '),
       'Contract bytecode = bytecode: no mint, no blacklist, no pause, no fee setter (2395) | Market cap = cap <$10k (32821) | Pool age × Market cap = 2-6 h × cap <$10k (12)',
       'scan_token : les cases en anglais, la meme mesure une seule fois (la plus petite des n)');
    ok(!/code : |octEmit|emission|liste noire/.test(st.texte) && /Contract bytecode = bytecode: no mint/.test(st.texte) && /too few to conclude/.test(st.texte),
       'le texte lu par l agent : plus aucune cle francaise, et « trop peu » reste dit sous 30 observations');
    ok(st.carte.links && st.carte.links.card === L(ADR).card && st.carte.links.share === L(ADR).share && st.texte.includes(L(ADR).card) && st.texte.includes(L(ADR).share),
       'la colonie connait le jeton : les liens de sa carte partageable (image et page de partage), en donnees ET dans le texte');
    ok(ficheRH.colonie.cases[0].trait === 'octEmit' && ficheRH.colonie.cases.length === 6, 'la fiche en cache n est pas touchee (la page SwoleMind la lit aussi)');
    const sansColonie = await A.outils(src({ liensScan: L })).scan_token({ address: ADR });
    ok(!sansColonie.carte.links && !/scan\/carte/.test(sansColonie.texte), 'hors Robinhood Chain (pas de colonie) : pas de lien vers une carte qui n existe pas');
    /* token_verdict porte la meme carte (28/09) : le verdict le moins cher devient partageable. */
    const tv = await A.outils(src({ fiche: async () => ficheRH, liensScan: L })).token_verdict({ address: ADR });
    ok(tv.donnees.links && tv.donnees.links.share === L(ADR).share && tv.texte.includes(L(ADR).card) && tv.texte.includes(L(ADR).share) && tv.donnees.verdict,
       'token_verdict : la colonie connait le jeton, le verdict porte les liens de la carte, en donnees ET dans le texte');
    const tv2 = await A.outils(src({ liensScan: L })).token_verdict({ address: ADR });
    ok(!tv2.donnees.links && !/scan\/carte/.test(tv2.texte), 'token_verdict hors Robinhood Chain : aucun lien de carte');
  }

  console.log('\n-- 2d. l agent qui embauche (embauche.js, 28/09) : offert au joueur seulement, et il le dit --');
  {
    const appels = [];
    const embauche = { cherche: async (q) => { appels.push(['cherche', q]); return [{ url: 'https://meteo.example/forecast', usd: 0.01, methode: 'GET', description: 'Weather forecast', entree: { queryParams: { city: 'Paris' } } }]; },
      embauche: async (a) => { appels.push(['embauche', a.url]); return { ok: true, type: 'application/json', resultat: '{"tempC":21}', recu: { url: a.url, usd: 0.01, factureUsd: 0.011, reseau: 'eip155:8453', tx: '0xcd' } }; },
      budget: () => ({ jourUsd: 1, depenseUsd: 0, maxAppelUsd: 0.1 }) };
    const cl = faux([
      { stop: 'tool_use', content: [{ type: 'tool_use', id: 'e1', name: 'find_paid_services', input: { need: 'weather forecast city' } }] },
      { stop: 'tool_use', content: [{ type: 'tool_use', id: 'e2', name: 'hire_paid_service', input: { url: 'https://meteo.example/forecast', query: { city: 'Lyon' } } }] },
      { stop: 'end_turn', content: [{ type: 'text', text: 'It is 21 °C in Lyon. I paid 0.01 $ to meteo.example.' }] }]);
    const res = [];
    await A.repond({ m, messages: [{ role: 'user', content: 'weather in Lyon?' }], surResultat: (o) => res.push(o) }, { client: cl, src: src({ embauche }) });
    const noms = cl.vus[0].tools.map((t) => t.name);
    ok(noms.includes('find_paid_services') && noms.includes('hire_paid_service') && /hire_paid_service, which charges the user's balance/.test(cl.vus[0].system) && !/You can only READ/.test(cl.vus[0].system),
       'avec une embauche liee au joueur : les deux outils, et une consigne qui dit ce que l agent peut payer');
    const t3 = JSON.stringify(cl.vus[2].messages);
    ok(appels[0][0] === 'cherche' && appels[1][1] === 'https://meteo.example/forecast' && /tempC/.test(t3) && /paid 0.01 \$ to https:\/\/meteo.example\/forecast on Base, charged the user 0.011 \$/.test(t3),
       'le modele recoit la reponse du service ET le recu (paye, facture, reseau)');
    const cl2 = faux([{ stop: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
    await A.repond({ m, messages: [{ role: 'user', content: 'x' }] }, { client: cl2, src: src() });
    ok(!cl2.vus[0].tools.some((t) => /paid_service/.test(t.name)) && /You can only READ/.test(cl2.vus[0].system), 'sans embauche (API, MCP, x402) : ni les outils, ni la phrase');
    ok(!require('./agentic').definitions({ recherche: true }).some((t) => /paid_service/.test(t.name)), 'et l API publique ne les liste jamais');
  }

  console.log('\n-- 2e. l eSIM (achats.js, 28/09) : l agent propose, il n achete jamais --');
  {
    const appels = [];
    const achats = { forfaits: async (a) => { appels.push(['forfaits', a]); return { ok: true, destination: { nom: 'Japan', autres: ['Region of 12 countries (China…)'] }, total: 40,
        forfaits: [{ plan: 'japan-1gb-7days-x', nom: 'Japan 1GB 7Days', go: 1, jours: 7, usd: 1.400141, factureUsd: 1.470148 }], plafondUsd: 15,
        conditions: 'https://vamoschips.com/legal/terms', compatibles: 'https://vamoschips.com/compatibility' }; },
      propose: async (a) => { appels.push(['propose', a.plan]); return { ok: true, offre: { id: 'o1', plan: a.plan, nom: 'Japan 1GB 7Days', go: 1, jours: 7, usd: 1.400141, factureUsd: 1.470148 } }; },
      confirme: async () => { appels.push(['confirme']); return { ok: true }; } };
    const cl = faux([
      { stop: 'tool_use', content: [{ type: 'tool_use', id: 's1', name: 'find_esim_plans', input: { country: 'Japan', min_days: 7 } }] },
      { stop: 'tool_use', content: [{ type: 'tool_use', id: 's2', name: 'propose_esim_purchase', input: { plan: 'japan-1gb-7days-x' } }] },
      { stop: 'end_turn', content: [{ type: 'text', text: 'The offer is on your screen.' }] }]);
    const res = [];
    await A.repond({ m, messages: [{ role: 'user', content: 'I need data in Japan for a week' }], surResultat: (o) => res.push(o) }, { client: cl, src: src({ achats }) });
    const noms = cl.vus[0].tools.map((t) => t.name);
    ok(noms.includes('find_esim_plans') && noms.includes('propose_esim_purchase') && /Proposing never pays/.test(cl.vus[0].system) && /Never say the eSIM is bought/.test(cl.vus[0].system),
       'avec les achats lies au joueur : les deux outils, et une consigne qui dit que proposer ne paie pas');
    ok(appels[0][1].pays === 'Japan' && appels[0][1].jours === 7 && appels[1][1] === 'japan-1gb-7days-x' && !appels.some((x) => x[0] === 'confirme'),
       'l agent cherche puis propose ; il n a aucun moyen de confirmer');
    const t3 = JSON.stringify(cl.vus[2].messages);
    ok(/plan id: japan-1gb-7days-x/.test(JSON.stringify(cl.vus[1].messages)) && /Nothing is bought yet/.test(t3), 'le modele lit l identifiant du forfait, puis « rien n est achete »');
    const r2 = res.find((x) => x.nom === 'propose_esim_purchase');
    ok(r2 && r2.achat && r2.achat.id === 'o1' && r2.achat.factureUsd === 1.470148, 'la page recoit l offre (surResultat.achat) pour afficher le bouton Buy');
    const cl2 = faux([{ stop: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
    await A.repond({ m, messages: [{ role: 'user', content: 'x' }] }, { client: cl2, src: src() });
    ok(!cl2.vus[0].tools.some((t) => /esim/.test(t.name)) && !/eSIM/.test(cl2.vus[0].system), 'sans achats (API, MCP, x402) : ni les outils, ni la phrase');
    ok(!require('./agentic').definitions({ recherche: true }).some((t) => /esim/.test(t.name)), 'et l API publique ne les liste jamais');
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
    /* « telegram » seul n'est plus un signe de publication depuis le 26 septembre 2026 :
       `telegram_calls` LIT les appels deja releves. Ce qui posterait : le module
       d'envoi Telegram, ses fonctions d'envoi, ou le module des posts X. */
    ok(!/require\('\.\/miroir'\)|surAchat|surVente|sendTransaction|signTransaction|x_post|require\('\.\/telegram'\)|\.notify(Photo)?\(|sendMessage|sendDocument/.test(code), 'aucun outil n achete, ne vend, ne signe ni ne poste');
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const i = srv.indexOf("path === '/studio/agent' ||"), bloc = srv.slice(i, srv.indexOf('SWOLEMIND — L\'HISTORIQUE', i));
    ok(/sessionJoueur\.lire\(game\.sessionSecret, jeton\)/.test(bloc) && /fournisseur !== 'anthropic'/.test(bloc) && !/q\.addr|q\.adresse/.test(bloc),
       'la route prend l adresse dans la session, jamais dans le corps, et ne sert que Claude');
  }

  console.log('\n-- 6. les appels Telegram suivis : offerts seulement avec TG_APPELS_VENTE=1 (26 septembre 2026) --');
  {
    /* Eteint (le defaut) : l'agent des joueurs — facture a l'usage — ne le voit
       pas, et un modele qui l'appellerait quand meme recoit « unknown tool »
       comme pour un nom invente ; le suivi n'est jamais lu. */
    let lus = 0;
    const S6 = src({ appels: () => { lus++; return { calls: [], channels: [] }; } });
    const tente = () => faux([{ stop: 'tool_use', content: [{ type: 'tool_use', id: 'tg', name: 'telegram_calls', input: { hours: 12 } },
      { type: 'tool_use', id: 'zz', name: 'invented_tool', input: {} }] }]);
    const c0 = tente();
    await A.repond({ m, messages: [{ role: 'user', content: 'telegram calls?' }] }, { client: c0, src: S6 });
    const r0 = c0.vus[1].messages[2].content;
    ok(!c0.vus[0].tools.some((t) => t.name === 'telegram_calls'), 'eteint : l outil n est pas declare au modele');
    ok(r0[0].is_error && r0[0].content === r0[1].content && /unknown tool/.test(r0[0].content) && lus === 0,
       'eteint : l appeler quand meme = un outil inconnu, mot pour mot, et le suivi n est pas lu [' + r0[0].content + ']');

    /* Allume : la couverture d'avant, inchangee. */
    process.env.TG_APPELS_VENTE = '1';
    let q = null;
    const O2 = A.outils({ appels: (x) => { q = x; return { calls: [{ channel: 'XandersOGCALLS', symbol: 'WICKR', changeSinceDetectionPct: 12.5 }], channels: [], method: 'not advice' }; } });
    const r = await O2.telegram_calls({ channel: 'XandersOGCALLS', hours: 12, limit: 5 });
    ok(q.channel === 'XandersOGCALLS' && q.hours === 12 && q.limit === 5 && JSON.parse(r.texte).calls[0].symbol === 'WICKR', 'telegram_calls transmet les filtres et rend les appels suivis en donnees');
    ok(/not switched on/.test((await A.outils({}).telegram_calls({})).erreur), 'suivi eteint : une erreur dite, pas une liste vide trompeuse');
    const c1 = tente();
    await A.repond({ m, messages: [{ role: 'user', content: 'telegram calls?' }] }, { client: c1, src: S6 });
    const r1 = c1.vus[1].messages[2].content;
    ok(c1.vus[0].tools.some((t) => t.name === 'telegram_calls') && !r1[0].is_error && lus === 1 && r1[1].is_error,
       'allume : declare au modele et execute ; un nom invente reste inconnu');
    delete process.env.TG_APPELS_VENTE;
  }

  /* ==================================================================
   * 7. ASK_AGENT VENDU EN x402 : LES BORNES ET LA GARDE EN DIRECT
   *    (lot Base, contrat §D.2-D.4 et §F.3, 27 septembre 2026)
   * ================================================================== */
  console.log('\n-- 7. ask_agent en x402 : plafond dur, garde en direct --');
  {
    const L = A.LIMITES_X402;
    /* Le pire cas a la formule (Sonnet 5, tache de 2 000 caracteres, recherche) : 0,3528 $
       au contrat §D.3, avec OUTILS_JETONS = 2 600. Chaque appel relit les definitions :
       une borne d'outils plus haute (3 000 le 27/09, can_i_sell) ajoute
       etapesMax x (borne - 2 600) jetons a 2 $/M — 0,3560 $. Ce qui est VERROUILLE : la
       formule, et le plafond dur (0,36 $) qu'elle ne doit jamais depasser. */
    const pc = A.pireCasUsd(m, [{ content: 'x'.repeat(2000) }], true, L);
    const attendu = 0.3528 + L.etapesMax * (A.OUTILS_JETONS - 2600) * 2e-6;
    ok(Math.abs(pc - attendu) < 1e-9 && pc <= A.BUDGET_X402_USD, 'pire cas x402 a la formule : ' + pc.toFixed(4) + ' $ (attendu ' + attendu.toFixed(4) + ') <= plafond ' + A.BUDGET_X402_USD + ' $');
    ok(L.modele === 'sonnet-5' && L.tacheMaxCar === 2000 && L.etapesMax === 4 && L.outilsParEtape === 2 && L.resultatCarMax === 6000 && L.sortieMax === 4000 && L.dureeMaxS === 150 && L.finalApresS === 105,
       'LIMITES_X402 : Sonnet 5, 2 000 caracteres, 4 appels, 2 outils, 6 000 caracteres, 4 000 jetons, 150 s, final force a 105 s');
    /* Par cle : 0,8592 $ avec la borne de 2 600, plus ETAPES_MAX appels qui relisent chacun la borne. */
    const parCle = A.pireCasUsd(m, [{ content: 'x'.repeat(2000) }], true);
    const attenduCle = 0.8592 + A.ETAPES_MAX * (A.OUTILS_JETONS - 2600) * 2e-6;
    ok(Math.abs(parCle - attenduCle) < 1e-9, 'sans limites : le pire cas par cle suit la meme formule [' + parCle.toFixed(4) + ' vs ' + attenduCle.toFixed(4) + ']');
    /* Un faux client qui sait compter (messages.countTokens) et dont chaque appel coute cher. */
    const fauxCompte = (tours, o) => {
      const c = faux(tours);
      c.comptes = [];
      c.messages.countTokens = async (p) => { c.comptes.push(p); if (o && o.pendant) o.pendant(c.comptes.length); return { input_tokens: (o && o.n) || 30000 }; };
      return c;
    };
    const outilTour = (id, name, input, usage) => ({ stop: 'tool_use', usage, content: [{ type: 'text', text: 'step ' + id }, { type: 'tool_use', id, name, input }] });
    /* Chaque appel : 30 000 jetons d'entree, 4 000 de sortie = 0,10 $. */
    const cher = { input_tokens: 30000, output_tokens: 4000 };
    const c1 = fauxCompte([outilTour('a', 'colony_activity', {}, cher), outilTour('b', 'colony_activity', {}, cher), outilTour('c', 'colony_activity', {}, cher), outilTour('d', 'colony_activity', {}, cher)]);
    const r1 = await A.repond({ m, messages: [{ role: 'user', content: 'q' }] }, { client: c1, src: src(), limites: L, budgetUsd: A.BUDGET_X402_USD });
    ok(r1.etapes === 3 && c1.vus[2].tool_choice && c1.vus[2].tool_choice.type === 'none' && !c1.vus[1].tool_choice && r1.coutUsd <= A.BUDGET_X402_USD + 1e-12,
       'un client qui depenserait trop : le 3e appel est FORCE final (tool_choice none), ' + r1.etapes + ' appels, depense ' + r1.coutUsd.toFixed(4) + ' $ <= plafond');
    ok(c1.comptes.length === 3 && c1.comptes.every((p) => p.tools.every((t) => !('eager_input_streaming' in t)) && p.model === m.api && p.system),
       'chaque appel est COMPTE avant (countTokens : modele, systeme, outils sans eager_input_streaming, messages)');
    ok(c1.vus.every((p) => p.max_tokens === 4000 && p.tools.length) && c1.vus[1].messages[2].content.length === 1, 'x402 : 4 000 jetons de sortie par appel, 2 outils au plus par appel');
    /* Le compte depasse ce qui reste : l'appel n'est pas fait. */
    const c2 = fauxCompte([outilTour('a', 'colony_activity', {}, cher)], { n: 200000 });
    const r2 = await A.repond({ m, messages: [{ role: 'user', content: 'q' }] }, { client: c2, src: src(), limites: L, budgetUsd: A.BUDGET_X402_USD });
    ok(c2.vus.length === 0 && r2.arretBudget === true && r2.stop === 'budget' && r2.texte === '' && r2.coutUsd === 0, 'un premier appel qui pourrait crever le plafond : PAS fait, texte vide, rien depense');
    /* La recherche web refusee une fois le budget atteint. */
    let cherches = 0;
    const S7 = src({ cherche: async () => { cherches++; return [{ url: 'https://n.example', titre: 'N', extrait: 'x', date: null }]; } });
    const c3 = fauxCompte([outilTour('w', 'web_search', { query: 'x' }, { input_tokens: 1000, output_tokens: 19600 })], { n: 1000 });
    const r3 = await A.repond({ m, messages: [{ role: 'user', content: 'q' }] }, { client: c3, src: S7, limites: L, budgetUsd: 0.2 });
    ok(cherches === 0 && r3.arretBudget && r3.coutUsd <= 0.2 + 1e-12, 'la recherche (0,005 $) refusee quand elle crevait le plafond : Perplexity jamais appele, depense ' + r3.coutUsd.toFixed(4) + ' $ <= 0,20 $');
    ok(c3.vus.length === 1 && r3.stop === 'budget' && /step w/.test(r3.texte), 'et aucun appel de plus (le suivant crevait le plafond) : la tache rend le texte deja ecrit');
    /* Le temps : a 105 s, l'appel final est force (horloge de l'essai, 60 s par appel). */
    let t = 0;
    const c4 = fauxCompte([outilTour('a', 'colony_activity', {}, { input_tokens: 100, output_tokens: 10 }), outilTour('b', 'colony_activity', {}, { input_tokens: 100, output_tokens: 10 }),
      { stop: 'end_turn', content: [{ type: 'text', text: 'final' }] }], { n: 100, pendant: () => { t += 60000; } });
    const r4 = await A.repond({ m, messages: [{ role: 'user', content: 'q' }] }, { client: c4, src: src(), limites: L, budgetUsd: A.BUDGET_X402_USD, maintenant: () => t - 60000 });
    ok(!c4.vus[0].tool_choice && !c4.vus[1].tool_choice && c4.vus[2].tool_choice && c4.vus[2].tool_choice.type === 'none' && /final/.test(r4.texte),
       'la marque des 105 s : l appel qui part apres (120 s) est le final (tool_choice none)');
    /* A 150 s : l'appel en vol est coupe, la tache REND son texte et son usage (ni exception, ni 409). */
    const court = Object.assign({}, L, { dureeMaxS: 0.3, finalApresS: 0.25 });
    const c5 = fauxCompte([outilTour('a', 'colony_activity', {}, { input_tokens: 1000, output_tokens: 100 })], { n: 1000 });
    const s0 = c5.messages.stream;
    c5.messages.stream = (p, o) => {
      if (c5.vus.length < 1) return s0(p, o);
      c5.vus.push(p);
      /* Le 2e appel ne finit jamais : seul le signal du delai l'arrete. */
      const coupe = new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      return { [Symbol.asyncIterator]: async function* () { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' partial' } }; await coupe; }, finalMessage: async () => coupe };
    };
    const deb = Date.now();
    const r5 = await C.repond({ addr: 'x402:0x' + '5'.repeat(40), modele: 'sonnet-5', messages: [{ role: 'user', content: 'q' }] }, {
      horsSolde: true, prixUsd: 0.54, pireCas: (mm, msgs) => A.pireCasUsd(mm, msgs, false, court),
      fournisseur: (p) => A.repond(p, { client: c5, src: src(), limites: court, budgetUsd: A.BUDGET_X402_USD }) });
    ok(r5.ok === true && r5.arretDelai === true && /step a/.test(r5.texte) && /partial/.test(r5.texte) && r5.coutUsd > 0 && Date.now() - deb < 2000,
       'a la fin du temps : l appel en vol coupe, la tache rend son texte et son cout (ok, pas de 409) [' + JSON.stringify({ ok: r5.ok, code: r5.code, stop: r5.stop }) + ']');
    ok(r5.coutUsd >= (1000 * 2 + 100 * 10) / 1e6 && C.MESURE.horsSolde.n >= 1, 'le cout rendu compte l appel fini ET le pire cas de l appel coupe (' + r5.coutUsd + ' $)');
    /* Une panne du fournisseur APRES une depense (529 au 2e appel) : rien n est encaisse, mais
       ce que l execution a deja coute remonte jusqu au registre des pertes (contrat §D.6 ;
       revue du 27 septembre 2026 : avant, `throw e` perdait la depense, coutUsd null). */
    const panne = (cl) => {
      const s1 = cl.messages.stream;
      cl.messages.stream = (p, o) => {
        if (cl.vus.length < 1) return s1(p, o);
        cl.vus.push(p);
        const err = Object.assign(new Error('overloaded'), { status: 529 });
        return { [Symbol.asyncIterator]: async function* () { throw err; }, finalMessage: async () => { throw err; } };
      };
      return cl;
    };
    const c6 = panne(fauxCompte([outilTour('a', 'colony_activity', {}, cher)], { n: 30000 }));
    const r6 = await C.repond({ addr: 'x402:0x' + '6'.repeat(40), modele: 'sonnet-5', messages: [{ role: 'user', content: 'q' }] }, {
      horsSolde: true, prixUsd: 0.54, pireCas: (mm, msgs) => A.pireCasUsd(mm, msgs, false, L),
      fournisseur: (p) => A.repond(p, { client: c6, src: src(), limites: L, budgetUsd: A.BUDGET_X402_USD }) });
    const premier = A.coutAppelUsd(m, cher);
    ok(r6.ok === false && r6.code === 502 && c6.vus.length === 2 && r6.coutUsd >= premier - 1e-12 && r6.coutUsd <= A.BUDGET_X402_USD + 1e-12,
       '529 au 2e appel apres un 1er a ' + premier.toFixed(2) + ' $ : 502, rien encaisse, coutUsd ' + r6.coutUsd + ' $ (>= le 1er appel, <= plafond) [' + JSON.stringify({ ok: r6.ok, code: r6.code }) + ']');
    let e7 = null;
    try { await A.repond({ m, messages: [{ role: 'user', content: 'q' }] }, { client: panne(faux([outilTour('a', 'colony_activity', {}, cher)])), src: src() }); } catch (e) { e7 = e; }
    ok(e7 && e7.status === 529 && !('coutUsd' in e7), 'sans limites (page, cle) : l erreur remonte telle quelle, rien d ajoute');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
