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
const { LIGUES_DEFAUT, ligues, observees, vendue, observee, refusee, venteImpossible } = require('./prix_ligues');
/* Le nombre d'issues vient du SPORT (paris.SPORTS), jamais de la reponse du
   fournisseur (lot 3, 10/10/2026). Aucun cycle : paris.js ne requiert que
   prix_ligues.js. */
const paris = require('./paris');

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
/** Ce qui se releve : ce qui se vend, plus ce qu'on observe.
 * Lot 3 (10/10/2026) : les cles ecrites en clair, plus celles de `connues`
 * (les cles qui ont une rencontre a venir au calendrier,
 * paris_import.liguesAvecRencontre) que couvre un joker du tennis — un joker
 * n'est jamais une cle qu'on paie, et sans calendrier il ne developpe rien.
 * Jamais une cle refusee (cricket) : elle ne coute aucun credit. Sans joker
 * ni cricket, l'ensemble est exactement celui d'avant. */
function aRelever(connues) {
  const out = new Set();
  for (const k of [...ligues(), ...observees()]) if (k.indexOf('*') < 0 && !refusee(k) && !venteImpossible(k)) out.add(k);
  for (const k of connues || []) if (!refusee(k) && !venteImpossible(k) && (vendue(k) || observee(k))) out.add(String(k));
  return out;
}
/* ---- LES ISSUES D'UNE CLE (lot 3, 10/10/2026) ----
 * Celles de son SPORT. Sans sport dit, une cle `soccer_*` garde les trois
 * issues du football — c'est la forme de tous les appels d'avant ce lot, et
 * le chemin vendu n'en change pas d'un octet (essais/reference) ; toute autre
 * cle sans sport ne se note PAS : on ne devine pas un nombre d'issues (un
 * hockey lu en 1-N-2 vendrait le temps reglementaire). Une cle refusee
 * (cricket) non plus, ni une cle VENDUE sans verrou d'heure reelle (le
 * tennis, prix_ligues.venteImpossible : ses rencontres restent suspendues).
 * Rend null quand rien ne doit etre note ni paye. */
function issuesDe(sport, ligue) {
  const L = String(ligue || '');
  if (refusee(L) || venteImpossible(L)) return null;
  if (sport !== undefined && sport !== null && sport !== '') return paris.sportConnu(sport) ? paris.issues(sport) : null;
  return /^soccer_/.test(L) ? ISSUES : null;
}
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
/* ---- LA CADENCE D'UNE CLE OBSERVEE (lot 3, 10/10/2026) ----
 * `PARIS_PRIX_OBSERVE_H` : 12 h par defaut, borne de 1 a 168 h, et jamais
 * plus serre que la releve des cles VENDUES (`releveMs`) — la releve
 * periodique passe `releveMs` comme age minimal a toutes les cles (planifie) :
 * en dessous, la variable serait sans effet, sans un mot (relecture du 09/10).
 * Pourquoi 12 h : pour JUGER l'Elo d'un sport, l'age du prix du marche compte
 * peu — vieux de 1 a 4 jours, il laissait encore 16 % de rencontres de Liga
 * battables contre 67 % a l'Elo (08/10, 829 rencontres) ; l'echantillon, lui,
 * vient des rencontres, pas des releves. 12 h = 2 credits par cle et par jour
 * au plus, contre 12 a la cadence de vente (2 h) : 240 a 360 credits par mois
 * pour NHL + NFL + NBA + tennis (plan du 09/10, budget). Une cle observee
 * n'est jamais prioritaire (classe 3, paris_import.rafraichitPrix). */
function observeMs() {
  const h = Number(process.env.PARIS_PRIX_OBSERVE_H);
  const ms = (isFinite(h) && h >= 1 ? Math.min(h, 168) : 12) * 3600000;
  return Math.max(ms, releveMs());
}
/** L'ecart entre deux releves de cette cle : vendue, `releveMs` ; observee, `observeMs`. */
function cadenceDe(cle) { return vendue(cle) ? releveMs() : observeMs(); }
const ECART_MAX = 0.05;
const BOURSE = 'betfair_ex_eu', PINNACLE = 'pinnacle';

