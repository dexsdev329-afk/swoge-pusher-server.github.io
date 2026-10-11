'use strict';
/*
 * LE VERROU D'HEURE REELLE DU TENNIS (11/10/2026).
 *
 * ---- pourquoi ----
 * Le proprietaire (11/10/2026) : « tennis faut reussir a le mettre au prix du
 * marche ». Le prix du marche a deux issues existe (prix_marche.js, lot 3) et
 * le tennis y est OBSERVE en production depuis le 11/10. Ce qui bloquait sa
 * vente : un seul verrou de fermeture, l'heure du catalogue — approximative au
 * tennis, ou les matchs s'enchainent sur un court. Le football a un second
 * verrou, l'etat et l'heure lus sur le tableau d'ESPN (paris.ouvert,
 * HEURES_REELLES). Depuis le 11/10, le tableau public d'ESPN porte aussi les
 * rencontres de tennis (scores_espn.releveTennisTableau). Ce module le lit, le
 * pose au meme verrou et compte la couverture.
 *
 * ---- trois modes, une variable, VIDE par defaut (prix_ligues.verrouTennis) ----
 *   PARIS_TENNIS_VERROU vide   aucune minuterie, aucune requete, aucun fichier
 *                              lu ni ecrit (meme par /paris/import) : rien ne
 *                              change ;
 *   observe                    les deux tableaux toutes les 15 min (la cadence
 *                              de la passe large du football), la couverture
 *                              comptee et gardee sur le volume, RIEN de pose ni
 *                              de vendu ; 0 credit ;
 *   actif                      toutes les 60 s (la passe proche du football) :
 *                              l'etat et l'heure ESPN poses au second verrou
 *                              pour TOUT le tennis (Elo compris : fermer plus
 *                              tot ne vend rien de plus), et le tennis VENDU au
 *                              marche ouvert seulement si apparie « pre »
 *                              depuis moins de paris.TENNIS_APPARIEMENT_MAX_MS.
 *
 * ---- ce qui ferme, toujours ----
 * ESPN refuse (statut, abandon a 8 s, reponse sans `events`) : la passe ne pose
 * rien et l'appariement vieillit — le tennis vendu ferme en 150 s. 403 ou 429,
 * sur un tableau du tennis OU SUR N'IMPORTE QUEL AUTRE tableau ESPN (football,
 * NHL… : scores_espn.blocages) : la passe recule de 2 min, puis 4, 8… 30 min
 * (meme recul que le direct en jeu, paris_en_jeu.js ; ce ne sont pas des
 * mesures : aucun refus des tableaux de tennis n'a ete observe). Le tennis
 * cede la place : un lecteur de plus ne doit jamais couter au football vendu
 * (relecture du 11/10, le risque ecarte au lot 7). Un redemarrage repart sans
 * appariement : ferme jusqu'a la premiere passe reussie.
 *
 * ---- ce qui est mesure (le carnet, DATA_DIR/tennis_verrou.json) ----
 * Par rencontre de tennis vue dans les 36 h avant son heure : apparie ou non a
 * sa DERNIERE passe avant l'heure, ambigu, et si ESPN l'a vue EN JEU alors que
 * le catalogue la disait encore a venir (de combien de minutes) — c'est la
 * fuite que le verrou ferme, et c'est elle qui coutait au tennis a l'Elo.
 * Puis, suivie jusqu'a 6 h APRES son heure (mesure seule, rien n'est pose pour
 * elle) : le passage « pre » -> « in » (porte T3) et le vainqueur ESPN (la
 * justesse de l'appariement, T1). Par jour, les tics, requetes, refus et
 * 403/429 (T2) — sur le volume, pas en memoire : un redeploiement ne les
 * efface pas. Ecrit en deux temps, au plus une fois par minute ; lecture
 * refusee jamais ecrasee ; contenu illisible mis de cote (meme schema que
 * prix_observe.js).
 */
const fs = require('fs');
const path = require('path');
const espn = require('./scores_espn');
const prixLigues = require('./prix_ligues');
const paris = require('./paris');
const regJournal = require('./reglement_journal');

const SECONDE = 1000, MINUTE = 60 * SECONDE, H = 60 * MINUTE, JOUR = 24 * H;
/* 36 h devant : l'horizon de la passe large du verrou du football (server.js,
   verrouFrais). Au-dela, une rencontre de tennis VENDUE n'est pas appariee,
   donc fermee. Releve du 11/10/2026 16:09 UTC : les 11 rencontres de tennis
   ouvertes du calendrier public commencaient toutes dans les 36 h. */
