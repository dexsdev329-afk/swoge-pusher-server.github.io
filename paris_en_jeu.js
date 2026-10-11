'use strict';
/*
 * LES PARIS EN JEU SUR LES TRES GROSSES EQUIPES : OBSERVATION SEULEMENT
 * (lot 7 de la cle 20K, 11/10/2026).
 *
 * ---- pourquoi ----
 *
 * Le proprietaire a demande le 09/10 les paris EN JEU, seulement sur les tres
 * grosses equipes (il les avait refuses le 08/10). Le danger n'est pas mesure :
 * en jeu, un parieur qui voit un but avant notre prix prend une cote perimee,
 * et la seule defense serieuse est la bourse Betfair, que le fournisseur
 * rafraichit toutes les 10 s en jeu contre 40 s pour les livres
 * (https://the-odds-api.com/sports-odds-data/update-intervals.html, relu par
 * le plan du 09/10). Ce lot ne vend RIEN. Il releve, il ecrit un journal, et il
 * calcule une porte ecrite d'avance (EXPLOITATION 8.12) qui dira si la vente
 * (lot 12 : game.js, le message WS, enDirect, parisListe, la page) peut
 * s'ouvrir. Rien ici n'est lu par la vente, et rien de vendu ne change.
 *
 * ---- ce qui est suivi ----
 *
 * Une rencontre de football du catalogue dont le domicile OU l'exterieur est
 * dans PARIS_EN_JEU_EQUIPES (comparaison EXACTE apres scores_espn.normalise,
 * jamais par ressemblance : « Inter Milan » n'est pas « AC Milan »), dans un
 * championnat de PARIS_EN_JEU_LIGUES qui est aussi VENDU au prix du marche
 * (prix_ligues.ligues) et qui a un tableau ESPN (scores_espn.CHEMINS). Du coup
 * d'envoi moins 2 min jusqu'a l'etat ESPN « post », 130 min au plus. Une
 * ancienne entree fermee d'un match deplace n'est pas suivie quand la nouvelle
 * existe (meme regle qu'enDirect, server.js).
 *
 * ---- les deux sources ----
 *
 * 1. Le prix : `/sports/{ligue}/odds?regions=eu&markets=h2h&eventIds=…`, UN
 *    credit par championnat et par releve quel que soit le nombre de
 *    rencontres (« cost = [number of markets specified] x [number of regions
 *    specified] », « If no events are returned, the request will not count
 *    against the usage quota », https://the-odds-api.com/liveapi/guides/v4/,
 *    copie du 09/10 dans le plan). Par `appel` du socle, injecte par
 *    server.js, en CLASSE 2 (`info.classe`) : `autorise` revérifie la part du
 *    jour moins 80 a CHAQUE releve, pas seulement a l'admission, et un refus
 *    rend la rencontre « incomplete ». On garde de la bourse `betfair_ex_eu`
 *    les prix arriere h2h, `h2h_lay` (« Lay odds are automatically included
 *    with h2h results for relevant betting exchanges », meme page), le
 *    `last_update` du MARCHE (« The market-level last_update field shows the
 *    last time our system saw odds for that market from the bookmaker. When a
 *    market is suspended or closed, its last_update stops advancing », meme
 *    page ; le `last_update` du livre est « deprecated » et garde a part), la
 *    somme des inverses et p sans marge (prix_marche.sansMarge, le MEME code
 *    que l'avant-match), plus la reference de prix_marche.referenceDe.
 *    Le carnet de vente (`paris_prix.json`) n'est JAMAIS ecrit : aucun appel a
 *    prix_marche.note.
 * 2. Le score, les rouges et l'horloge : ESPN, gratuit, PARTAGE avec
 *    l'affichage et le second verrou (server.js, `directSuivies`) — aucune
 *    lecture propre a ce module. Ce module ne decide que la CADENCE (15 s) de
 *    la passe des seules rencontres suivies, compte SES refus a part, et
 *    recule tout seul sur un 403 ou un 429 : une API non officielle saturee
 *    par le direct degraderait le second verrou et le reglement gratuit.
 *
 * ---- ce qu'il ecrit ----
 *
 *  $DATA_DIR/paris_en_jeu/AAAA-MM-JJ.jsonl  le journal, une ligne JSON par
 *      fait (format v1, voir `ligne*`), un fichier par jour UTC : la purge
 *      (30 jours, 20 Mo) et le bilan se font par morceaux ;
 *  $DATA_DIR/paris_en_jeu_quota.json        credits (total de l'observation,
 *      par jour, par mois), rencontres admises, completes et incompletes,
 *      arret, sonde : ecrit en deux temps, il survit aux redeploiements ;
 *  $DATA_DIR/paris_en_jeu_bilan.json        le dernier bilan, recalcule chaque
 *      heure et a la fin de chaque rencontre, par `bilan(lignes, params)` —
 *      la MEME fonction que `outils/releve_en_jeu.js` rejoue hors serveur.
 *
 * ---- ce qui ne change pas (tenu par paris_en_jeu.test.js) ----
 *
 *  - PARIS_EN_JEU vide (le defaut) : aucune minuterie, aucun appel, aucun
 *    fichier ; `vendre` n'existe pas avant le lot 12 et ne fait RIEN tourner.
 *  - En observation : paris.ouverts, le carnet des prix et les soldes sont
 *    identiques ; aucun message, aucune route publique, aucune page touches.
 *
 * Commentaires sans accents (convention de prix_marche.js et prix_journal.js).
 */
const fs = require('fs');
const path = require('path');
const espn = require('./scores_espn');
const prixLigues = require('./prix_ligues');
const pm = require('./prix_marche');
const cotes = require('./cotes');

const V = 1;
const SECONDE = 1000, MINUTE = 60000, HEURE = 3600000, JOUR = 86400000;
const ISSUES = ['1', 'N', '2'];

/* ---- LES VALEURS PAR DEFAUT (plan corrige du 09/10, decisions de l'assemblage) ----
 * Les huit clubs : les noms EXACTS de The Odds API, verifies un par un dans le
 * calendrier public du 09/10 (scratchpad cle20k/ameliorations/calendrier.json :
 * les huit y sont). Ils jouaient 14 rencontres sur 7 jours, dont 7 de Ligue des
 * champions. Les six championnats : ceux qui sont vendus au prix du marche et
 * ont un tableau ESPN (prix_ligues.LIGUES_DEFAUT). */
const EQUIPES_DEFAUT = ['Real Madrid', 'Barcelona', 'Bayern Munich', 'Paris Saint Germain',
  'Manchester City', 'Liverpool', 'Arsenal', 'Inter Milan'];
const LIGUES_DEFAUT = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_champs_league'];

/* Le suivi : 2 min avant le coup d'envoi, jusqu'a « post », 130 min au plus
   (plan). L'estimation d'une rencontre est de 115 min d'horloge en
   observation (plan, creditsMois : coup d'envoi a la fin, mi-temps comprise),
   soit 115 credits a 60 s. Sans appariement ESPN 30 min apres le coup
   d'envoi, la rencontre ne pourra pas compter (le bilan exige ESPN) : on cesse
   de payer pour elle. Les 30 min sont POSEES SANS MESURE le 11/10/2026 (aucun
   appariement en jeu jamais observe) : un plafond de perte, ~30 credits par
   rencontre perdue ; le bilan les jugera (`rencontres[].apparie`, raison
   « espn non apparie 30 min apres le coup d envoi » au journal). */
const AVANT_MS = 2 * MINUTE;
const APRES_MAX_MS = 130 * MINUTE;
const SUIVI_MIN = 115;
const SANS_ESPN_MS = 30 * MINUTE;
/* ESPN muet au-dela de 45 s sans lecture reussie, bourse fraiche si son
   last_update a 20 s au plus a la releve (porte du plan, conditions 4 et 5). */
const ESPN_MUET_MS = 45 * SECONDE;
const BOURSE_FRAICHE_MS = 20 * SECONDE;
const SOMME_MIN = 1.0, SOMME_MAX = 1.06;     // bornes de la bourse de prix_marche.referenceDe
/* ---- LE RECUL SUR UN REFUS D'ESPN ----
 * 403 ou 429 : la passe rapide s'arrete 2 min, puis 4, 8… jusqu'a 30 min, et
 * repart a 2 min apres une lecture sans refus. Ce ne sont PAS des mesures :
 * aucun refus d'ESPN au rythme de 15 s n'a jamais ete observe. Le compteur de
 * refus propre au direct (`etat().espn`) les rendra jugeables. */
const RECUL_MIN_MS = 2 * MINUTE, RECUL_MAX_MS = 30 * MINUTE;
/* ---- LA SONDE DU last_update ----
 * Le plan exigeait une releve d'un credit pour verifier que le marche porte
 * son last_update (les exemples /odds ne montrent que celui du livre). Elle
 * n'a pas ete faite avant ce lot. La PREMIERE releve en est donc une : si la
 * bourse est presente sans last_update de marche, l'observation s'arrete (un
 * credit perdu), le dit, et ne refait un essai que 7 jours plus tard. Les 7
 * jours sont POSES SANS MESURE le 11/10/2026 : un essai par semaine borne la
 * perte a ~4 credits par mois ; la ligne `k: "sonde"` du journal dira si
 * l'absence dure. */
const ARRET_SANS_LU_MS = 7 * JOUR;
const JOURNAL_JOURS = 30, JOURNAL_OCTETS = 20 * 1024 * 1024;
const FICHIER_JOUR = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RENCONTRES_MAX = 2000;

// ------------------------------------------------------------ les reglages

function dossierData() { return (process.env.DATA_DIR || './data').trim(); }
function dossierJournal() { return path.join(dossierData(), 'paris_en_jeu'); }
function fichierEtat() { return path.join(dossierData(), 'paris_en_jeu_quota.json'); }
function fichierBilan() { return path.join(dossierData(), 'paris_en_jeu_bilan.json'); }
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
const moisDe = (t) => new Date(t).toISOString().slice(0, 7);

/* Un nombre de l'environnement, borne. Vide : le defaut. Illisible : `illisible`
   (le defaut, sauf pour les plafonds de credits, qui echouent FERMES a 0). */
function nombre(nom, defaut, min, max, illisible) {
  const v = process.env[nom];
  if (v === undefined || String(v).trim() === '') return defaut;
  const n = Number(String(v).trim());
  if (!isFinite(n)) return illisible === undefined ? defaut : illisible;
  return Math.min(max, Math.max(min, n));
}
/* ---- LES NOMS D'EQUIPE SE DECOUPENT SUR « , » ET « ; » SEULEMENT ----
 * Ils ont des espaces (« Real Madrid ») : prix_ligues.decoupe, qui coupe aussi
 * sur les espaces, ferait deux clubs inconnus de « Real Madrid » (lecon des
 * separateurs du 09/10). */
function decoupeEquipes(v) {
  return String(v === undefined || v === null ? '' : v).split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
}

/** Les reglages, relus a chaque tic (une variable change au redemarrage). */
function config() {
  const brut = String(process.env.PARIS_EN_JEU === undefined ? '' : process.env.PARIS_EN_JEU).trim();
  const m = brut.toLowerCase();
  /* `observe` seul fait tourner quelque chose. Vide ou `0` : rien. Toute autre
     valeur — `vendre` compris, la vente etant le lot 12 — ne fait RIEN tourner
     et se dit au demarrage : une faute de frappe ne depense jamais un credit. */
  const mode = m === 'observe' ? 'observe' : (m === '' || m === '0') ? 'off' : 'inconnu';
  const eqBrut = process.env.PARIS_EN_JEU_EQUIPES;
  const equipes = eqBrut === undefined ? EQUIPES_DEFAUT.slice() : decoupeEquipes(eqBrut);
  const ligBrut = process.env.PARIS_EN_JEU_LIGUES;
  const demandees = ligBrut === undefined ? LIGUES_DEFAUT.slice() : prixLigues.decoupe(ligBrut);
  const vendues = prixLigues.ligues();
  const ligues = [], ecartees = [];
  for (const k of demandees) {
    if (/^soccer_/.test(k) && vendues.has(k) && espn.CHEMINS[k]) { if (ligues.indexOf(k) < 0) ligues.push(k); }
    else ecartees.push(k);
  }
  const cadenceS = nombre('PARIS_EN_JEU_CADENCE_S', 60, 10, 600);
  const espnS = nombre('PARIS_EN_JEU_ESPN_S', 15, 10, 45);
  return {
    mode, brut, equipes, equipesNorm: new Set(equipes.map((x) => espn.normalise(x)).filter(Boolean)),
    ligues, ecartees, cadenceS, espnS,
    /* jamais sous la cadence : la releve qui juge doit exister */
    delaiS: Math.max(nombre('PARIS_EN_JEU_DELAI_S', 60, 10, 600), cadenceS),
    marge: nombre('PARIS_EN_JEU_MARGE', 0.10, 0.03, 0.30),
    garde: nombre('PARIS_EN_JEU_GARDE', 0.03, 0, 0.20),
    fermeMin: nombre('PARIS_EN_JEU_FERME_MIN', 80, 46, 90),
    /* ---- LES PLAFONDS : 3 000 SUR TOUTE L'OBSERVATION, SANS PROLONGATION AUTOMATIQUE ----
     * Le plan nommait PARIS_EN_JEU_CREDITS_MOIS ; un plafond PAR MOIS se
     * rouvrirait seul le 1er (3 000 de plus), ce que la decision du 09/10
     * exclut (« sans prolongation automatique »). Le compteur est donc le
     * TOTAL depuis le premier credit, jamais remis a zero : prolonger, c'est
     * relever la variable a la main. 3 000 = 24 rencontres x 115 a 60 s
     * (~2 760) plus la marge des rencontres partagees (plan, creditsMois). */
    creditsObs: nombre('PARIS_EN_JEU_CREDITS_OBS', 3000, 0, 20000, 0),
    creditsJour: nombre('PARIS_EN_JEU_CREDITS_JOUR', 400, 0, 2000, 0),
    obsMatchs: Math.floor(nombre('PARIS_EN_JEU_OBS_MATCHS', 24, 1, 200)),
    /* includeBetLimits : « the response will include the bet limit of each
       betting option, mainly available for betting exchanges » (guide v4) ;
       son cout n'est pas documente. ETEINT par defaut (le plan disait 1) :
       aucun credit de plus que ce que le lot dit ; coupe tout seul si une
       releve qui le porte coute plus d'un credit. */
    limites: String(process.env.PARIS_EN_JEU_LIMITES || '').trim() === '1',
  };
}

