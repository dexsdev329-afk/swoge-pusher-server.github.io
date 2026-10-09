'use strict';
/*
 * LE PRIX DU MARCHE — on vend ce que le marche dit, plus notre marge.
 *
 * ---- pourquoi (08/10/2026) ----
 *
 * Nos cotes sortaient d'un Elo maison. Mesure du 08/10 sur 210 rencontres
 * appariees au marche (Polymarket et DraftKings, 597 issues) : 23 % des issues
 * rapportaient plus qu'elles ne coutaient au parieur MALGRE nos 10 % de marge,
 * et sur les favoris a 75 % et plus, 11 sur 11 etaient gagnants pour lui
 * (+6,6 % en moyenne) — Barcelone–Getafe a 1,20 pour un juste prix de 1,11.
 * Les deux seules rencontres portant des paris ce jour-la etaient
 * precisement deux de ces favoris, chacune au plafond de 2 M.
 *
 * Reparer l'Elo ne suffisait pas : meme avec un Elo PARFAIT il restait 15
 * issues battables sur 531. Vendre le prix du marche, frais, plus 10 %, en
 * laisse 0 a 2 sur 471 ; vieux de 1 a 4 jours, 16 % des rencontres de Liga
 * offrent encore un choix gagnant, contre 67 % aujourd'hui (829 rencontres,
 * football-data). D'ou : un prix du marche rafraichi chaque jour, et juste
 * avant le coup d'envoi pour ce qui porte des paris.
 *
 * ---- d'ou vient le prix ----
 *
 * De la reponse `/odds` de The Odds API, region eu, marche h2h : 1 credit par
 * championnat, toutes ses rencontres d'un coup. C'est la meme reponse que
 * l'etalonnage payait deja une fois par semaine et JETAIT apres en avoir tire
 * un quart de pas d'Elo. Ses conditions (31/08/2026) permettent d'afficher et
 * de calculer des valeurs derivees de ces donnees, usage commercial compris.
 * Recopier les sites des bookmakers, au contraire, est interdit par leurs
 * conditions et casse a chaque protection anti-robot.
 *
 * La reference, dans cet ordre :
 *   1. la bourse Betfair (betfair_ex_eu) si elle donne les trois prix et que
 *      sa somme d'inverses est saine (1,00 a 1,06) — c'est le prix le plus
 *      juste qui existe, presque sans marge ;
 *   2. sinon Pinnacle, le bookmaker le plus fin (somme 1,00 a 1,08) ;
 *   3. sinon la MEDIANE d'au moins trois bookmakers, chacun sa marge retiree.
 * Et un garde : si Betfair ou Pinnacle s'ecarte de plus de 5 points de la
 * mediane sur une issue, c'est un prix fige ou un marche mince — on prend la
 * mediane. La marge est retiree par la methode de la PUISSANCE
 * (`cotes.probasImplicites`) : la normalisation proportionnelle sous-estime
 * les gros favoris, exactement l'erreur qu'on corrige ici.
 */
const fs = require('fs');
const path = require('path');
const cotes = require('./cotes');

const ISSUES = ['1', 'N', '2'];

/* La liste vendue et la liste observee vivent dans `prix_ligues.js`, sans
   dependance : `paris.js` (la porte de vente) lit la meme. Defaut : les six
   grands championnats ; `PARIS_PRIX_LIGUES` vide COUPE tout (retour a l'Elo
   partout). Separateurs : virgule, point-virgule, espaces. */
const { LIGUES_DEFAUT, ligues, observees } = require('./prix_ligues');

/* Au-dela, le prix ne se vend plus : la rencontre est SUSPENDUE, jamais
   rendue a l'Elo en silence — a l'import ET a la vente (paris.ouvert, qui lit
   la meme variable). 36 h = le releve quotidien (22 h) plus quatorze heures de
   marge ; un releve refuse par la part du jour ne l'atteint pas, la releve
   des prix passant en PRIORITE dans le garde-fou (paris_import.autorise). */
const AGE_MAX_MS = (Number(process.env.PARIS_PRIX_AGE_MAX_H) || 36) * 3600000;

/* ---- OBSERVER SANS VENDRE (09/10/2026) ----
 * `PARIS_PRIX_OBSERVE` (cles separees par des virgules) : des championnats
 * dont on RELEVE le prix du marche sans le vendre — l'Elo continue d'y coter.
 * Pour juger un championnat AVANT de le basculer : la couverture des livres
 * (betfair / pinnacle / mediane / aucun, gardee par `note`) et l'ecart REEL de
 * nos cotes au marche (paris_import.ecartAuMarche). Mesure du banc du 09/10 :
 * sur les neuf championnats Elo, 20 % des issues 1-N-2 battables (test
 * 2023-26) ; c'est ce chiffre qu'on veut voir en direct avant de payer. */
