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
   Remesuré le même jour après la mention GoPlus, recherche web comprise :
   7 outils par défaut 3 165 caractères (1 583 jetons) ; 8 avec
   TG_APPELS_VENTE=1, 3 804 caractères (1 902 jetons) — le cas qui compte.
   Remesuré le même jour après les descriptions « quand appeler » (découverte) :
   7 outils 4 339 caractères (2 170 jetons), 8 avec TG_APPELS_VENTE=1 5 038
   caractères (2 519 jetons) — 2 000 ne tenait plus, d'où 2 600. Le pire cas
   d'ask_agent monte d'autant : 1,278 $ → 1,289 $ (Sonnet 5, tâche de 2 000
   caractères, marge comprise) ; la facture, elle, reste le réel.
   Remesuré le 27 septembre 2026 avec can_i_sell : 8 outils par défaut 5 178
   caractères (2 589 jetons), 9 avec TG_APPELS_VENTE=1 5 877 caractères
   (2 939 jetons) — 2 600 ne tenait plus, d'où 3 000. Pire cas d'ask_agent
   (Sonnet 5, tâche de 2 000 caractères, recherche, marge comprise) :
   1,2888 $ → 1,2960 $ ; la facture reste le réel.
   L'essai vérifie que la borne couvre toujours les définitions, réglage allumé. */
const OUTILS_JETONS = 3000;
const SYSTEME_JETONS = 500;
const PRIX_RECHERCHE_USD = 0.005;      /* Perplexity Search API, la requête réussie */

/* ---- L'AGENT VENDU EN x402 : DES BORNES PLUS SERRÉES ET UN PLAFOND DUR (contrat §D.2-D.4, 27 septembre 2026) ----
 * x402 « exact » exige le montant AVANT d'agir : ask_agent se vend à un prix
 * fixe, et ce que coûte une exécution doit rester sous un plafond. Avec une
 * clé, rien ne change (ETAPES_MAX, OUTILS_PAR_ETAPE, RESULTAT_CAR_MAX…).
 *   modèle Sonnet 5 seul, tâche ≤ 2 000 caractères, 4 appels au plus (le
 *   dernier sans outils), 2 outils par appel, résultats coupés à 6 000
 *   caractères, 4 000 jetons de sortie par appel (Sonnet 5 réfléchit par
 *   défaut et ça compte dedans : plus bas risquerait des réponses coupées),
 *   150 s en tout, l'appel final forcé après 105 s.
 * Pire cas à la formule (base_design/agent_budget_calc.js, relancé le 27
 * septembre 2026) : 76 400 jetons d'entrée × 2 $/M + 16 000 de sortie × 10 $/M
 * + 8 recherches × 0,005 $ = 0,3528 $ — SOUS L'HYPOTHÈSE NON MESURÉE d'un jeton
 * pour deux caractères (le tokenizer de Sonnet 5 en compte ~30 % de plus que
 * Sonnet 4.6 ; nos résultats sont du JSON plein d'adresses). D'où la GARDE EN
 * DIRECT de `repond` (deps.limites + deps.budgetUsd) : chaque appel est compté
 * AVANT (messages.countTokens, gratuit) et n'est pas fait s'il pouvait crever
 * le plafond. 105 s / 150 s : valeurs de DÉPART, la durée d'un appel final de
 * 4 000 jetons n'est pas mesurée (contrat §G.11) — à mesurer avant de les figer. */
const LIMITES_X402 = Object.freeze({ modele: 'sonnet-5', tacheMaxCar: 2000, etapesMax: 4, outilsParEtape: 2, resultatCarMax: 6000, sortieMax: 4000,
  dureeMaxS: 150, finalApresS: 105 });
/* Le plafond provisoire d'une exécution x402 (X402_AGENT_BUDGET_USD) : au-dessus
   du pire cas à la formule (0,3528 $). Prix = plafond × STUDIO_MARGE, arrondi
   au cent supérieur (0,54 $). Provisoire : le rapport caractères/jeton n'est pas mesuré. */
const BUDGET_X402_USD = 0.36;
/* countTokens rend une ESTIMATION (doc Anthropic token-counting, copie du 26
   septembre 2026, ligne 33) : +5 %. Un choix, pas une mesure ; la marge de prix
   (50 %) absorbe davantage. */
const MARGE_COMPTE = 1.05;

const SYSTEME = [
  'You are SwogeAgentic, the research agent of SWOGE WORLD.',
  'You receive a task, decide which tools to call, call them (several if useful), then answer.',
  'Answer in the language the user writes in, with Markdown. Quote the numbers you read with their source and, for the SWOGE AI colony, their number of observations.',
  'Never give financial advice, price predictions or buy/sell calls. Never call a token safe; "unknown" is unknown, not good news.',
  'You can only READ: you cannot buy, sell, sign or post anything. If asked to, say so.',
].join(' ');
/* L'embauche (embauche.js, 28/09/2026) : quand elle est offerte, la consigne dit la
   verite sur ce que l'agent peut PAYER — et seulement cela. */
const SYSTEME_EMBAUCHE = SYSTEME.replace('You can only READ: you cannot buy, sell, sign or post anything. If asked to, say so.',
  'You cannot buy, sell, sign or post anything, with one exception: you may pay an outside service through hire_paid_service, which charges the user\'s balance. '
  + 'Hire only when your own tools cannot answer, pick the cheapest service that fits, never hire the same service twice for the same question, '
  + 'and always tell the user which service you paid, how much, and what it returned.');

/* L'achat d'une eSIM (achats.js, 28/09/2026) : l'agent PROPOSE, le joueur confirme sur la
   page. La consigne le dit, pour que l'agent n'annonce jamais un achat qui n'a pas eu lieu. */
const SYSTEME_ACHATS = ' You can also help the user buy a travel data eSIM: find_esim_plans lists plans with their price, propose_esim_purchase puts ONE offer '
  + 'on the user\'s screen. Proposing never pays: the user alone confirms with the Buy button on the page, and is charged in $SWOGE only then. '
  + 'Never say the eSIM is bought. Say the offer is on screen ONLY when propose_esim_purchase succeeded in this answer; plan ids are not kept '
  + 'between messages, so when the user picks a plan from an earlier answer, call find_esim_plans again, then propose_esim_purchase. '
  + 'Ask for the destination and how much data or how many days if the user did not say, '
  + 'mention that the eSIM is data only (no phone number) and that the phone must support eSIM.';
function systemeDe(src) { return (src && src.embauche ? SYSTEME_EMBAUCHE : SYSTEME) + (src && src.achats ? SYSTEME_ACHATS : ''); }

/* ---- CE QUI N'EST PAS OFFERT (decision du proprietaire, 26 septembre 2026) ----
 * Les conditions de Telegram (« Terms of Service for Content Licensing »,
 * https://telegram.org/tos/content-licensing, relues le 26 septembre 2026)
 * interdisent « the scraping, indexing, harvesting, aggregation or use of data
 * obtained from its platform to [...] engage in the development, enhancement,
 * benchmarking or deployment of artificial intelligence [...] ». Un outil
 * PAYANT vendu a d'autres agents IA (`telegram_calls`) en est l'usage le plus
 * expose. Decision : la colonie continue de lire les apercus publics
 * (tg_canal, tg_appels, tg_decouverte) et la carte gratuite de la page SWOGE AI
 * les montre ; l'outil, lui, n'est offert NULLE PART — ni a l'agent des
 * joueurs (facture a l'usage), ni a l'API, ni au MCP, ni en x402, ni dans
 * openapi.json / llms.txt — tant que TG_APPELS_VENTE ne vaut pas '1'.
 * LE SEUL ROBINET : `definitions` ci-dessous. Tout ce qui liste un outil en
 * derive (agentic.js, agentic_mcp.js, decouverte.js, x402, les routes, le
 * llms.txt), et rien ne s'execute sans y etre : agentic.js refuse un outil
 * absent du catalogue, la boucle de `repond` n'execute que les outils DECLARES
 * au modele. Eteint, `telegram_calls` est donc un outil inconnu, exactement :
 * 404 avec une cle, 401 sans, -32602 en MCP, « unknown tool » pour le modele —
 * et rien de facture. Lu a chaque appel (pas au demarrage) : l'essai bascule
 * le reglage a chaud. TG_APPELS_NOTIFIE (vers NOTRE Telegram) n'y est pour rien. */
