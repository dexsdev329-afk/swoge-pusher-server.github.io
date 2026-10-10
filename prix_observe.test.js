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
 * Ajouts des mutations du 10/10/2026 (31 garde-fous qu'aucun essai ne tenait) :
 *  3ter. la porte au point qui distingue chaque regle — P5 sur les BORNES (pas
 *     les parts) et sur 40 rencontres de fraicheur, P4 signee ET |ecart|, P3 et
 *     P4 dans la porte, P2 rapport seulement ; P3 non mesurable sous 10 releves
 *     reussies (jamais « failed » pour des refus voulus) ;
 *  3quater. le carnet qui nourrit la porte — prix eu de plus de 3 h ignore,
 *     aucune cote « Elo » d'une rencontre au marche, un changement de notre Elo
 *     n'est pas un mouvement de DK, debutParSport pose une fois, cloture DK
 *     avant eu, derniere paire, 6 paires, heure du catalogue (G8), P1 du tennis ;
 *  4. jamais d'ecriture directe du carnet, releves purgees, 7 a 365 jours ;
 *  6. la carte refuse l'ecart sous 20 paires et la borne sous 40 rencontres ;
 *  2. un autre fournisseur est compte (af), jamais garde comme prix.
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
    /* un autre fournisseur n'est jamais un prix garde, mais il est COMPTE (af) :
       sans compte, un changement de fournisseur chez ESPN tarirait le carnet
       sans un mot (relecture du 10/10) */
    eq(obs.noteDk(par('nfl-ins', su(2.10, 1.75, Q, 'pre', 'FanDuel')), t1), 1, 'un autre fournisseur : la rencontre est comptee');
    ok(obs.etat().rencontres['nfl-ins'].dk === null && obs.etat().rencontres['nfl-ins'].af === 1, 'mais aucun point DK n est garde (dk vide, af = 1)');
    eq(obs.noteDk(par('nfl-ins', su(2.10, 1.75, Q, 'pre', 'FanDuel')), t2), 0, 'compte une fois : rien ne change, rien n est ecrit');
    eq(obs.noteDk(par('mlb-ins', su(1.70, 2.20, Q)), t1), 0, 'MLB hors de PARIS_OBS_DK_SPORTS par defaut (nfl,nhl,nba) : ignoree');
    process.env.PARIS_OBS_DK_SPORTS = 'nfl,nhl,nba,mlb';
    eq(obs.noteDk(par('mlb-ins', su(1.70, 2.20, Q)), t1), 1, 'ajoutee a la variable : notee (0 credit)');
    delete process.env.PARIS_OBS_DK_SPORTS;
    eq(obs.noteDk(par('nfl-ins', { etat: 'pre', quand: Q, dkSansClose: true }), t1), 1, 'ESPN sans close : aucun point, mais compte');
    const rn = obs.etat().rencontres['nfl-ins'];
    ok(rn && rn.sc === 1 && rn.dk === null, 'sc = 1, dk vide');
    const bn = obs.bilan(D + H).parSport.nfl;
    ok(bn.dkSansClose === 1 && bn.dkAutreFournisseur === 1 && bn.rencontres === 0, `le bilan compte ce qui est ecarte, sans en faire une rencontre (${bn.dkSansClose}, ${bn.dkAutreFournisseur})`);
    ok(/\[obs\] nfl : 0 rencontres.*DK ecarte : 1 sans close, 1 autre fournisseur/.test(obs.lignes(D + H).join('\n')), 'et la ligne [obs] le dit');
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
    /* sous 10 releves reussies, P3 n'est pas tenue — et pas encore mesurable
       (null), plutot que « failed » (relecture du 10/10) */
    eq(b3.porte.P3.ok, null, 'sept releves reussies : P3 non tenue, pas encore mesurable (10 exigees)');
    for (let i = 0; i < 3; i++) obs.noteEu('basketball_nba', 'nba', { pinnacle: 9, aucun: 1 }, T3 - i * MIN, 'ok');
    obs.noteEu('basketball_nba', 'nba', null, T3 - 2 * H, 'refuse');
    obs.noteEu('basketball_nba', 'nba', null, T3 - 3 * H, 'erreur');
    obs.noteEu('basketball_nba', 'nba', { pinnacle: 0, aucun: 10 }, T3 - 8 * J, 'ok');
    b3 = obs.bilan(T3).parSport.nba;
    ok(b3.porte.P3.ok === true && b3.porte.P3.reussies === 10 && b3.porte.P3.refusees === 1 && b3.porte.P3.erreurs === 1,
       `dix reussies, aucun 10 % : P3 tenue ; le refus (voulu) ne compte pas contre elle, la releve de 8 jours sort de la fenetre (${JSON.stringify(b3.porte.P3)})`);
    obs.noteEu('basketball_nba', 'nba', { pinnacle: 8, aucun: 2 }, T3 - 30 * MIN, 'ok');
    eq(obs.bilan(T3).parSport.nba.porte.P3.ok, false, 'un aucun de plus (12/110 > 10 %) : P3 tombe');
    /* sept jours de releves REFUSEES (classe 3, voulu) : P3 n'est pas mesurable,
       elle n'echoue pas — un refus n'est pas une condition */
    obs.oublie(); fs.rmSync(obs.fichier(), { force: true });
    for (let i = 0; i < 14; i++) obs.noteEu('basketball_nba', 'nba', null, T3 - i * 11 * H, 'refuse');
    const p3r = obs.bilan(T3).parSport.nba.porte.P3;
    ok(p3r.ok === null && p3r.refusees === 14 && p3r.reussies === 0, `quatorze refus, aucune releve reussie : P3 non mesurable, pas « failed » (${JSON.stringify(p3r)})`);
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

  console.log('\n-- 3ter. la porte au point qui distingue chaque regle (mutations du 10/10) --');
  {
    /* Un sport ou tout est tenu (P1 : 40 rencontres, 10 jours ; P3 : 10
       releves reussies ; P4 : paires de 0,1 point ; DK a bouge partout), puis
       une seule chose change. Les essais du 3bis ne jugeaient la porte que sur
       des cas extremes (20/40 contre 0/40) : sept mutants de la porte y
       survivaient (EXPLOITATION 8.8nonies). */
    const porteDe = (o) => {
      obs.oublie(); fs.rmSync(obs.fichier(), { force: true });
      const st = obs.etat(), T = Date.now(), d = T - H;
      st.debutParSport.nhl = T - 10 * J;
      const rel = o.releves || Array.from({ length: 10 }, () => ({ e: 'ok', pi: 9, a: 0 }));
      rel.forEach((x, L) => { st.releves['k' + L] = [{ t: T - L * H, s: 'nhl', e: x.e, b: 0, pi: x.pi || 0, md: 0, a: x.a || 0, nul: 0 }]; });
      for (let i = 0; i < (o.rencontres || 40); i++) {
        const elo = i < o.eloK ? { 1: 1.95, 2: 1.95 } : { 1: 1.70, 2: 2.05 };
        const pA2h = i < (o.marcheK || 0) ? { 1: 0.40, 2: 0.60 } : { 1: 0.54, 2: 0.46 };
        st.rencontres['c' + i] = { s: 'nhl', l: 'icehockey_nhl', ev: 'x' + i, dom: 'A' + i, ext: 'B' + i, debut: d, eu: null,
          pa: [[d - 2 * H].concat(o.paire || [0.551, 0.55])],
          dk: { premier: null, a2h: (o.a2h === undefined || i < o.a2h) ? { t: d - 3 * H, c: { 1: 1.8, 2: 2.05 }, p: pA2h, elo } : null,
                fin: { t: d - 10 * MIN, c: { 1: 1.75, 2: 2.12 }, p: { 1: 0.55, 2: 0.45 }, elo }, n: 2, bouge: 1 } };
      }
      return obs.bilan(T).parSport.nhl;
    };
    const temoin = porteDe({ eloK: 20 });
    ok(temoin.porte.bascule === true, `temoin : tout tenu, la porte est franchie (${temoin.porte.raisons.join(';')})`);
    /* P5 compare les BORNES, pas les parts : Elo 8/40 (20 %, borne basse
       10,5 %), prix de 2 h 3/40 (7,5 %, borne haute 19,9 %) — la part du
       marche est plus basse, rien ne le prouve */
    let b = porteDe({ eloK: 8, marcheK: 3 });
    ok(b.parRencontre.battables === 8 && b.fraicheur2h.parRencontre.battables === 3, `Elo 8/40 rencontres battables, prix de 2 h 3/40 (${b.parRencontre.battables}, ${b.fraicheur2h.parRencontre.battables})`);
    proche(b.porte.P5.eloBas, 0.105, 1e-3, 'borne basse de l Elo 10,5 %');
    proche(b.porte.P5.fraicheurHaut, 0.1986, 1e-3, 'borne haute du marche 19,9 %');
    ok(b.porte.P5.ok === false && b.porte.bascule === false && /P5 failed/.test(b.porte.raisons.join(' ')), 'P5 refusee, porte fermee : une part plus basse n est pas une preuve');
    /* P5 compte PAR RENCONTRE (les deux issues d'une rencontre ne sont pas
       independantes), pas par issue. Donne pour equivalent par les mutations
       du 10/10 (« les bornes se confondent ») : faux, une recherche sur 40 a
       120 rencontres trouve des cas qui departagent. Elo 17/40 rencontres
       (borne basse 28,5 %), marche 5/40 (borne haute 26,1 %) : P5 tenue ;
       comptee par issue (17/80 contre 5/80 : 13,7 % contre 13,8 %) elle
       tomberait. */
    b = porteDe({ eloK: 17, marcheK: 5 });
    proche(b.porte.P5.eloBas, 0.2851, 1e-3, 'Elo 17/40 rencontres : borne basse 28,5 %');
    proche(b.porte.P5.fraicheurHaut, 0.2611, 1e-3, 'marche 5/40 rencontres : borne haute 26,1 %');
    ok(b.porte.P5.ok === true && b.porte.bascule === true, `P5 comptee par rencontre : tenue, porte franchie (${b.porte.P5.ok}, ${b.porte.bascule})`);
    /* P5 : moins de 40 rencontres de fraicheur — non mesurable, jamais jugee */
    b = porteDe({ eloK: 20, a2h: 5 });
    ok(b.fraicheur2h.rencontres === 5 && b.porte.P5.ok === null && b.porte.bascule === null && /P5 not measurable yet/.test(b.porte.raisons.join(' ')),
       `5 rencontres de fraicheur sur 40 : P5 non mesurable (${b.porte.P5.ok})`);
    /* P4 : la mediane SIGNEE voit un prix plus tranche que le moneyline, que
       |ecart| ne voit pas — 0,62 contre 0,605 : |ecart| 1,5 point, signee +1,5 */
    b = porteDe({ eloK: 20, paire: [0.62, 0.605] });
    ok(b.porte.P4.ecartMedian <= 0.02 && b.porte.P4.signeeMediane > 0.01, `|ecart| ${b.porte.P4.ecartMedian} <= 2 points, signee ${b.porte.P4.signeeMediane} > 1 point`);
    ok(b.porte.P4.ok === false && b.porte.bascule === false && /P4 failed/.test(b.porte.raisons.join(' ')), 'P4 refuse un prix eu plus tranche que DK, et ferme la porte');
    /* P4 : |ecart| tient l'orientation, que la signee ne voit pas — 0,40 contre 0,60 */
    b = porteDe({ eloK: 20, paire: [0.40, 0.60] });
    ok(Math.abs(b.porte.P4.signeeMediane) < 1e-9 && b.porte.P4.ecartMedian > 0.02 && b.porte.P4.ok === false, `prix eu a l envers : signee 0, |ecart| ${b.porte.P4.ecartMedian} — P4 refuse`);
    /* P3 dans la porte : fausse (aucun 20 % sur 10 releves reussies), elle ferme */
    b = porteDe({ eloK: 20, releves: Array.from({ length: 10 }, () => ({ e: 'ok', pi: 8, a: 2 })) });
    ok(b.porte.P3.ok === false && b.porte.P4.ok === true && b.porte.P5.ok === true && b.porte.bascule === false && /P3 failed/.test(b.porte.raisons.join(' ')),
       `P3 seule fausse (aucun 20 %) : porte fermee (${b.porte.bascule})`);
    /* sept releves reussies : P3 non mesurable, la porte n'est pas atteinte */
    b = porteDe({ eloK: 20, releves: Array.from({ length: 7 }, () => ({ e: 'ok', pi: 9, a: 0 })) });
    ok(b.porte.P3.ok === null && b.porte.bascule === null && /P3 not measurable yet/.test(b.porte.raisons.join(' ')), `7 releves reussies : P3 non mesurable, porte non atteinte (${b.porte.bascule})`);
    /* P2 n'est qu'un rapport : 200 rencontres, Elo 10/400 issues (borne basse
       1,4 % < 5 %), marche 0/200 — P5 tenue, la porte passe */
    b = porteDe({ eloK: 10, rencontres: 200 });
    ok(b.porte.P2.ok === false && b.porte.P5.ok === true && b.porte.bascule === true, `P2 fausse (rapport), P5 tenue sur 200 : porte franchie (P2 ${b.porte.P2.ok}, P5 ${b.porte.P5.ok}, ${b.porte.bascule})`);
  }

  console.log('\n-- 3quater. ce qui nourrit la porte : le carnet ecrit juste (mutations du 10/10) --');
  {
    const raz = () => { obs.oublie(); fs.rmSync(obs.fichier(), { force: true }); };
    const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
    const deux = (key, e, c1, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [{ name: e.home_team, price: c1 }, { name: e.away_team, price: c2 }] }] });
    /* noteEu : un prix eu de plus de 3 h (pour() en rend jusqu'a 36 h) n'est ni note ni apparie */
    {
      raz();
      const t = Date.now(), D = t + 10 * H;
      poseCatalogue([match('nhl-q1', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.8, 2.0)]);
      const e1 = ev('ev-nhl-q1', 'Boston Bruins', 'Toronto Maple Leafs', D);
      pm.note([Object.assign({}, e1, { bookmakers: [deux('pinnacle', e1, 1.92, 1.96)] })], 'icehockey_nhl', t - 4 * H, { sport: 'nhl' });
      ok(pm.pour('ev-nhl-q1', t + MIN), 'temoin : pour() rend encore ce prix de 4 h');
      obs.noteDk(par('nhl-q1', su(1.95, 1.90, D)), t);
      const k = obs.noteEu('icehockey_nhl', 'nhl', { pinnacle: 1 }, t + MIN, 'ok');
      const r = obs.etat().rencontres['nhl-q1'];
      ok(k === 0 && r && r.eu === null && r.pa.length === 0, `prix eu de 4 h : ni note, ni paire (${k}, ${JSON.stringify(r && r.pa)})`);
    }
    /* eloDe : une rencontre au prix du marche n'apporte aucune cote « Elo » */
    {
      raz();
      const t = Date.now(), D = t + 10 * H;
      poseCatalogue([match('nhl-q2', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.8, 2.0, { prixMarche: { ref: 'pinnacle', t: new Date(t).toISOString(), p: { 1: 0.5, 2: 0.5 } } })]);
      ok(paris.match('nhl-q2') && paris.match('nhl-q2').prixMarche, 'temoin : le catalogue garde prixMarche');
      obs.noteDk(par('nhl-q2', su(1.95, 1.90, D)), t);
      const r = obs.etat().rencontres['nhl-q2'];
      ok(r && r.dk && r.dk.fin.elo === null, `rencontre au prix du marche : fin.elo null (${JSON.stringify(r && r.dk && r.dk.fin.elo)})`);
    }
    /* un changement de NOTRE Elo seul ecrit un point, sans compter comme un mouvement de DK */
    {
      raz();
      const t = Date.now(), D = t + 10 * H;
      poseCatalogue([match('nhl-q3', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.8, 2.0)]);
      obs.noteDk(par('nhl-q3', su(1.95, 1.90, D)), t);
      poseCatalogue([match('nhl-q3', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.7, 2.1)]);
      const c = obs.noteDk(par('nhl-q3', su(1.95, 1.90, D)), t + 30 * MIN);
      const r = obs.etat().rencontres['nhl-q3'];
      ok(c === 1 && r.dk.fin.elo[1] === 1.7 && r.dk.n === 2, `l Elo change, DK non : un point, fin.elo a jour (${c}, ${JSON.stringify(r.dk.fin.elo)})`);
      eq(r.dk.bouge, 0, 'et DK n a pas bouge (P5 ne se valide pas sur notre propre mouvement)');
    }
    /* debutParSport : le premier jour d'observation reste le premier (les 7 jours de P1) */
    {
      raz();
      const t = Date.now();
      poseCatalogue([match('nhl-q4', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', t + 30 * H, 1.8, 2.0), match('nhl-q5', 'nhl', 'Edmonton Oilers', 'Los Angeles Kings', t + 3 * J, 1.5, 2.6)]);
      obs.noteDk(par('nhl-q4', su(1.95, 1.90, t + 30 * H)), t - 2 * J);
      obs.noteDk(par('nhl-q5', su(1.55, 2.45, t + 3 * J)), t);
      eq(obs.etat().debutParSport.nhl, t - 2 * J, 'debutParSport.nhl = le premier releve, pas le dernier');
    }
    /* la reference : la cloture DK passe avant le prix eu ; la DERNIERE paire compte */
    {
      raz();
      const st = obs.etat(), T = Date.now(), d = T - H;
      st.rencontres.r1 = { s: 'nhl', l: 'icehockey_nhl', ev: 'x', dom: 'A', ext: 'B', debut: d,
        eu: { t: d - H, te: d - H, p: { 1: 0.5, 2: 0.5 }, elo: { 1: 1.9, 2: 1.9 } },
        dk: { premier: null, a2h: null, fin: { t: d - 10 * MIN, c: { 1: 1.5, 2: 2.7 }, p: { 1: 0.64, 2: 0.36 }, elo: { 1: 1.9, 2: 1.9 } }, n: 1, bouge: 0 },
        pa: [[d - 3 * H, 0.70, 0.50], [d - 2 * H, 0.551, 0.55]] };
      const b = obs.bilan(T).parSport.nhl;
      ok(b.sources.dk === 1 && b.sources.eu === 0, `la cloture DK d abord, le prix eu seulement a defaut (${JSON.stringify(b.sources)})`);
      proche(b.euDk.ecartMedian, 0.001, 1e-9, 'la DERNIERE paire de la rencontre compte, pas la premiere');
    }
    /* 6 paires au plus par rencontre */
    {
      raz();
      const t = Date.now(), D = t + 20 * H;
      poseCatalogue([match('nhl-q6', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', D, 1.8, 2.0)]);
      const e6 = ev('ev-nhl-q6', 'Boston Bruins', 'Toronto Maple Leafs', D);
      for (let i = 0; i < 8; i++) {
        const ti = t + i * 5 * MIN;
        pm.note([Object.assign({}, e6, { bookmakers: [deux('pinnacle', e6, 1.92, 1.96)] })], 'icehockey_nhl', ti, { sport: 'nhl' });
        obs.noteDk(par('nhl-q6', su(1.95 + i / 100, 1.90, D)), ti);
        obs.noteEu('icehockey_nhl', 'nhl', { pinnacle: 1 }, ti + MIN, 'ok');
      }
      eq(obs.etat().rencontres['nhl-q6'].pa.length, 6, 'huit releves appariees : six paires gardees');
    }
    /* G8 : l'heure du catalogue passee suffit, meme si ESPN dit encore « pre » a venir */
    {
      raz();
      const t = Date.now();
      poseCatalogue([match('nhl-q7', 'nhl', 'Boston Bruins', 'Toronto Maple Leafs', t - 5 * MIN, 1.8, 2.0)]);
      const c = obs.noteDk(par('nhl-q7', su(1.95, 1.90, t + 10 * MIN)), t);
      ok(c === 0 && !obs.etat().rencontres['nhl-q7'], `coup d envoi du catalogue passe, ESPN « pre » a venir : ignore (${c})`);
    }
    /* P1 du tennis : en nombre de rencontres, sans date */
    {
      raz();
      const st = obs.etat(), T = Date.now(), d = T - H;
      st.debutParSport.tennis = T - J;
      for (let i = 0; i < 40; i++) st.rencontres['t' + i] = { s: 'tennis', l: 'tennis_atp_x', ev: 'te' + i, dom: 'P' + i, ext: 'Q' + i, debut: d, dk: null, pa: [],
        eu: { t: d - 2 * H, te: d - 2 * H, p: { 1: 0.5, 2: 0.5 }, elo: { 1: 2.2, 2: 1.7 } } };
      const P1 = obs.bilan(T).parSport.tennis.porte.P1;
      ok(P1.ok === true && P1.joursObservation < 7, `tennis : 40 rencontres en 1 jour, P1 tenue sans date (${P1.ok}, ${P1.joursObservation} j)`);
    }
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
    /* ... ce qui passe aussi avec une ecriture directe : on regarde donc OU
       l'ecriture va. Un arret au milieu d'une ecriture directe laisserait un
       carnet tronque, mis de cote au redemarrage (mutations du 10/10) */
    {
      const ecrits = [], vrai = fs.writeFileSync;
      fs.writeFileSync = function (f, ...a) { ecrits.push(String(f)); return vrai.call(fs, f, ...a); };
      try { obs.noteDk(par('nhl-c1', su(1.86, 1.94, D)), Date.now()); obs.flush(); } finally { fs.writeFileSync = vrai; }
      ok(ecrits.includes(obs.fichier() + '.tmp') && !ecrits.includes(obs.fichier()), `jamais d ecriture directe du carnet, toujours par le temporaire (${ecrits.map((f) => path.basename(f)).join(',')})`);
    }
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
    /* les releves aussi (l'historique de P3) : une cle dont toutes les releves sont vieilles disparait */
    st.releves.cle_vieille = [{ t: Date.now() - 9 * J, s: 'nhl', e: 'ok', b: 0, pi: 1, md: 0, a: 0, nul: 0 }];
    st.releves.icehockey_nhl = [{ t: Date.now() - 9 * J, s: 'nhl', e: 'ok', b: 0, pi: 1, md: 0, a: 0, nul: 0 }];
    obs.noteEu('icehockey_nhl', 'nhl', { pinnacle: 1 }, Date.now(), 'ok');
    recharge();
    ok(!obs.etat().rencontres.vieille && obs.etat().rencontres.recente, 'PARIS_OBS_JOURS=7 : la rencontre de 8 jours est purgee, celle de 6 jours reste');
    ok(!obs.etat().releves.cle_vieille && obs.etat().releves.icehockey_nhl.length === 1 && obs.etat().releves.icehockey_nhl[0].t > Date.now() - J,
       `et les releves de 9 jours aussi (${JSON.stringify(Object.keys(obs.etat().releves))}, ${obs.etat().releves.icehockey_nhl.length})`);
    process.env.PARIS_OBS_JOURS = '1';
    eq(obs.joursGardes(), 7, 'PARIS_OBS_JOURS=1 : 7 jours au moins (P1 et P3 en lisent 7)');
    process.env.PARIS_OBS_JOURS = '1000';
    eq(obs.joursGardes(), 365, 'PARIS_OBS_JOURS=1000 : 365 au plus');
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
    /* 40 rencontres (la part s'affiche) mais 5 paires eu-DK et 5 rencontres de
       fraicheur : ni ecart ni borne haute — la carte refuse de conclure sous
       son propre seuil (mutations du 10/10 : rien ne le tenait) */
    obs.oublie(); fs.rmSync(obs.fichier(), { force: true });
    const s6 = obs.etat(), d6 = T - H;
    const pose6 = (nPaires, nFraiches) => {
      for (let i = 0; i < 40; i++) {
        const elo = { 1: 1.70, 2: 2.05 };
        s6.rencontres['n' + i] = { s: 'nhl', l: 'icehockey_nhl', ev: 'n' + i, dom: 'A' + i, ext: 'B' + i, debut: d6, eu: null,
          pa: i < nPaires ? [[d6 - 2 * H, 0.551, 0.55]] : [],
          dk: { premier: null, a2h: i < nFraiches ? { t: d6 - 3 * H, c: { 1: 1.8, 2: 2.05 }, p: { 1: 0.54, 2: 0.46 }, elo } : null,
                fin: { t: d6 - 10 * MIN, c: { 1: 1.75, 2: 2.12 }, p: { 1: 0.55, 2: 0.45 }, elo }, n: 2, bouge: 1 } };
      }
      return bac.obsRend(obs.bilan(T), null);
    };
    const peuPaires = pose6(5, 5);
    ok(/<b>NHL<\/b>: 40 game\(s\) &middot; Elo beatable/.test(peuPaires), 'temoin : 40 rencontres, la part s affiche');
    ok(/eu&ndash;DK gap not enough pairs \(5\/20\)/.test(peuPaires) && !/signed/.test(peuPaires), 'sous 20 paires : « not enough pairs (5/20) », aucun ecart');
    ok(/2-hour-old price beatable 0\/10 &middot;/.test(peuPaires) && !/high bound/.test(peuPaires), 'sous 40 rencontres de fraicheur : le compte, aucune borne haute');
    const assez6 = pose6(20, 40);
    ok(/eu&ndash;DK gap \+0\.1 pts \(signed \+0\.1 pts, 20 games\)/.test(assez6) && /\(high bound /.test(assez6), 'a 20 paires et 40 rencontres de fraicheur : l ecart et la borne s affichent');
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log(`\nRATES : ${rates}/${n}`);
  console.log(`prix_observe.test.js : ${n - rates} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
