'use strict';
/*
 * LE REGLEMENT : L'OMBRE ESPN DE 2 H ET LA PASSE FREQUENTE (lot 4, 10/10/2026).
 *
 * Ce que cet essai tient, et pourquoi :
 *
 *   a. Mode « observe » (defaut) : la passe de 2 h ne paie RIEN, ne remet
 *      RIEN a `signale` (donc ne regle et ne publie rien) et ecrit l'ombre.
 *   b. Mode « regle » : elle remet ce qu'ESPN tranche, et ne paie toujours
 *      rien — meme avec un cricket parie qu'ESPN ne couvre pas.
 *   c. La fenetre : la passe frequente ne demande jamais un MOIS a ESPN
 *      (7 Mo en MLB toutes les 2 h) ; la quotidienne garde ses 30 jours.
 *   d. Une seule releve de scores a la fois : lancees dans la meme
 *      milliseconde, chaque rencontre n'est remise qu'UNE fois.
 *   e. L'ombre compte les corrections : score, statut (AET), retour a un etat
 *      non fini, disparition d'un tableau qui a REPONDU — pas d'un tableau en
 *      panne ; rien apres la fenetre de 24 h.
 *   f. Le journal survit a un redemarrage, s'ecrit en deux temps, met de cote
 *      un fichier illisible.
 *   g. Le gain contrefactuel (porte A) : borne basse et haute, calculees.
 *   h. Un journal en panne ne change RIEN au reglement.
 *   i. La ligne de demarrage dit la cadence et le mode reels.
 *   j. `--reglement` : 0 credit, aucun appel reseau.
 *   k. La carte « Settlement » : le nombre d'abord, rien sous 300.
 *
 * Aucun appel reel : le faux `fetch` refuse tout hote inconnu. Un echec
 * s'ecrit RATE ; la derniere ligne donne RATES : n/total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'reglement-cadence-'));
/* chaque dossier temporaire de l'essai, retire a la fin */
const BACS = [BAC];
const bac = (nom) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), nom)); BACS.push(d); return d; };
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-essai';
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_LIGUES = 'foot=soccer_spain_la_liga,foot=soccer_epl,cricket=cricket_odi,tennis=tennis_atp_paris_masters';
process.env.PARIS_PRIX_LIGUES = '';
process.env.PARIS_PRIX_OBSERVE = '';
delete process.env.PARIS_SCORES_ESPN;
delete process.env.PARIS_SCORES_COUPE;
delete process.env.PARIS_SCORES_SAUTE_ENCOURS;
delete process.env.PARIS_AUTO;
delete process.env.PARIS_AUTO_PLAFOND;

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) { rates++; console.log('  RATE ' + m); } else console.log('  ok   ' + m); };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3600000;
const T0 = Date.now();

// ------------------------------------------------------------ le faux reseau
const ESPN = {};          // chemin -> [evenements]
const PANNE = new Set();  // chemins qui rendent 500
const TENNIS = { index: [], tournois: {} };
const espnUrls = [], coreUrls = [], odds = [];
let RETARD_ESPN = 0, RETARD_ODDS = 0;
const SCORES = { cricket_odi: [] };
function evEspn(id, dom, ext, quand, sd, se, etat, statut) {
  return { id, date: new Date(quand).toISOString(),
           competitions: [{ competitors: [
             { homeAway: 'home', team: { displayName: dom }, score: String(sd) },
             { homeAway: 'away', team: { displayName: ext }, score: String(se) }] }],
           status: { type: { state: etat || 'post', completed: (etat || 'post') === 'post', name: statut || (etat === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_FULL_TIME') } } };
}
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === 'site.api.espn.com') {
    espnUrls.push(String(url));
    if (RETARD_ESPN) await dors(RETARD_ESPN);
    const ch = (/sports\/(.+?)\/scoreboard/.exec(u.pathname) || [])[1];
    if (PANNE.has(ch)) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: (ESPN[ch] || []).slice() }) };
  }
  if (u.hostname === 'sports.core.api.espn.com') {
    coreUrls.push(String(url));
    if (/\/events$/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ items: TENNIS.index.map((r) => ({ $ref: r })) }) };
    return { ok: true, status: 200, json: async () => TENNIS.tournois[String(url)] || {} };
  }
  if (u.hostname === 'api.the-odds-api.com') {
    if (RETARD_ODDS) await dors(RETARD_ODDS);
    const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
    const ligue = m && m[1], quoi = m && m[2];
    const cout = quoi === 'scores' ? (u.searchParams.get('daysFrom') ? 2 : 1) : quoi === 'odds' ? 1 : 0;
    odds.push({ ligue, quoi, cout });
    const total = odds.reduce((t, a) => t + a.cout, 0);
    const corps = quoi === 'scores' ? (SCORES[ligue] || []) : [];
    return { ok: true, status: 200,
             headers: { get: (k) => ({ 'x-requests-remaining': String(20000 - total), 'x-requests-used': String(total), 'x-requests-last': String(cout) }[k.toLowerCase()] || null) },
             json: async () => corps, text: async () => JSON.stringify(corps) };
  }
  throw new Error('hote interdit dans cet essai : ' + u.hostname);
};
const creditsOdds = () => odds.reduce((t, a) => t + a.cout, 0);

