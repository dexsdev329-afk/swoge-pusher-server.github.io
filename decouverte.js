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
  { name: 'ai-models', description: 'Frontier AI models (Claude, GPT-6, Grok) paid per call, OpenAI format' },
  { name: 'osint', description: 'Passive reconnaissance on infrastructure and deployer wallets' },
  { name: 'images', description: 'Image generation (Grok Imagine, ChatGPT Image)' },
  { name: 'base', description: 'Base (eip155:8453) memecoin launches (Clanker, Zora) read on-chain, with deployer records' },
  { name: 'randomness', description: 'Provably fair draws: commit, draw, verify (HMAC-SHA256, no bias)' },
  { name: 'video', description: 'Short video generation (Grok Imagine)' },
  { name: 'esim', description: 'Travel data eSIM: free search, bought per purchase in USDC with x402, no account' },
  { name: 'payments', description: 'Pay other x402 services with your API key, within the owner\'s limits, with a hash-chained audit' },
  { name: 'catalogue', description: 'The live tool list, prices and x402 status' },
];
const ETIQUETTES_OUTIL = {
  scan_token: ['token-security', 'crypto', 'robinhood-chain'], colony_activity: ['robinhood-chain', 'crypto'], swoge_economy: ['crypto', 'robinhood-chain'],
  new_launches: ['robinhood-chain', 'crypto', 'token-security'], wallet_intel: ['osint', 'crypto', 'robinhood-chain'], osint_lookup: ['osint', 'research'],
  can_i_sell: ['token-security', 'crypto', 'robinhood-chain'], token_verdict: ['token-security', 'crypto', 'robinhood-chain'],
  roast_token: ['crypto', 'images', 'token-security'],
  fair_commit: ['randomness'], fair_draw: ['randomness'], fair_verify: ['randomness'],
  base_launches: ['base', 'crypto', 'token-security'], base_deployer: ['base', 'crypto', 'osint'],
  stock_token_check: ['robinhood-chain', 'token-security', 'crypto'], stock_tokens_premium: ['robinhood-chain', 'crypto'],
  chat_completion: ['ai-models', 'research'],
  robinhood_rpc: ['robinhood-chain', 'crypto'], robinhood_token: ['robinhood-chain', 'crypto', 'token-security'], robinhood_wallet: ['robinhood-chain', 'crypto'], robinhood_tx: ['robinhood-chain', 'crypto'],
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


/* ---- Les actions tokenisees : les formes partagees (actions_rh.js, 28/09/2026) ---- */
const ORACLE_ACTION = objn({ feed: s('Chainlink feed address on Robinhood Chain: read its value there'), updatedAt: s('ISO date of its last update'), stale: b('older than its heartbeat') },
  ['feed', 'updatedAt', 'stale'], 'the Chainlink feed of the token; its value is not republished');
const OFFICIELLE_ACTION = objn({ address: s(), symbol: s(), name: s(), isin: sn(), status: sn(), multiplier: sn('shares per token (corporate actions)'), pendingMultiplier: sn('the next multiplier, when announced'),
  corporateActionPending: b(), sessions: tab(s(), 'sessions where the stock trades: market, extended, overnight') },
  ['address', 'symbol', 'name', 'isin', 'status', 'multiplier', 'pendingMultiplier', 'corporateActionPending', 'sessions'], 'the official Robinhood Stock Token (api.robinhood.com/rhj/assets)');
const EX_OFFICIELLE_NVDA = { address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', symbol: 'NVDA', name: 'NVIDIA \u2022 Robinhood Token', isin: 'US67066G1040', status: 'ASSET_STATUS_ACTIVE',
  multiplier: '1.000775159164630595', pendingMultiplier: null, corporateActionPending: false, sessions: ['market', 'extended', 'overnight'] };
const EX_ORACLE_NVDA = { feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', updatedAt: '2026-09-28T17:07:42.000Z', stale: false };

/* ---- Les lancements de Base : les formes partagees par base_launches et base_deployer ---- */
const BILAN_BASE = (avecAvis) => obj(Object.assign({ tokens: n('launches in the window'), judged: n('launches 24 hours old or more'),
  tradedWithin24hPct: nn('share of judged launches swapped at least once after their launch block, within 24 hours'), ci95: { type: ['array', 'null'], items: n(), description: '95% Wilson interval of that share' },
  medianSwaps24h: nn(), medianPriceChangePct: nn('first swap to last swap within 24 hours') },
  avecAvis ? { enough: b('at least 5 judged launches: comparable to the reference'), note: sn('why it is not compared') } : {}),
  ['tokens', 'judged', 'tradedWithin24hPct', 'ci95', 'medianSwaps24h', 'medianPriceChangePct'].concat(avecAvis ? ['enough', 'note'] : []));
const LANCEMENT_BASE = (avecDeployeur) => obj(Object.assign({ token: s(), symbol: s('set by the deployer: untrusted text'), name: s('set by the deployer: untrusted text'),
  platform: { type: 'string', enum: ['clanker', 'zora', 'zora-creator'] }, deployer: s('Clanker tokenAdmin or Zora caller'), sender: sn('Clanker msgSender or Zora payoutRecipient, when different'),
  pairedWith: s('the other currency of the pool'), pool: s('Uniswap v4 pool id'), block: n(), tx: s(), launchedAt: s('ISO date'), ageMinutes: n(),
  swapsFirstHour: n('swaps after the launch block, first hour'), swaps24h: n('swaps after the launch block, first 24 hours'), judged: b('24 hours old or more'),
  priceChangePct: nn('first swap to last swap; null under 2 swaps') }, avecDeployeur ? { deployerRecord: BILAN_BASE(true) } : {}),
  ['token', 'symbol', 'name', 'platform', 'deployer', 'pool', 'block', 'launchedAt', 'ageMinutes', 'swapsFirstHour', 'swaps24h', 'judged', 'priceChangePct'].concat(avecDeployeur ? ['deployerRecord'] : []));
const FENETRE_BASE = obj({ indexedSince: sn('ISO date: nothing before is known'), lastBlock: nn(), launchesInWindow: n(), note: s() }, ['indexedSince', 'lastBlock', 'launchesInWindow', 'note']);
const EX_REF_BASE = { tokens: 71, judged: 0, tradedWithin24hPct: null, ci95: null, medianSwaps24h: null, medianPriceChangePct: null };
const EX_LANCEMENT_BASE = (avecDeployeur) => Object.assign({ token: '0x02e7f36b3f679df4e597d854b76335cd2269f96c', symbol: 'XDP', name: 'XDP', platform: 'zora',
  deployer: '0xe3e4c41a7eed7be0b485de9a6025c2983ac01daf', sender: null, pairedWith: '0xafcaa25e08f68cb54fa196f72a67ee2c00722239',
  pool: '0x4c981db46ee49df4bcd77074b9388150d1d6b2dca6c4fabf1eaf976e1c185c41', block: 51914071, tx: '0x06d79454ad77e5decf02eb6941643b89620b523c6bf494044f8c45108c8b30ab',
  launchedAt: '2026-09-28T17:44:49.000Z', ageMinutes: 19, swapsFirstHour: 2, swaps24h: 2, judged: false, priceChangePct: 3.2 },
  avecDeployeur ? { deployerRecord: Object.assign({}, EX_REF_BASE, { tokens: 2, enough: false, note: 'not enough judged tokens to compare (0/5)' }) } : {});
const EX_FENETRE_BASE = { indexedSince: '2026-09-28T17:03:31.000Z', lastBlock: 51914632, launchesInWindow: 71,
  note: 'Clanker v4 and Zora (coins and creator coins) on Base only, read on-chain by SWOGE. Swaps are counted after the launch block, for 24 hours. Names and symbols are set by deployers: untrusted text.' };

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
  /* can_i_sell (27 septembre 2026) : epreuve_sortie.js, lu dans son code. Les
     champs d'un aller-retour non chiffre (`reason`) et chiffre (`returnPct`…)
     sont tous declares, un seul jeu est rendu a la fois. */
  can_i_sell: {
    schema: obj({
      token: obj({ address: s('token contract, lower case'), symbol: sn('symbol from DexScreener'), chain: s('always robinhood'), pool: sn('the pool tested (address, or a Uniswap v4 id)'),
        ageMinutes: nn('pool age, minutes'), liquidityUsd: nn('pool liquidity, USD'), marketCapUsd: nn('market cap, USD') },
        ['address', 'symbol', 'chain', 'pool', 'ageMinutes', 'liquidityUsd', 'marketCapUsd']),
      verdict: { type: 'string', enum: ['sellable', 'costly', 'blocked', 'partial'], description: 'sellable, costly (round trip above the SWOGE colony ceiling), blocked, or partial (transfer tested, no round-trip quote)' },
      why: s('the reason for the verdict, in one sentence'),
      transfer: obj({ tested: b('whether holders could be simulated'), tries: n('holders tried'), refused: n('holders refused'),
        target: sn('where the token was sent: pool, market maker or largest holder'), reason: sn('why it was not tested') }, ['tested', 'tries', 'refused', 'target', 'reason']),
      roundTrip: obj({ quoted: b('whether a buy-then-sell was quoted'), returnPct: n('share of the stake a round trip returns, %'), costPct: n('fees and depth, %'),
        minReturnPct: n('below this return, the exit counts as blocked'), probeEth: nn('order size quoted, ETH'), uniswap: sn('Uniswap version quoted'),
        maxCostPct: n('the round-trip cost the SWOGE colony itself accepts, %'), reason: s('why no quote') }, ['quoted']),
      liquidity: obj({ lpTokenRead: b('whether the pool has a readable LP token'), burnedPct: n('share of LP tokens burned, %'), reason: sn('why it was not read') }, ['lpTokenRead']),
      checkedAt: s('when, ISO 8601 UTC'), limits: s('what a simulation cannot see'),
    }, ['token', 'verdict', 'why', 'transfer', 'roundTrip', 'liquidity', 'checkedAt', 'limits']),
    exemple: { token: { address: ADR, symbol: 'LOBSTER', chain: 'robinhood', pool: '0x2dc0fb72d9284228046cc95910eeaabebfe48456', ageMinutes: 42.3, liquidityUsd: 21000, marketCapUsd: 64000 },
      verdict: 'sellable', why: 'a round trip returns 97.2% of the stake (2.8% in fees and depth), and holders can send it to the pool',
      transfer: { tested: true, tries: 3, refused: 0, target: 'pool', reason: null },
      roundTrip: { quoted: true, returnPct: 97.2, costPct: 2.8, minReturnPct: 60, probeEth: 0.01, uniswap: 'v2', maxCostPct: 4 },
      liquidity: { lpTokenRead: true, burnedPct: 100 }, checkedAt: '2026-09-27T12:00:00.000Z',
      limits: 'A read-only simulation of what the pool would return NOW for a small order. It cannot see a blacklist that closes after you buy, liquidity pulled later, or a tax changed later. Measurements, never a buy or sell signal.' },
    texte: 'Exit test for $LOBSTER ' + ADR + ' on Robinhood Chain: SELLABLE — a round trip returns 97.2% of the stake (2.8% in fees and depth)…',
  },
  /* chat_completion (27 septembre 2026) : chat_x402.js, lu dans son code — le format chat.completion d'OpenAI. */
  chat_completion: {
    schema: obj({ id: s('chatcmpl-…'), object: s('always chat.completion'), created: n('Unix time'), model: s('the model id asked'), served: s('the provider model that answered'),
      choices: tab(obj({ index: n(), message: obj({ role: s('always assistant'), content: s('the answer') }, ['role', 'content']),
        finish_reason: { type: 'string', enum: ['stop', 'length'], description: 'length: max_tokens reached' } }, ['index', 'message', 'finish_reason'])),
      usage: obj({ prompt_tokens: n(), completion_tokens: n('reasoning included'), total_tokens: n() }, ['prompt_tokens', 'completion_tokens', 'total_tokens']) },
      ['id', 'object', 'created', 'model', 'served', 'choices', 'usage']),
    exemple: { id: 'chatcmpl-5b1f0c9e2a7d4e8f9a1b2c3d', object: 'chat.completion', created: 1790550000, model: 'haiku-4-5', served: 'claude-haiku-4-5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there, nice to meet!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 16, completion_tokens: 9, total_tokens: 25 } },
    texte: 'Hello there, nice to meet!',
  },
  /* Les lectures Robinhood Chain (27 septembre 2026) : lectures_rh.js, lu dans son code. */
  robinhood_rpc: {
    schema: obj({ chain: s('always robinhood'), chainId: n('always 4663'), method: s('the JSON-RPC method called'),
      result: { description: 'the node answer, as is (hex string, object, array or null)' }, truncated: b('eth_getLogs: cut at 500 logs') }, ['chain', 'chainId', 'method', 'result', 'truncated']),
    exemple: { chain: 'robinhood', chainId: 4663, method: 'eth_blockNumber', result: '0x46d2468', truncated: false },
    texte: '{"chain":"robinhood","chainId":4663,"method":"eth_blockNumber","result":"0x46d2468","truncated":false}',
  },
  robinhood_token: {
    schema: obj({ chain: s('always robinhood'), address: s('lower case'), isContract: b('false for a wallet'), note: s('only when there is no code'), codeBytes: n('size of the deployed code'),
      erc20: objn({ name: sn(), symbol: sn(), decimals: nn(), totalSupply: sn('raw units, as a decimal string'), totalSupplyUnits: nn('supply in token units') }, ['name', 'symbol', 'decimals', 'totalSupply', 'totalSupplyUnits'], 'null when not an ERC-20'),
      owner: sn('owner() address, "renounced (zero address)", or null without owner()'),
      proxy: objn({ standard: s('EIP-1967'), implementation: s(), admin: sn() }, ['standard', 'implementation', 'admin'], 'null when not an EIP-1967 proxy'),
      powers: obj({ readFrom: { type: 'string', enum: ['contract', 'implementation'] }, mint: b(), blacklist: b(), pause: b(), feeSetter: b(), note: s() }, ['readFrom', 'mint', 'blacklist', 'pause', 'feeSetter', 'note']),
      market: objn({ priceUsd: nn(), liquidityUsd: nn(), pool: sn(), url: sn(), marketCapUsd: nn('price x supply') }, ['priceUsd', 'liquidityUsd', 'pool', 'url', 'marketCapUsd'], 'DexScreener, null without a pool'),
    }, ['chain', 'address', 'isContract']),
    exemple: { chain: 'robinhood', address: '0x8a166fb41cd659a0a43396272ff73973ce29f817', isContract: true, codeBytes: 2466,
      erc20: { name: 'Swole Doge', symbol: 'SWOGE', decimals: 18, totalSupply: '1000000000000000000000000000', totalSupplyUnits: 1000000000 }, owner: 'renounced (zero address)', proxy: null,
      powers: { readFrom: 'contract', mint: false, blacklist: false, pause: false, feeSetter: false, note: 'function selectors exposed by the dispatcher: a power the code has, not proof it is used' },
      market: { priceUsd: 0.00002579, liquidityUsd: 13569, pool: '0xpool', url: 'https://dexscreener.com/robinhood/0xpool', marketCapUsd: 25790 } },
    texte: 'Robinhood Chain contract 0x8a166fb41cd659a0a43396272ff73973ce29f817: $SWOGE "Swole Doge", 1,000,000,000 supply, 18 decimals. Owner: renounced (zero address)…',
  },
  robinhood_wallet: {
    schema: obj({ chain: s('always robinhood'), address: s('lower case'),
      eth: obj({ balance: nn('ETH'), priceUsd: nn(), valueUsd: nn() }, ['balance', 'priceUsd', 'valueUsd']),
      tokens: tab(obj({ token: s(), symbol: sn(), decimals: nn(), balance: sn('raw units, decimal string'), balanceUnits: nn(), priceUsd: nn('DexScreener'), valueUsd: nn('null when the price is unknown, never zero'), readable: b('false when balanceOf failed') },
        ['token', 'symbol', 'decimals', 'balance', 'balanceUnits', 'priceUsd', 'valueUsd', 'readable'])),
      totalValueUsd: nn('sum over known prices'), note: s() }, ['chain', 'address', 'eth', 'tokens', 'totalValueUsd', 'note']),
    exemple: { chain: 'robinhood', address: '0x5593c8141303d14999df7aa03dd3d3a6d4335fab', eth: { balance: 0, priceUsd: 4000, valueUsd: 0 },
      tokens: [{ token: '0x8a166fb41cd659a0a43396272ff73973ce29f817', symbol: 'SWOGE', decimals: 18, balance: '15155373088977158000000000', balanceUnits: 15155373.09, priceUsd: 0.00002579, valueUsd: 390.86, readable: true }],
      totalValueUsd: 390.86, note: 'balances read on-chain in one Multicall3 call; prices from DexScreener (deepest pool), null when unknown - an unknown price is not zero' },
    texte: 'Wallet 0x5593c8141303d14999df7aa03dd3d3a6d4335fab on Robinhood Chain: 0 ETH ($0); 15155373.09 SWOGE ($390.86)…',
  },
  robinhood_tx: {
    schema: obj({ chain: s('always robinhood'), hash: s(), status: { type: 'string', enum: ['success', 'reverted', 'pending'] }, block: nn(), from: s(), to: sn('null for a contract creation'),
      contractCreated: sn(), valueEth: n(), method: sn('4-byte selector'), gasUsed: nn(), feeEth: nn(), feeUsd: nn('at today\'s ETH price'),
      transfers: tab(obj({ token: s(), symbol: sn(), from: s(), to: s(), amount: s('raw units'), amountUnits: nn(), valueUsdNow: nn('at today\'s price') }, ['token', 'symbol', 'from', 'to', 'amount', 'amountUnits', 'valueUsdNow']), 'ERC-20 transfers, 50 at most'),
      transfersTruncated: b(), swaps: tab(obj({ uniswap: { type: 'string', enum: ['v2', 'v3', 'v4'] }, pool: s('pool address, or the v4 pool id') }, ['uniswap', 'pool'])), logCount: n(), note: s() },
      ['chain', 'hash', 'status', 'block', 'from', 'to', 'contractCreated', 'valueEth', 'method', 'gasUsed', 'feeEth', 'feeUsd', 'transfers', 'transfersTruncated', 'swaps', 'logCount', 'note']),
    exemple: { chain: 'robinhood', hash: '0x91dfeb2157f926164b5d7d4a02819a3b06b302f6694877c8fbb36502f426fbaf', status: 'success', block: 74258956, from: '0x93023bb3a59a63ecfb23301b94ad9101f1ed9973',
      to: '0x540ee09a131bbffe1224ff5d85b3e9650f3d6089', contractCreated: null, valueEth: 0, method: '0x3593564c', gasUsed: 387269, feeEth: 0.000003872689618, feeUsd: 0.0155,
      transfers: [{ token: '0x6e5b1e7b0b0e0f0e0d0c0b0a0908070605040302', symbol: 'VAULT', from: '0x93023bb3A59a63ECFb23301B94Ad9101F1ED9973', to: '0x540Ee09a131bbfFE1224Ff5D85B3e9650f3d6089', amount: '54647729283119560000000000', amountUnits: 54647729.28, valueUsdNow: null }],
      transfersTruncated: false, swaps: [{ uniswap: 'v4', pool: '0x8abd9b14d9732e9217bb11fe8d0cab08b1ed0d2f232cc216873eaa7c0b4fd922' }], logCount: 7,
      note: 'valueUsdNow uses today\'s DexScreener price, not the price at the time of the transaction' },
    texte: 'Robinhood Chain transaction 0x91df…: SUCCESS, from 0x93023b… to 0x540ee0…, fee 0.000003872689618 ETH ($0.0155). 2 token transfers…',
  },
  /* token_verdict (27 septembre 2026) : verdict_jeton.js, lu dans son code. */
  token_verdict: {
    schema: obj({
      token: obj({ address: s('token contract, lower case'), symbol: sn('symbol from DexScreener'), name: sn('name from DexScreener'), chain: sn('DexScreener chain id'),
        priceUsd: nn('price, USD'), liquidityUsd: nn('deepest pool liquidity, USD'), marketCapUsd: nn('market cap, USD'), poolAgeDays: nn('pool age, days'), url: sn('DexScreener pool') },
        ['address', 'symbol', 'name', 'chain', 'priceUsd', 'liquidityUsd', 'marketCapUsd', 'poolAgeDays', 'url']),
      verdict: { type: 'string', enum: ['red_flags', 'caution', 'unknown', 'no_red_flag_found'], description: 'red_flags if any red flag; unknown if the market or the contract could not be read; caution if any other flag; else no_red_flag_found (never "safe")' },
      summary: s('the verdict in one sentence'),
      flags: tab(obj({ level: { type: 'string', enum: ['red', 'caution', 'unknown'] }, code: s('stable flag code, e.g. honeypot, hidden_owner, thin_pool, colony_negative_trait'),
        text: s('what fired, with its number and sample size when there is one'), source: s('GoPlus, DexScreener or SWOGE AI colony') }, ['level', 'code', 'text', 'source']), 'every check that fired'),
      colony: objn({ observations: n('observations in the colony memory'), horizonMinutes: n('the move is measured this many minutes after'), minObservations: n('traits under this count are not used'),
        negativeTraits: tab(obj({ trait: s(), case: s(), observations: n(), averagePct: n('average move, %') })), positiveTraits: tab(obj({ trait: s(), case: s(), observations: n(), averagePct: n('average move, %') }), 'shown apart, never an endorsement'),
        scan: sn('the full scan page') }, ['observations', 'horizonMinutes', 'minObservations', 'negativeTraits', 'positiveTraits'], 'Robinhood Chain tokens the colony knows'),
      attribution: objn({ security: s(), url: s() }, ['security', 'url'], 'set when GoPlus answered'),
      note: s('what the verdict is not'),
      links: obj({ card: s('shareable card, PNG 1200×630'), share: s('share page whose link preview is the card'), page: s('the scan on swoleeswoge.dog') },
        ['card', 'share', 'page'], 'when the colony knows the token: post the share link and the preview shows the card'),
    }, ['token', 'verdict', 'summary', 'flags', 'colony', 'attribution', 'note']),
    exemple: { token: { address: ADR, symbol: 'LOBSTER', name: 'Lobster', chain: 'robinhood', priceUsd: 0.000008424, liquidityUsd: 8803.04, marketCapUsd: 8253, poolAgeDays: 1.4,
        url: 'https://dexscreener.com/robinhood/0x66604bdceb5a54c2c137383171085c3c2260d3d21abe1a77d9180053c9e58c53' },
      verdict: 'caution', summary: '2 points to check: thin_pool, colony_negative_trait',
      flags: [{ level: 'caution', code: 'thin_pool', text: 'pool liquidity $8,803, under the $13,000 the SWOGE AI colony requires to buy — SWOGE AI colony paper trades by pool size at buy (16 Sep 2026): pools $6-13k, 28 trades, -7.8% average, 29% winners; $13-25k, 106 trades, +1.2%, 46% winners', source: 'DexScreener + SWOGE AI colony' },
        { level: 'caution', code: 'colony_negative_trait', text: 'Market cap = cap <$10k: past tokens with this trait moved -4.3% on average in 30 minutes, over 32,821 observations', source: 'SWOGE AI colony' }],
      colony: { observations: 147292, horizonMinutes: 30, minObservations: 30, negativeTraits: [{ trait: 'Market cap', case: 'cap <$10k', observations: 32821, averagePct: -4.3 }],
        positiveTraits: [{ trait: 'Contract bytecode', case: 'bytecode: no mint, no blacklist, no pause, no fee setter', observations: 2395, averagePct: 16.9 }], scan: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR },
      attribution: ATTR_EX, note: 'Measurements, never a buy or sell signal. no_red_flag_found means none of these checks fired, not that the token is safe; unknown stays unknown.' },
    texte: 'Quick verdict for $LOBSTER ' + ADR + ' on robinhood: CAUTION — 2 points to check: thin_pool, colony_negative_trait.…',
  },
  /* Les actions tokenisees (28 septembre 2026) : actions_rh.js ; exemples = VRAIES sorties du 28/09
     (la copie de NVDA a 0,000000324 $ existe sur la chaine). */
  stock_token_check: {
    schema: obj({ verdict: { type: 'string', enum: ['official', 'impostor', 'not_a_stock_token'] }, checked: sn('the address checked, when one was given'),
      onchain: objn({ symbol: sn(), name: sn() }, ['symbol', 'name'], 'what the checked contract says about itself'), official: OFFICIELLE_ACTION,
      warning: s('impostor only'), market: obj({ pool: objn({ priceUsd: n(), liquidityUsd: n(), address: sn(), quotedIn: s(), dex: s() }, ['priceUsd', 'liquidityUsd', 'address', 'quotedIn', 'dex'], 'deepest pool, the token as base'),
        oracle: ORACLE_ACTION, premiumToOraclePct: nn('pool price vs feed, in %') }, ['pool', 'oracle', 'premiumToOraclePct']),
      impostorPool: objn({ priceUsd: n(), liquidityUsd: n(), address: sn() }, ['priceUsd', 'liquidityUsd', 'address'], 'impostor only: its own pool'), note: s() },
      ['verdict', 'checked', 'onchain', 'official', 'note']),
    exemple: { verdict: 'impostor', checked: '0xdecf74e4aa6ff30b1612e65665aaf650bedecba3', onchain: { symbol: 'NVDA', name: 'NVDA' }, official: EX_OFFICIELLE_NVDA,
      warning: 'This contract copies the ticker or name of NVDA but is NOT the Robinhood Stock Token. The official contract is 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.',
      market: { pool: { priceUsd: 230.42, liquidityUsd: 5169589, address: '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3', quotedIn: 'USDG', dex: 'uniswap' }, oracle: EX_ORACLE_NVDA, premiumToOraclePct: -0.11 },
      impostorPool: { priceUsd: 0.000000324, liquidityUsd: 30386, address: '0xd9ea532d4b342ae5eef42517474a9ceda952d43febbd39c265f3cdd14de75b9d' }, note: 'Official list: Robinhood (api.robinhood.com/rhj/assets)…' },
    texte: 'IMPOSTOR: This contract copies the ticker or name of NVDA but is NOT the Robinhood Stock Token.…',
  },
  stock_tokens_premium: {
    schema: obj({ tokens: tab(obj({ address: s(), symbol: s(), name: s(), premiumToOraclePct: n(), poolPriceUsd: n(), liquidityUsd: n(), quotedIn: s(), oracle: ORACLE_ACTION, corporateActionPending: b() },
        ['address', 'symbol', 'name', 'premiumToOraclePct', 'poolPriceUsd', 'liquidityUsd', 'quotedIn', 'oracle', 'corporateActionPending']), 'sorted by absolute premium'),
      compared: n(), officialTokens: n(), withOracle: n(), minLiquidityUsd: n(), measuredAt: s(), note: s() },
      ['tokens', 'compared', 'officialTokens', 'withOracle', 'minLiquidityUsd', 'measuredAt', 'note']),
    exemple: { tokens: [{ address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', symbol: 'NVDA', name: 'NVIDIA \u2022 Robinhood Token', premiumToOraclePct: -0.11, poolPriceUsd: 230.42,
      liquidityUsd: 5169589, quotedIn: 'USDG', oracle: EX_ORACLE_NVDA, corporateActionPending: false }], compared: 28, officialTokens: 195, withOracle: 32, minLiquidityUsd: 10000,
      measuredAt: '2026-09-28T18:20:00.000Z', note: 'Official list: Robinhood (api.robinhood.com/rhj/assets)…' },
    texte: '28 official stock tokens compared (195 official, 32 with a feed). RKLB -0.83%, ASML -0.69%…',
  },
  /* Les lancements de Base (28 septembre 2026) : base_lancements.js ; l'exemple est une VRAIE
     sortie du 28/09 a 18:03 UTC (lue sur la chaine), tronquee a un lancement. */
  base_launches: {
    schema: obj({ launches: tab(LANCEMENT_BASE(true), 'newest first'), reference: BILAN_BASE(false), window: FENETRE_BASE }, ['launches', 'reference', 'window']),
    exemple: { launches: [EX_LANCEMENT_BASE(true)], reference: EX_REF_BASE, window: EX_FENETRE_BASE },
    texte: '1 newest Base launches (Clanker, Zora). Reference: no launch judged yet. Window since 2026-09-28T17:03:31.000Z.…',
  },
  base_deployer: {
    schema: obj({ address: s('the deployer, lower case'), record: BILAN_BASE(true), reference: BILAN_BASE(false), launches: tab(LANCEMENT_BASE(false), 'newest first, 50 at most'), window: FENETRE_BASE },
      ['address', 'record', 'reference', 'launches', 'window']),
    exemple: { address: '0xe3e4c41a7eed7be0b485de9a6025c2983ac01daf', record: Object.assign({}, EX_REF_BASE, { tokens: 2, enough: false, note: 'not enough judged tokens to compare (0/5)' }),
      reference: EX_REF_BASE, launches: [EX_LANCEMENT_BASE(false)], window: EX_FENETRE_BASE },
    texte: 'Deployer 0xe3e4c41a7eed7be0b485de9a6025c2983ac01daf on Base: 2 launches indexed since 2026-09-28T17:03:31.000Z, 0 judged. not enough judged tokens to compare (0/5).',
  },
  /* Le hasard prouvable (28 septembre 2026) : hasard.js, lu dans son code. L'exemple est un
     VRAI tirage (graine fixe) : fair_verify le confirme. */
  fair_commit: {
    schema: obj({ commitment_id: s('24 hex characters, for fair_draw'), server_seed_hash: s('SHA-256 of the secret server seed (hex); share it before the draw'),
      algorithm: s('swoge-hmac-sha256-v1'), committed_at: s('ISO date'), expires_at: s('ISO date, 7 days later'), next: s('what to do next') },
      ['commitment_id', 'server_seed_hash', 'algorithm', 'committed_at', 'expires_at', 'next']),
    exemple: { commitment_id: '6a1f0c3e9b7d2a5c8e4f1b0d', server_seed_hash: 'b85ef21a5deba1bcd033f7eb675b391cf40ce04d63d5e3da39ed9f61f27180b8', algorithm: 'swoge-hmac-sha256-v1',
      committed_at: '2026-09-28T21:00:00.000Z', expires_at: '2026-10-05T21:00:00.000Z',
      next: 'Share server_seed_hash with the other players now. Then call fair_draw with this commitment_id and your client_seed: the server reveals its seed and draws once.' },
    texte: 'Commitment 6a1f0c3e9b7d2a5c8e4f1b0d: server_seed_hash b85ef21a5deba1bc… (swoge-hmac-sha256-v1)…',
  },
  fair_draw: {
    schema: obj({ commitment_id: s(), algorithm: s(), server_seed_hash: s('the hash published by fair_commit'), server_seed: s('the revealed seed: SHA-256 of it is server_seed_hash'),
      client_seed: s(), count: n(), min: n(), max: n(), numbers: tab(n(), 'uniform integers in [min, max]'), committed_at: s(), drawn_at: s(),
      verify_code: s('Node.js code that redoes the draw'), already_drawn: b('true when this commitment was drawn before: the original draw is returned'), note: sn() },
      ['commitment_id', 'algorithm', 'server_seed_hash', 'server_seed', 'client_seed', 'count', 'min', 'max', 'numbers', 'drawn_at', 'verify_code', 'already_drawn']),
    exemple: { commitment_id: '6a1f0c3e9b7d2a5c8e4f1b0d', algorithm: 'swoge-hmac-sha256-v1', server_seed_hash: 'b85ef21a5deba1bcd033f7eb675b391cf40ce04d63d5e3da39ed9f61f27180b8',
      server_seed: '3f9a1c7e5b2d4086a1f3e5c7b9d0f2a4c6e8b1d3f5a7c9e0b2d4f6a8c0e2b4d6', client_seed: 'agent-42', count: 5, min: 1, max: 6, numbers: [3, 4, 3, 5, 3],
      committed_at: '2026-09-28T21:00:00.000Z', drawn_at: '2026-09-28T21:02:00.000Z', verify_code: 'const c=require("crypto");function draw(s,cs,n,min,max){…}', already_drawn: false },
    texte: 'Draw: 3, 4, 3, 5, 3 in [1, 6]. server_seed 3f9a1c7e… (hash b85ef21a…), client_seed "agent-42".',
  },
  fair_verify: {
    schema: obj({ algorithm: s(), server_seed_hash_computed: s('SHA-256 of server_seed'), hash_matches: { type: ['boolean', 'null'], description: 'null when no hash was given' },
      count: n(), min: n(), max: n(), numbers: tab(n()), numbers_match: { type: ['boolean', 'null'], description: 'null when no numbers were given' },
      nonce: n('swoge-casino-shoe only'), deck: tab(n(), 'swoge-casino-shoe only: card ids 0-51, rank = id % 13 (0 = 2 … 12 = ace), suit = id / 13'), cards: tab(s(), 'swoge-casino-shoe only: e.g. As, Td') },
      ['algorithm', 'server_seed_hash_computed', 'hash_matches']),
    exemple: { algorithm: 'swoge-hmac-sha256-v1', server_seed_hash_computed: 'b85ef21a5deba1bcd033f7eb675b391cf40ce04d63d5e3da39ed9f61f27180b8', hash_matches: true,
      count: 5, min: 1, max: 6, numbers: [3, 4, 3, 5, 3], numbers_match: true },
    texte: 'Hash matches. Numbers: 3, 4, 3, 5, 3 (match the claimed draw).',
  },
  /* roast_token (28 septembre 2026) : roast.js, lu dans son code. */
  roast_token: {
    schema: obj({
      token: obj({ address: s('token contract, lower case'), symbol: sn('symbol from DexScreener'), chain: sn('DexScreener chain id') }, ['address', 'symbol', 'chain']),
      roast: s('the roast, 2 or 3 sentences, at most 240 characters, ASCII'),
      verdict: { type: 'string', enum: ['red_flags', 'caution', 'unknown', 'no_red_flag_found'], description: 'the token_verdict of the same data' },
      writer: s('SWOGE AI (Claude Haiku), or template when the model did not answer: the template is built from the same facts'),
      facts: obj({ symbol: sn(), name: sn(), chain: sn(), priceUsd: nn(), liquidityUsd: nn('deepest pool, USD'), marketCapUsd: nn(), poolAgeDays: nn(), change24hPct: nn(),
        verdict: s(), flags: tab(s(), 'level: what fired') }, ['symbol', 'liquidityUsd', 'marketCapUsd', 'verdict', 'flags'], 'the only facts the roast may use'),
      links: obj({ card: s('shareable card, PNG 1200×630'), share: s('share page whose link preview is the card') }, ['card', 'share']),
      note: s('what the roast is not'),
    }, ['token', 'roast', 'verdict', 'writer', 'facts', 'links', 'note']),
    exemple: { token: { address: ADR, symbol: 'LOBSTER', chain: 'robinhood' },
      roast: 'LOBSTER runs on $8.8k of liquidity and a dream. My protein tub is deeper than this pool, and it has never skipped leg day.',
      verdict: 'caution', writer: 'SWOGE AI (Claude Haiku)',
      facts: { symbol: 'LOBSTER', name: 'Lobster', chain: 'robinhood', priceUsd: 0.000008424, liquidityUsd: 8803.04, marketCapUsd: 8253, poolAgeDays: 1.4, change24hPct: -12.4,
        verdict: 'caution', flags: ['caution: pool liquidity $8,803, under the $13,000 the SWOGE AI colony requires to buy'] },
      links: { card: 'https://web-production-220a3.up.railway.app/roast/3f2a9c1b7d4e.png', share: 'https://web-production-220a3.up.railway.app/rt/3f2a9c1b7d4e' },
      note: 'Entertainment built on real data: never a buy or sell signal.' },
    texte: 'SWOGE roasts $LOBSTER: LOBSTER runs on $8.8k of liquidity and a dream.…',
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
    schema: obj({ answer: s('Markdown answer'), sources: tab(SOURCE), tokens: tab({ type: 'object', description: 'token cards read on the way (same shape as scan_token.token)' }), steps: n('model calls used'),
      stoppedByBudget: b('paid per call (x402): true when the spending cap ended the run early') },
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
    /* Base allumée : le reçu d'un paiement en USDC sur Base (le premier proposé). */
    const a = ((c.x402 && c.x402.assets) || []).find((x) => x.symbol === (baseOn(c) ? 'USDC' : 'USDG'));
    e.x402 = { transaction: '0x8c1f3e2d4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', network: baseOn(c) ? c.x402.base.network : ((c.x402 && c.x402.network) || 'eip155:4663'),
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
  accepts: tab(obj({ scheme: { type: 'string', const: 'exact' }, network: s('eip155:8453 (Base) or eip155:4663 (Robinhood Chain)'), amount: s('atomic units of the asset (USDC and USDG: 6 decimals, $SWOGE: 18)'), asset: s(), payTo: s(),
    maxTimeoutSeconds: n(), extra: obj({ assetTransferMethod: { type: 'string', enum: ['eip3009', 'permit2'] }, name: s('EIP-712 domain name'), version: s('EIP-712 domain version') }, []) },
  ['scheme', 'network', 'amount', 'asset', 'payTo']), 'USDC on Base first when it is on (settled by Coinbase, no assetTransferMethod), then USDG (EIP-3009), then $SWOGE (Permit2) on Robinhood Chain'),
  extensions: { type: 'object', description: 'eip2612GasSponsoring: the server takes an EIP-2612 permit to Permit2 and pays the gas. bazaar: the input and output schemas of this tool, with a fixed example request (x402 bazaar extension)' },
  raison: s('why a payment was refused'), detail: sn(),
}, ['x402Version', 'accepts']);
const REFUS_CLE = obj({ ok: { type: 'boolean', const: false }, raison: s('what to do'), requisSwoge: s('$SWOGE needed') }, ['ok', 'raison']);

/* Base allumée (lot Base, 27 septembre 2026) : l'état public porte `base.actif`. */
const baseOn = (c) => !!(c && c.x402 && c.x402.base && c.x402.base.actif);
function exemple402(nom, p, c) {
  const x = c.x402 || {};
  const usdg = (x.assets || []).find((a) => a.symbol === 'USDG');
  const swoge = (x.assets || []).find((a) => a.symbol === 'SWOGE');
  const accepts = [];
  const delai = nom === 'ask_agent' ? 300 : 120;
  if (baseOn(c)) {
    /* Base d'abord, au prix Base (le minimum) ; Robinhood ensuite, à son prix (le maximum). */
    const usdc = (x.assets || []).find((a) => a.symbol === 'USDC') || {};
    accepts.push({ scheme: 'exact', network: x.base.network, amount: String(Math.round(p.min * 1e6)), asset: usdc.asset, payTo: x.base.payTo, maxTimeoutSeconds: delai,
      extra: { name: usdc.name || 'USD Coin', version: usdc.version || '2' } });
    if (usdg) accepts.push({ scheme: 'exact', network: x.network, amount: String(Math.round(p.max * 1e6)), asset: usdg.asset, payTo: x.payTo, maxTimeoutSeconds: delai,
      extra: { assetTransferMethod: 'eip3009', name: usdg.name || 'Global Dollar', version: usdg.version || '1' } });
    if (swoge && c.cours > 0) accepts.push({ scheme: 'exact', network: x.network, amount: ethers.utils.parseUnits((p.max / c.cours).toFixed(18), 18).toString(), asset: swoge.asset, payTo: x.payTo,
      maxTimeoutSeconds: delai, extra: { assetTransferMethod: 'permit2', name: swoge.name || 'Swole Doge', version: swoge.version || '1' } });
    return { ok: false, x402Version: 2, error: 'PAYMENT-SIGNATURE header is required',
      resource: { url: c.base + '/agentic/call/' + nom, description: 'SwogeAgentic tool ' + nom + '. Price: $' + Number(p.min.toFixed(6)) + ' in USDC on Base'
        + (accepts.length > 1 ? ', or $' + Number(p.max.toFixed(6)) + ' in ' + [usdg ? 'USDG' : null, accepts.length > 2 ? '$SWOGE' : null].filter(Boolean).join(' or ') + ' on Robinhood Chain' : '')
        + ' (tool price + settlement cost, minimum $' + (x.minimumUsd || 0.02) + ').', mimeType: 'application/json' },
      accepts, extensions: { eip2612GasSponsoring: { info: { description: 'The server accepts an EIP-2612 permit to the canonical Permit2 contract (value = the exact payment amount) and pays the gas.', version: '1' } } } };
  }
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
/* Les prix d'un x402.prix, par réseau prixé : Base (usdBase) et Robinhood (usd). */
const cotesDe = (p) => [p.usdBase, p.usd].filter((x) => typeof x === 'number' && x > 0);
async function prixX402Annonces({ noms, prix, base, minUsd }) {
  const out = {};
  const plancher = (x) => Math.max(minUsd || 0.02, x || 0);
  for (const nom of noms || []) {
    if (nom === 'generate_image') {
      const cotes = OPTIONS_IMAGE.map((a) => ({ a, u: base(nom, a) })).filter((x) => x.u > 0).sort((x, y) => x.u - y.u);
      if (!cotes.length) continue;
      const [bas, haut] = await Promise.all([prix(nom, cotes[0].a), prix(nom, cotes[cotes.length - 1].a)].map((p) => Promise.resolve(p).catch(() => null)));
      const mn = bas ? Math.min(...cotesDe(bas)) : NaN, mx = haut ? Math.max(...cotesDe(haut)) : NaN;
      out[nom] = { min: mn > 0 ? mn : plancher(cotes[0].u), max: mx > 0 ? mx : plancher(cotes[cotes.length - 1].u),
        options: { min: cotes[0].a, max: cotes[cotes.length - 1].a } };
      continue;
    }
    const p = await Promise.resolve().then(() => prix(nom)).catch(() => null);
    /* Lot Base (27 septembre 2026) : le prix de CHAQUE réseau prixé — Base (min) et
       Robinhood (max) ; un seul prixé (usd null si le RPC de Robinhood se tait) : le sien.
       Avant, `u > 0` sur un usd null faisait disparaître l'outil des prix. */
    const l = p ? cotesDe(p) : [];
    if (l.length) out[nom] = { min: Math.min(...l), max: Math.max(...l) };
    else { const u = plancher(base(nom)); if (u > 0) out[nom] = { min: u, max: u }; }
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
  if (baseOn(c)) {
    /* La phrase du gaz, construite sur les réseaux ALLUMÉS : Base allumée, personne ne paie de gaz. */
    const rh = ((c.x402 && c.x402.assets) || []).filter((a) => a.symbol !== 'USDC').map((a) => (a.symbol === 'SWOGE' ? '$SWOGE' : a.symbol)).join(' or ');
    const xb = o.name === 'generate_image' ? 'from $' + Number(p.min.toFixed(6)) + ' to $' + Number(p.max.toFixed(6)) + ' now, by request (provider, quality, count)'
      : p.min === p.max ? '$' + Number(p.min.toFixed(6)) + ' now' : '$' + Number(p.min.toFixed(6)) + ' now in USDC on Base, $' + Number(p.max.toFixed(6)) + ' on Robinhood Chain';
    return (cle ? cle + ' ' : '') + 'Without a key (x402): ' + xb + ', in USDC on Base' + (rh ? ' or ' + rh + ' on Robinhood Chain' : '') + ' (tool price + settlement cost, minimum $'
      + ((c.x402 && c.x402.minimumUsd) || 0.02) + '; the payer pays no gas on either network); the 402 quotes the exact amount for your arguments.';
  }
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
  /* ---- LA BOUTIQUE eSIM, POUR LES AGENTS AUSSI (28/09 au soir) ----
     Demande du proprietaire : « le but est que les agents aussi puissent utiliser nos services
     facilement ». Ses routes ne sont pas des outils /agentic/call (la recherche est gratuite, le
     prix de l'achat est celui du forfait choisi) : elles sont decrites a part. */
  if (c.esim) Object.assign(paths, pathsEsim(c));
  /* La passerelle de depense (passerelle.js, 28/09 au soir) : payer un AUTRE service x402 avec sa cle. */
  paths['/agentic/pay'] = { post: { operationId: 'payService', summary: 'Use this when your agent must pay another x402 service: SWOGE pays it for you, within the limits the key owner set', tags: ['payments'],
    description: 'With your API key and an Idempotency-Key header. The key owner first turns payments on for that key (per-call cap up to $0.10, optional allowed sites) on the SwogeAgentic page: off by default. '
      + 'Only services of the public x402 catalogue, public https addresses, no redirects; the price in the 402 must fit the per-call cap (and max_usd if sent) and the key\'s daily cap. '
      + 'Paid only if the service answers 200; the owner is billed in $SWOGE. The same Idempotency-Key never pays twice. Every attempt writes a hash-chained audit line: GET /agentic/audit.',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 } }],
    requestBody: { required: true, content: { 'application/json': { schema: obj({ url: s('https URL of the paid service'), method: s('GET or POST'), query: { type: 'object' }, body: { type: 'object' },
      max_usd: n('optional: a lower cap for this call') }, ['url']), example: { url: 'https://x402factory.ai/solana/coinprice', query: { symbol: 'SOL' }, max_usd: 0.01 } } } },
    responses: { 200: { description: 'Paid (or free): the service answer, the receipt and the audit line', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' }, resultat: { description: 'the service answer' },
      recu: { type: 'object', description: 'url, usd, factureUsd, reseau, tx' }, audit: { type: 'object', description: 'seq and h (SHA-256) of the audit line' }, rejoue: b('true: this Idempotency-Key was already used, original answer') }, ['ok']) } } },
      400: { description: 'Bad request or missing Idempotency-Key - nothing is charged' }, 401: { description: 'No key, or unknown or revoked key' }, 402: { description: 'Refused before or after the call - nothing is charged' },
      403: { description: 'Payments are off for this key, or the site is not allowed' }, 409: { description: 'A payment with this Idempotency-Key is still running' } },
    security: [{ cleApi: [] }, { cleEnTete: [] }] } };
  paths['/agentic/audit'] = { get: { operationId: 'audit', summary: 'The hash-chained audit of the payments made with your key (or all your keys, signed in)', tags: ['payments'],
    responses: { 200: { description: 'Lines, newest first, and the state of the whole chain', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' }, lignes: tab({ type: 'object' }),
      chaine: obj({ ok: { type: 'boolean' }, lignes: n(), casseA: nn('seq of the first broken line') }, ['ok']) }, ['ok', 'lignes', 'chaine']) } } }, 401: { description: 'No key' } },
    security: [{ cleApi: [] }, { cleEnTete: [] }] } };
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'SwogeAgentic',
      version: '1.1.0',
      summary: RESUME,
      description: DESCRIPTION,
      'x-guidance': 'POST /agentic/call/<tool> with a JSON body {"arguments": {...}}; GET /agentic/tools lists tools, input schemas and prices. Add "quote": true to get the price without running anything. '
        + 'With an API key (Authorization: Bearer swg_… or X-API-Key, created at ' + (c.page || 'the SwogeAgentic page') + ') the call is billed from the key owner\'s $SWOGE balance, within the daily cap they set. '
        + (baseOn(c) ? 'Without a key, tools marked x-payment-info answer 402 with a PAYMENT-REQUIRED header (x402 v2, scheme exact; first option USDC on Base, ' + c.x402.base.network + ', settled by Coinbase; then on Robinhood Chain, ' + c.x402.network + ', '
          + (c.x402.assets || []).filter((a) => a.symbol !== 'USDC').map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ') + '): sign and retry with PAYMENT-SIGNATURE and the SAME arguments; the payer pays no gas on either network. '
          : c.x402 ? 'Without a key, tools marked x-payment-info answer 402 with a PAYMENT-REQUIRED header (x402 v2, scheme exact, ' + c.x402.network + ', ' + (c.x402.assets || []).map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ') + '): sign and retry with PAYMENT-SIGNATURE and the SAME arguments; the server pays the gas. ' : '')
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
/** Les routes de la boutique eSIM (boutique_esim.js), decrites pour un agent. */
const PLAN_ESIM = obj({ plan: s('plan id: pass it to /esim/buy'), name: s(), covers: sn('the country, or the region that contains it'), gb: nn(), days: nn(), priceUsd: n('USD, paid in USDC') }, ['plan', 'name', 'priceUsd']);
const EX_PLANS_ESIM = { ok: true, destination: 'France', otherDestinations: [], unavailable: 0,
  plans: [{ plan: 'europe-33-areas-1gb-7days-example', name: 'Europe 1GB 7 Days', covers: 'Region of 33 countries (Austria, Belgium, Bulgaria…)', gb: 1, days: 7, priceUsd: 1.6 }],
  terms: 'https://vamoschips.com/legal/terms', compatibility: 'https://vamoschips.com/compatibility',
  note: 'Data only (no phone number). Paid in USDC from your wallet on Base or Solana; you are charged only if the eSIM is bought.' };
