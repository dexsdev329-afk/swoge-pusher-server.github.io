'use strict';
/* ============================================================================
 * LA COLONIE, COTE SERVEUR
 *
 * « Faut que ça soit live tout le temps, ça tourne 24/24 même quand on est
 * pas sur la page, tout le monde voit la même chose. »
 *
 * Les trois demandes n'en font qu'une, et elle interdit le navigateur. Une
 * page qui calcule dans l'onglet ne tourne que tant que l'onglet est ouvert,
 * et son etat vit dans le stockage local — donc chaque visiteur a SA
 * tresorerie, ses positions, ses lecons. Deux personnes cote a cote voyaient
 * deux colonies differentes, et fermer l'onglet arretait la sienne.
 *
 * Le moteur vit donc ici. Il tourne dans le processus du serveur, il ecrit
 * son etat sur le disque, et il le SERT. La page n'est plus qu'une vue : elle
 * demande, elle affiche, elle ne decide de rien. Tout le monde lit le meme
 * fichier, donc tout le monde voit la meme chose — y compris quelqu'un qui
 * ouvre la page pour la premiere fois au milieu de la nuit.
 *
 * ---- CE QU'IL NE TOUCHE PAS ----
 *
 * L'argent des joueurs. Sa tresorerie est du PAPIER : aucune transaction
 * n'est signee, rien n'est achete, rien n'est vendu. Il ecrit dans son propre
 * fichier, jamais dans `state.json`. Un defaut ici doit pouvoir couter zero
 * centime a qui que ce soit, et la seule facon d'en etre sur est qu'il n'ait
 * aucun chemin vers la caisse.
 *
 * ---- CE QU'IL NE FABRIQUE JAMAIS ----
 *
 * Une position s'ouvre au prix REEL lu a l'instant et se ferme au prix REEL
 * d'une lecture plus tard. Entre les deux il ne se passe rien qu'on invente.
 * Quand un service ne repond pas, le champ reste INCONNU — et l'inconnu ne
 * rapporte jamais de points a un jeton. C'est la seule discipline qui compte
 * ici : un chiffre flatteur qu'on ne peut pas reproduire ne vaut rien, et
 * pire, il donne envie d'y mettre de l'argent.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FICHIER = path.join(cfg.DATA_DIR, 'ai_colonie.json');
const TMP = FICHIER + '.tmp';

/* ---------------------------------------------------------------- reglages */
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const ENTETES = { Accept: 'application/json;version=20230302' };
const RPC_RH = 'https://rpc.mainnet.chain.robinhood.com';
const SUJET_TRANSFERT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const MORT = '0x000000000000000000000000000000000000dead';

const DEPART = 1000;            /* la tresorerie papier de depart */
const MISE = 50;                /* ce qu'une position engage */
const TENUE_DEFAUT_MIN = 20;    /* et ce que le Closer tient, avant d'apprendre */
const AGE_MAX_MIN = 360;        /* au-dela, ce n'est plus un jeton neuf */
const SEUIL = 55;               /* la note qu'il faut atteindre pour entrer */
const POSITIONS_MAX = 6;        /* jamais plus a la fois : au-dela on ne mesure plus rien */
const CADENCE_MS = 150000;      /* un tour toutes les deux minutes et demie */

/* Le temps de bloc, MESURE sur la chaine : 0,101 s. Un chiffre commente est un
   chiffre qu'on croit sur parole ; celui-la a ete releve. */
const BLOC_SECONDES = 0.101;
const BLOCS_HEURE = Math.round(3600 / BLOC_SECONDES);
const BLOCS_PLAFOND = 200000;   /* la plage que le noeud accepte, verifiee */

const TTL_GOPLUS = 6 * 3600e3, TTL_OHLCV = 30 * 60e3, TTL_DEX = 10 * 60e3, TTL_CHAINE = 10 * 60e3;

const AGENTS = ['scout', 'warden', 'whale', 'whisper', 'oracle', 'closer'];

/* ------------------------------------------------------------------- l'etat */
function etatNeuf() {
  return {
    v: 1, tresor: DEPART, trades: 0, gains: 0, meilleur: 0, meilleurSym: '',
    courbe: [DEPART], flux: [], positions: [], memoire: {}, compteurs: {},
    ouvertures: 0, maj: 0, dernierTour: 0, candidats: [], derniereErreur: null,
    depuis: Date.now(),
  };
}
let E = etatNeuf();

function charge() {
  let brut = null;
  try { brut = JSON.parse(fs.readFileSync(FICHIER, 'utf8')); } catch (e) { brut = null; }
  if (!brut || typeof brut !== 'object') return;
  const n = etatNeuf();
  /* Une forme plus ancienne se COMPLETE, elle ne se jette pas : jeter, ce
     serait effacer des semaines d'apprentissage a chaque correction. */
  for (const k of Object.keys(n)) if (!(k in brut)) brut[k] = n[k];
  if (!Array.isArray(brut.courbe) || !brut.courbe.length) brut.courbe = [DEPART];
  if (!Array.isArray(brut.flux)) brut.flux = [];
  if (!Array.isArray(brut.positions)) brut.positions = [];
  if (!brut.memoire || typeof brut.memoire !== 'object') brut.memoire = {};
  if (!brut.compteurs || typeof brut.compteurs !== 'object') brut.compteurs = {};
  E = brut;
}

