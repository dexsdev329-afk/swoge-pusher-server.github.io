'use strict';
/* ==================================================================
 * SWOGEAGENTIC — UN AGENT QUI CHERCHE AVEC LES OUTILS DE SWOGE
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026, après lecture de HYRE
 * (hyreagent.fun : des outils payés à l'appel pour agents) : « on a
 * énormément d'API, on peut créer SwogeAgentic » — une page À PART, SwoleMind
 * reste tel quel. L'agent reçoit une tâche, choisit lui-même ses outils,
 * enchaîne les appels, et répond avec les chiffres qu'il a lus.
 *
 * ---- CE QU'IL PEUT FAIRE, ET CE QU'IL NE PEUT PAS ----
 *
 * Des outils de LECTURE seulement : la fiche d'un jeton (DexScreener, GoPlus,
 * la colonie), l'activité de la colonie, la recherche web (Perplexity),
 * l'économie $SWOGE. Aucun outil n'achète, ne vend, ne signe, ne poste :
 * l'agent ne touche jamais à l'argent ni à une adresse.
 *
 * ---- LA BOUCLE ----
 *
 * La boucle manuelle en streaming de la documentation du SDK Anthropic
 * (`messages.stream` puis `finalMessage`, relue le 26 septembre) : on a
 * besoin d'additionner l'`usage` de CHAQUE appel pour la facture, et de
 * borner le nombre d'appels pour que le pire cas se calcule. Arrêts :
 * `end_turn`, `refusal`, `max_tokens` (une entrée d'outil coupée ne
 * s'exécute jamais), ou ETAPES_MAX atteint.
 *
 * ---- LE PIRE CAS, POUR LA RÉSERVE ----
 *
 * ETAPES_MAX appels au plus ; à chacun, au plus OUTILS_PAR_ETAPE outils dont
 * le résultat est coupé à RESULTAT_CAR_MAX caractères (un jeton pour deux
 * caractères, la règle de la réserve), et au plus SORTIE_MAX jetons de
 * sortie. L'entrée de l'appel k porte tout ce qui précède : la somme se
 * calcule exactement (voir `pireCasUsd`). Aucune logique d'argent ici :
 * `studio_chat.repond` réserve ce pire cas, facture le réel, rend le reste.
 * ================================================================== */

const AnthropicMod = require('@anthropic-ai/sdk');
const Anthropic = AnthropicMod.default || AnthropicMod;

const ETAPES_MAX = 6;
const OUTILS_PAR_ETAPE = 3;
const RESULTAT_CAR_MAX = 8000;
const SORTIE_MAX = 4000;
/* Les définitions d'outils, à la règle des réserves (un jeton pour deux
   caractères). Mesuré le 26 septembre 2026 avec les 7 outils : 3 120
   caractères, soit 1 560 jetons — l'ancienne borne de 1 500 ne tenait plus.
   L'essai vérifie que la borne couvre toujours les définitions. */
const OUTILS_JETONS = 2000;
const SYSTEME_JETONS = 500;
const PRIX_RECHERCHE_USD = 0.005;      /* Perplexity Search API, la requête réussie */

const SYSTEME = [
  'You are SwogeAgentic, the research agent of SWOGE WORLD.',
  'You receive a task, decide which tools to call, call them (several if useful), then answer.',
  'Answer in the language the user writes in, with Markdown. Quote the numbers you read with their source and, for the SWOGE AI colony, their number of observations.',
  'Never give financial advice, price predictions or buy/sell calls. Never call a token safe; "unknown" is unknown, not good news.',
  'You can only READ: you cannot buy, sell, sign or post anything. If asked to, say so.',
].join(' ');

