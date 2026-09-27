'use strict';
/* ==================================================================
 * SWOGEAGENTIC — SE FAIRE TROUVER PAR LES AGENTS
 * ==================================================================
 *
 * Demande du propriétaire, 26 septembre 2026 : « comment d'autres agents IA
 * peuvent nous trouver et utiliser nos services ». Relu le même jour :
 *   - spécification de découverte d'AgentCash (lue par x402scan et mppscan) :
 *     `GET /openapi.json` (OpenAPI 3.1, `info.x-guidance`, `x-payment-info`
 *     par opération payante, prix en DOLLARS décimaux — les unités atomiques
 *     sont dans le 402), preuve de propriété dans `x-discovery.ownershipProofs` ;
 *     « les sondes sans authentification atteignent le 402 AVANT la validation
 *     du corps » ;
 *   - manifeste `GET /.well-known/x402` lu par x402scan :
 *     `{ version: 1, x402Version: 2, resources: [url…], ownershipProofs: […] }` ;
 *   - la preuve de propriété : une signature EIP-191 de l'ORIGINE nue
 *     (https://hôte, sans barre finale) par une adresse `payTo`. Elle ne peut
 *     venir que du propriétaire (la clé de la trésorerie n'est pas ici) : il la
 *     pose dans `X402_PREUVE`, le serveur la VÉRIFIE et ne la publie que juste.
 *
 * ---- LA DEUXIÈME PASSE (audit du 26 septembre 2026, le soir) ----
 * L'audit AgentCash (`npx @agentcash/discovery`) relevait 16 erreurs, presque
 * toutes « Output schema is missing », des prix jusqu'à 10 fois le gaz
 * (0,157 $ affichés pour une lecture à 0,01 $), trois outils « sans mode
 * d'authentification » et aucun contact. Relu AVANT de changer un nom de champ :
 *   - https://agentcash.dev/discovery et le paquet @agentcash/discovery 1.7.5
 *     (docs/SPECIFICATION.md) : `responses.200.content["application/json"].schema`
 *     est le schéma de sortie qu'il lit ; une clé n'est reconnue que par un
 *     schéma de sécurité `type: "apiKey"` (le bearer `http` ne compte pas) ;
 *     `info.contact` recommandé ; extensions canoniques facultatives
 *     `x-agentcash-provenance.ownershipProofs` (lue AVANT `x-discovery`) et
 *     `x-agentcash-guidance.llmsTxtUrl` ; `info.x-guidance` sous ~4 000 caractères ;
 *   - x402scan (docs/DISCOVERY.md) : `/.well-known/x402` ne définit que
 *     `version`, `resources`, `ownershipProofs` et `instructions` — ni icône ni
 *     étiquettes. L'icône d'un service, x402scan la prend à l'ORIGINE (favicon,
 *     servi par la route /favicon.ico) ; titre et description, à défaut de page
 *     HTML, dans `info` de l'OpenAPI ; les étiquettes, il les pose lui-même.
 *     Les étiquettes vont donc là où la spécification OpenAPI les définit
 *     (`tags`, en tête et par opération, comme l'exemple d'AgentCash), le logo
 *     dans `info.x-logo` (l'extension de Redoc), et le manifeste gagne
 *     `instructions` — rien d'inventé.
 *
 * Tout est construit depuis le catalogue en direct : un outil ajouté apparaît
 * partout, avec son prix du moment. Rien n'est inventé : sans x402 allumé, pas
 * de manifeste (404), et l'OpenAPI ne décrit que les appels par clé.
 * ================================================================== */

const { ethers } = require('ethers');

/** L'origine nue d'une URL : https://hôte[:port], sans chemin ni barre finale. */
function origine(url) {
  const u = new URL(url);
  return u.protocol + '//' + u.host;
}

/** Les preuves de propriété valides : signées (EIP-191) sur l'origine par la trésorerie. Les autres sont écartées. */
function preuvesValides(preuves, orig, payTo) {
  return String(preuves || '').split(',').map((x) => x.trim()).filter(Boolean).filter((sig) => {
    try { return ethers.utils.verifyMessage(orig, sig).toLowerCase() === String(payTo || '').toLowerCase(); }
    catch (e) { return false; }
  });
}

/** Le prix affiché d'un outil payable d'avance : décimal en $, 6 chiffres (spec AgentCash). */
const usd6 = (x) => Number(x).toFixed(6);

const ICONE = 'https://swoleeswoge.dog/img/site/icone-192.png';

/* Ce qu'est le service, en une phrase puis en un paragraphe : `info.description`
   (que x402scan reprend quand l'origine n'a pas de page HTML) et le manifeste. */
const RESUME = 'Robinhood Chain intelligence for AI agents, measured with sample sizes: token scans, the SWOGE AI colony\'s measurements and fresh launches, launcher history, OSINT, web search, images and a research agent. Pay per call in USDG or $SWOGE, no account needed.';
const DESCRIPTION = 'SwogeAgentic sells the measurements of SWOGE AI, an autonomous colony that watches every new token on Robinhood Chain and records how tokens with each trait moved afterwards: '
  + 'every number comes with its number of observations, and a cell with too few is not shown. Use it before touching a Robinhood Chain token, or any EVM token: '
  + 'scan_token reads the market (DexScreener), the contract (Powered by Go+ Security) and what the colony measured on tokens like it; new_launches lists tokens minutes old with the colony\'s decision on each; '
  + 'wallet_intel tells who is behind a deployer. Also passive infrastructure OSINT, web search, image and video generation, and a research agent that chains the tools. '
  + 'Read-only: nothing here trades, signs or holds your funds. Measurements, never a buy or sell signal.';

