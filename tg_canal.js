'use strict';
/* ==========================================================================
 * DES CANAUX TELEGRAM COMME SOURCE D'ADRESSES — LECTURE PASSIVE, RIEN DE PLUS
 *
 * « SWOGE AI surveille ce canal Telegram, il y met des contrats et des liens
 *   DexScreener. » — @Exceptionalmemes, 21 septembre 2026. Repris le 26 :
 *   « faut bien vérifier que c'est du Robinhood chain ; je te donnerai
 *   d'autres canaux à surveiller. »
 *
 * Ce que fait ce module : lire l'apercu PUBLIC de canaux (t.me/s/<canal>) et
 * en tirer des ADRESSES DE JETON candidates, sur Robinhood Chain seulement. Il
 * ne juge pas, n'achete pas, ne previent personne : la colonie decide seule, et
 * le trait `origine = 'telegram'` la laisse APPRENDRE ce que vaut chaque source.
 *
 * ---- POURQUOI L'APERCU WEB, ET PAS L'API BOT ----
 * L'API Bot ne rend les posts d'un canal QUE si le bot en est administrateur ;
 * ces canaux sont a d'autres. L'apercu `https://t.me/s/<canal>` sert les
 * derniers posts en HTML, sans cle ni permission. Mesure du 26 septembre 2026
 * sur @Exceptionalmemes : HTTP 200, ~98 ko, 20 messages.
 *
 * ---- CE QUE LE RELEVE DU 26 SEPTEMBRE A MONTRE (et que ce module corrige) ----
 * En cinq jours : 344 lectures du canal, 2 039 appels DexScreener, AUCUN jeton
 * dans le trait `origine` (62 691 observations). Le canal poste surtout du
 * Solana (`…pump`), des tickers sans adresse et des images. Mais trois defauts
 * faisaient aussi perdre ou gaspiller :
 *   1. un lien `dexscreener.com/robinhood/0x…` pointe le plus souvent une
 *      PAIRE : cherchee comme un jeton, elle ne rendait rien — un vrai jeton
 *      Robinhood poste ainsi etait perdu. On resout la paire (API DexScreener
 *      `pairs/robinhood/…`, puis token0/token1 sur la chaine quand DexScreener
 *      ne la connait pas — c'est le cas de la paire v2 du $SWOGE lui-meme) ;
 *   2. un identifiant de piscine v4 fait 64 hexa : l'ancien motif en prenait
 *      les 40 premiers, une fausse adresse (un hash de transaction aussi) ;
 *   3. une adresse hors Robinhood n'etait pas retenue : redemandee a chaque
 *      tour — d'ou les 2 039 appels. Elle est desormais ecartee REJET_MS.
 * Un lien DexScreener d'une AUTRE chaine (`/base/`, `/solana/`…) est ecarte
 * sans un appel. Un ticker seul ($METCAT) n'est jamais pris : il designerait
 * n'importe quel clone (cf. le clone du $SWOGE, memes nom et symbole).
 * ======================================================================== */

const cfg = require('./config');

/* Les canaux surveilles : `TG_SURV_CANAUX`, reglable A CHAUD depuis le panneau
   (reglages.js), sans redemarrer. Vide : la source s'eteint proprement.
   On accepte « @canal », « t.me/canal », « https://t.me/s/canal ». */
function normaliseCanal(x) {
  const s = String(x || '').trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?t(elegram)?\.me\/(s\/)?/i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? s : null;
}
/* Les canaux AJOUTES par la decouverte (tg_decouverte.js), en plus de la liste. */
let _auto = () => [];
function poseAuto(fn) { _auto = fn; }
/** Les canaux de la liste (reglage), sans ceux de la decouverte. */
function canauxListe() {
  const brut = cfg.TG_SURV_CANAUX !== undefined ? cfg.TG_SURV_CANAUX
    : (process.env.TG_SURV_CANAUX === undefined ? 'Exceptionalmemes' : process.env.TG_SURV_CANAUX);
  return [...new Set(String(brut || '').split(/[,\s]+/).map(normaliseCanal).filter(Boolean))];
}
function canaux() {
  const l = canauxListe(), bas = new Set(l.map((c) => c.toLowerCase()));
  let a = [];
  try { a = (_auto() || []).map(normaliseCanal).filter((c) => c && !bas.has(c.toLowerCase())); } catch (e) { a = []; }
  return l.concat(a);
}