/* Ecriture atomique : fichier temporaire, puis rename. Une coupure au milieu
   laisse l'ancien intact. C'est la meme precaution que pour l'argent des
   joueurs — celui-ci ne porte que du papier, mais des semaines
   d'apprentissage perdues sont perdues quand meme. */
function sauve() {
  try {
    if (E.courbe.length > 2000) E.courbe = E.courbe.slice(-2000);
    if (E.flux.length > 200) E.flux = E.flux.slice(0, 200);
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(E));
    fs.renameSync(TMP, FICHIER);
  } catch (e) { /* disque plein ou volume absent : on continue sans garder */ }
}

/* ------------------------------------------------------------- les lectures */
const nn = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const CACHE = { goplus: {}, ohlcv: {}, dex: {}, chaine: {}, poolDe: {} };
const frais = (c, k, ttl) => { const x = c[k]; return (x && Date.now() - x.t < ttl) ? x.v : null; };
const garde = (c, k, v) => { c[k] = { t: Date.now(), v }; return v; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts) {
  const r = await fetch(url, opts || {});
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/* ---- LE NOEUD PUBLIC COUPE, ET IL FAUT LE PRENDRE AU SERIEUX ----
 * Mesure : sur six jetons a la file, QUATRE refus « Too Many Requests ». On
 * espace nos propres appels — plus efficace que de reprendre apres coup — avec
 * UNE reprise. Deux reprises sur un noeud qui refuse, c'est se faire couper
 * plus longtemps. Un echec reste un echec : il rend « inconnu ». */
let rpcDernier = 0;
async function rpc(methode, params, reprise) {
  const depuis = Date.now() - rpcDernier;
  if (depuis < 900) await dors(900 - depuis);
  rpcDernier = Date.now();
  const r = await fetch(RPC_RH, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: methode, params: params || [] }),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  const coupe = r.status === 429 || (j && j.error && (j.error.code === 429
    || /too many|rate/i.test(String(j.error.message || ''))));
  if (coupe && !reprise) { await dors(2500); return rpc(methode, params, true); }
  if (!r.ok) throw new Error('rpc ' + r.status);
  if (!j) throw new Error('rpc illisible');
  if (j.error) throw new Error(j.error.message || 'rpc');
  return j.result;
}
let blocCache = { n: 0, t: 0 };
async function blocCourant() {
  if (blocCache.n && Date.now() - blocCache.t < 5000) return blocCache.n;
  const n = parseInt(await rpc('eth_blockNumber'), 16);
  blocCache = { n, t: Date.now() };
  return n;
}

/* ---- LES POOLS QUI VIENNENT DE NAITRE ----
 * Trois pages du flux des nouveaux, et RIEN d'autre. Le flux des tendances a
 * ete essaye comme point de comparaison : il occupait une place et pouvait
 * finir en position, alors que ce n'est pas ce qu'on vient chercher. */
async function lisPools() {
  const pools = new Map(), toks = new Map();
  for (const page of [1, 2, 3]) {
    let d = null;
    try { d = await json(GT + '/new_pools?include=base_token&page=' + page, { headers: ENTETES }); }
    catch (e) { continue; }
    for (const inc of (d.included || [])) if (inc.type === 'token') toks.set(inc.id, inc.attributes);
    for (const p of (d.data || [])) {
      const a = p.attributes;
      const bt = p.relationships && p.relationships.base_token && p.relationships.base_token.data;
      const t = bt && toks.get(bt.id);
      if (!t || !t.address) continue;
      const addr = String(t.address).toLowerCase();
      const c = {
        addr, sym: (t.symbol || '?').toUpperCase().slice(0, 12), nom: (t.name || '').slice(0, 28),
        pool: a.address,
        prix: nn(a.base_token_price_usd),
        mc: nn(a.market_cap_usd) || nn(a.fdv_usd),
        liq: nn(a.reserve_in_usd),
        minutes: a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 60000 : null,
        cree: a.pool_created_at || null,
        tx: a.transactions || {},
        vol: { m5: nn(a.volume_usd && a.volume_usd.m5), h1: nn(a.volume_usd && a.volume_usd.h1),
               h6: nn(a.volume_usd && a.volume_usd.h6), h24: nn(a.volume_usd && a.volume_usd.h24) },
        ch_m5: nn(a.price_change_percentage && a.price_change_percentage.m5),
        ch_h1: nn(a.price_change_percentage && a.price_change_percentage.h1),
        ch_h6: nn(a.price_change_percentage && a.price_change_percentage.h6),
      };
      const prev = pools.get(addr);
      if (!prev || c.liq > prev.liq) pools.set(addr, c);
    }
    await dors(650);
  }
  return [...pools.values()];
}