/* ---- LES ÉTIQUETTES (OpenAPI `tags`) ---- */
const ETIQUETTES = [
  { name: 'crypto', description: 'Tokens, markets and on-chain data' },
  { name: 'robinhood-chain', description: 'Robinhood Chain (eip155:4663), measured by the SWOGE AI colony with sample sizes' },
  { name: 'token-security', description: 'Contract checks (Powered by Go+ Security) and what similar tokens did' },
  { name: 'research', description: 'Web search, OSINT and a research agent' },
  { name: 'osint', description: 'Passive reconnaissance on infrastructure and deployer wallets' },
  { name: 'images', description: 'Image generation (Grok Imagine, ChatGPT Image)' },
  { name: 'video', description: 'Short video generation (Grok Imagine)' },
  { name: 'catalogue', description: 'The live tool list, prices and x402 status' },
];
const ETIQUETTES_OUTIL = {
  scan_token: ['token-security', 'crypto', 'robinhood-chain'], colony_activity: ['robinhood-chain', 'crypto'], swoge_economy: ['crypto', 'robinhood-chain'],
  new_launches: ['robinhood-chain', 'crypto', 'token-security'], wallet_intel: ['osint', 'crypto', 'robinhood-chain'], osint_lookup: ['osint', 'research'],
  telegram_calls: ['robinhood-chain', 'crypto'], web_search: ['research'], ask_agent: ['research', 'crypto'],
  generate_image: ['images'], generate_video: ['video'], video_status: ['video'],
};

/* ==================================================================
 * LES SCHÉMAS DE SORTIE — lus dans le code de chaque outil le 26 septembre
 * 2026 : studio_agent.outils (et studio_jeton.carte pour scan_token), puis
 * agentic.resultatDe / appelle / sertSansFacture pour l'enveloppe, et
 * x402.traite pour le reçu. decouverte.test.js fait tourner les VRAIS outils
 * et valide leur sortie contre ces schémas dans les deux sens : aucun champ
 * requis inventé, aucun champ rendu qui ne soit décrit.
 * ================================================================== */
const s = (d) => ({ type: 'string', description: d });
const sn = (d) => ({ type: ['string', 'null'], description: d });
const n = (d) => ({ type: 'number', description: d });
const nn = (d) => ({ type: ['number', 'null'], description: d });
const b = (d) => ({ type: 'boolean', description: d });
const bn = (d) => ({ type: ['boolean', 'null'], description: d });
const tab = (items, d) => ({ type: 'array', items, description: d });
const obj = (props, req, d) => Object.assign({ type: 'object', properties: props, required: req || [] }, d ? { description: d } : {});
const objn = (props, req, d) => Object.assign(obj(props, req, d), { type: ['object', 'null'] });

const ADR = '0x254afb9fd36789bea39fb5656ba6fdb827be8dc5';
const ATTR = obj({ security: s('always "Powered by Go+ Security"'), url: s('https://gopluslabs.io') }, ['security', 'url'], 'GoPlus attribution: quote the security data with it');
const ATTR_EX = { security: 'Powered by Go+ Security', url: 'https://gopluslabs.io' };
const SOURCE = obj({ url: s('source URL'), titre: s('source title') }, ['url']);
const OSINT = obj({
  target: objn({ type: { type: 'string', enum: ['address', 'domain', 'ip', 'url', 'asn', 'cve'] }, value: s('the target as read') }, ['type', 'value']),
  passive: b('always true: the target never sees our requests'),
  findings: tab(obj({ severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'NOTE'] }, text: s('what the facts together show') }, ['severity', 'text']), 'findings first, most severe first (at most 10)'),
  facts: tab(obj({ predicate: s('what the fact is about'), value: s('its value (160 characters at most)'), sources: tab(s(), 'where it was read (2 at most)') }, ['predicate', 'value', 'sources']), 'at most 30 facts'),
  factCount: n('facts found in total'),
}, ['target', 'passive', 'findings', 'facts', 'factCount']);

const CARTE_JETON = obj({
  adresse: s('contract address, lowercase'), trouve: b('false when DexScreener knows no pool for it'),
  sym: sn('symbol'), nom: sn('name'), chaine: sn('DexScreener chain id of the deepest pool (robinhood, ethereum, base…)'),
  prixUsd: nn('price, USD'), liqUsd: nn('liquidity of the deepest pool, USD'), mcUsd: nn('market cap (or FDV), USD'), vol24Usd: nn('24 h volume, USD'),
  var24h: nn('24 h price change, %'), url: sn('DexScreener pool page'),
  securite: { type: 'string', enum: ['read', 'unknown', 'uncovered', 'failed'], description: 'GoPlus: read; unknown (no record yet — not good news); uncovered (chain not covered); failed' },
  honeypot: bn('GoPlus honeypot flag (null: unknown)'), taxeAchat: nn('buy tax, %'), taxeVente: nn('sell tax, %'),
  alertes: tab(s(), 'GoPlus red flags in words (Honeypot, Mintable, Blacklist, Hidden owner…)'),
  porteurs: nn('holder count'), premierPorteur: nn('largest free wallet, % of supply (contracts, locks and burns excluded)'), dixPremiers: nn('top 10 free wallets, % of supply'),
  colonie: objn({ observations: n('observations in the colony memory'), scan: s('the SWOGE Scan page of this token'),
    cases: tab(obj({ trait: s('what was measured, in words'), case: s('this token\'s value, in words'), n: n('observations behind the number'),
      moyenne: n('average 30-minute move of past tokens in this cell, %'), assez: b('false under 30 observations: too few to conclude') }, ['trait', 'case', 'n', 'moyenne', 'assez']),
      'one line per measurement, strongest first') }, ['observations', 'scan', 'cases'], 'Robinhood Chain tokens only: what the SWOGE AI colony measured'),
  attribution: objn({ security: s(), url: s() }, ['security', 'url'], 'set when GoPlus answered'),
  links: obj({ card: s('shareable scan card, PNG 1200×630'), share: s('share page whose link preview is the card'), page: s('the scan on swoleeswoge.dog') },
    ['card', 'share', 'page'], 'when the colony knows the token'),
}, ['adresse', 'trouve', 'sym', 'nom', 'chaine', 'prixUsd', 'liqUsd', 'mcUsd', 'vol24Usd', 'var24h', 'url', 'securite', 'honeypot', 'taxeAchat', 'taxeVente',
  'alertes', 'porteurs', 'premierPorteur', 'dixPremiers', 'colonie', 'attribution']);