/* Les outils, au format de l'API Messages (name, description, input_schema). */
function definitions(actifs) {
  const d = [
    { name: 'scan_token', description: 'Read live data on a token by its EVM contract address (0x…): market (DexScreener, deepest pool on any chain), contract security (GoPlus: honeypot, taxes, owner powers, holder concentration) and, for Robinhood Chain tokens, what the SWOGE AI colony measured on tokens with the same traits (with observation counts).',
      input_schema: { type: 'object', properties: { address: { type: 'string', description: 'EVM contract address, 0x followed by 40 hex characters' } }, required: ['address'] } },
    { name: 'colony_activity', description: 'What the SWOGE AI colony (an autonomous paper-trading colony on Robinhood Chain that learns from every token it watches) is doing: open positions, latest buys and sells with their results, the real-money mirror record, and its overall paper ledger. Optionally filtered to one token symbol or address.',
      input_schema: { type: 'object', properties: { token: { type: 'string', description: 'optional token symbol (e.g. TELEPAD) or address to filter on' } } } },
    { name: 'swoge_economy', description: 'The $SWOGE token economy read on-chain: total supply, burnt, casino vault, and the current $SWOGE price in USD.',
      input_schema: { type: 'object', properties: {} } },
    /* ---- AJOUTES LE 26 SEPTEMBRE 2026 (etape 3 de SwogeAgentic) ----
       Trois lectures qui existaient deja sur le serveur, jamais exposees :
       ce que la colonie vient de trouver, l'historique d'un lanceur (OSINT
       passif sur une adresse), la reconnaissance passive d'une infrastructure. */
    { name: 'new_launches', description: 'The newest tokens the SWOGE AI colony just found on Robinhood Chain (minutes old), with pool size, cap, 5-minute move and why the colony did or did not buy each one, plus the older tokens it keeps watching and its verdict on each.',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'how many fresh tokens (default 15)' } } } },
    { name: 'wallet_intel', description: 'What is known about an EVM wallet address: whether it launched tokens on the launchpads we index, which tokens it deployed, and what the SWOGE AI colony measured on launchers like it (with observation counts). Passive: the address is never contacted.',
      input_schema: { type: 'object', properties: { address: { type: 'string', description: 'EVM address, 0x followed by 40 hex characters' } }, required: ['address'] } },
    { name: 'osint_lookup', description: 'Passive reconnaissance on infrastructure: a domain, an IP address, a website URL, an autonomous system (AS15169) or a CVE. Returns DNS, certificates, registration, hosting and exposure findings, each with its source. People (e-mails, usernames, phone numbers, names) are not accepted.',
      input_schema: { type: 'object', properties: { target: { type: 'string', description: 'a domain, IP, URL, AS number or CVE id' } }, required: ['target'] } },
  ];
  if (actifs && actifs.recherche) d.push({ name: 'web_search', description: 'Search the web (Perplexity). Returns ranked results with title, URL, date and an extract. Use it for news, projects, people, anything outside SWOGE data.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'the search query, as you would type it' } }, required: ['query'] } });
  return d.map((x) => Object.assign({ eager_input_streaming: true }, x));
}

/** Le pire cas d'une tâche, en USD avant marge — `messages` nettoyés par studio_chat. */
function pireCasUsd(m, messages, recherche) {
  const car = (messages || []).reduce((s, x) => s + String(x.content || '').length, 0);
  const sortie = Math.min(m.maxTokens, SORTIE_MAX);
  const base = Math.ceil(car / 2) + SYSTEME_JETONS + OUTILS_JETONS;
  const parEtape = sortie + OUTILS_PAR_ETAPE * Math.ceil(RESULTAT_CAR_MAX / 2);
  /* L'appel k (0…ETAPES_MAX−1) relit la base et tout ce que les k précédents ont ajouté. */
  let entree = 0;
  for (let k = 0; k < ETAPES_MAX; k++) entree += base + k * parEtape;
  const recherches = recherche ? ETAPES_MAX * OUTILS_PAR_ETAPE : 0;
  return entree * m.entree / 1e6 + ETAPES_MAX * sortie * m.sortie / 1e6 + recherches * PRIX_RECHERCHE_USD;
}

const adresseOk = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
/* L'OSINT offert aux autres agents ne vise que l'INFRASTRUCTURE : vendre a
   n'importe quel agent une recherche sur des personnes, en serie, serait
   offrir du profilage. Le module sait faire plus ; ce n'est pas exposé ici. */
const OSINT_TYPES = ['domaine', 'ip', 'url', 'asn', 'cve'];
/** Un rapport OSINT, en texte court pour un modele : constats d'abord, puis faits sources. */
function resumeOsint(r) {
  const cst = (r.constats || []).slice(0, 10).map((c) => '- [' + c.etiquette + '] ' + c.dit);
  const fts = (r.faits || []).slice(0, 30).map((f) => '- ' + f.predicat + ': ' + String(f.valeur || (f.objet && f.objet.valeur) || f.extrait || '').slice(0, 160)
    + (f.sources && f.sources.length ? ' (source: ' + f.sources.slice(0, 2).join(', ') + ')' : ''));
  return 'Target: ' + (r.cible ? r.cible.type + ' ' + r.cible.valeur : '?') + ' (passive, ' + (r.faits || []).length + ' facts)\n'
    + (cst.length ? 'Findings:\n' + cst.join('\n') + '\n' : 'No finding raised.\n') + (fts.length ? 'Facts:\n' + fts.join('\n') : '');
}
const coupe = (s) => { s = String(s); return s.length > RESULTAT_CAR_MAX ? s.slice(0, RESULTAT_CAR_MAX) + '\n[truncated]' : s; };

/**
 * Les outils, câblés sur ce que le serveur sait déjà faire. `src` :
 *   fiche(addr) → fiche studio_jeton ; Jeton (le module) ; vue() → aiColonie.vue() ;
 *   economie() → economie.etat() ; cours() → cours $SWOGE ; cherche(q) → Perplexity.
 * Chaque outil rend { texte, carte?, recherche?, sources? } ; une erreur devient
 * un résultat `is_error`, jamais une exception qui casserait la tâche.
 */
function outils(src) {
  return {
    async scan_token(e) {
      if (!adresseOk(e.address)) return { erreur: 'address must be 0x followed by 40 hex characters' };
      const f = await src.fiche(String(e.address).toLowerCase());
      return { texte: src.Jeton.contexte([f]), carte: src.Jeton.carte(f), sources: src.Jeton.sources([f]) };
    },
    async colony_activity(e) {
      const v = src.vue() || {};
      const filtre = String((e && e.token) || '').trim().toLowerCase();
      const garde = (x) => !filtre || String(x.sym || '').toLowerCase() === filtre || String(x.adr || '').toLowerCase() === filtre;
      const iso = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null);
      const c = (v.carnet && v.carnet.tout) || null;
      const o = {
        note: 'Paper trades of an autonomous colony: measurements, never advice. The mirror executes some of them with real money.',
        status: v.pause ? 'paused' : 'running', rounds: v.tours, lastRound: iso(v.dernierTour),
        paperTreasuryUsd: v.tresor, paperStartUsd: v.depart,
        openPositions: (v.positions || []).filter(garde).map((p) => ({ sym: p.sym, address: p.adr, heldMinutes: p.ouverteDepuis ? Math.round(p.ouverteDepuis / 60000) : null,
          unrealisedPct: p.latent, stakeUsd: p.mise, capAtBuyUsd: p.mcAchat })),
        latestSignals: (v.signaux || []).filter(garde).slice(0, 15).map((s) => ({ kind: s.k === 'achat' ? 'buy' : s.k === 'vente' ? 'sell' : s.k,
          sym: s.sym, address: s.adr, capUsd: s.mc, resultPct: typeof s.r === 'number' ? Math.round(s.r * 10) / 10 : undefined, why: s.comment, at: iso(s.t) })),
        paperLedger: c ? { trades: c.n, averagePct: c.moyenne, winnersPct: c.partGagnantes } : null,
        realMirror: v.reel ? { trades: v.reel.n, averagePct: v.reel.moyenne } : null,
      };
      return { texte: JSON.stringify(o) };
    },
    async swoge_economy() {
      const [e, cours] = await Promise.all([src.economie(), src.cours()]);
      return { texte: JSON.stringify({ economy: e, swogePriceUsd: cours || null, source: 'on-chain reads (chain 4663) and DexScreener' }) };
    },
    async new_launches(e) {
      const v = src.vue() || {};
      const n = Math.max(1, Math.min(30, parseInt((e && e.limit) || 15, 10) || 15));
      const frais = (v.candidats || []).slice().sort((a, b) => (a.minutes || 0) - (b.minutes || 0)).slice(0, n).map((c) => ({
        sym: c.sym, address: c.addr, ageMinutes: c.minutes, poolUsd: c.liq, capUsd: c.mc, change5mPct: c.ch_m5, score: c.score,
        decision: c.refus ? 'not bought: ' + c.refus : 'passed the colony\'s gates', origin: c.origine }));
      const suivis = (v.surveillance || []).slice(0, 15).map((w) => ({ sym: w.sym, address: w.addr, timesSeen: w.vu, poolUsd: w.liq, verdict: w.verdict }));
      return { texte: JSON.stringify({ note: 'Live reads of the SWOGE AI colony on Robinhood Chain: measurements and decisions, never advice.', fresh: frais, watched: suivis }) };
    },
    async wallet_intel(e) {
      if (!adresseOk(e && e.address)) return { erreur: 'address must be 0x followed by 40 hex characters' };
      const r = await src.osint('adresse', String(e.address).toLowerCase());
      return { texte: resumeOsint(r) };
    },
    async osint_lookup(e) {
      const g = src.detecte(String((e && e.target) || '').trim().slice(0, 300));
      if (!g) return { erreur: 'not a recognised target: give a domain, an IP address, a URL, an AS number or a CVE id' };
      if (!OSINT_TYPES.includes(g.type)) return { erreur: 'only infrastructure is accepted here (domain, IP, URL, AS number, CVE) — not people, e-mails, usernames or phone numbers' };
      const r = await src.osint(g.type, g.valeur);
      return { texte: resumeOsint(r) };
    },
    async web_search(e) {
      const q = String((e && e.query) || '').trim().slice(0, 400);
      if (!q) return { erreur: 'empty query' };
      const r = await src.cherche(q);
      return { texte: r.length ? src.contexteRecherche(r) : 'No results.', recherche: 1,
               sources: r.map((x) => ({ url: x.url, titre: x.titre })) };
    },
  };
}

