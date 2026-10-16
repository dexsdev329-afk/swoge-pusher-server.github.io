'use strict';
/* ==================================================================
 * SMART MONEY — LE NOEUD (13/10/2026). LECTURE SEULE.
 * ==================================================================
 *
 * Client du noeud public https://rpc.mainnet.chain.robinhood.com par viem
 * 2.56.9 (version lue dans le paquet installe, 24/09/2026). Aucune methode
 * d'ecriture n'est jamais appelee : la liste METHODES ci-dessous est fermee
 * et tout le reste est refuse AVANT le reseau.
 *
 * Ce que viem fait par defaut et qu'on defait (lu dans node_modules/viem,
 * 13/10) :
 *  - retryCount = 3 (createTransport.js) : viem relancerait seul sur 403, 429
 *    et 5xx. Ici retryCount = 0 : la reprise appartient a ce module, qui
 *    attend (RECULS) puis abandonne la passe ;
 *  - maxResponseBodySize = 10 485 760 octets (utils/rpc/http.js) : 10 000
 *    lignes de Swap v4 font ~9,5 Mo (947 octets par ligne, sonde du 13/10 ;
 *    la plus grosse reponse mesuree : 8 357 329 octets pour 8 827 lignes).
 *    Ici 16 Mio ;
 *  - raw = true : une erreur JSON-RPC revient comme { error, result } au lieu
 *    d'une exception, pour lire le MESSAGE exact du noeud (« only N are
 *    allowed », « exceeds limit of 10000 ») qui decide de la coupe.
 *
 * ---- LA POLITESSE (sonde du 13/10, 409 appels, 2 refus 429) ----
 *  - appels legers : 0 refus sur 91 (jusqu'a 8/s) ; getLogs a 2 s d'ecart :
 *    ~230 appels, 0 refus 429 ; les deux 429 sont tombes a 1,2 s d'ecart juste
 *    apres une requete lourde (refus de plafond sur 1 M de blocs). D'ou 1,5 s
 *    entre deux appels legers, 3 s apres un lourd (getLogs ou lot) ;
 *  - un appel leger est repasse 10 s apres le 429 : recul de 15 s, puis 60 s,
 *    puis ABANDON de la passe (la suivante reprend : les cellules fermees sont
 *    en cache) ;
 *  - 403, 429 ou une reponse qui n'est pas du JSON = un refus ; aucun
 *    Retry-After n'est envoye par ce noeud (sonde) ;
 *  - budget par passe : appels et octets (decompresses), choisis d'apres le
 *    chiffrage du rattrapage (sonde : passes de 600 appels et 60 Mo) ; plus un
 *    PLAFOND QUOTIDIEN partage (revue N9) ;
 *  - revue du 13/10 (N1-N5) : une seule requete en vol pour TOUS les clients
 *    du noeud (file partagee, pas seulement l'echeance) ; un refus recule
 *    l'echeance partagee ; un abandon met le noeud en pause 30 min puis 2 h ;
 *    une reponse de plus de 16 Mio ou un delai depasse sur un getLogs COUPE la
 *    tranche (jamais un refus, jamais rejoue) ; aucun message ne recopie le
 *    texte brut de viem (il contient l'URL du noeud).
 *
 * ---- LES TRANCHES ADAPTATIVES (decision du proprietaire, 13/10) ----
 * Au lieu de 20 000 blocs fixes : on commence LARGE et on coupe en deux
 * seulement si le noeud refuse (plage ou plafond de lignes). Grille dyadique :
 * une cellule (L, i) couvre [i*2^L, (i+1)*2^L - 1] ; deux cellules sont
 * imbriquees ou disjointes, donc une cellule FERMEE (finie sous la pointe
 * sure) ne change plus jamais : cache immuable, cle = empreinte du filtre + L
 * + i, quel que soit le chemin qui y mene.
 *  Limites du noeud (messages exacts, sonde du 13/10) :
 *    une valeur par position + adresse  10 000 000 blocs -> L 23 (8 388 608)
 *    une position en tableau            100 000 blocs   -> L 16 (65 536)
 *    sans adresse                       30 000 blocs    -> L 14 (16 384)
 *    plafond de lignes                  10 000 (-32000 « exceeds limit of 10000 »)
 *  Une limite plus basse annoncee (« only N are allowed ») est APPRISE.
 *  Apres un succes, le niveau suivant vise CIBLE lignes a la densite lue, au
 *  plus +2 niveaux d'un coup ; une cellule vide donne +2.
 *  Calibrage hors ligne du 13/10 (0 appel, vies entieres de NILF et BRODIE
 *  jusqu'au bloc 83 886 079) : prototype de la sonde, cible 7 000 et depart a
 *  Lmax -> 10 / 5 / 17 / 5 appels (Transfer et Swap de chacun) contre 15 / 10 /
 *  19 / 11 avec cible 5 000 et depart L16 ; CE code, rejoue sur les memes
 *  journaux (smart_build/calibre/calibre_prod.js) : 9 / 5 / 16 / 5 appels, 1 et
 *  4 refus de plafond, toutes les lignes rendues (27 921, 8 999, 39 798,
 *  10 636). Avec des tranches fixes de 20 000 blocs, les seuls Transfer de NILF
 *  en demandaient 1 864.
 *  Pointe sure = pointe - 1 000 : le noeud recule de 3 blocs au plus entre
 *  repliques (2 reculs sur 91 lectures, sonde) ; on ne met en cache que sous
 *  cette pointe. Une plage au-dela de la pointe rend [] SANS erreur (sonde) :
 *  on ne demande jamais au-dela de `pointe`.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const URL_DEFAUT = 'https://rpc.mainnet.chain.robinhood.com';
const ESPACE_LEGER_MS = 1500;
const ESPACE_LOURD_MS = 3000;
const RECULS_MS = [15000, 60000];
/* Apres un ABANDON pour refus, le noeud n'est plus appele du tout pendant 30 min,
   puis 2 h si la passe suivante est abandonnee aussi ; remis a zero au premier
   succes. CHOISI (revue du 13/10) : le journal de run.js montre qu'apres un 429
   la passe et la veille revenaient a 3 s d'ecart (07:02:37 429, 07:02:40 200,
   07:02:43 429 de nouveau) ; une passe abandonnee revenait 30 min plus tard sans
   recul plus long. */