const SORTIES = {
  scan_token: {
    schema: obj({ token: CARTE_JETON, sources: tab(SOURCE, 'DexScreener pool and SWOGE Scan page'), attribution: ATTR }, ['token', 'sources', 'attribution']),
    exemple: { token: { adresse: ADR, trouve: true, sym: 'LOBSTER', nom: 'Lobster', chaine: 'robinhood', prixUsd: 0.000008424, liqUsd: 8803.04, mcUsd: 8253, vol24Usd: 1204.7,
      var24h: -3.1, url: 'https://dexscreener.com/robinhood/0x66604bdceb5a54c2c137383171085c3c2260d3d21abe1a77d9180053c9e58c53', securite: 'unknown', honeypot: null,
      taxeAchat: null, taxeVente: null, alertes: [], porteurs: null, premierPorteur: null, dixPremiers: null,
      colonie: { observations: 147292, scan: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR, cases: [
        { trait: 'Contract bytecode', case: 'bytecode: no mint, no blacklist, no pause, no fee setter', n: 2395, moyenne: 16.9, assez: true },
        { trait: 'Social links', case: '3+ socials', n: 1087, moyenne: 16.5, assez: true },
        { trait: 'Launchpad', case: 'not from a launchpad', n: 52584, moyenne: 5.5, assez: true },
        { trait: 'Launcher history', case: 'no launchpad record', n: 57003, moyenne: 4.5, assez: true },
        { trait: 'Market cap', case: 'cap <$10k', n: 32821, moyenne: -4.3, assez: true },
        { trait: 'How the colony found it', case: 'found via pools', n: 51335, moyenne: 3.7, assez: true }] },
      attribution: ATTR_EX,
      links: { card: 'https://web-production-220a3.up.railway.app/scan/carte/' + ADR + '.png', share: 'https://web-production-220a3.up.railway.app/s/' + ADR,
        page: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR } },
    sources: [{ url: 'https://dexscreener.com/robinhood/0x66604bdceb5a54c2c137383171085c3c2260d3d21abe1a77d9180053c9e58c53', titre: 'DexScreener · $LOBSTER' },
      { url: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR, titre: 'SWOGE Scan · $LOBSTER' }],
    attribution: ATTR_EX },
    texte: 'Token ' + ADR + ':\n- Market (DexScreener, deepest of 1 pool): $LOBSTER "Lobster" on robinhood (uniswap), price $0.000008424, liquidity $8,803, market cap $8,253…',
  },
  colony_activity: {
    schema: obj({
      note: s('what these numbers are'), status: { type: 'string', enum: ['running', 'paused'] }, rounds: n('rounds played'), lastRound: sn('last round, UTC'),
      paperTreasuryUsd: n('paper treasury, USD'), paperStartUsd: n('paper start, USD'),
      openPositions: tab(obj({ sym: s(), address: s(), heldMinutes: nn('minutes held'), unrealisedPct: n('unrealised result, %'), stakeUsd: n('paper stake, USD'), capAtBuyUsd: n('market cap at buy, USD') })),
      latestSignals: tab(obj({ kind: { type: 'string', enum: ['buy', 'sell'] }, sym: s(), address: s(), capUsd: n('market cap, USD'), resultPct: n('result of a sell, %'),
        why: s('the reason given'), at: sn('UTC') }), 'at most 15, newest first'),
      paperLedger: objn({ trades: n(), averagePct: n('average result per trade, %'), winnersPct: n('share of winning trades, %') }, [], 'all paper trades'),
      realMirror: objn({ trades: n(), averagePct: n('average result per trade, %') }, [], 'trades the mirror repeated with real money'),
    }, ['note', 'status', 'lastRound', 'openPositions', 'latestSignals', 'paperLedger', 'realMirror']),
    exemple: { note: 'Paper trades of an autonomous colony: measurements, never advice. The mirror executes some of them with real money.', status: 'running', rounds: 14949,
      lastRound: '2026-09-26 18:42 UTC', paperTreasuryUsd: 3174.6, paperStartUsd: 1000,
      openPositions: [{ sym: 'TELEPAD', address: '0x7d1c0e6f0bb1a1b0c95f8c1e4b6f3a2d9e8c7b61', heldMinutes: 13, unrealisedPct: 25.7, stakeUsd: 94.97, capAtBuyUsd: 39078 }],
      latestSignals: [{ kind: 'sell', sym: 'NOIR', address: '0x5b3e9a4c2d1f0e8b7a6c5d4e3f2a1b0c9d8e7f6a', capUsd: 21400, resultPct: -22.2, why: 'Duration reached', at: '2026-09-26 18:40 UTC' },
        { kind: 'buy', sym: 'TELEPAD', address: '0x7d1c0e6f0bb1a1b0c95f8c1e4b6f3a2d9e8c7b61', capUsd: 40325, at: '2026-09-26 18:29 UTC' }],
      paperLedger: { trades: 285, averagePct: 1.9, winnersPct: 47 }, realMirror: { trades: 272, averagePct: -3.5 } },
  },
  swoge_economy: {
    schema: obj({
      economy: obj({ ok: b('false when the chain could not be read'), frais: b('true: read in the last 5 minutes'), lu: nn('when it was read, ms since epoch'),
        jeton: s('$SWOGE contract'), chaine: n('chain id (4663)'), adresseBrulage: s('burn address'), coffreAdresse: sn('casino vault address'),
        offre: nn('total supply'), brule: nn('burned'), brulePct: nn('burned, % of supply'), coffre: nn('casino vault balance'), coffrePct: nn('vault, % of supply'),
        stakingAprPct: n('staking APR, %'), stakingPlafond: nn('staking cap, $SWOGE') },
      ['ok', 'frais', 'lu', 'jeton', 'chaine', 'adresseBrulage', 'coffreAdresse', 'offre', 'brule', 'brulePct', 'coffre', 'coffrePct', 'stakingAprPct', 'stakingPlafond'], 'read on-chain'),
      swogePriceUsd: nn('$SWOGE price, USD'), source: s(),
    }, ['economy', 'swogePriceUsd', 'source']),
    exemple: { economy: { ok: true, frais: true, lu: 1790455966725, jeton: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', chaine: 4663, adresseBrulage: '0x000000000000000000000000000000000000dEaD',
      coffreAdresse: '0x5593c8141303D14999Df7aa03dd3d3a6d4335fAb', offre: 1000000000, brule: 13389118.44, brulePct: 1.34, coffre: 15155373.09, coffrePct: 1.52, stakingAprPct: 100, stakingPlafond: 200000000 },
    swogePriceUsd: 0.00002493, source: 'on-chain reads (chain 4663) and DexScreener' },
  },
  new_launches: {
    schema: obj({
      note: s('what these are, with the GoPlus attribution'),
      fresh: tab(obj({ sym: s(), address: s(), ageMinutes: nn('minutes since the pool opened'), poolUsd: nn('pool size, USD'), capUsd: nn('market cap, USD'),
        change5mPct: nn('5-minute move, %'), score: nn('colony score'), decision: s('"passed the colony\'s gates" or "not bought: <reason>"'), origin: sn('how the colony found it') }),
        'newest first, at most 30'),
      watched: tab(obj({ sym: s(), address: s(), timesSeen: n(), poolUsd: nn('pool size, USD'), verdict: s('what the colony decided') }), 'older tokens it keeps watching (15 at most)'),
      attribution: ATTR,
    }, ['note', 'fresh', 'watched', 'attribution']),
    exemple: { note: 'Live reads of the SWOGE AI colony on Robinhood Chain: measurements and decisions, never advice. Contract safety verdicts: Powered by Go+ Security (https://gopluslabs.io).',
      fresh: [{ sym: 'NEW', address: '0x9f2e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5', ageMinutes: 1, poolUsd: 8000, capUsd: 9000, change5mPct: 65, score: 48, decision: 'not bought: $8000 pool: below the buy floor ($13000)', origin: 'pools' }],
      watched: [{ sym: 'TALIS', address: '0x3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f', timesSeen: 29, poolUsd: 53366, verdict: 'too old (819 min): watched only, never bought' }],
      attribution: ATTR_EX },
  },
  wallet_intel: {
    schema: OSINT,
    exemple: { target: { type: 'address', value: '0x4b1c9e7d2a3f5e6d7c8b9a0f1e2d3c4b5a6f7e8d' }, passive: true,
      findings: [{ severity: 'HIGH', text: 'This address is a repeat launcher, and repeat launchers measure worse.' }],
      facts: [{ predicate: 'LAUNCHED TOKENS ON', value: 'pons × 4', sources: ['pons registry'] }], factCount: 1 },
  },
  osint_lookup: {
    schema: OSINT,
    exemple: { target: { type: 'domain', value: 'example.com' }, passive: true, findings: [],
      facts: [{ predicate: 'A', value: '93.184.215.14', sources: ['dns.google'] }, { predicate: 'CERTIFICATE ISSUER', value: 'DigiCert Global G3 TLS ECC SHA384 2020 CA1', sources: ['crt.sh'] }], factCount: 2 },
  },
  telegram_calls: {
    schema: obj({ calls: tab(obj({ channel: s(), token: s(), symbol: sn(), name: sn(), post: sn('link to the post'), chart: s(), postedAt: sn(), detectedAt: s(),
      fresh: b('detected soon enough after its post to count in a score'), tokenAgeMinAtCall: nn(), priceAtDetection: nn(), liquidityAtDetection: nn(), capAtDetection: nn(),
      changeSinceDetectionPct: nn(), bestSinceDetectionPct: nn(), lastPriceAt: s() })),
    channels: tab(obj({ channel: s(), calls: n(), freshMeasured: n(), medianChangePct: nn(), medianBestPct: nn(), upSharePct: nn(), verdict: sn('why there is no score yet') })),
    method: s('how the numbers are read') }, ['calls', 'channels', 'method']),
    exemple: { calls: [], channels: [{ channel: 'XandersOGCALLS', calls: 4, freshMeasured: 3, medianChangePct: null, medianBestPct: null, upSharePct: null, verdict: 'not enough fresh calls to judge (3 of 10)' }],
      method: 'Prices are read at detection, not at the exact second of the post. Robinhood Chain only; this is not advice.' },
  },
  web_search: {
    schema: obj({ results: tab(SOURCE, 'ranked results (the text answer carries dates and extracts)') }, ['results']),
    exemple: { results: [{ url: 'https://robinhood.com/us/en/newsroom/robinhood-chain/', titre: 'Robinhood Chain' }] },
  },
  ask_agent: {
    schema: obj({ answer: s('Markdown answer'), sources: tab(SOURCE), tokens: tab({ type: 'object', description: 'token cards read on the way (same shape as scan_token.token)' }), steps: n('model calls used') },
      ['answer', 'sources', 'tokens', 'steps']),
    exemple: { answer: 'LOBSTER has an $8.8k pool. The colony measured +16.9% on 2,395 tokens whose bytecode shows no mint function [1].', sources: [{ url: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR, titre: 'SWOGE Scan · $LOBSTER' }],
      tokens: [], steps: 3 },
  },
  generate_image: {
    schema: obj({ images: tab(s(), 'image URLs'), provider: { type: 'string', enum: ['grok', 'openai'] }, understoodAs: sn('the prompt as rewritten, when it was'),
      reference: sn('"swoge" when drawn from the official SWOGE character') }, ['images', 'provider', 'understoodAs', 'reference']),
    exemple: { images: ['https://web-production-220a3.up.railway.app/studio/media/fichier/3f9c2a7b1e4d8c6a0b5f9e2d7c1a4b8e3f6d0c9a2b5e8f1d.jpg'], provider: 'grok', understoodAs: null, reference: null },
  },
  generate_video: {
    schema: obj({ id: s('video id (24 hex characters)'), status: s('pending at first'), duration: n('seconds'), resolution: s(), poll: s('always "video_status"') }, ['id', 'status', 'poll']),
    exemple: { id: '66f5b1c2d3e4f5a6b7c8d9e0', status: 'pending', duration: 6, resolution: '480p', poll: 'video_status' },
  },
  video_status: {
    schema: obj({ id: s(), status: s('pending, done or failed'), progress: nn('0 to 100'), url: sn('when done'), duration: nn(), resolution: sn(),
      billedSwoge: sn('what was billed, $SWOGE'), billedUsd: nn('what was billed, USD'), reason: sn('why it failed') }, ['id', 'status']),
    exemple: { id: '66f5b1c2d3e4f5a6b7c8d9e0', status: 'done', progress: 100, url: 'https://web-production-220a3.up.railway.app/studio/media/fichier/9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f.mp4',
      duration: 6, resolution: '480p', billedSwoge: '9621.43', billedUsd: 0.24, reason: null },
  },
};