/* L'apercu pese ~100 ko et un canal ne poste pas a la seconde. */
const TTL_MS = Math.max(30, Number(process.env.TG_SURV_TTL_S || 120)) * 1000;
/* Une adresse sans paire Robinhood : pas redemandee avant six heures. */
const REJET_MS = 6 * 3600e3;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NATIF = '0x0000000000000000000000000000000000000000';
const MONNAIES = new Set([WETH, USDG, NATIF]);

/* Le reseau et la chaine, injectables pour les essais : aucun appel sortant en test. */
let _lit = (url) => fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))));
let _paire = null;          /* (adresse) → { token0, token1 } lus sur la chaine, ou null */
function _reseau(fn) { _lit = fn; }
function _chaine(fn) { _paire = fn; }
function lisPaire(adr) {
  if (_paire) return _paire(adr);
  if (!cfg.RPC_URL) return Promise.resolve(null);
  const { ethers } = require('ethers');
  const p = new ethers.providers.JsonRpcProvider(cfg.RPC_URL, 4663);
  const c = new ethers.Contract(adr, ['function token0() view returns (address)', 'function token1() view returns (address)'], p);
  return Promise.all([c.token0(), c.token1()]).then(([a, b]) => ({ token0: a, token1: b })).catch(() => null);
}

/* Les deux formes qui portent une adresse EVM. Bornees : un identifiant v4 (64
   hexa) ou un hash ne donne pas une fausse adresse de 40. */
