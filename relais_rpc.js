'use strict';
/* ============================================================================
 * LE RELAIS JSON-RPC DE ROBINHOOD CHAIN, EN LECTURE SEULE (18/10/2026)
 *
 * ---- CE QUI EST ARRIVE ----
 * Le proprietaire ouvre l'onglet Explore du launchpad et lit, par moments :
 * « The launchpads could not be read from the Robinhood Chain node. Press
 * Reload. » — et le jeton V5 SWAI (0x83aB…5d22) n'apparait pas.
 *
 * Mesures du 18/10/2026 :
 *   - depuis le serveur (pas de CORS), 40 eth_getLogs simultanes sur des
 *     tranches de 9 M de blocs : 40 reussis, le plus lent en 204 ms. Le noeud
 *     tient la charge ;
 *   - depuis un Chromium sans tete, CHAQUE eth_getLogs : « Access-Control-
 *     Allow-Origin header contains multiple values '*,*' ». Le navigateur jette
 *     une reponse que le noeud a bien rendue. Note du 14/10 dans launchpad.html
 *     (parTranches) : le meme refus, vu par de vrais joueurs.
 * Le defaut est donc sur le CHEMIN du navigateur, pas dans le noeud. La page
 * lit d'abord le noeud ; quand le navigateur refuse sa reponse, elle repasse
 * la meme requete ici, et ce relais n'envoie qu'UN en-tete CORS.
 *
 * ---- CE QUE LE RELAIS NE FAIT JAMAIS ----
 *   - signer, envoyer une transaction, ouvrir un filtre, tracer : la liste
 *     ci-dessous est FERMEE, tout le reste est refuse avant le reseau ;
 *   - dire l'adresse du noeud amont (elle peut porter une cle) : aucune
 *     reponse, aucun message d'erreur, aucun journal ne la contient ;
 *   - recopier les en-tetes du noeud : la reponse est reconstruite, ses
 *     en-tetes sont les notres.
 *
 * Les bornes sont CHOISIES (aucune mesure de trafic n'existe encore pour cette
 * route) ; chacune dit pourquoi ce chiffre, et `etat()` compte ce qu'elles
 * refusent pour qu'elles deviennent jugeables.
 * ==========================================================================*/

/* La liste fermee. eth_getTransactionCount n'y est pas : la page ne lit pas de
   nonce (le portefeuille signe), et une methode qu'aucune page n'appelle n'a
   rien a faire dans une porte publique. */
const METHODES = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getLogs', 'eth_getBalance', 'eth_getCode',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_estimateGas',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getStorageAt', 'net_version',
]);

const DEFAUTS = {
  /* CHOISI : 128 Kio. Un lot de 25 eth_call de devis fait ~25 Kio ; quatre fois
     plus laisse de la marge sans laisser allouer des megaoctets a un inconnu. */
  CORPS_MAX: 128 * 1024,
  /* CHOISI : 25 appels par lot. ethers (StaticJsonRpcProvider) n'en envoie
     jamais en lot ; la borne ne sert qu'a ce qu'un seul POST ne vide pas le
     seau d'un coup. */
  LOT_MAX: 25,
  /* La limite du noeud lui-meme, relevee le 30/09/2026 : « query spans
     76531054 blocks (0 to 76531053), but only 10000000 are allowed ». La page
     lit par tranches de 9 M (PLAGE_MAX de launchpad.html). */
  PLAGE_MAX: 10000000,
  /* CHOISI : 15 s par appel amont. Le plus lent des 40 eth_getLogs du 18/10 a
     pris 204 ms ; 15 s couvre un noeud tres charge sans tenir une connexion de
     joueur indefiniment. */
  DELAI_MS: 15000,
  /* CHOISI : 16 Mio par reponse amont, comme smart_rpc.js. Au-dela, la page
     doit couper sa tranche, pas le serveur tout lire en memoire. */
  REPONSE_MAX: 16 * 1024 * 1024,
  /* CHOISI : par IP, un seau de 300 appels, rempli de 5 par seconde (300 par
     minute en regime). Mesure du 18/10/2026 (launchpad_relais.test.js du
     site, fork au bloc 91 991 316, 28 jetons) : un chargement d'Explore = 72
     appels au relais dont 64 eth_getLogs, avant les capitalisations. Quatre
     chargements d'affilee passent, un balayage automatique non. Un appel servi par le cache compte aussi : le
     seau borne ce que la porte accepte, pas seulement ce qu'elle coute. */
  IP_SEAU: 300, IP_PAR_S: 5,
  /* CHOISI : pour tout le serveur, 1 500 appels, 25 par seconde. Le noeud
     amont est souvent celui de la colonie (RPC_URL) : un relais qui le ferait
     saigner priverait la colonie de ses lectures — de l'argent reel. */
  TOUS_SEAU: 1500, TOUS_PAR_S: 25,
  /* Un bloc plus vieux que la pointe de 64 ne bouge plus (Robinhood Chain est
     une chaine Arbitrum Orbit : la sequence est finale bien avant). Le cache
     des journaux ne garde QUE ces plages fermees. CHOISI : 400 entrees,
     48 Mio au plus, 6 h. */
  PROFONDEUR_SURE: 64, CACHE_N: 400, CACHE_OCTETS: 48 * 1024 * 1024, CACHE_MS: 6 * 3600 * 1000,
  /* La pointe relue au plus toutes les 2 s (le temps d'un bloc ou deux) :
     ethers interroge eth_blockNumber en boucle, chaque onglet le ferait. */
  TETE_MS: 2000,
};

