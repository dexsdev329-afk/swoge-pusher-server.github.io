'use strict';
/*
 * L'OBSERVATION DES SPORTS A DEUX ISSUES — NHL, NFL, NBA, tennis (lot 3, 10/10/2026).
 *
 * ---- pourquoi ----
 *
 * Ces sports se vendent a l'Elo. Mesure du 09/10/2026 (0 credit : le moneyline
 * DraftKings que le tableau d'ESPN rend deja au verrou de fermeture, contre nos
 * cotes du calendrier public) : 35 rencontres NHL/NFL/MLB, 70 issues, 15
 * battables (21,4 %, borne basse de Wilson 13,4 %) — NHL 9/36, NFL 6/30,
 * MLB 0/4. C'est SOUS l'echantillon minimal : rien ne conclut encore. Avant de
 * les vendre au prix du marche (une variable, PARIS_PRIX_LIGUES), il faut
 * savoir sport par sport si la bascule AMELIORE ce qu'on vend. D'ou ce carnet,
 * qui ne vend rien, ne paie rien et ne decide rien : il releve, et `bilan`
 * calcule la porte ecrite d'avance (EXPLOITATION 8.8nonies) pour qu'on ne la
 * refasse pas a la main.
 *
 * ---- deux canaux, aucun credit de plus ----
 *
 *  A. `noteDk(par, now)` — le moneyline DraftKings vu par ESPN. Le verrou du
 *     serveur (server.js, verrouFrais) lit deja le tableau d'ESPN chaque minute
 *     pres du coup d'envoi et chaque quart d'heure a 36 h ; scores_espn.releve
 *     pose `su.dk` sur chaque rencontre appariee. 0 credit, 0 requete de plus.
 *     Le champ n'est pas documente par ESPN : observe le 09/10 sur 63 lots
 *     d'avant-match, fournisseur « DraftKings » partout, `close` present
 *     partout ; disparu pendant le match (3 rencontres « in » sans objet odds).
 *     On ne garde que `close` (jamais `open`, des lignes d'anticipation : JAX
 *     +110 a l'ouverture, -380 a la cloture), avant le coup d'envoi (etat
 *     « pre », heure ESPN ET heure du catalogue a venir), d'un seul
 *     fournisseur.
 *  B. `noteEu(ligue, sport, compte, now, etat)` — apres chaque releve /odds
 *     d'une cle OBSERVEE (paris_import.rafraichitPrix, PARIS_PRIX_OBSERVE,
 *     1 credit la releve, classe 3 jamais prioritaire) : l'historique de la
 *     releve (ok / refuse / erreur, et sa couverture), le prix eu de chaque
 *     rencontre a venir avec nos cotes Elo du meme instant, et la PAIRE eu /
 *     DraftKings quand le verrou a vu DK il y a moins de 15 min.
 *
 * ---- ce qui est garde, par rencontre (notre identifiant) ----
 *
 *   dk.premier / dk.a2h / dk.fin : le premier point DK, le dernier au plus tard
 *     2 h avant le coup d'envoi, le dernier avant le coup d'envoi. Un point =
 *     { t, c: cotes DK decimales, p: probas (marge retiree par la puissance,
 *     comme prix_marche), elo: nos cotes du meme instant si la rencontre est
 *     cotee a l'Elo }. Un point ne s'ecrit que si la cote DK ou notre Elo
 *     change : `fin` est donc la cote valable au coup d'envoi.
 *   dk.bouge : la cote DK a change au moins une fois (sans mouvement, la mesure
 *     de fraicheur ne vaut rien : P5 est alors declaree invalide).
 *   eu : le dernier prix eu releve avant le coup d'envoi, avec notre Elo.
 *   pa : les paires [t, p_eu(1), p_DK(1)] (6 au plus).
 *   sc : ESPN rendait un moneyline SANS `close` (aucun point garde, compte).
 *
 * ---- l'ecriture ----
 *
 * DATA_DIR/paris_observe.json, en deux temps (temporaire puis renommage), au
 * plus une fois par minute et seulement si une valeur a change (le passage
 * proche du verrou tourne chaque minute). Une lecture refusee (EIO, EMFILE)
 * n'est pas gardee : on ne note rien et on relit au prochain appel — sinon le
 * carnet vide ecraserait soixante jours d'observation. Un contenu qui ne se
 * decode pas est mis de cote (`.illisible-<t>`), jamais ecrase en silence.
 * Retention : PARIS_OBS_JOURS (60 par defaut).
 *
 * ---- les drapeaux ----
 *
 *   PARIS_OBS_US          « 0 » coupe le canal A (coupe-circuit, comme
 *                         PARIS_PRIX_JOURNAL et PARIS_CLV) ; actif sinon :
 *                         0 credit, 0 requete, rien de vendu ne change.
 *   PARIS_OBS_DK_SPORTS   les sports dont on garde DK : nfl,nhl,nba par defaut.
 *                         Pas le football (trois issues, mesure faite en
 *                         8.8quinquies) ; pas la MLB (retiree de l'observation
 *                         le 09/10 : la saison finit avant 40 rencontres,
 *                         decision a la reprise 2027 — l'ajouter ici ne coute
 *                         aucun credit).
 *   PARIS_OBS_JOURS       retention, 60 jours (bornee 7 a 365).
 */