/* ---- « IL A REPONDU » N'EST PAS « IL SAIT » ----
 * Sur un jeton de sept minutes, GoPlus rend SEPT champs : deux taxes vides,
 * une adresse, rien d'autre. Les lire comme « pas de honeypot, aucune
 * concentration, aucune taxe, code verifie » donnait trente points de surete
 * a un jeton dont on ne savait rien — sur la classe de jetons ou le risque de
 * fuite est le plus grand. Chaque champ est tri-etat. */
async function lisGoplus(t) {
  const c = frais(CACHE.goplus, t.addr, TTL_GOPLUS);
  if (c !== null) { t.g = c; return; }
  let info = {};
  try {
    const j = await json('https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=' + t.addr);
    info = (j.result || {})[t.addr] || {};
  } catch (e) { info = {}; }
  const su = (x) => x === '1';
  const hs = info.holders || [];
  let top = 0;
  for (const h of hs) {
    const p = nn(h.percent) * 100;
    if (Number(h.is_contract) === 1 || Number(h.is_locked) === 1) continue;
    if (/lock|burn|null/i.test(h.tag || '')) continue;
    if (p > top) top = p;
  }
  const lp = (info.lp_holders || []).reduce((s, h) =>
    s + ((Number(h.is_locked) === 1 || /lock|burn|null/i.test(h.tag || '')) ? nn(h.percent) * 100 : 0), 0);
  t.g = garde(CACHE.goplus, t.addr, {
    have: info.is_honeypot !== undefined || info.holder_count !== undefined || info.is_open_source !== undefined,
    honeypot: su(info.is_honeypot), cannotBuy: su(info.cannot_buy), pausable: su(info.transfer_pausable),
    ownerBal: su(info.owner_change_balance), selfd: su(info.selfdestruct),
    perslip: su(info.personal_slippage_modifiable), hpSame: su(info.honeypot_with_same_creator),
    slipMod: su(info.slippage_modifiable), cooldown: su(info.trading_cooldown), proxy: su(info.is_proxy),
    mintable: su(info.is_mintable),
    taxeSue: info.buy_tax !== undefined && info.buy_tax !== '',
    buyTax: Math.round(nn(info.buy_tax) * 100), sellTax: Math.round(nn(info.sell_tax) * 100),
    detSue: info.holder_count !== undefined, holders: parseInt(info.holder_count) || 0,
    topSu: hs.length > 0, top: Math.round(top * 10) / 10, lp: Math.round(lp),
    codeSu: info.is_open_source !== undefined, unverified: info.is_open_source === '0',
  });
}

async function lisOhlcv(pool) {
  const c = frais(CACHE.ohlcv, pool, TTL_OHLCV); if (c !== null) return c;
  try {
    const j = await json(GT + '/pools/' + pool + '/ohlcv/minute?aggregate=15&limit=24', { headers: ENTETES });
    const l = ((j.data || {}).attributes || {}).ohlcv_list || [];
    if (l.length < 4) return garde(CACHE.ohlcv, pool, { vola: null });
    /* Les bougies arrivent de la plus recente a la plus ancienne : les
       remettre dans l'ordre du temps, sinon les variations sont a l'envers. */
    const f = l.map((x) => nn(x[4])).reverse().filter((x) => x > 0);
    const r = [];
    for (let i = 1; i < f.length; i++) r.push((f[i] - f[i - 1]) / f[i - 1] * 100);
    if (!r.length) return garde(CACHE.ohlcv, pool, { vola: null });
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const va = Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length);
    return garde(CACHE.ohlcv, pool, { vola: Math.round(va * 100) / 100 });
  } catch (e) { return garde(CACHE.ohlcv, pool, { vola: null }); }
}

/* Un SECOND avis sur le prix. Il ne dit pas qui se trompe : il dit a quel
   point le marche est mince ou rapide — ce qu'un agent doit savoir avant
   d'entrer. */
async function lisDex(addr) {
  const c = frais(CACHE.dex, addr, TTL_DEX); if (c !== null) return c;
  try {
    const j = await json('https://api.dexscreener.com/latest/dex/tokens/' + addr);
    const p = (j.pairs || []).filter((x) => String(x.chainId || '').toLowerCase() === 'robinhood');
    if (!p.length) return garde(CACHE.dex, addr, { vu: false });
    p.sort((a, b) => nn(b.liquidity && b.liquidity.usd) - nn(a.liquidity && a.liquidity.usd));
    const i = p[0].info || {};
    return garde(CACHE.dex, addr, {
      vu: true, prix: nn(p[0].priceUsd), pools: p.length,
      socials: (i.socials || []).length + (i.websites || []).length,
    });
  } catch (e) { return garde(CACHE.dex, addr, { vu: false }); }
}

/* ---- CE QUE LA CHAINE SAIT, ET QUE PERSONNE D'AUTRE NE SAIT ----
 * Sur un jeton de sept minutes, GoPlus n'a pas encore indexe. Les blocs, eux,
 * contiennent deja tout : qui detient quoi, en soldant les transferts. Ce
 * n'est pas une estimation, c'est une somme — et quand elle contredit un
 * service, c'est elle qui a raison. */