const HORIZON_MS = 36 * H;
/* 6 h derriere, pour la MESURE seule (relecture du 11/10/2026) : sans elle, le
   passage pre -> in d'une rencontre qui commence apres l'heure du catalogue
   (le cas courant au tennis : « suivi de » sur un court) n'etait jamais vu, et
   la porte T3 n'aurait mesure que les departs en avance. 6 h : la marge deja
   prise par le direct (server.js, directSuivies). Rien n'est pose pour elles
   (paris.ouvert les ferme a l'heure du catalogue) ; 0 requete de plus — les
   memes journees (scores_espn.joursTennis : trois au plus). */
const APRES_MS = 6 * H;
const CADENCE_ACTIF_MS = 60 * SECONDE;
const CADENCE_OBSERVE_MS = 15 * MINUTE;
const RECUL_MIN_MS = 2 * MINUTE, RECUL_MAX_MS = 30 * MINUTE;
const ECRITURE_MS = MINUTE;
const LIGNE_MS = H;
const GARDE_JOURS = 14;
/* ---- LA PORTE T1, ECRITE D'AVANCE (EXPLOITATION 8.8nonies bis) ----
 * Par circuit : >= 95 % des rencontres appariees a leur derniere passe avant
 * leur heure, sur >= 100 rencontres et >= 3 tournois, sur 14 jours glissants.
 * 95 % : le seuil de la porte A des coupes (8.11). Une rencontre vendue non
 * appariee est FERMEE (pas un risque, une rencontre de moins a l'offre) : sous
 * 95 %, plus d'une rencontre sur vingt disparaitrait de l'offre par rapport a
 * l'Elo d'aujourd'hui. 100 rencontres : a 95 %, la borne basse de Wilson est
 * de 88,8 % — on ne bascule pas sur une semaine d'un seul tournoi.
 * ET la justesse : 0 desaccord entre le vainqueur ESPN de la rencontre
 * appariee (tableau public, « post ») et le resultat que l'ombre du reglement
 * a lu pour la meme rencontre du catalogue (reglement_journal, API interne
 * d'ESPN, autre appariement : `meme`, 36 h) — 0 credit. Sans minimum : seules
 * les rencontres de tennis PARIEES passent par l'ombre ; le nombre compare est
 * dit, et un seul desaccord ferme la porte (un faux appariement ouvre ou ferme
 * la vente sur la mauvaise rencontre). */
const PORTE = Object.freeze({ couverture: 0.95, rencontres: 100, tournois: 3, jours: GARDE_JOURS, desaccords: 0 });
/* ---- LA PORTE T2 (disponibilite du verrou), ECRITE D'AVANCE ----
 * Les 7 derniers jours UTC COMPLETS, chacun : >= 1 200 tics `actif` (20 h sur
 * 24 a 60 s : un redeploiement ou deux ne font pas tomber un jour, une journee
 * a moitie eteinte si), au moins une requete du circuit, refus du circuit
 * <= 1 % des requetes, et AUCUN 403/429 — ni sur le tennis, ni sur un autre
 * tableau ESPN (le football vendu au marche en depend). Un jour fautif :
 * false ; un jour incomplet sans faute : null (la date glisse). */
const PORTE_T2 = Object.freeze({ jours: 7, ticsMin: 1200, refusMax: 0.01 });
/* ---- LA PORTE T3 (le retard d'ESPN a passer « in »), ECRITE D'AVANCE ----
 * C'est le risque que le verrou ferme : une rencontre lancee qu'ESPN dit
 * encore « pre ». Ce que le tableau gratuit permet d'en mesurer, sur les
 * passages pre -> in vus en `actif` (derniere vue « pre » et premiere vue « in »
 * a <= 150 s d'ecart) avec une heure ESPN valide au premier « in » :
 *  (a) au premier « in », ESPN porte deja un jeu termine dans <= 5 % des cas
 *      (un jeu ~ 3 a 5 min : au-dela, ESPN etait en retard d'un jeu) ;
 *  (b) la derniere vue « pre » est au plus 300 s apres l'heure de debut qu'ESPN
 *      ecrit au premier « in », au 95e centile. 300 s : la resolution de cette
 *      heure — copies du 11/10/2026 a 16:04 : les 519 rencontres finies ou en
 *      jeu (508 a heure valide) portent une heure multiple de 5 min, les douze
 *      minutes 0, 5… 55 representees ; les 46 « pre » a heure valide,
 *      seulement :00 (24) ou :30 (22) — ESPN la reecrit au debut, a 5 min pres
 *      (indice, non prouve : c'est ce que (b) lit).
 * Sur >= 100 passages par circuit. Ce que T3 ne mesure PAS : un retard de
 * moins d'un jeu ou de 5 min — le proprietaire l'accepte par ecrit (comme P4
 * et P5) avant la bascule. */
const PORTE_T3 = Object.freeze({ passages: 100, ecartMaxS: 150, jeuxPartMax: 0.05, preApresDebutP95S: 300 });

const S = {
  derniere: 0, derniereReussie: 0,
  recul: { jusqua: 0, pas: 0 },
  espn: { jour: null, passes: 0, requetes: 0, refus: 0, illisibles: 0, statuts: {}, reculs: 0, ailleurs: 0, dernier: null },
  passe: null,
  ligneA: -Infinity,
  blocagesVus: 0,
};

