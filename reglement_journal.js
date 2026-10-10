'use strict';
/*
 * LE JOURNAL DU REGLEMENT — CE QU'UNE PASSE PLUS FREQUENTE AURAIT REGLE, ET CE
 * QUE COUTE LE /scores PAYE (lot 4 de la cle 20K, 10/10/2026).
 *
 * Il ne decide RIEN et ne paie rien. Il garde, sur le volume, quatre choses
 * qu'aucun autre fichier ne garde :
 *
 *   ombre     pour chaque rencontre qu'ESPN rend « reglable » (la meme decision
 *             que la vraie passe, `trieReglements`), l'instant de la PREMIERE
 *             lecture reglable, puis chaque CORRECTION vue pendant les
 *             PARIS_SCORES_OMBRE_H heures suivantes : un score qui change, un
 *             statut qui change (FULL_TIME -> AET), une rencontre qui revient
 *             a un etat non fini, une rencontre qui disparait alors que son
 *             tableau a repondu. C'est la porte A (EXPLOITATION 8.10) : regler
 *             plus tot n'est permis que si ces corrections n'existent pas.
 *   passes    l'heure de chaque passe REELLE (la quotidienne, qui part aussi a
 *             chaque demarrage) : le gain d'une passe de 2 h se mesure contre
 *             elles, sur TOUTES les rencontres de l'ombre, pas seulement sur
 *             les deux qui portaient un pari le 09/10.
 *   scores    chaque /scores PAYE, horodate (fenetre glissante, pas de seaux
 *             mensuels) : credits lus dans x-requests-last (ou deduits de
 *             x-requests-used, sinon « indecidable »), statut, code d'erreur,
 *             rencontres rendues, finies, appariees. C'est la porte B.
 *   regles    l'heure et la source (auto / main) de chaque vrai reglement.
 *   annonces  la derniere annonce publique d'une rencontre « a la main » : la
 *             passe frequente ne la repostera pas dans les 24 h.
 *
 * ---- POURQUOI IL NE PEUT JAMAIS GENER LE REGLEMENT ----
 * Chaque fonction publique attrape ses propres erreurs et rend null : un
 * volume plein, un fichier illisible, un droit refuse ne font jamais perdre un
 * reglement ni une releve (les appelants isolent AUSSI chaque appel, et
 * reglement_cadence.test.js tient les deux). Ecrit en deux temps (temporaire
 * puis renommage, comme alerte_solde.js et le compteur du socle) : un
 * redeploiement pendant l'ecriture — 118 en 17 jours en septembre
 * (EXPLOITATION 8.3) — laisse l'ancien fichier ou le nouveau, jamais un JSON
 * coupe. Un contenu illisible est mis de cote (.illisible-<t>) et l'on repart
 * d'un journal vide ; une LECTURE refusee (droits) ne garde rien et se relit
 * au prochain appel, pour ne jamais ecraser un bon fichier par un vide.
 *
 * ---- BORNES ----
 * 45 jours et 5 000 entrees par table : une fenetre de 30 jours pour la porte
 * B, plus deux semaines de marge, sans grossir sans fin. L'ombre suit ~60
 * rencontres par jour (22 tableaux ESPN, calendrier du 09/10) : ~2 700 sur 45
 * jours. Jamais une cle ni une URL : seulement des cles de ligue et des
 * identifiants de NOS rencontres.
 */
const fs = require('fs');
const path = require('path');

const H = 3600000;
const JOUR = 24 * H;
const GARDE_JOURS = 45;
const MAX_PAR_TABLE = 5000;
/* Une annonce « a la main » se garde 48 h : la regle n'en lit que 24. */
const ANNONCE_GARDE_MS = 48 * H;
/* La derniere lecture NON reglable d'une rencontre (pour borner le gain) se
   garde 48 h : l'ombre ne lit que les rencontres de moins de 36 h. */
const ATTENTE_GARDE_MS = 48 * H;

let DOSSIER = null;
function fichier() { return path.join(DOSSIER || (process.env.DATA_DIR || './data').trim(), 'reglement_journal.json'); }
/* `murDepuis` : { min, t } — le mur (AUTO_DELAI_MIN + 110, en minutes) des
   passes de l'ombre, et depuis quand. Releve PARIS_AUTO_DELAI_MIN apres une
   correction (EXPLOITATION 8.10) : la porte A ne juge que les rencontres lues
   au mur COURANT, et ses jours repartent de son changement — sans cela elle
   restait fermee 45 jours par une correction vue a l'ancien mur (relecture
   du lot 4). */