/* L'enveloppe de toute réponse 200 : le résultat de l'outil, son texte, et selon
   le chemin la facture par clé ou le reçu x402 ; ou, avec "quote": true, le devis. */
function enveloppe(nom) {
  const S = SORTIES[nom];
  return obj({
    ok: { type: 'boolean', const: true },
    outil: { type: 'string', const: nom },
    resultat: S ? S.schema : { description: 'the tool result' },
    texte: s('the same result as plain text, written for a language model'),
    facture: obj({ swoge: s('$SWOGE billed, exact decimal string'), usd: n('USD billed'), maxSwoge: s('video: most it can bill'), maxUsd: n(), aLArrivee: b('video: billed when it arrives') }, ['swoge', 'usd'], 'with an API key: what was billed'),
    solde: s('with an API key: the $SWOGE balance left'),
    recu: s('with an API key: the receipt id'),
    /* Deux formes sous la meme cle (agentic.js) : le reglement d'un appel paye sans
       cle, ou, dans un devis sans cle, les exigences x402 de cet appel. */
    x402: { anyOf: [
      obj({ transaction: s('settlement transaction hash'), network: s('eip155:4663'), amount: s('atomic units paid'), asset: s('token paid (USDG or $SWOGE)') },
        ['transaction', 'network', 'amount', 'asset'], 'paid without a key: the x402 settlement (also in the PAYMENT-RESPONSE header)'),
      obj({ x402Version: { type: 'integer' }, resource: { type: 'object' }, accepts: tab({ type: 'object' }), extensions: { type: 'object' } }, ['accepts'],
        'in a quote without a key: the x402 requirements of this exact call, payable as they are'),
    ] },
    devis: { type: 'object', description: 'with "quote": true: the price of this call — nothing run, nothing charged' },
    quote: { type: 'boolean', const: true, description: 'set on a quote' },
    tool: s('on a quote: the tool'),
    priceUsd: n('on a quote: the price (the maximum for a real-cost tool)'),
    howToPay: s('on a quote: how to pay for this tool, with or without a key'),
  }, ['ok', 'outil']);
}

