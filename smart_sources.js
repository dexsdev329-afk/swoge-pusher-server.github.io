'use strict';
/* ==================================================================
 * SMART MONEY — LES SOURCES PUBLIQUES (13/10/2026). Sans cle, lecture seule.
 * ==================================================================
 *
 * GeckoTerminal (doc api.geckoterminal.com/docs/v2/swagger.json lue le 13/10) :
 *  - « approximately 10 calls/minute, which may fluctuate » ; le depot ecrivait
 *    encore ~30/min (ai_colonie.js:70) — perime. Mesure du 13/10 depuis le bac
 *    a sable : a 7 s d'ecart, refus au 10e appel ; a 12 s, au 6e ; a 20 s,
 *    apres 17 ; a 60 s, 1 refus sur 8. Un 429 rend toujours `retry-after: 0`
 *    (inutilisable) ; une pause de 90 s a suffi 5 fois sur 6. D'ou : >= 60 s
 *    entre deux appels, 90 s de recul sur un refus, et ABANDON de la partie
 *    GeckoTerminal de la passe au deuxieme refus. Le quota est partage avec la
 *    colonie (meme IP de sortie, ~1,2 appel/min) ;
 *  - en-tete documente : Accept: application/json;version=20230203 (la colonie
 *    ecrit 20230302 : ecart existant, pas recopie ici) ;
 *  - /networks/robinhood/pools : 20 piscines par page, page <= 10, aucun lien
 *    de pagination ; tri h24_volume_usd_desc ou h24_tx_count_desc ;
 *  - OHLCV `day` : toute l'histoire en 1 appel (<= 1 000 bougies),
 *    [t, o, h, l, c, v], le plus recent d'abord. TOUJOURS `token=<adresse>` et
 *    verifier meta.base.address : sans lui, 4 series sur 35 etaient inversees
 *    (JACOB a 1,28 G$, relecture du rapport du 13/10).
 * DexScreener (docs.dexscreener.com/api/reference, 13/10) :
 *  - 300/min pour tokens/v1, token-pairs/v1 ; 60/min pour orders ; 1 appel/s ici ;
 *  - tokens/v1/robinhood/<<= 30 adresses> ne rend qu'UNE paire par jeton (140
 *    paires pour 146 jetons ; CHUMP 1 ici, 6 dans token-pairs/v1) ;
 *  - orders/v1 rend { orders: [...], boosts: [] }, pas le tableau de la doc.
 * Le cache brut garde chaque reponse (DATA_DIR/smart_money/sources), sous un
 * nom unique : jamais reecrite. Purge apres 7 jours (CHOISI : ~10 Mo/jour).
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const ACCEPT_GT = 'application/json;version=20230203';
const GT_ESPACE_MS = 60000;
const GT_RECUL_MS = 90000;
const DS_ESPACE_MS = 1000;
const DS_RECUL_MS = 60000;            // CHOISI : 0 refus DexScreener sur 27 appels (13/10), rien a mesurer
const GT_BUDGET_PASSE = 16;           // ~16 appels par passe de 30 min (chiffrage des sources du 13/10)
const DS_BUDGET_PASSE = 60;
const PURGE_MS = 7 * 24 * 3600e3;
/* Le filtre « jeton serieux » (releve des sources du 13/10, 395 jetons, 52 pages) :
   >= 50 acheteurs ou vendeurs sur 24 h ; le compte de jetons >= 1 M$ tient
   quand on bouge ce seuil (44, 43, 42, 40 pour 10, 30, 50, 100) ; et au plus
   100 k$ de volume par acheteur ou vendeur (les 10 copies d'adresse affichaient
   2 a 37 M$ de « volume » pour 3 a 100 acheteurs ou vendeurs). */
const ACTIFS_MIN = 50;
const VOLUME_PAR_ACTIF_MAX = 100000;
/* Un jeton dont la capitalisation affichee depasse 10 fois la fdv lue sur la
   chaine vient d'ailleurs (U : 1,56 G$ contre 30 M$ ; USDe, cbBTC, VIRTUAL). */
const EXTERNE_RAPPORT = 10;
/* On ne demande le pic (1 appel OHLCV) qu'aux jetons vus a >= 100 k$ : CHOISI
   (BRODIE a 408 k$ et VISTA a 104 k$ le 13/10 avaient depasse 1 M$). */
const PIC_CANDIDAT_USD = 100000;