const PAUSES_MS = [30 * 60e3, 2 * 3600e3];
const BUDGET_APPELS = 600;
/* Budget d'octets d'une passe : verifie AVANT chaque requete. Une seule reponse
   peut donc le depasser d'au plus CORPS_MAX : le VRAI plafond est budget +
   16 Mio (passe reelle du 13/10 : jusqu'a 71 532 253 octets, +19 %, pour un
   budget de 60 Mo ; revue N6). */
const BUDGET_OCTETS = 60e6;
/* PLAFOND QUOTIDIEN, pour le noeud et tous les clients qui partagent le rythme
   (passe + veille). CHOISI le 13/10 contre la mesure : la passe reelle a fait
   1 831 requetes HTTP en 183,5 min (~14 400 par jour en continu, une toutes les
   3 s pendant le rattrapage estime a 1-2 jours) et 9 980 appels JSON-RPC pour
   4 321 requetes (lots de 20). 12 000 requetes et 1,5 Go par jour : une requete
   toutes les 7 s en moyenne ; le rattrapage dure plus longtemps, le noeud
   public n'est plus sollicite sans arret. */
const PLAFOND_JOUR_HTTP = 12000;
const PLAFOND_JOUR_OCTETS = 1.5e9;
const CORPS_MAX = 16 * 1024 * 1024;
const DELAI_MS = 30000;
const RECUL_SURE = 1000;
const CIBLE = 7000;
const CROIT = 2;
const L_MAX = { simple: 23, multi: 16, sansAdresse: 14 };
const LOT = 20;                   // lots de 20 : 153 ms pour 20 recus (sonde) ; 100 : 6 refus sur 14 (communaute.js, 11/10)
const CACHE_MAX_OCTETS = 1024 * 1024 * 1024;   // 1 Gio sur le volume : CHOISI ; au-dela on lit sans ecrire (et on le DIT : etat.cachePlein)
/* La liste FERMEE des methodes : rien qui signe ou envoie. */
const METHODES = new Set(['eth_blockNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_chainId']);
const TROP_LIGNES = /exceeds limit of (\d+)/i;
const TROP_BLOCS = /only (\d+) are allowed/i;
/* « log query timed out » (message du noeud, vu 2 fois le 13/10 : passe 9 de la
   base M, passe 1 de la base C) : la requete est trop lourde POUR LE NOEUD. Ce
   n'est pas un refus de politesse : on coupe la tranche, on ne la rejoue pas. */
const TROP_LONG = /timed out|timeout|deadline/i;

class RefusNoeud extends Error { constructor(status, detail) { super(`refus du noeud (${status || 'non-JSON'})${detail ? ' : ' + detail : ''}`); this.status = status; } }
class AbandonPasse extends Error { constructor(m) { super(m); this.abandon = true; } }
class BudgetEpuise extends Error { constructor(quoi, n) { super(`budget ${quoi} atteint (${n})`); this.budget = quoi; } }
class MethodeInterdite extends Error {}
/* Une reponse trop lourde (plus de CORPS_MAX octets) ou trop longue a venir
   (delai depasse sur un eth_getLogs) : ni refus ni recul ; lisLogs coupe la
   cellule en deux. Revue N1 du 13/10 : la cellule L22 de la rampe 0x1eef
   (16 822 846 octets) etait retelechargee 3 fois a chaque passe (50,5 Mo). */
class TropLourd extends Error { constructor(quoi, octets) { super('reponse trop lourde (' + quoi + ')'); this.tropLourd = true; this.octets = octets || 0; } }

