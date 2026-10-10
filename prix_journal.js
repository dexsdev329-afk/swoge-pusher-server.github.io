'use strict';
/*
 * LE JOURNAL DES RELEVES DEJA PAYEES (lot 1 de la cle 20K, 10/10/2026).
 *
 * ---- pourquoi ----
 *
 * La cadence du prix du marche (PARIS_PRIX_RELEVE_H=2) n'a jamais ete jugee
 * sur une mesure de l'AGE du prix. 8.8bis ne mesure que deux points : le prix
 * « frais » (0 a 2 issues battables sur 471) et le prix « vieux de 1 a 4
 * jours » (16,7 % des rencontres avec un choix gagnant, 568 rencontres). Entre
 * les deux, rien : on ne sait pas ce que coute un prix de 2 h 30 (la cadence
 * reelle, voir plus bas), ni ce que couterait un prix de 12 h loin des matchs,
 * ni ce que rapporterait une releve de 30 min pres du coup d'envoi. Or
 * `prix_marche.note` ECRASE le prix precedent de chaque rencontre : la suite
 * des prix deja payes (un credit chacun) etait jetee a chaque releve.
 *
 * Ce module la garde, a ZERO credit : il s'abonne au crochet `apresNote` du
 * socle et ecrit, pour chaque reponse `/odds` notee, une ligne JSON dans
 * `$DATA_DIR/paris_prix_journal/AAAA-MM-JJ.jsonl` (jour UTC de la releve). Il
 * n'ajoute aucun appel, ne lit rien de ce que la vente lit, et ne decide rien :
 * la mesure (paires d'ages, cotes vendues, intervalles, portes G1/G2) se fait
 * HORS du serveur, par `outils/age_prix.js`, sur les fichiers figes par
 * `--telecharge` (route admin /paris/journal-prix). Une definition fausse se
 * recalcule donc sur tout le brut garde ; un bilan cumule dans le serveur ne
 * l'aurait pas permis (critique du plan, 09/10).
 *
 * LA CADENCE REELLE EST D'ENVIRON 2 H 30, PAS 2 H. `note` date la releve au
 * RETOUR du fetch (prix_marche.js, `t = now || Date.now()`), et
 * `prixPerimes` exige un age >= 2 h a chaque tic de 30 min : a 2 h pile,
 * l'age vaut 2 h moins la latence, la releve saute ce tic et part au suivant.
 * Simulation du plan (calendrier public du 09/10, latence 0,2 a 3 s) : 4 674
 * releves periodiques et 276 d'avant-match par mois, et non 6 120 + 520. Le
 * journal le dira en vrai (lignes par cause, ecarts entre releves).
 *
 * ---- ce qu'il ecrit (format v1) ----
 *
 * Une ligne par note() :
 *   { v:1, m:'h2h', t, l, q, c, av, am, n, o?, s?, ko?, e:[...] }
 *   t   date de la releve (ms), celle du carnet
 *   l   cle du championnat ; q la cause (periodique, avant, demande,
 *       demarrage, etalonnage, a la main)
 *   c, av, am  le REGIME de releve et de vente en vigueur, lu a chaque ligne :
 *       c = releveMs en minutes (PARIS_PRIX_RELEVE_H) ; av = 1 si
 *       PARIS_PRIX_AVANT_TOUS=1 (le meme test que `prixAvantMatch`, relu a
 *       chaque tic), sinon 0 ; am = l'age maximal de vente en minutes
 *       (prix_marche.AGE_MAX_MS, PARIS_PRIX_AGE_MAX_H, la meme variable que
 *       paris.AGE_PRIX_MS). Un changement de l'un des trois remet j0 : l'outil
 *       ne garde que la derniere serie a regime constant. `av` cree a lui seul
 *       les releves a moins de 3 h des rencontres sans pari (la cellule de
 *       G2) ; `am` borne les paires de l'outil, qui le lit ICI et non dans
 *       l'environnement de la machine qui mesure (relecture du lot 1, 10/10)
 *   n   rencontres de la reponse (avec un id) ; n = 0 : reponse vide
 *   o   1 pour un championnat observe, non vendu ; s le sport s'il est dit ;
 *       ko 1 si le carnet n'a PAS pu etre ecrit (le prix vendu n'a pas change)
 *   e   une entree par rencontre dont le coup d'envoi tombe avant
 *       t + horizon du catalogue (ODDS_API_HORIZON, 7 j) + 1 jour :
 *         [id, debut, 'x']                       sans reference (effacee du carnet)
 *         [id, debut, ref, pv, b, p, md, livres, luB, luP]
 *       ref = b (betfair) | p (pinnacle) | m (mediane), la reference VENDUE ;
 *       pv  = le prix vendu [1, N, 2], celui du carnet (arrondi 1e-5) ;
 *       b, p, md = les trois prix disponibles (null si absent), calcules par
 *       `prix_marche.referenceDe` lui-meme sur un seul livre (b, p) ou sur les
 *       livres ordinaires (md) — le meme code que la vente, aucune copie ;
 *       luB, luP = `last_update` du marche h2h de Betfair / Pinnacle (ms), s'il
 *       existe : l'age du prix de reference lui-meme.
 *
 * Le filtre d'horizon : « bookmakers may begin listing new season events a few
 * months in advance » (https://the-odds-api.com/liveapi/guides/v4/) ; sans
 * lui, le journal gonflerait de rencontres jamais vendues. Elles restent
 * comptees dans n.
 *
 * ---- l'index de cloture ----
 *
 * `$DATA_DIR/paris_prix_clotures.json` : pour chaque rencontre, la DERNIERE
 * observation d'avant-match (debut - t > 5 min) et l'avant-derniere, ecrit en
 * deux temps (temporaire propre au processus, puis renommage). Il sert la CLV
 * (lot 2) et la derive des coupes (lot 6) : un seul ecrivain, hors du carnet
 * de vente. `cloturesDe(lignes)` le refait a partir du journal brut (meme
 * contenu, essai T14) : un index qui ne se decode pas est mis de cote
 * (renomme `.illisible-<t>`, trois gardes, dit au journal de l'hote ; lot 2)
 * et repart de la releve en cours ; une lecture refusee (EIO...) saute la
 * releve sans rien ecraser. Le brut garde de quoi le refaire hors serveur.
 *
 * Il se relit et se reecrit en ENTIER a chaque releve, dans le processus qui
 * vend : il ne garde donc que les rencontres dont le coup d'envoi a moins de
 * CLOTURE_JOURS (7) jours. Banc du 10/10 (calendrier public du 09/10 : 203
 * rencontres de football en 6,96 jours, 29 par jour ; index de [t - X j ;
 * t + 8 j]) : retention 30 j = 1 108 rencontres, 451 Ko, 15,3 ms par releve
 * (max 24 ms) ; 7 j = 438 rencontres, 178 Ko, 6,1 ms (max 12 ms) ; 3 j =
 * 321, 4,6 ms. Soit ~1 s par jour au lieu de ~2,5 s a ~165 releves. Les 7
 * jours sont une DEFINITION, pas une mesure : la CLV (lot 2) fige la cloture
 * au reglement, que la releve quotidienne des scores fait en 24 h et qu'un
 * AET/PEN attend a la main — une semaine sans passage du proprietaire.
 *
 * ---- garde-fous ----
 *
 * - Rien ici ne leve vers `note` : le crochet du socle l'enferme deja dans un
 *   try/catch, et chaque ecriture a le sien. Un volume plein n'empeche ni le
 *   carnet, ni la vente (essai T5).
 * - Brut garde PARIS_PRIX_JOURNAL_J jours (30 par defaut, borne 3 a 60), purge
 *   au plus une fois par heure. Volume : prototype du plan, 204 lignes et
 *   260 Ko par jour a 2 h exactes (~165 lignes a la cadence reelle) ; banc
 *   pessimiste du 10/10 (170 lignes de 12 rencontres, trois sources chacune) :
 *   400 Ko par jour, 12 Mo pour 30 jours.
 * - PARIS_PRIX_JOURNAL=0 coupe l'ecriture : c'est le retour arriere. Vide (le
 *   defaut), le journal s'ecrit. Ni la vente, ni la cadence, ni les credits ne
 *   dependent de lui.
 * - Les lignes par cause se comptent sur le DISQUE (`etat`), jamais en
 *   memoire : 118 redeploiements en 17 jours (septembre) remettraient un
 *   compteur a zero. Seuls les echecs d'ecriture sont comptes en memoire (un
 *   disque qui refuse ne peut pas les garder).
 * - Le journal ne contient ni cle ni URL d'appel : la reponse brute n'y entre
 *   pas, seulement des probabilites, des dates et des cles de championnat.
 *
 * Commentaires sans accents (convention de prix_marche.js).
 */
