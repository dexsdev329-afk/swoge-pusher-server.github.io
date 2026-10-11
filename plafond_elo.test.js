'use strict';
/*
 * LE PLAFOND DES COTES ELO AU PRIX DU MARCHE OBSERVE (11/10/2026).
 *
 * ---- pourquoi ----
 *
 * Demande du proprietaire (11/10, ~19 h UTC) : « baisse les cotes pour le
 * tennis en attendant les resultats ». Le tennis reste vendu a l'Elo tant que
 * sa vente au marche n'a pas passe sa porte (EXPLOITATION 8.8nonies bis) ; le
 * 11/10, l'observation voyait 7 issues battables sur 20 a Wuhan, dont
 * Siniakova a 3,51 contre 46,2 % puis 47,3 % au marche (+62 %, +66 %).
 * PARIS_ELO_PLAFOND_MARCHE plafonne chaque issue d'une rencontre cotee a
 * l'Elo a la cote que le chemin du marche produirait sur le prix OBSERVE.
 * L'essai tient :
 *  1. variable vide (ou absente) : le catalogue est identique octet pour
 *     octet, aucune etiquette, la fonction rend l'objet recu ;
 *  2. variable posee : le plafond ne fait que BAISSER (jamais une cote au-dessus
 *     de l'Elo, aucune autre ligue ni aucun autre sport touche), aux cotes
 *     calculees le 11/10 (Siniakova 1,95, Zheng 2,29, de Minaur 1,63), et la
 *     rencontre reste cotee a l'Elo (plafond d'engagement, porte, CLV) ;
 *  3. issues inversees, sans prix, sans equipes, prix d'une autre rencontre
 *     (un seul nom different suffit), memes joueurs sous un autre identifiant,
 *     heure de prix qui ne fait pas une date : aucun plafond, et c'est compte ;
 *  4. favori du marche au-dela de 96 % : repli sur le rabot, entre 1,01 et
 *     l'Elo, le reste battable compte ;
 *  5. ce que la page montre est ce que la vente accepte (Game, puis un VRAI
 *     serveur en processus enfant : parisListe puis parie sur la socket ; la
 *     page OUVERTE recoit la liste repoussee quand le catalogue recharge
 *     change — relecture du 11/10 : 3,51 montre, 1,95 vendu) ;
 *  6. un pari pris garde sa cote ; le plafond repart de l'Elo frais a chaque
 *     import (jamais cumule), sur les deux chemins de l'import ; prix retire :
 *     l'Elo revient, sans etiquette ; chemin 2 quand `habille` leve : cote ET
 *     etiquette gardees ; retour arriere au chemin 2 : aucune etiquette ;
 *  7. l'observation mesure toujours l'Elo BRUT (eloDe, ecartAuMarche, noteEu) ;
 *     la cote VENDUE a cote, strictement moins battable, et sa pire issue ;
 *  8. 0 requete ajoutee : `fetch` espionne, memes appels avec et sans la
 *     variable ; la variable ne fait jamais relever une cle ;
 *  9. une erreur du plafond garde l'Elo et la rencontre (jamais ecartee) ;
 * 10. paris.valide garde l'etiquette valide, jette l'invalide, vue() ne la
 *     montre jamais ;
 * 11. le demarrage dit la variable (vide, prise, ignoree, chaque raison) ;
 *     /paris/import (etatImport) porte le compte par cle, les MEMES ignorees,
 *     et la cle en clair sans aucune rencontre (sansRencontre).
 * Un echec s'ecrit RATE ; la derniere ligne donne RATES : n/total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = 3600000, MIN = 60000, J = 86400000;
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok  ' + m); else { rates++; console.log('RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

if (process.argv[2] === '--serveur') serveur();
else principal();

// =====================================================================
function principal() {
for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'plafond-elo-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-plafond';
process.env.ODDS_API_FIN = new Date(Date.now() + 20 * J).toISOString().slice(0, 10);
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_efl_champ,nhl=icehockey_nhl,tennis=*';
process.env.ODDS_API_HORIZON = '7';
process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
process.env.PARIS_PRIX_RELEVE_H = '2';
process.env.PARIS_PRIX_OBSERVE = 'icehockey_nhl,soccer_efl_champ,tennis_atp_*,tennis_wta_*';

const DEMAIN = Date.now() + 2 * J;
const WTA = 'tennis_wta_wuhan_open', ATP = 'tennis_atp_shanghai_masters';
const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('e1', 'Arsenal', 'Everton', DEMAIN)],
  soccer_efl_champ: [ev('f1', 'Leeds United', 'Middlesbrough', DEMAIN + H)],
  icehockey_nhl: [ev('h1', 'Boston Bruins', 'Toronto Maple Leafs', DEMAIN)],
  [WTA]: [ev('w1', 'Katerina Siniakova', 'Liudmila Samsonova', DEMAIN + 10 * MIN), ev('w2', 'Qinwen Zheng', 'Mirra Andreeva', DEMAIN + 20 * MIN),
          ev('w3', 'Peyton Stearns', 'Iva Jovic', DEMAIN + 30 * MIN), ev('w4', 'Cristina Bucsa', 'Jasmine Paolini', DEMAIN + 40 * MIN),
          ev('w5', 'Elena Rybakina', 'Coco Gauff', DEMAIN + 50 * MIN), ev('w6', 'Emma Navarro', 'Daria Kasatkina', DEMAIN + 60 * MIN),
          ev('w7', 'Aryna Sabalenka', 'Ena Shibahara', DEMAIN + 70 * MIN), ev('w8', 'Belinda Bencic', 'Marta Kostyuk', DEMAIN + 80 * MIN)],
  [ATP]: [ev('a1', 'Alex de Minaur', 'Karen Khachanov', DEMAIN + 2 * H)],
};
const SPORTS = [{ key: WTA, group: 'Tennis', active: true }, { key: ATP, group: 'Tennis', active: true },
                { key: ATP + '_winner', group: 'Tennis', active: true }, { key: 'soccer_epl', group: 'Soccer', active: true }];
/* le faux reseau : The Odds API (gratuit : /sports, /events) et ESPN ; tout est ESPIONNE */
const appels = [];
global.fetch = async (url) => {
  const u = new URL(String(url));
  appels.push(u.hostname + u.pathname);
  if (/espn\.com$/.test(u.hostname)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: [] }) };
  if (u.origin !== 'https://api.the-odds-api.com') throw new Error('reseau interdit : ' + u.origin);
  const m = u.pathname.match(/^\/v4\/sports(?:\/([^/]+)\/(\w+))?$/);
  const ligue = m && m[1], quoi = m && m[2];
  let corps = [];
  if (!ligue) corps = SPORTS;
  else if (quoi === 'events') corps = EVENTS[ligue] || [];
  else throw new Error('cet essai ne paie rien : ' + u.pathname);
  const h = { 'x-requests-remaining': '20000', 'x-requests-used': '0', 'x-requests-last': '0' };
  return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
           json: async () => JSON.parse(JSON.stringify(corps)), text: async () => JSON.stringify(corps) };
};

const AS = require('./alerte_solde');
AS.oddsEvenement = () => true;
const pm = require('./prix_marche');
const prixLigues = require('./prix_ligues');
const cotes = require('./cotes');
const paris = require('./paris');
const imp = require('./paris_import');
const obs = require('./prix_observe');
const clv = require('./clv');
const { Game } = require('./game');
const cfg = require('./config');
const { ethers } = require('ethers');

/* les forces : celles du 11/10 ne sont pas dans l'amorce ; posees en memoire (rien d'ecrit) */
const FORCES = { 'Katerina Siniakova': 1500, 'Liudmila Samsonova': 1700, 'Qinwen Zheng': 1520, 'Mirra Andreeva': 1700,
  'Peyton Stearns': 1550, 'Iva Jovic': 1560, 'Cristina Bucsa': 1500, 'Jasmine Paolini': 1690, 'Elena Rybakina': 1650, 'Coco Gauff': 1700,
  'Emma Navarro': 1600, 'Daria Kasatkina': 1620, 'Aryna Sabalenka': 1800, 'Ena Shibahara': 1500, 'Belinda Bencic': 1640, 'Marta Kostyuk': 1600,
  'Alex de Minaur': 1600, 'Karen Khachanov': 1610 };