function pathsEsim(c) {
  const erreur = { description: 'Refused - nothing is charged', content: { 'application/json': { schema: obj({ ok: { type: 'boolean', const: false }, raison: s('what went wrong') }, ['ok', 'raison']) } } };
  return {
    '/esim/plans': { get: { operationId: 'esimPlans', summary: 'Use this when you need mobile data abroad: travel data eSIM plans for a country or region, with their price', tags: ['esim'],
      description: 'Free: nothing is paid. Returns data-only eSIM plans (no phone number) for a country (name or 2-letter code) or a region (Europe, Asia, Middle East, South America, North America, Global), '
        + 'including the regional plans that cover the country, cheapest per GB first, each with its price in USD paid in USDC. At most 20 searches per 10 minutes per IP. Seller: CHIPS.',
      parameters: [{ name: 'country', in: 'query', required: true, schema: { type: 'string', maxLength: 40 }, description: 'e.g. France, JP, Europe' },
        { name: 'min_gb', in: 'query', required: false, schema: { type: 'number' } }, { name: 'min_days', in: 'query', required: false, schema: { type: 'integer' } }],
      responses: { 200: { description: 'The plans', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' }, destination: s(), plans: tab(PLAN_ESIM),
        unavailable: n('plans the shop cannot sell right now'), terms: s(), compatibility: s('check the device supports eSIM'), note: s() }, ['ok', 'plans']), example: EX_PLANS_ESIM } } },
        400: erreur, 429: { description: 'Too many searches' } }, security: [] } },
    '/esim/buy': { post: { operationId: 'esimBuy', summary: 'Use this to buy a travel data eSIM chosen with /esim/plans, paid per purchase in USDC with x402 (Base or Solana), no account', tags: ['esim'],
      description: 'POST {"plan": "<plan id from /esim/plans>"} without payment: 402 with PAYMENT-REQUIRED (x402 v2, scheme exact, USDC on Base or Solana, the plan price). Sign and retry with PAYMENT-SIGNATURE and the SAME plan. '
        + 'The server verifies the payment, buys the eSIM, and only then settles it: an eSIM that could not be bought is never charged. Returns the activation (LPA code, SM-DP+ address, activation code) and orderLink, '
        + 'a secret: GET /esim/order/<orderLink> returns the activation again (no account). Limits: 15 $ per purchase, 30 $ per payer per day.',
      requestBody: { required: true, content: { 'application/json': { schema: obj({ plan: s('plan id from /esim/plans') }, ['plan']), example: { plan: EX_PLANS_ESIM.plans[0].plan } } } },
      responses: { 200: { description: 'Bought: activation and orderLink', content: { 'application/json': { schema: obj({ ok: { type: 'boolean' }, delivered: b('false: being prepared, poll /esim/order'), orderLink: s('secret, 32 hex'),
        achat: { type: 'object', description: 'name, gb, days, activation {uri, code, smdp, iccid4} or null while prepared' } }, ['ok', 'orderLink']) } } },
        400: erreur, 402: { description: 'Payment Required: the x402 v2 challenge for this plan (also in the PAYMENT-REQUIRED header)', headers: { 'PAYMENT-REQUIRED': { description: 'base64 JSON of the x402 v2 PaymentRequired object', schema: { type: 'string' } } } },
        409: { description: 'No current price for this plan: search /esim/plans again' }, 502: { description: 'The eSIM could not be bought - nothing is charged' }, 503: { description: 'The shop is closed right now' } },
      'x-payment-info': { protocols: [{ x402: {} }], price: { mode: 'dynamic', currency: 'USD', min: '0.500000', max: usd6(c.esim.maxUsd || 15) } }, security: [] } },
    '/esim/order/{orderLink}': { get: { operationId: 'esimOrder', summary: 'The activation of an eSIM bought with /esim/buy, by its secret order link', tags: ['esim'],
      parameters: [{ name: 'orderLink', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{32}$' } }],
      responses: { 200: { description: 'Ready: the activation' }, 202: { description: 'Paid, being prepared: try again in a minute' }, 404: { description: 'Unknown order link' } }, security: [] } },
  };
}