const fs = require('fs');
const path = require('path');
const pm = require('./prix_marche');

const V = 1;
const MINUTE = 60000, HEURE = 3600000, JOUR = 86400000;
/* Une observation a moins de 5 min du coup d'envoi n'entre pas dans l'index
   de cloture : la releve du tic de 10 min peut tomber sur le coup d'envoi, et
   un prix pris a la seconde ou le match commence n'est plus un prix d'avant
   (plan corrige du lot 1). */
const AVANT_CLOTURE_MS = 5 * MINUTE;
/* L'index de cloture garde 7 jours apres le coup d'envoi (voir l'en-tete :
   le cout mesure, et pourquoi 7). */
const CLOTURE_JOURS = 7;
const JOURS_DEFAUT = 30, JOURS_MIN = 3, JOURS_MAX = 60;
const FICHIER_JOUR = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const REF_COURTE = { betfair: 'b', pinnacle: 'p', mediane: 'm' };

/* Le meme dossier que le carnet (`paris_prix.json`) : le volume Railway. */
function base() { return path.dirname(pm.fichier()); }
function dossier() { return path.join(base(), 'paris_prix_journal'); }
function fichierClotures() { return path.join(base(), 'paris_prix_clotures.json'); }
/** Le journal s'ecrit sauf PARIS_PRIX_JOURNAL=0 (retour arriere). */
function actif() { return String(process.env.PARIS_PRIX_JOURNAL === undefined ? '' : process.env.PARIS_PRIX_JOURNAL).trim() !== '0'; }
/* Borne 3 a 60 : une valeur folle ne fait pas grossir le volume sans fin, et
   3 jours au moins gardent la fenetre D-3..D que l'outil exige d'un jour
   « complet ». 30 par defaut (decision du plan corrige : la mesure se refait
   sur le brut, qu'il faut donc garder au-dela des 14 jours de la porte). */