const RE_DEX = /dexscreener\.com\/([a-z0-9-]+)\/(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/gi;
const RE_NUE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const RE_SOL = /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g;

/**
 * Ce qu'un texte (un message, ou tout un HTML) propose :
 *   { liens: [{ reseau, id }], nues: [adresse], horsChaine: n }
 * Les adresses d'un lien DexScreener ne sont pas recomptees comme « nues ».
 */
function analyse(texte) {
  const s = String(texte || '');
  const liens = [], nues = new Set();
  let horsChaine = 0, m;
  RE_DEX.lastIndex = 0;
  while ((m = RE_DEX.exec(s))) {
    const reseau = m[1].toLowerCase(), id = m[2].toLowerCase();
    if (reseau === 'robinhood') { if (!liens.some((l) => l.id === id)) liens.push({ reseau, id }); } else horsChaine++;
  }
  const sansLiens = s.replace(RE_DEX, ' ');
  RE_NUE.lastIndex = 0;
  while ((m = RE_NUE.exec(sansLiens))) nues.add(m[0].toLowerCase());
  /* Les mints Solana (souvent en « …pump ») : comptes, jamais proposes. */
  const sol = (sansLiens.replace(/<[^>]+>/g, ' ').match(RE_SOL) || []).filter((x) => /pump$/.test(x) || /[a-z]/.test(x) && /[A-Z]/.test(x) && /[0-9]/.test(x));
  horsChaine += sol.length;
  return { liens, nues: [...nues].filter((a) => !liens.some((l) => l.id === a)), horsChaine };
}

/** Compatibilite : toutes les adresses EVM d'un texte (liens Robinhood compris), minuscules. */
function extraisAdresses(texte) {
  const a = analyse(texte);
  return [...new Set(a.liens.filter((l) => l.id.length === 42).map((l) => l.id).concat(a.nues))];
}

/* L'apercu, message par message : { post: 'canal/123', t: iso, html }. Sans
   blocs reconnus (forme changee), tout le HTML compte pour un message. */
function messages(html) {
  const blocs = String(html || '').split('tgme_widget_message_wrap').slice(1);
  if (!blocs.length) return [{ post: null, t: null, html: String(html || '') }];
  return blocs.map((b) => ({ post: (b.match(/data-post="([^"]+)"/) || [])[1] || null,
                             t: (b.match(/datetime="([^"]+)"/) || [])[1] || null, html: b }));
}

/* ---- RESOUDRE un lien DexScreener Robinhood vers l'adresse du JETON ----
   Le cote qui n'est pas une monnaie (WETH, USDG, ETH natif). */
function cotéJeton(a, b) {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  if (x && !MONNAIES.has(x)) return x;
  if (y && !MONNAIES.has(y)) return y;
  return null;
}
async function resousLien(id) {
  try {
    const j = JSON.parse(await _lit('https://api.dexscreener.com/latest/dex/pairs/robinhood/' + id));
    const p = (j.pairs || [])[0] || j.pair;
    if (p && String(p.chainId).toLowerCase() === 'robinhood') return cotéJeton(p.baseToken && p.baseToken.address, p.quoteToken && p.quoteToken.address);
  } catch (e) { /* DexScreener muet : la chaine en dessous */ }
  if (id.length !== 42) return null;                       /* un id v4 ne se lit pas comme une paire v2/v3 */
  const t = await lisPaire(id);
  if (t) return cotéJeton(t.token0, t.token1);             /* une paire que DexScreener ne connait pas */
  return id;                                               /* pas une paire : l'adresse du jeton elle-meme */
}

const cache = new Map();      /* canal → { t, trouve: [{ addr, post, t }], messages, horsChaine } */
const CITES = new Map();      /* canal cite (t.me/nom, @nom) → nombre de canaux suivis qui le citent */
const CITE_PAR = new Map();   /* canal suivi → ses citations au dernier passage */
/* Les canaux cites dans un apercu : liens t.me/<nom> et @mentions (ni bots, ni liens de service). */
function citesDans(html) {
  const out = new Set();
  const s = String(html || '');
  for (const m of s.matchAll(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_\/])/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:^|[\s>(])@([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/g)) out.add(m[1]);
  return [...out].filter((c) => !/bot$/i.test(c) && !/^(joinchat|share|addstickers|addlist|proxy|iv|s|c|telegram|durov)$/i.test(c));
}
const rejets = new Map();     /* addr → quand (pas de paire Robinhood) */
const liensVus = new Map();   /* id de lien → adresse resolue (ou null) */
const STATS = {};             /* canal → { lectures, erreurs, messages, dernierPost, horsChaine, proposes } */
const TROUVAILLES = [];       /* les dernieres : { addr, canal, post, t, statut } */

function noteTrouvaille(x) {
  const i = TROUVAILLES.findIndex((y) => y.addr === x.addr);
  if (i >= 0) TROUVAILLES.splice(i, 1);
  TROUVAILLES.unshift(x);
  if (TROUVAILLES.length > 40) TROUVAILLES.length = 40;
}

async function lisCanal(canal) {
  const c = cache.get(canal);
  if (c && Date.now() - c.t < TTL_MS) return c;
  const st = STATS[canal] || (STATS[canal] = { lectures: 0, erreurs: 0, messages: 0, dernierPost: null, horsChaine: 0, proposes: 0, derniereErreur: null });
  st.lectures++;
  const html = await _lit('https://t.me/s/' + encodeURIComponent(canal));
  const trouve = [];
  let horsChaine = 0;
  const ms = messages(html);
  for (const m of ms.reverse()) {                          /* les plus recents d'abord */
    const a = analyse(m.html);
    horsChaine += a.horsChaine;
    for (const l of a.liens) {
      if (!liensVus.has(l.id)) liensVus.set(l.id, await resousLien(l.id));
      const addr = liensVus.get(l.id);
      if (addr && !trouve.some((x) => x.addr === addr)) trouve.push({ addr, post: m.post, t: m.t });
    }
    for (const addr of a.nues) if (!trouve.some((x) => x.addr === addr)) trouve.push({ addr, post: m.post, t: m.t });
  }
  st.messages = ms.length; st.horsChaine = horsChaine;
  CITE_PAR.set(canal, citesDans(html).filter((c) => c.toLowerCase() !== canal.toLowerCase()));
  CITES.clear();
  for (const l of CITE_PAR.values()) for (const c of l) CITES.set(c, (CITES.get(c) || 0) + 1);
  st.dernierPost = ms.length ? (ms[0].t || st.dernierPost) : st.dernierPost;
  const r = { t: Date.now(), trouve, messages: ms.length, horsChaine };
  cache.set(canal, r);
  return r;
}

/** Compatibilite : les adresses candidates d'un canal. */
async function adressesCanal(canal) { return (await lisCanal(canal)).trouve.map((x) => x.addr); }

/**
 * Toutes les adresses de tous les canaux, dedupliquees, SANS celles rejetees il
 * y a moins de REJET_MS. Chaque entree dit son canal et son message. Une erreur
 * sur un canal n'eteint pas les autres.
 */
async function adressesRecentes() {
  const vu = new Map();
  const erreurs = [];
  const liste = canaux();
  const maintenant = Date.now();
  for (const [a, t] of rejets) if (maintenant - t > REJET_MS) rejets.delete(a);
  for (const canal of liste) {
    try {
      for (const x of (await lisCanal(canal)).trouve) {
        if (vu.has(x.addr) || rejets.has(x.addr)) continue;
        vu.set(x.addr, Object.assign({ canal }, x));
      }
    } catch (e) {
      const st = STATS[canal] || (STATS[canal] = { lectures: 0, erreurs: 0, messages: 0, dernierPost: null, horsChaine: 0, proposes: 0 });
      st.erreurs++; st.derniereErreur = String(e.message || e).slice(0, 80);
      erreurs.push({ canal, message: String(e.message || e).slice(0, 80) });
    }
  }
  return { adresses: [...vu.values()], erreurs, canaux: liste };
}

/** La colonie dit ce qu'elle a fait d'une adresse proposee. */
function note(addr, x, statut) {
  const a = String(addr).toLowerCase();
  if (statut === 'hors robinhood') rejets.set(a, Date.now());
  else if (STATS[x.canal]) STATS[x.canal].proposes++;
  noteTrouvaille({ addr: a, canal: x.canal, post: x.post || null, t: x.t || null, statut, vu: Date.now() });
}

/* Le score de chaque canal, pose par tg_appels.js quand le suivi des appels tourne. */
let _scores = null;
function poseScores(fn) { _scores = fn; }
/* Ce que la decouverte a ajoute et mesure, pose par tg_decouverte.js. */
let _decouverte = null;
function poseDecouverte(fn) { _decouverte = fn; }

/** Ce que la page montre : les canaux, ce qu'on y a lu, ce qu'on en a tire, et leur score. */
function vue() {
  let scores = null, decouverte = null;
  try { scores = _scores ? _scores() : null; } catch (e) { scores = null; }
  try { decouverte = _decouverte ? _decouverte() : null; } catch (e) { decouverte = null; }
  const auto = new Set(canaux().filter((c) => !canauxListe().includes(c)));
  return { scores, decouverte, canaux: canaux().map((c) => Object.assign({ canal: c, auto: auto.has(c) }, STATS[c] || { lectures: 0 })),
           trouvailles: TROUVAILLES.slice(), rejetsEnCours: rejets.size, rejetHeures: REJET_MS / 3600e3 };
}

/* Pour les essais. */
function _videCache() { cache.clear(); rejets.clear(); liensVus.clear(); CITES.clear(); CITE_PAR.clear(); TROUVAILLES.length = 0; for (const k of Object.keys(STATS)) delete STATS[k]; }
/** Les canaux cites par les canaux suivis, du plus cite au moins cite. */
function cites() { return [...CITES.entries()].sort((a, b) => b[1] - a[1]).map(([canal, n]) => ({ canal, n })); }

module.exports = {
  get CANAUX() { return canaux(); },
  canaux, canauxListe, normaliseCanal, analyse, extraisAdresses, messages, resousLien, adressesCanal, adressesRecentes, note, vue, poseScores,
  poseAuto, poseDecouverte, cites, citesDans,
  REJET_MS, _reseau, _chaine, _videCache,
};