/** La cause premiere d'une erreur enveloppee par viem. */
function racine(e) { let x = e; for (let k = 0; k < 8 && x && x.cause; k++) { if (x instanceof RefusNoeud || x instanceof BudgetEpuise || x instanceof MethodeInterdite || x instanceof TropLourd || x instanceof AbandonPasse) break; x = x.cause; } return x; }
/** Un libelle COURT et FIXE pour une erreur : jamais le message brut de viem,
 *  qui contient « URL: <url du noeud> » (revue N5 : un SMART_RPC_URL a cle
 *  finissait dans la vue publique /ai/smart). */
function libelle(x) {
  if (!x) return 'unknown';
  if (x instanceof RefusNoeud || x instanceof BudgetEpuise || x instanceof TropLourd || x instanceof AbandonPasse || x instanceof MethodeInterdite) return x.message;
  const n = String(x.name || '');
  if (n === 'TimeoutError') return 'timeout';
  if (n === 'HttpRequestError') return 'network';
  if (n === 'ResponseBodyTooLargeError') return 'body too large';
  if (x.code && /^[A-Z_]+$/.test(String(x.code))) return 'network ' + x.code;
  return n && /^[A-Za-z]+$/.test(n) ? n : 'error';
}

function genre(f) {
  if (!f.address) return 'sansAdresse';
  if (Array.isArray(f.address) && f.address.length > 1) return 'multi';
  if ((f.topics || []).some((t) => Array.isArray(t) && t.length > 1)) return 'multi';
  return 'simple';
}
/** Le filtre normalise : minuscules, tableaux d'un seul element aplatis. */
function normalise(f) {
  const n = (x) => (x == null ? null : Array.isArray(x) ? (x.length === 1 ? n(x[0]) : x.map(n)) : String(x).toLowerCase());
  const o = {};
  if (f.address) o.address = n(f.address);
  o.topics = (f.topics || []).map(n);
  while (o.topics.length && o.topics[o.topics.length - 1] == null) o.topics.pop();
  return o;
}
function empreinte(f) {
  const g = normalise(f);
  return crypto.createHash('sha1').update(JSON.stringify({ a: g.address || null, t: g.topics })).digest('hex').slice(0, 16);
}
const zeros = (p) => { if (p === 0) return 40; let z = 0; while (p % 2 === 0) { p /= 2; z++; } return z; };
const hex = (n) => '0x' + Number(n).toString(16);
const jourUtc = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * deps :
 *   url          le noeud (SMART_RPC_URL, defaut le noeud public)
 *   prendre      fetch (les essais en donnent un faux)
 *   horloge, dors
 *   dossier      ou vit le cache brut (DATA_DIR/smart_money/brut)
 *   espaceLegerMs, espaceLourdMs, reculs, pauses, budgetAppels, budgetOctets, cacheMaxOctets,
 *   corpsMax, delaiMs, plafondJourHttp, plafondJourOctets
 *   prefixeHash  '' (passe) ou 'V' (veille) : les recus et tx de la veille ont leur
 *                propre prefixe, purge apres 24 h (purgeVeille)
 *   journal(ligne)  optionnel : chaque requete (methode, ms, octets, statut, appels JSON-RPC)
 *   rythme       PARTAGE entre les clients du meme noeud (passe et veille) : une
 *                FILE (une seule requete en vol, revue N2 du 13/10 : 222
 *                chevauchements sur 1 669 requetes quand seul `prochain` etait
 *                partage), l'echeance `prochain` (avancee aussi par un refus :
 *                les deux clients reculent ensemble, revue N3), les abandons et
 *                la pause, et le compte du jour (plafond quotidien)
 */