const fs = require('fs');
const path = require('path');
const paris = require('./paris');
const cotes = require('./cotes');
const prixMarche = require('./prix_marche');

const MIN = 60000, H = 3600000, JOUR = 86400000;
const FOURNISSEUR = 'DraftKings';
/* Ecart d'une paire eu / DK : la passe large du verrou relit DK toutes les
   15 min — une releve eu trouve donc toujours un DK de moins de 15 min pour
   une rencontre a moins de 36 h. */
const DK_PAIRE_MS = 15 * MIN;
/* « une reference du meme instant : cloture DK, ou prix eu de moins de 3 h »
   (porte P1). 3 h : la fraicheur exigee a la vente pres du coup d'envoi
   (paris.FRAIS_MS). */
const EU_FRAIS_MS = 3 * H;
const PAIRES_MAX = 6;
const ECRITURE_MS = MIN;
/* Le seuil de conclusion, ecrit d'avance (porte P1) : 40 rencontres, soit 80
   issues. Sous lui, aucune part n'est une conclusion — le prototype du 09/10
   en avait 35 (NHL 18, NFL 15, MLB 2). */
const ASSEZ = Object.freeze({ rencontres: 40, issues: 80 });

/* ---- LA PORTE, ECRITE D'AVANCE (EXPLOITATION 8.8nonies, plan corrige du 09/10) ----
 * Par sport, toutes les conditions. Une porte non atteinte fait glisser la
 * date, jamais le seuil.
 *  P1 echantillon : >= 40 rencontres coup d'envoi passe, portant nos cotes Elo
 *     et une reference du meme instant (cloture DK, ou eu de moins de 3 h),
 *     soit >= 80 issues ; et 7 jours pleins d'observation (tennis : en nombre
 *     de rencontres seulement, sans date).
 *  P2 RAPPORT seulement : borne basse de Wilson (95 %) de la part d'issues Elo
 *     battables >= 5 %. Deja franchie pour la NHL au 09/10 (9/36, 13,8 %) :
 *     elle ne departage rien, elle ne bloque rien.
 *  P3 couverture eu sur 7 jours : `aucun` <= 10 % des rencontres relevees, et
 *     au moins 10 releves reussies. Un REFUS d'une cle observee est voulu
 *     (classe 3, jamais prioritaire) et ne dit rien de la cle une fois vendue,
 *     qui passera en classe 0 : il n'est pas une condition.
 *  P4 semantique (sports US) : sur >= 20 rencontres appariees eu / DK a moins
 *     de 15 min, mediane SIGNEE de |p_eu - 0,5| - |p_DK - 0,5| <= 1 point (un
 *     prix au temps reglementaire, nul rembourse, est plus TRANCHE que le
 *     moneyline : 1,1 a 3,2 points pour un favori de 55 a 65 % — un |ecart|
 *     ne le voyait pas) ; et |ecart| median <= 2 points (l'orientation).
 *  P5 fraicheur, COMPAREE A L'ELO qu'on remplace : la borne HAUTE de Wilson de
 *     la part de rencontres battables au prix DK de 2 h + 10 % (contre la
 *     cloture DK) est SOUS la borne BASSE de Wilson de la part de rencontres
 *     battables a l'Elo ; >= 40 rencontres de chaque cote, comptees PAR
 *     RENCONTRE (a 10 % de marge une rencontre a au plus une issue battable :
 *     ses deux issues ne sont pas independantes). Valable seulement si DK a
 *     bouge sur >= 20 % des rencontres ; sinon invalide, le proprietaire
 *     tranche. Le seuil absolu de 3 % (borne haute, par issue) dit seulement
 *     s'il FAUT EN PLUS la cadence rapprochee du rang 3 — jamais de garder
 *     l'Elo : a 21 % d'issues Elo battables, un marche a 4 % vaut mieux.
 *     Pourquoi pas « <= 3 % sur 80 issues » : 2 battables sur 80 ont une borne
 *     haute de 8,7 %, et une fuite reelle de 5 % passait 22 % du temps
 *     (calculs du sceptique, 09/10).
 *  Tennis : AUCUNE bascule possible tant qu'il n'a pas de verrou d'heure
 *     reelle (scores_espn.CHEMINS n'a aucune cle tennis, et /odds rend aussi
 *     les matchs en cours) ; P4 et P5 ne s'y mesurent pas gratuitement. */