// ------------------------------------------------------------ l'etat durable

function etatNeuf() {
  return { v: V, credits: { total: 0, jours: {}, mois: {} }, appels: 0, rencontres: {},
           arret: null, sonde: null, limitesCoupees: false, finObs: null };
}
let ETAT = null;
let etatIllisibleDit = false;
/* Le compteur tel qu'il est sur le disque, SANS rien toucher : rend { E, brut }
   (E null si le fichier est illisible, brut null s'il est absent). */
function litDisque() {
  let brut = null;
  try { brut = fs.readFileSync(fichierEtat(), 'utf8'); } catch (e) { return { E: etatNeuf(), brut: null }; }
  try {
    const j = JSON.parse(brut);
    const E = Object.assign(etatNeuf(), j);
    E.credits = Object.assign({ total: 0, jours: {}, mois: {} }, j.credits || {});
    E.rencontres = j.rencontres && typeof j.rencontres === 'object' ? j.rencontres : {};
    return { E, brut };
  } catch (e) { return { E: null, brut }; }
}
/* ---- UN COMPTEUR ILLISIBLE ECHOUE FERME, ET LE RESTE APRES UN REDEPLOIEMENT ----
 * On ne sait plus ce qui a ete depense : plus aucune admission (`illisible`),
 * et on le dit. Le fichier abime est mis de cote (`.illisible-<ts>`), jamais
 * ecrase. Le marqueur `illisible` est ECRIT dans le compteur neuf : avant la
 * relecture du 11/10/2026, il n'etait qu'en memoire, le premier tic ecrivait
 * un compteur a ZERO sans lui, et le redeploiement suivant relisait ce zero
 * sans erreur — le plafond de 3 000 « sans prolongation automatique » se
 * rouvrait tout seul (demontre : 2 990 depenses, fichier tronque, un tic, un
 * rechargement -> admise). Seul le proprietaire le leve : remettre
 * `credits.total` a la valeur connue (le fichier mis de cote, ou la classe 2
 * de odds_classes.json) et retirer la cle `illisible` (EXPLOITATION 8.12).
 * Absent : premier demarrage, un compteur neuf. */
function litEtat() {
  if (ETAT) return ETAT;
  const { E, brut } = litDisque();
  if (E) {
    ETAT = E;
    if (ETAT.illisible && !etatIllisibleDit) {
      etatIllisibleDit = true;
      console.log(`[en-jeu] compteur marque illisible depuis ${new Date(ETAT.illisible.t || 0).toISOString()} : AUCUNE rencontre admise tant que le proprietaire n a pas remis le total et retire « illisible » (EXPLOITATION 8.12)`);
    }
    return ETAT;
  }
  ETAT = etatNeuf();
  const aCote = fichierEtat() + '.illisible-' + Date.now();
  ETAT.illisible = { t: Date.now(), octets: brut.length, fichier: path.basename(aCote) };
  try { fs.renameSync(fichierEtat(), aCote); } catch (e2) { /* rien d'ecrase */ }
  if (!etatIllisibleDit) {
    etatIllisibleDit = true;
    console.log(`[en-jeu] compteur illisible (${brut.length} octet(s)) : mis de cote (${path.basename(aCote)}), AUCUNE rencontre admise tant que le proprietaire n a pas remis le total et retire « illisible » (on ne sait plus ce qui a ete depense)`);
  }
  return ETAT;
}
function ecritEtat() {
  const E = litEtat();
  /* borne : les rencontres finies les plus anciennes sortent ; les jours de plus de 120 jours aussi */
  const ids = Object.keys(E.rencontres);
  if (ids.length > RENCONTRES_MAX) {
    ids.sort((a, b) => (E.rencontres[a].tA || 0) - (E.rencontres[b].tA || 0));
    for (const id of ids.slice(0, ids.length - RENCONTRES_MAX)) if (E.rencontres[id].fin) delete E.rencontres[id];
  }
  const jours = Object.keys(E.credits.jours).sort();
  for (const j of jours.slice(0, Math.max(0, jours.length - 120))) delete E.credits.jours[j];
  try {
    fs.mkdirSync(dossierData(), { recursive: true });
    const tmp = fichierEtat() + '.tmp';
    /* `illisible` part avec le reste : c'est lui qui tient la porte fermee au redeploiement */
    fs.writeFileSync(tmp, JSON.stringify(E) + '\n');
    fs.renameSync(tmp, fichierEtat());
    S.sale = false;
    return true;
  } catch (e) { console.log('[en-jeu] compteur non ecrit : ' + (e && e.message)); return false; }
}
/** Oublie la memoire (un redeploiement) : le compteur se relit du disque. */
function recharge() {
  ETAT = null; etatIllisibleDit = false;
  Object.assign(S, { suivis: new Map(), derniereReleve: new Map(), dernierEspn: 0, dernierEv: new Map(), enCours: false, sale: false,
                     recul: { jusqua: 0, pas: 0 }, espn: { jour: null, requetes: 0, refus: 0, statuts: {}, reculs: 0, dernier: null },
                     bilan: null, bilanEnCours: false, bilanDu: false, bilanT: 0 });
  J.purge = -Infinity;
}

// ------------------------------------------------------------ le journal

const J = { echecs: 0, dernierEchec: null, dit: -Infinity, purge: -Infinity };
function ecritLigne(l) {
  try {
    fs.mkdirSync(dossierJournal(), { recursive: true });
    fs.appendFileSync(path.join(dossierJournal(), jourDe(l.t) + '.jsonl'), JSON.stringify(l) + '\n');
  } catch (e) {
    J.echecs++;
    J.dernierEchec = { t: l.t, message: String((e && e.message) || e).slice(0, 200) };
    if (!(l.t - J.dit < HEURE && l.t >= J.dit)) { J.dit = l.t; console.log('[en-jeu] journal non ecrit : ' + J.dernierEchec.message); }
    return false;
  }
  purge(l.t);
  return true;
}
/* ---- LA PURGE : 30 JOURS, 20 MO ----
 * Au plus une fois par heure. Les jours de plus de 30 jours sortent ; puis,
 * tant que le dossier depasse 20 Mo, le plus ancien (jamais celui du jour).
 * ~100 Ko par rencontre (plan) : 24 rencontres tiennent dix fois. */
function purge(t) {
  if (t - J.purge < HEURE && t >= J.purge) return;
  J.purge = t;
  try {
    const garde = jourDe(t - (JOURNAL_JOURS - 1) * JOUR);
    const fichiers = fs.readdirSync(dossierJournal()).filter((f) => FICHIER_JOUR.test(f)).sort();
    const restent = [];
    for (const f of fichiers) {
      if (f.slice(0, 10) < garde) fs.unlinkSync(path.join(dossierJournal(), f));
      else restent.push({ f, o: fs.statSync(path.join(dossierJournal(), f)).size });
    }
    let total = restent.reduce((a, x) => a + x.o, 0);
    const aujourdhui = jourDe(t) + '.jsonl';
    for (const x of restent) {
      if (total <= JOURNAL_OCTETS || x.f === aujourdhui) break;
      fs.unlinkSync(path.join(dossierJournal(), x.f));
      total -= x.o;
    }
  } catch (e) { /* un dossier absent ou illisible n'arrete rien */ }
}
/** Les jours du journal, avec leur taille. */
function jours() {
  try {
    return fs.readdirSync(dossierJournal()).filter((f) => FICHIER_JOUR.test(f)).sort()
      .map((f) => ({ jour: f.slice(0, 10), octets: fs.statSync(path.join(dossierJournal(), f)).size }));
  } catch (e) { return []; }
}
/** La reponse de la route admin `/paris/en-jeu/journal?jour=` : le jour brut,
    ou la liste des jours. Jour valide AVANT tout acces au disque. */
function reponseJournal(jour) {
  if (jour === null || jour === undefined || jour === '') {
    return { code: 200, type: 'application/json; charset=utf-8', corps: JSON.stringify({ jours: jours() }) };
  }
  const j = String(jour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j) || !isFinite(Date.parse(j + 'T00:00:00Z')) || new Date(j + 'T00:00:00Z').toISOString().slice(0, 10) !== j) {
    return { code: 400, type: 'application/json; charset=utf-8', corps: JSON.stringify({ error: 'day must be YYYY-MM-DD' }) };
  }
  try {
    return { code: 200, type: 'application/x-ndjson; charset=utf-8', corps: fs.readFileSync(path.join(dossierJournal(), j + '.jsonl')) };
  } catch (e) {
    return { code: 404, type: 'application/json; charset=utf-8', corps: JSON.stringify({ error: 'no journal for this day' }) };
  }
}

// ------------------------------------------------------------ la selection

/* L'entree vivante : une rencontre deplacee laisse une ancienne entree FERMEE
   a cote de la nouvelle (08/10/2026, la regle d'enDirect). */
function vivants(matchs) {
  const v = new Set();
  for (const m of matchs || []) if (m && !m.ferme && m.source && m.source.evenement) v.add(String(m.source.evenement));
  return v;
}
function clubsDe(m, cfg) {
  return [m.domicile, m.exterieur].filter((n) => cfg.equipesNorm.has(espn.normalise(n)));
}
/** Les rencontres a suivre maintenant (sans rien admettre). */
function aSuivre(matchs, now, cfg) {
  const lig = new Set(cfg.ligues);
  const vv = vivants(matchs);
  const out = [];
  for (const m of matchs || []) {
    if (!m || m.sport !== 'foot' || !m.source || !lig.has(m.source.ligue) || !m.source.evenement) continue;
    const clubs = clubsDe(m, cfg);
    if (!clubs.length) continue;
    if (m.ferme && vv.has(String(m.source.evenement))) continue;
    const d = Number(m.debut);
    if (!isFinite(d) || now < d - AVANT_MS || now > d + APRES_MAX_MS) continue;
    out.push({ m, clubs });
  }
  return out;
}

// ------------------------------------------------------------ l'admission

function enCours(E) { return Object.values(E.rencontres).filter((r) => r.etat === 'admise' && !r.fin); }
function completes(E) { return Object.values(E.rencontres).filter((r) => r.complete).length; }
/** Le cout estime d'une rencontre, a la cadence : 115 min (plan). */
function estimation(cfg) { return Math.ceil(SUIVI_MIN * 60 / cfg.cadenceS); }
/**
 * Une rencontre est-elle admise ? Budget de l'observation, du jour, de la part
 * du jour du socle (classe 2 : part moins 80), et nombre de rencontres
 * completes. Les rencontres en cours comptent pour ce qu'il leur reste a
 * depenser (estimation moins depense). Rend { ok, raison, est }.
 */
function admet(now, cfg, quota) {
  const E = litEtat();
  const est = estimation(cfg);
  if (E.illisible) return { ok: false, raison: 'compteur illisible', est };
  if (E.arret && now < E.arret.jusqua) return { ok: false, raison: 'arret : ' + E.arret.raison, est };
  const n = completes(E);
  if (n >= cfg.obsMatchs) return { ok: false, raison: `observation finie (${n} rencontre(s) complete(s))`, est };
  const engage = enCours(E).reduce((a, r) => a + Math.max(0, (r.est || 0) - (r.cr || 0)), 0);
  const jour = E.credits.jours[jourDe(now)] || 0;
  if (E.credits.total + engage + est > cfg.creditsObs)
    return { ok: false, raison: `plafond de l observation (${E.credits.total} + ${engage} engages + ${est} > ${cfg.creditsObs})`, est };
  if (jour + engage + est > cfg.creditsJour)
    return { ok: false, raison: `plafond du jour (${jour} + ${engage} engages + ${est} > ${cfg.creditsJour})`, est };
  let q = null;
  try { q = typeof quota === 'function' ? quota() : null; } catch (e) { q = null; }
  if (!q) return { ok: false, raison: 'part du jour inconnue', est };
  if (q.depense + engage + est > q.part - q.reserve)
    return { ok: false, raison: `part du jour du socle (${q.depense} + ${engage} engages + ${est} > ${q.part} - ${q.reserve})`, est };
  return { ok: true, raison: null, est };
}

// ------------------------------------------------------------ la memoire vive

const S = { suivis: new Map(), derniereReleve: new Map(), dernierEspn: 0, dernierEv: new Map(),
            enCours: false, dit: new Set(), sale: false,
            recul: { jusqua: 0, pas: 0 },
            espn: { jour: null, requetes: 0, refus: 0, statuts: {}, reculs: 0, dernier: null },
            bilan: null, bilanEnCours: false };