function vide() { return { v: 1, debut: null, murDepuis: null, ombre: {}, attente: {}, passes: [], scores: [], regles: {}, annonces: {} }; }

let ETAT = null;
const DIT = { lecture: -Infinity, ecriture: -Infinity };
function dit(quoi, message) {
  const t = Date.now();
  if (t - DIT[quoi] < H && t >= DIT[quoi]) return;
  DIT[quoi] = t;
  console.log('[reglement] journal : ' + message);
}
const objet = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Pose le dossier (le serveur passe DATA_DIR) et oublie la memoire. */
function charge(dossier) {
  DOSSIER = dossier ? String(dossier) : null;
  ETAT = null;
  return fichier();
}
/** Pour les essais : oublier la memoire, comme un redemarrage. */
function oublie() { ETAT = null; DIT.lecture = -Infinity; DIT.ecriture = -Infinity; }

/** L'etat en memoire, lu une fois ; null si le fichier ne se LIT pas. */
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
    if (!objet(j) || j.v !== 1) throw new Error('forme inattendue');
    const st = vide();
    st.debut = Number(j.debut) || null;
    if (objet(j.murDepuis)) st.murDepuis = j.murDepuis;
    for (const k of ['ombre', 'attente', 'regles', 'annonces']) if (objet(j[k])) st[k] = j[k];
    for (const k of ['passes', 'scores']) if (Array.isArray(j[k])) st[k] = j[k];
    ETAT = st;
  } catch (e) {
    const aCote = fichier() + '.illisible-' + Date.now();
    try { fs.renameSync(fichier(), aCote); } catch (e2) { /* deja parti */ }
    console.log('[reglement] journal illisible (' + String(e.message || e).slice(0, 80) + '), mis de cote sous ' + path.basename(aCote) + ' — on repart d un journal vide');
    ETAT = vide();
  }
  return ETAT;
}

/* Les plus recents d'abord gardes : `cle` donne l'instant d'une entree. */
function borneObjet(o, cle, limite) {
  for (const [id, x] of Object.entries(o)) if (!(cle(x) >= limite)) delete o[id];
  const ids = Object.keys(o);
  if (ids.length > MAX_PAR_TABLE) {
    ids.sort((a, b) => cle(o[a]) - cle(o[b]));
    for (const id of ids.slice(0, ids.length - MAX_PAR_TABLE)) delete o[id];
  }
}
function purge(st, t) {
  const limite = t - GARDE_JOURS * JOUR;
  /* une entree qui n'est pas un objet (journal edite a la main) vaut 0 : elle
     part a la purge, au lieu de faire lever chaque ecriture a venir */
  borneObjet(st.ombre, (e) => Number(e && e.premierReglable) || 0, limite);
  borneObjet(st.attente, (x) => Number(x) || 0, t - ATTENTE_GARDE_MS);
  borneObjet(st.regles, (r) => Number(r && r.t) || 0, limite);
  borneObjet(st.annonces, (x) => Number(x) || 0, t - ANNONCE_GARDE_MS);
  st.passes = st.passes.filter((x) => Number(x) >= limite).sort((a, b) => a - b).slice(-MAX_PAR_TABLE);
  st.scores = st.scores.filter((x) => x && Number(x.t) >= limite).slice(-MAX_PAR_TABLE);
}
/** Ecrit en deux temps. Rend vrai si le fichier est a jour. */
function sauve(st, t) {
  try {
    purge(st, t);
    fs.mkdirSync(path.dirname(fichier()), { recursive: true });
    const tmp = fichier() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st) + '\n');
    fs.renameSync(tmp, fichier());
    return true;
  } catch (e) {
    dit('ecriture', 'ecriture impossible (' + ((e && (e.code || e.message)) || e) + ') — garde en memoire, reessaye a la prochaine note');
    return false;
  }
}
/* Toute note passe par ici : elle ne leve JAMAIS (voir l'en-tete). */
function note(t, fn) {
  try {
    const st = etat();
    if (!st) return null;
    if (!st.debut) st.debut = t;
    const r = fn(st);
    sauve(st, t);
    return r === undefined ? true : r;
  } catch (e) {
    dit('ecriture', 'note refusee (' + String((e && e.message) || e).slice(0, 80) + ')');
    return null;
  }
}

