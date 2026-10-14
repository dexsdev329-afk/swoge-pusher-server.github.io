# Calcul INDEPENDANT (Python, sans le code JS) des gains et issues figes dans les
# essais (14/10/2026, apres la revue C1/C2). Son propre decodage, sa propre regle
# du beneficiaire, ses propres FRAIS : sur une vente, la retenue du crochet en ETH
# (0xc532c43b, mot 0 = 0) et les frais du routeur 0x65050a (0x205442d6, devise 0)
# sont retranches du Swap ; sur un achat, les frais du routeur sont ajoutes. Cout
# inconnu si > 1 % du sac est recu OU envoye hors marche.
import json, sys, gzip
d = json.load(gzip.open(sys.argv[1]))
T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
S = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
FC = '0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d'
FR = '0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92'
RT = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc'
PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
def s256(h):
    v = int(h, 16); return v - 2**256 if v >= 2**255 else v
def adr(t): return '0x' + t[-40:].lower()
out = {}
for nom, e in d.items():
    tx = {}
    for l in e['logs']:
        h = l['transactionHash'].lower(); g = tx.setdefault(h, {'sw': [], 'tr': [], 'cro': 0, 'rou': 0})
        t0 = l['topics'][0].lower(); a = l['address'].lower(); w = l['data'][2:]
        if t0 == S and a == PM and l['topics'][1].lower() == e['pool']:
            g['sw'].append((s256(w[0:64]), s256(w[64:128])))
        elif t0 == T and a == e['jeton'] and len(l['topics']) == 3:
            g['tr'].append((adr(l['topics'][1]), adr(l['topics'][2]), int(w[0:64], 16)))
        elif t0 == FC and e['hook'] and a == e['hook'] and l['topics'][1].lower() == e['pool'] and int(w[0:64], 16) == 0:
            g['cro'] += int(w[64:128], 16)
        elif t0 == FR and a == RT and int(l['topics'][1], 16) == 0:
            g['rou'] += int(w[0:64], 16)
    excl = {PM, e['hook'], '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'}
    trades = []
    for h, g in tx.items():
        if not g['sw']: continue
        # ETH en currency0 pour ces piscines v4 (ethEst0) : amount0 = ETH, cote utilisateur
        eth = sum(a for a, b in g['sw']); jet = sum(b for a, b in g['sw'])
        if not e['ethEst0']: eth, jet = jet, eth
        sens = 'achat' if eth < 0 and jet > 0 else ('vente' if eth > 0 and jet < 0 else None)
        if not sens: continue
        net = {}
        for de, vers, v in g['tr']:
            if de not in excl: net[de] = net.get(de, 0) - v
            if vers not in excl: net[vers] = net.get(vers, 0) + v
        best = None; bv = 0
        for a, n in net.items():
            v = n if sens == 'achat' else -n
            if v > bv: bv = v; best = a
        if best is None or bv * 2 < abs(jet): continue
        if sens == 'vente': payee = max(0, abs(eth) - g['cro'] - g['rou'])
        else: payee = abs(eth) + g['rou']
        trades.append((h, best, sens, payee, bv))
    num = int(e['prix']['num']); den = int(e['prix']['den'])
    res = []
    for w in e['wallets']:
        q = w['qui']; solde = int(w['solde']) if w['solde'] is not None else None
        mes = [t for t in trades if t[1] == q]; txm = {t[0] for t in mes}
        entre = sum(t[3] for t in mes if t[2] == 'achat'); sorti = sum(t[3] for t in mes if t[2] == 'vente'); achetes = sum(t[4] for t in mes if t[2] == 'achat')
        hors = {}
        for h, g in tx.items():
            if h in txm: continue
            dd = sum(v for de, vers, v in g['tr'] if vers == q) - sum(v for de, vers, v in g['tr'] if de == q)
            if dd: hors[h] = dd
        recu = sum(v for v in hors.values() if v > 0); envoye = -sum(v for v in hors.values() if v < 0)
        cout = achetes > 0 and recu * 100 <= (achetes + recu) and envoye * 100 <= achetes
        if solde is None: gain = None
        else:
            valeur = 0 if solde == 0 else solde * num // den
            gain = sorti - entre + valeur
        issue = 'inconnu' if (not cout or gain is None) else ('gagnant' if gain > 0 else 'perdant')
        res.append({'qui': q, 'entre': str(entre), 'sorti': str(sorti), 'gain': None if gain is None else str(gain), 'issue': issue,
                    'achats': sum(1 for t in mes if t[2] == 'achat'), 'ventes': sum(1 for t in mes if t[2] == 'vente')})
    out[nom] = res
json.dump(out, open(sys.argv[2], 'w'), indent=0)
for nom, r in out.items():
    print(nom, 'gagnants', sum(1 for x in r if x['issue'] == 'gagnant'), 'perdants', sum(1 for x in r if x['issue'] == 'perdant'), 'inconnus', sum(1 for x in r if x['issue'] == 'inconnu'))
