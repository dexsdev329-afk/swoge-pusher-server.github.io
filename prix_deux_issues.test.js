'use strict';
/*
 * LES SPORTS A DEUX ISSUES AU PRIX DU MARCHE — EN OBSERVATION (lot 3, 10/10/2026).
 *
 * ---- pourquoi ----
 *
 * NHL, NFL, NBA et tennis se vendent a l'Elo : le 09/10, 15 issues sur 70
 * battables face a DraftKings (21,4 %, borne basse de Wilson 13,4 %). Avant de
 * les vendre au marche, on les OBSERVE (PARIS_PRIX_OBSERVE) ; la bascule sera
 * une variable (PARIS_PRIX_LIGUES). Ce lot ne vend rien de plus. L'essai tient
 * donc d'abord des REFUS :
 *  1. la reference a deux issues : Betfair, puis Pinnacle, puis la mediane ;
 *     p somme 1 sur {1, 2}, sans « N » ; un Betfair a plus de 5 points de la
 *     mediane est ecarte ;
 *  2. un livre qui cote un nul sur un sport a deux issues n'est JAMAIS la
 *     reference (il vend le temps reglementaire ; notre reglement compte la
 *     prolongation et les tirs au but) — G1 ;
 *  3. sans sport connu, rien n'est note, et rien n'est PAYE : une cle sans
 *     sport, ou une cle cricket, coute 0 credit a t comme a t + 30 min — G2,
 *     G11, G12 ;
 *  4. une cle observee coute 1 credit, et la rencontre reste a l'Elo, ouverte ;
 *  5. l'observation n'est jamais prioritaire : jour charge, elle est refusee
 *     sans alerte, la vente passe — G3 ;
 *  6. la cadence : une cle observee suit PARIS_PRIX_OBSERVE_H (12 h), jamais
 *     plus serree que la vente — G4 ;
 *  7. le joker : tennis_atp_* / tennis_wta_* seulement, jamais un `_winner`,
 *     jamais une cle sans rencontre — G5 ;
 *  8. la bascule simulee : au prix du marche + 10 %, aucune issue gagnante,
 *     un seul marche ; sans prix frais, suspendue ; la porte de vente
 *     (paris.ouvert) ferme aussi un tournoi vendu par joker — G6 ; le tennis
 *     ne bascule JAMAIS (aucun verrou d'heure reelle) : pose dans
 *     PARIS_PRIX_LIGUES, il n'est ni releve ni note, il reste suspendu — G17 ;
 *  9. le reglement : un score egal au hockey est refuse ;
 * 10. PARIS_ELO_ENGAGEMENT_MAX : vide, rien ne change ; pose, il plafonne les
 *     seules rencontres cotees a l'Elo ; invalide, il est ignore — G14.
 * Ajouts des mutations du 10/10 (garde-fous qu'aucun essai ne tenait) : le
 * journal des releves lit les trois sources sur deux issues (§1) ;
 * l'etalonnage note la cle observee avec son sport et garde sa releve (§4bis) ;
 * etatPrix, `--prix` et prixInconnues suivent le joker (§7) ; le demarrage
 * dit le joker refuse et le plafond Elo, pris ou ignore (§12).
 * Un echec s'ecrit RATE ; la derniere ligne donne RATES : n/total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'deux-issues-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-essai';
process.env.ODDS_API_FIN = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,nhl=icehockey_nhl,nfl=americanfootball_nfl,tennis=*';
process.env.ODDS_API_HORIZON = '7';
process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
process.env.PARIS_PRIX_RELEVE_H = '2';

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok  ' + m); else { rates++; console.log('RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
const proche = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

const H = 3600000, MIN = 60000, J = 86400000;
const DEMAIN = Date.now() + 2 * J;
const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('e1', 'Arsenal', 'Ipswich Town', DEMAIN)],
  icehockey_nhl: [ev('h1', 'Boston Bruins', 'Toronto Maple Leafs', DEMAIN), ev('h2', 'Edmonton Oilers', 'Los Angeles Kings', DEMAIN + 3 * H)],
  americanfootball_nfl: [ev('n1', 'Atlanta Falcons', 'Baltimore Ravens', DEMAIN + H)],
  tennis_atp_shanghai_masters: [ev('t1', 'Cristina Bucsa', 'Iva Jovic', DEMAIN + 2 * H)],
  tennis_atp_shanghai_masters_winner: [],
  tennis_wta_wuhan: [],
};
const SPORTS = [{ key: 'tennis_atp_shanghai_masters', group: 'Tennis', active: true },
                { key: 'tennis_atp_shanghai_masters_winner', group: 'Tennis', active: true },
                { key: 'tennis_wta_wuhan', group: 'Tennis', active: true },
                { key: 'soccer_epl', group: 'Soccer', active: true }];
const trois = (key, e, c1, cn, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
const deux = (key, e, c1, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: e.away_team, price: c2 }] }] });
const avec = (e, livres) => Object.assign({}, e, { bookmakers: livres });
const E = (l, i) => EVENTS[l][i];
const ODDS = {
  soccer_epl: () => [avec(E('soccer_epl', 0), [trois('betfair_ex_eu', E('soccer_epl', 0), 1.12, 10.5, 30), trois('pinnacle', E('soccer_epl', 0), 1.11, 10.0, 26),
    trois('unibet_eu', E('soccer_epl', 0), 1.09, 9.0, 21), trois('williamhill', E('soccer_epl', 0), 1.10, 9.5, 23)])],
  icehockey_nhl: () => [
    avec(E('icehockey_nhl', 0), [deux('betfair_ex_eu', E('icehockey_nhl', 0), 1.95, 1.97), deux('pinnacle', E('icehockey_nhl', 0), 1.92, 1.96),
      deux('unibet_eu', E('icehockey_nhl', 0), 1.90, 1.95), deux('williamhill', E('icehockey_nhl', 0), 1.91, 1.93)]),
    avec(E('icehockey_nhl', 1), [deux('pinnacle', E('icehockey_nhl', 1), 1.55, 2.55), deux('unibet_eu', E('icehockey_nhl', 1), 1.53, 2.50),
      deux('williamhill', E('icehockey_nhl', 1), 1.54, 2.48)]),
  ],
  americanfootball_nfl: () => [avec(E('americanfootball_nfl', 0), [deux('pinnacle', E('americanfootball_nfl', 0), 2.30, 1.67),
    deux('unibet_eu', E('americanfootball_nfl', 0), 2.25, 1.65), deux('bwin', E('americanfootball_nfl', 0), 2.28, 1.64)])],
  tennis_atp_shanghai_masters: () => [avec(E('tennis_atp_shanghai_masters', 0), [deux('pinnacle', E('tennis_atp_shanghai_masters', 0), 3.10, 1.40),
    deux('unibet_eu', E('tennis_atp_shanghai_masters', 0), 3.00, 1.38), deux('bwin', E('tennis_atp_shanghai_masters', 0), 3.05, 1.39)])],
};
const appels = [];
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (/espn\.com$/.test(u.hostname)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: [] }) };
  if (u.origin !== 'https://api.the-odds-api.com') throw new Error('reseau interdit : ' + u.origin);
  const m = u.pathname.match(/^\/v4\/sports(?:\/([^/]+)\/(\w+))?$/);
  const ligue = m && m[1], quoi = m && m[2];
  let corps = [], cout = 0;
  if (!ligue) corps = SPORTS;
  else if (quoi === 'events') corps = EVENTS[ligue] || [];
  else if (quoi === 'odds') {
    corps = ODDS[ligue] ? ODDS[ligue]() : [];
    /* « markets x regions », et une reponse vide ne coute rien (doc du fournisseur) */
    if (corps.length) cout = u.searchParams.get('markets').split(',').length * u.searchParams.get('regions').split(',').length;
  }
  appels.push({ ligue, quoi, cout });
  const total = appels.reduce((t, a) => t + a.cout, 0);
  const h = { 'x-requests-remaining': String(20000 - total), 'x-requests-used': String(total), 'x-requests-last': String(cout) };
  return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
           json: async () => JSON.parse(JSON.stringify(corps)), text: async () => JSON.stringify(corps) };
};