function nouveauRythme() { return { prochain: 0, file: Promise.resolve(), abandons: 0, pause: 0, jour: { cle: null, http: 0, rpc: 0, octets: 0 } }; }
function cree(deps0) {
  const deps = Object.assign({
    url: URL_DEFAUT,
    prendre: (...a) => fetch(...a),
    horloge: () => Date.now(),
    dors: (ms) => new Promise((r) => setTimeout(r, ms)),
    dossier: null,
    espaceLegerMs: ESPACE_LEGER_MS,
    espaceLourdMs: ESPACE_LOURD_MS,
    reculs: RECULS_MS,
    pauses: PAUSES_MS,
    budgetAppels: BUDGET_APPELS,
    budgetOctets: BUDGET_OCTETS,
    cacheMaxOctets: CACHE_MAX_OCTETS,
    corpsMax: CORPS_MAX,
    delaiMs: DELAI_MS,
    plafondJourHttp: PLAFOND_JOUR_HTTP,
    plafondJourOctets: PLAFOND_JOUR_OCTETS,
    prefixeHash: '',
    journal: null,
  }, deps0 || {});
  const viem = require('viem');
  const rythme = deps.rythme || nouveauRythme();
  for (const [k, v] of Object.entries(nouveauRythme())) if (rythme[k] === undefined) rythme[k] = v;
  /* Le compte du jour : celui du rythme (partage, revue N9), ou un compte
     PROPRE (`deps.jourPropre`) pour un client qui a son plafond a lui — les
     lancements Pons toutes les 60 s (smart_lancements.js, 15/10) : la file
     et l'espacement restent partages, seul le plafond du jour est separe,
     pour que la passe et la veille ne soient pas affamees (mesure et choix :
     EXPLOITATION.md, « Lancements Pons »). */
  const jourPropre = deps.jourPropre ? { cle: null, http: 0, rpc: 0, octets: 0 } : null;
  const jourDe = () => jourPropre || rythme.jour;
  /* appels = requetes HTTP ; rpc = appels JSON-RPC (un lot de 20 compte 20 : revue N9) */
  const etat = { appels: 0, rpc: 0, octets: 0, refus: 0, reculs: 0, coupesLourdes: 0, depuisCache: 0, cacheOctets: null, cachePlein: false, lmax: {}, passe: { appels: 0, rpc: 0, octets: 0 },
                 budget: { appels: deps.budgetAppels, octets: deps.budgetOctets } };
  /** Retire toute trace de l'URL du noeud d'un texte (revue N5). */
  const masque = (s) => { let t = String(s == null ? '' : s); const u = String(deps.url || ''); if (u) t = t.split(u).join('<node>'); return t.replace(/URL: \S+/g, 'URL: <node>'); };

  // ---------------------------------------------------------- le transport
  /** Lit le corps sans jamais depasser corpsMax : Content-Length d'abord, puis
   *  en flux ; au-dela, TropLourd (lecture coupee). */
  async function lisCorps(r) {
    const lg = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('content-length')) : 0;
    if (lg && lg > deps.corpsMax) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* rien */ } throw new TropLourd('content-length ' + lg, 0); }
    if (r.body && typeof r.body.getReader === 'function') {
      const rd = r.body.getReader(); const morceaux = []; let n = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        n += value.byteLength;
        if (n > deps.corpsMax) { try { await rd.cancel(); } catch (e) { /* rien */ } throw new TropLourd(n + ' octets lus', n); }
        morceaux.push(Buffer.from(value));
      }
      return Buffer.concat(morceaux).toString('utf8');
    }
    const t = await r.text();
    const n = Buffer.byteLength(t || '');
    if (n > deps.corpsMax) throw new TropLourd(n + ' octets', n);
    return t;
  }
  /* Toute requete HTTP passe ici : methode autorisee, budgets (passe, jour),
     comptage des octets, refus reconnus. viem ne voit jamais un 403/429.
     L'attente et la file sont dans enFile(), AVANT viem : son delai de 30 s ne
     compte que la requete elle-meme, jamais l'attente de son tour. */
  async function fetchFn(url, init) {
    let corps;
    try { corps = JSON.parse(init.body); } catch (e) { throw new MethodeInterdite('corps illisible'); }
    const liste = Array.isArray(corps) ? corps : [corps];
    for (const c of liste) if (!METHODES.has(c.method)) throw new MethodeInterdite('methode refusee : ' + c.method);
    verifieBudgets();
    const J = jourDe();
    etat.appels++; etat.passe.appels++; J.http++;
    etat.rpc += liste.length; etat.passe.rpc += liste.length; J.rpc += liste.length;
    const t0 = deps.horloge();
    let r, texte, octets = 0;
    try {
      r = await deps.prendre(deps.url, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' }, body: init.body, signal: init.signal });
      texte = await lisCorps(r);
      octets = Buffer.byteLength(texte || '');
    } catch (e) {
      if (e instanceof TropLourd) { octets = e.octets; etat.coupesLourdes++; }
      throw e;
    } finally {
      etat.octets += octets; etat.passe.octets += octets; J.octets += octets;
      if (deps.journal) deps.journal({ t: t0, methode: Array.isArray(corps) ? 'lot:' + corps.length + 'x' + corps[0].method : corps.method, rpc: liste.length, status: r ? r.status : null, ms: deps.horloge() - t0, octets, trop: octets > deps.corpsMax || undefined });
    }
    let j = null; try { j = JSON.parse(texte); } catch (e) { j = null; }
    const msg = j && !Array.isArray(j) && j.error ? String(j.error.message || '') : '';
    const refus = r.status === 403 || r.status === 429 || j === null ||
      (j && !Array.isArray(j) && j.error && (j.error.code === 429 || /too many requests|rate limit/i.test(msg)));
    if (refus) { etat.refus++; throw new RefusNoeud(r.status, j === null ? 'reponse non JSON' : masque(msg).slice(0, 120)); }
    rythme.abandons = 0;
    return new Response(texte, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  /** Budgets de la passe et plafond du jour : verifies AVANT d'attendre son
   *  tour, et encore juste avant la requete. */
  function verifieBudgets() {
    if (etat.passe.appels >= etat.budget.appels) throw new BudgetEpuise('appels', etat.budget.appels);
    if (etat.passe.octets >= etat.budget.octets) throw new BudgetEpuise('octets', etat.budget.octets);
    const J = jourDe(), cle = jourUtc(deps.horloge());
    if (J.cle !== cle) { J.cle = cle; J.http = 0; J.rpc = 0; J.octets = 0; }
    if (J.http >= deps.plafondJourHttp) throw new BudgetEpuise('du jour (requetes)', deps.plafondJourHttp);
    if (J.octets >= deps.plafondJourOctets) throw new BudgetEpuise('du jour (octets)', deps.plafondJourOctets);
  }
  /** La FILE du noeud : une seule requete en vol pour tous les clients du meme
   *  rythme ; chacune attend l'echeance, puis la repousse a sa fin. */
  function enFile(fn, lourd) {
    const tour = rythme.file.then(async () => {
      if (rythme.pause > deps.horloge()) throw new AbandonPasse(`noeud en pause apres ${rythme.abandons} abandon(s), jusqu a ${new Date(rythme.pause).toISOString()}`);
      verifieBudgets();
      const attente = rythme.prochain - deps.horloge();
      if (attente > 0) await deps.dors(attente);
      try { return await fn(); }
      finally { rythme.prochain = Math.max(rythme.prochain, deps.horloge() + (lourd ? deps.espaceLourdMs : deps.espaceLegerMs)); }
    });
    rythme.file = tour.then(() => {}, () => {});
    return tour;
  }
  /** Un refus : l'echeance PARTAGEE recule (les deux clients reculent ensemble). */
  function recule(ms) { etat.reculs++; rythme.prochain = Math.max(rythme.prochain, deps.horloge() + ms); }
  /** Le dernier recul est passe : abandon, et pause croissante du noeud. */
  function abandonne(quoi, x) {
    rythme.abandons++;
    rythme.pause = deps.horloge() + deps.pauses[Math.min(rythme.abandons, deps.pauses.length) - 1];
    return new AbandonPasse(masque(quoi + ' : ' + libelle(x)).slice(0, 200) + ' — passe abandonnee apres ' + deps.reculs.length + ' reculs');
  }
  const chaine = viem.defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [deps.url] } }, contracts: { multicall3: { address: '0xca11bde05977b3631167028862be2a173976ca11' } } });
  const transport = (lot) => viem.http(deps.url, { fetchFn, retryCount: 0, timeout: deps.delaiMs, maxResponseBodySize: deps.corpsMax + 1024, raw: true, batch: lot ? { batchSize: LOT, wait: 0 } : false });
  const client = viem.createPublicClient({ chain: chaine, transport: transport(false) });
  const clientLot = viem.createPublicClient({ chain: chaine, transport: transport(true) });

  /** Un appel : { result } ou { erreur: { code, message } }. Sur refus :
   *  recul puis reprise ; apres le dernier recul, AbandonPasse. Sur un
   *  eth_getLogs trop lourd ou trop long : TropLourd (lisLogs coupe). */
  async function appel(method, params) {
    for (let k = 0; ; k++) {
      try {
        const r = await enFile(() => client.request({ method, params }, { retryCount: 0 }), method === 'eth_getLogs');
        if (r && r.error) return { erreur: { code: r.error.code, message: masque(r.error.message || '') } };
        return { result: r ? r.result : null };
      } catch (e) {
        const x = racine(e);
        if (x instanceof BudgetEpuise || x instanceof MethodeInterdite || x instanceof AbandonPasse) throw x;
        if (x instanceof TropLourd) throw x;
        if (method === 'eth_getLogs' && x && x.name === 'TimeoutError') { etat.coupesLourdes++; throw new TropLourd('delai de ' + deps.delaiMs + ' ms depasse'); }
        if (k >= deps.reculs.length) throw abandonne('noeud', x);
        recule(deps.reculs[k]);
      }
    }
  }
  /** Un lot de requetes (LOT par requete HTTP). Rend les resultats dans l'ordre
   *  ({ result } ou { erreur }). */
  async function lot(requetes) {
    const out = [];
    for (let d = 0; d < requetes.length; d += LOT) {
      const morceau = requetes.slice(d, d + LOT);
      for (let k = 0; ; k++) {
        try {
          const rs = await enFile(() => Promise.all(morceau.map((q) => clientLot.request(q, { retryCount: 0 }))), true);
          for (const r of rs) out.push(r && r.error ? { erreur: { code: r.error.code, message: masque(r.error.message || '') } } : { result: r ? r.result : null });
          break;
        } catch (e) {
          const x = racine(e);
          if (x instanceof BudgetEpuise || x instanceof MethodeInterdite || x instanceof AbandonPasse) throw x;
          if (x instanceof TropLourd) throw new AbandonPasse('noeud (lot) : ' + x.message);   // pas un refus : aucune pause
          if (k >= deps.reculs.length) throw abandonne('noeud (lot)', x);
          recule(deps.reculs[k]);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------- le cache brut
  const D = deps.dossier ? path.join(deps.dossier, 'brut') : null;
  function tailleCache() {
    if (!D) return 0;
    if (etat.cacheOctets == null) { etat.cacheOctets = 0; try { for (const f of fs.readdirSync(D)) { try { etat.cacheOctets += fs.statSync(path.join(D, f)).size; } catch (e) { /* rien */ } } } catch (e) { /* pas encore de dossier */ } }
    return etat.cacheOctets;
  }
  function cacheLit(cle) {
    if (!D) return null;
    const f = path.join(D, cle + '.json.gz');
    try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch (e) { return null; }
  }
  /** Immuable : un fichier existant n'est JAMAIS reecrit ; ecriture .tmp puis rename. */
  function cacheEcrit(cle, contenu) {
    if (!D) return false;
    const f = path.join(D, cle + '.json.gz');
    if (fs.existsSync(f)) return false;
    if (tailleCache() >= deps.cacheMaxOctets) { etat.cachePlein = true; return false; }
    fs.mkdirSync(D, { recursive: true });
    const z = zlib.gzipSync(JSON.stringify(contenu));
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, z);
    fs.renameSync(tmp, f);
    etat.cacheOctets = tailleCache() + z.length;
    return true;
  }

  // ---------------------------------------------------------- la pointe
  async function pointe() {
    const r = await appel('eth_blockNumber', []);
    if (r.erreur || !r.result) throw new AbandonPasse('eth_blockNumber illisible');
    const h = parseInt(r.result, 16);
    return { pointe: h, sure: h - RECUL_SURE };
  }

  // ---------------------------------------------------------- les journaux
  /**
   * lisLogs(filtre, de, a, { pointe, sure, maxLignes, premier, niveauDepart })
   * Rend { logs, stats }. Les cellules fermees debordant [de, a] sont lues en
   * entier (cachables) puis filtrees ; la queue ouverte est lue au plus juste.
   * `premier` : s'arrete a la premiere cellule non vide (1re trace d'un jeton).
   * `maxLignes` : leve TropDeLignes au-dela (le lecteur bascule alors en
   * lecture par acheteur).
   */
  async function lisLogs(filtre0, de, a, o) {
    const filtre = normalise(filtre0);
    const g = genre(filtre);
    let lmax = Math.min(L_MAX[g], etat.lmax[g] != null ? etat.lmax[g] : 99);
    const emp = empreinte(filtre);
    const st = { appels: 0, coupes: 0, coupesSansAppel: 0, refusLignes: 0, refusBlocs: 0, depuisCache: 0, lignes: 0, cellules: 0 };
    const logs = [];
    const haut = Math.min(a, o.pointe);
    if (de > haut) return { logs, stats: st };
    let voulu = o.niveauDepart != null ? Math.min(o.niveauDepart, lmax) : lmax;
    const pile = [];
    const prochaine = (pos, premiere) => {
      const L = premiere ? Math.min(lmax, voulu) : Math.min(lmax, voulu, zeros(pos));
      return { L, i: Math.floor(pos / 2 ** L) };
    };
    const fils = (c) => [{ L: c.L - 1, i: 2 * c.i }, { L: c.L - 1, i: 2 * c.i + 1 }].filter((f) => f.i * 2 ** f.L <= haut && (f.i + 1) * 2 ** f.L - 1 >= de);
    pile.push(prochaine(de, true));
    while (pile.length) {
      const c = pile.shift();
      if (c.L > lmax) { pile.unshift(...fils(c)); continue; }
      const debut = c.i * 2 ** c.L, fin = (c.i + 1) * 2 ** c.L - 1;
      if (debut > haut) break;
      const ferme = fin <= o.sure;
      /* une cellule qui deborde la fin demandee ET la pointe sure, alors que la
         fin demandee est sous la pointe sure : on descend (sans appel) jusqu'a
         une cellule fermee, lue en entier et cachee. Sans cela, une lecture
         bornee sous la pointe (1re trace d'un jeton, fenetre de naissance)
         relisait la meme queue « ouverte » a chaque passe (essai du 13/10 : 23
         appels rejoues par passe, aucune passe de 25 appels ne finissait). */
      if (!ferme && fin > haut && haut <= o.sure && c.L > 0) { st.coupes++; st.coupesSansAppel++; pile.unshift(...fils(c)); continue; }
      const cle = 'L_' + emp + '_L' + c.L + '_' + c.i;
      let lus = ferme ? cacheLit(cle) : null;
      if (!lus && c.L > 0) {
        /* ce que le cache sait sans appel, pour une cellule fermee OU ouverte :
           elle (ou une cellule plus petite au meme debut, dont elle contient
           toutes les lignes) depasse le plafond ; ou une cellule plus petite
           au meme debut est deja lue (epine gauche). Dans les deux cas on
           coupe sans rien demander. Sans cela, la queue ouverte rejouait a
           chaque passe les refus de plafond de ses ancetres (essai du 13/10 :
           3 appels au lieu de 1 a la deuxieme lecture). */
        let couper = ferme && !!cacheLit(cle + '_trop');
        for (let l = c.L - 1; l >= 0 && !couper; l--) {
          const k = 'L_' + emp + '_L' + l + '_' + (c.i * 2 ** (c.L - l));
          if (cacheLit(k + '_trop') || cacheLit(k)) couper = true;
        }
        if (couper) { st.coupes++; st.coupesSansAppel++; voulu = c.L - 1; pile.unshift(...fils(c)); continue; }
      }
      if (lus) { st.depuisCache++; etat.depuisCache++; }
      else {
        const q0 = ferme ? debut : Math.max(debut, de);
        const q1 = ferme ? fin : Math.min(fin, haut);
        if (q1 < q0) break;
        let r;
        try { r = await appel('eth_getLogs', [Object.assign({ fromBlock: hex(q0), toBlock: hex(q1) }, filtre.address ? { address: filtre.address } : {}, { topics: filtre.topics })]); }
        catch (e) { if (!(e instanceof TropLourd)) throw e; r = { erreur: { code: null, message: e.message, lourd: true } }; }
        st.appels++;
        if (r.erreur) {
          const msg = r.erreur.message;
          const mB = msg.match(TROP_BLOCS);
          if (mB) { st.refusBlocs++; const l = Math.floor(Math.log2(Number(mB[1]))); lmax = Math.min(lmax, l); etat.lmax[g] = lmax; }
          else if (TROP_LIGNES.test(msg) || r.erreur.code === -32005) { st.refusLignes++; if (ferme) cacheEcrit(cle + '_trop', [true]); }
          /* trop lourde (> corpsMax) ou trop longue (delai, « log query timed
             out ») : meme traitement que le plafond de lignes, jamais un recul */
          else if (r.erreur.lourd || TROP_LONG.test(msg)) { st.refusLourds = (st.refusLourds || 0) + 1; if (ferme) cacheEcrit(cle + '_trop', [true]); }
          else throw new Error('erreur du noeud sur eth_getLogs : ' + msg.slice(0, 200));
          if (c.L === 0) throw new Error('un seul bloc depasse le plafond du noeud');
          st.coupes++; voulu = c.L - 1;
          pile.unshift(...fils(c));
          continue;
        }
        lus = Array.isArray(r.result) ? r.result : [];
        if (ferme) cacheEcrit(cle, lus);
      }
      st.cellules++;
      let garde = 0;
      for (const x of lus) { const b = parseInt(x.blockNumber, 16); if (b >= de && b <= haut) { logs.push(x); garde++; } }
      st.lignes += garde;
      if (o.maxLignes && logs.length > o.maxLignes) { const e = new Error('trop de lignes'); e.tropDeLignes = true; e.stats = st; throw e; }
      if (o.premier && garde > 0) { st.premier = true; break; }
      const dens = lus.length / 2 ** c.L;
      const vise = dens > 0 ? Math.floor(Math.log2(CIBLE / dens)) : c.L + CROIT;
      voulu = Math.max(0, Math.min(lmax, c.L + CROIT, vise));
      if (!pile.length) {
        const pos = fin + 1;
        if (pos <= haut) pile.push(prochaine(pos, false));
      }
    }
    return { logs, stats: st };
  }

  // ---------------------------------------------------------- recus, tx, en-tetes
  /** Recus et tx par hash : immuables une fois inclus SOUS LA POINTE SURE, donc
   *  caches a cette condition seulement (comme les en-tetes et les cellules ;
   *  revue N7 du 13/10 : 17 recus de veille ecrits jusqu'a 219 blocs de la
   *  pointe). `sure` absent : rien n'est ecrit. */
  async function parHash(methode, prefixe, hashes, sure) {
    const out = new Map(); const manque = [];
    const P = deps.prefixeHash + prefixe;
    for (const h of hashes) { const c = cacheLit(P + h.toLowerCase()); if (c) { out.set(h, c); etat.depuisCache++; } else manque.push(h); }
    const rs = await lot(manque.map((h) => ({ method: methode, params: [h] })));
    rs.forEach((r, k) => {
      if (!r.result) return;
      out.set(manque[k], r.result);
      const b = r.result.blockNumber == null ? null : parseInt(r.result.blockNumber, 16);
      if (sure != null && b != null && isFinite(b) && b <= sure) cacheEcrit(P + manque[k].toLowerCase(), r.result);
    });
    return out;
  }
  const recus = (hashes, sure) => parHash('eth_getTransactionReceipt', 'R_', hashes, sure);
  const transactions = (hashes, sure) => parHash('eth_getTransactionByHash', 'T_', hashes, sure);
  /** Le code des adresses (eth_getCode, en lots) : '0x' = wallet ; 0xef0100… =
   *  wallet delegue EIP-7702 ; autre chose = contrat. Jamais en cache (le code
   *  d'une adresse change). */
  async function codes(adresses) {
    const rs = await lot(adresses.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    return new Map(adresses.map((a, k) => [a, rs[k] && rs[k].result != null ? String(rs[k].result) : null]));
  }
  /** Purge les recus et tx de la VEILLE (prefixe V) plus vieux que `ageMs` : ils
   *  ne servent plus apres 24 h (revue N8 : 1 430 fichiers en 3 h 34 de veille,
   *  ~11 Mo/jour sans fin). Ceux de la passe restent : un jeton relu les reprend. */
  function purgeVeille(ageMs) {
    if (!D) return 0;
    let n = 0;
    const limite = deps.horloge() - ageMs;
    let l = []; try { l = fs.readdirSync(D); } catch (e) { return 0; }
    for (const f of l) {
      if (!/^V[RT]_/.test(f)) continue;
      const x = path.join(D, f);
      try { const st = fs.statSync(x); if (st.mtimeMs < limite) { fs.unlinkSync(x); n++; if (etat.cacheOctets != null) etat.cacheOctets -= st.size; } } catch (e) { /* rien */ }
    }
    if (n && etat.cacheOctets != null && etat.cacheOctets < deps.cacheMaxOctets) etat.cachePlein = false;
    return n;
  }
  /** Horodatages (s) des blocs ; caches sous la pointe sure. */
  async function horodatages(blocs, sure) {
    const out = new Map(); const manque = [];
    for (const b of new Set(blocs)) { const c = b <= sure ? cacheLit('B_' + b) : null; if (c) out.set(b, c.t); else manque.push(b); }
    const rs = await lot(manque.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })));
    rs.forEach((r, k) => { if (r.result && r.result.timestamp) { const t = parseInt(r.result.timestamp, 16); out.set(manque[k], t); if (manque[k] <= sure) cacheEcrit('B_' + manque[k], { t }); } });
    return out;
  }

  // ---------------------------------------------------------- lectures de contrats
  const ABI_MC = viem.parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
  const ABI_20 = viem.parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)',
    'function token0() view returns (address)', 'function token1() view returns (address)']);
  const MC3 = '0xca11bde05977b3631167028862be2a173976ca11';
  /** Multicall3 aggregate3 en un eth_call (50 balanceOf en 68 ms, sonde).
   *  `appels` : [{ to, fn, args }] sur l'ABI ERC-20. Rend [valeur|null]. */
  async function multicall(appels) {
    const out = [];
    for (let d = 0; d < appels.length; d += 50) {
      const m = appels.slice(d, d + 50);
      const data = viem.encodeFunctionData({ abi: ABI_MC, functionName: 'aggregate3', args: [m.map((x) => ({ target: x.to, allowFailure: true, callData: viem.encodeFunctionData({ abi: ABI_20, functionName: x.fn, args: x.args || [] }) }))] });
      const r = await appel('eth_call', [{ to: MC3, data }, 'latest']);
      if (r.erreur || !r.result) { for (let k = 0; k < m.length; k++) out.push(null); continue; }
      const res = viem.decodeFunctionResult({ abi: ABI_MC, functionName: 'aggregate3', data: r.result });
      res.forEach((x, k) => {
        if (!x.success || x.returnData === '0x') { out.push(null); return; }
        try { out.push(viem.decodeFunctionResult({ abi: ABI_20, functionName: m[k].fn, data: x.returnData })); } catch (e) { out.push(null); }
      });
    }
    return out;
  }
  async function soldes(jeton, wallets) {
    const v = await multicall(wallets.map((w) => ({ to: jeton, fn: 'balanceOf', args: [w] })));
    return new Map(wallets.map((w, k) => [w, v[k]]));
  }
  async function infosJeton(jeton) {
    const [offre, decimales, symbole, nom] = await multicall(['totalSupply', 'decimals', 'symbol', 'name'].map((fn) => ({ to: jeton, fn })));
    return { offre, decimales: decimales == null ? null : Number(decimales), symbole: symbole == null ? null : String(symbole).replace(/[^\x20-\x7e]/g, '').slice(0, 24), nom: nom == null ? null : String(nom).replace(/[^\x20-\x7e]/g, '').slice(0, 60) };
  }

  return {
    etat, appel, lot, lisLogs, jour: () => Object.assign({}, jourDe()), recus, transactions, codes, horodatages, multicall, soldes, infosJeton, pointe,
    cacheLit, cacheEcrit, purgeVeille, masque, rythme,
    /** Remet les compteurs de passe a zero ; `b` borne CETTE passe seulement. */
    nouvellePasse(b) { etat.passe = { appels: 0, rpc: 0, octets: 0 }; etat.budget = { appels: (b && b.appels) || deps.budgetAppels, octets: (b && b.octets) || deps.budgetOctets }; },
  };
}

module.exports = {
  cree, nouveauRythme, genre, normalise, empreinte, zeros, racine, hex, libelle,
  RefusNoeud, AbandonPasse, BudgetEpuise, MethodeInterdite, TropLourd,
  URL_DEFAUT, ESPACE_LEGER_MS, ESPACE_LOURD_MS, RECULS_MS, PAUSES_MS, BUDGET_APPELS, BUDGET_OCTETS, PLAFOND_JOUR_HTTP, PLAFOND_JOUR_OCTETS, CORPS_MAX, RECUL_SURE, CIBLE, L_MAX, LOT, METHODES,
};