async function lisChaine(addr, minutes, pool) {
  const c = frais(CACHE.chaine, addr, TTL_CHAINE); if (c !== null) return c;
  try {
    const bloc = await blocCourant();
    const voulu = (minutes > 0 && minutes < 300)
      ? Math.ceil(minutes * 60 / BLOC_SECONDES) + 6000 : BLOCS_HEURE;
    const large = Math.min(BLOCS_PLAFOND, voulu);
    const logs = await rpc('eth_getLogs', [{
      address: addr, topics: [SUJET_TRANSFERT],
      fromBlock: '0x' + Math.max(0, bloc - large).toString(16), toBlock: '0x' + bloc.toString(16) }]);
    const solde = {}, recus = {};
    let brules = 0, total = 0, lus = 0;
    const adr = (t) => ('0x' + String(t || '').slice(26)).toLowerCase();
    for (const l of (logs || [])) {
      const de = adr(l.topics[1]), vers = adr(l.topics[2]);
      /* Le montant n'est pas toujours dans `data` : certains contrats
         l'INDEXENT, et il arrive alors dans `topics[3]`. Ne lire que `data`
         rendait « zero porteur » — pas une lecture ratee, une conclusion
         FAUSSE. Trois jetons sur six mesures tombaient dedans. */
      const brut = (l.data && l.data !== '0x') ? l.data : (l.topics.length > 3 ? l.topics[3] : null);
      let v = 0;
      if (brut) { try { v = Number(BigInt(brut)); lus++; } catch (e) { v = 0; } }
      if (!isFinite(v)) v = 0;
      solde[de] = (solde[de] || 0) - v;
      solde[vers] = (solde[vers] || 0) + v;
      recus[vers] = 1;
      if (de === ZERO) total += v;
      if (vers === ZERO || vers === MORT) brules += v;
    }
    const p = String(pool || '').toLowerCase();
    let circ = 0, mx = 0, np = 0;
    for (const a in solde) {
      if (a === ZERO || a === MORT || a === p) continue;   /* le pool fait le marche, il ne detient pas */
      const v = solde[a];
      if (v <= 0) continue;
      circ += v; np++;
      if (v > mx) mx = v;
    }
    /* ---- « PERSONNE NE DETIENT » N'EST PAS « JE NE SAIS PAS » ----
     * Releve sur deux jetons reels de deux minutes : soixante et un transferts,
     * trente adresses, et TOUTES a zero net — la piscine tenait la totalite de
     * l'emission. La lecture etait parfaite ; c'est le compte rendu qui mentait,
     * parce qu'un circulant nul sortait « inconnu ». Or l'inconnu coute quatre
     * points, tandis que « trente adresses ont touche le jeton et aucune ne l'a
     * garde » devrait fermer la porte. On separe donc les deux : `montantsLus`
     * dit si on a su lire, `personne` dit ce qu'on a lu. */
    const su = lus > 0;
    return garde(CACHE.chaine, addr, {
      vu: true, montantsLus: su,
      transferts: (logs || []).length, recepteurs: Object.keys(recus).length,
      porteurs: su ? np : null,
      personne: su && np === 0 && (logs || []).length > 0,
      top: (su && circ > 0) ? Math.round(mx / circ * 1000) / 10 : null,
      brule: (su && total > 0) ? Math.round(brules / total * 1000) / 10 : null,
    });
  } catch (e) { return garde(CACHE.chaine, addr, { vu: false }); }
}

/* ------------------------------------------------------- les traits, la note */
function tranche(v, seuils, noms) {
  for (let i = 0; i < seuils.length; i++) if (v < seuils[i]) return noms[i];
  return noms[noms.length - 1];
}
const rapport = (a, b) => (b > 0 ? a / b : (a > 0 ? 99 : 1));

/* Chaque agent possede SES traits, et sa propre memoire. C'est ce qui fait
   qu'ils s'ameliorent tous, et pas seulement l'Oracle. Un « ? » est une case
   a part entiere : l'Oracle apprendra ce que valent les jetons sur lesquels
   on ne savait rien, et c'est peut-etre la lecon la plus utile. */
