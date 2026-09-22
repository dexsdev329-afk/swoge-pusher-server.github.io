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
/* Le journal brut : il observe, il ne decide rien. Voir son en-tete. */
const journal = require('./perp_journal');
const cfg = require('./config');

const BASE = 'https://api.bitget.com/api/v2/mix/market';
const PRODUIT = 'USDT-FUTURES';

/* ---- CINQ COLONIES, PAS DEUX ----
 * « Pourquoi deux differentes ? Il me semble qu il trade n importe quel gros
 * token. » — et c est possible : Bitget expose 797 perpetuels, et la liste
 * est une variable d environnement, pas une reecriture. Les cinq marches
 * retenus le 19 septembre 2026, mesures ce jour-la sur `/mix/market/tickers` :
 * BTC 2 875 M$ sur 24 h, ETH 2 392, SOL 342, XRP 233, DOGE 57. Au-dessous, le
 * carnet devient trop mince pour qu un devis veuille dire quelque chose.
 *
 * Chacun garde SA colonie — tresorerie, positions, traits. Ce qu un agent
 * apprend sur la volatilite de DOGE ne vaut rien sur BTC, et une colonie
 * unique moyennerait les cinq sans en apprendre un seul. Ce qui se met en
 * commun, c est l AUDIT : voir `auditCommun()`. */
const SYMBOLES = String(process.env.PERP_SYMBOLES || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT')
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

const FICHIER = () => path.join(cfg.DATA_DIR, 'ai_perp.json');
const DEPART = Number(process.env.PERP_DEPART || 1000);

/* ==========================================================================
 * UNE COLONIE POUR TOUS LES PERPETUELS
 *
 * Il y en a eu une par marche : cinq tresoreries, cinq audits, cinq memoires.
 * « Non, il faudrait une colonie pour tous les perps. » C est le bon sens
 * d un bureau de trading — un capital, qui va la ou ca paie — et ca corrige
 * un defaut que le decoupage rendait invisible :
 *
 *   - cinq memoires qui apprennent chacune sur un cinquieme des observations
 *     n apprennent rien. Une seule, nourrie par les cinq marches, apprend
 *     cinq fois plus vite.
 *   - cinq tresoreries de mille dollars ne se comparent pas a une de cinq
 *     mille : la mise est une PART du capital, donc cinq petites colonies
 *     prennent cinq petites positions la ou une seule en prend une vraie.
 *
 * ---- ET CE QUE LE DECOUPAGE DISAIT DE VRAI ----
 * Il disait qu un marche ne se lit pas comme un autre : la volatilite de DOGE
 * n est pas celle de BTC. C est vrai, et ca ne justifie pas cinq colonies —
 * ca justifie que le MARCHE SOIT UN TRAIT. Il en est un (`TRAITS.marche`) :
 * la memoire apprend ce que chaque marche a rendu, exactement comme elle
 * apprend ce qu a rendu un regime calme ou un financement negatif. La
 * question « DOGE paie-t-il comme BTC ? » se repond alors par une mesure, au
 * lieu d etre tranchee par la forme du code.
 * ======================================================================== */
function etatNeuf() {
  return {
    v: 2, depuis: Date.now(), tours: 0, maj: 0,
    tresor: DEPART, depart: DEPART, trades: 0, gains: 0, meilleur: 0,
    positions: [], carnet: [], ombres: [], audit: {}, profils: {},
    compteurs: {}, flux: [], derniereErreur: null,
    /* Le dernier interet ouvert vu par marche : il sert a calculer sa
       VARIATION, qui part au journal. Rien d autre ne le lit. */
    interetVu: {},
    /* Tours consecutifs sans rien prendre : c est lui qui ouvre la soupape. */
    disette: 0,
    /* ---- LE DERNIER PRIX VU, PAR MARCHE ----
     * « On ne voit pas le prix actuel ni combien on gagne. » Une position
     * ouverte n affichait que son entree, son stop et sa cible : trois
     * chiffres figes au moment de l ouverture. Ce qu on vient voir, c est ou
     * en est le prix MAINTENANT et ce que la position vaut a cet instant.
     * Le tour le sait — il vient de lire les marches — mais il ne le gardait
     * nulle part entre deux tours. */
    prixVu: {},
    /* le financement paye ou recu, cumule : c est la ligne qu on regarde
       quand le papier gagne et qu on se demande ce qu il coute vraiment */
    financement: { n: 0, total: 0 },
    seuil: Number(process.env.PERP_SEUIL || 55),
  };
}
let E = null;                     /* UNE colonie, pour tous les marches */
function etat() { return E || (E = etatNeuf()); }

function charge() {
  try {
    const j = JSON.parse(fs.readFileSync(FICHIER(), 'utf8'));
    /* `v` fait foi : un etat de la version par marche ne se recolle pas en
       un seul, et il ne vaut rien — les colonies sont nees le meme jour. */
    if (j && j.v === 2) { E = Object.assign(etatNeuf(), j); return SYMBOLES.slice(); }
  } catch (e) { if (e.code !== 'ENOENT') console.error('[perp] ' + e.message); }
  E = etatNeuf();
  return SYMBOLES.slice();
}
function sauve() {
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    const t = FICHIER() + '.tmp';
    fs.writeFileSync(t, JSON.stringify(etat()));
    fs.renameSync(t, FICHIER());
  } catch (e) { console.error('[perp] sauvegarde : ' + e.message); }
}
function compte(k) { const c = etat().compteurs; c[k] = (c[k] || 0) + 1; }

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
    /* ---- CE QUI EST MESURE MAIS NE DECIDE RIEN ----
     * Meme frontiere que `OBS_VIEUX_PAR_TOUR` dans la colonie de jetons : on
     * rend une chose mesurable AVANT de lui faire prendre une position. Ces
     * trois-la partent dans le journal brut a chaque tour ; aucune n entre
     * dans une note, un veto ou une mise. Le jour ou le journal dira qu une
     * d elles paie, elle deviendra un trait — avec le nombre d observations
     * qui l aura decide, ecrit a cote.
     *
     * `base`  l ecart entre le prix marque et l index. Sur un perpetuel, il
     *         dit si le contrat se paie au-dessus ou en dessous du comptant :
     *         c est la prime que la foule accepte de payer.
     * `volume`  le volume en dollars sur vingt-quatre heures. Un signal lu
     *         sur un marche a l arret ne vaut pas le meme sur un marche
     *         plein.
     * `varInteret`  la variation de l interet ouvert d un tour a l autre.
     *         Des positions qui s ouvrent pendant que le prix monte ne
     *         racontent pas la meme chose que des positions qui se ferment.
     *         Elle vaut `null` au premier tour : on n invente pas une
     *         variation sans point de depart. */
    base: (m.marque !== null && m.index !== null && m.index > 0)
      ? (m.marque - m.index) / m.index * 100 : null,
    volume: m.volume,
    varInteret: null,
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
  /* ---- LE MARCHE LUI-MEME ----
   * C est ce qui justifiait cinq colonies : « la volatilite de DOGE n est pas
   * celle de BTC ». Vrai — et c est une MESURE, pas une raison de decouper le
   * code. En trait, la question se repond : la memoire apprend ce que chaque
   * marche a rendu, comme elle apprend ce qu a rendu un regime calme. Si DOGE
   * ne paie pas, la case le dira, et le Banquier en tiendra compte. */
  marche: (x) => (x.sym ? String(x.sym).replace(/USDT$/, '') : null),
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
  { key: 'banquier', nom: 'Banker', emoji: '🏦', role: 'banque', traits: ['marche'],
    quoi: 'sizes the paper position against the book' },
  { key: 'closer', nom: 'Closer', emoji: '🚪', role: 'execution', traits: [],
    quoi: 'the stop, the target, and the clock' },
];