const adr = (x) => String(x || '').toLowerCase();
const nombre = (x) => { const n = Number(x); return isFinite(n) ? n : null; };
const net = (s, n) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '').trim().slice(0, n || 40);
const normSym = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');

// ------------------------------------------------------------ lecteurs purs

/** Une page GeckoTerminal de piscines -> [{ pool, dex, base, quote, fdv, mcap,
 *  volume24, actifs24, reserveUsd, creee }]. */
function piscinesGt(j) {
  const inc = new Map(((j && j.included) || []).map((x) => [x.id, x.attributes || {}]));
  const out = [];
  for (const d of (j && j.data) || []) {
    const a = d.attributes || {}, r = d.relationships || {};
    const id = (k) => (r[k] && r[k].data && r[k].data.id) || '';
    const tok = (k) => { const i = id(k); const x = inc.get(i) || {}; return { adresse: adr(x.address || i.replace(/^robinhood_/, '')), symbole: net(x.symbol, 24), decimales: x.decimals == null ? null : Number(x.decimals) }; };
    const tx = (a.transactions && a.transactions.h24) || {};
    out.push({
      pool: adr(a.address), dex: id('dex'), base: tok('base_token'), quote: tok('quote_token'),
      fdv: nombre(a.fdv_usd), mcap: nombre(a.market_cap_usd), prixUsd: nombre(a.base_token_price_usd),
      volume24: nombre(a.volume_usd && a.volume_usd.h24), actifs24: (Number(tx.buyers) || 0) + (Number(tx.sellers) || 0),
      reserveUsd: nombre(a.reserve_in_usd), creee: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    });
  }
  return out;
}

/** OHLCV jour -> { pic: { prix, t } (meilleure CLOTURE), meche: { prix, t }, n }.
 *  null si la serie n'est pas celle du jeton (meta.base.address). */
function picJour(j, jeton) {
  const meta = j && j.meta && j.meta.base;
  if (!meta || adr(meta.address) !== adr(jeton)) return null;
  const l = (j.data && j.data.attributes && j.data.attributes.ohlcv_list) || [];
  let pic = null, meche = null;
  for (const b of l) {
    const [t, , h, , c] = b.map(Number);
    if (isFinite(c) && (!pic || c > pic.prix)) pic = { prix: c, t };
    if (isFinite(h) && (!meche || h > meche.prix)) meche = { prix: h, t };
  }
  return { pic, meche, n: l.length };
}

/** DexScreener tokens/v1 ou token-pairs/v1 -> [{ pool, dex, version, base,
 *  quote, prixUsd, prixNatif, fdv, mcap, liquiditeQuote, creee, txns24 }]. */
function pairesDs(l) {
  const out = [];
  for (const p of Array.isArray(l) ? l : []) {
    if (!p || p.chainId !== 'robinhood') continue;
    const lab = (p.labels || []).join(',');
    const version = /v4/.test(lab) ? 4 : /v3/.test(lab) ? 3 : /v2/.test(lab) ? 2 : null;
    const tx = (p.txns && p.txns.h24) || {};
    out.push({
      pool: adr(p.pairAddress), dex: net(p.dexId, 40), version,
      base: { adresse: adr(p.baseToken && p.baseToken.address), symbole: net(p.baseToken && p.baseToken.symbol, 24) },
      quote: { adresse: adr(p.quoteToken && p.quoteToken.address), symbole: net(p.quoteToken && p.quoteToken.symbol, 24) },
      prixUsd: nombre(p.priceUsd), prixNatif: nombre(p.priceNative), fdv: nombre(p.fdv), mcap: nombre(p.marketCap),
      liquiditeQuote: nombre(p.liquidity && p.liquidity.quote), creee: nombre(p.pairCreatedAt), txns24: (Number(tx.buys) || 0) + (Number(tx.sells) || 0),
    });
  }
  return out;
}

/** orders/v1 -> le 1er paiement d'un profil (ms) ou null. Accepte les deux
 *  formes (doc : tableau ; reponse reelle du 13/10 : { orders: [...] }). */
function profilPaye(j) {
  const l = Array.isArray(j) ? j : (j && Array.isArray(j.orders) ? j.orders : []);
  let t = null;
  for (const o of l) if (o && o.type === 'tokenProfile' && o.status === 'approved' && Number(o.paymentTimestamp) > 0) t = t == null ? Number(o.paymentTimestamp) : Math.min(t, Number(o.paymentTimestamp));
  return t;
}