const PORTE = Object.freeze({
  P1: Object.freeze({ rencontres: 40, issues: 80, jours: 7 }),
  P2: Object.freeze({ wilsonBas: 0.05 }),
  P3: Object.freeze({ aucunMax: 0.10, reussiesMin: 10, jours: 7 }),
  P4: Object.freeze({ rencontres: 20, signeeMax: 0.01, ecartMax: 0.02 }),
  P5: Object.freeze({ rencontres: 40, dkBougeMin: 0.20, absoluHaut: 0.03 }),
});
/* Les sports qu'on peut basculer : ceux dont la fermeture a un second verrou
   d'heure reelle (paris.ouvert, HEURES_REELLES, lu sur scores_espn.CHEMINS). */
const SANS_VERROU_REEL = new Set(['tennis']);

// ------------------------------------------------------------ les drapeaux

function actifUS() { return String(process.env.PARIS_OBS_US === undefined ? '' : process.env.PARIS_OBS_US).trim() !== '0'; }
function sportsDk() {
  const v = process.env.PARIS_OBS_DK_SPORTS;
  const l = v === undefined ? ['nfl', 'nhl', 'nba'] : String(v).split(/[\s,;]+/).filter(Boolean);
  return new Set(l);
}
function joursGardes() {
  const n = Math.floor(Number(process.env.PARIS_OBS_JOURS));
  return Math.min(365, Math.max(7, isFinite(n) && n > 0 ? n : 60));
}

// ------------------------------------------------------------- les calculs

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r4 = (x) => Math.round(Number(x) * 1e4) / 1e4;
/** Les bornes de Wilson a 95 % de k sur n : [bas, haut], ou null sans n. */
function wilson(k, n, z) {
  if (!(n > 0)) return null;
  const zz = z || 1.96, p = k / n, z2 = zz * zz;
  const c = p + z2 / (2 * n), r = zz * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return [Math.max(0, (c - r) / (1 + z2 / n)), Math.min(1, (c + r) / (1 + z2 / n))];
}
function mediane(v) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b), k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}
const pct = (x) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);
/** Nos cotes Elo d'une rencontre (1-N-2 de base), si elle est cotee a l'Elo. */
function eloDe(m) {
  if (!paris.aLElo(m)) return null;
  const c = (m.marches && m.marches[paris.MARCHE_BASE] && m.marches[paris.MARCHE_BASE].cotes) || m.cotes;
  if (!c || !(Number(c[1]) > 1 && Number(c[2]) > 1)) return null;
  return { 1: Number(c[1]), 2: Number(c[2]) };
}
const memeElo = (a, b) => (!a && !b) || (a && b && a[1] === b[1] && a[2] === b[2]);
const memePoint = (a, b) => a && b && a.c[1] === b.c[1] && a.c[2] === b.c[2] && memeElo(a.elo, b.elo);

// -------------------------------------------------------------- le carnet