for (const [k, v] of Object.entries(FORCES)) cotes.poseNote('tennis', k, v);

/* ---- le carnet des prix, ecrit a la main : ce que l'observation aurait note ---- */
const T = Date.now();
const deux = (p1) => ({ 1: p1, 2: Math.round((1 - p1) * 1e5) / 1e5 });
const entree = (ligue, dom, ext, p, extra) => Object.assign({ t: T - H, ref: 'betfair', p, livres: 4, ecart: 0, ligue, dom, ext, debut: DEMAIN }, extra || {});
const CARNET = {
  w1: entree(WTA, 'Katerina Siniakova', 'Liudmila Samsonova', deux(0.462)),
  w2: entree(WTA, 'Qinwen Zheng', 'Mirra Andreeva', deux(0.381)),
  /* w3 : aucun prix */
  w4: entree(WTA, 'Jasmine Paolini', 'Cristina Bucsa', deux(0.30)),             // INVERSE
  w5: entree(WTA, 'Iga Swiatek', 'Aryna Sabalenka', deux(0.80)),                // les noms d'une AUTRE rencontre
  w6: entree(WTA, '', '', deux(0.80)),                                           // une entree sans equipes
  w7: entree(WTA, 'Aryna Sabalenka', 'Ena Shibahara', deux(0.98)),              // favori a 98 % : repli
  w8: entree('tennis_wta_china_open', 'Belinda Bencic', 'Marta Kostyuk', deux(0.80)),   // bons noms, AUTRE cle
  a1: entree(ATP, 'Alex de Minaur', 'Karen Khachanov', deux(0.568)),
  h1: entree('icehockey_nhl', 'Boston Bruins', 'Toronto Maple Leafs', deux(0.70)),
  f1: entree('soccer_efl_champ', 'Leeds United', 'Middlesbrough', { 1: 0.7, N: 0.2, 2: 0.1 }),
  e1: entree('soccer_epl', 'Arsenal', 'Everton', { 1: 0.6, N: 0.25, 2: 0.15 }, { ref: 'pinnacle' }),
};
const poseCarnet = (c) => fs.writeFileSync(pm.fichier(), JSON.stringify({ evenements: c, ligues: {}, couverture: {} }) + '\n');
const FCAT = path.join(BAC, 'paris_catalogue.json');
const lu = () => fs.readFileSync(FCAT);
const parEv = (e) => paris.catalogue().matchs.find((m) => m.source && m.source.evenement === e);
const brutEv = (e) => JSON.parse(fs.readFileSync(FCAT, 'utf8')).matchs.find((m) => m.source && m.source.evenement === e);
const c1n2 = (m) => m && m.marches && m.marches['1n2'] && m.marches['1n2'].cotes;
const importe = async () => { const k = appels.length; await imp.importeMatchs(); paris.charge(); return appels.slice(k); };
const capte = async (f) => {
  const lu2 = [], vrai = console.log;
  console.log = (...a) => { lu2.push(a.map(String).join(' ')); };
  let r;
  try { r = await f(); } finally { console.log = vrai; }
  return { r, lignes: lu2 };
};
const variable = (v) => { if (v === undefined) delete process.env.PARIS_ELO_PLAFOND_MARCHE; else process.env.PARIS_ELO_PLAFOND_MARCHE = v; };
const PROD = 'tennis_atp_*,tennis_wta_*';
/* la cote que le chemin du marche produit sur ce prix (la fonction meme du chemin vendu) */
const auMarche = (p) => cotes.marchesDuMarche('tennis', p, undefined, WTA)['1n2'].cotes;

