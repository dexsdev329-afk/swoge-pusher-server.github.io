'use strict';
/*
 * LES GARDE-FOUS DU REGLEMENT (lot 4, 10/10/2026) — CE QUE LES ESSAIS DU LOT
 * LAISSAIENT PASSER.
 *
 * La relecture par mutation du lot 4 a retire un par un 132 garde-fous de
 * paris_import.js, reglement_journal.js, server.js et admin.js : 51 passaient
 * reglement_cadence, paris_import, prix_journal et paris_auto (et dix autres
 * suites), dont 45 reels. Chaque section ci-dessous tient l'un d'eux — son
 * numero de mutant est dans le titre — et les sections 22 a 27 tiennent les
 * corrections de la relecture (porte B sur des couts indecidables, fin de
 * fenetre non vue, coupe annoncee en plein match, OMBRE_H borne, credit en
 * vol pendant une deduction, mur courant, recul sur les refus d'ESPN).
 * Ecrire ici un essai qui reste vert quand on retire ce qu'il tient ne sert
 * a rien : chacun a ete vu RATE sur son mutant.
 *
 * Aucun appel reel : le faux `fetch` refuse tout hote inconnu. Un echec
 * s'ecrit RATE ; la derniere ligne donne RATES : n/total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'reglement-gardes-'));
const BACS = [BAC];
const bac = (nom) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), nom)); BACS.push(d); return d; };
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-essai';
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_LIGUES = 'foot=soccer_spain_la_liga,foot=soccer_epl,cricket=cricket_odi,cricket=cricket_ipl,cricket=cricket_the_hundred,tennis=tennis_atp_paris_masters';
process.env.PARIS_PRIX_LIGUES = '';
process.env.PARIS_PRIX_OBSERVE = '';
for (const k of ['PARIS_SCORES_ESPN', 'PARIS_SCORES_COUPE', 'PARIS_SCORES_SAUTE_ENCOURS', 'PARIS_AUTO', 'PARIS_AUTO_PLAFOND', 'PARIS_AUTO_DELAI_MIN',
                 'PARIS_SCORES_ESPN_H', 'PARIS_SCORES_ESPN_FEN_J', 'PARIS_SCORES_OMBRE_H', 'PARIS_SCORES_COUPE_N']) delete process.env[k];

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) { rates++; console.log('  RATE ' + m); } else console.log('  ok   ' + m); };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
const H = 3600000, JOUR = 24 * H;
const T0 = Date.now();
const vraiST = global.setTimeout, vraiSI = global.setInterval;
const dors = (ms) => new Promise((r) => vraiST(r, ms));

// ------------------------------------------------------------ le faux reseau
const ESPN = {}, PANNE = new Set(), DATE_KO = new Map();
const TENNIS = { index: [], tournois: {} };
let utilise = 0;
const ODDS = { hundred422: false, bump: false, reset: false, lent: false };
let lentEnCours = null;
const espnUrls = [];
function evEspn(id, dom, ext, quand, sd, se, etat, statut) {
  return { id, date: new Date(quand).toISOString(),
           competitions: [{ competitors: [
             { homeAway: 'home', team: { displayName: dom }, score: String(sd) },
             { homeAway: 'away', team: { displayName: ext }, score: String(se) }] }],
           status: { type: { state: etat || 'post', completed: (etat || 'post') === 'post', name: statut || (etat === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_FULL_TIME') } } };
}
/* un appel coupe au delai pendant la 422 : compte par prudence en DEPENSE,
   sans appel compte (`delai()` du socle) */
function depenseSansAppel(depense) {
  const f = path.join(process.env.DATA_DIR, 'odds_classes.json');
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { jours: {} };
  const j = new Date().toISOString().slice(0, 10);
  c.jours[j] = c.jours[j] || {};
  const k = Object.keys(c.jours[j])[0] || '1';
  const l = c.jours[j][k] || (c.jours[j][k] = { appels: 0, depense: 0, refus: 0, delais: 0 });
  l.depense += depense; l.delais = (l.delais || 0) + 1;
  fs.writeFileSync(f, JSON.stringify(c));
}
const entetes = () => ({ get: (k) => ({ 'x-requests-remaining': String(20000 - utilise), 'x-requests-used': String(utilise) }[k.toLowerCase()] || null) });
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === 'site.api.espn.com') {
    const ch = (/sports\/(.+?)\/scoreboard/.exec(u.pathname) || [])[1];
    const d = u.searchParams.get('dates');
    espnUrls.push(String(url));
    if (PANNE.has(ch) || DATE_KO.get(ch + '|' + d) === 'panne') return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    if (DATE_KO.get(ch + '|' + d) === 'illisible') return { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token < (essai)'); } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: (ESPN[ch] || []).slice() }) };
  }
  if (u.hostname === 'sports.core.api.espn.com') {
    if (/\/events$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ items: TENNIS.index.map((r) => ({ $ref: r })) }) };
    return { ok: true, status: 200, json: async () => TENNIS.tournois[String(url)] || {} };
  }
  if (u.hostname === 'api.the-odds-api.com') {
    const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
    const ligue = m && m[1], quoi = m && m[2];
    const cout = quoi === 'scores' ? 2 : quoi === 'odds' ? 1 : 0;
    utilise += cout;
    if (ligue === 'lent') {
      /* facture chez le fournisseur TOUT DE SUITE, repondu 300 ms plus tard :
         il est dans x-requests-used de l'appel suivant, pas encore compte */
      await dors(300);
      const h = entetes();
      return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'x-requests-last' ? String(cout) : h.get(k)) }, json: async () => [], text: async () => '[]' };
    }
    if (ODDS.hundred422 && ligue === 'cricket_the_hundred') {
      if (ODDS.reset) utilise = cout;                          // le compteur du fournisseur repart de zero
      if (ODDS.bump) { utilise += 2; depenseSansAppel(2); }   // un autre appel, coupe au delai, compte par prudence
      if (ODDS.lent) { ODDS.lent = false; lentEnCours = imp.appel('/sports/lent/odds', { regions: 'eu' }, 1, 'lent (essai)', undefined, {}).catch(() => null); await dors(20); }
      return { ok: false, status: 422, headers: { get: () => null }, text: async () => '{"message":"Unknown sport","error_code":"UNKNOWN_SPORT"}', json: async () => ({}) };
    }
    const h = entetes();
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'x-requests-last' ? String(cout) : h.get(k)) },
             json: async () => [], text: async () => '[]' };
  }
  throw new Error('hote interdit dans cet essai : ' + u.hostname);
};

