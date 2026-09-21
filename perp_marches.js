'use strict';
/* ==================================================================
 * PERP — DECOUVERTE ET NORMALISATION DES MARCHES
 * ==================================================================
 *
 * La couche « Market Discovery → Market Cache → Normalized Market Data » du
 * cahier des charges, cote serveur. Elle interroge les exchanges QUE LE
 * SERVEUR PEUT JOINDRE et rend une liste de marches a la FORME UNIQUE, pour
 * que le frontend ne depende jamais du format d un exchange.
 *
 * ---- CE QUI EST JOIGNABLE, MESURE, PAS SUPPOSE ----
 * Depuis notre infrastructure (Railway, US) :
 *   - Hyperliquid : REST et WS ouverts, CORS *. VERIFIE en direct
 *     (BTC mid recu). C est la source de reference.
 *   - OKX : REST ouvert (467 swaps USDT) ; le WS a expire depuis notre
 *     datacenter — utilisable pour la DECOUVERTE, pas pour le flux serveur.
 *   - Binance (451) et Bybit (403) : geo-bloques de toute notre infra. Pas
 *     de proxy serveur possible. Ils ne peuvent etre joints qu en WS DIRECT
 *     depuis le navigateur d un utilisateur en region permise, et on ne les
 *     annonce jamais comme « verifies » ici.
 *
 * On ne pretend donc jamais qu un marche est live si on ne l a pas vu vivre.
 * Chaque exchange porte son etat reel. */

const https = require('https');

/* Le reseau est injectable : les essais normalisent des reponses reelles
   capturees, sans toucher a l internet. */
let RESEAU = { get: getHttps, post: postHttps };
function getHttps(url) {
  return new Promise((res, rej) => {
    https.get(url, { timeout: 9000, headers: { accept: 'application/json' } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ code: r.statusCode, corps: b }));
    }).on('error', rej).on('timeout', function () { this.destroy(); rej(new Error('timeout')); });
  });
}
function postHttps(url, body) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(body);
    const r = https.request(url, { method: 'POST', timeout: 9000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ code: x.statusCode, corps: b }));
    });
    r.on('error', rej); r.on('timeout', function () { this.destroy(); rej(new Error('timeout')); });
    r.write(d); r.end();
  });
}

/* Number(null) et Number('') valent 0 : un champ ABSENT deviendrait 0, lu
   comme une vraie valeur. On rend null pour tout ce qui n est pas un nombre
   ecrit — jamais un zero invente. */
const nn = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

/* La FORME UNIQUE d un marche. Tout exchange s y ramene. Le frontend ne lit
   que ca — jamais le JSON brut d un exchange. */
function marcheNormalise(o) {
  return {
    symbole: o.symbole,          /* « BTC/USD:PERP » — cle stable inter-exchange */
    base: o.base, quote: o.quote,
    exchange: o.exchange,
    idExchange: o.idExchange,     /* l identifiant natif, pour s abonner au WS */
    last: nn(o.last), bid: nn(o.bid), ask: nn(o.ask),
    markPrice: nn(o.markPrice), indexPrice: nn(o.indexPrice),
    fundingRate: nn(o.fundingRate),
    volume24h: nn(o.volume24h), openInterest: nn(o.openInterest),
    variation24h: nn(o.variation24h),
    horodatage: o.horodatage || Date.now(),
  };
}

/* ---- HYPERLIQUID ----
 * `metaAndAssetCtxs` : deux tableaux alignes par index — l univers (noms,
 * levier) et le contexte (mark, oracle, funding, OI, volume). Un seul appel
 * pour les 234 perps. Les perps HL sont marges en USD. */