function joursGardes() {
  const n = Math.floor(Number(process.env.PARIS_PRIX_JOURNAL_J));
  return Math.min(JOURS_MAX, Math.max(JOURS_MIN, isFinite(n) && n > 0 ? n : JOURS_DEFAUT));
}
/* L'horizon du catalogue (paris_import : ODDS_API_HORIZON, 7 j) plus un jour. */
function horizonMs() {
  const h = Number(process.env.ODDS_API_HORIZON || 7);
  return ((isFinite(h) && h > 0 ? h : 7) + 1) * JOUR;
}
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const trois = (p) => (p ? [r5(p['1']), r5(p.N), r5(p['2'])] : null);

// ------------------------------------------------------------ la ligne

/* Le `last_update` du marche h2h d'un livre (a defaut, celui du livre). */
function luDe(livre) {
  if (!livre) return null;
  const m = (livre.markets || []).find((x) => x && x.key === 'h2h');
  const t = Date.parse((m && m.last_update) || livre.last_update || '');
  return isFinite(t) ? t : null;
}
/* Les trois prix disponibles d'une rencontre, par `referenceDe` LUI-MEME :
   - Betfair seul : la bourse si sa somme d'inverses est saine ;
   - Pinnacle seul : Pinnacle si la sienne l'est ;
   - la mediane : les livres ordinaires ET Pinnacle (comme dans referenceDe,
     ou Pinnacle compte aussi parmi les livres), Betfair exclu, Pinnacle
     renomme pour n'etre pas reconnu comme reference.
   Aucune borne recopiee : si la vente change ses regles, le journal suit. */
function sourcesDe(ev) {
  const livres = (ev && Array.isArray(ev.bookmakers)) ? ev.bookmakers : [];
  const seul = (cle) => {
    const lv = livres.find((b) => b && b.key === cle);
    if (!lv) return { p: null, lu: null };
    const r = pm.referenceDe(Object.assign({}, ev, { bookmakers: [lv] }));
    return { p: r ? r.p : null, lu: r ? luDe(lv) : null };
  };
  const b = seul(pm.BOURSE), p = seul('pinnacle');
  const ordinaires = livres.filter((x) => x && x.key !== pm.BOURSE)
    .map((x) => (x.key === 'pinnacle' ? Object.assign({}, x, { key: 'pinnacle#livre' }) : x));
  const rm = pm.referenceDe(Object.assign({}, ev, { bookmakers: ordinaires }));
  return { b: b.p, p: p.p, md: rm && rm.ref === 'mediane' ? rm.p : null, luB: b.lu, luP: p.lu };
}