(async () => {
  /* un calendrier vide sur le volume : l'amorce du depot n'entre pas dans l'essai */
  fs.writeFileSync(FCAT, JSON.stringify({ sports: [{ cle: 'tennis', nom: 'Tennis', actif: false }], matchs: [] }));
  paris.charge();
  poseCarnet(CARNET);

  console.log('\n-- 1. variable vide : rien ne change (octet pour octet) --');
  let F0, C0, A0;
  {
    variable(undefined);
    await importe();                    // le premier import lit /sports (le joker) : hors comparaison
    const x0 = await capte(importe);
    A0 = x0.r; F0 = lu(); C0 = JSON.parse(F0.toString());
    ok(C0.matchs.length === 12, `le calendrier porte les 12 rencontres de l essai (${C0.matchs.length})`);
    ok(!F0.toString().includes('plafondMarche'), 'variable absente : aucune etiquette au catalogue');
    ok(!x0.lignes.some((l) => /plafond Elo au marche/.test(l)), 'variable absente : aucune ligne « plafond Elo » au journal');
    variable('');
    const x1 = await capte(importe);
    ok(Buffer.compare(lu(), F0) === 0, 'variable vide ("") : catalogue IDENTIQUE octet pour octet a la variable absente');
    ok(!x1.lignes.some((l) => /plafond Elo au marche/.test(l)), 'variable vide : aucune ligne « plafond Elo »');
    variable('   ;  ,');
    await importe();
    ok(Buffer.compare(lu(), F0) === 0, 'variable faite de separateurs seuls : identique aussi');
    variable('tennis_*,basketball_*,cricket_odi,soccer_fa_cup,soccer_epl,americanfootball_nfl');
    await importe();
    ok(Buffer.compare(lu(), F0) === 0, 'variable sans aucune cle prise (jokers refuses, cricket, coupe, vendue, non observee) : identique');
    variable(undefined);
    const w1 = parEv('w1');
    ok(imp.plafonneAuMarche(w1, Date.now(), {}) === w1, 'plafonneAuMarche rend l objet RECU (meme identite) quand la variable est vide');
    eq(JSON.stringify(imp.etatPlafondElo().dernierImport.parLigue), '{}', 'etatImport : aucun compte par cle');
  }

  console.log('\n-- 2. variable posee : le plafond ne fait que BAISSER, le tennis seul --');
  let F1, C1, A1, x2;
  {
    variable(PROD);
    x2 = await capte(importe);
    A1 = x2.r; F1 = lu(); C1 = JSON.parse(F1.toString());
    eq(C1.matchs.length, C0.matchs.length, 'meme nombre de rencontres : aucune ecartee');
    let jamaisPlusHaut = true, autresIdentiques = true, baissees = 0;
    for (const m0 of C0.matchs) {
      const m1 = C1.matchs.find((x) => x.id === m0.id);
      for (const k of Object.keys(m0.marches)) for (const i of Object.keys(m0.marches[k].cotes)) {
        const a = m0.marches[k].cotes[i], b = m1.marches[k].cotes[i];
        if (!(b <= a)) jamaisPlusHaut = false;
        if (b < a) baissees++;
      }
      if (!/^tennis_/.test(m0.source.ligue) && JSON.stringify(m0) !== JSON.stringify(m1)) autresIdentiques = false;
    }
    ok(jamaisPlusHaut, 'aucune cote, sur aucun marche, au-dessus de celle de l Elo');
    ok(autresIdentiques, 'EPL (vendue), Championship (observee, football) et NHL (observee, non listee) : entrees IDENTIQUES');
    eq(baissees, 4, 'quatre issues baissees : Siniakova, Zheng, de Minaur, Sabalenka');
    const elo = (e) => C0.matchs.find((m) => m.source.evenement === e).marches['1n2'].cotes;
    const vend = (e) => c1n2(brutEv(e));
    /* les cotes calculees le 11/10 avec ce code (EXPLOITATION, commentaire de paris_import) */
    eq(`${vend('w1')[1]}|${vend('w2')[1]}|${vend('a1')[1]}`, '1.95|2.29|1.63', 'Siniakova 0,462 -> 1,95 ; Zheng 0,381 -> 2,29 ; de Minaur 0,568 -> 1,63');
    eq(vend('w1')[1], auMarche(deux(0.462))[1], 'la cote plafonnee est celle de cotes.marchesDuMarche (le chemin vendu), pas une formule a part');
    eq(`${vend('w1')[2]}|${vend('w2')[2]}|${vend('a1')[2]}`, `${elo('w1')[2]}|${elo('w2')[2]}|${elo('a1')[2]}`,
       'l AUTRE issue garde l Elo (un min, jamais un remplacement : elle ne monte pas a la cote du marche)');
    ok(auMarche(deux(0.462))[2] > elo('w1')[2], `... alors que la cote du marche de Samsonova (${auMarche(deux(0.462))[2]}) depasse son Elo (${elo('w1')[2]})`);
    for (const e of ['w1', 'w2', 'a1']) ok(vend(e)[1] * CARNET[e].p[1] < 1, `${e} : l issue plafonnee n est plus battable au prix observe (${vend(e)[1]} x ${CARNET[e].p[1]})`);
    const w1 = brutEv('w1');
    eq(JSON.stringify(w1.plafondMarche.elo), JSON.stringify(elo('w1')), 'l etiquette porte l Elo BRUT d avant le plafond');
    eq(`${w1.plafondMarche.ref}|${w1.plafondMarche.t}|${w1.plafondMarche.p[1]}`, `betfair|${new Date(T - H).toISOString()}|0.462`, '... et le prix (reference, heure, proba)');
    ok(!w1.prixMarche && w1.cotesGenerees === true, 'prixMarche n est JAMAIS pose : la cote reste fabriquee');
    const m = parEv('w1');
    ok(paris.aLElo(m), 'la rencontre plafonnee reste cotee a l Elo (paris.aLElo)');
    ok(paris.ouvert(m, Date.now()) && !paris.prixTropVieux(m, Date.now()), 'ouverte, et jamais « odds are being refreshed » (aucune porte d age du prix)');
    eq(clv.aLaVente(m, '1n2', '1'), null, 'aucune jambe CLV (ce n est pas une vente au prix du marche)');
    process.env.PARIS_ELO_ENGAGEMENT_MAX = '300000';
    const g = new Game();
    eq(`${g.plafondEngagement(m)}|${g.plafondEngagement(parEv('w3'))}`, '300000|300000', 'PARIS_ELO_ENGAGEMENT_MAX s applique toujours (300 000), plafonnee ou non');
    delete process.env.PARIS_ELO_ENGAGEMENT_MAX;
    eq(parEv('e1').prixMarche && parEv('e1').prixMarche.ref, 'pinnacle', 'l EPL reste au prix du marche (chemin vendu inchange)');
    ok(x2.lignes.some((l) => /^\[odds\] plafond Elo au marche tennis_wta_wuhan_open : \{/.test(l)) && x2.lignes.some((l) => /^\[odds\] plafond Elo au marche tennis_atp_shanghai_masters : \{/.test(l)),
       'une ligne « [odds] plafond Elo au marche <cle> » par cle plafonnee');
    ok(!x2.lignes.some((l) => /plafond Elo au marche (icehockey|soccer)/.test(l)), 'aucune pour la NHL ni le football');
    /* le catalogue ecrit passe le validateur du serveur */
    let err = null;
    try { paris.valide(JSON.parse(F1.toString())); } catch (e) { err = e; }
    eq(err && err.message, null, 'paris.valide accepte le catalogue plafonne');
  }

  console.log('\n-- 3. inverse, sans prix, sans equipes, autre rencontre : aucun plafond, compte --');
  {
    const meme = (e) => JSON.stringify(brutEv(e)) === JSON.stringify(C0.matchs.find((m) => m.source.evenement === e));
    ok(meme('w3'), 'w3 sans prix : cote Elo inchangee');
    ok(meme('w4'), 'w4 prix releve dans l AUTRE orientation : inchange (jamais retourne)');
    ok(meme('w5'), 'w5 prix sous son identifiant mais avec les noms d une AUTRE rencontre : refuse');
    ok(meme('w6'), 'w6 entree sans equipes (ancienne) : ambigue, refusee');
    ok(meme('w8'), 'w8 bons noms mais prix d une AUTRE cle (China Open) : refuse');
    const s = imp.etatPlafondElo().dernierImport.parLigue[WTA];
    eq(`${s.rencontres}|${s.elo}|${s.sansPrix}|${s.inverse}|${s.autre}|${s.sansEquipes}|${s.plafonnees}|${s.issues}|${s.repli}|${s.erreurs}`,
       '8|8|1|1|2|1|3|3|1|0', 'compte Wuhan : 8 rencontres a l Elo, 1 sans prix, 1 inverse, 2 autres, 1 sans equipes, 3 plafonnees (3 issues), 1 repli, 0 erreur');
    const sa = imp.etatPlafondElo().dernierImport.parLigue[ATP];
    eq(`${sa.rencontres}|${sa.plafonnees}|${sa.issues}`, '1|1|1', 'compte Shanghai : 1 rencontre, plafonnee sur une issue');
    /* deuxIssues et la marge du livre VENDU : chiffres exacts, pas un ordre de grandeur
       (mutations du 11/10 : « toujours incremente » et « marge sur l'Elo » passaient) */
    eq(s.deuxIssues, 0, 'deuxIssues : une seule issue baissee par rencontre (w1, w2, w7)');
    const mg = ['w1', 'w2', 'w7'].map((e) => paris.margeDe(c1n2(brutEv(e)), ['1', '2'], 1)).sort((a, b) => a - b);
    eq(`${s.margeMediane}|${s.margeMax}`, `${Math.round(mg[1] * 1000) / 1000}|${Math.round(mg[2] * 1000) / 1000}`, 'marge mediane et max : celles des livres VENDUS (plafonnes)');
    eq(`${s.eloBrut.battables}/${s.eloBrut.issues}`, '3/6', 'Elo BRUT contre le meme prix : 3 issues battables sur 6 jugees (3 rencontres appariees : la mesure qui fonde la regle)');
    eq(`${s.vendue.battables}/${s.vendue.issues}`, '1/6', 'cote vendue contre le meme prix : 1 sur 6 (le favori a 98 %, au plancher 1,03)');
    const el = (e) => C0.matchs.find((m) => m.source.evenement === e).marches['1n2'].cotes[1];
    const vd = (e) => c1n2(brutEv(e))[1];
    const attendu = Math.round(['w1', 'w2', 'w7'].reduce((t, e) => t + (el(e) - vd(e)) / el(e), 0) / 3 * 1000) / 1000;
    eq(s.ecartMoyen, attendu, 'ecart moyen = moyenne de (Elo - plafonnee) / Elo sur les issues baissees');
    eq(`${s.ageMedianH}|${s.ageMaxH}|${s.direct}`, '1|1|0', 'l age du prix est garde (1 h, mediane et max), aucun prix de direct');
    ok(s.margeMax > s.margeMediane && s.margeMediane > 0.02, `la marge du livre plafonne est dite (mediane ${s.margeMediane}, max ${s.margeMax})`);
    /* un prix dont la cote du marche depasse l'Elo sur les DEUX issues : rien ne baisse, aucune etiquette */
    const e3 = C0.matchs.find((m) => m.source.evenement === 'w3').marches['1n2'].cotes;
    let p3 = null;
    for (let x = 0.05; x < 0.95 && p3 === null; x += 0.0025) {
      const c = cotes.marchesDuMarche('tennis', deux(Math.round(x * 1e4) / 1e4), undefined, WTA);
      if (c && c['1n2'].cotes[1] >= e3[1] && c['1n2'].cotes[2] >= e3[2]) p3 = Math.round(x * 1e4) / 1e4;
    }
    ok(p3 !== null, `un prix ou le marche est plus genereux que l Elo sur les deux issues existe (p1 = ${p3})`);
    poseCarnet(Object.assign({}, CARNET, { w3: entree(WTA, 'Peyton Stearns', 'Iva Jovic', deux(p3)) }));
    await importe();
    const w3 = brutEv('w3');
    ok(JSON.stringify(c1n2(w3)) === JSON.stringify(e3) && !('plafondMarche' in w3), 'w3 : rien ne baisse, cote Elo et AUCUNE etiquette');
    ok(imp.plafonneAuMarche(w3, Date.now(), {}) === w3, '... et la fonction rend l objet recu (meme identite)');
    const s3 = imp.etatPlafondElo().dernierImport.parLigue[WTA];
    eq(`${s3.sansPrix}|${s3.plafonnees}|${s3.eloBrut.issues}`, '0|3|8', 'jugee (8 issues) sans etre plafonnee (toujours 3)');
    /* l'appariement « meme rencontre » : UN seul nom different suffit a refuser, et le prix des
       memes joueurs sous un AUTRE identifiant n'est jamais repris (mutations du 11/10 : ne
       comparer que l'exterieur, que le domicile, ou reprendre par noms, passaient) */
    poseCarnet(Object.assign({}, CARNET, {
      w5: entree(WTA, 'Elena Rybakina', 'Iga Swiatek', deux(0.80)),          // meme domicile, AUTRE exterieur
      w6: entree(WTA, 'Iga Swiatek', 'Daria Kasatkina', deux(0.80)),         // AUTRE domicile, meme exterieur
      autre_w3: entree(WTA, 'Peyton Stearns', 'Iva Jovic', deux(0.80)) }));  // memes joueurs que w3, AUTRE identifiant
    await importe();
    ok(meme('w5'), 'w5 : meme domicile mais AUTRE exterieur : aucun plafond');
    ok(meme('w6'), 'w6 : AUTRE domicile mais meme exterieur : aucun plafond');
    ok(meme('w3'), 'w3 : un prix des MEMES joueurs sous un AUTRE identifiant n est jamais pris');
    const sx = imp.etatPlafondElo().dernierImport.parLigue[WTA];
    eq(`${sx.autre}|${sx.sansEquipes}|${sx.sansPrix}|${sx.plafonnees}`, '3|0|1|3', 'compte : 3 autres (w5, w6, w8), 0 sans equipes, w3 sans prix, 3 plafonnees');
    /* une heure de prix qui ne fait pas une date (chaine ISO au lieu d'un nombre) : l'Elo est
       vendu, et rien ne dit « plafonnee » (relecture du 11/10 : plafonnees 1 ET erreurs 1) */
    poseCarnet(Object.assign({}, CARNET, { w1: entree(WTA, 'Katerina Siniakova', 'Liudmila Samsonova', deux(0.462), { t: new Date(T - H).toISOString() }) }));
    await importe();
    ok(meme('w1'), 'w1 au prix dont l heure est une chaine : Elo vendu, aucune etiquette');
    const st = imp.etatPlafondElo().dernierImport.parLigue[WTA];
    eq(`${st.plafonnees}|${st.issues}|${st.invalide}|${st.erreurs}|${st.ageMaxH}|${st.eloBrut.issues}`, '2|2|1|0|1|4',
       'compte : 2 plafonnees (w2, w7), w1 « invalide » (ni plafonnee ni erreur), age et issues jugees sans elle');
    poseCarnet(CARNET);
    await importe();
  }

  console.log('\n-- 4. favori du marche a 98 % : repli sur le rabot existant --');
  {
    eq(cotes.marchesDuMarche('tennis', deux(0.98), undefined, WTA), null, 'marchesDuMarche rend null au-dela d environ 96 %');
    const v = c1n2(brutEv('w7')), e = C0.matchs.find((m) => m.source.evenement === 'w7').marches['1n2'].cotes;
    eq(v[1], cotes.raboteIssues(e, deux(0.98), ['1', '2'])[1], 'repli : cotes.raboteIssues (6 % par issue, plancher 1,03), rien d invente');
    ok(v[1] >= paris.COTE_MIN && v[1] <= e[1] && v[1] < e[1], `la cote reste entre 1,01 et l Elo (${v[1]} <= ${e[1]})`);
    eq(v[2], e[2], 'l outsider garde son Elo');
    eq(brutEv('w7').plafondMarche.repli, true, 'l etiquette dit le repli');
  }

  console.log('\n-- 5. ce que la page montre est ce que la vente accepte (Game) --');
  const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
  const A = ('0x' + 'e7'.repeat(20)).toLowerCase();
  const g = new Game();
  g._p(A).betBalance = W(5000000);
  let pari = null;
  const mise = Math.max(cfg.PARI_MIN, 1000);
  {
    const m = parEv('w1');
    const v = g.parisOuverts(Date.now()).find((x) => x.id === m.id);
    ok(v && v.marches['1n2'].cotes['1'] === 1.95 && v.cotes['1'] === 1.95, 'parisOuverts (parisListe, /paris/calendrier) montre 1,95 dans les marches ET dans l echo a plat');
    ok(!JSON.stringify(v).includes('plafondMarche') && !('plafondMarche' in v), 'la vue ne porte jamais l etiquette (ni l Elo brut)');
    pari = g.parie(A, m.id, '1', mise, Date.now());
    eq(pari.jambes[0].cote, v.marches['1n2'].cotes['1'], 'game.parie (le chemin du message « parie ») vend a la cote montree');
    eq(`${pari.cote}|${pari.rapport}`, `1.95|${paris.rapport(1.95, mise)}`, 'la cote et le rapport du ticket');
    const c = g.parieCombine(A, [{ match: parEv('w2').id, marche: '1n2', choix: '1' }, { match: parEv('a1').id, choix: '1' }], mise, Date.now());
    eq(`${c.jambes[0].cote}|${c.jambes[1].cote}|${c.cote}`, `2.29|1.63|${Math.floor(2.29 * 1.63 * 1e4) / 1e4}`, 'un combine prend aussi les cotes plafonnees');
  }

  console.log('\n-- 6. un pari pris garde sa cote ; le plafond repart de l Elo frais a chaque import --');
  {
    const id = parEv('w1').id;
    poseCarnet(Object.assign({}, CARNET, { w1: entree(WTA, 'Katerina Siniakova', 'Liudmila Samsonova', deux(0.30), { t: T - 30 * MIN }) }));
    await importe();
    const nouv = c1n2(parEv('w1'));
    eq(nouv[1], Math.min(C0.matchs.find((m) => m.id === id).marches['1n2'].cotes[1], auMarche(deux(0.30))[1]),
       `prix neuf (30 %) : min(Elo, marche) = ${nouv[1]} — repart de l Elo, jamais min(1,95, ...) (aucun cumul)`);
    ok(nouv[1] > 1.95, 'la cote vendue suit le prix neuf (ici elle remonte, toujours sous l Elo)');
    const t = g.mesParis(A, 10).find((p) => p.id === pari.id);
    eq(`${t.jambes[0].cote}|${t.cote}|${t.rapport}`, `1.95|1.95|${paris.rapport(1.95, mise)}`, 'le ticket deja pris garde 1,95 et son rapport');
    /* chemin 2 : rencontres reprises de l'ancien calendrier (la cle n'a rien rendu) */
    const sauve = EVENTS[WTA];
    EVENTS[WTA] = [];
    poseCarnet(CARNET);
    await importe();
    const r = brutEv('w1');
    eq(`${r && c1n2(r)[1]}|${r && r.plafondMarche && r.plafondMarche.p[1]}`, '1.95|0.462', 'chemin 2 (rencontre reprise et retarifee) : plafonnee aussi, au prix du carnet');
    eq(JSON.stringify(r.plafondMarche.elo), JSON.stringify(C0.matchs.find((m) => m.id === id).marches['1n2'].cotes), '... depuis l Elo que habille vient de refaire');
    const sansW1 = Object.assign({}, CARNET); delete sansW1.w1;
    poseCarnet(sansW1);
    await importe();
    const r2 = brutEv('w1');
    ok(r2 && JSON.stringify(c1n2(r2)) === JSON.stringify(C0.matchs.find((m) => m.id === id).marches['1n2'].cotes) && !('plafondMarche' in r2),
       'chemin 2, prix retire : l Elo brut revient, et l etiquette d avant est effacee');
    /* chemin 2, `habille` leve sur une rencontre DEJA plafonnee : elle est gardee telle quelle,
       cote ET etiquette — la replafonner effacerait l'etiquette sans rien baisser, et
       l'observation noterait la cote plafonnee comme Elo (mutation du 11/10, passait) */
    poseCarnet(CARNET); await importe();
    ok(brutEv('w1').plafondMarche && c1n2(brutEv('w1'))[1] === 1.95, 'chemin 2 : w1 re-plafonnee');
    const avant = brutEv('w1'), vraiH = cotes.habille;
    cotes.habille = function (m) { if (m && m.source && m.source.evenement === 'w1') throw new Error('cotes : essai — devenue incotable'); return vraiH.apply(this, arguments); };
    try { await importe(); } finally { cotes.habille = vraiH; }
    const apres = brutEv('w1');
    eq(`${JSON.stringify(c1n2(apres))}|${JSON.stringify(apres.plafondMarche)}`, `${JSON.stringify(c1n2(avant))}|${JSON.stringify(avant.plafondMarche)}`,
       'chemin 2, habille leve : cote ET etiquette gardees, rien replafonne');
    eq(JSON.stringify(obs.eloDe(parEv('w1'))), JSON.stringify({ 1: avant.plafondMarche.elo[1], 2: avant.plafondMarche.elo[2] }), '... l observation lit toujours l Elo brut');
    /* chemin 2, variable videe (le retour arriere documente) : l'etiquette part AUSSI quand la
       variable ne couvre plus la cle (mutation du 11/10 : ne l'effacer que sous la variable, passait) */
    variable(undefined); await importe();
    const r3 = brutEv('w1');
    ok(r3 && !('plafondMarche' in r3) && JSON.stringify(c1n2(r3)) === JSON.stringify(C0.matchs.find((m) => m.id === id).marches['1n2'].cotes),
       'chemin 2, variable videe (retour arriere) : Elo brut ET aucune etiquette');
    ok(!('vendue' in imp.ecartAuMarche(WTA, Date.now())), '... ecartAuMarche ne voit plus aucune rencontre plafonnee');
    variable(PROD);
    EVENTS[WTA] = sauve;
    /* aucune porte d'age inventee : un prix de 48 h (au-dela des 36 h de la VENTE) baisse encore la cote,
       et son age est dit ; un prix note apres son coup d'envoi (direct possible) baisse aussi, compte */
    poseCarnet(Object.assign({}, CARNET, { w2: entree(WTA, 'Qinwen Zheng', 'Mirra Andreeva', deux(0.381), { t: T - 48 * H }),
                                           a1: entree(ATP, 'Alex de Minaur', 'Karen Khachanov', deux(0.568), { debut: T - 2 * H }) }));
    await importe();
    const sw = imp.etatPlafondElo().dernierImport.parLigue;
    eq(`${c1n2(brutEv('w2'))[1]}|${sw[WTA].ageMaxH}`, '2.29|48', 'un prix de 48 h plafonne encore (il ne peut que baisser), age max dit : 48 h');
    eq(pm.pour('w2'), null, '... alors que la vente au marche (pour, 36 h) le refuserait');
    eq(`${c1n2(brutEv('a1'))[1]}|${sw[ATP].direct}`, '1.63|1', 'un prix note apres son heure de debut : plafonne, et compte « direct »');
    poseCarnet(CARNET);
    await importe();
    variable(undefined);
    await importe();
    ok(!lu().toString().includes('plafondMarche') && Buffer.compare(lu(), F0) === 0,
       'retour arriere (variable videe) : au prochain import, le catalogue redevient celui de l Elo, octet pour octet');
    eq(g.mesParis(A, 10).find((p) => p.id === pari.id).jambes[0].cote, 1.95, '... et le ticket garde toujours 1,95');
    variable(PROD);
    await importe();
  }

  console.log('\n-- 7. l observation mesure toujours l Elo BRUT --');
  {
    const tm = Date.now();
    variable(undefined); await importe();
    const e0 = {}, d0 = {};
    for (const l of [WTA, ATP]) e0[l] = imp.ecartAuMarche(l, tm);
    for (const e of ['w1', 'w2', 'a1', 'w7']) d0[e] = JSON.stringify(obs.eloDe(parEv(e)));
    obs.noteEu(WTA, 'tennis', { betfair: 8 }, tm, 'ok');
    const eu0 = JSON.stringify(obs.etat().rencontres[parEv('w1').id].eu.elo);
    variable(PROD); await importe();
    for (const e of ['w1', 'w2', 'a1', 'w7']) eq(JSON.stringify(obs.eloDe(parEv(e))), d0[e], `eloDe(${e}) : l Elo brut, pas la cote vendue`);
    ok(c1n2(parEv('w1'))[1] !== obs.eloDe(parEv('w1'))[1], '... alors que la cote vendue differe');
    for (const l of [WTA, ATP]) {
      const e1 = imp.ecartAuMarche(l, tm);
      const sans = Object.assign({}, e1); delete sans.vendue;
      eq(JSON.stringify(sans), JSON.stringify(e0[l]), `ecartAuMarche(${l}) (ligne « [odds] observe ») : memes chiffres que sans plafond`);
      /* strictement moins : la cote VENDUE est jugee sur la cote vendue, pas sur l'Elo brut
         (mutation du 11/10 : « + 1 » laissait passer l'egalite, c'est-a-dire l'Elo brut) */
      ok(e1.vendue && e1.vendue.plafonnees >= 1 && e1.vendue.battables < e0[l].battables && e1.vendue.esperanceMoyenne < e0[l].esperanceMoyenne,
         `... et la cote VENDUE a cote, jugee sur la cote vendue (${e1.vendue && e1.vendue.battables} < ${e0[l].battables}, ${e1.vendue && e1.vendue.esperanceMoyenne} < ${e0[l].esperanceMoyenne})`);
      /* la pire issue REELLEMENT offerte (relecture du 11/10 : « pire » seul, l'Elo brut,
         laissait croire que 3,51 etait encore vendu) */
      const vp = e1.vendue && e1.vendue.pire;
      const mv = vp && paris.catalogue().matchs.find((x) => x.source && x.source.ligue === l && x.domicile + ' v ' + x.exterieur === vp.rencontre);
      ok(vp && mv && c1n2(mv)[vp.issue] === vp.cote && vp.esperance <= e0[l].pire.esperance,
         `${l} : vendue.pire porte la cote VENDUE au catalogue (${vp && vp.rencontre} ${vp && vp.issue} a ${vp && vp.cote}, ${vp && vp.esperance}), jamais pire que l Elo brut (${e0[l].pire.cote}, ${e0[l].pire.esperance})`);
      eq(JSON.stringify(e1.pire), JSON.stringify(e0[l].pire), `${l} : « pire » reste celui de l Elo brut (la mesure)`);
    }
    {
      /* Shanghai : le pire de l'Elo brut est de Minaur a son Elo (plafonne) ; la pire cote
         VENDUE est strictement moins genereuse. Wuhan : le pire reste Navarro, NON plafonnee
         (son entree sans equipes est ambigue) — la ligne dit vrai : c'est ce qui est offert,
         et Siniakova n'y est plus a son Elo. */
      const pa = imp.ecartAuMarche(ATP, tm).vendue.pire, pw = imp.ecartAuMarche(WTA, tm).vendue.pire;
      ok(e0[ATP].pire.rencontre === 'Alex de Minaur v Karen Khachanov' && pa.esperance < e0[ATP].pire.esperance && pa.cote === c1n2(parEv('a1'))[pa.issue],
         `Shanghai : pire Elo brut de Minaur ${e0[ATP].pire.cote} (${e0[ATP].pire.esperance}) ; pire VENDUE ${pa.rencontre} ${pa.issue} a ${pa.cote} (${pa.esperance})`);
      ok(pw.rencontre === 'Emma Navarro v Daria Kasatkina' && pw.cote === c1n2(parEv('w6'))[pw.issue] && !brutEv('w6').plafondMarche
         && !(pw.rencontre === 'Katerina Siniakova v Liudmila Samsonova' && pw.issue === '1'),
         `Wuhan : pire VENDUE ${pw.rencontre} ${pw.issue} a ${pw.cote} (non plafonnee, ambigue) ; Siniakova n y est plus`);
    }
    ok(!('vendue' in e0[WTA]), 'sans plafond, ecartAuMarche n a pas de champ « vendue » (sortie d avant)');
    /* la mesure d'observation reste la sienne (plus large que l'appariement du plafond : elle prend
       aussi une entree sans equipes et un prix d'une autre cle) : le plafond ne la change pas */
    eq(e0[WTA].battables, 5, 'Wuhan, ligne « [odds] observe » : 5 issues Elo battables, sa propre regle, inchangee');
    obs.noteEu(WTA, 'tennis', { betfair: 8 }, tm + 1000, 'ok');
    eq(JSON.stringify(obs.etat().rencontres[parEv('w1').id].eu.elo), eu0, 'noteEu (carnet d observation, P1/P2) note l Elo BRUT');
  }

  console.log('\n-- 8. 0 requete ajoutee : fetch espionne --');
  {
    variable(undefined); await importe();
    const sansV = await importe();
    variable(PROD);
    const avecV = await importe();
    eq(avecV.join(','), sansV.join(','), `import avec la variable : les MEMES requetes que sans (${avecV.length}, /events seulement)`);
    ok(avecV.every((u) => /\/events$/.test(u)), 'aucune /odds, aucun ESPN, aucun /sports de plus');
    const t = Date.now() + 24 * H;
    const p1 = imp.prixPerimes(t).join(',');
    variable(undefined);
    eq(imp.prixPerimes(t).join(','), p1, 'les cles a relever sont les memes avec ou sans la variable');
    process.env.PARIS_PRIX_OBSERVE = 'icehockey_nhl,soccer_efl_champ';
    variable(PROD);
    ok(!imp.prixPerimes(t).some((k) => /^tennis_/.test(k)), 'tennis non observe, variable posee : aucune cle tennis a relever (jamais une requete)');
    ok(!prixLigues.plafondElo(WTA), '... et aucun plafond (plafondElo faux)');
    const k = appels.length;
    await importe();
    ok(!lu().toString().includes('plafondMarche'), '... le catalogue n a aucune etiquette');
    ok(appels.slice(k).every((u) => /\/events$/.test(u)), '... et l import ne fait que /events');
    process.env.PARIS_PRIX_OBSERVE = 'icehockey_nhl,soccer_efl_champ,tennis_atp_*,tennis_wta_*';
    variable('tennis_wta_*');
    await importe();
    ok(brutEv('w1').plafondMarche && !brutEv('a1').plafondMarche, 'tennis_wta_* seul : Wuhan plafonne, Shanghai (ATP) non');
    variable(PROD + ',icehockey_nhl,soccer_efl_champ');
    await importe();
    ok(brutEv('h1').plafondMarche && c1n2(brutEv('h1'))[1] <= c1n2(C0.matchs.find((m) => m.source.evenement === 'h1'))[1],
       'une NHL listee ET observee est plafonnee (deux issues, seul marche 1n2)');
    const f1 = brutEv('f1');
    ok(!f1.plafondMarche && JSON.stringify(f1) === JSON.stringify(C0.matchs.find((m) => m.source.evenement === 'f1')),
       'le football liste et observe n est JAMAIS plafonne (plusieurs marches : arbitrage entre marches)');
    eq(imp.etatPlafondElo().dernierImport.parLigue.soccer_efl_champ.sportExclu, 1, '... et c est compte (sportExclu)');
    variable(PROD);
    await importe();
  }

  console.log('\n-- 9. une erreur du plafond garde l Elo et la rencontre --');
  {
    const vrai = pm.dernierPrix;
    pm.dernierPrix = () => { throw new Error('carnet en panne (essai)'); };
    let x;
    try { x = await capte(importe); } finally { pm.dernierPrix = vrai; }
    const w1 = brutEv('w1');
    ok(w1 && JSON.stringify(c1n2(w1)) === JSON.stringify(c1n2(C0.matchs.find((m) => m.source.evenement === 'w1'))) && !w1.plafondMarche,
       'la rencontre reste au catalogue, a l Elo de cet import, sans etiquette');
    eq(JSON.parse(lu().toString()).matchs.length, C0.matchs.length, 'aucune rencontre ecartee, le catalogue est ecrit');
    ok(imp.etatPlafondElo().dernierImport.parLigue[WTA].erreurs >= 8 && x.lignes.some((l) => /plafond Elo au marche .*Elo garde \(carnet en panne/.test(l)),
       'l erreur est comptee et dite au journal');
    /* une rencontre commencee, une cote relevee a la main, une rencontre au prix du marche : la fonction les rend telles quelles */
    const base = Object.assign({}, JSON.parse(JSON.stringify(brutEv('w2'))));
    await importe();
    const plafonnee = JSON.parse(JSON.stringify(brutEv('w2')));
    const commencee = Object.assign({}, plafonnee, { debut: new Date(Date.now() - MIN).toISOString() });
    ok(imp.plafonneAuMarche(commencee, Date.now(), {}) === commencee && 'plafondMarche' in commencee, 'commencee : rendue telle quelle, cote ET etiquette (ses paris sont poses)');
    const main = Object.assign({}, base, { cotesGenerees: false });
    delete main.plafondMarche;
    eq(JSON.stringify(c1n2(imp.plafonneAuMarche(main, Date.now(), {}))), JSON.stringify(c1n2(main)), 'cote relevee a la main : jamais touchee');
    const auPrix = Object.assign({}, main, { cotesGenerees: true, prixMarche: { ref: 'betfair', t: new Date().toISOString(), livres: 3, p: deux(0.5) } });
    eq(JSON.stringify(c1n2(imp.plafonneAuMarche(auPrix, Date.now(), {}))), JSON.stringify(c1n2(auPrix)), 'rencontre au prix du marche : jamais touchee');
    const suspendue = Object.assign({}, main, { cotesGenerees: true, suspendu: true });
    eq(JSON.stringify(c1n2(imp.plafonneAuMarche(suspendue, Date.now(), {}))), JSON.stringify(c1n2(suspendue)), 'rencontre suspendue : jamais touchee');
  }

  console.log('\n-- 10. paris.valide et vue() --');
  {
    const cat = JSON.parse(lu().toString());
    const w = cat.matchs.find((m) => m.source.evenement === 'w1');
    const v1 = paris.valide(cat).matchs.find((m) => m.id === w.id);
    eq(JSON.stringify(v1.plafondMarche.elo), JSON.stringify(w.plafondMarche.elo), 'valide garde l etiquette (l Elo brut lu par l observation)');
    const autres = paris.valide(cat).matchs.filter((m) => m.id !== w.id && !cat.matchs.find((x) => x.id === m.id).plafondMarche);
    ok(autres.every((m) => !('plafondMarche' in m)), 'sans etiquette : la rencontre validee n a pas la cle (exactement celle d avant)');
    const mal = JSON.parse(JSON.stringify(cat));
    mal.matchs.find((m) => m.id === w.id).plafondMarche.elo = { 1: 0.5, 2: 'x' };
    ok(!('plafondMarche' in paris.valide(mal).matchs.find((m) => m.id === w.id)), 'une etiquette invalide (Elo hors bornes) est jetee, sans faire tomber le catalogue');
    const mal2 = JSON.parse(JSON.stringify(cat));
    Object.assign(mal2.matchs.find((m) => m.id === w.id), { prixMarche: { ref: 'betfair', t: new Date().toISOString(), livres: 3, p: deux(0.5) } });
    ok(!('plafondMarche' in paris.valide(mal2).matchs.find((m) => m.id === w.id)), 'une etiquette sur une rencontre au prix du marche est jetee');
    const vue = paris.vue(parEv('w1'), Date.now());
    ok(!JSON.stringify(vue).includes('plafondMarche') && !JSON.stringify(vue).includes('"elo"'), 'paris.vue ne montre ni l etiquette ni l Elo brut');
  }

  console.log('\n-- 11. le demarrage dit la variable ; /paris/import porte le compte --');
  {
    const demarrage = () => {
      const lu2 = [], vrai = console.log;
      let ctl = null;
      console.log = (...a) => { lu2.push(a.join(' ')); };
      try { ctl = imp.planifie(() => {}, () => false); } finally { console.log = vrai; if (ctl) ctl.arrete(); }
      return lu2.join('\n');
    };
    const k = appels.length;
    variable(undefined);
    ok(/\[paris\] PARIS_ELO_PLAFOND_MARCHE : vide — aucune cote Elo plafonnee, rien ne change/.test(demarrage()), 'vide : dit « vide — rien ne change »');
    variable(PROD);
    let txt = demarrage();
    ok(/\[paris\] PARIS_ELO_PLAFOND_MARCHE : tennis_atp_\*, tennis_wta_\* — cotes Elo plafonnees au prix du marche observe/.test(txt) && !/ignoree\(s\)/.test(txt),
       'posee (la valeur de production) : les deux jokers pris, rien d ignore');
    variable('tennis_wta_*;basketball_*;soccer_efl_champ;americanfootball_nfl;soccer_epl');
    txt = demarrage();
    ok(/PARIS_ELO_PLAFOND_MARCHE basketball_\* \(joker refuse/.test(txt), 'un joker refuse est dit');
    ok(/PARIS_ELO_PLAFOND_MARCHE americanfootball_nfl \(non observee/.test(txt), 'une cle non observee est dite (aucun prix, jamais une requete)');
    ok(/PARIS_ELO_PLAFOND_MARCHE soccer_epl \(vendue au prix du marche/.test(txt), 'une cle vendue est dite');
    ok(/PARIS_ELO_PLAFOND_MARCHE soccer_efl_champ \(foot : plusieurs marches, jamais plafonnee\)/.test(txt), 'une cle de football observee est dite (plusieurs marches)');
    ok(/: tennis_wta_\* — cotes Elo plafonnees/.test(txt), '... et ce qui est pris reste dit');
    eq(appels.length - k, 0, 'le demarrage arrete aussitot n a fait aucune requete');
    /* chaque raison de refus, dite sous SA raison — cricket et sport inconnu MEME observes
       (mutations du 11/10 : la ligne les disait « plafonnees » ; coupe et _winner sous une
       fausse raison) */
    {
      const obs0 = process.env.PARIS_PRIX_OBSERVE;
      process.env.PARIS_PRIX_OBSERVE = obs0 + ',cricket_odi,basketball_euroleague';
      const dit = (v) => { variable(v); return demarrage(); };
      let x = dit('cricket_odi');
      ok(/PARIS_ELO_PLAFOND_MARCHE cricket_odi \(cricket refuse/.test(x) && /aucune cle prise/.test(x), 'cricket (meme observe) : refuse et dit, rien de pris');
      x = dit('basketball_euroleague');
      ok(/PARIS_ELO_PLAFOND_MARCHE basketball_euroleague \(sport inconnu/.test(x) && /aucune cle prise/.test(x), 'sport inconnu (meme observe) : dit, rien de pris');
      x = dit('soccer_fa_cup');
      ok(/PARIS_ELO_PLAFOND_MARCHE soccer_fa_cup \(coupe/.test(x), 'coupe : dite comme coupe');
      x = dit(ATP + '_winner');
      ok(/_winner \(classement/.test(x), '_winner : dit comme classement');
      process.env.PARIS_PRIX_OBSERVE = obs0;
    }
    /* /paris/import et la ligne de demarrage disent la MEME liste d'ignorees (relecture du
       11/10 : une cle de football n'etait dite qu'au demarrage) */
    {
      variable('tennis_wta_*;basketball_*;soccer_efl_champ;americanfootball_nfl;soccer_epl');
      const txt2 = demarrage();
      const ig = imp.etatPlafondElo().ignorees;
      ok(ig.some((x) => /PARIS_ELO_PLAFOND_MARCHE soccer_efl_champ \(foot : plusieurs marches/.test(x)), '/paris/import : la cle de football est dite ignoree, avec sa raison');
      ok(ig.length === 4 && ig.every((x) => txt2.includes(x)), `/paris/import et le demarrage : les memes ${ig.length} ignorees, mot pour mot`);
    }
    /* une cle en clair prise mais sans aucune rencontre (mal ecrite, couverte par le joker de
       PARIS_PRIX_OBSERVE) : dite apres l'import, au journal et dans /paris/import (relecture du 11/10) */
    {
      variable('tennis_atp_shanghai,tennis_wta_*');
      ok(/: tennis_atp_shanghai, tennis_wta_\* — cotes Elo plafonnees/.test(demarrage()), 'le demarrage ne peut pas la juger (aucune requete) : prise');
      const x = await capte(importe);
      eq(JSON.stringify(imp.etatPlafondElo().sansRencontre), '["tennis_atp_shanghai"]', '/paris/import : sansRencontre la nomme');
      ok(x.lignes.some((l) => /^\[odds\] plafond Elo au marche : aucune rencontre a venir pour tennis_atp_shanghai \(/.test(l)), '... et l import la dit au journal');
      ok(!brutEv('a1').plafondMarche && brutEv('w1').plafondMarche, '... Shanghai (vraie cle) n est pas plafonnee, Wuhan l est');
      variable(ATP + ',tennis_wta_*');
      const y = await capte(importe);
      eq(JSON.stringify(imp.etatPlafondElo().sansRencontre), '[]', 'la cle juste : sansRencontre vide');
      ok(!y.lignes.some((l) => /aucune rencontre a venir/.test(l)) && brutEv('a1').plafondMarche, '... aucune ligne, et Shanghai est plafonnee');
    }
    variable(PROD);
    await importe();
    const e = imp.etatImport().eloPlafondMarche;
    eq(`${e.variable.join(',')}|${e.ignorees.length}|${Object.keys(e.dernierImport.parLigue).sort().join(',')}`,
       `tennis_atp_*,tennis_wta_*|0|${ATP},${WTA}`, 'etatImport().eloPlafondMarche : la variable, rien d ignore, le compte par cle');
    const s = e.dernierImport.parLigue[WTA];
    ok(['plafonnees', 'issues', 'sansPrix', 'ecartMoyen', 'ageMaxH', 'eloBrut', 'vendue'].every((x) => x in s), 'par cle : plafonnees, issues, sans prix, ecart moyen, age, Elo brut, vendue');
  }

  console.log('\n-- 12. le vrai serveur : parisListe puis parie sur la socket (processus enfant) --');
  {
    const { spawnSync } = require('child_process');
    const BACS = fs.mkdtempSync(path.join(os.tmpdir(), 'plafond-elo-srv-'));
    fs.copyFileSync(FCAT, path.join(BACS, 'paris_catalogue.json'));
    /* le catalogue de l'Elo brut (variable vide, §1) : ce que lisent les pages qui se
       reconnectent au deploiement, avant l'import qui pose le plafond */
    const CAT2 = path.join(BACS, 'catalogue_elo_brut.json');
    fs.writeFileSync(CAT2, F0);
    const w1 = brutEv('w1');
    const env = Object.assign({}, process.env);
    for (const x of Object.keys(env)) if (/^(PARIS_|ODDS_API_)/.test(x)) delete env[x];
    Object.assign(env, { DATA_DIR: BACS, ESSAI_MATCH: w1.id, ESSAI_COTE: String(c1n2(w1)[1]), ESSAI_ELO: String(w1.plafondMarche.elo[1]), ESSAI_CAT2: CAT2 });
    const c = spawnSync(process.execPath, [__filename, '--serveur'], { env, encoding: 'utf8', timeout: 180000 });
    const lignes = String(c.stdout || '').split('\n');
    for (const l of lignes) if (/^ {2}ok {2}/.test(l)) { n++; console.log(l.replace(/^ {2}ok {2}/, '  ok  [serveur] ')); }
    for (const l of lignes) if (/^RATE /.test(l)) { n++; rates++; console.log('RATE [serveur] ' + l.slice(5)); }
    eq(`${c.status}|${lignes.some((l) => /^SERVEUR FINI$/.test(l))}`, '0|true', 'le serveur enfant a fini vert'
       + (c.status ? ' — ' + String(c.stderr || '').slice(0, 400) : ''));
    try { fs.rmSync(BACS, { recursive: true, force: true }); } catch (e) { /* rien */ }
  }

  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* rien */ }
  console.log(`\nRATES : ${rates}/${n}`);
  console.log(`plafond_elo.test.js : ${n - rates} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
}

// =====================================================================
/*
 * LE VRAI SERVEUR, EN PROCESSUS ENFANT. Le catalogue plafonne ecrit par
 * l'import du parent est sur le volume ; ODDS_API_KEY est vide (aucune
 * minuterie d'import) et `fetch` refuse toute requete qui ne va pas au
 * serveur lui-meme. Un joueur se connecte (signature), lit parisListe et
 * /paris/calendrier, parie par le message « parie » : le ticket porte la cote
 * montree, jamais l'Elo brut.
 */
async function serveur() {
  const fetchVrai = global.fetch;
  const refusees = [];
  global.fetch = async (u0, op) => {
    if (/^http:\/\/127\.0\.0\.1:/.test(String(u0))) return fetchVrai(u0, op);
    refusees.push(String(u0));
    throw new Error('aucune requete reseau dans cet essai');
  };
  const net = require('net');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => r(q)); }); });
  Object.assign(process.env, { PORT: String(port), RPC_URL: '', ADMIN_KEY: 'cle-de-banc-plafond', ODDS_API_KEY: '',
    AI_COLONIE: '0', PERP_COLONIES: '0', PERP_JOURNAL: '0', POLY_PAPIER: '0', DEPLOIEMENT_V4: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', MONITEUR_URL: '' });
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
    notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  const vraiLog = console.log;
  const traces = [];
  console.log = (...a) => { traces.push(a.map(String).join(' ')); };
  const dit = (l) => vraiLog(l);
  const okS = (c, m) => dit((c ? '  ok  ' : 'RATE ') + m);
  try {
    const { ethers } = require('ethers');
    const cfg = require('./config');
    const { Game } = require('./game');
    let moteur = null;
    const p0 = Game.prototype._p;
    Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
    require('./server');
    const base = 'http://127.0.0.1:' + port;
    for (let k = 0; k < 100; k++) { try { if ((await fetchVrai(base + '/health')).ok) break; } catch (e) { /* pas encore */ } await new Promise((r) => setTimeout(r, 100)); }
    const WebSocket = require('ws');
    const s = await new Promise((res, rej) => {
      const x = new WebSocket('ws://127.0.0.1:' + port);
      x.recus = [];
      x.on('message', (d) => { try { x.recus.push(JSON.parse(d)); } catch (e) { /* rien */ } });
      x.on('open', () => res(x)); x.on('error', rej);
    });
    const attend = (type, ms) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function tour() {
        const m = s.recus.filter((x) => x.type === type || x.type === 'error').pop();
        if (m) return res(m);
        if (Date.now() - t0 > (ms || 8000)) return rej(new Error('pas de ' + type));
        setTimeout(tour, 25);
      })();
    });
    const id = process.env.ESSAI_MATCH, cote = Number(process.env.ESSAI_COTE), elo = Number(process.env.ESSAI_ELO);
    const h = await attend('hello');
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'parisListe' }));
    const liste = await attend('parisListe');
    const m = (liste.matchs || []).find((x) => x.id === id);
    okS(m && m.marches['1n2'].cotes['1'] === cote && m.cotes['1'] === cote, `parisListe (la page) montre ${cote} pour Siniakova (Elo brut ${elo})`);
    okS(!JSON.stringify(liste).includes('plafondMarche'), 'parisListe ne porte jamais l etiquette ni l Elo brut');
    const cal = await (await fetchVrai(base + '/paris/calendrier')).json();
    const mc = (cal.matchs || []).find((x) => x.id === id);
    okS(mc && mc.marches['1n2'].cotes['1'] === cote, '/paris/calendrier (route publique) montre la meme cote');
    const w = ethers.Wallet.createRandom();
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend('auth');
    const addr = w.address.toLowerCase();
    moteur._p(addr).betBalance = ethers.utils.parseUnits('1000000', cfg.DECIMALS);
    const mise = Math.max(cfg.PARI_MIN, 1000);
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'parie', match: id, choix: '1', mise }));
    const r = await attend('pariPose');
    okS(r.type === 'pariPose', 'le message « parie » est accepte' + (r.type === 'error' ? ' — ' + r.error : ''));
    const j = r.pari && r.pari.jambes && r.pari.jambes[0];
    okS(j && j.cote === cote && r.pari.cote === cote, `le ticket (pariPose) porte ${cote} : la cote montree, jamais l Elo brut ${elo}`);
    okS(r.pari && r.pari.rapport === Math.floor(cote * mise * 1e6) / 1e6, 'le rapport du ticket descend de la cote montree');
    const apres = (r.matchs || []).find((x) => x.id === id);
    okS(apres && apres.cotes['1'] === cote, 'la liste renvoyee avec le ticket montre la meme cote');
    /* le serveur tente ses autres sources au demarrage (refusees ici) ; aucune n'est The Odds API */
    okS(!refusees.some((u) => /the-odds-api/.test(u)), 'aucune requete a The Odds API (' + refusees.length + ' autre(s) requete(s) du demarrage refusee(s))');

    /* ---- LA PAGE OUVERTE SUIT LE CATALOGUE RECHARGE (relecture du 11/10) ----
     * Avant : la page ne recevait la liste qu'a la connexion ; ouverte avant l'import qui
     * pose le plafond, elle montrait 3,28 et le ticket portait 1,95. Le serveur repousse
     * maintenant `parisListe` aux sockets qui l'ont demandee quand le catalogue recharge a
     * change — ici comme `rafraichit` : le fichier ecrit, puis paris.charge(). */
    const parisM = require('./paris');
    const FC = path.join(process.env.DATA_DIR, 'paris_catalogue.json');
    const plafonne = fs.readFileSync(FC, 'utf8');
    const s2 = await new Promise((res, rej) => {
      const x = new WebSocket('ws://127.0.0.1:' + port);
      x.recus = [];
      x.on('message', (d) => { try { x.recus.push(JSON.parse(d)); } catch (e) { /* rien */ } });
      x.on('open', () => res(x)); x.on('error', rej);
    });
    const attendS = (sock, type, ms) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function tour() {
        const q = sock.recus.filter((x) => x.type === type || x.type === 'error').pop();
        if (q) return res(q);
        if (Date.now() - t0 > (ms || 8000)) return rej(new Error('pas de ' + type));
        setTimeout(tour, 25);
      })();
    });
    await attendS(s2, 'hello');
    const sur = (l) => (l.matchs || []).find((x) => x.id === id);
    s.recus.length = 0; s2.recus.length = 0;
    fs.writeFileSync(FC, fs.readFileSync(process.env.ESSAI_CAT2, 'utf8'));
    parisM.charge();
    const p1 = await attendS(s, 'parisListe');
    okS(p1.type === 'parisListe' && sur(p1) && sur(p1).cotes['1'] === elo && sur(p1).marches['1n2'].cotes['1'] === elo,
        `catalogue recharge et change (Elo brut) : parisListe repoussee SANS etre demandee, ${elo} pour Siniakova`);
    okS(Array.isArray(p1.mesParis) && p1.mesParis.some((x) => x.id === r.pari.id) && p1.min === cfg.PARI_MIN && Array.isArray(p1.sports),
        '... la liste entiere : sports, bornes de mise, et les paris de CE joueur');
    s.recus.length = 0;
    fs.writeFileSync(FC, plafonne);
    parisM.charge();
    const p2 = await attendS(s, 'parisListe');
    okS(sur(p2) && sur(p2).cotes['1'] === cote, `l import qui pose le plafond : la page ouverte recoit ${cote} aussitot (plus ${elo})`);
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'parie', match: id, choix: '1', mise }));
    const r2 = await attendS(s, 'pariPose');
    okS(r2.type === 'pariPose' && r2.pari.jambes[0].cote === sur(p2).cotes['1'] && r2.pari.cote === cote, `le ticket suivant porte la cote repoussee (${cote})`);
    s.recus.length = 0;
    parisM.charge();
    await new Promise((q) => setTimeout(q, 400));
    okS(!s.recus.some((x) => x.type === 'parisListe'), 'un rechargement SANS changement du fichier ne repousse rien');
    okS(!s2.recus.some((x) => x.type === 'parisListe'), 'une socket qui n a jamais demande la liste (un autre jeu) ne la recoit jamais');
    try { s2.close(); } catch (e) { /* rien */ }
    try { s.close(); } catch (e) { /* rien */ }
    dit('SERVEUR FINI');
    process.exit(0);
  } catch (e) {
    dit('RATE ' + ((e && e.stack) || e));
    dit(traces.filter((x) => /paris|Error|erreur/i.test(x)).slice(-10).join('\n'));
    process.exit(1);
  }
}