function manifeste(c) {
  const m = { version: 1, x402Version: 2, name: 'SwogeAgentic', description: RESUME,
    resources: Object.keys(c.prixX402 || {}).map((n) => c.base + '/agentic/call/' + n).concat(c.esim ? [c.base + '/esim/buy'] : []),
    instructions: DESCRIPTION + ' How to pay: POST the resource with {"arguments": {...}} and no key; the 402 PAYMENT-REQUIRED header (x402 v2, scheme exact'
      + (baseOn(c) ? '; USDC on Base (' + c.x402.base.network + ') first, then on Robinhood Chain (' + c.x402.network + ') ' + (c.x402.assets || []).filter((a) => a.symbol !== 'USDC').map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ')
        : c.x402 ? ', ' + c.x402.network + ', ' + (c.x402.assets || []).map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ') : '')
      + ') quotes that exact request; sign it and retry with PAYMENT-SIGNATURE and the same arguments. ' + (baseOn(c) ? 'The payer pays no gas on either network. ' : 'We pay the gas. ')
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
  scan_token: { address: ADR }, can_i_sell: { address: ADR }, token_verdict: { address: ADR }, roast_token: { address: ADR }, colony_activity: {},
  /* Le hasard prouvable : fair_verify sur le VRAI tirage de l'exemple ; fair_draw a besoin d'un engagement vivant. */
  stock_token_check: { symbol: 'NVDA' }, stock_tokens_premium: { limit: 10 },
  base_launches: { limit: 5 }, base_deployer: { address: '0xe3e4c41a7eed7be0b485de9a6025c2983ac01daf' },
  fair_commit: {}, fair_draw: { commitment_id: '6a1f0c3e9b7d2a5c8e4f1b0d', client_seed: 'agent-42', count: 5, min: 1, max: 6 },
  fair_verify: { server_seed: '3f9a1c7e5b2d4086a1f3e5c7b9d0f2a4c6e8b1d3f5a7c9e0b2d4f6a8c0e2b4d6', server_seed_hash: 'b85ef21a5deba1bcd033f7eb675b391cf40ce04d63d5e3da39ed9f61f27180b8',
    client_seed: 'agent-42', count: 5, min: 1, max: 6, numbers: [3, 4, 3, 5, 3] },
  chat_completion: { messages: [{ role: 'user', content: 'Say hello in five words.' }], max_tokens: 64 },
  robinhood_rpc: { method: 'eth_blockNumber' }, robinhood_token: { address: ADR }, robinhood_wallet: { address: ADR }, /* Une VRAIE transaction de Robinhood Chain (decodee le 27/09 : 2 transferts VAULT, un swap v4) : l'inscription
     automatique paie avec cet exemple, et un hash invente rendait « no such transaction » (27/09, 22 h 17). */
  robinhood_tx: { hash: '0x91dfeb2157f926164b5d7d4a02819a3b06b302f6694877c8fbb36502f426fbaf' }, swoge_economy: {}, new_launches: { limit: 5 },
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

/* ---- ASCII (lot Base, 27 septembre 2026) ----
   Tout ce qu'un client recopie dans son paiement (resource, accepts[].extra,
   extensions.*) reste en ASCII imprimable : le client MCP de Cloudflare encode
   par btoa(JSON.stringify(…)) et jette au-delà de U+00FF (cloudflare/agents
   packages/agents/src/mcp/client/x402.ts:454-488, commit dbf170cf). Les
   exemples de SORTIES portent « · », « × », « … » : remplacés ici. */
const REMPLACE = { '\u2014': '-', '\u2013': '-', '\u2026': '...', '\u00b7': '-', '\u00d7': 'x', '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2192': '->', '\u00a0': ' ' };
const ascii = (t) => String(t).replace(/[^\x20-\x7e]/g, (ch) => (REMPLACE[ch] !== undefined ? REMPLACE[ch] : ch === '\n' || ch === '\t' ? ' ' : ''));
const asciiProfond = (x) => (Array.isArray(x) ? x.map(asciiProfond) : x && typeof x === 'object'
  ? Object.keys(x).reduce((o, k) => { o[ascii(k)] = asciiProfond(x[k]); return o; }, {}) : typeof x === 'string' ? ascii(x) : x);

/* ---- L'EXEMPLE DE SORTIE (info.output.example ; lot Base, 27 septembre 2026) ----
 * Le validateur de Coinbase le marque « advisory » (bazaar.info.output.example,
 * relevé du 27 septembre 2026, base_design/skeptic/val_2026-09-27.json) ; DOCS
 * get-discovered : « Complete input and output schemas with realistic examples
 * raise metadata quality ». PETIT : le bloc voyage dans l'en-tête
 * PAYMENT-REQUIRED (6 581 caractères pour scan_token le 27 septembre 2026,
 * plafond d'essai 8 192) et revient dans le PAYMENT-SIGNATURE du client
 * (16 384 octets d'en-têtes au total chez Node). `resultat` (l'exemple de
 * SORTIES, en ASCII) n'y entre que s'il tient en EXEMPLE_SORTIE_MAX_CAR
 * caractères — un choix de départ, vérifié par les essais de taille
 * (x402.test.js, x402_route.test.js) ; sinon l'enveloppe seule (ok, outil,
 * texte), qui valide aussi le schéma (resultat n'y est pas requis). */
const EXEMPLE_SORTIE_MAX_CAR = 700;
function exempleSortie(nom) {
  const S = SORTIES[nom] || {};
  const e = { ok: true, outil: nom };
  if (S.exemple !== undefined) {
    const r = asciiProfond(S.exemple);
    if (JSON.stringify(r).length <= EXEMPLE_SORTIE_MAX_CAR) e.resultat = r;
  }
  if (S.texte) e.texte = ascii(S.texte);
  else if (!e.resultat) e.texte = 'See resultat: the ' + nom + ' result as data.';
  return e;
}

/* ask_agent vendu en x402 (X402_AGENT=1, contrat §B.2) : le bloc n'annonce que ce
   que le chemin x402 accepte — Sonnet 5 seul, tâche de 2 000 caractères au plus
   (studio_agent.LIMITES_X402). Sinon il afficherait des modèles refusés en 400. */
const MODELE_AGENT_X402 = 'sonnet-5';
const TACHE_AGENT_X402_MAX = 2000;
function entreeVendue(nom, schema) {
  if (nom !== 'ask_agent' || !schema || !schema.properties) return schema;
  const props = Object.assign({}, schema.properties);
  if (props.task) props.task = Object.assign({}, props.task, { maxLength: TACHE_AGENT_X402_MAX });
  if (props.model) props.model = Object.assign({}, props.model, { enum: [MODELE_AGENT_X402] });
  return Object.assign({}, schema, { properties: props });
}

function bazaar(nom, def) {
  const corps = { type: 'object', properties: { arguments: Object.assign({ type: 'object' }, sec(entreeVendue(nom, (def && def.inputSchema) || {}))) }, required: ['arguments'] };
  const env = enveloppe(nom);
  /* La sortie d'un appel paye sans cle : le resultat, son texte, le reglement x402. */
  const sortie = { type: 'object', required: ['ok', 'outil'], properties: { ok: env.properties.ok, outil: env.properties.outil, resultat: sec(env.properties.resultat),
    texte: { type: 'string' }, x402: sec(env.properties.x402.anyOf[0]) } };
  return {
    info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: { arguments: Object.assign({}, EXEMPLES_ENTREE[nom] || {}) } }, output: { type: 'json', example: exempleSortie(nom) } },
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: {
        input: { type: 'object', properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST'] }, bodyType: { type: 'string', enum: ['json'] },
          body: corps }, required: ['type', 'method', 'bodyType', 'body'], additionalProperties: false },
        output: { type: 'object', properties: { type: { type: 'string' }, example: sortie }, required: ['type'] },
      }, required: ['input'] },
  };
}