/** La ligne v1 d'une releve, a partir de ce que le crochet `apresNote` donne. */
function ligneDe(fait, now) {
  const t = Number(fait.t) || Number(now) || Date.now();
  const L = String(fait.ligue || '');
  const parId = new Map();
  for (const ev of fait.evs || []) if (ev && ev.id && !parId.has(String(ev.id))) parId.set(String(ev.id), ev);
  const limite = t + horizonMs();
  const e = [];
  for (const r of fait.refs || []) {
    const debut = Number(r.debut) || 0;
    if (debut > limite) continue;
    if (!r.ref || !r.p) { e.push([String(r.id), debut, 'x']); continue; }
    const s = sourcesDe(parId.get(String(r.id)));
    e.push([String(r.id), debut, REF_COURTE[r.ref] || String(r.ref), trois(r.p), trois(s.b), trois(s.p), trois(s.md),
            Number(r.livres) || 0, s.luB, s.luP]);
  }
  const ligne = { v: V, m: 'h2h', t, l: L, q: fait.quoi === null || fait.quoi === undefined ? '' : String(fait.quoi),
                  c: Math.round(pm.releveMs() / MINUTE), av: process.env.PARIS_PRIX_AVANT_TOUS === '1' ? 1 : 0,
                  am: Math.round(pm.AGE_MAX_MS / MINUTE), n: (fait.refs || []).length };
  if (!pm.ligues().has(L)) ligne.o = 1;
  if (fait.sport !== null && fait.sport !== undefined) ligne.s = String(fait.sport);
  if (fait.ecrit === false) ligne.ko = 1;
  ligne.e = e;
  return ligne;
}

// ------------------------------------------------------------ l'ecriture

const ETAT = { echecs: { journal: 0, clotures: 0 }, dernierEchec: null, dit: -Infinity, purge: -Infinity, ditIndex: false };
/* Une erreur dite au plus une fois par heure (date de la releve) : un volume
   plein ne doit pas noyer le journal de l'hote d'une ligne par releve. */
function echec(quoi, e, t) {
  ETAT.echecs[quoi] = (ETAT.echecs[quoi] || 0) + 1;
  const quand = Number(t) || Date.now();
  ETAT.dernierEchec = { quand: new Date(quand).toISOString(), quoi, message: String((e && e.message) || e).slice(0, 200) };
  if (!(quand - ETAT.dit < HEURE && quand >= ETAT.dit)) {
    ETAT.dit = quand;
    console.log('[odds] journal des prix : ' + quoi + ' impossible a ecrire (' + ETAT.dernierEchec.message + ') — la vente continue, rien n est perdu du carnet');
  }
}
/* La purge : au plus une fois par heure, les fichiers de plus de
   `joursGardes()` jours (le jour de la releve compte pour un). */
function purge(t) {
  if (t - ETAT.purge < HEURE && t >= ETAT.purge) return;
  ETAT.purge = t;
  try {
    const garde = jourDe(t - (joursGardes() - 1) * JOUR);
    for (const f of fs.readdirSync(dossier())) {
      const m = f.match(FICHIER_JOUR);
      if (m && m[1] < garde) fs.unlinkSync(path.join(dossier(), f));
    }
  } catch (e) { echec('purge', e, t); }
}
/** Ajoute une ligne au fichier de son jour. Rend vrai/faux, ne leve JAMAIS. */
function ecrit(ligne) {
  try {
    fs.mkdirSync(dossier(), { recursive: true });
    fs.appendFileSync(path.join(dossier(), jourDe(ligne.t) + '.jsonl'), JSON.stringify(ligne) + '\n');
  } catch (e) { echec('journal', e, ligne && ligne.t); return false; }
  purge(ligne.t);
  return true;
}

/* L'index de cloture : la derniere observation d'avant-match de chaque
   rencontre, et l'avant-derniere. Une observation = [t, q, ref, pv, b, p, md,
   livres, luB, luP] (les champs de l'entree, precedes de la date et de la
   cause). Les rencontres dont le coup d'envoi a plus de CLOTURE_JOURS jours
   sortent. `ajouteCloture` est la regle, en memoire (le serveur ET
   `cloturesDe`) ; rend vrai si l'index a change. */