function traitsDe(t) {
  const g = t.g || {}, c = t.chaine || {}, d = t.dex || {}, x = t.tx || {}, v = t.vol || {};
  const h1 = x.h1 || {};
  return {
    scout: {
      age: t.minutes === null ? 'age ?' : t.minutes < 10 ? 'ne de <10 min'
           : t.minutes < 30 ? '10-30 min' : t.minutes < 120 ? '30 min-2 h' : '2-6 h',
      liq: tranche(t.liq || 0, [1e3, 5e3, 25e3, 1e5], ['liq<1k', 'liq 1-5k', 'liq 5-25k', 'liq 25-100k', 'liq>100k']),
      pools: !d.vu ? 'pools ?' : tranche(d.pools, [2, 4], ['1 pool', '2-3 pools', '>=4 pools']),
    },
    warden: {
      taxe: !g.taxeSue ? 'taxe inconnue'
            : (g.buyTax + g.sellTax) === 0 ? 'aucune taxe'
            : (g.buyTax + g.sellTax) <= 10 ? 'taxe <=10%' : 'taxe >10%',
      code: !g.codeSu ? 'code inconnu' : (g.unverified ? 'code non verifie' : 'code verifie'),
      pouv: !g.have ? 'pouvoirs ?' : (g.mintable && g.proxy) ? 'mint + proxy'
            : g.mintable ? 'emission possible' : g.proxy ? 'contrat proxy' : 'aucun pouvoir',
    },
    whale: {
      top: (c.vu && c.top !== null) ? tranche(c.top, [5, 15, 30, 50],
             ['top <5%', 'top 5-15%', 'top 15-30%', 'top 30-50%', 'top >50%'])
           : (g.topSu ? tranche(g.top, [5, 15, 30, 50],
             ['top <5%', 'top 5-15%', 'top 15-30%', 'top 30-50%', 'top >50%']) : 'concentration inconnue'),
      det: (c.vu && c.porteurs !== null) ? tranche(c.porteurs, [10, 30, 100, 500],
             ['<10 porteurs', '10-30', '30-100', '100-500', '>500 porteurs'])
           : (g.detSue ? tranche(g.holders, [100, 1e3, 1e4],
             ['<100 det', '100-1k det', '1k-10k det', '>10k det']) : 'porteurs inconnus'),
      brule: (c.vu && c.brule !== null) ? tranche(c.brule, [1, 50, 90],
             ['rien brule', '<50% brule', '50-90% brule', '>90% brule']) : 'brule inconnu',
    },
    whisper: {
      press: tranche(rapport(h1.buys || 0, h1.sells || 0), [0.8, 1.05, 1.5],
             ['vendeurs devant', 'equilibre', 'acheteurs devant', 'achats massifs']),
      uniq: tranche((h1.buyers || 0) + (h1.sellers || 0), [20, 100, 500],
             ['<20 traders/h', '20-100/h', '100-500/h', '>500/h']),
      accel: tranche(rapport(v.h1 || 0, (v.h6 || 0) / 6), [0.6, 1.2, 3],
             ['ca retombe', 'stable', 'ca accelere', 'explosion']),
      accord: t.ecart === null || t.ecart === undefined ? 'une seule source'
              : tranche(t.ecart, [0.5, 2, 6], ['prix concordants', 'ecart <2%', 'ecart 2-6%', 'ecart >6%']),
    },
    oracle: {
      mc: tranche(t.mc || 0, [5e4, 5e5, 5e6], ['mc <50k', 'mc 50-500k', 'mc 0,5-5M', 'mc >5M']),
      elan: tranche(t.ch_m5 || 0, [-5, 0, 5, 20], ['5m <-5%', '5m -5-0%', '5m 0-5%', '5m 5-20%', '5m >20%']),
      vola: t.vola === null || t.vola === undefined ? 'vola ?'
            : tranche(t.vola, [2, 5, 12], ['calme', 'vola 2-5%', 'vola 5-12%', 'vola >12%']),
    },
  };
}
const TENUES = [5, 10, 20, 40, 80, 160];
function trancheTenue(min) {
  let b = TENUES[0];
  for (const t of TENUES) if (min >= t) b = t;
  return b + ' min';
}

function memLit(a, t, v) { const m = E.memoire; return (m[a] && m[a][t] && m[a][t][v]) || null; }
function memCase(a, t, v) {
  const m = E.memoire;
  if (!m[a]) m[a] = {};
  if (!m[a][t]) m[a][t] = {};
  if (!m[a][t][v]) m[a][t][v] = { n: 0, s: 0 };
  return m[a][t][v];
}
const CONFIANCE_K = 6;
const confiance = (n) => n / (n + CONFIANCE_K);

function ajustementAgent(agent, cases) {
  if (!cases) return 0;
  let somme = 0, vus = 0;
  for (const k in cases) {
    const c = memLit(agent, k, cases[k]);
    if (!c || !c.n) continue;
    somme += confiance(c.n) * Math.max(-30, Math.min(30, c.s / c.n));
    vus++;
  }
  if (!vus) return 0;
  return Math.max(-12, Math.min(12, somme * 0.45));
}
function apprendAgent(agent, cases, rendement) {
  if (!cases) return;
  const r = Math.max(-95, Math.min(300, rendement));
  for (const k in cases) { const c = memCase(agent, k, cases[k]); c.n++; c.s += r; }
}
function leconsDe(agent, max) {
  const m = E.memoire[agent] || {}, out = [];
  for (const t in m) for (const v in m[t]) {
    const c = m[t][v];
    if (c.n < 2) continue;
    const moy = c.s / c.n;
    out.push({ quoi: v, n: c.n, moyenne: Math.round(moy * 10) / 10, poids: confiance(c.n) * Math.abs(moy) });
  }
  out.sort((a, b) => b.poids - a.poids);
  return out.slice(0, max || 3);
}
function tenueApprise() {
  const cases = ((E.memoire.closer || {}).tenue) || {};
  let best = null;
  for (const v in cases) {
    const c = cases[v];
    if (c.n < 3) continue;
    const note = confiance(c.n) * (c.s / c.n);
    if (!best || note > best.note) best = { v, note, moy: c.s / c.n, n: c.n };
  }
  if (!best) return { min: TENUE_DEFAUT_MIN, appris: false };
  return { min: parseInt(best.v, 10) || TENUE_DEFAUT_MIN, appris: true,
           moy: Math.round(best.moy * 10) / 10, n: best.n };
}