// -------------------------------------------------------------- le calendrier
const COTES2 = { 1: 1.8, 2: 1.95 };
const COTES3 = { 1: 2.1, N: 3.3, 2: 3.4 };
const M = (id, sport, ligue, dom, ext, debut, ev) => ({ id, sport, competition: 'Essai', pays: '', domicile: dom, exterieur: ext,
  debut: new Date(debut).toISOString(), cotes: sport === 'foot' ? COTES3 : COTES2,
  source: { fournisseur: 'the-odds-api', ligue, evenement: ev || id } });
const CAL = {
  sports: [{ cle: 'foot', nom: 'Football', actif: true }, { cle: 'cricket', nom: 'Cricket', actif: true }, { cle: 'tennis', nom: 'Tennis', actif: true }],
  matchs: [
    M('liga-fini', 'foot', 'soccer_spain_la_liga', 'Barcelona', 'Getafe', T0 - 5 * H),
    M('liga-tot', 'foot', 'soccer_spain_la_liga', 'Sevilla', 'Betis', T0 - 1 * H),
    M('liga-vieux', 'foot', 'soccer_spain_la_liga', 'Valencia', 'Girona', T0 - 20 * 24 * H),
    M('liga-same', 'foot', 'soccer_spain_la_liga', 'Osasuna', 'Alaves', T0 - 6 * H),
    M('liga-retour', 'foot', 'soccer_spain_la_liga', 'Mallorca', 'Celta', T0 - 7 * H),
    M('liga-disp', 'foot', 'soccer_spain_la_liga', 'Elche', 'Levante', T0 - 8 * H),
    M('liga-aet', 'foot', 'soccer_spain_la_liga', 'Oviedo', 'Espanyol', T0 - 9 * H),
    /* une rencontre A VENIR, comme toujours en production (relecture du lot
       4) : l'ombre ne la lit pas — elle ferait demander un MOIS a ESPN */
    M('liga-futur', 'foot', 'soccer_spain_la_liga', 'Girona', 'Villarreal', T0 + 10 * 24 * H),
    M('epl-panne', 'foot', 'soccer_epl', 'Arsenal', 'Chelsea', T0 - 5 * H),
    M('cri-odi', 'cricket', 'cricket_odi', 'India', 'Australia', T0 - 6 * H),
    M('tennis-pari', 'tennis', 'tennis_atp_paris_masters', 'Sinner J', 'Alcaraz C', T0 - 5 * H),
    M('tennis-sans', 'tennis', 'tennis_atp_paris_masters', 'Zverev A', 'Fritz T', T0 - 5 * H),
  ],
};
const debutDe = (id) => Date.parse(CAL.matchs.find((m) => m.id === id).debut);
function espnInitial() {
  ESPN['soccer/esp.1'] = [
    evEspn('e1', 'Barcelona', 'Getafe', debutDe('liga-fini'), 2, 1),
    evEspn('e2', 'Sevilla', 'Betis', debutDe('liga-tot'), 1, 1, 'post'),
    evEspn('e3', 'Valencia', 'Girona', debutDe('liga-vieux'), 0, 1),
    evEspn('e4', 'Osasuna', 'Alaves', debutDe('liga-same'), 1, 0),
    evEspn('e5', 'Mallorca', 'Celta', debutDe('liga-retour'), 0, 0),
    evEspn('e6', 'Elche', 'Levante', debutDe('liga-disp'), 3, 1),
    evEspn('e7', 'Oviedo', 'Espanyol', debutDe('liga-aet'), 1, 1),
  ];
  ESPN['soccer/eng.1'] = [evEspn('p1', 'Arsenal', 'Chelsea', debutDe('epl-panne'), 2, 0)];
  const REF = 'http://sports.core.api.espn.com/v2/sports/tennis/leagues/atp/events/paris';
  TENNIS.index = [REF];
  TENNIS.tournois[REF] = { competitions: [
    { date: new Date(debutDe('tennis-pari')).toISOString(), competitors: [{ name: 'Sinner J', winner: true }, { name: 'Alcaraz C', winner: false }] },
    { date: new Date(debutDe('tennis-sans')).toISOString(), competitors: [{ name: 'Zverev A', winner: true }, { name: 'Fritz T', winner: false }] }] };
}
const evDe = (ch, id) => ESPN[ch].find((e) => e.id === id);
function poseScore(ch, id, sd, se, etat, statut) {
  const i = ESPN[ch].findIndex((e) => e.id === id);
  const v = ESPN[ch][i];
  ESPN[ch][i] = evEspn(id, v.competitions[0].competitors[0].team.displayName, v.competitions[0].competitors[1].team.displayName,
                       Date.parse(v.date), sd, se, etat, statut);
}