function jourDe(t) { return new Date(t).toISOString().slice(0, 10); }
const pct = (x) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);
const objet = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Les 403/429 vus sur les tableaux ESPN qui ne sont PAS ceux du tennis, depuis le demarrage. */
function autresBlocages() {
  let n = 0;
  for (const [k, v] of Object.entries(espn.blocages ? espn.blocages() : {})) if (!/^tennis\//.test(k)) n += Number(v) || 0;
  return n;
}

// -------------------------------------------------------------- le carnet

function fichier() { return path.join((process.env.DATA_DIR || './data').trim(), 'tennis_verrou.json'); }
function vide() { return { v: 1, rencontres: {}, jours: {} }; }
let ETAT = null, SALE = false, ECRIT_A = 0, MINUTERIE = null;
const DIT = { lecture: -Infinity, ecriture: -Infinity };
function dit(quoi, message) {
  const t = Date.now();
  if (t - DIT[quoi] < H && t >= DIT[quoi]) return;
  DIT[quoi] = t;
  console.log('[tennis] carnet du verrou : ' + message);
}
/** Le carnet en memoire, lu une fois ; null si le fichier ne se LIT pas (rien n'est note ni ecrase). */
function carnet() {
  if (ETAT) return ETAT;
  let brut;
  try { brut = fs.readFileSync(fichier(), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') { ETAT = vide(); return ETAT; }
    dit('lecture', 'lecture refusee (' + ((e && (e.code || e.message)) || e) + ') — rien n est note, on relit a la prochaine passe');
    return null;
  }
  try {
    const j = JSON.parse(brut);
    if (!j || typeof j !== 'object' || j.v !== 1 || !objet(j.rencontres)) throw new Error('forme inattendue');
    ETAT = { v: 1, rencontres: j.rencontres, jours: objet(j.jours) ? j.jours : {} };
  } catch (e) {
    const aCote = fichier() + '.illisible-' + Date.now();
    try { fs.renameSync(fichier(), aCote); } catch (e2) { /* deja parti */ }
    console.log('[tennis] carnet du verrou illisible (' + String(e.message || e).slice(0, 80) + '), mis de cote sous ' + path.basename(aCote) + ' — on repart d un carnet vide');
    ETAT = vide();
  }
  return ETAT;
}
function purge(st, t) {
  const limite = t - GARDE_JOURS * JOUR;
  for (const [id, r] of Object.entries(st.rencontres)) if (!(r && Number(r.d) >= limite)) delete st.rencontres[id];
  const j0 = jourDe(limite);
  for (const j of Object.keys(st.jours || {})) if (!(j >= j0)) delete st.jours[j];
}
/** Ecrit maintenant ce qui a change (en deux temps). Vrai si le carnet est a jour sur le disque. */
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
  ETAT = null; SALE = false; ECRIT_A = 0;
  S.derniere = 0; S.derniereReussie = 0; S.recul = { jusqua: 0, pas: 0 };
  S.espn = { jour: null, passes: 0, requetes: 0, refus: 0, illisibles: 0, statuts: {}, reculs: 0, ailleurs: 0, dernier: null };
  S.passe = null; S.ligneA = -Infinity;
  /* un vrai redemarrage repart de 0 des deux cotes ; ici le compteur de
     scores_espn survit : « rien de neuf depuis » */
  S.blocagesVus = autresBlocages();
}

/* Le compte du jour (UTC) au carnet : tics par mode, et par circuit requetes,
   refus et 403/429 ; `ailleurs` : les 403/429 des AUTRES tableaux ESPN. */
function jourCarnet(st, t) {
  if (!st) return null;
  if (!objet(st.jours)) st.jours = {};
  const j = jourDe(t);
  const x = objet(st.jours[j]) ? st.jours[j] : (st.jours[j] = {});
  if (!objet(x.tics)) x.tics = {};
  if (!(Number(x.ailleurs) >= 0)) x.ailleurs = 0;
  for (const c of ['atp', 'wta']) if (!objet(x[c])) x[c] = { requetes: 0, refus: 0, bloques: 0 };
  return x;
}

/* Une ligne de la releve au carnet.
   AVANT l'heure du catalogue : la DERNIERE passe fait foi (`ap`, `amb`, `pa`) ;
   la premiere vue en jeu avant l'heure est gardee (`en`, `av` en minutes, `st`
   le statut ESPN).
   Avant ET apres (jusqu'a APRES_MS) : le passage pre -> in pour T3 — `dp` la
   derniere vue « pre » avant le premier « in », `ed` l'heure ESPN (valide) au
   premier « in »/« post », `jx` les jeux deja joues a ce moment, `ec` l'ecart
   en secondes entre ces deux vues, `mo` le mode ('a' actif, 'o' observe) — et
   `vq` le vainqueur ESPN ('1' notre domicile, '2' notre exterieur) pour T1.
   Une rencontre vue pour la premiere fois APRES son heure n'entre pas (elle
   n'a pas de couverture). */
function note(st, l, su, t, mode) {
  const id = String(l.id);
  const avant = Number(l.debut) > t;
  let r = st.rencontres[id];
  if (!r) {
    if (!avant) return;
    r = st.rencontres[id] = { l: String(l.ligue), c: l.tour, pr: t, n: 0, a: 0 };
  }
  if (avant) {
    r.d = Number(l.debut) || 0; r.de = t; r.n++;
    r.ap = l.resultat === 'apparie' ? 1 : 0;
    r.amb = l.resultat === 'ambigu' ? 1 : 0;
    r.pa = l.resultat === 'panne' ? 1 : 0;
    if (l.resultat === 'apparie') {
      r.a++;
      r.hv = su && su.heureValide ? 1 : 0;
      if (su && su.tournoi) r.to = String(su.tournoi).slice(0, 80);
    }
  }
  if (l.resultat !== 'apparie' || !su) return;
  if (su.etat === 'pre') { if (!r.en) r.dp = t; }
  else if ((su.etat === 'in' || su.etat === 'post') && !r.en) {
    r.en = t; r.et = su.etat; r.st = String(su.statut || '').slice(0, 40);
    r.av = Math.max(0, Math.round((r.d - t) / MINUTE));
    r.ed = su.heureValide && Number(su.dateEspn) > 0 ? Number(su.dateEspn) : 0;
    r.jx = Number(su.jeux) >= 0 && su.jeux !== null ? Number(su.jeux) : 0;
    r.mo = mode === 'actif' ? 'a' : 'o';
    r.ec = r.dp ? Math.round((t - r.dp) / SECONDE) : null;
  }
  if ((su.vainqueur === '1' || su.vainqueur === '2') && !r.vq) r.vq = su.vainqueur;
}

function recule(now, pourquoi) {
  S.recul.pas = S.recul.pas ? Math.min(RECUL_MAX_MS, S.recul.pas * 2) : RECUL_MIN_MS;
  S.recul.jusqua = now + S.recul.pas;
  S.espn.reculs = (S.espn.reculs || 0) + 1;
  console.log(`[tennis] ${pourquoi} : le verrou du tennis recule de ${Math.round(S.recul.pas / 1000)} s — le tennis vendu au marche reste FERME`);
}

// --------------------------------------------------------------- la passe

/**
 * Une passe. `matchs` : le catalogue. Rend la Map a poser au second verrou
 * (paris.poseHeuresReelles) en mode `actif`, null sinon (eteint, observe,
 * recul, panne). N'appelle ESPN que s'il y a du tennis dans [-6 h ; +36 h].
 * La Map ne porte que les rencontres A VENIR (celles d'apres l'heure sont
 * suivies pour la mesure seule).
 */
async function passe(matchs, t, opts) {
  const o = opts || {};
  const mode = prixLigues.verrouTennis();
  if (!mode) return null;
  const now = Number(t) || Date.now();
  const j = jourDe(now);
  if (S.espn.jour !== j) S.espn = { jour: j, passes: 0, requetes: 0, refus: 0, illisibles: 0, statuts: {}, reculs: S.espn.reculs || 0, ailleurs: S.espn.ailleurs || 0, dernier: S.espn.dernier };
  const st = carnet();
  const jr = jourCarnet(st, now);
  if (jr) { jr.tics[mode] = (Number(jr.tics[mode]) || 0) + 1; marque(); }
  S.derniere = now;
  if (now < S.recul.jusqua) return null;
  /* un 403/429 sur un AUTRE tableau ESPN depuis la derniere passe : on recule
     sans rien demander (relecture du 11/10/2026) */
  const ailleurs = autresBlocages();
  if (ailleurs > S.blocagesVus) {
    const neufs = ailleurs - S.blocagesVus;
    S.blocagesVus = ailleurs;
    S.espn.ailleurs = (S.espn.ailleurs || 0) + neufs;
    if (jr) { jr.ailleurs += neufs; marque(); }
    recule(now, `ESPN refuse ailleurs (${neufs} 403/429 sur un autre tableau)`);
    return null;
  }
  const dansLot = (m) => m && !m.ferme && m.source && espn.tourDe(m.source.ligue)
    && Number(m.debut) > now - APRES_MS && Number(m.debut) <= now + HORIZON_MS;
  const lot = (Array.isArray(matchs) ? matchs : []).filter(dansLot);
  const aVenir = (m) => Number(m.debut) > now;
  if (!lot.length) {
    S.passe = { t: now, mode, rencontres: 0, apres: 0, parCircuit: {}, parTournoi: {}, vendues: { rencontres: 0, appariees: 0 }, nonAppariees: [] };
    S.derniereReussie = now;
    return mode === 'actif' ? new Map() : null;
  }
  S.espn.passes++;
  let r = null;
  try { r = await espn.releveTennisTableau(lot, { prendre: o.prendre }); }
  catch (e) { r = null; S.espn.dernier = String((e && e.message) || e).slice(0, 80); }
  let refus = 0, bloque = false;
  for (const [tour, s] of Object.entries((r && r.tours) || {})) {
    S.espn.requetes += s.requetes || 0; S.espn.refus += s.refus || 0; S.espn.illisibles += s.illisibles || 0;
    refus += s.refus || 0;
    if (s.dernier) S.espn.dernier = s.dernier;
    let bl = 0;
    for (const [k, v] of Object.entries(s.statuts || {})) {
      S.espn.statuts[k] = (S.espn.statuts[k] || 0) + v;
      if (String(k) === '403' || String(k) === '429') { bloque = true; bl += Number(v) || 0; }
    }
    if (jr && jr[tour]) { jr[tour].requetes += s.requetes || 0; jr[tour].refus += s.refus || 0; jr[tour].bloques += bl; }
  }
  if (jr) marque();
  if (!r) refus++;
  if (bloque) recule(now, `ESPN refuse (${S.espn.dernier})`);
  else if (!refus) S.recul.pas = 0;
  if (!r) return null;

  /* le carnet, puis l'instantane de la passe (les rencontres A VENIR seules) */
  const parTournoi = {}, parCircuit = {}, nonAppariees = [];
  const vendues = { rencontres: 0, appariees: 0 };
  let nAvenir = 0, nApres = 0;
  for (const l of r.rencontres) {
    const su = r.par.get(l.id);
    if (st) note(st, l, su, now, mode);
    if (!(Number(l.debut) > now)) { nApres++; continue; }
    nAvenir++;
    for (const [cle, tab] of [[l.ligue, parTournoi], [l.tour, parCircuit]]) {
      const x = tab[cle] || (tab[cle] = { rencontres: 0, appariees: 0, ambigues: 0, sans: 0, panne: 0 });
      x.rencontres++;
      if (l.resultat === 'apparie') x.appariees++; else if (l.resultat === 'ambigu') x.ambigues++;
      else if (l.resultat === 'panne') x.panne++; else x.sans++;
    }
    if (prixLigues.vendue(l.ligue)) { vendues.rencontres++; if (l.resultat === 'apparie') vendues.appariees++; }
    if (l.resultat !== 'apparie' && nonAppariees.length < 20)
      nonAppariees.push({ id: l.id, ligue: l.ligue, dom: l.dom, ext: l.ext, debut: new Date(l.debut).toISOString(), resultat: l.resultat,
                          proches: l.proches || [], candidats: l.candidats || undefined });
  }
  if (st) marque();
  S.passe = { t: now, mode, rencontres: nAvenir, apres: nApres, parCircuit, parTournoi, vendues, nonAppariees,
              jours: Object.fromEntries(Object.entries(r.tours).map(([k, s]) => [k, s.jours])) };
  if (!refus) S.derniereReussie = now;
  ditLaPasse(now);
  if (mode !== 'actif') return null;
  /* a poser : les rencontres A VENIR seulement — exactement ce qui etait pose
     avant que la mesure ne suive les rencontres apres leur heure */
  const aPoser = new Map();
  const ids = new Set(lot.filter(aVenir).map((m) => m.id));
  for (const [id, s] of r.par) if (ids.has(id)) aPoser.set(id, s);
  return aPoser;
}

/* Au journal, au plus une fois par heure : la couverture de la passe, ce qu'ESPN
   a vu en jeu avant l'heure du catalogue, et les refus. */
function ditLaPasse(t) {
  if (t - S.ligneA < LIGNE_MS && t >= S.ligneA) return;
  S.ligneA = t;
  const p = S.passe;
  if (!p) return;
  const c = Object.entries(p.parTournoi).map(([k, x]) => `${k} ${x.appariees}/${x.rencontres}` + (x.ambigues ? ` (${x.ambigues} ambigue(s))` : '') + (x.panne ? ` (${x.panne} en panne)` : '')).join(', ');
  const m = mesure(t);
  const avant = ['atp', 'wta'].map((k) => (m.parCircuit[k] ? `${k} ${m.parCircuit[k].enJeuAvant.n}` : null)).filter(Boolean).join(', ');
  const passages = ['atp', 'wta'].map((k) => (m.parCircuit[k] ? `${k} ${m.parCircuit[k].passages.n}` : null)).filter(Boolean).join(', ');
  console.log(`[tennis] verrou (${p.mode}) : ${c || 'aucune rencontre dans les 36 h'}`
    + (p.vendues.rencontres ? ` ; vendues au marche ${p.vendues.appariees}/${p.vendues.rencontres} appariees` : '')
    + ` ; vues en jeu avant l heure du catalogue (14 j) : ${avant || '0'}`
    + ` ; passages pre->in mesures (T3, 14 j) : ${passages || '0'}`
    + ` ; ESPN ${S.espn.requetes} requete(s), ${S.espn.refus} refus aujourd hui`);
}

// --------------------------------------------------------- la mesure, la porte

function mediane(v) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b), k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}
/** Le centile `q` (rang le plus proche, 0 < q <= 1) ; null sans valeur. */
function centile(v, q) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
/** Le resultat ('1'|'2') que l'ombre du reglement a lu pour chaque rencontre (0 credit, reglement_journal). */
function resultatsDuReglement() {
  let om = {};
  try { const b = regJournal.brut(); om = (b && objet(b.ombre)) ? b.ombre : {}; } catch (e) { om = {}; }
  return (id) => {
    const e = om[id];
    const f = e && (e.dernierFini || e.alors);
    return f && (f.resultat === '1' || f.resultat === '2') ? f.resultat : null;
  };
}
/**
 * La mesure sur le carnet : les rencontres dont l'heure est PASSEE, sur 14
 * jours. `o.st` : le carnet a lire (defaut : celui en memoire, lu au besoin) ;
 * `o.resultat(id)` : le resultat du reglement, pour la justesse (T1).
 */