/* Un exemple de réponse : x402 pour un outil payable sans clé, facture par clé sinon. */
function exemple200(nom, payable, c) {
  const S = SORTIES[nom] || {};
  const e = { ok: true, outil: nom, resultat: S.exemple === undefined ? null : S.exemple, texte: S.texte || JSON.stringify(S.exemple || {}).slice(0, 160) };
  if (payable) {
    const a = ((c.x402 && c.x402.assets) || []).find((x) => x.symbol === 'USDG');
    e.x402 = { transaction: '0x8c1f3e2d4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', network: (c.x402 && c.x402.network) || 'eip155:4663',
      amount: String(Math.round(payable.min * 1e6)), asset: a ? a.asset : '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' };
  } else {
    e.facture = { swoge: '51606.49', usd: 1.2888 };
    e.solde = '248393.51';
    e.recu = '9f3c2a7b1e4d8c6a';
  }
  return e;
}

/* ---- LE 402 ----
 * Sans clé, outil payable : le PaymentRequired x402 v2 (x402.exige), aussi en
 * base64 dans l'en-tête PAYMENT-REQUIRED. Avec une clé : solde ou plafond du
 * jour trop bas. */
const DEFI_X402 = obj({
  ok: { type: 'boolean', const: false },
  x402Version: { type: 'integer', const: 2 }, error: s(),
  resource: obj({ url: s(), description: s('price in dollars, what it covers'), mimeType: s() }, ['url']),
  accepts: tab(obj({ scheme: { type: 'string', const: 'exact' }, network: s('eip155:4663'), amount: s('atomic units of the asset (USDG: 6 decimals, $SWOGE: 18)'), asset: s(), payTo: s(),
    maxTimeoutSeconds: n(), extra: obj({ assetTransferMethod: { type: 'string', enum: ['eip3009', 'permit2'] }, name: s('EIP-712 domain name'), version: s('EIP-712 domain version') }, ['assetTransferMethod']) },
  ['scheme', 'network', 'amount', 'asset', 'payTo']), 'USDG (EIP-3009) first, then $SWOGE (Permit2)'),
  extensions: { type: 'object', description: 'eip2612GasSponsoring: the server takes an EIP-2612 permit to Permit2 and pays the gas. bazaar: the input and output schemas of this tool, with a fixed example request (x402 bazaar extension)' },
  raison: s('why a payment was refused'), detail: sn(),
}, ['x402Version', 'accepts']);
const REFUS_CLE = obj({ ok: { type: 'boolean', const: false }, raison: s('what to do'), requisSwoge: s('$SWOGE needed') }, ['ok', 'raison']);

