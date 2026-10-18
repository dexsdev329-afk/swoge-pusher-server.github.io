'use strict';
/* ============================================================================
 * LE PRIX DES POSITIONS OUVERTES, LU SUR LA CHAINE — OBSERVATION SEULE (LOT 1)
 *
 * ---- LA MESURE, 17/10/2026 (sonde en lecture seule) ----
 *
 * Les positions ouvertes ne sont cotees QUE par DexScreener (`lisDex`). Sur la
 * piscine v3 de NYD, DexScreener se rafraichit toutes les 30,4 s, et chaque
 * valeur qu'il sert est le slot0 de la chaine 27 a 33 s plus tot : 30 a 60 s
 * de retard. UNE piscine, onze mises a jour : un petit echantillon, dit comme
 * tel. Sur trois piscines actives relues le meme soir, chaine et DexScreener
 * s'ecartaient de 4 %, 11 % et 18 % ; sur une piscine calme, de 0,002 %.
 *
 * Et les regles de sortie ne tournent qu'une fois par tour (CADENCE_MS =
 * 150 000) : arret suiveur, paliers, gain pris, plus haut `hautR`. Le veilleur
 * de 45 s ne joue que la coupe, sur la piscine la plus profonde. Releve
 * _releves/2026-10-17T22-33-05-052Z.json : 61 sorties par arret suiveur
 * depassent leur seuil de 7,9 points en mediane (10,4 en moyenne), 17,5 points
 * pour les pics a +40 % et plus (n=24) ; la coupe a -35 % tombe a -43 % en
 * mediane (n=40). La chaine 4663 fait un bloc toutes les 0,102 s, un eth_call
 * slot0 repond en ~45 ms sur le noeud public, et le prix d'une piscine active
 * change toutes les 3 a 4 s.
 *
 * ---- CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT JAMAIS ----
 *
 * Il lit, toutes les 2 s, le prix de chaque position ouverte DANS SA PISCINE
 * (v2 getReserves, v3 slot0, v4 StateView.getSlot0), en un seul lot JSON-RPC
 * par passage. Il rejoue sur cette serie les MEMES regles de sortie — les
 * fonctions de la colonie, passees en dependance, jamais recopiees — sur une
 * COPIE des champs de la position, et note la premiere fois que chacune se
 * serait declenchee. Quand la vraie sortie arrive (tour, veilleur), il ecrit
 * la ligne d'audit : combien de secondes plus tot, a quel rendement, combien
 * de points.
 *
 * Il ne ferme, n'ouvre, ne modifie AUCUNE position. Il ne touche ni au tresor,
 * ni au carnet, ni a la memoire des agents, ni au miroir, ni au releve des
 * noeuds de la colonie (`E.services`) : un noeud qui sature ici ne doit pas
 * changer la rotation des noeuds du tour. Le lot 2 — laisser cette boucle
 * declencher les sorties — ne se decide que sur cet audit.
 *
 * ---- LA CONVERSION, ET POURQUOI ELLE NE FABRIQUE PAS DE SAUT ----
 *
 * La chaine donne un prix NATIF : le jeton dans la monnaie de sa piscine
 * (ETH, ou NVDA, USDG...). La colonie compte en dollars (`priceUsd` de
 * DexScreener, `base_token_price_usd` de GeckoTerminal pour `prix0`).
 * Le facteur retenu est celui de DexScreener LUI-MEME, pour la meme piscine :
 * k = priceUsd / priceNative, lus dans la meme reponse, au meme instant. C'est
 * exactement le facteur qui a fabrique le prix en dollars que la colonie
 * tient. Donc quand la chaine et DexScreener s'accordent sur le prix natif,
 * ils s'accordent en dollars au chiffre pres, et tout ecart est le retard de
 * DexScreener — ce qu'on mesure — jamais un artefact de conversion.
 *
 * L'autre voie — ancrer sur la premiere lecture de chaine et appliquer des
 * rapports — importerait pour toute la vie de la position l'ecart de
 * DexScreener a l'instant de l'ancre (4 a 18 % mesures le 17/10 sur des
 * piscines actives) : c'est la le faux mouvement, celui de MET (187 %) en plus
 * petit. Elle est refusee.
 *
 * Deux gardes encore : on ne change JAMAIS de piscine (on lit `p.pool`, celle
 * du miroir, ou rien) ; et la premiere lecture doit tomber a moins d'un
 * facteur 5 du prix natif de DexScreener pour la meme piscine, sinon la
 * position est ecartee et comptee « incoherente » (une erreur de decimales ou
 * d'ordre token0/token1 donne un facteur 1e12 ou l'inverse du prix, pas 5).
 * Sans facteur pour la piscine, une piscine cotee en ETH prend celui de la
 * derniere paire ETH lue par DexScreener (l'ETH en dollars, tel qu'il le
 * voit) ; une autre monnaie sans facteur attend, et c'est compte.
 * ==========================================================================*/