// ------------------------------------------------------------------ l'ombre

/**
 * Une passe de l'ombre : `lectures` = [{ id, sport, ligue, debut, avecParis,
 * lu, repondu, fini, score, resultat, aMain, statut, reglable }], toutes lues a
 * l'instant `t`. `o` = { ombreH, murMin } (murMin : l'age minimal d'une
 * rencontre reglable, AUTO_DELAI_MIN + 110). Rend { nouvelles, reglables,
 * corrections: [...nouvelles], closes } ou null.
 */
/* La lecture d'une rencontre deja dans l'ombre, contre ce qu'on en savait :
   { etat, lu, cause } — null si son tableau est muet (panne, refus, passe
   sautee) : rien ne se conclut. Chaque ecart se compte UNE fois : contre la
   derniere lecture finie pour le score et le statut, contre le dernier etat
   pour un retour ou une disparition. Une rencontre qui revient au meme score
   apres avoir disparu ne compte pas deux fois. */
function compare(l, avant, fin) {
  if (l.lu && l.fini) {
    const lu = { score: l.score || null, resultat: l.resultat || null, aMain: !!l.aMain, statut: l.statut || null };
    let cause = null;
    if (lu.score !== fin.score || lu.resultat !== fin.resultat) cause = 'score';
    else if (lu.aMain !== !!fin.aMain) cause = 'statut';
    return { etat: 'fini', lu, cause };
  }
  /* lue, mais plus finie (reprise, abandon, statut annule) */
  if (l.lu) return { etat: 'nonfini', lu: { score: l.score || null, statut: l.statut || null, aMain: false }, cause: avant.etat !== 'nonfini' ? 'retour' : null };
  /* son tableau a repondu, et elle n'y est plus */
  if (l.repondu) return { etat: 'absente', lu: { score: null, statut: null, aMain: false }, cause: avant.etat !== 'absente' ? 'disparue' : null };
  return null;
}

function noteOmbre(lectures, t, o) {
  const opts = o || {};
  const ombreMs = (Number(opts.ombreH) > 0 ? Number(opts.ombreH) : 24) * H;
  const murMs = (Number(opts.murMin) >= 0 ? Number(opts.murMin) : 200) * 60000;
  const murMin = murMs / 60000;
  return note(t, (st) => {
    const r = { nouvelles: 0, reglables: 0, corrections: [], closes: 0 };
    if (!objet(st.murDepuis) || Number(st.murDepuis.min) !== murMin) st.murDepuis = { min: murMin, t };
    for (const l of lectures || []) {
      if (!l || !l.id) continue;
      const id = String(l.id);
      if (l.reglable) r.reglables++;
      const e = st.ombre[id];
      if (!e) {
        if (!l.reglable) {
          /* pas encore reglable : on garde l'instant, il borne le gain */
          if (l.lu || l.repondu) st.attente[id] = t;
          continue;
        }
        /* La borne basse de l'instant ou elle est devenue reglable : la
           derniere lecture NON reglable, et jamais avant le mur de temps. */
        const debut = Number(l.debut) || 0;
        st.ombre[id] = {
          sport: String(l.sport || ''), ligue: String(l.ligue || ''), debut, murMin,
          avecParis: !!l.avecParis, premierReglable: t,
          borne: Math.max(Number(st.attente[id]) || 0, debut + murMs),
          alors: { score: l.score || null, resultat: l.resultat || null, aMain: !!l.aMain, statut: l.statut || null },
          dernierFini: { score: l.score || null, resultat: l.resultat || null, aMain: !!l.aMain, statut: l.statut || null },
          dernier: { t, etat: 'fini' },
          lectures: 1, plusGrandTrou: 0, muettes: 0, corrections: [],
        };
        delete st.attente[id];
        r.nouvelles++;
        continue;
      }
      if (e.clos) continue;
      const avant = e.dernier || {};
      const fin = e.dernierFini || e.alors || {};
      const x = compare(l, avant, fin);
      const corrige = (extra) => {
        const c = Object.assign({ t, cause: x.cause,
          avant: { etat: avant.etat || null, score: fin.score || null, aMain: !!fin.aMain, statut: fin.statut || null },
          apres: { etat: x.etat, score: x.lu.score || null, aMain: !!x.lu.aMain, statut: x.lu.statut || null } }, extra);
        if (!Array.isArray(e.corrections)) e.corrections = [];
        e.corrections.push(c);
        r.corrections.push(Object.assign({ id }, c));
      };
      /* ---- LA FIN DE LA FENETRE (relecture du lot 4) ----
       * Au-dela de la fenetre, la rencontre est close. Mais si sa derniere
       * vraie lecture est AVANT la fin de la fenetre (tableau muet sur les
       * dernieres heures, passe decalee par un redemarrage), la fin n'a pas
       * ete vue : (1) le temps entre cette lecture et la fin de la fenetre
       * est un TROU — sans cela, une panne des 8 dernieres heures donnait une
       * rencontre « suivie sans trou » ; (2) un ecart lu a la cloture a pu
       * tomber DANS la fenetre : il compte comme une correction (`cloture`),
       * par prudence — la porte A n'en tolere aucune. Une fin de fenetre
       * vue (lecture a premierReglable + 24 h pile) : un changement lu apres
       * n'est pas une correction de la fenetre. */
      if (t - e.premierReglable > ombreMs) {
        const finFen = e.premierReglable + ombreMs;
        const dernierT = Number(avant.t) || e.premierReglable;
        if (dernierT < finFen) {
          e.plusGrandTrou = Math.max(Number(e.plusGrandTrou) || 0, finFen - dernierT);
          if (x && x.cause) corrige({ cloture: true });
        }
        e.clos = t; r.closes++;
        continue;
      }
      if (l.avecParis) e.avecParis = true;
      /* tableau muet (panne, refus) : rien ne se conclut, le trou grandit */
      if (!x) { e.muettes = (Number(e.muettes) || 0) + 1; continue; }
      e.lectures = (Number(e.lectures) || 0) + 1;
      e.plusGrandTrou = Math.max(Number(e.plusGrandTrou) || 0, t - (Number(avant.t) || t));
      if (x.cause) corrige();
      if (x.etat === 'fini') e.dernierFini = x.lu;
      e.dernier = { t, etat: x.etat };
    }
    return r;
  });
}