const erreur = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const estQte = (x) => typeof x === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(x);
const TAGS_TETE = new Set(['latest', 'pending', 'safe', 'finalized']);

function cree(o) {
  o = o || {};
  const L = Object.assign({}, DEFAUTS, o.limites || {});
  const amont = String(o.amont || '').trim();
  const f = o.fetch || ((u, x) => fetch(u, x));
  const maintenant = o.maintenant || (() => Date.now());
  const seaux = new Map();                       // ip -> { j, t }
  const tous = { j: L.TOUS_SEAU, t: maintenant() };
  const cache = new Map();                       // cle -> { corps (texte du result), octets, t }
  let octetsCache = 0;
  let tete = null;                               // { n, t }
  let teteEnVol = null;
  let chaine = null;                             // eth_chainId : ne change jamais
  const C = { requetes: 0, appels: 0, appels_amont: 0, cache: 0, refus_methode: 0, refus_plage: 0, refus_forme: 0,
    refus_debit: 0, refus_corps: 0, erreurs_amont: 0, depuis: maintenant() };

  function remplit(s, cap, parS) {
    const t = maintenant();
    s.j = Math.min(cap, s.j + ((t - s.t) / 1000) * parS); s.t = t;
  }
  /* Prend n jetons dans le seau de l'IP ET dans celui de tous, ou rien. */
  function prend(ip, n) {
    let s = seaux.get(ip);
    if (!s) {
      if (seaux.size > 20000) for (const [k, v] of seaux) { remplit(v, L.IP_SEAU, L.IP_PAR_S); if (v.j >= L.IP_SEAU) seaux.delete(k); }
      s = { j: L.IP_SEAU, t: maintenant() }; seaux.set(ip, s);
    }
    remplit(s, L.IP_SEAU, L.IP_PAR_S); remplit(tous, L.TOUS_SEAU, L.TOUS_PAR_S);
    if (s.j < n || tous.j < n) return false;
    s.j -= n; tous.j -= n; return true;
  }

  /* Un appel au noeud. Rend { result } ou { error } (celle du noeud, telle
     quelle) ; une panne de transport devient une erreur -32603 sans URL. */
  async function appelle(method, params) {
    if (!amont) return { error: { code: -32603, message: 'relay has no upstream node' } };
    C.appels_amont++;
    let r;
    try {
      r = await f(amont, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(L.DELAI_MS) });
    } catch (e) {
      C.erreurs_amont++;
      return { error: { code: -32603, message: e && e.name === 'TimeoutError' ? 'upstream node timed out' : 'upstream node unreachable' } };
    }
    const lg = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (lg > L.REPONSE_MAX) { C.erreurs_amont++; return { error: { code: -32005, message: 'response too large: read a smaller block range' } }; }
    let texte;
    try { texte = await r.text(); } catch (e) { C.erreurs_amont++; return { error: { code: -32603, message: 'upstream node unreachable' } }; }
    if (texte.length > L.REPONSE_MAX) { C.erreurs_amont++; return { error: { code: -32005, message: 'response too large: read a smaller block range' } }; }
    let j = null; try { j = JSON.parse(texte); } catch (e) { j = null; }
    if (j && typeof j === 'object' && !Array.isArray(j) && (j.error || 'result' in j)) {
      if (j.error) return { error: { code: Number(j.error.code) || -32603, message: String(j.error.message || 'error').slice(0, 300), ...(j.error.data !== undefined ? { data: j.error.data } : {}) } };
      return { result: j.result };
    }
    C.erreurs_amont++;
    return { error: { code: -32603, message: 'upstream node HTTP ' + r.status } };
  }

  async function laTete() {
    const t = maintenant();
    if (tete && t - tete.t < L.TETE_MS) return tete.n;
    if (!teteEnVol) {
      teteEnVol = appelle('eth_blockNumber', []).then((x) => {
        if (estQte(x.result)) tete = { n: parseInt(x.result, 16), t: maintenant() };
        return x;
      }).finally(() => { teteEnVol = null; });
    }
    const x = await teteEnVol;
    if (x.error) throw Object.assign(new Error(x.error.message), { rpc: x.error });
    return tete.n;
  }

  function bloc(v, n) {
    if (v === undefined || v === null || TAGS_TETE.has(v)) return n;
    if (v === 'earliest') return 0;
    if (estQte(v)) return parseInt(v, 16);
    return NaN;
  }
  function metEnCache(cle, valeur) {
    const texte = JSON.stringify(valeur), octets = texte.length;
    if (octets > L.CACHE_OCTETS / 4) return;
    while (cache.size && (cache.size >= L.CACHE_N || octetsCache + octets > L.CACHE_OCTETS)) {
      const [k, v] = cache.entries().next().value; cache.delete(k); octetsCache -= v.octets;
    }
    cache.set(cle, { texte, octets, t: maintenant() }); octetsCache += octets;
  }
  function duCache(cle) {
    const e = cache.get(cle);
    if (!e) return undefined;
    if (maintenant() - e.t > L.CACHE_MS) { cache.delete(cle); octetsCache -= e.octets; return undefined; }
    cache.delete(cle); cache.set(cle, e);       // le plus recemment lu passe en fin de file
    C.cache++;
    return JSON.parse(e.texte);
  }

  /* Un appel du client, deja compte dans le seau. */
  async function un(q) {
    const id = q && (typeof q.id === 'number' || typeof q.id === 'string' || q.id === null) ? q.id : null;
    if (!q || typeof q !== 'object' || Array.isArray(q) || q.jsonrpc !== '2.0' || typeof q.method !== 'string') {
      C.refus_forme++; return erreur(id, -32600, 'invalid request');
    }
    const method = q.method, params = q.params === undefined ? [] : q.params;
    if (!METHODES.has(method)) { C.refus_methode++; return erreur(id, -32601, 'method not allowed: this relay is read-only'); }
    if (!Array.isArray(params) || JSON.stringify(params).length > L.CORPS_MAX) { C.refus_forme++; return erreur(id, -32602, 'invalid params'); }
    const rend = (x) => (x.error ? { jsonrpc: '2.0', id, error: x.error } : { jsonrpc: '2.0', id, result: x.result });

    if (method === 'eth_chainId') {
      if (chaine) { C.cache++; return rend({ result: chaine }); }
      const x = await appelle(method, []); if (estQte(x.result)) chaine = x.result; return rend(x);
    }
    if (method === 'eth_blockNumber') {
      try { const fraiche = tete && maintenant() - tete.t < L.TETE_MS; const n = await laTete(); if (fraiche) C.cache++; return rend({ result: '0x' + n.toString(16) }); }
      catch (e) { return rend({ error: e.rpc || { code: -32603, message: 'upstream node unreachable' } }); }
    }
    if (method === 'eth_getBlockByNumber' && params[1] === true) {
      C.refus_forme++; return erreur(id, -32602, 'full transactions are not relayed: pass false');
    }
    if (method === 'eth_getLogs') {
      const filtre = params[0];
      if (!filtre || typeof filtre !== 'object' || Array.isArray(filtre)) { C.refus_forme++; return erreur(id, -32602, 'invalid params'); }
      if (filtre.blockHash !== undefined) return rend(await appelle(method, params));   // un seul bloc
      let n = null;
      const besoinTete = [filtre.fromBlock, filtre.toBlock].some((v) => v === undefined || v === null || typeof v !== 'string' || !estQte(v));
      if (besoinTete) {
        try { n = await laTete(); } catch (e) { return rend({ error: e.rpc || { code: -32603, message: 'upstream node unreachable' } }); }
      }
      const de = bloc(filtre.fromBlock, n), a = bloc(filtre.toBlock, n);
      if (!Number.isFinite(de) || !Number.isFinite(a)) { C.refus_forme++; return erreur(id, -32602, 'invalid block range'); }
      if (a - de + 1 > L.PLAGE_MAX) {
        C.refus_plage++;
        return erreur(id, -32005, 'block range too large: ' + (a - de + 1) + ' blocks, at most ' + L.PLAGE_MAX.toLocaleString('en-US'));
      }
      /* Le cache seulement pour une plage aux deux bornes numeriques ET fermee. */
      const fermee = estQte(filtre.fromBlock) && estQte(filtre.toBlock);
      if (fermee) {
        let pointe = tete ? tete.n : null;
        if (pointe == null || a > pointe - L.PROFONDEUR_SURE) { try { pointe = await laTete(); } catch (e) { pointe = null; } }
        if (pointe != null && a <= pointe - L.PROFONDEUR_SURE) {
          const cle = JSON.stringify([de, a, filtre.address === undefined ? null : filtre.address, filtre.topics === undefined ? null : filtre.topics]).toLowerCase();
          const vu = duCache(cle);
          if (vu !== undefined) return rend({ result: vu });
          const x = await appelle(method, params);
          if (!x.error && Array.isArray(x.result)) metEnCache(cle, x.result);
          return rend(x);
        }
      }
      return rend(await appelle(method, params));
    }
    return rend(await appelle(method, params));
  }

  /* Le corps texte d'un POST -> { status, corps, entetes? }. */
  async function traite(texte, ip) {
    C.requetes++;
    let q;
    try { q = JSON.parse(texte); } catch (e) { C.refus_forme++; return { status: 400, corps: erreur(null, -32700, 'parse error') }; }
    const lot = Array.isArray(q);
    const liste = lot ? q : [q];
    if (!liste.length) { C.refus_forme++; return { status: 400, corps: erreur(null, -32600, 'empty batch') }; }
    if (liste.length > L.LOT_MAX) { C.refus_forme++; return { status: 400, corps: erreur(null, -32600, 'batch too large: at most ' + L.LOT_MAX + ' calls') }; }
    if (!prend(String(ip || '?'), liste.length)) {
      C.refus_debit++;
      return { status: 429, corps: lot ? liste.map((x) => erreur(x && x.id, -32005, 'rate limited: slow down')) : erreur(q && q.id, -32005, 'rate limited: slow down'),
        entetes: { 'retry-after': '5' } };
    }
    C.appels += liste.length;
    const reps = await Promise.all(liste.map((x) => un(x).catch(() => erreur(x && x.id, -32603, 'relay error'))));
    return { status: 200, corps: lot ? reps : reps[0] };
  }

  const ENTETES = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400',
    'x-content-type-options': 'nosniff' };

  /* La route HTTP. `ip` : celle que le serveur a lue (x-forwarded-for derriere Railway). */
  function sert(req, res, ip) {
    if (req.method === 'OPTIONS') { res.writeHead(204, ENTETES); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, Object.assign({ allow: 'POST, OPTIONS' }, ENTETES)); return res.end(JSON.stringify(erreur(null, -32600, 'POST a JSON-RPC request'))); }
    let n = 0, trop = false; const bouts = [];
    req.on('data', (c) => {
      if (trop) return;
      n += c.length;
      if (n > L.CORPS_MAX) {
        trop = true; C.requetes++; C.refus_corps++;
        res.writeHead(413, Object.assign({ connection: 'close' }, ENTETES));
        res.end(JSON.stringify(erreur(null, -32600, 'request body too large: at most ' + L.CORPS_MAX + ' bytes')));
        req.resume();
        return;
      }
      bouts.push(c);
    });
    req.on('error', () => { if (!res.headersSent) { res.writeHead(400, ENTETES); res.end(); } });
    req.on('end', async () => {
      if (trop) return;
      let r;
      try { r = await traite(Buffer.concat(bouts).toString('utf8'), ip); }
      catch (e) { r = { status: 500, corps: erreur(null, -32603, 'relay error') }; }
      if (res.headersSent) return;
      res.writeHead(r.status, Object.assign({}, ENTETES, r.entetes || {}));
      res.end(JSON.stringify(r.corps));
    });
  }

  function etat() {
    return Object.assign({}, C, { cache_entrees: cache.size, cache_octets: octetsCache, ips: seaux.size, amont_pose: !!amont, methodes: [...METHODES] });
  }

  return { sert, traite, etat, METHODES, LIMITES: L };
}

module.exports = { cree, METHODES, DEFAUTS };