/* ---- LES VETOS ----
 * Ils rendent une PHRASE, en anglais, et cette phrase devient une ligne
 * d audit. Elle doit donc nommer la regle, pas le chiffre du moment. */
/* ==========================================================================
 * DEUX SORTES DE REFUS, ET C EST CE QUI A BLOQUE LA COLONIE
 *
 * ---- CE QUI EST ARRIVE, 19 septembre 2026, sept tours ----
 *
 * Zero position ouverte, dix ombres en attente, aucun trade. Un tour rejoue
 * a la main contre le vrai marche a donne, sur les CINQ marches a la fois :
 *
 *   LONG   note 36 a 51   « score below the bar »        (la barre est a 55)
 *   SHORT  note 49 a 64   « short against a deep uptrend »
 *
 * Ce n est pas une panne, c est une contradiction de conception. La NOTE est
 * contrariante : le financement, le couloir et la journee — 28 points sur 48
 * — poussent CONTRE le mouvement en cours. Le VETO, lui, suit la tendance :
 * jamais de short contre un fond haussier. Quand le fond monte, le short est
 * le cote que la note aime et que le veto interdit ; le long est le cote que
 * le veto autorise et que la note deteste. L intersection est VIDE, et elle
 * l est exactement dans l etat de marche le plus frequent.
 *
 * Et la consequence est pire que l inaction : `reference()` exige douze
 * observations de la ligne « pris » pour exister. Sans rien de pris, la
 * reference n existe jamais, donc `verdictRegle` ne peut JAMAIS rendre autre
 * chose que « unknown ». L audit est structurellement incapable de conclure.
 * La colonie n apprend pas — elle ne le peut pas.
 *
 * ---- DEJA VU, ET DEJA PAYE ----
 *
 * La colonie de jetons a vecu la meme roue a cliquet le 12 septembre : trois
 * bornes a leur butee, vingt-huit tours sans achat, et un desserrage qui
 * exigeait une reference qu on ne pouvait plus produire. « La boucle ne
 * pouvait que se fermer. » Elle a recu une soupape de famine. Celle-ci en
 * recoit une aussi.
 *
 * ---- LA SEPARATION ----
 *
 * Un refus de SECURITE protege d une position qu on ne saurait pas juger :
 * donnees illisibles, marche mort, tempete. Il ne cede jamais.
 * Un refus d AVIS est une opinion sur la direction. C est lui qui cede quand
 * la colonie est a l arret, parce qu une opinion qu on ne peut pas mesurer
 * n est pas une regle : c est une croyance.
 * ======================================================================== */