function dire(cle, texte) { if (S.dit.has(cle)) return; S.dit.add(cle); console.log(texte); }

/* Les credits d'un appel, au journal du compteur (total, jour, mois) et a
   chaque rencontre de l'appel (part egale). */
function compteCredits(x, ids, t) {
  const E = litEtat();
  S.sale = true;
  E.appels++;
  if (x > 0) {
    E.credits.total += x;
    E.credits.jours[jourDe(t)] = (E.credits.jours[jourDe(t)] || 0) + x;
    E.credits.mois[moisDe(t)] = (E.credits.mois[moisDe(t)] || 0) + x;
    for (const id of ids) { const r = E.rencontres[id]; if (r) r.cr = Math.round(((r.cr || 0) + x / ids.length) * 1000) / 1000; }
  }
}

function termine(id, t, fin, raison) {
  const E = litEtat();
  const r = E.rencontres[id];
  if (!r || r.fin) return;
  S.sale = true;
  r.fin = t; r.etat = fin; r.raison = raison || null;
  const prevues = 1 + Math.floor(Math.max(0, t - (Number(r.tA) || t)) / ((Number(r.c) || 60) * SECONDE));
  /* complete : suivie DES avant le coup d'envoi (une admission a mi-match,
     apres un redeploiement, ne compte pas), finie, ESPN apparie, et 90 % des
     releves prevues reussies (plan) */
  r.complete = fin === 'terminee' && !!r.espn && r.tA <= r.d && (r.ok || 0) >= 0.9 * prevues;
  ecritLigne({ v: V, k: 'f', t, id, fin, r: raison || null, cr: r.cr || 0, ok: r.ok || 0, ko: r.ko || 0, pr: prevues, cp: r.complete ? 1 : 0 });
  console.log(`[en-jeu] ${fin} ${id} : ${Math.round(r.cr || 0)} credits` + (raison ? ` (${raison})` : '') +
              (fin === 'terminee' ? `, ${r.ok || 0}/${prevues} releve(s)${r.complete ? ', complete' : ', NON complete'}` : ''));
  S.suivis.delete(id);
  S.bilanDu = true;
  const n = completes(E);
  const cfg = config();
  if (n >= cfg.obsMatchs && !E.finObs) {
    E.finObs = { t, n };
    ecritLigne({ v: V, k: 'x', t, quoi: 'observation finie', n });
    console.log(`[en-jeu] observation finie : ${n} rencontre(s) complete(s) — plus aucune admission (PARIS_EN_JEU_OBS_MATCHS=${cfg.obsMatchs})`);
  }
}

// ------------------------------------------------------------ la releve des prix

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r3 = (x) => Math.round(x * 1000) / 1000;
const trois = (c) => (c ? [c['1'], c.N, c['2']] : null);
/* Le marche d'un livre, range sur NOS noms (domicile, exterieur) : l'issue est
   lue par son NOM, jamais par sa position, comme le reste du serveur. */
function prixDuMarche(livre, cle, m) {
  const mk = ((livre && livre.markets) || []).find((x) => x && x.key === cle);
  if (!mk || !Array.isArray(mk.outcomes)) return null;
  const o = (nom) => { const x = mk.outcomes.find((y) => y && y.name === nom); return x && Number(x.price) > 1 ? Number(x.price) : null; };
  const c = { 1: o(m.domicile), N: o('Draw'), 2: o(m.exterieur) };
  return ISSUES.every((i) => c[i]) ? c : null;
}
/** L'entree du journal pour UNE rencontre suivie dans la reponse /odds. */
function entreeDe(m, ev, t, deps, vv) {
  const e = { id: m.id };
  /* l'etat du catalogue a la releve : les gardes nonFermee, nonReglee et entreeVivante le lisent */
  if (m.ferme && m.ferme <= t) e.fe = 1;
  if (m.suspendu) e.su = 1;
  let regle = false;
  try { regle = typeof deps.estRegle === 'function' && !!deps.estRegle(m.id); } catch (er) { regle = false; }
  if (regle) e.rg = 1;
  if (m.ferme && vv.has(String(m.source.evenement))) e.vi = 0;
  if (!ev) { e.abs = 1; return e; }
  /* l'orientation : le fournisseur a deja inverse domicile et exterieur (paris_import, « prix releve dans l'autre orientation ») */
  e.o = ev.home_team === m.domicile && ev.away_team === m.exterieur ? 1 : 0;
  const nous = Object.assign({}, ev, { home_team: m.domicile, away_team: m.exterieur });
  const bf = (ev.bookmakers || []).find((b) => b && b.key === pm.BOURSE);
  e.lu = null;
  if (bf) {
    const mk = (bf.markets || []).find((x) => x && x.key === 'h2h');
    const lu = Date.parse((mk && mk.last_update) || '');
    if (isFinite(lu)) e.lu = lu; else if (mk) e.luManque = 1;
    const luL = Date.parse(bf.last_update || '');
    if (isFinite(luL)) e.lul = luL;
    const c = pm.lotDuLivre(bf, nous);
    if (c) {
      e.b = trois(c);
      const s = ISSUES.reduce((a, i) => a + 1 / c[i], 0);
      e.s = r5(s);
      const p = s >= SOMME_MIN && s <= SOMME_MAX ? pm.sansMarge(c) : null;
      if (p) e.pb = [r5(p['1']), r5(p.N), r5(p['2'])];
    }
    const lay = prixDuMarche(bf, 'h2h_lay', m);
    if (lay) e.lay = trois(lay);
    /* les limites (includeBetLimits) : le nom du champ n'est pas documente,
       on garde les cles brutes de la premiere issue (hors nom et prix) */
    if (mk && Array.isArray(mk.outcomes) && mk.outcomes[0]) {
      const brut = {};
      for (const [k, v] of Object.entries(mk.outcomes[0])) if (k !== 'name' && k !== 'price' && (typeof v === 'number' || typeof v === 'string')) brut[k] = v;
      if (Object.keys(brut).length) e.bl = brut;
    }
  }
  const ref = pm.referenceDe(nous);
  if (ref) { e.ref = ref.ref === 'betfair' ? 'b' : ref.ref === 'pinnacle' ? 'p' : 'm'; e.pr = [r5(ref.p['1']), r5(ref.p.N), r5(ref.p['2'])]; e.nl = ref.livres; }
  const pin = (ev.bookmakers || []).find((b) => b && b.key === 'pinnacle');
  if (pin) { const rp = pm.referenceDe(Object.assign({}, nous, { bookmakers: [pin] })); if (rp && rp.ref === 'pinnacle') e.pin = [r5(rp.p['1']), r5(rp.p.N), r5(rp.p['2'])]; }
  return e;
}

async function releveCotes(ligue, suivis, now, deps, cfg) {
  const E = litEtat();
  const ids = suivis.map((s) => s.m.id);
  const jour = E.credits.jours[jourDe(now)] || 0;
  /* les plafonds propres AVANT l'appel (le socle tient la part du jour) */
  if (E.credits.total + 1 > cfg.creditsObs || jour + 1 > cfg.creditsJour) {
    const raison = E.credits.total + 1 > cfg.creditsObs ? 'plafond de l observation' : 'plafond du jour';
    for (const id of ids) termine(id, now, 'incomplete', raison);
    ecritEtat();
    return;
  }
  const info = { classe: 2 };
  const limites = cfg.limites && !E.limitesCoupees;
  const params = { regions: 'eu', markets: 'h2h', oddsFormat: 'decimal',
                   eventIds: suivis.map((s) => s.m.source.evenement).join(','),
                   includeBetLimits: limites ? 'true' : undefined };
  let evs = null, erreur = null;
  try { evs = await deps.appel('/sports/' + ligue + '/odds', params, 1, 'en jeu ' + ligue, undefined, info); }
  catch (e) { erreur = e; }
  const t = deps.horloge();
  /* le cout : x-requests-last ; un delai sans en-tete compte par prudence ; une reponse 200 sans en-tete compte 1 */
  const x = info.dernier !== null && info.dernier !== undefined ? info.dernier
          : (info.comptePrudent ? info.comptePrudent : (erreur ? 0 : 1));
  compteCredits(x, ids, t);
  if (erreur) {
    const code = info.code || 'ERREUR';
    ecritLigne({ v: V, k: 'c', t, l: ligue, ids, x: info.dernier === undefined ? null : info.dernier, st: info.statut || null, ko: String(code).slice(0, 40) });
    for (const id of ids) { const r = E.rencontres[id]; if (r) r.ko = (r.ko || 0) + 1; }
    /* un refus du garde-fou (classe 2 : part du jour moins 80) arrete le suivi */
    if (code === 'REFUSE') for (const id of ids) termine(id, t, 'incomplete', 'part du jour (classe 2)');
    ecritEtat();
    return;
  }
  const parEv = new Map();
  for (const ev of Array.isArray(evs) ? evs : []) if (ev && ev.id) parEv.set(String(ev.id), ev);
  const vv = vivants(deps.catalogue());
  const entrees = suivis.map((s) => entreeDe(s.m, parEv.get(String(s.m.source.evenement)), t, deps, vv));
  ecritLigne({ v: V, k: 'c', t, l: ligue, ids, n: parEv.size, x: info.dernier === undefined ? null : info.dernier,
               st: info.statut || null, lim: limites ? 1 : 0, ev: entrees });
  for (const e of entrees) { const r = E.rencontres[e.id]; if (r) { S.sale = true; if (e.abs) r.ko = (r.ko || 0) + 1; else r.ok = (r.ok || 0) + 1; } }
  if (limites && x > 1) {
    E.limitesCoupees = true;
    ecritLigne({ v: V, k: 'x', t, quoi: 'limites coupees', x });
    console.log(`[en-jeu] includeBetLimits coute ${x} credits par releve : coupe (PARIS_EN_JEU_LIMITES ignoree desormais)`);
  }
  /* ---- LA SONDE DU last_update (voir ARRET_SANS_LU_MS) ---- */
  if (!E.sonde) {
    const avec = entrees.filter((e) => e.lu !== null && e.lu !== undefined).length;
    const sans = entrees.filter((e) => e.luManque).length;
    if (avec) {
      E.sonde = { ok: 1, t };
      ecritLigne({ v: V, k: 'sonde', t, ok: 1, avec, sans });
      console.log(`[en-jeu] sonde : le marche h2h de la bourse porte son last_update (${avec} rencontre(s)) — l observation continue`);
    } else if (sans) {
      E.arret = { raison: 'last_update absent du marche h2h de la bourse', t, jusqua: t + ARRET_SANS_LU_MS };
      ecritLigne({ v: V, k: 'sonde', t, ok: 0, avec, sans });
      console.log('[en-jeu] sonde : la bourse est la SANS last_update de marche — bourseVivante serait toujours faux : observation ARRETEE 7 jours (1 credit)');
      for (const s of [...S.suivis.values()]) termine(s.m.id, t, 'incomplete', 'arret : last_update absent');
    }
  }
  ecritEtat();
}

// ------------------------------------------------------------ ESPN, partage

/* Le `prendre` que la passe rapide donne a scores_espn : il compte les
   requetes et les refus DU DIRECT, a part de ceux du verrou (scores_espn.REFUS
   les compte aussi, par tableau), et declenche le recul sur 403/429. */
function prendreCompte(base, now) {
  const f = base || (typeof fetch === 'function' ? fetch : null);
  const j = jourDe(now);
  if (S.espn.jour !== j) S.espn = { jour: j, requetes: 0, refus: 0, statuts: {}, reculs: S.espn.reculs || 0, dernier: S.espn.dernier };
  const etat = { refus: 0, bloque: false };
  const prendre = async (u, op) => {
    S.espn.requetes++;
    let rep;
    try { if (!f) throw new Error('fetch absent'); rep = await f(u, op); }
    catch (e) { S.espn.refus++; etat.refus++; S.espn.dernier = String((e && e.message) || e).slice(0, 80); throw e; }
    if (!rep || !rep.ok) {
      const st = (rep && rep.status) || '?';
      S.espn.refus++; etat.refus++;
      S.espn.statuts[st] = (S.espn.statuts[st] || 0) + 1;
      S.espn.dernier = 'statut ' + st;
      if (st === 403 || st === 429) etat.bloque = true;
    }
    return rep;
  };
  return { prendre, etat };
}
async function releveEspn(suivis, now, deps, cfg) {
  if (now < S.recul.jusqua) return;
  const { prendre, etat } = prendreCompte(deps.fetchEspn, now);
  let par = null;
  try { par = await deps.lisEspn(suivis.map((s) => s.m), now, prendre); }
  catch (e) { par = null; dire('espn-erreur-' + jourDe(now), '[en-jeu] lecture ESPN impossible : ' + (e && e.message)); }
  const t = deps.horloge();
  if (etat.bloque) {
    S.recul.pas = S.recul.pas ? Math.min(RECUL_MAX_MS, S.recul.pas * 2) : RECUL_MIN_MS;
    S.recul.jusqua = t + S.recul.pas;
    S.espn.reculs = (S.espn.reculs || 0) + 1;
    ecritLigne({ v: V, k: 'eko', t, p: 'recul ' + Math.round(S.recul.pas / 1000) + ' s (' + S.espn.dernier + ')' });
    console.log(`[en-jeu] ESPN refuse (${S.espn.dernier}) : la passe rapide recule de ${Math.round(S.recul.pas / 1000)} s`);
  } else if (!etat.refus && par) S.recul.pas = 0;
  const E = litEtat();
  for (const s of suivis) {
    const su = par && par.get(s.m.id);
    if (!su) { ecritLigne({ v: V, k: 'eko', t, id: s.m.id, p: etat.refus ? 'refus' : 'non apparie' }); continue; }
    const l = { v: V, k: 'e', t, id: s.m.id, et: su.etat || null, st: su.statut || null,
                h: su.horloge === undefined ? null : su.horloge, pe: su.periode === undefined ? null : su.periode,
                af: su.affiche || '', s: su.score || null, r: Array.isArray(su.rouges) ? su.rouges : [0, 0] };
    const evj = JSON.stringify(su.evenements || []);
    if (S.dernierEv.get(s.m.id) !== evj) { l.ev = su.evenements || []; S.dernierEv.set(s.m.id, evj); }
    ecritLigne(l);
    const r = E.rencontres[s.m.id];
    if (r && !r.espn) { r.espn = t; S.sale = true; }
    if (su.etat === 'post' || su.fini) termine(s.m.id, t, 'terminee', null);
  }
}