/** Ce qui se releve : ce qui se vend, plus ce qu'on observe. */
function aRelever() { return new Set([...ligues(), ...observees()]); }
/* ---- LA CADENCE DU RELEVE ----
 * `PARIS_PRIX_RELEVE_H` : 22 h par defaut (une fois par jour, le forfait
 * gratuit de 500 credits). Avec un forfait paye, plus souvent : vieux de 1 a
 * 4 jours, le prix laissait un choix gagnant sur 16 % des rencontres de Liga
 * contre 0 a 2 sur 471 frais (mesure du 08/10). Jamais plus espace que l'age
 * de vente moins deux heures : sinon tout serait suspendu entre deux releves. */
function releveMs() {
  const h = Number(process.env.PARIS_PRIX_RELEVE_H);
  const ms = (isFinite(h) && h >= 1 ? h : 22) * 3600000;
  return Math.min(ms, AGE_MAX_MS - 2 * 3600000);
}
const ECART_MAX = 0.05;
const BOURSE = 'betfair_ex_eu', PINNACLE = 'pinnacle';

/* Les trois prix d'un livre, rangés sur NOS issues : 1 = domicile. */
function lotDuLivre(b, ev) {
  const m = (b.markets || []).find((x) => x.key === 'h2h');
  const o = (nom) => {
    const x = m && Array.isArray(m.outcomes) && m.outcomes.find((y) => y.name === nom);
    return x && Number(x.price) > 1 ? Number(x.price) : null;
  };
  const c = { 1: o(ev.home_team), N: o('Draw'), 2: o(ev.away_team) };
  return ISSUES.every((i) => c[i]) ? c : null;
}
const somme = (c) => ISSUES.reduce((t, i) => t + 1 / c[i], 0);
function sansMarge(c) {
  const p = cotes.probasImplicites(c, ISSUES, 1);
  return p && ISSUES.every((i) => p[i] > 0 && p[i] < 1) ? p : null;
}

/**
 * La reference d'une rencontre de la reponse `/odds`, ou null.
 * Rend { ref, p: {1,N,2}, livres, ecart } — `p` sans marge, somme 1.
 */
function referenceDe(ev) {
  const lots = [];
  let bourse = null, pin = null;
  for (const b of (ev && ev.bookmakers) || []) {
    const c = lotDuLivre(b, ev);
    if (!c) continue;
    const s = somme(c);
    if (b.key === BOURSE) { if (s >= 1.0 && s <= 1.06) bourse = sansMarge(c); continue; }
    if (b.key === PINNACLE && s >= 1.0 && s <= 1.08) pin = sansMarge(c);
    const p = s >= 1.0 ? sansMarge(c) : null;
    if (p) lots.push(p);
  }
  let med = null;
  if (lots.length >= 3) {
    med = {};
    for (const i of ISSUES) {
      const v = lots.map((p) => p[i]).sort((a, b) => a - b), k = Math.floor(v.length / 2);
      med[i] = v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
    }
    const t = ISSUES.reduce((a, i) => a + med[i], 0);
    for (const i of ISSUES) med[i] /= t;
  }
  const ecartDe = (p) => (med ? Math.max(...ISSUES.map((i) => Math.abs(p[i] - med[i]))) : 0);
  for (const [ref, p] of [['betfair', bourse], ['pinnacle', pin]]) {
    if (!p) continue;
    const e = ecartDe(p);
    if (e <= ECART_MAX) return { ref, p, livres: lots.length + (bourse ? 1 : 0), ecart: Math.round(e * 1000) / 1000 };
  }
  if (med) return { ref: 'mediane', p: med, livres: lots.length, ecart: 0 };
  return null;
}

// ------------------------------------------------------------ le carnet

const DOSSIER = (process.env.DATA_DIR || './data').trim();
function fichier() { return path.join(DOSSIER, 'paris_prix.json'); }
function lis() {
  try {
    const j = JSON.parse(fs.readFileSync(fichier(), 'utf8'));
    return { evenements: j.evenements || {}, ligues: j.ligues || {}, couverture: j.couverture || {} };
  } catch (e) { return { evenements: {}, ligues: {}, couverture: {} }; }
}
/* ---- LA LECTURE DE VENTE, GARDEE TANT QUE LE FICHIER NE CHANGE PAS ----
 * `pour` est appele pour CHAQUE rencontre de chaque import, et relisait puis
 * decodait tout le carnet a chaque fois. A dix-sept championnats (09/10/2026),
 * relecture contradictoire : 400 lectures d'un carnet de 750 rencontres,
 * 596 ms ou le serveur de jeux ne repond plus — a chaque import, soit apres
 * chaque releve. Remesure sur un carnet de 750 rencontres (149 Ko) : 400
 * lectures 580 ms avant, 13,5 ms avec la lecture gardee. On garde donc la
 * derniere lecture, invalidee par tout changement de date ou de taille du
 * fichier (une releve a la main, `node paris_import.js --prix`, l'ecrit d'un
 * autre processus) — et nos propres ecritures la renouvellent meme sur un volume
 * dont l'heure des fichiers est a la seconde. `note` et `lis` relisent
 * toujours le fichier : seule la vente passe par ici, et elle ne modifie rien
 * (`pour` rend une copie). */