function mesure(now, o) {
  const t = now || Date.now();
  const opts = o || {};
  const st = Object.prototype.hasOwnProperty.call(opts, 'st') ? opts.st : (ETAT || carnet());
  const resultat = typeof opts.resultat === 'function' ? opts.resultat : null;
  const parCircuit = {}, parTournoi = {};
  const ajoute = (tab, cle, r, id) => {
    const x = tab[cle] || (tab[cle] = { rencontres: 0, appariees: 0, ambigues: 0, panne: 0, tournois: new Set(), enJeuAvant: [], finiesAvant: 0,
                                        passages: [], comparees: 0, desaccords: [] });
    x.rencontres++; x.appariees += r.ap ? 1 : 0; x.ambigues += r.amb ? 1 : 0; x.panne += r.pa ? 1 : 0;
    x.tournois.add(r.l);
    /* vue en jeu AVANT l'heure du catalogue (la fuite que le verrou ferme) */
    if (r.en && Number(r.en) < Number(r.d)) {
      if (r.et === 'in') x.enJeuAvant.push(Number(r.av) || 0); else x.finiesAvant++;
    }
    /* T3 : le passage pre -> in vu en actif, a <= 150 s d'ecart, heure ESPN valide */
    if (r.en && r.et === 'in' && r.mo === 'a' && r.ec !== null && r.ec !== undefined && Number(r.ec) <= PORTE_T3.ecartMaxS
        && Number(r.ed) > 0 && Number(r.dp) > 0) {
      x.passages.push({ jx: Number(r.jx) || 0, pad: (Number(r.dp) - Number(r.ed)) / SECONDE, ret: (Number(r.en) - Number(r.ed)) / SECONDE });
    }
    /* T1, justesse : le vainqueur ESPN contre le resultat du reglement */
    if (resultat && (r.vq === '1' || r.vq === '2')) {
      const res = resultat(id);
      if (res) { x.comparees++; if (res !== r.vq) x.desaccords.push(id); }
    }
  };
  for (const [id, r] of Object.entries((st && st.rencontres) || {})) {
    if (!r || !(Number(r.d) <= t) || Number(r.d) < t - GARDE_JOURS * JOUR) continue;
    ajoute(parCircuit, r.c === 'atp' || r.c === 'wta' ? r.c : '?', r, id);
    ajoute(parTournoi, r.l, r, id);
  }
  const fige = (x) => {
    const pad = x.passages.map((p) => p.pad), ret = x.passages.map((p) => p.ret);
    const unJeu = x.passages.filter((p) => p.jx >= 1).length;
    return {
      rencontres: x.rencontres, appariees: x.appariees, ambigues: x.ambigues, panne: x.panne,
      part: x.rencontres ? pct(x.appariees / x.rencontres) : null, tournois: x.tournois.size,
      enJeuAvant: { n: x.enJeuAvant.length, medianeMin: mediane(x.enJeuAvant), maxMin: x.enJeuAvant.length ? Math.max(...x.enJeuAvant) : null },
      finiesAvant: x.finiesAvant,
      passages: { n: x.passages.length, apresUnJeu: unJeu, partApresUnJeu: x.passages.length ? pct(unJeu / x.passages.length) : null,
                  preApresDebutS: { mediane: mediane(pad), p95: centile(pad, 0.95), max: pad.length ? Math.max(...pad) : null },
                  inApresDebutS: { mediane: mediane(ret), p95: centile(ret, 0.95), max: ret.length ? Math.max(...ret) : null } },
      justesse: resultat ? { comparees: x.comparees, desaccords: x.desaccords.length, ids: x.desaccords.slice(0, 10) } : null,
    };
  };
  const out = { jours: GARDE_JOURS, parCircuit: {}, parTournoi: {} };
  for (const [k, x] of Object.entries(parCircuit)) out.parCircuit[k] = fige(x);
  for (const [k, x] of Object.entries(parTournoi)) out.parTournoi[k] = fige(x);
  return out;
}
/** La porte T1 par circuit : true, false (couverture sous le seuil, ou un desaccord) ou null (pas assez). */
function porte(m) {
  const out = {};
  for (const k of ['atp', 'wta']) {
    const x = m.parCircuit[k];
    const des = x && x.justesse ? x.justesse.desaccords : 0;
    const comp = x && x.justesse ? ` ; matching checked on ${x.justesse.comparees} settled games` : '';
    if (des > PORTE.desaccords) {
      out[k] = { ok: false, raison: `ESPN matching disagrees with settlement on ${des} game(s)` + comp };
    } else if (!x || x.rencontres < PORTE.rencontres || x.tournois < PORTE.tournois) {
      out[k] = { ok: null, raison: 'not enough games yet (' + (x ? x.rencontres : 0) + '/' + PORTE.rencontres + ', ' + (x ? x.tournois : 0) + '/' + PORTE.tournois + ' tournaments)' };
    } else {
      const ok = x.appariees / x.rencontres >= PORTE.couverture;
      out[k] = { ok, raison: (ok ? 'ESPN coverage ' + Math.round(x.part * 1000) / 10 + ' % on ' + x.rencontres + ' games'
                                 : 'ESPN coverage ' + Math.round(x.part * 1000) / 10 + ' % < 95 % on ' + x.rencontres + ' games') + comp };
    }
  }
  return out;
}
/** La porte T2 par circuit, sur les 7 derniers jours UTC complets du carnet. */
function porteT2(st, now) {
  const out = {};
  const jours = [];
  for (let i = 1; i <= PORTE_T2.jours; i++) jours.push(jourDe(now - i * JOUR));
  for (const k of ['atp', 'wta']) {
    const fautes = [];
    let pleins = 0;
    for (const j of jours) {
      const x = st && objet(st.jours) && objet(st.jours[j]) ? st.jours[j] : null;
      const c = x && objet(x[k]) ? x[k] : { requetes: 0, refus: 0, bloques: 0 };
      const tics = x && objet(x.tics) ? Number(x.tics.actif) || 0 : 0;
      const req = Number(c.requetes) || 0, ref = Number(c.refus) || 0;
      if ((Number(c.bloques) || 0) > 0 || (x && Number(x.ailleurs) > 0)) fautes.push(j + ' 403/429');
      else if (req > 0 && ref / req > PORTE_T2.refusMax) fautes.push(j + ' ' + Math.round(ref / req * 1000) / 10 + ' % refused');
      if (tics >= PORTE_T2.ticsMin && req > 0) pleins++;
    }
    if (fautes.length) out[k] = { ok: false, raison: 'ESPN availability failed: ' + fautes.join(', ') };
    else if (pleins < jours.length) out[k] = { ok: null, raison: `not enough full active days yet (${pleins}/${jours.length})` };
    else out[k] = { ok: true, raison: `${jours.length} full active days, refusals <= 1 %, no 403/429` };
  }
  return out;
}
/** La porte T3 par circuit : le retard d'ESPN a passer « in », borne par le tableau gratuit. */
function porteT3(m) {
  const out = {};
  for (const k of ['atp', 'wta']) {
    const x = m.parCircuit[k];
    const p = x ? x.passages : null;
    if (!p || p.n < PORTE_T3.passages) { out[k] = { ok: null, raison: `not enough pre->in transitions yet (${p ? p.n : 0}/${PORTE_T3.passages})` }; continue; }
    const a = p.partApresUnJeu <= PORTE_T3.jeuxPartMax;
    const b = p.preApresDebutS.p95 !== null && p.preApresDebutS.p95 <= PORTE_T3.preApresDebutP95S;
    out[k] = { ok: a && b,
               raison: `${p.n} transitions: ${Math.round(p.partApresUnJeu * 1000) / 10} % already a game in (max 5 %), `
                 + `last "pre" ${p.preApresDebutS.p95} s after ESPN start at p95 (max 300 s)` };
  }
  return out;
}