const NON_OFFERTS = () => (process.env.TG_APPELS_VENTE === '1' ? [] : ['telegram_calls']);

/* ---- LES DESCRIPTIONS : QUAND APPELER, PUIS CE QUI REVIENT (26 septembre 2026) ----
 * Elles nourrissent tout ce qu'un autre agent lit avant de choisir : le modele
 * de la page, /agentic/tools, le MCP, openapi.json (la PREMIERE phrase devient
 * le `summary`, que x402scan affiche tel quel), le manifeste x402 et llms.txt
 * (premiere phrase aussi). Un annuaire d'outils se parcourt par la tache, pas
 * par le nom : la premiere phrase dit donc QUAND appeler (« Use this when… »,
 * « Use this before… »), la suite ce qui revient, d'ou ca vient et ses limites.
 * Jamais « safe » : des mesures avec leur effectif. studio_agent.test.js le
 * verifie sur l'intention (premiere phrase), pas mot pour mot. */
/* Les outils que agentic.js ajoute pour l'API (ask_agent, generate_image,
   generate_video, video_status), a la meme regle — agentic.definitions les lit ici. */
const DESCRIPTIONS_API = Object.freeze({
  /* 27 septembre 2026 : les modeles d'IA payes a l'appel (chat_x402.js), vendus par l'API seulement. */
  chat_completion: 'Use this when you need an answer from a frontier AI model without an account or an API key: Claude (Opus, Fable, Sonnet, Haiku), GPT-6 or Grok, one call. '
    + 'OpenAI-style messages in, an OpenAI chat.completion out (choices, usage). The price is quoted before the call from your input and max_tokens at the model rate, '
    + 'plus a small margin; a failed call is not charged. Text only, no tools.',
  /* 27 septembre 2026 : les lectures Robinhood Chain (lectures_rh.js), vendues par l'API seulement. */
  robinhood_rpc: 'Use this when you need a raw read on Robinhood Chain (chain id 4663) without running a node: one read-only JSON-RPC call. '
    + 'Allowed: eth_blockNumber, eth_chainId, eth_gasPrice, eth_getBalance, eth_getCode, eth_getTransactionCount, eth_getStorageAt, eth_call, eth_estimateGas, '
    + 'eth_getTransactionByHash, eth_getTransactionReceipt, eth_getBlockByNumber and eth_getBlockByHash (headers), eth_getLogs (10,000 blocks, 500 logs at most). Returns the node answer as is.',
  robinhood_token: 'Use this when you need to know what a Robinhood Chain contract is before touching it: one call, decoded. '
    + 'Returns ERC-20 name, symbol, decimals and supply, the owner (or renounced), the EIP-1967 proxy implementation, the powers its code exposes (mint, blacklist, pause, fee setter; read in the implementation behind a proxy) and the DexScreener price, liquidity and market cap.',
  robinhood_wallet: 'Use this when you need the holdings of a Robinhood Chain address: ETH plus up to 20 tokens, read on-chain in one Multicall3 call. '
    + 'Returns each balance in units with its symbol and decimals, the DexScreener price and USD value when known (unknown stays null, never zero), and the total.',
  robinhood_tx: 'Use this when you need to understand what a Robinhood Chain transaction did. '
    + 'Returns its status, from, to, method, gas and fee in ETH and USD, every ERC-20 transfer decoded with symbol and amount, and the Uniswap v2, v3 or v4 swaps it contains.',
  /* 27 septembre 2026 : le verdict rapide, vendu par l'API seulement (verdict_jeton.js). */
  token_verdict: 'Use this when you must decide fast whether an EVM token is worth a closer look: one verdict you can branch on (red_flags, caution, unknown or no_red_flag_found) with its reasons. '
    + 'Judges the same data as scan_token: the GoPlus contract checks (Powered by Go+ Security, https://gopluslabs.io), the deepest DexScreener pool and, for Robinhood Chain tokens, the traits the SWOGE AI colony measured on past tokens. '
    + 'Each flag carries its source, and each colony figure its number of observations. no_red_flag_found only means none of the checks fired; never a buy or sell signal, and unknown stays unknown.',
  /* 28 septembre 2026 : le roast, vendu par l'API seulement (roast.js). */
  roast_token: 'Use this when you want a funny, shareable take on an EVM token for a post or a chat: SWOGE, a very muscular shiba inu, roasts it in 2 or 3 sentences built only on its real data. '
    + 'The facts are the same as token_verdict (DexScreener pool, GoPlus contract checks, Powered by Go+ Security, https://gopluslabs.io, and the SWOGE AI colony for Robinhood Chain tokens); the roast repeats a red flag only when a check actually raised it. '
    + 'Returns the roast, the facts behind it and a shareable 1200×630 PNG card with a share link whose preview is the card. Entertainment, never a buy or sell signal.',
  /* 28 septembre 2026 : les actions tokenisees de Robinhood Chain (actions_rh.js) ; stock_token_check offert aussi au joueur le soir. */
  stock_token_check: 'Use this before touching a stock token on Robinhood Chain (NVDA, TSLA, SPY…): it tells whether a contract is the official Robinhood Stock Token or a copy using the same ticker. '
    + 'Returns the verdict (official, impostor with the official address, or not a stock token), the official ISIN, status, multiplier and any pending corporate action, '
    + 'the deepest pool price and liquidity, and the premium of that pool to the Chainlink feed of the token (the feed address and its last update; its value is not republished).',
  stock_tokens_premium: 'Use this when you want the Robinhood Chain stock tokens whose on-chain pools trade furthest from their Chainlink feed. '
    + 'Returns the official tokens with both a feed and a pool above a minimum liquidity, sorted by absolute premium, with pool price, liquidity, quote currency and feed freshness. A premium is a measurement, never a trade signal.',
  /* 28 septembre 2026 : les lancements de Base (base_lancements.js) ; offerts aussi au joueur le soir. */
  base_launches: 'Use this when you want the newest memecoin launches on Base (Clanker v4 and Zora coins), read on-chain: each with its deployer and the deployer\'s MEASURED record. '
    + 'For each launch: platform, deployer, age, swaps since the launch block (first hour and 24 hours, from the Uniswap v4 PoolManager) and price change; for its deployer: how many of their earlier tokens were traded within 24 hours, '
    + 'against the reference of all launches (most get no swap at all). Below 5 judged tokens the record says so instead of comparing. Measurements, never a buy or sell signal.',
  base_deployer: 'Use this when you need the track record of an address that launches tokens on Base (Clanker v4 or Zora). '
    + 'Returns every launch we indexed with its swaps in the first hour and 24 hours and its price change, and the share traded within 24 hours against all launches, with its 95% interval. '
    + 'The window is what SWOGE indexed on-chain (it says since when); below 5 judged tokens it does not compare.',
  /* 28 septembre 2026 : le hasard prouvable (hasard.js), vendu par l'API seulement. */
  fair_commit: 'Use this before any draw other players must trust (a game between agents, a raffle, a giveaway): the server picks a secret seed and publishes its SHA-256 hash now, so it cannot change the seed later. '
    + 'Returns a commitment_id and the server_seed_hash to share with the players. Then call fair_draw.',
  fair_draw: 'Use this after fair_commit, once every player has seen the server_seed_hash: give your client_seed and get uniform random integers in [min, max]. '
    + 'The server reveals its seed with the draw; a commitment draws once (a second call returns the original draw). '
    + 'Algorithm ' + require('./hasard').ALGO + ': HMAC-SHA256(server_seed, client_seed:counter) read 4 bytes at a time, rejection sampling, no bias; the answer carries code that redoes it.',
  fair_verify: 'Use this to check a draw independently: recomputes the SHA-256 of a revealed server_seed against its hash, and the numbers of a ' + require('./hasard').ALGO + ' draw, '
    + 'or the 52-card shoe of a SWOGE casino hand (scheme swoge-casino-shoe with its nonce). Pure computation: nothing is stored.',
  ask_agent: 'Use this when a question needs several of these tools chained together and a written answer, for example comparing tokens or researching a launcher. '
    + 'SwogeAgentic, a Claude agent, picks the tools, reads the numbers and answers in Markdown with its sources and sample sizes. '
    + 'API key only: billed at its real cost, up to the quoted maximum ("quote": true gives it). Takes 10 to 60 seconds.',
  generate_image: 'Use this when you need an image: an illustration, a meme, a post visual, or the SWOGE character (a prompt that names SWOGE is drawn from the official character). '
    + 'Made with Grok Imagine (default) or ChatGPT Image, speed or quality, 1, 2 or 4 images. Returns image URLs. '
    + 'With an API key: billed at its real cost, up to the quoted maximum. Without a key (x402): a fixed price for that exact request, quoted in the 402.',
  generate_video: 'Use this when you need a short video clip, 6 or 10 seconds, made with Grok Imagine. '
    + 'Returns a video id at once; poll it with video_status (free) until it is done and gives its URL. '
    + 'API key only: billed at its real cost when the video arrives, up to the quoted maximum, nothing if it fails.',
  video_status: 'Use this when you started a video with generate_video and want to know whether it is ready. '
    + 'Returns pending, done with its URL, or failed and not charged, plus what was billed. Free.',
});

