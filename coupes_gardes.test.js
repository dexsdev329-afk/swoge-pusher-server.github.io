'use strict';
/*
 * LES GARDE-FOUS DU LOT 6 QUE RIEN NE TENAIT (coupes, 11/10/2026).
 *
 * La mutation du lot (103 garde-fous retires un par un sur une copie hors
 * depot) en laissait survivre 36 a coupes.test.js et scores_espn.test.js (35
 * d'entre eux aussi a quinze suites voisines) : aucun defaut du code, des
 * trous d'essai. Chaque section tient l'INTENTION d'un garde-fou et tombe
 * s'il est retire (mutant entre crochets, liste dans EXPLOITATION 8.11) :
 *  A  une coupe NON observee n'est jamais payee, meme fenetre ouverte [N05] ;
 *  B  la classe d'une coupe est bornee a 2 ou 3, quel que soit l'appelant [N07] ;
 *  C  les coupes APRES les championnats vendus, un championnat perime [N10] ;
 *  D  la releve forcee par le VRAI chemin, planifie().avantMatch : son age
 *     minimal et sa classe arrivent jusqu'a l'appel [N14, N15] ;
 *  E  une rencontre deja commencee ne declenche aucune releve [N37] ;
 *  F  la fenetre T-45/T-20, jugee sur le coup d'envoi le plus tardif [N38-N40] ;
 *  G  un appariement ESPN vu ne redescend pas quand ESPN repond sans lui [N42] ;
 *  H  une autre affiche sous le meme evenement : l'appariement repart de zero [N35] ;
 *  I  la mesure E, C, A sur un suivi et un inventaire construits [N49-N52] ;
 *  J  le critere E lui-meme, pas seulement le verdict [N53] ;
 *  K  la derive : par rencontre, bornes des tranches, ko, reference VENDUE,
 *     par coupe et non par famille [N65-N69, N74] ;
 *  L  liguesEnService sur le chemin des JOKERS (la production : tennis=*),
 *     /sports lu et injoignable ; une coupe listee deux fois n'est lue
 *     qu'une fois [N01, N02, N04] ;
 *  M  node paris_import.js --coupes : 0 credit, aucun /odds [N18] ;
 *  N  hygiene des deux fichiers : purge des 60 jours, seuil T-60 du suivi,
 *     reponse vide qui ne retire rien, fenetre des doublons, version [N36,
 *     N46, N48, N62, N63] ;
 *  O  la releve forcee des coupes APRES les causes des championnats vendus [N77] ;
 *  P  PARIS_COUPES_OBSERVE_H=1 : une releve d'avant-match par creneau, dans
 *     [T-60 ; T-30], et pas de forcee derriere elle (l'option de E, C, A sans
 *     D, EXPLOITATION 8.11, marche a suivre).
 * Aucun reseau : faux fournisseur (marches x regions, 0 pour /events et pour
 * une reponse vide, https://the-odds-api.com/liveapi/guides/v4/) et faux
 * ESPN ; les processus enfants (L, M) prechargent essais/coupes/faux_fetch.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-gardes-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-des-gardes-coupes';
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_FIN = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_spain_la_liga';
process.env.ODDS_API_HORIZON = '7';
process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_spain_la_liga';
process.env.PARIS_PRIX_RELEVE_H = '2';

let n = 0, rates = 0;
const ok = (v, m) => { n++; if (v) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)}${a === b ? '' : ' au lieu de ' + JSON.stringify(b)})`);
const J = (x) => JSON.stringify(x);
const H = 3600000, MIN = 60000, JOUR = 86400000;
const UEL = 'soccer_uefa_europa_league', UECL = 'soccer_uefa_europa_conference_league', FA = 'soccer_fa_cup', DFB = 'soccer_germany_dfb_pokal';
const CDR = 'soccer_spain_copa_del_rey', CDF = 'soccer_france_coupe_de_france', EFL = 'soccer_england_efl_cup', COPPA = 'soccer_italy_coppa_italia';
const AIDE = path.join(__dirname, 'essais', 'coupes');

// --------------------------------------------------- le faux fournisseur
const T0 = Date.now();
const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('e1', 'Arsenal', 'Everton', T0 + 30 * H)],
  soccer_spain_la_liga: [ev('s1', 'Real Madrid', 'Getafe', T0 + 30 * H)],
  [UEL]: [ev('u1', 'FC Copenhagen', 'Ajax', T0 + 30 * H), ev('u2', 'Real Betis', 'Lyon', T0 + 30 * H), ev('u3', 'Celtic', 'Roma', T0 + 40 * MIN)],
  [FA]: [ev('f1', 'Chelsea', 'Fulham', T0 + 31 * H)],
  [DFB]: [ev('d1', 'Bayern Munich', 'Hamburger SV', T0 + 60 * H)],
};
const livre = (key, e, c1, cn, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
const trois = (e, p) => [livre('betfair_ex_eu', e, ...p.map((x) => Math.round(100 / (x * 1.02)) / 100)),
  livre('pinnacle', e, ...p.map((x) => Math.round(100 / (x * 1.03)) / 100)), livre('unibet_eu', e, ...p.map((x) => Math.round(100 / (x * 1.06)) / 100))];
const odds = (l, p) => () => (EVENTS[l] || []).map((e) => Object.assign({}, e, { bookmakers: trois(e, p) }));
const ODDS = { soccer_epl: odds('soccer_epl', [0.5, 0.27, 0.23]), soccer_spain_la_liga: odds('soccer_spain_la_liga', [0.7, 0.18, 0.12]),
  [UEL]: odds(UEL, [0.45, 0.28, 0.27]), [FA]: odds(FA, [0.55, 0.25, 0.2]), [DFB]: odds(DFB, [0.8, 0.13, 0.07]) };
const espnEv = (id, dom, ext, quand) => ({ id, date: new Date(quand).toISOString().slice(0, 16) + 'Z',
  status: { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } },
  competitions: [{ competitors: [{ homeAway: 'home', score: '0', team: { displayName: dom } }, { homeAway: 'away', score: '0', team: { displayName: ext } }] }] });
const ESPN = { 'soccer/uefa.europa': [espnEv('x2', 'Real Betis', 'Lyon', T0 + 30 * H)] };
const appels = [];
let utilise = 0;
const entetes = (h) => ({ get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) });
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (/espn\.com$/.test(u.hostname)) {
    const ch = /sports\/(.+?)\/scoreboard/.exec(u.pathname)[1];
    const q = u.searchParams.get('dates') || '';
    const evs = (ESPN[ch] || []).filter((x) => (q.length === 8 ? x.date.slice(0, 10).replace(/-/g, '') === q : x.date.slice(0, 7).replace('-', '') === q));
    return { ok: true, status: 200, json: async () => ({ events: JSON.parse(JSON.stringify(evs)) }) };
  }
  const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
  const ligue = m && m[1], quoi = m ? m[2] : 'sports';
  /* « cost = [number of markets specified] x [number of regions specified] » */
  const cout = quoi === 'odds' ? (u.searchParams.get('markets') || '').split(',').length * (u.searchParams.get('regions') || '').split(',').length : 0;
  let corps = [];
  if (quoi === 'events') corps = EVENTS[ligue] || [];
  else if (quoi === 'odds') corps = ODDS[ligue] ? ODDS[ligue]() : [];
  /* « If no events are returned, the request will not count against the usage quota » */
  const facture = corps.length ? cout : 0;
  utilise += facture;
  appels.push({ ligue, quoi, cout: facture });
  return { ok: true, status: 200, headers: entetes({ 'x-requests-remaining': String(20000 - utilise), 'x-requests-used': String(utilise), 'x-requests-last': String(facture) }),
           json: async () => JSON.parse(JSON.stringify(corps)), text: async () => JSON.stringify(corps) };
};
require('./alerte_solde').oddsEvenement = () => true;