function fichier() { return path.join((process.env.DATA_DIR || './data').trim(), 'paris_observe.json'); }
function vide() { return { v: 1, debutParSport: {}, rencontres: {}, releves: {} }; }
let ETAT = null, SALE = false, ECRIT_A = 0, MINUTERIE = null;
const DIT = { lecture: -Infinity, ecriture: -Infinity };
/* La derniere cote DK vue par rencontre, en memoire (pour les paires eu / DK). */
const DERNIER_DK = new Map();
function dit(quoi, message) {
  const t = Date.now();
  if (t - DIT[quoi] < H && t >= DIT[quoi]) return;
  DIT[quoi] = t;
  console.log('[obs] carnet d observation : ' + message);
}
/** L'etat en memoire, lu une fois ; null si le fichier ne se LIT pas (rien n'est garde). */
function etat() {
  if (ETAT) return ETAT;
  let brut;
  try { brut = fs.readFileSync(fichier(), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') { ETAT = vide(); return ETAT; }
    dit('lecture', 'lecture refusee (' + ((e && (e.code || e.message)) || e) + ') — rien n est note, on relit au prochain appel');
    return null;
  }
  try {
    const j = JSON.parse(brut);
    if (!j || typeof j !== 'object' || j.v !== 1 || typeof j.rencontres !== 'object' || !j.rencontres || typeof j.releves !== 'object' || !j.releves) throw new Error('forme inattendue');
    ETAT = { v: 1, debutParSport: j.debutParSport && typeof j.debutParSport === 'object' ? j.debutParSport : {}, rencontres: j.rencontres, releves: j.releves };
  } catch (e) {
    const aCote = fichier() + '.illisible-' + Date.now();
    try { fs.renameSync(fichier(), aCote); } catch (e2) { /* deja parti */ }
    console.log('[obs] carnet d observation illisible (' + String(e.message || e).slice(0, 80) + '), mis de cote sous ' + path.basename(aCote) + ' — on repart d un carnet vide');
    ETAT = vide();
  }
  return ETAT;
}
function purge(st, t) {
  const limite = t - joursGardes() * JOUR;
  for (const [id, r] of Object.entries(st.rencontres)) if (!(Number(r.debut) >= limite)) delete st.rencontres[id];
  for (const [L, h] of Object.entries(st.releves)) {
    const g = (Array.isArray(h) ? h : []).filter((x) => x && Number(x.t) >= limite);
    if (g.length) st.releves[L] = g; else delete st.releves[L];
  }
  for (const [id, d] of DERNIER_DK) if (t - d.t > H) DERNIER_DK.delete(id);
}
/** Ecrit maintenant ce qui a change (en deux temps). Rend vrai si le carnet est a jour sur le disque. */
function flush() {
  if (MINUTERIE) { clearTimeout(MINUTERIE); MINUTERIE = null; }
  if (!SALE || !ETAT) return !SALE;
  purge(ETAT, Date.now());
  try {
    fs.mkdirSync(path.dirname(fichier()), { recursive: true });
    const tmp = fichier() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ETAT) + '\n');
    fs.renameSync(tmp, fichier());
    SALE = false; ECRIT_A = Date.now();
    return true;
  } catch (e) {
    dit('ecriture', 'ecriture impossible (' + ((e && (e.code || e.message)) || e) + ') — gardee en memoire, reessayee dans une minute');
    ECRIT_A = Date.now();
    MINUTERIE = setTimeout(flush, ECRITURE_MS);
    if (MINUTERIE.unref) MINUTERIE.unref();
    return false;
  }
}
/* Au plus une ecriture par minute : le reste attend la minuterie. */
function marque() {
  SALE = true;
  const ecoule = Date.now() - ECRIT_A;
  if (ecoule >= ECRITURE_MS || ecoule < 0) { flush(); return; }
  if (!MINUTERIE) {
    MINUTERIE = setTimeout(flush, ECRITURE_MS - ecoule);
    if (MINUTERIE.unref) MINUTERIE.unref();
  }
}
/** Pour les essais : oublier la memoire, comme un redemarrage (rien n'est ecrit). */
function oublie() {
  if (MINUTERIE) { clearTimeout(MINUTERIE); MINUTERIE = null; }
  ETAT = null; SALE = false; ECRIT_A = 0; DERNIER_DK.clear();
}
function rencontreDe(st, m, t) {
  const id = String(m.id);
  let r = st.rencontres[id];
  if (!r) {
    r = st.rencontres[id] = { s: String(m.sport), l: String((m.source && m.source.ligue) || ''), ev: String((m.source && m.source.evenement) || ''),
                              dom: String(m.domicile || ''), ext: String(m.exterieur || ''), debut: Number(m.debut) || 0, dk: null, eu: null, pa: [] };
    if (!st.debutParSport[r.s]) st.debutParSport[r.s] = t;
  }
  return r;
}