/* Les schemas d'entree des outils vendus par l'API ET offerts au joueur : une seule
   source (agentic.definitions les relit), pour que les deux ne divergent jamais. */
const SCHEMAS_API = Object.freeze({
  stock_token_check: { type: 'object', properties: {
    address: { type: 'string', description: 'a token contract on Robinhood Chain, 0x followed by 40 hex characters' },
    symbol: { type: 'string', description: 'or a ticker (NVDA, TSLA, SPY…) to get the official contract' } } },
  base_launches: { type: 'object', properties: {
    platform: { type: 'string', enum: ['all', 'clanker', 'zora'], description: 'default all' },
    limit: { type: 'integer', minimum: 1, maximum: 25, description: 'how many launches, newest first (default 10)' },
    traded_only: { type: 'boolean', description: 'only launches swapped at least once after their launch block' } } },
  base_deployer: { type: 'object', properties: {
    address: { type: 'string', description: 'the deployer address on Base, 0x followed by 40 hex characters' } }, required: ['address'] },
});

/* Les outils, au format de l'API Messages (name, description, input_schema). */
function definitions(actifs) {
  const d = [
    /* « Powered by Go+ Security » : la mention que la licence de l'API GoPlus
       demande (https://docs.gopluslabs.io/reference/api-license-agreement-new,
       relue le 26 septembre 2026). Dans la PREMIERE phrase : c'est elle que
       llms.txt et le resume d'openapi.json reprennent. */
    { name: 'scan_token', description: 'Use this before buying, listing or writing about an EVM token, to check its market and its contract in one call (contract security Powered by Go+ Security, https://gopluslabs.io). '
        + 'Give the contract address (0x…), on any chain DexScreener indexes. Returns the deepest pool (price, liquidity, market cap, 24 h volume and change, from DexScreener), '
        + 'the GoPlus contract checks where GoPlus covers the chain (honeypot, buy and sell tax, mint, pause, blacklist, hidden owner, holder concentration) and, for Robinhood Chain tokens, '
        + 'the average 30-minute move the SWOGE AI colony measured on past tokens sharing each trait, with its number of observations, plus a shareable scan card. '
        + 'Measurements, never a buy or sell signal; unknown stays unknown.',
      input_schema: { type: 'object', properties: { address: { type: 'string', description: 'EVM contract address, 0x followed by 40 hex characters' } }, required: ['address'] } },
    /* ---- AJOUTE LE 27 SEPTEMBRE 2026 : l'epreuve de sortie (epreuve_sortie.js) ----
       Ce que le Cobaye joue avant chaque achat de la colonie, pour un tiers.
       honeypot.is ne connait pas la chaine 4663 : peu d'autres le donnent. */
    { name: 'can_i_sell', description: 'Use this right before buying a Robinhood Chain token, to know whether you could sell it back and at what cost. '
        + 'Simulates the exit on-chain, read-only: real holders try to send the token to the pool, and a buy-then-sell round trip of a small order is quoted on Uniswap. '
        + 'Returns a verdict (sellable, costly, blocked, or partial when only the transfer could be tested), the round-trip return and cost, the transfer test and the share of LP tokens burned. '
        + 'Only an answer is billed: an unknown token or an untestable exit costs nothing. A simulation of now, never a buy or sell signal.',
      input_schema: { type: 'object', properties: { address: { type: 'string', description: 'token contract address on Robinhood Chain, 0x followed by 40 hex characters' } }, required: ['address'] } },
    { name: 'colony_activity', description: 'Use this when you want to know what the SWOGE AI colony, an autonomous paper-trading colony on Robinhood Chain, holds or did recently, overall or on one token. '
        + 'Returns its open positions, latest buys and sells with results and reasons, its paper ledger (trades, average result, share of winners) and the record of the mirror that repeats some trades with real money. '
        + 'Optionally filtered to one token symbol or address. Paper trades are measurements, never advice.',
      input_schema: { type: 'object', properties: { token: { type: 'string', description: 'optional token symbol (e.g. TELEPAD) or address to filter on' } } } },
    { name: 'swoge_economy', description: 'Use this when you need the current state of the $SWOGE token economy. '
        + 'Returns total supply, the amount burned and the casino vault balance (each with its share of supply), the staking APR and cap, read on-chain on Robinhood Chain, and the $SWOGE price in USD from DexScreener.',
      input_schema: { type: 'object', properties: {} } },
    /* ---- AJOUTES LE 26 SEPTEMBRE 2026 (etape 3 de SwogeAgentic) ----
       Trois lectures qui existaient deja sur le serveur, jamais exposees :
       ce que la colonie vient de trouver, l'historique d'un lanceur (OSINT
       passif sur une adresse), la reconnaissance passive d'une infrastructure. */
    { name: 'new_launches', description: 'Use this when you want the newest tokens on Robinhood Chain, minutes after their pool opens, with what an autonomous trading colony decided about each. '
        + 'Returns up to 30 fresh tokens (age, pool size, market cap, 5-minute move, score, and why the SWOGE AI colony did or did not buy it) and the older tokens it keeps watching with its verdict on each. '
        + 'Its contract checks use GoPlus data: Powered by Go+ Security (https://gopluslabs.io). Live reads, never advice.',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'how many fresh tokens (default 15)' } } } },
    { name: 'wallet_intel', description: 'Use this when you need to know who is behind an EVM address, typically a token deployer, before trusting what it launches. '
        + 'Returns findings first (such as repeat launching), then facts: the tokens it deployed on the launchpads the colony indexes and what the SWOGE AI colony measured on launchers like it (with observation counts), each with its source. '
        + 'Passive: the address is never contacted.',
      input_schema: { type: 'object', properties: { address: { type: 'string', description: 'EVM address, 0x followed by 40 hex characters' } }, required: ['address'] } },
    { name: 'osint_lookup', description: 'Use this when you need passive reconnaissance on internet infrastructure: a domain, an IP address, a website URL, an autonomous system (AS15169) or a CVE id. '
        + 'Returns findings first, then DNS, certificate, registration, hosting and exposure facts, each with its source. '
        + 'Passive only; people (e-mails, usernames, phone numbers, names) are refused.',
      input_schema: { type: 'object', properties: { target: { type: 'string', description: 'a domain, IP, URL, AS number or CVE id' } }, required: ['target'] } },
    /* ---- AJOUTE LE 26 SEPTEMBRE 2026 : l'agent qui suit les canaux Telegram (tg_appels.js) ---- */
    { name: 'telegram_calls', description: 'Use this when you want the Robinhood Chain tokens that public Telegram call channels are pushing, and how those calls did. '
        + 'Returns each call with its post link, price at detection, change since and best since, and a per-channel score counted on fresh calls only (none under 10 calls). Not advice.',
      input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'optional channel name to filter on' },
        hours: { type: 'integer', minimum: 1, maximum: 168, description: 'look back this many hours (default 24)' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'how many calls (default 20)' } } } },
  ];
  /* ---- L'EMBAUCHE (embauche.js, 28/09/2026) : offerte seulement a une tache d'un joueur
     connecte (src.embauche lie a SON adresse) — jamais a l'API, au MCP ni en x402. */
  if (actifs && actifs.embauche) d.push(
    { name: 'find_paid_services', description: 'Use this when none of your own tools can answer and an outside paid service might: it searches the public catalogue of x402 services (PayAI) for your need. '
        + 'Returns up to 6 services with their URL, what they do, their price in USD per call and how to call them (method and example inputs). Searching is free: nothing is paid.',
      input_schema: { type: 'object', properties: { need: { type: 'string', description: 'what you need, in a few English keywords (e.g. "weather forecast city")' } }, required: ['need'] } },
    { name: 'hire_paid_service', description: 'Use this when a service found with find_paid_services is worth its price for the task: the agent pays it in USDC from its own wallet and the user\'s balance is charged the price plus 10%. '
        + 'Only a URL returned by find_paid_services can be hired, at most 0.10 $ per call and 1 $ per user per day; nothing is charged if the service fails. '
        + 'Returns the service answer and a receipt (price, charge, network, transaction).',
      input_schema: { type: 'object', properties: { url: { type: 'string', description: 'the service URL, exactly as find_paid_services returned it' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'optional; the method find_paid_services gave' },
        query: { type: 'object', description: 'optional query parameters, for GET services' },
        body: { type: 'object', description: 'optional JSON body, for POST services' } }, required: ['url'] } });
  /* ---- L'eSIM (achats.js, 28/09/2026) : comme l'embauche, seulement pour un joueur connecte. */
  if (actifs && actifs.achats) d.push(
    { name: 'find_esim_plans', description: 'Use this when the user wants mobile data abroad (a travel eSIM): it lists data-only eSIM plans for a country or region '
        + 'with data, days and price (USD, and what the user would be charged). Searching is free: nothing is paid.',
      input_schema: { type: 'object', properties: { country: { type: 'string', description: 'the destination country in English, or its 2-letter code (e.g. "Japan", "FR")' },
        min_gb: { type: 'number', description: 'optional; at least this many GB' }, min_days: { type: 'integer', description: 'optional; valid at least this many days' } }, required: ['country'] } },
    { name: 'propose_esim_purchase', description: 'Use this when the user chose a plan from find_esim_plans: it shows the user ONE offer with a Buy button. '
        + 'It does NOT buy anything: the user confirms on the page, and only then is charged. The offer expires after 15 minutes.',
      input_schema: { type: 'object', properties: { plan: { type: 'string', description: 'the plan id, exactly as find_esim_plans returned it' } }, required: ['plan'] } });
  /* ---- LES MARCHES VOISINS, POUR LE JOUEUR (28/09/2026 au soir) ----
     Vendus aux autres agents depuis le matin, jamais offerts au joueur. Or c'est lui
     qui tombe sur la copie de NVDA (30 386 $ de liquidite le 28/09, a cote de
     l'officielle) ou qui achete un lancement Base. Seulement a la page (actifs.actions,
     actifs.base : src.joueur) : ask_agent garde son catalogue, donc son prix x402. */
  if (actifs && actifs.actions) d.push({ name: 'stock_token_check', description: DESCRIPTIONS_API.stock_token_check, input_schema: SCHEMAS_API.stock_token_check });
  if (actifs && actifs.base) d.push(
    { name: 'base_launches', description: DESCRIPTIONS_API.base_launches, input_schema: SCHEMAS_API.base_launches },
    { name: 'base_deployer', description: DESCRIPTIONS_API.base_deployer, input_schema: SCHEMAS_API.base_deployer });
  if (actifs && actifs.recherche) d.push({ name: 'web_search', description: 'Use this when the answer is outside SWOGE data: news, projects, teams, people, anything on the open web. '
    + 'Returns ranked results with title, URL, date and an extract (Perplexity Search).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'the search query, as you would type it' } }, required: ['query'] } });
  const retenus = NON_OFFERTS();
  return d.filter((x) => !retenus.includes(x.name)).map((x) => Object.assign({ eager_input_streaming: true }, x));
}

/* Les outils qu'une tache recoit, lus sur SA source (src de server.srcAgent). */
const actifsDe = (src) => ({ recherche: !!(src && src.recherche), embauche: !!(src && src.embauche), achats: !!(src && src.achats),
  actions: !!(src && src.joueur && src.actions), base: !!(src && src.joueur && src.base) });

/* ---- CE QUE CHAQUE APPEL RELIT VRAIMENT (28/09/2026 au soir) ----
   Mesure : un joueur connecte avec l'embauche, l'eSIM et la recherche recevait 13
   outils, 8 506 caracteres (4 253 jetons), et une consigne de 660 jetons ; le pire
   cas en comptait 3 000 et 500. Or la facture est PLAFONNEE a la reserve
   (studio_chat : « DÉPASSEMENT ») : la difference, jusqu'a 6 x 1 413 jetons par
   tache, etait payee par la maison. Les bornes deviennent ce que la tache envoie
   (un jeton pour deux caracteres), jamais sous les constantes mesurees : le prix
   x402 d'ask_agent, fixe sur OUTILS_JETONS, ne bouge pas. */
function jetonsDe(src) {
  return { outilsJetons: Math.max(OUTILS_JETONS, Math.ceil(JSON.stringify(definitions(actifsDe(src))).length / 2)),
    systemeJetons: Math.max(SYSTEME_JETONS, Math.ceil(systemeDe(src).length / 2)) };
}

/** Le pire cas d'une tâche, en USD avant marge — `messages` nettoyés par studio_chat.
 *  `limites` (facultatif, LIMITES_X402) : les bornes de l'agent vendu en x402 ;
 *  `limites.outilsJetons` / `systemeJetons` (jetonsDe) : ce que CETTE tâche relit. */
function pireCasUsd(m, messages, recherche, limites) {
  const L = limites || {};
  const E = L.etapesMax || ETAPES_MAX, T = L.outilsParEtape || OUTILS_PAR_ETAPE, R = L.resultatCarMax || RESULTAT_CAR_MAX, S = L.sortieMax || SORTIE_MAX;
  const car = (messages || []).reduce((s, x) => s + String(x.content || '').length, 0);
  const sortie = Math.min(m.maxTokens, S);
  const base = Math.ceil(car / 2) + (L.systemeJetons || SYSTEME_JETONS) + (L.outilsJetons || OUTILS_JETONS);
  const parEtape = sortie + T * Math.ceil(R / 2);
  /* L'appel k (0…E−1) relit la base et tout ce que les k précédents ont ajouté. */
  let entree = 0;
  for (let k = 0; k < E; k++) entree += base + k * parEtape;
  /* E × T recherches : un peu trop (le dernier appel n'a pas d'outils), du bon côté. */
  const recherches = recherche ? E * T : 0;
  return entree * m.entree / 1e6 + E * sortie * m.sortie / 1e6 + recherches * PRIX_RECHERCHE_USD;
}
/* Le coût réel d'UN appel, lu dans son `usage` (écritures de cache à 1,25×, lectures à 0,1× —
   la même règle que studio_chat.coutUsd ; la boucle n'allume jamais le cache). */
const coutAppelUsd = (m, u) => (((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * m.entree
  + (u.output_tokens || 0) * m.sortie) / 1e6;

const adresseOk = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
/* L'OSINT offert aux autres agents ne vise que l'INFRASTRUCTURE : vendre a
   n'importe quel agent une recherche sur des personnes, en serie, serait
   offrir du profilage. Le module sait faire plus ; ce n'est pas exposé ici. */
const OSINT_TYPES = ['domaine', 'ip', 'url', 'asn', 'cve'];
/* ---- UN RAPPORT OSINT, EN DONNEES (26 septembre 2026) ----
 * C'etait un texte (« Target: … Findings: … Facts: … ») : l'agent de la page le
 * lisait tres bien, mais l'API rend `resultat` en analysant le texte comme du
 * JSON (agentic.resultatDe) — wallet_intel et osint_lookup, vendus 0,02 $,
 * rendaient donc `resultat: null`. Memes bornes qu'avant (10 constats, 30
 * faits, 160 caracteres, 2 sources), memes champs, constats d'abord ; les
 * types de cible en anglais. */
const TYPES_EN = { adresse: 'address', domaine: 'domain', ip: 'ip', url: 'url', asn: 'asn', cve: 'cve' };
function rapportOsint(r) {
  return {
    target: r && r.cible ? { type: TYPES_EN[r.cible.type] || r.cible.type, value: r.cible.valeur } : null,
    passive: true,
    findings: ((r && r.constats) || []).slice(0, 10).map((c) => ({ severity: c.etiquette, text: c.dit })),
    facts: ((r && r.faits) || []).slice(0, 30).map((f) => ({ predicate: f.predicat,
      value: String(f.valeur || (f.objet && f.objet.valeur) || f.extrait || '').slice(0, 160), sources: (f.sources || []).slice(0, 2) })),
    factCount: ((r && r.faits) || []).length,
  };
}

/* ---- LE SCAN D'UN JETON, EN ANGLAIS ET AVEC SES LIENS (26 septembre 2026) ----
 * La fiche (studio_jeton) porte les cases de la colonie sous leurs CLES
 * internes (« octEmit = code : sans emission ») : l'agent qui paie les lisait
 * telles quelles, et quatre fois la meme mesure (le bytecode lu une fois,
 * range sous quatre traits). On passe par carte_scan.casesEnAnglais — la
 * traduction et le dedoublonnage de la carte partagee — sur une COPIE : la
 * fiche est en cache, et la page SwoleMind la lit aussi. */
/* Traduites et dedoublonnees sur TOUTES les cases (`toutes`), puis coupees a
   6 — au moins les 5 lignes de la carte gratuite. Coupees avant (les 6 cases
   brutes de la fiche), LOBSTER rendait 3 lignes a l'agent qui paie contre 5 sur
   la carte gratuite (releve du 26 septembre 2026). */
const LIGNES_VENDUES = 6;
function ficheEnAnglais(f, assez) {
  if (!f || !f.colonie || !Array.isArray(f.colonie.cases)) return f;
  const brutes = Array.isArray(f.colonie.toutes) ? f.colonie.toutes : f.colonie.cases;
  const cases = require('./carte_scan').casesEnAnglais(brutes).slice(0, LIGNES_VENDUES)
    .map((c) => ({ trait: c.traitLabel, case: c.label, n: c.n, moyenne: c.moyenne, assez: c.n >= (assez || 30) }));
  const colonie = Object.assign({}, f.colonie, { cases });
  delete colonie.toutes;
  return Object.assign({}, f, { colonie });
}
const coupe = (s, max) => { s = String(s); const k = max || RESULTAT_CAR_MAX; return s.length > k ? s.slice(0, k) + '\n[truncated]' : s; };

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
      const adr = String(e.address).toLowerCase();
      const f = ficheEnAnglais(await src.fiche(adr), src.Jeton.OBS_ASSEZ);
      const carte = src.Jeton.carte(f);
      let texte = src.Jeton.contexte([f]);
      /* La carte partageable existe quand la colonie connait le jeton (sa route relit le meme scan). */
      if (f && f.colonie && src.liensScan) {
        carte.links = src.liensScan(adr);
        texte += '\n\nShareable scan card (PNG): ' + carte.links.card + ' — share page (link preview on X, Telegram, Discord): ' + carte.links.share;
      }
      return { texte, carte, sources: src.Jeton.sources([f]) };
    },
    /* Le verdict rapide (verdict_jeton.js, 27/09/2026) : la MEME fiche que
       scan_token, jugee — vendu par l'API seulement (agentic.definitions),
       jamais offert a l'agent de la page (sa borne d'outils, OUTILS_JETONS). */
    async token_verdict(e) {
      if (!adresseOk(e.address)) return { erreur: 'address must be 0x followed by 40 hex characters' };
      const V = require('./verdict_jeton');
      const adr = String(e.address).toLowerCase();
      const f = await src.fiche(adr);
      const v = V.juge(f);
      let texte = V.texte(v);
      /* La carte partageable, comme scan_token (28/09/2026) : un verdict qu'un agent
         poste sur X ou Telegram porte l'image SWOGE et son lien — c'est l'outil le
         moins cher, donc le plus appele. Seulement quand la colonie connait le jeton :
         la route de la carte relit son scan. */
      if (f && f.colonie && src.liensScan) {
        v.links = src.liensScan(adr);
        texte += '\n\nShareable card (PNG): ' + v.links.card + ' — share page (link preview on X, Telegram, Discord): ' + v.links.share;
      }
      return { texte, donnees: v };
    },
    /* L'embauche (embauche.js, 28/09/2026) : src.embauche est lie a l'adresse du joueur. */
    async find_paid_services(e) {
      if (!src.embauche) return { erreur: 'hiring outside services is not available here' };
      const l = await src.embauche.cherche(e && e.need, 6);
      if (!l.length) return { texte: 'No paid service in the catalogue matches "' + String((e && e.need) || '').slice(0, 80) + '". Nothing was paid.' };
      const b = src.embauche.budget ? src.embauche.budget() : null;
      return { texte: l.map((s, i) => (i + 1) + '. ' + s.url + ' — ' + s.usd + ' $ per call, ' + s.methode + (s.description ? ' — ' + s.description : '')
          + ((s.entree.queryParams || s.entree.body) ? '\n   example inputs: ' + JSON.stringify(s.entree.queryParams || s.entree.body).slice(0, 300) : '')).join('\n')
        + (b ? '\n\nUser budget today: ' + b.depenseUsd + ' $ spent of ' + b.jourUsd + ' $ (at most ' + b.maxAppelUsd + ' $ per call). Searching was free.' : '') };
    },
    async hire_paid_service(e) {
      if (!src.embauche) return { erreur: 'hiring outside services is not available here' };
      const r = await src.embauche.embauche(e || {});
      if (!r || !r.ok) return { erreur: (r && r.raison) || 'the service could not be hired - nothing was charged' };
      const c = r.recu;
      return { texte: 'Service answer (' + (r.type || 'unknown type') + '):\n' + r.resultat
          + '\n\nReceipt: ' + (r.gratuit ? 'the service answered without asking for payment; nothing was charged.'
            : 'paid ' + c.usd + ' $ to ' + c.url + ' on ' + (c.reseau === 'eip155:8453' ? 'Base' : 'Solana') + ', charged the user ' + c.factureUsd + ' $ in $SWOGE' + (c.tx ? ', transaction ' + c.tx : '') + '.'),
        donnees: c };
    },
    /* L'eSIM (achats.js, 28/09/2026) : src.achats est lie a l'adresse du joueur. */
    async find_esim_plans(e) {
      if (!src.achats) return { erreur: 'eSIM purchases are not available here' };
      const r = await src.achats.forfaits({ pays: e && e.country, go: e && e.min_gb, jours: e && e.min_days });
      if (!r || !r.ok) return { erreur: (r && r.raison) || 'the eSIM shop did not answer' };
      const hf = r.horsFonds ? ' ' + r.horsFonds + ' more plan(s) cost more than the shop can pay right now: they cannot be offered, do not mention them as options.' : '';
      if (!r.forfaits.length) return { texte: 'No plan for ' + r.destination.nom + ' can be bought right now within the ' + r.plafondUsd + ' $ limit.' + hf
        + (r.destination.autres.length ? ' Other destinations covering it: ' + r.destination.autres.join('; ') + '.' : '') };
      return { texte: 'Data-only eSIM plans for ' + r.destination.nom + ' (cheapest per GB first; ' + r.total + ' plans in total, the ones shown were priced just now):\n'
          + r.forfaits.map((f, i) => (i + 1) + '. ' + f.nom + ' — ' + f.go + ' GB, ' + f.jours + ' days — ' + f.usd + ' $ (the user is charged ' + f.factureUsd + ' $ in $SWOGE) — plan id: ' + f.plan).join('\n')
          + (r.destination.autres.length ? '\nOther destinations covering it: ' + r.destination.autres.join('; ') + '.' : '')
          + hf + '\nSeller: CHIPS (terms ' + r.conditions + '); check the phone supports eSIM: ' + r.compatibles + '. Nothing was paid.', donnees: r };
    },
    async propose_esim_purchase(e) {
      if (!src.achats) return { erreur: 'eSIM purchases are not available here' };
      const r = await src.achats.propose({ plan: e && e.plan });
      if (!r || !r.ok) return { erreur: (r && r.raison) || 'the offer could not be made - nothing was charged' };
      const o = r.offre;
      return { texte: 'Offer shown to the user: ' + o.nom + ' (' + o.go + ' GB, ' + o.jours + ' days) for ' + o.factureUsd + ' $ in $SWOGE. '
          + 'Nothing is bought yet: the user must press Buy on the page within 15 minutes. Do not say it is bought.', achat: o };
    },
    /* Les actions tokenisees (actions_rh.js, 28/09/2026) : l'API, et le joueur pour stock_token_check. */
    async stock_token_check(e) {
      if (!src.actions) return { erreur: 'stock token checks are not available here' };
      const r = await src.actions.verifie({ address: e && e.address, symbol: e && e.symbol });
      if (r.erreur) return { erreur: r.erreur };
      const m = r.market || {};
      return { texte: (r.verdict === 'official' ? 'OFFICIAL Robinhood Stock Token ' + r.official.symbol + ' (' + r.official.address + ')'
          : r.verdict === 'impostor' ? 'IMPOSTOR: ' + r.warning : 'Not a Robinhood Stock Token (' + r.checked + ').')
          + (r.official ? ' Pool ' + (m.pool ? m.pool.priceUsd + ' $ (' + m.pool.liquidityUsd + ' $ liquidity)' : 'unknown') + ', premium to the Chainlink feed ' + (m.premiumToOraclePct === null ? 'unknown' : m.premiumToOraclePct + '%')
            + (r.official.corporateActionPending ? '. Corporate action pending (multiplier ' + r.official.multiplier + ' → ' + r.official.pendingMultiplier + ').' : '.') : ''), donnees: r };
    },
    async stock_tokens_premium(e) {
      if (!src.actions) return { erreur: 'stock token checks are not available here' };
      const r = await src.actions.ecarts({ limit: e && e.limit, min_liquidity_usd: e && e.min_liquidity_usd });
      if (r.erreur) return { erreur: r.erreur };
      return { texte: r.compared + ' official stock tokens compared (' + r.officialTokens + ' official, ' + r.withOracle + ' with a feed). '
        + r.tokens.map((t) => t.symbol + ' ' + t.premiumToOraclePct + '%').join(', '), donnees: r };
    },
    /* Les lancements de Base (base_lancements.js, 28/09/2026) : l'API et le joueur. */
    async base_launches(e) {
      if (!src.base) return { erreur: 'Base launches are not available here' };
      const r = src.base.recents({ platform: e && e.platform, limit: e && e.limit, traded_only: !!(e && e.traded_only) });
      const ref = r.reference;
      return { texte: r.launches.length + ' newest Base launches (Clanker, Zora). Reference: ' + (ref.judged ? ref.tradedWithin24hPct + '% of ' + ref.judged + ' judged launches were traded within 24 h' : 'no launch judged yet')
          + '. Window since ' + r.window.indexedSince + '.\n' + r.launches.map((l) => '- ' + l.symbol + ' (' + l.platform + ', ' + l.ageMinutes + ' min) ' + l.token + ', deployer ' + l.deployer
            + ': ' + l.swaps24h + ' swaps; deployer record ' + (l.deployerRecord.enough ? l.deployerRecord.tradedWithin24hPct + '% traded of ' + l.deployerRecord.judged : l.deployerRecord.note)).join('\n'),
        donnees: r };
    },
    async base_deployer(e) {
      if (!src.base) return { erreur: 'Base launches are not available here' };
      if (!adresseOk(e && e.address)) return { erreur: 'address must be 0x followed by 40 hex characters' };
      const r = src.base.createur(e.address);
      const b = r.record;
      return { texte: 'Deployer ' + r.address + ' on Base: ' + b.tokens + ' launches indexed since ' + r.window.indexedSince + ', ' + b.judged + ' judged. '
          + (b.enough ? b.tradedWithin24hPct + '% traded within 24 h (95% ' + b.ci95.join('-') + '%), against ' + r.reference.tradedWithin24hPct + '% for all launches.' : b.note + '.'), donnees: r };
    },
    /* Le hasard prouvable (hasard.js, 28/09/2026) : vendu par l'API seulement. */
    async fair_commit() {
      if (!src.hasard) return { erreur: 'provably fair draws are not available here' };
      const r = src.hasard.engage();
      const d = Object.assign({}, r); delete d.ok;
      return { texte: 'Commitment ' + r.commitment_id + ': server_seed_hash ' + r.server_seed_hash + ' (' + r.algorithm + '), valid until ' + r.expires_at + '. ' + r.next, donnees: d };
    },
    async fair_draw(e) {
      if (!src.hasard) return { erreur: 'provably fair draws are not available here' };
      const r = src.hasard.tire(e || {});
      if (!r.ok) return { erreur: r.erreur };
      const d = Object.assign({}, r); delete d.ok;
      return { texte: (r.already_drawn ? 'Already drawn (original draw): ' : 'Draw: ') + r.numbers.join(', ') + ' in [' + r.min + ', ' + r.max + ']. server_seed ' + r.server_seed
        + ' (hash ' + r.server_seed_hash + '), client_seed "' + r.client_seed + '".', donnees: d };
    },
    async fair_verify(e) {
      if (!src.hasard) return { erreur: 'provably fair draws are not available here' };
      const r = src.hasard.verifie(e || {});
      if (!r.ok) return { erreur: r.erreur };
      const d = Object.assign({}, r); delete d.ok;
      return { texte: 'Hash ' + (r.hash_matches === null ? 'not given' : r.hash_matches ? 'matches' : 'does NOT match') + '. '
        + (r.cards ? 'Shoe: ' + r.cards.join(' ') : 'Numbers: ' + r.numbers.join(', ') + (r.numbers_match === null ? '' : r.numbers_match ? ' (match the claimed draw)' : ' (do NOT match the claimed draw)')) + '.', donnees: d };
    },
    /* Le roast (roast.js, 28/09/2026) : vendu par l'API seulement. */
    async roast_token(e) {
      if (!src.roast) return { erreur: 'roasts are not switched on' };
      const r = await src.roast.roast(e && e.address);
      if (!r || r.erreur) return { erreur: (r && r.erreur) || 'the roast failed - nothing was charged' };
      return { texte: r.texte, donnees: r.donnees };
    },
    /* Les lectures Robinhood Chain (lectures_rh.js) : vendues par l'API seulement. */
    robinhood_rpc: (e) => (src.lectures ? src.lectures.robinhood_rpc(e) : { erreur: 'Robinhood Chain reads are not switched on' }),
    robinhood_token: (e) => (src.lectures ? src.lectures.robinhood_token(e) : { erreur: 'Robinhood Chain reads are not switched on' }),
    robinhood_wallet: (e) => (src.lectures ? src.lectures.robinhood_wallet(e) : { erreur: 'Robinhood Chain reads are not switched on' }),
    robinhood_tx: (e) => (src.lectures ? src.lectures.robinhood_tx(e) : { erreur: 'Robinhood Chain reads are not switched on' }),
    async can_i_sell(e) {
      if (!src.sortie) return { erreur: 'the exit test is not switched on' };
      const r = await src.sortie.verifie(e && e.address);
      if (!r || !r.resultat) return { erreur: (r && r.erreur) || 'the exit could not be tested — nothing was charged' };
      return { texte: src.sortie.texte(r), donnees: r.resultat };
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
    async telegram_calls(e) {
      if (!src.appels) return { erreur: 'telegram call tracking is not switched on' };
      const r = src.appels({ channel: e && e.channel, hours: e && e.hours, limit: e && e.limit });
      return { texte: JSON.stringify(r) };
    },
    async new_launches(e) {
      const v = src.vue() || {};
      const n = Math.max(1, Math.min(30, parseInt((e && e.limit) || 15, 10) || 15));
      const frais = (v.candidats || []).slice().sort((a, b) => (a.minutes || 0) - (b.minutes || 0)).slice(0, n).map((c) => ({
        sym: c.sym, address: c.addr, ageMinutes: c.minutes, poolUsd: c.liq, capUsd: c.mc, change5mPct: c.ch_m5, score: c.score,
        decision: c.refus ? 'not bought: ' + c.refus : 'passed the colony\'s gates', origin: c.origine }));
      const suivis = (v.surveillance || []).slice(0, 15).map((w) => ({ sym: w.sym, address: w.addr, timesSeen: w.vu, poolUsd: w.liq, verdict: w.verdict }));
      /* La licence GoPlus (decision du 26 septembre 2026) : ces decisions sont
         aussi des donnees GoPlus. Un refus du Warden EST la phrase GoPlus
         (ai_colonie.vetoWarden : « honeypot », « sell tax 25% »...), celui du
         Whale peut venir du `top` GoPlus quand la chaine n'a pas ete lue, et
         la note comme « passed the colony's gates » tiennent compte de GoPlus
         des qu'il connait le jeton. La mention part donc TOUJOURS, en donnees
         (`attribution`, reprise telle quelle par agentic.resultatDe : cle, MCP,
         x402) et dans la note que lit le modele — une forme stable, sans
         deviner jeton par jeton d'ou vient chaque verdict. */
      const A = src.Jeton.ATTRIBUTION;
      return { texte: JSON.stringify({ note: 'Live reads of the SWOGE AI colony on Robinhood Chain: measurements and decisions, never advice. Contract safety verdicts: '
          + A.security + ' (' + A.url + ').', fresh: frais, watched: suivis, attribution: { security: A.security, url: A.url } }) };
    },
    async wallet_intel(e) {
      if (!adresseOk(e && e.address)) return { erreur: 'address must be 0x followed by 40 hex characters' };
      const r = await src.osint('adresse', String(e.address).toLowerCase());
      return { texte: JSON.stringify(rapportOsint(r)) };
    },
    async osint_lookup(e) {
      const g = src.detecte(String((e && e.target) || '').trim().slice(0, 300));
      if (!g) return { erreur: 'not a recognised target: give a domain, an IP address, a URL, an AS number or a CVE id' };
      if (!OSINT_TYPES.includes(g.type)) return { erreur: 'only infrastructure is accepted here (domain, IP, URL, AS number, CVE) — not people, e-mails, usernames or phone numbers' };
      const r = await src.osint(g.type, g.valeur);
      return { texte: JSON.stringify(rapportOsint(r)) };
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
async function repond({ m, messages, surTexte, surReflexion, surOutil, surResultat, signal }, deps) {
  const c = (deps && deps.client) || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 180000 });
  const O = outils(deps.src);
  const tools = definitions(actifsDe(deps.src));
  const systeme = systemeDe(deps.src);
  /* Seul un outil DECLARE s'execute : un nom que le modele invente, ou un outil
     non offert (NON_OFFERTS) qu'il appellerait quand meme, est « inconnu ». */
  const declares = new Set(tools.map((t) => t.name));
  const fil = messages.map((x) => ({ role: x.role, content: x.content }));
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, recherches_perplexity: 0 };
  const textes = [], sources = [], cartes = [];
  let stop = null, servi = m.api, etapes = 0;
  /* ---- LA GARDE EN DIRECT (x402 seulement : deps.limites) ----
     Sans `limites`, tout est comme avant (page, API a cle, essais). */
  const L = deps.limites || null;
  const etapesMax = L ? L.etapesMax : ETAPES_MAX;
  const outilsMax = L ? L.outilsParEtape : OUTILS_PAR_ETAPE;
  const resultatMax = L ? L.resultatCarMax : RESULTAT_CAR_MAX;
  const sortieMax = L ? L.sortieMax : SORTIE_MAX;
  const plafond = L && deps.budgetUsd > 0 ? Number(deps.budgetUsd) : null;
  const horloge = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const debut = horloge();
  let depense = 0, supplement = 0, arretBudget = false, arretDelai = false, delaiAtteint = false;
  /* Le delai TENU DANS LA BOUCLE : le `signal` existant jette « stopped » et
     studio_chat en fait un 409 qui perd texte et usage (studio_agent.js
     repond, studio_chat.js repondSuite) ; ici, a 150 s, l'appel en vol est
     coupe et la tache rend ce qu'elle a. */
  let ctlDelai = null, minuterie = null;
  if (L) {
    ctlDelai = new AbortController();
    /* PAS unref : c'est elle qui debloque un appel pendu (effacee dans le finally). */
    minuterie = setTimeout(() => { delaiAtteint = true; ctlDelai.abort(); }, Math.max(1, L.dureeMaxS * 1000 - (horloge() - debut)));
  }
  const signalAppel = ctlDelai ? (signal ? AbortSignal.any([signal, ctlDelai.signal]) : ctlDelai.signal) : signal;
  /* countTokens avec nos outils : `eager_input_streaming` retire de la COPIE comptee seulement
     (son acceptation par countTokens n'est pas verifiee, contrat §D.4.1). */
  const toolsCompte = tools.map((t) => { const x = Object.assign({}, t); delete x.eager_input_streaming; return x; });
  const compte = async () => {
    try {
      const r = await c.messages.countTokens({ model: m.api, system: systeme, tools: toolsCompte, messages: fil });
      if (r && r.input_tokens > 0) return r.input_tokens;
    } catch (e) { /* compte impossible : un jeton par caractere, pessimiste expres */ }
    return JSON.stringify([systeme, toolsCompte, fil]).length;
  };

  try {
    while (etapes < etapesMax) {
      /* Arrêté par le joueur : pas d'étape de plus (et le flux en cours est coupé par le signal). */
      if (signal && signal.aborted) throw Object.assign(new Error('stopped'), { arrete: true });
      if (L && (delaiAtteint || horloge() - debut >= L.dureeMaxS * 1000)) { arretDelai = true; break; }
      /* Au dernier appel permis, il doit conclure avec ce qu'il a : les outils
         restent DECLARES (l'historique porte des blocs tool_use) mais
         `tool_choice: none` les interdit — accepte par tous les modeles, quand
         `any`/`tool` rendent un 400 sur Opus 5.5 et Fable 5.1 (doc relue). */
      let dernier = etapes + 1 === etapesMax;
      if (L && horloge() - debut >= L.finalApresS * 1000) dernier = true;
      const maxTok = Math.min(m.maxTokens, sortieMax);
      let pireAppel = 0;
      if (plafond !== null) {
        const n = await compte();
        pireAppel = n * MARGE_COMPTE * m.entree / 1e6 + maxTok * m.sortie / 1e6;
        /* Cet appel pourrait crever le plafond : il n'est pas fait. */
        if (depense + pireAppel > plafond) { arretBudget = true; break; }
        /* Un tour d'outils de plus seulement si une reponse finale tient encore
           apres lui (resultats comptes a un jeton par caractere, pessimiste expres). */
        const pireFinal = (n + maxTok + outilsMax * resultatMax) * m.entree / 1e6 * MARGE_COMPTE + maxTok * m.sortie / 1e6;
        if (!dernier && depense + pireAppel + pireFinal > plafond) dernier = true;
      }
      etapes++;
      const params = { model: m.api, max_tokens: maxTok, system: systeme, messages: fil, tools };
      if (dernier) params.tool_choice = { type: 'none' };
      const opts = signalAppel ? { signal: signalAppel } : undefined;
      let texteEtape = '', msg;
      try {
        const flux = m.repli
          ? c.beta.messages.stream(Object.assign({}, params, { betas: ['server-side-fallback-2026-06-01'], fallbacks: [{ model: m.repli }] }), opts)
          : c.messages.stream(params, opts);
        for await (const ev of flux) {
          if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking' && surReflexion) surReflexion();
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            if (!texteEtape && textes.length && surTexte) surTexte('\n\n');
            texteEtape += ev.delta.text;
            if (surTexte) surTexte(ev.delta.text);
          }
        }
        msg = await flux.finalMessage();
      } catch (e) {
        /* Le delai de la garde : l'appel en vol est coupe, on rend ce qu'on a (son cout
           n'est pas connu : on compte son pire cas, du bon cote). */
        if (delaiAtteint && !(signal && signal.aborted)) {
          if (texteEtape) textes.push(texteEtape);
          supplement += pireAppel;
          arretDelai = true;
          break;
        }
        /* Toute autre panne (529, reseau…) sous la garde : l'appel en vol compte a son pire
           cas, du bon cote — la depense deja faite part avec l'erreur (voir plus bas). */
        if (L) supplement += pireAppel;
        throw e;
      }
      const u = msg.usage || {};
      usage.input_tokens += u.input_tokens || 0; usage.output_tokens += u.output_tokens || 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens || 0; usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
      depense += coutAppelUsd(m, u);
      servi = msg.model || servi; stop = msg.stop_reason || null;
      if (texteEtape) textes.push(texteEtape);

      const appels = (msg.content || []).filter((b) => b.type === 'tool_use');
      if (stop !== 'tool_use' || !appels.length) break;          /* end_turn, refusal, max_tokens : on s'arrête */
      if (dernier && L) break;                                    /* forcé dernier (garde) : aucun outil de plus */
      fil.push({ role: 'assistant', content: msg.content });
      const resultats = [];
      for (let i = 0; i < appels.length; i++) {
        const b = appels[i];
        if (i >= outilsMax || !declares.has(b.name) || !O[b.name] || !b.input || typeof b.input !== 'object') {
          resultats.push({ type: 'tool_result', tool_use_id: b.id, is_error: true,
            content: i >= outilsMax ? 'at most ' + outilsMax + ' tools per step' : 'unknown tool or unreadable input' });
          continue;
        }
        /* La recherche coute 0,005 $ : refusee si elle crevait le plafond. */
        if (plafond !== null && b.name === 'web_search' && depense + PRIX_RECHERCHE_USD > plafond) {
          resultats.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'search budget reached' });
          continue;
        }
        if (surOutil) surOutil({ id: b.id, nom: b.name, entree: b.input });
        let r;
        try { r = await O[b.name](b.input); } catch (e) { r = { erreur: 'the tool failed: ' + String(e && e.message || e).slice(0, 120) }; }
        if (r.recherche) { usage.recherches_perplexity += r.recherche; depense += r.recherche * PRIX_RECHERCHE_USD; }
        if (r.sources) for (const s of r.sources) if (!sources.some((x) => x.url === s.url)) sources.push(s);
        if (r.carte) cartes.push(r.carte);
        if (surResultat) surResultat({ id: b.id, nom: b.name, ok: !r.erreur, resume: r.erreur || coupe(r.texte || '', resultatMax).slice(0, 280), carte: r.carte || null, achat: r.achat || null });
        resultats.push(r.erreur ? { type: 'tool_result', tool_use_id: b.id, is_error: true, content: r.erreur }
                                : { type: 'tool_result', tool_use_id: b.id, content: coupe(r.texte || '', resultatMax) });
      }
      fil.push({ role: 'user', content: resultats });
    }
  } catch (e) {
    /* x402 (contrat §D.6) : une execution qui echoue APRES avoir depense doit porter ce
       qu'elle a coute jusqu'au registre des pertes — sinon le plafond du jour sous-compte.
       studio_chat.repond (horsSolde) le rend en `coutUsd`. */
    if (L && e && typeof e === 'object') e.coutUsd = depense + supplement;
    throw e;
  } finally { if (minuterie) clearTimeout(minuterie); }
  const out = { texte: textes.join('\n\n'), sources, usage, stop: arretBudget ? 'budget' : arretDelai ? 'time' : stop === 'tool_use' ? 'max_steps' : stop, servi, jetons: cartes, etapes };
  /* x402 : ce qui a ete depense (cout reel des appels finis + recherches + pire cas d'un appel coupe). */
  if (L) Object.assign(out, { coutUsd: depense + supplement, coutSupplementUsd: supplement, arretBudget, arretDelai });
  return out;
}

module.exports = { repond, definitions, actifsDe, jetonsDe, SCHEMAS_API, outils, NON_OFFERTS, pireCasUsd, coutAppelUsd, SYSTEME, SYSTEME_EMBAUCHE, SYSTEME_ACHATS, systemeDe, OSINT_TYPES, rapportOsint, ficheEnAnglais, DESCRIPTIONS_API, OUTILS_JETONS, SYSTEME_JETONS,
  ETAPES_MAX, OUTILS_PAR_ETAPE, RESULTAT_CAR_MAX, SORTIE_MAX, PRIX_RECHERCHE_USD, LIMITES_X402, BUDGET_X402_USD, MARGE_COMPTE };