/* Les prix d'un livre, rangés sur NOS issues : 1 = domicile. `iss` : les
   issues du sport (defaut : les trois du football, la forme d'avant le lot 3).
   ---- UN NUL SUR UN SPORT A DEUX ISSUES : LE LIVRE EST ECARTE (lot 3) ----
   Notre reglement du hockey compte la prolongation ET les tirs au but (ESPN,
   52 matchs NHL finis du 10 au 15/01/2026 : 12 au-dela du temps
   reglementaire, 0 score egal — le tir au but vainqueur compte un but). Un
   livre qui cote un nul vend le temps reglementaire : un AUTRE pari, que
   prendre pour le notre ferait payer le mauvais camp. La doc ne tranche pas
   (h2h : « Bet on the winning team or player of a game (includes the draw for
   soccer) », sans un mot sur la prolongation, et h2h_3_way existe a part —
   https://the-odds-api.com/sports-odds-data/betting-markets.html, lu le
   09/10) : sur un sport a deux issues, un h2h qui n'a pas EXACTEMENT deux
   prix, ou qui porte « Draw », est ecarte et compte (`stats.nul`). Le
   football est inchange : le nul y reste exige. */
function lotDuLivre(b, ev, iss, stats) {
  const I = iss || ISSUES;
  const m = (b.markets || []).find((x) => x.key === 'h2h');
  if (I.length === 2) {
    if (!m || !Array.isArray(m.outcomes)) return null;
    if (m.outcomes.length !== 2 || m.outcomes.some((y) => y && y.name === 'Draw')) {
      if (stats) stats.nul = (stats.nul || 0) + 1;
      return null;
    }
  }
  const o = (nom) => {
    const x = m && Array.isArray(m.outcomes) && m.outcomes.find((y) => y.name === nom);
    return x && Number(x.price) > 1 ? Number(x.price) : null;
  };
  const c = I.length === 2 ? { 1: o(ev.home_team), 2: o(ev.away_team) } : { 1: o(ev.home_team), N: o('Draw'), 2: o(ev.away_team) };
  return I.every((i) => c[i]) ? c : null;
}
const somme = (c, iss) => (iss || ISSUES).reduce((t, i) => t + 1 / c[i], 0);
function sansMarge(c, iss) {
  const I = iss || ISSUES;
  const p = cotes.probasImplicites(c, I, 1);
  return p && I.every((i) => p[i] > 0 && p[i] < 1) ? p : null;
}

/**
 * La reference d'une rencontre de la reponse `/odds`, ou null.
 * Rend { ref, p: {1,N,2}, livres, ecart } — `p` sans marge, somme 1.
 * `iss` (lot 3) : les issues du sport, {1,2} a deux issues ; `stats` recoit
 * `nul`, le nombre de livres ecartes pour un nul. Les bornes (bourse 1,00 a
 * 1,06 ; Pinnacle 1,00 a 1,08 ; ECART_MAX 5 points) ne bougent pas.
 */
function referenceDe(ev, iss, stats) {
  const I = iss || ISSUES;
  const lots = [];
  let bourse = null, pin = null;
  for (const b of (ev && ev.bookmakers) || []) {
    const c = lotDuLivre(b, ev, I, stats);
    if (!c) continue;
    const s = somme(c, I);
    if (b.key === BOURSE) { if (s >= 1.0 && s <= 1.06) bourse = sansMarge(c, I); continue; }
    if (b.key === PINNACLE && s >= 1.0 && s <= 1.08) pin = sansMarge(c, I);
    const p = s >= 1.0 ? sansMarge(c, I) : null;
    if (p) lots.push(p);
  }
  let med = null;
  if (lots.length >= 3) {
    med = {};
    for (const i of I) {
      const v = lots.map((p) => p[i]).sort((a, b) => a - b), k = Math.floor(v.length / 2);
      med[i] = v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
    }
    const t = I.reduce((a, i) => a + med[i], 0);
    for (const i of I) med[i] /= t;
  }
  const ecartDe = (p) => (med ? Math.max(...I.map((i) => Math.abs(p[i] - med[i]))) : 0);
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
  try { return lisOuLeve(); } catch (e) { return { evenements: {}, ligues: {}, couverture: {} }; }
}
function lisOuLeve() {
  const j = JSON.parse(fs.readFileSync(fichier(), 'utf8'));
  return { evenements: j.evenements || {}, ligues: j.ligues || {}, couverture: j.couverture || {} };
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
 * autre processus), relue tant que le fichier a moins de deux secondes, et
 * renouvelee par nos propres ecritures. `note` et `lis` relisent
 * toujours le fichier : seule la vente passe par ici, et elle ne modifie rien
 * (`pour` rend une copie). */
