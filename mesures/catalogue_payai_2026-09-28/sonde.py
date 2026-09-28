# Sonde de vie du catalogue PayAI : UNE requete non payee par service, jamais d'en-tete de paiement.
import sys, json, random, time, base64, collections, threading, datetime
from concurrent.futures import ThreadPoolExecutor
import requests
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from payai_lib import *

GRAINE = 402
TOTAL = 150
MIN_PAR_CAT = 5
NOUS = 'web-production-220a3.up.railway.app'
CA = '/root/.ccr/ca-bundle.crt'
H = {'User-Agent': 'x402-catalog-liveness-survey/1.0 (unpaid probe)', 'Accept': 'application/json'}
CAIP = {'base': 'eip155:8453', 'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'polygon': 'eip155:137',
        'base-sepolia': 'eip155:84532', 'avalanche': 'eip155:43114', 'arbitrum': 'eip155:42161'}


def caip(n):
    return CAIP.get(n, n)


items = charge()
mainnet = [i for i in items if not est_test(i) and reseau(i) in NOM_RESEAU and 'inconnu' not in NOM_RESEAU[reseau(i)]
           and hote(i) != NOUS]
par_cat = collections.defaultdict(list)
for i in mainnet:
    par_cat[categorie(i)].append(i)
cats = sorted(par_cat)
# allocation : MIN_PAR_CAT chacune, le reste proportionnel a la taille
reste = TOTAL - MIN_PAR_CAT * len(cats)
tot = sum(len(v) for v in par_cat.values())
alloc = {c: min(len(par_cat[c]), MIN_PAR_CAT + round(reste * len(par_cat[c]) / tot)) for c in cats}
rng = random.Random(GRAINE)
echantillon = []
for c in cats:
    lst = sorted(par_cat[c], key=lambda i: i['resource'] + reseau(i))
    echantillon += [(c, i) for i in rng.sample(lst, alloc[c])]
# nos propres entrees, en temoin (hors statistiques du marche)
temoins = [('nous', i) for i in items if hote(i) == NOUS]

dns_cache = {}
dns_lock = threading.Lock()


def dns(h):
    h = h.split(':')[0]
    with dns_lock:
        if h in dns_cache:
            return dns_cache[h]
    try:
        r = requests.get('https://cloudflare-dns.com/dns-query', params={'name': h, 'type': 'A'},
                         headers={'accept': 'application/dns-json'}, timeout=10, verify=CA)
        j = r.json()
        st = j.get('Status')
        if st == 0 and not j.get('Answer'):
            r2 = requests.get('https://cloudflare-dns.com/dns-query', params={'name': h, 'type': 'AAAA'},
                              headers={'accept': 'application/dns-json'}, timeout=10, verify=CA).json()
            res = 'ok' if r2.get('Answer') else 'sans_adresse'
        else:
            res = {0: 'ok', 3: 'nxdomain', 2: 'servfail'}.get(st, f'status{st}')
    except Exception as e:
        res = 'doh_erreur'
    with dns_lock:
        dns_cache[h] = res
    return res


def lire_402(r):
    """Retourne (source, objet) : en-tete payment-required (base64 JSON) ou corps JSON avec accepts."""
    hv = r.headers.get('payment-required') or r.headers.get('PAYMENT-REQUIRED')
    if hv:
        try:
            pad = hv + '=' * (-len(hv) % 4)
            o = json.loads(base64.b64decode(pad).decode('utf-8'))
            if isinstance(o, dict) and o.get('accepts'):
                return 'entete', o
        except Exception:
            pass
    try:
        o = r.json()
        if isinstance(o, dict) and o.get('accepts'):
            return 'corps', o
    except Exception:
        pass
    return None, None