const AS = require('./alerte_solde');
const alertes = [];
AS.oddsEvenement = (...a) => { alertes.push(a); return true; };
const pm = require('./prix_marche');
const prixLigues = require('./prix_ligues');
const cotes = require('./cotes');
const paris = require('./paris');
const imp = require('./paris_import');
const obs = require('./prix_observe');
const pj = require('./prix_journal');
const { Game } = require('./game');
const cfg = require('./config');
const { ethers } = require('ethers');

const credits = () => appels.reduce((t, a) => t + a.cout, 0);
const oddsDepuis = (k) => appels.slice(k).filter((a) => a.quoi === 'odds').map((a) => a.ligue).join(',');
const FQ = path.join(BAC, 'odds_quota.json');
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const poseQuota = (reste, depense) => fs.writeFileSync(FQ, JSON.stringify({ reste, utilise: 20000 - reste, vu: null, depenseDuJour: depense, jour: aujourdhui() }));
const NHL = ['1', '2'];
const parEv = (e) => paris.catalogue().matchs.find((m) => m.source && m.source.evenement === e);
const importe = async () => { await imp.importeMatchs(); paris.charge(); };

(async () => {
  poseQuota(20000, 0);
  await importe();

  console.log('\n-- 1. la reference a deux issues --');
  {
    const e = E('icehockey_nhl', 0);
    const base = [deux('pinnacle', e, 1.92, 1.96), deux('unibet_eu', e, 1.90, 1.95), deux('williamhill', e, 1.91, 1.93)];
    const r1 = pm.referenceDe(avec(e, [deux('betfair_ex_eu', e, 1.95, 1.97)].concat(base)), NHL);
    eq(r1 && r1.ref, 'betfair', 'la bourse saine (1,95 / 1,97, somme 1,02) est la reference');
    ok(r1 && !('N' in r1.p) && Math.abs(r1.p[1] + r1.p[2] - 1) < 1e-9, 'p somme 1 sur {1, 2}, sans cle N');
    eq((pm.referenceDe(avec(e, base), NHL) || {}).ref, 'pinnacle', 'sans Betfair, Pinnacle');
    eq((pm.referenceDe(avec(e, base.slice(1).concat([deux('bwin', e, 1.89, 1.97)])), NHL) || {}).ref, 'mediane', 'sans l un ni l autre, la mediane de trois livres');
    eq(pm.referenceDe(avec(e, base.slice(1)), NHL), null, 'deux livres ordinaires : pas de prix, on ne devine pas');
    const fige = pm.referenceDe(avec(e, [deux('betfair_ex_eu', e, 1.70, 2.35)].concat(base)), NHL);
    eq(fige && fige.ref, 'pinnacle', 'un Betfair a plus de 5 points de la mediane est ecarte (prix fige ou marche mince)');
    const c = pm.note(ODDS.icehockey_nhl(), 'icehockey_nhl', undefined, { quoi: 'essai', sport: 'nhl' });
    ok(c.betfair === 1 && c.pinnacle === 1 && c.issues === 2 && c.nul === 0, `note avec le sport : une reference par rencontre, deux issues (${JSON.stringify(c)})`);
    eq(Object.keys(pm.lis().evenements.h1.p).sort().join(','), '1,2', 'le carnet garde p sur {1, 2}');
    ok(pm.pour('h2') && Math.abs(pm.pour('h2').p[1] + pm.pour('h2').p[2] - 1) < 2e-5, 'pour() rend le prix a deux issues, somme 1');
    /* Le journal des releves (lot 1) lit Betfair, Pinnacle et la mediane avec
       les issues du SPORT (pm.issuesDe) : sans elles, toute ligne NHL, NFL,
       NBA ou tennis perdait ses trois sources (null), et cela ne se serait vu
       qu'a la mesure hors serveur (mutations du 10/10). */
    const l = pj.ligneDe({ t: Date.now(), ligue: 'icehockey_nhl', sport: 'nhl', quoi: 'essai', evs: ODDS.icehockey_nhl(),
                           refs: [{ id: 'h1', debut: DEMAIN, ref: 'betfair', p: { 1: 0.5, 2: 0.5 }, livres: 4 }] });
    const x = l.e[0];
    ok(Array.isArray(x[4]) && Array.isArray(x[5]) && Array.isArray(x[6]) && x[4][0] > 0 && x[5][0] > 0 && x[6][0] > 0,
       `journal NHL : Betfair, Pinnacle et la mediane lus sur deux issues (${JSON.stringify(x.slice(4, 7))})`);
    eq(l.s, 'nhl', 'et la ligne porte son sport');
  }

  console.log('\n-- 2. un livre a nul n est jamais la reference d un sport a deux issues (G1) --');
  {
    const e = E('icehockey_nhl', 0);
    const ordinaires = [deux('unibet_eu', e, 1.90, 1.95), deux('williamhill', e, 1.91, 1.93), deux('bwin', e, 1.89, 1.97)];
    const st = { nul: 0 };
    const r = pm.referenceDe(avec(e, [trois('pinnacle', e, 2.30, 4.2, 2.45)].concat(ordinaires)), NHL, st);
    eq(r && r.ref, 'mediane', 'un Pinnacle a trois prix (Draw) sur la NHL n est jamais la reference : la mediane des livres a deux prix');
    eq(st.nul, 1, 'et il est compte (nul = 1)');
    const st2 = { nul: 0 };
    eq(pm.referenceDe(avec(e, [trois('betfair_ex_eu', e, 2.4, 4.3, 2.5)].concat(ordinaires)), NHL, st2).ref, 'mediane', 'une bourse a trois prix non plus');
    const tie = { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: e.home_team, price: 2.3 }, { name: 'Tie', price: 4.2 }, { name: e.away_team, price: 2.45 }] }] };
    const st3 = { nul: 0 };
    eq(pm.referenceDe(avec(e, [tie].concat(ordinaires)), NHL, st3).ref, 'mediane', 'trois prix sans le mot « Draw » : ecarte aussi (exactement deux prix exiges)');
    eq(st3.nul, 1, 'et compte');
    pm.note([avec(e, [trois('pinnacle', e, 2.30, 4.2, 2.45)].concat(ordinaires))], 'icehockey_nhl', undefined, { sport: 'nhl' });
    const cv = pm.lis().couverture.icehockey_nhl;
    ok(cv && cv.nul === 1 && cv.mediane === 1 && cv.issues === 2, `couverture.nul = 1 au carnet (${JSON.stringify(cv)})`);
    const ex = ev('hx', 'Boston Bruins', 'Edmonton Oilers', DEMAIN + 5 * H);
    const tousNul = [avec(ex, [trois('pinnacle', ex, 2.3, 4.2, 2.45), trois('unibet_eu', ex, 2.25, 4.0, 2.4), trois('bwin', ex, 2.28, 4.1, 2.4)])];
    const ca = pm.note(tousNul, 'icehockey_nhl', undefined, { sport: 'nhl' });
    ok(ca.aucun === 1 && ca.nul === 3, `si tous les livres cotent un nul : aucune reference (${JSON.stringify(ca)})`);
    eq(pm.lis().evenements.hx, undefined, 'et rien n entre au carnet');
    /* le football : un livre SANS nul reste ecarte (non-regression) */
    const f = E('soccer_epl', 0);
    eq(pm.referenceDe(avec(f, [deux('pinnacle', f, 1.2, 9), deux('unibet_eu', f, 1.21, 8.8), deux('bwin', f, 1.19, 9.1)])), null,
       'au football, un livre sans nul reste ecarte (trois issues exigees)');
  }

  console.log('\n-- 3. sans sport connu, rien n est note ni paye (G2, G11, G12) --');
  {
    pm.note(ODDS.icehockey_nhl(), 'icehockey_nhl', undefined, { sport: 'nhl' });
    const avant = fs.readFileSync(pm.fichier(), 'utf8');
    const c = pm.note(ODDS.icehockey_nhl(), 'icehockey_nhl');
    ok(c.sportInconnu === true && c.aucun === 2 && c.betfair === 0 && c.pinnacle === 0, `note(evs, icehockey_nhl) sans sport : rien (${JSON.stringify(c)})`);
    ok(fs.readFileSync(pm.fichier(), 'utf8') === avant, 'le carnet est intact, octet pour octet (ni prix, ni date, ni couverture)');
    const cs = pm.note(ODDS.soccer_epl(), 'soccer_epl');
    ok(cs.betfair === 1 && !cs.sportInconnu && !('nul' in cs) && !('issues' in cs), `note(evs, soccer_epl) sans sport : comme avant le lot (${JSON.stringify(cs)})`);
    ok(pm.pour('e1') && pm.pour('e1').p.N > 0, 'le football garde ses trois issues');
    eq(pm.note(ODDS.icehockey_nhl(), 'cricket_odi', undefined, { sport: 'cricket' }).sportInconnu, true, 'une cle cricket ne se note jamais, meme avec son sport');
    /* une cle sans sport (absente d'ODDS_API_LIGUES) et une cle cricket, avec
       une rencontre retenue au catalogue : 0 credit, a t et a t + 30 min */
    const brut = JSON.parse(fs.readFileSync(path.join(BAC, 'paris_catalogue.json'), 'utf8'));
    const modele = brut.matchs.find((m) => m.source && m.source.ligue === 'icehockey_nhl');
    const clone = (id, ligue) => Object.assign(JSON.parse(JSON.stringify(modele)), { id, source: Object.assign({}, modele.source, { ligue, evenement: 'ev-' + id }) });
    brut.matchs.push(clone('obs-euro-1', 'basketball_euroleague'), clone('obs-cric-1', 'cricket_odi'));
    fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify(brut));
    paris.charge();
    process.env.PARIS_PRIX_OBSERVE = 'basketball_euroleague,cricket_odi';
    const c0 = credits(), k0 = appels.length;
    const p1 = imp.prixPerimes();
    ok(p1.includes('basketball_euroleague'), 'la cle sans sport est perimee (aucune date ecrite)');
    ok(!p1.includes('cricket_odi'), 'la cle cricket n est meme pas a relever (G12)');
    await imp.rafraichitPrix(p1.filter((k) => !/^soccer_|^icehockey|^american|^tennis/.test(k)), 'periodique', pm.releveMs());
    await imp.rafraichitPrix(['cricket_odi'], 'periodique', 0);
    eq(credits() - c0, 0, 'a t : 0 credit');
    ok(imp.prixPerimes(Date.now() + 30 * MIN).includes('basketball_euroleague'), 'a t + 30 min elle est encore « perimee »');
    await imp.rafraichitPrix(['basketball_euroleague', 'cricket_odi'], 'periodique', pm.releveMs());
    eq(credits() - c0, 0, 'a t + 30 min : toujours 0 credit (G11)');
    eq(oddsDepuis(k0), '', 'aucun appel /odds pour elles');
    eq(imp.sportDeLaCle('basketball_euroleague'), null, 'sportDeLaCle : null hors d ODDS_API_LIGUES');
    eq(imp.sportDeLaCle('tennis_atp_shanghai_masters'), 'tennis', 'sportDeLaCle : le joker tennis=* donne le tennis');
    ok(prixLigues.refusees().some((x) => /cricket_odi/.test(x)), 'le cricket est dit au demarrage (refusees)');
    ok(!prixLigues.observee('cricket_odi') && prixLigues.observee('basketball_euroleague'), 'une cle cricket posee dans PARIS_PRIX_OBSERVE n est jamais observee (G12b)');
    delete process.env.PARIS_PRIX_OBSERVE;
    brut.matchs = brut.matchs.filter((m) => !/^obs-/.test(m.id));
    fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify(brut));
    paris.charge();
  }

  console.log('\n-- 4. une cle observee : 1 credit, et la rencontre reste a l Elo --');
  {
    process.env.PARIS_PRIX_OBSERVE = 'icehockey_nhl';
    await importe();
    const c0 = credits();
    eq(await imp.rafraichitPrix(['icehockey_nhl'], 'periodique', 0), 0, 'rend 0 : rien de vendu (le calendrier ne se refait pas pour elle)');
    eq(credits() - c0, 1, 'un credit pour la releve');
    await importe();
    const nhl = paris.catalogue().matchs.filter((m) => m.source && m.source.ligue === 'icehockey_nhl');
    eq(nhl.length, 2, 'les deux rencontres NHL au calendrier');
    ok(nhl.every((m) => !m.prixMarche && !m.suspendu && m.cotesGenerees && paris.ouvert(m)), 'a l Elo, ouvertes, jamais suspendues : rien de vendu ne change');
    const ep = imp.etatPrix().icehockey_nhl;
    ok(ep && ep.observe === true && ep.cadenceH === 12, `etatPrix la dit observee, toutes les 12 h (${JSON.stringify(ep && { observe: ep.observe, cadenceH: ep.cadenceH })})`);
    eq(ep.ecart.issues, 2 * ep.ecart.avecPrix, 'deux issues par rencontre');
    let k = 0;
    for (const m of nhl) { const r = pm.pour(m.source.evenement); const c = m.marches['1n2'].cotes; for (const i of NHL) if (c[i] * r.p[i] > 1) k++; }
    eq(ep.ecart.battables, k, `les issues battables, refaites a la main (${k})`);
    const st = obs.etat(), h = st.releves.icehockey_nhl;
    ok(h && h[h.length - 1].e === 'ok' && h[h.length - 1].s === 'nhl' && h[h.length - 1].b + h[h.length - 1].pi === 2, 'le carnet d observation garde la releve (ok, sport, couverture)');
    ok(nhl.every((m) => st.rencontres[m.id] && st.rencontres[m.id].eu && st.rencontres[m.id].eu.elo && st.rencontres[m.id].eu.elo[1] === m.marches['1n2'].cotes[1]),
       'et chaque rencontre avec son prix eu et notre Elo du meme instant');
  }

  console.log('\n-- 4bis. l etalonnage d une cle observee : le prix a deux issues, et la releve au carnet --');
  {
    /* L'etalonnage hebdomadaire paie deja /odds : il note le prix de la cle
       observee AVEC le sport de sa ligne (sinon sportInconnu : credit paye,
       rien note) et laisse la releve au carnet d'observation. Rien ne le
       tenait (mutations du 10/10). Le carnet est vide de h1/h2 d'abord : le
       prix lu apres ne peut venir que de l'etalonnage. */
    const c = pm.lis(); delete c.evenements.h1; delete c.evenements.h2; fs.writeFileSync(pm.fichier(), JSON.stringify(c));
    ok(!pm.pour('h1'), 'temoin : plus aucun prix pour h1');
    const avant = (obs.etat().releves.icehockey_nhl || []).length;
    const c0 = credits();
    await imp.calibre('icehockey_nhl');
    eq(credits() - c0, 1, 'un credit : celui de l etalonnage, rien de plus');
    const r = pm.pour('h1');
    ok(r && r.p && !('N' in r.p) && Math.abs(r.p[1] + r.p[2] - 1) < 2e-5, `l etalonnage note la cle observee sur deux issues (${JSON.stringify(r && r.p)})`);
    const h = obs.etat().releves.icehockey_nhl || [];
    ok(h.length === avant + 1 && h[h.length - 1].e === 'ok' && h[h.length - 1].s === 'nhl', `et laisse sa releve au carnet d observation (${h.length - avant})`);
  }

  console.log('\n-- 5. l observation n est jamais prioritaire (G3) --');
  {
    poseQuota(20000, imp.partDuJour(20000));
    alertes.length = 0;
    const k0 = appels.length;
    eq(await imp.rafraichitPrix(['soccer_epl', 'icehockey_nhl'], 'essai', 0), 1, 'rend 1 : le seul championnat VENDU releve');
    eq(oddsDepuis(k0), 'soccer_epl', 'part du jour prise : la vente passe, l observation est refusee (0 credit)');
    eq(alertes.length, 0, 'et le refus de l observation n alerte pas');
    const h = obs.etat().releves.icehockey_nhl;
    eq(h[h.length - 1].e, 'refuse', 'le carnet garde le refus (il ne compte pas contre P3)');
    poseQuota(20000, 0);
  }

  console.log('\n-- 6. la cadence d une cle observee (G4) --');
  {
    await imp.rafraichitPrix(['icehockey_nhl', 'soccer_epl'], 'periodique', 0);
    const T = Date.now();
    eq(pm.observeMs(), 12 * H, 'PARIS_PRIX_OBSERVE_H vide : 12 h');
    ok(!imp.prixPerimes(T + 11 * H).includes('icehockey_nhl'), 't + 11 h : la NHL observee n est pas perimee');
    ok(imp.prixPerimes(T + 13 * H).includes('icehockey_nhl'), 't + 13 h : elle l est');
    ok(imp.prixPerimes(T + 2 * H + MIN).includes('soccer_epl') && !imp.prixPerimes(T + 2 * H + MIN).includes('icehockey_nhl'),
       't + 2 h : l EPL vendue suit releveMs (2 h), la NHL observee non');
    process.env.PARIS_PRIX_OBSERVE_H = '3';
    ok(!imp.prixPerimes(T + 2.5 * H).includes('icehockey_nhl') && imp.prixPerimes(T + 4 * H).includes('icehockey_nhl'), 'PARIS_PRIX_OBSERVE_H=3 : perimee a t + 4 h, pas a t + 2 h 30');
    ok(imp.prixPerimes(T + 2 * H + MIN).includes('soccer_epl'), 'et la vente ne bouge pas');
    process.env.PARIS_PRIX_OBSERVE_H = '1';
    eq(pm.observeMs(), pm.releveMs(), 'PARIS_PRIX_OBSERVE_H=1 : jamais plus serre que la vente (releveMs, 2 h)');
    process.env.PARIS_PRIX_OBSERVE_H = '500';
    eq(pm.observeMs(), 168 * H, 'PARIS_PRIX_OBSERVE_H=500 : borne a 168 h');
    process.env.PARIS_PRIX_OBSERVE_H = 'n importe quoi';
    eq(pm.observeMs(), 12 * H, 'illisible : 12 h');
    delete process.env.PARIS_PRIX_OBSERVE_H;
    eq(pm.cadenceDe('soccer_epl'), pm.releveMs(), 'cadenceDe : vendue -> releveMs');
    eq(pm.cadenceDe('icehockey_nhl'), pm.observeMs(), 'cadenceDe : observee -> observeMs');
  }

  console.log('\n-- 7. le joker du tennis (G5) --');
  {
    process.env.PARIS_PRIX_OBSERVE = 'tennis_atp_*,tennis_*,basketball_*';
    ok(prixLigues.observee('tennis_atp_shanghai_masters'), 'tennis_atp_* couvre tennis_atp_shanghai_masters');
    ok(!prixLigues.observee('tennis_atp_shanghai_masters_winner'), 'jamais un classement (_winner)');
    ok(!prixLigues.observee('tennis_wta_wuhan'), 'tennis_atp_* ne couvre pas la WTA');
    ok(!prixLigues.observee('tennis_itf_men') && !prixLigues.observee('basketball_nba') && !prixLigues.observee('basketball_euroleague'),
       'tennis_* et basketball_* ne couvrent RIEN');
    const ref = prixLigues.refusees();
    ok(ref.some((x) => /PARIS_PRIX_OBSERVE tennis_\* /.test(x)) && ref.some((x) => /basketball_\*/.test(x)) && !ref.some((x) => x.startsWith('PARIS_PRIX_OBSERVE tennis_atp_*')),
       `les jokers refuses sont dits, pas tennis_atp_* (${ref.length})`);
    ok(![...pm.aRelever()].some((k) => k.indexOf('*') >= 0), 'aucun joker n est une cle qu on paie');
    const avecR = imp.liguesAvecRencontre();
    const ar = pm.aRelever(avecR);
    ok(ar.has('tennis_atp_shanghai_masters'), 'aRelever(calendrier) developpe le joker sur le tournoi qui a une rencontre');
    ok(!ar.has('tennis_atp_shanghai_masters_winner') && !ar.has('tennis_wta_wuhan') && !ar.has('tennis_atp_paris'), 'et sur rien d autre');
    eq(pm.aRelever(new Set(['tennis_atp_shanghai_masters_winner', 'tennis_itf_men'])).has('tennis_atp_shanghai_masters_winner'), false, 'un _winner du calendrier n entre pas');
    process.env.PARIS_PRIX_OBSERVE = 'tennis_wta_*';
    const c0 = credits();
    ok(!imp.prixPerimes().some((k) => /^tennis_wta/.test(k)), 'tennis_wta_* sans rencontre au calendrier : rien a relever');
    await imp.rafraichitPrix(imp.prixPerimes().filter((k) => /^tennis_/.test(k)), 'periodique', 0);
    eq(credits() - c0, 0, 'et 0 credit');
    process.env.PARIS_PRIX_OBSERVE = 'tennis_atp_*';
    ok(imp.prixPerimes().includes('tennis_atp_shanghai_masters'), 'tennis_atp_* avec une rencontre : a relever');
    await imp.rafraichitPrix(['tennis_atp_shanghai_masters'], 'periodique', 0);
    eq(credits() - c0, 1, 'un credit');
    ok(pm.pour('t1') && !('N' in pm.pour('t1').p) && pm.pour('t1').p[2] > 0.65, 'note au tennis : deux issues, le favori a l exterieur');
    eq(imp.prixInconnues().join(','), '', 'tennis_atp_* suivi par tennis=* : rien a signaler');
    /* ce que le panneau et `--prix` voient : le joker developpe sur le
       calendrier, pas seulement les cles ecrites (mutations du 10/10) */
    ok(Object.keys(imp.etatPrix()).includes('tennis_atp_shanghai_masters'), 'etatPrix montre le tournoi que couvre tennis_atp_*');
    ok(imp.clefsALaMain().includes('tennis_atp_shanghai_masters') && !imp.clefsALaMain().some((k) => k.indexOf('*') >= 0),
       '--prix (clefsALaMain) le releve aussi, jamais un joker brut');
    /* un joker que ODDS_API_LIGUES ne suit pas (pas de tennis=*) ne releve
       rien : il est signale. LIGUES se lit au chargement : processus enfant. */
    {
      const { execFileSync } = require('child_process');
      const bacE = fs.mkdtempSync(path.join(os.tmpdir(), 'deux-issues-enfant-'));
      try {
        const env = Object.assign({}, process.env, { DATA_DIR: bacE, ODDS_API_KEY: '', ODDS_API_LIGUES: 'nhl=icehockey_nhl', PARIS_PRIX_OBSERVE: 'tennis_atp_*' });
        const sortie = execFileSync(process.execPath, ['-e', "process.stdout.write('\\nPI=' + JSON.stringify(require('./paris_import').prixInconnues()) + '\\n')"],
                                    { cwd: __dirname, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const ligne = sortie.split('\n').find((x) => x.startsWith('PI='));
        const pi = ligne ? JSON.parse(ligne.slice(3)) : null;
        ok(Array.isArray(pi) && pi.includes('tennis_atp_*'), `sans tennis=* dans ODDS_API_LIGUES : tennis_atp_* est signale (${JSON.stringify(pi)})`);
      } finally { fs.rmSync(bacE, { recursive: true, force: true }); }
    }
    delete process.env.PARIS_PRIX_OBSERVE;
  }

  console.log('\n-- 8. la bascule simulee (G6) --');
  {
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,icehockey_nhl,tennis_atp_*';
    const c8 = credits(), k8 = appels.length;
    eq(await imp.rafraichitPrix(['icehockey_nhl', 'tennis_atp_shanghai_masters'], 'periodique', 0), 1, 'NHL vendue : relevee et comptee ; le tournoi « vendu » par joker ne l est pas');
    eq(oddsDepuis(k8), 'icehockey_nhl', 'un seul appel /odds, la NHL');
    eq(credits() - c8, 1, 'un credit');
    ok(!imp.prixPerimes(Date.now() + 13 * H).includes('tennis_atp_shanghai_masters'), 'le tennis vendu n est jamais a relever (aucun verrou d heure reelle)');
    eq(pm.note(ODDS.tennis_atp_shanghai_masters(), 'tennis_atp_shanghai_masters', undefined, { sport: 'tennis' }).venteImpossible, true, 'et jamais note, meme a la main');
    ok(prixLigues.refusees().some((x) => /^PARIS_PRIX_LIGUES tennis_atp_\* \(tennis : aucune vente au marche sans verrou d heure reelle/.test(x)), 'c est dit au demarrage');
    await importe();
    const nhl = paris.catalogue().matchs.filter((m) => m.source && m.source.ligue === 'icehockey_nhl');
    const ten = paris.catalogue().matchs.filter((m) => m.source && m.source.ligue === 'tennis_atp_shanghai_masters');
    ok(nhl.length === 2 && nhl.every((m) => m.prixMarche && !m.suspendu), 'la NHL au prix du marche, aucune suspendue');
    ok(ten.length === 1 && ten[0].suspendu && !ten[0].prixMarche && !paris.ouvert(ten[0]),
       'le tennis « vendu » : SUSPENDU — ni au marche sans verrou d heure reelle, ni rendu a l Elo');
    for (const m of nhl) {
      const c = m.marches['1n2'].cotes, p = m.prixMarche.p;
      ok(NHL.every((i) => c[i] * p[i] < 1), `${m.domicile} v ${m.exterieur} : aucune issue gagnante pour le parieur (${c[1]} x ${p[1]}, ${c[2]} x ${p[2]})`);
      ok(1 / c[1] + 1 / c[2] - 1 >= 0.095, `marge ${((1 / c[1] + 1 / c[2] - 1) * 100).toFixed(2)} % >= 9,5 %`);
      eq(Object.keys(m.marches).join(','), '1n2', 'un seul marche, 1n2, sans nul');
    }
    /* sans prix frais : suspendue */
    const carnet = pm.lis();
    carnet.evenements.h1.t = Date.now() - 40 * H;
    carnet.evenements.h2.dom = 'Los Angeles Kings'; carnet.evenements.h2.ext = 'Edmonton Oilers';
    fs.writeFileSync(pm.fichier(), JSON.stringify(carnet));
    await importe();
    ok(parEv('h1').suspendu && !parEv('h1').prixMarche, 'sans prix de moins de 36 h : SUSPENDUE, jamais rendue a l Elo');
    ok(parEv('h2').suspendu && /orientation/.test(parEv('h2').suspenduRaison), 'un prix colle a l envers : suspendue');
    /* la porte de vente, sur une rencontre fabriquee sans prix */
    const fab = (ligue) => ({ id: 'fab-x', debut: Date.now() + J, cotesGenerees: true, source: { ligue } });
    ok(!paris.ouvert(fab('icehockey_nhl')), 'paris.ouvert : une NHL fabriquee sans prix est fermee');
    ok(!paris.ouvert(fab('tennis_atp_shanghai_masters')), 'et un tournoi « vendu » par le joker aussi (vendue, pas ligues().has)');
    ok(!paris.ouvert(Object.assign(fab('tennis_atp_shanghai_masters'), { prixMarche: { ref: 'pinnacle', t: new Date().toISOString(), p: { 1: 0.3, 2: 0.7 } } })),
       'meme un catalogue qui porterait un prix du marche au tennis « vendu » est ferme (G17)');
    ok(paris.ouvert(fab('tennis_atp_shanghai_masters_winner')), 'un classement n est pas couvert : rien a fermer');
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
    ok(paris.ouvert(fab('icehockey_nhl')) && paris.ouvert(fab('tennis_atp_shanghai_masters')), 'retour arriere (cle retiree) : de nouveau ouvertes, a l Elo');
    await importe();
    ok(paris.catalogue().matchs.filter((m) => m.source && m.source.ligue === 'icehockey_nhl').every((m) => !m.prixMarche && !m.suspendu), 'et l import les rend a l Elo');
  }

  console.log('\n-- 9. le reglement du hockey : jamais un nul --');
  {
    const g = new Game();
    const id = parEv('h1').id;
    let err = null;
    try { g.regleMatch(id, '3-3'); } catch (e) { err = e; }
    ok(err && /a level score \(3-3\) is impossible here/.test(err.message), 'un score egal (3-3) est refuse : « a level score … »');
    eq(g.regleMatch(id, '3-4').resultat, '2', '3-4 (tir au but compris) regle « 2 »');
  }

  console.log('\n-- 10. PARIS_ELO_ENGAGEMENT_MAX (G14) --');
  {
    const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
    const A = ('0x' + 'd4'.repeat(20)).toLowerCase();
    const nhl = parEv('h1'), epl = parEv('e1');
    ok(nhl && paris.aLElo(nhl) && epl && epl.prixMarche && !paris.aLElo(epl), 'une NHL a l Elo, l EPL au prix du marche');
    const jeu = () => { const g = new Game(); g._p(A).betBalance = W(5000000); return g; };
    delete process.env.PARIS_ELO_ENGAGEMENT_MAX;
    let g = jeu();
    eq(g.plafondEngagement(nhl), cfg.PARI_ENGAGEMENT_MAX, 'vide : le plafond global, rien ne change');
    ok(!!g.parie(A, nhl.id, '1', 200000, Date.now()), 'vide : une mise de 200 000 passe');
    process.env.PARIS_ELO_ENGAGEMENT_MAX = '300000';
    g = jeu();
    eq(g.plafondEngagement(nhl), 300000, 'pose a 300 000 : la NHL a l Elo est plafonnee');
    eq(g.plafondEngagement(epl), cfg.PARI_ENGAGEMENT_MAX, 'l EPL au prix du marche ne l est pas');
    let refus = null;
    try { g.parie(A, nhl.id, '1', 200000, Date.now()); } catch (e) { refus = e; }
    ok(refus && /is full/.test(refus.message), `une mise dont le gain depasse 300 000 est refusee (${refus && refus.message})`);
    ok(!!g.parie(A, nhl.id, '1', 100000, Date.now()), 'une mise sous le plafond passe');
    const vues = g.parisOuverts();
    const vn = vues.find((v) => v.id === nhl.id), ve = vues.find((v) => v.id === epl.id);
    ok(vn && vn.place <= 300000 - vn.engagement + 1e-6 && vn.place >= 0, `la place affichee suit le plafond Elo (${vn && Math.round(vn.place)})`);
    eq(ve && ve.place, cfg.PARI_ENGAGEMENT_MAX - ve.engagement, 'la place de l EPL suit le plafond global');
    process.env.PARIS_ELO_ENGAGEMENT_MAX = '9000000';
    eq(jeu().plafondEngagement(nhl), cfg.PARI_ENGAGEMENT_MAX, 'plus haut que le global : il ne releve jamais le plafond');
    for (const x of ['abc', '0', '-5']) {
      process.env.PARIS_ELO_ENGAGEMENT_MAX = x;
      ok(jeu().plafondEngagement(nhl) === cfg.PARI_ENGAGEMENT_MAX && paris.eloEngagementMax().invalide === true, `« ${x} » : ignore et dit invalide`);
    }
    delete process.env.PARIS_ELO_ENGAGEMENT_MAX;
  }

  console.log('\n-- 11. rien de vendu ne change sans les drapeaux --');
  {
    /* PARIS_PRIX_OBSERVE vide : rien d'observe, aucune cle a deux issues n'est relevee */
    delete process.env.PARIS_PRIX_OBSERVE;
    const p = imp.prixPerimes(Date.now() + 24 * H);
    ok(!p.some((k) => /^icehockey|^american|^tennis|^basketball/.test(k)), `PARIS_PRIX_OBSERVE vide : aucune cle a deux issues a relever (${p.join(',')})`);
    eq(pm.observees().size, 0, 'rien d observe');
  }

  console.log('\n-- 12. ce que le demarrage dit (joker refuse, plafond Elo) --');
  {
    /* Les seules lignes qui disent au journal si une variable posee est prise
       ou ignoree — dont PARIS_ELO_ENGAGEMENT_MAX, pose a 300 000 en production.
       Rien ne les tenait (mutations du 10/10). planifie est arrete aussitot :
       aucune minuterie ne part, aucun credit. */
    const capte = () => {
      const lu = [], vrai = console.log;
      let ctl = null;
      console.log = (...a) => { lu.push(a.join(' ')); };
      try { ctl = imp.planifie(() => {}, () => false); } finally { console.log = vrai; if (ctl) ctl.arrete(); }
      return lu.join('\n');
    };
    const c0 = credits();
    process.env.PARIS_PRIX_OBSERVE = 'basketball_*';
    process.env.PARIS_ELO_ENGAGEMENT_MAX = '300000';
    let txt = capte();
    ok(/\[odds\] IGNORE\(S\) : PARIS_PRIX_OBSERVE basketball_\* \(joker refuse/.test(txt), 'un joker refuse est dit au demarrage');
    ok(/\[paris\] PARIS_ELO_ENGAGEMENT_MAX : 300000 \$SWOGEBET par rencontre cotee a l Elo/.test(txt), 'le plafond Elo pose est dit, avec sa valeur');
    process.env.PARIS_ELO_ENGAGEMENT_MAX = 'abc';
    txt = capte();
    ok(/\[paris\] PARIS_ELO_ENGAGEMENT_MAX : IGNORE \(« abc » n est pas un nombre strictement positif\) — plafond global seul/.test(txt), 'une valeur invalide est dite IGNOREE');
    delete process.env.PARIS_ELO_ENGAGEMENT_MAX;
    delete process.env.PARIS_PRIX_OBSERVE;
    txt = capte();
    ok(/\[paris\] PARIS_ELO_ENGAGEMENT_MAX : vide — plafond global seul/.test(txt) && !/IGNORE\(S\)/.test(txt), 'vide : dit vide, rien d ignore');
    eq(credits() - c0, 0, 'et le demarrage arrete aussitot n a paye aucun credit');
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log(`\nRATES : ${rates}/${n}`);
  console.log(`prix_deux_issues.test.js : ${n - rates} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
