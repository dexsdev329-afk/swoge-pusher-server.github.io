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
 * 2. LES COUTS SONT COMPTES DES LE PREMIER JOUR : FINANCEMENT ET FRAIS.
 *    Tenir un perpetuel se paie toutes les huit heures. La lecon vient de la
 *    colonie de jetons, mesuree le 18 septembre 2026 : son papier gagnait et
 *    son reel perdait 3,7 % par trade, uniquement par frottement, parce que
 *    le cout n entrait nulle part dans le papier. Ici il entre des le debut :
 *    le rendement d une position papier est net du financement paye ou recu
 *    ET des frais, PAR TYPE D ORDRE depuis le 27 septembre 2026 (`fraisAR()`,
 *    taker 0,06 % a l entree, au stop et a la sortie au temps, maker 0,02 % a
 *    la cible — grille Bitget lue sur `/contracts` le 26/09 : makerFeeRate
 *    0.0002, takerFeeRate 0.0006 pour les 805 contrats).
 *
 *    ---- CE QUE LE « +0,110 % NET MAKER » VALAIT VRAIMENT ----
 *    Ce chiffre a justifie le 4σ/6σ et les frais maker du 23 septembre. Il
 *    venait de `perp_edge.js` : `trend` SEUL (pas la note), une entree a
 *    CHAQUE bougie (n = 13 923, trades qui se chevauchent — n effectif ~500),
 *    financement et carnet mis a null. Refait le 26 septembre 2026 avec la
 *    meme methode : erreur-type 0,074 une fois groupee par jour, t ≈ 1,1 —
 *    JAMAIS significatif. La regle EN SERVICE, rejouee sans chevauchement sur
 *    31 jours (n = 330, une position par marche, deux au plus dans un sens) :
 *    brut +0,030 %, net frais papier −0,008 ± 0,070, net frais reels −0,075.
 *    Aucune geometrie de 2σ/3σ a 8σ/12σ n y est positive aux frais reels. La
 *    geometrie reste donc 4σ/6σ faute de mieux, pas parce qu elle gagne ; tout
 *    changement passe desormais par `outils/perp_rejeu.js` (12–24 mois).
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

/* ---- LES MINIMUMS DE L AUDIT : UN CALCUL DE PUISSANCE, PLUS UN ROND ----
 * `AUDIT_MIN_OBS` valait 12, pose sans calcul. Rapport du 26 septembre 2026
 * (231 ombres jugees a 4 h) : pour que le verdict « coute » (+8 points de
 * gagnantes sur la reference) ait 80 % de chances de se voir a α = 5 %, il
 * faut ~310 ombres PAR COTE ; « protege » (part ≤ 0,6 × reference) en veut
 * ~650 ; une difference de moyennes de 0,113 σ (0,15 % a σ 1,33 %) ~1 230.
 * Douze donnait des verdicts qui ne voulaient rien dire.
 *
 * Les minimums sont CALCULES ici, avec les hypotheses ecrites, et non tapes :
 * la base est la part d ombres qui montent d au moins +1 σ a 4 h, soit
 * 15,9 % pour une loi normale (les rendements sont a queues epaisses, la
 * base mesuree sera un peu plus basse : le calcul reste le bon ordre). */
const Z_ALPHA = 1.959964;        /* bilateral, α = 5 % */
const Z_BETA = 0.841621;         /* puissance 80 % */
function nDeuxParts(p1, p2) {
  const d = p1 - p2;
  return Math.ceil(Math.pow(Z_ALPHA + Z_BETA, 2) * (p1 * (1 - p1) + p2 * (1 - p2)) / (d * d));
}
function nDeuxMoyennes(ecart, sd) {
  return Math.ceil(2 * Math.pow(Z_ALPHA + Z_BETA, 2) * sd * sd / (ecart * ecart));
}
const PART_BASE_SIGMA = 0.159;
/* Controle : la meme formule a la base de l ancien audit (11 % de ≥ +1,5 %)
   rend 309 et 647 — les ~310 et ~650 du rapport. En σ, a 15,9 % : */
const AUDIT_MIN_COUTE = nDeuxParts(PART_BASE_SIGMA, PART_BASE_SIGMA + 0.08);       /* 388 */
const AUDIT_MIN_PROTEGE = nDeuxParts(PART_BASE_SIGMA, PART_BASE_SIGMA * 0.6);      /* 427 */
const AUDIT_MIN_MOYENNE = nDeuxMoyennes(0.113, 1);                                 /* 1 230, en σ */
/* Ces trois minimums SUPPOSENT des ombres indépendantes. Elles ne le sont pas :
   un veto qui refuse BTC, ETH, SOL, XRP et DOGE au même tour pose cinq ombres
   dont les rendements à 4 h ont ρ = 0,76 (rapport du 26/09). Les minimums ne
   sont pas relevés : c'est l'ERREUR-TYPE du verdict qui porte la corrélation,
   groupée par créneau d'ouverture de 4 h, covariance entre la règle et
   « pris » comprise (voir `ecartGroupe`). Simulation sous H0 du 27/09
   (grappes de 5 ombres à ρ 0,76, n 390) : avec l'erreur-type i.i.d., le z nul
   avait un écart-type de 1,40–1,42, et les faux « costs » passaient de 0,10 %
   à 1,9–2,05 %, les faux « protects » de 0,18 % à 2,2–3,0 %. À ces minimums,
   un verdict est donc plus rare que ne le dit le calcul de puissance : c'est
   voulu ; l'effectif réel se lit en créneaux (`groupes`) avec chaque verdict. */
/* Le premier verdict possible : c est le chiffre que la page ecrit sous
   « en dessous, aucune regle n a de verdict ». */
const AUDIT_MIN_OBS = Math.min(AUDIT_MIN_COUTE, AUDIT_MIN_PROTEGE);

/* ---- QUAND UN BILAN DE TRADES DEVIENT JUGEABLE ----
 * Ecart-type d un trade net mesure le 26/09/2026 : 1,44 % (40 trades). Pour
 * detecter +0,30 % par trade (unilateral, α 5 %, puissance 80 %) :
 * ((1,645 + 0,842) × 1,44 / 0,30)² = 143 trades — 8 jours a 17,9 par jour.
 * Sous ce nombre, la page ecrit « not judgeable (n/143) ». */
const SD_TRADE = 1.44;
const TRADES_JUGEABLES = Math.ceil(Math.pow((1.644854 + Z_BETA) * SD_TRADE / 0.30, 2));
/* Comparer DEUX groupes de trades (la soupape contre le reste) demande plus :
   un ecart de 0,30 % entre deux moyennes, bilateral → 362 par groupe. */
const TRADES_COMPARABLES = nDeuxMoyennes(0.30, SD_TRADE);

/** Intervalle de Wilson a 95 % d une part k/n, en fractions. */
function wilson(k, n) {
  if (!n) return null;
  const z = Z_ALPHA, p = k / n, z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const r3 = (v) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 1000) / 1000;
/** Moyenne et erreur-type depuis n, somme et somme des carres. */
function moyenneEt(n, s, q) {
  if (!n) return { n: 0, moyenne: null, se: null };
  const m = s / n;
  const v = n > 1 ? Math.max(0, (q - n * m * m) / (n - 1)) : null;
  return { n, moyenne: m, se: v === null ? null : Math.sqrt(v / n) };
}

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
/* La « génération » du trésor papier : bumper `PERP_GEN` (ex. 1→2) remet le
 * trésor à zéro UNE fois au prochain démarrage — pour repartir propre quand on
 * change la stratégie de sortie. Idempotent, comme la caisse Pancake.
 * Génération 2 le 24 septembre 2026 : l'ancien relevé mélangeait le 3σ/5σ
 * au 4σ/6σ, qu'on croyait net-positif (« +0,110 %/trade maker » — chiffre
 * jamais significatif, voir l'en-tête : t ≈ 1,1 une fois groupé par jour) ;
 * on repart propre pour que la géométrie se juge seule. Papier.
 * Les frais par type d'ordre (27/09/2026) ne remettent PAS le trésor à zéro :
 * les trades d'avant gardent leurs frais maker dans le carnet, et la vue rend
 * à côté leur net aux frais réels (`rReel`), pour que les deux se comparent. */