// ------------------------------------------------------------ le tic

async function tic(now, deps) {
  const cfg = config();
  if (cfg.mode !== 'observe') return { fait: 'off' };
  if (S.enCours) return { fait: 'occupe' };
  S.enCours = true;
  try {
    const E = litEtat();
    const matchs = deps.catalogue() || [];
    /* reprise apres un redeploiement : les rencontres admises non finies reprennent */
    const parId = new Map(matchs.map((m) => [m.id, m]));
    for (const [id, r] of Object.entries(E.rencontres)) {
      if (r.etat === 'admise' && !r.fin && !S.suivis.has(id) && parId.has(id)) S.suivis.set(id, { m: parId.get(id), clubs: r.clubs || [] });
    }
    /* L'objet du catalogue est relu a CHAQUE tic : l'import le remplace (toutes
       les 12 h, ou a la main), et une rencontre fermee, suspendue ou deplacee
       APRES l'admission doit etre notee telle a la releve suivante (les gardes
       nonFermee et entreeVivante, l'appariement ESPN par l'heure). Trouve par
       la mutation du 11/10/2026 : l'objet fige a l'admission ne voyait jamais
       la fermeture. Sortie du catalogue, la rencontre garde le dernier vu. */
    for (const [id, s] of S.suivis) if (parId.has(id)) s.m = parId.get(id);
    /* ---- UNE RENCONTRE ADMISE SORTIE DU CATALOGUE NE RESTE PAS ENGAGEE ----
     * (relecture du 11/10/2026) La reprise ne la retrouve pas apres un
     * redeploiement : elle restait « admise » pour toujours, et son reste
     * estime (jusqu'a 115 credits) s'ajoutait a `engage` a chaque admission
     * suivante, du jour comme de l'observation. 130 min apres son coup
     * d'envoi (ou tout de suite si l'heure est illisible), elle finit
     * « incomplete ». */
    for (const [id, r] of Object.entries(E.rencontres)) {
      if (r.etat !== 'admise' || r.fin || S.suivis.has(id)) continue;
      const d = Number(r.d);
      if (!isFinite(d) || now > d + APRES_MAX_MS) termine(id, now, 'incomplete', 'absente du catalogue, 130 min passees');
    }
    /* l'admission : une fois par rencontre, ecrite */
    for (const x of aSuivre(matchs, now, cfg)) {
      if (E.rencontres[x.m.id]) continue;
      const a = admet(now, cfg, deps.quota);
      S.sale = true;
      E.rencontres[x.m.id] = { etat: a.ok ? 'admise' : 'refusee', tA: now, d: Number(x.m.debut), l: x.m.source.ligue, clubs: x.clubs, est: a.est,
                               c: cfg.cadenceS, cr: 0, ok: 0, ko: 0, raison: a.raison };
      if (!a.ok) E.rencontres[x.m.id].fin = now;
      ecritLigne({ v: V, k: 'a', t: now, id: x.m.id, l: x.m.source.ligue, e: x.m.source.evenement, dom: x.m.domicile,
                   ext: x.m.exterieur, d: Number(x.m.debut), cl: x.clubs, ok: a.ok ? 1 : 0, r: a.raison, est: a.est,
                   c: cfg.cadenceS, es: cfg.espnS, de: cfg.delaiS, ma: cfg.marge, ga: cfg.garde, fm: cfg.fermeMin });
      console.log(`[en-jeu] ${a.ok ? 'admise' : 'refusee'} ${x.m.id} (${x.m.domicile} - ${x.m.exterieur}) : ${a.est} credits estimes` +
                  (a.ok ? '' : ` — ${a.raison}`));
      if (a.ok) S.suivis.set(x.m.id, x);
    }
    if (S.sale) ecritEtat();
    /* les fins par le temps : 130 min, ou ESPN jamais apparie 30 min apres le coup d'envoi */
    for (const s of [...S.suivis.values()]) {
      const d = Number(s.m.debut), r = E.rencontres[s.m.id];
      if (now > d + APRES_MAX_MS) termine(s.m.id, now, r && r.espn ? 'terminee' : 'incomplete', r && r.espn ? 'fin sans etat post (130 min)' : 'espn jamais apparie');
      else if (r && !r.espn && now > d + SANS_ESPN_MS) termine(s.m.id, now, 'incomplete', 'espn non apparie 30 min apres le coup d envoi');
    }
    const suivis = [...S.suivis.values()];
    if (!suivis.length) { if (S.sale) ecritEtat(); return { fait: 'rien' }; }
    if (now - S.dernierEspn >= cfg.espnS * SECONDE) {
      S.dernierEspn = now;
      await releveEspn(suivis, now, deps, cfg);
    }
    const parLigue = new Map();
    for (const s of S.suivis.values()) {
      const l = s.m.source.ligue;
      if (!parLigue.has(l)) parLigue.set(l, []);
      parLigue.get(l).push(s);
    }
    for (const [l, lot] of parLigue) {
      if (now - (S.derniereReleve.get(l) || 0) < cfg.cadenceS * SECONDE) continue;
      S.derniereReleve.set(l, now);
      await releveCotes(l, lot, now, deps, cfg);
    }
    if (S.sale) ecritEtat();
    return { fait: 'tic', suivis: S.suivis.size };
  } finally { S.enCours = false; }
}

/**
 * Le branchement. `deps` :
 *   appel(chemin, params, cout, quoi, prioritaire, info)  paris_import.appel (socle)
 *   catalogue()        les rencontres du catalogue (paris.catalogue().matchs)
 *   lisEspn(lot, t, prendre)  la releve ESPN PARTAGEE (server.js, directSuivies)
 *   estRegle(id)       la rencontre est-elle deja reglee (game.parisRegles)
 *   quota()            { depense, part, reserve } du socle (part du jour, reserve de la classe 2)
 *   cle                ODDS_API_KEY est posee
 *   minuteries         false : aucun setInterval (les essais appellent tic)
 *   horloge()          l'heure (Date.now par defaut)
 * Rend { tic, arrete, actif }. Inerte (aucune minuterie, aucun fichier) si
 * PARIS_EN_JEU n'est pas `observe` ou sans cle.
 */
function planifie(deps0) {
  const deps = Object.assign({ horloge: () => Date.now() }, deps0 || {});
  if (typeof deps.lisEspn !== 'function') deps.lisEspn = (lot, t, prendre) => espn.releve(lot, { maintenant: t, marge: 6 * HEURE, prendre });
  if (typeof deps.catalogue !== 'function') deps.catalogue = () => require('./paris').catalogue().matchs;
  const cfg = config();
  const inerte = { tic: async () => ({ fait: 'off' }), arrete() {}, actif: false };
  if (cfg.mode === 'off') { console.log('[en-jeu] eteint (PARIS_EN_JEU vide) : aucune releve, aucun credit'); return inerte; }
  if (cfg.mode === 'inconnu') {
    console.log(`[en-jeu] PARIS_EN_JEU=${cfg.brut} inconnu : seul « observe » existe dans ce lot (la vente est le lot 12) — RIEN ne tourne`);
    return inerte;
  }
  if (!deps.cle || typeof deps.appel !== 'function') { console.log('[en-jeu] sans ODDS_API_KEY : inerte'); return inerte; }
  ligneDemarrage(cfg, deps);
  const pas = async () => {
    /* une panne repetee (catalogue illisible…) se dit une fois par jour, pas toutes les 5 s */
    try { await tic(deps.horloge(), deps); }
    catch (e) { const m = String((e && e.message) || e).slice(0, 120); dire('tic|' + jourDe(deps.horloge()) + '|' + m, '[en-jeu] tic : ' + m); }
    if (S.bilanDu || deps.horloge() - (S.bilanT || 0) >= HEURE) {
      S.bilanDu = false; S.bilanT = deps.horloge();
      let projection = null;
      try { projection = typeof deps.projection === 'function' ? deps.projection() : null; } catch (e) { projection = null; }
      bilanFichiers({ projection }).catch((e) => console.log('[en-jeu] bilan : ' + (e && e.message)));
    }
  };
  let minuterie = null;
  if (deps.minuteries !== false) { minuterie = setInterval(pas, 5 * SECONDE); if (minuterie.unref) minuterie.unref(); }
  return { tic: (t) => tic(t, deps), pas, arrete() { if (minuterie) clearInterval(minuterie); minuterie = null; }, actif: true };
}

/* La ligne de demarrage : reglages, ligues ecartees, clubs absents du
   calendrier en cours (un nom mal ecrit coupe un club sans bruit). */
function ligneDemarrage(cfg, deps) {
  let matchs = [];
  try { matchs = deps.catalogue() || []; } catch (e) { matchs = []; }
  const vus = new Set();
  for (const m of matchs) { vus.add(espn.normalise(m.domicile)); vus.add(espn.normalise(m.exterieur)); }
  const absents = cfg.equipes.filter((n) => !vus.has(espn.normalise(n)));
  console.log(`[en-jeu] OBSERVATION : ${cfg.equipes.length} club(s), ligues ${cfg.ligues.join(',') || 'AUCUNE'}, ` +
              `releve ${cfg.cadenceS} s, ESPN ${cfg.espnS} s, plafonds ${cfg.creditsObs} (observation) / ${cfg.creditsJour} (jour), ` +
              `${cfg.obsMatchs} rencontres completes au plus, limites ${cfg.limites ? 'oui' : 'non'} — rien de vendu ne change`);
  if (cfg.ecartees.length) console.log(`[en-jeu] ligue(s) ignoree(s) (non vendue au marche, sans tableau ESPN, ou pas du football) : ${cfg.ecartees.join(', ')}`);
  if (absents.length) console.log(`[en-jeu] club(s) absent(s) du calendrier en cours (orthographe The Odds API ?) : ${absents.join(', ')}`);
}

// ------------------------------------------------------------ l'etat lisible

/* ---- UNE LECTURE D'ETAT N'A AUCUN EFFET DE BORD ----
 * `/paris/import` (un GET admin) l'appelle, module eteint compris. Avant la
 * relecture du 11/10/2026, elle passait par `litEtat`, qui RENOMME un compteur
 * illisible : un simple GET ecrivait sur le volume. Ici : la memoire si le
 * module l'a deja lue, sinon le disque tel quel ; un fichier illisible se dit
 * (`compteurIllisible`) sans etre touche — le tic d'un module allume le mettra
 * de cote. */
function etatSansEffet() {
  if (ETAT) return ETAT;
  const { E, brut } = litDisque();
  if (E) return E;
  return Object.assign(etatNeuf(), { illisible: { t: null, octets: brut.length } });
}
function etat() {
  const cfg = config();
  const E = etatSansEffet();
  const rs = Object.entries(E.rencontres);
  return {
    mode: cfg.mode, valeur: cfg.brut || null,
    reglages: { equipes: cfg.equipes, ligues: cfg.ligues, ecartees: cfg.ecartees, cadenceS: cfg.cadenceS, espnS: cfg.espnS,
                delaiS: cfg.delaiS, marge: cfg.marge, garde: cfg.garde, fermeMin: cfg.fermeMin,
                creditsObs: cfg.creditsObs, creditsJour: cfg.creditsJour, obsMatchs: cfg.obsMatchs, limites: cfg.limites && !E.limitesCoupees },
    suivies: [...S.suivis.keys()],
    credits: { total: E.credits.total, aujourdhui: E.credits.jours[jourDe(Date.now())] || 0,
               mois: E.credits.mois[moisDe(Date.now())] || 0, appels: E.appels },
    rencontres: { admises: rs.filter(([, r]) => r.etat !== 'refusee').length, refusees: rs.filter(([, r]) => r.etat === 'refusee').length,
                  completes: rs.filter(([, r]) => r.complete).length, incompletes: rs.filter(([, r]) => r.etat === 'incomplete').length,
                  enCours: rs.filter(([, r]) => r.etat === 'admise' && !r.fin).length },
    arret: E.arret, sonde: E.sonde, finObs: E.finObs, compteurIllisible: !!E.illisible,
    espn: Object.assign({ recul: S.recul.jusqua > Date.now() ? { jusqua: new Date(S.recul.jusqua).toISOString(), pasS: S.recul.pas / 1000 } : null }, S.espn),
    journal: { jours: jours(), echecs: J.echecs, dernierEchec: J.dernierEchec },
    bilan: S.bilan ? { calcule: S.bilan.calcule, porte: S.bilan.porte, echantillon: S.bilan.echantillon } : lisBilanDisque(),
  };
}
function lisBilanDisque() {
  try { const b = JSON.parse(fs.readFileSync(fichierBilan(), 'utf8')); return { calcule: b.calcule, porte: b.porte, echantillon: b.echantillon }; }
  catch (e) { return null; }
}

