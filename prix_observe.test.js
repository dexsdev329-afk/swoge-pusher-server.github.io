'use strict';
/*
 * LE CARNET D'OBSERVATION DES SPORTS A DEUX ISSUES (lot 3, 10/10/2026).
 *
 * prix_observe.js ne vend rien, ne paie rien, ne decide rien : il releve le
 * moneyline DraftKings qu'ESPN rend deja au verrou (0 credit, 0 requete de
 * plus) et le prix eu des cles observees, puis calcule la porte P1-P5 ecrite
 * d'avance (EXPLOITATION 8.8nonies). L'essai tient :
 *  1. la conversion (-142 -> 1,7042 ; +120 -> 2,20), la marge retiree par la
 *     puissance, et l'ORIENTATION : notre domicile peut etre l'exterieur
 *     d'ESPN, et le tableau peut ranger l'exterieur en premier — G7 ;
 *  2. les instants : a2h = dernier releve au plus tard 2 h avant le coup
 *     d'envoi, fin = dernier avant ; rien APRES le coup d'envoi (heure ESPN,
 *     etat « pre ») — G8 ; un seul fournisseur ; sans `close`, aucun point ;
 *  3. le bilan : sur les 35 rencontres reelles du 09/10 (essais/
 *     observe_0910.json, close seulement), 15/70 battables, borne basse de
 *     Wilson 13,4 % ; aucune conclusion sous 40 rencontres / 80 issues, une a
 *     40 — G9 ; la fraicheur a 2 h et l'ecart eu-DK refaits a la main ; P3 sur
 *     l'historique des releves ; P5 COMPAREE a l'Elo ; le tennis jamais
 *     basculable ;
 *  4. le carnet : relu apres un redemarrage, purge, ecrit en deux temps, un
 *     fichier illisible mis de cote, une lecture refusee jamais gardee — G16 ;
 *     PARIS_OBS_US=0 coupe tout ; aucune requete reseau.
 * Un echec s'ecrit RATE ; la derniere ligne donne RATES : n/total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-'));
process.env.DATA_DIR = BAC;
let reseau = 0;
global.fetch = async () => { reseau++; throw new Error('aucune requete reseau dans cet essai'); };

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok  ' + m); else { rates++; console.log('RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
const proche = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

const paris = require('./paris');
const cotes = require('./cotes');
const espn = require('./scores_espn');
const pm = require('./prix_marche');
const obs = require('./prix_observe');

const H = 3600000, MIN = 60000, J = 86400000;
const SPORTS = ['foot', 'nhl', 'nfl', 'nba', 'mlb', 'tennis'].map((cle) => ({ cle, nom: cle.toUpperCase(), actif: true }));
const LIGUE = { nhl: 'icehockey_nhl', nfl: 'americanfootball_nfl', nba: 'basketball_nba', mlb: 'baseball_mlb', tennis: 'tennis_atp_shanghai_masters' };
const match = (id, sport, dom, ext, debut, c1, c2, extra) => Object.assign({ id, sport, competition: sport.toUpperCase(), domicile: dom, exterieur: ext,
  debut: new Date(debut).toISOString(), marches: { '1n2': { cotes: { 1: c1, 2: c2 } } }, cotesGenerees: true,
  source: { fournisseur: 'the-odds-api', ligue: LIGUE[sport], evenement: 'ev-' + id } }, extra || {});
let CAT = [];
const poseCatalogue = (matchs) => { CAT = matchs; fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify({ sports: SPORTS, matchs })); paris.charge(); };
const su = (c1, c2, quand, etat, f) => ({ etat: etat || 'pre', quand, dk: c1 ? { 1: c1, 2: c2, fournisseur: f || 'DraftKings' } : undefined });
const par = (id, x) => new Map([[id, x]]);
const recharge = () => { obs.flush(); obs.oublie(); };

(async () => {
  console.log('\n-- 1. conversion et orientation (G7) --');
  {
    proche(espn.americaine('-142'), 1.7042, 1e-4, 'cote americaine -142 -> 1,7042');
    eq(espn.americaine('+120'), 2.2, '+120 -> 2,20');
    const p = cotes.probasImplicites({ 1: espn.americaine('-142'), 2: espn.americaine('+120') }, ['1', '2'], 1);
    proche(p[1] + p[2], 1, 1e-9, 'la marge est retiree par la puissance : somme 1');
    ok(p[1] > 1 / 1.7042 / (1 / 1.7042 + 1 / 2.2), 'la puissance donne plus au favori que la proportion (l erreur qu on corrige)');
    /* une vraie reponse ESPN : BOS (domicile ESPN) -135, PHI +114 ; NOTRE
       domicile est Philadelphie */
    const B2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'bancs_espn_deux_issues.json'), 'utf8'));
    const pre = B2.nhl_pre.events[0];
    const debut = Date.parse('2026-10-10T17:00Z'), T = debut - 5 * H;
    poseCatalogue([match('nhl-phi-bos', 'nhl', 'Philadelphia Flyers', 'Boston Bruins', debut, 2.25, 1.70)]);
    const prendre = (evs) => async () => ({ ok: true, json: async () => ({ events: evs }) });
    const p1 = await espn.releve(paris.catalogue().matchs, { maintenant: T, prendre: prendre([pre]) });
    eq(obs.noteDk(p1, T), 1, 'noteDk note la rencontre');
    const r = obs.etat().rencontres['nhl-phi-bos'];
    ok(r && r.dk && r.dk.fin.c[1] === 2.14 && r.dk.fin.c[2] === 1.7407, `notre domicile (PHI) recoit +114, l exterieur -135 (${JSON.stringify(r && r.dk && r.dk.fin.c)})`);
    ok(r.dk.fin.p[1] < 0.5 && Math.abs(r.dk.fin.p[1] + r.dk.fin.p[2] - 1) < 2e-5, 'p oriente : Philadelphie outsider, somme 1');
    ok(r.dk.fin.elo && r.dk.fin.elo[1] === 2.25 && r.dk.fin.elo[2] === 1.70, 'avec nos cotes Elo du meme instant');
    const permute = JSON.parse(JSON.stringify(pre));
    permute.competitions[0].competitors.reverse();
    poseCatalogue([match('nhl-phi-bos2', 'nhl', 'Philadelphia Flyers', 'Boston Bruins', debut, 2.25, 1.70)]);
    obs.noteDk(await espn.releve(paris.catalogue().matchs, { maintenant: T, prendre: prendre([permute]) }), T);
    const r2 = obs.etat().rencontres['nhl-phi-bos2'];
    eq(r2 && r2.dk && r2.dk.fin.c[1], 2.14, 'le tableau range l exterieur en premier : toujours +114 pour PHI (homeAway, pas la position)');
    eq(reseau, 0, 'aucune requete reseau');
  }

  console.log('\n-- 2. les instants gardes (G8), un seul fournisseur, close seulement --');
  {
    const D = Date.now() + 30 * H, Q = D - 10 * MIN;    // l'heure d'ESPN, 10 min avant celle du catalogue (NHL)
    poseCatalogue([match('nhl-ins', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.80, 2.00),
                   match('mlb-ins', 'mlb', 'New York Yankees', 'Boston Red Sox', D, 1.70, 2.15),
                   match('nfl-ins', 'nfl', 'Atlanta Falcons', 'Baltimore Ravens', D, 2.20, 1.66)]);
    const t1 = Q - 5 * H, t2 = Q - 3 * H, t3 = Q - 2 * H - 20 * MIN, t4 = Q - H, t5 = Q + 2 * MIN, t6 = Q - 20 * MIN;
    eq(obs.noteDk(par('nhl-ins', su(1.80, 2.05, Q)), t1), 1, 't - 5 h : premier point');
    eq(obs.noteDk(par('nhl-ins', su(1.80, 2.05, Q)), t2), 0, 't - 3 h, meme cote : rien ne change, rien n est ecrit');
    eq(obs.noteDk(par('nhl-ins', su(1.75, 2.12, Q)), t3), 1, 't - 2 h 20 : la cote bouge');
    eq(obs.noteDk(par('nhl-ins', su(1.70, 2.20, Q)), t4), 1, 't - 1 h : encore');
    eq(obs.noteDk(par('nhl-ins', su(1.40, 3.10, Q)), t5), 0, 'APRES l heure ESPN (catalogue encore a venir) : ignore');
    eq(obs.noteDk(par('nhl-ins', su(1.40, 3.10, Q, 'in')), t6), 0, 'etat « in » : ignore');
    const r = obs.etat().rencontres['nhl-ins'];
    eq(r.dk.premier.t, t1, 'premier = le premier releve');
    eq(r.dk.a2h.t, t3, 'a2h = le dernier au plus tard 2 h avant le coup d envoi (heure ESPN)');
    eq(r.dk.fin.t, t4, 'fin = le dernier avant le coup d envoi, jamais celui d apres');
    eq(r.dk.fin.c[1], 1.70, 'la cloture est la cote de t - 1 h');
    ok(r.dk.bouge === 1 && r.dk.n === 3, 'dkBouge : la cote a change (3 points distincts)');
    eq(r.debut, Q, 'le coup d envoi garde est le plus tot des deux (ESPN)');
    eq(obs.noteDk(par('nfl-ins', su(2.10, 1.75, Q, 'pre', 'FanDuel')), t1), 0, 'un autre fournisseur : ignore');
    eq(obs.noteDk(par('mlb-ins', su(1.70, 2.20, Q)), t1), 0, 'MLB hors de PARIS_OBS_DK_SPORTS par defaut (nfl,nhl,nba) : ignoree');
    process.env.PARIS_OBS_DK_SPORTS = 'nfl,nhl,nba,mlb';
    eq(obs.noteDk(par('mlb-ins', su(1.70, 2.20, Q)), t1), 1, 'ajoutee a la variable : notee (0 credit)');
    delete process.env.PARIS_OBS_DK_SPORTS;
    eq(obs.noteDk(par('nfl-ins', { etat: 'pre', quand: Q, dkSansClose: true }), t1), 1, 'ESPN sans close : aucun point, mais compte');
    const rn = obs.etat().rencontres['nfl-ins'];
    ok(rn && rn.sc === 1 && rn.dk === null, 'sc = 1, dk vide');
    eq(obs.noteDk(par('inconnue', su(1.8, 2.0, Q)), t1), 0, 'une rencontre absente du catalogue : ignoree');
    eq(obs.noteDk(par('nhl-ins', su(0.9, 2.0, Q)), t1), 0, 'une cote <= 1 : ignoree');
  }

  console.log('\n-- 3. le bilan sur les 35 rencontres du 09/10 (G9) --');
  {
    obs.oublie();
    fs.rmSync(obs.fichier(), { force: true });
    const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'essais', 'observe_0910.json'), 'utf8')).rencontres;
    eq(F.length, 35, 'la fixture porte 35 rencontres (close DraftKings seulement)');
    const T0 = Date.now(), D = T0 + 3 * H;
    poseCatalogue(F.map((x, i) => match('j0910-' + i, x.sport, x.dom, x.ext, D, x.elo[1], x.elo[2])));
    process.env.PARIS_OBS_DK_SPORTS = 'nfl,nhl,mlb';
    const p = new Map(F.map((x, i) => ['j0910-' + i, su(espn.americaine(x.dk.dom), espn.americaine(x.dk.ext), D)]));
    eq(obs.noteDk(p, T0), 35, 'les 35 notees par noteDk');
    delete process.env.PARIS_OBS_DK_SPORTS;
    ok(obs.bilan(T0 + H).parSport.nhl === undefined, 'avant le coup d envoi, rien ne compte');
    const b = obs.bilan(T0 + 4 * H).parSport;
    const tot = ['nhl', 'nfl', 'mlb'].reduce((a, s) => ({ r: a.r + b[s].rencontres, i: a.i + b[s].issues, k: a.k + b[s].battablesElo }), { r: 0, i: 0, k: 0 });
    eq(`${tot.k}/${tot.i}`, '15/70', '15 issues battables sur 70');
    proche(obs.wilson(tot.k, tot.i)[0], 0.1344, 1e-4, 'borne basse de Wilson 13,4 %');
    eq(`${b.nhl.battablesElo}/${b.nhl.issues} ${b.nfl.battablesElo}/${b.nfl.issues} ${b.mlb.battablesElo}/${b.mlb.issues}`, '9/36 6/30 0/4', 'NHL 9/36, NFL 6/30, MLB 0/4');
    eq(b.nhl.wilsonBas, 0.1375, 'NHL : borne basse 13,8 %');
    /* refait a la main, sans le module : americaine, puissance, cote x p > 1 */
    let k = 0;
    for (const x of F) {
      const q = cotes.probasImplicites({ 1: espn.americaine(x.dk.dom), 2: espn.americaine(x.dk.ext) }, ['1', '2'], 1);
      for (const i of ['1', '2']) if (x.elo[i] * q[i] > 1) k++;
    }
    eq(k, tot.k, 'refait a la main : le meme compte');
    ok(['nhl', 'nfl', 'mlb'].every((s) => b[s].conclut === false && b[s].porte.bascule === null), 'sous 40 rencontres : aucune conclusion, porte non atteinte');
    ok(/not enough games yet \(18\/40\)/.test(b.nhl.porte.raisons.join(' ')), `et c est dit : ${b.nhl.porte.raisons.join(' ; ')}`);
    eq(b.nhl.parRencontre.battables, 9, 'par rencontre : 9 sur 18 (une issue au plus par rencontre)');
    const l = obs.lignes(T0 + 4 * H).join('\n');
    ok(/\[obs\] nhl : 18 rencontres, Elo battables 9\/36 \(25,0 %, borne basse 13,8 %\)/.test(l) && /aucune conclusion sous 40/.test(l), 'la ligne [obs] du jour');
    /* 40 rencontres : la conclusion ; 39 : non (G9) */
    const D2 = T0 + 3 * H;
    const plus = (nb, pref) => Array.from({ length: nb }, (_, i) => match(pref + i, 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D2, 1.80, 2.00));
    poseCatalogue(CAT.concat(plus(21, 'jplus-')));
    obs.noteDk(new Map(Array.from({ length: 21 }, (_, i) => ['jplus-' + i, su(1.85, 1.95, D2)])), T0);
    let bn = obs.bilan(T0 + 4 * H).parSport.nhl;
    ok(bn.rencontres === 39 && bn.conclut === false, `39 rencontres : pas de conclusion (${bn.rencontres})`);
    poseCatalogue(CAT.concat(plus(1, 'jder-')));
    obs.noteDk(par('jder-0', su(1.85, 1.95, D2)), T0);
    bn = obs.bilan(T0 + 4 * H).parSport.nhl;
    ok(bn.rencontres === 40 && bn.issues === 80 && bn.conclut === true, `40 rencontres, 80 issues : conclusion (${bn.rencontres}/${bn.issues})`);
    ok(bn.porte.P1.ok === false && /of 7 days/.test(bn.porte.raisons.join(' ')), 'mais P1 attend 7 jours pleins d observation (date au plus tot)');
  }

  console.log('\n-- 3bis. fraicheur, paires eu-DK, P3, P5 comparee a l Elo, tennis --');
  {
    obs.oublie();
    fs.rmSync(obs.fichier(), { force: true });
    const T = Date.now(), D = T + 6 * H;
    /* la fraicheur a 2 h : notre prix au DK de 2 h + 10 % contre la cloture */
    poseCatalogue([match('nba-f1', 'nba', 'Boston Celtics', 'New York Knicks', D, 1.80, 2.00), match('nba-f2', 'nba', 'Los Angeles Lakers', 'Golden State Warriors', D, 1.90, 1.90)]);
    obs.noteDk(par('nba-f1', su(1.65, 2.30, D)), D - 5 * H);
    obs.noteDk(par('nba-f1', su(1.30, 3.60, D)), D - H);         // une absence annoncee tard : le favori se raccourcit
    obs.noteDk(par('nba-f2', su(1.91, 1.91, D)), D - 5 * H);      // sans mouvement
    const b = obs.bilan(D + H).parSport.nba;
    let k = 0, iss = 0;
    for (const id of ['nba-f1', 'nba-f2']) {
      const r = obs.etat().rencontres[id];
      const co = cotes.marchesDuMarche('nba', r.dk.a2h.p)['1n2'].cotes;
      for (const i of ['1', '2']) { iss++; if (co[i] * r.dk.fin.p[i] > 1) k++; }
    }
    eq(`${b.fraicheur2h.battables}/${b.fraicheur2h.issues}`, `${k}/${iss}`, `fraicheur : DK de 2 h + 10 % contre la cloture, refait a la main (${k}/${iss})`);
    ok(k === 1, 'le favori raccourci tard est battable au prix de 2 h');
    eq(`${b.dkBouge.bouge}/${b.dkBouge.rencontres}`, '1/2', 'dkBouge : 1 sur 2');
    /* les paires eu / DK : le prix eu releve, DK vu il y a moins de 15 min */
    const t0 = Date.now(), D3 = t0 + 10 * H;
    poseCatalogue([match('nhl-p1', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D3, 1.80, 2.00, { source: { fournisseur: 'the-odds-api', ligue: 'icehockey_nhl', evenement: 'p1' } }),
                   match('nhl-p2', 'nhl', 'Edmonton Oilers', 'Los Angeles Kings', D3, 1.50, 2.60, { source: { fournisseur: 'the-odds-api', ligue: 'icehockey_nhl', evenement: 'p2' } })]);
    const ev = (id, dom, ext) => ({ id, commence_time: new Date(D3).toISOString(), home_team: dom, away_team: ext });
    const deux = (key, e, c1, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [{ name: e.home_team, price: c1 }, { name: e.away_team, price: c2 }] }] });
    const e1 = ev('p1', 'Boston Bruins', 'Toronto Maple Leafs'), e2 = ev('p2', 'Edmonton Oilers', 'Los Angeles Kings');
    const compte = pm.note([Object.assign({}, e1, { bookmakers: [deux('pinnacle', e1, 1.92, 1.96)] }), Object.assign({}, e2, { bookmakers: [deux('pinnacle', e2, 1.55, 2.55)] })],
                           'icehockey_nhl', t0, { sport: 'nhl' });
    obs.noteDk(new Map([['nhl-p1', su(1.95, 1.90, D3)], ['nhl-p2', su(1.58, 2.45, D3)]]), t0);
    eq(obs.noteEu('icehockey_nhl', 'nhl', compte, t0 + 5 * MIN, 'ok'), 2, 'noteEu : deux rencontres au prix eu frais, bien orientees');
    const rp = obs.etat().rencontres['nhl-p1'];
    ok(rp.pa.length === 1 && rp.pa[0][2] === obs.etat().rencontres['nhl-p1'].dk.fin.p[1], 'une paire eu / DK (DK vu il y a 5 min)');
    obs.noteEu('icehockey_nhl', 'nhl', compte, t0 + 20 * MIN, 'ok');
    eq(obs.etat().rencontres['nhl-p1'].pa.length, 1, 'DK vu il y a 20 min : pas de paire (15 min au plus)');
    const be = obs.bilan(D3 + H).parSport.nhl;
    const ec = ['nhl-p1', 'nhl-p2'].map((id) => { const x = obs.etat().rencontres[id].pa[0]; return [Math.abs(x[1] - x[2]), Math.abs(x[1] - 0.5) - Math.abs(x[2] - 0.5)]; });
    const med = (v) => (v[0] + v[1]) / 2;
    proche(be.euDk.ecartMedian, med(ec.map((x) => x[0])), 1e-4, 'ecart median |p_eu - p_DK|, refait a la main');
    proche(be.euDk.signeeMediane, med(ec.map((x) => x[1])), 1e-4, 'mediane SIGNEE de |p_eu - 0,5| - |p_DK - 0,5|, refaite a la main');
    eq(be.porte.P4.ok, null, 'P4 : 2 rencontres sur 20, rien a conclure');
    /* un prix eu colle a l'envers n'est pas note */
    const c2 = pm.lis(); c2.evenements.p2.dom = 'Los Angeles Kings'; c2.evenements.p2.ext = 'Edmonton Oilers'; fs.writeFileSync(pm.fichier(), JSON.stringify(c2));
    eq(obs.noteEu('icehockey_nhl', 'nhl', compte, t0 + 25 * MIN, 'ok'), 1, 'un prix eu colle a l envers : la rencontre n est pas notee');
    /* P3 sur l'historique : sept releves, recalcule a la main */
    obs.oublie(); fs.rmSync(obs.fichier(), { force: true });
    const T3 = Date.now();
    for (let i = 0; i < 7; i++) obs.noteEu('basketball_nba', 'nba', { pinnacle: 9, aucun: 1 }, T3 - (7 - i) * 12 * H, 'ok');
    let b3 = obs.bilan(T3).parSport.nba;
    eq(b3.couvertureEu7j.partAucun, 0.1, 'aucun : 7 sur 70 = 10 %, refait a la main');
    eq(b3.porte.P3.ok, false, 'sept releves reussies : P3 non tenue (10 exigees)');
    for (let i = 0; i < 3; i++) obs.noteEu('basketball_nba', 'nba', { pinnacle: 9, aucun: 1 }, T3 - i * MIN, 'ok');
    obs.noteEu('basketball_nba', 'nba', null, T3 - 2 * H, 'refuse');
    obs.noteEu('basketball_nba', 'nba', null, T3 - 3 * H, 'erreur');
    obs.noteEu('basketball_nba', 'nba', { pinnacle: 0, aucun: 10 }, T3 - 8 * J, 'ok');
    b3 = obs.bilan(T3).parSport.nba;
    ok(b3.porte.P3.ok === true && b3.porte.P3.reussies === 10 && b3.porte.P3.refusees === 1 && b3.porte.P3.erreurs === 1,
       `dix reussies, aucun 10 % : P3 tenue ; le refus (voulu) ne compte pas contre elle, la releve de 8 jours sort de la fenetre (${JSON.stringify(b3.porte.P3)})`);
    obs.noteEu('basketball_nba', 'nba', { pinnacle: 8, aucun: 2 }, T3 - 30 * MIN, 'ok');
    eq(obs.bilan(T3).parSport.nba.porte.P3.ok, false, 'un aucun de plus (12/110 > 10 %) : P3 tombe');
    /* P5, COMPAREE a l'Elo : etat ecrit a la main dans le carnet */
    obs.oublie(); fs.rmSync(obs.fichier(), { force: true });
    const st = obs.etat(), T5 = Date.now(), d5 = T5 - H;
    st.debutParSport.nhl = T5 - 10 * J;
    const pt = (t, c, p, elo) => ({ t, c, p, elo });
    const rencontre = (i, eloBattable, bouge) => {
      const pFin = { 1: 0.55, 2: 0.45 };
      const elo = eloBattable ? { 1: 1.95, 2: 1.95 } : { 1: 1.70, 2: 2.05 };
      const a2h = pt(d5 - 3 * H, { 1: 1.80, 2: 2.05 }, bouge ? { 1: 0.54, 2: 0.46 } : pFin, elo);
      return { s: 'nhl', l: 'icehockey_nhl', ev: 'x' + i, dom: 'A' + i, ext: 'B' + i, debut: d5, eu: null, pa: [[d5 - 2 * H, 0.551, 0.55]],
               dk: { premier: a2h, a2h, fin: pt(d5 - 10 * MIN, { 1: 1.75, 2: 2.12 }, pFin, elo), n: 2, bouge: bouge ? 1 : 0 } };
    };
    for (let i = 0; i < 40; i++) st.rencontres['c' + i] = rencontre(i, i < 20, i % 2 === 0);
    for (let L = 0; L < 10; L++) st.releves['k' + L] = [{ t: T5 - L * H, s: 'nhl', e: 'ok', b: 0, pi: 9, md: 0, a: 0, nul: 0 }];
    let b5 = obs.bilan(T5).parSport.nhl;
    ok(b5.porte.P5.ok === true && b5.porte.P5.fraicheurHaut < b5.porte.P5.eloBas,
       `Elo 20/40 rencontres battables, prix de 2 h 0/40 : la borne haute du marche (${b5.porte.P5.fraicheurHaut}) est sous la borne basse de l Elo (${b5.porte.P5.eloBas}) — P5 tenue`);
    ok(b5.porte.P1.ok && b5.porte.P3.ok && b5.porte.P4.ok === true && b5.porte.bascule === true, `P1, P3, P4, P5 : la porte est franchie (${b5.porte.raisons.join(';')})`);
    proche(b5.fraicheur2h.wilsonHaut, 0.0458, 1e-4, '0/80 issues au prix de 2 h : borne haute 4,6 %');
    eq(b5.porte.P5.cadenceRapprochee, true, 'au-dessus de 3 % : la cadence rapprochee serait necessaire EN PLUS (il faut ~300 issues pour la prouver inutile) — jamais un maintien de l Elo');
    for (let i = 0; i < 40; i++) st.rencontres['c' + i].dk.bouge = i < 4 ? 1 : 0;
    b5 = obs.bilan(T5).parSport.nhl;
    ok(b5.porte.P5.valide === false && b5.porte.P5.ok === null && b5.porte.bascule === null, 'DK a bouge sur 10 % des rencontres (< 20 %) : P5 invalide, le proprietaire tranche');
    for (let i = 0; i < 40; i++) { st.rencontres['c' + i].dk.bouge = 1; st.rencontres['c' + i].dk.fin.elo = { 1: 1.70, 2: 2.05 }; }
    b5 = obs.bilan(T5).parSport.nhl;
    ok(b5.porte.P5.ok === false && b5.porte.bascule === false, 'un Elo qui ne fuit plus (0/40) : le marche n est pas meilleur, P5 refuse la bascule');
    /* le tennis : jamais basculable */
    for (let i = 0; i < 45; i++) st.rencontres['t' + i] = { s: 'tennis', l: 'tennis_atp_x', ev: 'te' + i, dom: 'P' + i, ext: 'Q' + i, debut: d5, dk: null, pa: [],
                                                          eu: { t: d5 - 2 * H, te: d5 - 2 * H, p: { 1: 0.5, 2: 0.5 }, elo: { 1: 2.2, 2: 1.7 } } };
    const bt = obs.bilan(T5).parSport.tennis;
    ok(bt.rencontres === 45 && bt.conclut === true && bt.porte.bascule === false && /no real-time lock/.test(bt.porte.raisons.join(' ')),
       'tennis : 45 rencontres, et pourtant aucune bascule possible sans verrou d heure reelle');
    eq(bt.porte.P4.mesurable, false, 'P4 non mesurable au tennis (pas de DK)');
    eq(bt.battablesElo, 45, 'l Elo du tennis contre le prix eu : 2,2 x 0,5 > 1 sur chaque rencontre');
  }

  console.log('\n-- 4. le carnet : relu, purge, deux temps, illisible, lecture refusee (G16), coupe-circuit --');
  {
    obs.oublie(); fs.rmSync(obs.fichier(), { force: true });
    const D = Date.now() + 20 * H;
    poseCatalogue([match('nhl-c1', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.80, 2.00), match('nhl-c2', 'nhl', 'Edmonton Oilers', 'Los Angeles Kings', D, 1.50, 2.60)]);
    obs.noteDk(new Map([['nhl-c1', su(1.85, 1.95, D)], ['nhl-c2', su(1.55, 2.45, D)]]), Date.now());
    obs.flush();
    const sur = JSON.parse(fs.readFileSync(obs.fichier(), 'utf8'));
    ok(sur.rencontres['nhl-c1'] && sur.rencontres['nhl-c2'], 'ecrit sur le disque');
    eq(fs.readdirSync(BAC).filter((f) => /paris_observe\.json\.tmp/.test(f)).length, 0, 'en deux temps : aucun temporaire ne reste');
    /* au plus une ecriture par minute */
    const avant = fs.readFileSync(obs.fichier(), 'utf8');
    obs.noteDk(par('nhl-c1', su(1.90, 1.90, D)), Date.now());
    ok(fs.readFileSync(obs.fichier(), 'utf8') === avant, 'un changement moins d une minute apres : pas encore ecrit');
    obs.flush();
    ok(JSON.parse(fs.readFileSync(obs.fichier(), 'utf8')).rencontres['nhl-c1'].dk.fin.c[1] === 1.9, 'et ecrit au plus tard a la minuterie (flush)');
    obs.oublie();
    eq(Object.keys(obs.etat().rencontres).length, 2, 'relu apres un redemarrage');
    /* purge */
    process.env.PARIS_OBS_JOURS = '7';
    const st = obs.etat();
    st.rencontres.vieille = { s: 'nhl', l: 'icehockey_nhl', ev: 'v', dom: 'a', ext: 'b', debut: Date.now() - 8 * J, dk: null, eu: null, pa: [] };
    st.rencontres.recente = { s: 'nhl', l: 'icehockey_nhl', ev: 'r', dom: 'a', ext: 'b', debut: Date.now() - 6 * J, dk: null, eu: null, pa: [] };
    obs.noteEu('icehockey_nhl', 'nhl', { pinnacle: 1 }, Date.now(), 'ok');
    recharge();
    ok(!obs.etat().rencontres.vieille && obs.etat().rencontres.recente, 'PARIS_OBS_JOURS=7 : la rencontre de 8 jours est purgee, celle de 6 jours reste');
    delete process.env.PARIS_OBS_JOURS;
    eq(obs.joursGardes(), 60, 'retention par defaut : 60 jours');
    /* lecture refusee : rien n'est garde, le fichier reste */
    const nb = Object.keys(obs.etat().rencontres).length;
    obs.oublie();
    const lireVrai = fs.readFileSync;
    fs.readFileSync = function (f, ...a) { if (String(f) === obs.fichier()) { const e = new Error('EIO simule'); e.code = 'EIO'; throw e; } return lireVrai.call(fs, f, ...a); };
    let r0;
    try { r0 = obs.noteDk(par('nhl-c2', su(1.50, 2.70, D)), Date.now()); } finally { fs.readFileSync = lireVrai; }
    eq(r0, 0, 'lecture refusee (EIO) : rien n est note');
    eq(Object.keys(obs.etat().rencontres).length, nb, 'et rien n est garde : la lecture suivante retrouve tout le carnet (G16)');
    /* illisible : mis de cote, jamais ecrase */
    obs.oublie();
    fs.writeFileSync(obs.fichier(), '{ pas du json');
    obs.noteDk(par('nhl-c2', su(1.50, 2.70, D)), Date.now());
    ok(fs.readdirSync(BAC).some((f) => /^paris_observe\.json\.illisible-\d+$/.test(f)), 'un fichier illisible est mis de cote (.illisible-<t>)');
    ok(Object.keys(obs.etat().rencontres).length === 1, 'et le carnet repart vide, la rencontre du jour notee');
    /* coupe-circuit */
    obs.flush();
    const fige = fs.readFileSync(obs.fichier(), 'utf8');
    process.env.PARIS_OBS_US = '0';
    eq(obs.noteDk(par('nhl-c1', su(1.10, 8.0, D)), Date.now()), 0, 'PARIS_OBS_US=0 : noteDk ne fait rien');
    obs.flush();
    ok(fs.readFileSync(obs.fichier(), 'utf8') === fige, 'et le carnet ne bouge pas');
    ok(/COUPE/.test(obs.ligneDemarrage()), 'la ligne de demarrage le dit');
    delete process.env.PARIS_OBS_US;
    ok(/0 credit, 0 requete de plus/.test(obs.ligneDemarrage()), 'actif : 0 credit, 0 requete');
    eq(reseau, 0, 'aucune requete reseau de tout l essai');
  }

  console.log('\n-- 5. le branchement (server.js, paris_import.js) --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const verrou = src.slice(src.indexOf('function verrouFrais('), src.indexOf('function directFrais('));
    ok(/const par = await espn\.releve\(lot, \{ maintenant: t \}\);\s*\n\s*paris\.poseHeuresReelles\(par, t\);/.test(verrou),
       'le verrou pose les heures reelles de la MEME releve, d abord');
    ok(/try \{ prixObserve\.noteDk\(par, t\); \} catch \(e\)/.test(verrou), 'puis la passe au carnet, dans son propre try (jamais bloquant pour le verrou)');
    ok(/if \(path === '\/paris\/mises'\) \{\s*\n\s*if \(!authed\) return refuse\(req, res, false\);\s*\n\s*rate\(req, true\);/.test(src),
       '/paris/mises commence par la garde admin');
    ok(/'\/paris\/mises'/.test(fs.readFileSync(path.join(__dirname, 'acces.test.js'), 'utf8')), 'acces.test.js la compte parmi les portes privees');
    const imp = fs.readFileSync(path.join(__dirname, 'paris_import.js'), 'utf8');
    ok(/prixObserve\.noteEu\(clef, sport, c, Date\.now\(\), 'ok'\)/.test(imp) && /info\.code === 'REFUSE' \? 'refuse' : 'erreur'/.test(imp),
       'rafraichitPrix passe le compte a noteEu, et le refus (ou l erreur) aussi');
    ok(/observation: \(\(\) => \{ try \{ return prixObserve\.bilan\(\);/.test(imp), 'etatImport rend le bilan (/paris/import)');
  }

  console.log('\n-- 6. la carte du panneau (anglais, n toujours dit, rien sous 40) --');
  {
    const vm = require('vm');
    process.env.RPC_URL = process.env.RPC_URL || '';
    const page = require('./admin').page('jeton');
    const bac = { esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
    vm.createContext(bac);
    for (const nom of ['function num(', 'function ent(']) { const i = page.indexOf(nom); vm.runInContext(page.slice(i, page.indexOf('\n', i)), bac); }
    const d = page.indexOf('var OBS_NOMS='), f = page.indexOf('\n}\n', page.indexOf('function misesRend('));
    ok(d > 0 && f > d, 'la page porte obsRend et misesRend');
    vm.runInContext(page.slice(d, f + 2), bac);
    const T = Date.now();
    const peu = bac.obsRend(obs.bilan(T + 400 * J), null);
    const b = obs.bilan(T);
    const html = bac.obsRend(b, { valeur: null, brut: null, invalide: false });
    ok(/Market watch \(not sold\)/.test(html) && /not set &mdash; global cap only/.test(html), 'en anglais, plafond Elo vide dit');
    ok(/No game observed yet/.test(peu), 'sans rencontre dans la fenetre : « No game observed yet »');
    /* une rencontre sous le seuil : son compte, aucune part */
    const st = obs.etat();
    st.rencontres.carte = { s: 'nfl', l: 'americanfootball_nfl', ev: 'c', dom: '<b>A', ext: 'B', debut: T - H, pa: [], eu: null,
                            dk: { premier: null, a2h: null, fin: { t: T - 2 * H, c: { 1: 1.5, 2: 2.7 }, p: { 1: 0.64, 2: 0.36 }, elo: { 1: 1.9, 2: 1.95 } }, n: 1, bouge: 0 } };
    const sous = bac.obsRend(obs.bilan(T), null);
    ok(/<b>NFL<\/b>: 1 game\(s\) &mdash; not enough games yet \(1\/40\)/.test(sous) && !/Elo beatable/.test(sous), 'sous 40 : « not enough games yet (1/40) », aucune part');
    ok(/gate not reached/.test(sous), 'et la porte n est pas atteinte');
    const inval = bac.obsRend(obs.bilan(T), { valeur: null, brut: '<x>', invalide: true });
    ok(/IGNORED/.test(inval) && /&lt;x&gt;/.test(inval) && !/<x>/.test(inval), 'un plafond invalide : IGNORED, echappe');
    const m = bac.misesRend({ jours: 30, parJeton: { swogebet: { nhl: { tickets: 3, adresses: 2, mise: 1234, enJeu: 100, miseJugee: 1134, rendu: 900, netMaison: 234, rembourses: 1, dansCombines: 1 },
                                                         combine: { tickets: 1, adresses: 1, mise: 50, enJeu: 0, miseJugee: 50, rendu: 0, netMaison: 50, rembourses: 0, dansCombines: 0 } },
                                             swoge: { foot: { tickets: 1, adresses: 1, mise: 400, enJeu: 0, miseJugee: 400, rendu: 0, netMaison: 400, rembourses: 0, dansCombines: 0 } } } });
    ok(/Stakes by sport \(30 days\)/.test(m) && /\$SWOGEBET &middot; <b>NHL<\/b>: 3 ticket\(s\), 2 address\(es\), staked 1,234/.test(m) && /\$SWOGE &middot; <b>Football<\/b>/.test(m) && /<b>Parlays<\/b>/.test(m),
       'la mise par sport : par jeton, des comptes entiers, les combines a part');
    ok(/no bet in the window/.test(bac.misesRend({ jours: 30, parJeton: {} })), 'aucune mise : dit');
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log(`\nRATES : ${rates}/${n}`);
  console.log(`prix_observe.test.js : ${n - rates} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
