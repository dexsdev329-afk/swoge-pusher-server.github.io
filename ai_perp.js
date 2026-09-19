'use strict';
/* ==========================================================================
 * SWOGE AI — LES COLONIES DE PERPETUELS (BTC, ETH)
 *
 * ---- pourquoi ce fichier existe, et pourquoi il est SEPARE ----
 *
 * « On peut faire des longs ou des shorts sur ETH ou BTC via Bitget ou Bybit.
 * Ce serait cool de creer une colonie BTC et une colonie ETH, deux autres
 * colonies differentes. » Puis : « deux nouvelles pages, et du coup des
 * agents differents, car ce n est pas la meme analyse qu on a besoin. »
 *
 * C est exact, et c est la raison d etre de ce fichier. La colonie de la
 * chaine Robinhood (`ai_colonie.js`) sait juger un jeton de cinq minutes :
 * concentration des porteurs, profondeur de piscine, contrat verifie, age,
 * rug pull. AUCUN de ces signaux n existe sur un perpetuel BTC. Reutiliser
 * ses agents ici reviendrait a poser les mauvaises questions avec assurance.
 * Les agents sont donc neufs, et les signaux avec eux : tendance sur
 * plusieurs echelles, regime de volatilite, taux de FINANCEMENT, variation
 * de l interet ouvert contre le prix, desequilibre du carnet.
 *
 * Ce qui est repris, en revanche, c est la DOCTRINE du depot, parce qu elle
 * ne depend pas de l instrument :
 *   - toute decision laisse une ombre, jugee a des echeances fixes ;
 *   - toute regle qui refuse porte une ligne d audit, comparee a ce qu on
 *     PREND — une regle qui ecarte autant de gagnants que ce qu on garde ne
 *     protege de rien ;
 *   - sous un minimum d observations, on ne conclut pas ;
 *   - chaque seuil porte en commentaire la mesure qui l a fixe.
 *
 * ---- deux differences de structure avec la colonie de jetons ----
 *
 * 1. ON PEUT VENDRE A DECOUVERT. Un jeton se prend ou se laisse ; un
 *    perpetuel se prend DANS UN SENS. Une ombre porte donc son sens, et son
 *    rendement est celui du sens choisi. Une regle qui refuse un long est
 *    jugee sur ce qu aurait fait CE long, pas sur le mouvement du prix.
 *
 * 2. LE FINANCEMENT EST UN COUT, ET IL EST COMPTE DES LE PREMIER JOUR.
 *    Tenir un perpetuel se paie toutes les huit heures. La lecon vient de la
 *    colonie de jetons, mesuree le 18 septembre 2026 : son papier gagnait et
 *    son reel perdait 3,7 % par trade, uniquement par frottement, parce que
 *    le cout n entrait nulle part dans le papier. Ici il entre des le debut :
 *    le rendement d une position papier est net du financement paye ou recu.
 *
 * ---- ce que ce fichier NE fait pas ----
 *
 * Il ne signe rien. Il ne lit aucune cle. Il n y a pas de miroir, pas
 * d ordre, pas de levier reel. Une colonie de perpetuels qui perd en papier
 * ne doit jamais avoir eu la possibilite de perdre autre chose, et la seule
 * garantie qui vaille est qu il n existe aucun chemin vers un ordre dans ce
 * fichier. Le jour ou il en faudra un, il passera par le mode DEMO de la
 * plateforme (`paptrading: 1` chez Bitget, compte separe chez Bybit), et par
 * sa propre revue.
 *
 * ---- la source ----
 *
 * Bitget, points d acces PUBLICS, sans cle (releve du 19 septembre 2026) :
 *   GET /api/v2/mix/market/ticker   → lastPr, markPrice, indexPrice,
 *       fundingRate, holdingAmount (interet ouvert), bidSz/askSz, change24h
 *   GET /api/v2/mix/market/candles  → [ts, o, h, l, c, volume, montant],
 *       du plus ancien au plus recent
 * Bybit a ete essaye d abord — c est l autre plateforme citee — et repond
 * « CloudFront ... blocked access from your country » depuis cette machine.
 * Le choix n est donc pas une preference, c est une mesure.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const BASE = 'https://api.bitget.com/api/v2/mix/market';
const PRODUIT = 'USDT-FUTURES';

/* Les deux colonies. Chacune a son etat, ses agents, son audit, sa page. */
const SYMBOLES = String(process.env.PERP_SYMBOLES || 'BTCUSDT,ETHUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

/* ---- LES ECHEANCES ----
 * Rien a voir avec les cinq minutes d un jeton qui vient de naitre. Un
 * perpetuel se tient des heures : on juge a quinze minutes, une heure, quatre
 * heures, douze et vingt-quatre. La reference — celle qui nourrit la memoire
 * des agents et l audit — est QUATRE HEURES : c est l horizon ou le taux de
 * financement a deja ete preleve au moins une fois (toutes les huit heures)
 * et ou une tendance intraday a eu le temps de se dementir. */
const HORIZONS = [15, 60, 240, 720, 1440];
const HORIZON_REF = 240;
const PROFIL_MIN_OBS = 8;        /* sous ca, une case n est pas une case */
const AUDIT_MIN_OBS = 12;        /* sous ca, une part de gagnantes est du bruit */

/* ---- CE QUI COMPTE COMME UNE MONTEE ----
 * Sur un jeton de cinq minutes, +20 % est un evenement ordinaire. Sur BTC a
 * quatre heures, c est une seance historique. Les bornes sont donc a
 * l echelle de l instrument : +1,5 % dans le sens pris compte comme une
 * reussite, -1,5 % comme un echec. Mesure du 19 septembre 2026 sur les
 * bougies de quinze minutes de BTCUSDT : l ecart type d un rendement a
 * quatre heures est de l ordre de 1,2 %, donc 1,5 % separe un vrai mouvement
 * du bruit sans exiger l exceptionnel. */
const GAGNE = 1.5;
const PERD = -1.5;

// --------------------------------------------------------------- l etat

const FICHIER = (sym) => path.join(cfg.DATA_DIR, 'ai_perp_' + sym + '.json');
const DEPART = Number(process.env.PERP_DEPART || 1000);

function etatNeuf(sym) {
  return {
    v: 1, sym, depuis: Date.now(), tours: 0, maj: 0,
    tresor: DEPART, depart: DEPART, trades: 0, gains: 0, meilleur: 0,
    positions: [], carnet: [], ombres: [], audit: {}, profils: {},
    compteurs: {}, flux: [], derniereErreur: null,
    /* le financement paye ou recu, cumule : c est la ligne qu on regarde
       quand le papier gagne et qu on se demande ce qu il coute vraiment */
    financement: { n: 0, total: 0 },
    seuil: Number(process.env.PERP_SEUIL || 55),
  };
}
const E = {};                     /* un etat par symbole */
function etat(sym) { return E[sym] || (E[sym] = etatNeuf(sym)); }

function charge() {
  for (const sym of SYMBOLES) {
    try {
      const j = JSON.parse(fs.readFileSync(FICHIER(sym), 'utf8'));
      if (j && j.sym === sym) { E[sym] = Object.assign(etatNeuf(sym), j); continue; }
    } catch (e) { if (e.code !== 'ENOENT') console.error('[perp] ' + sym + ' : ' + e.message); }
    E[sym] = etatNeuf(sym);
  }
  return SYMBOLES.slice();
}
function sauve(sym) {
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    const t = FICHIER(sym) + '.tmp';
    fs.writeFileSync(t, JSON.stringify(etat(sym)));
    fs.renameSync(t, FICHIER(sym));
  } catch (e) { console.error('[perp] sauvegarde ' + sym + ' : ' + e.message); }
}
function compte(sym, k) { const c = etat(sym).compteurs; c[k] = (c[k] || 0) + 1; }