// ------------------------------------------------------------ canal A : DK

/**
 * Le moneyline DraftKings de la releve du verrou (`par` : Map de notre
 * identifiant vers ce que scores_espn.releve rend). 0 credit. Rend le nombre
 * de rencontres dont le carnet a change. Ne leve pas sur une entree bancale.
 */
function noteDk(par, now) {
  if (!actifUS() || !(par instanceof Map) || !par.size) return 0;
  const t = Number(now) || Date.now();
  const sports = sportsDk();
  let st = null, change = 0;
  for (const [id, su] of par) {
    if (!su || (!su.dk && !su.dkSansClose)) continue;
    const m = paris.match(id);
    if (!m || !m.source || !sports.has(String(m.sport))) continue;
    /* G8 : rien APRES le coup d'envoi — ni l'heure du catalogue, ni celle
       d'ESPN (9 a 10 min plus tot en NHL, paris.js), ni un etat autre que
       « pre ». Un moneyline en jeu n'est pas une cloture. */
    const quand = Number(su.quand) || 0;
    if (su.etat !== 'pre' || !(quand > t) || !(m.debut > t)) continue;
    if (!st) { st = etat(); if (!st) return 0; }
    if (!su.dk) {
      const r = rencontreDe(st, m, t);
      if (!r.sc) { r.sc = 1; change++; }
      continue;
    }
    const dk = su.dk;
    if (String(dk.fournisseur || '') !== FOURNISSEUR) continue;
    const c = { 1: r4(dk[1]), 2: r4(dk[2]) };
    if (!(c[1] > 1 && c[2] > 1)) continue;
    const p = cotes.probasImplicites(c, ['1', '2'], 1);
    if (!p || !(p[1] > 0 && p[1] < 1 && p[2] > 0 && p[2] < 1)) continue;
    const debut = Math.min(m.debut, quand);
    const pt = { t, c, p: { 1: r5(p[1]), 2: r5(p[2]) }, elo: eloDe(m) };
    DERNIER_DK.set(String(id), { t, p: pt.p });
    const r = rencontreDe(st, m, t);
    let bouge = false;
    if (r.debut !== debut) { r.debut = debut; bouge = true; }
    if (!r.dk || !memePoint(r.dk.fin, pt)) {
      if (!r.dk) r.dk = { premier: pt, a2h: null, fin: pt, n: 1, bouge: 0 };
      else {
        if (r.dk.fin.c[1] !== c[1] || r.dk.fin.c[2] !== c[2]) r.dk.bouge = 1;
        r.dk.fin = pt; r.dk.n++;
      }
      if (t <= debut - 2 * H) r.dk.a2h = pt;
      bouge = true;
    }
    if (bouge) change++;
  }
  if (change) marque();
  return change;
}

// ------------------------------------------------------------ canal B : eu

/**
 * Apres une releve /odds d'une cle observee (ou son refus). `etatReleve` :
 * 'ok' | 'refuse' | 'erreur'. Rend le nombre de rencontres notees.
 */
function noteEu(ligue, sport, compte, now, etatReleve) {
  const t = Number(now) || Date.now();
  const L = String(ligue || '');
  if (!L) return 0;
  const st = etat();
  if (!st) return 0;
  const e = etatReleve === 'refuse' || etatReleve === 'erreur' ? etatReleve : 'ok';
  const c = compte && typeof compte === 'object' ? compte : {};
  const n = (x) => Math.max(0, Math.floor(Number(x) || 0));
  if (!Array.isArray(st.releves[L])) st.releves[L] = [];
  st.releves[L].push({ t, s: sport ? String(sport) : null, e, b: n(c.betfair), pi: n(c.pinnacle), md: n(c.mediane), a: n(c.aucun), nul: n(c.nul) });
  let notees = 0;
  if (e === 'ok' && sport && paris.sportConnu(sport) && paris.issues(sport).length === 2) {
    let matchs = [];
    try { matchs = paris.catalogue().matchs; } catch (x) { /* catalogue illisible : l'historique suffit */ }
    for (const m of matchs) {
      if (!m || !m.source || m.source.ligue !== L || !(m.debut > t)) continue;
      const r = prixMarche.pour(m.source.evenement, t);
      if (!r || !r.p || !(r.p[1] > 0 && r.p[2] > 0) || r.p.N !== undefined) continue;
      /* un prix colle a l'envers donnerait au favori la proba de l'outsider */
      if (r.dom && (r.dom !== m.domicile || r.ext !== m.exterieur)) continue;
      if (!(t - r.t <= EU_FRAIS_MS)) continue;
      const rec = rencontreDe(st, m, t);
      rec.eu = { t, te: r.t, p: { 1: r.p[1], 2: r.p[2] }, elo: eloDe(m) };
      const d = DERNIER_DK.get(String(m.id));
      if (d && Math.abs(t - d.t) <= DK_PAIRE_MS) {
        rec.pa.push([t, r.p[1], d.p[1]]);
        if (rec.pa.length > PAIRES_MAX) rec.pa.splice(0, rec.pa.length - PAIRES_MAX);
      }
      notees++;
    }
  }
  marque();
  return notees;
}