/** L'etat, pour /paris/import -> tennis. Eteint : rien n'est lu ni ecrit sur le disque. */
function etat(now) {
  const t = now || Date.now();
  const mode = prixLigues.verrouTennis();
  const st = ETAT || (mode ? carnet() : null);
  const m = mesure(t, { st, resultat: mode ? resultatsDuReglement() : null });
  const jours = {};
  if (st && objet(st.jours)) for (const j of Object.keys(st.jours).sort().slice(-GARDE_JOURS)) jours[j] = st.jours[j];
  return {
    mode: mode || 'off',
    invalide: prixLigues.verrouTennisInvalide(),
    cadenceS: (mode === 'actif' ? CADENCE_ACTIF_MS : CADENCE_OBSERVE_MS) / 1000,
    horizonH: HORIZON_MS / H,
    apresH: APRES_MS / H,
    appariementMaxS: paris.TENNIS_APPARIEMENT_MAX_MS / 1000,
    derniere: S.derniere ? new Date(S.derniere).toISOString() : null,
    derniereReussie: S.derniereReussie ? new Date(S.derniereReussie).toISOString() : null,
    recul: S.recul.jusqua > t ? { jusqua: new Date(S.recul.jusqua).toISOString(), pasS: S.recul.pas / 1000 } : null,
    espn: Object.assign({}, S.espn, { statuts: Object.assign({}, S.espn.statuts) }),
    passe: S.passe,
    mesure: m,
    jours,
    porte: { seuils: PORTE, seuilsT2: PORTE_T2, seuilsT3: PORTE_T3, T1: porte(m), T2: porteT2(st, t), T3: porteT3(m) },
    carnet: { fichier: path.basename(fichier()), rencontres: ETAT ? Object.keys(ETAT.rencontres).length : null },
  };
}