/** Les rencontres encore dans leur fenetre de suivi (lues meme si elles ont plus de 36 h). */
function suivisEnCours(t, o) {
  try {
    const st = etat();
    if (!st) return [];
    const ombreMs = ((o && Number(o.ombreH) > 0) ? Number(o.ombreH) : 24) * H;
    const graceMs = ((o && Number(o.graceH) >= 0) ? Number(o.graceH) : 6) * H;
    return Object.keys(st.ombre).filter((id) => {
      const e = st.ombre[id];
      return objet(e) && !e.clos && t - e.premierReglable <= ombreMs + graceMs;
    });
  } catch (e) { return []; }
}

/** L'heure d'une passe REELLE (la quotidienne, demarrages compris). */
function notePasse(t) { return note(t, (st) => { st.passes.push(t); }); }

/** Un vrai reglement : `via` = 'auto' | 'main' ; `info` = { source, ligue } —
    la source d'un reglement automatique ('espn' ou 'scores' : le /scores paye
    de The Odds API), pour compter ce que CE chemin regle vraiment, cle par cle
    (porte B). Le premier seul compte. */
function noteRegle(id, t, score, via, info) {
  if (!id) return null;
  return note(t, (st) => {
    const k = String(id);
    if (st.regles[k]) return false;
    const i = info || {};
    st.regles[k] = { t, score: score == null ? null : String(score), via: via === 'main' ? 'main' : 'auto',
                     source: i.source ? String(i.source) : null, ligue: i.ligue ? String(i.ligue) : null };
    return true;
  });
}

// ------------------------------------------------------- le canal public

/** Annoncee « a la main » dans les `fenetreMs` (24 h par defaut) ? */
function annonceRecente(id, t, fenetreMs) {
  try {
    const st = etat();
    if (!st) return false;
    const a = Number(st.annonces[String(id)]);
    return a > 0 && t - a >= 0 && t - a < (Number(fenetreMs) > 0 ? Number(fenetreMs) : 24 * H);
  } catch (e) { return false; }
}
function noteAnnonces(ids, t) {
  if (!ids || !ids.length) return true;
  return note(t, (st) => { for (const id of ids) st.annonces[String(id)] = t; });
}

// ------------------------------------------------------------ les /scores

