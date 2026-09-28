# Bibliotheque commune : chargement du catalogue PayAI, normalisation, categories.
import json, re, collections
from urllib.parse import urlparse

import os
SCR = os.path.dirname(os.path.abspath(__file__))  # le catalogue brut (cat.jsonl) se retelecharge : voir le rapport

# Actifs dont on connait la nature (adresse officielle du contrat / mint).
USDC = {
    ('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
    ('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
    ('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'.lower(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'.lower()),
    ('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'.lower()),
    ('eip155:137', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
    ('polygon', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
    ('eip155:42161', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    ('eip155:43114', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'),
    # testnets
    ('eip155:84532', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'),
    ('base-sepolia', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'),
    ('solana-devnet', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'.lower()),
    ('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'.lower(), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'.lower()),
}
TESTNETS = {'eip155:84532', 'base-sepolia', 'solana-devnet', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            'eip155:80002', 'xlayer-testnet', 'sei-testnet'}
NOM_RESEAU = {
    'eip155:8453': 'Base', 'base': 'Base',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana', 'solana': 'Solana',
    'eip155:84532': 'Base Sepolia (test)', 'base-sepolia': 'Base Sepolia (test)',
    'solana-devnet': 'Solana devnet (test)', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana devnet (test)',
    'eip155:137': 'Polygon', 'polygon': 'Polygon', 'eip155:80002': 'Polygon Amoy (test)',
    'eip155:42161': 'Arbitrum', 'eip155:43114': 'Avalanche', 'eip155:196': 'X Layer', 'xlayer': 'X Layer',
    'xlayer-testnet': 'X Layer testnet (test)', 'eip155:1329': 'Sei', 'sei-testnet': 'Sei testnet (test)',
    'peaq': 'peaq', 'eip155:1187947933': 'eip155:1187947933 (SKALE, declare)', 'eip155:1952': 'eip155:1952 (inconnu)',
}


def charge():
    items = []
    for l in open(f'{SCR}/cat.jsonl'):
        items += json.loads(l)['items']
    return items


def texte(i):
    a = i['accepts'][0]
    parts = [i['resource'], i.get('description') or '', (i.get('metadata') or {}).get('description') or '',
             a.get('description') or '', i.get('serviceName') or '', ' '.join(i.get('tags') or []), i.get('toolName') or '']
    return ' '.join(p for p in parts if p)


def desc(i):
    a = i['accepts'][0]
    return (i.get('description') or (i.get('metadata') or {}).get('description') or a.get('description') or '').strip()


def methode(i):
    if i.get('method'):
        return i['method']
    a = i['accepts'][0]
    m = ((a.get('outputSchema') or {}).get('input') or {}).get('method')
    if m:
        return m
    b = (((i.get('extensions') or {}).get('bazaar') or {}).get('info') or {}).get('input') or {}
    return b.get('method')


def prix(i):
    """(usd ou None, actif_libelle). USD seulement pour USDC connu (6 decimales)."""
    a = i['accepts'][0]
    net = a.get('network') or ''
    asset = (a.get('asset') or '').lower()
    amt = a.get('amount') if i['x402Version'] == 2 else a.get('maxAmountRequired')
    if amt is None:
        amt = a.get('amount') or a.get('maxAmountRequired')
    try:
        amt = int(amt)
    except Exception:
        return None, 'montant illisible'
    if (net.lower(), asset) in USDC:
        return amt / 1e6, 'USDC'
    return None, (a.get('extra') or {}).get('name') or asset[:10]


def reseau(i):
    return i['accepts'][0].get('network') or '?'


def est_test(i):
    return reseau(i) in TESTNETS


def hote(i):
    return urlparse(i['resource']).netloc.lower()
# --- Categories par score. Le texte = URL (chemin decoupe en mots, camelCase separe) + description(s)
# + serviceName + tags + toolName. Chaque categorie a une liste de motifs (mots entiers) ; le score
# d'une categorie = nombre de motifs distincts trouves, un motif trouve dans la description compte 2,
# dans l'URL seule 1. On garde la categorie de plus haut score ; egalite -> ordre de la liste.
# Les tests/demos sont reperes a part par des motifs forts (echo, hello world, test charge, don...).
CATS = [
    ('achats_reels', [r"e-?sims?", r"gift ?cards?", r"dropship\w*", r"virtual (phone )?numbers?", r"phone numbers? (rental|rent|purchase|buy)", r"rent (a )?(phone )?number",
                      r"sms (verification|otp|receive)", r"receive sms", r"mobile top.?up", r"airtime", r"mobile top.?up", r"phone (recharge|top.?up)", r"shipping labels?", r"postage", r"postcards?",
                      r"physical (mail|letter|goods|products?|items?)", r"send (a )?(physical )?letter", r"flowers? deliver\w*", r"place (an )?order", r"buy (a |an )?(product|item|gift)",
                      r"domain registration", r"register (a )?domain", r"merch", r"t-?shirts?", r"vouchers?", r"data plan", r"travel data",
                      r"(amazon|shopify|walmart|ebay) (order|purchase|checkout)", r"print on demand", r"ship(ped|ping)? to (your|an?) address", r"shipping address",
                      r"mailing address", r"delivered to", r"real[- ]world (purchase|goods|products?)", r"dropshipping", r"textbelt", r"send (an? )?sms",
                      r"social media growth", r"growth services", r"x raid", r"ad slot", r"newsletter ad", r"human (judgement|judgment|task|rail)", r"sms verification"]),
    ('paris_prediction_jeux', [r"polymarket", r"kalshi", r"limitless", r"prediction[ -]?markets?", r"predictions?", r"forecasting duel", r"bets?", r"betting", r"odds", r"sportsbook",
                               r"sports?", r"nfl", r"nba", r"mlb", r"nhl", r"soccer", r"football", r"ufc", r"e-?sports?", r"casino", r"dice", r"coin ?flip", r"lottery", r"raffle",
                               r"games?", r"gaming", r"roshambo", r"rock.?paper", r"poker", r"blackjack", r"roulette", r"chess", r"monopoly", r"padel", r"leagues?",
                               r"horoscope", r"tarot", r"i-?ching", r"fengshui", r"feng shui", r"astrolog\w*", r"zodiac", r"bagua", r"natal chart", r"full chart"]),
    ('securite_jeton', [r"honeypot", r"rug ?pulls?", r"rugs?", r"scams?", r"phishing", r"drainer", r"malicious", r"sanction\w*", r"ofac", r"aml", r"kyt", r"approvals?", r"revoke",
                        r"exploit\w*", r"vulnerab\w*", r"goplus", r"gopluslabs", r"token.security", r"rug.?check", r"token ?scan", r"contract (scan|check|audit|verification)", r"smart contract (audit|security)", r"audit\w*",
                        r"security", r"risk score", r"risk card", r"token risk", r"wallet risk", r"counterparty", r"sniper\w*", r"snipe", r"mint authority", r"freeze authority",
                        r"blacklist\w*", r"flagged", r"trust score", r"reputation", r"bundl(e|er)s? (detection|check)", r"dev wallet", r"holder concentration", r"sell tax", r"buy tax",
                        r"can i sell", r"sellable", r"lp (burn|lock)\w*", r"liquidity lock\w*", r"safety", r"safe", r"risk", r"verdict", r"threat", r"compliance"]),
    ('donnees_onchain', [r"wallets?", r"(wallet|evm|solana|token|contract|0x) address(es)?", r"balances?", r"transactions?", r"tx", r"txs", r"rpc", r"json-rpc", r"eth_\w+", r"blocks?", r"gas", r"holders?", r"on-?chain",
                         r"nfts?", r"ens", r"basenames?", r"erc-?20", r"erc-?721", r"spl", r"mint", r"calldata", r"abi", r"selectors?", r"contracts?", r"evm", r"chain ?id", r"explorer",
                         r"etherscan", r"basescan", r"solscan", r"helius", r"nansen", r"dune", r"counterparties", r"pnl", r"positions?", r"portfolio", r"slot", r"epoch", r"validators?",
                         r"lamports", r"event logs?", r"receipts?", r"nonce", r"bridge\w*", r"robinhood chain", r"x402scan", r"facilitator", r"erc-?8004", r"8004", r"deployer", r"deployed",
                         r"fund.?flow", r"tracing", r"smart money", r"whales?", r"token god mode", r"tgm",
                         r"stablecoin balance", r"wei", r"gwei", r"eip-?\d+", r"multicall", r"airdrop check"]),
    ('finance_tradfi', [r"stocks?", r"equit(y|ies)", r"shares", r"nasdaq", r"nyse", r"s&p", r"spx", r"vix", r"dxy", r"forex", r"fx", r"exchange rates?", r"currenc(y|ies)", r"sec",
                        r"edgar", r"10-k", r"10-q", r"filings?", r"earnings", r"dividends?", r"etfs?", r"commodit(y|ies)", r"gold", r"silver", r"oil", r"crude", r"palladium", r"corn",
                        r"cattle", r"treasur(y|ies)", r"bonds?", r"yield curve", r"interest rates?", r"inflation", r"cpi", r"gdp", r"macro\w*", r"economic\w*", r"central bank",
                        r"fomc", r"fed", r"moex", r"cbr", r"compan(y|ies)", r"cnpj", r"lei", r"gleif", r"business (lookup|registry)", r"vat", r"iban", r"bic", r"swift",
                        r"invoic\w*", r"e-invoice", r"accounting", r"tax(es)?", r"credit", r"banks?", r"fdic", r"payroll", r"capex", r"financial", r"analyst", r"shopper", r"cik",
                        r"sic", r"ticker"]),
    ('prix_marche_crypto', [r"prices?", r"pricing feed", r"price feed", r"ohlcv?", r"candles?", r"klines?", r"market ?cap", r"trending", r"dex", r"dexscreener", r"birdeye", r"coingecko",
                            r"coinmarketcap", r"pump\.?fun", r"pumpfun", r"pump", r"memecoins?", r"meme ?coins?", r"funding( rate)?", r"open interest", r"perps?", r"perpetual\w*",
                            r"liquidations?", r"order ?book", r"swaps?", r"quotes?", r"slippage", r"btc", r"eth", r"sol", r"bitcoin", r"crypto\w*", r"token (price|prices|data|info|metrics|snapshot|analytics|screener|launch\w*)", r"new tokens", r"launch(es)?", r"\w+usdt", r"\w+usd",
                            r"kol", r"signals?", r"rsi", r"macd", r"ema", r"sma", r"bollinger", r"technical (analysis|indicators?)", r"indicators?", r"sentiment", r"fear.?(and.?)?greed",
                            r"hyperliquid", r"binance", r"coinbase", r"cex", r"arbitrage", r"arb", r"spread", r"volatility", r"stablecoins?", r"pegs?", r"coinstats", r"altcoins?", r"defi",
                            r"tvl", r"yields?", r"apy", r"apr", r"staking", r"unlocks?", r"dominance", r"usdt", r"trad(e|es|ing)", r"traders?", r"market movers", r"alsat", r"superalsat",
                            r"backtest\w*", r"trading strateg\w*", r"options", r"deribit", r"mark price", r"liquidity", r"pools?", r"lp", r"vaults?", r"lending", r"borrow\w*", r"aave", r"uniswap",
                            r"jupiter", r"raydium", r"meteora", r"orca"]),
    ('llm_chat', [r"llms?", r"chat/completions", r"chat completions?", r"chat", r"gpt[-\w]*", r"openai", r"anthropic", r"claude", r"gemini", r"grok", r"llama", r"mistral", r"deepseek",
                  r"qwen", r"(language|ai|llm|frontier) models?", r"inference", r"prompts?", r"completions?", r"summari[sz]\w*", r"translat\w*", r"rewrite", r"paraphras\w*", r"embeddings?", r"rag", r"reasoning",
                  r"deep research", r"research (report|agent)", r"copywrit\w*", r"generate (text|content|a post|tweets?|copy)", r"classif\w*", r"extract-json", r"token compression",
                  r"ai (agent|assistant|answer|analysis|insight|verdict)", r"ask", r"answer", r"questions?", r"writer", r"essay", r"repurpos\w*", r"nda", r"proofread\w*",
                  r"grammar", r"tone", r"agents? (run|task)", r"verification pass\w*", r"deep-verify", r"persona"]),
    ('image_video_audio', [r"images?", r"img", r"pictures?", r"photos?", r"videos?", r"audio", r"speech", r"tts", r"text.to.speech", r"voices?", r"music", r"songs?", r"soundtrack",
                           r"transcri\w*", r"subtitles?", r"ocr", r"vision", r"thumbnails?", r"avatars?", r"meme generat\w*", r"stable diffusion", r"flux", r"midjourney", r"dall-?e",
                           r"sora", r"veo", r"kling", r"runway", r"upscal\w*", r"background remov\w*", r"qr ?codes?", r"qr", r"svg", r"png", r"jpe?g", r"screenshots?", r"gifs?",
                           r"youtube", r"podcasts?", r"dead air", r"cutlist", r"nano-?banana", r"audiobooks?", r"films?", r"movies?", r"draw\w*", r"illustrat\w*", r"logo", r"detect"]),
    ('social', [r"twitter", r"tweets?", r"retweet\w*", r"x\.com", r"farcaster", r"warpcast", r"casts?", r"reddit", r"telegram", r"discord", r"tiktok", r"instagram", r"reels",
                r"linkedin", r"facebook", r"threads", r"bluesky", r"influencers?", r"followers?", r"following", r"unfollow", r"social", r"mentions?", r"hashtags?", r"lens",
                r"zora", r"x raid", r"xraid", r"likes?", r"engagement", r"posts?", r"screen ?name", r"username", r"user profile", r"timeline", r"kol"]),
    ('osint_infra', [r"whois", r"rdap", r"dns", r"mx", r"spf", r"dmarc", r"dkim", r"dnssec", r"ssl", r"tls", r"certificates?", r"subdomains?", r"domains?", r"ip", r"ipv[46]", r"asn?",
                     r"cves?", r"ports?", r"shodan", r"headers?", r"uptime", r"status page", r"latency", r"redirects?", r"http status", r"reachab\w*", r"osint", r"recon",
                     r"breach\w*", r"leak\w*", r"email (validation|verification|check)", r"validate email", r"disposable email", r"phone (parse|parser|validation|lookup)",
                     r"cookies?", r"tech.?stack", r"srv", r"srv records?", r"nameservers?", r"hosting", r"cdn", r"ip-info", r"geoip", r"ip geolocation", r"bin", r"hsts", r"csp"]),
    ('meteo_geo', [r"weather", r"forecast", r"temperature", r"climate", r"sun(rise|set)?", r"twilight", r"golden hour", r"moon", r"tides?", r"air quality", r"aqi", r"pollen",
                   r"earthquakes?", r"geocod\w*", r"latitude", r"longitude", r"lat", r"lon", r"coordinates", r"maps?", r"places?", r"poi", r"city", r"cities", r"country",
                   r"countries", r"timezones?", r"time ?zones?", r"iana", r"holidays?", r"postal", r"zip ?codes?", r"elevation", r"routing", r"distance", r"directions", r"traffic",
                   r"aviation", r"airports?", r"flights?", r"density altitude", r"metar", r"acars", r"geo", r"shipping ?rates", r"package tracking", r"tracking", r"carriers?",
                   r"fedex", r"usps", r"dhl", r"ups", r"vin", r"plates?", r"placa", r"vehicles?", r"veicular", r"real estate", r"property", r"parcels?", r"locations?", r"clubs?"]),
    ('recherche_web', [r"search", r"scrap(e|er|ing)", r"crawl\w*", r"web ?pages?", r"websites?", r"urls?", r"fetch", r"readability", r"extract\w*", r"markdown", r"html",
                       r"wayback", r"archive", r"wikipedia", r"wiki", r"news", r"articles?", r"rss", r"feeds?", r"headlines?", r"serp", r"google", r"bing", r"perplexity", r"exa",
                       r"tavily", r"brave", r"firecrawl", r"jina", r"open ?graph", r"link preview", r"sitemap", r"changelogs?", r"releases?", r"brows(e|er)", r"books?", r"gutenberg",
                       r"library", r"papers?", r"arxiv", r"pubmed", r"scholar", r"patents?", r"clinical", r"trials?", r"fda", r"fec", r"courts?", r"legal", r"laws?", r"regulat\w*",
                       r"government", r"census", r"datasets?", r"jobs?", r"grants?", r"research", r"dossier", r"lookup", r"meta(data)?"]),
    ('outils_dev', [r"hash(es|ing)?", r"sha-?256", r"sha-?512", r"sha1", r"md5", r"checksum", r"base64", r"base32", r"hex", r"encode", r"decode", r"json", r"yaml", r"xml", r"csv",
                    r"regex", r"uuid", r"ulid", r"case convert\w*", r"camelcase", r"snake_case", r"slug\w*", r"text", r"strings?", r"word (count|frequenc\w*)", r"diff", r"merge",
                    r"sort", r"arrays?", r"objects?", r"keys?", r"pars(e|er|ing)", r"format\w*", r"minif\w*", r"validat\w*", r"lint\w*", r"compil\w*", r"github", r"gitlab",
                    r"npm", r"pypi", r"nuget", r"crates", r"go module", r"packages?", r"dependenc\w*", r"licen[sc]e", r"spdx", r"code", r"coding", r"python", r"javascript",
                    r"typescript", r"solidity", r"sql", r"webhooks?", r"cron", r"schedul\w*", r"queue", r"idempot\w*", r"dedupe", r"rate.?limit", r"retry", r"backoff",
                    r"cache", r"kv", r"storage", r"upload", r"files?", r"pdf", r"docx", r"convert(er)?", r"conversion", r"units?", r"calculat\w*", r"compute", r"math", r"statistic\w*",
                    r"probabilit\w*", r"random", r"seeded", r"passphrase", r"password", r"colou?rs?", r"hsl", r"rgb", r"timestamp", r"date", r"email", r"inbox\w*", r"agentmail",
                    r"mailbox", r"meetings?", r"calendar", r"memory", r"mcp", r"tools?", r"simulat\w*", r"cloud", r"autoscal\w*", r"deploy\w*", r"server", r"infra", r"trace",
                    r"observab\w*", r"sandbox", r"schema", r"openapi", r"handoff", r"capsule", r"preflight", r"notariz\w*", r"attest\w*", r"sign(ature)?", r"verify", r"eval\w*",
                    r"cocktail", r"fitness", r"recipes?", r"pii", r"redact", r"latency summary", r"percentile\w*", r"p95", r"bool", r"sql migration", r"cookies audit"]),
]
TESTS = re.compile(r"\becho\b|\bping\b|hello[ -]?world|\bdemo\b|\btest[ -]?(charge|payment|endpoint|service|route|resource|api)?\b|\btest-\d|\btesting\b|testnet|\bdummy\b|"
                   r"\bdonat(e|ion|ions)\b|\btips?\b|tip jar|probe channel|pay with base|placeholder|\bfoo\b|write-message|healthcheck|lorem|\bsample endpoint", re.I)

CATS_RE = [(n, [re.compile(r'\b' + p + r'\b', re.I) for p in pats]) for n, pats in CATS]

LIBELLE = {
    'achats_reels': 'Commerce / achats (eSIM, cartes cadeaux, colis, produits...)',
    'tests_divers': 'Tests / demos / echo / dons',
    'paris_prediction_jeux': 'Paris, marches de prediction, sport, jeux, divination',
    'securite_jeton': 'Analyse de jeton / securite / risque',
    'prix_marche_crypto': 'Prix / marche crypto / DeFi / trading',
    'donnees_onchain': 'Donnees on-chain (portefeuilles, tx, RPC, contrats)',
    'llm_chat': 'LLM / chat / texte genere',
    'image_video_audio': 'Image / video / audio',
    'social': 'Reseaux sociaux',
    'recherche_web': 'Recherche web / scraping / actualites / documents',
    'finance_tradfi': 'Finance traditionnelle (actions, FX, macro, entreprises)',
    'meteo_geo': 'Meteo / geo / transport / logistique',
    'osint_infra': 'OSINT / infra internet (DNS, WHOIS, IP, e-mail)',
    'outils_dev': 'Outils dev / utilitaires / calcul',
    'non_classe': 'Non classe (texte insuffisant)',
}


def _norm(s):
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', s)
    s = re.sub(r'%20|%2F|[-_/.?=&:]+', ' ', s)
    return s.lower()


def scores(i):
    d = _norm(' '.join([desc(i), i.get('serviceName') or '', ' '.join(i.get('tags') or []), i.get('toolName') or '']))
    u = urlparse(i['resource'])
    path = _norm(u.path + ' ' + u.query)
    host = _norm(u.netloc)
    # mots generiques des chemins d'URL, sans valeur de categorie
    path = re.sub(r'\b(api|apis|v\d+|x402|x402s|tools?|agents?|agentic|paid|invoke|entrypoints|call|mpp|public|paysponge)\b', ' ', path)
    sc = {}
    for n, rxs in CATS_RE:
        s = 0
        for rx in rxs:
            if rx.search(d):
                s += 2
            elif rx.search(path):
                s += 1
        if s:
            sc[n] = s
    if not sc:
        for n, rxs in CATS_RE:
            s = sum(1 for rx in rxs if rx.search(host))
            if s:
                sc[n] = s
    return sc, d, path


def categorie(i):
    sc, d, path = scores(i)
    # un test franc (dans la description ou le chemin) l'emporte, sauf si la description est riche
    if (TESTS.search(d + ' ' + path) or re.search(r'\bhealth$', path.strip())) and max(sc.values() or [0]) <= 4:
        return 'tests_divers'
    if not sc:
        return 'non_classe'
    ordre = [n for n, _ in CATS]
    return max(sc, key=lambda n: (sc[n], -ordre.index(n)))


def quartiles(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    def q(p):
        k = (n - 1) * p
        f = int(k); c = min(f + 1, n - 1)
        return xs[f] + (xs[c] - xs[f]) * (k - f)
    return dict(n=n, min=xs[0], q1=q(.25), med=q(.5), q3=q(.75), max=xs[-1], moy=sum(xs) / n)