function exemple402(nom, p, c) {
  const x = c.x402 || {};
  const usdg = (x.assets || []).find((a) => a.symbol === 'USDG');
  const swoge = (x.assets || []).find((a) => a.symbol === 'SWOGE');
  const accepts = [];
  if (usdg) accepts.push({ scheme: 'exact', network: x.network, amount: String(Math.round(p.min * 1e6)), asset: usdg.asset, payTo: x.payTo, maxTimeoutSeconds: 120,
    extra: { assetTransferMethod: 'eip3009', name: usdg.name || 'Global Dollar', version: usdg.version || '1' } });
  if (swoge && c.cours > 0) accepts.push({ scheme: 'exact', network: x.network, amount: ethers.utils.parseUnits((p.min / c.cours).toFixed(18), 18).toString(), asset: swoge.asset, payTo: x.payTo,
    maxTimeoutSeconds: 120, extra: { assetTransferMethod: 'permit2', name: swoge.name || 'Swole Doge', version: swoge.version || '1' } });
  return { ok: false, x402Version: 2, error: 'PAYMENT-SIGNATURE header is required',
    resource: { url: c.base + '/agentic/call/' + nom, description: 'SwogeAgentic tool ' + nom + ' — $' + Number(p.min.toFixed(6)) + ' in ' + [usdg ? 'USDG' : null, accepts.length > 1 ? '$SWOGE' : null].filter(Boolean).join(' or ')
      + ' (tool price + settlement gas, minimum $' + (x.minimumUsd || 0.02) + ')', mimeType: 'application/json' },
    accepts, extensions: { eip2612GasSponsoring: { info: { description: 'The server accepts an EIP-2612 permit to the canonical Permit2 contract (value = the exact payment amount) and pays the gas.', version: '1' } } } };
}

/* ---- LES PRIX ANNONCÉS (audit du 26 septembre 2026) ----
 * Avant : un intervalle de « sans gaz » à « dix fois le gaz du moment » pour
 * tenir la promesse si le gaz montait — 0,157 $ affichés pour une lecture à
 * 0,01 $, ce qui fait fuir un agent qui trie par prix, et x402 n'a jamais
 * besoin de cette marge : le 402 cote le montant EXACT au moment de l'appel.
 * Désormais le prix x402 réel du moment (x402.prix : prix de l'outil + gaz
 * mesuré, au moins 0,02 $), FIXE — il ne varie qu'avec le gaz, que le 402
 * relit ; un intervalle seulement pour generate_image, dont le prix dépend
 * VRAIMENT de la demande (fournisseur, qualité, nombre, image de référence).
 * Relevé en direct le même jour (/agentic/x402) : scan_token 0,024291 $, gaz
 * 0,014291 $. `prix(nom, args)` = x402.prix ; sans prix (cours de l'ETH
 * inconnu), le plancher : max(minimum, prix de l'outil). */
const OPTIONS_IMAGE = (() => {
  const l = [];
  for (const provider of ['grok', 'openai']) for (const quality of ['speed', 'quality']) for (const count of [1, 2, 4]) for (const prompt of ['a cat', 'swoge'])
    l.push({ prompt, provider, quality, count });
  return l;
})();
async function prixX402Annonces({ noms, prix, base, minUsd }) {
  const out = {};
  const plancher = (x) => Math.max(minUsd || 0.02, x || 0);
  for (const nom of noms || []) {
    if (nom === 'generate_image') {
      const cotes = OPTIONS_IMAGE.map((a) => ({ a, u: base(nom, a) })).filter((x) => x.u > 0).sort((x, y) => x.u - y.u);
      if (!cotes.length) continue;
      const [bas, haut] = await Promise.all([prix(nom, cotes[0].a), prix(nom, cotes[cotes.length - 1].a)].map((p) => Promise.resolve(p).catch(() => null)));
      out[nom] = { min: bas ? bas.usd : plancher(cotes[0].u), max: haut ? haut.usd : plancher(cotes[cotes.length - 1].u),
        options: { min: cotes[0].a, max: cotes[cotes.length - 1].a } };
      continue;
    }
    const p = await Promise.resolve().then(() => prix(nom)).catch(() => null);
    const u = p ? p.usd : plancher(base(nom));
    if (u > 0) out[nom] = { min: u, max: u };
  }
  return out;
}

/* Le prix dit en toutes lettres dans la description de l'opération : par clé ET sans clé. */
function phrasePrix(o, p, c) {
  const pr = o.prix || {};
  const cle = pr.gratuit ? 'Free with an API key (it reads your own video).'
    : pr.variable ? 'With an API key: its real cost, up to $' + pr.maxUsd + ' ("quote": true gives the maximum for your arguments), billed in $SWOGE at the live price.'
      : pr.usd ? 'With an API key: $' + pr.usd + ' per call, billed in $SWOGE at the live price.' : '';
  if (!p) return cle + (!c.x402 ? '' : pr.gratuit ? ' API key only (it reads the video of that key).' : pr.variable ? ' API key only (its price is not known before it runs).' : '');
  const en = ((c.x402 && c.x402.assets) || []).map((a) => (a.symbol === 'SWOGE' ? '$SWOGE' : a.symbol)).join(' or ') || '$SWOGE';
  const x = p.min === p.max ? '$' + Number(p.min.toFixed(6)) + ' now' : 'from $' + Number(p.min.toFixed(6)) + ' to $' + Number(p.max.toFixed(6)) + ' now, by request (provider, quality, count)';
  return (cle ? cle + ' ' : '') + 'Without a key (x402): ' + x + ', in ' + en + ' on Robinhood Chain (tool price + settlement gas, minimum $' + ((c.x402 && c.x402.minimumUsd) || 0.02)
    + '); the 402 quotes the exact amount for your arguments.';
}

/**
 * L'OpenAPI 3.1. `c` = { base, outils (catalogue : définitions, et `prix` quand il vient d'agentic.catalogue),
 *   x402 (état public ou null), prixX402 : { nom → { min, max } } (outils payables d'avance), preuves, docs,
 *   page, icone, email, cours ($ par $SWOGE, pour l'exemple du 402) }.
 */