/**
 * Une tâche, en streaming. Même contrat qu'un fournisseur de studio_chat :
 * rend { texte, sources, usage, stop, servi } — `usage` additionné sur tous
 * les appels, `recherches_perplexity` compté pour la facture. `surOutil`
 * et `surResultat` racontent chaque geste à la page.
 */
async function repond({ m, messages, surTexte, surReflexion, surOutil, surResultat }, deps) {
  const c = (deps && deps.client) || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 180000 });
  const O = outils(deps.src);
  const tools = definitions({ recherche: !!deps.src.recherche });
  const fil = messages.map((x) => ({ role: x.role, content: x.content }));
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, recherches_perplexity: 0 };
  const textes = [], sources = [], cartes = [];
  let stop = null, servi = m.api, etapes = 0;

  while (etapes < ETAPES_MAX) {
    etapes++;
    /* Au dernier appel permis, il doit conclure avec ce qu'il a : les outils
       restent DECLARES (l'historique porte des blocs tool_use) mais
       `tool_choice: none` les interdit — accepte par tous les modeles, quand
       `any`/`tool` rendent un 400 sur Opus 5.5 et Fable 5.1 (doc relue). */
    const dernier = etapes === ETAPES_MAX;
    const params = { model: m.api, max_tokens: Math.min(m.maxTokens, SORTIE_MAX), system: SYSTEME, messages: fil, tools };
    if (dernier) params.tool_choice = { type: 'none' };
    const flux = m.repli
      ? c.beta.messages.stream(Object.assign({}, params, { betas: ['server-side-fallback-2026-06-01'], fallbacks: [{ model: m.repli }] }))
      : c.messages.stream(params);
    let texteEtape = '';
    for await (const ev of flux) {
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking' && surReflexion) surReflexion();
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        if (!texteEtape && textes.length && surTexte) surTexte('\n\n');
        texteEtape += ev.delta.text;
        if (surTexte) surTexte(ev.delta.text);
      }
    }
    const msg = await flux.finalMessage();
    const u = msg.usage || {};
    usage.input_tokens += u.input_tokens || 0; usage.output_tokens += u.output_tokens || 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens || 0; usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    servi = msg.model || servi; stop = msg.stop_reason || null;
    if (texteEtape) textes.push(texteEtape);

    const appels = (msg.content || []).filter((b) => b.type === 'tool_use');
    if (stop !== 'tool_use' || !appels.length) break;          /* end_turn, refusal, max_tokens : on s'arrête */
    fil.push({ role: 'assistant', content: msg.content });
    const resultats = [];
    for (let i = 0; i < appels.length; i++) {
      const b = appels[i];
      if (i >= OUTILS_PAR_ETAPE || !O[b.name] || !b.input || typeof b.input !== 'object') {
        resultats.push({ type: 'tool_result', tool_use_id: b.id, is_error: true,
          content: i >= OUTILS_PAR_ETAPE ? 'at most ' + OUTILS_PAR_ETAPE + ' tools per step' : 'unknown tool or unreadable input' });
        continue;
      }
      if (surOutil) surOutil({ id: b.id, nom: b.name, entree: b.input });
      let r;
      try { r = await O[b.name](b.input); } catch (e) { r = { erreur: 'the tool failed: ' + String(e && e.message || e).slice(0, 120) }; }
      if (r.recherche) usage.recherches_perplexity += r.recherche;
      if (r.sources) for (const s of r.sources) if (!sources.some((x) => x.url === s.url)) sources.push(s);
      if (r.carte) cartes.push(r.carte);
      if (surResultat) surResultat({ id: b.id, nom: b.name, ok: !r.erreur, resume: r.erreur || coupe(r.texte || '').slice(0, 280), carte: r.carte || null });
      resultats.push(r.erreur ? { type: 'tool_result', tool_use_id: b.id, is_error: true, content: r.erreur }
                              : { type: 'tool_result', tool_use_id: b.id, content: coupe(r.texte || '') });
    }
    fil.push({ role: 'user', content: resultats });
  }
  return { texte: textes.join('\n\n'), sources, usage, stop: stop === 'tool_use' ? 'max_steps' : stop, servi, jetons: cartes, etapes };
}

module.exports = { repond, definitions, outils, pireCasUsd, SYSTEME, OSINT_TYPES, resumeOsint, OUTILS_JETONS, SYSTEME_JETONS,
  ETAPES_MAX, OUTILS_PAR_ETAPE, RESULTAT_CAR_MAX, SORTIE_MAX };