const prixLigues = require('./prix_ligues');
const pm = require('./prix_marche');
const paris = require('./paris');
const coupes = require('./coupes');
const imp = require('./paris_import');
const ap = require('./outils/age_prix');

const coupeAppels = (quoi) => appels.filter((x) => prixLigues.estCoupe(x.ligue) && (!quoi || x.quoi === quoi));
const jour = () => new Date().toISOString().slice(0, 10);
const classes = () => { try { return JSON.parse(fs.readFileSync(path.join(BAC, 'odds_classes.json'), 'utf8')).jours[jour()] || {}; } catch (e) { return {}; } };
const cls = (k, champ) => Number(((classes()[k]) || {})[champ]) || 0;
const dateLigue = (cle, t) => { const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')); c.ligues[cle] = t; fs.writeFileSync(pm.fichier(), JSON.stringify(c)); };
const pose = (o) => { for (const k of ['PARIS_COUPES', 'PARIS_COUPES_OBSERVE', 'PARIS_COUPES_OBSERVE_H']) delete process.env[k]; Object.assign(process.env, o || {}); };
const capte = async (f) => { const l = [], vrai = console.log; console.log = (...a) => { l.push(a.join(' ')); }; try { await f(); } finally { console.log = vrai; } return l; };
/* un processus enfant, aucun reseau (faux_fetch en precharge), DATA_DIR a lui */
const enfant = (script, args, env) => {
  const e = Object.assign({}, process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-gardes-e-')) }, env);
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return execFileSync(process.execPath, ['-r', path.join(AIDE, 'faux_fetch.js'), script].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
};

(async () => {
  await imp.rafraichitPrix(['soccer_epl', 'soccer_spain_la_liga'], 'essai');
  pose({ PARIS_COUPES_OBSERVE: UEL, PARIS_COUPES_OBSERVE_H: '48' });
  await imp.importeMatchs();
  paris.charge();

  console.log('\n-- A. une coupe NON observee n est jamais payee, meme fenetre ouverte [N05] --');
  appels.length = 0;
  await imp.rafraichitPrix([FA], 'a la main');
  eq(coupeAppels('odds').length, 0, 'FA Cup (ni observee ni vendue), PARIS_COUPES_OBSERVE_H=48 : aucun /odds');

  console.log('\n-- B. la classe d une coupe est bornee a 2 ou 3, quel que soit l appelant [N07] --');
  {
    dateLigue(UEL, 0);
    const k0 = cls(0, 'appels'), k3 = cls(3, 'appels');
    appels.length = 0;
    await imp.rafraichitPrix([UEL], 'essai', 0, { classe: 0 });
    eq(coupeAppels('odds').length, 1, 'la releve part');
    eq(cls(0, 'appels') - k0, 0, 'jamais en classe 0, meme demandee');
    eq(cls(3, 'appels') - k3, 1, 'en classe 3');
  }

  console.log('\n-- C. les coupes APRES les championnats vendus, avec un championnat perime [N10] --');
  {
    dateLigue('soccer_epl', 0); dateLigue('soccer_spain_la_liga', 0); dateLigue(UEL, 0);
    const per = imp.prixPerimes(Date.now());
    ok(per.includes('soccer_epl') && per.includes(UEL), 'les deux sont perimes : ' + per.join(','));
    ok(per.indexOf(UEL) > per.indexOf('soccer_epl') && per.indexOf(UEL) > per.indexOf('soccer_spain_la_liga'), 'la coupe passe apres : ' + per.join(','));
    const t = Date.now();
    dateLigue('soccer_epl', t); dateLigue('soccer_spain_la_liga', t); dateLigue(UEL, t);
  }

  console.log('\n-- D. la releve forcee par le VRAI chemin, planifie().avantMatch [N14, N15] --');
  {
    const debut3 = Date.parse(EVENTS[UEL][2].commence_time);
    /* dernier releve a T-70 : avant T-60, donc forcee ; vieux de 30 min
       seulement, sous PRIX_DEMANDE_MS (1 h) : seul l'age minimal de la cause
       la laisse partir */
    dateLigue(UEL, debut3 - 70 * MIN);
    const k2 = cls(2, 'appels');
    appels.length = 0;
    await capte(async () => { const ctl = imp.planifie(() => {}, () => false, () => 0); try { await ctl.avantMatch(); } finally { ctl.arrete(); } });
    eq(coupeAppels('odds').length, 1, 'avantMatch paie la releve forcee (age minimal de la cause, pas PRIX_DEMANDE_MS)');
    eq(cls(2, 'appels') - k2, 1, 'en classe 2 (la classe de la cause arrive jusqu a l appel)');
  }

  console.log('\n-- E. une rencontre deja commencee ne declenche aucune releve [N37] --');
  {
    pose({ PARIS_COUPES_OBSERVE: [UEL, DFB].join(','), PARIS_COUPES_OBSERVE_H: '48' });
    const now = Date.now();
    coupes.noteInventaire(DFB, [ev('dz', 'Bayern Munich', 'Hamburger SV', now - 30 * MIN)], now);
    dateLigue(DFB, 0);
    ok(!coupes.aVenir(now, 48 * H).has(DFB), 'aVenir : la DFB-Pokal (seule rencontre commencee il y a 30 min) n a rien a venir');
    ok(!imp.prixPerimes(now).includes(DFB), 'prixPerimes ne la paie pas (/odds rend aussi les matchs en cours)');
  }

  console.log('\n-- F. la fenetre T-45/T-20 de la releve forcee [N38, N39, N40] --');
  {
    pose({ PARIS_COUPES_OBSERVE: [UEL, CDR].join(','), PARIS_COUPES_OBSERVE_H: '48' });
    const now = Date.now();
    const de = (f) => f.filter((x) => x.cle === CDR);
    coupes.noteInventaire(CDR, [ev('k50', 'Sevilla', 'Elche', now + 50 * MIN)], now);
    dateLigue(CDR, 1);
    eq(de(coupes.forcees(now)).length, 0, 'a T-50 : pas encore (sinon une releve a chaque tic jusqu a T-60)');
    coupes.noteInventaire(CDR, [ev('k10', 'Sevilla', 'Elche', now + 10 * MIN)], now + 1);
    eq(de(coupes.forcees(now)).length, 0, 'a T-10 : trop tard');
    coupes.noteInventaire(CDR, [ev('k25', 'Sevilla', 'Elche', now + 25 * MIN), ev('k44', 'Getafe', 'Osasuna', now + 44 * MIN)], now + 2);
    dateLigue(CDR, now - 17 * MIN);
    const f = de(coupes.forcees(now))[0];
    ok(f && f.debut === now + 44 * MIN, 'deux coups d envoi dans la fenetre : jugee sur le plus TARDIF (T-60 de 44 min) — ' + J(f));
  }

  console.log('\n-- G/H. l appariement ESPN : ne redescend pas, repart de zero si l affiche change [N42, N35] --');
  {
    pose({ PARIS_COUPES_OBSERVE: UEL, PARIS_COUPES_OBSERVE_H: '48' });
    await imp.importeMatchs();
    await coupes.apparieEspn({ maintenant: T0 });
    ok(coupes.lisInventaire().coupes[UEL].ev.u2.espn.ok === true, 'u2 appariee');
    const garde = ESPN['soccer/uefa.europa'];
    ESPN['soccer/uefa.europa'] = [];
    await coupes.apparieEspn({ maintenant: T0 });
    ok(coupes.lisInventaire().coupes[UEL].ev.u2.espn.ok === true, 'ESPN repond sans elle (pas une panne) : l appariement vu ne redescend pas');
    ESPN['soccer/uefa.europa'] = garde;
    const u2 = EVENTS[UEL][1];
    EVENTS[UEL][1] = Object.assign({}, u2, { away_team: 'Nice' });
    await imp.importeMatchs();
    eq(coupes.lisInventaire().coupes[UEL].ev.u2.espn, null, 'une autre affiche sous le meme evenement : l appariement repart de zero');
    EVENTS[UEL][1] = u2;
    await imp.importeMatchs();
  }

  console.log('\n-- I. la mesure E, C, A sur un suivi et un inventaire construits [N49, N50, N51, N52] --');
  {
    const D = Date.parse('2026-10-29T19:00:00Z');
    coupes.noteInventaire(CDF, [ev('k1', 'A1', 'B1', D), ev('k2', 'A2', 'B2', D), ev('k3', 'A3', 'B3', D), ev('k6', 'A6', 'B6', D + 5 * H)], D - 3 * H);
    const inv = coupes.lisInventaire();
    inv.coupes[CDF].ev.k1.espn = { ok: true, t: 1 };
    inv.coupes[CDF].ev.k2.espn = { ok: false, t: 1 };
    inv.coupes[CDF].ev.k3.espn = null;
    fs.writeFileSync(coupes.fichierInventaire(), JSON.stringify(inv));
    coupes.noteSuivi({ ligue: CDF, t: D - 3 * H, refs: [{ id: 'k1', debut: D, ref: 'betfair' }, { id: 'k2', debut: D, ref: null },
      { id: 'k3', debut: D, ref: 'pinnacle' }, { id: 'k6', debut: D + 5 * H, ref: 'betfair' }] });
    const m = coupes.mesure(CDF, D + 3 * H);
    eq(m.E, 3, 'E : k1, k2, k3 jouees ; k6 pas encore jouee');
    eq(m.C, 2, 'C : betfair et pinnacle ; « aucun » ne couvre pas');
    eq(m.A, 1, 'A : k1 seule (k2 conclue NON, k3 jamais lue)');
    coupes.noteSuivi({ ligue: EFL, t: D - 72 * H, refs: [{ id: 'm1', debut: D, ref: 'betfair' }] });
    eq(coupes.mesure(EFL, D + 3 * H).E, 0, 'E : une rencontre sans releve dans ses 48 h ne compte pas');
  }

  console.log('\n-- J. le critere E lui-meme, pas seulement le verdict [N53] --');
  {
    const P = coupes.PORTE, d = {};
    for (const tr of P.tranches) { d[tr] = {}; for (const mk of P.marches) d[tr][mk] = { n: 189, k: 0, nRef: 30, kRef: 0 }; }
    eq(coupes.porte(UEL, { E: 7, C: 7, A: 7 }, d, Date.parse('2026-11-07T12:00Z')).criteres.E.tient, false, 'E 7 : le critere E ne tient pas');
    eq(coupes.porte(UEL, { E: 8, C: 8, A: 8 }, d, Date.parse('2026-11-07T12:00Z')).criteres.E.tient, true, 'E 8 : il tient');
  }

  console.log('\n-- K. la derive : par rencontre, bornes des tranches, ko, reference vendue, par coupe [N65, N66, N67, N68, N69, N74] --');
  {
    const D = Date.parse('2026-10-29T19:00:00Z');
    const L = (t, l, e, x) => Object.assign({ v: 1, m: 'h2h', t, l, q: 'periodique', c: 120, av: 1, am: 2160, n: e.length, s: 'foot', e }, x || {});
    const E = (id, debut, ref, pv) => [id, debut, ref, pv, null, null, null, 4, null, null];
    const P1 = [0.50, 0.26, 0.24], P2 = [0.60, 0.22, 0.18];
    const o = { o: 1 };
    const lignes = [
      /* m : trois releves, DEUX paires a moins de 3 h — une seule rencontre */
      L(D - 170 * MIN, UEL, [E('m', D, 'b', P1)], o), L(D - 110 * MIN, UEL, [E('m', D, 'b', P1)], o), L(D - 50 * MIN, UEL, [E('m', D, 'b', P1)], o),
      /* n : nouveau releve a T-70 : moins de 3 h, PAS apres T-60 */
      L(D - 120 * MIN, UEL, [E('n', D, 'b', P1)], o), L(D - 70 * MIN, UEL, [E('n', D, 'b', P1)], o),
      /* q : nouveau releve a T-4 h : 3-48 h, pas moins de 3 h */
      L(D - 6 * H, UEL, [E('q', D, 'b', P1)], o), L(D - 4 * H, UEL, [E('q', D, 'b', P1)], o),
      /* p : le premier releve n a pas ecrit le carnet (ko) : pas une paire */
      L(D - 150 * MIN, UEL, [E('p', D, 'b', P1)], { o: 1, ko: 1 }), L(D - 90 * MIN, UEL, [E('p', D, 'b', P1)], o),
      /* u : Conference League, battable — jamais dans la porte de l Europa League */
      L(D - 2 * H, UECL, [E('u', D, 'b', P1)], o), L(D - 50 * MIN, UECL, [E('u', D, 'b', P2)], o),
      /* r : championnat VENDU, la reference */
      L(D - 2 * H, 'soccer_epl', [E('r', D, 'p', P1)]), L(D - 50 * MIN, 'soccer_epl', [E('r', D, 'p', P1)]),
      /* z : championnat OBSERVE (o), battable — jamais dans la reference */
      L(D - 2 * H, 'soccer_netherlands_eredivisie', [E('z', D, 'p', P1)], o), L(D - 50 * MIN, 'soccer_netherlands_eredivisie', [E('z', D, 'p', P2)], o),
    ];
    const r = ap.deriveCoupes(lignes);
    const d = ap.deriveDe(r, [UEL]);
    eq(d.moins3h['1n2'].n, 2, 'moins de 3 h : m (une fois, pas deux paires) et n');
    eq(d.apresT60['1n2'].n, 1, 'apres T-60 : m seule (n a T-70 n y est pas)');
    eq(d.de3a48h['1n2'].n, 1, '3-48 h : q (T-4 h)');
    eq(r.exclus.ko, 1, 'p : premier releve ko, exclu');
    eq(J([d.moins3h['1n2'].nRef, d.moins3h['1n2'].kRef]), J([1, 0]), 'reference : le championnat vendu seul (pas l observe)');
    const PC = ap.portesCoupes(r, null, Date.parse('2026-11-07T00:00Z'));
    eq(PC[UEL].porte.criteres.D.cellules['moins3h|1n2'].n, 2, 'la porte de l Europa League juge SA derive, pas celle de la famille');
  }

  console.log('\n-- L. liguesEnService sur le chemin des jokers (la production : tennis=*) [N01, N02, N04] --');
  {
    const cles = (env) => {
      try { return JSON.parse(enfant(path.join(AIDE, 'ligues_en_service.js'), [], Object.assign({ PARIS_COUPES_OBSERVE_H: undefined }, env)).trim().split('\n').pop()); }
      catch (e) { return ['ERREUR ' + String(e.message).slice(0, 120)]; }
    };
    const jok = { ODDS_API_LIGUES: 'foot=soccer_epl,tennis=*', PARIS_COUPES_OBSERVE: UEL };
    const lu = cles(Object.assign({ FAUX_SPORTS: 'ok' }, jok));
    ok(lu.includes(UEL) && lu.includes('soccer_epl'), 'jokers lus : la coupe observee est en service — ' + J(lu));
    const panne = cles(Object.assign({ FAUX_SPORTS: 'panne' }, jok));
    ok(panne.includes(UEL) && panne.includes('soccer_epl'), '/sports injoignable, sans cache : la coupe observee reste en service — ' + J(panne));
    const sans = cles({ ODDS_API_LIGUES: 'foot=soccer_epl,tennis=*', PARIS_COUPES_OBSERVE: undefined, FAUX_SPORTS: 'ok' });
    ok(!sans.some((x) => prixLigues.estCoupe(x)), 'jokers sans PARIS_COUPES_OBSERVE : aucune coupe — ' + J(sans));
    const deux = cles({ ODDS_API_LIGUES: 'foot=soccer_epl,foot=' + UEL, PARIS_COUPES_OBSERVE: UEL });
    eq(deux.filter((x) => x === UEL).length, 1, 'une coupe ecrite dans ODDS_API_LIGUES ET observee : un seul /events');
  }

  console.log('\n-- M. node paris_import.js --coupes : 0 credit, aucun /odds [N18] --');
  {
    const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-gardes-cli-')), 'urls.txt');
    let code = 0;
    try { enfant(path.join(__dirname, 'paris_import.js'), ['--coupes'], { FAUX_LOG: LOG, PARIS_COUPES: undefined, PARIS_COUPES_OBSERVE: undefined, PARIS_COUPES_OBSERVE_H: undefined }); }
    catch (e) { code = e.status; }
    const urls = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : [];
    eq(code, 0, '--coupes sort en code 0');
    eq(urls.filter((u) => /the-odds-api/.test(u) && /\/events/.test(u)).length, 8, 'un /events par coupe (les huit, sans PARIS_COUPES_OBSERVE)');
    eq(urls.filter((u) => /\/odds/.test(u)).length, 0, 'aucun /odds');
  }

  console.log('\n-- N. hygiene des deux fichiers [N36, N46, N48, N62, N63] --');
  {
    const now = Date.now();
    /* N36 : l'inventaire garde 60 jours apres le coup d'envoi, pas plus */
    coupes.noteInventaire(COPPA, [ev('vieux', 'Inter', 'Lazio', now - 61 * JOUR), ev('recent', 'Roma', 'Napoli', now - 59 * JOUR)], now);
    const ic = coupes.lisInventaire().coupes[COPPA].ev;
    ok(!ic.vieux && ic.recent, 'inventaire : une rencontre jouee il y a 61 jours est purgee, celle d il y a 59 jours reste');
    /* N46 : « apres T-60 » veut dire a 60 min au plus du coup d'envoi */
    const D = now + 10 * H;
    coupes.noteSuivi({ ligue: COPPA, t: D - 61 * MIN, refs: [{ id: 's61', debut: D, ref: 'betfair' }] });
    eq(coupes.lisSuivi().coupes[COPPA].s61.apresT60, false, 'suivi : un releve a T-61 n est pas « apres T-60 »');
    coupes.noteSuivi({ ligue: COPPA, t: D - 59 * MIN, refs: [{ id: 's61', debut: D, ref: 'betfair' }] });
    eq(coupes.lisSuivi().coupes[COPPA].s61.apresT60, true, 'a T-59, il l est');
    /* N48 : une reponse /odds VIDE (gratuite) ne retire aucun marche */
    coupes.noteSuivi({ ligue: COPPA, t: D - 3 * H, refs: [{ id: 'v1', debut: D, ref: 'pinnacle' }] });
    coupes.noteSuivi({ ligue: COPPA, t: D - 2 * H, refs: [] });
    eq(coupes.lisSuivi().coupes[COPPA].v1.ref, 'pinnacle', 'suivi : une reponse vide ne conclut rien (v1 reste au prix de Pinnacle)');
    /* N62 : un doublon, c'est la meme affiche a 36 h pres, pas au-dela */
    const inv = { v: 1, coupes: { [FA]: { lu: 5, ev: { f9: { dom: 'Arsenal', ext: 'Everton', debut: now + 10 * H, vu: 5 } } } } };
    const cat = (dt) => [{ id: 'epl-x', domicile: 'Arsenal', exterieur: 'Everton', debut: now + 10 * H + dt, source: { ligue: 'soccer_epl' } }];
    eq(coupes.doublons(cat(35 * H), now, inv).length, 1, 'doublons : la meme affiche a 35 h : signalee');
    eq(coupes.doublons(cat(37 * H), now, inv).length, 0, 'a 37 h : deux rencontres, pas un doublon');
    /* N63 : un fichier d'une autre version n'est jamais lu comme le notre */
    const f = path.join(BAC, 'version_essai.json');
    fs.writeFileSync(f, J({ v: 2, coupes: { [UEL]: {} } }));
    eq(coupes.lisFichier(f).etat, 'version', 'lisFichier : v 2 n est pas lu (etat « version »)');
  }

  console.log('\n-- O. la releve forcee des coupes APRES les causes des championnats vendus [N77] --');
  {
    pose({ PARIS_COUPES_OBSERVE: [UEL, CDR].join(','), PARIS_COUPES_OBSERVE_H: '48' });
    paris.charge();
    const e1 = Date.parse(EVENTS.soccer_epl[0].commence_time), t = e1 - 40 * MIN;
    dateLigue('soccer_epl', 1);
    coupes.noteInventaire(CDR, [ev('kav', 'Sevilla', 'Elche', t + 30 * MIN)], Date.now());
    dateLigue(CDR, 1);
    const causes = imp.causesAvantMatch(() => true, t);
    const iA = causes.findIndex((x) => x.quoi === 'avant'), iC = causes.findIndex((x) => x.quoi === 'coupe T-45');
    ok(iA >= 0 && iC >= 0 && iA < iC, 'l avant-match de la Premier League (vendue) passe avant la releve forcee de la coupe — ' + J(causes.map((x) => x.quoi)));
    dateLigue('soccer_epl', Date.now());
  }

  console.log('\n-- P. PARIS_COUPES_OBSERVE_H=1 : une releve par creneau, dans [T-60 ; T-30], sans forcee derriere --');
  {
    pose({ PARIS_COUPES_OBSERVE: COPPA, PARIS_COUPES_OBSERVE_H: '1' });
    const now = Date.now(), T = now + 55 * MIN;
    coupes.noteInventaire(COPPA, [ev('cr1', 'Juventus', 'Torino', T)], now);
    dateLigue(COPPA, 1);
    ok(!imp.prixPerimes(now - 10 * MIN).includes(COPPA), 'a T-65 : rien (la rencontre n est pas dans l heure)');
    ok(imp.prixPerimes(now).includes(COPPA), 'a T-55 : la releve periodique (tic de 30 min : elle tombe dans [T-60 ; T-30])');
    dateLigue(COPPA, now);
    eq(coupes.forcees(T - 40 * MIN).filter((x) => x.cle === COPPA).length, 0, 'a T-40 : pas de forcee (le releve est posterieur a T-60)');
    ok(!imp.prixPerimes(T - 40 * MIN).includes(COPPA) && !imp.prixPerimes(T - 5 * MIN).includes(COPPA), 'ni de periodique jusqu au coup d envoi (cadence de 2 h) : un credit pour le creneau');
    pose({ PARIS_COUPES_OBSERVE: COPPA, PARIS_COUPES_OBSERVE_H: '48' });
    dateLigue(COPPA, 1);
    ok(imp.prixPerimes(now - 10 * MIN).includes(COPPA), 'a 48 h de fenetre, la meme rencontre se releve des T-65 (et toutes les 2 h depuis T-48 h)');
  }

  console.log(rates ? `\nRATES : ${rates}/${n}` : `\ncoupes_gardes.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