/* =====================================================================
 * LE BILAN — LA PORTE ECRITE D'AVANCE (EXPLOITATION 8.12, 11/10/2026)
 * =====================================================================
 *
 * Une fonction pure de lignes du journal : le serveur la calcule chaque heure
 * (par morceaux, voir `bilanFichiers`) et `outils/releve_en_jeu.js` la rejoue
 * hors serveur sur les memes fichiers, pour 0 credit. Une definition fausse se
 * recalcule sur tout le brut garde.
 *
 * ---- POURQUOI LA PORTE DU PLAN D'ORIGINE A ETE REECRITE (sceptique du 09/10) ----
 * (a1) « battables contre la releve suivante » mesurait les buts A VENIR : un
 * systeme SANS fuite y laissait deja 1,34 a 1,88 % (sim_porte.txt, buts de
 * Poisson, regle exacte, D = 60 s), le meme chiffre avec une bourse en retard de
 * 60 s (sim_fuite.txt) ; (a2) recompensait un ESPN lent (49 % de battables a
 * ESPN instantane, 1 % a 90 s) ; (a3) etait tautologique avec GARDE. Supprimees.
 * La porte se juge par EVENEMENT (but ou rouge), sur deux questions :
 *  G1 le parieur INFORME : il voit l'evenement et demande T_E + 5, 15 ou 30 s,
 *     sur l'issue que l'evenement favorise, a la cote de la derniere releve
 *     d'avant sa demande ; la regle exacte d'acceptation l'accepte-t-elle ?
 *  G2 la bourse EN RETARD : une releve faite apres l'evenement, bourse vivante
 *     et vue par le fournisseur au moins 20 s apres T_E, montre-t-elle encore
 *     le prix d'avant ? C'est la fuite que le delai D cache tant que le retard
 *     reste sous D, et qu'un retard a peine plus long ouvrirait.
 * Un bourse en retard de 60 s passe G1 (le delai de 60 s et le score ESPN la
 * couvrent : sim_fuite.txt, 0 % d'acceptes) mais pas G2 : c'est la porte qui
 * doit la voir. Validee sur deux journaux synthetiques (paris_en_jeu.test.js).
 *
 * ---- LE RETARD D'ESPN LUI-MEME (relecture du 11/10/2026, bloquant) ----
 * T_E se date d'abord par l'horloge d'ESPN : si tout le flux d'ESPN (horloge
 * et faits) a D s de retard sur le terrain, T_E arrive D s trop TARD, et G1 et
 * G2, ancrees sur T_E, ne voient plus qu'un retard de la bourse SUPERIEUR a
 * celui d'ESPN. Demontre sur la vraie simulation : bourse en retard de 60 s,
 * ESPN en retard de 45 s -> porte VERTE (G1 0, G2 0/48) ; rouge a 5 et 30 s.
 * Aucune mesure du bilan ne le revelait (ESPN - T_E restait a 8 s : l'horloge
 * et la detection retardent ensemble). D'ou `retardEspn` : en 1re periode,
 * t - K - horloge (K = le coup d'envoi du catalogue) vaut le retard d'ESPN
 * PLUS le retard du coup d'envoi, jamais moins tant que le match ne commence
 * pas en avance ; son maximum sur la periode est une BORNE HAUTE du retard
 * d'ESPN. T_E (horloge ou lecture) est avance de cette borne : jamais plus
 * tard que le vrai fait, au plus `retardEspnMaxS` plus tot. Au-dela de ce
 * seuil (ou sans 5 lectures pour le dire), on ne sait plus separer un ESPN lent
 * d'un coup d'envoi tardif : G1 et G2 ne jugent pas la rencontre (« not
 * enough », jamais vert). Le seuil de 20 s est celui que G2 tolere deja
 * (`g2VuApresS`) : une avance de T_E de 20 s au plus ne fait voir a G2 aucune
 * bourse saine comme en retard (elle est suspendue ou deja au prix d'apres).
 * Pose SANS MESURE le 11/10/2026 : le bilan rapporte la borne par rencontre
 * (`latences.retardEspn`), a lire des la premiere rencontre (8.12).
 */

/* La porte, ecrite d'avance. Une porte non atteinte fait glisser la date,
   jamais le seuil (decision de l'assemblage du 09/10). */
const PORTE = Object.freeze({
  evenementsMin: 40,          // buts ou rouges dates ; regle de trois : 0 sur 40, borne a 95 % ~ 7,5 %
  rencontresMin: 20,          // completes : >= 90 % des releves prevues, ESPN apparie
  clubsMin: 5,
  joursMin: 14,
  deltasS: [5, 15, 30],       // G1 : la demande du parieur informe, en secondes apres T_E
  g1AcceptesMax: 0,
  g2FenetreS: 120,            // G2 : les releves de [T_E ; T_E + 120 s[, le prix d'apres a T_E + 120 s
  g2VuApresS: 20,             // ... dont le fournisseur a vu la bourse au moins 20 s apres T_E (datation a +-15 s)
  g2AbsorbeMin: 0.5,          // le prix a fait moins de la moitie du mouvement : prix d'avant
  g2MouvementMin: 0.05,       // evenement jugeable : la proba favorisee bouge d'au moins 5 points
  g2AvantS: 120, g2ApresS: 180,  // ... sans autre evenement dans [T_E - 120 s ; T_E + 180 s]
  g2PartMax: 0.05, g2JugeablesMin: 20,
  /* ^ les seuils de G2 (5 points, 20 s, la moitie, 120/180 s, 5 % sur 20) sont
     POSES SANS MESURE le 11/10/2026 : seuls les journaux synthetiques les
     valident. Les juger sur le journal reel : `conditions.G2` (fuites,
     jugeables) et `evenements[].g2Jugeable`. */
  g3VivanteMin: 0.95, g3HorsEvenementS: 120, g3RencontresClub: 3, g3ClubsMin: 4,
  g4MuetMax: 0.02,
  g5CoutUnMin: 0.99, g5CreditsRencontreMax: 100, g5ProjectionMax: 16000,
  /* g6Tolerance : le plan dit « la tolerance choisie par le joueur », sans
     chiffre ; 10 % est POSE SANS MESURE le 11/10/2026 (le bilan rapporte aussi
     la regle stricte, `taux[].accepteesStricte`, pour juger l'ecart). */
  g6AccepteesMin: 0.50, g6HorsEvenementS: 180, g6Tolerance: 0.10,
  /* favoriseMin : POSE SANS MESURE le 11/10/2026 ; il ne decide que l'issue
     que G1 essaie (les autres issues qui montent sont essayees aussi). Le juger :
     `evenements[].fav` contre l'issue de la regle. */
  favoriseMin: 1.02,          // une issue favorisee monte d'au moins 2 % relatifs
  marges: [0.06, 0.10, 0.15],
  /* le retard d'ESPN borne (voir plus haut) : au-dela, G1 et G2 ne jugent pas la rencontre */
  retardEspnMaxS: 20, retardEspnLecturesMin: 5,
});

/* Les reglages du bilan : ceux de la porte, et ceux de la vente prevue (delai,
   garde, fermeture, marge) — par defaut les memes que `config()`. */
function paramsBilan(p) {
  const cfg = config();
  const P = Object.assign({ delaiS: cfg.delaiS, cadenceS: cfg.cadenceS, garde: cfg.garde, fermeMin: cfg.fermeMin,
                            marge: cfg.marge, projection: null }, p || {});
  P.delaiMs = P.delaiS * SECONDE;
  P.cadenceMs = P.cadenceS * SECONDE;
  return P;
}

// ---- les cotes hypothetiques : le MEME habillage que la vente (cotes.habilleUnMarche)

const HAB = new Map();
function habille(pb, marge) {
  if (!pb) return null;
  const k = pb.join(',') + '|' + marge;
  if (HAB.has(k)) return HAB.get(k);
  let c = null;
  try {
    const r = cotes.habilleUnMarche({ 1: pb[0], N: pb[1], 2: pb[2] }, ISSUES, 1, marge);
    c = r ? r.cotes : null;
  } catch (e) { c = null; }
  if (HAB.size > 50000) HAB.clear();
  HAB.set(k, c);
  return c;
}
const IDX = { 1: 0, N: 1, 2: 2 };
const scoreDe = (s) => { const m = /^(\d+)-(\d+)$/.exec(String(s || '')); return m ? [Number(m[1]), Number(m[2])] : null; };
const rougesEgaux = (a, b) => !!a && !!b && (a.r || [0, 0])[0] === (b.r || [0, 0])[0] && (a.r || [0, 0])[1] === (b.r || [0, 0])[1];

/* ---- LES GARDES DE LA REGLE D'ACCEPTATION ----
 * Une demande `d` (heure d.t, issue d.o, cote vue d.cv tiree de la releve i)
 * est jugee a la releve j (la premiere reussie a d.t + delai ou apres) :
 * chaque garde rend VRAI si elle laisse passer. La table est EXPORTEE :
 * l'essai remplace chaque entree par « toujours vrai », rejoue SON scenario et
 * exige qu'il passe a tort — une garde que rien ne tient se voit.
 * Contexte : { d, i, j (releves : {t, e}), ei, ed, ej (lectures ESPN a i, a la
 * demande, a j), cf (cote fraiche a j), regle ('stricte' | 'min'), tol, P }.
 * Les gardes de la vente elle-meme (une demande par adresse, adresse de la
 * session, plafonds de mise et d'engagement, gain maximal, sequestre de la
 * mise) sont du lot 12 : rien ne se vend ici. */
const GARDES = {
  /* jugee au plus tot D apres la demande, abandonnee apres D + 2 x cadence */
  delai: (c) => c.j.t - c.d.t >= c.P.delaiMs && c.j.t - c.d.t <= c.P.delaiMs + 2 * c.P.cadenceMs,
  /* la bourse a j : presente, saine, fraiche (20 s), VUE APRES la demande (5 s) */
  bourseVivante: (c) => !!c.j.e.pb && c.j.e.lu !== null && c.j.e.lu !== undefined
    && c.j.e.lu >= c.d.t + 5 * SECONDE && c.j.t - c.j.e.lu <= BOURSE_FRAICHE_MS,
  /* la reference est la bourse, a i et a j (jamais Pinnacle ni la mediane : Pinnacle « may incur a delay ») */
  bourseSeule: (c) => c.i.e.ref === 'b' && c.j.e.ref === 'b',
  orientation: (c) => c.i.e.o === 1 && c.j.e.o === 1,
  entreeVivante: (c) => c.i.e.vi !== 0 && c.j.e.vi !== 0,
  nonFermee: (c) => !c.j.e.fe && !c.j.e.su,
  nonReglee: (c) => !c.j.e.rg,
  espnVivant: (c) => !!c.ej && c.j.t - c.ej.t <= ESPN_MUET_MS && c.ej.et === 'in',
  minute: (c) => !!c.ej && isFinite(Number(c.ej.h)) && c.ej.h !== null && (c.ej.pe === 1 || c.ej.pe === 2)
    && !(c.ej.pe === 2 && c.ej.h >= c.P.fermeMin * 60),
  /* fermee a la mi-temps et pendant les arrets de jeu de la 1re (horloge figee a 2 700) */
  miTemps: (c) => !!c.ej && c.ej.st !== 'STATUS_HALFTIME' && !(c.ej.pe === 1 && c.ej.h >= 2700) && !(c.ej.pe === 2 && c.ej.h < 2700),
  /* le score de REFERENCE est celui de la releve i, pas celui de la demande */
  scoreRef: (c) => !!c.ei && !!c.ed && c.ei.s === c.ed.s,
  score: (c) => !!c.ed && !!c.ej && c.ed.s === c.ej.s,
  rouge: (c) => rougesEgaux(c.ei, c.ed) && rougesEgaux(c.ed, c.ej),
  /* stricte : cote vue <= cote fraiche ; min : la cote fraiche, si elle n'a pas baisse de plus que la tolerance */
  coteVueMax: (c) => !!c.cf && (c.regle === 'min' ? c.cf >= c.d.cv * (1 - c.tol) : c.d.cv <= c.cf),
  garde: (c) => !!c.j.e.pb && prixAccepte(c) * c.j.e.pb[IDX[c.d.o]] <= 1 - c.P.garde,
};
function prixAccepte(c) { return c.regle === 'min' && c.cf ? Math.min(c.d.cv, c.cf) : c.d.cv; }
/** Juge une demande : { ok, refus } (la premiere garde qui refuse). */
function accepte(c) {
  for (const nom of Object.keys(GARDES)) {
    let passe = false;
    try { passe = !!GARDES[nom](c); } catch (e) { passe = false; }
    if (!passe) return { ok: false, refus: nom };
  }
  return { ok: true, refus: null, prix: prixAccepte(c) };
}
/* L'offre a la releve i, a l'heure t de la demande : bourse vivante a i,
   ESPN lu dans les 45 s, en jeu, dans la fenetre (1re periode avant 45:00,
   2e avant la fermeture), 1-N-2 cotable. Rend les cotes, ou null. */