/**
 * Le bloc bazaar d'un outil MCP (x402 sur MCP, contrat §C.3 ; x402-foundation
 * specs/extensions/bazaar.md:170-240, commit 4fcf836c) : `info.input.type` 'mcp',
 * le NOM de l'outil, son inputSchema EXACTEMENT comme tools/list le donne
 * (agentic_mcp.outilsMcp), le transport, un exemple d'entrée fixe. Une fiche
 * = l'adresse de l'endpoint + le nom de l'outil (bazaar.md:282). Pas de limite
 * d'en-tête ici (corps JSON), mais petit et ASCII quand même.
 */
function bazaarMcp(nom, defMcp) {
  const d = defMcp || {};
  const schemaEntree = asciiProfond(sec(entreeVendue(nom, d.inputSchema || { type: 'object' })));
  const env = enveloppe(nom);
  const sortie = { type: 'object', required: ['ok', 'outil'], properties: { ok: env.properties.ok, outil: env.properties.outil, resultat: sec(env.properties.resultat),
    texte: { type: 'string' }, x402: sec(env.properties.x402.anyOf[0]) } };
  const desc = ascii(String(d.description || '').split('. ')[0].replace(/\.$/, '')) + '.';
  return {
    info: { input: { type: 'mcp', toolName: nom, description: desc, inputSchema: schemaEntree, transport: 'streamable-http', example: Object.assign({}, EXEMPLES_ENTREE[nom] || {}) },
      output: { type: 'json', example: exempleSortie(nom) } },
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: {
        input: { type: 'object', properties: { type: { type: 'string', const: 'mcp' }, toolName: { type: 'string', const: nom }, description: { type: 'string' },
          inputSchema: { type: 'object' }, transport: { type: 'string', enum: ['streamable-http'] }, example: { type: 'object' } },
        required: ['type', 'toolName', 'inputSchema'], additionalProperties: false },
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

module.exports = { origine, preuvesValides, openapi, manifeste, ficheMcp, usd6, prixX402Annonces, bazaar, bazaarMcp, exempleSortie, EXEMPLES_ENTREE, enveloppe, SORTIES, ETIQUETTES, ETIQUETTES_OUTIL,
  DEFI_X402, REFUS_CLE, OPTIONS_IMAGE, RESUME, DESCRIPTION, ICONE, EXEMPLE_SORTIE_MAX_CAR, ascii, asciiProfond, MODELE_AGENT_X402, TACHE_AGENT_X402_MAX };