const { ethers } = require('ethers');

const sel = (s) => ethers.utils.id(s).slice(0, 10);
const SEL = {
  token0: sel('token0()'), token1: sel('token1()'), decimals: sel('decimals()'),
  getReserves: sel('getReserves()'), slot0: sel('slot0()'), getSlot0: sel('getSlot0(bytes32)'),
};
/* StateView v4 : l'adresse que la page du portefeuille utilise deja
   (swoge_wallet.html, ETAT4). Verifiee le 17/10 sur trois piscines v4 :
   getSlot0(id) rend le meme sqrtPriceX96 que extsload(keccak(id, 6)) lu
   directement dans le PoolManager. */
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const PM4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';   /* miroir.js, smart_calcul.js */
const SUJET_INIT = ethers.utils.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const ETH4 = '0x0000000000000000000000000000000000000000';
/* « only 10000000 are allowed for this request » : le noeud officiel, 17/10,
   sur un eth_getLogs depuis le bloc 0. Une fenetre d'un bloc de moins. Dix
   millions de blocs a 0,102 s, c'est onze jours : les positions achetent des
   piscines de moins de six heures. */
const LOGS_FENETRE = 9999999;
const ADRESSES_ETH = [ETH4, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];

/* Les reglages. Eteint par defaut : seul « observe » allume. */
function nEnv(env, nom, defaut) {
  const v = parseFloat(env[nom]);
  return isFinite(v) && v >= 0 ? v : defaut;
}
function reglages(env) {
  const brut = String(env.COLONIE_PRIX_CHAINE || '').trim().toLowerCase();
  return {
    mode: brut === 'observe' ? 'observe' : 'off',
    inconnu: !!brut && brut !== '0' && brut !== 'observe' && brut !== 'off',
    /* 2 s : le prix d'une piscine active change toutes les 3 a 4 s (17/10).
       Plancher 1 s : en dessous on paie des lectures du meme bloc de prix. */
    ms: Math.max(1000, nEnv(env, 'COLONIE_PRIX_CHAINE_MS', 2000)),
    /* Le delai de CHAQUE appel. ~45 ms mesures ; 1,5 s laisse la marge d'un
       noeud lent sans que deux passages se chevauchent. */
    delaiMs: Math.max(200, nEnv(env, 'COLONIE_PRIX_CHAINE_DELAI_MS', 1500)),
    /* Le plafond d'eth_call par minute, decouverte comprise : 30 passages x
       10 positions (POSITIONS_MAX) = 300, plus la place des decouvertes. */
    maxMin: Math.max(1, nEnv(env, 'COLONIE_PRIX_CHAINE_MAX_MIN', 360)),
  };
}

/* ------------------------------------------------------------ les lecteurs */
const mot = (hex, i) => {
  const h = String(hex || '').replace(/^0x/, '');
  const m = h.slice(i * 64, (i + 1) * 64);
  return m.length === 64 ? BigInt('0x' + m) : null;
};
const adresseDe = (hex) => {
  const h = String(hex || '').replace(/^0x/, '');
  return h.length >= 64 ? ('0x' + h.slice(24, 64)).toLowerCase() : null;
};
const decimalesDe = (hex) => {
  const v = mot(hex, 0);
  return (v !== null && v <= 255n) ? Number(v) : null;
};
/** Le prix du jeton de base dans l'autre monnaie, depuis les reserves v2. */
function prixV2(r0, r1, dec0, dec1, baseEst0) {
  if (!(r0 > 0n) || !(r1 > 0n)) return null;
  const p10 = Number(r1) / Number(r0) * Math.pow(10, dec0 - dec1);   /* token0 en token1 */
  const p = baseEst0 ? p10 : 1 / p10;
  return isFinite(p) && p > 0 ? p : null;
}
/** Le meme depuis sqrtPriceX96 (v3 slot0, v4 getSlot0). */
function prixSqrt(sqrtX96, dec0, dec1, baseEst0) {
  if (!(sqrtX96 > 0n)) return null;
  const x = Number(sqrtX96) / Math.pow(2, 96);
  const p10 = x * x * Math.pow(10, dec0 - dec1);
  const p = baseEst0 ? p10 : 1 / p10;
  return isFinite(p) && p > 0 ? p : null;
}
/** La clef v4 d'un journal Initialize, VERIFIEE : l'identifiant recalcule
 *  depuis les cinq champs doit etre celui de la piscine (comme `miroir.js`). */