/**
 * Les exclusions. `socle` : WETH, USDG, ETH natif (deux sentinelles) ;
 * `actions` : Map adresse -> fiche (registre officiel, actions_rh.js) ;
 * `externes` : adresses vues hors de la chaine (regle mcap > 10 x fdv).
 */
function exclu(adresse, x) {
  const a = adr(adresse);
  if (x.socle && x.socle.has(a)) return 'base asset';
  if (x.actions && x.actions.has(a)) return 'tokenized stock';
  if (x.externes && x.externes.has(a)) return 'outside asset';
  return null;
}
/** Une cotation qui compte : ETH, WETH, USDG, ou une action officielle. */
const cotationSure = (quote, x) => { const a = adr(quote); return (x.socle && x.socle.has(a)) || (x.actions && x.actions.has(a)); };

/** COPIE D'ADRESSE : meme symbole, memes caracteres hexa 3 a 5 et memes 4
 *  derniers qu'un autre jeton plus actif (releve des sources du 13/10 : 10 copies,
 *  creees du 06 au 11/10, 3 a 100 acheteurs ou vendeurs contre 85 a 12 086 pour
 *  les originaux). Rend Set des adresses jugees copies. */
function copies(jetons) {
  const groupes = new Map();
  for (const j of jetons) {
    const a = adr(j.adresse);
    const k = normSym(j.symbole) + ':' + a.slice(2, 5) + ':' + a.slice(-4);
    if (!groupes.has(k)) groupes.set(k, []);
    groupes.get(k).push(j);
  }
  const out = new Set();
  for (const l of groupes.values()) {
    if (l.length < 2) continue;
    l.sort((x, y) => (y.officiel ? 1 : 0) - (x.officiel ? 1 : 0) || (y.actifs24 || 0) - (x.actifs24 || 0));
    for (const j of l.slice(1)) out.add(adr(j.adresse));
  }
  return out;
}

/** Le jugement d'une piscine pour la capitalisation ACTUELLE (Not verified :
 *  le prix est celui de la source). Rend { garde, raison }. */
function jugeActuel(p, x) {
  if (!cotationSure(p.quote.adresse, x)) return { garde: false, raison: 'quote asset not trusted' };
  if (p.fdv == null || p.fdv < 1e6) return { garde: false, raison: 'under $1M' };
  if (p.mcap != null && p.mcap > EXTERNE_RAPPORT * p.fdv) return { garde: false, raison: 'outside asset (market cap > 10× on-chain fdv)', externe: true };
  if ((p.actifs24 || 0) < ACTIFS_MIN) return { garde: false, raison: `fewer than ${ACTIFS_MIN} buyers or sellers in 24 h` };
  if (p.volume24 != null && p.volume24 > VOLUME_PAR_ACTIF_MAX * Math.max(1, p.actifs24)) return { garde: false, raison: 'volume per trader too high' };
  return { garde: true, raison: 'current fdv ≥ $1M' };
}

// ------------------------------------------------------------ le client

/**
 * deps : { prendre, horloge, dors, dossier, journal }
 */