// -------------------------------------------------------------- le bilan

function nouveauSport() {
  return { rencontres: 0, issues: 0, battablesElo: 0, rencontresBattables: 0, sources: { dk: 0, eu: 0 }, pire: null,
           fr: { rencontres: 0, issues: 0, battables: 0, rencontresBattables: 0 },
           dk: { rencontres: 0, bouge: 0, sansClose: 0 }, ecarts: [], signees: [],
           eu7: { releves: 0, reussies: 0, refusees: 0, erreurs: 0, rencontres: 0, aucun: 0, nul: 0 } };
}
/**
 * Par sport, la mesure et la porte. `jours` : la fenetre des rencontres
 * (30 par defaut) ; la couverture eu porte toujours sur 7 jours (P3).
 */
function bilan(now, jours) {
  const t = Number(now) || Date.now();
  const J = Number(jours) > 0 ? Number(jours) : 30;
  const st = etat() || vide();
  const depuis = t - J * JOUR;
  const par = {};
  const S = (s) => par[s] || (par[s] = nouveauSport());
  for (const r of Object.values(st.rencontres)) {
    /* seulement les rencontres dont le coup d'envoi est PASSE */
    if (!r || !(Number(r.debut) <= t) || Number(r.debut) < depuis) continue;
    const b = S(r.s);
    if (r.sc) b.dk.sansClose++;
    /* l'Elo contre sa reference du MEME instant : la cloture DK, sinon le prix eu */
    const ref = (r.dk && r.dk.fin && r.dk.fin.elo) ? { p: r.dk.fin.p, elo: r.dk.fin.elo, src: 'dk' }
      : (r.eu && r.eu.elo && r.eu.t - r.eu.te <= EU_FRAIS_MS) ? { p: r.eu.p, elo: r.eu.elo, src: 'eu' } : null;
    if (ref) {
      b.rencontres++; b.sources[ref.src]++;
      let k = 0;
      for (const i of ['1', '2']) {
        const e = Number(ref.elo[i]) * Number(ref.p[i]) - 1;
        b.issues++;
        if (e > 0) { b.battablesElo++; k++; }
        if (!b.pire || e > b.pire.esperance) b.pire = { rencontre: r.dom + ' v ' + r.ext, issue: i, cote: Number(ref.elo[i]), marche: Math.round(ref.p[i] * 1000) / 1000, esperance: Math.round(e * 1000) / 1000, source: ref.src };
      }
      if (k) b.rencontresBattables++;
    }
    if (r.dk) {
      b.dk.rencontres++;
      if (r.dk.bouge) b.dk.bouge++;
      /* la fraicheur : notre prix au DK de 2 h + 10 % contre la cloture DK */
      if (r.dk.a2h && r.dk.fin) {
        let co = null;
        try { const mm = cotes.marchesDuMarche(r.s, r.dk.a2h.p); co = mm && mm[paris.MARCHE_BASE] && mm[paris.MARCHE_BASE].cotes; } catch (x) { co = null; }
        if (co) {
          b.fr.rencontres++;
          let k = 0;
          for (const i of ['1', '2']) { b.fr.issues++; if (Number(co[i]) * Number(r.dk.fin.p[i]) > 1) { b.fr.battables++; k++; } }
          if (k) b.fr.rencontresBattables++;
        }
      }
    }
    if (Array.isArray(r.pa) && r.pa.length) {
      const x = r.pa[r.pa.length - 1];
      b.ecarts.push(Math.abs(x[1] - x[2]));
      b.signees.push(Math.abs(x[1] - 0.5) - Math.abs(x[2] - 0.5));
    }
  }
  for (const h of Object.values(st.releves)) {
    for (const x of Array.isArray(h) ? h : []) {
      if (!x || !x.s || !(x.t <= t) || x.t < t - PORTE.P3.jours * JOUR) continue;
      const e7 = S(x.s).eu7;
      e7.releves++;
      if (x.e === 'ok') { e7.reussies++; e7.rencontres += x.b + x.pi + x.md + x.a; e7.aucun += x.a; e7.nul += x.nul || 0; }
      else if (x.e === 'refuse') e7.refusees++; else e7.erreurs++;
    }
  }
  const sortie = {};
  for (const [s, b] of Object.entries(par)) sortie[s] = conclusion(s, b, st, t);
  return { asOf: new Date(t).toISOString(), jours: J, assez: ASSEZ, porte: PORTE, fournisseur: FOURNISSEUR,
           actif: actifUS(), sportsDk: [...sportsDk()], parSport: sortie };
}
function conclusion(s, b, st, t) {
  const wI = wilson(b.battablesElo, b.issues), wR = wilson(b.rencontresBattables, b.rencontres);
  const fI = wilson(b.fr.battables, b.fr.issues), fR = wilson(b.fr.rencontresBattables, b.fr.rencontres);
  const conclut = b.rencontres >= ASSEZ.rencontres && b.issues >= ASSEZ.issues;
  const debut = Number(st.debutParSport[s]) || null;
  const joursObs = debut ? (t - debut) / JOUR : 0;
  const tennis = SANS_VERROU_REEL.has(s);
  const e7 = b.eu7;
  const partAucun = e7.rencontres ? e7.aucun / e7.rencontres : null;
  const ecartMed = mediane(b.ecarts), signeeMed = mediane(b.signees);
  const bougePart = b.dk.rencontres ? b.dk.bouge / b.dk.rencontres : null;
  const P1 = { rencontres: b.rencontres, issues: b.issues, joursObservation: Math.round(joursObs * 10) / 10,
               ok: b.rencontres >= PORTE.P1.rencontres && b.issues >= PORTE.P1.issues && (tennis || joursObs >= PORTE.P1.jours) };
  const P2 = { wilsonBas: wI ? pct(wI[0]) : null, ok: wI ? wI[0] >= PORTE.P2.wilsonBas : null, rapportSeulement: true };
  const P3 = { releves: e7.releves, reussies: e7.reussies, refusees: e7.refusees, erreurs: e7.erreurs, partAucun: pct(partAucun),
               ok: e7.releves ? (partAucun !== null && partAucun <= PORTE.P3.aucunMax && e7.reussies >= PORTE.P3.reussiesMin) : null };
  let P4, P5;
  if (tennis) {
    P4 = { mesurable: false, ok: null };
    P5 = { mesurable: false, ok: null };
  } else {
    const n4 = b.ecarts.length;
    P4 = { rencontres: n4, signeeMediane: pct(signeeMed), ecartMedian: pct(ecartMed),
           ok: n4 >= PORTE.P4.rencontres ? (signeeMed <= PORTE.P4.signeeMax && ecartMed <= PORTE.P4.ecartMax) : null };
    const assez5 = b.fr.rencontres >= PORTE.P5.rencontres && b.rencontres >= PORTE.P5.rencontres;
    const valide = bougePart !== null && bougePart >= PORTE.P5.dkBougeMin;
    P5 = { rencontresFraicheur: b.fr.rencontres, rencontresElo: b.rencontres,
           fraicheurHaut: fR ? pct(fR[1]) : null, eloBas: wR ? pct(wR[0]) : null, dkBouge: pct(bougePart), valide,
           ok: !assez5 ? null : (!valide ? null : fR[1] < wR[0]),
           /* le seuil absolu, sur la borne haute par issue : faut-il EN PLUS la cadence rapprochee ? */
           cadenceRapprochee: fI && b.fr.issues >= PORTE.P1.issues ? fI[1] > PORTE.P5.absoluHaut : null };
  }
  const raisons = [];
  let bascule;
  if (tennis) { bascule = false; raisons.push('no real-time lock for tennis: it cannot be switched'); }
  else if (!P1.ok) { bascule = null; raisons.push('not enough games yet (' + b.rencontres + '/' + PORTE.P1.rencontres + ')' + (joursObs < PORTE.P1.jours ? ', ' + Math.floor(joursObs) + ' of 7 days' : '')); }
  else {
    const conds = [['P3', P3.ok], ['P4', P4.ok], ['P5', P5.ok]];
    if (conds.some((x) => x[1] === false)) { bascule = false; raisons.push(conds.filter((x) => x[1] === false).map((x) => x[0]).join(', ') + ' failed'); }
    else if (conds.some((x) => x[1] === null)) { bascule = null; raisons.push(conds.filter((x) => x[1] === null).map((x) => x[0]).join(', ') + ' not measurable yet'); }
    else bascule = true;
  }
  return {
    rencontres: b.rencontres, issues: b.issues, battablesElo: b.battablesElo, sources: b.sources,
    part: b.issues ? pct(b.battablesElo / b.issues) : null, wilsonBas: wI ? pct(wI[0]) : null, wilsonHaut: wI ? pct(wI[1]) : null,
    parRencontre: { rencontres: b.rencontres, battables: b.rencontresBattables, part: b.rencontres ? pct(b.rencontresBattables / b.rencontres) : null,
                    wilsonBas: wR ? pct(wR[0]) : null },
    conclut, manque: Math.max(0, ASSEZ.rencontres - b.rencontres), pire: b.pire,
    couvertureEu7j: Object.assign({}, e7, { partAucun: pct(partAucun) }),
    euDk: { rencontres: b.ecarts.length, ecartMedian: pct(ecartMed), signeeMediane: pct(signeeMed) },
    fraicheur2h: { rencontres: b.fr.rencontres, issues: b.fr.issues, battables: b.fr.battables, part: b.fr.issues ? pct(b.fr.battables / b.fr.issues) : null,
                   wilsonHaut: fI ? pct(fI[1]) : null,
                   parRencontre: { battables: b.fr.rencontresBattables, wilsonHaut: fR ? pct(fR[1]) : null } },
    dkBouge: { rencontres: b.dk.rencontres, bouge: b.dk.bouge, part: pct(bougePart) },
    dkSansClose: b.dk.sansClose,
    porte: { P1, P2, P3, P4, P5, bascule, raisons },
  };
}