// -------------------------------------------------------------- le calendrier
const COTES2 = { 1: 1.8, 2: 1.95 }, COTES3 = { 1: 2.1, N: 3.3, 2: 3.4 };
const M = (id, sport, ligue, dom, ext, debut) => ({ id, sport, competition: 'Essai', pays: '', domicile: dom, exterieur: ext,
  debut: new Date(debut).toISOString(), cotes: sport === 'foot' ? COTES3 : COTES2,
  source: { fournisseur: 'the-odds-api', ligue, evenement: id } });
const CAL = {
  sports: [{ cle: 'foot', nom: 'Football', actif: true }, { cle: 'cricket', nom: 'Cricket', actif: true }, { cle: 'tennis', nom: 'Tennis', actif: true }],
  matchs: [
    M('liga-fini', 'foot', 'soccer_spain_la_liga', 'Barcelona', 'Getafe', T0 - 5 * H),
    M('liga-tot', 'foot', 'soccer_spain_la_liga', 'Sevilla', 'Betis', T0 - 1 * H),
    M('liga-same', 'foot', 'soccer_spain_la_liga', 'Osasuna', 'Alaves', T0 - 6 * H),
    M('liga-retour', 'foot', 'soccer_spain_la_liga', 'Mallorca', 'Celta', T0 - 7 * H),
    M('liga-disp', 'foot', 'soccer_spain_la_liga', 'Elche', 'Levante', T0 - 8 * H),
    M('liga-aet', 'foot', 'soccer_spain_la_liga', 'Oviedo', 'Espanyol', T0 - 9 * H),
    M('liga-tard', 'foot', 'soccer_spain_la_liga', 'Betis', 'Cadiz', T0 - 30 * H),
    M('liga-futur', 'foot', 'soccer_spain_la_liga', 'Girona', 'Villarreal', T0 + 10 * JOUR),
    M('liga-40j', 'foot', 'soccer_spain_la_liga', 'Getafe', 'Leganes', T0 - 40 * JOUR),
    M('epl-panne', 'foot', 'soccer_epl', 'Arsenal', 'Chelsea', T0 - 5 * H),
    M('cri-ipl', 'cricket', 'cricket_ipl', 'Mumbai', 'Chennai', T0 - 6 * H),
    M('cri-hun', 'cricket', 'cricket_the_hundred', 'Oval', 'London', T0 - 6 * H),
    M('cri-odi', 'cricket', 'cricket_odi', 'India', 'Australia', T0 - 6 * H),
    M('cri-jeune', 'cricket', 'cricket_odi', 'England', 'Pakistan', T0 - 1 * H),
    M('cri-odi-fin', 'cricket', 'cricket_odi', 'Sri Lanka', 'Bangladesh', T0 - 11 * H),
    M('tennis-pari', 'tennis', 'tennis_atp_paris_masters', 'Sinner J', 'Alcaraz C', T0 - 5 * H),
  ],
};
const debutDe = (id) => Date.parse(CAL.matchs.find((m) => m.id === id).debut);
const REF = 'http://sports.core.api.espn.com/v2/sports/tennis/leagues/atp/events/paris';
function espnInitial() {
  ESPN['soccer/esp.1'] = [
    evEspn('e1', 'Barcelona', 'Getafe', debutDe('liga-fini'), 2, 1),
    evEspn('e2', 'Sevilla', 'Betis', debutDe('liga-tot'), 1, 1),
    evEspn('e4', 'Osasuna', 'Alaves', debutDe('liga-same'), 1, 0),
    evEspn('e5', 'Mallorca', 'Celta', debutDe('liga-retour'), 0, 0),
    evEspn('e6', 'Elche', 'Levante', debutDe('liga-disp'), 3, 1),
    evEspn('e7', 'Oviedo', 'Espanyol', debutDe('liga-aet'), 1, 1),
    evEspn('e8', 'Betis', 'Cadiz', debutDe('liga-tard'), 2, 2),
    evEspn('e9', 'Getafe', 'Leganes', debutDe('liga-40j'), 1, 0),
  ];
  ESPN['soccer/eng.1'] = [evEspn('p1', 'Arsenal', 'Chelsea', debutDe('epl-panne'), 2, 0)];
  TENNIS.index = [REF];
  TENNIS.tournois[REF] = { competitions: [
    { date: new Date(debutDe('tennis-pari')).toISOString(), competitors: [{ name: 'Sinner J', winner: true }, { name: 'Alcaraz C', winner: false }] }] };
  PANNE.clear(); DATE_KO.clear();
}
const jourUtc = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const PARIES = new Set(['liga-fini', 'liga-tot', 'tennis-pari', 'cri-odi']);
const aRegler = (id) => PARIES.has(id);
const expo = () => 1000;
async function capte(f) {
  const lu = [], vrai = console.log;
  console.log = (...a) => { lu.push(a.join(' ')); };
  let r;
  try { r = await f(); } finally { console.log = vrai; }
  return { r, lignes: lu };
}

fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify(CAL, null, 1) + '\n');
espnInitial();
const paris = require('./paris');
paris.charge();
const imp = require('./paris_import');
const rj = require('./reglement_journal');
const ombre = async (t, ex) => (await capte(() => imp.ombreReglement(aRegler, ex || expo, t))).r;
/* une passe neuve : journal vide, tableaux d'origine, refus d'ESPN tenus pour vus */
const neuf = (nom) => { rj.charge(bac(nom)); espnInitial(); imp.refusOmbreVus(); };