/**
 * Un /scores PAYE (appel autorise par le garde-fou, ou refuse par lui) :
 * `x` = { t, cout (x-requests-last, null si inconnu), statut, code, rendus,
 * finies, appariees, vieux (une rencontre declencheuse a plus de
 * AUTO_DELAI_MIN + 110 min), declencheurs, ageMaxMin }. Rend l'entree.
 */
function noteAppelScores(clef, x) {
  const t = Number(x && x.t) || Date.now();
  return note(t, (st) => {
    const nb = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
    const e = {
      t, clef: String(clef),
      cout: nb(x.cout), statut: nb(x.statut), code: x.code ? String(x.code).slice(0, 40) : null,
      rendus: Number(x.rendus) || 0, finies: Number(x.finies) || 0, appariees: Number(x.appariees) || 0,
      vieux: !!x.vieux, declencheurs: Number(x.declencheurs) || 0,
      ageMaxMin: nb(x.ageMaxMin),
    };
    st.scores.push(e);
    return e;
  });
}
/** Le cout d'un appel sans en-tete, deduit plus tard (`cout` >= 0), ou declare indecidable (`cout` null). */
function deduitCout(entree, cout, comment) {
  if (!entree) return null;
  return note(Date.now(), (st) => {
    const e = st.scores.find((s) => s.t === entree.t && s.clef === entree.clef);
    if (!e) return false;
    if (cout === null || cout === undefined) { e.indecidable = true; delete e.coutDeduit; }
    else { e.coutDeduit = Number(cout); e.deduitPar = String(comment || ''); delete e.indecidable; }
    return true;
  });
}

// --------------------------------------------------------------- le bilan

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
const enH = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / H * 100) / 100);
function stats(xs) {
  return { n: xs.length, medianeH: enH(quantile(xs, 0.5)), p90H: enH(quantile(xs, 0.9)) };
}
/** Le cout qui compte pour une entree : lu, sinon deduit, sinon null. */
function coutDe(e) {
  if (e.cout !== null && e.cout !== undefined) return Number(e.cout);
  if (e.coutDeduit !== null && e.coutDeduit !== undefined) return Number(e.coutDeduit);
  return null;
}
/* L'appel n'a rien rendu d'utile, et il a ete paye pour une rencontre assez
   vieille pour etre reglee : c'est la seule « inutilite » qu'une coupe peut
   economiser (un appel pour un match en cours est « precoce », pas inutile). */
function genre(e) {
  if (e.code === 'REFUSE') return 'refuse';
  if (e.statut === null && e.code !== 'DELAI') return 'reseau';
  const c = coutDe(e);
  if (c === null) return e.indecidable ? 'indecidable' : 'inconnu';
  if (!(c > 0)) return 'gratuit';
  if (e.appariees > 0) return 'utile';
  return e.vieux ? 'inutile' : 'precoce';
}

/** Les /scores d'une cle sur les `jours` derniers jours (fenetre glissante). */
function bilanScores(t, jours) {
  const st = (() => { try { return etat(); } catch (e) { return null; } })();
  const out = {};
  if (!st) return out;
  const depuis = t - (Number(jours) > 0 ? Number(jours) : 30) * JOUR;
  for (const e of st.scores) {
    if (!e || !(e.t >= depuis) || e.t > t) continue;
    const b = out[e.clef] || (out[e.clef] = { appels: 0, reponses: 0, payes: 0, credits: 0, inconnus: 0, deduits: 0, indecidables: 0,
      refuses: 0, reseau: 0, delais: 0, gratuits: 0, rendus: 0, finies: 0, appariees: 0, inutiles: 0, precoces: 0, utiles: 0,
      creditsInutiles: 0, creditsPrecoces: 0,
      statuts: {}, codes: {}, dernier: null });
    const g = genre(e);
    if (g === 'refuse') { b.refuses++; b.dernier = Math.max(b.dernier || 0, e.t); continue; }
    b.appels++;
    if (e.statut !== null) { b.reponses++; const s = String(e.statut); b.statuts[s] = (b.statuts[s] || 0) + 1; }
    if (e.code === 'DELAI') b.delais++;
    if (e.code && e.code !== 'DELAI') b.codes[e.code] = (b.codes[e.code] || 0) + 1;
    if (g === 'reseau') b.reseau++;
    const c = coutDe(e);
    if (c !== null && c > 0) { b.payes++; b.credits += c; }
    if (e.cout === null && e.coutDeduit !== undefined && e.coutDeduit !== null) b.deduits++;
    if (g === 'inconnu') b.inconnus++;
    if (g === 'indecidable') b.indecidables++;
    if (g === 'gratuit') b.gratuits++;
    if (g === 'utile') b.utiles++;
    if (g === 'inutile') { b.inutiles++; b.creditsInutiles += c; }
    if (g === 'precoce') { b.precoces++; b.creditsPrecoces += c; }
    b.rendus += e.rendus; b.finies += e.finies; b.appariees += e.appariees;
    b.dernier = Math.max(b.dernier || 0, e.t);
  }
  for (const b of Object.values(out)) b.dernier = b.dernier ? new Date(b.dernier).toISOString() : null;
  return out;
}