function offre(i, ed, t, P, marge) {
  if (!i || !i.e || !i.e.pb || i.e.lu === null || i.e.lu === undefined || i.t - i.e.lu > BOURSE_FRAICHE_MS) return null;
  /* une releve de plus de cadence + 10 s n'est plus montree (« paused », plan corrige, mineurs) */
  if (t - i.t > P.cadenceMs + 10 * SECONDE) return null;
  if (!ed || t - ed.t > ESPN_MUET_MS || ed.et !== 'in' || !fenetreOuverte(ed, P)) return null;
  return habille(i.e.pb, marge);
}
function fenetreOuverte(l, P) {
  const h = Number(l.h);
  if (l.h === null || !isFinite(h) || l.st === 'STATUS_HALFTIME') return false;
  return (l.pe === 1 && h < 2700) || (l.pe === 2 && h >= 2700 && h < P.fermeMin * 60);
}
/* La fenetre de la condition G3/G4 : en jeu, mi-temps comprise, jusqu'a la fermeture. */
function fenetreJugee(l, P) { return !!l && l.et === 'in' && !(l.pe === 2 && Number(l.h) >= P.fermeMin * 60) && !(Number(l.pe) > 2); }
function vivante(r) { return !!r && !!r.e && !!r.e.pb && r.e.lu !== null && r.e.lu !== undefined && r.t - r.e.lu <= BOURSE_FRAICHE_MS; }

// ---- le regroupement par rencontre

function regroupe(lignes) {
  const g = new Map(), appels = [], sondes = [], admissions = [];
  const de = (id) => { if (!g.has(id)) g.set(id, { id, a: null, f: null, rel: [], esp: [], eko: 0 }); return g.get(id); };
  for (const l of lignes || []) {
    if (!l || typeof l !== 'object') continue;
    if (l.k === 'a' && l.id) { de(l.id).a = l; admissions.push(l); }
    else if (l.k === 'f' && l.id) de(l.id).f = l;
    else if (l.k === 'e' && l.id) de(l.id).esp.push(l);
    else if (l.k === 'eko' && l.id) de(l.id).eko++;
    else if (l.k === 'sonde') sondes.push(l);
    else if (l.k === 'c') {
      appels.push(l);
      const n = Array.isArray(l.ids) ? l.ids.length : 0;
      if (l.ko) { for (const id of l.ids || []) de(id).rel.push({ t: l.t, ko: l.ko, x: l.x, n }); }
      else for (const e of l.ev || []) if (e && e.id) de(e.id).rel.push({ t: l.t, e, x: l.x, n, abs: !!e.abs });
    }
  }
  for (const x of g.values()) {
    x.rel.sort((a, b) => a.t - b.t);
    x.esp.sort((a, b) => a.t - b.t);
    /* `ev` (les faits ESPN) n'est ecrit que quand il change : on le reporte */
    let dernier = [];
    for (const l of x.esp) { if (Array.isArray(l.ev)) dernier = l.ev; l.evc = dernier; }
  }
  return { g, appels, sondes, admissions };
}

/* recherche : la derniere lecture (ou releve) <= t, la premiere >= t */
function derniereAvant(liste, t) {
  let lo = 0, hi = liste.length - 1, r = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (liste[mid].t <= t) { r = liste[mid]; lo = mid + 1; } else hi = mid - 1; }
  return r;
}
function premiereApres(liste, t) {
  let lo = 0, hi = liste.length - 1, r = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (liste[mid].t >= t) { r = liste[mid]; hi = mid - 1; } else lo = mid + 1; }
  return r;
}

// ---- les evenements d'une rencontre (buts et rouges vus par ESPN)

/* ---- LA BORNE HAUTE DU RETARD D'ESPN D'UNE RENCONTRE (secondes) ----
 * En 1re periode, en jeu, horloge courante (sous 2 700, hors mi-temps) :
 * t - K - horloge = retard d'ESPN + retard du coup d'envoi (K = l'heure du
 * catalogue, `a.d`). Le MAXIMUM sur la periode : une lecture servie en retard
 * l'augmente (prudent), jamais ne le baisse. Moins de `retardEspnLecturesMin`
 * lectures : inconnue (null). Un coup d'envoi en avance le rendrait negatif :
 * borne a 0 (on n'avance jamais T_E dans le mauvais sens). */
function retardEspn(x, P) {
  const K = x.a ? Number(x.a.d) : NaN;
  if (!isFinite(K)) return { s: null, n: 0 };
  let max = -Infinity, n = 0;
  for (const l of x.esp) {
    const h = Number(l.h);
    if (l.et !== 'in' || l.pe !== 1 || l.h === null || l.h === undefined || !isFinite(h) || h >= 2700 || l.st === 'STATUS_HALFTIME') continue;
    n++;
    const v = (l.t - K) / SECONDE - h;
    if (v > max) max = v;
  }
  if (n < P.retardEspnLecturesMin) return { s: null, n };
  return { s: Math.max(0, max), n };
}
/* La datation : par l'horloge d'ESPN (la lecture de reference est la derniere
   avant la detection, dans la meme periode, horloge non figee), sinon par T_gel
   (le last_update fige de la bourse entre les deux lectures), sinon la lecture
   d'avant. `decale` (ms, la borne du retard d'ESPN, `retardEspn`) AVANCE les
   datations venues d'ESPN — l'horloge et la lecture d'avant arrivent en
   retard d'autant que le flux d'ESPN : sans lui, « un T_E trop tot rend le
   parieur plus informe » n'etait vrai que si ESPN etait a l'heure (relecture
   du 11/10/2026). T_gel vient de la bourse : il n'est pas decale, mais jamais
   plus tard que la detection corrigee (une bourse en retard gele en retard).
   Toujours : T <= detection corrigee, et pas plus de 300 s avant la detection. */
function evenementsDe(x, oks, decale) {
  const D = isFinite(Number(decale)) && Number(decale) > 0 ? Number(decale) : 0;
  const L = x.esp.filter((l) => l.s);
  const out = [];
  for (let k = 1; k < L.length; k++) {
    const a = L[k - 1], b = L[k];
    const sa = scoreDe(a.s), sb = scoreDe(b.s);
    if (!sa || !sb) continue;
    const ra = a.r || [0, 0], rb = b.r || [0, 0];
    const nouveaux = (b.evc || []).filter((f) => !(a.evc || []).some((y) => y[0] === f[0] && y[1] === f[1] && y[2] === f[2]));
    const faits = [];
    for (let s = 0; s < 2; s++) {
      for (let n = sa[s]; n < sb[s]; n++) faits.push({ type: 'b', camp: s === 0 ? 'd' : 'x' });
      for (let n = ra[s]; n < rb[s]; n++) faits.push({ type: 'r', camp: s === 0 ? 'd' : 'x' });
      if (sb[s] < sa[s]) out.push({ type: 'annule', camp: s === 0 ? 'd' : 'x', tDetect: b.t, ignore: true });
    }
    for (const f of faits) {
      /* l'horloge du fait : un detail neuf du meme type (et du meme camp s'il y en a un ; un csc peut porter l'autre equipe) */
      const memeType = nouveaux.filter((y) => y[1] === f.type);
      const cand = memeType.filter((y) => y[0] === f.camp).concat(memeType.filter((y) => y[0] !== f.camp));
      const det = cand.length ? cand.reduce((p, y) => (Number(y[2]) > Number(p[2]) ? y : p), cand[0]) : null;
      if (det) nouveaux.splice(nouveaux.indexOf(det), 1);
      const clock = det && isFinite(Number(det[2])) && det[2] !== null ? Number(det[2]) : null;
      let T = null, m = null;
      /* la periode du fait : celle des deux lectures qui l'encadrent ; a cheval
         (mi-temps) ou dans les arrets de jeu (horloge >= 2 700 en 1re), elle
         ne se date pas par l'horloge */
      const pe = a.pe === b.pe && (a.pe === 1 || a.pe === 2) ? a.pe : null;
      if (clock !== null && pe !== null) {
        const borne = pe === 1 ? 2700 : 5400;
        if (clock >= (pe - 1) * 2700 && clock < borne) {
          let ref = null;
          for (let q = k - 1; q >= 0; q--) { const l = L[q]; if (l.pe === pe && isFinite(Number(l.h)) && l.h !== null && l.h < borne && l.et === 'in') { ref = l; break; } }
          if (ref) { T = ref.t + (clock - ref.h) * SECONDE - D; m = 'horloge'; }
        }
      }
      if (T === null) {
        const g = oks.find((r) => r.t > a.t && r.t <= b.t + 60 * SECONDE && r.e && r.e.lu !== null && r.e.lu !== undefined
                                 && r.t - r.e.lu > BOURSE_FRAICHE_MS && r.e.lu >= a.t - 60 * SECONDE && r.e.lu <= b.t);
        if (g) { T = g.e.lu; m = 'gel'; }
      }
      if (T === null) { T = a.t - D; m = 'lecture'; }
      T = Math.min(b.t - D, Math.max(b.t - 300 * SECONDE, T));
      out.push({ type: f.type, camp: f.camp, T, m, tDetect: b.t, tAvant: a.t, clock });
    }
  }
  return out.filter((e) => !e.ignore).sort((p, q) => p.T - q.T);
}
/* L'issue que le fait favorise par la regle : but du domicile ou rouge de l'exterieur -> 1, et l'inverse -> 2. */
function issueRegle(e) { return (e.type === 'b') === (e.camp === 'd') ? '1' : '2'; }

// ---- le bilan d'une rencontre

