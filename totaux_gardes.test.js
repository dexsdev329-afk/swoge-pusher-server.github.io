'use strict';
/*
 * LES GARDE-FOUS DU LOT 5 QUE RIEN NE TENAIT (totaux du marche, 10/10/2026).
 *
 * La mutation du lot (157 garde-fous retires un par un sur une copie hors
 * depot) en laissait survivre 73 a cotes_totaux.test.js et
 * totaux_marche.test.js ; la relecture contradictoire du meme jour en a
 * ajoute (reference VENDUE au journal, ligne d'audit de DP_MAX, `fuite` au
 * lieu de `retenu`, minuteries hors de l'avant-match, J0 par championnat, age
 * a 0 qui echoue ferme, releve qui ne repart pas pour une rencontre fermee ou
 * sans p h2h). Chaque section tient l'INTENTION d'un garde-fou, et tombe s'il
 * est retire :
 *  A-I  regle (48 h, 12 h, 30 credits, cles), delai, releve observee,
 *       cloture (20-75 min, 2 h, strates, raisons), vente commencee, retour
 *       arriere sur une rencontre conservee ;
 *  J    cloture d'une rencontre fermee, prix du marche inverse, ecart du
 *       moment sur un total perime ;
 *  K    la porte 2 range le type de reference sur le total VENDU ;
 *  L    la ligne d'audit de DP_MAX et de l'age (ombre des refusees, dp) ;
 *  M    par championnat : `fuite` prouvee, ou rien de prouve (et la puissance) ;
 *  N    ce qui ne declenche pas de releve (fermee, sans p h2h) ;
 *  P    PARIS_TOTAUX_AGE_MAX_H=0 : rien n'est servi, l'observation continue ;
 *  Q    J0 par championnat (porte 1) ;
 *  R    les minuteries ne tombent jamais sur un tic des prix ;
 *  S-T  references, carnet, journal, verdicts des portes 1 et 2.
 * Le banc (faux fournisseur qui facture marches x regions, aucun reseau) est
 * celui de totaux_marche.test.js, recopie tel quel.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'totaux-gardes-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-des-totaux';
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_FIN = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_france_ligue_one,foot=soccer_spain_la_liga';
process.env.ODDS_API_HORIZON = '7';
process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_france_ligue_one,soccer_spain_la_liga';

let n = 0, rates = 0;
const ok = (v, m) => { n++; if (v) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const J = (x) => JSON.stringify(x);
const H = 3600000;

// --------------------------------------------------- le faux fournisseur
const T0 = Date.now();
const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('e1', 'Arsenal', 'Everton', T0 + 30 * H), ev('e2', 'Chelsea', 'Liverpool', T0 + 32 * H),
               ev('e3', 'Tottenham', 'Fulham', T0 + 6 * 24 * H)],
  soccer_france_ligue_one: [ev('l1', 'Lyon', 'Monaco', T0 + 30 * H)],
  soccer_spain_la_liga: [ev('s1', 'Getafe', 'Girona', T0 + 30 * H)],
};
const h2h = (key, e, c1, cn, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
const tot = (key, lignes) => ({ key, markets: [{ key: 'totals', outcomes: lignes.flatMap(([l, o, u]) => [{ name: 'Over', price: o, point: l }, { name: 'Under', price: u, point: l }]) }] });
/* le 1-N-2 du marche de chaque rencontre (sans marge), habille a 2 % (bourse),
   3 % (Pinnacle) et 6 % (un livre ordinaire) */
const P_EPL = [[0.50, 0.26, 0.24], [0.42, 0.27, 0.31], [0.36, 0.28, 0.36], [0.30, 0.28, 0.42]];
const avecMarge = (key, e, p, m) => h2h(key, e, ...p.map((x) => Math.round(100 / (x * (1 + m))) / 100));
const H2H = {
  soccer_epl: () => EVENTS.soccer_epl.map((e, i) => Object.assign({}, e, { bookmakers: [avecMarge('betfair_ex_eu', e, P_EPL[i], 0.02),
    avecMarge('pinnacle', e, P_EPL[i], 0.03), avecMarge('unibet_eu', e, P_EPL[i], 0.06)] })),
  soccer_france_ligue_one: () => EVENTS.soccer_france_ligue_one.map((e) => Object.assign({}, e, { bookmakers: [h2h('pinnacle', e, 2.3, 3.4, 3.2)] })),
  soccer_spain_la_liga: () => EVENTS.soccer_spain_la_liga.map((e) => Object.assign({}, e, { bookmakers: [h2h('pinnacle', e, 2.5, 3.1, 3.1)] })),
};
/* Les totaux : e1 a Betfair 2,5 ; e2 a Pinnacle 2,5 ; e3 sans aucun livre de
   totaux (a J+6) ; l1 sans totaux (pour les essais). */
let TOTALS = null;
const totauxDefaut = () => ({
  soccer_epl: () => [
    Object.assign({}, EVENTS.soccer_epl[0], { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]]), tot('pinnacle', [[2.5, 1.93, 1.93]]),
      tot('unibet_eu', [[2.5, 1.85, 1.95]]), tot('williamhill', [[2.5, 1.88, 1.92]])] }),
    Object.assign({}, EVENTS.soccer_epl[1], { bookmakers: [tot('pinnacle', [[2.5, 1.70, 2.20]]), tot('unibet_eu', [[2.5, 1.66, 2.15]])] }),
    Object.assign({}, EVENTS.soccer_epl[2], { bookmakers: [] }),
  ].concat(EVENTS.soccer_epl.slice(3).map((e) => Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, 2.05, 1.85]])] }))),
  soccer_france_ligue_one: () => EVENTS.soccer_france_ligue_one.map((e) => Object.assign({}, e, { bookmakers: [h2h('pinnacle', e, 2.3, 3.4, 3.2)] })),
  soccer_spain_la_liga: () => EVENTS.soccer_spain_la_liga.map((e) => Object.assign({}, e, { bookmakers: [tot('pinnacle', [[2.5, 1.9, 1.95]])] })),
});
TOTALS = totauxDefaut();
const appels = [];
let utilise = 0;
const entetes = (h) => ({ get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) });
let sansEntete = false;
const PANNE_TOTAUX = new Set();
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (/espn\.com$/.test(u.hostname)) return { ok: true, status: 200, headers: entetes({}), json: async () => ({ events: [] }) };
  const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
  const ligue = m && m[1], quoi = m ? m[2] : 'sports';
  const marches = u.searchParams.get('markets') || '';
  /* « cost = [number of markets specified] x [number of regions specified] » */
  const cout = quoi === 'odds' ? marches.split(',').length * (u.searchParams.get('regions') || '').split(',').length : 0;
  if (quoi === 'odds' && marches !== 'h2h' && PANNE_TOTAUX.has(ligue)) {
    const err = { message: 'Invalid market', error_code: 'INVALID_MARKET' };
    appels.push({ ligue, quoi, marches, cout: 0, regions: u.searchParams.get('regions') });
    return { ok: false, status: 422, headers: entetes({}), json: async () => err, text: async () => JSON.stringify(err) };
  }
  let corps = [];
  if (quoi === 'events') corps = EVENTS[ligue] || [];
  else if (quoi === 'odds') corps = (marches === 'h2h' ? H2H[ligue] : TOTALS[ligue]) ? (marches === 'h2h' ? H2H[ligue] : TOTALS[ligue])() : [];
  /* « If no events are returned, the request will not count against the usage quota » */
  const facture = corps.length ? cout : 0;
  utilise += facture;
  appels.push({ ligue, quoi, marches, cout: facture, regions: u.searchParams.get('regions') });
  return { ok: true, status: 200,
    headers: entetes(sansEntete ? {} : { 'x-requests-remaining': String(20000 - utilise), 'x-requests-used': String(utilise), 'x-requests-last': String(facture) }),
    json: async () => JSON.parse(JSON.stringify(corps)), text: async () => JSON.stringify(corps) };
};
const AS = require('./alerte_solde');
AS.oddsEvenement = () => true;