function openapi(c) {
  const paths = {};
  const payable = c.prixX402 || {};
  for (const o of c.outils) {
    const p = payable[o.name];
    const desc = String(o.description || '');
    const op = {
      operationId: o.name,
      summary: desc.split('. ')[0].replace(/\.$/, ''),
      description: desc + (desc && !/\.$/.test(desc) ? '.' : '') + ' ' + phrasePrix(o, p, c),
      tags: ETIQUETTES_OUTIL[o.name] || ['crypto'],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        properties: { arguments: Object.assign({ type: 'object' }, o.inputSchema || {}), quote: { type: 'boolean', description: 'true: return the price of this call without running or charging it' } },
        required: ['arguments'] } } } },
      responses: {
        200: { description: 'The tool result: `resultat` (data), `texte` (the same, as text for a model) and the receipt — `facture`, `solde`, `recu` with an API key, `x402` without one',
          content: { 'application/json': { schema: enveloppe(o.name), example: exemple200(o.name, p, c) } } },
        400: { description: 'Invalid arguments — nothing is charged' },
        401: { description: p ? 'An API key was sent but is unknown or revoked' : 'No API key (the answer says how to get one) or an unknown or revoked key' },
        402: p
          ? { description: 'Payment Required — without a key, the x402 v2 challenge for this exact request (also base64 in the PAYMENT-REQUIRED header); with an API key, the balance or the daily cap is too low',
            headers: { 'PAYMENT-REQUIRED': { description: 'base64 JSON of the x402 v2 PaymentRequired object', schema: { type: 'string' } } },
            content: { 'application/json': { schema: { anyOf: [{ $ref: '#/components/schemas/PaymentRequired' }, { $ref: '#/components/schemas/KeyRefusal' }] }, example: exemple402(o.name, p, c) } } }
          : { description: 'The balance or the key\'s daily cap is too low', content: { 'application/json': { schema: { $ref: '#/components/schemas/KeyRefusal' },
            example: { ok: false, raison: 'this key\'s daily cap does not leave room for this task (up to 51606.49 $SWOGE)' } } } },
        429: { description: 'Too many calls (60 per minute per key) or too many free quotes' },
        502: { description: 'The tool or its provider failed — nothing is charged' },
        503: { description: 'Unavailable right now (price or provider) — nothing is charged' },
      },
      security: p ? [{ cleApi: [] }, {}] : [{ cleApi: [] }, { cleEnTete: [] }],
    };
    if (p) {
      op['x-payment-info'] = { protocols: [{ x402: {} }],
        price: p.min === p.max ? { mode: 'fixed', currency: 'USD', amount: usd6(p.min) } : { mode: 'dynamic', currency: 'USD', min: usd6(p.min), max: usd6(p.max) } };
    }
    paths['/agentic/call/' + o.name] = { post: op };
  }
  paths['/agentic/tools'] = { get: { operationId: 'listTools', summary: 'The live tool catalogue: names, input schemas, prices', tags: ['catalogue'],
    responses: { 200: { description: 'The catalogue', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' }, monnaie: s('"$SWOGE"'), coursUsd: nn('$SWOGE price, USD'),
      outils: tab(obj({ name: s(), description: s(), inputSchema: { type: 'object' }, prix: { type: 'object', description: '{usd, swoge}, {variable, maxUsd, maxSwoge, note} or {gratuit: true}' } }, ['name', 'description', 'inputSchema'])),
      x402: { type: 'object', description: 'public x402 state (actif false when off)' } }, ['ok', 'outils']) } } } }, security: [] } };
  if (c.x402) paths['/agentic/x402'] = { get: { operationId: 'x402Status', summary: 'x402 status: networks, assets, prices now, what was collected', tags: ['catalogue'],
    responses: { 200: { description: 'Public status (never a key)', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' }, actif: { type: 'boolean' }, network: s(), payTo: s(),
      assets: tab({ type: 'object' }), outils: tab({ type: 'object', description: '{name, usd, gazUsd, amount, amountUsdg}' }) }, ['ok', 'actif']) } } } }, security: [] } };
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'SwogeAgentic',
      version: '1.1.0',
      summary: RESUME,
      description: DESCRIPTION,
      'x-guidance': 'POST /agentic/call/<tool> with a JSON body {"arguments": {...}}; GET /agentic/tools lists tools, input schemas and prices. Add "quote": true to get the price without running anything. '
        + 'With an API key (Authorization: Bearer swg_… or X-API-Key, created at ' + (c.page || 'the SwogeAgentic page') + ') the call is billed from the key owner\'s $SWOGE balance, within the daily cap they set. '
        + (c.x402 ? 'Without a key, tools marked x-payment-info answer 402 with a PAYMENT-REQUIRED header (x402 v2, scheme exact, ' + c.x402.network + ', ' + (c.x402.assets || []).map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ') + '): sign and retry with PAYMENT-SIGNATURE and the SAME arguments; the server pays the gas. ' : '')
        + 'Every number from the SWOGE AI colony comes with its observation count: quote it. Results are measurements, never buy or sell signals. MCP (Streamable HTTP, same key): /mcp.',
      contact: Object.assign({ name: 'SWOGE WORLD', url: c.page || 'https://swoleeswoge.dog/swogeagentic.html' }, c.email ? { email: c.email } : {}),
      'x-logo': { url: c.icone || ICONE, altText: 'SWOGE' },
    },
    servers: [{ url: c.base }],
    tags: ETIQUETTES,
    paths,
    components: { schemas: { PaymentRequired: DEFI_X402, KeyRefusal: REFUS_CLE }, securitySchemes: {
      cleApi: { type: 'http', scheme: 'bearer', description: 'SwogeAgentic API key (swg_…), as Authorization: Bearer' },
      cleEnTete: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'The same SwogeAgentic API key (swg_…), in X-API-Key' },
    } },
    'x-agentcash-guidance': { llmsTxtUrl: c.base + '/llms.txt' },
  };
  if (c.docs) doc.externalDocs = { url: c.docs };
  if (c.preuves && c.preuves.length) {
    doc['x-discovery'] = { ownershipProofs: c.preuves };
    doc['x-agentcash-provenance'] = { ownershipProofs: c.preuves };
  }
  return doc;
}

/**
 * Le manifeste `/.well-known/x402` (forme lue par x402scan : version, resources,
 * ownershipProofs, instructions). `name`, `description` et `docs` y étaient
 * déjà ; lus par personne, ignorés sans dommage.
 */
