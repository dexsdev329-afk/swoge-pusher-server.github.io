# Calculs du rapport PayAI : tout ce qui est chiffre dans analyse_payai.md sort d'ici.
import sys, json, re, collections, datetime, math
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from payai_lib import *

NOUS = 'web-production-220a3.up.railway.app'
items = charge()
C = collections.Counter
S = {}
out = []


def p(*a):
    out.append(' '.join(str(x) for x in a))


def f(x):
    if x is None:
        return 'inconnu'
    if x == 0:
        return '0'
    if x < 0.01:
        return f'{x:.4f}'.rstrip('0')
    return f'{x:.3f}'.rstrip('0').rstrip('.')


# ---------- 1. Taille
p('## TAILLE')
p('entrees', len(items), 'resources distinctes', len(set(i['resource'] for i in items)))
hotes = C(hote(i) for i in items)
p('hotes', len(hotes), 'hotes sans port', len(set(h.split(':')[0] for h in hotes)))
p('payTo distincts', len(set(i['accepts'][0]['payTo'] for i in items)))
p('versions', C(i['x402Version'] for i in items))
p('type', C(i['type'] for i in items))
p('scheme', C(urlparse(i['resource']).scheme for i in items))
p('schemes x402', C(i['accepts'][0].get('scheme') for i in items))
p('methode', C(methode(i) for i in items))
res = C()
for i in items:
    n = reseau(i)
    res[(NOM_RESEAU.get(n, n), 'test' if est_test(i) else ('inconnu' if 'inconnu' in NOM_RESEAU.get(n, 'inconnu') else 'mainnet'))] += 1
p('reseaux', res.most_common())
p('mainnet', sum(v for k, v in res.items() if k[1] == 'mainnet'), 'test', sum(v for k, v in res.items() if k[1] == 'test'),
  'inconnu', sum(v for k, v in res.items() if k[1] == 'inconnu'))
act = C()
for i in items:
    u, a = prix(i)
    act['USDC' if u is not None else a] += 1
p('actifs', act.most_common())
# fraicheur
lu = sorted(i['lastUpdated'] for i in items)
p('lastUpdated min', lu[0], 'max', lu[-1])
ref = datetime.datetime(2026, 9, 28, 17, 0, tzinfo=datetime.timezone.utc)
ages = [(ref - datetime.datetime.fromisoformat(i['lastUpdated'].replace('Z', '+00:00'))).total_seconds() / 86400 for i in items]
for d in (1, 7, 30, 90):
    p(f'maj < {d} j', sum(1 for a in ages if a < d))
# descriptions
p('sans description', sum(1 for i in items if not desc(i)))
p('avec schema bazaar', sum(1 for i in items if ((i.get('extensions') or {}).get('bazaar') or {}).get('info')))
p('avec outputSchema', sum(1 for i in items if i.get('outputSchema') or (i['accepts'][0].get('outputSchema') or {}).get('output')))

# ---------- 2. Prix
p('## PRIX')
main_usd = [(i, prix(i)[0]) for i in items if not est_test(i) and prix(i)[0] is not None]
xs = [u for _, u in main_usd]
p('prix mainnet USDC n', len(xs), quartiles(xs))
p('prix zero', sum(1 for x in xs if x == 0))
tr = [(0, 0), (0, 0.001), (0.001, 0.005), (0.005, 0.01), (0.01, 0.05), (0.05, 0.1), (0.1, 1), (1, 10), (10, 1e12)]
for a, b in tr:
    if a == b:
        p('  =0', sum(1 for x in xs if x == 0))
    else:
        p(f'  ]{a};{b}]', sum(1 for x in xs if a < x <= b))
for net in ('Base', 'Solana', 'Polygon'):
    v = [u for i, u in main_usd if NOM_RESEAU.get(reseau(i)) == net]
    p('prix', net, quartiles(v))
# par hote (chaque hote une fois : mediane de ses prix) pour neutraliser les gros publieurs
ph = collections.defaultdict(list)
for i, u in main_usd:
    ph[hote(i)].append(u)
med_h = [quartiles(v)['med'] for v in ph.values()]
p('prix median par hote (un point par hote)', quartiles(med_h))

# ---------- 3. Categories
p('## CATEGORIES')
cat = {id(i): categorie(i) for i in items}
cc = C(cat.values())
S['categories'] = {}
for c, n in cc.most_common():
    lst = [i for i in items if cat[id(i)] == c]
    h = C(hote(i) for i in lst)
    pu = [prix(i)[0] for i in lst if not est_test(i) and prix(i)[0] is not None]
    q = quartiles(pu)
    S['categories'][c] = dict(n=n, hotes=len(h), top=h.most_common(4), prix=q)
    p(c, n, 'hotes', len(h), 'top', h.most_common(4), 'prix', {k: (round(v, 5) if isinstance(v, float) else v) for k, v in (q or {}).items()})

# ---------- 5. Concentration
p('## CONCENTRATION')
tot = len(items)
top = hotes.most_common()
cum = 0
for k, (h, n) in enumerate(top[:20], 1):
    cum += n
    p(k, h, n, f'{100*n/tot:.1f}%', f'cumul {100*cum/tot:.1f}%')