def sonde(ci):
    c, i = ci
    a = i['accepts'][0]
    m = (methode(i) or 'GET').upper()
    m_env = 'POST' if m == 'POST' else 'GET'
    cat_amt = a.get('amount') if i['x402Version'] == 2 else a.get('maxAmountRequired')
    usd, actif = prix(i)
    rec = dict(categorie=c, resource=i['resource'], hote=hote(i), version=i['x402Version'], methode_catalogue=m,
               methode_envoyee=m_env, reseau=reseau(i), actif=actif, prix_catalogue_usd=usd, montant_catalogue=cat_amt,
               payTo_catalogue=a.get('payTo'), description=desc(i)[:200])
    t = time.time()
    try:
        if m_env == 'POST':
            r = requests.post(i['resource'], json={}, headers=H, timeout=10, verify=CA, allow_redirects=True)
        else:
            r = requests.get(i['resource'], headers=H, timeout=10, verify=CA, allow_redirects=True)
        rec['ms'] = int((time.time() - t) * 1000)
        rec['http'] = r.status_code
        rec['url_finale'] = r.url if r.url != i['resource'] else None
        rec['corps_extrait'] = r.text[:300]
        if r.status_code == 402:
            src, o = lire_402(r)
            if o:
                rec['etat'] = '402_lisible'
                rec['source_402'] = src
                acc = o.get('accepts') or []
                rec['accepts_402'] = [dict(network=x.get('network'), amount=x.get('amount') or x.get('maxAmountRequired'),
                                           asset=x.get('asset'), payTo=x.get('payTo'), scheme=x.get('scheme')) for x in acc][:12]
                rec['version_402'] = o.get('x402Version')
                same = [x for x in acc if caip(x.get('network') or '') == caip(reseau(i))
                        and (x.get('asset') or '').lower() == (a.get('asset') or '').lower()]
                if not same:
                    rec['prix_compare'] = 'reseau_ou_actif_absent_du_402'
                else:
                    try:
                        vals = [int(x.get('amount') or x.get('maxAmountRequired')) for x in same]
                        ca = int(cat_amt)
                        if ca in vals:
                            rec['prix_compare'] = 'identique'
                        elif min(vals) > ca:
                            rec['prix_compare'] = '402_plus_cher'
                        else:
                            rec['prix_compare'] = '402_moins_cher'
                        rec['montant_402'] = vals[0]
                    except Exception:
                        rec['prix_compare'] = 'illisible'
                    rec['payTo_identique'] = any((x.get('payTo') or '').lower() == (a.get('payTo') or '').lower() for x in same)
            else:
                rec['etat'] = '402_illisible'
        elif 200 <= r.status_code < 300:
            rec['etat'] = '200_gratuit'
        elif 400 <= r.status_code < 500:
            rec['etat'] = '4xx'
        elif r.status_code >= 500:
            rec['etat'] = '5xx'
        else:
            rec['etat'] = f'autre_{r.status_code}'
    except requests.exceptions.Timeout:
        rec['ms'] = int((time.time() - t) * 1000)
        rec['etat'] = 'delai_depasse'
    except Exception as e:
        rec['ms'] = int((time.time() - t) * 1000)
        rec['erreur'] = f'{type(e).__name__}: {str(e)[:200]}'
        d = dns(hote(i))
        rec['dns'] = d
        rec['etat'] = 'dns_mort' if d in ('nxdomain', 'sans_adresse', 'servfail') else 'injoignable'
    return rec


if __name__ == '__main__':
    debut = datetime.datetime.utcnow().isoformat() + 'Z'
    with ThreadPoolExecutor(max_workers=10) as ex:
        res = list(ex.map(sonde, echantillon + temoins))
    out = dict(date=debut, graine=GRAINE, total_vise=TOTAL, min_par_categorie=MIN_PAR_CAT,
               allocation=alloc, taille_population_mainnet_hors_nous=len(mainnet),
               regles='une requete non payee par service (GET, ou POST {} si le catalogue dit POST), delai 10 s, '
                      'aucun en-tete PAYMENT-SIGNATURE ni X-PAYMENT, aucune cle, aucune donnee personnelle',
               resultats=[r for r in res if r['categorie'] != 'nous'],
               temoins_swoge=[r for r in res if r['categorie'] == 'nous'])
    json.dump(out, open(f'{SCR}/sonde_payai.json', 'w'), indent=1, ensure_ascii=False)
    print(collections.Counter(r['etat'] for r in out['resultats']))
    print(collections.Counter(r['etat'] for r in out['temoins_swoge']))