function cleV4DuJournal(log, id) {
  if (!log || !log.topics || log.topics.length < 4) return null;
  const c0 = adresseDe(log.topics[2]), c1 = adresseDe(log.topics[3]);
  let d;
  try { d = ethers.utils.defaultAbiCoder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], log.data); }
  catch (e) { return null; }
  const k = [c0, c1, d[0], d[1], d[2]];
  const calc = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['(address,address,uint24,int24,address)'], [k]));
  if (calc.toLowerCase() !== String(id).toLowerCase() || String(log.topics[1]).toLowerCase() !== calc.toLowerCase()) return null;
  return { c0, c1 };
}

/* ------------------------------------------------------------- statistiques */
function quantile(l, q) {
  if (!l.length) return null;
  const s = l.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}
const r1 = (x) => (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 10) / 10;
const r2 = (x) => (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 100) / 100;
const pousse = (l, v, max) => { l.push(v); if (l.length > max) l.splice(0, l.length - max); };

/* Les seuils de la page (swoge_ai.html) : REEL_ASSEZ = 5 fermetures appariees
   avant de montrer un chiffre, BANCS_ASSEZ = 100 avant de designer une regle.
   Le lot 2 change une regle de sortie : c'est la barre des 100. */
const REEL_ASSEZ = 5;
const ASSEZ = 100;
const ECHANTILLONS_MAX = 400;     /* par position : ~13 min a 2 s, pour le retard et la sortie */
const CORRESPONDANCE = 0.002;     /* 0,2 % : la tolerance de la sonde du 17/10 */
const NOTE_DEX_MAX_MS = 10 * 60e3;
const COHERENCE = 5;              /* facteur au-dela duquel une lecture est une erreur de lecture */
const PAUSE_SATURE_MS = 60e3;
/* Les regles qui FERMENT, dans l'ordre de `regle`. Les paliers vendent une part. */
const FERMANTES = ['sol coupe', 'arret suiveur', 'gain pris'];
const NOMS = {
  'sol coupe': 'safety cut', 'arret suiveur': 'trailing stop', 'gain pris': 'take-profit',
  'gain pris (essai)': 'take-profit (1-in-3 trial)', 'dernier palier': 'last rung',
  'palier 1': 'ladder rung 1', 'palier 2': 'ladder rung 2', 'palier 3': 'ladder rung 3',
  'premiere regle': 'first rule to fire, any',
};

/* ==========================================================================
 * LA BOUCLE
 *
 * deps :
 *   positions()      les positions ouvertes (LUES : on n'en garde qu'une copie de champs)
 *   regles           { danger(p, x), suiveur(p, r), paliers(p, r), prise(p, r), min, max }
 *   noeud()          { url, cle } le noeud de tete de la colonie
 *   noeudJournaux()  { url, cle } un noeud qui sert eth_getLogs sur 10 M de blocs
 *   etat()           l'objet ou garder l'audit (E.prixChaine, persiste par la colonie)
 *   fetch, maintenant, env
 * ======================================================================== */