let VU = null;
function luPourVendre() {
  let sig = 'absent';
  try { const st = fs.statSync(fichier()); sig = st.mtimeMs + ':' + st.size; } catch (e) { /* pas encore de carnet */ }
  if (!VU || VU.sig !== sig) VU = { sig, c: lis() };
  return VU.c;
}
/* Ecrit en deux temps (fichier temporaire puis renommage) : un volume plein
   ou une ecriture coupee ne laisse jamais un carnet a moitie ecrit. Rend
   false en cas d'echec — l'appelant garde alors la date en memoire, pour ne
   pas repayer le meme releve a chaque minuterie (relecture du 08/10). */
const MEMOIRE = {};
function ecris(c) {
  try {
    fs.mkdirSync(path.dirname(fichier()), { recursive: true });
    const tmp = fichier() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c) + '\n');
    fs.renameSync(tmp, fichier());
    VU = null;
    return true;
  } catch (e) {
    console.log('[odds] carnet des prix illisible ou plein : ' + (e.message || e));
    return false;
  }
}

/**
 * Noter la reponse `/odds` d'un championnat. Rend le compte par reference.
 * Garde dix jours d'historique : assez pour l'audit, pas un fichier qui
 * grossit sans fin.
 */
function note(evs, ligue, now) {
  const t = now || Date.now();
  const L = String(ligue || '');
  const c = lis();
  const compte = { betfair: 0, pinnacle: 0, mediane: 0, aucun: 0, retires: 0 };
  const vus = new Set();
  for (const ev of evs || []) {
    if (!ev || !ev.id) continue;
    const k = String(ev.id);
    vus.add(k);
    const r = referenceDe(ev);
    /* ---- UN MARCHE RETIRE N'A PLUS DE PRIX ----
     * Les livres retirent un 1-N-2 quand une nouvelle tombe (blessure, doute
     * sur la tenue du match) ; il disparait de la reponse. Garder l'ancien
     * prix, c'etait le vendre precisement quand il est faux (relecture du
     * 08/10). Sans reference, on EFFACE : la rencontre sera suspendue. */
    if (!r) { compte.aucun++; if (c.evenements[k]) { delete c.evenements[k]; compte.retires++; } continue; }
    compte[r.ref]++;
    const p = {};
    for (const i of ISSUES) p[i] = Math.round(r.p[i] * 1e5) / 1e5;
    /* Les equipes, pour verifier l'orientation a l'import : un prix colle a
       l'envers donnerait au favori la cote de l'outsider. */
    c.evenements[k] = { t, ref: r.ref, p, livres: r.livres, ecart: r.ecart, ligue: L,
                        dom: String(ev.home_team || ''), ext: String(ev.away_team || ''),
                        debut: Date.parse(ev.commence_time) || 0 };
  }
  /* Une rencontre a venir de ce championnat ABSENTE d'une reponse non vide :
     son marche a ete retire. Meme regle. */
  if (vus.size) {
    for (const [k, e] of Object.entries(c.evenements)) {
      if (e.ligue === L && !vus.has(k) && e.debut > t) { delete c.evenements[k]; compte.retires++; }
    }
  }
  c.ligues[L] = t;
  /* la couverture du dernier releve : de quoi juger un championnat observe */
  c.couverture[L] = Object.assign({ t: new Date(t).toISOString() }, compte);
  for (const [k, e] of Object.entries(c.evenements)) if (t - e.t > 10 * 86400000) delete c.evenements[k];
  /* La date ne vit en memoire QUE si l'ecriture a echoue. */
  if (ecris(c)) delete MEMOIRE[L]; else MEMOIRE[L] = t;
  return compte;
}

/** Le prix d'un evenement s'il est assez frais pour etre vendu, sinon null. */
function pour(evenement, now) {
  const e = luPourVendre().evenements[String(evenement || '')];
  if (!e) return null;
  /* une COPIE : la lecture est partagee entre toutes les rencontres */
  return (now || Date.now()) - e.t <= AGE_MAX_MS ? Object.assign({}, e, { p: Object.assign({}, e.p) }) : null;
}
/** Quand ce championnat a ete releve pour la derniere fois (0 si jamais) —
    la date ecrite, ou celle gardee en memoire si l'ecriture a echoue. */
function derniere(ligue) {
  const L = String(ligue || '');
  return Math.max(Number(luPourVendre().ligues[L]) || 0, MEMOIRE[L] || 0);
}

module.exports = { LIGUES_DEFAUT, ligues, observees, aRelever, releveMs, AGE_MAX_MS, ECART_MAX, referenceDe, note, pour, derniere, fichier, lis };