let VU = null;
/* ---- DEUX REGLES DE LA RELECTURE DU 09/10 ----
 * 1. Une lecture RATEE ne se garde pas. `lis` rend un carnet vide sur toute
 *    erreur (EMFILE, EIO, fichier coupe) ; gardee sous la signature d'un
 *    fichier intact, elle resservait ce vide a chaque rencontre : les dix-sept
 *    championnats, six grands compris, suspendus au prochain import, et
 *    `derniere` a 0 partout. Avant la lecture gardee, la meme erreur ne
 *    touchait qu'une rencontre.
 * 2. Un fichier ecrit il y a moins de deux secondes se relit a chaque fois (la
 *    regle de git pour les horodatages trop recents) : sur un volume dont
 *    l'heure des fichiers est a la seconde, deux ecritures de meme taille par
 *    un autre processus dans la meme seconde ont la meme signature. Simule a
 *    la relecture : l'essai des dates du carnet (section 5) rougissait a
 *    chaque fois a la seconde, trois fois sur cinq a 10 ms. Le cout : une
 *    relecture par rencontre dans les deux secondes qui suivent une ecriture. */
const RECENT_MS = 2000;
function luPourVendre() {
  let sig = 'absent', mtime = 0;
  try { const st = fs.statSync(fichier()); mtime = st.mtimeMs; sig = mtime + ':' + st.size; } catch (e) { /* pas encore de carnet */ }
  if (VU && VU.sig === sig && VU.lu - mtime > RECENT_MS) return VU.c;
  const lu = Date.now();
  let c;
  try { c = lisOuLeve(); } catch (e) {
    VU = null;
    /* absent : rien a vendre, c'est un etat stable ; illisible : on ne garde rien */
    return { evenements: {}, ligues: {}, couverture: {} };
  }
  VU = { sig, c, lu };
  return c;
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

/* ---- LE CROCHET apresNote (socle, 10/10/2026) ----
 * Plusieurs lots veulent voir chaque reponse `/odds` deja payee : le journal
 * des releves (lot 1), l'index de cloture qu'il tient pour la CLV (lot 2) et
 * la derive des coupes (lot 6). Les loger DANS `note` mettait leur code — et
 * leurs exceptions — dans le chemin d'ecriture du prix vendu. Ils s'abonnent
 * donc ici, et sont appeles APRES l'ecriture du carnet, chacun dans son
 * try/catch : un abonne qui leve, ou rend une promesse rejetee, ne change ni
 * le carnet, ni la date, ni le compte rendu. Chacun recoit SA copie, la
 * reponse brute `evs` comprise : un abonne qui la touche ne fausse ni le
 * compte rendu, ni ce que voit le suivant, ni l'etalonnage, qui relit `evs`
 * juste apres `note` pour recaler les forces Elo (`paris_import.calibre`).
 * Avant, `evs` etait passe tel quel : un journal qui l'aurait trie aurait
 * change l'etalonnage sans que rien ne le dise (relecture du socle). Une copie
 * par abonne et par releve payee : trois abonnes au plus sont prevus (lots 1,
 * 2 et 6).
 * Sans abonne (le cas de ce lot), `note` fait exactement ce qu'elle faisait :
 * essais/reference/ le prouve octet pour octet. */
const ABONNES = [];
function apresNote(fn) {
  if (typeof fn !== 'function') throw new TypeError('apresNote : une fonction est attendue');
  ABONNES.push(fn);
  return function desabonne() { const i = ABONNES.indexOf(fn); if (i >= 0) ABONNES.splice(i, 1); };
}
function previens(fait) {
  for (const fn of ABONNES.slice()) {
    try {
      const r = fn(Object.assign({}, fait, { compte: Object.assign({}, fait.compte), evs: structuredClone(fait.evs),
        refs: fait.refs.map((x) => Object.assign({}, x, { p: x.p && Object.assign({}, x.p) })) }));
      if (r && typeof r.then === 'function') r.then(null, (e) => console.log('[odds] apresNote (' + (fn.name || 'abonne') + ') : ' + ((e && e.message) || e)));
    } catch (e) { console.log('[odds] apresNote (' + (fn.name || 'abonne') + ') : ' + ((e && e.message) || e)); }
  }
}

/**
 * Noter la reponse `/odds` d'un championnat. Rend le compte par reference.
 * Garde dix jours d'historique : assez pour l'audit, pas un fichier qui
 * grossit sans fin.
 * `opts` (socle, 10/10/2026) : { quoi, sport }. `quoi` est la cause de la
 * releve (« periodique », « avant le coup d envoi », « etalonnage »…) pour le
 * journal ; `sport` est le sport de la cle, pour le lot des deux issues. Ni
 * l'un ni l'autre ne change le carnet dans ce lot : ils sont transmis aux
 * abonnes. Une chaine seule vaut `{ quoi }`.
 */
function note(evs, ligue, now, opts) {
  const t = now || Date.now();
  const L = String(ligue || '');
  const o = typeof opts === 'string' ? { quoi: opts } : (opts && typeof opts === 'object' ? opts : {});
  /* ---- LE NOMBRE D'ISSUES VIENT DU SPORT (lot 3, 10/10/2026) ----
   * `opts.sport` le donne ; sans lui, une cle soccer_* garde les trois issues
   * (tous les appels d'avant ce lot, octet pour octet) et toute autre cle ne
   * note RIEN : ni prix, ni date, ni couverture, ni abonnes — le carnet reste
   * tel quel. Ce n'est pas un retrait : on ne sait pas lire cette reponse.
   * Le compte le dit (`sportInconnu`, `aucun` = toute la reponse). */
  const iss = issuesDe(o.sport, L);
  if (!iss) {
    const n = (evs || []).filter((ev) => ev && ev.id).length;
    if (venteImpossible(L)) {
      console.log(`[odds] prix du marche ${L} : vendue sans verrou d heure reelle (tennis) — rien n est note (${n} rencontre(s)), ses rencontres restent suspendues`);
      return { betfair: 0, pinnacle: 0, mediane: 0, aucun: n, retires: 0, venteImpossible: true };
    }
    console.log(`[odds] prix du marche ${L} : sport ${o.sport === undefined || o.sport === null ? 'non dit' : JSON.stringify(String(o.sport))}`
      + (refusee(L) ? ' (cle refusee)' : '') + ` — rien n est note (${n} rencontre(s)) : on ne devine pas un nombre d issues`);
    return { betfair: 0, pinnacle: 0, mediane: 0, aucun: n, retires: 0, sportInconnu: true };
  }
  const c = lis();
  const compte = { betfair: 0, pinnacle: 0, mediane: 0, aucun: 0, retires: 0 };
  /* Deux issues : le compte dit combien de livres cotaient un nul (ecartes) et
     sur combien d'issues porte le prix. Le football garde exactement son
     compte d'avant (essais/reference, octet pour octet). */
  if (iss.length !== ISSUES.length) Object.assign(compte, { nul: 0, issues: iss.length });
  const vus = new Set();
  /* Ce que les abonnes recoivent par rencontre : rien de plus que le carnet. */
  const refs = [];
  for (const ev of evs || []) {
    if (!ev || !ev.id) continue;
    const k = String(ev.id);
    vus.add(k);
    const r = referenceDe(ev, iss, compte.nul === undefined ? null : compte);
    /* ---- UN MARCHE RETIRE N'A PLUS DE PRIX ----
     * Les livres retirent un 1-N-2 quand une nouvelle tombe (blessure, doute
     * sur la tenue du match) ; il disparait de la reponse. Garder l'ancien
     * prix, c'etait le vendre precisement quand il est faux (relecture du
     * 08/10). Sans reference, on EFFACE : la rencontre sera suspendue. */
    if (!r) {
      compte.aucun++; if (c.evenements[k]) { delete c.evenements[k]; compte.retires++; }
      refs.push({ id: k, debut: Date.parse(ev.commence_time) || 0, ref: null, p: null, livres: 0 });
      continue;
    }
    compte[r.ref]++;
    const p = {};
    for (const i of iss) p[i] = Math.round(r.p[i] * 1e5) / 1e5;
    /* Les equipes, pour verifier l'orientation a l'import : un prix colle a
       l'envers donnerait au favori la cote de l'outsider. */
    c.evenements[k] = { t, ref: r.ref, p, livres: r.livres, ecart: r.ecart, ligue: L,
                        dom: String(ev.home_team || ''), ext: String(ev.away_team || ''),
                        debut: Date.parse(ev.commence_time) || 0 };
    refs.push({ id: k, debut: c.evenements[k].debut, ref: r.ref, p: Object.assign({}, p), livres: r.livres });
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
  const ecrit = ecris(c);
  if (ecrit) delete MEMOIRE[L]; else MEMOIRE[L] = t;
  /* Le carnet d'abord, les abonnes ensuite (voir `apresNote`). */
  if (ABONNES.length) previens({ ligue: L, t, quoi: o.quoi === undefined ? null : String(o.quoi), sport: o.sport === undefined ? null : o.sport,
                                 ecrit, evs: evs || [], refs, compte });
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

module.exports = { LIGUES_DEFAUT, ligues, observees, aRelever, releveMs, AGE_MAX_MS, ECART_MAX, referenceDe, note, pour, derniere, fichier, lis,
                   /* le socle (10/10/2026) : le crochet, et la lecture d'un livre pour qui doit lire la bourse avec le MEME code */
                   apresNote, lotDuLivre, sansMarge, BOURSE,
                   /* les deux issues (lot 3, 10/10/2026) : la liste vendue / observee avec le joker du tennis, la cadence
                      d'une cle observee, et les issues d'une cle (la meme regle pour le carnet, la releve et le journal) */
                   vendue, observee, refusee, venteImpossible, observeMs, cadenceDe, issuesDe, ISSUES };