const tm = require('./totaux_marche');
const pm = require('./prix_marche');
const cotes = require('./cotes');
const paris = require('./paris');
const imp = require('./paris_import');
const totauxAppels = () => appels.filter((a) => a.quoi === 'odds' && a.marches !== 'h2h');
const lisCat = () => JSON.parse(fs.readFileSync(path.join(BAC, 'paris_catalogue.json'), 'utf8')).matchs;
const parEv = (l, e) => l.find((m) => m.source && m.source.evenement === e);
const carnet = () => JSON.parse(fs.readFileSync(tm.fichier(), 'utf8'));
const ecritCarnet = (f) => { const c = carnet(); f(c); fs.writeFileSync(tm.fichier(), JSON.stringify(c)); };
const classes = () => { try { return JSON.parse(fs.readFileSync(path.join(BAC, 'odds_classes.json'), 'utf8')).jours[new Date().toISOString().slice(0, 10)] || {}; } catch (e) { return {}; } };
const FQ = path.join(BAC, 'odds_quota.json');
const poseDepense = (d) => { const q = JSON.parse(fs.readFileSync(FQ, 'utf8')); q.depenseDuJour = d; fs.writeFileSync(FQ, JSON.stringify(q)); };
const lot = (m, k) => m.marches && m.marches[k] && m.marches[k].cotes;
const MOIS = new Date().toISOString().slice(0, 7);