/* ---- NOTER UN JETON QUI VIENT DE NAITRE ----
 * L'ancienne note mesurait la qualite ETABLIE — detenteurs, capitalisation,
 * volume — c'est-a-dire tout ce qu'un jeton de sept minutes n'a pas, et elle
 * le punissait pour ca. Celle-ci note ce qui EXISTE a cet age. Et ce qui
 * n'existe pas ne rapporte rien : un champ qu'on n'a pas lu vaut « inconnu »,
 * jamais « bon ». */
function scoreBase(t) {
  const g = t.g || {}, ch = t.chaine || {}, x = t.tx || {};
  const h1 = x.h1 || {};
  let s = 30;
  s += t.liq >= 1e5 ? 16 : t.liq >= 25e3 ? 13 : t.liq >= 8e3 ? 9 : t.liq >= 3e3 ? 5 : t.liq >= 1e3 ? 1 : -6;

  const top = (ch.vu && ch.top !== null && ch.top !== undefined) ? ch.top : (g.topSu ? g.top : null);
  if (top === null) s -= 4;
  else s += top < 5 ? 14 : top < 15 ? 9 : top < 30 ? 2 : top < 50 ? -10 : -26;

  const det = (ch.vu && ch.porteurs !== null && ch.porteurs !== undefined) ? ch.porteurs
            : (g.detSue ? g.holders : null);
  if (det === null) s -= 3;
  else s += det >= 120 ? 12 : det >= 50 ? 9 : det >= 20 ? 5 : det >= 8 ? 1 : -6;

  if (ch.vu && ch.brule !== null && ch.brule !== undefined)
    s += ch.brule >= 90 ? 8 : ch.brule >= 50 ? 5 : ch.brule >= 10 ? 2 : 0;

  const ach = h1.buys || 0, ven = h1.sells || 0, uniq = h1.buyers || 0;
  if (ach + ven > 0) {
    const r = ach / Math.max(1, ven);
    s += r >= 2 ? 8 : r >= 1.3 ? 5 : r >= 0.9 ? 1 : r >= 0.6 ? -3 : -8;
  } else s -= 4;
  s += uniq >= 60 ? 9 : uniq >= 25 ? 6 : uniq >= 10 ? 3 : uniq >= 3 ? 0 : -5;

  if (g.taxeSue) s += (g.buyTax + g.sellTax) === 0 ? 6 : (g.buyTax + g.sellTax) <= 10 ? 2 : -14;
  if (g.codeSu) s += g.unverified ? -8 : 5;
  if (g.have) {
    if (g.proxy) s -= 6;
    if (g.mintable) s -= 8;
    if (g.slipMod) s -= 8;
    if (g.cooldown) s -= 5;
    if (g.lp >= 50) s += 5;
  }
  s += Math.max(-8, Math.min(10, (t.ch_m5 || 0) * 0.25));
  return s;
}

function analyse(t) {
  const g = t.g || {}, ch = t.chaine || {};
  let sec = null;
  if (g.have) {
    if (g.honeypot) sec = 'honeypot';
    else if (g.cannotBuy) sec = 'achat impossible';
    else if (g.ownerBal) sec = 'le proprietaire reecrit les soldes';
    else if (g.selfd) sec = 'auto-destruction';
    else if (g.perslip) sec = 'taxe par portefeuille';
    else if (g.hpSame) sec = 'createur deja honeypot';
    else if (g.pausable) sec = 'transferts suspendables';
    else if (g.taxeSue && g.sellTax > 10) sec = 'taxe vente ' + g.sellTax + '%';
    else if (g.taxeSue && g.buyTax > 15) sec = 'taxe achat ' + g.buyTax + '%';
  }
  /* GoPlus ne sait rien avant des heures ; la chaine sait tout de suite. La
     concentration mesuree dans les blocs prend donc le pas — c'est elle qui
     protege au moment ou la decision se prend. */
  const topVu = (ch.vu && ch.top !== null && ch.top !== undefined) ? ch.top : (g.topSu ? g.top : null);
  /* Un jeton que personne ne garde se refuse pour CETTE raison, ecrite. Sorti
     en « note trop basse », le meme jeton aurait l'air d'un jeton ordinaire un
     peu faible — alors que c'est le profil d'une piscine qui tient tout et
     d'adresses qui entrent et ressortent aussitot. */
  const conc = ch.personne
    ? ch.recepteurs + ' adresses ont touche le jeton, aucune ne le garde'
    : (topVu !== null && topVu >= 50)
      ? 'un porteur tient ' + topVu.toFixed(0) + '% du circulant' : null;
  const tr = traitsDe(t);
  const base = scoreBase(t);
  const parts = {};
  let adj = 0;
  for (const a of ['scout', 'warden', 'whale', 'whisper', 'oracle']) {
    parts[a] = Math.round(ajustementAgent(a, tr[a]) * 10) / 10;
    adj += parts[a];
  }
  adj = Math.max(-30, Math.min(30, adj));
  const score = Math.max(0, Math.min(100, Math.round(base + adj)));
  return { sec, conc, traits: tr, parts, base: Math.round(base), adj: Math.round(adj), score,
           /* Sans prix relu, on ne sait pas a quoi on achete : on n'achete pas. */
           achete: !sec && !conc && score >= SEUIL && t.prix > 0 };
}

