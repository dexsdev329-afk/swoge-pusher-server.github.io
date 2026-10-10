'use strict';
/*
 * LE JOURNAL DES RELEVES DEJA PAYEES, ET LA MESURE DE L'AGE DU PRIX (lot 1 de
 * la cle 20K, 10/10/2026).
 *
 * ---- ce que l'essai tient ----
 *
 * Chaque promesse a un garde-fou qui la fait tomber s'il est retire. Les
 * garde-fous retires un par un, et les quelques mutants equivalents qui
 * survivent (avec leur raison), sont dans EXPLOITATION 8.8septies :
 *  T1  0 credit et RIEN de vendu ne bouge : le meme scenario a horloge figee,
 *      journal actif puis coupe (PARIS_PRIX_JOURNAL=0), donne les memes
 *      appels, les memes credits, le meme carnet, le meme calendrier, le meme
 *      compteur, octet pour octet ; seul le journal differe ;
 *  T2  une ligne par reponse /odds notee, avec sa cause ; panne ou refus :
 *      aucune ; reponse vide : n = 0. Le tic de 10 min en deux causes (avant,
 *      demande), sans payer deux fois un championnat ni refaire deux imports ;
 *      sur 300 tirages, la suite des cles = l'ancien ensemble groupe ; et le
 *      tic par causes contre l'ancien appel groupe, sur le meme etat : memes
 *      appels, memes credits (refus d'autorise() et cle trop fraiche compris) ;
 *  T3  le contenu d'une ligne : reference vendue = carnet, trois sources
 *      calculees par le code de la vente, horizon, en jeu, observe, regime
 *      (c, av, am) ;
 *  T4  la borne 3-60 jours et la purge, au plus une fois par heure ;
 *  T5  jamais bloquant : un volume qui refuse n'empeche ni le carnet ni la
 *      vente, l'erreur se dit une fois par heure ; PARIS_PRIX_JOURNAL=0 coupe ;
 *  T6  une ligne coupee est sautee et comptee, au meme compte dans le
 *      serveur (en-tete seul) et dans l'outil (JSON complet) ;
 *  T7  la regle des paires sur des cas faits a la main (outils/age_prix.js) ;
 *  T8  la mesure cote comme la VENTE : cotes.habille(avecPrix(m)), le vrai
 *      chemin de l'import, sur 200 prix tires avec une graine fixe ;
 *  T9  l'intervalle robuste par rencontre ;
 *  T10 les jours complets (trou de 4 h, a cheval sur minuit compris) et j0
 *      (derniere serie a regime constant : c, av, am) ;
 *  T11 les verdicts G1/G2 de part et d'autre de chaque seuil, sans bascule :
 *      G2 ne dit jamais « non » sans la puissance A τ avant j0 + 28 ; G1 lit
 *      la borne exacte pres de 0 ; la construction de G1 attend la
 *      conclusion de la projection (le 7 du mois) ;
 *  T12 retraits de marche, cadence reelle, part des mises ;
 *  T13 l'etat, la route admin, aucune cle nulle part ;
 *  T14 l'index de cloture (derniere et avant-derniere d'avant-match, 7 jours,
 *      temporaire du processus, refait a l'identique depuis le journal) ;
 *  T15 la ligne du panneau d'administration : aucune part, aucun verdict, des
 *      comptes entiers, tout echappe ;
 *  T16 --telecharge : la cle dans l'en-tete seulement, jours passes seulement,
 *      paris sans adresse, une reponse en erreur jamais figee ;
 *  T17 le tic de 10 min tel que `planifie` le pose : cadence, decalage, age
 *      minimal d'une demande, erreurs enfermees ;
 *  T18 les champs et reglages du journal cote serveur (ko, c, av, am,
 *      horizon, replis, compte du jour, sources, purge, exceptions) ;
 *  T19 la mesure de bout en bout : sommes par rencontre, intervalle,
 *      puissance sous τ, portes sur leurs cellules, dates, rapport (n/a sous
 *      30), cadence par championnat, mises, age maximal lu dans les lignes.
 *
 * Aucun reseau : `fetch` est remplace. La derniere ligne dit « N
 * verifications OK » (verifie.sh la lit).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const H = 3600000, MIN = 60000, JOUR = 86400000;
const CLE_BANC = 'cle-de-banc-essai';

// ================================================================ T1, l'enfant
/* Le scenario de T1, lance dans un processus a part (l'etat des modules ne se
   remet pas a zero dans un meme processus) : horloge figee, faux fournisseur
   fixe, demarrage, avant-match par causes, releve periodique, etalonnage,
   imports. Il ecrit sur stdout tout ce qui sort du chemin des prix. */
async function scenario() {
  const BAC = process.env.DATA_DIR;
  const VraieDate = Date;
  const T0 = VraieDate.UTC(2026, 9, 10, 9, 0, 0);
  let MAINT = T0;
  class DateFigee extends VraieDate {
    constructor(...a) { if (a.length) super(...a); else super(MAINT); }
    static now() { return MAINT; }
  }
  global.Date = DateFigee;
  const quand = (dt) => new VraieDate(T0 + dt).toISOString();
  const ev = (id, dom, ext, dt) => ({ id, commence_time: quand(dt), home_team: dom, away_team: ext });
  const EV = {
    soccer_epl: [ev('e1', 'Arsenal', 'Everton', 3 * H + 5 * MIN), ev('e2', 'Chelsea', 'Liverpool', 26 * H), ev('e3', 'Brentford', 'Fulham', 74 * H)],
    soccer_france_ligue_one: [ev('f1', 'Lyon', 'Monaco', 28 * H)],
  };
  let TOUR = 1;
  const trois = (key, e, a, b, c) => ({ key, last_update: quand(-10 * MIN), markets: [{ key: 'h2h', last_update: quand(-10 * MIN), outcomes: [
    { name: e.home_team, price: a }, { name: 'Draw', price: b }, { name: e.away_team, price: c }] }] });
  const E = (l, i) => EV[l][i];
  const ODDS = {
    soccer_epl: () => [
      Object.assign({}, E('soccer_epl', 0), { bookmakers: [trois('betfair_ex_eu', E('soccer_epl', 0), TOUR === 1 ? 1.62 : 1.58, 4.1, 6.2),
        trois('pinnacle', E('soccer_epl', 0), 1.6, 4.0, 5.9), trois('unibet_eu', E('soccer_epl', 0), 1.57, 3.9, 5.6),
        trois('williamhill', E('soccer_epl', 0), 1.58, 3.8, 5.5)] }),
      Object.assign({}, E('soccer_epl', 1), { bookmakers: [trois('pinnacle', E('soccer_epl', 1), 2.55, 3.45, 2.85),
        trois('unibet_eu', E('soccer_epl', 1), 2.5, 3.4, 2.8), trois('bwin', E('soccer_epl', 1), 2.45, 3.4, 2.9)] }),
    ].concat(TOUR === 1 ? [Object.assign({}, E('soccer_epl', 2), { bookmakers: [trois('betfair_ex_eu', E('soccer_epl', 2), 2.3, 3.5, 3.3)] })] : []),
    soccer_france_ligue_one: () => [Object.assign({}, E('soccer_france_ligue_one', 0), { bookmakers: [
      trois('pinnacle', E('soccer_france_ligue_one', 0), 2.2, 3.5, 3.3), trois('unibet_eu', E('soccer_france_ligue_one', 0), 2.15, 3.4, 3.25),
      trois('bwin', E('soccer_france_ligue_one', 0), 2.1, 3.5, 3.4)] })],
  };
  const appels = [];
  let utilise = 0;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.origin !== 'https://api.the-odds-api.com') throw new Error('scenario : reseau interdit — ' + u.origin);
    const m = u.pathname.match(/^\/v4\/sports(?:\/([^/]+)\/(events|odds))?$/);
    let corps = [], cout = 0;
    if (m && m[1] && m[2] === 'events') corps = EV[m[1]] || [];
    else if (m && m[1] && m[2] === 'odds') { corps = ODDS[m[1]] ? ODDS[m[1]]() : []; if (corps.length) cout = 1; }
    utilise += cout;
    appels.push({ t: new VraieDate(MAINT).toISOString(), chemin: u.pathname, cout });
    const h = { 'x-requests-remaining': String(20000 - utilise), 'x-requests-used': String(utilise), 'x-requests-last': String(cout) };
    const brut = JSON.stringify(corps);
    return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
             json: async () => JSON.parse(brut), text: async () => brut };
  };
  fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify({ sports: [], matchs: [] }) + '\n');
  const pm = require('./prix_marche');
  const paris = require('./paris');
  const imp = require('./paris_import');
  await imp.importeMatchs(); paris.charge();
  await imp.rafraichitPrix(imp.prixPerimes(), 'demarrage', pm.releveMs());
  await imp.importeMatchs(); paris.charge();
  MAINT = T0 + 2.5 * H; TOUR = 2;
  paris.demandePrix({ source: { ligue: 'soccer_epl' } });    // deja dans « avant » : jamais paye deux fois
  for (const x of imp.causesAvantMatch(() => false)) await imp.rafraichitPrix(x.clefs, x.quoi, H);
  await imp.rafraichitPrix(imp.prixPerimes(), 'periodique', pm.releveMs());
  await imp.importeMatchs(); paris.charge();
  MAINT = T0 + 3 * H; TOUR = 3;
  await imp.calibre();
  await imp.importeMatchs(); paris.charge();
  const lit = (f) => { try { return fs.readFileSync(path.join(BAC, f), 'utf8'); } catch (e) { return null; } };
  const jdir = path.join(BAC, 'paris_prix_journal');
  const causes = [];
  try {
    for (const f of fs.readdirSync(jdir).sort()) for (const s of fs.readFileSync(path.join(jdir, f), 'utf8').split('\n')) if (s) { const x = JSON.parse(s); causes.push(x.l + ':' + x.q); }
  } catch (e) { /* journal coupe : pas de dossier */ }
  process.stdout.write(JSON.stringify({
    appels, credits: utilise, carnet: lit('paris_prix.json'), catalogue: lit('paris_catalogue.json'), quota: lit('odds_quota.json'),
    releveMs: pm.releveMs(), perimes: imp.prixPerimes(T0 + 6 * H).join(','),
    avecPrix: paris.catalogue().matchs.map((m) => JSON.stringify(imp.avecPrix(m, T0 + 3 * H))),
    journal: fs.existsSync(jdir), clotures: fs.existsSync(path.join(BAC, 'paris_prix_clotures.json')), causes,
  }));
}
if (process.argv[2] === '--scenario') {
  scenario().catch((e) => { console.error(e); process.exit(1); });
} else {
  principal().catch((e) => { console.error('RATE', e); process.exit(1); });
}

