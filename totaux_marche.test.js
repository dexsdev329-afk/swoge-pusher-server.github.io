'use strict';
/*
 * LE PLUS/MOINS 2,5 AU PRIX DES TOTAUX DU MARCHE — RELEVE, CARNET, BUDGET,
 * OBSERVATION, MESURE (lot 5 de la cle 20K, 10/10/2026).
 *
 * Ce lot est une OBSERVATION : PARIS_TOTAUX_OBSERVE, PARIS_TOTAUX_LIGUES et
 * PARIS_TOTAUX_CLOTURE sont vides par defaut, donc 0 credit et rien de vendu
 * ne change. L'essai tient ces promesses, chacune avec un garde-fou qui la
 * fait tomber s'il est retire (EXPLOITATION 8.8decies) :
 *  0. drapeaux vides : aucun appel, aucune minuterie, la ligne de demarrage
 *     le dit ;
 *  1. la reference : Betfair, sinon Pinnacle, sinon la mediane d'au moins
 *     trois livres ; lignes x,5 seulement ; garde de 0,25 but ; noms
 *     inconnus comptes ;
 *  3. le carnet : age (48 h), equipes, marche retire, reponse vide, elagage,
 *     ecriture ratee gardee en memoire, la cloture n'ecrit jamais un total ;
 *  4. le budget : 1 credit (totals seulement, jamais spreads), la regle 48 h /
 *     48 h / 12 h, essais plafonnes et comptes a 48 h seulement, plafond du
 *     mois, la classe (3 observee, 1 vendue, 2 cloture), jamais prioritaire,
 *     un championnat non liste ne coute rien, les credits du carnet sont
 *     ceux du fournisseur ;
 *  5. l'observation ne change RIEN au catalogue, octet pour octet, et l'etat
 *     dit la couverture et l'ecart du moment, egaux au calcul a la main ;
 *  6. la vente (cle de PARIS_TOTAUX_LIGUES) : aucune issue plus/moins gagnante
 *     au prix de reference ; 1-N-2 et dc inchanges ; total perime, ligne
 *     extrapolee ou 1-N-2 qui a bouge : rien ne change ;
 *  8. la cloture et la mesure : une releve par championnat et par 2 h dans
 *     la fenetre, rien sans le drapeau, la mesure egale le calcul a la main,
 *     et refuse de conclure sous l'echantillon ;
 *  9. la lecture gardee du carnet.
 * Aucun reseau : `fetch` est remplace par un faux fournisseur qui facture
 * marches x regions, comme la doc (https://the-odds-api.com/liveapi/guides/v4/).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'totaux-'));
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

  console.log('\n-- 0. drapeaux vides : rien n est releve, rien n est paye --');
  {
    appels.length = 0;
    ok(imp.totauxAReleve().length === 0 && imp.totauxCloture().length === 0, 'aucun championnat a relever, aucune cloture');
    await imp.rafraichitTotaux(['soccer_epl', 'soccer_france_ligue_one'], 'essai');
    await imp.rafraichitTotaux(['soccer_epl'], 'essai', { cloture: true });
    ok(totauxAppels().length === 0 && !fs.existsSync(tm.fichier()), 'rafraichitTotaux sur des cles non listees : 0 appel, aucun carnet');
    ok(/vendu sur 0, observe sur 0, cloture non, age max 48 h/.test(imp.ligneTotaux()), 'la ligne de demarrage le dit : ' + imp.ligneTotaux());
    const a = imp.planifie(() => {}, () => false);
    const nb = a.minuteries.length;
    a.arrete();
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_epl';
    const b = imp.planifie(() => {}, () => false);
    ok(b.minuteries.length === nb + 1, `aucune minuterie des totaux sans liste (${nb}), une avec PARIS_TOTAUX_OBSERVE (${b.minuteries.length})`);
    b.arrete();
    delete process.env.PARIS_TOTAUX_OBSERVE;
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_*, basketball_nba';
    ok(imp.totauxAReleve().length === 0 && /IGNORE.*soccer_\*.*basketball_nba/.test(imp.ligneTotaux()), 'un joker ou une cle hors football ne releve rien, et c est dit');
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_germany_bundesliga';
    ok(imp.totauxAReleve().length === 0 && /absente\(s\) des ligues importees.*soccer_germany_bundesliga/.test(imp.ligneTotaux()), 'une cle absente d ODDS_API_LIGUES : jamais relevee, dit au demarrage');
    delete process.env.PARIS_TOTAUX_OBSERVE;
  }

  console.log('\n-- 1. la reference --');
  {
    const e = EVENTS.soccer_epl[0];
    const base = [tot('pinnacle', [[2.5, 1.93, 1.93]]), tot('unibet_eu', [[2.5, 1.85, 1.95]]), tot('williamhill', [[2.5, 1.88, 1.92]])];
    const r1 = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])].concat(base) }));
    ok(r1 && r1.ref === 'betfair' && r1.ligne === 2.5, 'la bourse Betfair d abord');
    const p = cotes.probasImplicites({ plus: 1.95, moins: 1.95 }, ['plus', 'moins'], 1).plus;
    ok(Math.abs(r1.pPlus25 - p) < 1e-9 && Math.abs(cotes.plusDeLigne(r1.total, 2.5) - p) < 1e-9, `ligne 2,5 : pPlus25 = la proba sans marge (${p.toFixed(4)})`);
    ok(tm.referenceDe(Object.assign({}, e, { bookmakers: base })).ref === 'pinnacle', 'sans Betfair, Pinnacle');
    const med = tm.referenceDe(Object.assign({}, e, { bookmakers: base.slice(1).concat([tot('bwin', [[2.5, 1.9, 1.9]])]) }));
    ok(med && med.ref === 'mediane' && med.ligne === 2.5 && med.livres25 === 3, 'sans l un ni l autre, la mediane d au moins trois livres a 2,5 (ligne 2,5)');
    const medMixte = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('unibet_eu', [[2.5, 1.85, 1.95]]), tot('bwin', [[3.5, 3.0, 1.38]]), tot('williamhill', [[1.5, 1.3, 3.4]])] }));
    ok(medMixte && medMixte.ref === 'mediane' && medMixte.ligne === null, 'trois livres sur des lignes differentes : mediane, ligne null (extrapolee)');
    ok(tm.referenceDe(Object.assign({}, e, { bookmakers: base.slice(1) })) === null, 'deux livres ordinaires : null');
    const st = {};
    const quart = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('pinnacle', [[2.25, 1.9, 1.95], [2.75, 2.3, 1.62]]), tot('betfair_ex_eu', [[3, 2.6, 1.55]])] }), st);
    ok(quart === null && st.quartSeul === true && st.lignes['2.25'] === 1 && st.lignes['3'] === 1, 'un livre qui n offre que 2,25 / 2,75 / 3 est ignore, compte quartSeul, lignes vues comptees');
    const fige = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.45, 2.9]])].concat(base) }));
    ok(fige && fige.ref === 'pinnacle', `une bourse a plus de 0,25 but de la mediane est ecartee (Betfair ${tm.totalDuLivre(tot('betfair_ex_eu', [[2.5, 1.45, 2.9]])).total.toFixed(2)} contre ${tm.totalDuLivre(base[0]).total.toFixed(2)})`);
    const proche = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.85, 2.05]])].concat(base) }));
    ok(proche && proche.ref === 'betfair' && proche.ecart <= tm.ECART_MAX, 'a moins de 0,25 but, la bourse reste la reference');
    const seul = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.95, 1.95]])] }));
    ok(seul && seul.ref === 'betfair' && seul.seul === true, 'Betfair seul (pas de mediane) : dit `seul`');
    const st2 = {};
    const noms = tm.referenceDe(Object.assign({}, e, { bookmakers: [{ key: 'betfair_ex_eu', markets: [{ key: 'totals', outcomes: [
      { name: 'Over 2.5', price: 1.9, point: 2.5 }, { name: 'Under 2.5', price: 1.9, point: 2.5 }] }] }] }), st2);
    ok(noms === null && st2.nomsInconnus === 2, 'un nom d issue autre que Over / Under est ignore et compte (nomsInconnus)');
    const l35 = tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[3.5, 3.1, 1.36]])] }));
    ok(l35 && l35.ligne === 3.5 && Math.abs(l35.pPlus25 - cotes.plusDeLigne(l35.total, 2.5)) < 1e-12, 'ligne 3,5 : pPlus25 = plusDeLigne(T, 2,5)');
    const proche25 = tm.totalDuLivre(tot('pinnacle', [[1.5, 1.25, 4.0], [2.5, 1.9, 1.95], [3.5, 3.2, 1.35]]));
    ok(proche25 && proche25.ligne === 2.5, 'plusieurs lignes x,5 chez un livre : la plus proche de 2,5');
    ok(tm.referenceDe(Object.assign({}, e, { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.85, 1.85]])] })) === null, 'une bourse dont la somme des inverses depasse 1,06 n est pas une reference');
  }

  console.log('\n-- 5. l observation ne change rien au catalogue, et l etat dit ce qu elle mesure --');
  {
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_epl';
    appels.length = 0;
    ok(J(imp.totauxAReleve()) === J(['soccer_epl']), 'la Premier League a des rencontres a 48 h sans total : a relever');
    await imp.rafraichitTotaux(imp.totauxAReleve(), 'essai');
    const ta = totauxAppels();
    ok(ta.length === 1 && ta[0].marches === 'totals' && ta[0].regions === 'eu' && ta[0].cout === 1, `une releve, markets=totals, region eu : 1 credit (${J(ta)})`);
    ok(fs.existsSync(tm.fichier()) && carnet().evenements.e1 && carnet().evenements.e2, 'le carnet est ecrit (e1 Betfair, e2 Pinnacle)');
    ok(carnet().evenements.e1.pH2h && Math.abs(carnet().evenements.e1.pH2h[1] - pm.pour('e1').p[1]) < 1e-12, 'le carnet garde le p h2h du prix du marche au moment du releve');
    ok((classes()[3] || {}).depense === 1, 'une cle observee paie en classe 3');
    await imp.importeMatchs();
    paris.charge();
    ok(J(lisCat()) === REF0, 'le catalogue (marches, cotes, cotesGenerees, suspendu) est IDENTIQUE octet pour octet a celui d un import sans totaux');
    const etat = imp.etatImport().totaux;
    const L = etat.ligues.soccer_epl;
    ok(L && L.observe === true && L.vendu === false && L.releve, 'etatImport().totaux : observe, pas vendu, date de releve');
    /* a la main : e1 et e2 vus a 48 h ou moins, tous deux avec une reference (e3 est a J+6) */
    ok(L.couverture.rencontres === 2 && L.couverture.avecRef === 2 && L.couverture.part === 1 && L.couverture.betfair === 1 && L.couverture.pinnacle === 1 && L.couverture.ligne25 === 2,
      `couverture : ${L.couverture.avecRef}/${L.couverture.rencontres} = ${L.couverture.part}, betfair 1, pinnacle 1, ligne 2,5 : 2`);
    ok(L.couverture.porte === 'ne conclut pas' && /moins de 20 : ne conclut pas/.test(L.couverture.pourquoi), 'porte 1 : 2 rencontres, ne conclut pas — ' + L.couverture.pourquoi);
    ok(L.dernierCompte && L.dernierCompte.lignes['2.5'] === 6 && L.dernierCompte.livresParLigneMax === 1, 'le dernier compte dit les lignes vues par livre (6 a 2,5) et le nombre max de lignes par livre (1)');
    /* l'ecart du moment, a la main */
    let issues = 0, batt = 0;
    for (const e of ['e1', 'e2']) {
      const m = parEv(lisCat(), e), c = lot(m, 'ou25'), pp = carnet().evenements[e].pPlus25;
      for (const [i, q] of [['plus', pp], ['moins', 1 - pp]]) { issues++; if (c[i] * q > 1) batt++; }
    }
    ok(L.ecartMaintenant.issues === issues && L.ecartMaintenant.battables === batt && L.ecartMaintenant.avecTotal === 2,
      `ecartMaintenant = le calcul a la main : ${batt} battable(s) sur ${issues} issues ou25 vendues (${J(L.ecartMaintenant.pire)})`);
    ok(/ne conclut pas/.test(L.ecartMaintenant.pourquoi), 'et refuse de conclure sur 2 rencontres');
    ok(etat.credits.total === 1 && etat.credits.parLigue.soccer_epl.regle === 1, 'les credits du mois : 1 (x-requests-last)');
    ok(cotes.etatButs().depuisDemarrage.totalMarche === 0, 'aucune grille n a pris le total du marche (COMPTE.totalMarche = 0)');
  }

  console.log('\n-- 4. le budget --');
  {
    appels.length = 0;
    ok(imp.totauxAReleve().length === 0, 'releve il y a un instant : rien avant 12 h');
    const garde = carnet();
    ecritCarnet((c) => { delete c.evenements.e1; });
    ok(imp.totauxAReleve().length === 0 && J(imp.totauxAReleve(T0 + 13 * H)) === J(['soccer_epl']),
      'meme si e1 a perdu son total : pas avant 12 h ; 13 h apres, oui');
    fs.writeFileSync(tm.fichier(), JSON.stringify(garde));
    await imp.rafraichitTotaux(['soccer_epl'], 'essai');
    ok(totauxAppels().length === 0, 'meme demande a la main par la minuterie : jamais deux fois en 12 h (0 appel)');
    ok(imp.totauxAReleve(T0 + 13 * H).length === 0, '13 h plus tard : e1 et e2 ont un total frais, e3 est a plus de 48 h — rien');
    ok(tm.essaisDe('e3') === 0, 'e3 (a J+6) sans reference ne compte PAS d essai : les livres n ont pas encore ouvert');
    ok(J(imp.totauxAReleve(T0 + 4.6 * 24 * H)) === J(['soccer_epl']), 'a J-1,4, e3 n a toujours pas de total : la regle le releve (le compteur ne s est pas epuise a J+6)');
    /* les essais d'une rencontre sans reference a 48 h : deux, puis plus rien */
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_epl,soccer_france_ligue_one';
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    ok(tm.essaisDe('l1') === 1, 'Lyon-Monaco a 30 h, sans livre de totaux : un essai');
    ecritCarnet((c) => { c.ligues.soccer_france_ligue_one -= 13 * H; });
    ok(imp.totauxAReleve().includes('soccer_france_ligue_one'), '13 h plus tard : encore a relever');
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    ok(tm.essaisDe('l1') === 2, 'deux essais');
    ecritCarnet((c) => { c.ligues.soccer_france_ligue_one -= 13 * H; });
    ok(!imp.totauxAReleve().includes('soccer_france_ligue_one'), `apres ${imp.TOTAUX_ESSAIS_MAX} releves sans reference : plus rien ne se declenche`);
    ok(totauxAppels().filter((a) => a.ligue === 'soccer_france_ligue_one').length === 2, 'deux appels, pas un de plus');
    /* le plafond du mois */
    ecritCarnet((c) => { c.ligues.soccer_epl -= 13 * H; c.credits[MOIS].soccer_epl.regle = imp.TOTAUX_PLAFOND_MOIS; delete c.evenements.e1; });
    ok(!imp.totauxAReleve().includes('soccer_epl'), `plafond du mois atteint (${imp.TOTAUX_PLAFOND_MOIS} credits) : plus de releve, meme sans total`);
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_epl'], 'essai');
    ok(totauxAppels().length === 0, 'et rafraichitTotaux le refuse aussi');
    ecritCarnet((c) => { c.credits[MOIS].soccer_epl.regle = 1; });
    ok(imp.totauxAReleve().includes('soccer_epl'), 'sous le plafond : e1 sans total, on releve');
    /* le 1-N-2 qui a bouge : la releve est redemandee */
    await imp.rafraichitTotaux(['soccer_epl'], 'essai');
    ecritCarnet((c) => { c.ligues.soccer_epl -= 13 * H; c.evenements.e2.pH2h = { 1: c.evenements.e2.pH2h[1] + 0.06, N: c.evenements.e2.pH2h.N - 0.06, 2: c.evenements.e2.pH2h[2] }; });
    ok(imp.totauxAReleve().includes('soccer_epl'), 'le 1-N-2 a bouge de 6 points depuis le releve du total : la releve est redemandee');
    ecritCarnet((c) => { c.evenements.e2.pH2h = { 1: c.evenements.e2.pH2h[1] - 0.06 + 0.04, N: c.evenements.e2.pH2h.N + 0.06 - 0.04, 2: c.evenements.e2.pH2h[2] }; });
    ok(!imp.totauxAReleve().includes('soccer_epl'), 'de 4 points : non');
    /* un championnat non liste ne coute rien */
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_spain_la_liga'], 'essai');
    ok(totauxAppels().length === 0, 'La Liga n est pas listee : 0 appel');
    /* les credits du carnet = ceux du fournisseur */
    const c = carnet().credits[MOIS];
    const paye = appels.length; void paye;
    const parLigue = (l) => (c[l] ? c[l].regle + c[l].cloture : 0);
    ok(parLigue('soccer_france_ligue_one') === 2, 'les credits du carnet sont les x-requests-last : Ligue 1, 2');
    sansEntete = true;
    ecritCarnet((x) => { x.ligues.soccer_france_ligue_one -= 13 * H; x.essais = {}; });
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    sansEntete = false;
    const c2 = carnet().credits[MOIS].soccer_france_ligue_one;
    ok(c2.regle === 3 && c2.inconnus === 1, 'un en-tete absent compte le cout attendu par prudence (le plafond ne se perce pas)');
    /* une releve partie mais ratee (422) : date et cout ecrits, pas de rafale */
    ecritCarnet((x) => { x.ligues.soccer_france_ligue_one -= 13 * H; x.essais = {}; });
    PANNE_TOTAUX.add('soccer_france_ligue_one');
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    PANNE_TOTAUX.delete('soccer_france_ligue_one');
    const c3 = carnet().credits[MOIS].soccer_france_ligue_one;
    ok(totauxAppels().length === 1 && c3.echecs === 1 && c3.regle === 4 && !imp.totauxAReleve().includes('soccer_france_ligue_one'),
      'une releve ratee (422, sans en-tete) : un seul appel, la date et le cout attendu sont ecrits — pas de rafale toutes les 30 min');
    /* la classe : 3 observee refusee quand 1 et 2 passent ; jamais prioritaire */
    const q = imp.etatQuota(), part = imp.partDuJour(q.reste);
    ecritCarnet((x) => { x.ligues.soccer_france_ligue_one -= 13 * H; x.essais = {}; });
    poseDepense(part - 120);
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    ok(totauxAppels().length === 0 && (classes()[3] || {}).refus >= 1, `part du jour ${part}, ${part - 120} deja depenses : la releve observee (classe 3, reserve 160) est refusee`);
    process.env.PARIS_TOTAUX_LIGUES = 'soccer_france_ligue_one';
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    ok(totauxAppels().length === 1 && (classes()[1] || {}).appels >= 1, 'la meme cle VENDUE passe en classe 1');
    delete process.env.PARIS_TOTAUX_LIGUES;
    poseDepense(part);
    ecritCarnet((x) => { x.ligues.soccer_france_ligue_one -= 13 * H; x.essais = {}; });
    process.env.PARIS_TOTAUX_LIGUES = 'soccer_france_ligue_one';
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_france_ligue_one'], 'essai');
    await imp.rafraichitPrix(['soccer_epl'], 'essai');
    ok(totauxAppels().length === 0 && appels.filter((a) => a.marches === 'h2h').length === 1,
      'part du jour atteinte : les totaux (meme vendus) sont refuses, le prix h2h vendu (classe 0, prioritaire) passe');
    delete process.env.PARIS_TOTAUX_LIGUES;
    poseDepense(0);
    ok(appels.concat(totauxAppels()).every((a) => a.quoi !== 'odds' || a.marches === 'h2h' || a.marches === 'totals'), 'jamais de spreads : markets=totals, toujours');
  }

  console.log('\n-- 3. le carnet --');
  {
    const L = 'soccer_epl', t = Date.now();
    const evs = TOTALS.soccer_epl();
    tm.note(evs, L, t, { credits: 1 });
    ok(tm.pour('e1', 'Arsenal', 'Everton', t) && tm.pour('e1', 'Everton', 'Arsenal', t), 'le total vaut dans les deux sens (il ne depend pas de l orientation)');
    ok(tm.pour('e1', 'Arsenal', 'Chelsea', t) === null, 'les equipes d un autre match : null');
    ok(tm.pour('e1', 'Arsenal', 'Everton', t + 49 * H) === null && tm.pour('e1', 'Arsenal', 'Everton', t + 47 * H), 'un total de plus de 48 h n est pas servi, de 47 h oui');
    const r = tm.note([evs[0]], L, t + 1000, { credits: 1 });
    ok(r.retires === 1 && tm.pour('e2', 'Chelsea', 'Liverpool', t + 1000) === null, 'une rencontre a venir absente d une reponse non vide perd son total (marche retire)');
    const avant = Object.keys(tm.lis().evenements).length;
    tm.note([], L, t + 2000, { credits: 0 });
    ok(Object.keys(tm.lis().evenements).length === avant, 'une reponse VIDE n efface rien : c est une panne, pas un retrait');
    const sans = Object.assign({}, evs[0], { bookmakers: [] });
    const r2 = tm.note([sans], L, t + 3000, { credits: 1 });
    ok(r2.retires === 1 && tm.pour('e1', 'Arsenal', 'Everton', t + 3000) === null, 'une rencontre sans reference perd son total');
    tm.note(evs, L, t - 11 * 86400000, { credits: 1 });
    tm.note([Object.assign({}, evs[0])], 'soccer_france_ligue_one', t, { credits: 1 });
    ok(!tm.lis().evenements.e2, 'elagage : un total de plus de 10 jours disparait du carnet');
    /* la cloture n'ecrit jamais un total, mais en efface un */
    tm.note(evs, L, t, { credits: 1 });
    const t1 = tm.lis().evenements.e1.t;
    const nouveau = Object.assign({}, ev('e9', 'Brentford', 'Burnley', t + 40 * H), { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.9, 2.0]])] });
    const cl = tm.note([evs[0], nouveau], L, t + 5000, { cloture: true, credits: 1 });
    ok(!tm.lis().evenements.e9 && tm.lis().evenements.e1.t === t1 && cl.refs.e9 && cl.refs.e1, 'une cloture n ecrit JAMAIS dans evenements (ni neuf, ni rafraichi) ; elle rend ses references');
    ok(!tm.lis().evenements.e2, 'mais elle efface une rencontre absente de sa reponse (marche retire) : e2 n a plus de total');
    ok(tm.derniereCloture(L) === t + 5000 && tm.derniere(L) === t, 'la date de cloture est a part de celle de la regle');
    /* une ecriture ratee : la date reste en memoire, la releve n'est pas repayee */
    const f = tm.fichier();
    fs.mkdirSync(f + '.tmp');
    const t2 = Date.now() + 20 * H;
    tm.note(evs, 'soccer_spain_la_liga', t2, { credits: 1 });
    fs.rmdirSync(f + '.tmp');
    ok(tm.derniere('soccer_spain_la_liga') === t2, 'ecriture ratee : la date de releve vit en memoire (le carnet ne l a pas)');
  }

  console.log('\n-- 6. la vente : une cle de PARIS_TOTAUX_LIGUES --');
  {
    /* la reference du moment : le prix h2h a ete releve depuis REF0 (section 4) */
    TOTALS = totauxDefaut();
    ecritCarnet((c) => { c.ligues.soccer_epl = 0; c.credits = {}; });
    await imp.rafraichitTotaux(['soccer_epl'], 'essai');
    await imp.importeMatchs(); paris.charge();
    const REF1 = J(lisCat());
    delete process.env.PARIS_TOTAUX_OBSERVE;
    process.env.PARIS_TOTAUX_LIGUES = 'soccer_epl';
    ecritCarnet((c) => { c.ligues.soccer_epl = 0; });
    appels.length = 0;
    await imp.rafraichitTotaux(['soccer_epl'], 'essai');
    ok((classes()[1] || {}).appels >= 1, 'la releve d une cle vendue part en classe 1');
    await imp.importeMatchs();
    paris.charge();
    const cat = lisCat(), ref = JSON.parse(REF1);
    let pire = -1, vendues = 0;
    for (const e of ['e1', 'e2']) {
      const m = parEv(cat, e), c = lot(m, 'ou25'), r = tm.pour(e, m.domicile, m.exterieur);
      if (!m.butsMarche) continue;
      vendues++;
      pire = Math.max(pire, c.plus * r.pPlus25, c.moins * (1 - r.pPlus25));
    }
    ok(vendues === 2 && pire <= 1, `au total du marche : aucune issue plus/moins gagnante au prix de reference (meilleure cote x p = ${pire.toFixed(3)})`);
    ok(['e1', 'e2'].every((e) => J(lot(parEv(cat, e), '1n2')) === J(lot(parEv(ref, e), '1n2')) && J(lot(parEv(cat, e), 'dc')) === J(lot(parEv(ref, e), 'dc'))),
      'le 1-N-2 et la double chance sont ceux de l import sans totaux');
    ok(['e1', 'e2'].every((e) => J(lot(parEv(cat, e), 'ou25')) !== J(lot(parEv(ref, e), 'ou25'))), 'le plus/moins, lui, descend du total du marche');
    ok(J(parEv(cat, 'e3')) === J(parEv(ref, 'e3')) && J(parEv(cat, 'l1')) === J(parEv(ref, 'l1')), 'e3 (sans total) et la Ligue 1 (non listee) : inchangees');
    const b = parEv(cat, 'e1').butsMarche;
    ok(b && b.ref === 'betfair' && b.ligne === 2.5 && b.total > 0 && b.t, 'butsMarche est ecrit dans paris_catalogue.json (d ou vient le total, et de quand)');
    const mm = paris.match(parEv(cat, 'e1').id);
    ok(mm.butsMarche && mm.butsMarche.total === b.total && !('butsMarche' in paris.vue(mm)), 'garde par le validateur, jamais recopie dans paris.vue()');
    ok(cotes.etatButs().depuisDemarrage.totalMarche > 0, 'COMPTE.totalMarche le dit');
    /* perime, extrapole, 1-N-2 qui a bouge : rien ne change */
    const sauve = carnet();
    const essaie = async (f, m) => {
      fs.writeFileSync(tm.fichier(), JSON.stringify(sauve));
      ecritCarnet(f);
      await imp.importeMatchs(); paris.charge();
      const x = parEv(lisCat(), 'e1');
      ok(!x.butsMarche && J(x.marches) === J(parEv(ref, 'e1').marches), m);
    };
    await essaie((c) => { c.evenements.e1.t -= 49 * H; }, 'un total de 49 h : les lots de e1 sont ceux d avant, octet pour octet');
    await essaie((c) => { c.evenements.e1.ligne = 3.5; }, 'une ligne de reference 3,5 (extrapolee, strate non mesuree) : pas vendue');
    await essaie((c) => { c.evenements.e1.pH2h = { 1: c.evenements.e1.pH2h[1] - 0.06, N: c.evenements.e1.pH2h.N + 0.06, 2: c.evenements.e1.pH2h[2] }; },
      'le 1-N-2 a bouge de 6 points depuis le releve : pas servi');
    await essaie((c) => { c.evenements.e1.pH2h = null; }, 'sans p h2h au releve : on ne sait pas, pas servi');
    fs.writeFileSync(tm.fichier(), JSON.stringify(sauve));
    process.env.PARIS_TOTAUX_LIGUES = '';
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_epl';
    await imp.importeMatchs(); paris.charge();
    ok(J(lisCat()) === REF1, 'retour arriere : la cle retiree de PARIS_TOTAUX_LIGUES, le catalogue redevient celui d avant, octet pour octet');
    const sansPrix = imp.avecButs(Object.assign({}, parEv(JSON.parse(REF1), 'e1'), { prixMarche: undefined }));
    ok(!sansPrix.butsMarche, 'avecButs sans prix du marche servi : rien');
  }

  console.log('\n-- 8. la cloture et la mesure --');
  {
    /* une rencontre dans 50 min, au prix du marche */
    EVENTS.soccer_epl.push(ev('e4', 'Brighton', 'Wolves', Date.now() + 50 * 60000));
    TOTALS = totauxDefaut();
    await imp.rafraichitPrix(['soccer_epl'], 'essai');
    ecritCarnet((c) => { c.ligues.soccer_epl = 0; c.cloture = {}; });
    await imp.rafraichitTotaux(['soccer_epl'], 'essai');      // la regle : le total de e4 au carnet
    await imp.importeMatchs(); paris.charge();
    ok(imp.totauxCloture().length === 0, 'PARIS_TOTAUX_CLOTURE absent : aucune cloture, meme a 50 min d un coup d envoi');
    process.env.PARIS_TOTAUX_CLOTURE = '1';
    ok(J(imp.totauxCloture()) === J(['soccer_epl']), 'avec PARIS_TOTAUX_CLOTURE=1 : la Premier League a une rencontre dans 20 a 75 min');
    const avantE = J(carnet().evenements);
    appels.length = 0;
    TOTALS.soccer_epl = () => totauxDefaut().soccer_epl().map((x) => (x.id === 'e4' ? Object.assign({}, x, { bookmakers: [tot('betfair_ex_eu', [[2.5, 1.80, 2.10]])] }) : x));
    await imp.rafraichitTotaux(imp.totauxCloture(), 'cloture', { cloture: true });
    ok(totauxAppels().length === 1 && (classes()[2] || {}).appels >= 1, 'une releve de cloture, en classe 2');
    ok(J(carnet().evenements) === avantE, 'la cloture n a rien ecrit dans le total vendu');
    ok(imp.totauxCloture().length === 0, 'jamais deux clotures du meme championnat en 2 h');
    const o = tm.lisObs().entrees.e4;
    ok(o && o.clo && o.clo.ref === 'betfair' && o.vendu && o.ombre && o.strate === '<24h|2,5', `la rencontre est mesuree : cloture, cote vendue, cote de l ombre, strate ${o && o.strate}`);
    const m4 = parEv(lisCat(), 'e4');
    ok(o && J(o.vendu) === J({ plus: lot(m4, 'ou25').plus, moins: lot(m4, 'ou25').moins }), 'vendu = la cote ou25 du catalogue a l instant de la cloture');
    const pm4 = pm.pour('e4').p, e4 = carnet().evenements.e4;
    const ombre = cotes.marchesDuMarche('foot', pm4, undefined, 'soccer_epl', { total: e4.total }).ou25.cotes;
    ok(o && J(o.ombre) === J({ plus: ombre.plus, moins: ombre.moins }), 'ombre = ce qu on vendrait au total du carnet (marchesDuMarche)');
    ok(cotes.etatButs().ombre.totalMarche >= 1, 'et l ombre compte dans etatButs().ombre');
    delete process.env.PARIS_TOTAUX_CLOTURE;
    /* la mesure sur des donnees fixees : a la main */
    const E = {};
    /* `ref` : la reference du total VENDU (vente) ; la cloture est toujours
       Betfair ici, pour que le rangement par reference ne puisse pas la
       confondre avec celle de la vente */
    const fixe = (id, ligue, strate, vendu, ombre, p, ref) => { E[id] = { ligue, dom: 'A' + id, ext: 'B' + id, debut: Date.now() - H, clo: { pPlus25: p, ref: 'betfair', seul: false, ligne: 2.5 },
      vente: { ref: ref || 'pinnacle', seul: false, ligne: 2.5 }, vendu, ombre, strate, tCloture: Date.now() - 2 * H }; };
    fixe('x1', 'soccer_epl', '<24h|2,5', { plus: 2.10, moins: 1.70 }, { plus: 1.80, moins: 1.95 }, 0.50);   // vendu : plus battable (1,05), ombre : rien
    fixe('x2', 'soccer_epl', '<24h|2,5', { plus: 1.50, moins: 2.30 }, { plus: 1.70, moins: 2.00 }, 0.55);   // vendu : moins 2,30 x 0,45 = 1,035 ; ombre : rien
    fixe('x3', 'soccer_epl', '24-48h|2,5', { plus: 1.80, moins: 1.90 }, { plus: 2.05, moins: 1.70 }, 0.50); // vendu : rien ; ombre : plus 1,025
    fixe('x4', 'soccer_france_ligue_one', '<24h|extrapolee', { plus: 1.75, moins: 1.95 }, { plus: 1.75, moins: 1.95 }, 0.52, 'mediane');
    fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: E }));
    const M = tm.mesure(null, Date.now(), null, tm.lis()).mesure;
    ok(M.n === 4 && M.issuesVendu === 8 && M.battVendu === 2 && M.battOmbre === 1, `poolee : n 4, vendu 2/8, ombre 1/8 (${M.battVendu}/${M.issuesVendu}, ${M.battOmbre}/${M.issuesOmbre})`);
    const gv = ((2.10 * 0.5 - 1) + (2.30 * 0.45 - 1)) / 4, go = (2.05 * 0.5 - 1) / 4;
    ok(Math.abs(M.gainFuteVendu - gv) < 1e-12 && Math.abs(M.gainFuteOmbre - go) < 1e-12, `gain fute (esperance a la cloture) : vendu ${M.gainFuteVendu.toFixed(4)}, ombre ${M.gainFuteOmbre.toFixed(4)} — le calcul a la main`);
    ok(M.strates['<24h|2,5'].n === 2 && M.strates['24-48h|2,5'].n === 1 && M.strates['<24h|extrapolee'].n === 1, 'stratifiee par age du total et ligne de vente');
    ok(Object.values(M.strates).every((s) => s.conclut === false && s.passe === null && /ne conclut pas/.test(s.pourquoi)), 'sous 100 rencontres par strate : ne conclut pas, et le dit');
    const apres = Math.max(Date.parse(tm.lis().j0) + 15 * 86400000, Date.parse('2026-10-27T00:00:00Z'));
    const Mt = tm.mesure(null, apres, null, tm.lis()).mesure;
    ok(Mt.dateOk === true && Object.values(Mt.strates).every((s) => s.conclut === false && /< 100 rencontres/.test(s.pourquoi)), 'meme apres la date : sous 100 rencontres, aucune strate ne conclut');
    ok(M.parRef.pinnacle.n === 3 && M.parRef.mediane.n === 1 && M.parRef.betfair.n === 0 && M.parRefCloture.betfair.n === 4,
      'le type de reference se range sur celle du total VENDU (pinnacle 3, mediane 1), celle de la cloture en second axe (betfair 4)');
    const ML = tm.mesure('soccer_epl', Date.now(), null, tm.lis()).mesure;
    ok(ML.n === 3 && ML.fuite === null && /< 20 rencontres avec cloture : ne conclut pas/.test(ML.pourquoi), 'par championnat sous 20 rencontres : ne conclut pas');
    /* 100 rencontres dans une strate, apres la date : la porte se juge */
    const F = {};
    for (let i = 0; i < 100; i++) F['y' + i] = { ligue: 'soccer_epl', debut: Date.now() - H, clo: { pPlus25: 0.5, ref: 'betfair', ligne: 2.5 },
      vendu: i < 5 ? { plus: 2.1, moins: 1.7 } : { plus: 1.8, moins: 1.9 }, ombre: { plus: 1.8, moins: 1.95 }, strate: '<24h|2,5', tCloture: Date.now() };
    fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: F }));
    const tard = Math.max(Date.parse(tm.lis().j0) + 15 * 86400000, Date.parse('2026-10-27T00:00:00Z'));
    const S = tm.mesure(null, tard, null, tm.lis()).mesure.strates['<24h|2,5'];
    ok(S.conclut === true && S.passe === true && S.partOmbre === 0 && S.battVendu === 5, '100 rencontres, apres J0 + 14 et le 26/10 : la strate conclut (ombre 0 %, vendu 5 issues) et passe');
    const S2 = tm.mesure(null, Date.parse(tm.lis().j0) + 86400000, null, tm.lis()).mesure.strates['<24h|2,5'];
    ok(S2.conclut === false && /ne conclut pas/.test(S2.pourquoi), 'les memes 100 rencontres avant J0 + 14 : ne conclut pas (la date glisse, jamais le seuil)');
    fs.writeFileSync(tm.fichierObs(), JSON.stringify({ entrees: {} }));
    /* etatImport lit le journal UNE fois */
    const lire = fs.readFileSync;
    let lectures = 0;
    fs.readFileSync = function (f, ...a) { if (String(f) === tm.fichierObs()) lectures++; return lire.call(fs, f, ...a); };
    process.env.PARIS_TOTAUX_OBSERVE = 'soccer_epl,soccer_france_ligue_one';
    try { imp.etatImport(); } finally { fs.readFileSync = lire; }
    ok(lectures === 1, `etatImport lit le journal d observation une fois (${lectures}) pour deux championnats`);
  }

  console.log('\n-- 9. la lecture gardee du carnet --');
  {
    const t = Date.now();
    const c = carnet();
    for (let i = 0; i < 750; i++) c.evenements['g' + i] = { t, ref: 'betfair', total: 2.7, ligne: 2.5, pPlus25: 0.5, pH2h: null, ligue: 'soccer_epl', dom: 'D' + i, ext: 'X' + i, debut: t + 20 * H };
    fs.writeFileSync(tm.fichier(), JSON.stringify(c));
    const vieux = new Date(Date.now() - 10000);
    fs.utimesSync(tm.fichier(), vieux, vieux);
    const lire = fs.readFileSync;
    let lectures = 0, panne = false;
    fs.readFileSync = function (f, ...a) {
      if (String(f) === tm.fichier()) { lectures++; if (panne) { const e = new Error('EIO simule'); e.code = 'EIO'; throw e; } }
      return lire.call(fs, f, ...a);
    };
    try {
      let trouves = 0;
      for (let i = 0; i < 400; i++) if (tm.pour('g' + (i % 750), 'D' + (i % 750), 'X' + (i % 750), t)) trouves++;
      ok(trouves === 400 && lectures <= 1, `400 lectures de vente sur un carnet de 750 rencontres : ${lectures} lecture du fichier`);
      /* une lecture ratee n'est pas gardee */
      const v2 = new Date(Date.now() - 9000);
      fs.utimesSync(tm.fichier(), v2, v2);
      panne = true;
      ok(tm.pour('g1', 'D1', 'X1', t) === null, 'lecture ratee (EIO) : rien a vendre');
      panne = false;
      lectures = 0;
      ok(tm.pour('g1', 'D1', 'X1', t) !== null && lectures === 1, 'et elle n est PAS gardee : la suivante relit le fichier');
      /* un fichier de moins de 2 s se relit */
      fs.writeFileSync(tm.fichier(), JSON.stringify(c));
      lectures = 0;
      tm.pour('g1', 'D1', 'X1', t); tm.pour('g2', 'D2', 'X2', t); tm.pour('g3', 'D3', 'X3', t);
      ok(lectures === 3, `un fichier ecrit il y a moins de 2 s se relit a chaque fois (${lectures})`);
    } finally { fs.readFileSync = lire; }
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'totaux_marche.test.js : ' + n + ' verifications OK'));
  if (rates) process.exitCode = 1;
})().catch((e) => { console.error('ECHEC', e); process.exitCode = 1; });