/* --------------------------------------------------------- les positions */
function compte(k, n) { E.compteurs[k] = (E.compteurs[k] || 0) + (n || 1); }

function ouvre(t) {
  if (E.positions.length >= POSITIONS_MAX) return false;
  if (E.positions.some((p) => p.adr === t.addr)) return false;   /* une seule par jeton */
  const tenue = tenueApprise();
  E.positions.push({
    sym: t.sym, adr: t.addr, pool: t.pool, prix0: t.prix, t0: Date.now(),
    mise: MISE, traits: t.an.traits, score: t.an.score, mc: t.mc, minutes: Math.round(t.minutes || 0),
    tenueMin: tenue.min, traj: [],
  });
  E.ouvertures++;
  compte('closer');
  E.flux.unshift({ sym: t.sym, pool: t.pool, tag: 'open', txt: 'OUVERT · $' + MISE, cls: 'n', t: Date.now() });
  return true;
}

function ferme(p, prix, quand) {
  const r = (prix - p.prix0) / p.prix0 * 100;
  const pnl = p.mise * r / 100;
  E.tresor += pnl;
  E.trades++;
  if (pnl > 0) E.gains++;
  const mult = 1 + r / 100;
  if (mult > E.meilleur) { E.meilleur = mult; E.meilleurSym = p.sym; }
  /* ---- ET C'EST ICI QUE LES SIX APPRENNENT ----
   * Sur le rendement REEL. Une lecon tiree d'un resultat invente serait pire
   * qu'aucune lecon : elle se propagerait a tous les jetons qui partagent le
   * trait. */
  for (const a of ['scout', 'warden', 'whale', 'whisper', 'oracle']) apprendAgent(a, p.traits[a], r);
  /* Le Closer, lui, apprend une DUREE — depuis la trajectoire reelle de la
     position, c'est-a-dire les prix qu'on a vraiment releves pendant qu'elle
     etait ouverte. */
  const vus = {};
  for (const pt of (p.traj || [])) {
    const cle = trancheTenue(pt.dt / 60000);
    if (vus[cle]) continue;
    vus[cle] = 1;
    apprendAgent('closer', { tenue: cle }, pt.r);
  }
  const fin = trancheTenue((quand - p.t0) / 60000);
  if (!vus[fin]) apprendAgent('closer', { tenue: fin }, r);

  E.flux.unshift({ sym: p.sym, pool: p.pool, tag: pnl >= 0 ? 'buy' : 'cut',
    txt: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '  ·  ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '%',
    cls: pnl >= 0 ? 'up' : 'dn', t: quand, tenue: quand - p.t0 });
  E.courbe.push(Math.round(E.tresor * 100) / 100);
}

function regle(prix) {
  const now = Date.now();
  let n = 0;
  E.positions = E.positions.filter((p) => {
    const x = prix[p.adr];
    if (!(x > 0)) return true;                    /* pas de prix : on attend */
    const dt = now - p.t0;
    const r = (x - p.prix0) / p.prix0 * 100;
    if (!p.traj) p.traj = [];
    if (p.traj.length < 40) p.traj.push({ dt, r: Math.round(r * 100) / 100 });
    if (dt < (p.tenueMin || TENUE_DEFAUT_MIN) * 60000) return true;
    ferme(p, x, now);
    n++;
    return false;
  });
  return n;
}

/* ------------------------------------------------------------------ le tour */
let enCours = false;
const dernierPrix = {};