/** La ligne de demarrage : toujours dite, meme eteint. */
function ligneDemarrage() {
  const mode = prixLigues.verrouTennis(), inv = prixLigues.verrouTennisInvalide();
  const vendus = [...prixLigues.ligues()].filter((k) => /^tennis_/.test(k));
  const base = mode === 'actif'
    ? `ACTIF : tableaux ESPN atp/wta toutes les ${CADENCE_ACTIF_MS / 1000} s sur les rencontres des ${HORIZON_MS / H} h, fermee a l etat in/post et a l heure ESPN valide moins ${paris.AVANCE_REELLE_MS / 1000} s ; `
      + `tennis vendu au marche ouvert seulement apparie « pre » depuis moins de ${paris.TENNIS_APPARIEMENT_MAX_MS / 1000} s`
      + (vendus.length ? ` (vendu : ${vendus.join(', ')})` : ' (aucune cle tennis dans PARIS_PRIX_LIGUES : le tennis reste a l Elo, ferme plus tot)')
    : mode === 'observe'
      ? `OBSERVE : tableaux ESPN atp/wta toutes les ${CADENCE_OBSERVE_MS / 60000} min, couverture comptee (/paris/import -> tennis), rien n est pose ni vendu de plus, 0 credit`
      : 'ETEINT (PARIS_TENNIS_VERROU vide) : aucune requete, le tennis vendu au marche reste SUSPENDU';
  return '[tennis] verrou d heure reelle : ' + base + (inv ? ` — PARIS_TENNIS_VERROU « ${inv} » IGNORE (vide, observe ou actif)` : '');
}