/** Les lignes `[obs]` du jour, une par sport (ecrites avec la releve des scores). */
function lignes(now) {
  const b = bilan(now);
  const f = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1).replace('.', ',') + ' %');
  const pts = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1).replace('.', ',') + ' pts');
  return Object.entries(b.parSport).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([s, x]) =>
    `[obs] ${s} : ${x.rencontres} rencontres, Elo battables ${x.battablesElo}/${x.issues} (${f(x.part)}, borne basse ${f(x.wilsonBas)}), `
    + `eu-DK ${pts(x.euDk.ecartMedian)} (signe ${pts(x.euDk.signeeMediane)}, n ${x.euDk.rencontres}), `
    + `prix de 2 h + 10 % : ${x.fraicheur2h.battables}/${x.fraicheur2h.issues}, DK a bouge ${x.dkBouge.bouge}/${x.dkBouge.rencontres}`
    + (x.conclut ? '' : ` — aucune conclusion sous ${ASSEZ.rencontres} rencontres (${x.rencontres})`)
    + (x.porte.bascule === true ? ' — PORTE FRANCHIE' : x.porte.bascule === false ? ' — porte fermee : ' + x.porte.raisons.join(' ; ') : ''));
}
/** Une ligne de demarrage. */
function ligneDemarrage() {
  if (!actifUS()) return '[obs] moneyline DraftKings (ESPN) : COUPE (PARIS_OBS_US=0) — rien n est note, rien de vendu ne change';
  const st = etat();
  return '[obs] moneyline DraftKings (ESPN) : note pour ' + [...sportsDk()].join(', ') + ' (0 credit, 0 requete de plus), '
    + (st ? Object.keys(st.rencontres).length + ' rencontre(s) au carnet' : 'carnet illisible pour l instant') + ', garde ' + joursGardes() + ' j';
}

module.exports = { noteDk, noteEu, bilan, lignes, ligneDemarrage, flush, oublie, fichier, etat,
                   wilson, mediane, eloDe, actifUS, sportsDk, joursGardes,
                   ASSEZ, PORTE, FOURNISSEUR, DK_PAIRE_MS, EU_FRAIS_MS, SANS_VERROU_REEL };