(async () => {
  console.log('\n-- 1. les bornes des variables entieres (PI04, PI05, PI08 ; OMBRE_H borne a 48) --');
  {
    process.env.PARIS_SCORES_ESPN_FEN_J = '5';
    eq(imp.scoresEspnFenJ(), 3, 'PARIS_SCORES_ESPN_FEN_J=5 (au-dela de 4) : defaut 3, jamais un mois');
    process.env.PARIS_SCORES_ESPN_FEN_J = '30';
    eq(imp.scoresEspnFenJ(), 3, 'PARIS_SCORES_ESPN_FEN_J=30 : defaut 3');
    process.env.PARIS_SCORES_ESPN_H = '0';
    eq(imp.scoresEspnH(), 2, 'PARIS_SCORES_ESPN_H=0 : defaut 2 (jamais setInterval 0)');
    process.env.PARIS_SCORES_OMBRE_H = '500';
    eq(imp.ombreH(), 24, 'PARIS_SCORES_OMBRE_H=500 : defaut 24');
    process.env.PARIS_SCORES_OMBRE_H = '72';
    eq(imp.ombreH(), 24, 'PARIS_SCORES_OMBRE_H=72 : defaut 24 (a 72 h, l ombre demanderait des mois a ESPN)');
    process.env.PARIS_SCORES_OMBRE_H = '48';
    eq(imp.ombreH(), 48, 'PARIS_SCORES_OMBRE_H=48 : accepte');
    /* et 48 h ne fait jamais demander un mois : le pire cas, une rencontre
       entree a 36 h et suivie 48 h + 6 h de grace, et une commencee a l'instant */
    const espn = require('./scores_espn');
    const q = espn.requetes(T0 - (36 + 48 + 6) * H - JOUR, T0 + JOUR);
    ok(q.length <= espn.JOURS_MAX && q.every((x) => /^\d{8}$/.test(x)), 'pire cas a 48 h : ' + q.length + ' journee(s), aucun mois');
    for (const k of ['PARIS_SCORES_ESPN_FEN_J', 'PARIS_SCORES_ESPN_H', 'PARIS_SCORES_OMBRE_H']) delete process.env[k];
  }

  console.log('\n-- 2. la cadence programmee : 20 min, puis toutes les 2 h (PI45, PI46) --');
  {
    const tos = [], ints = [];
    global.setTimeout = (fn, ms) => { const h = { fn, ms, unref() { return h; }, ref() { return h; } }; tos.push(h); return h; };
    global.setInterval = (fn, ms) => { const h = { fn, ms, unref() { return h; } }; ints.push(h); return h; };
    let ctl, nouv = [];
    try {
      ctl = (await capte(() => imp.planifie(() => {}, aRegler, expo))).r;
      const t20 = tos.find((h) => h.ms === 20 * 60000);
      ok(!!t20, 'une minuterie a 20 min apres le demarrage');
      const avant = ints.length;
      if (t20) await capte(async () => { t20.fn(); });
      nouv = ints.slice(avant);
    } finally { global.setTimeout = vraiST; global.setInterval = vraiSI; }
    ok(nouv.length === 1 && nouv[0].ms === 2 * H, 'puis un intervalle de 2 h exactement : ' + JSON.stringify(nouv.map((x) => x.ms)));
    await dors(300);
    if (ctl) ctl.arrete();
  }

  console.log('\n-- 3. chaque passe reelle note son heure (PI48) --');
  {
    neuf('rg-passe-');
    const { r: ctl } = await capte(() => imp.planifie(() => {}, aRegler, expo));
    try { await capte(() => ctl.releve()); } finally { ctl.arrete(); }
    eq((rj.brut().passes || []).length, 1, 'la quotidienne a note son heure : le gain se mesure contre elle');
  }

  console.log('\n-- 4. l ombre trie avec le plafond (PI33) --');
  {
    neuf('rg-plafond-');
    await ombre(T0, () => 6e6);
    const b = rj.brut();
    ok(!b.ombre['liga-fini'] && b.attente['liga-fini'] > 0, 'exposition 6 M > AUTO_PLAFOND : pas reglable dans l ombre non plus');
  }

  console.log('\n-- 5. une rencontre en suivi reste lue au-dela de 36 h (PI23) --');
  {
    neuf('rg-suivi-');
    await ombre(T0);
    ok(rj.brut().ombre['liga-tard'] && rj.brut().ombre['liga-tard'].premierReglable === T0, 'liga-tard (30 h) reglable a T0');
    await ombre(T0 + 10 * H);
    await ombre(T0 + 25 * H);
    const e = rj.brut().ombre['liga-tard'] || {};
    ok(e.clos === T0 + 25 * H && e.lectures >= 2, 'lue a 40 h puis close a 55 h : suivie jusqu au bout — ' + JSON.stringify({ clos: e.clos, lectures: e.lectures }));
  }

  console.log('\n-- 6. une panne PARTIELLE n est pas une disparition (PI28, PI30, PI31) --');
  for (const quoi of ['panne', 'illisible']) {
    neuf('rg-partiel-');
    await ombre(T0);
    ESPN['soccer/esp.1'] = ESPN['soccer/esp.1'].filter((x) => x.id !== 'e6');
    DATE_KO.set('soccer/esp.1|' + jourUtc(debutDe('liga-disp')), quoi);
    await ombre(T0 + 2 * H);
    const e = rj.brut().ombre['liga-disp'] || {};
    eq((e.corrections || []).length, 0, `le jour de liga-disp ${quoi === 'panne' ? 'en 500' : 'au corps illisible'}, les autres en 200 : aucune « disparue »`);
    eq(e.muettes, 1, 'la lecture est muette');
  }

  console.log('\n-- 7. une panne longue est un TROU (RJ18, RJ19, RJ32) --');
  {
    neuf('rg-trou-');
    const t1 = T0;
    await ombre(t1);
    PANNE.add('soccer/eng.1');
    for (const h of [2, 4, 6, 8]) await ombre(t1 + h * H);
    PANNE.delete('soccer/eng.1');
    for (let h = 10; h <= 26; h += 2) await ombre(t1 + h * H);
    const e = rj.brut().ombre['epl-panne'] || {};
    ok(e.lectures >= 2 && e.plusGrandTrou >= 10 * H, 'quatre passes sans lecture, puis la lecture reprend : un trou de 10 h — ' + e.plusGrandTrou / H);
    const o = imp.bilanReglement(t1 + 26 * H).journal.ombre;
    ok(o.suivies >= 2, o.suivies + ' rencontre(s) suivie(s) jusqu au bout');
    eq(o.suiviesSansTrou, o.suivies - 1, 'et epl-panne ne compte pas parmi les suivies SANS TROU');
  }

  console.log('\n-- 8. les portes sur un journal fabrique (PI17-19, PI78-82, PI85, PI86, RJ32 ; porte B indecidable ; mur courant) --');
  {
    const t = T0, pr = t - 3 * JOUR;
    const entree = (o, i, mur) => Object.assign({ sport: 'foot', ligue: 'soccer_epl', debut: pr - 4 * H, avecParis: false, premierReglable: pr, borne: pr - H,
      alors: {}, dernierFini: {}, dernier: { t: pr + 24 * H, etat: 'fini' }, lectures: 12, muettes: 0,
      plusGrandTrou: i < (o.trous || 0) ? 10 * H : 2 * H,
      corrections: i < (o.corr || 0) ? [{ t: pr + H, cause: 'score', avant: {}, apres: {} }] : [], clos: pr + 25 * H }, mur === undefined ? {} : { murMin: mur });
    const fabrique = (o) => {
      const st = { v: 1, debut: t - o.jours * JOUR - H, ombre: {}, attente: {}, passes: o.passes, scores: o.scores || [], regles: {}, annonces: {} };
      if (o.murDepuis) st.murDepuis = o.murDepuis;
      for (let i = 0; i < (o.n || 0); i++) st.ombre['g' + i] = entree(o, i, o.mur);
      for (let i = 0; i < (o.vieux || 0); i++) st.ombre['v' + i] = entree({ corr: o.vieux }, i, o.murVieux);
      const d = bac('rg-porte-');
      fs.writeFileSync(path.join(d, 'reglement_journal.json'), JSON.stringify(st));
      rj.charge(d);
      return imp.bilanReglement(t);
    };
    const bon = [pr + 3 * H], nul = [pr - 30 * 60000, pr + 3 * H];
    let b = fabrique({ jours: 20, n: 320, passes: bon });
    ok(b.porteA.passe === true && !b.porteA.raisons.length, 'temoin : 20 jours, 320 sans trou, 0 correction, gain 3 h : PASSEE');
    b = fabrique({ jours: 5, n: 320, passes: bon });
    ok(b.porteA.passe === null && b.porteA.raisons.join() === 'jours', '5 jours seulement : pas encore jugeable, raison jours — ' + JSON.stringify([b.porteA.passe, b.porteA.raisons]));
    b = fabrique({ jours: 20, n: 320, corr: 1, passes: bon });
    ok(b.porteA.passe === false && b.porteA.raisons.includes('correction'), 'UNE correction sur 320 : FERMEE — ' + JSON.stringify([b.porteA.passe, b.porteA.raisons]));
    b = fabrique({ jours: 20, n: 320, passes: nul });
    ok(b.porteA.passe === false && b.porteA.raisons.join() === 'gain', 'gain BAS 0 (haut 3 h) : FERMEE sur le gain — ' + JSON.stringify([b.porteA.passe, b.porteA.raisons, b.porteA.gainMedianBasH]));
    b = fabrique({ jours: 20, n: 320, trous: 300, passes: bon });
    ok(b.porteA.passe === null && b.porteA.raisons.join() === 'echantillon' && b.porteA.suivies === 20,
       '320 suivies dont 20 sans trou : echantillon — ' + JSON.stringify([b.porteA.passe, b.porteA.raisons, b.porteA.suivies]));

    /* LE MUR COURANT (relecture du lot 4) : une correction vue a l'ANCIEN mur
       (PARIS_AUTO_DELAI_MIN releve depuis) ne ferme plus la porte pour 45
       jours ; les jours partent du changement de mur. Le mur courant est
       200 min (AUTO_DELAI_MIN 90 + 110, defaut). */
    b = fabrique({ jours: 40, n: 320, mur: 200, vieux: 5, murVieux: 140, murDepuis: { min: 200, t: t - 20 * JOUR }, passes: bon });
    ok(b.porteA.passe === true && b.porteA.autreMur === 5 && b.porteA.jours === 20,
       'cinq corrections a l ancien mur (140 min), 320 propres au mur courant depuis 20 jours : PASSEE — ' + JSON.stringify([b.porteA.passe, b.porteA.autreMur, b.porteA.jours]));
    b = fabrique({ jours: 40, n: 320, mur: 200, vieux: 5, murVieux: 200, murDepuis: { min: 200, t: t - 20 * JOUR }, passes: bon });
    ok(b.porteA.passe === false, 'temoin : les memes corrections au mur COURANT ferment la porte');
    b = fabrique({ jours: 40, n: 320, mur: 200, murDepuis: { min: 200, t: t - 5 * JOUR }, passes: bon });
    ok(b.porteA.passe === null && b.porteA.raisons.join() === 'jours' && b.porteA.jours === 5,
       'mur change il y a 5 jours (journal de 40) : les jours repartent du changement — ' + JSON.stringify([b.porteA.jours, b.porteA.raisons]));
    b = fabrique({ jours: 40, n: 320, mur: 140, murDepuis: { min: 140, t: t - 30 * JOUR }, passes: bon });
    ok(b.porteA.passe === null && b.porteA.suivies === 0 && b.porteA.autreMur === 320 && b.porteA.jours === 0,
       'tout lu a un autre mur, et le mur courant jamais lu : rien a juger, 0 jour — ' + JSON.stringify([b.porteA.suivies, b.porteA.autreMur, b.porteA.jours]));

    const sc = (clef, k, x) => Array.from({ length: k }, (_, i) => Object.assign({ t: t - (i + 1) * H, clef, cout: 2, statut: 200, code: null, rendus: 0, finies: 0, appariees: 0, vieux: true, declencheurs: 1, ageMaxMin: 300 }, x));
    b = fabrique({ jours: 5, passes: bon, scores: sc('cricket_big_bash', 12, { vieux: false }) });
    eq(b.porteSaute.passe, null, 'porte du saut : 12 precoces mais 5 jours : pas encore jugeable');
    b = fabrique({ jours: 31, passes: bon, scores: [].concat(sc('soccer_france_ligue_one', 6), sc('cricket_ipl', 6), sc('cricket_ipl', 1, { appariees: 1, t: t - 30 * 60000 }), sc('cricket_odi', 6)) });
    ok(b.porteB.soccer_france_ligue_one && b.porteB.soccer_france_ligue_one.verdict === null && b.porteB.soccer_france_ligue_one.motif === 'cochee',
       'porte B a 31 jours : une cle cochee, six inutiles, n est jamais jugee — ' + JSON.stringify(b.porteB.soccer_france_ligue_one));
    eq(b.porteB.cricket_ipl && b.porteB.cricket_ipl.verdict, 'garder', 'porte B a 31 jours : une appariee = garder');
    eq(b.porteB.cricket_odi && b.porteB.cricket_odi.verdict, 'couper', 'temoin : six inutiles, 0 appariee, 31 jours = couper');

    /* PORTE B SUR DES COUTS INDECIDABLES (relecture du lot 4) : six 422 sans
       en-tete, au cout non deduit, etaient declarees « rien a economiser
       (x-requests-last a 0) ». Seul un cout LU a 0 dit « gratuit ». */
    const i422 = { cout: null, statut: 422, code: 'UNKNOWN_SPORT', indecidable: true };
    b = fabrique({ jours: 31, passes: bon, scores: [].concat(sc('cricket_the_hundred', 6, i422), sc('cricket_asia_cup', 6, { cout: 0 }), sc('cricket_psl', 6, { cout: 0 }), sc('cricket_psl', 1, i422)) });
    const ph = b.porteB.cricket_the_hundred || {};
    ok(ph.verdict === null && ph.motif === 'indecidable', 'six 422 au cout indecidable, 31 jours : motif indecidable, AUCUN verdict — ' + JSON.stringify(ph));
    eq((b.porteB.cricket_asia_cup || {}).verdict, 'rien', 'temoin : six reponses au cout LU a 0 : rien a economiser');
    ok((b.porteB.cricket_psl || {}).verdict === null && (b.porteB.cricket_psl || {}).motif === 'indecidable', 'six gratuites et une indecidable : on attend (indecidable)');
    const lignes = imp.lignesReglement(b).join('\n');
    ok(!/cricket_the_hundred.*RIEN A ECONOMISER/.test(lignes) && /cricket_the_hundred.*cout indecidable/.test(lignes), '--reglement le dit : ' + (lignes.match(/cricket_the_hundred.*$/m) || [''])[0].slice(0, 160));
  }

  console.log('\n-- 9. l ecriture en deux temps (RJ04) et la version (RJ03) --');
  {
    const d = bac('rg-ecrit-');
    rj.charge(d);
    rj.notePasse(T0);
    const avant = fs.readFileSync(rj.fichier(), 'utf8');
    const vraiRen = fs.renameSync;
    fs.renameSync = (a, b) => { if (/reglement_journal\.json$/.test(String(b))) throw Object.assign(new Error('EIO (essai)'), { code: 'EIO' }); return vraiRen(a, b); };
    try { await capte(() => rj.notePasse(T0 + 1000)); } finally { fs.renameSync = vraiRen; }
    eq(fs.readFileSync(rj.fichier(), 'utf8'), avant, 'un renommage rate : le fichier en place n est JAMAIS reecrit a moitie');
    const d2 = bac('rg-version-');
    fs.writeFileSync(path.join(d2, 'reglement_journal.json'), JSON.stringify({ v: 2, ombre: { x: { premierReglable: T0 } }, passes: [], scores: [] }));
    rj.charge(d2);
    const { r: lu } = await capte(() => rj.brut());
    ok(lu && !lu.ombre.x && fs.readdirSync(d2).some((x) => /illisible/.test(x)), 'un journal v2 n est pas lu comme un v1 : mis de cote');
  }

  console.log('\n-- 10. une annonce vaut 24 h, pas plus (RJ22) --');
  {
    rj.charge(bac('rg-annonce-'));
    rj.noteAnnonces(['z'], T0);
    ok(rj.annonceRecente('z', T0 + H), 'annoncee il y a 1 h : recente');
    ok(!rj.annonceRecente('z', T0 + 25 * H), 'annoncee il y a 25 h : plus recente, la passe frequente la redit');
  }

  console.log('\n-- 11. la deduction refuse une depense en parallele sans appel compte (PI57), et un credit en vol --');
  {
    rj.charge(bac('rg-deduit-'));
    const ids = new Set(['cri-ipl', 'cri-hun', 'cri-odi']);
    ODDS.hundred422 = true; ODDS.bump = false;
    await capte(() => imp.importeScores((id) => ids.has(id)));
    let e = rj.brut().scores.filter((x) => x.clef === 'cricket_the_hundred').pop() || {};
    eq(e.coutDeduit, 2, 'temoin : la 422 entre deux appels a en-tete, rien d autre : 2 deduits');
    ODDS.bump = true;
    await capte(() => imp.importeScores((id) => ids.has(id)));
    e = rj.brut().scores.filter((x) => x.clef === 'cricket_the_hundred').pop() || {};
    ok(e.indecidable === true && e.coutDeduit === undefined, 'un appel coupe au delai (2 comptes par prudence, aucun appel compte) pendant la 422 : indecidable — ' + JSON.stringify({ d: e.coutDeduit, i: e.indecidable }));
    ODDS.bump = false;
    /* Relecture du lot 4 : un appel payant concurrent, facture AVANT l'appel
       suivant mais compte APRES lui (encore en vol) : x-requests-used le
       porte, le compte par classe pas encore — son credit irait a la 422. */
    ODDS.lent = true; lentEnCours = null;
    await capte(() => imp.importeScores((id) => ids.has(id)));
    ok(lentEnCours !== null, 'l appel concurrent est bien parti pendant la 422');
    e = rj.brut().scores.filter((x) => x.clef === 'cricket_the_hundred').pop() || {};
    ok(e.indecidable === true && e.coutDeduit === undefined, 'un credit encore en vol a la lecture suivante : indecidable, jamais 3 attribues a la 422 — ' + JSON.stringify({ d: e.coutDeduit, i: e.indecidable }));
    await capte(() => lentEnCours);
    ODDS.hundred422 = false; ODDS.lent = false;
  }

  console.log('\n-- 12. la coupe n envoie a la main que les rencontres dont le FORMAT est surement fini (PI65, relecture du lot 4) --');
  {
    rj.charge(bac('rg-coupe-'));
    for (let i = 0; i < 6; i++) rj.noteAppelScores('cricket_odi', { t: T0 - (i + 1) * H, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
    process.env.PARIS_SCORES_COUPE = '1';
    let finis = [];
    try { finis = (await capte(() => imp.importeScores((id) => id === 'cri-odi' || id === 'cri-jeune' || id === 'cri-odi-fin'))).r; }
    finally { delete process.env.PARIS_SCORES_COUPE; }
    const ids = finis.map((f) => f.id);
    ok(ids.includes('cri-odi-fin') && !ids.includes('cri-odi') && !ids.includes('cri-jeune'),
       'coupee : l ODI de 11 h a la main ; celui de 6 h (un ODI dure ~8 h) et celui de 1 h, nulle part — ' + ids.join(','));
    const f = finis.find((x) => x.id === 'cri-odi-fin') || {};
    ok(/verifier que la rencontre est finie/.test(f.aMain || ''), 'et la raison dit de verifier qu elle est finie : ' + f.aMain);
    eq(imp.attenteCoupeMs('cricket_test_match'), 120 * H, 'un test : cinq jours');
    eq(imp.attenteCoupeMs('cricket_odi'), 10 * H, 'un autre cricket : 10 h');
    eq(imp.attenteCoupeMs('tennis_atp_paris_masters'), 6 * H, 'un tennis : 6 h');
    /* et le tri ne la publie jamais « trop peu » : 11 h depuis le coup d'envoi */
    const r = imp.trieReglements([f], () => 0, Date.now());
    ok(r.mains.length === 1 && !r.mains[0].attente && /verifier que la rencontre est finie/.test(r.mains[0].raison), 'le tri la garde a la main, avec sa raison');
  }

  console.log('\n-- 13. la borne du gain : le mur des 200 min et la derniere lecture non reglable (PI36, RJ09, RJ10) --');
  {
    neuf('rg-mur-');
    rj.notePasse(T0 - 4 * H);           // une passe reelle AVANT le mur de liga-fini, epl-panne et tennis-pari
    await ombre(T0);
    rj.notePasse(T0 + 10 * H);
    const g = rj.resume(T0 + 11 * H, { ombreH: 24, cadenceH: 2 }).ombre.gain.tous;
    eq(g.medianeBasH, 10, 'une passe reelle avant le mur des 200 min ne regle rien : mediane basse 10 h');
    const d = T0 - 30 * H, L = (id, reglable) => ({ id, sport: 'foot', ligue: 'x', debut: d, lu: true, repondu: true, fini: true, score: '1-0', resultat: '1', reglable });
    rj.charge(bac('rg-borne1-'));
    rj.noteOmbre([L('A', false)], d + 190 * 60000, { ombreH: 24, murMin: 200 });
    rj.notePasse(d + 195 * 60000);
    rj.noteOmbre([L('A', true)], d + 260 * 60000, { ombreH: 24, murMin: 200 });
    rj.notePasse(d + 12 * H);
    eq(rj.resume(d + 13 * H, { ombreH: 24, cadenceH: 2 }).ombre.gain.tous.medianeBasH, Math.round((12 * H - 260 * 60000) / H * 100) / 100,
       'lecture non reglable a 190 min, passe a 195 min (avant le mur) : elle ne compte pas');
    rj.charge(bac('rg-borne2-'));
    rj.notePasse(d + 250 * 60000);
    rj.noteOmbre([L('B', false)], d + 300 * 60000, { ombreH: 24, murMin: 200 });
    rj.noteOmbre([L('B', true)], d + 420 * 60000, { ombreH: 24, murMin: 200 });
    rj.notePasse(d + 15 * H);
    eq(rj.resume(d + 16 * H, { ombreH: 24, cadenceH: 2 }).ombre.gain.tous.medianeBasH, Math.round((15 * H - 420 * 60000) / H * 100) / 100,
       'passe a 250 min, lue NON reglable a 300 min : la passe n a pas pu la regler');
  }

  console.log('\n-- 14. le vainqueur d un tennis qui change est une correction (RJ13) --');
  {
    neuf('rg-tennis-');
    await ombre(T0);
    TENNIS.tournois[REF] = { competitions: [
      { date: new Date(debutDe('tennis-pari')).toISOString(), competitors: [{ name: 'Sinner J', winner: false }, { name: 'Alcaraz C', winner: true }] }] };
    await ombre(T0 + 2 * H);
    const c = ((rj.brut().ombre['tennis-pari'] || {}).corrections || []);
    ok(c.length === 1 && c[0].cause === 'score', 'Sinner puis Alcaraz vainqueur : une correction — ' + JSON.stringify(c.map((x) => x.cause)));
  }

  console.log('\n-- 15. le compte : refus, utiles, chemin, garde de 45 jours, fenetre de suivi (RJ24, RJ26, RJ31, RJ07, RJ20) --');
  {
    rj.charge(bac('rg-genre-'));
    rj.noteAppelScores('k1', { t: T0, cout: null, statut: null, code: 'REFUSE' });
    rj.noteAppelScores('k2', { t: T0, cout: 2, statut: 200, appariees: 1, vieux: true });
    const bs = rj.bilanScores(T0 + 1, 30);
    ok(bs.k1.refuses === 1 && bs.k1.appels === 0, 'un refus du garde-fou n est pas un appel : ' + JSON.stringify({ r: bs.k1.refuses, a: bs.k1.appels }));
    ok(bs.k2.utiles === 1 && bs.k2.inutiles === 0, 'un appel qui apparie est utile, pas inutile');
    rj.noteRegle('Z1', T0, '1-0', 'auto', { source: 'espn', ligue: 'k3' });
    eq(rj.resume(T0 + 1, { fenetreJours: 30 }).scores.regleesParClef.k3, undefined, 'un reglement ESPN ne compte pas pour le /scores paye');
    rj.noteAppelScores('k4', { t: T0 - 29.5 * JOUR, cout: 2, statut: 200, vieux: true });
    rj.noteAppelScores('k5', { t: T0, cout: 2, statut: 200, vieux: true });
    eq((rj.bilanScores(T0, 30).k4 || {}).appels, 1, 'un appel de 29,5 jours reste dans la fenetre de 30 jours (garde 45)');
    rj.noteOmbre([{ id: 'vieille', sport: 'foot', ligue: 'x', debut: T0 - 40 * H, lu: true, repondu: true, fini: true, score: '1-0', reglable: true }], T0 - 31 * H, { ombreH: 24 });
    ok(!rj.suivisEnCours(T0, { ombreH: 24 }).includes('vieille'), 'au-dela de 24 h + 6 h de grace, une rencontre non close n est plus relue');
  }

  console.log('\n-- 16. un bilan qui leve ne casse pas /paris/import (PI75) ; une entree bancale ne bloque rien --');
  {
    rj.charge(bac('rg-leve-'));
    const vrai = rj.resume;
    rj.resume = () => { throw new TypeError('forme inattendue (essai)'); };
    let leve = null, e = null;
    try { e = imp.etatImport(); } catch (x) { leve = x; } finally { rj.resume = vrai; }
    ok(!leve && e && e.reglement && /forme inattendue/.test(e.reglement.erreur || ''), 'le resume leve : etatImport rend reglement.erreur, ne leve pas — ' + (leve ? leve.message : JSON.stringify(e && e.reglement).slice(0, 80)));
    const d = bac('rg-forme-');
    fs.writeFileSync(path.join(d, 'reglement_journal.json'), JSON.stringify({ v: 1, debut: T0, ombre: { x: null }, passes: [], scores: [] }));
    rj.charge(d);
    const b = imp.bilanReglement(T0);
    ok(b.journal && b.journal.lisible && !b.erreur, 'une entree nulle dans l ombre : le bilan se calcule');
    rj.notePasse(T0 + 1000);
    ok(!('x' in JSON.parse(fs.readFileSync(rj.fichier(), 'utf8')).ombre), 'et la note suivante l ecrit sans elle (purge), au lieu de lever a chaque ecriture');
  }

  console.log('\n-- 17. la carte echappe l erreur (AD04) --');
  {
    process.env.RPC_URL = process.env.RPC_URL || '';
    const page = require('./admin').page('jeton');
    const debut = page.indexOf('var REGL_B='), fin = page.indexOf('\n}\n', page.indexOf('function reglRend('));
    const ctx = { esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
    vm.createContext(ctx);
    for (const nom of ['function num(', 'function ent(']) { const i = page.indexOf(nom); vm.runInContext(page.slice(i, page.indexOf('\n', i)), ctx); }
    vm.runInContext(page.slice(debut, fin + 2), ctx);
    ok(!/<img src=x>/.test(ctx.reglRend({ erreur: '<img src=x>' })), 'reglement.erreur est echappe');
  }

  console.log('\n-- 18. la coupe a exactement N inutiles, pas avant (PI73) --');
  {
    rj.charge(bac('rg-seuil-'));
    for (let i = 0; i < 4; i++) rj.noteAppelScores('cricket_psl', { t: T0 - (i + 1) * H, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
    process.env.PARIS_SCORES_COUPE = '1';
    try {
      eq(imp.clefCoupee('cricket_psl', T0), null, '4 inutiles sur 5 : pas coupee');
      rj.noteAppelScores('cricket_psl', { t: T0 - 5 * H, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
      ok(imp.clefCoupee('cricket_psl', T0) !== null, '5 inutiles sur 5 (PARIS_SCORES_COUPE_N) : coupee');
    } finally { delete process.env.PARIS_SCORES_COUPE; }
  }

  console.log('\n-- 19. l ombre ne lit jamais une rencontre a venir (PI27) --');
  {
    neuf('rg-futur-');
    espnUrls.length = 0;
    await ombre(T0);
    const mois = espnUrls.filter((u) => /dates=\d{6}&/.test(u));
    ok(espnUrls.length > 0 && !mois.length, 'une rencontre dans 10 jours au calendrier : l ombre ne demande que des journees — ' + espnUrls.length + ' requete(s), ' + mois.length + ' au mois');
    ok(!rj.brut().attente['liga-futur'], 'et la rencontre a venir n est pas lue');
  }

  console.log('\n-- 20. fenetreEspnMs jamais plus large que 30 jours (PI42) --');
  {
    espnInitial();
    const finis = (await capte(() => imp.importeScores((id) => id === 'liga-40j', { payant: false, fenetreEspnMs: 60 * JOUR }))).r;
    ok(!finis.some((f) => f.id === 'liga-40j'), 'fenetreEspnMs = 60 jours : une rencontre de 40 jours n est pas demandee (30 jours au plus)');
  }

  console.log('\n-- 21. un compteur du fournisseur qui repart a zero ne fait pas un cout negatif (PI58) --');
  {
    rj.charge(bac('rg-reset-'));
    const ids = new Set(['cri-ipl', 'cri-hun', 'cri-odi']);
    ODDS.hundred422 = true; ODDS.reset = true;
    try { await capte(() => imp.importeScores((id) => ids.has(id))); } finally { ODDS.hundred422 = false; ODDS.reset = false; }
    const e = rj.brut().scores.filter((x) => x.clef === 'cricket_the_hundred').pop() || {};
    ok(e.indecidable === true && e.coutDeduit === undefined, 'x-requests-used repart de zero pendant la 422 : indecidable, jamais negatif — ' + JSON.stringify({ d: e.coutDeduit, i: e.indecidable }));
  }

  console.log('\n-- 22. la fin de la fenetre non vue : un trou, et un ecart lu a la cloture compte (relecture du lot 4) --');
  {
    rj.charge(bac('rg-fin-'));
    const d = T0 - 10 * H, oh = { ombreH: 24, murMin: 200 }, P = T0;
    const L = (id, score) => ({ id, sport: 'foot', ligue: 'x', debut: d, lu: true, repondu: true, fini: true, score, resultat: score === '2-2' ? 'N' : '1', reglable: true });
    const muet = (id) => ({ id, sport: 'foot', ligue: 'x', debut: d, lu: false, repondu: false, fini: false, reglable: false });
    /* F1 : lue jusqu'a +16 h, tableau muet de +18 a +24 h, 2-2 a la cloture
       F2 : lue jusqu'a +24 h pile (fin vue), 2-2 a la cloture
       F3 : comme F1, mais le meme score a la cloture */
    rj.noteOmbre([L('F1', '2-1'), L('F2', '2-1'), L('F3', '2-1')], P, oh);
    for (let h = 2; h <= 16; h += 2) rj.noteOmbre([L('F1', '2-1'), L('F2', '2-1'), L('F3', '2-1')], P + h * H, oh);
    for (let h = 18; h <= 24; h += 2) rj.noteOmbre([muet('F1'), L('F2', '2-1'), muet('F3')], P + h * H, oh);
    rj.noteOmbre([L('F1', '2-2'), L('F2', '2-2'), L('F3', '2-1')], P + 26 * H, oh);
    const o = rj.brut().ombre;
    ok(o.F1.clos === P + 26 * H && o.F1.plusGrandTrou >= 8 * H, 'F1 : panne des 8 dernieres heures de la fenetre = un trou de 8 h — ' + o.F1.plusGrandTrou / H);
    ok(o.F1.corrections.length === 1 && o.F1.corrections[0].cause === 'score' && o.F1.corrections[0].cloture === true,
       'F1 : 2-1 puis 2-2 lu a la cloture, fin de fenetre non vue : une correction (cloture) — ' + JSON.stringify(o.F1.corrections.map((c) => [c.cause, c.cloture])));
    ok(o.F2.corrections.length === 0 && o.F2.plusGrandTrou === 2 * H, 'F2 : fin de fenetre vue, 2-2 lu apres : pas une correction, pas de trou');
    ok(o.F3.corrections.length === 0 && o.F3.plusGrandTrou >= 8 * H, 'F3 : meme score a la cloture : pas de correction, mais le trou');
    const res = rj.resume(P + 26 * H, { ombreH: 24, cadenceH: 2 });
    ok(res.ombre.suivies === 3 && res.ombre.suiviesSansTrou === 1 && res.ombre.avecCorrection === 1,
       'resume : 3 suivies, 1 sans trou (F2), 1 corrigee (F1) — ' + JSON.stringify([res.ombre.suivies, res.ombre.suiviesSansTrou, res.ombre.avecCorrection]));
  }

  console.log('\n-- 23. le mur courant dans le journal (relecture du lot 4) --');
  {
    rj.charge(bac('rg-murj-'));
    const d = T0 - 10 * H;
    const L = (id) => ({ id, sport: 'foot', ligue: 'x', debut: d, lu: true, repondu: true, fini: true, score: '1-0', resultat: '1', reglable: true });
    rj.noteOmbre([L('A')], T0 - 3 * JOUR, { ombreH: 24, murMin: 200 });
    eq(rj.brut().ombre.A.murMin, 200, 'chaque entree garde le mur de sa lecture');
    eq((rj.brut().murDepuis || {}).min, 200, 'et le journal le mur courant');
    rj.noteOmbre([L('B')], T0, { ombreH: 24, murMin: 260 });
    const md = rj.brut().murDepuis || {};
    ok(md.min === 260 && md.t === T0, 'PARIS_AUTO_DELAI_MIN releve : le mur et son depart changent — ' + JSON.stringify(md));
    const r = rj.resume(T0 + 1, { ombreH: 24, murMin: 260 });
    ok(r.ombre.autreMur === 1 && r.ombre.enCours === 1 && r.ombre.jours === 0, 'au nouveau mur : A hors porte, B en cours, 0 jour — ' + JSON.stringify([r.ombre.autreMur, r.ombre.enCours, r.ombre.jours]));
    const r0 = rj.resume(T0 + 1, { ombreH: 24 });
    eq(r0.ombre.autreMur, 0, 'sans mur dit : tout compte, comme avant');
  }

  console.log('\n-- 24. l ombre cede la place au verrou quand ESPN refuse (relecture du lot 4) --');
  {
    neuf('rg-recul-');
    PANNE.add('soccer/eng.1');
    await ombre(T0);
    espnUrls.length = 0;
    const r = await ombre(T0 + 2 * H);
    ok(!espnUrls.some((u) => /soccer\/eng\.1\//.test(u)) && espnUrls.some((u) => /soccer\/esp\.1\//.test(u)),
       'eng.1 a refuse depuis la passe d avant : pas relu (esp.1, lui, l est) — ' + espnUrls.length + ' requete(s)');
    ok(r && r.sautes && r.sautes.join() === 'soccer/eng.1', 'et le rendu le dit : ' + JSON.stringify(r && r.sautes));
    PANNE.delete('soccer/eng.1');
    espnUrls.length = 0;
    await ombre(T0 + 4 * H);
    ok(espnUrls.some((u) => /soccer\/eng\.1\//.test(u)), 'aucun refus nouveau depuis : eng.1 est relu a la passe suivante');
    ok(rj.brut().ombre['epl-panne'] && rj.brut().ombre['epl-panne'].premierReglable === T0 + 4 * H, 'et sa rencontre entre dans l ombre a cette lecture');
  }

  for (const d of BACS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* rien */ } }
  console.log(`\nRATES : ${rates}/${n}`);
  if (!rates) console.log(`reglement_gardes.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