function cree(deps0) {
  const deps = Object.assign({
    prendre: (...a) => fetch(...a), horloge: () => Date.now(), dors: (ms) => new Promise((r) => setTimeout(r, ms)),
    dossier: null, gtEspaceMs: GT_ESPACE_MS, gtReculMs: GT_RECUL_MS, dsEspaceMs: DS_ESPACE_MS, dsReculMs: DS_RECUL_MS,
    gtBudget: GT_BUDGET_PASSE, dsBudget: DS_BUDGET_PASSE, journal: null,
  }, deps0 || {});
  const etat = {
    gt: { appels: 0, refus: 0, passe: 0, refusPasse: 0, prochain: 0, abandon: false },
    ds: { appels: 0, refus: 0, passe: 0, refusPasse: 0, prochain: 0, abandon: false },
  };
  const D = deps.dossier ? path.join(deps.dossier, 'sources') : null;
  let n = 0;
  function brut(nom, statut, texte) {
    if (!D) return;
    try {
      fs.mkdirSync(D, { recursive: true });
      const f = path.join(D, `${deps.horloge()}_${process.pid}_${++n}_${nom.replace(/[^a-z0-9_]/gi, '_').slice(0, 60)}_${statut}.json.gz`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, zlib.gzipSync(String(texte || '')));
    } catch (e) { /* le cache ne bloque jamais la lecture */ }
  }
  function purge() {
    if (!D) return 0;
    let k = 0;
    try { for (const f of fs.readdirSync(D)) { const t = Number(f.split('_')[0]); if (t && deps.horloge() - t > PURGE_MS) { fs.unlinkSync(path.join(D, f)); k++; } } } catch (e) { /* rien */ }
    return k;
  }

  /** Un GET poli. Rend le JSON, ou null (refus, budget, abandon). */
  async function lit(qui, url, nom, entetes) {
    const E = etat[qui];
    const espace = qui === 'gt' ? deps.gtEspaceMs : deps.dsEspaceMs;
    const recul = qui === 'gt' ? deps.gtReculMs : deps.dsReculMs;
    const budget = qui === 'gt' ? deps.gtBudget : deps.dsBudget;
    for (let essai = 0; essai < 2; essai++) {
      if (E.abandon || E.passe >= budget) return null;
      const attente = E.prochain - deps.horloge();
      if (attente > 0) await deps.dors(attente);
      E.appels++; E.passe++;
      let r = null, texte = '', statut = 0;
      try {
        r = await deps.prendre(url, { headers: Object.assign({ 'user-agent': 'swoge-smart-money/1.0 (read-only)' }, entetes || {}), signal: AbortSignal.timeout(20000) });
        statut = r.status; texte = await r.text();
      } catch (e) { statut = 0; texte = ''; }
      E.prochain = deps.horloge() + espace;
      brut(qui + '_' + nom, statut, texte);
      let j = null; try { j = JSON.parse(texte); } catch (e) { j = null; }
      if (deps.journal) deps.journal({ qui, nom, statut, octets: texte.length });
      if (statut === 200 && j !== null) return j;
      if (statut === 404) return null;                    // un jeton inconnu de la source n'est pas un refus
      E.refus++; E.refusPasse++;
      if (E.refusPasse >= 2) { E.abandon = true; return null; }   // deuxieme refus de la passe : cette source s'arrete
      await deps.dors(recul);
    }
    return null;
  }
  const gt = (chemin, nom) => lit('gt', GT + chemin, nom, { accept: ACCEPT_GT });
  const ds = (chemin, nom) => lit('ds', DS + chemin, nom, { accept: 'application/json' });

  return {
    etat, purge,
    nouvellePasse() { for (const k of ['gt', 'ds']) { etat[k].passe = 0; etat[k].refusPasse = 0; etat[k].abandon = false; } },
    async piscines(tri, page) {
      const j = await gt(`/networks/robinhood/pools?sort=${tri === 'tx' ? 'h24_tx_count_desc' : 'h24_volume_usd_desc'}&include=base_token,quote_token,dex&page=${page}`, `pools_${tri}_p${page}`);
      return j ? piscinesGt(j) : null;
    },
    async nouvelles(page) {
      const j = await gt(`/networks/robinhood/new_pools?include=base_token,quote_token,dex&page=${page}`, `new_p${page}`);
      return j ? piscinesGt(j) : null;
    },
    async pic(pool, jeton) {
      const j = await gt(`/networks/robinhood/pools/${pool}/ohlcv/day?limit=1000&currency=usd&token=${jeton}`, `ohlcv_${String(jeton).slice(2, 10)}`);
      return j ? picJour(j, jeton) : null;
    },
    async jetonsDs(adresses) {
      const out = [];
      for (let d = 0; d < adresses.length; d += 30) {
        const j = await ds(`/tokens/v1/robinhood/${adresses.slice(d, d + 30).join(',')}`, `tokens_${d}`);
        if (j) out.push(...pairesDs(j));
      }
      return out;
    },
    async pairesDs(jeton) { const j = await ds(`/token-pairs/v1/robinhood/${jeton}`, `pairs_${String(jeton).slice(2, 10)}`); return j ? pairesDs(j) : null; },
    async profilDs(jeton) { const j = await ds(`/orders/v1/robinhood/${jeton}`, `orders_${String(jeton).slice(2, 10)}`); return j ? { t: profilPaye(j) } : null; },
  };
}

module.exports = {
  cree, piscinesGt, picJour, pairesDs, profilPaye, exclu, cotationSure, copies, jugeActuel, normSym,
  GT, DS, ACCEPT_GT, GT_ESPACE_MS, GT_RECUL_MS, DS_ESPACE_MS, GT_BUDGET_PASSE, DS_BUDGET_PASSE, ACTIFS_MIN, VOLUME_PAR_ACTIF_MAX,
  EXTERNE_RAPPORT, PIC_CANDIDAT_USD, PURGE_MS,
};