(async () => {
  /* le calendrier au prix du marche (h2h), comme en production */
  await imp.rafraichitPrix(['soccer_epl', 'soccer_france_ligue_one', 'soccer_spain_la_liga'], 'essai');
  await imp.importeMatchs();
  paris.charge();
  const REF0 = J(lisCat());
  const EPL = 'soccer_epl', L1 = 'soccer_france_ligue_one';
  const reset = (f) => ecritCarnet((c) => { c.ligues = {}; c.cloture = {}; c.essais = {}; c.credits = {}; if (f) f(c); });

  console.log('\n-- A. retour arriere : avecButs retire un total d avant --');
  {
    const m1 = parEv(lisCat(), 'e1');
    const vieux = Object.assign({}, m1, { butsMarche: { total: 3.1, t: new Date().toISOString(), ref: 'betfair', ligne: 2.5 } });
    ok(!('butsMarche' in imp.avecButs(vieux)), 'PARIS_TOTAUX_LIGUES vide : un butsMarche deja pose est retire (repli totalDe au prochain import)');
  }

  console.log('\n-- B. releve observee : rien a refaire ; planifie --');
  {
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    appels.length = 0;
    const v = await imp.rafraichitTotaux([EPL], 'essai');
    ok(totauxAppels().length === 1 && v === 0, `une releve OBSERVEE rend 0 (aucune cote a refaire) : ${v}`);
    reset((c) => { delete c.evenements.e1; });
    appels.length = 0;
    const a = imp.planifie(() => {}, () => false);
    await a.totaux();
    a.arrete();
    ok(totauxAppels().length === 1 && appels.filter((x) => x.quoi === 'events').length === 0, 'planifie().totaux() en observation : une releve, aucun import refait');
  }

  console.log('\n-- C. la regle : fenetre de 48 h, ecart de 12 h, plafond de 30, cles --');
  {
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    await imp.rafraichitTotaux([EPL], 'essai');
    const tr = carnet().ligues[EPL];
    ecritCarnet((c) => { delete c.evenements.e1; });
    ok(imp.totauxAReleve(tr + 7 * H).length === 0 && J(imp.totauxAReleve(tr + 13 * H)) === J([EPL]), 'e1 sans total : rien 7 h apres la releve, oui 13 h apres (ecart de 12 h)');
    reset((c) => { delete c.evenements.e3; });
    const e3 = Date.parse(EVENTS.soccer_epl[2].commence_time);
    ok(imp.totauxAReleve(e3 - 60 * H).length === 0 && J(imp.totauxAReleve(e3 - 40 * H)) === J([EPL]), 'e3 sans total : rien a 60 h du coup d envoi, oui a 40 h (fenetre de 48 h)');
    reset((c) => { delete c.evenements.e1; c.credits[MOIS] = { [EPL]: { regle: 30, cloture: 0, inconnus: 0 } }; });
    ok(imp.TOTAUX_PLAFOND_MOIS === 30 && imp.totauxAReleve().length === 0, 'plafond du mois : 30 credits, la valeur ecrite dans EXPLOITATION');
    reset((c) => { delete c.evenements.e1; });
    process.env.PARIS_TOTAUX_OBSERVE = L1;
    ok(!imp.totauxAReleve().includes(EPL), 'la Premier League non listee n est pas rendue par la regle');
    process.env.PARIS_TOTAUX_OBSERVE = EPL + ',soccer_germany_bundesliga';
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_germany_bundesliga'], 'a la main');
    ok(totauxAppels().length === 0, 'une cle listee mais absente d ODDS_API_LIGUES : 0 appel, meme demandee a la main');
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    ecritCarnet((c) => { delete c.evenements.e1; c.ligues = {}; });
    const e1d = Date.parse(EVENTS.soccer_epl[0].commence_time);
    ok(imp.totauxAReleve(e1d + H).length === 0, 'e1 commencee depuis 1 h, sans total : ne declenche pas de releve (e2 a un total frais)');
  }

  console.log('\n-- G. sans prix au catalogue : le p h2h vient du carnet du prix --');
  {
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    ecritCarnet((c) => { c.ligues = {}; });
    const fc = path.join(BAC, 'paris_catalogue.json'), brut = fs.readFileSync(fc, 'utf8');
    const j = JSON.parse(brut);
    for (const m of j.matchs) if (m.source && m.source.ligue === EPL) delete m.prixMarche;
    fs.writeFileSync(fc, JSON.stringify(j)); paris.charge();
    const m1 = parEv(paris.catalogue().matchs, 'e1');
    ok(m1 && !m1.prixMarche && imp.totauxAReleve().length === 0, 'rencontres sans prixMarche, totaux frais releves sur le meme 1-N-2 : rien a relever');
    /* et le 1-N-2 du carnet du prix sert toujours la garde : s'il a bouge de
       6 points depuis le releve du total, la releve est redemandee */
    ecritCarnet((c) => { const p = c.evenements.e1.pH2h; c.evenements.e1.pH2h = { 1: p[1] + 0.06, N: p.N - 0.06, 2: p[2] }; });
    ok(J(imp.totauxAReleve()) === J([EPL]), 'sans prixMarche au catalogue, le 1-N-2 du carnet du prix a bouge de 6 points : a relever');
    fs.writeFileSync(fc, brut); paris.charge();
  }

  console.log('\n-- I. un prix du marche range a l envers : pas de p h2h note --');
  {
    reset();
    const fp = pm.fichier(), brutP = fs.readFileSync(fp, 'utf8'), jp = JSON.parse(brutP);
    jp.evenements.e1 = Object.assign({}, jp.evenements.e1, { dom: 'Everton', ext: 'Arsenal' });
    fs.writeFileSync(fp, JSON.stringify(jp));
    await imp.rafraichitTotaux([EPL], 'essai');
    const ce = carnet().evenements;
    ok(ce.e1 && ce.e1.pH2h === null && ce.e2 && ce.e2.pH2h, 'e1 au carnet du prix sur les equipes inversees : total note sans p h2h (jamais servi), e2 normal');
    fs.writeFileSync(fp, brutP);
  }

  console.log('\n-- D. un delai : date ecrite, pas de rafale --');
  {
    const vraiST = global.setTimeout, vraiFetch = global.fetch;
    global.setTimeout = (f, ms, ...x) => vraiST(f, ms === 15000 ? 40 : ms, ...x);
    let tentatives = 0;
    global.fetch = async (url, o) => {
      const u = new URL(String(url));
      if (/\/odds/.test(u.pathname) && u.searchParams.get('markets') === 'totals') {
        tentatives++;
        return new Promise((res, rej) => { if (o && o.signal) o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
      }
      return vraiFetch(url, o);
    };
    try {
      reset();
      await imp.rafraichitTotaux([EPL], 'essai');
      await imp.rafraichitTotaux([EPL], 'essai');
    } finally { global.setTimeout = vraiST; global.fetch = vraiFetch; }
    ok(tentatives === 1 && carnet().ligues[EPL] > 0, `une releve abandonnee (delai) ecrit sa date : ${tentatives} tentative(s), pas deux`);
  }

  console.log('\n-- E. la vente : une rencontre commencee ne prend pas le total --');
  {
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    process.env.PARIS_TOTAUX_LIGUES = EPL;
    const m1 = parEv(lisCat(), 'e1');
    const servi = imp.avecButs(m1);
    const commencee = imp.avecButs(Object.assign({}, m1, { debut: new Date(Date.now() - 60000).toISOString() }));
    ok(servi.butsMarche && !commencee.butsMarche, 'un total frais sert a e1 a venir, pas a e1 commencee');
    delete process.env.PARIS_TOTAUX_LIGUES;
  }

  console.log('\n-- F. la cloture : fenetre, ecart, cles, mesure --');
  {
    EVENTS.soccer_epl.push(ev('e4', 'Brighton', 'Wolves', Date.now() + 50 * 60000));
    TOTALS = totauxDefaut();
    await imp.rafraichitPrix([EPL], 'essai');
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    await imp.importeMatchs(); paris.charge();
    const sauve = carnet();
    process.env.PARIS_TOTAUX_CLOTURE = '1';
    ok(J(imp.totauxCloture()) === J([EPL]), 'controle : e4 a 50 min, une cloture');
    ok(imp.totauxCloture(Date.now() - 60 * 60000).length === 0, 'e4 a 110 min : pas encore (borne de 75 min)');
    ok(imp.totauxCloture(Date.now() + 40 * 60000).length === 0, 'e4 a 10 min : trop tard (borne de 20 min)');
    ecritCarnet((c) => { c.cloture[EPL] = Date.now() - 90 * 60000; });
    ok(imp.totauxCloture().length === 0, 'une cloture il y a 90 min : pas de deuxieme avant 2 h');
    ecritCarnet((c) => { c.cloture = {}; });
    process.env.PARIS_TOTAUX_OBSERVE = L1;
    ok(imp.totauxCloture().length === 0, 'la Premier League non listee : aucune cloture rendue');
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    appels.length = 0;
    await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
    await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
    ok(totauxAppels().length === 1, 'rafraichitTotaux en cloture, deux fois de suite : un seul appel (2 h)');
    const o1 = tm.lisObs().entrees.e1;
    ok(!(o1 && o1.tCloture), 'e1 (a 30 h) n est pas mesure a la cloture de e4 (fenetre de 2 h)');
    const cloture = async (f, rep) => {
      fs.writeFileSync(tm.fichier(), JSON.stringify(sauve));
      ecritCarnet((c) => { c.cloture = {}; if (f) f(c); });
      if (rep) TOTALS.soccer_epl = () => totauxDefaut().soccer_epl().map((x) => (x.id === 'e4' ? Object.assign({}, x, { bookmakers: rep }) : x));
      else TOTALS = totauxDefaut();
      await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
      TOTALS = totauxDefaut();
      return tm.lisObs().entrees.e4 || {};
    };
    let o = await cloture();
    ok(o.strate === '<24h|2,5' && o.ombre, `controle : e4 mesuree, strate ${o.strate}`);
    o = await cloture((c) => { c.evenements.e4.t -= 30 * H; });
    ok(o.strate === '24-48h|2,5' && o.ombre, `un total de 30 h : strate 24-48h (${o.strate})`);
    o = await cloture((c) => { c.evenements.e4.ligne = 3.5; });
    ok(o.strate === '<24h|extrapolee', `un total releve sur la ligne 3,5 : strate extrapolee (${o.strate})`);
    o = await cloture((c) => { c.evenements.e4.t -= 49 * H; });
    ok(!o.ombre && o.raison === 'total trop vieux', `un total de 49 h : pas d ombre (${o.raison})`);
    o = await cloture((c) => { const p = c.evenements.e4.pH2h; c.evenements.e4.pH2h = { 1: p[1] + 0.06, N: p.N - 0.06, 2: p[2] }; });
    ok(!o.ombre && o.raison === '1-N-2 qui a bouge', `un 1-N-2 qui a bouge de 6 points : pas d ombre (${o.raison})`);
    o = await cloture((c) => { c.evenements.e4.dom = 'Autre equipe'; });
    ok(!o.ombre && o.raison === 'pas de total au carnet', `un total d un autre match : pas d ombre (${o.raison})`);
    o = await cloture(null, [tot('betfair_ex_eu', [[3.5, 3.1, 1.36]])]);
    ok(!o.ombre && o.raison === 'cloture hors ligne 2,5', `une cloture a la seule ligne 3,5 : pas jugee (${o.raison})`);
    delete process.env.PARIS_TOTAUX_CLOTURE;
  }

  console.log('\n-- H. retour arriere sur une rencontre conservee (calendrier du championnat en panne) --');
  {
    fs.writeFileSync(tm.fichier(), JSON.stringify(Object.assign(carnet(), { ligues: {}, cloture: {}, essais: {}, credits: {} })));
    TOTALS = totauxDefaut();
    await imp.rafraichitTotaux([EPL], 'essai');
    process.env.PARIS_TOTAUX_LIGUES = EPL;
    await imp.importeMatchs(); paris.charge();
    const avant = parEv(lisCat(), 'e1');
    delete process.env.PARIS_TOTAUX_LIGUES;
    const vraiFetch = global.fetch;
    global.fetch = async (url, o) => {
      const u = new URL(String(url));
      if (/\/sports\/soccer_epl\/events/.test(u.pathname)) return { ok: false, status: 500, headers: entetes({}), json: async () => ({ message: 'panne' }), text: async () => 'panne' };
      return vraiFetch(url, o);
    };
    try { await imp.importeMatchs(); paris.charge(); } finally { global.fetch = vraiFetch; }
    const apres = parEv(lisCat(), 'e1');
    ok(avant && avant.butsMarche && apres && !apres.butsMarche, 'la cle retiree : une rencontre conservee (calendrier en panne) perd son total au prochain import');
    /* cle VENDUE, calendrier en panne : une rencontre conservee que `habille`
       refuse (1-N-2 de 97 %, « trop desequilibre au prix du marche ») est
       gardee SUSPENDUE — sans dire qu'un total du marche a fait son prix ;
       cotee normalement, butsMarche le dit */
    process.env.PARIS_TOTAUX_LIGUES = EPL;
    const fp = pm.fichier(), brutP = fs.readFileSync(fp, 'utf8');
    const conserve = async (p) => {
      if (p) {
        const jp = JSON.parse(brutP);
        jp.evenements.e1 = Object.assign({}, jp.evenements.e1, { p });
        fs.writeFileSync(fp, JSON.stringify(jp));
        ecritCarnet((c) => { c.evenements.e1.pH2h = Object.assign({}, p); });
      }
      global.fetch = async (url, o) => {
        const u = new URL(String(url));
        if (/\/sports\/soccer_epl\/events/.test(u.pathname)) return { ok: false, status: 500, headers: entetes({}), json: async () => ({ message: 'panne' }), text: async () => 'panne' };
        return vraiFetch(url, o);
      };
      try { await imp.importeMatchs(); paris.charge(); } finally { global.fetch = vraiFetch; }
      return parEv(lisCat(), 'e1');
    };
    const cotee = await conserve(null);
    const refusee = await conserve({ 1: 0.97, N: 0.02, 2: 0.01 });
    fs.writeFileSync(fp, brutP);
    ok(cotee && cotee.butsMarche && cotee.butsMarche.grille > 0 && refusee && refusee.suspendu && !refusee.butsMarche,
      `cle vendue, rencontre conservee : cotee, butsMarche dit le total ; refusee par habille (suspendue : ${refusee && refusee.suspenduRaison}), butsMarche n est pas recopie`);
    delete process.env.PARIS_TOTAUX_LIGUES;
    await imp.importeMatchs(); paris.charge();
  }

  console.log('\n-- J. les trois garde-fous de la cloture et de l ecart que rien ne tenait --');
  {
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    process.env.PARIS_TOTAUX_CLOTURE = '1';
    TOTALS = totauxDefaut();
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');           // la regle : e4 a son total au carnet
    await imp.importeMatchs(); paris.charge();
    const fc = path.join(BAC, 'paris_catalogue.json'), brutC = fs.readFileSync(fc, 'utf8');
    const obsVide = () => fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: {} }));
    /* une rencontre FERMEE avant la cloture n'est pas mesuree */
    obsVide();
    const jc = JSON.parse(brutC);
    for (const m of jc.matchs) if (m.source && m.source.evenement === 'e4') m.ferme = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(fc, JSON.stringify(jc)); paris.charge();
    ecritCarnet((c) => { c.cloture = {}; });
    await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
    const ferme = tm.lisObs().entrees.e4;
    fs.writeFileSync(fc, brutC); paris.charge();
    obsVide();
    ecritCarnet((c) => { c.cloture = {}; });
    await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
    const ouverte = tm.lisObs().entrees.e4;
    ok(!(ferme && ferme.tCloture) && ouverte && ouverte.tCloture, 'e4 fermee avant la cloture : pas mesuree ; rouverte : mesuree');
    /* un prix du marche range sur les equipes inversees ne sert pas l'ombre */
    obsVide();
    const fp = pm.fichier(), brutP = fs.readFileSync(fp, 'utf8'), jp = JSON.parse(brutP);
    jp.evenements.e4 = Object.assign({}, jp.evenements.e4, { dom: 'Wolves', ext: 'Brighton' });
    fs.writeFileSync(fp, JSON.stringify(jp));
    ecritCarnet((c) => { c.cloture = {}; });
    await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
    const inv = tm.lisObs().entrees.e4 || {};
    fs.writeFileSync(fp, brutP);
    ok(inv.tCloture && inv.raison === 'pas de prix du marche frais' && !inv.ombre && !inv.ombreRefusee,
      `prix du marche de e4 sur les equipes inversees : pas d ombre (${inv.raison})`);
    /* ecartMaintenant ne compte pas un total de plus de 48 h */
    const avec = imp.etatTotaux().ligues[EPL].ecartMaintenant.avecTotal;
    ecritCarnet((c) => { c.evenements.e1.t -= 49 * H; });
    const sans = imp.etatTotaux().ligues[EPL].ecartMaintenant.avecTotal;
    ok(avec >= 2 && sans === avec - 1, `ecartMaintenant : e1 au total de 49 h ne compte plus (${avec} -> ${sans})`);
    reset();
  }

  console.log('\n-- K. la porte 2 range le type de reference sur le total VENDU, pas sur la cloture --');
  {
    TOTALS = totauxDefaut();
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');       // e4 : Betfair seul (la regle)
    ok(carnet().evenements.e4 && carnet().evenements.e4.ref === 'betfair' && carnet().evenements.e4.seul === true, 'controle : le total de e4 au carnet vient de Betfair seul');
    fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: {} }));
    TOTALS.soccer_epl = () => totauxDefaut().soccer_epl().map((x) => (x.id === 'e4' ? Object.assign({}, x, { bookmakers: [
      tot('pinnacle', [[2.5, 1.93, 1.93]]), tot('unibet_eu', [[2.5, 1.85, 1.95]]), tot('williamhill', [[2.5, 1.88, 1.92]])] }) : x));
    await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
    TOTALS = totauxDefaut();
    const o = tm.lisObs().entrees.e4 || {};
    ok(o.clo && o.clo.ref === 'pinnacle' && o.vente && o.vente.ref === 'betfair' && o.vente.seul === true && o.vente.ligne === 2.5 && o.vente.t,
      `le journal ecrit la reference du total VENDU (vente : ${J(o.vente)}) a cote de celle de la cloture (${o.clo && o.clo.ref})`);
    const M = tm.mesure(null).mesure;
    ok(M.parRef.betfairSeul.n === 1 && M.parRef.betfair.n === 1 && M.parRef.pinnacle.n === 0 && M.parRefCloture.pinnacle.n === 1 && M.parRefCloture.betfair.n === 0,
      'parRef se range sur la vente (Betfair seul : 1), parRefCloture sur la cloture (Pinnacle : 1)');
    ok(typeof o.dp === 'number' && o.dp < 0.005 && o.refusePar === null && o.ombre && o.strate === '<24h|2,5', `une rencontre jugee porte son dp (${o.dp})`);
  }

  console.log('\n-- L. la ligne d audit de DP_MAX et de l age --');
  {
    TOTALS = totauxDefaut();
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    const sauve = carnet();
    const cloture = async (f) => {
      fs.writeFileSync(tm.fichier(), JSON.stringify(sauve));
      ecritCarnet((c) => { c.cloture = {}; if (f) f(c); });
      fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: {} }));
      await imp.rafraichitTotaux([EPL], 'cloture', { cloture: true });
      return tm.lisObs().entrees.e4 || {};
    };
    let o = await cloture((c) => { const p = c.evenements.e4.pH2h; c.evenements.e4.pH2h = { 1: p[1] + 0.06, N: p.N - 0.06, 2: p[2] }; });
    ok(o.refusePar === 'dp' && Math.abs(o.dp - 0.06) < 1e-3 && o.ombreRefusee && !o.ombre && !o.strate,
      `1-N-2 qui a bouge de 6 points : refusee (dp ${o.dp}), l ombre qu on aurait vendue est gardee HORS des strates`);
    o = await cloture((c) => { c.evenements.e4.t -= 49 * H; });
    ok(o.refusePar === 'age' && o.ombreRefusee && !o.ombre && o.ageH > 48, `total de 49 h : refusee par l age (${o.ageH} h), ombre gardee a part`);
    /* la mesure juge les DEUX strates d'age quel que soit le reglage de vente :
       a PARIS_TOTAUX_AGE_MAX_H=24, un total de 30 h est mesure (24-48h), pas refuse */
    process.env.PARIS_TOTAUX_AGE_MAX_H = '24';
    o = await cloture((c) => { c.evenements.e4.t -= 30 * H; });
    delete process.env.PARIS_TOTAUX_AGE_MAX_H;
    ok(o.strate === '24-48h|2,5' && o.ombre && !o.refusePar, `vente coupee a 24 h : un total de 30 h reste mesure (${o.strate})`);
    o = await cloture((c) => { c.evenements.e4.pH2h = null; });
    ok(o.refusePar === 'sansPh2h' && o.raison === 'sans p h2h au releve' && o.dp === null && o.ombreRefusee && !o.ombre, 'sans p h2h au releve : refusee, dite, ombre a part');
    /* la mesure, a la main, sur un journal fixe */
    const now = Date.parse('2026-11-04T00:00:00Z'), J0 = '2026-10-01T00:00:00Z';
    const neutre = { plus: 1.8, moins: 1.9 }, gagne = { plus: 2.1, moins: 1.7 };
    const ent = (spec) => { const E = {}; spec.forEach((x, i) => { E['d' + i] = Object.assign({ ligue: EPL, debut: now - H, clo: { pPlus25: 0.5, ref: 'betfair', ligne: 2.5 }, vendu: neutre, tCloture: now }, x); }); return { entrees: E }; };
    const fait = (k, f) => Array.from({ length: k }, (_, i) => f(i));
    const G = (spec) => tm.mesure(null, now, ent(spec), { j0: J0 }).mesure.garde;
    let g = G(fait(10, () => ({ ombre: neutre, strate: '<24h|2,5', dp: 0.01 })).concat(fait(5, () => ({ ombre: neutre, strate: '<24h|2,5', dp: 0.03 })))
      .concat(fait(3, () => ({ ombreRefusee: neutre, refusePar: 'dp', dp: 0.07 }))).concat(fait(2, () => ({ ombreRefusee: neutre, refusePar: 'age', dp: 0 }))));
    ok(g.acceptees['[0 ; 0,02['].n === 10 && g.acceptees['[0,02 ; 0,05]'].n === 5 && g.refusees.dp.n === 3 && g.refusees.age.n === 2,
      'acceptees rangees par tranche de dp (10 sous 2 points, 5 de 2 a 5), refusees par cause (dp 3, age 2)');
    ok(Object.values(g.acceptees).concat(Object.values(g.refusees)).every((a) => a.conclut === false && /ne conclut pas/.test(a.pourquoi)) && /ne conclut pas/.test(g.lecture.join()),
      'sous 100 rencontres : aucune tranche ne conclut, et la lecture le dit');
    g = G(fait(100, (i) => ({ ombre: i < 2 ? gagne : neutre, strate: '<24h|2,5', dp: 0.03 })));
    ok(g.acceptees['[0,02 ; 0,05]'].conclut && /DP_MAX trop large/.test(g.lecture.join()), `100 acceptees a 2-5 points, 1 % battables : « ${g.lecture.join(' | ')} »`);
    g = G(fait(100, (i) => ({ ombreRefusee: neutre, vendu: i < 5 ? gagne : neutre, refusePar: 'dp', dp: 0.08 })));
    ok(g.refusees.dp.conclut && /DP_MAX trop strict/.test(g.lecture.join()), `100 refusees qui auraient tenu (0 % contre 2,5 % vendu) : « ${g.lecture.join(' | ')} »`);
    g = G(fait(100, (i) => ({ ombreRefusee: i < 3 ? gagne : neutre, refusePar: 'dp', dp: 0.08 })));
    ok(/la garde sert/.test(g.lecture.join()), 'des refusees qui n auraient pas tenu (1,5 %) : la garde sert');
    const gTot = tm.mesure(null, now, ent(fait(100, (i) => ({ ombreRefusee: i < 1 ? gagne : neutre, refusePar: 'dp', dp: 0.08 }))), { j0: J0 }).mesure;
    ok(gTot.n === 0 && Object.values(gTot.strates).every((s) => s.n === 0), 'les refusees n entrent JAMAIS dans les strates de vente');
    reset();
  }

  console.log('\n-- M. par championnat : une fuite prouvee, ou rien de prouve --');
  {
    const now = Date.parse('2026-11-02T00:00:00Z'), J0 = '2026-10-01T00:00:00Z';
    const neutre = { plus: 1.8, moins: 1.9 };
    const W = (k) => { const E = {}; for (let i = 0; i < 20; i++) E['w' + i] = { ligue: EPL, debut: now - H, clo: { pPlus25: 0.5, ref: 'betfair', ligne: 2.5 }, strate: '<24h|2,5', tCloture: now, vendu: neutre, ombre: i < k ? { plus: 2.1, moins: 1.7 } : neutre }; return { entrees: E }; };
    const m10 = tm.mesure(EPL, now, W(10), { j0: J0, j0Ligues: { [EPL]: J0 } }).mesure;
    ok(m10.fuite === true && /fuite prouvee/.test(m10.pourquoi) && m10.retenu === undefined, `10 issues battables sur 40 : fuite prouvee (${m10.pourquoi})`);
    const m1 = tm.mesure(EPL, now, W(1), { j0: J0, j0Ligues: { [EPL]: J0 } }).mesure;
    ok(m1.fuite === false && Math.abs(m1.wilsonBasOmbre - 0.004427) < 1e-5, `1 sur 40 : Wilson ${(100 * m1.wilsonBasOmbre).toFixed(2)} % < 0,5 %, rien de prouve`);
    ok(/n'en prouve pas l'absence/.test(m1.pourquoi) && Math.abs(m1.puissance3 - 0.338) < 0.005, `et ce n est pas un feu vert : ${m1.pourquoi}`);
    ok(Math.abs(tm.puissance(100, 0.03, 0.005) - 0.805) < 0.005, 'a 50 rencontres (100 issues), une fuite de 3 % est vue 80 % du temps');
  }

  console.log('\n-- N. ce qui ne declenche pas de releve --');
  {
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    TOTALS = totauxDefaut();
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    await imp.importeMatchs(); paris.charge();
    ecritCarnet((c) => { c.ligues = {}; delete c.evenements.e1; });
    ok(J(imp.totauxAReleve()) === J([EPL]), 'controle : e1 sans total, a 30 h : a relever');
    const fc = path.join(BAC, 'paris_catalogue.json'), brutC = fs.readFileSync(fc, 'utf8');
    const jc = JSON.parse(brutC);
    for (const m of jc.matchs) if (m.source && m.source.evenement === 'e1') m.ferme = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(fc, JSON.stringify(jc)); paris.charge();
    ok(imp.totauxAReleve().length === 0, 'e1 FERMEE (absente de la reponse des totaux) ne relance pas de releve toutes les 12 h');
    fs.writeFileSync(fc, brutC); paris.charge();
    /* sans p h2h aujourd'hui : seule l'absence d'un total frais declenche */
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    ecritCarnet((c) => { c.ligues = {}; });
    const fp = pm.fichier(), brutP = fs.readFileSync(fp, 'utf8'), jp = JSON.parse(brutP);
    const jc2 = JSON.parse(brutC);
    for (const m of jc2.matchs) if (m.source && m.source.ligue === EPL) delete m.prixMarche;
    for (const k of Object.keys(jp.evenements)) if (/^e\d$/.test(k)) delete jp.evenements[k];
    fs.writeFileSync(fc, JSON.stringify(jc2)); fs.writeFileSync(fp, JSON.stringify(jp)); paris.charge();
    ok(imp.totauxAReleve().length === 0, 'sans p h2h (suspendue, ou observee sans prix du marche), des totaux frais : rien a relever (avant : a chaque ecart de 12 h)');
    ecritCarnet((c) => { delete c.evenements.e2; });
    ok(J(imp.totauxAReleve()) === J([EPL]), 'sans p h2h, e2 sans total : a relever');
    fs.writeFileSync(fc, brutC); fs.writeFileSync(fp, brutP); paris.charge();
    reset();
  }

  console.log('\n-- P. PARIS_TOTAUX_AGE_MAX_H=0 : rien n est servi, l observation continue --');
  {
    process.env.PARIS_TOTAUX_OBSERVE = EPL;
    TOTALS = totauxDefaut();
    reset();
    await imp.rafraichitTotaux([EPL], 'essai');
    process.env.PARIS_TOTAUX_LIGUES = EPL;
    process.env.PARIS_TOTAUX_AGE_MAX_H = '0';
    await imp.importeMatchs(); paris.charge();
    ok(lisCat().every((m) => !m.butsMarche), 'cle vendue mais age max 0 : aucun total au catalogue');
    ok(/age max 0 h \(AUCUN total servi\)/.test(imp.ligneTotaux()), 'la ligne de demarrage le dit : ' + imp.ligneTotaux());
    ecritCarnet((c) => { c.ligues = {}; });
    ok(imp.totauxAReleve().length === 0, 'des totaux de moins de 48 h : la regle ne releve pas a chaque ecart de 12 h (elle garde ses 48 h)');
    delete process.env.PARIS_TOTAUX_AGE_MAX_H;
    await imp.importeMatchs(); paris.charge();
    ok(lisCat().some((m) => m.butsMarche && m.butsMarche.grille > 0), 'controle : a 48 h, la meme cle sert le total (avec `grille`)');
    const mv = paris.match(parEv(lisCat(), 'e1').id);
    ok(mv && mv.butsMarche && mv.butsMarche.grille === parEv(lisCat(), 'e1').butsMarche.grille && !('butsMarche' in paris.vue(mv)),
      'le validateur garde `grille` (le total qui a fait le prix), vue() ne le recopie pas');
    /* a 0 h, meme un total ecrit a cet instant n'est pas servi */
    const tq = Date.now() + 5000;
    tm.note([Object.assign(ev('z1', 'Zeta', 'Omega', tq + 30 * H), { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])] })], 'soccer_spain_la_liga', tq, { credits: 0 });
    process.env.PARIS_TOTAUX_AGE_MAX_H = '0';
    const z0 = tm.pour('z1', 'Zeta', 'Omega', tq);
    delete process.env.PARIS_TOTAUX_AGE_MAX_H;
    ok(z0 === null && tm.pour('z1', 'Zeta', 'Omega', tq) !== null, 'a 0 h, pour() ne sert pas un total de cet instant ; a 48 h, si');
    delete process.env.PARIS_TOTAUX_LIGUES;
    await imp.importeMatchs(); paris.charge();
    reset();
  }

  /* `ev` du banc ne porte pas de livres : `evb` les ajoute (tm.note direct) */
  const evb = (id, dom, ext, quand, b) => Object.assign(ev(id, dom, ext, quand), { bookmakers: b || [] });

  console.log('\n-- Q. J0 par championnat --');
  {
    fs.rmSync(tm.fichier(), { force: true });
    const t = Date.now();
    tm.note([evb('q1', 'Lyon', 'Monaco', t + 30 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], EPL, t - 40 * 86400000, { credits: 1 });
    tm.note([evb('q2', 'Getafe', 'Girona', t + 30 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], L1, t - 3 * 86400000, { credits: 1 });
    tm.note([evb('q1', 'Lyon', 'Monaco', t + 30 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], EPL, t - 86400000, { credits: 1 });
    const c = tm.lis();
    ok(c.j0 === new Date(t - 40 * 86400000).toISOString() && c.j0Ligues[EPL] === c.j0 && c.j0Ligues[L1] === new Date(t - 3 * 86400000).toISOString(),
      'j0 = la premiere releve de tous ; j0Ligues = la premiere de CHAQUE championnat, jamais deplacee');
    const couv = (L, k, total) => { const E = {}; for (let i = 0; i < total; i++) E['c' + i] = { ligue: L, debut: t - H, couv: { releves: 1, avecRef: i < k, ref: i < k ? 'pinnacle' : null, ligne: 2.5 } }; return { entrees: E }; };
    ok(tm.mesure(L1, t, couv(L1, 5, 20), c).couverture.porte === 'decision du proprietaire', 'Ligue 1 a 25 % apres 3 jours de SON observation : pas encore « retirer » (le J0 global a 40 jours)');
    ok(tm.mesure(EPL, t, couv(EPL, 5, 20), c).couverture.porte === 'retirer', 'Premier League a 25 % apres 40 jours : retirer');
    fs.rmSync(tm.fichier(), { force: true });
  }

  console.log('\n-- R. les minuteries des totaux ne tombent jamais sur l avant-match ni sur la periodique des prix --');
  {
    const vrai = global.setTimeout;
    const releve = (f) => { const d = []; global.setTimeout = (g, ms, ...a) => { d.push(ms); return vrai(g, ms, ...a); }; try { const p = imp.planifie(() => {}, () => false); p.arrete(); } finally { global.setTimeout = vrai; } return d; };
    delete process.env.PARIS_TOTAUX_OBSERVE; delete process.env.PARIS_TOTAUX_CLOTURE;
    const sans = releve();
    process.env.PARIS_TOTAUX_OBSERVE = EPL; process.env.PARIS_TOTAUX_CLOTURE = '1';
    const avec = releve();
    delete process.env.PARIS_TOTAUX_CLOTURE;
    const reste = avec.slice();
    for (const x of sans) { const i = reste.indexOf(x); if (i >= 0) reste.splice(i, 1); }
    const MIN = 60000;
    ok(J(reste.slice().sort((a, b) => a - b)) === J([7 * MIN, 20 * MIN]) && imp.TOTAUX_TIC_PREMIER_MS === 20 * MIN && imp.CLOTURE_TIC_DECALAGE_MS === 7 * MIN,
      `deux minuteries de plus : la cloture a 7 min, la regle a 20 min (${J(reste.map((x) => x / MIN))})`);
    /* sur 24 h, avec les delais RELEVES : la regle a d + 30k, la cloture a
       d' + 10 + 10k ; l'avant-match des prix a 15 + 10k (5 min puis toutes
       les 10), leur periodique a 30k */
    const ticks = (debut, pas) => { const s = new Set(); for (let x = debut; x <= 24 * 60; x += pas) s.add(x); return s; };
    const dRegle = Math.max(...reste) / MIN, dClot = Math.min(...reste) / MIN;
    const regle = ticks(dRegle, 30), clot = ticks(dClot + 10, 10), avant = ticks(15, 10), perio = ticks(30, 30);
    ok([...regle].every((x) => !avant.has(x) && !perio.has(x)) && [...clot].every((x) => !avant.has(x) && !perio.has(x) && !regle.has(x)),
      'aucun tic des totaux en meme temps qu un tic des prix, sur 24 h');
    ok([...regle].every((x) => [...avant].some((a) => a > x && a - x >= 5)), 'la regle precede l avant-match suivant de 5 min : son plus long tour (17 x 15 s) a fini');
  }

  console.log('\n-- S. references, carnet et journal : les bornes que rien ne tenait --');
  {
    fs.rmSync(tm.fichier(), { force: true });
    fs.rmSync(tm.fichierObs(), { force: true });
    const e = evb('e1', 'Arsenal', 'Everton', Date.now() + 30 * H);
    const autres = [tot('unibet_eu', [[2.5, 1.85, 1.95]]), tot('williamhill', [[2.5, 1.88, 1.92]]), tot('bwin', [[2.5, 1.9, 1.9]])];
    const s = 2 / 1.82;
    const r = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('pinnacle', [[2.5, 1.82, 1.82]])].concat(autres) }));
    ok(s > 1.08 && r && r.ref === 'mediane', `Pinnacle a somme ${s.toFixed(3)} > 1,08 n est pas la reference (${r && r.ref})`);
    const base = [tot('pinnacle', [[2.5, 1.93, 1.93]]), tot('unibet_eu', [[2.5, 1.85, 1.95]]), tot('williamhill', [[2.5, 1.88, 1.92]])];
    const med = base.map((b) => tm.totalDuLivre(b).total).sort((a, b) => a - b)[1];
    let bf = null;
    for (let q = 0.40; q < 0.95 && !bf; q += 0.0005) {
      const o = Math.round(100 / (q * 1.005)) / 100, u = Math.round(100 / ((1 - q) * 1.005)) / 100;
      const x = tm.totalDuLivre(tot('betfair_ex_eu', [[2.5, o, u]]));
      if (x && x.somme <= tm.SOMME_BOURSE && x.total - med > 0.32 && x.total - med < 0.4) bf = [o, u, x.total];
    }
    const rb = bf && tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, bf[0], bf[1]]])].concat(base) }));
    ok(bf && rb && rb.ref !== 'betfair' && tm.ECART_MAX === 0.25, `une bourse a ${bf ? (bf[2] - med).toFixed(2) : '?'} but de la mediane (entre 0,25 et 0,5) est ecartee (${rb && rb.ref})`);
    ok(tm.totalDuLivre(tot('betfair_ex_eu', [[2.5, 2.10, 2.10]])) === null, 'un livre dont la somme des inverses est sous 1 (2,10 / 2,10) n est pas lu');
    ok(tm.totalDuLivre(tot('pinnacle', [[2.5, 1.0, 12.0]])) === null && tm.juge({ plus: 1.0, moins: 3.0 }, 0.5) === null, 'une cote de 1,00 n est ni lue ni jugee');
    ok(tm.servable({ pH2h: { 1: 0.40, N: 0.30, 2: 0.30 } }, { 1: 0.37, N: 0.36, 2: 0.27 }) === false, 'le NUL a bouge de 6 points (1 et 2 de 3) : pas servi');
    ok(tm.ecartH2h({ pH2h: { 1: 0, N: 0.5, 2: 0.5 } }, { 1: 0.01, N: 0.5, 2: 0.49 }) === null, 'un p h2h hors de ]0 ; 1[ : on ne sait pas');
    const t = Date.now();
    tm.note([evb('e1', 'Arsenal', 'Everton', t + 30 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])]),
             evb('e0', 'Chelsea', 'Fulham', t - H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], EPL, t, { credits: 1 });
    const j0 = tm.lis().j0;
    tm.note([evb('l1', 'Lyon', 'Monaco', t + 30 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], L1, t + 1000, { credits: 1 });
    ok(!!tm.lis().evenements.e1 && tm.lis().j0 === j0, 'la reponse de la Ligue 1 n efface pas le total de la Premier League ; J0 ne bouge pas');
    tm.note([evb('e1', 'Arsenal', 'Everton', t + 30 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], EPL, t + 2000, { credits: 1 });
    ok(!!tm.lis().evenements.e0, 'un marche retire ne touche que les rencontres a venir (e0, commencee, garde son total)');
    tm.note([evb('far', 'Leeds', 'Wolves', t + 6 * 24 * H, [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])])], 'soccer_spain_la_liga', t + 3000, { credits: 1 });
    ok(!tm.lisObs().entrees.far, 'une rencontre a J+6 AVEC reference n entre pas dans la couverture (porte 1 : a 48 h ou moins)');
    tm.note([evb('s9', 'Getafe', 'Girona', t + 30 * H, [])], 'soccer_spain_la_liga', t + 4000, { credits: 1 });
    ok(tm.essaisDe('s9') === 1, 'un essai pour s9');
    tm.note([], 'soccer_spain_la_liga', t + 56 * H, { credits: 0 });
    ok(!tm.lis().essais.s9, 'l essai d une rencontre passee depuis plus d un jour est elague');
    const vieux = { ligue: EPL, dom: 'a', ext: 'b', debut: t - 61 * 86400000, couv: { releves: 1, avecRef: true } };
    fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: { vieux } }));
    tm.noteCloture('neuf', { ligue: EPL, dom: 'c', ext: 'd', debut: t + H, raison: 'essai' }, t);
    ok(!tm.lisObs().entrees.vieux && tm.lisObs().entrees.neuf, 'le journal oublie une rencontre de plus de 60 jours');
    const E = {};
    for (let i = 0; i < 5001; i++) E['o' + i] = { ligue: EPL, debut: t - i * 60000 };
    fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: E }));
    tm.noteCloture('neuf2', { ligue: EPL, dom: 'c', ext: 'd', debut: t + H, raison: 'essai' }, t);
    ok(Object.keys(tm.lisObs().entrees).length === 5000 && tm.OBS_MAX === 5000 && tm.OBS_JOURS === 60, 'le journal garde au plus 5 000 entrees');
  }

  console.log('\n-- T. la mesure : les verdicts des portes 1 et 2 --');
  {
    const now = Date.parse('2026-11-02T00:00:00Z');
    const couv = (k, total) => { const E = {}; for (let i = 0; i < total; i++) E['c' + i] = { ligue: EPL, debut: now - H, couv: { releves: 1, avecRef: i < k, ref: i < k ? 'pinnacle' : null, ligne: 2.5 } }; return { entrees: E }; };
    const p1 = (k, total, j0) => tm.mesure(EPL, now, couv(k, total), { j0, j0Ligues: { [EPL]: j0 } }).couverture.porte;
    ok(p1(14, 20, '2026-10-30T00:00:00Z') === 'passe', 'porte 1 : 70 % de 20 passe');
    ok(p1(12, 20, '2026-10-30T00:00:00Z') === 'decision du proprietaire', 'porte 1 : 60 % de 20, decision du proprietaire');
    ok(p1(5, 20, '2026-10-30T00:00:00Z') === 'decision du proprietaire', 'porte 1 : 25 % apres 3 jours, pas encore retirer');
    ok(p1(5, 20, '2026-09-20T00:00:00Z') === 'retirer', 'porte 1 : 25 % apres 6 semaines, retirer');
    const lot = (spec) => { const E = {}; spec.forEach((x, i) => { E['p' + i] = Object.assign({ ligue: EPL, debut: now - H, clo: { pPlus25: 0.5, ref: 'betfair', ligne: 2.5 }, strate: '<24h|2,5', tCloture: now }, x); }); return { entrees: E }; };
    const neutre = { plus: 1.8, moins: 1.9 };
    const S = (spec, t, j0) => tm.mesure(null, t, lot(spec), { j0 }).mesure.strates['<24h|2,5'];
    const fait = (f) => Array.from({ length: 100 }, (_, i) => f(i));
    const J0 = '2026-10-01T00:00:00Z';
    const a = S(fait((i) => ({ vendu: i < 5 ? { plus: 2.1, moins: 1.7 } : neutre, ombre: i < 2 ? { plus: 2.05, moins: 1.7 } : neutre })), now, J0);
    ok(a.conclut === true && a.partOmbre === 0.01 && a.passe === false, `partOmbre 1 % > 0,5 % : ne passe pas (${a.partOmbre}, ${a.passe})`);
    const b = S(fait(() => ({ vendu: neutre, ombre: neutre })), now, J0);
    ok(b.conclut === true && b.partOmbre === 0 && b.partVendu === 0 && b.passe === false, 'partOmbre = partVendu = 0 : pas « strictement mieux », ne passe pas');
    const g = S(fait((i) => ({ vendu: i < 2 ? { plus: 2.02, moins: 1.7 } : neutre, ombre: i < 1 ? { plus: 3.0, moins: 1.2 } : neutre })), now, J0);
    ok(g.conclut === true && g.partOmbre <= 0.005 && g.partOmbre < g.partVendu && g.gainFuteOmbre > g.gainFuteVendu && g.passe === false,
      'gain fute de l ombre au-dessus de celui du vendu : ne passe pas');
    const ok100 = fait((i) => ({ vendu: i < 5 ? { plus: 2.1, moins: 1.7 } : neutre, ombre: neutre }));
    ok(S(ok100, Date.parse('2026-10-20T00:00:00Z'), J0).conclut === false, 'J0 + 19 mais avant le 26/10 : ne conclut pas');
    ok(S(ok100, Date.parse('2026-10-27T00:00:00Z'), '2026-10-20T00:00:00Z').conclut === false, 'apres le 26/10 mais J0 + 7 : ne conclut pas');
    ok(S(ok100, Date.parse('2026-11-04T00:00:00Z'), '2026-10-20T00:00:00Z').conclut === true, 'J0 + 15 et apres le 26/10 : conclut');
    ok(S(ok100, Date.parse('2026-12-01T00:00:00Z'), null).conclut === false, 'sans J0 : ne conclut jamais');
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'totaux_gardes.test.js : ' + n + ' verifications OK'));
  if (rates) process.exitCode = 1;
})().catch((e) => { console.error('ECHEC', e); process.exitCode = 1; });