function cree(deps) {
  const R = Object.assign({}, reglages(deps.env || process.env));
  let fetchF = deps.fetch || ((...a) => fetch(...a));
  let maintenant = deps.maintenant || Date.now;
  const fiches = {};        /* par piscine : type, ordre, decimales, etat */
  const ombres = {};        /* par position (adr:t0) : copie des champs, echantillons, premiers declenchements */
  const notes = {};         /* par piscine : la derniere lecture DexScreener { usd, natif, t } */
  let kEth = null;          /* l'ETH en dollars selon DexScreener : { k, t } */
  const fenetre = [];       /* [t, appels] sur la derniere minute */
  let pauseJusqua = 0, enCours = false, minuteur = null;
  const C = { passages: 0, lots: 0, appels: 0, erreurs: 0, delais: 0, sature: 0, plafond: 0,
              lectures: 0, aberrants: 0 };

  function store() {
    const E = deps.etat();
    if (!E.prixChaine || typeof E.prixChaine !== 'object') E.prixChaine = {};
    const S = E.prixChaine;
    if (!S.regles || typeof S.regles !== 'object') S.regles = {};
    if (!Array.isArray(S.ecarts)) S.ecarts = [];
    if (!Array.isArray(S.retards)) S.retards = [];
    if (!Array.isArray(S.lignes)) S.lignes = [];
    if (!S.c || typeof S.c !== 'object') S.c = {};
    return S;
  }
  const compteS = (k, n) => { const S = store(); S.c[k] = (S.c[k] || 0) + (n || 1); };
  const actif = () => R.mode === 'observe';

  /* ---- CE QUE DEXSCREENER A DIT, POUR CHAQUE PISCINE ----
   * Appele par `lisDex` sur chaque paire de chaque reponse : aucun appel de
   * plus, seulement ce qu'on lisait deja. */
  function noteDex(x) {
    if (!actif() || !x || !x.pool) return;
    const usd = Number(x.usd), natif = Number(x.natif);
    if (!(usd > 0) || !(natif > 0)) return;
    const t = maintenant();
    notes[String(x.pool).toLowerCase()] = { usd, natif, t };
    if (x.eth) kEth = { k: usd / natif, t };
  }

  /* ------------------------------------------------------------ le reseau */
  function appelsDeLaMinute(now) {
    while (fenetre.length && now - fenetre[0][0] >= 60e3) fenetre.shift();
    return fenetre.reduce((s, x) => s + x[1], 0);
  }
  async function lot(url, appels) {
    const now = maintenant();
    if (appelsDeLaMinute(now) + appels.length > R.maxMin) { C.plafond++; compteS('plafond'); return null; }
    fenetre.push([now, appels.length]);
    C.lots++; C.appels += appels.length;
    const ctl = new AbortController();
    const minu = setTimeout(() => ctl.abort(), R.delaiMs);
    try {
      const corps = appels.map((a, i) => ({ jsonrpc: '2.0', id: i, method: a[0], params: a[1] }));
      const r = await fetchF(url, { method: 'POST', headers: { 'content-type': 'application/json' },
                                    body: JSON.stringify(corps), signal: ctl.signal });
      if (r.status === 429) { C.sature++; compteS('sature'); pauseJusqua = maintenant() + PAUSE_SATURE_MS; return null; }
      const j = await r.json();
      if (!Array.isArray(j)) {
        /* Un noeud qui refuse les lots, ou qui sature : on se tait une minute. */
        const msg = String((j && j.error && j.error.message) || '');
        if (/too many|rate|429/i.test(msg) || (j && j.error && j.error.code === 429)) { C.sature++; compteS('sature'); }
        else { C.erreurs++; compteS('erreur'); }
        pauseJusqua = maintenant() + PAUSE_SATURE_MS;
        return null;
      }
      const out = new Array(appels.length).fill(null);
      for (const x of j) if (x && typeof x.id === 'number' && x.id >= 0 && x.id < out.length) out[x.id] = x;
      if (out.some((x) => x && x.error && (x.error.code === 429 || /too many|rate/i.test(String(x.error.message || ''))))) {
        C.sature++; compteS('sature'); pauseJusqua = maintenant() + PAUSE_SATURE_MS;
      }
      return out.map((x) => (x && !x.error && typeof x.result !== 'undefined') ? x.result : null);
    } catch (e) {
      if (ctl.signal.aborted) { C.delais++; compteS('delai'); } else { C.erreurs++; compteS('erreur'); }
      return null;
    } finally { clearTimeout(minu); }
  }
  const call = (to, data) => ['eth_call', [{ to, data }, 'latest']];

  /* ------------------------------------------------- la fiche d'une piscine */
  const PERMANENTS = { 'type inconnu': 1, 'base absente': 1, 'decimales illisibles': 1, 'v4 sans cle': 1, 'incoherent': 1 };
  function ficheDe(p) {
    const pool = String(p.pool || '').toLowerCase();
    if (!fiches[pool]) {
      const f = { pool, base: String(p.adr || '').toLowerCase(), etape: null, etat: null };
      if (/^0x[0-9a-f]{64}$/.test(pool)) { f.ver = 'v4'; f.etape = 'tip'; }
      else if (/^0x[0-9a-f]{40}$/.test(pool)) { f.etape = 'type'; }
      else { f.etat = 'type inconnu'; compteS('ecartee_type inconnu'); }
      fiches[pool] = f;
    }
    return fiches[pool];
  }
  function ecarte(f, pourquoi) { f.etat = pourquoi; f.etape = null; compteS('ecartee_' + pourquoi); }

  /* Les appels de decouverte d'une fiche, et ce qu'on fait de leurs reponses. */
  function decouverte(f) {
    if (f.etape === 'type') {
      return { appels: [call(f.pool, SEL.token0), call(f.pool, SEL.token1), call(f.pool, SEL.slot0), call(f.pool, SEL.getReserves)],
        suite(res) {
          if (!res) return;
          const t0 = adresseDe(res[0]), t1 = adresseDe(res[1]);
          if (!t0 || !t1) return ecarte(f, 'type inconnu');
          if (res[2] && mot(res[2], 1) !== null) f.ver = 'v3';
          else if (res[3] && mot(res[3], 2) !== null) f.ver = 'v2';
          else return ecarte(f, 'type inconnu');
          f.t0 = t0; f.t1 = t1;
          if (f.base !== t0 && f.base !== t1) return ecarte(f, 'base absente');
          f.etape = 'decimales';
        } };
    }
    if (f.etape === 'decimales') {
      const ap = [], qui = [];
      for (const t of [f.t0, f.t1]) if (t !== ETH4) { ap.push(call(t, SEL.decimals)); qui.push(t); }
      return { appels: ap, suite(res) {
        if (!res) return;
        const d = {};
        qui.forEach((t, i) => { d[t] = decimalesDe(res[i]); });
        f.d0 = f.t0 === ETH4 ? 18 : d[f.t0]; f.d1 = f.t1 === ETH4 ? 18 : d[f.t1];
        if (f.d0 === null || f.d1 === null || f.d0 === undefined || f.d1 === undefined) return ecarte(f, 'decimales illisibles');
        f.base0 = f.base === f.t0;
        f.quote = f.base0 ? f.t1 : f.t0;
        f.eth = ADRESSES_ETH.indexOf(f.quote) >= 0;
        f.etape = null; f.etat = 'prete';
      } };
    }
    return null;
  }
  /* v4 : le bloc de tete, puis le journal Initialize par identifiant (sur le
     noeud des journaux, dans sa fenetre), puis les decimales. */
  async function decouvreV4(f) {
    if (f.etape === 'tip') {
      const res = await lot(deps.noeudJournaux().url, [['eth_blockNumber', []]]);
      const n = res && res[0] ? parseInt(res[0], 16) : NaN;
      if (isFinite(n)) { f.tip = n; f.etape = 'journal'; }
      return;
    }
    if (f.etape === 'journal') {
      const res = await lot(deps.noeudJournaux().url, [['eth_getLogs', [{ address: PM4, topics: [SUJET_INIT, f.pool],
        fromBlock: '0x' + Math.max(0, f.tip - LOGS_FENETRE).toString(16), toBlock: '0x' + f.tip.toString(16) }]]]);
      if (!res) { f.essais = (f.essais || 0) + 1; if (f.essais >= 3) ecarte(f, 'v4 sans cle'); return; }
      const k = (res[0] || []).map((l) => cleV4DuJournal(l, f.pool)).find(Boolean);
      if (!k) return ecarte(f, 'v4 sans cle');
      f.t0 = k.c0; f.t1 = k.c1;
      if (f.base !== f.t0 && f.base !== f.t1) return ecarte(f, 'base absente');
      f.etape = 'decimales';
    }
  }
  const lecture = (f) => f.ver === 'v2' ? call(f.pool, SEL.getReserves)
    : f.ver === 'v3' ? call(f.pool, SEL.slot0) : call(STATE_VIEW, SEL.getSlot0 + f.pool.slice(2));
  function natifDe(f, res) {
    if (!res) return null;
    if (f.ver === 'v2') return prixV2(mot(res, 0), mot(res, 1), f.d0, f.d1, f.base0);
    const s = mot(res, 0);
    return s === null ? null : prixSqrt(s & ((1n << 160n) - 1n), f.d0, f.d1, f.base0);
  }

  /* ---------------------------------------------------------- les ombres */
  const cleDe = (p) => String(p.adr).toLowerCase() + ':' + p.t0;
  /* Une COPIE des seuls champs que lisent les regles. Les regles de la
     colonie ecrivent dans ce qu'on leur donne (`arretSuiveur` pose `hautR`) :
     elles n'ecrivent donc que dans la copie. */
  function copieDe(p, o) {
    return { adr: p.adr, sym: p.sym, prix0: p.prix0, liq0: p.liq0, t0: p.t0,
             hautR: o.hautR, paliers: Object.assign({}, o.paliers), reste: p.reste };
  }
  function ombreDe(p) {
    const k = cleDe(p);
    if (!ombres[k]) {
      ombres[k] = { k, adr: String(p.adr).toLowerCase(), sym: p.sym, pool: String(p.pool || '').toLowerCase(),
                    hautR: (typeof p.hautR === 'number') ? p.hautR : undefined,
                    paliers: Object.assign({}, p.paliers || {}), premiers: {}, ech: [], joue: 0, noteT: 0,
                    vuDe: maintenant() };
    }
    return ombres[k];
  }
  /* Un echantillon de plus ; les plus vieux sortent, et le curseur des regles
     deja jouees recule d'autant. */
  function ajoute(o, e) {
    o.ech.push(e);
    const trop = o.ech.length - ECHANTILLONS_MAX;
    if (trop > 0) { o.ech.splice(0, trop); o.joue = Math.max(0, o.joue - trop); }
  }
  function facteurDe(f) {
    const n = notes[f.pool], now = maintenant();
    if (n && now - n.t <= NOTE_DEX_MAX_MS) return n.usd / n.natif;
    if (f.eth && kEth && now - kEth.t <= NOTE_DEX_MAX_MS) return kEth.k;
    return null;
  }
  /* Rejoue les regles sur les echantillons pas encore joues. */
  function joue(p, o, f) {
    const k = facteurDe(f);
    if (!(k > 0)) { compteS('sansConversion'); return; }
    const reg = deps.regles;
    for (; o.joue < o.ech.length; o.joue++) {
      const e = o.ech[o.joue];
      const usd = e.nat * k;
      const r = (usd - p.prix0) / p.prix0 * 100;
      e.r = r;
      if (!isFinite(r) || r > reg.max || r < reg.min) { C.aberrants++; compteS('aberrant'); continue; }
      const tenu = !!(p.tenuParMain && e.t < p.tenuParMain.jusqua);
      const q = copieDe(p, o);
      const note = (cle, extra) => {
        if (o.premiers[cle]) return;
        o.premiers[cle] = Object.assign({ t: e.t, r }, extra || {});
        if (FERMANTES.indexOf(cle) >= 0 && !o.premiers['premiere regle'])
          o.premiers['premiere regle'] = { t: e.t, r, regle: cle };
      };
      /* L'ordre de `regle` : la coupe, les paliers, l'arret suiveur, le gain. */
      if (!tenu && reg.danger(q, { prix: usd, liq: 0 })) note('sol coupe');
      for (const n of reg.paliers(q, r)) { o.paliers[n.k] = true; note('palier ' + n.k); }
      if (!tenu) {
        const s = reg.suiveur(q, r);
        o.hautR = q.hautR;
        if (s) note('arret suiveur', { haut: q.hautR });
        const a = reg.prise(q, r);
        if (a) note(a.sur ? 'gain pris' : 'gain pris (essai)');
      }
    }
  }
  /* Le retard de DexScreener sur la chaine, a chaque nouvelle lecture : le
     moment ou la chaine avait le prix qu'il sert encore. */
  function noteRetard(o, n) {
    if (!n || n.t === o.noteT) return;
    o.noteT = n.t;
    const S = store();
    const avant = o.ech.filter((e) => e.t <= n.t);
    if (avant.length < 2) return;
    const va = (e) => Math.abs(e.nat / n.natif - 1) <= CORRESPONDANCE;
    let j = avant.length - 1;
    while (j >= 0 && !va(avant[j])) j--;
    if (j < 0) { S.sansCorrespondance = (S.sansCorrespondance || 0) + 1; return; }
    if (j === avant.length - 1) { S.aJour = (S.aJour || 0) + 1; return; }
    let i = j;
    while (i > 0 && va(avant[i - 1])) i--;
    /* Au moins (lecture - derniere fois que la chaine avait ce prix), au plus
       (lecture - premiere fois de cette meme plage). */
    pousse(S.retards, [Math.round((n.t - avant[j].t) / 100) / 10, Math.round((n.t - avant[i].t) / 100) / 10], 500);
  }

  /* ---------------------------------------------------------- un passage */
  async function passage() {
    if (!actif() || enCours) return 0;
    const now = maintenant();
    const ps = (deps.positions() || []).filter((p) => p && p.adr && p.prix0 > 0);
    /* Les ombres des positions disparues sans sortie vue (abandon) s'oublient. */
    const vivantes = new Set(ps.map(cleDe));
    for (const k of Object.keys(ombres)) if (!vivantes.has(k)) delete ombres[k];
    if (!ps.length) return 0;
    if (now < pauseJusqua) return 0;
    enCours = true;
    try {
      C.passages++;
      /* Ce que la minute permet encore : les lectures de prix d'abord, puis les
         decouvertes ENTIERES qui tiennent. Sans ce tri, un lot de decouverte
         plus gros que le plafond (deux positions v3 : huit appels) serait
         refuse a chaque passage, pour toujours. */
      let place = R.maxMin - appelsDeLaMinute(now), manque = false;
      const appels = [], suites = [], v4 = [], aDecouvrir = [];
      for (const p of ps) {
        const f = ficheDe(p);
        if (f.etat === 'prete') {
          if (place > 0) { suites.push({ p, f, idx: appels.length }); appels.push(lecture(f)); place--; } else manque = true;
          continue;
        }
        if (PERMANENTS[f.etat]) continue;
        if (f.ver === 'v4' && (f.etape === 'tip' || f.etape === 'journal')) { if (v4.indexOf(f) < 0) v4.push(f); continue; }
        if (aDecouvrir.indexOf(f) < 0) aDecouvrir.push(f);
      }
      for (const f of aDecouvrir) {
        const d = decouverte(f);
        if (!d) continue;
        if (!d.appels.length) { d.suite([]); continue; }
        if (d.appels.length > place) { manque = true; continue; }
        suites.push({ d, i0: appels.length, n: d.appels.length });
        appels.push(...d.appels);
        place -= d.appels.length;
      }
      if (manque) { C.plafond++; compteS('plafond'); }
      const res = appels.length ? await lot(deps.noeud().url, appels) : null;
      /* Une decouverte v4 par passage au plus : c'est un journal, pas un prix. */
      if (v4.length && R.maxMin - appelsDeLaMinute(maintenant()) >= 1) await decouvreV4(v4[0]);
      if (!appels.length) return 0;
      const t = maintenant();
      for (const s of suites) {
        if (s.d) { s.d.suite(res ? res.slice(s.i0, s.i0 + s.n) : null); continue; }
        const nat = res ? natifDe(s.f, res[s.idx]) : null;
        if (!(nat > 0)) continue;
        C.lectures++;
        const o = ombreDe(s.p);
        const n = notes[s.f.pool];
        /* La premiere lecture se compare a DexScreener sur la MEME piscine :
           une erreur de lecture ne doit jamais devenir un declenchement. */
        if (!s.f.verifiee) {
          if (!n || t - n.t > NOTE_DEX_MAX_MS) { ajoute(o, { t, nat }); continue; }
          const f5 = nat / n.natif;
          if (!(f5 < COHERENCE && f5 > 1 / COHERENCE)) { ecarte(s.f, 'incoherent'); delete ombres[o.k]; continue; }
          s.f.verifiee = true;
        }
        ajoute(o, { t, nat });
        joue(s.p, o, s.f);
        /* L'ecart au dernier prix DexScreener tenu, en natif : sans conversion. */
        if (n && t - n.t <= NOTE_DEX_MAX_MS) {
          pousse(store().ecarts, [r2(Math.abs(n.natif / nat - 1) * 100), Math.round((t - n.t) / 1000)], 2000);
          noteRetard(o, n);
        }
      }
      return C.lectures;
    } finally { enCours = false; }
  }

  /* ------------------------------------------------------ la vraie sortie */
  function rChaineA(o, t) {
    for (let i = o.ech.length - 1; i >= 0; i--) {
      const e = o.ech[i];
      if (e.t <= t && typeof e.r === 'number') return (t - e.t <= 10e3) ? e.r : null;
    }
    return null;
  }
  function ligne(regle, o, f, r, t) {
    const S = store();
    const L = S.regles[regle] || (S.regles[regle] = { n: 0, nonVu: 0, avances: [], pts: [], ptsLivre: [] });
    if (!f) { L.nonVu++; return; }
    if (f.t > t) { L.nonVu++; return; }
    const rCs = rChaineA(o, t);
    const avance = Math.round((t - f.t) / 100) / 10;
    /* Les points : ce que la chaine rendait au declenchement, moins ce qu'elle
       rendait au moment de la vraie sortie — c'est ce qu'un ordre reel aurait
       touche de plus ou de moins. A cote, l'ecart au rendement inscrit. */
    const pts = rCs === null ? null : f.r - rCs;
    L.n++;
    pousse(L.avances, avance, 500);
    if (pts !== null) pousse(L.pts, r2(pts), 500);
    pousse(L.ptsLivre, r2(f.r - r), 500);
    pousse(S.lignes, { t, sym: o.sym, regle, avance, rChaine: r2(f.r), rSortie: r2(r), rChaineSortie: r2(rCs),
                       pts: r2(pts), ptsLivre: r2(f.r - r) }, 40);
  }
  /** La position vient de fermer. `regle` : la regle qui l'a fermee. */
  function sortieReelle(p, regle, r, t) {
    if (!actif() || !p) return;
    const o = ombres[cleDe(p)];
    if (!o) { compteS('sortieSansOmbre'); return; }
    if (o.joue < o.ech.length) { const f = fiches[o.pool]; if (f) joue(p, o, f); }
    if (FERMANTES.indexOf(regle) >= 0) {
      ligne(regle, o, o.premiers[regle], r, t);
      if (regle === 'gain pris' && !o.premiers['gain pris'] && o.premiers['gain pris (essai)'])
        ligne('gain pris (essai)', o, o.premiers['gain pris (essai)'], r, t);
    }
    /* Toutes les sorties, l'echeance comprise : la premiere regle qui aurait
       ferme sur la chaine, si elle tombe avant. */
    const pr = o.premiers['premiere regle'];
    if (pr && pr.t <= t) ligne('premiere regle', o, pr, r, t);
    compteS('sortie_' + regle);
    delete ombres[o.k];
  }
  function palierReel(p, k, r, t) {
    if (!actif() || !p) return;
    const o = ombres[cleDe(p)];
    if (!o) return;
    if (o.joue < o.ech.length) { const f = fiches[o.pool]; if (f) joue(p, o, f); }
    ligne('palier ' + k, o, o.premiers['palier ' + k], r, t);
  }

  /* --------------------------------------------------------------- la vue */
  function vue(noeudNom) {
    const S = deps.etat().prixChaine || {};
    const fichesL = Object.values(fiches);
    const ecarts = (S.ecarts || []).map((x) => x[0]).filter((x) => typeof x === 'number');
    const ages = (S.ecarts || []).map((x) => x[1]).filter((x) => typeof x === 'number');
    const ret = S.retards || [];
    const nEc = ecarts.length, nRet = ret.length + (S.aJour || 0);
    const audit = Object.keys(S.regles || {}).map((cle) => {
      const L = S.regles[cle];
      const montre = L.n >= REEL_ASSEZ;
      const pm = L.pts.length ? L.pts.reduce((s, x) => s + x, 0) / L.pts.length : null;
      return {
        cle: 'chain view · ' + (NOMS[cle] || cle), regle: cle, n: L.n, nonVu: L.nonVu,
        avanceMediane: montre ? r1(quantile(L.avances, 0.5)) : null,
        ptsMoyen: montre ? r1(pm) : null,
        ptsMedian: montre ? r1(quantile(L.pts, 0.5)) : null,
        ptsLivreMedian: montre ? r1(quantile(L.ptsLivre, 0.5)) : null,
        partGagnant: montre && L.pts.length ? Math.round(100 * L.pts.filter((x) => x > 0).length / L.pts.length) : null,
        verdict: L.n < ASSEZ
          ? 'too few exits to conclude (' + L.n + '/' + ASSEZ + ')' + (L.n < REEL_ASSEZ ? ': figures hidden below ' + REEL_ASSEZ : '')
          : 'on ' + L.n + ' exits the chain view fires ' + r1(quantile(L.avances, 0.5)) + ' s earlier (median), '
            + (pm >= 0 ? '+' : '') + r1(pm) + ' pts per exit on average — observed only, nothing traded on it',
      };
    }).sort((a, b) => b.n - a.n);
    return {
      mode: R.mode, valeurInconnue: R.inconnu, ms: R.ms, delaiMs: R.delaiMs, maxMin: R.maxMin, noeud: noeudNom || null,
      assez: ASSEZ, montreA: REEL_ASSEZ,
      suivies: Object.keys(ombres).length,
      piscines: { pretes: fichesL.filter((f) => f.etat === 'prete').length,
                  enCours: fichesL.filter((f) => !f.etat).length,
                  ecartees: fichesL.filter((f) => PERMANENTS[f.etat]).reduce((m, f) => { m[f.etat] = (m[f.etat] || 0) + 1; return m; }, {}) },
      appels: Object.assign({ minute: appelsDeLaMinute(maintenant()) }, C),
      compteurs: S.c || {},
      ecart: { n: nEc, medianePct: r2(quantile(ecarts, 0.5)), p90Pct: r2(quantile(ecarts, 0.9)),
               ageMedianS: quantile(ages, 0.5),
               verdict: nEc < ASSEZ ? 'too few readings to conclude (' + nEc + '/' + ASSEZ + ')'
                 : 'DexScreener differs from the chain by ' + r2(quantile(ecarts, 0.5)) + '% (median), '
                   + r2(quantile(ecarts, 0.9)) + '% at p90, on ' + nEc + ' readings' },
      retard: { n: nRet, aJour: S.aJour || 0, sansCorrespondance: S.sansCorrespondance || 0,
                minMedianS: r1(quantile(ret.map((x) => x[0]), 0.5)), maxMedianS: r1(quantile(ret.map((x) => x[1]), 0.5)),
                maxP90S: r1(quantile(ret.map((x) => x[1]), 0.9)),
                verdict: nRet < ASSEZ ? 'too few DexScreener updates to conclude (' + nRet + '/' + ASSEZ + ')'
                  : 'DexScreener shows the chain price of ' + r1(quantile(ret.map((x) => x[0]), 0.5)) + '-'
                    + r1(quantile(ret.map((x) => x[1]), 0.5)) + ' s earlier (median), on ' + nRet + ' updates' },
      audit,
      lignes: (S.lignes || []).slice(-20).reverse(),
    };
  }

  function demarre() {
    if (!actif() || minuteur) return false;
    minuteur = setInterval(() => { passage().catch(() => { C.erreurs++; }); }, R.ms);
    if (minuteur.unref) minuteur.unref();
    return true;
  }
  function arrete() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }

  return {
    actif, demarre, arrete, passage: passage, noteDex, sortieReelle, palierReel, vue,
    reglages: () => Object.assign({}, R),
    /* pour les essais : une fausse chaine, une horloge, un mode */
    _pose(o) {
      if (o.fetch) fetchF = o.fetch;
      if (o.maintenant) maintenant = o.maintenant;
      if (o.env) Object.assign(R, reglages(o.env));
      if (o.oublie) { for (const k of Object.keys(fiches)) delete fiches[k]; for (const k of Object.keys(ombres)) delete ombres[k];
                      for (const k of Object.keys(notes)) delete notes[k]; kEth = null; fenetre.length = 0; pauseJusqua = 0;
                      for (const k of Object.keys(C)) C[k] = 0; }
    },
    _ombres: () => ombres, _fiches: () => fiches,
  };
}

module.exports = { cree, reglages, prixV2, prixSqrt, cleV4DuJournal, mot, adresseDe, decimalesDe, quantile,
                   SEL, STATE_VIEW, PM4, SUJET_INIT, LOGS_FENETRE, ASSEZ, REEL_ASSEZ, FERMANTES, NOMS };