const GEN = String(process.env.PERP_GEN || '2');

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
    v: 2, gen: GEN, depuis: Date.now(), tours: 0, maj: 0,
    tresor: DEPART, depart: DEPART, trades: 0, gains: 0, meilleur: 0,
    positions: [], carnet: [], ombres: [], audit: {}, profils: {},
    /* Le plus récent créneau de 4 h d'ouverture vu par l'audit : les créneaux
       plus vieux de 3 sont clos et se replient (voir `plieAudit`). */
    auditTemps: { bMax: null },
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
    /* Le bilan de TOUS les trades fermes, jamais tronque (le carnet garde
       200 lignes) : effectif, gagnants, sommes et carres du net tel que
       comptabilise ET du net aux frais reels, par sortie et par jour — de
       quoi rendre n, Wilson et net ± erreur-type groupee par jour. */
    bilan: bilanNeuf(),
    /* La periode de financement de chaque contrat, lue sur `/contracts`
       (`fundInterval`, en heures) : {sym: {min, t}}. */
    periodesFin: {},
  };
}
function bilanNeuf() {
  return { n: 0, gagnants: 0, s: 0, q: 0, sR: 0, qR: 0, parSortie: {}, jours: {}, manquants: 0 };
}
let E = null;                     /* UNE colonie, pour tous les marches */
function etat() { return E || (E = etatNeuf()); }