function bilanMatch(x, P) {
  const a = x.a, f = x.f;
  const C = ((a && a.c) || P.cadenceS) * SECONDE;
  const oks = x.rel.filter((r) => !r.ko && !r.abs && r.e);
  const tA = a ? a.t : (x.rel[0] ? x.rel[0].t : 0);
  const tF = f ? f.t : Math.max(tA, ...(x.rel.length ? [x.rel[x.rel.length - 1].t] : [0]), ...(x.esp.length ? [x.esp[x.esp.length - 1].t] : [0]));
  const prevues = 1 + Math.floor(Math.max(0, tF - tA) / C);
  const apparie = x.esp.length > 0;
  const complete = !!a && a.ok === 1 && a.t <= a.d && !!f && f.fin === 'terminee' && apparie && oks.length >= 0.9 * prevues;
  const res = { id: x.id, ligue: a ? a.l : null, clubs: a ? a.cl || [] : [], dom: a ? a.dom : null, ext: a ? a.ext : null,
                admise: !!a && a.ok === 1, complete, apparie, releves: oks.length, prevues, tA, tF, evenements: [] };
  if (!res.admise) return res;
  const L = x.esp;
  const espnA = (t) => derniereAvant(L, t);
  /* le retard d'ESPN borne : mesurable, T_E en est avance ; sinon G1 et G2 ne jugent pas la rencontre */
  const ret = retardEspn(x, P);
  const mesurable = ret.s !== null && ret.s <= P.retardEspnMaxS;
  res.retardEspnS = ret.s === null ? null : Math.round(ret.s * 10) / 10;
  res.retardEspnLectures = ret.n;
  res.mesurable = mesurable;
  const evs = evenementsDe(x, oks, mesurable ? ret.s * SECONDE : 0);
  // ---- la fenetre jugee (en jeu jusqu'a la fermeture)
  const tIn = (L.find((l) => l.et === 'in') || {}).t;
  const l80 = L.find((l) => l.pe === 2 && Number(l.h) >= P.fermeMin * 60);
  const dansLeJeu = L.filter((l) => l.et === 'in');
  const tFerme = l80 ? l80.t : (dansLeJeu.length ? dansLeJeu[dansLeJeu.length - 1].t : tF);
  // ---- couts (G5) : credits de la fenetre 0-80e, part egale entre les rencontres de l'appel
  let creditsFenetre = 0, credits = 0;
  for (const r of x.rel) {
    const part = r.x > 0 && r.n > 0 ? r.x / r.n : 0;
    credits += part;
    if (tIn !== undefined && r.t >= tIn && r.t <= tFerme) creditsFenetre += part;
  }
  res.credits = r3(credits); res.creditsFenetre = r3(creditsFenetre);
  // ---- G3 : bourse vivante dans la fenetre, hors des 120 s qui suivent un evenement
  let vivN = 0, vivD = 0;
  const susp = [];
  let debutSusp = null;
  for (const r of x.rel.filter((y) => !y.ko)) {
    const l = espnA(r.t);
    if (!fenetreJugee(l, P)) continue;
    const apresEv = evs.some((e) => r.t >= e.T && r.t < e.T + P.g3HorsEvenementS * SECONDE);
    const v = !r.abs && vivante(r);
    if (!apresEv) { vivD++; if (v) vivN++; }
    /* la duree des suspensions, rapportee a part : last_update fige */
    const fige = !r.abs && r.e && r.e.lu !== null && r.e.lu !== undefined && r.t - r.e.lu > BOURSE_FRAICHE_MS;
    if (fige && debutSusp === null) debutSusp = r.e.lu;
    if (!fige && debutSusp !== null) { susp.push(r.t - debutSusp); debutSusp = null; }
  }
  res.bourse = { vivantes: vivN, jugees: vivD, suspensionsS: susp.map((d) => Math.round(d / 1000)) };
  // ---- G4 : ESPN muet (plus de 45 s sans lecture, ou horloge figee hors arrets et mi-temps)
  let muet = 0, ouvert = 0, figeDepuis = null;
  const Lf = L.filter((l) => tIn !== undefined && l.t >= tIn && l.t <= tFerme);
  for (let k = 1; k < Lf.length; k++) {
    const p = Lf[k - 1], q = Lf[k];
    const gap = q.t - p.t;
    ouvert += gap;
    if (gap > ESPN_MUET_MS) muet += gap - ESPN_MUET_MS;
    const enCoursHorloge = p.et === 'in' && q.et === 'in' && p.pe === q.pe && p.st !== 'STATUS_HALFTIME'
      && ((p.pe === 1 && Number(p.h) < 2700) || (p.pe === 2 && Number(p.h) < 5400));
    if (enCoursHorloge && Number(q.h) === Number(p.h)) {
      if (figeDepuis === null) figeDepuis = p.t;
      const fige = q.t - figeDepuis;
      if (fige > ESPN_MUET_MS && gap <= ESPN_MUET_MS) muet += Math.min(gap, fige - ESPN_MUET_MS);
    } else figeDepuis = null;
  }
  res.espn = { muetS: Math.round(muet / 1000), ouvertS: Math.round(ouvert / 1000), lectures: L.length };
  // ---- les evenements : G1 (parieur informe), G2 (bourse en retard), latences
  for (let n = 0; n < evs.length; n++) {
    const e = evs[n];
    const avant = derniereAvant(oks.filter((r) => r.e.pb), e.T - 1);
    const suivant = evs[n + 1], precedent = evs[n - 1];
    /* le prix d'apres : la premiere bourse vivante a T_E + 120 s ou apres (au-dela
       du retard que G2 cherche ; plus loin, la derive du temps qui passe — le
       nul qui monte a 0-0 en fin de match — se prendrait pour le saut) */
    const apresR = oks.find((r) => r.t >= e.T + P.g2FenetreS * SECONDE && vivante(r) && (!suivant || r.t < suivant.T));
    const pAv = avant ? avant.e.pb : null, pAp = apresR ? apresR.e.pb : null;
    let fav = [issueRegle(e)];
    if (pAv && pAp) {
      const monte = ISSUES.filter((o) => pAp[IDX[o]] / pAv[IDX[o]] > P.favoriseMin);
      if (monte.length) fav = monte;
    }
    const oStar = pAv && pAp ? fav.reduce((b, o) => (pAp[IDX[o]] - pAv[IDX[o]] > pAp[IDX[b]] - pAv[IDX[b]] ? o : b), fav[0]) : fav[0];
    const mouvement = pAv && pAp ? pAp[IDX[oStar]] - pAv[IDX[oStar]] : null;
    const ev = { type: e.type, camp: e.camp, T: e.T, m: e.m, tDetect: e.tDetect, fav, oStar, mouvement: mouvement === null ? null : r5(mouvement),
                 mesurable, g1: {}, g1Offres: 0 };
    // G1 : le parieur informe, regle STRICTE (jamais sur une rencontre au retard d'ESPN inconnu ou trop grand)
    let accepteG1 = false;
    for (const d of mesurable ? P.deltasS : []) {
      const td = e.T + d * SECONDE;
      const i = derniereAvant(oks, td);
      const ed = espnA(td);
      const cv = offre(i, ed, td, P, P.marge);
      if (!cv) { ev.g1[d] = 'no offer'; continue; }
      ev.g1Offres++;
      const j = premiereApres(oks, td + P.delaiMs);
      let acc = false, refus = null;
      for (const o of fav) {
        if (!cv[o]) continue;
        if (!j) { refus = 'delai'; continue; }
        const c = { d: { t: td, o, cv: cv[o] }, i, j, ei: espnA(i.t), ed, ej: espnA(j.t), cf: (habille(j.e.pb, P.marge) || {})[o] || null,
                    regle: 'stricte', tol: 0, P };
        const r = accepte(c);
        if (r.ok) acc = true; else refus = refus || r.refus;
      }
      ev.g1[d] = acc ? 'accepted' : 'refused: ' + (refus || 'not cotable');
      if (acc) accepteG1 = true;
    }
    ev.g1Accepte = accepteG1;
    // G2 : la bourse en retard
    const voisin = (precedent && precedent.T > e.T - P.g2AvantS * SECONDE) || (suivant && suivant.T < e.T + P.g2ApresS * SECONDE);
    /* jugeable : un fait DANS la fenetre de vente (la lecture d'ESPN d'avant le
       fait la montre ouverte : apres la fermeture, rien ne se vend et la derive
       de fin de match domine le saut), qui deplace la proba d'au moins 5 points,
       sans voisin */
    const avantE = derniereAvant(L, e.T);
    ev.g2Jugeable = !!(mesurable && pAv && pAp && mouvement !== null && Math.abs(mouvement) >= P.g2MouvementMin && !voisin
                       && avantE && fenetreOuverte(avantE, P));
    ev.g2Fuite = false;
    if (ev.g2Jugeable) {
      for (const r of oks) {
        if (r.t < e.T || r.t >= e.T + P.g2FenetreS * SECONDE) continue;
        if (!vivante(r) || r.e.lu < e.T + P.g2VuApresS * SECONDE) continue;
        const fait = (r.e.pb[IDX[oStar]] - pAv[IDX[oStar]]) / mouvement;
        if (fait < P.g2AbsorbeMin) { ev.g2Fuite = true; ev.g2Releve = r.t; break; }
      }
    }
    // latences rapportees : T_espn - T_saut, T_espn - T_gel
    if (pAv) {
      const saut = oks.find((r) => r.t > e.T && r.e.pb && Math.abs(r.e.pb[IDX[oStar]] - pAv[IDX[oStar]]) > 0.10);
      if (saut) ev.espnMoinsSautS = Math.round((e.tDetect - (saut.e.lu !== null && saut.e.lu !== undefined ? saut.e.lu : saut.t)) / 1000);
    }
    const gel = oks.find((r) => r.t > e.T && r.e.lu !== null && r.e.lu !== undefined && r.t - r.e.lu > BOURSE_FRAICHE_MS && r.e.lu >= e.T - 60 * SECONDE);
    if (gel) ev.espnMoinsGelS = Math.round((e.tDetect - gel.e.lu) / 1000);
    ev.espnMoinsTES = Math.round((e.tDetect - e.T) / 1000);
    res.evenements.push(ev);
  }
  // ---- G6 et les taux : les demandes hypothetiques (releve i, issue cotable), a la releve i
  const dem = {};
  for (const marge of P.marges.concat(P.marges.indexOf(P.marge) < 0 ? [P.marge] : [])) {
    const t0 = { offres: 0, releves: 0, cotables: 0, stricte: 0, min: 0, horsEv: 0, minHorsEv: 0 };
    for (const i of oks) {
      const ed = espnA(i.t);
      if (!ed || !fenetreOuverte(ed, P) || ed.et !== 'in') continue;
      t0.releves++;
      const cv = offre(i, ed, i.t, P, marge);
      if (!cv) continue;
      t0.cotables++;
      const j = premiereApres(oks, i.t + P.delaiMs);
      const horsEv = !evs.some((e) => i.t >= e.T && i.t < e.T + P.g6HorsEvenementS * SECONDE);
      for (const o of ISSUES) {
        if (!cv[o]) continue;
        t0.offres++;
        if (horsEv) t0.horsEv++;
        if (!j) continue;
        const base = { d: { t: i.t, o, cv: cv[o] }, i, j, ei: ed, ed, ej: espnA(j.t), cf: (habille(j.e.pb, marge) || {})[o] || null, P };
        if (accepte(Object.assign({}, base, { regle: 'stricte', tol: 0 })).ok) t0.stricte++;
        if (accepte(Object.assign({}, base, { regle: 'min', tol: P.g6Tolerance })).ok) { t0.min++; if (horsEv) t0.minHorsEv++; }
      }
    }
    dem[String(marge)] = t0;
  }
  res.demandes = dem;
  return res;
}

// ---- l'assemblage et la porte

const part = (a, b) => (b > 0 ? a / b : null);
function quantile(v, q) { if (!v.length) return null; const s = v.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; }
const pc = (x) => (x === null || x === undefined ? 'n/a' : (Math.round(x * 10000) / 100) + ' %');

/* ---- LA PROJECTION DU MOIS DE VENTE (condition 6 du plan) ----
 * « direct, plus la base, plus les autres chantiers en service, calculee sur
 * le calendrier reel du jour de la porte, sous 16 000 sur 20 000 ».
 * `pr` : un nombre (la base du mois SANS l'observation, donnee a la main), ou
 * la projection du socle { credits, jourDuMois, mois } (x-requests-used x 30 /
 * jour du mois), dont on retire ce que l'observation a coute ce mois-la (au
 * meme rythme). Le direct vendu : credits moyens d'une rencontre complete du
 * coup d'envoi a la fermeture (les appels partages deja divises), fois les
 * rencontres des clubs suivis par 30 jours, comptees sur les admissions du
 * journal (refusees comprises : c'est le calendrier) sur 7 jours au moins. */
function projectionVente(pr, appels, admissions, comp) {
  if (pr === null || pr === undefined) return null;
  let base = null;
  if (typeof pr === 'number' && isFinite(pr)) base = pr;
  else if (pr && typeof pr === 'object' && isFinite(Number(pr.credits)) && Number(pr.jourDuMois) > 0 && pr.mois) {
    const obs = appels.filter((l) => moisDe(l.t) === pr.mois).reduce((a, l) => a + (l.x > 0 ? l.x : 0), 0);
    base = Number(pr.credits) - obs * 30 / Number(pr.jourDuMois);
  }
  if (base === null) return null;
  const vus = new Map();
  for (const a of admissions) if (!vus.has(a.id)) vus.set(a.id, a.t);
  const ts = [...vus.values()];
  const span = ts.length > 1 ? (Math.max(...ts) - Math.min(...ts)) / JOUR : 0;
  if (!comp.length || span < 7) return { base: Math.round(base), vente: null, total: null, pourquoi: 'calendar under 7 days' };
  const moy = comp.reduce((a, r) => a + r.creditsFenetre, 0) / comp.length;
  const parMois = ts.length / span * 30;
  const vente = moy * parMois;
  return { base: Math.round(base), vente: Math.round(vente), total: Math.round(base + vente),
           rencontresMois: Math.round(parMois * 10) / 10, creditsRencontre: Math.round(moy * 10) / 10 };
}