function ajouteCloture(idx, ligne) {
  let change = false;
  for (const x of ligne.e || []) {
    const id = x[0], debut = x[1];
    if (!(debut - ligne.t > AVANT_CLOTURE_MS)) continue;
    const obs = [ligne.t, ligne.q].concat(x.slice(2));
    const cur = idx.ev[id];
    if (!cur || !Array.isArray(cur.d)) {
      idx.ev[id] = { l: ligne.l, debut, d: obs, a: null };
      if (ligne.o) idx.ev[id].o = 1;
      change = true;
    } else if (obs[0] > cur.d[0]) {
      cur.a = cur.d; cur.d = obs; cur.debut = debut; change = true;
    } else if (obs[0] < cur.d[0] && (!cur.a || obs[0] > cur.a[0])) {
      cur.a = obs; change = true;    // une ligne arrivee en retard (deux processus)
    }
  }
  const limite = ligne.t - CLOTURE_JOURS * JOUR;
  for (const [id, x] of Object.entries(idx.ev)) if (!(Number(x.debut) >= limite)) { delete idx.ev[id]; change = true; }
  return change;
}
/* ---- UN INDEX ILLISIBLE EST MIS DE COTE, PAS ECRASE (lot 2, 10/10/2026) ----
 * Refait en silence a partir de la seule releve en cours, il emportait toutes
 * les clotures d'avant : la CLV (lot 2) les fige au reglement, jusqu'a une
 * semaine plus tard. Le fichier illisible est donc renomme a cote
 * (`paris_prix_clotures.json.illisible-<t>`) et la chose est dite au journal
 * de l'hote : le brut du journal garde de quoi le refaire hors serveur
 * (`cloturesDe`). Si le renommage echoue lui-meme, on ecrase comme avant,
 * et on le dit une fois par processus.
 * SEUL un contenu qui ne se decode pas (SyntaxError) est mis de cote : une
 * lecture qui echoue (EIO, EMFILE, EACCES...) ne dit rien du contenu, et
 * renommer puis refaire un index peut-etre sain emportait toutes ses
 * clotures (relecture du 10/10) ; `majClotures` saute alors cette releve.
 * Les mises de cote gardees : les ILLISIBLES_GARDES plus recentes (une
 * corruption repetee ne remplit pas le volume ; trois suffisent a refaire
 * l'histoire, le brut du journal fait le reste). */
const ILLISIBLES_GARDES = 3;
function metDeCote(f, e, t) {
  const cote = f + '.illisible-' + (Number.isFinite(t) ? t : Date.now());
  try {
    fs.renameSync(f, cote);
    console.log('[odds] index de cloture illisible (' + String((e && e.message) || e).slice(0, 120) + '), mis de cote sous '
      + path.basename(cote) + ' et refait a partir de cette releve');
  } catch (e2) {
    if (!ETAT.ditIndex) { ETAT.ditIndex = true; console.log('[odds] index de cloture illisible, refait a partir de cette releve : ' + (e.message || e)); }
    return;
  }
  try {
    const pre = path.basename(f) + '.illisible-';
    const vieux = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(pre))
      .sort((a, b) => Number(b.slice(pre.length)) - Number(a.slice(pre.length))).slice(ILLISIBLES_GARDES);
    for (const x of vieux) fs.unlinkSync(path.join(path.dirname(f), x));
  } catch (e3) { /* la purge n'empeche jamais l'index de repartir */ }
}
/** L'index de cloture et son etat : { idx, etat } ; etat = 'ok' | 'absent'
 *  (aucun fichier) | 'illisible' (lecture refusee ou contenu qui ne se decode
 *  pas) | 'version' (une autre version). Lecture seule : c'est l'ecrivain
 *  (`majClotures`) qui met de cote un index illisible. Lu UNE fois par
 *  reglement (lot 2) : le gel distingue « pas d'index » de « index pas
 *  lisible maintenant », qu'il ne fige pas (reprise au reglement suivant). */