/**
 * Les chiffres bruts, sans verdict (les portes sont dans paris_import, qui
 * connait les seuils) : `o` = { ombreH, cadenceH, fenetreJours, murMin }.
 * `murMin` (le mur courant) : l'ombre ne compte que les rencontres lues a ce
 * mur (les autres : `autreMur`), et ses `jours` partent de son changement.
 */
function resume(now, o) {
  const t = Number(now) || Date.now();
  const opts = o || {};
  const st = (() => { try { return etat(); } catch (e) { return null; } })();
  if (!st) return { lisible: false, fichier: path.basename(fichier()) };
  const ombreMs = (Number(opts.ombreH) > 0 ? Number(opts.ombreH) : 24) * H;
  /* « Sans trou » = jamais plus de TROIS cadences (6 h) entre deux lectures.
     Une DECISION du lot 4, pas une mesure : une correction qui dure se voit
     a la lecture suivante, quelle que soit la cadence ; un etat passager de
     moins de 6 h (un score saisi puis corrige) peut echapper a trois passes
     manquees, et c'est exactement ce que la porte A doit voir. La duree des
     etats passagers d'ESPN n'est pas mesuree : si l'ombre en montre un, la
     mesurer avant de toucher ce seuil. */
  const trouMax = 3 * (Number(opts.cadenceH) > 0 ? Number(opts.cadenceH) : 2) * H;
  const murCourant = opts.murMin === null || opts.murMin === undefined || !isFinite(Number(opts.murMin)) ? null : Number(opts.murMin);
  const passes = st.passes.slice().sort((a, b) => a - b);
  const apres = (x, strict) => passes.find((p) => (strict ? p > x : p >= x));

  /* Les jours d'ombre AU MUR COURANT : depuis son premier passage, ou depuis
     le debut du journal s'il n'a pas de trace de mur (aucune passe d'ombre
     encore). Un mur configure que l'ombre n'a pas encore lu : 0 jour. */
  const md = objet(st.murDepuis) ? st.murDepuis : null;
  const joursDe = (x) => Math.max(0, Math.floor((t - x) / JOUR));
  const joursOmbre = murCourant === null || !md ? (st.debut ? joursDe(st.debut) : 0)
    : Number(md.min) === murCourant ? joursDe(Number(md.t) || t) : 0;
  const ombre = { suivies: 0, suiviesSansTrou: 0, enCours: 0, abandonnees: 0, avecCorrection: 0, corrections: [],
                  jours: joursOmbre, murMin: murCourant, autreMur: 0,
                  gain: { tous: null, parSport: {} }, controle: { auto: null, main: null } };
  const bas = { tous: [] }, haut = { tous: [] }, enAttente = { tous: 0 };
  const ctrl = { auto: [], main: [] };
  for (const [id, e] of Object.entries(st.ombre)) {
    if (!objet(e)) continue;
    if (murCourant !== null && e.murMin !== undefined && e.murMin !== null && Number(e.murMin) !== murCourant) { ombre.autreMur++; continue; }
    if (e.clos) {
      ombre.suivies++;
      if ((Number(e.plusGrandTrou) || 0) <= trouMax) ombre.suiviesSansTrou++;
    } else if (t - e.premierReglable > ombreMs + 6 * H) ombre.abandonnees++;
    else ombre.enCours++;
    if ((e.corrections || []).length) {
      ombre.avecCorrection++;
      for (const c of e.corrections) ombre.corrections.push(Object.assign({ id, sport: e.sport, ligue: e.ligue }, c));
    }
    /* LE GAIN CONTREFACTUEL. Haut : la prochaine passe reelle a partir de la
       premiere lecture reglable, moins cette lecture. Bas : si une passe reelle
       est tombee entre la borne (la derniere lecture NON reglable, jamais avant
       le mur des 200 min, bornes comprises) et elle, on suppose qu'elle a
       regle (gain 0) — l'ombre ne lit que toutes les 2 h, l'instant reel ou
       la rencontre est devenue reglable est quelque part entre les deux. */
    const s = e.sport || '?';
    for (const tab of [bas, haut]) if (!tab[s]) tab[s] = [];
    if (enAttente[s] === undefined) enAttente[s] = 0;
    const tB = apres(Number(e.borne) || 0, false), tH = apres(e.premierReglable, false);
    if (tH === undefined || tB === undefined) { enAttente.tous++; enAttente[s]++; }
    else {
      const gB = tB < e.premierReglable ? 0 : tB - e.premierReglable;
      bas.tous.push(gB); bas[s].push(gB);
      haut.tous.push(tH - e.premierReglable); haut[s].push(tH - e.premierReglable);
    }
    const r = st.regles[id];
    if (r && e.avecParis) ctrl[r.via === 'main' ? 'main' : 'auto'].push(r.t - e.premierReglable);
  }
  ombre.corrections.sort((a, b) => b.t - a.t);
  ombre.corrections = ombre.corrections.slice(0, 20);
  const gain = (k) => {
    const b = stats(bas[k] || []), h = stats(haut[k] || []);
    return { n: b.n, enAttente: enAttente[k] || 0, medianeBasH: b.medianeH, p90BasH: b.p90H, medianeHautH: h.medianeH, p90HautH: h.p90H };
  };
  ombre.gain.tous = gain('tous');
  for (const k of Object.keys(bas)) if (k !== 'tous') ombre.gain.parSport[k] = gain(k);
  ombre.controle.auto = stats(ctrl.auto);
  ombre.controle.main = stats(ctrl.main);

  const fen = Number(opts.fenetreJours) > 0 ? Number(opts.fenetreJours) : 30;
  const parMois = {};
  for (const e of st.scores) {
    const k = new Date(e.t).toISOString().slice(0, 7) + '|' + e.clef;
    const g = genre(e);
    if (g === 'refuse') continue;
    const m = parMois[k] || (parMois[k] = { appels: 0, credits: 0, appariees: 0, inutiles: 0, precoces: 0, indecidables: 0 });
    m.appels++;
    const c = coutDe(e);
    if (c !== null && c > 0) m.credits += c;
    m.appariees += e.appariees;
    if (g === 'inutile') m.inutiles++;
    if (g === 'precoce') m.precoces++;
    if (g === 'indecidable' || g === 'inconnu') m.indecidables++;
  }
  /* Les vrais reglements, par chemin : ce que le /scores paye regle
     REELLEMENT, cle par cle, sur la fenetre de la porte B. */
  const regles = { n: 0, main: 0, auto: { espn: 0, scores: 0, autre: 0 } };
  const regleesParClef = {};
  for (const r of Object.values(st.regles)) {
    regles.n++;
    if (r.via === 'main') { regles.main++; continue; }
    if (r.source === 'espn') regles.auto.espn++;
    else if (r.source === 'scores') {
      regles.auto.scores++;
      if (r.ligue && Number(r.t) >= t - fen * JOUR) regleesParClef[r.ligue] = (regleesParClef[r.ligue] || 0) + 1;
    } else regles.auto.autre++;
  }
  return {
    lisible: true, fichier: path.basename(fichier()),
    depuis: st.debut ? new Date(st.debut).toISOString() : null,
    jours: st.debut ? Math.floor((t - st.debut) / JOUR) : 0,
    ombre,
    passes: { n: passes.length, derniere: passes.length ? new Date(passes[passes.length - 1]).toISOString() : null },
    regles,
    scores: { fenetreJours: fen, parClef: bilanScores(t, fen), parMois, regleesParClef },
  };
}

/** Pour les essais et la ligne de commande : le contenu brut (une copie). */
function brut() {
  try { const st = etat(); return st ? JSON.parse(JSON.stringify(st)) : null; } catch (e) { return null; }
}

module.exports = { charge, oublie, fichier, noteOmbre, suivisEnCours, notePasse, noteRegle, annonceRecente, noteAnnonces,
                   noteAppelScores, deduitCout, bilanScores, resume, brut, genre, quantile,
                   GARDE_JOURS, MAX_PAR_TABLE };