async function decouvreHyperliquid() {
  const r = await RESEAU.post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
  const j = JSON.parse(r.corps);
  const univers = j[0].universe, ctx = j[1];
  const out = [];
  for (let i = 0; i < univers.length; i++) {
    const u = univers[i], c = ctx[i] || {};
    if (u.isDelisted) continue;
    const mark = nn(c.markPx);
    const oi = nn(c.openInterest);
    const prev = nn(c.prevDayPx), mid = nn(c.midPx);
    out.push(marcheNormalise({
      symbole: u.name + '/USD:PERP', base: u.name, quote: 'USD',
      exchange: 'Hyperliquid', idExchange: u.name,
      last: mid, bid: c.impactPxs ? nn(c.impactPxs[0]) : null, ask: c.impactPxs ? nn(c.impactPxs[1]) : null,
      markPrice: mark, indexPrice: nn(c.oraclePx), fundingRate: nn(c.funding),
      /* OI est en unites de base : on le donne en notionnel USD, comparable
         entre marches. Volume 24h est deja en notionnel (dayNtlVlm). */
      openInterest: oi != null && mark != null ? oi * mark : null,
      volume24h: nn(c.dayNtlVlm),
      variation24h: prev && mid ? ((mid - prev) / prev) * 100 : null,
    }));
  }
  return out;
}

/* ---- OKX ----
 * Deux appels : la liste des swaps USDT, puis les tickers (un appel pour
 * tous). Reachable en REST depuis le serveur ; le WS, non — d ou la
 * distinction plus bas. */
async function decouvreOkx() {
  const inst = JSON.parse((await RESEAU.get('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).corps);
  const tick = JSON.parse((await RESEAU.get('https://www.okx.com/api/v5/market/tickers?instType=SWAP')).corps);
  const parId = new Map();
  for (const t of (tick.data || [])) parId.set(t.instId, t);
  const out = [];
  for (const s of (inst.data || [])) {
    if (s.settleCcy !== 'USDT' || s.state !== 'live') continue;
    const t = parId.get(s.instId) || {};
    const last = nn(t.last), open = nn(t.open24h);
    out.push(marcheNormalise({
      symbole: s.ctValCcy + '/USDT:PERP', base: s.ctValCcy, quote: 'USDT',
      exchange: 'OKX', idExchange: s.instId,
      last, bid: nn(t.bidPx), ask: nn(t.askPx),
      markPrice: null, indexPrice: null, fundingRate: null,
      volume24h: nn(t.volCcy24h), openInterest: null,
      variation24h: last && open ? ((last - open) / open) * 100 : null,
    }));
  }
  return out;
}

/* Les exchanges que le SERVEUR sait decouvrir, avec leur etat reel. Un
   exchange qui tombe n empeche pas les autres : une source muette est un
   fait, pas une panne. */
const SOURCES = [
  { nom: 'Hyperliquid', ws: 'wss://api.hyperliquid.xyz/ws', wsVerifie: true, decouvre: decouvreHyperliquid },
  { nom: 'OKX', ws: 'wss://ws.okx.com:8443/ws/v5/public', wsVerifie: false, decouvre: decouvreOkx },
];

let CACHE = null;
const TTL = Math.max(30000, Number(process.env.PERP_MARCHES_TTL || 5 * 60 * 1000));

async function decouvre(force) {
  if (!force && CACHE && Date.now() - CACHE.t < TTL) return CACHE.v;
  const exchanges = [];
  const marches = [];
  await Promise.all(SOURCES.map(async (s) => {
    const t0 = Date.now();
    try {
      const m = await s.decouvre();
      marches.push(...m);
      exchanges.push({ nom: s.nom, ws: s.ws, wsVerifie: s.wsVerifie, marches: m.length, ms: Date.now() - t0, ok: true });
    } catch (e) {
      exchanges.push({ nom: s.nom, ws: s.ws, wsVerifie: s.wsVerifie, marches: 0, ok: false,
                       erreur: String(e.message || e).slice(0, 80) });
    }
  }));
  const v = { horodatage: Date.now(), exchanges, marches };
  CACHE = { t: Date.now(), v };
  return v;
}

module.exports = {
  decouvre, decouvreHyperliquid, decouvreOkx, marcheNormalise, SOURCES,
  _reseau: (r) => { RESEAU = r; }, _videCache: () => { CACHE = null; },
};