function manifeste(c) {
  const m = { version: 1, x402Version: 2, name: 'SwogeAgentic', description: RESUME,
    resources: Object.keys(c.prixX402 || {}).map((n) => c.base + '/agentic/call/' + n),
    instructions: DESCRIPTION + ' How to pay: POST the resource with {"arguments": {...}} and no key; the 402 PAYMENT-REQUIRED header (x402 v2, scheme exact'
      + (c.x402 ? ', ' + c.x402.network + ', ' + (c.x402.assets || []).map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ') : '')
      + ') quotes that exact request; sign it and retry with PAYMENT-SIGNATURE and the same arguments. We pay the gas. '
      + 'Input and output schemas, prices and tags: ' + c.base + '/openapi.json. Guidance for agents: ' + c.base + '/llms.txt.' };
  if (c.preuves && c.preuves.length) m.ownershipProofs = c.preuves;
  if (c.docs) m.docs = c.docs;
  return m;
}

/**
 * L'extension `bazaar` d'un 402 (spécification x402 « Extension: bazaar »,
 * relue le 26 septembre 2026) : `info` (un exemple d'entrée et de sortie) et
 * `schema` (qui valide `info`), où @agentcash/discovery lit le schéma d'entrée
 * (`schema.properties.input.properties.body`) et de sortie
 * (`schema.properties.output.properties.example`). C'est l'autre moitié des 16
 * erreurs de l'audit (« extensions.bazaar… missing ») : elle se pose dans le
 * 402 (x402.js, `deps.bazaar`, branché dans server.js).
 *
 * L'exemple d'entrée (`info.input.body`) est FIXE, un par outil
 * (EXEMPLES_ENTREE), jamais les arguments de la requête : (1) la spécification
 * dit « Facilitators must validate info against schema before cataloging », et
 * un annuaire sonde SANS arguments — avec `{}`, 9 outils sur 12 échouaient
 * leur propre schéma (scan_token sur `address`, generate_image sur `prompt`…),
 * vérifié à ajv 2020-12 le 26 septembre 2026 ; (2) le 402 d'un vrai appel
 * porterait sinon l'adresse, la cible OSINT, la recherche ou le prompt de
 * l'acheteur, qu'un facilitateur peut publier dans un catalogue public.
 */
/* Un exemple VALIDE par outil (les ARGS de decouverte.test.js) : chacun passe
   son schéma d'entrée ET agentic.entreeInvalide — l'essai le vérifie. */
const EXEMPLES_ENTREE = {
  scan_token: { address: ADR }, colony_activity: {}, swoge_economy: {}, new_launches: { limit: 5 },
  wallet_intel: { address: ADR }, osint_lookup: { target: 'example.com' }, telegram_calls: { hours: 24, limit: 20 },
  web_search: { query: 'robinhood chain' }, generate_image: { prompt: 'a swole doge', count: 1 },
  ask_agent: { task: 'is LOBSTER worth a look?' }, generate_video: { prompt: 'a swole doge lifting' }, video_status: { id: '66f5b1c2d3e4f5a6b7c8d9e0' },
};
/* Sans les `description` : l'extension voyage en base64 dans l'en-tete
   PAYMENT-REQUIRED. Mesure du 26 septembre 2026 : avec descriptions et exemple,
   11 576 caracteres pour scan_token — au-dela des 8 Ko d'en-tete que bien des
   mandataires acceptent (et des 16 Ko d'undici, en-tetes cumules) ; sans, 4 228
   (1 756 a 4 228 selon l'outil). Les descriptions et l'exemple restent dans
   /openapi.json ; ici, la forme seule. */
const sec = (x) => (Array.isArray(x) ? x.map(sec) : x && typeof x === 'object'
  ? Object.keys(x).filter((k) => k !== 'description').reduce((o, k) => { o[k] = sec(x[k]); return o; }, {}) : x);
function bazaar(nom, def) {
  const corps = { type: 'object', properties: { arguments: Object.assign({ type: 'object' }, sec((def && def.inputSchema) || {})) }, required: ['arguments'] };
  const env = enveloppe(nom);
  /* La sortie d'un appel paye sans cle : le resultat, son texte, le reglement x402. */
  const sortie = { type: 'object', required: ['ok', 'outil'], properties: { ok: env.properties.ok, outil: env.properties.outil, resultat: sec(env.properties.resultat),
    texte: { type: 'string' }, x402: sec(env.properties.x402.anyOf[0]) } };
  return {
    info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: { arguments: Object.assign({}, EXEMPLES_ENTREE[nom] || {}) } }, output: { type: 'json' } },
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: {
        input: { type: 'object', properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST'] }, bodyType: { type: 'string', enum: ['json'] },
          body: corps }, required: ['type', 'method', 'bodyType', 'body'], additionalProperties: false },
        output: { type: 'object', properties: { type: { type: 'string' }, example: sortie }, required: ['type'] },
      }, required: ['input'] },
  };
}

/**
 * La fiche du registre MCP officiel (server.json, schéma 2025-12-11 relu le 26 septembre 2026).
 * 1.0.1 (26 septembre 2026, le soir) : tools/list et les devis ({"quote": true})
 * marchent sans clé (agentic.js) — l'en-tête n'est donc plus « requis ». Le
 * server.json du dépôt (posé par l'autre moitié du lot) est la sortie de cette
 * fonction, mot pour mot : decouverte.test.js le vérifie.
 */
function ficheMcp({ nom, base, version }) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: nom,
    title: 'SwogeAgentic',
    /* ≤ 100 caractères (schéma server.json 2025-12-11, relu le 26 septembre 2026). */
    description: 'Crypto intel for AI agents: token scans, SWOGE AI colony data, OSINT, web search, images, video',
    version: version || '1.0.1',
    remotes: [{ type: 'streamable-http', url: base + '/mcp',
      headers: [{ name: 'Authorization', description: 'Bearer swg_… — an API key from swoleeswoge.dog/swogeagentic.html (a daily cap bounds what it can spend). '
        + 'Optional: tools/list and free price quotes ({"quote": true}) work without a key; running a tool needs one, or x402 over REST', isRequired: false, isSecret: true }] }],
  };
}

module.exports = { origine, preuvesValides, openapi, manifeste, ficheMcp, usd6, prixX402Annonces, bazaar, EXEMPLES_ENTREE, enveloppe, SORTIES, ETIQUETTES, ETIQUETTES_OUTIL,
  DEFI_X402, REFUS_CLE, OPTIONS_IMAGE, RESUME, DESCRIPTION, ICONE };