function charge() {
  try {
    const j = JSON.parse(fs.readFileSync(FICHIER(), 'utf8'));
    /* `v` fait foi : un etat de la version par marche ne se recolle pas en
       un seul, et il ne vaut rien — les colonies sont nees le meme jour. */
    if (j && j.v === 2) {
      /* Génération différente → trésor remis à zéro une fois (comme Pancake). */
      if (String(j.gen || '1') !== GEN) { E = etatNeuf(); sauve(); console.log('[perp] trésor remis à zéro (génération ' + GEN + ')'); return SYMBOLES.slice(); }
      E = Object.assign(etatNeuf(), j);
      /* Un etat d avant le bilan (27/09/2026) : on le reconstruit depuis le
         carnet. S il manque des trades (plus de 200), le bilan le DIT. */
      if (!j.bilan) rebatitBilan(E);
      return SYMBOLES.slice();
    }
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
const nb = (x) => { const v = Number(x); return (x !== null && x !== undefined && x !== '' && isFinite(v)) ? v : null; };
function bougies(l) {
  return (l || []).map((c) => ({ t: nb(c[0]), o: nb(c[1]), h: nb(c[2]), b: nb(c[3]), c: nb(c[4]), v: nb(c[5]) }))
    .filter((c) => c.c !== null);
}

/* ---- LA PERIODE DE FINANCEMENT, CONTRAT PAR CONTRAT (27 septembre 2026) ----
 * `PERIODE_FIN_MIN = 480` etait code en dur. Vrai pour les cinq marches
 * suivis (`fundInterval` = 8 sur `/contracts`, lu le 26/09/2026), FAUX pour
 * 378 des 805 perpetuels USDT de Bitget, qui reglent toutes les 4 h (et un
 * toutes les heures). Elargir la liste des marches aurait donc divise par
 * deux leur cout de financement sans que rien ne le dise. On lit le champ,
 * une fois par jour et par contrat (5 appels par jour), et 480 reste le
 * defaut quand la lecture echoue. */
const PERIODES_TTL = 24 * 3600000;
async function litPeriodes(symboles, prendre) {
  const S = etat();
  for (const sym of symboles) {
    const vu = S.periodesFin[sym];
    if (vu && Date.now() - vu.t < PERIODES_TTL) continue;
    try {
      const c = ((await lit('/contracts', { symbol: sym, productType: PRODUIT }, prendre)) || [])[0] || {};
      const h = nb(c.fundInterval);
      S.periodesFin[sym] = (h > 0 && h <= 24) ? { min: h * 60, t: Date.now() }
                                               : { min: PERIODE_FIN_MIN, t: Date.now(), defaut: true };
    } catch (e) { compte('lecturePeriodeRatee'); }
  }
}
function periodeFin(sym) {
  const v = etat().periodesFin && etat().periodesFin[sym];
  return (v && v.min > 0) ? v.min : PERIODE_FIN_MIN;
}

/* ---- LES BOUGIES D UNE MINUTE, POUR JUGER STOPS ET CIBLES (27/09/2026) ----
 * Le papier ne lisait que le DERNIER prix, toutes les cinq minutes. Rejeu du
 * 26 septembre sur bougies Bitget 1 min des 40 trades visibles : 39 issues
 * sur 40 identiques, mais un « temps −0,46 % » etait un stop touche a 188 min
 * (−1,12 % net), et 9 stops sur 22 avaient ete vus avec 50 a 282 min de
 * retard — le creneau restait occupe pendant ce temps. On lit donc, pour
 * chaque position ouverte, les bougies d une minute depuis le dernier
 * controle : un appel par position, au plus `POSITIONS_MAX` (5) par tour.
 * Une lecture ratee retombe sur le dernier prix, comme avant. */
const FINES_MAX_MIN = 1000;      /* la limite d un appel `/candles` */
async function litFines(positions, prendre) {
  const out = {};
  const now = Date.now();
  for (const p of positions.slice(0, POSITIONS_MAX)) {
    if (out[p.sym]) continue;
    const debut = Math.floor(Math.max(p.vu || p.t, now - FINES_MAX_MIN * 60000) / 60000) * 60000;
    try {
      out[p.sym] = bougies(await lit('/candles', { symbol: p.sym, productType: PRODUIT, granularity: '1m',
                                                   startTime: debut, endTime: now, limit: FINES_MAX_MIN }, prendre));
      compte('lecturesFines');
    } catch (e) { compte('lectureFineRatee'); }
  }
  return out;
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
 * ---- RESOLU LE 22 SEPTEMBRE 2026 : LA NOTE SUIT LA TENDANCE ----
 * La contradiction ci-dessus venait d une note CONTRARIANTE contre un veto qui
 * suit la tendance. `perp_edge.js` a tranche sur de vraies bougies Bitget : la
 * note a contre-mouvement PERD (29,3 % de gagnants sur 10 j, 36,0 % sur 31 j,
 * point mort a 37,5 %), suivre la tendance GAGNE (48,5 % / 41,6 %) sur les cinq
 * marches. Le couloir et la journee suivent donc desormais le mouvement (voir
 * `note()`), la note s aligne sur le veto au lieu de le combattre, et l
 * intersection n est plus vide. Le financement, lui, reste a contre-foule : il
 * n a pas ete mesure (inconnu bougie par bougie dans l historique), donc on n y
 * touche pas — sa propre ligne d audit le jugera.
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

function note(x, sens, muets) {
  let s = 50;
  const dit = [];
  /* `muets` : les agents qu un BANC fait taire (le rejeu, pour mesurer une
     variante). Le service ne le passe jamais : la note en service est
     entiere. `v` garde la contribution exacte (deux decimales) : c est elle
     qui part au journal, agent par agent, pour qu un P/L par agent existe. */
  const ajoute = (k, v, pourquoi) => {
    if (!v || (muets && muets.indexOf(k) >= 0)) return;
    s += v; dit.push({ agent: k, points: Math.round(v), v: Math.round(v * 100) / 100, pourquoi });
  };
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
    /* ---- CONTINUATION, PAS RENVERSEMENT (renversé le 22 septembre 2026) ----
     * Ce spécialiste « achetait bas, vendait haut » : il poussait le long quand
     * le prix était bas dans sa journée. Mesuré faux. `perp_edge.js` rejoue le
     * VRAI scoreur sur de vraies bougies Bitget et simule la sortie du bot
     * (stop 3σ / cible 5σ / 12 h ; point mort d'une marche aléatoire = 37,5 %).
     * La note « à contre-mouvement » PERD — 29,3 % de gagnants sur 10 j,
     * 36,0 % sur 31 j, brut moyen négatif, quasi comme l'inverse de la tendance —
     * alors que SUIVRE la tendance passe le point mort (48,5 % / 41,6 %,
     * +0,20 puis +0,05 %/trade) sur les 5 marchés. Le couloir suit donc le
     * mouvement : le prix haut dans sa journée est un signe de force. Son ombre
     * continue de mesurer ; s'il coûte en range prolongé, la mémoire le dira. */
    const c = (x.couloir - 0.5) * 2;
    ajoute('couloir', c * sens * POIDS.couloir, 'day range at ' + Math.round(x.couloir * 100) + '%');
  }
  if (x.carnet !== null) ajoute('carnet', x.carnet * sens * POIDS.carnet, 'book imbalance ' + Math.round(x.carnet * 100) + '%');
  if (x.var24 !== null) {
    /* Continuation aussi : suivre le mouvement des 24 h, pas le contrer — même
       mesure que le couloir ci-dessus (perp_edge.js, 22 septembre 2026 : trend
       au-dessus du point mort, contre-mouvement dessous, sur 10 et 31 jours). */
    const j = Math.max(-1, Math.min(1, x.var24 / 3));
    ajoute('journee', j * sens * POIDS.journee * 0.5, 'day ' + x.var24.toFixed(2) + '%');
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
/* ---- LA PORTE PAR MARCHÉ : la mémoire prime — ÉTEINTE PAR DÉFAUT ----
 * Un marché dont l'espérance apprise (ombres, à l'horizon de référence) est
 * négative ne mérite pas qu'on y engage le papier. Posée le 22 septembre 2026
 * sur BTC -0,079, ETH -0,01, XRP -0,011, SOL -0,096, DOGE +0,10 (240 min).
 *
 * ---- CE QU'ELLE A FAIT EN VRAI : RIEN (mesuré le 26 septembre 2026) ----
 * Elle cherchait la case `'BTCUSDT'` (`lus[sym].nom || sym` : `mesures()` ne
 * rend pas de `nom`), alors que le trait `marche` range sous `'BTC'`. Code
 * mort : BTC avait −0,062 sur n = 47 et un LONG BTC a été ouvert à 20:57.
 * Réactivée telle quelle, elle aurait refusé BTC sur du BRUIT : −0,062 avec
 * une erreur-type d'environ 0,12.
 *
 * Corrigée le 27 septembre 2026, derrière un interrupteur qui reste ÉTEINT
 * (`PERP_PORTE_MEMOIRE=1` pour l'allumer, décision du propriétaire) :
 *   - la clé est celle du trait (`TRAITS.marche(x)`, donc `'BTC'`) ;
 *   - on ne refuse que si moyenne + 2 erreurs-types < 0 : une espérance
 *     négative AU-DELÀ du bruit, pas une moyenne qui penche. Il faut
 *     ~1 200 observations par marché pour voir −0,1 % : elle refusera
 *     rarement, et c'est voulu ;
 *   - l'erreur-type vient de la somme des carrés, gardée depuis ce jour
 *     (`nq`, `sq`, `q`) : les observations d'avant n'ont pas de carré et ne
 *     comptent pas pour la porte.
 * Éteinte, elle se MESURE quand même : `memoireAuraitRefuse` compte les
 * candidats qu'elle aurait écartés. Rend la phrase du refus, ou null. */
const PORTE_MEMOIRE = String(process.env.PERP_PORTE_MEMOIRE || '0') === '1';
function marcheRefuse(nom) {
  const c = caseProfil('marche', nom, HORIZON_REF, true);
  if (!c || !(c.nq >= PROFIL_MIN_OBS)) return null;
  const d = moyenneEt(c.nq, c.sq, c.q);
  if (d.se === null || !(d.moyenne + 2 * d.se < 0)) return null;
  return 'market memory: this market loses beyond noise';
}
function noteProfil(traits, h, r) {
  for (const agent in traits) {
    for (const k in traits[agent]) {
      const c = caseProfil(k, traits[agent][k], h, false);
      c.n++; c.s += r;
      /* Les carrés, pour l'erreur-type : comptés À PART, depuis le jour où ils
         existent, pour ne jamais mélanger une somme complète et une somme de
         carrés partielle. */
      c.nq = (c.nq || 0) + 1; c.sq = (c.sq || 0) + r; c.q = (c.q || 0) + r * r;
    }
  }
}

/* ==========================================================================
 * L'AUDIT, REFAIT LE 27 SEPTEMBRE 2026
 *
 * Ce que le rapport du 26 septembre a mesuré sur l'ancien (231 ombres à 4 h) :
 *   1. la part « ≥ +1,5 % à 4 h » mesure surtout le MÉLANGE DE MARCHÉS :
 *      P(|r 4 h| ≥ 1,5 %) vaut 5,4 % sur BTC et 31,7 % sur DOGE (10 jours).
 *      Une règle qui écarte surtout du DOGE paraissait « coûteuse » par
 *      construction ;
 *   2. `minObs` = 12 contre ~310 ombres par côté pour son propre seuil de
 *      verdict (+8 points) ;
 *   3. la référence était jugée à 4 h fixes, alors que les trades sortent au
 *      stop, à la cible ou à 12 h : l'audit ne mesurait pas ce que les trades
 *      rapportent ;
 *   4. « score below the bar » était attribué à Trend, alors que c'est la
 *      NOTE ENTIÈRE qui est sous la barre, tous agents compris.
 *
 * D'où :
 *   1. chaque ombre porte le σ à 4 h de SON marché au moment de la décision
 *      (vol 15 min × √16) ; l'audit garde le rendement en unités de σ
 *      (`z`), sa moyenne ± erreur-type, et la part z ≥ +1 avec son
 *      intervalle de Wilson. Le rendement en % reste à côté ;
 *   2. les minimums viennent du calcul de puissance plus haut ;
 *   3. l'issue RÉELLE des trades (stop, cible, temps, frais réels) est une
 *      ligne À PART (`bilan`), jamais mélangée à la référence à 4 h ;
 *   4. le refus « score below the bar » est rangé sous « Score ».
 * Ce qui NE bouge PAS : `PROFIL_MIN_OBS` (8) et le jalon de 240 min.
 * Les anciennes lignes gardent leurs chiffres en % ; leur partie en σ part
 * de zéro, et la page le dit par son effectif.
 * ======================================================================== */
const GAGNE_SIGMA = 1;           /* une montée d'au moins 1 σ à 4 h dans le sens pris */
function noteAudit(cle, r, z, t0) {
  const A = etat().audit;
  const a = A[cle] || (A[cle] = { n: 0, s: 0, gagnantes: 0, perdantes: 0 });
  a.n++; a.s += r;
  a.q = (a.q || 0) + r * r;
  if (r >= GAGNE) a.gagnantes++;
  if (r <= PERD) a.perdantes++;
  if (z !== null && z !== undefined && isFinite(z)) {
    a.nz = (a.nz || 0) + 1; a.sz = (a.sz || 0) + z; a.qz = (a.qz || 0) + z * z;
    if (z >= GAGNE_SIGMA) a.gz = (a.gz || 0) + 1;
    if (z <= -GAGNE_SIGMA) a.pz = (a.pz || 0) + 1;
    /* La même ombre, rangée dans le créneau de 4 h où elle a été OUVERTE :
       c'est le groupe de l'erreur-type du verdict. Sans heure d'ouverture,
       elle n'entre pas dans les groupes, et le verdict ne la compte pas. */
    if (t0 !== undefined && t0 !== null && isFinite(t0)) groupeAudit(a, Math.floor(t0 / CRENEAU_AUDIT_MS), z >= GAGNE_SIGMA ? 1 : 0, z);
  }
}

/* ---- L'ERREUR-TYPE GROUPÉE PAR CRÉNEAU D'OUVERTURE ----
 * Une ombre est ouverte à t0 et jugée à t0 + 240…324 min (le jalon de 4 h et
 * sa tolérance de 35 %), donc au plus deux créneaux de 4 h après le sien.
 * Chaque ligne garde ses créneaux OUVERTS (n, montées ≥ +1 σ, somme des z) et
 * replie les créneaux clos — plus vieux de 3 que le plus récent vu — dans des
 * sommes : nombre de créneaux k, Σn², ΣG², ΣG·n, ΣS², ΣS·n, et, contre
 * « pris », les produits croisés du même créneau. Rien ne grossit avec le
 * temps, et l'erreur-type est exacte (même formule que `seGroupe`). */
const CRENEAU_AUDIT_MS = HORIZON_REF * 60000;
function groupesNeufs() {
  return { k: 0, n: 0, g: 0, s: 0, nn: 0, gg: 0, gn: 0, ss: 0, sn: 0, ouverts: {},
           /* avec « pris », créneau par créneau (reste vide pour « pris ») */
           x: { k: 0, nn: 0, gg: 0, gn: 0, ng: 0, ss: 0, sn: 0, ns: 0 } };
}
function groupeAudit(a, b, g, z) {
  const G = a.grp || (a.grp = groupesNeufs());
  const o = G.ouverts[b] || (G.ouverts[b] = { n: 0, g: 0, s: 0 });
  o.n++; o.g += g; o.s += z;
  G.n++; G.g += g; G.s += z;
  const T = etat().auditTemps || (etat().auditTemps = { bMax: null });
  if (T.bMax === null || b > T.bMax) { T.bMax = b; plieAudit(b - 3); }
}
/** Replie tous les créneaux ≤ limite : les règles d'abord, « pris » ensuite,
 *  pour que le créneau de « pris » soit encore là quand une règle s'y croise. */
function plieAudit(limite) {
  const A = etat().audit, R = A['pris'] && A['pris'].grp;
  const cles = Object.keys(A).filter((c) => c !== 'pris' && A[c].grp);
  if (R) cles.push('pris');
  for (const c of cles) {
    const G = A[c].grp;
    for (const bs of Object.keys(G.ouverts)) {
      if (Number(bs) > limite) continue;
      const o = G.ouverts[bs];
      G.k++; G.nn += o.n * o.n; G.gg += o.g * o.g; G.gn += o.g * o.n; G.ss += o.s * o.s; G.sn += o.s * o.n;
      const r = c !== 'pris' && R ? R.ouverts[bs] : null;
      if (r) {
        const X = G.x;
        X.k++; X.nn += o.n * r.n; X.gg += o.g * r.g; X.gn += o.g * r.n; X.ng += o.n * r.g;
        X.ss += o.s * r.s; X.sn += o.s * r.n; X.ns += o.n * r.s;
      }
      delete G.ouverts[bs];
    }
  }
}
/** Les sommes d'une ligne, créneaux clos ET ouverts (sans rien replier). */
function sommesGroupes(G) {
  const t = { k: G.k, n: G.n, g: G.g, s: G.s, nn: G.nn, gg: G.gg, gn: G.gn, ss: G.ss, sn: G.sn };
  for (const bs in G.ouverts) { const o = G.ouverts[bs]; t.k++; t.nn += o.n * o.n; t.gg += o.g * o.g; t.gn += o.g * o.n; t.ss += o.s * o.s; t.sn += o.s * o.n; }
  return t;
}
function croiseGroupes(G, R) {
  const X = G.x, t = { nn: X.nn, gg: X.gg, gn: X.gn, ng: X.ng, ss: X.ss, sn: X.sn, ns: X.ns };
  for (const bs in G.ouverts) {
    const o = G.ouverts[bs], r = R.ouverts[bs];
    if (!r) continue;
    t.nn += o.n * r.n; t.gg += o.g * r.g; t.gn += o.g * r.n; t.ng += o.n * r.g; t.ss += o.s * r.s; t.sn += o.s * r.n; t.ns += o.n * r.s;
  }
  return t;
}
/**
 * La différence règle − « pris », en parts (≥ +1 σ) et en moyennes (σ), avec
 * son erreur-type groupée par créneau : Var(a) + Var(r) − 2·Cov(a, r), chaque
 * terme valant k/(k−1) · Σ_créneaux (S_g − m·n_g)(…) / (n·n'). Null si l'une
 * des lignes a moins de deux créneaux.
 */
function ecartGroupe(a, ref) {
  if (!a.grp || !ref.grp) return null;
  const A = sommesGroupes(a.grp), R = sommesGroupes(ref.grp), X = croiseGroupes(a.grp, ref.grp);
  if (A.k < 2 || R.k < 2 || !A.n || !R.n) return null;
  const cA = A.k / (A.k - 1), cR = R.k / (R.k - 1), cX = Math.sqrt(cA * cR);
  const va = (m, SS, Sn, nn, n) => Math.max(0, SS - 2 * m * Sn + m * m * nn) / (n * n);
  const pa = A.g / A.n, pr = R.g / R.n, ma = A.s / A.n, mr = R.s / R.n;
  const vP = cA * va(pa, A.gg, A.gn, A.nn, A.n) + cR * va(pr, R.gg, R.gn, R.nn, R.n)
           - 2 * cX * (X.gg - pr * X.gn - pa * X.ng + pa * pr * X.nn) / (A.n * R.n);
  const vM = cA * va(ma, A.ss, A.sn, A.nn, A.n) + cR * va(mr, R.ss, R.sn, R.nn, R.n)
           - 2 * cX * (X.ss - mr * X.sn - ma * X.ns + ma * mr * X.nn) / (A.n * R.n);
  return { n: A.n, nRef: R.n, groupes: A.k, groupesRef: R.k, pa, pr, ma, mr,
           seParts: Math.sqrt(Math.max(0, vP)), seMoyennes: Math.sqrt(Math.max(0, vM)) };
}
/** La partie en unités de σ d'une ligne : n, moyenne ± se, part z ≥ +1 (Wilson). */
function ligneSigma(a) {
  const nz = a.nz || 0;
  const d = moyenneEt(nz, a.sz || 0, a.qz || 0);
  const w = wilson(a.gz || 0, nz);
  return { n: nz, moyenne: r3(d.moyenne), se: r3(d.se),
           part: nz ? Math.round((a.gz || 0) / nz * 1000) / 10 : null,
           wilson: w ? [Math.round(w[0] * 1000) / 10, Math.round(w[1] * 1000) / 10] : null };
}
/** Ce que la page montre de l audit : par regle, ce que les refuses ont fait. */
function auditDesRefus() {
  const A = etat().audit, out = [];
  for (const cle in A) {
    const a = A[cle];
    if (a.n < 3) continue;
    const d = a.q !== undefined ? moyenneEt(a.n, a.s, a.q) : { se: null };
    out.push({ cle, n: a.n, moyenne: Math.round(a.s / a.n * 1000) / 1000, se: r3(d.se),
               gagnantes: a.gagnantes, perdantes: a.perdantes,
               partGagnantes: Math.round(a.gagnantes / a.n * 100),
               sigma: ligneSigma(a) });
  }
  out.sort((x, y) => y.n - x.n);
  return out.slice(0, 25);
}
/** La reference : ce qu on PREND. Une regle se juge contre elle, pas contre un rond. */
function reference() {
  const a = etat().audit['pris'];
  if (!a || a.n < 3) return null;
  const sg = ligneSigma(a);
  return { n: a.n, partGagnantes: Math.round(a.gagnantes / a.n * 100), sigma: sg,
           /* comparable seulement quand la partie en σ a son premier minimum */
           suffisante: sg.n >= AUDIT_MIN_OBS };
}
/**
 * Le verdict d une regle : elle protege, elle coute, ou on ne sait pas encore.
 * Tout se lit en unités de σ, contre la ligne « pris » :
 *   « costs »    n ≥ AUDIT_MIN_COUTE des deux côtés, part ≥ référence + 8 points
 *                ET écart de parts significatif (z ≥ 1,96) ;
 *   « protects » n ≥ AUDIT_MIN_PROTEGE des deux côtés, part ≤ 0,6 × référence
 *                ET z ≤ −1,96 ;
 *   « same »     n ≥ AUDIT_MIN_MOYENNE des deux côtés et des moyennes en σ à
 *                moins de 2 erreurs-types l'une de l'autre ;
 *   sinon « unknown », avec ce qu'il manque pour le premier verdict possible.
 */
function verdictRegle(cle) {
  const a = etat().audit[cle];
  const ref = etat().audit['pris'];
  const sa = a ? ligneSigma(a) : { n: 0 };
  if (!a || sa.n < AUDIT_MIN_OBS) {
    return { verdict: 'unknown', n: sa.n, manque: AUDIT_MIN_OBS - sa.n, minObs: AUDIT_MIN_OBS };
  }
  const sr = ref ? ligneSigma(ref) : { n: 0 };
  if (sr.n < AUDIT_MIN_OBS) return { verdict: 'unknown', n: sa.n, part: sa.part, pourquoi: 'the reference has too few observations yet', manqueReference: AUDIT_MIN_OBS - sr.n };
  /* ---- ERREUR-TYPE GROUPÉE PAR CRÉNEAU D'OUVERTURE (27/09/2026) ----
     Elle était binomiale i.i.d. (parts) et `moyenneEt` i.i.d. (moyennes) :
     cinq ombres d'un même tour sur cinq marchés à ρ 0,76 comptaient pour
     cinq. Le verdict se lit maintenant sur les ombres rangées par créneau
     (toutes : l'audit en σ est né avec), contre « pris », covariance du même
     créneau comprise. */
  const E = ecartGroupe(a, ref);
  if (!E) return { verdict: 'unknown', n: sa.n, part: sa.part, pourquoi: 'fewer than two 4-hour windows yet' };
  const pa = E.pa, pr = E.pr;
  const zP = E.seParts > 0 ? (pa - pr) / E.seParts : 0;
  const base = { n: E.n, part: sa.part, reference: sr.part, zParts: Math.round(zP * 100) / 100,
                 seParts: r3(E.seParts), groupes: E.groupes, groupesReference: E.groupesRef };
  const nMin = Math.min(E.n, E.nRef);
  if (nMin >= AUDIT_MIN_COUTE && pa >= pr + 0.08 && zP >= Z_ALPHA) return Object.assign({ verdict: 'costs' }, base);
  if (nMin >= AUDIT_MIN_PROTEGE && pa <= pr * 0.6 && zP <= -Z_ALPHA) return Object.assign({ verdict: 'protects' }, base);
  if (nMin >= AUDIT_MIN_MOYENNE) {
    const ecart = E.ma - E.mr, se = E.seMoyennes;
    if (Math.abs(ecart) <= 2 * se) return Object.assign({ verdict: 'same', ecartSigma: r3(ecart), se: r3(se) }, base);
  }
  return Object.assign({ verdict: 'unknown', pourquoi: 'no difference large enough to call yet',
                         manque: Math.max(0, AUDIT_MIN_MOYENNE - nMin) }, base);
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
  /* « score below the bar » n'est le refus d'aucun agent : c'est la NOTE
     ENTIÈRE, tous agents compris, qui reste sous la barre. Rangé sous Trend
     jusqu'au 27 septembre 2026 — l'audit accusait un agent d'un refus
     collectif. La ligne repart donc d'un échantillon vide, sous son vrai nom. */
  if (k === 'score') return 'Score';
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
  /* Le σ à 4 h de CE marché, maintenant : c'est l'unité dans laquelle l'audit
     juge l'ombre, pour qu'un refus sur DOGE ne pèse pas six fois un refus
     sur BTC. `null` si la volatilité n'est pas lisible : on ne l'invente pas. */
  const sig = (x.vol15 > 0) ? x.vol15 * Math.sqrt(HORIZON_REF / 15) : null;
  S.ombres.push({ cle, sens, sym: x.sym, prix0: x.prix, t: now, traits, jalons: {}, sig,
                  pf: x.periodeFin || periodeFin(x.sym),
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
const PERIODE_FIN_MIN = 480;     /* le défaut ; la vraie période vient de `periodeFin(sym)` */
function coutFinancement(sens, taux, minutes, periode) {
  if (taux === null || taux === undefined || !isFinite(taux)) return 0;
  const periodes = minutes / (periode > 0 ? periode : PERIODE_FIN_MIN);
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
    const fc = coutFinancement(o.sens, o.fin0, age, o.pf);
    const r = Math.round((brut + fc) * 1000) / 1000;
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
                             financement: Math.round(fc * 1000) / 1000,
                             cle: o.cle, z: o.sig ? Math.round(r / o.sig * 1000) / 1000 : null });
      if (h === HORIZON_REF) { noteAudit(o.cle, r, o.sig ? r / o.sig : null, o.t); compte('ombresJugees'); n++; }
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
 * Trois etait POSE SANS MESURE : la mise est un dixieme de la tresorerie, donc
 * trois positions font trois dixiemes d exposition. Rendu jugeable
 * immediatement — `plafondPositions` compte les fois ou le plafond mord, et
 * `dejaSurCeMarche` celles ou c est la regle du marche unique.
 *
 * ---- PORTE A CINQ LE 22 SEPTEMBRE 2026 : UNE PAR MARCHE ----
 * Il y a CINQ marches (BTC, ETH, SOL, XRP, DOGE) et la regle « un marche a la
 * fois » interdit deja d en tenir deux sur le meme : cinq est donc la borne
 * PRINCIPIELLE (une position par marche), pas un chiffre choisi. A trois, le
 * plafond etait le seul frein qui empechait de couvrir les cinq marches ; a
 * cinq c est la regle du marche unique qui borne, et `plafondPositions` ne
 * mordra plus que si un marche portait deux candidats — ce qu on interdit par
 * ailleurs. Ce qui a change le calcul : le sens de l entree est desormais
 * MESURE positif (note 43,1 % de gagnants, +0,070 %/trade sur 31 jours de
 * bougies Bitget, cf. `perp_edge.js`), donc couvrir plus de marches expose a
 * un edge positif au lieu de multiplier une perte. Exposition max = 5 x 10 % =
 * 50 % du capital partage ; reglable par `PERP_POSITIONS_MAX`. Le compteur
 * reste : si couvrir les cinq fait souffrir le papier, on redescend, avec le
 * chiffre qui l aura decide.
 * Relu le 26 septembre 2026 : ce « +0,070 % » comptait des entrees qui se
 * chevauchent. Sans chevauchement (31 jours, n = 330), la note fait +0,030 %
 * brut et −0,075 ± 0,068 net aux frais reels : l avantage n est pas mesure. */
const POSITIONS_MAX = Math.max(1, Number(process.env.PERP_POSITIONS_MAX || 5));

/* ---- AU PLUS DEUX POSITIONS DANS LE MEME SENS (26 septembre 2026) ----
 * Releve du 26 septembre, 12:21 UTC, depuis le 24 a 06:40 : 38 trades,
 * 26 % de gagnants, tresor papier 1 000 → 983,65. Sorties : 23 stops a
 * -1,45 % en moyenne, 9 cibles a +2,04 %, 6 fins de tenue a ~0. Le point
 * mort a ces ecarts est 41 % de gagnants. Et les stops tombent ENSEMBLE :
 * le 25 a 14:06, XRP et DOGE longs stoppes la meme minute ; a 12:16, BTC et
 * SOL longs aussi. Cinq cryptos qui bougent ensemble, prises dans le meme
 * sens, c'est UN pari pose cinq fois, pas cinq paris.
 * Le proprietaire a choisi de l'essayer comme une regle MESURABLE : au-dela
 * de MEME_SENS_MAX positions dans un sens, le candidat de ce sens est refuse
 * sous sa propre cle d'audit (« Exposure · too many positions the same
 * way »), donc son ombre est jugee a 4 h contre « pris », comme toute autre
 * regle. Verdict a relire apres 100 trades : si ce qu'elle refuse monte
 * autant que ce qu'on prend, elle ne sert a rien et on l'enleve.
 * `PERP_MEME_SENS_MAX` la regle ; 5 la rend inoperante. */
const MEME_SENS_MAX = Math.max(1, Number(process.env.PERP_MEME_SENS_MAX || 2));

/* ---- LA GEOMETRIE DE SORTIE : stop et cible, en ecarts-types de volatilite ----
 * Le stop est passe de 3σ a 4σ le 22 septembre 2026 ; la cible de 5σ a 6σ le
 * 23 septembre, sur `perp_edge.js` (`trend` seul, n = 13 923 entrees qui se
 * chevauchent) :
 *   stop 4σ / cible 5σ   +0,126 % brut   +0,086 % net maker   +0,006 % net taker
 *   stop 4σ / cible 6σ   +0,150 % brut   +0,110 % net maker   +0,030 % net taker
 * ---- RELU LE 26 SEPTEMBRE 2026 : AUCUN DE CES CHIFFRES N ETAIT UN AVANTAGE ----
 * Groupe par jour, l erreur-type du « +0,110 » vaut 0,074 (t ≈ 1,1). La regle
 * EN SERVICE (note entiere, vetos, creneaux), rejouee sans chevauchement sur
 * 31 jours de bougies Bitget, n = 330 : brut +0,030 %, net frais reels
 * −0,075 ± 0,068. Balayage 2σ/3σ, 3σ/5σ, 4σ/6σ, 4σ/8σ, 6σ/9σ, 8σ/12σ : brut
 * entre +0,005 et +0,071, AUCUN net positif aux frais reels. La geometrie
 * n est pas le levier ; 4σ/6σ reste parce qu aucune autre ne fait mieux. Tout
 * changement passe par `outils/perp_rejeu.js` (porte obligatoire).
 *
 * ---- LE REJEU LONG, 27 SEPTEMBRE 2026 (24 mois, 5 marches, 72 580 bougies
 * 15 min chacun, aucune manquante ; frais reels ; garde = 3 derniers mois) ----
 *                     ancien (reglage)                    garde (jugement)
 *   service 4σ/6σ    n=7 200  −0,083 ± 0,021 [−0,124 ; −0,043]   n=1 052  −0,069 ± 0,038
 *   3σ/5σ            n=9 567  −0,081 ± 0,015                     n=1 447  −0,055 ± 0,030
 *   4σ/8σ            n=6 251  −0,073 ± 0,024                     n=899    −0,046 ± 0,046
 *   6σ/9σ            n=4 989  −0,065 ± 0,030                     n=736    −0,002 ± 0,061
 *   Funding muet     n=6 941  −0,068 ± 0,022                     n=1 000  −0,026 ± 0,044
 * (net par trade aux frais reels, %, erreur-type groupee par jour.) Brut entre
 * +0,020 et +0,105 partout : la note n a pas d avantage de direction qui
 * paie ~0,10 % de frais. 6σ/9σ, choisie sur l ancien, ne conclut pas sur la
 * garde (borne basse −0,122) : 5 variantes essayees, AUCUN changement. Sur
 * 24 mois la regle en service PERD, et la borne haute de l ancien (−0,043)
 * le dit au-dela du bruit. Garde de 6 mois : n=2 153, −0,095 ± 0,028. */
const STOP_VOL = Math.max(0.5, Number(process.env.PERP_STOP_VOL || 4.0));
const CIBLE_VOL = Math.max(0.5, Number(process.env.PERP_CIBLE_VOL || 6.0));
const TENUE_MAX_MIN = 720;
const LEVIER = 1;                 /* PAPIER, et sans levier : voir l en-tete */

/* ---- LES FRAIS, PAR TYPE D ORDRE (27 septembre 2026) ----
 * Le papier comptait 0,04 % aller-retour, soit MAKER des deux cotes. Or
 * l entree se fait au dernier prix (ordre au marche : taker), le stop est un
 * stop-market (taker), la sortie au temps est au marche (taker) ; seule la
 * cible peut etre un ordre limite pose (maker). Grille Bitget USDT-M VIP 0,
 * lue sur `/contracts` le 26/09/2026 pour les 805 contrats : maker 0,02 %,
 * taker 0,06 % par cote. Aller-retour reel : 0,12 % au stop et au temps,
 * 0,08 % a la cible. Recalcule sur les 40 trades visibles du 26/09 :
 * −0,377 → −0,449 % par trade. Le tresor affiche baisse d autant : c est le
 * papier qui cesse d etre optimiste, pas la colonie qui empire.
 *
 * `PERP_FRAIS` garde son sens : un aller-retour FORFAITAIRE applique a tous
 * les trades. Pose, il prime (c est le reglage d avant) ; absent, les frais
 * suivent le type d ordre (`PERP_FRAIS_TAKER`, `PERP_FRAIS_MAKER`, par cote). */
const FRAIS_TAKER = Math.max(0, Number(process.env.PERP_FRAIS_TAKER || 0.06));
const FRAIS_MAKER = Math.max(0, Number(process.env.PERP_FRAIS_MAKER || 0.02));
const FRAIS_FORFAIT = (process.env.PERP_FRAIS !== undefined && String(process.env.PERP_FRAIS).trim() !== '')
  ? Math.max(0, Number(process.env.PERP_FRAIS)) : null;
/** Les frais REELS d un aller-retour selon la sortie : ce qu un compte paierait. */
function fraisReels(pourquoi) { return FRAIS_TAKER + (pourquoi === 'target' ? FRAIS_MAKER : FRAIS_TAKER); }
/** Les frais que le papier preleve : le forfait s il est pose, sinon les reels. */
function fraisAR(pourquoi) { return FRAIS_FORFAIT !== null ? FRAIS_FORFAIT : fraisReels(pourquoi); }
/* L ancien nom, garde pour qui le lit : l aller-retour d une sortie au marche. */
const FRAIS_AR = fraisAR('stop');

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
    fin0: x.financement, pf: x.periodeFin || periodeFin(x.sym), score: an.score, traits: an.traits,
    /* le detail de la note a l entree : sans lui, aucun P/L par agent */
    dit: (an.dit || []).map((d) => [d.agent, d.v !== undefined ? d.v : d.points]),
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

/** Ajoute un trade ferme au bilan : tout, sans jamais tronquer. */
function ajouteBilan(B, c) {
  const r = c.r, rR = c.rReel !== undefined ? c.rReel : c.r;
  B.n++; if (r > 0) B.gagnants++;
  B.s += r; B.q += r * r; B.sR += rR; B.qR += rR * rR;
  const k = c.pourquoi || '?';
  const o = B.parSortie[k] || (B.parSortie[k] = { n: 0, s: 0, sR: 0 });
  o.n++; o.s += r; o.sR += rR;
  const j = new Date(c.t || Date.now()).toISOString().slice(0, 10);
  const d = B.jours[j] || (B.jours[j] = { n: 0, s: 0, sR: 0 });
  d.n++; d.s += r; d.sR += rR;
}
/** Le net aux frais reels d une ligne de carnet, meme ancienne (frais maker). */
function rReelDe(c) {
  if (typeof c.rReel === 'number') return c.rReel;
  if (typeof c.brut !== 'number') return c.r;
  return Math.round((c.brut + (c.financement || 0) - fraisReels(c.pourquoi)) * 1000) / 1000;
}
function rebatitBilan(S) {
  S.bilan = bilanNeuf();
  for (const c of S.carnet.slice().reverse()) ajouteBilan(S.bilan, Object.assign({}, c, { rReel: rReelDe(c) }));
  S.bilan.manquants = Math.max(0, (S.trades || 0) - S.carnet.length);
}

function ferme(p, prix, pourquoi, quand) {
  const S = etat();
  const tFin = quand || Date.now();
  const minutes = (tFin - p.t) / 60000;
  const brut = (prix - p.prix0) / p.prix0 * 100 * p.sens;
  const fin = coutFinancement(p.sens, p.fin0, minutes, p.pf);
  /* Le rendement papier est NET : mouvement du prix, moins le financement paye,
     moins les frais de CET aller-retour. C est ce que le reel encaisserait. */
  const frais = fraisAR(pourquoi);
  const r = Math.round((brut + fin - frais) * 1000) / 1000;
  const rReel = Math.round((brut + fin - fraisReels(pourquoi)) * 1000) / 1000;
  const gain = Math.round(p.mise * r / 100 * 100) / 100;
  S.tresor = Math.round((S.tresor + gain) * 100) / 100;
  S.trades++; S.gains += gain;
  if (r > S.meilleur) S.meilleur = r;
  S.financement.n++; S.financement.total += fin;
  const ligne = { sym: p.sym, soupape: !!p.soupape,
                  sens: p.sens, prix0: p.prix0, prix, r, rReel, brut: Math.round(brut * 1000) / 1000,
                  financement: Math.round(fin * 1000) / 1000, frais, gain, minutes: Math.round(minutes),
                  pourquoi, t: tFin, ouvert: p.t, dit: p.dit || null, score: p.score };
  S.carnet.unshift(ligne);
  if (S.carnet.length > 200) S.carnet.length = 200;
  if (!S.bilan) S.bilan = bilanNeuf();
  ajouteBilan(S.bilan, ligne);
  S.positions = S.positions.filter((q) => q !== p);
  S.flux.unshift({ t: Date.now(), sym: p.sym,
                   quoi: 'CLOSED ' + String(p.sym).replace(/USDT$/, '') + ' ' + r.toFixed(2) + '% · ' + pourquoi });
  if (S.flux.length > 60) S.flux.length = 60;
  compte('fermetures');
  return r;
}

/**
 * Parcourt les bougies FINES d une position (1 min en service, 15 min au
 * rejeu) depuis son dernier controle. Rend {prix, pourquoi, t} si une
 * barriere est touchee, ou si la tenue est echue, sinon null.
 *   - une bougie qui COMMENCE avant l entree est ignoree : ses extremes
 *     peuvent dater d avant la position ;
 *   - stop et cible dans la meme bougie : le stop d abord (prudent, on ne sait
 *     pas l ordre) ;
 *   - une bougie qui OUVRE au-dela du stop le prend a son ouverture (un
 *     stop-market glisse) ; au-dela de la cible, a la cible (un ordre limite
 *     pose ne s execute pas mieux que son prix) ;
 *   - la tenue echue : sortie au dernier cours avant l echeance.
 */
function parcoursFin(p, fines) {
  for (const c of fines) {
    if (!(c.t >= p.t) || c.h === null || c.b === null) continue;
    /* L echeance : le dernier cours vu AVANT elle (`vuC`, garde d un tour a
       l autre). Sans cours vu, on laisse le dernier prix decider. */
    if (c.t >= p.jusqua) return (p.vuC > 0) ? { prix: p.vuC, pourquoi: 'time', t: p.jusqua } : null;
    p.vu = c.t;
    if (p.sens > 0 ? c.b <= p.stop : c.h >= p.stop) {
      const px = (c.o !== null && (p.sens > 0 ? c.o < p.stop : c.o > p.stop)) ? c.o : p.stop;
      return { prix: px, pourquoi: 'stop', t: c.t };
    }
    if (p.sens > 0 ? c.h >= p.cible : c.b <= p.cible) return { prix: p.cible, pourquoi: 'target', t: c.t };
    p.vuC = c.c;
  }
  return null;
}

/** Chaque position est surveillee au prix de SON marche, et sur ses bougies fines quand on les a. */
function surveille(lus, fines) {
  const S = etat();
  for (const p of S.positions.slice()) {
    const f = fines && fines[p.sym];
    if (f && f.length) {
      const res = parcoursFin(p, f);
      if (res) { ferme(p, res.prix, res.pourquoi, res.t); compte('sortiesFines'); continue; }
    }
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
 * Pour un banc (le rejeu, les essais) : `opts.fines` ({symbole: bougies})
 * remplace la lecture des bougies fines, `opts.muets` fait taire des agents
 * dans la note, `opts.sansSauver` evite d ecrire l etat a chaque tour.
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
  /* La periode de financement de chaque contrat : une lecture par jour. */
  if (!o.marches) await litPeriodes(Object.keys(lus), o.prendre);
  for (const sym of Object.keys(lus)) {
    const m = o.marches ? o.marches[sym] : null;
    lus[sym].periodeFin = (m && m.periodeFin > 0) ? m.periodeFin : periodeFin(sym);
  }

  regleLesOmbres(lus);
  /* Les bougies d une minute des positions ouvertes : un appel par position. */
  const fines = o.marches ? (o.fines || null) : await litFines(S.positions, o.prendre);
  surveille(lus, fines);

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
      const an = note(x, sens, o.muets);
      /* Sous la barre, c est la NOTE qui refuse, pas Trend : voir `nomAgent`. */
      if (!refus && an.score < S.seuil) { refus = 'score below the bar'; qui = 'score'; }
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
    /* La cle est celle du TRAIT (`'BTC'`), plus le symbole (`'BTCUSDT'`) :
       c etait le code mort. Eteinte, la porte ne refuse rien mais compte ce
       qu elle aurait refuse — voir `marcheRefuse`. */
    const r = marcheRefuse(TRAITS.marche(lus[v.sym]));
    if (r && PORTE_MEMOIRE) { v.refus = r; v.qui = 'Memory'; }
    else if (r) compte('memoireAuraitRefuse');
  }
  /* L'exposition dans un sens : voir MEME_SENS_MAX. Apres les avis de
     direction, pour ne compter que les candidats qui seraient pris. */
  for (const v of verdicts) {
    if (v.refus) continue;
    if (S.positions.filter((q) => q.sens === v.sens).length >= MEME_SENS_MAX) {
      v.refus = 'too many positions the same way'; v.qui = 'Exposure';
      compte('memeSens');
    }
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

  if (!o.sansSauver) sauve();
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
  /* Comparable : deux groupes de trades, un ecart de 0,30 % a voir a 80 % —
     `TRADES_COMPARABLES` par groupe (calcul de puissance, pas un rond). */
  return { soupape: a, colonie: b, tours: FAMINE_TOURS, minTrades: TRADES_COMPARABLES,
           comparable: a.n >= TRADES_COMPARABLES && b.n >= TRADES_COMPARABLES,
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

/* ---- LE BILAN DES TRADES, AVEC CE QU IL PEUT DIRE ----
 * n, gagnants et leur intervalle de Wilson, net ± erreur-type GROUPEE PAR
 * JOUR (les cinq cryptos bougent ensemble : correlation a 4 h ρ = 0,76,
 * mesuree le 26/09 — des trades du meme jour ne sont pas independants), le
 * meme net aux frais reels, et `jugeable` seulement a `TRADES_JUGEABLES`. */
function seGroupe(jours, cle, n, moyenne) {
  if (!n || moyenne === null) return null;
  let v = 0, k = 0;
  for (const j in jours) { const d = jours[j]; const e = d[cle] - moyenne * d.n; v += e * e; k++; }
  if (k < 2) return null;
  return Math.sqrt(v * k / (k - 1)) / n;
}
function bilanVue() {
  const B = etat().bilan || bilanNeuf();
  const m = B.n ? B.s / B.n : null, mR = B.n ? B.sR / B.n : null;
  const w = wilson(B.gagnants, B.n);
  const parSortie = {};
  for (const k in B.parSortie) { const o = B.parSortie[k]; parSortie[k] = { n: o.n, moyenne: r3(o.s / o.n), moyenneReel: r3(o.sR / o.n) }; }
  const se = seGroupe(B.jours, 's', B.n, m), seR = seGroupe(B.jours, 'sR', B.n, mR);
  return { n: B.n, gagnants: B.gagnants, part: B.n ? Math.round(B.gagnants / B.n * 1000) / 10 : null,
           wilson: w ? [Math.round(w[0] * 1000) / 10, Math.round(w[1] * 1000) / 10] : null,
           net: r3(m), se: r3(se), netReel: r3(mR), seReel: r3(seR),
           jours: Object.keys(B.jours).length, seuil: TRADES_JUGEABLES,
           jugeable: B.n >= TRADES_JUGEABLES, manquants: B.manquants || 0, parSortie };
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
    /* Le taux de gain vient du BILAN (tous les trades, jamais tronqué), pas du
       carnet (200 lignes) : la page l'écrivait « on <trades> » alors qu'il
       portait sur les 200 derniers — le 27/09, 300 trades dont les 100
       premiers gagnants : « 0% on 300 · 95% CI 28–39% », un n faux et un
       intervalle qui ne contenait pas le chiffre. Son n est `bilan.n`, son
       intervalle `bilan.wilson` ; si le bilan a été rebâti depuis le carnet
       (`manquants` > 0), ce sont les `bilan.n` trades les plus récents. */
    partGagnantes: (S.bilan && S.bilan.n) ? Math.round(S.bilan.gagnants / S.bilan.n * 100) : null,
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
        fin = Math.round(coutFinancement(p.sens, p.fin0, minutes, p.pf) * 1000) / 1000;
        /* Net des DEUX couts, comme a la fermeture : financement + frais d une
           sortie AU MARCHE maintenant (taker des deux cotes). */
        net = Math.round((brut + fin - fraisAR('time')) * 1000) / 1000;
        gain = Math.round(p.mise * net / 100 * 100) / 100;
      }
      return { sym: p.sym, nom: String(p.sym || '').replace(/USDT$/, ''),
               sens: p.sens, prix0: p.prix0, prix, prixVu: vu ? vu.t : null,
               stop: p.stop, cible: p.cible, mise: p.mise, levier: p.levier,
               brut, financement: fin, net, gain,
               score: p.score, depuis: p.t };
    }),
    /* Le carnet ENTIER (200 lignes au plus) : il n en servait que 40, et les
       premiers trades n etaient plus relisibles de l exterieur (26/09/2026).
       Chaque ligne porte son net aux frais REELS, meme les anciennes. */
    carnet: S.carnet.map((c) => Object.assign({}, c, { rReel: rReelDe(c) })),
    bilan: bilanVue(),
    parMarche: parMarche(),
    soupape: soupapeBilan(), positionsMax: POSITIONS_MAX, memeSensMax: MEME_SENS_MAX, fondMur: FOND_MUR,
    agents: AGENTS.map((x) => ({ key: x.key, nom: x.nom, emoji: x.emoji, role: x.role, quoi: x.quoi, traits: x.traits })),
    audit: a,
    reference: reference(),
    verdicts: a.map((l) => Object.assign({ cle: l.cle }, verdictRegle(l.cle))),
    ombres: { enAttente: S.ombres.length, jugees: S.compteurs.ombresJugees || 0 },
    /* Ce que le journal brut porte : sans ca, on ne sait pas si la question
       « comment gagne-t-on sur la duree » a seulement de quoi etre posee. */
    journal: journal.etat(),
    horizons: HORIZONS, horizonRef: HORIZON_REF, minObs: AUDIT_MIN_OBS, profilMinObs: PROFIL_MIN_OBS,
    minObsAudit: { coute: AUDIT_MIN_COUTE, protege: AUDIT_MIN_PROTEGE, moyenne: AUDIT_MIN_MOYENNE },
    frais: { taker: FRAIS_TAKER, maker: FRAIS_MAKER, forfait: FRAIS_FORFAIT },
    porteMemoire: PORTE_MEMOIRE,
    periodesFin: Object.keys(S.periodesFin || {}).reduce((o, k) => { o[k] = S.periodesFin[k].min; return o; }, {}),
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
  POSITIONS_MAX, MEME_SENS_MAX, FOND_MUR,
  charge, etat, etatNeuf, vue, tour, demarre, litMarche,
  mesures, traitsDe, note, noteOmbre, regleLesOmbres, noteAudit, ecartGroupe, CRENEAU_AUDIT_MS, auditDesRefus,
  reference, verdictRegle, coutFinancement, ouvre, ferme, surveille,
  parMarche, soupapeBilan, caseProfil, noteProfil, marcheRefuse,
  volatilite, position, ema,
  /* 27 septembre 2026 : frais par ordre, periodes, bougies fines, audit en σ, bilan */
  FRAIS_TAKER, FRAIS_MAKER, FRAIS_FORFAIT, FRAIS_AR, fraisAR, fraisReels, rReelDe,
  periodeFin, litPeriodes, litFines, parcoursFin, bilanVue, rebatitBilan, ligneSigma, wilson, moyenneEt,
  AUDIT_MIN_COUTE, AUDIT_MIN_PROTEGE, AUDIT_MIN_MOYENNE, TRADES_JUGEABLES, TRADES_COMPARABLES,
  nDeuxParts, nDeuxMoyennes, PORTE_MEMOIRE, STOP_VOL, CIBLE_VOL, TENUE_MAX_MIN, bougies,
  _pose: (e) => { E = e; },
};