/**
 * Les minuteries. `deps` : { catalogue() -> matchs, pose(par, t), prendre?,
 * minuteries? (false pour les essais) }. AUCUNE minuterie quand le verrou est
 * eteint (le defaut), relu au demarrage. Rend null eteint, sinon { tic, arrete }.
 */
function planifie(deps) {
  const d = deps || {};
  console.log(ligneDemarrage());
  const mode = prixLigues.verrouTennis();
  if (!mode) return null;
  let enVol = false;
  const tic = async () => {
    if (enVol) return false;
    enVol = true;
    try {
      const t = Date.now();
      let matchs = [];
      try { matchs = typeof d.catalogue === 'function' ? d.catalogue() : []; } catch (e) { matchs = []; }
      const par = await passe(matchs, t, { prendre: d.prendre });
      if (par && typeof d.pose === 'function') d.pose(par, t);
      return true;
    } catch (e) {
      console.log('[tennis] verrou : ' + ((e && e.message) || e));
      return false;
    } finally { enVol = false; }
  };
  const minuteries = [];
  if (d.minuteries !== false) {
    const cadence = mode === 'actif' ? CADENCE_ACTIF_MS : CADENCE_OBSERVE_MS;
    const a = setTimeout(tic, 0); if (a.unref) a.unref(); minuteries.push(a);
    const b = setInterval(tic, cadence); if (b.unref) b.unref(); minuteries.push(b);
  }
  return { tic, mode, arrete() { minuteries.forEach(clearTimeout); minuteries.forEach(clearInterval); flush(); } };
}

module.exports = { HORIZON_MS, APRES_MS, CADENCE_ACTIF_MS, CADENCE_OBSERVE_MS, RECUL_MIN_MS, RECUL_MAX_MS, PORTE, PORTE_T2, PORTE_T3, GARDE_JOURS,
                   passe, planifie, etat, mesure, porte, porteT2, porteT3, centile, ligneDemarrage, carnet, flush, oublie, fichier };