/* Le mur de tendance : voir la mesure dans `VETOS.tendance`. 4 % le
   19 septembre (sans mesure), 8 % le 20 (parce que l audit disait qu il
   coutait). */
const FOND_MUR = Math.max(1, Number(process.env.PERP_FOND_MUR || 8));

const VETOS_SECURITE = {
  regime: (x) => {
    if (x.vol15 === null) return 'volatility unreadable: not enough candles yet';
    if (x.vol15 < 0.04) return 'market is dead: nothing moves enough to pay the funding';
    if (x.vol15 > 0.6) return 'storm: a stop would be hit by noise alone';
    return null;
  },
  donnees: (x) => (x.fond === null || x.ecartEma === null) ? 'trend unreadable: not enough candles yet' : null,
};

const VETOS = {
  tendance: (x, sens) => {
    if (x.fond === null) return null;         /* illisible : c est la securite qui le dit */
    /* ---- CE QUE L AUDIT A DIT DE CETTE REGLE ----
     *
     * Seuil pose a 4 % le 19 septembre 2026, sans mesure — c etait la borne
     * haute de la tranche « fond neutre » du trait.
     *
     * Premiere mesure, 20 septembre, 80 ombres jugees :
     *
     *   Trend · short against a deep uptrend   n=13   31 % de gagnantes   moy +0,80 %
     *   pris (la reference)                    n=25    8 % de gagnantes   moy +0,40 %
     *
     * Les shorts REFUSES par cette regle ont gagne quatre fois plus souvent
     * que ce que la colonie prend reellement, et rapporte le double en
     * moyenne. Le verdict du moteur lui-meme, sur son propre minimum de douze
     * observations : « costs ». La regle ne protegeait pas, elle coutait.
     *
     * Elle n est pas supprimee — un fond a +20 % reste un mur — mais son
     * seuil passe a 8 %, ce qui divise sa portee. Elle garde donc sa ligne
     * d audit : si elle coute encore a 8 %, on l elargira encore, avec le
     * chiffre qui l aura decide. C est un AVIS : il cede devant la soupape. */
    if (sens > 0 && x.fond < -FOND_MUR) return 'long against a deep downtrend';
    if (sens < 0 && x.fond > FOND_MUR) return 'short against a deep uptrend';
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
      const c = caseProfil(k, tr[agent][k], HORIZON_REF, true);
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

function caseProfil(trait, valeur, h, lectureSeule) {
  const P = etat().profils;
  if (lectureSeule) return ((P[trait] || {})[valeur] || {})[h] || null;
  const t = P[trait] || (P[trait] = {});
  const v = t[valeur] || (t[valeur] = {});
  return v[h] || (v[h] = { n: 0, s: 0 });
}
/* ---- LA PORTE PAR MARCHÉ : la mémoire prime ----
 * Un marché dont l'espérance apprise (ombres, à l'horizon de référence) est
 * négative sur assez d'observations ne mérite pas qu'on y engage le papier. On
 * refuse — mais en AVIS, pas en sécurité : la soupape peut passer outre pour
 * garder la ligne de référence vivante, et l'ombre continue de mesurer le
 * marché (donc l'espérance se corrige toute seule si le marché redevient bon).
 * Mesuré le 22 septembre 2026, espérance par marché à 240 min : BTC -0,079,
 * ETH -0,01, XRP -0,011, SOL -0,096 (négatifs), DOGE +0,10 — 4 sur 5 saignaient.
 * Rend la phrase du refus, ou null. */
function marcheRefuse(nom) {
  const c = caseProfil('marche', nom, HORIZON_REF, true);
  if (c && c.n >= PROFIL_MIN_OBS && c.s / c.n <= 0) return 'market memory: this market loses on average';
  return null;
}
function noteProfil(traits, h, r) {
  for (const agent in traits) {
    for (const k in traits[agent]) {
      const c = caseProfil(k, traits[agent][k], h, false);
      c.n++; c.s += r;
    }
  }
}
function noteAudit(cle, r) {
  const A = etat().audit;
  const a = A[cle] || (A[cle] = { n: 0, s: 0, gagnantes: 0, perdantes: 0 });
  a.n++; a.s += r;
  if (r >= GAGNE) a.gagnantes++;
  if (r <= PERD) a.perdantes++;
}
/** Ce que la page montre de l audit : par regle, ce que les refuses ont fait. */
function auditDesRefus() {
  const A = etat().audit, out = [];
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
function reference() {
  const a = etat().audit['pris'];
  return (a && a.n >= AUDIT_MIN_OBS) ? { n: a.n, partGagnantes: Math.round(a.gagnantes / a.n * 100) } : null;
}
/** Le verdict d une regle : elle protege, elle coute, ou on ne sait pas encore. */
function verdictRegle(cle) {
  const a = etat().audit[cle];
  const ref = reference();
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
function noteOmbre(x, sens, refus, quiRefuse, traits) {
  const S = etat();
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
  /* Une seule ombre par cle, par sens ET PAR MARCHE : sans le marche, une
     ombre posee sur BTC empecherait la meme regle d en poser une sur DOGE, et
     l audit ne verrait plus qu un marche sur cinq. */
  if (S.ombres.some((o) => o.cle === cle && o.sens === sens && o.sym === x.sym
                           && now - o.t < HORIZON_REF * 60000)) return;
  S.ombres.push({ cle, sens, sym: x.sym, prix0: x.prix, t: now, traits, jalons: {},
                  /* L identifiant de la ligne d observation : c est lui qui
                     relie « ce qu on a vu » a « ce que ca a donne ». Sans ce
                     fil, le journal n est qu une liste de photos. */
                  oid: x.oid || null,
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

/** Chaque ombre se juge au prix de SON marche : `lus` est {symbole: mesures}. */
function regleLesOmbres(lus) {
  const S = etat();
  if (!S.ombres.length) return 0;
  const now = Date.now();
  const dernier = HORIZONS[HORIZONS.length - 1];
  let n = 0;
  S.ombres = S.ombres.filter((o) => {
    const x = lus[o.sym];
    const age = (now - o.t) / 60000;
    /* Le marche n a pas ete lu ce tour : l ombre attend plutot que d etre
       jugee au prix d un autre instrument. */
    if (!x || !(x.prix > 0)) return age <= dernier + Math.max(5, dernier * 0.35);
    const brut = (x.prix - o.prix0) / o.prix0 * 100 * o.sens;
    const r = Math.round((brut + coutFinancement(o.sens, o.fin0, age)) * 1000) / 1000;
    for (const h of HORIZONS) {
      if (o.jalons[h] !== undefined) continue;
      /* Une echeance ratee reste vide : un jalon pris au mauvais moment n est
         pas un jalon. Meme regle que dans l autre colonie. */
      if (!(age >= h && age <= h + Math.max(5, h * 0.35))) continue;
      o.jalons[h] = r;
      noteProfil(o.traits, h, r);
      compte('jalons');
      /* Ce que la situation a REELLEMENT donne, echeance par echeance. C est
         la moitie du journal qui manque a un simple releve de marche. */
      journal.noteResultat({ id: o.oid, t: now, sym: o.sym, sens: o.sens, horizon: h,
                             rendement: r, brut: Math.round(brut * 1000) / 1000,
                             financement: Math.round(coutFinancement(o.sens, o.fin0, age) * 1000) / 1000,
                             cle: o.cle });
      if (h === HORIZON_REF) { noteAudit(o.cle, r); compte('ombresJugees'); n++; }
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
/* ---- LA SOUPAPE DE FAMINE ----
 * Au bout de ce nombre de tours consecutifs sans rien prendre, la colonie
 * prend le meilleur candidat que la SECURITE laisse passer, meme s il est
 * sous la barre ou refuse par un avis de direction. Un tour dure cinq
 * minutes : douze tours font une heure.
 *
 * POSE SANS MESURE le 19 septembre 2026 — la colonie n avait rien pris du
 * tout, il n existait donc aucun echantillon pour le choisir. C est un point
 * de depart, et il est rendu jugeable immediatement.
 *
 * Une prise de soupape reste classee « pris » dans l audit, et c est voulu :
 * la reference est ce qu on prend REELLEMENT, et la soupape est une facon de
 * prendre. Mais chaque trade ferme garde sa marque, et la vue rend les deux
 * groupes cote a cote avec leur effectif (`soupapeBilan`). Dans quinze jours
 * on saura : si la soupape rapporte moins, elle se resserre ; si elle
 * rapporte autant, c est la barre a 55 qui est trop haute. */
const FAMINE_TOURS = Math.max(1, Number(process.env.PERP_FAMINE_TOURS || 12));

/* ---- COMBIEN DE POSITIONS A LA FOIS ----
 *
 * Mesure du 20 septembre 2026, 283 tours : **4 ouvertures** et
 * **211 `dejaEngage`**. Deux cent onze fois, un candidat avait passe la
 * securite, l avis ET la barre — et la colonie n a rien fait, parce qu elle
 * tenait deja une position ailleurs. Une position se tient jusqu a douze
 * heures : sur cinq marches, une seule a la fois laisse passer l essentiel de
 * ce qu on a su reperer.
 *
 * La regle d origine — « deux sens ouverts en meme temps sur le MEME
 * instrument s annulent et paient deux financements » — reste vraie et reste
 * appliquee : un marche a la fois. Elle ne disait rien de deux marches
 * differents, et c est elle qu on avait etendue trop loin.
 *
 * Trois, POSE SANS MESURE : la mise est un dixieme de la tresorerie, donc
 * trois positions font trois dixiemes d exposition. Rendu jugeable
 * immediatement — `plafondPositions` compte les fois ou le plafond mord, et
 * `dejaSurCeMarche` celles ou c est la regle du marche unique. Si le plafond
 * mord souvent sans que le papier souffre, il monte. */
const POSITIONS_MAX = Math.max(1, Number(process.env.PERP_POSITIONS_MAX || 3));

const STOP_VOL = 3.0, CIBLE_VOL = 5.0, TENUE_MAX_MIN = 720;
const LEVIER = 1;                 /* PAPIER, et sans levier : voir l en-tete */

function ouvre(x, sens, an) {
  const S = etat();
  const v = x.vol15 === null ? 0.15 : x.vol15;
  /* Le Banquier : une part fixe du papier, bornee. Rien d appris tant que
     rien n est mesure — et c est dit. */
  const mise = Math.max(1, Math.min(S.tresor * 0.1, S.tresor / 4));
  const p = {
    sym: x.sym, sens, prix0: x.prix, t: Date.now(), mise, levier: LEVIER,
    stop: x.prix * (1 - sens * STOP_VOL * v / 100),
    cible: x.prix * (1 + sens * CIBLE_VOL * v / 100),
    fin0: x.financement, score: an.score, traits: an.traits,
    vol: v, jusqua: Date.now() + TENUE_MAX_MIN * 60000,
  };
  S.positions.push(p);
  S.flux.unshift({ t: Date.now(), sym: x.sym,
                   quoi: (sens > 0 ? 'LONG' : 'SHORT') + ' ' + String(x.sym).replace(/USDT$/, '') + ' at ' + x.prix,
                   score: an.score });
  if (S.flux.length > 60) S.flux.length = 60;
  compte('ouvertures');
  return p;
}

function ferme(p, prix, pourquoi) {
  const S = etat();
  const minutes = (Date.now() - p.t) / 60000;
  const brut = (prix - p.prix0) / p.prix0 * 100 * p.sens;
  const fin = coutFinancement(p.sens, p.fin0, minutes);
  const r = Math.round((brut + fin) * 1000) / 1000;
  const gain = Math.round(p.mise * r / 100 * 100) / 100;
  S.tresor = Math.round((S.tresor + gain) * 100) / 100;
  S.trades++; S.gains += gain;
  if (r > S.meilleur) S.meilleur = r;
  S.financement.n++; S.financement.total += fin;
  S.carnet.unshift({ sym: p.sym, soupape: !!p.soupape,
                     sens: p.sens, prix0: p.prix0, prix, r, brut: Math.round(brut * 1000) / 1000,
                     financement: Math.round(fin * 1000) / 1000, gain, minutes: Math.round(minutes),
                     pourquoi, t: Date.now() });
  if (S.carnet.length > 200) S.carnet.length = 200;
  S.positions = S.positions.filter((q) => q !== p);
  S.flux.unshift({ t: Date.now(), sym: p.sym,
                   quoi: 'CLOSED ' + String(p.sym).replace(/USDT$/, '') + ' ' + r.toFixed(2) + '% · ' + pourquoi });
  if (S.flux.length > 60) S.flux.length = 60;
  compte('fermetures');
  return r;
}

/** Chaque position est surveillee au prix de SON marche. */
function surveille(lus) {
  const S = etat();
  for (const p of S.positions.slice()) {
    const x = lus[p.sym];
    if (!x || !(x.prix > 0)) continue;
    if (p.sens > 0 ? x.prix <= p.stop : x.prix >= p.stop) { ferme(p, p.stop, 'stop'); continue; }
    if (p.sens > 0 ? x.prix >= p.cible : x.prix <= p.cible) { ferme(p, p.cible, 'target'); continue; }
    if (Date.now() >= p.jusqua) ferme(p, x.prix, 'time');
  }
}

// --------------------------------------------------------------- le tour

/**
 * UN tour, TOUS les marches. `opts.marches` ({symbole: marche}) remplace la
 * lecture pour un banc ; `opts.prendre` remplace `fetch` dans les essais.
 */
async function tour(opts) {
  const o = opts || {};
  const S = etat();
  /* ---- LIRE D ABORD, DECIDER ENSUITE ----
   * Les cinq marches sont lus avant qu une seule decision soit prise : la
   * colonie choisit le meilleur parmi ce qu elle a vu, et non le premier qui
   * passe la barre. C est la difference entre un bureau et cinq guichets. */
  const lus = {};
  const symboles = o.marches ? Object.keys(o.marches) : SYMBOLES;
  const rates = [];
  for (const sym of symboles) {
    try {
      const m = o.marches ? o.marches[sym] : await litMarche(sym, o.prendre);
      const x = mesures(m);
      x.sym = sym;
      /* La variation de l interet ouvert depuis le tour precedent. Elle part
         au journal et nulle part ailleurs — voir la note dans `mesures()`. */
      const vu = S.interetVu[sym];
      if (vu && vu > 0 && x.interet !== null) x.varInteret = (x.interet - vu) / vu * 100;
      if (x.interet !== null) S.interetVu[sym] = x.interet;
      if (x.prix > 0) { lus[sym] = x; S.prixVu[sym] = { prix: x.prix, t: Date.now() }; }
    } catch (e) {
      rates.push(sym + ' : ' + String(e.message || e).slice(0, 80));
      compte('lectureRatee');
    }
  }
  if (!Object.keys(lus).length) {
    S.derniereErreur = rates.join(' · ').slice(0, 160) || 'no market could be read';
    return { etat: 'lecture ratee', erreur: S.derniereErreur };
  }
  /* Un marche muet sur cinq n est pas une panne : on le dit sans effacer le
     tour, parce que les quatre autres ont bien ete lus. */
  S.derniereErreur = rates.length ? rates.join(' · ').slice(0, 160) : null;
  S.tours++; S.maj = Date.now();

  regleLesOmbres(lus);
  surveille(lus);

  /* Les deux sens sont examines separement, sur chaque marche : un refus de
     long et un refus de short ne disent pas la meme chose, et chacun merite
     sa ligne d audit. */
  const verdicts = [];
  for (const sym of Object.keys(lus)) {
    const x = lus[sym];
    for (const sens of [1, -1]) {
      /* La securite d abord, et elle ne cede jamais : une position prise sur
         des donnees illisibles ou dans une tempete ne serait pas jugeable. */
      let refus = null, qui = null, securite = false;
      for (const k of Object.keys(VETOS_SECURITE)) {
        const r = VETOS_SECURITE[k](x, sens);
        if (r) { refus = r; qui = k === 'donnees' ? 'tendance' : k; securite = true; break; }
      }
      /* Puis les avis de direction, qui cedent devant la soupape. */
      if (!refus) {
        for (const a of AGENTS) {
          const v = VETOS[a.key];
          if (!v) continue;
          const r = v(x, sens);
          if (r) { refus = r; qui = a.key; break; }
        }
      }
      const an = note(x, sens);
      if (!refus && an.score < S.seuil) { refus = 'score below the bar'; qui = 'tendance'; }
      verdicts.push({ sym, sens, refus, qui, securite, score: an.score, an });
    }
  }
  /* ---- UNE POSITION A LA FOIS, POUR TOUTE LA COLONIE ----
   * La mise est une PART de la tresorerie : deux positions ouvertes en meme
   * temps, c est deux fois l exposition, et rien n a encore mesure que ce
   * soit mieux. La meilleure note l emporte, quel que soit le marche — c est
   * exactement ce que le decoupage en cinq colonies ne savait pas faire. */
  /* ---- LE MEILLEUR PARMI LES MARCHES LIBRES ----
   * Premiere ecriture : on prenait la meilleure note, PUIS on abandonnait si
   * ce marche etait deja tenu. Un candidat excellent sur un marche libre
   * etait donc perdu parce qu un autre, meilleur, se trouvait sur un marche
   * occupe — exactement le defaut qu on venait de corriger, deplace d un
   * cran. On ecarte d abord les marches tenus, on choisit ensuite. */
  /* La porte par marché : un marché à espérance apprise négative est refusé
     (avis), donc écarté du choix — mais son ombre est quand même notée plus
     bas, donc il continue d'apprendre, et la soupape peut passer outre. */
  for (const v of verdicts) {
    if (v.refus) continue;
    const r = marcheRefuse((lus[v.sym] && lus[v.sym].nom) || v.sym);
    if (r) { v.refus = r; v.qui = 'Memory'; }
  }
  const tenus = new Set(S.positions.map((q) => q.sym));
  const passants = verdicts.filter((v) => !v.refus);
  let pris = passants.filter((v) => !tenus.has(v.sym)).sort((a, b) => b.score - a.score)[0];
  /* Un candidat existait, mais seulement la ou l on est deja : ce n est pas
     la meme chose que « rien ne passe », et ca se compte a part. */
  if (!pris && passants.length) compte('dejaSurCeMarche');
  /* ---- LA SOUPAPE ----
   * Rien ne passe depuis trop longtemps : on prend le meilleur candidat que
   * la SECURITE laisse passer. Sans elle, la colonie n a aucun moyen de
   * construire la ligne « pris » qui sert de reference a tout l audit — et
   * sans reference, aucune regle ne peut jamais etre jugee. */
  let parSoupape = false;
  if (!pris) {
    /* La disette compte les tours ou RIEN ne passe. Un tour ou un candidat
       existait — mais sur un marche deja tenu — n est pas une disette : la
       colonie fonctionne, elle est juste occupee. */
    if (!passants.length) S.disette = (S.disette || 0) + 1;
    /* La soupape ne s ouvre que si la colonie est a PLAT. Elle existe pour
       construire la reference quand on ne prend rien ; ajouter de
       l exposition a une colonie deja engagee n est pas son role. */
    if (S.disette >= FAMINE_TOURS && !S.positions.length) {
      const ouvert = verdicts.filter((v) => !v.securite).sort((a, b) => b.score - a.score)[0];
      if (ouvert) { pris = ouvert; parSoupape = true; }
    }
  } else S.disette = 0;

  /* ---- LA LIGNE BRUTE, UNE PAR MARCHE ----
   * Ecrite APRES la decision, pour qu elle la porte, et avant les ombres,
   * pour qu elles reprennent son identifiant. Elle n influence rien : si le
   * journal tombe, le tour se termine pareil. */
  for (const sym of Object.keys(lus)) {
    const x = lus[sym];
    x.oid = journal.idObs(x.t || Date.now(), sym, S.tours);
    const sides = verdicts.filter((v) => v.sym === sym);
    journal.noteObservation({ id: x.oid, t: Date.now(), x, sides,
                              prise: (pris && pris.sym === sym) ? pris.sens : null });
  }

  for (const v of verdicts) {
    if (pris && v === pris) noteOmbre(lus[v.sym], v.sens, null, null, v.an.traits);
    else noteOmbre(lus[v.sym], v.sens, v.refus, v.qui, v.an.traits);
  }
  const plein = S.positions.length >= POSITIONS_MAX;
  if (pris && !plein) {
    const p = ouvre(lus[pris.sym], pris.sens, pris.an);
    p.soupape = parSoupape;
    S.disette = 0;
    if (parSoupape) {
      compte('soupape');
      /* Ecrit dans le journal du panneau : une prise de soupape ne doit pas
         se lire comme une prise ordinaire. */
      S.flux[0].quoi += ' · valve';
    }
  } else if (pris) {
    /* Le plafond mord : un candidat passait, sur un marche libre, et il n y a
       plus de place. C est la seule raison qui reste, et elle se compte a
       part — les melanger cachait laquelle mordait, et c est ce melange qui a
       laisse passer les 211 occasions. */
    compte('plafondPositions');
  }

  sauve();
  return { etat: 'ok', marches: Object.keys(lus), rates,
           verdicts: verdicts.map((v) => ({ sym: v.sym, sens: v.sens, score: v.score, refus: v.refus })),
           ouvert: S.positions.length, tresor: S.tresor };
}

// --------------------------------------------------------------- la vue

/* ---- LA SOUPAPE RAPPORTE-T-ELLE MOINS QUE LA COLONIE ? ----
 * Les deux groupes cote a cote, chacun avec son effectif. Aucun verdict tant
 * que les deux n ont pas atteint le minimum : comparer trois trades a
 * quarante ne dit rien, et l afficher quand meme serait pire que se taire. */
function soupapeBilan() {
  const S = etat();
  const g = { soupape: { n: 0, gagnantes: 0, somme: 0 }, colonie: { n: 0, gagnantes: 0, somme: 0 } };
  for (const c of S.carnet) {
    const d = c.soupape ? g.soupape : g.colonie;
    d.n++; d.somme += c.r; if (c.r > 0) d.gagnantes++;
  }
  const fini = (d) => d.n ? { n: d.n, moyenne: Math.round(d.somme / d.n * 1000) / 1000,
                              partGagnantes: Math.round(d.gagnantes / d.n * 100) } : { n: 0, moyenne: null, partGagnantes: null };
  const a = fini(g.soupape), b = fini(g.colonie);
  return { soupape: a, colonie: b, tours: FAMINE_TOURS,
           comparable: a.n >= AUDIT_MIN_OBS && b.n >= AUDIT_MIN_OBS,
           disette: S.disette || 0, prises: S.compteurs.soupape || 0 };
}

/** Ce que la page lit. Aucune cle, aucun secret : il n y en a pas ici. */
/* ---- CE QUE CHAQUE MARCHE A RENDU ----
 * Le decoupage en cinq colonies donnait cette repartition gratuitement ; une
 * colonie unique doit la RENDRE, sinon on perd la seule chose que le
 * decoupage faisait bien : savoir sur quel marche la colonie gagne. Elle est
 * tiree du carnet — ce qui a ete ferme, pas ce qu on esperait — et chaque
 * ligne porte son effectif, parce qu un marche vu trois fois ne se compare
 * pas a un marche vu cent fois. */
function parMarche() {
  const S = etat();
  const out = {};
  for (const sym of SYMBOLES) out[sym] = { sym, nom: sym.replace(/USDT$/, ''), n: 0, gagnantes: 0, gain: 0, financement: 0 };
  for (const c of S.carnet) {
    const d = out[c.sym] || (out[c.sym] = { sym: c.sym, nom: String(c.sym || '?').replace(/USDT$/, ''),
                                            n: 0, gagnantes: 0, gain: 0, financement: 0 });
    d.n++; if (c.r > 0) d.gagnantes++;
    d.gain += c.gain || 0; d.financement += c.financement || 0;
  }
  /* La case memoire du marche : ce que la colonie a APPRIS de lui, a cote de
     ce qu elle y a gagne. Les deux ne disent pas la meme chose — l une porte
     sur les trades fermes, l autre sur toutes les ombres jugees. */
  return Object.keys(out).map((k) => {
    const d = out[k];
    const c = caseProfil('marche', d.nom, HORIZON_REF, true);
    return Object.assign(d, {
      gain: Math.round(d.gain * 100) / 100,
      financement: Math.round(d.financement * 1000) / 1000,
      partGagnantes: d.n ? Math.round(d.gagnantes / d.n * 100) : null,
      /* `null` tant que la case n a pas ses observations : une esperance sur
         trois ombres est du bruit, et elle se lirait comme un jugement. */
      appris: (c && c.n >= PROFIL_MIN_OBS) ? { n: c.n, moyenne: Math.round(c.s / c.n * 1000) / 1000 } : null,
      obs: (c && c.n) || 0,
    });
  }).sort((a, b) => b.n - a.n || b.obs - a.obs);
}

/** Ce que la page lit. Aucune cle, aucun secret : il n y en a pas ici. */
function vue() {
  const S = etat();
  const f = S.financement;
  const a = auditDesRefus();
  return {
    tours: S.tours, maj: S.maj, depuis: S.depuis, erreur: S.derniereErreur,
    marches: SYMBOLES, tresor: Math.round(S.tresor * 100) / 100, depart: S.depart,
    profit: Math.round((S.tresor - S.depart) * 100) / 100,
    trades: S.trades, meilleur: S.meilleur,
    partGagnantes: S.carnet.length ? Math.round(S.carnet.filter((c) => c.r > 0).length / S.carnet.length * 100) : null,
    /* Ce que le financement a coute en tout : la ligne qu on regarde quand le
       papier a l air bon. */
    financement: { n: f.n, total: Math.round(f.total * 1000) / 1000,
                   moyenne: f.n ? Math.round(f.total / f.n * 1000) / 1000 : null },
    positions: S.positions.map((p) => {
      /* ---- CE QUE LA POSITION VAUT MAINTENANT ----
       * Le meme calcul qu a la fermeture, financement compris : sans lui, le
       * chiffre affiche serait plus flatteur que celui qu on encaissera, et
       * c est exactement le mensonge que cette colonie existe pour eviter.
       * `null` quand le marche n a pas ete lu : on ne devine pas un prix. */
      const vu = S.prixVu[p.sym];
      const prix = (vu && vu.prix > 0) ? vu.prix : null;
      let brut = null, fin = null, net = null, gain = null;
      if (prix !== null) {
        const minutes = (Date.now() - p.t) / 60000;
        brut = Math.round((prix - p.prix0) / p.prix0 * 100 * p.sens * 1000) / 1000;
        fin = Math.round(coutFinancement(p.sens, p.fin0, minutes) * 1000) / 1000;
        net = Math.round((brut + fin) * 1000) / 1000;
        gain = Math.round(p.mise * net / 100 * 100) / 100;
      }
      return { sym: p.sym, nom: String(p.sym || '').replace(/USDT$/, ''),
               sens: p.sens, prix0: p.prix0, prix, prixVu: vu ? vu.t : null,
               stop: p.stop, cible: p.cible, mise: p.mise, levier: p.levier,
               brut, financement: fin, net, gain,
               score: p.score, depuis: p.t };
    }),
    carnet: S.carnet.slice(0, 40),
    parMarche: parMarche(),
    soupape: soupapeBilan(), positionsMax: POSITIONS_MAX, fondMur: FOND_MUR,
    agents: AGENTS.map((x) => ({ key: x.key, nom: x.nom, emoji: x.emoji, role: x.role, quoi: x.quoi, traits: x.traits })),
    audit: a,
    reference: reference(),
    verdicts: a.map((l) => Object.assign({ cle: l.cle }, verdictRegle(l.cle))),
    ombres: { enAttente: S.ombres.length, jugees: S.compteurs.ombresJugees || 0 },
    /* Ce que le journal brut porte : sans ca, on ne sait pas si la question
       « comment gagne-t-on sur la duree » a seulement de quoi etre posee. */
    journal: journal.etat(),
    horizons: HORIZONS, horizonRef: HORIZON_REF, minObs: AUDIT_MIN_OBS, profilMinObs: PROFIL_MIN_OBS,
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
    console.log('[perp] colonie eteinte (PERP_COLONIES=0)');
    return null;
  }
  charge();
  console.log('[perp] colonie PAPIER armee sur ' + SYMBOLES.join(', ') + ' · un tour toutes les '
              + Math.round(CADENCE_MS / 60000) + ' min · aucune cle, aucun ordre');
  const boucle = async () => {
    try { await tour(); } catch (e) { console.error('[perp] ' + (e.message || e)); }
  };
  setTimeout(boucle, 20000);
  minuterie = setInterval(boucle, CADENCE_MS);
  return { arrete() { if (minuterie) clearInterval(minuterie); } };
}

module.exports = {
  SYMBOLES, HORIZONS, HORIZON_REF, AGENTS, TRAITS, VETOS, GAGNE, PERD,
  AUDIT_MIN_OBS, PROFIL_MIN_OBS, PERIODE_FIN_MIN, FAMINE_TOURS, VETOS_SECURITE,
  POSITIONS_MAX, FOND_MUR,
  charge, etat, etatNeuf, vue, tour, demarre, litMarche,
  mesures, traitsDe, note, noteOmbre, regleLesOmbres, noteAudit, auditDesRefus,
  reference, verdictRegle, coutFinancement, ouvre, ferme, surveille,
  parMarche, soupapeBilan, caseProfil, noteProfil, marcheRefuse,
  volatilite, position, ema,
  _pose: (e) => { E = e; },
};