function lisCloturesEtat() {
  let txt;
  try { txt = fs.readFileSync(fichierClotures(), 'utf8'); } catch (e) {
    return { idx: null, etat: e && e.code === 'ENOENT' ? 'absent' : 'illisible', erreur: String((e && (e.code || e.message)) || e) };
  }
  let idx;
  try { idx = JSON.parse(txt); } catch (e) { return { idx: null, etat: 'illisible', erreur: 'json' }; }
  return idx && idx.v === V && idx.ev && typeof idx.ev === 'object' ? { idx, etat: 'ok' } : { idx: null, etat: 'version' };
}
/** L'index de cloture tel qu'il est sur le disque, ou null (absent,
 *  illisible, autre version). */
function lisClotures() { return lisCloturesEtat().idx; }
/** La cloture d'une rencontre, ou null : { l, debut, d, a, o? }. Relue du
 *  disque a chaque appel : l'objet rendu n'est jamais l'index lui-meme. */
function cloture(evId) {
  const idx = lisClotures();
  return idx && Object.prototype.hasOwnProperty.call(idx.ev, String(evId)) ? idx.ev[String(evId)] : null;
}
/* Le fichier : lu, mis a jour, ecrit en deux temps. Le temporaire porte le
   PID : pendant un redeploiement, l'ancien et le nouveau processus ecrivent
   un instant ensemble, et un temporaire commun pouvait melanger leurs deux
   ecritures. (Une mise a jour de l'un peut encore effacer celle de l'autre :
   la ligne reste au journal brut, d'ou `cloturesDe`.) Ne leve jamais. */
function majClotures(ligne) {
  /* sans date, la purge effacerait tout l'index (debut >= NaN est faux) */
  if (!ligne || !Number.isFinite(ligne.t)) return false;
  try {
    const f = fichierClotures();
    let idx = null, txt = null;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) {
      /* une lecture refusee ne dit rien du contenu : on n'ecrase pas un
         index peut-etre sain, cette releve reste au journal brut */
      if (e.code !== 'ENOENT') { echec('clotures', e, ligne.t); return false; }
    }
    if (txt !== null) {
      try { idx = JSON.parse(txt); } catch (e) { metDeCote(f, e, ligne.t); }
    }
    if (!idx || idx.v !== V || !idx.ev || typeof idx.ev !== 'object') idx = { v: V, ev: {} };
    if (!ajouteCloture(idx, ligne)) return true;
    idx.maj = ligne.t;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx) + '\n');
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { echec('clotures', e, ligne && ligne.t); return false; }
}
/** L'index refait a partir des lignes du journal (`lisJournal`), dans l'ordre
 *  des dates : le contenu du fichier, a la date `maj` pres de la derniere
 *  ligne qui l'a change. Hors serveur (outils, lot 2). */
function cloturesDe(lignes) {
  const idx = { v: V, ev: {} };
  const l = (lignes || []).filter((x) => x && Number.isFinite(x.t) && Array.isArray(x.e)).sort((a, b) => a.t - b.t);
  for (const x of l) if (ajouteCloture(idx, x)) idx.maj = x.t;
  return idx;
}

/* L'abonne du crochet. Le carnet est deja ecrit quand il est appele (socle). */
function journalDesPrix(fait) {
  if (!actif()) return;
  let ligne;
  try { ligne = ligneDe(fait); } catch (e) { echec('journal', e, fait && fait.t); return; }
  ecrit(ligne);
  majClotures(ligne);
}
let DESABONNE = null;
/** Branche le journal sur `prix_marche.apresNote`, une seule fois. */
function branche() {
  if (!DESABONNE) {
    const d = pm.apresNote(journalDesPrix);
    DESABONNE = () => { d(); DESABONNE = null; };
  }
  return DESABONNE;
}

// ------------------------------------------------------------ la lecture

/* Une ligne lue : l'objet, ou null si elle est coupee ou n'est pas une ligne
   du journal (un redeploiement pendant `appendFileSync` peut couper la
   derniere ligne d'un fichier ; deux ecrivains aussi). */
function lisLigne(s) {
  if (!s) return null;
  try {
    const x = JSON.parse(s);
    return x && typeof x === 'object' && Number.isFinite(x.t) && Array.isArray(x.e) ? x : null;
  } catch (e) { return null; }
}
/** Les lignes d'un texte .jsonl : { lignes, illisibles }. Ne leve jamais. */
function lisTexte(txt) {
  const lignes = [];
  let illisibles = 0;
  for (const s of String(txt || '').split('\n')) {
    if (!s.trim()) continue;
    const x = lisLigne(s);
    if (x) lignes.push(x); else illisibles++;
  }
  return { lignes, illisibles };
}
/** Lit le journal d'un dossier (le volume, ou une copie figee) :
 *  { lignes (triees par date), illisibles, fichiers }. `depuis`/`jusqua` en
 *  jours AAAA-MM-JJ inclus. */