for s in (100, 50, 20, 10, 5, 2, 1):
    p(f'hotes avec >= {s} entrees', sum(1 for _, n in top if n >= s))
p('hotes a 1 entree', sum(1 for _, n in top if n == 1))
p('top1 %', 100 * top[0][1] / tot, 'top5 %', 100 * sum(n for _, n in top[:5]) / tot, 'top10 %', 100 * sum(n for _, n in top[:10]) / tot)
hhi = sum((n / tot) ** 2 for _, n in top)
p('HHI hotes', round(hhi * 10000))
pt = C(i['accepts'][0]['payTo'].lower() for i in items)
p('payTo top5', [(k[:10], n) for k, n in pt.most_common(5)])


def gabarit(i):
    u = urlparse(i['resource'])
    segs = []
    for s in u.path.split('/'):
        if not s:
            continue
        if re.fullmatch(r'0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{30,}|\d+|[0-9a-f-]{20,}|:[\w]+|\{\w+\}|%7B\w+%7D|\*', s):
            s = '{id}'
        elif re.search(r'(usdt|usd|btc|eth)$', s.lower()) and len(s) <= 16:
            s = '{paire}'
        segs.append(s)
    return u.netloc + '/' + '/'.join(segs)


gab = C(gabarit(i) for i in items)
p('gabarits de route distincts', len(gab), 'pour', tot, 'entrees')
p('gabarits les plus repetes', gab.most_common(12))
# familles : hote + 1er segment utile
# doublons
p('resources en double exact', tot - len(set(i['resource'] for i in items)))
dd = C((desc(i).strip().lower()) for i in items if desc(i).strip())
grp = [(d, n) for d, n in dd.items() if n > 1]
p('descriptions non vides', sum(dd.values()), 'distinctes', len(dd), 'groupes repetes', len(grp), 'entrees dans un groupe repete', sum(n for _, n in grp))
p('descriptions les plus repetees', [(d[:70], n) for d, n in sorted(grp, key=lambda x: -x[1])[:10]])
dh = collections.defaultdict(set)
for i in items:
    if desc(i).strip():
        dh[desc(i).strip().lower()].add(hote(i))
p('descriptions identiques sur plusieurs hotes', sum(1 for v in dh.values() if len(v) > 1),
  [(d[:60], sorted(v)[:4]) for d, v in dh.items() if len(v) > 2][:8])
# meme resource sur plusieurs reseaux
rn = collections.defaultdict(set)
for i in items:
    rn[i['resource']].add(reseau(i))
p('resources sur plusieurs reseaux', sum(1 for v in rn.values() if len(v) > 1))

# ---------- 6. Nos outils face au marche
p('## NOS OUTILS')
nous = {i['resource'].rsplit('/', 1)[-1]: i for i in items if hote(i) == NOUS}
p('nos entrees', len(nous), sorted((k, prix(v)[0], NOM_RESEAU.get(reseau(v))) for k, v in nous.items()))
CONC = {
    'scan_token': r"(token|erc-?20|contract|mint).{0,60}(security|safety|risk|honeypot|rug|scan|audit|due.diligence|pre-?flight)|honeypot|rug.?(check|pull|risk|probab)|goplus",
    'can_i_sell': r"honeypot|sellab|can.{0,10}sell|sell (simulation|test|tax)|exit (simulation|test)|round.?trip|simulate.{0,20}(sell|swap)",
    'token_verdict': r"(token|contract|mint).{0,60}verdict|verdict.{0,60}(token|contract|mint)",
    'roast_token': r"\broast",
    'wallet_intel': r"deployer|wallet (intel|profile|profil|risk|report|label|identity|analysis|dossier|screen|reputation)|who is behind|serial (rug|launch)|creator (history|rating)|dev (history|wallet)",
    'osint_lookup': r"\bwhois\b|\brdap\b|\bdns\b|\bip (info|lookup|intel|address intel)|\bcve\b|\basn\b|certificate transparency|subdomain",
    'web_search': r"web search|search the (open )?web|search the web|\bserp\b|exa search|perplexity|tavily search|brave search|google (search|results)|neural search|firecrawl search",
    'chat_completion': r"chat/completions|chat completions?|openai.compatible",
    'ask_agent': r"deep research|research agent|autonomous agent (task|run)|agent task|run an agent|ask (an? )?agent|delegate .{0,20}task",
    'generate_image': r"image generat|text.to.image|generate (an? )?(finished )?images?|\bflux\b|stable.diffusion|\bsdxl\b|dall.?e|nano.?banana|imagen\b",
    'generate_video': r"video generat|text.to.video|image.to.video|generate (a )?(short )?video|\bkling\b|\bveo\b|\bsora\b|\bwan \d|minimax/video|stable-video",
    'robinhood_*': r"robinhood",
    'new_launches': r"new (token )?launch|newest tokens|new tokens|recent(ly)? launch|token launches|new pairs|fresh tokens|just launched",
    'colony_activity': r"paper.?trad|copy.?trad|autonomous trad|trading (agent|bot|colony)|ai trad(er|ing agent)",
    'swoge_economy': r"tokenomics|burn(ed|t)? (supply|amount)|circulating supply|staking apr",
}
S['nos_outils'] = {}
# utilitaires hors ligne (validateurs de forme, calculs locaux) : pas des concurrents d'un outil qui lit le monde
EXCL = re.compile(r"local utility|without (network|fetching|live)|shape check|no network|offline|test fixtures|fixtures without", re.I)
autres = [i for i in items if hote(i) != NOUS and not est_test(i) and not EXCL.search(texte(i))]
for k, rx in CONC.items():
    r = re.compile(rx, re.I)
    lst = [i for i in autres if r.search(texte(i))]
    pu = [prix(i)[0] for i in lst if prix(i)[0] is not None]
    h = C(hote(i) for i in lst)
    nm = [n for n in nous if n.startswith(k.rstrip('*'))]
    notre = sorted(set(prix(nous[n])[0] for n in nm)) if nm else None
    q = quartiles(pu)
    moins = sum(1 for x in pu if notre and x < min(notre))
    S['nos_outils'][k] = dict(n=len(lst), hotes=len(h), top=h.most_common(6), prix=q, notre=notre, moins_chers=moins)
    p(k, 'n', len(lst), 'hotes', len(h), 'notre', notre, 'q', {a: round(b, 5) for a, b in (q or {}).items()}, 'moins chers que nous', moins, 'top', h.most_common(6))

