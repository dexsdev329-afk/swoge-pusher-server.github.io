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

/* Les six grands championnats, ceux ou l'argent se pose et ou l'Elo perd le
   plus. `PARIS_PRIX_LIGUES` vide COUPE tout (retour a l'Elo partout). */
const LIGUES_DEFAUT = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_champs_league'];
function ligues() {
  const v = process.env.PARIS_PRIX_LIGUES;
  if (v === undefined) return new Set(LIGUES_DEFAUT);
  return new Set(String(v).split(',').map((x) => x.trim()).filter(Boolean));
}

/* Au-dela, le prix ne se vend plus : la rencontre est SUSPENDUE, jamais
   rendue a l'Elo en silence — a l'import ET a la vente (paris.ouvert, qui lit
   la meme variable). 36 h = le releve quotidien (22 h) plus quatorze heures de
   marge ; un releve refuse par la part du jour ne l'atteint pas, la releve
   des prix passant en PRIORITE dans le garde-fou (paris_import.autorise). */
const AGE_MAX_MS = (Number(process.env.PARIS_PRIX_AGE_MAX_H) || 36) * 3600000;
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
    return { evenements: j.evenements || {}, ligues: j.ligues || {} };
  } catch (e) { return { evenements: {}, ligues: {} }; }
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
  for (const [k, e] of Object.entries(c.evenements)) if (t - e.t > 10 * 86400000) delete c.evenements[k];
  /* La date ne vit en memoire QUE si l'ecriture a echoue. */
  if (ecris(c)) delete MEMOIRE[L]; else MEMOIRE[L] = t;
  return compte;
}

/** Le prix d'un evenement s'il est assez frais pour etre vendu, sinon null. */
function pour(evenement, now) {
  const e = lis().evenements[String(evenement || '')];
  if (!e) return null;
  return (now || Date.now()) - e.t <= AGE_MAX_MS ? e : null;
}
/** Quand ce championnat a ete releve pour la derniere fois (0 si jamais) —
    la date ecrite, ou celle gardee en memoire si l'ecriture a echoue. */
function derniere(ligue) {
  const L = String(ligue || '');
  return Math.max(Number(lis().ligues[L]) || 0, MEMOIRE[L] || 0);
}

module.exports = { LIGUES_DEFAUT, ligues, AGE_MAX_MS, ECART_MAX, referenceDe, note, pour, derniere, fichier, lis };