const PARIES = new Set(['liga-fini', 'liga-tot', 'liga-vieux', 'cri-odi', 'tennis-pari']);
const REGLES = new Set();
const aRegler = (id) => PARIES.has(id) && !REGLES.has(id);
const expo = () => 1000;

function ecritCalendrier() {
  fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify(CAL, null, 1) + '\n');
}
async function capte(f) {
  const lu = [], vrai = console.log;
  console.log = (...a) => { lu.push(a.join(' ')); };
  let r;
  try { r = await f(); } finally { console.log = vrai; }
  return { r, lignes: lu };
}

ecritCalendrier();
espnInitial();
const paris = require('./paris');
paris.charge();
let imp = require('./paris_import');
let rj = require('./reglement_journal');

(async () => {
  // ===================================================================== a
  console.log('\n-- a. mode observe : l ombre seule, 0 credit, rien de remis --');
  {
    const signales = [];
    const { r: ctl, lignes } = await capte(() => imp.planifie((f, o) => signales.push({ f, o }), aRegler, expo));
    try {
      odds.length = 0; espnUrls.length = 0; coreUrls.length = 0;
      const { lignes: dits } = await capte(() => ctl.frequente());
      eq(odds.length, 0, 'aucun appel vers api.the-odds-api.com');
      eq(signales.length, 0, 'signale n est JAMAIS appele : rien n est regle ni publie');
      const b = rj.brut();
      ok(b && b.ombre['liga-fini'] && b.ombre['liga-fini'].premierReglable > 0, 'l ombre note la premiere lecture reglable de la rencontre finie depuis 5 h');
      ok(b.ombre['liga-same'] && !b.ombre['liga-same'].avecParis, 'y compris une rencontre SANS pari (toutes les rencontres des tableaux ESPN)');
      ok(!b.ombre['liga-tot'] && b.attente['liga-tot'] > 0, 'finie depuis 1 h : pas reglable, son instant non reglable est garde');
      ok(!b.ombre['liga-vieux'], 'une rencontre pariee vieille de 20 jours n entre pas dans l ombre (36 h)');
      ok(!b.ombre['liga-futur'] && !b.attente['liga-futur'], 'une rencontre a venir (dans 10 jours) n est pas lue');
      ok(espnUrls.length > 0 && !espnUrls.some((u) => /dates=\d{6}&/.test(u)),
         'avec une rencontre a venir au calendrier, l ombre ne demande que des journees : ' + espnUrls.length + ' requete(s)');
      ok(!b.ombre['cri-odi'] && !b.attente['cri-odi'], 'un cricket sans tableau ESPN ne se lit pas');
      ok(b.ombre['tennis-pari'] && b.ombre['tennis-pari'].avecParis, 'le tennis parie est suivi (API core)');
      ok(!b.ombre['tennis-sans'], 'le tennis sans pari ne l est pas');
      ok(coreUrls.length > 0, 'l API core du tennis a ete lue pour lui');
      ok(dits.some((x) => /^\[reglement\] ombre : \d+ rencontre\(s\) lue\(s\)/.test(x)), 'la ligne [reglement] ombre est ecrite');
      ok(lignes.some((x) => /\[reglement\] scores : ESPN toutes les 2 h \(observe : ombre seule, rien n est regle ni publie\)/.test(x)),
         'la ligne de demarrage dit la cadence et le mode reels');
    } finally { ctl.arrete(); }
  }

  // ===================================================================== b
  console.log('\n-- b. mode regle : remis a signale, toujours 0 credit --');
  {
    process.env.PARIS_SCORES_ESPN = 'regle';
    const signales = [];
    const { r: ctl, lignes } = await capte(() => imp.planifie((f, o) => signales.push({ f, o }), aRegler, expo));
    try {
      ok(lignes.some((x) => /ESPN toutes les 2 h \(REGLE, 0 credit, fenetre 3 j\)/.test(x)), 'la ligne de demarrage dit REGLE');
      odds.length = 0;
      await capte(() => ctl.frequente());
      eq(signales.length, 1, 'signale est appele une fois');
      eq(signales[0] && signales[0].o && signales[0].o.passe, 'frequente', 'avec { passe: frequente }');
      const ids = signales[0] ? signales[0].f.map((f) => f.id).sort() : [];
      ok(ids.includes('liga-fini') && ids.includes('tennis-pari'), 'ce qu ESPN tranche (football, tennis) : ' + ids.join(','));
      ok(!ids.includes('cri-odi'), 'pas le cricket qu ESPN ne couvre pas');
      eq(creditsOdds(), 0, '0 credit : aucun /scores paye, meme pour le cricket parie');
      eq(odds.length, 0, 'aucun appel du tout vers The Odds API');
    } finally { ctl.arrete(); }
  }

  // ===================================================================== c
  console.log('\n-- c. la fenetre : jamais un mois dans la passe frequente --');
  {
    const signales = [];
    const { r: ctl } = await capte(() => imp.planifie((f, o) => signales.push({ f, o }), aRegler, expo));
    try {
      espnUrls.length = 0;
      await capte(() => ctl.frequente());
      const mois = espnUrls.filter((u) => /dates=\d{6}&/.test(u));
      eq(mois.length, 0, 'passe frequente (ombre + regle) : aucune requete au mois — ' + espnUrls.length + ' requete(s) au jour');
      ok(espnUrls.length > 0 && espnUrls.every((u) => /dates=\d{8}$/.test(u)), 'que des journees');
      espnUrls.length = 0;
      await capte(() => ctl.releve());
      ok(espnUrls.some((u) => /dates=\d{6}&/.test(u)), 'la quotidienne, elle, garde ses 30 jours (le parie de 20 jours se demande au mois)');
      espnUrls.length = 0;
      delete process.env.PARIS_SCORES_ESPN;
      await capte(() => ctl.frequente());
      ok(espnUrls.length > 0 && !espnUrls.some((u) => /dates=\d{6}&/.test(u)), 'l ombre seule (observe) non plus');
      process.env.PARIS_SCORES_ESPN = 'regle';
    } finally { ctl.arrete(); }
  }

  // ===================================================================== d
  console.log('\n-- d. une seule releve de scores a la fois --');
  {
    process.env.PARIS_SCORES_ESPN = 'regle';
    const vus = [];
    const signale = (f) => { for (const x of f) { vus.push(x.id); REGLES.add(x.id); } };
    const { r: ctl } = await capte(() => imp.planifie(signale, aRegler, expo));
    RETARD_ESPN = 30; RETARD_ODDS = 60;
    try {
      await capte(() => Promise.all([ctl.frequente(), ctl.releve()]));
      const doubles = vus.filter((x, i) => vus.indexOf(x) !== i);
      ok(vus.includes('liga-fini'), 'la rencontre finie est remise : ' + vus.join(','));
      eq(doubles.length, 0, 'frequente() et releve() lancees ensemble : chaque rencontre remise UNE fois');
    } finally { ctl.arrete(); RETARD_ESPN = 0; RETARD_ODDS = 0; REGLES.clear(); delete process.env.PARIS_SCORES_ESPN; }
  }

  // ===================================================================== e
  console.log('\n-- e. les corrections de l ombre --');
  {
    /* un journal neuf, et des passes a des instants choisis */
    rj.charge(bac('reglement-ombre-'));
    espnInitial();
    const passe = async (t) => (await capte(() => imp.ombreReglement(aRegler, expo, t))).r;
    const t1 = T0 + 60000;
    let r = await passe(t1);
    let b = rj.brut();
    const reglables = ['liga-fini', 'liga-same', 'liga-retour', 'liga-disp', 'liga-aet', 'epl-panne'];
    ok(reglables.every((id) => b.ombre[id] && b.ombre[id].premierReglable === t1), 'six rencontres reglables a la premiere passe');
    eq(r.corrections.length, 0, 'premiere passe : 0 correction');
    r = await passe(t1 + 2 * H);
    eq(r.corrections.length, 0, 'meme lecture deux heures plus tard : 0 correction');
    poseScore('soccer/esp.1', 'e1', 2, 2);                       // liga-fini : 2-1 -> 2-2
    poseScore('soccer/esp.1', 'e5', 0, 0, 'in');                  // liga-retour : revient en cours
    ESPN['soccer/esp.1'] = ESPN['soccer/esp.1'].filter((e) => e.id !== 'e6');   // liga-disp disparait, le tableau repond
    poseScore('soccer/esp.1', 'e7', 1, 1, 'post', 'STATUS_FINAL_AET');          // liga-aet : meme score, prolongation
    PANNE.add('soccer/eng.1');                                    // epl-panne : tableau en panne
    r = await passe(t1 + 4 * H);
    const parId = (id) => (rj.brut().ombre[id] || {}).corrections || [];
    eq(parId('liga-fini').length, 1, 'un score qui change (2-1 -> 2-2) : UNE correction');
    eq((parId('liga-fini')[0] || {}).cause, 'score', 'cause : score');
    eq(parId('liga-same').length, 0, 'un score identique : 0 correction');
    eq((parId('liga-retour')[0] || {}).cause, 'retour', 'reglable puis de nouveau en cours : correction « retour »');
    eq((parId('liga-disp')[0] || {}).cause, 'disparue', 'absente d un tableau qui a REPONDU : correction « disparue »');
    eq((parId('liga-aet')[0] || {}).cause, 'statut', 'FULL_TIME puis AET au meme score : correction « statut »');
    eq(parId('epl-panne').length, 0, 'absente d un tableau EN PANNE : rien ne se conclut');
    eq((rj.brut().ombre['epl-panne'] || {}).muettes, 1, 'mais la lecture muette se compte');
    ok(r.corrections.length === 4, 'la passe rend ses 4 corrections nouvelles (' + r.corrections.length + ')');
    PANNE.delete('soccer/eng.1');
    r = await passe(t1 + 6 * H);
    eq(r.corrections.length, 0, 'les memes etats deux heures plus tard : aucune correction de plus (chaque ecart compte une fois)');
    /* La fin de la fenetre est VUE (lecture a premierReglable + 24 h pile) :
       un changement lu apres elle n'est pas une correction de la fenetre.
       (Sans cette lecture, le changement a pu tomber dedans : il compte, par
       prudence — reglement_gardes.test.js le tient.) */
    r = await passe(t1 + 24 * H);
    eq(r.corrections.length, 0, 'la lecture de fin de fenetre (24 h pile) : memes etats, 0 correction');
    poseScore('soccer/esp.1', 'e1', 3, 3);
    r = await passe(t1 + 26 * H);
    eq(parId('liga-fini').length, 1, 'un changement APRES 24 h n est pas compte');
    ok(rj.brut().ombre['liga-fini'].clos === t1 + 26 * H, 'et la rencontre est close : suivie jusqu au bout');
    const res = imp.bilanReglement(t1 + 26 * H);
    eq(res.journal.ombre.suivies, 7, 'sept rencontres suivies 24 h (les six de football et le tennis parie)');
    eq(res.journal.ombre.avecCorrection, 4, 'quatre corrigees');
    eq(res.porteA.passe, false, 'porte A FERMEE des la premiere correction, a tout echantillon');
    ok(res.porteA.raisons[0] === 'correction', 'et la raison est la correction');
  }

  // ===================================================================== f
  console.log('\n-- f. le journal survit a un redemarrage --');
  {
    const dossier = path.dirname(rj.fichier());
    const avant = rj.brut();
    ok(!fs.readdirSync(dossier).some((x) => /\.tmp$/.test(x)), 'aucun fichier temporaire laisse (ecrit en deux temps)');
    for (const k of Object.keys(require.cache)) if (/paris_import\.js$|reglement_journal\.js$/.test(k)) delete require.cache[k];
    imp = require('./paris_import');
    rj = require('./reglement_journal');
    rj.charge(dossier);
    const apres = rj.brut();
    eq(apres.ombre['liga-fini'].premierReglable, avant.ombre['liga-fini'].premierReglable, 'premierReglable survit au rechargement des modules');
    eq(apres.ombre['liga-fini'].corrections.length, 1, 'les corrections aussi');
    eq(apres.debut, avant.debut, 'et le debut du journal');
    fs.writeFileSync(rj.fichier(), '{"v":1,"ombre":{"x"');
    rj.oublie();
    const { r: lu, lignes } = await capte(() => rj.brut());
    ok(lu && Object.keys(lu.ombre).length === 0, 'un fichier coupe se relit comme un journal vide');
    ok(fs.readdirSync(dossier).some((x) => /reglement_journal\.json\.illisible-\d+/.test(x)) && lignes.some((x) => /illisible/.test(x)),
       'et il est MIS DE COTE, et la chose est dite');
  }

  // ===================================================================== g
  console.log('\n-- g. le gain contrefactuel --');
  {
    rj.charge(bac('reglement-gain-'));
    const d = T0 - 30 * H, mur = 200, oh = { ombreH: 24, murMin: mur };
    const L = (id, reglable) => ({ id, sport: 'foot', ligue: 'soccer_spain_la_liga', debut: d, lu: true, repondu: true, fini: true, score: '1-0', resultat: '1', reglable });
    rj.notePasse(d + 100 * 60000);                 // avant le mur des 200 min : ne compte pour personne
    rj.noteOmbre([L('A', false), L('B', false)], d + 190 * 60000, oh);   // derniere lecture non reglable de A et B
    rj.noteOmbre([L('A', true)], d + 210 * 60000, oh);
    rj.noteOmbre([L('B', true)], d + 230 * 60000, oh);
    rj.noteOmbre([L('C', true)], d + 20 * H, oh);  // aucune passe reelle apres elle
    rj.notePasse(d + 12 * H);
    const res = rj.resume(d + 21 * H, { ombreH: 24, cadenceH: 2 });
    const g = res.ombre.gain.tous;
    eq(g.n, 2, 'deux rencontres jugees, une en attente de passe reelle');
    eq(g.enAttente, 1, 'C : en attente');
    /* A : borne = max(190, 200 min) = 200 min ; premiere passe >= borne = 12 h ; gain = 12 h - 210 min.
       B : meme borne, gain = 12 h - 230 min. C : lue reglable a 20 h, aucune passe apres. */
    const attendus = [12 * H - 210 * 60000, 12 * H - 230 * 60000].map((x) => Math.round(x / H * 100) / 100).sort((a, b) => a - b);
    eq(g.medianeBasH, attendus[0], 'mediane basse : celle du plus petit des deux gains (rang ceil(0,5 x 2))');
    eq(g.medianeHautH, attendus[0], 'haute = basse ici (aucune passe entre la borne et la lecture reglable)');
    rj.charge(bac('reglement-gain2-'));
    rj.noteOmbre([L('D', false)], d + 300 * 60000, oh);
    rj.notePasse(d + 330 * 60000);                 // une passe reelle entre la derniere lecture non reglable et la reglable
    rj.noteOmbre([L('D', true)], d + 420 * 60000, oh);
    rj.notePasse(d + 15 * H);
    const g2 = rj.resume(d + 16 * H, { ombreH: 24, cadenceH: 2 }).ombre.gain.tous;
    eq(g2.medianeBasH, 0, 'une passe reelle a pu la regler avant la lecture reglable : gain BAS 0');
    eq(g2.medianeHautH, Math.round((15 * H - 420 * 60000) / H * 100) / 100, 'gain HAUT : la prochaine passe apres la lecture reglable');
    rj.noteRegle('D', d + 15 * H, '1-0', 'auto', { source: 'espn', ligue: 'soccer_spain_la_liga' });
    const c = rj.resume(d + 16 * H, { ombreH: 24, cadenceH: 2 }).ombre.controle.auto;
    eq(c.n, 0, 'une rencontre SANS pari n entre pas dans le controle');
    /* ce que le /scores paye regle VRAIMENT, cle par cle (porte B) */
    rj.noteRegle('E', d + 15 * H, '1-0', 'auto', { source: 'scores', ligue: 'cricket_odi' });
    rj.noteRegle('F', d + 15 * H, '2-0', 'main', { source: 'main', ligue: 'cricket_odi' });
    rj.noteRegle('E', d + 16 * H, '9-9', 'main');
    const rs = rj.resume(d + 16 * H, { ombreH: 24, cadenceH: 2, fenetreJours: 30 });
    ok(rs.regles.n === 3 && rs.regles.auto.espn === 1 && rs.regles.auto.scores === 1 && rs.regles.main === 1,
       'les vrais reglements par chemin : 1 par ESPN, 1 par /scores paye, 1 a la main — ' + JSON.stringify(rs.regles));
    eq(rs.scores.regleesParClef.cricket_odi, 1, 'cricket_odi : 1 rencontre reellement reglee par le /scores paye (pas celle a la main)');
    eq(rj.brut().regles.E.score, '1-0', 'un second reglement de la meme rencontre n ecrase pas le premier');
  }

  // ===================================================================== h
  console.log('\n-- h. un journal en panne ne change rien au reglement --');
  {
    espnInitial();
    const reference = async () => (await capte(() => imp.importeScores(aRegler))).r.map((f) => f.id + '=' + (f.score || f.resultat) + (f.aMain ? '!' : '')).sort().join(',');
    rj.charge(bac('reglement-ref-'));
    const ref = await reference();
    ok(ref.length > 0, 'reference : ' + ref);
    /* le fichier du journal est un DOSSIER : ni lecture ni ecriture */
    const casse = bac('reglement-casse-');
    fs.mkdirSync(path.join(casse, 'reglement_journal.json'));
    rj.charge(casse);
    eq(await reference(), ref, 'journal illisible : importeScores rend exactement les memes rencontres');
    const o = await capte(() => imp.ombreReglement(aRegler, expo, Date.now()));
    ok(o.r && o.r.note === false && o.lignes.some((x) => /JOURNAL NON ECRIT/.test(x)), 'l ombre ne leve pas, et dit que rien n est ecrit');
    let leve = null;
    try { imp.bilanReglement(); imp.etatImport(); } catch (e) { leve = e; }
    ok(!leve, 'le bilan et etatImport ne levent pas');

    /* chaque fonction du journal qui LEVE (l'isolation de l'appelant) */
    rj.charge(bac('reglement-leve-'));
    /* une note mal formee, sur un journal LISIBLE, ne leve pas non plus : le
       journal attrape tout lui-meme */
    let l0 = null, r0;
    try { r0 = (await capte(() => rj.noteAppelScores('cle-x'))).r; } catch (e) { l0 = e; }
    ok(!l0 && r0 === null, 'une note bancale rend null, sans lever');
    const vrais = {};
    for (const k of ['noteAppelScores', 'deduitCout', 'noteOmbre', 'suivisEnCours', 'notePasse', 'bilanScores']) { vrais[k] = rj[k]; rj[k] = () => { throw new Error('panne (essai)'); }; }
    try {
      eq(await reference(), ref, 'chaque note du journal leve : importeScores rend les memes rencontres');
      const remis = [];
      const { r: ctl } = await capte(() => imp.planifie((f, o) => remis.push({ f, o }), aRegler, expo));
      try { await capte(() => ctl.releve()); } finally { ctl.arrete(); }
      eq(remis.length === 1 ? remis[0].f.map((f) => f.id + '=' + (f.score || f.resultat) + (f.aMain ? '!' : '')).sort().join(',') : 'rien', ref,
         'la quotidienne (notePasse leve) remet les memes rencontres a signale');
      let l2 = null;
      try { await capte(() => imp.ombreReglement(aRegler, expo, Date.now())); } catch (e) { l2 = e; }
      ok(!l2, 'et l ombre ne leve pas');
      process.env.PARIS_SCORES_COUPE = '1';
      odds.length = 0;
      eq(await reference(), ref, 'meme avec la coupe armee (son bilan leve : rien n est coupe)');
      /* les rencontres rendues ne suffisent pas a le voir : celles d'une cle
         coupee attendent la duree de leur format (un ODI, 10 h) avant de
         partir a la main — on regarde donc le /scores lui-meme */
      ok(odds.some((x) => x.ligue === 'cricket_odi' && x.quoi === 'scores'), 'et le /scores paye de cricket_odi part toujours : rien n est coupe sur un journal en panne');
    } finally { for (const k of Object.keys(vrais)) rj[k] = vrais[k]; delete process.env.PARIS_SCORES_COUPE; }
  }

  // ===================================================================== i
  console.log('\n-- i. la ligne de demarrage, mode par mode --');
  {
    const ligne = async () => {
      const { r: ctl, lignes } = await capte(() => imp.planifie(() => {}, aRegler, expo));
      ctl.arrete();
      return lignes.find((x) => /^\[reglement\] scores :/.test(x)) || '';
    };
    process.env.PARIS_SCORES_ESPN = 'xyz';
    let l = await ligne();
    ok(/observe : ombre seule/.test(l) && /PARIS_SCORES_ESPN « xyz » IGNORE/.test(l), 'une valeur inconnue vaut observe, et se dit : ' + l.slice(0, 120));
    eq(imp.modeEspn(), 'observe', 'modeEspn() rend observe');
    process.env.PARIS_SCORES_ESPN = '0';
    l = await ligne();
    ok(/COUPEE \(PARIS_SCORES_ESPN=0\)/.test(l), '0 : la passe est dite coupee');
    const signales = [];
    const { r: ctl } = await capte(() => imp.planifie((f) => signales.push(f), aRegler, expo));
    espnUrls.length = 0;
    await capte(() => ctl.frequente());
    ctl.arrete();
    eq(espnUrls.length + signales.length, 0, '0 : ni lecture ESPN ni rien de remis');
    delete process.env.PARIS_SCORES_ESPN;
    process.env.PARIS_SCORES_COUPE = '1';
    l = await ligne();
    ok(/coupe des cles jamais appariees ARMEE \(5 appels inutiles\)/.test(l), 'la coupe armee se dit');
    delete process.env.PARIS_SCORES_COUPE;
    l = await ligne();
    ok(/coupe des cles jamais appariees eteinte, rencontres en cours payees comme avant/.test(l), 'par defaut : coupe eteinte, rencontres en cours payees');
  }

  // ===================================================================== j
  console.log('\n-- j. --reglement : 0 credit, aucun appel reseau --');
  {
    const dossier = bac('reglement-cli-');
    rj.charge(dossier);
    rj.noteAppelScores('cricket_odi', { t: Date.now(), cout: 2, statut: 200, rendus: 0, finies: 0, appariees: 0, vieux: true, declencheurs: 1 });
    const garde = path.join(dossier, 'garde.js'), trace = path.join(dossier, 'reseau.txt');
    fs.writeFileSync(garde, `global.fetch = async (u) => { require('fs').appendFileSync(${JSON.stringify(trace)}, String(u) + '\\n'); throw new Error('reseau interdit'); };\n`);
    const env = Object.assign({}, process.env, { DATA_DIR: dossier, ODDS_API_KEY: '', NODE_OPTIONS: '--require ' + garde });
    const p = spawnSync(process.execPath, [path.join(__dirname, 'paris_import.js'), '--reglement'], { env, encoding: 'utf8', timeout: 60000 });
    eq(p.status, 0, '--reglement sort en 0');
    ok(/\[reglement\] ombre :/.test(p.stdout) && /PORTE A : pas encore jugeable/.test(p.stdout), 'il imprime l ombre et la porte A');
    ok(/cricket_odi \(non cochee\) : 1 appel\(s\), 2 credit\(s\), 0 appariee\(s\), 0 reglee\(s\) par ce chemin, 1 inutile\(s\)/.test(p.stdout), 'et les /scores payes par cle : ' + (p.stdout.match(/cricket_odi.*$/m) || [''])[0]);
    ok(!fs.existsSync(trace), 'aucun appel reseau');
  }

  // ===================================================================== k
  console.log('\n-- k. la carte « Settlement » du panneau --');
  {
    process.env.RPC_URL = process.env.RPC_URL || '';
    const page = require('./admin').page('jeton');
    const debut = page.indexOf('var REGL_B='), fin = page.indexOf('\n}\n', page.indexOf('function reglRend('));
    ok(debut > 0 && fin > debut, 'la page porte reglRend');
    const bac = { esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
    vm.createContext(bac);
    for (const nom of ['function num(', 'function ent(']) { const i = page.indexOf(nom); vm.runInContext(page.slice(i, page.indexOf('\n', i)), bac); }
    vm.runInContext(page.slice(debut, fin + 2), bac);
    const e = JSON.parse(JSON.stringify(imp.etatImport().reglement));
    let html = bac.reglRend(e);
    ok(/<b>Settlement<\/b>/.test(html) && /shadow only/.test(html) && /nothing is settled or posted/.test(html), 'en anglais : Settlement, shadow only');
    ok(/not enough games yet \(0\/300\)/.test(html), 'sous 300 rencontres : « not enough games yet (n/300) », aucun gain affiche');
    ok(!/median gain/.test(html), 'aucune mediane sous l echantillon');
    ok(/cricket_odi<\/code> \(no scores on the provider page\): paid 2 credit\(s\) on 1 call\(s\), matched 0, settled this way 0, useless 1/.test(html), 'la ligne par cle : ' + (html.match(/cricket_odi.{0,140}/) || [''])[0]);
    const gros = JSON.parse(JSON.stringify(e));
    Object.assign(gros.journal.ombre, { suiviesSansTrou: 320, avecCorrection: 0, enCours: 4 });
    gros.journal.ombre.gain.tous = { n: 330, medianeBasH: 3.5, p90BasH: 11.2 };
    gros.porteA = Object.assign({}, gros.porteA, { passe: true, raisons: [] });
    html = bac.reglRend(gros);
    ok(/median gain 3.5 h over 330 game\(s\)/.test(html) && /gate A passed/.test(html) && /<b>320<\/b> game\(s\)/.test(html), 'au-dessus de 300 : la mediane, son nombre, la porte');
    gros.journal.ombre.avecCorrection = 1;
    gros.porteA = Object.assign({}, gros.porteA, { passe: false, raisons: ['correction'] });
    html = bac.reglRend(gros);
    ok(/1 game\(s\) corrected after a settleable read/.test(html) && /gate A closed/.test(html), 'une correction : porte A fermee, dite');
    const piege = JSON.parse(JSON.stringify(e));
    piege.journal.scores.parClef['<img src=x>'] = { appels: 1 };
    piege.espn.invalide = '<b>x';
    html = bac.reglRend(piege);
    ok(!/<img src=x>/.test(html) && !/<b>x/.test(html), 'cles et valeurs echappees');
    eq(bac.reglRend(undefined), '', 'un serveur d avant le lot : rien');
    ok(/OFF/.test(bac.reglRend(Object.assign({}, e, { espn: Object.assign({}, e.espn, { mode: '0' }) }))), 'PARIS_SCORES_ESPN=0 : OFF');
    ok(/ARMED/.test(bac.reglRend(Object.assign({}, e, { coupe: { active: true } }))), 'la coupe armee se voit');
  }

  for (const d of BACS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* rien */ } }
  console.log(`\nRATES : ${rates}/${n}`);
  if (!rates) console.log(`reglement_cadence.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