// --------------------------------------------------------------- la lecture

async function lit(chemin, params, prendre) {
  const f = prendre || fetch;
  const u = new URL(BASE + chemin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await f(u.toString(), { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || String(j.code) !== '00000') {
    throw new Error('bitget ' + chemin + ' : ' + (j.msg || r.status));
  }
  return j.data;
}

/**
 * Tout ce qu un tour a besoin de savoir sur un symbole. Les champs non lus
 * restent `null` : un inconnu n est pas une valeur, et aucune regle plus bas
 * n a le droit de le combler.
 */
async function litMarche(sym, prendre) {
  const t = (await lit('/ticker', { symbol: sym, productType: PRODUIT }, prendre))[0];
  /* Deux echelles de bougies : quinze minutes pour le mouvement du jour,
     quatre heures pour la tendance de fond. Cent bougies suffisent aux deux
     moyennes les plus longues qu on calcule. */
  const m15 = await lit('/candles', { symbol: sym, productType: PRODUIT, granularity: '15m', limit: 100 }, prendre);
  const h4 = await lit('/candles', { symbol: sym, productType: PRODUIT, granularity: '4H', limit: 60 }, prendre);
  const nb = (x) => { const v = Number(x); return isFinite(v) ? v : null; };
  const bougies = (l) => (l || []).map((c) => ({ t: nb(c[0]), o: nb(c[1]), h: nb(c[2]), b: nb(c[3]), c: nb(c[4]), v: nb(c[5]) }))
    .filter((c) => c.c !== null);
  return {
    sym, t: Date.now(),
    prix: nb(t.lastPr), marque: nb(t.markPrice), index: nb(t.indexPrice),
    financement: nb(t.fundingRate),          /* par periode de 8 h, en fraction */
    interet: nb(t.holdingAmount),            /* interet ouvert, en contrats */
    bid: nb(t.bidSz), ask: nb(t.askSz),
    haut24: nb(t.high24h), bas24: nb(t.low24h), var24: nb(t.change24h),
    volume: nb(t.quoteVolume),
    m15: bougies(m15), h4: bougies(h4),
  };
}

// --------------------------------------------------------------- les mesures

const moy = (l) => l.length ? l.reduce((a, b) => a + b, 0) / l.length : null;
function ema(vals, n) {
  if (!vals || vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = moy(vals.slice(0, n));
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
/** L ecart type des rendements de bougie a bougie, en pourcent. */
function volatilite(bougies) {
  if (!bougies || bougies.length < 12) return null;
  const r = [];
  for (let i = 1; i < bougies.length; i++) {
    const a = bougies[i - 1].c, b = bougies[i].c;
    if (a > 0) r.push((b - a) / a * 100);
  }
  if (r.length < 10) return null;
  const m = moy(r);
  return Math.sqrt(moy(r.map((x) => (x - m) * (x - m))));
}
/** Ou se situe le prix dans son couloir des N dernieres bougies : 0 bas, 1 haut. */
function position(bougies, n) {
  const l = (bougies || []).slice(-n);
  if (l.length < Math.min(n, 10)) return null;
  const haut = Math.max(...l.map((c) => c.h)), bas = Math.min(...l.map((c) => c.b));
  const p = l[l.length - 1].c;
  if (!(haut > bas)) return null;
  return (p - bas) / (haut - bas);
}
const pct = (a, b) => (a > 0 && b !== null) ? (b - a) / a * 100 : null;

/** Tout ce que les agents lisent, calcule une fois par tour. */
function mesures(m) {
  const c15 = m.m15.map((x) => x.c), c4 = m.h4.map((x) => x.c);
  const der = c15.length ? c15[c15.length - 1] : null;
  const e9 = ema(c15, 9), e21 = ema(c15, 21), e50 = ema(c4, 50);
  return {
    prix: m.prix, der,
    /* la tendance courte : l ecart entre deux moyennes de quinze minutes */
    ecartEma: (e9 !== null && e21 !== null && e21 > 0) ? (e9 - e21) / e21 * 100 : null,
    /* la tendance de fond : le prix contre une moyenne de quatre heures */
    fond: (e50 !== null && m.prix !== null && e50 > 0) ? (m.prix - e50) / e50 * 100 : null,
    vol15: volatilite(m.m15), vol4: volatilite(m.h4),
    couloir: position(m.m15, 96),               /* 24 h en bougies de 15 min */
    var1h: c15.length >= 5 ? pct(c15[c15.length - 5], der) : null,
    var4h: c15.length >= 17 ? pct(c15[c15.length - 17], der) : null,
    financement: m.financement,
    /* le carnet en tete, et rien de plus : ce que l API publique donne */
    carnet: (m.bid !== null && m.ask !== null && (m.bid + m.ask) > 0)
      ? (m.bid - m.ask) / (m.bid + m.ask) : null,
    interet: m.interet, var24: m.var24 !== null ? m.var24 * 100 : null,
  };
}

// --------------------------------------------------------------- les traits

const tranche = (v, bornes, noms) => {
  if (v === null || v === undefined || !isFinite(v)) return null;
  for (let i = 0; i < bornes.length; i++) if (v < bornes[i]) return noms[i];
  return noms[noms.length - 1];
};

/* ---- LES TRAITS, ET POURQUOI CEUX-LA ----
 * Chacun est une question qu on peut poser a un perpetuel et qui n a aucun
 * sens sur un jeton de cinq minutes. C est toute la reponse a « ce n est pas
 * la meme analyse » : la table ci-dessous EST la difference. */
const TRAITS = {
  /* La tendance courte, en ecart de moyennes. */
  tend:  (x) => tranche(x.ecartEma, [-0.6, -0.15, 0.15, 0.6],
                        ['tend <-0,6%', 'tend -0,6/-0,15%', 'tend plate', 'tend 0,15/0,6%', 'tend >0,6%']),
  /* La tendance de fond, le prix contre sa moyenne de quatre heures. */
  fond:  (x) => tranche(x.fond, [-4, -1, 1, 4],
                        ['fond <-4%', 'fond -4/-1%', 'fond neutre', 'fond 1/4%', 'fond >4%']),
  /* Le regime : une meme regle ne vaut pas la meme chose en calme et en
     tempete, et c est la premiere chose qu un jeu de regles oublie. */
  regime: (x) => tranche(x.vol15, [0.08, 0.18, 0.35], ['calme', 'normal', 'agite', 'tempete']),
  /* Le couloir : acheter le haut d un couloir de vingt-quatre heures n est
     pas la meme decision qu acheter son bas. */
  couloir: (x) => tranche(x.couloir === null ? null : x.couloir * 100, [20, 40, 60, 80],
                          ['bas du couloir', 'bas-milieu', 'milieu', 'haut-milieu', 'haut du couloir']),
  /* LE TRAIT PROPRE AU PERPETUEL : qui paie qui. Un financement tres positif
     dit que les longs paient les shorts, donc que tout le monde est long —
     c est une foule, et une foule se fait sortir. */
  fin:   (x) => tranche(x.financement === null ? null : x.financement * 100, [-0.01, -0.002, 0.002, 0.01],
                        ['longs payes fort', 'longs payes', 'financement neutre', 'longs paient', 'longs paient fort']),
  /* Le carnet en tete. Faible portee, mais gratuit et il se mesure. */
  carnet: (x) => tranche(x.carnet === null ? null : x.carnet * 100, [-30, -8, 8, 30],
                         ['vendeurs devant', 'vendeurs', 'carnet equilibre', 'acheteurs', 'acheteurs devant']),
  /* La journee : ou en est le prix sur vingt-quatre heures. */
  jour:  (x) => tranche(x.var24, [-3, -0.7, 0.7, 3],
                        ['jour <-3%', 'jour -3/-0,7%', 'jour plat', 'jour 0,7/3%', 'jour >3%']),
};

/** Les traits de ce moment, par agent — comme dans la colonie de jetons. */
function traitsDe(x) {
  const out = {};
  for (const a of AGENTS) {
    const c = {};
    for (const k of a.traits) { const v = TRAITS[k] ? TRAITS[k](x) : null; if (v !== null) c[k] = v; }
    if (Object.keys(c).length) out[a.key] = c;
  }
  return out;
}

// --------------------------------------------------------------- les agents

/* ---- HUIT AGENTS, AUCUN REPRIS DE LA COLONIE DE JETONS ----
 * `garde` peut refuser, et son veto est dans le code. `specialiste` ne refuse
 * jamais : il pousse ou retient une note. `banque` dimensionne, `execution`
 * ferme. La meme frontiere que dans l autre colonie, sur d autres questions. */
const AGENTS = [
  { key: 'tendance', nom: 'Trend', emoji: '📈', role: 'garde', traits: ['tend', 'fond'],
    quoi: 'reads direction on two scales and refuses to trade against the deeper one' },
  { key: 'regime', nom: 'Regime', emoji: '🌡️', role: 'garde', traits: ['regime'],
    quoi: 'refuses a dead market and a storm: the first pays nothing, the second stops you out' },
  { key: 'financement', nom: 'Funding', emoji: '💸', role: 'specialiste', traits: ['fin'],
    quoi: 'who pays whom — a crowded side is a side that gets flushed' },
  { key: 'couloir', nom: 'Range', emoji: '📏', role: 'specialiste', traits: ['couloir'],
    quoi: 'where the price sits in its own day' },
  { key: 'carnet', nom: 'Book', emoji: '📖', role: 'specialiste', traits: ['carnet'],
    quoi: 'the top of the book, and nothing it cannot see' },
  { key: 'journee', nom: 'Session', emoji: '🕐', role: 'specialiste', traits: ['jour'],
    quoi: 'what the last twenty-four hours already did' },
  { key: 'banquier', nom: 'Banker', emoji: '🏦', role: 'banque', traits: [],
    quoi: 'sizes the paper position against the book' },
  { key: 'closer', nom: 'Closer', emoji: '🚪', role: 'execution', traits: [],
    quoi: 'the stop, the target, and the clock' },
];

/* ---- LES VETOS ----
 * Ils rendent une PHRASE, en anglais, et cette phrase devient une ligne
 * d audit. Elle doit donc nommer la regle, pas le chiffre du moment. */
const VETOS = {
  tendance: (x, sens) => {
    if (x.fond === null || x.ecartEma === null) return 'trend unreadable: not enough candles yet';
    /* On ne prend pas a contre-sens du fond quand il est marque. Seuil a 4 %,
       pose le 19 septembre 2026 : c est la borne haute de la tranche « fond
       neutre » du trait, donc la regle et la mesure parlent de la meme chose. */
    if (sens > 0 && x.fond < -4) return 'long against a deep downtrend';
    if (sens < 0 && x.fond > 4) return 'short against a deep uptrend';
    return null;
  },
  regime: (x) => {
    if (x.vol15 === null) return 'volatility unreadable: not enough candles yet';
    if (x.vol15 < 0.04) return 'market is dead: nothing moves enough to pay the funding';
    if (x.vol15 > 0.6) return 'storm: a stop would be hit by noise alone';
    return null;
  },
};

/* ---- LA NOTE ----
 * Chaque specialiste vote, et son vote est POUR UN SENS. Le total decide.
 * Les poids ne sont pas un reglage d humeur : ils sont egaux au depart, et
 * c est l audit qui dira lesquels meritent mieux. Ecrire des poids differents
 * avant la premiere mesure serait inventer un chiffre. */
const POIDS = { financement: 10, couloir: 10, carnet: 6, journee: 8, tendance: 14 };

function note(x, sens) {
  let s = 50;
  const dit = [];
  const ajoute = (k, v, pourquoi) => { if (v) { s += v; dit.push({ agent: k, points: Math.round(v), pourquoi }); } };
  if (x.ecartEma !== null) {
    const v = Math.max(-1, Math.min(1, x.ecartEma / 0.6)) * sens * POIDS.tendance;
    ajoute('tendance', v, 'short-term trend ' + x.ecartEma.toFixed(2) + '%');
  }
  if (x.financement !== null) {
    /* Contre la foule : financement positif (les longs paient) favorise le
       short, et inversement. C est le signal le plus propre du perpetuel. */
    const f = Math.max(-1, Math.min(1, x.financement * 100 / 0.01));
    ajoute('financement', -f * sens * POIDS.financement,
           'funding ' + (x.financement * 100).toFixed(4) + '% per 8h');
  }
  if (x.couloir !== null) {
    /* Acheter bas, vendre haut : le couloir pousse le long quand le prix est
       bas dans sa journee, le short quand il est haut. */
    const c = (x.couloir - 0.5) * 2;
    ajoute('couloir', -c * sens * POIDS.couloir, 'day range at ' + Math.round(x.couloir * 100) + '%');
  }
  if (x.carnet !== null) ajoute('carnet', x.carnet * sens * POIDS.carnet, 'book imbalance ' + Math.round(x.carnet * 100) + '%');
  if (x.var24 !== null) {
    const j = Math.max(-1, Math.min(1, x.var24 / 3));
    ajoute('journee', -j * sens * POIDS.journee * 0.5, 'day ' + x.var24.toFixed(2) + '%');
  }
  /* Ce que la memoire a retenu des cases de ce moment. */
  const tr = traitsDe(x);
  let lecon = 0, nLecon = 0;
  for (const agent in tr) {
    for (const k in tr[agent]) {
      const c = caseProfil(x.__sym, k, tr[agent][k], HORIZON_REF, true);
      if (c && c.n >= PROFIL_MIN_OBS) { lecon += (c.s / c.n) * sens; nLecon++; }
    }
  }
  if (nLecon) {
    const v = Math.max(-12, Math.min(12, lecon / nLecon * 4));
    ajoute('memoire', v, nLecon + ' learned cells');
  }
  return { score: Math.round(s), dit, traits: tr };
}

// --------------------------------------------------------------- la memoire

function caseProfil(sym, trait, valeur, h, lectureSeule) {
  const P = etat(sym).profils;
  if (lectureSeule) return ((P[trait] || {})[valeur] || {})[h] || null;
  const t = P[trait] || (P[trait] = {});
  const v = t[valeur] || (t[valeur] = {});
  return v[h] || (v[h] = { n: 0, s: 0 });
}
function noteProfil(sym, traits, h, r) {
  for (const agent in traits) {
    for (const k in traits[agent]) {
      const c = caseProfil(sym, k, traits[agent][k], h, false);
      c.n++; c.s += r;
    }
  }
}
function noteAudit(sym, cle, r) {
  const A = etat(sym).audit;
  const a = A[cle] || (A[cle] = { n: 0, s: 0, gagnantes: 0, perdantes: 0 });
  a.n++; a.s += r;
  if (r >= GAGNE) a.gagnantes++;
  if (r <= PERD) a.perdantes++;
}
/** Ce que la page montre de l audit : par regle, ce que les refuses ont fait. */
function auditDesRefus(sym) {
  const A = etat(sym).audit, out = [];
  for (const cle in A) {
    const a = A[cle];
    if (a.n < 3) continue;
    out.push({ cle, n: a.n, moyenne: Math.round(a.s / a.n * 1000) / 1000,
               gagnantes: a.gagnantes, perdantes: a.perdantes,
               partGagnantes: Math.round(a.gagnantes / a.n * 100) });
  }
  out.sort((x, y) => y.partGagnantes - x.partGagnantes);
  return out.slice(0, 25);
}
/** La reference : ce qu on PREND. Une regle se juge contre elle, pas contre un rond. */
function reference(sym) {
  const a = etat(sym).audit['pris'];
  return (a && a.n >= AUDIT_MIN_OBS) ? { n: a.n, partGagnantes: Math.round(a.gagnantes / a.n * 100) } : null;
}
/** Le verdict d une regle : elle protege, elle coute, ou on ne sait pas encore. */
function verdictRegle(sym, cle) {
  const a = etat(sym).audit[cle];
  const ref = reference(sym);
  if (!a || a.n < AUDIT_MIN_OBS) return { verdict: 'unknown', n: (a && a.n) || 0, manque: AUDIT_MIN_OBS - ((a && a.n) || 0) };
  const p = Math.round(a.gagnantes / a.n * 100);
  if (!ref) return { verdict: 'unknown', n: a.n, partGagnantes: p, pourquoi: 'nothing taken yet to compare against' };
  return { verdict: p >= ref.partGagnantes + 8 ? 'costs' : p <= ref.partGagnantes * 0.6 ? 'protects' : 'same',
           n: a.n, partGagnantes: p, reference: ref.partGagnantes };
}

// --------------------------------------------------------------- les ombres

const OMBRES_MAX = 4000;
/**
 * Une ombre par DECISION : ce qu on a pris, et ce qu on a refuse. Elle porte
 * son sens, parce qu un refus de long ne se juge pas sur le mouvement du prix
 * mais sur ce qu aurait fait ce long.
 */
/** Le nom anglais d un agent depuis sa cle — c est ce nom qui va a l ecran. */
function nomAgent(k) {
  if (!k) return null;
  const a = AGENTS.find((z) => z.key === k);
  return a ? a.nom : k;
}
function noteOmbre(sym, x, sens, refus, quiRefuse, traits) {
  const S = etat(sym);
  if (!(x.prix > 0)) return;
  /* ---- LA CLE D AUDIT SE LIT SUR LA PAGE ----
     Elle etait construite sur la CLE de l agent — `tendance`, `couloir`,
     `journee` — et la page l affiche telle quelle : une ligne d audit moitie
     francaise au milieu d un panneau anglais. Le nom de l agent est deja
     anglais et deja montre a cote, dans la liste des agents : c est lui qui
     nomme la regle. Change avant la premiere mesure, donc sans rien perdre —
     apres, une cle qui change repartirait d un echantillon vide. */
  const cle = refus ? (nomAgent(quiRefuse) || 'refus') + ' · ' + refus : 'pris';
  const now = Date.now();
  /* Une seule ombre par cle et par sens a la fois : sinon chaque tour en
     empile une et la meme situation compte cent fois. */
  if (S.ombres.some((o) => o.cle === cle && o.sens === sens && now - o.t < HORIZON_REF * 60000)) return;
  S.ombres.push({ cle, sens, prix0: x.prix, t: now, traits, jalons: {},
                  fin0: x.financement === null ? null : x.financement });
  if (S.ombres.length > OMBRES_MAX) S.ombres = S.ombres.slice(-OMBRES_MAX);
}

/* ---- LE FINANCEMENT EST RETIRE DU RENDEMENT ----
 * Toutes les huit heures, un cote paie l autre. Tenir un long quand le taux
 * est positif coute ; tenir un short rapporte. Une ombre jugee sur le seul
 * mouvement du prix surestimerait donc tous les longs dans un marche haussier
 * — exactement le biais que la colonie de jetons a paye en argent reel. */
const PERIODE_FIN_MIN = 480;
function coutFinancement(sens, taux, minutes) {
  if (taux === null || taux === undefined || !isFinite(taux)) return 0;
  const periodes = minutes / PERIODE_FIN_MIN;
  return -sens * taux * 100 * periodes;      /* en points de pourcentage */
}

function regleLesOmbres(sym, x) {
  const S = etat(sym);
  if (!S.ombres.length || !(x.prix > 0)) return 0;
  const now = Date.now();
  const dernier = HORIZONS[HORIZONS.length - 1];
  let n = 0;
  S.ombres = S.ombres.filter((o) => {
    const age = (now - o.t) / 60000;
    const brut = (x.prix - o.prix0) / o.prix0 * 100 * o.sens;
    const r = Math.round((brut + coutFinancement(o.sens, o.fin0, age)) * 1000) / 1000;
    for (const h of HORIZONS) {
      if (o.jalons[h] !== undefined) continue;
      /* Une echeance ratee reste vide : un jalon pris au mauvais moment n est
         pas un jalon. Meme regle que dans l autre colonie. */
      if (!(age >= h && age <= h + Math.max(5, h * 0.35))) continue;
      o.jalons[h] = r;
      noteProfil(sym, o.traits, h, r);
      compte(sym, 'jalons');
      if (h === HORIZON_REF) { noteAudit(sym, o.cle, r); compte(sym, 'ombresJugees'); n++; }
    }
    return age <= dernier + Math.max(5, dernier * 0.35);
  });
  return n;
}

// --------------------------------------------------------------- les positions

/* ---- CE QUE LE CLOSER DECIDE, ET CE QUI EST DANS LE CODE ----
 * Le stop et la cible sont poses en MULTIPLES de la volatilite du moment, pas
 * en pourcentage fixe : un stop a 1 % est un stop serre en calme et un stop
 * inexistant en tempete, et c est la premiere facon de se faire sortir par le
 * bruit. Les multiples sont volontairement larges et fixes tant qu aucune
 * mesure ne les a departages — l audit des sorties les jugera. */
const STOP_VOL = 3.0, CIBLE_VOL = 5.0, TENUE_MAX_MIN = 720;
const LEVIER = 1;                 /* PAPIER, et sans levier : voir l en-tete */

function ouvre(sym, x, sens, an) {
  const S = etat(sym);
  const v = x.vol15 === null ? 0.15 : x.vol15;
  /* Le Banquier : une part fixe du papier, bornee. Rien d appris tant que
     rien n est mesure — et c est dit. */
  const mise = Math.max(1, Math.min(S.tresor * 0.1, S.tresor / 4));
  const p = {
    sens, prix0: x.prix, t: Date.now(), mise, levier: LEVIER,
    stop: x.prix * (1 - sens * STOP_VOL * v / 100),
    cible: x.prix * (1 + sens * CIBLE_VOL * v / 100),
    fin0: x.financement, score: an.score, traits: an.traits,
    vol: v, jusqua: Date.now() + TENUE_MAX_MIN * 60000,
  };
  S.positions.push(p);
  S.flux.unshift({ t: Date.now(), quoi: (sens > 0 ? 'LONG' : 'SHORT') + ' at ' + x.prix, score: an.score });
  if (S.flux.length > 60) S.flux.length = 60;
  compte(sym, 'ouvertures');
  return p;
}

function ferme(sym, p, prix, pourquoi) {
  const S = etat(sym);
  const minutes = (Date.now() - p.t) / 60000;
  const brut = (prix - p.prix0) / p.prix0 * 100 * p.sens;
  const fin = coutFinancement(p.sens, p.fin0, minutes);
  const r = Math.round((brut + fin) * 1000) / 1000;
  const gain = Math.round(p.mise * r / 100 * 100) / 100;
  S.tresor = Math.round((S.tresor + gain) * 100) / 100;
  S.trades++; S.gains += gain;
  if (r > S.meilleur) S.meilleur = r;
  S.financement.n++; S.financement.total += fin;
  S.carnet.unshift({ sens: p.sens, prix0: p.prix0, prix, r, brut: Math.round(brut * 1000) / 1000,
                     financement: Math.round(fin * 1000) / 1000, gain, minutes: Math.round(minutes),
                     pourquoi, t: Date.now() });
  if (S.carnet.length > 200) S.carnet.length = 200;
  S.positions = S.positions.filter((q) => q !== p);
  S.flux.unshift({ t: Date.now(), quoi: 'CLOSED ' + r.toFixed(2) + '% · ' + pourquoi });
  if (S.flux.length > 60) S.flux.length = 60;
  compte(sym, 'fermetures');
  return r;
}

function surveille(sym, x) {
  const S = etat(sym);
  for (const p of S.positions.slice()) {
    if (!(x.prix > 0)) continue;
    if (p.sens > 0 ? x.prix <= p.stop : x.prix >= p.stop) { ferme(sym, p, p.stop, 'stop'); continue; }
    if (p.sens > 0 ? x.prix >= p.cible : x.prix <= p.cible) { ferme(sym, p, p.cible, 'target'); continue; }
    if (Date.now() >= p.jusqua) ferme(sym, p, x.prix, 'time');
  }
}

// --------------------------------------------------------------- le tour

/**
 * Un tour pour un symbole. `opts.prendre` remplace `fetch` dans les essais,
 * `opts.marche` court-circuite la lecture (pour un banc).
 */
async function tour(sym, opts) {
  const o = opts || {};
  const S = etat(sym);
  let m;
  try {
    m = o.marche || await litMarche(sym, o.prendre);
    S.derniereErreur = null;
  } catch (e) {
    S.derniereErreur = String(e.message || e).slice(0, 160);
    compte(sym, 'lectureRatee');
    return { sym, etat: 'lecture ratee', erreur: S.derniereErreur };
  }
  const x = mesures(m);
  x.__sym = sym;
  S.tours++; S.maj = Date.now();

  regleLesOmbres(sym, x);
  surveille(sym, x);

  /* Les deux sens sont examines separement : un refus de long et un refus de
     short ne disent pas la meme chose, et chacun merite sa ligne d audit. */
  const verdicts = [];
  for (const sens of [1, -1]) {
    let refus = null, qui = null;
    for (const a of AGENTS) {
      const v = VETOS[a.key];
      if (!v) continue;
      const r = v(x, sens);
      if (r) { refus = r; qui = a.key; break; }
    }
    const an = note(x, sens);
    if (!refus && an.score < S.seuil) { refus = 'score below the bar'; qui = 'tendance'; }
    verdicts.push({ sens, refus, qui, score: an.score, an });
  }
  /* On ne tient qu une position a la fois par colonie : deux sens ouverts en
     meme temps sur le meme instrument s annulent et paient deux financements. */
  const pris = verdicts.filter((v) => !v.refus).sort((a, b) => b.score - a.score)[0];
  for (const v of verdicts) {
    if (pris && v === pris) noteOmbre(sym, x, v.sens, null, null, v.an.traits);
    else noteOmbre(sym, x, v.sens, v.refus, v.qui, v.an.traits);
  }
  if (pris && !S.positions.length) ouvre(sym, x, pris.sens, pris.an);
  else if (pris) compte(sym, 'dejaEngage');

  sauve(sym);
  return { sym, etat: 'ok', prix: x.prix, verdicts: verdicts.map((v) => ({ sens: v.sens, score: v.score, refus: v.refus })),
           ouvert: S.positions.length, tresor: S.tresor };
}

// --------------------------------------------------------------- la vue

/** Ce que la page lit. Aucune cle, aucun secret : il n y en a pas ici. */
function vue(sym) {
  const S = etat(sym);
  const f = S.financement;
  return {
    sym, tours: S.tours, maj: S.maj, depuis: S.depuis, erreur: S.derniereErreur,
    tresor: Math.round(S.tresor * 100) / 100, depart: S.depart,
    profit: Math.round((S.tresor - S.depart) * 100) / 100,
    trades: S.trades, meilleur: S.meilleur,
    partGagnantes: S.carnet.length ? Math.round(S.carnet.filter((c) => c.r > 0).length / S.carnet.length * 100) : null,
    /* Ce que le financement a coute en tout : la ligne qu on regarde quand le
       papier a l air bon. */
    financement: { n: f.n, total: Math.round(f.total * 1000) / 1000,
                   moyenne: f.n ? Math.round(f.total / f.n * 1000) / 1000 : null },
    positions: S.positions.map((p) => ({ sens: p.sens, prix0: p.prix0, stop: p.stop, cible: p.cible,
                                         mise: p.mise, score: p.score, depuis: p.t })),
    carnet: S.carnet.slice(0, 40),
    agents: AGENTS.map((a) => ({ key: a.key, nom: a.nom, emoji: a.emoji, role: a.role, quoi: a.quoi, traits: a.traits })),
    audit: auditDesRefus(sym),
    reference: reference(sym),
    verdicts: auditDesRefus(sym).map((l) => Object.assign({ cle: l.cle }, verdictRegle(sym, l.cle))),
    ombres: { enAttente: S.ombres.length, jugees: S.compteurs.ombresJugees || 0 },
    horizons: HORIZONS, horizonRef: HORIZON_REF, minObs: AUDIT_MIN_OBS,
    gagne: GAGNE, perd: PERD, seuil: S.seuil,
    flux: S.flux.slice(0, 20),
    compteurs: S.compteurs,
    /* Dit en toutes lettres, sur la page comme ici : rien n est signe. */
    papier: true, source: 'Bitget public market data',
  };
}

// --------------------------------------------------------------- le service

let minuterie = null;
const CADENCE_MS = Math.max(60000, Number(process.env.PERP_CADENCE_MS || 5 * 60000));
function demarre() {
  if (String(process.env.PERP_COLONIES || '1') !== '1') {
    console.log('[perp] colonies eteintes (PERP_COLONIES=0)');
    return null;
  }
  charge();
  console.log('[perp] colonies PAPIER armees : ' + SYMBOLES.join(', ') + ' · un tour toutes les '
              + Math.round(CADENCE_MS / 60000) + ' min · aucune cle, aucun ordre');
  const boucle = async () => {
    for (const sym of SYMBOLES) {
      try { await tour(sym); } catch (e) { console.error('[perp] ' + sym + ' : ' + (e.message || e)); }
    }
  };
  setTimeout(boucle, 20000);
  minuterie = setInterval(boucle, CADENCE_MS);
  return { arrete() { if (minuterie) clearInterval(minuterie); } };
}

module.exports = {
  SYMBOLES, HORIZONS, HORIZON_REF, AGENTS, TRAITS, VETOS, GAGNE, PERD,
  AUDIT_MIN_OBS, PROFIL_MIN_OBS, PERIODE_FIN_MIN,
  charge, etat, etatNeuf, vue, tour, demarre, litMarche,
  mesures, traitsDe, note, noteOmbre, regleLesOmbres, noteAudit, auditDesRefus,
  reference, verdictRegle, coutFinancement, ouvre, ferme, surveille,
  volatilite, position, ema,
  _pose: (sym, e) => { E[sym] = e; },
};