# ---------- 7. Trous
p('## BESOINS')
BES = {
    'scores sportifs en direct': r"live scores?|scoreboard|\bespn\b|match results?|fixtures|box ?score",
    'cotes sportives / bookmakers': r"sports? odds|betting odds|odds api|bookmaker|sportsbook|moneyline|point spread|over/under",
    'marches de prediction (Polymarket/Kalshi)': r"polymarket|kalshi|prediction.markets?",
    'PancakeSwap Prediction / manches UP-DOWN': r"pancake.{0,30}predict|up.?or.?down|binary (option|round)|price rounds?",
    'verification provably-fair de casino': r"provably|fairness (proof|verif)|server.?seed|client.?seed|verify (a )?(roll|bet|game|spin|hand)",
    'hasard verifiable (RNG/VRF)': r"verifiable (rng|random)|\bvrf\b|random (number|beacon)|randomness",
    'Robinhood Chain (toute donnee)': r"robinhood",
    'actions tokenisees': r"tokeni[sz]ed (stock|equit)|stock tokens?|xstocks?|\bst0x\b",
    'test de revente / honeypot': r"honeypot|sellab|can.{0,10}sell|sell simulation",
    'historique du deployeur / createur': r"deployer|serial rug|creator (history|rating)|dev (history|wallet)",
    'perps Hyperliquid / funding': r"hyperliquid|funding rate",
    'gaz multi-chaines': r"gas (price|oracle|estimat|fee)",
    'devis de swap': r"swap quote|best route|get_swap_quote|aggregator quote|swap price",
    'airdrops': r"airdrop",
    'NFT floor': r"floor price|nft floor",
    'PnL de portefeuille': r"\bpnl\b|profit and loss",
    'objets de jeux video / skins (Steam, CS2)': r"\bsteam\b|\bcs2\b|cs:?go|game items?|in-game|skins? (price|market)",
    'esports': r"e-?sports?|league of legends|\bdota\b|valorant",
    'echecs / moteurs de jeu': r"\bchess\b|stockfish",
    'lancer un jeton': r"launch (a |your )?(new )?token|deploy (a |your )?token|token deploy|clanker",
    'confiance / vie d un service x402': r"x402.{0,40}(trust|preflight|liveness|safe to pay|reliability|listing quality|doctor)|is this x402",
    'alertes / webhooks': r"\balerts?\b|webhook|notify",
    'solde multi-chaines / portefeuille': r"cross.chain balance|multi.?chain (balance|portfolio)|portfolio",
    'memecoins Solana (pump.fun)': r"pump\.?fun|pumpfun",
    'memecoins Base / Clanker / Zora': r"clanker|zora|base (memecoin|launch)",
    'Telegram / canaux crypto': r"telegram",
}
S['besoins'] = {}
for k, rx in BES.items():
    r = re.compile(rx, re.I)
    lst = [i for i in autres if r.search(texte(i))]
    pu = [prix(i)[0] for i in lst if prix(i)[0] is not None]
    h = C(hote(i) for i in lst)
    q = quartiles(pu)
    S['besoins'][k] = dict(n=len(lst), hotes=len(h), top=h.most_common(5), prix=q)
    p(k, '| n', len(lst), '| hotes', len(h), '| min', f(q and q['min']), 'med', f(q and q['med']), '|', h.most_common(5))

json.dump(S, open(f'{SCR}/stats_payai.json', 'w'), indent=1, ensure_ascii=False, default=str)
print('\n'.join(out))