// ================================================================ l'essai
async function principal() {
  for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
  const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  process.env.DATA_DIR = BAC;
  process.env.ODDS_API_KEY = CLE_BANC;
  process.env.ODDS_API_TOTAL = '20000';
  process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_france_ligue_one';
  process.env.ODDS_API_HORIZON = '7';
  process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
  process.env.PARIS_PRIX_RELEVE_H = '2';

  let n = 0;
  const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ' + m); };
  const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); n++; console.log('  ok  ' + m); };
  const proche = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`); n++; console.log('  ok  ' + m); };
  const leve = (f) => { try { f(); return null; } catch (e) { return e; } };

  // --------------------------------------------------- le faux fournisseur
  const MAINTENANT = Date.now();
  const DEMAIN = MAINTENANT + 2 * JOUR;
  const LU = new Date(MAINTENANT - 7 * MIN).toISOString();
  const ev = (id, dom, ext, t) => ({ id, commence_time: new Date(t).toISOString(), home_team: dom, away_team: ext });
  const livre = (key, e, c1, cn, c2) => ({ key, last_update: LU, markets: [{ key: 'h2h', last_update: LU, outcomes: [
    { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
  const EVENTS = {
    soccer_epl: [ev('a1', 'Arsenal', 'Ipswich Town', DEMAIN), ev('a2', 'Chelsea', 'Everton', DEMAIN + H),
                 ev('a3', 'Equipe Inconnue FC', 'Liverpool', DEMAIN + 2 * H), ev('a4', 'Brentford', 'Fulham', MAINTENANT + 10 * JOUR),
                 ev('a5', 'Wolves', 'Leeds', MAINTENANT - 30 * MIN)],
    soccer_france_ligue_one: [ev('f1', 'Lyon', 'Monaco', DEMAIN)],
  };
  let PRIX_A1 = 1.12;
  const ODDS = {
    soccer_epl: () => [
      Object.assign({}, EVENTS.soccer_epl[0], { bookmakers: [livre('betfair_ex_eu', EVENTS.soccer_epl[0], PRIX_A1, 10.5, 30),
        livre('pinnacle', EVENTS.soccer_epl[0], 1.11, 10.0, 26), livre('unibet_eu', EVENTS.soccer_epl[0], 1.09, 9.0, 21),
        livre('williamhill', EVENTS.soccer_epl[0], 1.10, 9.5, 23)] }),
      Object.assign({}, EVENTS.soccer_epl[1], { bookmakers: [livre('pinnacle', EVENTS.soccer_epl[1], 1.95, 3.6, 4.2),
        livre('unibet_eu', EVENTS.soccer_epl[1], 1.90, 3.5, 4.0), livre('williamhill', EVENTS.soccer_epl[1], 1.91, 3.4, 4.1)] }),
      Object.assign({}, EVENTS.soccer_epl[2], { bookmakers: [livre('unibet_eu', EVENTS.soccer_epl[2], 6.0, 4.5, 1.55),
        livre('williamhill', EVENTS.soccer_epl[2], 6.2, 4.4, 1.53)] }),                       // deux livres : pas de reference
      Object.assign({}, EVENTS.soccer_epl[3], { bookmakers: [livre('betfair_ex_eu', EVENTS.soccer_epl[3], 2.3, 3.5, 3.3)] }),   // au-dela de l'horizon
      Object.assign({}, EVENTS.soccer_epl[4], { bookmakers: [livre('pinnacle', EVENTS.soccer_epl[4], 2.6, 3.3, 2.9)] }),        // en jeu
    ],
    soccer_france_ligue_one: () => [Object.assign({}, EVENTS.soccer_france_ligue_one[0], { bookmakers: [
      livre('pinnacle', EVENTS.soccer_france_ligue_one[0], 2.4, 3.4, 3.0), livre('unibet_eu', EVENTS.soccer_france_ligue_one[0], 2.35, 3.3, 2.95),
      livre('bwin', EVENTS.soccer_france_ligue_one[0], 2.3, 3.4, 3.0)] })],
    soccer_italy_serie_a: () => [],                                                                // une reponse vide
  };
  const appels = [];
  const PANNE = new Set();
  const vuesUrl = [];
  global.fetch = async (url) => {
    const u = new URL(String(url));
    vuesUrl.push(String(url));
    if (/espn\.com$/.test(u.hostname)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: [] }), text: async () => '{}' };
    const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
    const ligue = m && m[1], quoi = m && m[2];
    if (PANNE.has(ligue)) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ message: 'panne' }), text: async () => 'panne' };
    const corps = quoi === 'events' ? (EVENTS[ligue] || []) : quoi === 'odds' ? (ODDS[ligue] ? ODDS[ligue]() : []) : [];
    const cout = quoi === 'odds' && corps.length ? 1 : 0;
    appels.push({ ligue, quoi, cout });
    const total = appels.reduce((t, a) => t + a.cout, 0);
    const h = { 'x-requests-remaining': String(20000 - total), 'x-requests-used': String(total), 'x-requests-last': String(cout) };
    return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
             json: async () => JSON.parse(JSON.stringify(corps)), text: async () => JSON.stringify(corps) };
  };

  const AS = require('./alerte_solde');
  AS.oddsEvenement = () => true;     // aucune alerte reelle
  const pm = require('./prix_marche');
  const cotes = require('./cotes');
  const paris = require('./paris');
  const imp = require('./paris_import');
  const pj = require('./prix_journal');
  const ap = require('./outils/age_prix');

  const FQ = path.join(BAC, 'odds_quota.json');
  const aujourdhui = () => new Date().toISOString().slice(0, 10);
  const poseQuota = (reste, depense) => fs.writeFileSync(FQ, JSON.stringify({ reste, utilise: 20000 - reste, vu: null, depenseDuJour: depense, jour: aujourdhui() }));
  const toutes = () => {
    const out = [];
    try { for (const f of fs.readdirSync(pj.dossier()).sort()) out.push(...pj.lisTexte(fs.readFileSync(path.join(pj.dossier(), f), 'utf8')).lignes); } catch (e) { /* vide */ }
    return out;
  };
  const credits = () => appels.reduce((t, a) => t + a.cout, 0);
  const capture = async (f) => {
    const lignes = [], vrai = console.log;
    console.log = (...a) => { lignes.push(a.join(' ')); };
    try { await f(); } finally { console.log = vrai; }
    return lignes;
  };

  // =================================================================== T1
  console.log('\n-- T1. 0 credit, et rien de vendu ne bouge (journal actif contre coupe) --');
  {
    const lance = (journal) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-t1-'));
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(PARIS_|ODDS_API_|DATA_DIR$)/.test(k)) env[k] = v;
      Object.assign(env, { DATA_DIR: dir, ODDS_API_KEY: CLE_BANC, ODDS_API_TOTAL: '20000', ODDS_API_LIGUES: 'foot=soccer_epl,foot=soccer_france_ligue_one',
                           PARIS_PRIX_LIGUES: 'soccer_epl', PARIS_PRIX_OBSERVE: 'soccer_france_ligue_one', PARIS_PRIX_RELEVE_H: '2', PARIS_PRIX_AVANT_TOUS: '1' });
      if (journal !== undefined) env.PARIS_PRIX_JOURNAL = journal;
      const sortie = execFileSync(process.execPath, [__filename, '--scenario'], { cwd: __dirname, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      fs.rmSync(dir, { recursive: true, force: true });
      return JSON.parse(sortie.slice(sortie.indexOf('{"appels"')));
    };
    const avec = lance(undefined), sans = lance('0');
    eq(JSON.stringify(avec.appels), JSON.stringify(sans.appels), `memes appels au fournisseur, dans le meme ordre (${avec.appels.length})`);
    eq(avec.credits, sans.credits, `memes credits (${avec.credits}, somme des x-requests-last)`);
    ok(avec.credits >= 5, 'le scenario a bien paye des releves (sinon l egalite ne prouverait rien)');
    eq(avec.carnet, sans.carnet, 'paris_prix.json identique octet pour octet');
    eq(avec.catalogue, sans.catalogue, 'le calendrier vendu identique octet pour octet');
    eq(avec.quota, sans.quota, 'le compteur de credits identique octet pour octet');
    eq(JSON.stringify(avec.avecPrix), JSON.stringify(sans.avecPrix), `avecPrix rend les memes prix du marche sur chaque rencontre (${avec.avecPrix.length})`);
    eq(avec.releveMs, sans.releveMs, 'releveMs inchange'); eq(avec.perimes, sans.perimes, 'prixPerimes inchange');
    eq(avec.causes.join(','), 'soccer_epl:demarrage,soccer_france_ligue_one:demarrage,soccer_epl:avant,soccer_france_ligue_one:periodique,soccer_france_ligue_one:etalonnage',
       'journal actif : une ligne par releve payee, avec sa cause (demarrage, avant, periodique, etalonnage)');
    ok(avec.journal && avec.clotures, 'journal actif : le dossier et l index de cloture existent');
    ok(!sans.journal && !sans.clotures && sans.causes.length === 0, 'PARIS_PRIX_JOURNAL=0 : rien n est ecrit, ni journal ni index');
  }

  // =================================================================== T2
  console.log('\n-- T2. une ligne par reponse /odds notee, sa cause ; panne, refus : aucune --');
  {
    process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
    poseQuota(20000, 0);
    await imp.importeMatchs(); paris.charge();
    appels.length = 0;
    await imp.rafraichitPrix(['soccer_epl', 'soccer_france_ligue_one'], 'periodique', 0);
    let L = toutes();
    eq(L.map((x) => x.l + ':' + x.q).join(','), 'soccer_epl:periodique,soccer_france_ligue_one:periodique', 'deux championnats releves : deux lignes, cause periodique');
    eq(appels.filter((a) => a.quoi === 'odds').length, 2, 'et deux appels /odds, pas un de plus');
    await imp.calibre('soccer_france_ligue_one');
    L = toutes();
    eq(L[L.length - 1].q, 'etalonnage', 'calibre : une ligne de cause etalonnage');
    const avant = L.length;
    PANNE.add('soccer_epl');
    await imp.rafraichitPrix(['soccer_epl'], 'periodique', 0);
    PANNE.delete('soccer_epl');
    eq(toutes().length, avant, 'un championnat en PANNE (503) : aucune ligne');
    const part = imp.partDuJour(20000);
    poseQuota(20000, part);
    appels.length = 0;
    await imp.rafraichitPrix(['soccer_france_ligue_one'], 'periodique', 0);    // observe, classe 3 : refuse
    eq(appels.filter((a) => a.quoi === 'odds').length, 0, 'un observe refuse par le garde-fou ne part pas...');
    eq(toutes().length, avant, '...et ne laisse aucune ligne');
    poseQuota(20000, 0);
    await imp.rafraichitPrix(['soccer_italy_serie_a'], 'periodique', 0);
    const vide = toutes().pop();
    ok(vide.l === 'soccer_italy_serie_a' && vide.n === 0 && vide.e.length === 0, 'une reponse vide : une ligne avec n = 0 et e = []');

    /* le tic de 10 min, cause par cause */
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_france_ligue_one';
    process.env.PARIS_PRIX_AVANT_TOUS = '1';
    delete process.env.PARIS_PRIX_OBSERVE;
    const dans40 = MAINTENANT + 40 * MIN;
    EVENTS.soccer_epl.push(ev('a6', 'Burnley', 'Spurs', dans40));
    try {
      await imp.importeMatchs(); paris.charge();
      const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8'));
      c.ligues.soccer_epl = Date.now() - 3 * H; c.ligues.soccer_france_ligue_one = Date.now() - 3 * H;
      fs.writeFileSync(pm.fichier(), JSON.stringify(c));
      const mL1 = paris.catalogue().matchs.find((m) => m.source && m.source.ligue === 'soccer_france_ligue_one');
      const mEpl = paris.catalogue().matchs.find((m) => m.source && m.source.evenement === 'a6');
      ok(mL1 && mEpl, 'le calendrier porte une rencontre de Ligue 1 et une d EPL a 40 min');
      paris.demandePrix(mL1); paris.demandePrix(mEpl);
      const lots = imp.causesAvantMatch(() => false);
      eq(JSON.stringify(lots), JSON.stringify([{ quoi: 'avant', clefs: ['soccer_epl'] }, { quoi: 'demande', clefs: ['soccer_france_ligue_one'] }]),
         'causesAvantMatch : avant (EPL a 40 min) puis demande SANS ce que avant releve deja (Ligue 1)');
      eq(paris.prixDemandes().length, 0, 'prixDemandes est vide apres, comme avant');
      paris.demandePrix(mL1); paris.demandePrix(mEpl);
      poseQuota(20000, 0);
      const ctl = imp.planifie(() => {}, () => false);
      try {
        appels.length = 0;
        const n0 = toutes().length;
        await ctl.avantMatch();
        const odds = appels.filter((a) => a.quoi === 'odds').map((a) => a.ligue);
        eq(odds.join(','), 'soccer_epl,soccer_france_ligue_one', 'le tic : un appel par championnat, l EPL demandee ET a 40 min payee UNE fois');
        eq(toutes().slice(n0).map((x) => x.l + ':' + x.q).join(','), 'soccer_epl:avant,soccer_france_ligue_one:demande', 'deux lignes : avant, demande');
        eq(appels.filter((a) => a.quoi === 'events').length, 2, 'le calendrier refait UNE fois (un /events par championnat), comme avant');
        ok(toutes().slice(n0).every((x) => x.av === 1), 'PARIS_PRIX_AVANT_TOUS=1 : chaque ligne porte av = 1');
      } finally { ctl.arrete(); }

      /* La suite des cles du tic par causes = l'ancien ensemble groupe
         `[...new Set(prixAvantMatch(...).concat(prixDemandes()))]`, sur 300
         tirages : demandes au hasard (doublons, cles vendues ou non), avant-
         match pour tous ou non, carnet frais ou vieux, paris au hasard. */
      EVENTS.soccer_france_ligue_one.push(ev('f2', 'Nice', 'Lens', MAINTENANT + 50 * MIN));
      try {
        await imp.importeMatchs(); paris.charge();
        let graine = 99;
        const hasard = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
        const POOL = ['soccer_epl', 'soccer_france_ligue_one', 'soccer_italy_serie_a', 'soccer_spain_la_liga', 'soccer_epl'];
        const ids = paris.catalogue().matchs.map((m) => m.id);
        const fige = Date.now();
        let pareils = 0, croises = 0, deuxLots = 0;
        for (let i = 0; i < 300; i++) {
          if (hasard() < 0.5) process.env.PARIS_PRIX_AVANT_TOUS = '1'; else delete process.env.PARIS_PRIX_AVANT_TOUS;
          const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8'));
          for (const l of ['soccer_epl', 'soccer_france_ligue_one']) c.ligues[l] = fige - (hasard() < 0.7 ? 3 * H : 30 * MIN);
          fs.writeFileSync(pm.fichier(), JSON.stringify(c));
          const parie = new Set(ids.filter(() => hasard() < 0.5));
          const aDesParis = (id) => parie.has(id);
          const D = POOL.filter(() => hasard() < 0.5);
          if (hasard() < 0.5) D.reverse();
          D.forEach((l) => paris.demandePrix({ source: { ligue: l } }));
          const lots = imp.causesAvantMatch(aDesParis, fige);
          D.forEach((l) => paris.demandePrix({ source: { ligue: l } }));
          const avantSeul = imp.prixAvantMatch(aDesParis, fige);
          const groupe = [...new Set(avantSeul.concat(paris.prixDemandes()))];
          const suite = [].concat(...lots.map((x) => x.clefs));
          if (JSON.stringify(suite) === JSON.stringify(groupe) && lots.every((x) => x.clefs.length)
              && new Set(suite).size === suite.length && (!lots.length || lots[0].quoi === 'avant' || !avantSeul.length)) pareils++;
          if (avantSeul.some((l) => D.includes(l))) croises++;
          if (lots.length === 2) deuxLots++;
        }
        eq(pareils, 300, 'sur 300 tirages : avant puis demande = l ancien ensemble groupe, dans le meme ordre, sans doublon ni lot vide');
        ok(croises >= 30 && deuxLots >= 30, `les tirages exercent le cas qui compte (${croises} avec une demande deja dans avant, ${deuxLots} avec deux lots)`);

        /* Le tic par causes contre l'ancien appel groupe, sur le MEME etat :
           deux championnats en avant-match (EPL a 40 min, Ligue 1 a 50 min),
           une demande deja dans avant (Ligue 1), une demande refusee par
           autorise() (Serie A, observee hors liste : classe 3, jour charge),
           une demande relevee il y a 10 min (Liga : moins de PRIX_DEMANDE_MS,
           1 h). Memes appels au fournisseur, dans le meme ordre, memes credits,
           meme compteur ; seul le libelle de la cause change. */
        process.env.PARIS_PRIX_AVANT_TOUS = '1';
        const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8'));
        c.ligues.soccer_epl = Date.now() - 3 * H; c.ligues.soccer_france_ligue_one = Date.now() - 3 * H; c.ligues.soccer_spain_la_liga = Date.now() - 10 * MIN;
        delete c.ligues.soccer_italy_serie_a;
        fs.writeFileSync(pm.fichier(), JSON.stringify(c));
        poseQuota(20000, imp.partDuJour(20000) - 100);
        const FCAT = path.join(BAC, 'paris_catalogue.json');
        const etat0 = { carnet: fs.readFileSync(pm.fichier(), 'utf8'), quota: fs.readFileSync(FQ, 'utf8'), cat: fs.readFileSync(FCAT, 'utf8') };
        const D = ['soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_spain_la_liga'];
        const ctl2 = imp.planifie(() => {}, () => false);
        const tour = async (f) => {
          fs.writeFileSync(pm.fichier(), etat0.carnet); fs.writeFileSync(FQ, etat0.quota); fs.writeFileSync(FCAT, etat0.cat);
          paris.charge();
          D.forEach((l) => paris.demandePrix({ source: { ligue: l } }));
          appels.length = 0;
          const dits = await capture(f);
          return { appels: JSON.stringify(appels), credits: credits(), quota: JSON.parse(fs.readFileSync(FQ, 'utf8')).depenseDuJour,
                   refus: dits.filter((s) => /REFUSE prix soccer_italy_serie_a/.test(s)).length };
        };
        try {
          const groupe = await tour(() => ctl2.prix([...new Set(imp.prixAvantMatch(() => false).concat(paris.prixDemandes()))], 'avant le coup d envoi', H));
          const causes = await tour(() => ctl2.avantMatch());
          ok(groupe.credits === 2 && /soccer_epl","quoi":"odds/.test(groupe.appels) && /soccer_france_ligue_one","quoi":"odds/.test(groupe.appels)
             && !/soccer_spain_la_liga/.test(groupe.appels) && groupe.refus === 1, 'l ancien appel groupe : EPL et Ligue 1 payees, Serie A refusee, Liga trop fraiche');
          eq(causes.appels, groupe.appels, 'le tic par causes : les MEMES appels, dans le meme ordre (odds puis un seul calendrier)');
          eq(causes.credits, groupe.credits, `les memes credits (${causes.credits})`);
          eq(causes.quota, groupe.quota, 'le meme compteur du jour');
          eq(causes.refus, 1, 'et le meme refus d autorise() pour la Serie A');
        } finally {
          ctl2.arrete();
          fs.writeFileSync(pm.fichier(), etat0.carnet); fs.writeFileSync(FQ, etat0.quota); fs.writeFileSync(FCAT, etat0.cat);
          paris.prixDemandes();
        }
      } finally { EVENTS.soccer_france_ligue_one.pop(); }
    } finally {
      EVENTS.soccer_epl.pop();
      process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
      delete process.env.PARIS_PRIX_AVANT_TOUS;
      await imp.importeMatchs(); paris.charge();
    }
  }

  // =================================================================== T3
  console.log('\n-- T3. le contenu d une ligne --');
  {
    process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
    poseQuota(20000, 0);
    await imp.rafraichitPrix(['soccer_epl', 'soccer_france_ligue_one'], 'periodique', 0);
    delete process.env.PARIS_PRIX_OBSERVE;
    const L = toutes();
    const epl = L.filter((x) => x.l === 'soccer_epl').pop(), l1 = L.filter((x) => x.l === 'soccer_france_ligue_one').pop();
    const carnet = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8'));
    ok(epl.v === 1 && epl.m === 'h2h' && epl.q === 'periodique', 'v 1, marche h2h, cause');
    eq(epl.t, carnet.ligues.soccer_epl, 't = la date du carnet');
    eq(epl.c, 120, 'c = releveMs en minutes (PARIS_PRIX_RELEVE_H=2)');
    eq(epl.av, 0, 'av = 0 sans PARIS_PRIX_AVANT_TOUS');
    eq(epl.am, Math.round(pm.AGE_MAX_MS / MIN), `am = l age maximal de vente en minutes (${epl.am}, PARIS_PRIX_AGE_MAX_H, 36 h par defaut)`);
    eq(epl.am, Math.round(paris.AGE_PRIX_MS / MIN), 'le meme que paris.AGE_PRIX_MS (la porte de paris.ouvert)');
    eq(epl.n, 5, 'n compte les cinq rencontres de la reponse');
    eq(epl.e.map((x) => x[0]).join(','), 'a1,a2,a3,a5', 'a4 (au-dela de 7 + 1 jours) absente de e, comptee dans n');
    ok(!('o' in epl) && l1.o === 1, 'o = 1 pour le championnat observe seulement');
    const a1 = epl.e[0];
    eq(a1[2], 'b', 'Arsenal–Ipswich : reference Betfair');
    eq(JSON.stringify(a1[3]), JSON.stringify([carnet.evenements.a1.p[1], carnet.evenements.a1.p.N, carnet.evenements.a1.p[2]]), 'le prix vendu = le carnet, a 1e-5');
    eq(a1[7], carnet.evenements.a1.livres, 'livres = le carnet');
    eq(JSON.stringify(a1[4]), JSON.stringify(a1[3]), 'la source Betfair = le prix vendu (la reference est Betfair)');
    ok(a1[5] && a1[6], 'les sources Pinnacle et mediane sont la aussi');
    eq(a1[8], Date.parse(LU), 'luB : last_update du marche h2h de Betfair');
    eq(a1[9], Date.parse(LU), 'luP : celui de Pinnacle');
    const a2 = epl.e[1];
    ok(a2[2] === 'p' && a2[4] === null && JSON.stringify(a2[5]) === JSON.stringify(a2[3]) && a2[6], 'Chelsea–Everton : Pinnacle vendu, pas de Betfair, mediane presente');
    eq(JSON.stringify(epl.e[2]), JSON.stringify(['a3', Date.parse(EVENTS.soccer_epl[2].commence_time), 'x']), 'sans reference : [id, debut, x]');
    ok(epl.e[3][1] <= epl.t, 'la rencontre en jeu est gardee (debut <= t), la mesure l ignorera');
    /* la source nommee par la reference = le prix vendu, sur 300 rencontres
       tirees (graine fixe) : les trois sources viennent du code de la vente */
    let graine = 7;
    const hasard = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
    const cles = ['betfair_ex_eu', 'pinnacle', 'unibet_eu', 'williamhill', 'bwin', 'marathonbet'];
    let nRef = 0, accord = 0;
    for (let i = 0; i < 300; i++) {
      const e = ev('r' + i, 'Dom', 'Ext', DEMAIN);
      const p1 = 0.15 + hasard() * 0.6, pn = 0.15 + hasard() * 0.15, p2 = Math.max(0.05, 1 - p1 - pn);
      const livres = cles.filter(() => hasard() < 0.6).map((k) => {
        const m = 1 + 0.01 + hasard() * 0.08 + (hasard() < 0.1 ? 0.2 : 0);
        return livre(k, e, Math.round(100 / (p1 * m)) / 100 * (1 + (hasard() - 0.5) * 0.1), Math.round(100 / (pn * m)) / 100, Math.round(100 / (p2 * m)) / 100);
      });
      const evx = Object.assign({}, e, { bookmakers: livres });
      const r = pm.referenceDe(evx);
      if (!r) continue;
      nRef++;
      const s = pj.sourcesDe(evx);
      const src = { betfair: s.b, pinnacle: s.p, mediane: s.md }[r.ref];
      if (src && ['1', 'N', '2'].every((k) => src[k] === r.p[k])) accord++;
    }
    ok(nRef > 150, `${nRef} rencontres tirees ont une reference`);
    eq(accord, nRef, 'pour chacune, la source nommee par la reference EST le prix vendu (referenceDe sur un seul livre / sur les livres ordinaires)');
    ok(!JSON.stringify(L).includes(CLE_BANC) && !/apiKey/.test(JSON.stringify(L)), 'aucune cle ni URL d appel dans le journal');
  }

  // =================================================================== T4
  console.log('\n-- T4. la borne et la purge --');
  {
    process.env.PARIS_PRIX_JOURNAL_J = '99'; eq(pj.joursGardes(), 60, 'PARIS_PRIX_JOURNAL_J=99 ramene a 60');
    process.env.PARIS_PRIX_JOURNAL_J = '1'; eq(pj.joursGardes(), 3, '=1 ramene a 3');
    process.env.PARIS_PRIX_JOURNAL_J = 'abc'; eq(pj.joursGardes(), 30, 'illisible : 30');
    delete process.env.PARIS_PRIX_JOURNAL_J; eq(pj.joursGardes(), 30, 'vide : 30 (defaut)');
    process.env.PARIS_PRIX_JOURNAL_J = '10';
    const TJ = Date.parse(aujourdhui() + 'T12:00:00Z');
    const ligne = (t) => ({ v: 1, m: 'h2h', t, l: 'soccer_borne', q: 'essai', c: 120, n: 0, o: 1, e: [] });
    for (let k = 12; k >= 0; k--) ok(pj.ecrit(ligne(TJ - k * JOUR)) === true, `ecrit le jour J-${k}`);
    const jours = fs.readdirSync(pj.dossier()).filter((f) => /\.jsonl$/.test(f)).sort();
    eq(jours.length, 10, 'apres purge, dix fichiers');
    eq(jours[0], pj.jourDe(TJ - 9 * JOUR) + '.jsonl', 'le plus vieux est J-9');
    eq(jours[jours.length - 1], pj.jourDe(TJ) + '.jsonl', 'le plus recent est J');
    const vrai = fs.readdirSync;
    let lus = 0;
    fs.readdirSync = function (d, ...r) { if (String(d) === pj.dossier()) lus++; return vrai.call(fs, d, ...r); };
    try {
      for (const dm of [10, 20, 30]) pj.ecrit(ligne(TJ + dm * MIN));
      eq(lus, 0, 'trois lignes dans l heure qui suit une purge : aucune relecture du dossier');
      pj.ecrit(ligne(TJ + 61 * MIN));
      eq(lus, 1, 'une heure apres : une purge, une seule');
    } finally { fs.readdirSync = vrai; }
    delete process.env.PARIS_PRIX_JOURNAL_J;
    for (const f of jours) if (f !== aujourdhui() + '.jsonl') fs.rmSync(path.join(pj.dossier(), f), { force: true });
    /* on retire aussi les lignes d'essai du jour (soccer_borne) */
    const fj = path.join(pj.dossier(), aujourdhui() + '.jsonl');
    fs.writeFileSync(fj, fs.readFileSync(fj, 'utf8').split('\n').filter((s) => s && !s.includes('soccer_borne')).join('\n') + '\n');
  }

  // =================================================================== T5
  console.log('\n-- T5. jamais bloquant --');
  {
    const D = pj.dossier();
    const sauve = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-sauve-'));
    fs.renameSync(D, path.join(sauve, 'j'));
    fs.writeFileSync(D, 'un fichier a la place du dossier');
    const e0 = pj.etat().echecs.journal;
    poseQuota(20000, 0);
    const prixVendus = [];
    const dits = await capture(async () => {
      for (const px of [1.12, 1.11, 1.10]) {     // Betfair reste saine (somme 1,02 a 1,04) : c'est elle qui se vend
        PRIX_A1 = px;
        const r = await imp.rafraichitPrix(['soccer_epl'], 'periodique', 0);
        prixVendus.push({ r, t: pm.derniere('soccer_epl'), p: pm.pour('a1') && pm.pour('a1').p[1] });
      }
    });
    ok(prixVendus.every((x) => x.r === 1), 'rafraichitPrix rend son compte a chaque fois (note n a pas leve)');
    ok(prixVendus[2].t >= prixVendus[0].t && Date.now() - prixVendus[2].t < 60000, 'le carnet est ecrit (date de la releve)');
    ok(prixVendus[0].p < prixVendus[1].p && prixVendus[1].p < prixVendus[2].p, `pour() vend le NOUVEAU prix a chaque releve (${prixVendus.map((x) => x.p).join(' < ')})`);
    eq(pj.etat().echecs.journal - e0, 3, 'etat().echecs.journal compte les trois ecritures refusees');
    eq(dits.filter((s) => /\[odds\] journal des prix/.test(s)).length, 1, 'l erreur se dit UNE fois en une heure, pas a chaque releve');
    eq(pj.etat().echecs.clotures, 0, 'l index de cloture, lui, s ecrit toujours');
    fs.rmSync(D, { force: true });
    fs.renameSync(path.join(sauve, 'j'), D);
    fs.rmSync(sauve, { recursive: true, force: true });
    /* le retour arriere */
    process.env.PARIS_PRIX_JOURNAL = '0';
    try {
      const avant = toutes().length, idx = fs.readFileSync(pj.fichierClotures(), 'utf8');
      PRIX_A1 = 1.12;
      eq(await imp.rafraichitPrix(['soccer_epl'], 'periodique', 0), 1, 'PARIS_PRIX_JOURNAL=0 : la releve se fait');
      eq(toutes().length, avant, 'et rien n est ecrit au journal');
      eq(fs.readFileSync(pj.fichierClotures(), 'utf8'), idx, 'ni a l index de cloture');
      ok(pm.pour('a1').p[1] > 0, 'la vente continue');
    } finally { delete process.env.PARIS_PRIX_JOURNAL; }
  }

  // =================================================================== T6
  console.log('\n-- T6. une ligne coupee --');
  {
    const L = toutes().slice(-3);
    const bizarre = Object.assign({}, L[0], { q: 'cause "entre guillemets" \\ et accent é' });
    const coupe = JSON.stringify(L[1]).slice(0, 80);
    const txt = [JSON.stringify(L[0]), JSON.stringify(bizarre), '{"x":1}', JSON.stringify(L[2]), coupe].join('\n') + '\n';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-t6-'));
    fs.writeFileSync(path.join(dir, '2026-01-02.jsonl'), txt);
    const lu = await pj.lisJournal({ dossier: dir });
    eq(lu.lignes.length, 3, 'lisJournal rend les trois lignes entieres');
    eq(lu.illisibles, 2, 'et compte deux illisibles (une ligne etrangere, une ligne coupee), sans lever');
    fs.writeFileSync(path.join(pj.dossier(), '2026-01-02.jsonl'), txt);
    const e = pj.etat().jours.find((x) => x.jour === '2026-01-02');
    const parQuoi = {};
    for (const x of lu.lignes) parQuoi[x.q] = (parQuoi[x.q] || 0) + 1;
    ok(e && e.lignes === 3 && e.illisibles === 2 && JSON.stringify(Object.entries(e.parQuoi).sort()) === JSON.stringify(Object.entries(parQuoi).sort()),
       'le compte du serveur (en-tete seul, sans decoder les prix) = celui de l outil (JSON complet), cause echappee comprise');
    fs.rmSync(path.join(pj.dossier(), '2026-01-02.jsonl'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // =================================================================== T7
  console.log('\n-- T7. la regle des paires, cas faits a la main --');
  const T = Date.UTC(2026, 9, 12, 10, 0, 0);
  const ligneM = (t, l, e, extra) => Object.assign({ v: 1, m: 'h2h', t, l, q: 'periodique', c: 120, n: e.length, e }, extra || {});
  const E = (id, debut, ref, pv, src) => (ref === 'x' ? [id, debut, 'x']
    : [id, debut, ref, pv, (src && src.b) || (ref === 'b' ? pv : null), (src && src.p) || (ref === 'p' ? pv : null), (src && src.m) || (ref === 'm' ? pv : null), 4, null, null]);
  const cel = (r, cle) => r.cellules[cle] || { m: 0, n: 0, b: 0, sev: 0, refuses: 0, paires: 0, nRef: 0, bRef: 0 };
  {
    const PK = [0.5, 0.27, 0.23], PJ = [0.56, 0.24, 0.20];
    const ck = ap.cotesVendues(PK);
    eq(JSON.stringify([ck['1n2'][1], ck['1n2'].N, ck['1n2'][2]]), '[1.88,3.29,3.8]', 'p {.50,.27,.23} se vend 1,88 / 3,29 / 3,80 (habilleUnMarche)');
    eq(JSON.stringify([ck.dc['1X'], ck.dc[12], ck.dc.X2]), '[1.23,1.29,1.83]', 'double chance 1,23 / 1,29 / 1,83');
    const D0 = T + 30 * H;
    const cas = (pk, pjx) => ap.mesure([ligneM(T, 'soccer_epl', [E('x1', D0, 'b', pk)]), ligneM(T + 2 * H, 'soccer_epl', [E('x1', D0, 'b', pjx)])], { sansFiltreJours: true });
    let r = cas(PK, PJ);
    let c = cel(r, 'tous|vente|1n2|1-3h|24-48h');
    ok(c.m === 1 && c.n === 3 && c.b === 1, 'contre {.56,.24,.20} : 1 issue battable sur 3 en 1-N-2');
    proche(c.sev, 1.88 * 0.56 - 1, 1e-9, '« 1 » a +5,28 %');
    c = cel(r, 'tous|vente|dc|1-3h|24-48h');
    ok(c.n === 3 && c.b === 0, '0 sur 3 en double chance');
    eq(cel(cas(PK, PK), 'tous|vente|1n2|1-3h|24-48h').b, 0, 'p(k) = p(j) : 0 sur 3 (le plancher de marge)');
    r = cas([0.8, 0.12, 0.08], [0.85, 0.09, 0.06]);
    c = cel(r, 'tous|vente|1n2|1-3h|24-48h');
    ok(c.b === 1, 'favori .80 -> .85 : cote 1,18, « 1 » battable');
    proche(c.sev, 1.18 * 0.85 - 1, 1e-9, 'a +0,3 %');
    eq(cel(r, 'tous|vente|1n2|1-3h|<3h').m + cel(r, 'tous|vente|1n2|0-1h|24-48h').m, 0, 'rien ailleurs');

    /* le k le PLUS RECENT de la tranche, une paire par (j, tranche) */
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x2', D0, 'b', PK)]), ligneM(T + 30 * MIN, 'soccer_epl', [E('x2', D0, 'b', PJ)]),
                   ligneM(T + 150 * MIN, 'soccer_epl', [E('x2', D0, 'b', PJ)])], { sansFiltreJours: true });
    c = cel(r, 'tous|vente|1n2|1-3h|24-48h');
    ok(c.paires === 1 && c.b === 0, 'deux k dans 1-3 h : seul le plus recent (meme prix) fait la paire — 0 battable, une paire');

    /* Δ > AGE_PRIX_MS : jamais vendu, jamais compte */
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x3', T + 80 * H, 'b', PK)]), ligneM(T + 40 * H, 'soccer_epl', [E('x3', T + 80 * H, 'b', PJ)])],
                  { sansFiltreJours: true, ages: [0, 1, 3, 6, 12, 13, 48] });
    eq(cel(r, 'tous|vente|1n2|13-48h|24-48h').paires, 0, 'k vieux de 40 h (> 36 h) : exclu, meme dans une tranche 13-48 h');

    /* la porte 3 h / 3 h */
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x4', T + 5 * H, 'b', PK)]), ligneM(T + 4 * H, 'soccer_epl', [E('x4', T + 5 * H, 'b', PJ)])], { sansFiltreJours: true });
    c = cel(r, 'tous|vente|1n2|3-6h|<3h');
    ok(c.m === 0 && c.refuses === 1, 'delai 1 h, prix de 4 h : refuse par la porte de vente, compte dans refuses, pas dans la part');

    /* en jeu, observe, sans reference */
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x5', T + H, 'b', PK)]), ligneM(T + 90 * MIN, 'soccer_epl', [E('x5', T + H, 'b', PJ)])], { sansFiltreJours: true });
    ok(Object.keys(r.cellules).length === 0 && r.exclus.enJeu === 1, 'j en jeu (debut <= t) : ignore');
    r = ap.mesure([ligneM(T, 'soccer_mls_obs', [E('x6', D0, 'b', PK)], { o: 1 }), ligneM(T + 2 * H, 'soccer_mls_obs', [E('x6', D0, 'b', PJ)], { o: 1 })], { sansFiltreJours: true });
    ok(Object.keys(r.cellules).length === 0 && r.exclus.observes === 2, 'lignes o = 1 (observe, non vendu) : ignorees');
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x7', D0, 'x')]), ligneM(T + 2 * H, 'soccer_epl', [E('x7', D0, 'b', PJ)])], { sansFiltreJours: true });
    ok(Object.keys(r.cellules).length === 0, 'k sans reference (x) : aucune paire');
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x9', D0, 'b', PK)]), ligneM(T + 30 * MIN, 'soccer_epl', [E('x9', D0, 'b', PJ)], { ko: 1 }),
                   ligneM(T + 150 * MIN, 'soccer_epl', [E('x9', D0, 'b', PJ)])], { sansFiltreJours: true });
    c = cel(r, 'tous|vente|1n2|1-3h|24-48h');
    ok(c.paires === 1 && c.b === 1, 'k dont le carnet n a pas ete ecrit (ko) : jamais vendu, c est le prix d avant qui fait la paire');

    /* changement de reference b -> m, et la meme source */
    const P3 = [0.62, 0.22, 0.16];
    r = ap.mesure([ligneM(T, 'soccer_epl', [E('x8', D0, 'b', PK, { b: PK, m: [0.49, 0.28, 0.23] })]),
                   ligneM(T + 2 * H, 'soccer_epl', [E('x8', D0, 'm', P3, { b: PK, m: P3 })])], { sansFiltreJours: true });
    const v = cel(r, 'tous|vente|1n2|1-3h|24-48h'), s = cel(r, 'tous|source|1n2|1-3h|24-48h');
    ok(v.nRef === 1 && v.bRef === 1 && v.b >= 1, 'betfair -> mediane : compte dans nRef/bRef, battable a la vente');
    ok(s.m === 1 && s.b === 0, 'meme source (Betfair relu a j, inchange) : 0 battable — le bruit de reference ne decide pas seul');
  }

  // =================================================================== T8
  console.log('\n-- T8. la mesure cote comme la VENTE (cotes.habille(avecPrix(m))) --');
  {
    let graine = 20261010;
    const hasard = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
    const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8'));
    const ms = [];
    for (let i = 0; i < 200; i++) {
      const a = 0.04 + hasard() * 0.9, b = 0.04 + hasard() * 0.4, d = 0.04 + hasard() * 0.9, s = a + b + d;
      const p = { 1: Math.round(a / s * 1e5) / 1e5, N: Math.round(b / s * 1e5) / 1e5 };
      p[2] = Math.round((1 - p[1] - p.N) * 1e5) / 1e5;
      const id = 't8-' + i, debut = Date.now() + 3 * JOUR;
      c.evenements[id] = { t: Date.now(), ref: 'betfair', p, livres: 4, ecart: 0, ligue: 'soccer_epl', dom: 'Dom ' + i, ext: 'Ext ' + i, debut };
      ms.push({ id: 'm' + i, sport: 'foot', domicile: 'Dom ' + i, exterieur: 'Ext ' + i, debut: new Date(debut).toISOString(),
                competition: 'Premier League', source: { ligue: 'soccer_epl', evenement: id }, p });
    }
    fs.writeFileSync(pm.fichier(), JSON.stringify(c));
    let pareils = 0, vendus = 0, dc = 0;
    for (const m of ms) {
      let h = null;
      try { h = cotes.habille(imp.avecPrix(m)); } catch (e) { h = null; }
      const mine = ap.cotesVendues([m.p[1], m.p.N, m.p[2]]);
      const vrai1 = h && h.marches && h.marches['1n2'] ? h.marches['1n2'].cotes : null;
      const vraiDc = h && h.marches && h.marches.dc ? h.marches.dc.cotes : null;
      if (vrai1) vendus++;
      if (vraiDc) dc++;
      const meme = (a, b) => (!a && !b) || (a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]));
      if (meme(vrai1, mine && mine['1n2']) && meme(vraiDc, mine && mine.dc)) pareils++;
    }
    ok(vendus > 150 && dc > 150, `${vendus} rencontres vendues au marche, ${dc} avec double chance (l egalite porte sur du vrai)`);
    eq(pareils, 200, 'sur 200 prix tires : 1-N-2 et double chance de la mesure = ceux du chemin de vente, issue par issue');
    for (const m of ms) delete c.evenements[m.source.evenement];
    fs.writeFileSync(pm.fichier(), JSON.stringify(c));
  }

  // =================================================================== T9
  console.log('\n-- T9. l intervalle robuste par rencontre --');
  {
    const cellDe = (paires) => {
      const c = { m: 0, n: 0, b: 0, sbb: 0, snn: 0, sbn: 0, sev: 0, nRef: 0, bRef: 0, refuses: 0 };
      for (const [nn, bb] of paires) { c.m++; c.n += nn; c.b += bb; c.sbb += bb * bb; c.snn += nn * nn; c.sbn += bb * nn; }
      return c;
    };
    const s = ap.stats(cellDe([[3, 1], [6, 0], [3, 2]]));
    const r = 3 / 12, v = (3 / 2) * ((1 + 0 + 4) - 2 * r * (3 + 0 + 6) + r * r * (9 + 36 + 9)) / 144;
    proche(s.part, 0.25, 1e-12, 'part = Σb / Σn');
    proche(s.se, Math.sqrt(v), 1e-12, 'erreur type = m/(m-1) (Σb² - 2rΣbn + r²Σn²)/(Σn)², a la main');
    const un = ap.stats(cellDe([[3, 1]]));
    ok(un.se === null && un.lo === null, 'm = 1 : intervalle non defini');
    const base = [];
    for (let i = 0; i < 20; i++) base.push([3 + (i % 3), i % 4 === 0 ? 1 : 0]);
    const s1 = ap.stats(cellDe(base)), s4 = ap.stats(cellDe(base.concat(base, base, base)));
    proche(s4.se / s1.se, 0.5, 0.025, 'quatre fois les memes rencontres : l intervalle retrecit d un facteur 2 (a 5 % pres, le facteur m/(m-1))');
  }

  // =================================================================== T10
  console.log('\n-- T10. jours complets et j0 --');
  const journee = (debutJ, nJours, o) => {
    const L = [];
    const opt = o || {};
    for (let t = debutJ; t < debutJ + nJours * JOUR; t += (opt.pas || 150 * MIN)) {
      if (opt.trou && t >= opt.trou[0] && t < opt.trou[1]) continue;
      L.push(ligneM(t, opt.l || 'soccer_epl', opt.e ? opt.e(t) : [], { c: opt.c ? opt.c(t) : 120 }));
    }
    return L;
  };
  {
    const J0 = Date.UTC(2026, 9, 1, 0, 30);
    const L = journee(J0, 10);
    const S = ap.serie(L);
    eq(S.j0, '2026-10-01', 'j0 = le premier jour de journal');
    const complet = ap.completeur(S.run);
    ok(complet('2026-10-04') && complet('2026-10-08'), 'D-3..D couverts sans trou : complet');
    ok(!complet('2026-10-10'), 'le dernier jour (journal pas au-dela) : incomplet');
    ok(!complet('2026-09-30'), 'avant le journal : incomplet');
    /* sur la grille de 150 min partie de 00 h 30, retirer [03 h ; 09 h) le 06
       laisse un trou de 00 h 30 a 10 h 30 : 10 h, pas 6 h */
    const troue = journee(J0, 10, { trou: [Date.UTC(2026, 9, 6, 3), Date.UTC(2026, 9, 6, 9)] });
    const c2 = ap.completeur(ap.serie(troue).run);
    ok(c2('2026-10-05') && !c2('2026-10-06') && !c2('2026-10-09') && c2('2026-10-10') === false, 'un trou de 10 h le 06 (00 h 30 -> 10 h 30) : D = 06 a 09 incomplets');
    /* le seuil de 4 h lui-meme : un seul releve manquant laisse 5 h */
    const un = journee(J0, 10).filter((x) => x.t !== J0 + 5 * JOUR + 150 * MIN);
    const c3 = ap.completeur(ap.serie(un).run);
    ok(c3('2026-10-05') && !c3('2026-10-06'), 'un SEUL releve manque le 06 (trou de 5 h > 4 h) : le 05 complet, le 06 incomplet');
    /* un trou a cheval sur minuit se compte depuis la derniere ligne d'AVANT la fenetre */
    const minuit = journee(J0, 10).filter((x) => !(x.t > Date.UTC(2026, 9, 5, 18, 30) && x.t < Date.UTC(2026, 9, 6, 0, 30)));
    const c4 = ap.completeur(ap.serie(minuit).run);
    ok(!c4('2026-10-09') && c4('2026-10-10') === false && ap.completeur(ap.serie(journee(J0, 10)).run)('2026-10-09'),
       'trou 17 h 00 -> 00 h 30 (7 h 30) a cheval sur minuit : D = 09 (fenetre depuis le 06 00 h) incomplet, complet sans le trou');
    const L2 = journee(J0, 10, { c: (t) => (t < Date.UTC(2026, 9, 5) ? 120 : 60) });
    eq(ap.serie(L2).j0, '2026-10-05', 'la cadence change le 05 : j0 repart au 05');
    /* le regime, c'est aussi PARIS_PRIX_AVANT_TOUS (av) et l'age de vente (am) */
    const L3 = journee(J0, 10).map((x) => Object.assign(x, { av: x.t < Date.UTC(2026, 9, 4) ? 0 : 1, am: 2160 }));
    ok(ap.serie(L3).j0 === '2026-10-04' && ap.serie(L3).av === 1 && ap.serie(L3).changements === 1, 'PARIS_PRIX_AVANT_TOUS pose le 04 (av 0 -> 1) : j0 repart au 04, un changement');
    const L4 = journee(J0, 10).map((x) => Object.assign(x, { av: 1, am: x.t < Date.UTC(2026, 9, 6) ? 2160 : 1440 }));
    ok(ap.serie(L4).j0 === '2026-10-06' && ap.serie(L4).am === 1440, 'PARIS_PRIX_AGE_MAX_H change le 06 (am 2160 -> 1440) : j0 repart au 06');
    /* une rencontre d'avant j0 + 3 n'entre pas */
    const avecEv = journee(J0, 10, { e: (t) => [E('z1', Date.UTC(2026, 9, 3, 15), 'b', [0.5, 0.27, 0.23]), E('z2', Date.UTC(2026, 9, 6, 15), 'b', [0.5, 0.27, 0.23])].filter((x) => x[1] > t - 2 * H) });
    const r = ap.mesure(avecEv);
    ok(r.exclus.avantJ0 === 1 && r.joursRetenus.join(',') === '2026-10-06', 'kickoff le 03 (< j0 + 3) exclu ; le 06 retenu');
    /* un jour incomplet n'entre pas dans la mesure, meme avec des paires */
    const pk = [0.5, 0.27, 0.23];
    const troueEv = journee(J0, 10, { trou: [Date.UTC(2026, 9, 6, 3), Date.UTC(2026, 9, 6, 9)],
      e: (t) => [E('w5', Date.UTC(2026, 9, 5, 15), 'b', pk), E('w7', Date.UTC(2026, 9, 7, 15), 'b', pk)].filter((x) => x[1] > t - 2 * H) });
    const r2 = ap.mesure(troueEv);
    ok(r2.joursRetenus.join(',') === '2026-10-05' && r2.exclus.joursIncomplets === 1, 'kickoff le 07, fenetre trouee le 06 : exclu (joursIncomplets) ; le 05 retenu');
  }

  // =================================================================== T11
  console.log('\n-- T11. les verdicts, de part et d autre de chaque seuil, sans bascule --');
  {
    const d = { j0: '2026-10-10', fin: '2026-10-23', auPlusTot: '2026-10-24', prolonge: '2026-11-07' };
    const sd = (m, part, se) => ({ m, part, se, lo: part - 1.959964 * se, hi: part + 1.959964 * se, mde80: (1.959964 + 0.841621) * se });
    const releve0 = pm.releveMs(), perimes0 = imp.prixPerimes().join(',');
    eq(ap.verdictG2(sd(5000, 0.05, 0.001), d).verdict, 'trop tot', 'G2 avant j0 + 14 : trop tot, meme avec un gros echantillon');
    ok(/24/.test(ap.verdictG2(sd(5000, 0.05, 0.001), d).motif), 'le motif donne la date au plus tot');
    const d14 = Object.assign({}, d, { fin: '2026-10-24' });
    eq(ap.verdictG2(sd(149, 0.05, 0.001), d14).verdict, 'echantillon insuffisant', 'G2 a m = 149 : echantillon insuffisant');
    eq(ap.verdictG2(sd(150, 0.0101, 0.006), d14).verdict, 'oui', 'G2 a m = 150, part 1,01 % >= τ : oui');
    eq(ap.verdictG2(sd(150, 0.0099, 0.004), d14).verdict, 'oui', 'part 0,99 % mais borne basse > 0 : oui');
    /* « prolonger » et « non » se jugent sur de VRAIES cellules (ap.stats) :
       la puissance se calcule SOUS τ, plus avec l'erreur type observee, qui
       tombe a 0 avec les issues battables (relecture du lot 1 : 18 % de
       « non » sur 4 000 tirages a fuite vraie = τ, m = 150). Intention de
       l'essai : jamais « non » sans la puissance a τ avant j0 + 28. */
    const cellP = (liste) => { const c = { m: 0, n: 0, b: 0, sbb: 0, snn: 0, sbn: 0, sev: 0, nRef: 0, bRef: 0, refuses: 0, paires: 0 };
      for (const [nn, bb] of liste) { c.m++; c.n += nn; c.b += bb; c.sbb += bb * bb; c.snn += nn * nn; c.sbn += bb * nn; } return c; };
    const rep = (k, nn, bb) => Array.from({ length: k }, () => [nn, bb]);
    const pc = (x) => (x * 100).toFixed(2) + ' %';
    const d28 = Object.assign({}, d, { fin: '2026-11-07' });
    const s0 = ap.stats(cellP(rep(150, 3, 0)));
    ok(s0.se === 0 && s0.hi === 0, 'aucune issue battable sur 450 : Wald s effondre (erreur type 0, borne haute 0)');
    proche(s0.mde80, (1.959964 + 0.841621) * Math.sqrt(0.01 * 0.99 / 450), 1e-12, `effet detectable a 80 % SOUS τ : 2,801585 √(τ(1-τ)/Σn) = ${pc(s0.mde80)}`);
    eq(ap.verdictG2(s0, d14).verdict, 'prolonger', 'G2, 0 battable sur 450 a j0 + 14 : prolonger, JAMAIS non (pas la puissance a τ)');
    eq(ap.verdictG2(ap.stats(cellP(rep(2, 3, 1).concat(rep(148, 3, 0)))), d14).verdict, 'prolonger', 'G2, 2 battables sur 450 : prolonger');
    const n28 = ap.verdictG2(s0, d28);
    ok(n28.verdict === 'non' && /SANS la puissance/.test(n28.motif), 'a j0 + 28 la porte conclut, et dit qu elle conclut sans la puissance');
    const s3 = ap.stats(cellP(rep(3, 3, 1).concat(rep(297, 3, 0))));
    ok(s3.lo <= 0 && s3.part < 0.01 && s3.mde80 <= 0.01, `m = 300, 3 sur 900 : ni oui, ni faute de puissance (effet detectable ${pc(s3.mde80)} <= τ)`);
    eq(ap.verdictG2(s3, d14).verdict, 'non', 'avec la puissance a τ des j0 + 14 : non');
    const sG = ap.stats(cellP(rep(1, 3, 3).concat(rep(299, 3, 0))));
    ok(sG.deff > 1 && sG.mde80 > s3.mde80 && ap.verdictG2(sG, d14).verdict === 'prolonger',
       `les 3 battables dans UNE rencontre : effet de grappe ${sG.deff.toFixed(2)} > 1, effet detectable ${pc(sG.mde80)} > τ : prolonger`);
    proche(sG.hiExact, ap.borneHautePoisson(3 / sG.deff) / (900 / sG.deff), 1e-12, 'la borne exacte se prend sur Σb/deff et Σn/deff (taille efficace)');
    ok(sG.hiExact > ap.borneHautePoisson(3) / 900 * 1.5, `et la grappe l elargit (${pc(sG.hiExact)} contre ${pc(ap.borneHautePoisson(3) / 900)} sans elle)`);
    const g199 = ap.verdictG1(ap.stats(cellP(rep(199, 3, 0))), ap.stats(cellP(rep(400, 3, 0))), d14);
    ok(g199.verdict === 'echantillon insuffisant' && /m=199\/200/.test(g199.motif), 'G1 a m = 199 (cellule 12-13 h) : echantillon insuffisant, m=199/200');
    /* G1 lit la borne EXACTE (Poisson) pres de 0, et l'ecart ses erreurs types */
    proche(ap.borneHautePoisson(0), -Math.log(0.025), 1e-9, 'borne exacte de 0 a 97,5 % : -ln(0,025) = 3,689');
    proche(ap.borneHautePoisson(2), 7.2247, 1e-3, 'borne exacte de 2 : 7,2247 (χ² a 6 degres, 97,5 %, divise par 2)');
    const loin2 = ap.stats(cellP(rep(2, 3, 1).concat(rep(198, 3, 0)))), ref0 = ap.stats(cellP(rep(200, 3, 0)));
    ok(loin2.hi <= 0.01 && loin2.hiSur > 0.01, `2 battables sur 600 : Wald ${pc(loin2.hi)} <= τ, borne exacte ${pc(loin2.hiSur)} > τ`);
    eq(ap.verdictG1(loin2, ref0, d14).verdict, 'non', 'G1, 2 sur 600 a 12-13 h : non (Wald aurait dit equivalent)');
    const ref12 = ap.stats(cellP(rep(12, 3, 1).concat(rep(188, 3, 0))));
    const v12 = ap.verdictG1(loin2, ref12, d14);
    ok(v12.verdict === 'non' && v12.hiEcart <= 0.005, `... meme quand l ecart passe (reference a 2 %, borne haute de l ecart ${pc(v12.hiEcart)}) : c est la borne exacte de 12-13 h qui dit non`);
    const loinB = ap.stats(cellP(rep(2, 3, 1).concat(rep(398, 3, 0)))), refB = ap.stats(cellP(rep(400, 3, 0)));
    const hiEWald = loinB.part - refB.part + 1.959964 * Math.sqrt(loinB.se * loinB.se + refB.se * refB.se);
    ok(loinB.hiSur <= 0.01 && hiEWald <= 0.005, `2 sur 1 200 contre 0 : Wald passait l ecart (${pc(hiEWald)} <= τ/2)`);
    eq(ap.verdictG1(loinB, refB, d14).verdict, 'non', '... mais l ecart aux erreurs types de la borne exacte depasse τ/2 : non');
    const zero = ap.stats(cellP(rep(400, 3, 0)));
    eq(ap.verdictG1(zero, ap.stats(cellP(rep(400, 3, 0))), d14).verdict, 'oui', 'G1, 0 sur 1 200 contre 0 sur 1 200 : oui (borne exacte 0,31 %, ecart 0,43 %)');
    eq(ap.verdictG1(ap.stats(cellP(rep(9, 3, 1).concat(rep(391, 3, 0)))), refB, d14).verdict, 'non', 'G1, 9 sur 1 200 (0,75 %) a 12-13 h : non');
    const p08 = ap.stats(cellP(rep(48, 3, 1).concat(rep(1952, 3, 0))));
    const v08 = ap.verdictG1(p08, ap.stats(cellP(rep(48, 3, 1).concat(rep(1952, 3, 0)))), d14);
    ok(v08.verdict === 'non' && v08.hiEcart <= 0.005 && p08.hiSur > 0.01, `0,8 % aux deux ages (ecart nul, borne ${pc(v08.hiEcart)}) : la borne haute de 12-13 h (${pc(p08.hiSur)} > τ) dit non a elle seule`);
    const l21 = ap.stats(cellP(rep(21, 3, 1).concat(rep(1979, 3, 0)))), r3 = ap.stats(cellP(rep(3, 3, 1).concat(rep(997, 3, 0))));
    const v21 = ap.verdictG1(l21, r3, d14), seul = l21.part - r3.part + 1.959964 * l21.seSur;
    ok(v21.verdict === 'non' && seul <= 0.005 && v21.hiEcart > 0.005,
       `0,35 % contre 0,1 % : l incertitude de la REFERENCE compte (ecart haut ${pc(v21.hiEcart)} > τ/2, ${pc(seul)} sans elle) : non`);
    eq(ap.verdictG1(zero, zero, d).verdict, 'trop tot', 'G1 avant j0 + 14 : trop tot');
    eq(ap.accorde({ verdict: 'oui', motif: '' }, { verdict: 'non', motif: '' }).verdict, 'non decide', 'vente et meme source en desaccord : non decide');
    eq(ap.accorde({ verdict: 'oui', motif: 'm' }, { verdict: 'oui', motif: '' }).verdict, 'oui', 'd accord : leur verdict');
    /* sur une vraie mesure : des tranches sans 12-13 h ne decident pas G1 */
    const L = journee(Date.UTC(2026, 9, 1, 0, 30), 20, { e: (t) => [E('y' + Math.floor(t / JOUR), Math.floor(t / JOUR) * JOUR + JOUR + 15 * H, 'b', [0.5, 0.27, 0.23])] });
    const P = ap.portes(ap.mesure(L, { ages: [0, 1, 3, 6, 12, 24] }));
    eq(P.g1.verdict, 'tranches redefinies', 'tranches sans 12-13 h : G1 ne se calcule pas, il le dit');
    eq(ap.portes(ap.mesure(L)).g2.verdict, 'echantillon insuffisant', 'vingt jours de journal mais une rencontre par jour : echantillon insuffisant');
    /* la construction de G1 lit la CONCLUSION de la projection du socle
       (paris_import.projectionMois : rien avant le 7 du mois) */
    const proj = (utilise, jour) => imp.projectionMois({ vu: new Date(Date.UTC(2026, 9, jour, 12)).toISOString(), utilise }, Date.UTC(2026, 9, jour, 13));
    ok(/NE SE CONSTRUIT PAS/.test(ap.portes(ap.mesure(L), { projection: proj(3000, 10) }).g1.construction), 'projection 9 000 le 10 : G1 ne se construit pas');
    ok(/peut se construire/.test(ap.construction(proj(6000, 10))), 'projection 18 000 le 10 (concluante) : G1 peut se construire');
    const tot = ap.construction(proj(700, 1));
    ok(/pas encore concluante/.test(tot) && !/peut se construire/.test(tot), 'le 1er, 700 utilises (21 000 projetes) : pas encore concluante, G1 ne se construit pas');
    const s18 = ap.construction({ credits: 17000, depasse: false, seuil: 18000, jourDuMois: 10 });
    ok(/NE SE CONSTRUIT PAS/.test(s18) && /18000/.test(s18), 'la conclusion du socle decide, pas le chiffre (seuil du socle a 18 000, 17 000 projetes : ne se construit pas)');
    const sans = ap.construction({ credits: 21000 });
    ok(/sans la conclusion/.test(sans) && !/peut se construire/.test(sans), 'un chiffre sans la conclusion du socle (depasse) : G1 ne se construit pas');
    /* la moyenne ponderee par le temps sur 0-12 h 30 (rapportee pour G1) */
    const rM = { serie: { j0: '2026-10-01', dernier: Date.parse('2026-10-16T12:00:00Z') }, tranches: ['0-1h', '1-3h', '3-6h', '6-12h', '12-13h', '13-36h'], cellules: {} };
    const bat = [0, 1, 2, 4, 8];
    ['0-1h', '1-3h', '3-6h', '6-12h', '12-13h'].forEach((a, i) => { rM.cellules['tous|vente|1n2|' + a + '|48h+'] = cellP(rep(bat[i], 3, 1).concat(rep(100 - bat[i], 3, 0))); });
    proche(ap.moyenneTemps(rM, 'vente', '48h+', 12.5).part, (1 * 0 + 2 * 1 + 3 * 2 + 6 * 4 + 0.5 * 8) / 300 / 12.5, 1e-12,
           'moyenne ponderee par le temps : (1 p0-1 + 2 p1-3 + 3 p3-6 + 6 p6-12 + 0,5 p12-13) / 12,5');
    const pM = ap.portes(rM);
    ok(pM.moyenneG1 && Math.abs(pM.moyenneG1.part - 36 / 3750) < 1e-12 && pM.moyenneG1.heures === 12.5, 'portes() la rapporte pour G1, a 12 h 30 (12 h + le tic de 30 min)');
    ok(ap.moyenneTemps({ tranches: ['1-3h', '3-6h', '6-12h', '12-13h'], cellules: rM.cellules }, 'vente', '48h+', 12.5).part === null, 'des tranches qui ne couvrent pas 0-1 h : n/a');
    rM.cellules['tous|vente|1n2|6-12h|48h+'] = cellP(rep(29, 3, 0));
    ok(ap.moyenneTemps(rM, 'vente', '48h+', 12.5).part === null, 'une tranche a 29 rencontres : n/a');
    eq(pm.releveMs(), releve0, 'quel que soit le verdict, releveMs inchange');
    eq(imp.prixPerimes().join(','), perimes0, 'prixPerimes inchange');
    ok(process.env.PARIS_PRIX_RELEVE_LOIN_H === undefined && process.env.PARIS_PRIX_RELEVE_PRES_MIN === undefined, 'aucune variable du lot B posee');
  }

  // =================================================================== T12
  console.log('\n-- T12. retraits, cadence reelle, mises --');
  {
    const D1 = T + 30 * H;
    const run = [ligneM(T, 'soccer_epl', [E('r1', D1, 'b', [0.5, 0.27, 0.23]), E('r2', D1, 'p', [0.4, 0.3, 0.3]), E('r3', D1, 'b', [0.3, 0.3, 0.4])]),
                 ligneM(T + 150 * MIN, 'soccer_epl', [E('r1', D1, 'x'), E('r3', D1, 'b', [0.3, 0.3, 0.4])]),
                 ligneM(T + 300 * MIN, 'soccer_epl', [], { n: 0 }),
                 ligneM(T + 425 * MIN, 'soccer_epl', [E('r3', D1, 'b', [0.3, 0.3, 0.4])])];
    const r = ap.retraits(run);
    const x = r['24-48h'];
    ok(x.retirees === 1 && x.absentes === 1, 'r1 retire (x), r2 absente : deux retraits au delai 24-48 h');
    eq(x.suivies, 3, 'trois suivis (r1, r2, r3) ; la reponse vide qui suit ne retire rien');
    eq(x.dureeMedianeMin, 150, 'p(k) s est vendu 150 min avant l effacement');
    const cd = ap.cadence(run);
    ok(cd.n === 3 && cd.medianeMin === 150 && cd.histo.find((h) => h.de === 150).n === 2 && cd.histo.find((h) => h.de === 120).n === 1,
       'cadence reelle : ecarts 150, 150, 125 min, mediane 150, histogramme par quart d heure');
    const tickets = [{ t: T, mise: 1000, jambes: [{ debut: new Date(T + H).toISOString() }, { debut: T + 50 * H }] }];
    let m = ap.mises(tickets);
    ok(m.jambes === 2 && m.parDelai['<3h'].part === null && !m.assez, 'deux jambes : aucune part affichee (sous 30)');
    const beaucoup = [];
    for (let i = 0; i < 30; i++) beaucoup.push({ t: T, mise: 100, jambes: [{ debut: T + (i < 10 ? H : 30 * H) }] });
    m = ap.mises(beaucoup);
    proche(m.parDelai['<3h'].part, 1 / 3, 1e-9, 'trente jambes : un tiers des mises a moins de 3 h');
  }

  // =================================================================== T13
  console.log('\n-- T13. l etat, la route, aucune cle --');
  {
    const e = imp.etatImport().journalPrix;
    ok(e && e.actif === true && e.fichiers >= 1 && e.lignes >= 5 && e.lignesParQuoi.periodique >= 2 && e.joursGardes === 30,
       `etatImport().journalPrix : ${e.fichiers} fichier(s), ${e.lignes} ligne(s), par cause ${JSON.stringify(e.lignesParQuoi)}`);
    ok(e.lignesParQuoi.avant >= 1 && e.lignesParQuoi.demande >= 1 && e.lignesParQuoi.etalonnage >= 1, 'les causes avant, demande, etalonnage s y lisent');
    const s = JSON.stringify(imp.etatImport());
    ok(!s.includes(CLE_BANC) && !/apiKey/.test(s), 'etatImport ne contient ni la cle ni apiKey');
    for (const j of ['../x', '2026-1-1', '', '2026-02-30', '2026-10-10/../../x', null]) ok(leve(() => pj.litJourBrut(j)) instanceof TypeError, `litJourBrut(${JSON.stringify(j)}) refuse`);
    eq(pj.litJourBrut('2000-01-01'), null, 'un jour absent : null');
    eq(pj.reponseJour('../x').code, 400, 'route : jour mal ecrit, 400');
    eq(pj.reponseJour(null).code, 400, 'route : sans jour, 400');
    eq(pj.reponseJour('2000-01-01').code, 404, 'route : jour absent, 404');
    const r = pj.reponseJour(aujourdhui());
    ok(r.code === 200 && /x-ndjson/.test(r.type) && r.corps === fs.readFileSync(path.join(pj.dossier(), aujourdhui() + '.jsonl'), 'utf8'), 'route : le fichier du jour, tel quel, en ndjson');
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    ok(/if \(path === '\/paris\/journal-prix'\) \{\s*\n\s*if \(!authed\) return refuse\(req, res, false\);\s*\n\s*rate\(req, true\);/.test(src),
       'server.js : la route commence par la garde admin (authed, sinon refuse)');
    ok(/prixJournal\.reponseJour\(/.test(src.slice(src.indexOf("path === '/paris/journal-prix'"))), 'et passe par reponseJour (validation du jour avant le disque)');
    ok(/'\/paris\/journal-prix\?jour=/.test(fs.readFileSync(path.join(__dirname, 'acces.test.js'), 'utf8')), 'acces.test.js la compte parmi les portes privees');
    ok(/prixJournal\.branche\(\)/.test(fs.readFileSync(path.join(__dirname, 'paris_import.js'), 'utf8')), 'paris_import branche le journal (sinon T1 et T2 tombent aussi)');
  }

  // =================================================================== T14
  console.log('\n-- T14. l index de cloture --');
  {
    const F = pj.fichierClotures();
    const T14 = Date.now();
    const deb = T14 + 3 * H;
    const lc = (t, e) => ({ v: 1, m: 'h2h', t, l: 'soccer_epl', q: 'avant', c: 120, n: e.length, e });
    const P = (x) => [x, 0.3, 0.7 - x];
    const lis = () => JSON.parse(fs.readFileSync(F, 'utf8'));
    const tmps = () => fs.readdirSync(path.dirname(F)).filter((f) => f.startsWith(path.basename(F) + '.') && f.endsWith('.tmp'));
    /* la retention : CLOTURE_JOURS = 7 jours apres le coup d'envoi (le cout
       de la relecture entiere a chaque releve, banc de l'en-tete) */
    pj.majClotures(lc(T14 - 9 * JOUR, [E('c2', T14 - 8 * JOUR, 'b', P(0.4)), E('c3', T14 - 6 * JOUR, 'b', P(0.4))]));
    ok(lis().ev.c2 && lis().ev.c3, 'deux rencontres vues la veille de leur coup d envoi, il y a 8 et 6 jours');
    pj.majClotures(lc(T14, [E('c1', deb, 'b', P(0.4))]));
    let idx = lis();
    ok(idx.ev.c1 && idx.ev.c1.d[0] === T14 && idx.ev.c1.a === null, 'premiere observation : derniere = elle, avant-derniere vide');
    ok(!idx.ev.c2 && idx.ev.c3, 'au releve suivant, la rencontre de plus de 7 jours sort de l index, celle de 6 jours reste');
    pj.majClotures(lc(T14 + 2 * H, [E('c1', deb, 'b', P(0.45))]));
    idx = lis();
    ok(idx.ev.c1.d[0] === T14 + 2 * H && idx.ev.c1.a[0] === T14 && idx.ev.c1.d[1] === 'avant' && idx.ev.c1.d[2] === 'b', 'la suivante : derniere et avant-derniere, avec cause et reference');
    pj.majClotures(lc(deb - 4 * MIN, [E('c1', deb, 'b', P(0.5))]));
    eq(lis().ev.c1.d[0], T14 + 2 * H, 'a 4 min du coup d envoi : pas une observation d avant-match (> 5 min exige)');
    pj.majClotures(lc(T14 + H, [E('c1', deb, 'b', P(0.42))]));
    idx = lis();
    ok(idx.ev.c1.d[0] === T14 + 2 * H && idx.ev.c1.a[0] === T14 + H, 'une ligne arrivee en retard prend la place de l avant-derniere si elle est plus recente');
    eq(tmps().length, 0, 'ecrit en deux temps : aucun temporaire ne reste');
    /* o, un match deplace, une autre version */
    pj.majClotures(Object.assign(lc(T14 + 170 * MIN, [E('k1', T14 + 5 * H, 'b', P(0.4))]), { l: 'soccer_obs', o: 1 }));
    eq(lis().ev.k1 && lis().ev.k1.o, 1, 'o = 1 pour un championnat observe');
    pj.majClotures(Object.assign(lc(T14 + 175 * MIN, [E('k1', T14 + 29 * H, 'b', P(0.41))]), { l: 'soccer_obs', o: 1 }));
    eq(lis().ev.k1.debut, T14 + 29 * H, 'un match deplace prend son nouveau coup d envoi (celui qui sert a la purge)');
    idx = lis(); idx.v = 0; idx.ev.vieux = { l: 'x', debut: T14 + H, d: [T14, 'avant'], a: null };
    fs.writeFileSync(F, JSON.stringify(idx));
    pj.majClotures(lc(T14 + 178 * MIN, [E('k2', T14 + 9 * H, 'b', P(0.4))]));
    ok(lis().v === 1 && !lis().ev.vieux && lis().ev.k2, 'un index d une autre version est refait');
    const tel = fs.readFileSync(F, 'utf8');
    eq(pj.majClotures({ v: 1, t: NaN, l: 'soccer_epl', q: 'avant', e: [] }), false, 'une ligne sans date est refusee...');
    eq(fs.readFileSync(F, 'utf8'), tel, '...et n efface rien de l index');
    /* le temporaire est celui du PROCESSUS : celui d'un autre (redeploiement)
       ne bloque rien ; le sien impossible, l'ecriture echoue sans lever */
    const autre = F + '.1.tmp';
    fs.mkdirSync(autre);
    try { ok(pj.majClotures(lc(T14 + 179 * MIN, [E('k2', T14 + 9 * H, 'b', P(0.43))])) === true, 'le temporaire d un autre processus ne gene pas l ecriture'); } finally { fs.rmdirSync(autre); }
    const avant = fs.readFileSync(F, 'utf8'), e0 = pj.etat().echecs.clotures;
    fs.mkdirSync(F + '.' + process.pid + '.tmp');
    try { eq(pj.majClotures(lc(T14 + 180 * MIN, [E('c1', deb + H, 'b', P(0.6))])), false, 'son propre temporaire impossible : rend faux, sans lever'); } finally { fs.rmdirSync(F + '.' + process.pid + '.tmp'); }
    eq(fs.readFileSync(F, 'utf8'), avant, 'l ancien index reste entier');
    eq(pj.etat().echecs.clotures - e0, 1, 'et l echec est compte');
    /* refait depuis le journal : cloturesDe(lignes) = le fichier ecrit ligne
       a ligne (une ligne en retard et un observe compris) */
    fs.rmSync(F);
    const Lc = [lc(T14 - 2 * H, [E('r1', T14 + 20 * H, 'b', P(0.4)), E('r2', T14 + 50 * H, 'p', P(0.3))]),
                lc(T14, [E('r1', T14 + 20 * H, 'm', P(0.41)), E('r3', T14 + 6 * MIN, 'b', P(0.5))]),
                Object.assign(lc(T14 + 30 * MIN, [E('r4', T14 + 30 * H, 'b', P(0.35))]), { o: 1, l: 'soccer_obs' }),
                lc(T14 + 2 * H, [E('r1', T14 + 20 * H, 'b', P(0.42)), E('r2', T14 + 50 * H, 'x')]),
                lc(T14 + H, [E('r1', T14 + 20 * H, 'b', P(0.43))]),
                lc(T14 + 3 * H, [E('r2', T14 + 52 * H, 'p', P(0.31)), E('r3', T14 + 6 * MIN, 'b', P(0.5))])];
    for (const x of Lc) pj.majClotures(x);
    const refait = pj.cloturesDe(Lc);
    eq(JSON.stringify({ v: refait.v, ev: refait.ev }), JSON.stringify({ v: lis().v, ev: lis().ev }), 'cloturesDe(lignes du journal) = l index ecrit releve par releve');
    ok(Object.keys(refait.ev).length === 4 && refait.ev.r1.a[0] === T14 + H && refait.ev.r2.debut === T14 + 52 * H, 'r1 (ligne en retard), r2 (deplace, retiree puis revue), r3, r4 (observe)');
    fs.writeFileSync(F, '{"v":1,"ev":{"c1"');
    const dits = await capture(async () => { pj.majClotures(lc(T14 + 160 * MIN, [E('c9', deb, 'b', P(0.4))])); });
    ok(lis().ev.c9 && dits.some((s) => /index de cloture illisible/.test(s)), 'un index illisible est refait et la chose est dite');
  }

  // =================================================================== T15
  console.log('\n-- T15. la ligne du panneau d administration --');
  {
    process.env.RPC_URL = process.env.RPC_URL || '';
    const admin = require('./admin');
    const page = admin.page('jeton');
    const debut = page.indexOf('var JP_CAUSES='), fin = page.indexOf('\n}\n', page.indexOf('function jpRend('));
    ok(debut > 0 && fin > debut, 'la page porte jpRend');
    const bac = { esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
                  fmt: (v) => { const x = parseFloat(v || '0'); return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(2); } };
    vm.createContext(bac);
    /* num et ent, ceux de la page (les comptes ne passent pas par fmt) */
    for (const nom of ['function num(', 'function ent(']) { const i = page.indexOf(nom); vm.runInContext(page.slice(i, page.indexOf('\n', i)), bac); }
    vm.runInContext(page.slice(debut, fin + 2), bac);
    const e = pj.etat();
    const html = bac.jpRend(e);
    ok(/Price-age journal \(0 credits, read-only\)/.test(html) && /periodic \d/.test(html) && /pre-kickoff \d/.test(html) && /on request \d/.test(html),
       'en anglais : fichiers, octets, lignes par cause');
    ok(!/%/.test(html) && !/verdict:|\b(yes|no)\b/i.test(html.replace(/no rate or verdict/, '')), 'aucune part ni verdict affiche');
    const gros = bac.jpRend(Object.assign({}, e, { fichiers: 30, joursGardes: 30, lignes: 1249, lignesParQuoi: { periodique: 1100, avant: 149 }, illisibles: 3 }));
    ok(!/\.00\b/.test(gros) && /<b>1,249<\/b> paid fetch/.test(gros) && /periodic 1,100/.test(gros) && /kept 30 days/.test(gros) && !/1\.2k/.test(gros),
       'des comptes entiers : 1,249 (ni « 1.2k » ni « .00 »)');
    const piege = bac.jpRend(Object.assign({}, e, { lignesParQuoi: { '<i>x': 1 }, echecs: { journal: 1 }, dernierEchec: { quoi: '<b>q', message: '<img src=x onerror=1>' } }));
    ok(!/<img/.test(piege) && !/<i>x/.test(piege) && !/<b>q/.test(piege) && /&lt;img/.test(piege), 'cause et message d echec echappes');
    ok(/impbad/.test(bac.jpRend(Object.assign({}, e, { echecs: { journal: 2 }, dernierEchec: { quoi: 'journal', message: 'ENOSPC' } }))), 'un echec se voit');
    ok(/OFF/.test(bac.jpRend(Object.assign({}, e, { actif: false }))), 'coupe : OFF');
    eq(bac.jpRend(undefined), '', 'un serveur d avant le lot : rien');
    /* et la ligne est bien dans la carte : impRend sur le VRAI etatImport */
    const dImp = page.indexOf('function impRend(e){'), fImp = page.indexOf('\n}\n', dImp);
    let rendu = '';
    bac.$ = () => ({ set innerHTML(v) { rendu = v; } });
    vm.runInContext(page.slice(dImp, fImp + 2), bac);
    bac.impRend(JSON.parse(JSON.stringify(imp.etatImport())));
    ok(/Price-age journal \(0 credits, read-only\)/.test(rendu), 'impRend(etatImport()) affiche la ligne du journal dans la carte du calendrier');
    const blocs = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    ok(blocs.every((b) => { try { new Function(b); return true; } catch (er) { return false; } }), 'le script de la page compile');
  }

  // =================================================================== T16
  console.log('\n-- T16. --telecharge --');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-t16-'));
    fs.writeFileSync(path.join(dir, '2026-10-08.jsonl'), 'deja la\n');
    const vus = [];
    const faux = async (url, o) => {
      vus.push({ url: String(url), cle: o && o.headers && o.headers['x-admin-key'] });
      const u = new URL(String(url));
      const rep = (corps, type) => ({ ok: true, status: 200, json: async () => corps, text: async () => (typeof corps === 'string' ? corps : JSON.stringify(corps)) });
      if (u.pathname === '/paris/import') return rep({ journalPrix: { jours: [{ jour: '2026-10-08' }, { jour: '2026-10-09' }, { jour: '2026-10-10' }, { jour: '../x' }] }, quota: { projection: { credits: 7000 } } });
      if (u.pathname === '/paris/journal-prix') return rep('{"v":1,"jour":"' + u.searchParams.get('jour') + '"}\n');
      if (u.pathname === '/paris/liste') return rep({ paris: [{ id: 'b1', addr: '0x' + 'a'.repeat(40), nom: 'Alice', t: 1, mise: 5, jambes: [{ debut: 'x', match: 'm', choix: '1' }] }], encore: false });
      return { ok: false, status: 404 };
    };
    const fait = await ap.telecharge({ base: 'https://exemple.invalid/', cle: 'CLE-SECRETE-T16', dossier: dir, aujourdhui: '2026-10-10', fetch: faux });
    eq(fait.jours.join(','), '2026-10-09', 'seul le jour passe absent est fige (08 deja la, 10 en cours, ../x refuse)');
    ok(!vus.some((v) => /jour=\.\./.test(v.url) || /jour=2026-10-(08|10)/.test(v.url)), 'aucune demande pour ../x, ni pour le jour deja fige ou en cours');
    ok(fait.deja === 1 && fait.aujourdhui === 1, 'un jour deja la (08), un en cours (10) : ../x n est meme pas cherche sur le disque');
    ok(vus.every((v) => v.cle === 'CLE-SECRETE-T16' && !v.url.includes('CLE-SECRETE')), 'la cle part dans l en-tete, jamais dans l adresse');
    const ecrit = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    ok(!ecrit.includes('CLE-SECRETE'), 'aucun fichier ecrit ne contient la cle');
    ok(!ecrit.includes('0xaaaa') && !ecrit.includes('Alice'), 'les paris figes ne portent ni adresse ni nom');
    eq(JSON.parse(fs.readFileSync(path.join(dir, 'etat.json'), 'utf8')).projection.credits, 7000, 'la projection du mois est figee avec l etat');
    fs.rmSync(dir, { recursive: true, force: true });
    /* une reponse en erreur n'est JAMAIS figee : le jour serait tenu pour
       telecharge (existsSync) et perdu a la purge des 30 jours */
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-t16b-'));
    const panne = async (url) => {
      const u = new URL(String(url));
      if (u.pathname === '/paris/import') return { ok: true, status: 200, json: async () => ({ journalPrix: { jours: [{ jour: '2026-10-09' }] } }) };
      return { ok: false, status: 500, json: async () => ({ error: 'x' }), text: async () => '{"error":"journal unreadable"}' };
    };
    let rejet = null;
    await ap.telecharge({ base: 'https://exemple.invalid', cle: 'k', dossier: dir2, aujourdhui: '2026-10-10', fetch: panne }).catch((er) => { rejet = er; });
    ok(rejet && /HTTP 500/.test(rejet.message) && !fs.existsSync(path.join(dir2, '2026-10-09.jsonl')) && !fs.readdirSync(dir2).some((f) => /\.tmp$/.test(f)),
       'HTTP 500 : erreur, et le jour n est PAS fige (il sera retente)');
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // =================================================================== T17
  console.log('\n-- T17. le tic de 10 min tel que planifie le pose --');
  {
    poseQuota(20000, 0);
    await imp.importeMatchs(); paris.charge();
    const vieillit = (ms) => { const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')); c.ligues.soccer_epl = Date.now() - ms; fs.writeFileSync(pm.fichier(), JSON.stringify(c)); };
    const vST = global.setTimeout, vSI = global.setInterval;
    const poses = [];
    let ctl = null, avantDecalage = -1;
    global.setTimeout = (f, ms) => { poses.push({ type: 't', f, ms }); return { faux: 1 }; };
    global.setInterval = (f, ms) => { poses.push({ type: 'i', f, ms }); return { faux: 1 }; };
    try {
      await capture(async () => { ctl = imp.planifie(() => {}, () => false); });
      avantDecalage = poses.filter((p) => p.type === 'i' && p.f === ctl.avantMatch).length;
      /* les rappels de 5 min (sauf la releve des scores) : c'est l'un d'eux qui pose le tic */
      for (const p of poses.slice()) if (p.type === 't' && p.ms === 5 * MIN && p.f !== ctl.releve) p.f();
    } finally { global.setTimeout = vST; global.setInterval = vSI; }
    try {
      const tic = poses.filter((p) => p.type === 'i' && p.f === ctl.avantMatch);
      ok(avantDecalage === 0 && tic.length === 1, 'planifie pose UNE minuterie avantMatch, par le rappel decale de 5 min');
      eq(tic[0].ms, 10 * MIN, 'elle bat toutes les 10 min (cadence inchangee)');
      ok(poses.some((p) => p.type === 'i' && p.ms === 30 * MIN), 'la releve periodique bat toujours toutes les 30 min');
      const m = paris.catalogue().matchs.find((x) => x.source && x.source.evenement === 'a1');
      ok(!!m, 'Arsenal–Ipswich (a1) est au calendrier');
      vieillit(10 * MIN);
      paris.demandePrix(m);
      appels.length = 0;
      await ctl.avantMatch();
      eq(appels.filter((a) => a.quoi === 'odds').length, 0, 'une demande sur un prix de 10 min : AUCUN credit (PRIX_DEMANDE_MS, 1 h)');
      eq(paris.prixDemandes().length, 0, 'et la demande est consommee, comme avant');
      vieillit(2 * H);
      paris.demandePrix(m);
      appels.length = 0;
      const n0 = toutes().length;
      await ctl.avantMatch();
      eq(appels.filter((a) => a.quoi === 'odds').length, 1, 'sur un prix de 2 h : un credit');
      eq(toutes().slice(n0).map((x) => x.q).join(','), 'demande', 'une ligne, de cause demande');
      eq(appels.filter((a) => a.quoi === 'events').length, 2, 'un vendu releve : le calendrier refait, une fois');
      appels.length = 0;
      await ctl.avantMatch();
      eq(appels.length, 0, 'rien a relever : aucun appel, ni /odds ni calendrier');
      const vrai = paris.prixDemandes, vErr = console.error;
      paris.prixDemandes = () => { throw new Error('panne essai'); };
      console.error = () => {};
      let rejet = null;
      try { await ctl.avantMatch().catch((e) => { rejet = e; }); } finally { paris.prixDemandes = vrai; console.error = vErr; }
      eq(rejet, null, 'une exception dans le tic est enfermee (sur) : la promesse d une minuterie ne rejette jamais');
    } finally { if (ctl) ctl.arrete(); }
  }

  // =================================================================== T18
  console.log('\n-- T18. les champs et reglages du journal, cote serveur --');
  {
    poseQuota(20000, 0);
    const c0 = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')); c0.ligues.soccer_epl = Date.now() - 3 * H; fs.writeFileSync(pm.fichier(), JSON.stringify(c0));
    /* ko : le carnet n'a pas pu etre ecrit (le prix vendu n'a pas change) */
    const tmpCarnet = pm.fichier() + '.tmp';
    fs.mkdirSync(tmpCarnet);
    try { await capture(() => imp.rafraichitPrix(['soccer_epl'], 'periodique', 0)); } finally { fs.rmdirSync(tmpCarnet); }
    let L = toutes();
    eq(L[L.length - 1].ko, 1, 'carnet impossible a ecrire : la ligne porte ko = 1');
    await imp.rafraichitPrix(['soccer_epl'], 'periodique', 0);
    L = toutes();
    ok(!('ko' in L[L.length - 1]), 'carnet ecrit : pas de ko');
    /* le regime suit l'environnement */
    const T18 = Date.now();
    const P5 = { 1: 0.5, N: 0.27, 2: 0.23 };
    const fait = { t: T18, ligue: 'soccer_epl', quoi: 'essai', ecrit: true, evs: [], refs: [
      { id: 'h1', debut: T18 + 7.5 * JOUR, ref: 'betfair', p: P5, livres: 4 }, { id: 'h2', debut: T18 + 8.5 * JOUR, ref: 'betfair', p: P5, livres: 4 }] };
    process.env.PARIS_PRIX_RELEVE_H = '3';
    try { eq(pj.ligneDe(fait).c, 180, 'PARIS_PRIX_RELEVE_H=3 : c = 180'); } finally { process.env.PARIS_PRIX_RELEVE_H = '2'; }
    process.env.PARIS_PRIX_AVANT_TOUS = '1';
    try { eq(pj.ligneDe(fait).av, 1, 'PARIS_PRIX_AVANT_TOUS=1 : av = 1'); } finally { delete process.env.PARIS_PRIX_AVANT_TOUS; }
    process.env.PARIS_PRIX_AVANT_TOUS = 'oui';
    try { eq(pj.ligneDe(fait).av, 0, 'une autre valeur que 1 : av = 0, le meme test que prixAvantMatch'); } finally { delete process.env.PARIS_PRIX_AVANT_TOUS; }
    const enfant = execFileSync(process.execPath, ['-e', "const pj=require('./prix_journal');process.stdout.write(JSON.stringify(pj.ligneDe({t:1,ligue:'x',quoi:'q',refs:[],evs:[]})))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { PARIS_PRIX_AGE_MAX_H: '24' }), encoding: 'utf8' });
    eq(JSON.parse(enfant).am, 1440, 'PARIS_PRIX_AGE_MAX_H=24 (lu au demarrage) : am = 1440');
    eq(pj.ligneDe(fait).e.map((x) => x[0]).join(','), 'h1', 'horizon 7 + 1 j : 7,5 j garde, 8,5 j filtre');
    process.env.ODDS_API_HORIZON = 'abc';
    try { eq(pj.horizonMs(), 8 * JOUR, 'ODDS_API_HORIZON illisible : 7 + 1 j'); } finally { process.env.ODDS_API_HORIZON = '7'; }
    for (const v of ['0', '-5']) {
      process.env.PARIS_PRIX_JOURNAL_J = v;
      try { eq(pj.joursGardes(), 30, `PARIS_PRIX_JOURNAL_J=${v} : le defaut 30`); } finally { delete process.env.PARIS_PRIX_JOURNAL_J; }
    }
    /* le compte du jour suit le fichier (taille, date) : jamais fige en memoire */
    const e0 = pj.etat();
    ok(pj.ecrit({ v: 1, m: 'h2h', t: Date.now(), l: 'soccer_borne', q: 'essai-cache', c: 120, n: 0, o: 1, e: [] }), 'une ligne ajoutee au jour');
    const e1 = pj.etat();
    ok(e1.lignes === e0.lignes + 1 && e1.lignesParQuoi['essai-cache'] === 1, 'etat() la compte aussitot');
    const fj = path.join(pj.dossier(), aujourdhui() + '.jsonl');
    fs.writeFileSync(fj, fs.readFileSync(fj, 'utf8').split('\n').filter((s) => s && !s.includes('soccer_borne')).join('\n') + '\n');
    /* les sources : last_update du MARCHE, et seulement d'une source saine */
    const es = ev('s1', 'Dom', 'Ext', DEMAIN);
    const bk = (key, a, b, c, lu, luM) => ({ key, last_update: lu, markets: [{ key: 'h2h', last_update: luM, outcomes: [
      { name: 'Dom', price: a }, { name: 'Draw', price: b }, { name: 'Ext', price: c }] }] });
    const s = pj.sourcesDe(Object.assign({}, es, { bookmakers: [bk('betfair_ex_eu', 2.0, 3.6, 4.4, '2026-10-10T08:00:00Z', '2026-10-10T09:30:00Z'),
      bk('pinnacle', 1.5, 3.0, 4.0, '2026-10-10T08:00:00Z', '2026-10-10T08:00:00Z')] }));
    eq(s.luB, Date.parse('2026-10-10T09:30:00Z'), 'luB : last_update du marche h2h, pas celui du livre');
    ok(s.b && s.p === null && s.luP === null, 'Pinnacle insain (somme des inverses 1,25) : ni prix ni last_update');
    /* la purge : un vieux jour du journal, jamais un fichier etranger */
    fs.writeFileSync(path.join(pj.dossier(), 'notes.txt'), 'a garder');
    fs.writeFileSync(path.join(pj.dossier(), '2000-01-01.jsonl'), '');
    const futur = Date.now() + 2 * JOUR;
    pj.ecrit({ v: 1, m: 'h2h', t: futur, l: 'soccer_borne', q: 'essai', c: 120, n: 0, o: 1, e: [] });
    ok(!fs.existsSync(path.join(pj.dossier(), '2000-01-01.jsonl')) && fs.existsSync(path.join(pj.dossier(), 'notes.txt')),
       'la purge efface un vieux jour du journal, pas un fichier etranger');
    fs.rmSync(path.join(pj.dossier(), 'notes.txt'));
    fs.rmSync(path.join(pj.dossier(), pj.jourDe(futur) + '.jsonl'));
    /* une exception de ligneDe est comptee, jamais levee */
    const vraiR = pm.releveMs;
    const j0 = pj.etat().echecs.journal;
    let leve = null;
    pm.releveMs = () => { throw new Error('panne essai'); };
    try { await capture(async () => { try { pj.journalDesPrix(fait); } catch (er) { leve = er; } }); } finally { pm.releveMs = vraiR; }
    ok(leve === null && pj.etat().echecs.journal === j0 + 1, 'ligneDe qui leve : compte dans echecs.journal, rien ne remonte vers note');
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const iR = src.indexOf("path === '/paris/journal-prix'");
    ok(/'cache-control': 'no-store'/.test(src.slice(iR, src.indexOf('\n  }\n', iR))), 'la route admin ne se met jamais en cache (no-store)');
  }

  // =================================================================== T19
  console.log('\n-- T19. la mesure de bout en bout --');
  {
    const PK = [0.5, 0.27, 0.23], PJ = [0.56, 0.24, 0.20];
    const D0 = T + 30 * H;
    const base = [ligneM(T, 'soccer_epl', [E('x1', D0, 'b', PK)]), ligneM(T + 2 * H, 'soccer_epl', [E('x1', D0, 'b', PJ)])];
    const ref = JSON.stringify(ap.mesure(base, { sansFiltreJours: true }).cellules);
    eq(JSON.stringify(ap.mesure(base.concat([ligneM(T + H, 'soccer_epl', [E('x1', D0, 'b', PJ)], { m: 'totals' })]), { sansFiltreJours: true }).cellules), ref, 'une ligne m = totals ne touche pas la mesure h2h');
    eq(JSON.stringify(ap.mesure(base.concat([ligneM(T + H, 'soccer_epl', [E('x1', D0, 'b', PJ)], { v: 2 })]), { sansFiltreJours: true }).cellules), ref, 'une ligne v = 2 non plus');
    /* l'intervalle de bout en bout : la grappe est la RENCONTRE */
    const suites = { A: [PK, PJ, PK, PJ], B: [PK, PJ], C: [PK, PK] };
    const Lm = [];
    for (let i = 0; i < 4; i++) {
      const e = [];
      for (const [id, sx] of Object.entries(suites)) if (i < sx.length) e.push(E(id, D0, 'b', sx[i]));
      Lm.push(ligneM(T + i * 2 * H, 'soccer_epl', e));
    }
    const attendu = { m: 0, n: 0, b: 0, sbb: 0, snn: 0, sbn: 0 };
    let bMax = 0;
    for (const sx of Object.values(suites)) {
      let nn = 0, bb = 0;
      for (let i = 1; i < sx.length; i++) { const r = ap.juge(ap.cotesVendues(sx[i - 1]), sx[i])['1n2']; nn += r.n; bb += r.b; }
      attendu.m++; attendu.n += nn; attendu.b += bb; attendu.sbb += bb * bb; attendu.snn += nn * nn; attendu.sbn += bb * nn;
      bMax = Math.max(bMax, bb);
    }
    ok(bMax >= 2, `une rencontre a ${bMax} issues battables (sinon Σb² = Σb ne distinguerait rien)`);
    const rm = ap.mesure(Lm, { sansFiltreJours: true });
    const cm = rm.cellules['tous|vente|1n2|1-3h|24-48h'];
    eq(JSON.stringify({ m: cm.m, n: cm.n, b: cm.b, sbb: cm.sbb, snn: cm.snn, sbn: cm.sbn }), JSON.stringify(attendu), 'sommes par RENCONTRE : m, n, b, Σb², Σn², Σbn');
    const st = ap.stats(cm);
    ok(st.se > 0, 'erreur type non nulle');
    proche(st.lo, st.part - 1.959964 * st.se, 1e-12, 'borne basse = part - 1,959964 se');
    proche(st.hi, st.part + 1.959964 * st.se, 1e-12, 'borne haute = part + 1,959964 se');
    const deff = Math.max(1, st.se * st.se * st.n / (st.part * (1 - st.part)));
    proche(st.mde80, (1.959964 + 0.841621) * Math.sqrt(0.01 * 0.99 * deff / st.n), 1e-12, 'effet detectable a 80 % = 2,801585 √(τ(1-τ) deff / Σn), sous τ');
    ok(st.hiSur >= st.hi && st.hiSur >= st.hiExact, 'la borne haute de G1 est la plus prudente de Wald et de l exacte');
    ok(rm.cellules['grands|vente|1n2|1-3h|24-48h'] && rm.cellules['grands|vente|1n2|1-3h|24-48h'].m === 3, 'EPL : rangee dans le groupe des six grands');
    /* les seuils des verdicts */
    const sd = (m, part, se) => ({ m, part, se, lo: part - 1.959964 * se, hi: part + 1.959964 * se, mde80: 0 });
    const d14 = { j0: '2026-10-10', fin: '2026-10-24', auPlusTot: '2026-10-24', prolonge: '2026-11-07' };
    eq(ap.verdictG2(sd(150, 3 / 300, 0.006), d14).verdict, 'oui', 'G2 : part = τ exactement (3/300) : oui');
    const cP = (k) => { const x = { m: 0, n: 0, b: 0, sbb: 0, snn: 0, sbn: 0, sev: 0, nRef: 0, bRef: 0, refuses: 0, paires: 0 }; for (let i = 0; i < k; i++) { x.m++; x.n += 3; x.snn += 9; } return x; };
    const r199 = ap.verdictG1(ap.stats(cP(400)), ap.stats(cP(199)), d14);
    ok(r199.verdict === 'echantillon insuffisant' && /m=199\/200/.test(r199.motif), 'G1 : 199 rencontres dans la reference 1-3 h : insuffisant (m=199/200)');
    /* portes() : les bonnes cellules, vente contre meme source, les dates */
    const cellP = (liste) => { const x = { m: 0, n: 0, b: 0, sbb: 0, snn: 0, sbn: 0, sev: 0, nRef: 0, bRef: 0, refuses: 0, paires: 0 };
      for (const [nn, bb] of liste) { x.m++; x.n += nn; x.b += bb; x.sbb += bb * bb; x.snn += nn * nn; x.sbn += bb * nn; } return x; };
    const rep = (k, nn, bb) => Array.from({ length: k }, () => [nn, bb]);
    const cellules = {
      'tous|vente|1n2|1-3h|<3h': cellP(rep(9, 3, 1).concat(rep(191, 3, 0))),
      'tous|source|1n2|1-3h|<3h': cellP(rep(300, 3, 0)),
      'tous|vente|1n2|12-13h|48h+': cellP(rep(500, 3, 0)), 'tous|vente|1n2|1-3h|48h+': cellP(rep(500, 3, 0)),
      'tous|source|1n2|12-13h|48h+': cellP(rep(250, 3, 1)), 'tous|source|1n2|1-3h|48h+': cellP(rep(250, 3, 0)),
    };
    const rr = (dernier) => ({ serie: { j0: '2026-10-01', dernier: Date.parse(dernier) }, tranches: ['0-1h', '1-3h', '3-6h', '6-12h', '12-13h', '13-36h'], cellules });
    let Pt = ap.portes(rr('2026-10-16T12:00:00Z'));
    eq(Pt.dates.auPlusTot, '2026-10-15', 'au plus tot j0 + 14');
    eq(Pt.dates.prolonge, '2026-10-29', 'prolongation j0 + 28');
    ok(Pt.g2.vente.verdict === 'oui' && Pt.g2.source.verdict === 'non', 'G2 lit la cellule <3 h x 1-3 h en 1-N-2 : vente oui (1,5 %), meme source non (0 sur 900, avec la puissance)');
    eq(Pt.g2.verdict, 'non decide', 'G2 : vente et meme source en desaccord : non decide');
    ok(Pt.g1.vente.verdict === 'oui' && Pt.g1.source.verdict === 'non', 'G1 lit 48 h+ x 12-13 h contre 1-3 h : vente oui, meme source non');
    eq(Pt.g1.verdict, 'non decide', 'G1 : non decide');
    Pt = ap.portes(rr('2026-10-12T12:00:00Z'));
    ok(Pt.g2.verdict === 'trop tot' && Pt.g1.verdict === 'trop tot', 'j0 + 11 : trop tot');
    /* cadence par championnat */
    const cd = ap.cadence([ligneM(T, 'soccer_epl', []), ligneM(T + 10 * MIN, 'soccer_usa_mls', []), ligneM(T + 150 * MIN, 'soccer_epl', []), ligneM(T + 160 * MIN, 'soccer_usa_mls', [])]);
    ok(cd.n === 2 && cd.medianeMin === 150, 'cadence : ecarts PAR championnat (150, 150), jamais entre deux championnats');
    /* mises : une jambe de combine pese mise / jambes */
    const tickets = [];
    for (let i = 0; i < 30; i++) tickets.push({ t: T, mise: 100, jambes: [{ debut: T + H }] });
    tickets.push({ t: T, mise: 1000, jambes: [{ debut: T + H }, { debut: T + 30 * H }] });
    proche(ap.mises(tickets).parDelai['<3h'].mise, 3500, 1e-9, 'combine a deux jambes : 500 par jambe');
    /* le rapport refuse de conclure sous 30 rencontres, ecart G2 compris */
    const D8 = T + 8 * H;
    const r2 = ap.mesure([ligneM(T, 'soccer_epl', [E('q1', D8, 'b', PK)]), ligneM(T + 2 * H, 'soccer_epl', [E('q1', D8, 'b', PJ)]),
                          ligneM(T + 4 * H, 'soccer_epl', [E('q1', D8, 'b', PK)]), ligneM(T + 6 * H, 'soccer_epl', [E('q1', D8, 'b', PJ)])], { sansFiltreJours: true });
    const P2 = ap.portes(r2);
    const txt = ap.rapport(r2, P2);
    ok(P2.ecartG2 && P2.ecartG2.m === 1 && P2.ecartG2.assez === false, 'l ecart G2 existe (m = 1) mais n est pas assez');
    const rang = txt.split('\n').find((x) => /^  1-3h /.test(x)) || '';
    ok((rang.match(/n\/a \(m=1<30\)/g) || []).length === 3 && !/%/.test(rang), 'tableau, rang 1-3 h : n/a (m=1<30) dans ses trois cellules, aucune part');
    ok(/     vente : n\/a \(m=1\)/.test(txt) && /grands {7}G2 n\/a \(m=1\)/.test(txt), 'porte G2 et groupes : n/a (m=1), pas de part');
    ok(/ecart 3-6 h moins 1-3 h au delai 3-6 h \(rapporte\) : n\/a \(m=1<30\)/.test(txt), 'ecart G2 : n/a sous 30 rencontres');
    ok(/moyenne ponderee par le temps sur 0-12\.5 h d age, delai 48h\+ \(rapportee\) : n\/a/.test(txt), 'moyenne ponderee : n/a sans donnees');
    /* j sans reference, retraits, cotes */
    let lev = null, r3 = null;
    try { r3 = ap.mesure([ligneM(T, 'soccer_epl', [E('z1', D0, 'b', PK)]), ligneM(T + 2 * H, 'soccer_epl', [E('z1', D0, 'x')])], { sansFiltreJours: true }); } catch (er) { lev = er; }
    ok(!lev && r3.exclus.sansReference === 1, 'j sans reference apres un k vendu : ignore et compte, sans lever');
    eq(ap.retraits([ligneM(T, 'soccer_epl', [E('r1', D0, 'b', PK)]), ligneM(T + 150 * MIN, 'soccer_epl', [], { ko: 1, n: 3 })])['24-48h'].suivies, 0,
       'retraits : la ligne suivante est ko (carnet non ecrit) : rien de suivi');
    eq(ap.retraits([ligneM(T, 'soccer_epl', [E('r2', D0, 'x')]), ligneM(T + 150 * MIN, 'soccer_epl', [E('r2', D0, 'b', PK)])])['24-48h'].suivies, 0,
       'retraits : un k sans reference n est pas suivi');
    ok(ap.cotesVendues([1, 0, 0]) === null && ap.cotesVendues([0.5, 0.5, 0]) === null, 'cotes : un prix a 0 ou 1 ne se cote pas');
    /* l'age maximal de vente vient des LIGNES (am), pas de la machine qui mesure */
    const D20 = T + 20 * H;
    const paire = (x) => ap.mesure([ligneM(T, 'soccer_epl', [E('am1', D20, 'b', PK)], x), ligneM(T + 12.5 * H, 'soccer_epl', [E('am1', D20, 'b', PJ)], x)], { sansFiltreJours: true });
    eq(cel(paire({ am: 2160 }), 'tous|vente|1n2|12-13h|6-24h').paires, 1, 'am = 2160 (36 h) dans les lignes : la paire de 12 h 30 compte');
    eq(cel(paire({ am: 600 }), 'tous|vente|1n2|12-13h|6-24h').paires, 0, 'am = 600 (10 h) : le serveur ne vendait pas un prix de 12 h 30, aucune paire');
    eq(paire({}).serie.ageMaxMs, paris.AGE_PRIX_MS, 'sans am (lignes d avant le champ) : paris.AGE_PRIX_MS de la machine, et le rapport le dit');
  }

  // =================================================================== fin
  console.log('\n-- la ligne de demarrage --');
  {
    const l = pj.ligneDemarrage();
    ok(/^\[odds\] journal des prix : actif, 30 j gardes, \d+ fichier\(s\)/.test(l) && /0 credit/.test(l), 'dit : actif, jours gardes, fichiers, 0 credit');
    process.env.PARIS_PRIX_JOURNAL = '0';
    ok(/COUPE/.test(pj.ligneDemarrage()), 'coupe : le dit');
    delete process.env.PARIS_PRIX_JOURNAL;
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log(`\nprix_journal.test.js : ${n} verifications OK`);
}
