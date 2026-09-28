import sys, json, requests, collections
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, '.')
from payai_lib import *
items = charge()
hotes = sorted(set(hote(i).split(':')[0] for i in items))
def q(h):
    try:
        if re.match(r'^\d+\.\d+\.\d+\.\d+$', h):
            return h, 'ip_litterale'
        j = requests.get('https://cloudflare-dns.com/dns-query', params={'name': h, 'type': 'A'}, headers={'accept': 'application/dns-json'}, timeout=10).json()
        if j.get('Status') == 0 and not j.get('Answer'):
            j2 = requests.get('https://cloudflare-dns.com/dns-query', params={'name': h, 'type': 'AAAA'}, headers={'accept': 'application/dns-json'}, timeout=10).json()
            return h, 'ok' if j2.get('Answer') else 'sans_adresse'
        return h, {0: 'ok', 3: 'nxdomain', 2: 'servfail'}.get(j.get('Status'), 'status%s' % j.get('Status'))
    except Exception as e:
        return h, 'erreur_doh'
with ThreadPoolExecutor(16) as ex:
    res = dict(ex.map(q, hotes))
json.dump(res, open('dns_hotes.json', 'w'), indent=0)
c = collections.Counter(res.values()); print(len(hotes), c)
ent = collections.Counter(res[hote(i).split(':')[0]] for i in items); print('entrees', ent)
print([h for h, v in res.items() if v != 'ok'][:40])