async function lisJournal(o) {
  const opt = o || {};
  const dir = opt.dossier || dossier();
  let noms = [];
  try { noms = (await fs.promises.readdir(dir)).filter((f) => FICHIER_JOUR.test(f)).sort(); } catch (e) { /* pas de journal */ }
  const out = { lignes: [], illisibles: 0, fichiers: [] };
  for (const f of noms) {
    const j = f.slice(0, 10);
    if (opt.depuis && j < opt.depuis) continue;
    if (opt.jusqua && j > opt.jusqua) continue;
    let txt = '';
    try { txt = await fs.promises.readFile(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    const r = lisTexte(txt);
    out.lignes.push(...r.lignes);
    out.illisibles += r.illisibles;
    out.fichiers.push({ jour: j, lignes: r.lignes.length, illisibles: r.illisibles, octets: Buffer.byteLength(txt) });
  }
  out.lignes.sort((a, b) => a.t - b.t);
  return out;
}

/* ---- LE COMPTE D'UN FICHIER, SANS DECODER LES PRIX ----
 * `etat` est lu par /paris/import, dans le processus qui vend. Decoder 30
 * jours de journal pour compter des causes : 156 ms d'un bloc au premier
 * appel (banc du 10/10 : 30 fichiers de 170 lignes a 12 rencontres, 12 Mo,
 * pessimiste), le serveur de jeux muet pendant ce temps. On lit donc la cause
 * dans l'en-tete de la ligne, que `JSON.stringify` ecrit toujours dans le meme
 * ordre (v, m, t, l, q), et une ligne n'est entiere que si elle finit par
 * « ]} » (`e`, un tableau sans objet, est le dernier champ) : une ligne coupee
 * par un redeploiement ne finit jamais ainsi. Meme banc : 31 a 33 ms au
 * premier appel (la lecture des 12 Mo), fait au DEMARRAGE par la ligne du
 * journal de l'hote (`ligneDemarrage`), puis 0,6 ms (seul le fichier du jour
 * se relit). La lecture complete (`lisTexte`, JSON.parse) reste celle de
 * l'outil, hors serveur ; l'essai T6 exige que les deux comptes soient egaux. */
const ENTETE = /^\{"v":\d+,"m":"[^"\\]*","t":\d+,"l":"(?:[^"\\]|\\.)*","q":"((?:[^"\\]|\\.)*)"/;
function compteTexte(txt) {
  const parQuoi = {};
  let lignes = 0, illisibles = 0;
  for (const s of String(txt || '').split('\n')) {
    if (!s.trim()) continue;
    const m = s.endsWith(']}') && s.match(ENTETE);
    if (!m) { illisibles++; continue; }
    let q = m[1];
    if (q.indexOf('\\') >= 0) { try { q = JSON.parse('"' + q + '"'); } catch (e) { illisibles++; continue; } }
    q = q || '?';
    parQuoi[q] = (parQuoi[q] || 0) + 1;
    lignes++;
  }
  return { lignes, illisibles, parQuoi };
}
/* Garde tant que la taille et la date du fichier ne changent pas : les jours
   passes ne se relisent qu'une fois par processus, le jour en cours a chaque
   ajout. Compte sur le DISQUE : il survit aux redeploiements. */
const COMPTES = new Map();
function compteFichier(nom) {
  const f = path.join(dossier(), nom);
  const st = fs.statSync(f);
  const sig = st.size + ':' + st.mtimeMs;
  const c = COMPTES.get(nom);
  if (c && c.sig === sig) return c;
  const neuf = Object.assign({ sig, octets: st.size }, compteTexte(fs.readFileSync(f, 'utf8')));
  COMPTES.set(nom, neuf);
  return neuf;
}
/** L'etat du journal pour `etatImport().journalPrix` : fichiers, octets,
 *  lignes par cause (lues sur le disque), echecs et illisibles. Rien de
 *  calcule, aucun verdict : la mesure est dans outils/age_prix.js. */
function etat() {
  const out = { actif: actif(), version: V, joursGardes: joursGardes(), horizonJours: Math.round(horizonMs() / JOUR),
                fichiers: 0, octets: 0, premier: null, dernier: null, lignes: 0, lignesParQuoi: {}, illisibles: 0,
                jours: [], echecs: Object.assign({}, ETAT.echecs), dernierEchec: ETAT.dernierEchec, clotures: null };
  let noms = [];
  try { noms = fs.readdirSync(dossier()).filter((f) => FICHIER_JOUR.test(f)).sort(); } catch (e) { /* pas encore de journal */ }
  const vus = new Set();
  for (const nom of noms) {
    let c;
    try { c = compteFichier(nom); } catch (e) { continue; }
    vus.add(nom);
    const jour = nom.slice(0, 10);
    out.fichiers++; out.octets += c.octets; out.lignes += c.lignes; out.illisibles += c.illisibles;
    if (!out.premier) out.premier = jour;
    out.dernier = jour;
    for (const [q, k] of Object.entries(c.parQuoi)) out.lignesParQuoi[q] = (out.lignesParQuoi[q] || 0) + k;
    out.jours.push({ jour, octets: c.octets, lignes: c.lignes, illisibles: c.illisibles, parQuoi: c.parQuoi });
  }
  for (const k of [...COMPTES.keys()]) if (!vus.has(k)) COMPTES.delete(k);
  try {
    const st = fs.statSync(fichierClotures());
    out.clotures = { octets: st.size, maj: new Date(st.mtimeMs).toISOString() };
  } catch (e) { /* pas encore d'index */ }
  return out;
}

/* ---- LA ROUTE ADMIN /paris/journal-prix?jour=AAAA-MM-JJ ----
 * Le fichier brut d'un jour, tel quel, pour `outils/age_prix.js --telecharge`
 * (le figer avant la purge). Lecture seule. Le jour est valide AVANT d'approcher
 * le disque : seul /^\d{4}-\d{2}-\d{2}$/ d'une vraie date passe, jamais un
 * chemin (`../x`). */
const RE_JOUR = /^\d{4}-\d{2}-\d{2}$/;
function jourValide(j) {
  if (typeof j !== 'string' || !RE_JOUR.test(j)) return false;
  const d = new Date(j + 'T00:00:00Z');
  return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === j;
}
/** Le texte brut d'un jour, null s'il n'existe pas. Leve sur un jour mal ecrit. */
function litJourBrut(jour) {
  if (!jourValide(jour)) throw new TypeError('jour attendu au format AAAA-MM-JJ');
  try { return fs.readFileSync(path.join(dossier(), jour + '.jsonl'), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
/** La reponse HTTP de la route : { code, type, corps }. */
function reponseJour(jour) {
  const json = 'application/json';
  if (!jourValide(jour)) return { code: 400, type: json, corps: JSON.stringify({ error: 'day must be YYYY-MM-DD' }) };
  let txt;
  try { txt = litJourBrut(jour); } catch (e) { return { code: 500, type: json, corps: JSON.stringify({ error: 'journal unreadable' }) }; }
  if (txt === null) return { code: 404, type: json, corps: JSON.stringify({ error: 'no journal for ' + jour }) };
  return { code: 200, type: 'application/x-ndjson; charset=utf-8', corps: txt };
}

/** La ligne du journal de l'hote au demarrage. */
function ligneDemarrage() {
  const e = etat();
  return '[odds] journal des prix : ' + (e.actif ? 'actif' : 'COUPE (PARIS_PRIX_JOURNAL=0)') + ', ' + e.joursGardes + ' j gardes, '
    + e.fichiers + ' fichier(s), ' + Math.round(e.octets / 1024) + ' Ko' + (e.dernier ? ', dernier ' + e.dernier : '')
    + ' — 0 credit, mesure hors serveur (outils/age_prix.js)';
}

module.exports = { V, AVANT_CLOTURE_MS, CLOTURE_JOURS, JOURS_DEFAUT, JOURS_MIN, JOURS_MAX,
                   dossier, fichierClotures, actif, joursGardes, horizonMs, jourDe,
                   sourcesDe, ligneDe, ecrit, ajouteCloture, majClotures, cloturesDe, journalDesPrix, branche,
                   /* lot 2 (CLV) : la lecture de l'index au reglement */
                   lisClotures, lisCloturesEtat, cloture, ILLISIBLES_GARDES,
                   lisLigne, lisTexte, lisJournal, etat, jourValide, litJourBrut, reponseJour, ligneDemarrage };