async function tour() {
  if (enCours) return;
  enCours = true;
  try {
    /* ---- RIEN DE VIEUX N'ENTRE ----
     * Le but est d'analyser du NEUF. Un seul jeton etabli dans le pipeline
     * suffit a fausser ce que les agents apprennent. */
    const liste = (await lisPools())
      .filter((t) => t.liq >= 500 && t.prix > 0)
      .filter((t) => t.minutes !== null && t.minutes <= AGE_MAX_MIN)
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, 20);
    if (!liste.length) throw new Error('aucun jeton neuf assez liquide');

    /* Les prix d'abord : une position due se ferme au prix qu'on vient de
       lire, pas au suivant. */
    const prix = {};
    for (const t of liste) { prix[t.addr] = t.prix; dernierPrix[t.addr] = t.prix; }
    const fermees = regle(prix);

    /* Le detail coute trois appels par jeton, sur des services gratuits qui
       coupent. Six, pas vingt — mieux vaut six jetons vraiment lus que vingt
       « inconnus ». */
    const candidats = liste.slice(0, 6);
    for (const t of candidats) {
      CACHE.poolDe[t.addr] = t.pool;
      await lisGoplus(t);
      const [o, d, ch] = await Promise.all([
        lisOhlcv(t.pool), lisDex(t.addr), lisChaine(t.addr, t.minutes, t.pool)]);
      t.vola = o.vola; t.dex = d; t.chaine = ch;
      t.ecart = (d.vu && d.prix > 0 && t.prix > 0) ? Math.abs(d.prix - t.prix) / t.prix * 100 : null;
      await dors(300);
    }

    let ouvertes = 0;
    for (const t of candidats) {
      compte('scout');
      t.an = analyse(t);
      if (t.an.sec) { compte('wardenBloque'); continue; }
      compte('wardenOk');
      if (t.an.conc) { compte('whaleBloque'); continue; }
      compte('whaleOk');
      compte('whisper');
      compte('oracle');
      if (!t.an.achete) continue;
      if (ouvre(t)) ouvertes++;
    }

    /* Ce que la page affichera : le detail de ce qu'on vient de regarder.
       Aucun chiffre n'y est arrondi vers le haut, et l'inconnu y reste nul. */
    E.candidats = candidats.map((t) => ({
      sym: t.sym, addr: t.addr, pool: t.pool, minutes: Math.round(t.minutes),
      liq: Math.round(t.liq), mc: Math.round(t.mc), prix: t.prix,
      ch_m5: t.ch_m5, score: t.an ? t.an.score : null,
      base: t.an ? t.an.base : null, adj: t.an ? t.an.adj : null,
      refus: t.an ? (t.an.sec || t.an.conc || (t.an.achete ? null : 'note trop basse')) : null,
      porteurs: t.chaine && t.chaine.vu ? t.chaine.porteurs : null,
      top: t.chaine && t.chaine.vu ? t.chaine.top : null,
      chaineVue: !!(t.chaine && t.chaine.vu),
      montantsLus: !!(t.chaine && t.chaine.montantsLus),
      personne: !!(t.chaine && t.chaine.personne),
      transferts: t.chaine && t.chaine.vu ? t.chaine.transferts : null,
      goplusSait: !!(t.g && t.g.have),
    }));
    E.maj = Date.now();
    E.dernierTour = Date.now();
    E.derniereErreur = null;
    if (fermees || ouvertes) sauve(); else sauve();
  } catch (e) {
    /* On DIT que la lecture a echoue. Rien n'est fabrique pour combler : sans
       prix, il n'y a ni ouverture ni reglement, et l'ecran doit le montrer
       plutot que d'afficher un etat qui aurait l'air normal. */
    E.derniereErreur = String((e && e.message) || e).slice(0, 160);
    E.dernierTour = Date.now();
    sauve();
  }
  enCours = false;
}

/* ------------------------------------------------------------------- la vue */
/* Ce que tout le monde lit, et c'est le MEME pour tout le monde. */
function vue() {
  const l = {};
  for (const a of AGENTS) l[a] = { obs: 0, lecons: leconsDe(a, 3) };
  for (const a of AGENTS) {
    const m = E.memoire[a] || {};
    let n = 0;
    for (const t in m) for (const v in m[t]) n = Math.max(n, m[t][v].n);
    l[a].obs = n;
  }
  const tn = tenueApprise();
  return {
    t: Date.now(),
    depuis: E.depuis,
    maj: E.maj, dernierTour: E.dernierTour, erreur: E.derniereErreur,
    cadence: CADENCE_MS,
    tresor: Math.round(E.tresor * 100) / 100, depart: DEPART, mise: MISE,
    trades: E.trades, gains: E.gains,
    meilleur: Math.round(E.meilleur * 100) / 100, meilleurSym: E.meilleurSym,
    ouvertures: E.ouvertures,
    courbe: E.courbe.slice(-120),
    flux: E.flux.slice(0, 12),
    positions: E.positions.map((p) => {
      const x = dernierPrix[p.adr];
      const r = (x > 0) ? (x - p.prix0) / p.prix0 * 100 : null;
      return { sym: p.sym, pool: p.pool, minutes: p.minutes, score: p.score,
               ouverteDepuis: Date.now() - p.t0, tenueMin: p.tenueMin,
               latent: r === null ? null : Math.round(r * 10) / 10 };
    }),
    candidats: E.candidats,
    compteurs: E.compteurs,
    agents: l,
    tenue: tn,
    seuil: SEUIL, ageMax: AGE_MAX_MIN,
  };
}

let minuteur = null;
function demarre() {
  charge();
  if (minuteur) return;
  /* Un premier tour tout de suite, puis la cadence. Au demarrage du serveur,
     les positions en cours se reglent au prix du moment — le temps ecoule est
     du temps reel, meme si personne ne regardait. */
  tour();
  minuteur = setInterval(tour, CADENCE_MS);
  if (minuteur.unref) minuteur.unref();
}
function arrete() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }

module.exports = {
  demarre, arrete, vue, tour, charge, sauve,
  /* exposes pour l'essai : ce sont eux qui portent les regles */
  scoreBase, analyse, traitsDe, tenueApprise, leconsDe, apprendAgent, ajustementAgent,
  regle, ouvre, ferme, etatNeuf, FICHIER, SEUIL, AGE_MAX_MIN, MISE, DEPART,
  _etat: () => E, _pose: (x) => { E = x; }, _cache: CACHE, _prix: dernierPrix,
};