function assemble(rs, appels, sondes, admissions, P) {
  const comp = rs.filter((r) => r.complete);
  const evs = [];
  for (const r of comp) for (const e of r.evenements) evs.push(Object.assign({ id: r.id }, e));
  const clubsVus = new Set();
  for (const r of comp) for (const c of r.clubs) clubsVus.add(c);
  const t0 = comp.length ? Math.min(...comp.map((r) => r.tA)) : null;
  const t1 = comp.length ? Math.max(...comp.map((r) => r.tF)) : null;
  const joursObs = t0 === null ? 0 : (t1 - t0) / JOUR;
  /* ---- L'ECHANTILLON DE G1 : DES EVENEMENTS JUGES, PAS SEULEMENT DATES ----
   * « 0 sur 40, borne a 95 % ~ 7,5 % » ne tient que si les 40 sont 40 ESSAIS :
   * un evenement sans offre au parieur informe (issue non cotable, releve trop
   * vieille, apres la fermeture) ou dans une rencontre ou le retard d'ESPN
   * n'est pas borne n'en est pas un (relecture du 11/10/2026 : 62, 60 et 40
   * offres sur 80 evenements dans la simulation saine). */
  const evsM = evs.filter((e) => e.mesurable);
  const juges = evsM.filter((e) => e.g1Offres > 0);
  const nonMesurables = comp.filter((r) => !r.mesurable);
  const echantillon = { evenements: evs.length, evenementsJuges: juges.length, rencontres: comp.length, clubs: clubsVus.size, jours: Math.round(joursObs * 10) / 10,
                        admises: rs.filter((r) => r.admise).length, incompletes: rs.filter((r) => r.admise && !r.complete).length,
                        retardEspnInconnu: nonMesurables.length };
  const C = {};
  // G1 : une seule acceptation rougit, quel que soit l'echantillon ; l'echantillon manque se dit « not enough »
  const g1Acc = evsM.filter((e) => e.g1Accepte).length;
  const parDelta = {};
  for (const d of P.deltasS) parDelta[d] = { offres: evsM.filter((e) => e.g1[d] && e.g1[d] !== 'no offer').length, acceptees: evsM.filter((e) => e.g1[d] === 'accepted').length };
  C.G1 = { ok: g1Acc <= P.g1AcceptesMax, acceptes: g1Acc, evenements: evs.length, juges: juges.length, parDelta, seuil: P.g1AcceptesMax,
           texte: `informed bettor accepted on ${g1Acc} of ${juges.length} judged events (max ${P.g1AcceptesMax})` };
  /* G2. Sous 20 jugeables, rien ne se conclut (« not enough », pas « G2 red » :
     une lecture « red » ferait croire a une fuite au lieu de prolonger) — SAUF si
     les fuites deja vues depassent 5 % de 20 : la porte est alors rouge quoi que
     disent les jugeables a venir. */
  const jug = evs.filter((e) => e.g2Jugeable), fu = jug.filter((e) => e.g2Fuite);
  const g2Part = part(fu.length, jug.length);
  const g2Conclut = jug.length >= P.g2JugeablesMin || fu.length > P.g2PartMax * P.g2JugeablesMin;
  C.G2 = { ok: jug.length >= P.g2JugeablesMin && g2Part <= P.g2PartMax, mesurable: g2Conclut,
           manque: `${jug.length} judgeable event(s) for G2 < ${P.g2JugeablesMin}`,
           fuites: fu.length, jugeables: jug.length, part: g2Part, seuil: P.g2PartMax,
           texte: `stale live exchange price after the event on ${fu.length} of ${jug.length} judgeable events (${pc(g2Part)}, max ${pc(P.g2PartMax)}` +
                  (jug.length < P.g2JugeablesMin ? `; not measurable under ${P.g2JugeablesMin}` : '') + ')' };
  // G3 et la part d'ESPN apparie, club par club
  const clubs = {};
  for (const r of rs.filter((y) => y.admise)) {
    for (const c of r.clubs) {
      const k = clubs[c] || (clubs[c] = { rencontres: 0, completes: 0, appariees: 0, vivantes: 0, jugees: 0, muetS: 0, ouvertS: 0 });
      k.rencontres++;
      if (r.apparie) k.appariees++;
      if (!r.complete) continue;
      k.completes++;
      k.vivantes += r.bourse.vivantes; k.jugees += r.bourse.jugees;
      k.muetS += r.espn.muetS; k.ouvertS += r.espn.ouvertS;
    }
  }
  const vendables = [];
  for (const [c, k] of Object.entries(clubs)) {
    k.vivante = part(k.vivantes, k.jugees);
    k.vendable = k.completes >= P.g3RencontresClub && k.vivante !== null && k.vivante >= P.g3VivanteMin && k.appariees === k.rencontres;
    k.pourquoi = k.vendable ? null
      : k.completes < P.g3RencontresClub ? `not enough: ${k.completes} complete match(es) < ${P.g3RencontresClub}`
      : k.appariees < k.rencontres ? `ESPN matched ${k.appariees} of ${k.rencontres} matches`
      : `live exchange on ${pc(k.vivante)} of judged polls (min ${pc(P.g3VivanteMin)})`;
    if (k.vendable) vendables.push(c);
  }
  const susp = [].concat(...comp.map((r) => r.bourse.suspensionsS));
  /* G3 ne conclut qu'avec au moins 4 clubs a 3 rencontres completes : en dessous, « not enough » */
  const clubsJuges = Object.values(clubs).filter((k) => k.completes >= P.g3RencontresClub).length;
  C.G3 = { ok: vendables.length >= P.g3ClubsMin, mesurable: clubsJuges >= P.g3ClubsMin, vendables, clubs, seuil: P.g3ClubsMin,
           manque: `${clubsJuges} club(s) with ${P.g3RencontresClub} complete matches < ${P.g3ClubsMin}`,
           suspensionsS: { n: susp.length, mediane: quantile(susp, 0.5), p90: quantile(susp, 0.9), max: susp.length ? Math.max(...susp) : null },
           texte: `${vendables.length} club(s) with a live exchange on >= ${pc(P.g3VivanteMin)} of polls and ESPN on every match (min ${P.g3ClubsMin})` };
  // G4
  const muet = comp.reduce((a, r) => a + r.espn.muetS, 0), ouvert = comp.reduce((a, r) => a + r.espn.ouvertS, 0);
  C.G4 = { ok: ouvert > 0 && part(muet, ouvert) <= P.g4MuetMax, mesurable: ouvert > 0, manque: 'no ESPN open time',
           muetS: muet, ouvertS: ouvert, part: part(muet, ouvert), seuil: P.g4MuetMax,
           texte: `ESPN silent ${pc(part(muet, ouvert))} of open time (max ${pc(P.g4MuetMax)})` };
  // G5
  const xs = appels.filter((l) => l.x !== null && l.x !== undefined);
  const un = xs.filter((l) => l.x <= 1).length;
  const maxR = comp.length ? Math.max(...comp.map((r) => r.creditsFenetre)) : null;
  const proj = projectionVente(P.projection, appels, admissions, comp);
  const total = appels.reduce((a, l) => a + (l.x > 0 ? l.x : 0), 0);
  C.G5 = { ok: xs.length > 0 && part(un, xs.length) >= P.g5CoutUnMin && maxR !== null && maxR <= P.g5CreditsRencontreMax
              && !!proj && proj.total !== null && proj.total < P.g5ProjectionMax,
           appels: appels.length, avecCout: xs.length, auPlusUn: part(un, xs.length), creditsRencontreMax: maxR, credits: total,
           projection: proj, seuils: { auPlusUn: P.g5CoutUnMin, rencontre: P.g5CreditsRencontreMax, projection: P.g5ProjectionMax },
           texte: `x-requests-last <= 1 on ${pc(part(un, xs.length))} of calls (min ${pc(P.g5CoutUnMin)}), ` +
                  `at most ${maxR === null ? 'n/a' : Math.round(maxR * 10) / 10} credits per match kick-off to ${P.fermeMin}' (max ${P.g5CreditsRencontreMax}), ` +
                  `month projection with live betting sold ${!proj ? 'not given' : proj.total === null ? 'not measurable (' + proj.pourquoi + ')' : proj.total} (max ${P.g5ProjectionMax})` };
  // G6 et les taux par marge
  const taux = {};
  for (const m of Object.keys((comp[0] && comp[0].demandes) || {})) {
    const s = { releves: 0, cotables: 0, offres: 0, stricte: 0, min: 0, horsEv: 0, minHorsEv: 0 };
    for (const r of comp) { const d = r.demandes[m]; if (!d) continue; for (const k of Object.keys(s)) s[k] += d[k]; }
    taux[m] = { cotable: part(s.cotables, s.releves), accepteesStricte: part(s.stricte, s.offres), accepteesMin: part(s.min, s.offres),
                accepteesMinHorsEvenement: part(s.minHorsEv, s.horsEv), offres: s.offres, horsEvenement: s.horsEv };
  }
  const t = taux[String(P.marge)] || { accepteesMinHorsEvenement: null, horsEvenement: 0 };
  C.G6 = { ok: t.accepteesMinHorsEvenement !== null && t.accepteesMinHorsEvenement >= P.g6AccepteesMin, part: t.accepteesMinHorsEvenement,
           mesurable: t.accepteesMinHorsEvenement !== null, manque: 'no request outside the 3 min after events',
           demandes: t.horsEvenement, seuil: P.g6AccepteesMin, tolerance: P.g6Tolerance, marge: P.marge,
           texte: `${pc(t.accepteesMinHorsEvenement)} of requests accepted outside 3 min after an event, at min(seen, fresh) within ${pc(P.g6Tolerance)} (min ${pc(P.g6AccepteesMin)})` };
  // latences rapportees (b)
  const lat = (k) => { const v = evs.map((e) => e[k]).filter((y) => y !== undefined && y !== null); return { n: v.length, mediane: quantile(v, 0.5), p90: quantile(v, 0.9) }; };
  const rets = comp.map((r) => r.retardEspnS).filter((v) => v !== null && v !== undefined);
  const latences = { espnMoinsSautS: lat('espnMoinsSautS'), espnMoinsGelS: lat('espnMoinsGelS'), espnMoinsTES: lat('espnMoinsTES'),
                     datation: { horloge: evs.filter((e) => e.m === 'horloge').length, gel: evs.filter((e) => e.m === 'gel').length, lecture: evs.filter((e) => e.m === 'lecture').length },
                     /* la borne du retard d'ESPN par rencontre complete (s) : au-dela du seuil, la rencontre n'est pas jugee par G1/G2 */
                     retardEspn: { n: comp.length, connues: rets.length, mediane: quantile(rets, 0.5), p90: quantile(rets, 0.9),
                                   max: rets.length ? Math.max(...rets) : null, seuil: P.retardEspnMaxS, nonJugees: nonMesurables.length } };
  // l'echantillon, puis la porte
  const manque = [];
  if (echantillon.evenementsJuges < P.evenementsMin) {
    manque.push(`${echantillon.evenementsJuges} event(s) judged for the informed bettor < ${P.evenementsMin} (${echantillon.evenements} dated` +
                (nonMesurables.length ? `; ESPN may lag over ${P.retardEspnMaxS} s, or unknown, on ${nonMesurables.length} of ${comp.length} complete match(es): not judged` : '') + ')');
  }
  if (echantillon.rencontres < P.rencontresMin) manque.push(`${echantillon.rencontres} complete match(es) < ${P.rencontresMin}`);
  if (echantillon.clubs < P.clubsMin) manque.push(`${echantillon.clubs} club(s) < ${P.clubsMin}`);
  if (echantillon.jours < P.joursMin) manque.push(`${echantillon.jours} day(s) < ${P.joursMin}`);
  /* une condition qui ne peut pas conclure (echantillon) dit « not enough », jamais « red » */
  const K6 = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
  for (const k of K6) if (!C[k].ok && C[k].mesurable === false) manque.push(C[k].manque);
  const raisons = [];
  if (manque.length) raisons.push('not enough: ' + manque.join(', '));
  for (const k of K6) if (!C[k].ok && C[k].mesurable !== false) raisons.push(k + ' red: ' + C[k].texte);
  const sonde = sondes.length ? sondes[sondes.length - 1] : null;
  if (sonde && !sonde.ok) raisons.push('probe: the exchange h2h market has no last_update');
  const porte = { verte: raisons.length === 0, raisons, echantillon, clubsVendables: vendables };
  return { v: V, porte, echantillon, conditions: C, taux, latences, sonde: sonde ? { ok: !!sonde.ok, t: sonde.t } : null,
           rencontres: rs.map((r) => ({ id: r.id, clubs: r.clubs, complete: r.complete, apparie: r.apparie, releves: r.releves, prevues: r.prevues,
                                        credits: r.credits, creditsFenetre: r.creditsFenetre, evenements: (r.evenements || []).length,
                                        retardEspnS: r.retardEspnS === undefined ? null : r.retardEspnS, mesurable: !!r.mesurable })),
           evenements: evs.map((e) => ({ id: e.id, type: e.type, camp: e.camp, T: e.T, m: e.m, fav: e.fav, mouvement: e.mouvement,
                                         mesurable: !!e.mesurable, g1: e.g1, g2Jugeable: e.g2Jugeable, g2Fuite: e.g2Fuite })),
           params: { delaiS: P.delaiS, cadenceS: P.cadenceS, garde: P.garde, fermeMin: P.fermeMin, marge: P.marge } };
}

/**
 * LE BILAN : une fonction pure des lignes du journal. `params` : delaiS,
 * cadenceS, garde, fermeMin, marge, projection (credits du mois projetes par
 * le socle, x-requests-used x 30 / jour du mois) ; le reste de la porte vient
 * de PORTE. Sous l'echantillon minimal, la porte n'est pas verte et la raison
 * commence par « not enough ».
 */
function bilan(lignes, params) {
  const P = Object.assign({}, PORTE, paramsBilan(params));
  const { g, appels, sondes, admissions } = regroupe(lignes);
  const rs = [...g.values()].map((x) => bilanMatch(x, P));
  return assemble(rs, appels, sondes, admissions, P);
}

/* ---- LE BILAN DU SERVEUR, PAR MORCEAUX ----
 * Le journal se lit jour par jour et le bilan rencontre par rencontre, en
 * rendant la main a la boucle entre chaque (setImmediate) : sur 20 Mo, un
 * calcul d'un bloc tiendrait le serveur de jeux quelques centaines de ms
 * (relecture du 09/10). Le resultat va sur le volume (en deux temps). */
const cede = () => new Promise((r) => setImmediate(r));
function lisLignes(txt) {
  const out = [];
  for (const s of String(txt || '').split('\n')) { if (!s.trim()) continue; try { out.push(JSON.parse(s)); } catch (e) { /* ligne coupee : ignoree */ } }
  return out;
}
async function bilanFichiers(params) {
  if (S.bilanEnCours) return S.bilan;
  S.bilanEnCours = true;
  try {
    const lignes = [];
    for (const j of jours()) {
      try { for (const l of lisLignes(fs.readFileSync(path.join(dossierJournal(), j.jour + '.jsonl'), 'utf8'))) lignes.push(l); } catch (e) { /* jour illisible */ }
      await cede();
    }
    const P = Object.assign({}, PORTE, paramsBilan(params));
    const { g, appels, sondes, admissions } = regroupe(lignes);
    const rs = [];
    for (const x of g.values()) { rs.push(bilanMatch(x, P)); await cede(); }
    const b = assemble(rs, appels, sondes, admissions, P);
    b.calcule = new Date().toISOString();
    S.bilan = b;
    try {
      fs.mkdirSync(dossierData(), { recursive: true });
      const tmp = fichierBilan() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(b) + '\n');
      fs.renameSync(tmp, fichierBilan());
    } catch (e) { console.log('[en-jeu] bilan non ecrit : ' + (e && e.message)); }
    return b;
  } finally { S.bilanEnCours = false; }
}

module.exports = { V, EQUIPES_DEFAUT, LIGUES_DEFAUT, PORTE, GARDES, config, decoupeEquipes, aSuivre, admet, estimation,
                   planifie, tic, etat, bilan, bilanFichiers, accepte, offre, habille, regroupe, evenementsDe, retardEspn, lisLignes,
                   reponseJournal, jours, recharge, dossierJournal, fichierEtat, fichierBilan, prendreCompte,
                   _S: S, ESPN_MUET_MS, BOURSE_FRAICHE_MS, AVANT_MS, APRES_MAX_MS, SANS_ESPN_MS, RECUL_MIN_MS, RECUL_MAX_MS, ARRET_SANS_LU_MS };
