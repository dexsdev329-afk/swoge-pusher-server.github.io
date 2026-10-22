'use strict';
/*
 * LE DIRECT EN JEU SUR LES TRES GROSSES EQUIPES : OBSERVATION SEULEMENT
 * (lot 7 de la cle 20K, 11/10/2026).
 *
 * Ce que l'essai tient, chaque promesse avec la verification qui tomberait si
 * son garde-fou etait retire :
 *  1. la selection : club de la liste (exact apres normalisation), championnat
 *     liste ET vendu au marche ET au tableau ESPN, fenetre de suivi, entree
 *     vivante ; « Real Madrid;Barcelona » = « Real Madrid, Barcelona » ;
 *  2. eteint par defaut : PARIS_EN_JEU vide, `0`, `vendre` ou sans cle = aucune
 *     minuterie, aucun appel, aucun fichier ; allume, rien de vendu ne change
 *     (paris.ouverts, le carnet paris_prix.json octet pour octet), et ni le
 *     moteur ni le message WS ne connaissent le direct (lot 12) ;
 *  3. le cout, par le VRAI `appel` du socle : un appel par championnat, h2h et
 *     eu, eventIds, x-requests-last additionne, CLASSE 2 (la part du jour moins
 *     80 refuse le direct et laisse passer une releve de prix), plafonds du
 *     jour et de l'observation, compteurs relus apres un redeploiement, limites
 *     coupees si elles coutent plus d'un credit, jamais la cle au journal ;
 *  4. l'admission : part du jour, plafond de 3 000 sans prolongation, arret
 *     apres PARIS_EN_JEU_OBS_MATCHS, une rencontre coupee est « incomplete » ;
 *  5. ESPN partage : refus comptes a part, recul sur 403/429 qui double,
 *     rencontre non appariee coupee a 30 min ;
 *  6. le bilan sur un journal fabrique a la main, chiffres EXACTS ; « not
 *     enough » sous l'echantillon ; une seule condition rouge ferme la porte ;
 *  7. LA PORTE SUR DEUX JOURNAUX SYNTHETIQUES (et d'autres) : sain ->
 *     verte, bourse en retard de 60 s -> rouge par G2, bourse figee et ESPN
 *     lent -> rouge par G1, bourse ET ESPN en retard (60 s et 45 s) -> jamais
 *     verte (le retard d'ESPN borne, relecture du 11/10/2026), ESPN a 15 s ->
 *     rouge par G2, coup d'envoi 15 s en retard -> toujours verte ; l'outil
 *     hors serveur rend le meme bilan ;
 *  8. la sonde du last_update : absent, l'observation s'arrete (1 credit) ;
 *  9. LES GARDES RETIREES UNE A UNE : chaque entree de GARDES remplacee par
 *     « toujours vrai » laisse passer SON scenario ;
 * 10. le journal : purge a 30 jours et 20 Mo, route (400, 404, 200) ;
 * 11. l'etat lisible (/paris/import -> enJeu) ;
 * 12. les garde-fous que la mutation du 11/10/2026 laissait passer : chaque
 *     condition de la porte sait rougir, une rencontre ne compte que finie,
 *     appariee, a 90 % ; le plafond tenu avant chaque releve, le recul plafonne
 *     et remis a zero, la fin a 130 min, le tic non reentrant, la purge qui
 *     epargne le jour courant, l'objet du catalogue relu a chaque tic ;
 * 13. les trous de la SECONDE mutation et les constats de la relecture du
 *     11/10/2026 : bornes des reglages, selection illisible, admission
 *     (engages, jour, socle, quota qui leve, refusee jamais relevee),
 *     compteur illisible qui reste ferme apres un redeploiement, etat() sans
 *     effet de bord, engagement fantome, comptages, cadence ESPN de 15 s,
 *     chaque SOUS-condition des gardes, l'offre, chaque condition seule rouge,
 *     la porte ecrite d'avance cle par cle.
 *
 * Aucun reseau : `fetch` et ESPN sont remplaces. Aucun credit.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'en-jeu-'));
const DONNEES = path.join(BAC, 'principal');
fs.mkdirSync(DONNEES);
process.env.DATA_DIR = DONNEES;
process.env.ODDS_API_KEY = 'cle-de-banc-du-direct';
process.env.ODDS_API_TOTAL = '20000';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); n++; console.log('  ok  ' + m); };
/* ---- UN ESSAI QUI S'ARRETE AVANT SA FIN N'EST PAS VERT ----
 * Une promesse jamais tenue (une releve qui n'aboutit pas) vide la boucle de
 * Node, qui sort alors en SILENCE avec le code 0 : la mutation du 11/10/2026
 * (tic reentrant) passait ainsi pour verte sans avoir fini. */
let fini = false;
process.on('exit', (c) => { if (c === 0 && !fini) { console.error('RATE : l essai s est arrete avant sa fin (' + n + ' verifications)'); process.exitCode = 1; } });
const titre = (t) => console.log('\n-- ' + t + ' --');
/* Les lignes [en-jeu] du module : gardees pour les essais qui les lisent, tues a l'ecran */
const traces = [];
const logVrai = console.log;
console.log = (...a) => { const s = a.map(String).join(' '); if (/^\[(en-jeu|odds|espn)\]/.test(s)) { traces.push(s); return; } logVrai(...a); };
const dit = (re) => traces.some((s) => re.test(s));

const enJeu = require('./paris_en_jeu');
const espn = require('./scores_espn');
const sim = require('./essais/en_jeu/simulation');
const MIN = 60000;
const nouveau = (nom) => { const d = path.join(BAC, nom); fs.mkdirSync(d, { recursive: true }); process.env.DATA_DIR = d; enJeu.recharge(); return d; };
const lisJournal = () => sim.lignesDe(enJeu, enJeu.dossierJournal());

/* une rencontre du catalogue */
const rencontre = (id, dom, ext, ligue, debut, x) => Object.assign({ id, sport: 'foot', competition: 'x', domicile: dom, exterieur: ext, debut,
  source: { fournisseur: 'the-odds-api', ligue, evenement: 'ev-' + id }, ferme: null, suspendu: false }, x || {});

(async () => {
  // ==================================================================== 1
  titre('1. la selection');
  {
    process.env.PARIS_EN_JEU = 'observe';
    const cfg = enJeu.config();
    eq(cfg.equipes.join('|'), 'Real Madrid|Barcelona|Bayern Munich|Paris Saint Germain|Manchester City|Liverpool|Arsenal|Inter Milan',
       'les huit clubs par defaut, noms exacts de The Odds API');
    eq(cfg.ligues.join(','), 'soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga,soccer_france_ligue_one,soccer_uefa_champs_league',
       'les six championnats par defaut (vendus au marche, au tableau ESPN)');
    eq(JSON.stringify([cfg.cadenceS, cfg.espnS, cfg.delaiS, cfg.creditsObs, cfg.creditsJour, cfg.obsMatchs, cfg.limites]),
       JSON.stringify([60, 15, 60, 3000, 400, 24, false]), 'cadence 60 s, ESPN 15 s, delai 60 s, plafonds 3 000 / 400, 24 rencontres, limites eteintes');
    eq(JSON.stringify(enJeu.decoupeEquipes('Real Madrid;Barcelona')), JSON.stringify(enJeu.decoupeEquipes('Real Madrid, Barcelona')),
       '« Real Madrid;Barcelona » et « Real Madrid, Barcelona » donnent la meme liste');
    eq(enJeu.decoupeEquipes(' Real Madrid ; Paris Saint Germain ,, ').join('|'), 'Real Madrid|Paris Saint Germain', 'les espaces des noms restent (jamais un separateur)');
    const T = Date.UTC(2026, 9, 18, 19, 0);
    const cat = [
      rencontre('bar-get', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', T),
      rencontre('get-ala', 'Getafe', 'Alavés', 'soccer_spain_la_liga', T),
      rencontre('bar-seg', 'Barcelona', 'Racing', 'soccer_spain_segunda_division', T),
      rencontre('bar-uel', 'Barcelona', 'Lyon', 'soccer_uefa_europa_league', T),
      rencontre('acm-int', 'AC Milan', 'Inter Milan', 'soccer_italy_serie_a', T),
      rencontre('int-acm-vieille', 'Inter Milan', 'AC Milan', 'soccer_italy_serie_a', T, { ferme: T - 86400000, source: { fournisseur: 'the-odds-api', ligue: 'soccer_italy_serie_a', evenement: 'ev-dup' } }),
      rencontre('int-acm-neuve', 'Inter Milan', 'AC Milan', 'soccer_italy_serie_a', T, { source: { fournisseur: 'the-odds-api', ligue: 'soccer_italy_serie_a', evenement: 'ev-dup' } }),
      rencontre('ars-tard', 'Arsenal', 'Everton', 'soccer_epl', T + 10 * MIN),
      Object.assign(rencontre('nba', 'Real Madrid', 'Barcelona', 'soccer_epl', T), { sport: 'nba' }),
    ];
    const ids = (t, c) => enJeu.aSuivre(cat, t, c || enJeu.config()).map((x) => x.m.id).sort().join(',');
    eq(ids(T), 'acm-int,bar-get,int-acm-neuve', 'au coup d envoi : Barcelona-Getafe, AC Milan-Inter (exterieur), la NOUVELLE entree du match deplace');
    ok(!ids(T).includes('get-ala'), 'Getafe-Alaves (aucun club de la liste) : pas suivie');
    ok(!ids(T).includes('bar-seg') && !ids(T).includes('bar-uel'), 'un club de la liste dans une ligue hors liste (Segunda, Europa League) : pas suivie');
    ok(!ids(T).includes('nba'), 'un autre sport : pas suivi');
    eq(ids(T - 3 * MIN), '', 'trois minutes avant le coup d envoi : rien');
    ok(ids(T + 8 * MIN).includes('ars-tard'), 'deux minutes avant : suivie');
    ok(!ids(T + 131 * MIN).includes('bar-get'), 'plus de 130 min apres : plus suivie');
    eq(enJeu.aSuivre([rencontre('vieille-seule', 'Inter Milan', 'AC Milan', 'soccer_italy_serie_a', T, { ferme: T - 86400000 })], T, enJeu.config()).length, 1,
       'une entree fermee SANS remplacante reste suivie (la garde nonFermee la juge au bilan)');
    /* une ligue a l'Elo (non vendue au marche) n'est pas suivie */
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_italy_serie_a';
    eq(ids(T), 'acm-int,int-acm-neuve', 'la Liga sortie de PARIS_PRIX_LIGUES (cotee a l Elo) : Barcelona-Getafe n est plus suivie');
    ok(enJeu.config().ecartees.includes('soccer_spain_la_liga'), 'et la ligue est dite ecartee');
    delete process.env.PARIS_PRIX_LIGUES;
    process.env.PARIS_EN_JEU_LIGUES = 'soccer_epl; soccer_spain_segunda_division,soccer_uefa_europa_league';
    eq(enJeu.config().ligues.join(','), 'soccer_epl', 'PARIS_EN_JEU_LIGUES : une cle non vendue au marche ou une coupe est ignoree');
    eq(enJeu.config().ecartees.join(','), 'soccer_spain_segunda_division,soccer_uefa_europa_league', 'et dite');
    /* vendue au marche ne suffit pas : du football (la NHL a un tableau ESPN) ET un tableau ESPN (sans lui, ni score ni horloge) */
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,icehockey_nhl,soccer_fiji_premier';
    process.env.PARIS_EN_JEU_LIGUES = 'soccer_epl,icehockey_nhl,soccer_fiji_premier';
    eq(`${enJeu.config().ligues.join(',')}|${enJeu.config().ecartees.join(',')}`, 'soccer_epl|icehockey_nhl,soccer_fiji_premier',
       'une cle vendue mais pas du football (NHL), ou sans tableau ESPN : ignoree et dite');
    delete process.env.PARIS_PRIX_LIGUES;
    delete process.env.PARIS_EN_JEU_LIGUES;
    /* la cadence a son plancher (la bourse est rafraichie toutes les 10 s), le delai n'est jamais sous la cadence */
    process.env.PARIS_EN_JEU_CADENCE_S = '5';
    eq(enJeu.config().cadenceS, 10, 'PARIS_EN_JEU_CADENCE_S=5 : plancher 10 s');
    process.env.PARIS_EN_JEU_CADENCE_S = '120'; process.env.PARIS_EN_JEU_DELAI_S = '60';
    eq(enJeu.config().delaiS, 120, 'cadence 120 s, delai 60 s : le delai monte a 120 s (la releve qui juge doit exister)');
    delete process.env.PARIS_EN_JEU_CADENCE_S; delete process.env.PARIS_EN_JEU_DELAI_S;
    process.env.PARIS_EN_JEU_EQUIPES = 'Barcelona;Real Madrid';
    eq(ids(T), 'bar-get', 'PARIS_EN_JEU_EQUIPES reduit la liste');
    process.env.PARIS_EN_JEU_EQUIPES = 'barcelona';
    eq(ids(T), 'bar-get', 'la comparaison se fait apres normalisation (casse)');
    process.env.PARIS_EN_JEU_EQUIPES = 'AC Milan';
    eq(ids(T), 'acm-int,int-acm-neuve', '« AC Milan » ne suit pas l Inter par ressemblance (seulement les matchs de l AC Milan)');
    process.env.PARIS_EN_JEU_EQUIPES = 'Inter';
    eq(ids(T), '', '« Inter » seul ne suit ni l Inter Milan ni personne : aucune ressemblance');
    delete process.env.PARIS_EN_JEU_EQUIPES;
    /* un nom absent du calendrier en cours est dit au demarrage */
    nouveau('demarrage');
    traces.length = 0;
    const p = enJeu.planifie({ cle: true, appel: async () => [], catalogue: () => cat, minuteries: false });
    ok(dit(/club\(s\) absent\(s\) du calendrier en cours.*Bayern Munich/), 'un club absent du calendrier est dit au demarrage');
    p.arrete();
    delete process.env.PARIS_EN_JEU;
  }

  // ==================================================================== 2
  titre('2. eteint par defaut ; allume, rien de vendu ne change');
  {
    const T = Date.now() + 60000;
    const cat = [rencontre('bar-get', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', T)];
    for (const v of [undefined, '', '0', 'vendre', 'OBSERVER']) {
      const d = nouveau('off-' + String(v));
      if (v === undefined) delete process.env.PARIS_EN_JEU; else process.env.PARIS_EN_JEU = v;
      let appels = 0;
      traces.length = 0;
      const p = enJeu.planifie({ cle: true, appel: async () => { appels++; return []; }, catalogue: () => cat, minuteries: false,
                                 lisEspn: async () => { appels++; return new Map(); }, quota: () => ({ depense: 0, part: 1000, reserve: 80 }) });
      await p.tic(T);
      await enJeu.tic(T, { appel: async () => { appels++; return []; }, catalogue: () => cat, horloge: () => T });
      eq(`${p.actif}|${appels}|${fs.readdirSync(d).length}`, 'false|0|0', `PARIS_EN_JEU=${JSON.stringify(v)} : inerte, 0 appel, 0 fichier`);
      if (v === 'vendre') ok(dit(/inconnu : seul « observe » existe.*RIEN ne tourne/), '`vendre` (le lot 12) ne fait rien tourner, et le dit');
    }
    process.env.PARIS_EN_JEU = 'observe';
    {
      const d = nouveau('sans-cle');
      const p = enJeu.planifie({ cle: false, appel: async () => [], catalogue: () => cat, minuteries: false });
      eq(`${p.actif}|${fs.readdirSync(d).length}`, 'false|0', 'sans ODDS_API_KEY : inerte quelle que soit la valeur');
    }
    /* allume : le catalogue servi et le carnet des prix ne bougent pas */
    const d = nouveau('rien-de-vendu');
    const paris = require('./paris');
    const carnet = path.join(d, 'carnet-temoin.json');
    fs.writeFileSync(carnet, JSON.stringify({ evenements: { x: { t: 1, p: { 1: 0.5, N: 0.3, 2: 0.2 } } } }));
    const empreinte = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const pmFichier = require('./prix_marche').fichier();
    const avantCarnet = fs.existsSync(pmFichier) ? empreinte(pmFichier) : 'absent';
    const avantTemoin = empreinte(carnet);
    const avantOuverts = JSON.stringify(paris.ouverts(Date.now()));
    const r = await sim.simule(enJeu, d, 'sain', { calendrier: sim.calendrier(3, 2) });
    ok(r.appels.length >= 10, `${r.appels.length} releves faites (au moins 10)`);
    eq(JSON.stringify(paris.ouverts(Date.now())), avantOuverts, 'paris.ouverts identique (JSON)');
    eq(fs.existsSync(pmFichier) ? empreinte(pmFichier) : 'absent', avantCarnet, 'le carnet de vente paris_prix.json : empreinte sha256 identique');
    eq(empreinte(carnet), avantTemoin, 'aucun fichier du dossier touche hors du journal du direct');
    ok(!fs.existsSync(path.join(d, 'paris_prix.json')), 'aucun carnet de prix ecrit par le direct');
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
    ok(!/parieEnJeu|pariEnJeu/.test(src), 'ni le message WS ni le moteur ne connaissent un pari en jeu (lot 12)');
    ok(!/paris_en_jeu|_pireSiVendu|enJeu:\s*\{/.test(fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8')), 'game.js ne connait pas le direct (ni module, ni _pireSiVendu, ni jambe en jeu)');
  }

  // ==================================================================== 3
  titre('3. le cout, par le vrai appel du socle (classe 2)');
  {
    process.env.DATA_DIR = DONNEES;
    enJeu.recharge();
    process.env.PARIS_EN_JEU = 'observe';
    const imp = require('./paris_import');
    const vus = [];
    let coutSuivant = 1;
    const fetchVrai = global.fetch;
    global.fetch = async (u0) => {
      const u = new URL(String(u0));
      const ligue = (/\/sports\/([^/]+)\/odds/.exec(u.pathname) || [])[1];
      const ids = String(u.searchParams.get('eventIds') || '').split(',').filter(Boolean);
      vus.push({ url: String(u0), ligue, ids, markets: u.searchParams.get('markets'), regions: u.searchParams.get('regions'),
                 lim: u.searchParams.get('includeBetLimits'), fmt: u.searchParams.get('oddsFormat') });
      const t = new Date(Date.now() - 3000).toISOString();
      /* ev-c : le fournisseur a INVERSE domicile et exterieur (deja vu, paris_import) */
      const evs = ids.map((id) => ({ id, home_team: id === 'ev-b' ? 'Liverpool' : id === 'ev-c' ? 'Getafe' : 'Arsenal',
                                    away_team: id === 'ev-b' ? 'Fulham' : id === 'ev-c' ? 'Barcelona' : 'Everton', commence_time: t,
                                    bookmakers: [{ key: 'betfair_ex_eu', markets: [{ key: 'h2h', last_update: t, outcomes: [
                                      { name: id === 'ev-b' ? 'Liverpool' : id === 'ev-c' ? 'Barcelona' : 'Arsenal', price: 1.9, bet_limit: 1234 },
                                      { name: 'Draw', price: 3.6 }, { name: id === 'ev-b' ? 'Fulham' : id === 'ev-c' ? 'Getafe' : 'Everton', price: 4.4 }] }] }] }));
      const c = coutSuivant;
      return { ok: true, status: 200,
               headers: { get: (k) => ({ 'x-requests-remaining': '19000', 'x-requests-used': '1000', 'x-requests-last': String(c) }[k.toLowerCase()] || null) },
               json: async () => evs, text: async () => JSON.stringify(evs) };
    };
    /* Midi UTC du jour courant, pas Date.now() : le scenario avance d'une quinzaine de minutes
       simulees, et lance a 23:54 UTC (verifie.sh du 21/10) il franchissait minuit — les credits
       du jour repartaient de zero et « UNE releve, puis plus rien » en voyait trois. Les compteurs
       du socle restent ceux du jour reel, le meme jour. */
    const midi = new Date(); midi.setUTCHours(12, 0, 0, 0);
    const t0 = midi.getTime();
    const K = t0 + 60000;
    const cat = [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', K), rencontre('b', 'Liverpool', 'Fulham', 'soccer_epl', K),
                 rencontre('c', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', K)];
    let maintenant = t0;
    const quota = () => { const q = imp.etatQuota(); return { depense: q.depenseDuJour, part: imp.partDuJour(q.reste), reserve: imp.RESERVES_CLASSE[2] }; };
    const espnVide = async () => new Map();
    const deps = { cle: true, appel: imp.appel, catalogue: () => cat, minuteries: false, horloge: () => maintenant, quota, lisEspn: espnVide };
    const p = enJeu.planifie(deps);
    await p.tic(maintenant);
    eq(vus.length, 2, 'deux championnats suivis : DEUX appels (un par championnat)');
    const epl = vus.find((v) => v.ligue === 'soccer_epl');
    eq(epl.ids.sort().join(','), 'ev-a,ev-b', 'les deux rencontres de Premier League partagent UN appel (eventIds=a,b)');
    eq(`${epl.markets}|${epl.regions}|${epl.fmt}|${epl.lim}`, 'h2h|eu|decimal|null', 'markets=h2h, regions=eu, oddsFormat=decimal, pas d includeBetLimits par defaut');
    const E1 = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8'));
    eq(E1.credits.total, 2, 'le cout lu dans x-requests-last est additionne : 2 credits');
    eq(E1.rencontres.a.cr + E1.rencontres.b.cr, 1, 'l appel partage se divise entre ses rencontres (0,5 + 0,5)');
    const classes = JSON.parse(fs.readFileSync(path.join(DONNEES, 'odds_classes.json'), 'utf8'));
    const jour = new Date().toISOString().slice(0, 10);
    eq(classes.jours[jour]['2'].depense, 2, 'le socle les compte en CLASSE 2 (odds_classes.json)');
    const liga = lisJournal().find((l) => l.k === 'c' && l.l === 'soccer_spain_la_liga').ev[0];
    eq(`${liga.o}|${JSON.stringify(liga.b)}`, '0|[1.9,3.6,4.4]', 'fournisseur inverse : orientation notee 0, et les prix lus par NOM dans notre orientation (Barcelona 1,9)');
    const ars = lisJournal().find((l) => l.k === 'c' && l.l === 'soccer_epl').ev.find((e) => e.id === 'a');
    eq(`${ars.o}|${ars.ref}|${JSON.stringify(ars.pb)}|${ars.s}`, '1|b|' + JSON.stringify(ars.pb) + '|' + ars.s, '(Arsenal : orientation 1, reference bourse)');
    ok(ars.pb && Math.abs(ars.pb[0] + ars.pb[1] + ars.pb[2] - 1) < 1e-4 && ars.s > 1 && ars.s < 1.06, 'p sans marge de la bourse (somme 1), somme des inverses saine');
    const brut = fs.readdirSync(enJeu.dossierJournal()).map((f) => fs.readFileSync(path.join(enJeu.dossierJournal(), f), 'utf8')).join('');
    ok(!brut.includes(process.env.ODDS_API_KEY) && !brut.includes('apiKey'), 'le journal ne porte jamais la cle ni l URL');
    ok(vus.every((v) => v.url.includes('apiKey=')), '(la cle part bien dans l URL de l appel, et seulement la)');
    /* un redeploiement : les compteurs se relisent du disque */
    enJeu.recharge();
    eq(enJeu.etat().credits.total, 2, 'apres un rechargement (redeploiement), le compteur est relu : 2');
    /* la part du jour moins 80 refuse le direct, et laisse passer une releve de prix (classe 0) */
    const q = imp.etatQuota();
    const part = imp.partDuJour(q.reste);
    q.depenseDuJour = part - 80; q.jour = jour;
    fs.writeFileSync(path.join(DONNEES, 'odds_quota.json'), JSON.stringify(q));
    maintenant += 61000;
    vus.length = 0;
    traces.length = 0;
    await p.tic(maintenant);
    eq(vus.length, 0, `depense du jour = part (${part}) - 80 : le direct est REFUSE par le socle (rien ne part)`);
    const E2 = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8'));
    eq(['a', 'b', 'c'].map((id) => E2.rencontres[id].etat + ':' + E2.rencontres[id].raison).join(','),
       'incomplete:part du jour (classe 2),incomplete:part du jour (classe 2),incomplete:part du jour (classe 2)',
       'et les rencontres sont « incomplete » (le suivi s arrete)');
    await imp.appel('/sports/soccer_epl/odds', { regions: 'eu', markets: 'h2h' }, 1, 'prix soccer_epl', 1, { classe: 0 });
    eq(vus.length, 1, 'la meme part laisse passer une releve de PRIX (classe 0, prioritaire)');
    /* les plafonds propres : jour */
    const d2 = nouveau('plafond-jour');
    fs.writeFileSync(path.join(DONNEES, 'odds_quota.json'), JSON.stringify(Object.assign(imp.etatQuota(), { depenseDuJour: 0 })));
    process.env.PARIS_EN_JEU_CREDITS_JOUR = '120';
    vus.length = 0;
    const cat2 = [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', K)];
    const p2 = enJeu.planifie(Object.assign({}, deps, { catalogue: () => cat2 }));
    maintenant = t0;
    for (let k = 0; k < 6; k++) { await p2.tic(maintenant); maintenant += 61000; }
    eq(vus.length, 6, 'plafond du jour 120 : une rencontre estimee a 115 est admise, une releve par minute');
    const E3 = JSON.parse(fs.readFileSync(path.join(d2, 'paris_en_jeu_quota.json'), 'utf8'));
    E3.credits.jours[jour] = 119;
    fs.writeFileSync(path.join(d2, 'paris_en_jeu_quota.json'), JSON.stringify(E3));
    enJeu.recharge();
    vus.length = 0;
    for (let k = 0; k < 3; k++) { await p2.tic(maintenant); maintenant += 61000; }
    eq(vus.length, 1, 'a 119 credits du jour : UNE releve (120), puis plus rien');
    eq(JSON.parse(fs.readFileSync(path.join(d2, 'paris_en_jeu_quota.json'), 'utf8')).rencontres.a.raison, 'plafond du jour', 'la rencontre finit « incomplete » : plafond du jour');
    delete process.env.PARIS_EN_JEU_CREDITS_JOUR;
    /* les limites : demandees, puis coupees si elles coutent plus d'un credit */
    nouveau('limites');
    process.env.PARIS_EN_JEU_LIMITES = '1';
    vus.length = 0;
    coutSuivant = 2;
    const p3 = enJeu.planifie(Object.assign({}, deps, { catalogue: () => cat2 }));
    maintenant = t0;
    await p3.tic(maintenant); maintenant += 61000; coutSuivant = 1; await p3.tic(maintenant);
    eq(vus.map((v) => String(v.lim)).join(','), 'true,null', 'PARIS_EN_JEU_LIMITES=1 : includeBetLimits=true, puis COUPE apres une releve a 2 credits');
    const lc = lisJournal().filter((l) => l.k === 'c');
    eq(JSON.stringify(lc[0].ev[0].bl), JSON.stringify({ bet_limit: 1234 }), 'les cles brutes de la limite sont gardees (nom non documente)');
    ok(lisJournal().some((l) => l.k === 'x' && l.quoi === 'limites coupees'), 'la coupure est ecrite au journal');
    delete process.env.PARIS_EN_JEU_LIMITES;
    coutSuivant = 1;
    global.fetch = fetchVrai;
  }

  // ==================================================================== 4
  titre('4. l admission');
  {
    process.env.PARIS_EN_JEU = 'observe';
    const cfg = enJeu.config();
    nouveau('admission');
    eq(enJeu.estimation(cfg), 115, 'une rencontre estimee a 115 credits (115 min a 60 s)');
    const q = (depense, part) => () => ({ depense, part, reserve: 80 });
    eq(enJeu.admet(Date.now(), cfg, q(0, 195)).ok, true, 'part 195 : 0 + 115 <= 195 - 80, admise');
    const r1 = enJeu.admet(Date.now(), cfg, q(1, 195));
    ok(!r1.ok && /part du jour du socle/.test(r1.raison), 'part 195, 1 deja depense : 116 > 115, refusee (« ' + r1.raison + ' »)');
    ok(!enJeu.admet(Date.now(), cfg, () => null).ok, 'part du jour inconnue : refusee (echoue ferme)');
    /* le plafond de l'observation : jamais rouvert le 1er du mois */
    const E = JSON.parse(JSON.stringify({ v: 1, credits: { total: 2886, jours: {}, mois: { '2026-10': 2886 } }, appels: 0, rencontres: {} }));
    fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify(E));
    enJeu.recharge();
    eq(enJeu.admet(Date.now(), cfg, q(0, 100000)).ok, false, '2 886 deja depenses : 2 886 + 115 > 3 000, refusee');
    eq(enJeu.admet(Date.UTC(2026, 10, 2, 12), cfg, q(0, 100000)).ok, false, 'et toujours refusee le 2 novembre : aucune prolongation automatique');
    process.env.PARIS_EN_JEU_CREDITS_OBS = '6000';
    eq(enJeu.admet(Date.now(), enJeu.config(), q(0, 100000)).ok, true, 'prolonger, c est relever PARIS_EN_JEU_CREDITS_OBS a la main');
    /* le plafond du jour, a l'admission */
    fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify({ v: 1, credits: { total: 300, jours: { [new Date().toISOString().slice(0, 10)]: 286 }, mois: {} }, appels: 0, rencontres: {} }));
    enJeu.recharge();
    const rj = enJeu.admet(Date.now(), cfg, q(0, 100000));
    ok(!rj.ok && /^plafond du jour \(286 \+ 0 engages \+ 115 > 400\)$/.test(rj.raison), '286 credits deja depenses aujourd hui : 286 + 115 > 400, refusee (« ' + rj.raison + ' »)');
    /* un compteur illisible echoue ferme, et il est mis de cote */
    fs.writeFileSync(enJeu.fichierEtat(), '{"v":1,"credits":{"total":12');
    enJeu.recharge();
    const ri = enJeu.admet(Date.now(), cfg, q(0, 100000));
    eq(`${ri.ok}|${ri.raison}`, 'false|compteur illisible', 'compteur illisible : plus aucune admission (on ne sait plus ce qui a ete depense)');
    ok(fs.readdirSync(path.dirname(enJeu.fichierEtat())).some((f) => /^paris_en_jeu_quota\.json\.illisible-\d+$/.test(f)), 'et le fichier est mis de cote, jamais ecrase');
    ok(dit(/compteur illisible .* AUCUNE rencontre admise/), 'et c est dit');
    process.env.PARIS_EN_JEU_CREDITS_OBS = 'trois mille';
    eq(enJeu.config().creditsObs, 0, 'un plafond illisible echoue ferme (0)');
    delete process.env.PARIS_EN_JEU_CREDITS_OBS;
    process.env.PARIS_EN_JEU_CREDITS_JOUR = 'quatre cents';
    eq(enJeu.config().creditsJour, 0, 'le plafond du jour illisible aussi (0)');
    delete process.env.PARIS_EN_JEU_CREDITS_JOUR;
    /* les rencontres en cours comptent ce qu'il leur reste */
    fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify({ v: 1, credits: { total: 2800, jours: {}, mois: {} }, appels: 0,
      rencontres: { x: { etat: 'admise', est: 115, cr: 10 } } }));
    enJeu.recharge();
    eq(enJeu.admet(Date.now(), cfg, q(0, 100000)).ok, false, '2 800 + 105 engages (115 - 10) + 115 > 3 000 : refusee');
    fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify({ v: 1, credits: { total: 2770, jours: {}, mois: {} }, appels: 0,
      rencontres: { x: { etat: 'admise', est: 115, cr: 10 } } }));
    enJeu.recharge();
    eq(enJeu.admet(Date.now(), cfg, q(0, 100000)).ok, true, '2 770 + 105 + 115 = 2 990 <= 3 000 : admise');
    /* l'arret apres PARIS_EN_JEU_OBS_MATCHS rencontres completes */
    process.env.PARIS_EN_JEU_OBS_MATCHS = '1';
    const d = nouveau('obs-matchs');
    const cal = sim.calendrier(5, 2);
    cal[1].K = cal[0].K + 3 * 3600000;
    const rObs = await sim.simule(enJeu, d, 'sain', { calendrier: cal });
    const E2 = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8'));
    eq(`${E2.rencontres['sim-0'].complete}|${E2.rencontres['sim-1'].etat}|${E2.rencontres['sim-1'].raison}`,
       'true|refusee|observation finie (1 rencontre(s) complete(s))', 'PARIS_EN_JEU_OBS_MATCHS=1 : la premiere complete, la seconde refusee');
    /* mutation du 11/10/2026 (P123) : une rencontre REFUSEE n'est jamais relevee (ni payee) */
    eq(rObs.appels.filter((a) => a.ids.includes(cal[1].ev)).length, 0, '... et AUCUNE releve /odds ne porte la rencontre refusee');
    ok(lisJournal().some((l) => l.k === 'x' && l.quoi === 'observation finie'), 'la fin de l observation est ecrite au journal');
    delete process.env.PARIS_EN_JEU_OBS_MATCHS;
    /* une rencontre coupee est incomplete et sort du bilan */
    const b = enJeu.bilan(lisJournal(), {});
    eq(b.echantillon.rencontres, 1, 'au bilan : une rencontre complete, la refusee ne compte pas');
    /* une admission apres le coup d'envoi (redeploiement a mi-match) n'est jamais complete */
    const d3 = nouveau('mi-match');
    const cal3 = sim.calendrier(5, 1);
    const r3 = await sim.simule(enJeu, d3, 'sain', { calendrier: cal3 });
    void r3;
    const L3 = lisJournal();
    const tard = L3.map((l) => (l.k === 'a' ? Object.assign({}, l, { t: l.d + 10 * MIN }) : l));
    eq(enJeu.bilan(tard, {}).echantillon.rencontres, 0, 'une rencontre admise 10 min apres le coup d envoi ne compte pas au bilan');
    eq(enJeu.bilan(L3, {}).echantillon.rencontres, 1, '(la meme, admise avant : complete)');
    /* et le module lui-meme ne la compte pas (le compte qui arrete l'observation) */
    nouveau('mi-match-module');
    const cal4 = sim.calendrier(5, 1);
    const cat4 = cal4.map((m) => rencontre(m.id, m.dom, m.ext, m.ligue, m.K, { source: { fournisseur: 'the-odds-api', ligue: m.ligue, evenement: m.ev } }));
    let t4 = cal4[0].K + 10 * MIN;
    const p4 = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t4, catalogue: () => cat4,
                                appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return [sim.evenementOdds(cal4[0], t4, 'sain', () => 0.5)]; },
                                fetchEspn: async (u) => ({ ok: true, status: 200, json: async () => ({ events: /dates=20261012/.test(String(u)) ? [sim.evenementEspn(cal4[0], t4, 20)] : [] }) }),
                                quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
    for (; t4 <= cal4[0].K + (sim.FIN_S + 120) * 1000; t4 += 5000) await p4.tic(t4);
    const r4 = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8')).rencontres[cal4[0].id];
    eq(`${r4.etat}|${r4.complete}`, 'terminee|false', 'admise 10 min apres le coup d envoi : terminee mais JAMAIS complete (OBS_MATCHS ne la compte pas)');
    /* moins de 90 % des releves prevues reussies : terminee, jamais complete (le module, pas seulement le bilan) */
    nouveau('quatre-vingt-dix');
    let t9 = cal4[0].K - 2 * MIN, k9 = 0;
    const p9 = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t9, catalogue: () => cat4,
                                appel: async (c, pa, k, q, pr, info) => { k9++; Object.assign(info, { dernier: 1, statut: 200 });
                                  return k9 % 3 === 0 ? [sim.evenementOdds(cal4[0], t9, 'sain', () => 0.5)] : []; },
                                fetchEspn: async () => ({ ok: true, status: 200, json: async () => ({ events: [sim.evenementEspn(cal4[0], t9, 20)] }) }),
                                quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
    for (; t9 <= cal4[0].K + (sim.FIN_S + 120) * 1000; t9 += 5000) await p9.tic(t9);
    const r9 = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8')).rencontres[cal4[0].id];
    ok(r9.etat === 'terminee' && r9.complete === false && r9.ok < 0.9 * (r9.ok + r9.ko),
       `un tiers des releves avec la rencontre (${r9.ok} sur ${r9.ok + r9.ko}) : terminee, NON complete (90 % exiges)`);
    eq(enJeu.bilan(lisJournal(), {}).echantillon.rencontres, 0, '... et le bilan ne la compte pas non plus');
    /* l'etat du catalogue a chaque releve : fermee, suspendue, reglee, ancienne entree */
    nouveau('drapeaux');
    const K5 = Date.UTC(2026, 9, 24, 12, 0);
    const cat5 = [rencontre('f', 'Arsenal', 'Everton', 'soccer_epl', K5, { ferme: K5 - 3600000 }),
                  rencontre('s', 'Liverpool', 'Fulham', 'soccer_epl', K5, { suspendu: true }),
                  rencontre('g', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', K5)];
    const odds5 = (m) => ({ id: m.source.evenement, home_team: m.domicile, away_team: m.exterieur, bookmakers: [] });
    const p5 = enJeu.planifie({ cle: true, minuteries: false, horloge: () => K5, catalogue: () => cat5, lisEspn: async () => new Map(),
                                estRegle: (id) => id === 'g', quota: () => ({ depense: 0, part: 100000, reserve: 80 }),
                                appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 });
                                  return cat5.filter((m) => pa.eventIds.split(',').includes(m.source.evenement)).map(odds5); } });
    await p5.tic(K5);
    const ent = {};
    for (const l of lisJournal()) if (l.k === 'c') for (const e of l.ev) ent[e.id] = e;
    eq(`${ent.f.fe}|${ent.s.su}|${ent.g.rg}|${ent.g.fe}|${ent.g.su}`, '1|1|1|undefined|undefined', 'chaque releve note fermee (fe), suspendue (su), reglee (rg) : les gardes du bilan les lisent');
    eq(`${ent.g.lu}|${ent.g.pb}`, 'null|undefined', 'sans bourse dans la reponse : ni last_update ni p (jamais une bourse vivante)');
  }

  // ==================================================================== 5
  titre('5. ESPN partage : refus comptes, recul, non appariee');
  {
    process.env.PARIS_EN_JEU = 'observe';
    nouveau('espn');
    const K = Date.UTC(2026, 9, 20, 12, 0);
    const cat = [rencontre('bar-get', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', K)];
    let statut = 429, lectures = 0, maintenant = K - 2 * MIN;
    const fetchEspn = async () => { lectures++; return { ok: statut === 200, status: statut, json: async () => ({ events: [] }) }; };
    const appel = async (c, p, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return []; };
    const p = enJeu.planifie({ cle: true, appel, catalogue: () => cat, fetchEspn, minuteries: false, horloge: () => maintenant,
                               quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
    await p.tic(maintenant);
    eq(lectures, 1, 'la passe rapide lit le tableau ESPN : une requete (un coup d envoi de midi, une journee)');
    const e1 = enJeu.etat().espn;
    eq(`${e1.refus}|${e1.statuts['429']}|${e1.reculs}`, '1|1|1', 'un 429 : compte au direct (refus, statut), et recul');
    ok(dit(/ESPN refuse \(statut 429\) : la passe rapide recule de 120 s/), 'le recul est dit (120 s)');
    const avant = lectures;
    for (let k = 0; k < 20; k++) { maintenant += 5000; await p.tic(maintenant); }
    eq(lectures, avant, 'pendant le recul (100 s), aucune lecture');
    maintenant += 25000; await p.tic(maintenant);
    eq(lectures, avant + 1, 'apres 2 min, une lecture');
    ok(dit(/recule de 240 s/), 'un second 429 de suite : le recul double (240 s)');
    statut = 403;
    maintenant += 241000; await p.tic(maintenant);
    ok(dit(/statut 403\) : la passe rapide recule de 480 s/), 'un 403 aussi (480 s)');
    statut = 200;
    maintenant += 481000; await p.tic(maintenant);
    maintenant += 16000; await p.tic(maintenant);
    ok(lectures >= avant + 4, 'une lecture sans refus remet le recul a zero (les lectures reprennent a 15 s)');
    ok(lisJournal().some((l) => l.k === 'eko' && /^recul/.test(l.p)), 'le recul est ecrit au journal');
    /* jamais appariee 30 min apres le coup d'envoi : on cesse de payer */
    let releves = 0;
    const p2 = enJeu.planifie({ cle: true, appel: async (c, pa, k, q, pr, info) => { releves++; Object.assign(info, { dernier: 1, statut: 200 }); return []; },
                                catalogue: () => cat, fetchEspn, minuteries: false, horloge: () => maintenant,
                                quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
    void p2;
    nouveau('non-appariee');
    maintenant = K - 2 * MIN;
    const p3 = enJeu.planifie({ cle: true, appel: async (c, pa, k, q, pr, info) => { releves++; Object.assign(info, { dernier: 1, statut: 200 }); return []; },
                                catalogue: () => cat, fetchEspn, minuteries: false, horloge: () => maintenant,
                                quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
    releves = 0;
    for (; maintenant <= K + 40 * MIN; maintenant += 5000) await p3.tic(maintenant);
    const E = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8')).rencontres['bar-get'];
    eq(`${E.etat}|${E.raison}`, 'incomplete|espn non apparie 30 min apres le coup d envoi', 'ESPN ne l apparie pas : incomplete a 30 min');
    ok(releves <= 34, `et les releves s arretent (${releves} au plus, 32 min a 60 s)`);
    ok(lisJournal().some((l) => l.k === 'eko' && l.id === 'bar-get' && l.p === 'non apparie'), 'chaque lecture sans elle est ecrite « non apparie »');
  }

  // ==================================================================== 6
  titre('6. le bilan sur un journal fabrique a la main : chiffres exacts');
  {
    const K = Date.UTC(2026, 9, 21, 19, 0);
    const s = 1000;
    const L = [];
    /* M1 : Barcelona - Getafe ; but du domicile a K+610 s (horloge 610), vu par ESPN a K+630 ;
       bourse suspendue de K+610 a K+650 (last_update fige a K+608), puis 0,80/0,13/0,07 */
    const ajoute = (id, cle, lu, pb, x) => {
      L.push({ v: 1, k: 'a', t: K - 120 * s, id, l: cle, e: 'ev-' + id, dom: 'Barcelona', ext: 'Getafe', d: K, cl: ['Barcelona'], ok: 1, r: null, est: 115, c: 60 });
      for (let t = K - 120 * s; t <= K + 2400 * s; t += 60 * s) {
        const e = { id, o: 1, ref: 'b', pb: pb(t), lu: lu(t), b: [1, 1, 1], s: 1.01 };
        if (x && x[(t - K) / s]) Object.assign(e, x[(t - K) / s]);
        L.push({ v: 1, k: 'c', t, l: cle, ids: [id], n: 1, x: 1, st: 200, ev: [e] });
      }
    };
    const pAvant = [0.6, 0.25, 0.15], pApres = [0.8, 0.13, 0.07];
    ajoute('m1', 'soccer_spain_la_liga', (t) => (t >= K + 610 * s && t < K + 650 * s ? K + 608 * s : t - 5 * s), (t) => (t < K + 650 * s ? pAvant : pApres),
           { 1800: { lu: K + 1700 * s } });
    const lec = (id, t, sc, ev) => L.push(Object.assign({ v: 1, k: 'e', t, id, et: 'in', st: 'STATUS_FIRST_HALF', h: (t - K) / 1000, pe: 1, af: '', s: sc, r: [0, 0] }, ev ? { ev } : {}));
    for (let t = K; t <= K + 2400 * s; t += 15 * s) {
      if (t > K + 1200 * s && t < K + 1275 * s) continue;            // 75 s sans lecture : 30 s muet
      lec('m1', t, t >= K + 630 * s ? '1-0' : '0-0', t === K + 630 * s ? [['d', 'b', 610]] : (t === K ? [] : undefined));
    }
    L.push({ v: 1, k: 'e', t: K + 2415 * s, id: 'm1', et: 'post', st: 'STATUS_FULL_TIME', h: 2700, pe: 1, af: '', s: '1-0', r: [0, 0] });
    L.push({ v: 1, k: 'f', t: K + 2415 * s, id: 'm1', fin: 'terminee', r: null });
    /* M2 : la meme rencontre (Liverpool), mais la bourse montre le prix d'avant jusqu'a K+680 avec un last_update FRAIS */
    const debutM2 = L.length;
    ajoute('m2', 'soccer_epl', (t) => t - 5 * s, (t) => (t < K + 680 * s ? pAvant : pApres));
    for (let k = debutM2; k < L.length; k++) if (L[k].k === 'a') L[k].cl = ['Liverpool'];
    for (let t = K; t <= K + 2400 * s; t += 15 * s) lec('m2', t, t >= K + 630 * s ? '1-0' : '0-0', t === K + 630 * s ? [['d', 'b', 610]] : (t === K ? [] : undefined));
    L.push({ v: 1, k: 'e', t: K + 2415 * s, id: 'm2', et: 'post', st: 'STATUS_FULL_TIME', h: 2700, pe: 1, af: '', s: '1-0', r: [0, 0] });
    L.push({ v: 1, k: 'f', t: K + 2415 * s, id: 'm2', fin: 'terminee', r: null });
    L.push({ v: 1, k: 'c', t: K + 60 * s, l: 'soccer_epl', ids: ['m2'], ko: 'DELAI', x: null });
    const b = enJeu.bilan(L, { projection: 9000 });
    const ev1 = b.evenements.find((e) => e.id === 'm1'), ev2 = b.evenements.find((e) => e.id === 'm2');
    eq(`${ev1.type}|${ev1.camp}|${ev1.m}|${(ev1.T - K) / 1000}`, 'b|d|horloge|610', 'M1 : un but du domicile, date par l horloge a K+610 s exactement');
    eq(JSON.stringify(ev1.fav), JSON.stringify(['1']), 'l issue favorisee : 1 (0,60 -> 0,80)');
    eq(ev1.mouvement, 0.2, 'son mouvement : 0,2');
    eq(JSON.stringify(ev1.g1), JSON.stringify({ 5: 'refused: score', 15: 'refused: score', 30: 'refused: scoreRef' }),
       'G1 a +5 et +15 s : offre au prix d avant, REFUSEE (le score change avant j) ; a +30 s, ESPN montre deja le but : refusee (scoreRef, la reference est la releve i)');
    eq(`${ev1.g2Jugeable}|${ev1.g2Fuite}`, 'true|false', 'G2 sur M1 : jugeable, pas de fuite (suspendue puis absorbee)');
    eq(`${ev2.g2Jugeable}|${ev2.g2Fuite}`, 'true|true', 'G2 sur M2 : la releve de K+660 montre le prix d avant, vu a K+655 (>= T+20 s) : FUITE');
    eq(b.conditions.G1.acceptes, 0, 'G1 : 0 acceptation');
    eq(`${b.conditions.G2.fuites}/${b.conditions.G2.jugeables}`, '1/2', 'G2 : 1 fuite sur 2 evenements jugeables');
    const r1 = b.rencontres.find((r) => r.id === 'm1'), r2 = b.rencontres.find((r) => r.id === 'm2');
    eq(`${r1.releves}/${r1.prevues}|${r2.releves}/${r2.prevues}`, '43/43|43/43', 'releves reussies / prevues : 43/43 (le DELAI de M2 ne compte pas comme reussie)');
    eq(`${r1.credits}|${r2.credits}`, '43|43', 'credits : 43 chacune (x-requests-last = 1 par releve, le DELAI sans en-tete compte 0)');
    eq(r1.creditsFenetre, 41, 'credits du coup d envoi a la fin de la fenetre (K a K+2400 s) : 41');
    const g3m1 = b.conditions.G3.clubs.Barcelona;
    /* fenetre jugee : releves de K a K+2400 (41) hors [T ; T+120 s[ (K+660, K+720 : 2) = 39, dont une figee (K+1800) */
    eq(`${g3m1.vivantes}/${g3m1.jugees}`, '38/39', 'G3 Barcelona : 38 bourses vivantes sur 39 releves jugees (K+1800 figee, les 120 s d apres le but exclues)');
    eq(b.conditions.G3.clubs.Barcelona.vendable, false, 'un club a une seule rencontre complete : not enough (3 au moins)');
    ok(/not enough: 1 complete match/.test(g3m1.pourquoi), 'et c est dit : ' + g3m1.pourquoi);
    eq(b.rencontres.length, 2, 'deux rencontres');
    eq(b.conditions.G4.muetS, 30, 'G4 : 75 s sans lecture = 30 s muettes (au-dela de 45 s)');
    eq(b.conditions.G4.ouvertS, 2 * 2400, 'sur 2 x 2 400 s de temps ouvert');
    eq(`${b.conditions.G5.appels}|${b.conditions.G5.avecCout}|${b.conditions.G5.auPlusUn}`, '87|86|1', 'G5 : 87 appels, 86 avec un cout, tous a 1 credit au plus');
    /* « not enough » sous l'echantillon, meme si tout le reste etait vert. Depuis
       la relecture du 11/10/2026, l'echantillon de G1 compte les evenements JUGES
       (une offre au parieur informe, retard d'ESPN borne), et une condition qui ne
       peut pas conclure (G2 sous 20 jugeables avec une seule fuite, G3 sous 4 clubs
       a 3 rencontres) se range dans « not enough », jamais dans « red ». */
    eq(b.porte.verte, false, 'deux rencontres, deux evenements : la porte n est pas verte');
    ok(/^not enough: 2 event\(s\) judged for the informed bettor < 40 \(2 dated\), 2 complete match\(es\) < 20, 2 club\(s\) < 5, 0(\.\d)? day\(s\) < 14, 2 judgeable event\(s\) for G2 < 20, 0 club\(s\) with 3 complete matches < 4$/.test(b.porte.raisons[0]),
       'et la premiere raison est « not enough », chaque manque nomme : ' + b.porte.raisons[0]);
    eq(b.porte.raisons.length, 2, '... et une seule autre raison (G5 : pas de projection mesurable sur 2 rencontres), jamais « G2 red » ni « G3 red »');
    eq(`${r1.retardEspnS}|${r1.mesurable}`, '0|true', 'l horloge du journal fait main suit le coup d envoi du catalogue : retard d ESPN borne a 0 s, rencontre jugee');

    /* ---- M3 : EXACTEMENT UNE ACCEPTATION DU PARIEUR INFORME ----
     * (mutation du 11/10/2026, A02 : g1AcceptesMax 0 -> 1 survivait) La bourse
     * montre le prix d'avant, fraiche, jusqu'a K+730 ; ESPN ne montre le but de
     * K+610 qu'a K+735 (125 s). Le parieur qui demande a K+615 est juge a K+720 :
     * score inchange, cote inchangee, bourse vue apres lui -> ACCEPTE. */
    const L3 = [{ v: 1, k: 'a', t: K - 120 * s, id: 'm3', l: 'soccer_epl', e: 'ev-m3', dom: 'Arsenal', ext: 'Everton', d: K, cl: ['Arsenal'], ok: 1, r: null, est: 115, c: 60 }];
    for (let t = K - 120 * s; t <= K + 2400 * s; t += 60 * s) {
      L3.push({ v: 1, k: 'c', t, l: 'soccer_epl', ids: ['m3'], n: 1, x: 1, st: 200, ev: [{ id: 'm3', o: 1, ref: 'b', pb: t < K + 730 * s ? pAvant : pApres, lu: t - 5 * s, b: [1, 1, 1], s: 1.01 }] });
    }
    for (let t = K; t <= K + 2400 * s; t += 15 * s) {
      L3.push(Object.assign({ v: 1, k: 'e', t, id: 'm3', et: 'in', st: 'STATUS_FIRST_HALF', h: (t - K) / 1000, pe: 1, af: '', s: t >= K + 735 * s ? '1-0' : '0-0', r: [0, 0] },
                            t === K ? { ev: [] } : t === K + 735 * s ? { ev: [['d', 'b', 610]] } : {}));
    }
    L3.push({ v: 1, k: 'e', t: K + 2415 * s, id: 'm3', et: 'post', st: 'STATUS_FULL_TIME', h: 2700, pe: 1, af: '', s: '1-0', r: [0, 0] });
    L3.push({ v: 1, k: 'f', t: K + 2415 * s, id: 'm3', fin: 'terminee', r: null });
    const b3 = enJeu.bilan(L3, { projection: 9000 });
    const e3 = b3.evenements[0];
    eq(`${e3.m}|${(e3.T - K) / 1000}|${JSON.stringify(e3.g1)}`, 'horloge|610|{"5":"accepted","15":"accepted","30":"accepted"}',
       'M3 : le but date a K+610 s, le parieur informe ACCEPTE a +5, +15 et +30 s (ESPN montre le but 125 s apres)');
    eq(`${b3.conditions.G1.acceptes}|${b3.conditions.G1.ok}`, '1|false', 'G1 : une acceptation sur un evenement juge -> rouge (le seuil ecrit est 0)');
    ok(b3.porte.raisons.some((x) => x.startsWith('G1 red: informed bettor accepted on 1 of 1 judged events')), 'la porte le dit : « G1 red » meme sous l echantillon minimal');
    eq(enJeu.bilan(L3, { projection: 9000, g1AcceptesMax: 1 }).conditions.G1.ok, true, '(le meme journal, seuil force a 1 : G1 verte — le seuil ecrit decide)');

    /* ---- LA DATATION DE REPLI, ET LA BORNE DU RETARD D'ESPN ----
     * (mutation du 11/10/2026, E1 et E2 : le journal synthetique date tout par
     * l'horloge, les replis n'etaient jamais exerces) */
    const repli = (lu, h) => {
      const R = [{ v: 1, k: 'a', t: K - 120 * s, id: 'm', l: 'soccer_epl', e: 'ev-m', dom: 'Arsenal', ext: 'Everton', d: K, cl: ['Arsenal'], ok: 1, est: 115, c: 60 }];
      for (let t = K; t <= K + 1200 * s; t += 15 * s) {
        R.push({ v: 1, k: 'e', t, id: 'm', et: 'in', st: 'STATUS_FIRST_HALF', h: h ? (t - K) / 1000 : null, pe: 1, s: t >= K + 615 * s ? '1-0' : '0-0', r: [0, 0],
                 ev: h && t >= K + 615 * s ? [['d', 'b', h]] : [] });
      }
      const oks = lu ? [{ t: K + 640 * s, e: { pb: [0.5, 0.3, 0.2], lu } }] : [];
      return (decale) => enJeu.evenementsDe(enJeu.regroupe(R).g.get('m'), oks, decale)[0];
    };
    const lec0 = repli(null, null);
    eq(`${lec0(0).m}|${(lec0(0).T - K) / 1000}|${(lec0(5000).T - K) / 1000}`, 'lecture|600|595',
       'sans horloge ni gel : datee par la lecture d AVANT la detection (K+600, jamais K+615), avancee de la borne d ESPN (5 s -> K+595)');
    const gel = repli(K + 605 * s, null);
    eq(`${gel(0).m}|${(gel(0).T - K) / 1000}|${(gel(5000).T - K) / 1000}`, 'gel|605|605',
       'sans horloge, la bourse figee a K+605 : datee par T_gel, que la borne d ESPN ne decale pas');
    const gelTard = repli(K + 614 * s, null);
    eq((gelTard(10000).T - K) / 1000, 605, 'un gel plus tard que la detection corrigee (K+615 - 10 s) : ramene a K+605 (une bourse en retard gele en retard)');
    const incoherent = repli(null, 900);
    eq(`${incoherent(0).m}|${incoherent(0).T === incoherent(0).tDetect}`, 'horloge|true',
       'un detail d horloge incoherent (900 s, vu a K+615) : T_E plafonne a l instant de detection, jamais apres');
    /* la borne elle-meme : le maximum de t - K - horloge en 1re periode, 5 lectures au moins, jamais negative */
    const lecR = (dt, h, x) => Object.assign({ t: K + dt * s, et: 'in', pe: 1, h, st: 'STATUS_FIRST_HALF' }, x || {});
    const borne = (esp) => enJeu.retardEspn({ a: { d: K }, esp }, enJeu.PORTE);
    eq(JSON.stringify(borne([lecR(100, 95), lecR(115, 105), lecR(130, 125), lecR(145, 140), lecR(160, 156),
                             lecR(3000, 100, { pe: 2 }), lecR(3100, 2700), lecR(3200, 2000, { st: 'STATUS_HALFTIME' }), lecR(3300, 1000, { et: 'post' }), lecR(170, 100, { et: 'pre' })])),
       JSON.stringify({ s: 10, n: 5 }), 'borne : le MAXIMUM (10 s) sur les seules lectures EN JEU de 1re periode, horloge courante (ni 2e periode, ni 2 700, ni mi-temps, ni pre/post)');
    eq(JSON.stringify(borne([lecR(100, 95), lecR(115, 105), lecR(130, 125), lecR(145, 140)])), JSON.stringify({ s: null, n: 4 }), 'quatre lectures : borne inconnue (null)');
    eq(borne([lecR(100, 110), lecR(115, 125), lecR(130, 140), lecR(145, 155), lecR(160, 170)]).s, 0, 'un coup d envoi en avance (valeurs negatives) : 0, jamais negative');
    eq(enJeu.retardEspn({ a: { d: 'x' }, esp: [lecR(100, 95)] }, enJeu.PORTE).s, null, 'sans heure de coup d envoi lisible : inconnue');
  }

  // ==================================================================== 7
  titre('7. la porte sur les journaux synthetiques : sain -> verte, retard de 60 s -> rouge');
  let sain = null;
  /* L'ecart (s) entre T_E et le VRAI instant de chaque fait de la simulation (meme rencontre, meme
     type, meme camp, dans l'ordre) : la datation avancee de la borne du retard d'ESPN se verifie
     contre la verite, pas seulement par la porte qu'elle produit. */
  const ecartsDatation = (b, cal) => {
    const parId = new Map(cal.map((m) => [m.id, m]));
    const vus = new Map();
    return [...new Set(b.evenements.slice().sort((x, y) => x.T - y.T).map((e) => {
      const cle = `${e.id}|${e.type}|${e.camp}`;
      const k = vus.get(cle) || 0; vus.set(cle, k + 1);
      const f = parId.get(e.id).faits.filter((y) => y.type === e.type && (y.cote === 'h') === (e.camp === 'd'))[k];
      return f ? Math.round((e.T - f.T) / 1000) : 'sans fait';
    }))].sort((a, c) => a - c).join(',');
  };
  {
    process.env.PARIS_EN_JEU = 'observe';
    const r = await sim.simule(enJeu, path.join(BAC, 'sain'), 'sain');
    sain = sim.lignesDe(enJeu, r.dossier);
    const b = enJeu.bilan(sain, { projection: 9000 });
    const C = b.conditions;
    logVrai(`     sain : ${b.echantillon.evenements} evenements, ${b.echantillon.rencontres} rencontres, G1 ${C.G1.acceptes}, G2 ${C.G2.fuites}/${C.G2.jugeables}, ` +
            `G3 ${C.G3.vendables.length} clubs, G4 ${C.G4.part}, G5 ${C.G5.creditsRencontreMax} cr/rencontre, projection ${JSON.stringify(C.G5.projection)}, G6 ${C.G6.part}`);
    ok(b.echantillon.evenements >= 40 && b.echantillon.rencontres >= 20 && b.echantillon.clubs >= 5 && b.echantillon.jours >= 14,
       `l echantillon synthetique passe le minimum (${JSON.stringify(b.echantillon)})`);
    eq(b.porte.verte, true, 'JOURNAL SAIN : PORTE VERTE (' + b.porte.raisons.join(' ; ') + ')');
    eq(C.G1.acceptes, 0, 'sain : le parieur informe n est jamais accepte');
    eq(C.G2.fuites, 0, 'sain : aucune bourse vivante au prix d avant apres un fait');
    ok(C.G2.jugeables >= 20, `sain : ${C.G2.jugeables} evenements jugeables pour G2 (20 au moins)`);
    eq(b.latences.datation.horloge, b.echantillon.evenements, 'tous les faits dates par l horloge d ESPN');
    eq(`${b.latences.retardEspn.max}|${ecartsDatation(b, r.calendrier)}`, '5|0',
       'l horloge d ESPN a 5 s de retard : borne lue 5 s, et CHAQUE fait date a son vrai instant (ecart 0 s)');
    /* une seule condition rouge ferme la porte : la projection au-dessus de 16 000 */
    const b2 = enJeu.bilan(sain, { projection: 15000 });
    eq(`${b2.porte.verte}|${b2.porte.raisons.length}|${b2.porte.raisons[0].slice(0, 7)}`, 'false|1|G5 red:', 'le meme journal, la base a 15 000 : G5 seule rouge ferme la porte');
    const b3 = enJeu.bilan(sain, {});
    ok(!b3.porte.verte && /month projection with live betting sold not given/.test(b3.conditions.G5.texte), 'sans projection, G5 ne conclut pas : porte fermee');
    const b4 = enJeu.bilan(sain, { projection: { credits: 9500, jourDuMois: 15, mois: '2026-10' } });
    ok(b4.conditions.G5.projection.base < 9500, `la projection du socle est diminuee de ce que l observation a coute (base ${b4.conditions.G5.projection.base})`);
    /* l'outil hors serveur : le meme bilan */
    const outil = require('./outils/releve_en_jeu');
    const sortie = [];
    const lg = console.log; console.log = (x) => sortie.push(String(x));
    const code = outil.principal(['node', 'outil', r.dossier, '--projection', '9000', '--json']);
    console.log = lg;
    eq(code, 0, 'outils/releve_en_jeu.js sur le journal sain : code 0 (porte verte)');
    eq(JSON.stringify(JSON.parse(sortie.join('\n')).porte), JSON.stringify(b.porte), 'et la meme porte que le serveur (une seule fonction)');
  }
  {
    const r = await sim.simule(enJeu, path.join(BAC, 'retard'), 'retard');
    const L = sim.lignesDe(enJeu, r.dossier);
    const b = enJeu.bilan(L, { projection: 9000 });
    const C = b.conditions;
    logVrai(`     retard 60 s : G1 ${C.G1.acceptes}, G2 ${C.G2.fuites}/${C.G2.jugeables}, raisons ${JSON.stringify(b.porte.raisons.map((x) => x.slice(0, 7)))}`);
    eq(b.porte.verte, false, 'BOURSE EN RETARD DE 60 s : PORTE ROUGE');
    ok(!C.G2.ok && C.G2.part > 0.5, `par G2 : ${C.G2.fuites} fuites sur ${C.G2.jugeables} (${Math.round(C.G2.part * 100)} %)`);
    /* mutation du 11/10/2026 (A32) : retirer G2 de la porte ne faisait rien tomber, G1 rougissait aussi */
    ok(b.porte.raisons.some((x) => x.startsWith('G2 red:')), 'et c est bien G2 qui ferme la porte (raison « G2 red: »)');
    ok(C.G3.ok, 'alors que la bourse y parait vivante (last_update frais) : G3 ne la voit pas, G2 si');
    const outil = require('./outils/releve_en_jeu');
    const texte = [];
    const lg = console.log; console.log = (x) => texte.push(String(x));
    const code = outil.principal(['node', 'outil', r.dossier, '--projection', '9000']);
    console.log = lg;
    eq(code, 2, 'outils/releve_en_jeu.js sur le journal en retard : code 2 (porte non verte)');
    ok(/ESPN lag bound \(kick-off \+ clock, 1st half\): median 5 s, p90 5 s, max 5 s on 24 of 24 complete matches; 0 not judged/.test(texte.join('\n')),
       'et le texte de l outil dit la borne du retard d ESPN (mediane, p90, max, rencontres non jugees)');
  }
  {
    const r = await sim.simule(enJeu, path.join(BAC, 'figee'), 'figee');
    const b = enJeu.bilan(sim.lignesDe(enJeu, r.dossier), { projection: 9000 });
    ok(!b.conditions.G1.ok && b.conditions.G1.acceptes >= 10, `bourse figee et ESPN lent (200 s) : G1 rouge, le parieur informe accepte ${b.conditions.G1.acceptes} fois`);
  }
  /* ---- LE TROISIEME JOURNAL OBLIGATOIRE : LA BOURSE ET ESPN EN RETARD ENSEMBLE ----
   * (relecture du 11/10/2026, bloquant) Avant, T_E se datait par l'horloge
   * d'ESPN sans rien en retirer : un ESPN en retard de 45 s datait chaque fait
   * 45 s trop tard, et la bourse en retard de 60 s donnait une porte VERTE (G1 0,
   * G2 0/48). La borne du retard d'ESPN (t - K - horloge en 1re periode) avance
   * T_E ; au-dela de 20 s, G1 et G2 ne jugent pas la rencontre. */
  {
    const r = await sim.simule(enJeu, path.join(BAC, 'retard-espn45'), 'retard', { horlogeS: 45, espnS: 45 });
    const b = enJeu.bilan(sim.lignesDe(enJeu, r.dossier), { projection: 9000 });
    logVrai(`     retard 60 s, ESPN 45 s : raisons ${JSON.stringify(b.porte.raisons.map((x) => x.slice(0, 90)))}`);
    eq(b.porte.verte, false, 'BOURSE EN RETARD DE 60 s ET ESPN EN RETARD DE 45 s : PORTE NON VERTE');
    eq(`${b.latences.retardEspn.mediane}|${b.latences.retardEspn.nonJugees}|${b.echantillon.evenementsJuges}|${b.conditions.G2.jugeables}`, '45|24|0|0',
       'la borne du retard d ESPN lit 45 s sur chaque rencontre : aucune n est jugee par G1 ni G2');
    ok(b.evenements.length === 80 && b.evenements.every((e) => !e.mesurable && Object.keys(e.g1).length === 0 && !e.g2Jugeable),
       'ses 80 evenements sont marques non jugeables : le parieur informe n y est meme pas essaye (une acceptation n y voudrait rien dire)');
    ok(/^not enough: 0 event\(s\) judged .*ESPN may lag over 20 s, or unknown, on 24 of 24 complete match\(es\)/.test(b.porte.raisons[0]),
       'et la raison le dit (« ESPN may lag over 20 s … not judged ») : ' + b.porte.raisons[0].slice(0, 80));
  }
  {
    /* le retard d'ESPN sous le seuil (15 s) : T_E avance de 15 s, G2 voit toujours la bourse en retard */
    const r = await sim.simule(enJeu, path.join(BAC, 'retard-espn15'), 'retard', { horlogeS: 15, espnS: 20 });
    const b = enJeu.bilan(sim.lignesDe(enJeu, r.dossier), { projection: 9000 });
    eq(`${b.porte.verte}|${b.latences.retardEspn.max}|${ecartsDatation(b, r.calendrier)}`, 'false|15|0',
       'bourse en retard de 60 s, ESPN en retard de 15 s : borne lue 15 s, chaque fait date a son vrai instant (sans la borne : 15 s trop tard), porte rouge');
    ok(b.porte.raisons.some((x) => x.startsWith('G2 red:')) && b.conditions.G2.jugeables >= 20, `par G2 (${b.conditions.G2.fuites}/${b.conditions.G2.jugeables})`);
  }
  {
    /* la tolerance : un coup d'envoi 15 s en retard sur le catalogue, ESPN a 5 s -> borne 20 s, T_E jusqu'a 15 s trop tot.
       Une bourse SAINE n'y est jamais prise pour une bourse en retard : la porte reste verte. */
    const r = await sim.simule(enJeu, path.join(BAC, 'sain-ko15'), 'sain', { coupEnvoiS: 15 });
    const b = enJeu.bilan(sim.lignesDe(enJeu, r.dossier), { projection: 9000 });
    eq(ecartsDatation(b, r.calendrier), '-15', 'chaque fait date 15 s AVANT son vrai instant (le retard du coup d envoi), jamais apres');
    eq(`${b.porte.verte}|${b.latences.retardEspn.max}|${b.conditions.G2.fuites}`, 'true|20|0',
       'journal sain, coup d envoi 15 s en retard : borne 20 s (encore jugee), 0 fuite, PORTE VERTE (' + b.porte.raisons.join(' ; ').slice(0, 120) + ')');
  }

  // ==================================================================== 8
  titre('8. la sonde du last_update');
  {
    process.env.PARIS_EN_JEU = 'observe';
    nouveau('sonde');
    const K = Date.UTC(2026, 9, 22, 19, 0);
    const cat = [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', K)];
    let appels = 0, maintenant = K - 2 * MIN;
    const appel = async (c, p, k, q, pr, info) => {
      appels++;
      Object.assign(info, { dernier: 1, statut: 200 });
      return [{ id: 'ev-a', home_team: 'Arsenal', away_team: 'Everton', bookmakers: [{ key: 'betfair_ex_eu', last_update: new Date(maintenant).toISOString(),
        markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.5 }, { name: 'Draw', price: 4.4 }, { name: 'Everton', price: 7.5 }] }] }] }];
    };
    const p = enJeu.planifie({ cle: true, appel, catalogue: () => cat, minuteries: false, horloge: () => maintenant,
                               lisEspn: async () => new Map(), quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
    for (let k = 0; k < 10; k++) { await p.tic(maintenant); maintenant += 61000; }
    eq(appels, 1, 'la bourse SANS last_update de marche : une releve (1 credit), puis plus rien');
    const E = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8'));
    eq(`${E.arret.raison}|${E.rencontres.a.etat}`, 'last_update absent du marche h2h de la bourse|incomplete', 'l observation est arretee, la rencontre incomplete');
    ok(lisJournal().some((l) => l.k === 'sonde' && l.ok === 0 && l.sans === 1), 'la sonde est ecrite au journal (ok: 0)');
    ok(lisJournal().some((l) => l.k === 'c' && l.ev[0].luManque === 1 && l.ev[0].lu === null && l.ev[0].lul > 0),
       'la releve dit luManque, et garde a part le last_update du livre (deprecie)');
    ok(dit(/SANS last_update de marche.*ARRETEE 7 jours/), 'et c est dit au journal de l hote');
    const r = enJeu.admet(K + 6 * 86400000, enJeu.config(), () => ({ depense: 0, part: 100000, reserve: 80 }));
    ok(!r.ok && /^arret/.test(r.raison), 'six jours plus tard : toujours aucune admission');
    ok(enJeu.admet(K + 8 * 86400000, enJeu.config(), () => ({ depense: 0, part: 100000, reserve: 80 })).ok, 'apres sept jours : une nouvelle tentative est permise');
    const bs = enJeu.bilan(lisJournal(), {});
    ok(bs.porte.raisons.some((x) => /probe: the exchange h2h market has no last_update/.test(x)), 'le bilan le dit dans ses raisons');
  }

  // ==================================================================== 9
  titre('9. les gardes retirees une a une');
  {
    const ATTENDUES = ['delai', 'bourseVivante', 'bourseSeule', 'orientation', 'entreeVivante', 'nonFermee', 'nonReglee', 'espnVivant',
                       'minute', 'miTemps', 'scoreRef', 'score', 'rouge', 'coteVueMax', 'garde'];
    eq(Object.keys(enJeu.GARDES).join(','), ATTENDUES.join(','), 'la table GARDES compte toutes ses entrees, chacune avec un scenario ci-dessous');
    const P = Object.assign({}, enJeu.PORTE, { delaiS: 60, cadenceS: 60, delaiMs: 60000, cadenceMs: 60000, garde: 0.03, fermeMin: 80, marge: 0.10 });
    const pb = [0.5, 0.3, 0.2];
    const cv = enJeu.habille(pb, 0.10)['1'];
    const td = Date.UTC(2026, 9, 23, 19, 20);
    const lec = (t, x) => Object.assign({ t, et: 'in', pe: 1, h: 1200, st: 'STATUS_FIRST_HALF', s: '0-0', r: [0, 0] }, x || {});
    const base = () => ({ d: { t: td, o: '1', cv }, i: { t: td - 10000, e: { pb, lu: td - 15000, ref: 'b', o: 1 } },
                          j: { t: td + 70000, e: { pb: pb.slice(), lu: td + 66000, ref: 'b', o: 1 } },
                          ei: lec(td - 10000), ed: lec(td), ej: lec(td + 65000, { h: 1275 }), cf: cv, regle: 'stricte', tol: 0, P });
    eq(enJeu.accepte(base()).ok, true, `le scenario de base passe toutes les gardes (cote vue ${cv} x 0,5 <= 0,97)`);
    const SCENARIOS = {
      delai: (c) => { c.j.t = td + 200000; c.j.e.lu = td + 196000; c.ej = lec(td + 195000, { h: 1400 }); },
      bourseVivante: (c) => { c.j.e.lu = td + 2000; },
      bourseSeule: (c) => { c.j.e.ref = 'm'; },
      orientation: (c) => { c.j.e.o = 0; },
      entreeVivante: (c) => { c.j.e.vi = 0; },
      nonFermee: (c) => { c.j.e.fe = 1; },
      nonReglee: (c) => { c.j.e.rg = 1; },
      espnVivant: (c) => { c.ej.t = c.j.t - 60000; },
      minute: (c) => { Object.assign(c.ej, { pe: 2, h: 4810, st: 'STATUS_SECOND_HALF' }); },
      miTemps: (c) => { c.ej.st = 'STATUS_HALFTIME'; },
      scoreRef: (c) => { c.ed.s = '1-0'; c.ej.s = '1-0'; },
      score: (c) => { c.ej.s = '1-0'; },
      rouge: (c) => { c.ej.r = [0, 1]; },
      coteVueMax: (c) => { c.cf = Math.round((cv - 0.05) * 100) / 100; },
      garde: (c) => { c.j.e.pb = [0.56, 0.26, 0.18]; },
    };
    eq(Object.keys(SCENARIOS).join(','), ATTENDUES.join(','), 'un scenario par garde');
    for (const nom of ATTENDUES) {
      const c = base(); SCENARIOS[nom](c);
      const r = enJeu.accepte(c);
      eq(`${r.ok}|${r.refus}`, `false|${nom}`, `${nom} : son scenario est refuse, par elle seule`);
      const vraie = enJeu.GARDES[nom];
      enJeu.GARDES[nom] = () => true;
      const c2 = base(); SCENARIOS[nom](c2);
      const r2 = enJeu.accepte(c2);
      enJeu.GARDES[nom] = vraie;
      ok(r2.ok, `garde ${nom} retiree : le scenario passe — l essai la tient`);
    }
    /* l'offre : une releve de plus de cadence + 10 s n'est plus montree (« paused ») */
    {
      const b0 = base();
      const edA = (t) => Object.assign({}, b0.ed, { t });
      ok(enJeu.offre(b0.i, edA(b0.i.t + 70000), b0.i.t + 70000, P, 0.10), 'offre : releve de 70 s (cadence + 10 s) encore montree');
      eq(enJeu.offre(b0.i, edA(b0.i.t + 71000), b0.i.t + 71000, P, 0.10), null, 'offre : releve de 71 s : plus rien (paused)');
      eq(enJeu.offre(Object.assign({}, b0.i, { e: Object.assign({}, b0.i.e, { lu: b0.i.t - 21000 }) }), b0.ed, b0.i.t, P, 0.10), null, 'offre : bourse vue il y a 21 s a la releve : rien');
      eq(enJeu.offre(b0.i, Object.assign({}, b0.ed, { st: 'STATUS_HALFTIME' }), b0.i.t, P, 0.10), null, 'offre : mi-temps : rien');
      eq(enJeu.offre(b0.i, Object.assign({}, b0.ed, { t: b0.i.t - 46000 }), b0.i.t, P, 0.10), null, 'offre : ESPN lu il y a 46 s : rien');
    }
    /* la regle « min » de la condition G6 : la cote fraiche, dans la tolerance */
    const cm = base(); cm.regle = 'min'; cm.tol = 0.10; cm.cf = Math.round(cv * 0.95 * 100) / 100;
    const rm = enJeu.accepte(cm);
    eq(`${rm.ok}|${rm.prix}`, `true|${cm.cf}`, 'regle min, cote fraiche 5 % plus basse : acceptee AU PRIX FRAIS');
    cm.cf = Math.round(cv * 0.85 * 100) / 100;
    eq(enJeu.accepte(cm).refus, 'coteVueMax', 'regle min, 15 % plus basse (hors tolerance de 10 %) : refusee');
  }

  // ==================================================================== 10
  titre('10. le journal : purge, route');
  {
    const d = nouveau('purge');
    const dj = path.join(d, 'paris_en_jeu');
    fs.mkdirSync(dj, { recursive: true });
    const T = Date.UTC(2026, 9, 31, 12, 0);
    for (let k = 0; k < 40; k++) fs.writeFileSync(path.join(dj, new Date(T - k * 86400000).toISOString().slice(0, 10) + '.jsonl'), 'x\n');
    fs.writeFileSync(path.join(dj, 'autre.txt'), 'garde');
    process.env.PARIS_EN_JEU = 'observe';
    const p = enJeu.planifie({ cle: true, appel: async () => [], catalogue: () => [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', T + 60000)],
                               minuteries: false, horloge: () => T, lisEspn: async () => new Map(), quota: () => ({ depense: 0, part: 0, reserve: 80 }) });
    await p.tic(T);
    const restent = fs.readdirSync(dj).filter((f) => /\.jsonl$/.test(f)).sort();
    eq(`${restent.length}|${restent[0]}`, '30|2026-10-02.jsonl', 'purge : 30 jours gardes (du 02/10 au 31/10)');
    ok(fs.existsSync(path.join(dj, 'autre.txt')), 'un fichier qui n est pas un jour du journal n est jamais efface');
    /* 20 Mo : les plus anciens sortent, jamais le jour courant */
    const gros = Buffer.alloc(6 * 1024 * 1024, 120);
    for (const j of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) fs.writeFileSync(path.join(dj, j + '.jsonl'), gros);
    enJeu.recharge();
    await enJeu.tic(T + 2 * 3600000, { appel: async () => [], catalogue: () => [rencontre('b', 'Arsenal', 'Everton', 'soccer_epl', T + 2 * 3600000 + 60000)],
                                       horloge: () => T + 2 * 3600000, lisEspn: async () => new Map(), quota: () => ({ depense: 0, part: 0, reserve: 80 }) });
    const total = fs.readdirSync(dj).filter((f) => /\.jsonl$/.test(f)).reduce((a, f) => a + fs.statSync(path.join(dj, f)).size, 0);
    ok(total <= 20 * 1024 * 1024, `24 Mo ecrits, 20 Mo au plus apres purge (${(total / 1048576).toFixed(1)} Mo)`);
    ok(!fs.existsSync(path.join(dj, '2026-10-27.jsonl')), 'le plus ancien des gros jours est sorti le premier');
    ok(fs.existsSync(path.join(dj, '2026-10-31.jsonl')) && fs.existsSync(path.join(dj, '2026-10-30.jsonl')), 'les jours recents restent');
    /* la route */
    eq(enJeu.reponseJournal('2026-13-01').code, 400, 'route : un jour invalide -> 400');
    eq(enJeu.reponseJournal('../../etc/passwd').code, 400, 'route : un chemin -> 400');
    eq(enJeu.reponseJournal('2025-01-01').code, 404, 'route : un jour absent -> 404');
    const r = enJeu.reponseJournal('2026-10-31');
    eq(`${r.code}|${r.type.split(';')[0]}`, '200|application/x-ndjson', 'route : un jour present -> 200, le .jsonl brut');
    const liste = JSON.parse(enJeu.reponseJournal(null).corps);
    ok(Array.isArray(liste.jours) && liste.jours.some((x) => x.jour === '2026-10-31' && x.octets > 0), 'route sans jour : la liste des jours et leur taille');
  }

  // ==================================================================== 11
  titre('11. l etat lisible (/paris/import -> enJeu)');
  {
    process.env.DATA_DIR = path.join(BAC, 'sain');
    enJeu.recharge();
    const b = await enJeu.bilanFichiers({ projection: 9000 });
    eq(b.porte.verte, true, 'le bilan du serveur, par morceaux, sur le journal sain : vert (la meme fonction)');
    const e = enJeu.etat();
    eq(`${e.mode}|${e.rencontres.completes}|${e.credits.total > 0}|${e.bilan.porte.verte}`, 'observe|24|true|true', 'etat : mode, rencontres completes, credits, porte du dernier bilan');
    ok(fs.existsSync(enJeu.fichierBilan()), 'le bilan est ecrit sur le volume');
    delete process.env.PARIS_EN_JEU;
    eq(enJeu.etat().mode, 'off', 'PARIS_EN_JEU vide : etat dit « off »');
  }

  // ==================================================================== 12
  /* Les garde-fous que la mutation du 11/10/2026 laissait passer (retires un
     par un dans le code, sur une copie hors depot) : chacun a ici la
     verification qui tombe sans lui. */
  titre('12. les trous laisses par la mutation');
  {
    process.env.PARIS_EN_JEU = 'observe';
    const Q = () => ({ depense: 0, part: 100000, reserve: 80 });
    const K = Date.UTC(2026, 9, 25, 12, 0);
    const cat = [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', K)];
    const bourse = (t, prix, extra) => [Object.assign({ id: 'ev-a', home_team: 'Arsenal', away_team: 'Everton', bookmakers: [{ key: 'betfair_ex_eu',
      markets: [{ key: 'h2h', last_update: new Date(t - 2000).toISOString(), outcomes: [{ name: 'Arsenal', price: prix[0] }, { name: 'Draw', price: prix[1] }, { name: 'Everton', price: prix[2] }] }] }] }, extra || {})];
    /* le plafond de l'observation tenu AVANT chaque releve (pas seulement a l'admission) */
    {
      const d = nouveau('plafond-obs-releve');
      let t = K - 2 * MIN, appels = 0;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { appels++; Object.assign(info, { dernier: 1, statut: 200 }); return bourse(t, [1.9, 3.6, 4.4]); } });
      await p.tic(t);
      const E = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8'));
      E.credits.total = 2999;
      fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify(E));
      enJeu.recharge();
      appels = 0;
      for (let k = 0; k < 4; k++) { t += 61000; await p.tic(t); }
      const r = JSON.parse(fs.readFileSync(path.join(d, 'paris_en_jeu_quota.json'), 'utf8')).rencontres.a;
      eq(`${appels}|${r.etat}|${r.raison}`, '1|incomplete|plafond de l observation', 'a 2 999 credits : UNE releve (3 000), puis la rencontre s arrete « plafond de l observation »');
    }
    /* une reponse 200 sans x-requests-last compte un credit (prudence), pas zero */
    {
      nouveau('sans-entete');
      const t = K - 2 * MIN;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: null, statut: 200 }); return bourse(t, [1.9, 3.6, 4.4]); } });
      await p.tic(t);
      eq(enJeu.etat().credits.total, 1, 'une reponse sans x-requests-last : comptee 1 credit (jamais 0 par defaut)');
    }
    /* une bourse dont la somme des inverses sort de [1,00 ; 1,06] ne donne pas de p (jamais une bourse vivante) */
    {
      nouveau('somme');
      const t = K - 2 * MIN;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return bourse(t, [1.5, 3.0, 4.0]); } });
      await p.tic(t);
      const e = lisJournal().find((l) => l.k === 'c').ev[0];
      eq(`${e.s}|${e.pb}|${e.lu > 0}`, '1.25|undefined|true', 'somme 1,25 : notee, mais aucune p sans marge (la bourse ne compte pas)');
    }
    /* l'ancienne entree d'un match deplace, deja suivie quand la nouvelle arrive : notee vi = 0 (la garde entreeVivante la lit) */
    {
      nouveau('ancienne-entree');
      let t = K - 2 * MIN;
      const vieille = rencontre('v', 'Arsenal', 'Everton', 'soccer_epl', K, { source: { fournisseur: 'the-odds-api', ligue: 'soccer_epl', evenement: 'ev-a' } });
      let catV = [vieille];
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => catV, lisEspn: async () => new Map(), quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return bourse(t, [1.9, 3.6, 4.4]); } });
      await p.tic(t);
      catV = [Object.assign({}, vieille, { ferme: K - 3 * MIN }), rencontre('n', 'Arsenal', 'Everton', 'soccer_epl', K, { source: { fournisseur: 'the-odds-api', ligue: 'soccer_epl', evenement: 'ev-a' } })];
      t += 61000; await p.tic(t);
      const derniere = lisJournal().filter((l) => l.k === 'c').pop();
      const ev = Object.fromEntries(derniere.ev.map((e) => [e.id, e]));
      eq(`${ev.v && ev.v.vi}|${ev.v && ev.v.fe}|${ev.n && ev.n.vi}`, '0|1|undefined', 'l ancienne entree, fermee, est notee vi = 0 ; la nouvelle non');
    }
    /* le recul : plafonne a 30 min, et remis a 2 min apres une lecture sans refus */
    {
      nouveau('recul-plafond');
      const m0 = sim.calendrier(13, 1)[0];
      let t = m0.K - 2 * MIN, statut = 200;
      /* appariee d'abord (sinon coupee a 30 min), puis ESPN fige en jeu et qui refuse */
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, quota: Q,
                                 catalogue: () => [rencontre(m0.id, m0.dom, m0.ext, m0.ligue, m0.K, { source: { fournisseur: 'the-odds-api', ligue: m0.ligue, evenement: m0.ev } })],
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 0, statut: 200 }); return []; },
                                 fetchEspn: async () => ({ ok: statut === 200, status: statut, json: async () => ({ events: [sim.evenementEspn(m0, Math.min(t, m0.K + 60 * MIN), 20)] }) }) });
      await p.tic(t);
      statut = 429;
      traces.length = 0;
      for (const pas of [16, 121, 241, 481, 961, 1801, 1801]) { t += pas * 1000; await p.tic(t); }
      const reculs = traces.filter((s) => /la passe rapide recule de/.test(s)).map((s) => Number(/recule de (\d+) s/.exec(s)[1]));
      eq(reculs.join(','), '120,240,480,960,1800,1800,1800', 'sept 429 de suite : 2, 4, 8, 16 min, puis plafonne a 30 min');
      statut = 200; t += 1801000; await p.tic(t);
      statut = 429; traces.length = 0; t += 16000; await p.tic(t);
      ok(dit(/recule de 120 s/), 'une lecture sans refus, puis un 429 : le recul repart de 2 min');
    }
    /* sans etat « post », la rencontre finit a 130 min (terminee, ESPN apparie) */
    {
      nouveau('cent-trente');
      const cal = sim.calendrier(11, 1);
      const m0 = cal[0];
      const catS = [rencontre(m0.id, m0.dom, m0.ext, m0.ligue, m0.K, { source: { fournisseur: 'the-odds-api', ligue: m0.ligue, evenement: m0.ev } })];
      let t = m0.K - 2 * MIN;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => catS, quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return [sim.evenementOdds(m0, t, 'sain', () => 0.5)]; },
                                 /* un ESPN fige en 2e periode : jamais « post » */
                                 fetchEspn: async () => ({ ok: true, status: 200, json: async () => ({ events: [sim.evenementEspn(m0, Math.min(t, m0.K + 60 * MIN), 20)] }) }) });
      for (; t <= m0.K + 132 * MIN; t += 5000) await p.tic(t);
      const r = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8')).rencontres[m0.id];
      eq(`${r.etat}|${r.raison}`, 'terminee|fin sans etat post (130 min)', 'ESPN jamais « post » : terminee a 130 min, et on cesse de payer');
    }
    /* deux tics en meme temps (une releve lente) : le second ne fait rien */
    {
      nouveau('reentrant');
      const t = K - 2 * MIN;
      let libere = null, appels = 0;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { appels++; await new Promise((r) => { libere = r; }); Object.assign(info, { dernier: 1, statut: 200 }); return []; } });
      const premier = p.tic(t);
      for (let k = 0; k < 20 && !libere; k++) await new Promise((r) => setImmediate(r));
      const second = await p.tic(t + 61000);
      libere(); await premier;
      eq(`${second.fait}|${appels}`, 'occupe|1', 'un tic pendant une releve en vol : « occupe », aucun second appel');
    }
    /* la purge : jamais le jour courant (meme seul au-dela de 20 Mo), jamais un fichier qui n'est pas un jour */
    {
      const d = nouveau('purge-jour');
      const dj = path.join(d, 'paris_en_jeu');
      fs.mkdirSync(dj, { recursive: true });
      const T = Date.UTC(2026, 9, 31, 12, 0);
      fs.writeFileSync(path.join(dj, '2026-10-31.jsonl'), Buffer.alloc(21 * 1024 * 1024, 120));
      fs.writeFileSync(path.join(dj, '2025-01-01.notes'), 'garde');
      await enJeu.tic(T, { appel: async () => [], catalogue: () => [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', T + 60000)], horloge: () => T,
                           lisEspn: async () => new Map(), quota: () => ({ depense: 0, part: 0, reserve: 80 }) });
      ok(fs.existsSync(path.join(dj, '2026-10-31.jsonl')), 'le jour courant reste, meme seul au-dela de 20 Mo');
      ok(fs.existsSync(path.join(dj, '2025-01-01.notes')), 'un fichier date qui n est pas un .jsonl du journal reste');
    }
    /* le bilan : chaque condition sait rougir, et une rencontre qui manque une exigence ne compte pas */
    {
      const P0 = { projection: 9000 };
      const base = enJeu.bilan(sain, P0);
      eq(base.porte.verte, true, '(le journal sain : vert)');
      const dK = new Map(sain.filter((l) => l.k === 'a').map((l) => [l.id, l.d]));
      const tIn = new Map();
      for (const l of sain) if (l.k === 'e' && l.et === 'in' && !tIn.has(l.id)) tIn.set(l.id, l.t);
      /* G2 : moins de 20 evenements jugeables, aucune fuite : pas mesurable, jamais vert. Depuis la
         relecture du 11/10/2026, c'est un manque (« not enough »), pas « G2 red » : une lecture
         « red » ferait conclure a une fuite au lieu de prolonger l'observation. */
      const un = sain.filter((l) => !l.id || l.id === 'sim-0' || (l.k === 'c' && l.ids.includes('sim-0')));
      const b1 = enJeu.bilan(un, P0);
      ok(!b1.conditions.G2.ok && b1.conditions.G2.fuites === 0 && b1.conditions.G2.jugeables < 20 && /not measurable/.test(b1.conditions.G2.texte),
         `G2 sur ${b1.conditions.G2.jugeables} evenement(s) jugeable(s), 0 fuite : « not measurable », jamais vert`);
      ok(!b1.porte.verte && /judgeable event\(s\) for G2 < 20/.test(b1.porte.raisons[0]) && !b1.porte.raisons.some((x) => x.startsWith('G2 red')),
         '... et la porte le range dans « not enough », jamais dans « G2 red »');
      /* G3 : une bourse figee (last_update de 30 s) une entree sur sept (impair : les deux rencontres d'un appel partage y passent) */
      let k = 0;
      const fige = sain.map((l) => (l.k === 'c' && l.ev ? Object.assign({}, l, { ev: l.ev.map((e) => (e.lu && (k++ % 7 === 0) ? Object.assign({}, e, { lu: l.t - 30000 }) : e)) }) : l));
      const b2 = enJeu.bilan(fige, P0);
      ok(!b2.conditions.G3.ok && b2.conditions.G3.vendables.length === 0, `G3 : une releve sur sept figee -> aucun club a 95 % (${JSON.stringify(Object.values(b2.conditions.G3.clubs).map((c) => Math.round(c.vivante * 1000) / 10))}), rouge`);
      eq(b2.porte.verte, false, '... et la porte se ferme');
      /* G3 : un club dont une rencontre n'est pas appariee par ESPN n'est pas vendable */
      const enPlus = sain.concat([{ v: 1, k: 'a', t: Date.UTC(2026, 10, 1, 18, 58), id: 'rm-x', l: 'soccer_spain_la_liga', e: 'ev-x', dom: 'Real Madrid', ext: 'Elche',
                                    d: Date.UTC(2026, 10, 1, 19, 0), cl: ['Real Madrid'], ok: 1, est: 115, c: 60 },
                                  { v: 1, k: 'f', t: Date.UTC(2026, 10, 1, 19, 30), id: 'rm-x', fin: 'incomplete', r: 'espn non apparie' }]);
      const rm = enJeu.bilan(enPlus, P0).conditions.G3.clubs['Real Madrid'];
      ok(rm.vendable === false && /^ESPN matched 4 of 5/.test(rm.pourquoi), 'G3 : Real Madrid, une rencontre sur cinq sans ESPN : pas vendable (« ' + rm.pourquoi + ' »)');
      /* G4 : dix minutes sans lecture ESPN dans chaque rencontre */
      const muet = sain.filter((l) => !(l.k === 'e' && dK.has(l.id) && l.t > dK.get(l.id) + 1000000 && l.t < dK.get(l.id) + 1600000));
      const b4 = enJeu.bilan(muet, P0);
      ok(!b4.conditions.G4.ok && b4.conditions.G4.part > 0.02, `G4 : 10 min muettes par rencontre (${Math.round(b4.conditions.G4.part * 1000) / 10} %) : rouge`);
      /* G5 : x-requests-last = 2 sur les releves d'avant le coup d'envoi (hors fenetre : les credits de la fenetre ne bougent pas) */
      const cher = sain.map((l) => (l.k === 'c' && l.ids && l.ids.every((id) => tIn.has(id) && l.t < tIn.get(id)) ? Object.assign({}, l, { x: 2 }) : l));
      const b5 = enJeu.bilan(cher, P0);
      ok(!b5.conditions.G5.ok && b5.conditions.G5.auPlusUn < 0.99 && b5.conditions.G5.creditsRencontreMax === base.conditions.G5.creditsRencontreMax,
         `G5 : ${Math.round((1 - b5.conditions.G5.auPlusUn) * 1000) / 10} % des appels a 2 credits (hors fenetre) : rouge par x-requests-last seul`);
      const b5b = enJeu.bilan(sain, Object.assign({ g5CreditsRencontreMax: 90 }, P0));
      ok(!b5b.conditions.G5.ok, `G5 : ${base.conditions.G5.creditsRencontreMax} credits par rencontre contre un plafond de 90 : rouge`);
      /* G6 : 94,5 % acceptes hors evenement contre un seuil de 95 % */
      const b6 = enJeu.bilan(sain, Object.assign({ g6AccepteesMin: 0.95 }, P0));
      ok(!b6.conditions.G6.ok && b6.conditions.G6.part < 0.95, `G6 : ${Math.round(b6.conditions.G6.part * 1000) / 10} % contre 95 % : rouge`);
      /* une rencontre ne compte que finie « terminee », appariee par ESPN, avec 90 % de ses releves */
      const sans = (f) => enJeu.bilan(f(sain), P0).echantillon.rencontres;
      eq(sans((L) => L.map((l) => (l.k === 'f' && l.id === 'sim-5' ? Object.assign({}, l, { fin: 'incomplete' }) : l))), 23, 'une fin « incomplete » : la rencontre ne compte pas');
      eq(sans((L) => L.filter((l) => !(l.k === 'e' && l.id === 'sim-5'))), 23, 'aucune lecture ESPN : la rencontre ne compte pas');
      let q = 0;
      eq(sans((L) => L.map((l) => (l.k === 'c' && l.ids && l.ids.length === 1 && l.ids[0] === 'sim-5' && (q++ % 5 === 0) ? Object.assign({}, l, { ko: 'DELAI', ev: undefined }) : l))),
         23, 'une releve sur cinq en echec (80 % < 90 %) : la rencontre ne compte pas');
    }
    delete process.env.PARIS_EN_JEU;
  }

  // ==================================================================== 13
  /* Les trous de la SECONDE mutation (11/10/2026, 223 mutants, 65 survivants,
     54 non equivalents) et les constats de la relecture du meme jour : chaque
     verification ci-dessous est vraie sur le code et tombe sur son mutant
     (l'identifiant entre crochets est celui de la mutation). */
  titre('13. la seconde mutation et la relecture');
  {
    process.env.PARIS_EN_JEU = 'observe';
    const Q = () => ({ depense: 0, part: 100000, reserve: 80 });
    const K = Date.UTC(2026, 9, 25, 12, 0);
    const cat = [rencontre('a', 'Arsenal', 'Everton', 'soccer_epl', K)];
    const bourse = (t, prix, dom, ext) => [{ id: 'ev-a', home_team: dom || 'Arsenal', away_team: ext || 'Everton', bookmakers: [{ key: 'betfair_ex_eu',
      markets: [{ key: 'h2h', last_update: new Date(t - 2000).toISOString(), outcomes: [{ name: dom || 'Arsenal', price: prix[0] }, { name: 'Draw', price: prix[1] }, { name: ext || 'Everton', price: prix[2] }] }] }] }];
    /* les variables posees le temps d'une lecture de config() */
    const avec = (vars, f) => { const av = {}; for (const k of Object.keys(vars)) { av[k] = process.env[k]; process.env[k] = vars[k]; }
      try { return f(); } finally { for (const k of Object.keys(vars)) { if (av[k] === undefined) delete process.env[k]; else process.env[k] = av[k]; } } };
    const etatDisque = (o) => { fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify(Object.assign({ v: 1, credits: { total: 0, jours: {}, mois: {} }, appels: 0, rencontres: {} }, o))); enJeu.recharge(); };

    /* -- les bornes des reglages [P10, P11, P16, P19, P23, P24] */
    eq(`${avec({ PARIS_EN_JEU_ESPN_S: '1' }, () => enJeu.config().espnS)}|${avec({ PARIS_EN_JEU_ESPN_S: '600' }, () => enJeu.config().espnS)}`, '10|45',
       'PARIS_EN_JEU_ESPN_S borne de 10 a 45 s (1 -> 10, 600 -> 45)');
    eq(`${avec({ PARIS_EN_JEU_CREDITS_OBS: '50000' }, () => enJeu.config().creditsObs)}|${avec({ PARIS_EN_JEU_CREDITS_JOUR: '5000' }, () => enJeu.config().creditsJour)}`, '20000|2000',
       'plafonds bornes : observation 20 000 au plus, jour 2 000 au plus');
    eq(`${avec({ PARIS_EN_JEU_FERME_MIN: '10' }, () => enJeu.config().fermeMin)}|${avec({ PARIS_EN_JEU_FERME_MIN: '200' }, () => enJeu.config().fermeMin)}|${avec({ PARIS_EN_JEU_GARDE: '-1' }, () => enJeu.config().garde)}`,
       '46|90|0', 'fermeture bornee de 46 a 90 min, garde jamais negative (une garde negative accepterait au-dessus du prix juste)');
    eq(avec({ PARIS_EN_JEU_CADENCE_S: '30' }, () => enJeu.estimation(enJeu.config())), 230, '[P65] l estimation suit la cadence : 115 min a 30 s = 230 credits');

    /* -- la selection : coup d'envoi illisible, evenement absent [P46, P43] */
    {
      const T = Date.UTC(2026, 9, 18, 19, 0);
      const sansEv = rencontre('x', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', T); sansEv.source = { fournisseur: 'the-odds-api', ligue: 'soccer_spain_la_liga' };
      eq(enJeu.aSuivre([rencontre('y', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', 'pas une date')], T, enJeu.config()).length, 0,
         'un coup d envoi illisible n est jamais suivi (sinon ni la fin a 130 min ni l arret a 30 min ne tomberaient)');
      eq(enJeu.aSuivre([sansEv], T, enJeu.config()).length, 0, 'une rencontre sans identifiant d evenement n est jamais suivie');
    }

    /* -- l'admission : engages, jour, socle, quota qui leve [P55, P58, P62, P64] */
    {
      nouveau('admission-2');
      const j = new Date().toISOString().slice(0, 10);
      const cfg = enJeu.config();
      etatDisque({ credits: { total: 2890, jours: {}, mois: {} }, rencontres: { x: { etat: 'admise', est: 115, cr: 200 } } });
      eq(enJeu.admet(Date.now(), cfg, Q).ok, false, '[P55] une rencontre en cours qui a coute PLUS que son estimation (200 > 115) engage 0, jamais -85 : 2 890 + 0 + 115 > 3 000, refusee');
      etatDisque({ credits: { total: 200, jours: { [j]: 200 }, mois: {} }, rencontres: { x: { etat: 'admise', est: 115, cr: 10 } } });
      eq(enJeu.admet(Date.now(), cfg, Q).raison, 'plafond du jour (200 + 105 engages + 115 > 400)', '[P58] le plafond du jour compte les engages : 200 + 105 + 115 > 400');
      etatDisque({ rencontres: { x: { etat: 'admise', est: 115, cr: 10 } } });
      eq(enJeu.admet(Date.now(), cfg, () => ({ depense: 0, part: 299, reserve: 80 })).raison, 'part du jour du socle (0 + 105 engages + 115 > 299 - 80)',
         '[P62] la part du jour du socle compte les engages : 0 + 105 + 115 > 299 - 80');
      etatDisque({});
      eq(enJeu.admet(Date.now(), cfg, () => { throw new Error('socle illisible'); }).raison, 'part du jour inconnue', '[P64] un quota() qui leve : refusee (echoue ferme, jamais une part infinie)');
    }
    /* -- une rencontre refusee a l'admission n'est jamais relevee [P123] */
    {
      nouveau('refusee-jamais-relevee');
      let t = K - 2 * MIN, appels = 0;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: () => null,
                                 appel: async (c, pa, k, q, pr, info) => { appels++; Object.assign(info, { dernier: 1, statut: 200 }); return bourse(t, [1.9, 3.6, 4.4]); } });
      for (let k = 0; k < 5; k++) { await p.tic(t); t += 61000; }
      eq(`${appels}|${enJeu.etat().rencontres.refusees}`, '0|1', 'part du jour inconnue a l admission : refusee, et AUCUNE releve en 5 minutes');
    }

    /* -- le compteur illisible reste ferme apres un redeploiement (relecture du 11/10/2026) */
    {
      const d = nouveau('illisible-redeploiement');
      const cfg = enJeu.config();
      const q = () => ({ depense: 0, part: 600, reserve: 80 });
      etatDisque({ credits: { total: 2990, jours: {}, mois: {} }, appels: 2990 });
      ok(/^plafond de l observation/.test(enJeu.admet(Date.now(), cfg, q).raison), '2 990 credits depenses : refusee par le plafond');
      fs.writeFileSync(enJeu.fichierEtat(), '{"v":1,"credits":{"total":29');
      enJeu.recharge();
      /* une lecture d'etat (GET /paris/import) ne touche RIEN, meme sur un compteur illisible */
      const avantGet = fs.readdirSync(d).sort().join(',');
      const eg = enJeu.etat();
      eq(`${eg.compteurIllisible}|${fs.readdirSync(d).sort().join(',')}`, `true|${avantGet}`, 'etat() sur un compteur illisible : le dit, sans renommer ni ecrire aucun fichier');
      const now = Date.now();
      const catI = [rencontre('m1', 'Barcelona', 'Getafe', 'soccer_spain_la_liga', now + 60000)];
      const p = enJeu.planifie({ cle: true, appel: async () => [], catalogue: () => catI, minuteries: false, horloge: () => now, estRegle: () => false, quota: q, lisEspn: async () => new Map() });
      await p.tic(now);
      const disque = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8'));
      ok(disque.illisible && /^paris_en_jeu_quota\.json\.illisible-\d+$/.test(disque.illisible.fichier), 'apres un tic, le compteur ecrit PORTE le marqueur « illisible » (et le nom du fichier mis de cote)');
      enJeu.recharge();                     /* un redeploiement */
      const r = enJeu.admet(now, enJeu.config(), q);
      eq(`${r.ok}|${r.raison}`, 'false|compteur illisible', 'apres le redeploiement : TOUJOURS refusee (le plafond de 3 000 ne se rouvre pas a zero)');
      ok(dit(/compteur marque illisible depuis .* AUCUNE rencontre admise tant que le proprietaire/), 'et c est redit au demarrage, avec ce qu il faut faire');
      /* seul le proprietaire le leve : remettre le total, retirer « illisible » */
      const leve = Object.assign({}, disque, { credits: { total: 2990, jours: {}, mois: {} } }); delete leve.illisible;
      fs.writeFileSync(enJeu.fichierEtat(), JSON.stringify(leve)); enJeu.recharge();
      ok(/^plafond de l observation \(2990/.test(enJeu.admet(now, enJeu.config(), q).raison), 'le proprietaire remet 2 990 et retire le marqueur : le plafond reprend la ou il etait');
    }

    /* -- une rencontre admise sortie du catalogue ne reste pas engagee (relecture du 11/10/2026) */
    {
      const d = nouveau('engagement-fantome');
      etatDisque({ rencontres: { fantome: { etat: 'admise', tA: K - 2 * MIN, d: K, l: 'soccer_epl', clubs: ['Arsenal'], est: 115, c: 60, cr: 3, ok: 3, ko: 0 } } });
      const t = K + 131 * MIN;
      await enJeu.tic(t, { appel: async () => [], catalogue: () => [], horloge: () => t, lisEspn: async () => new Map(), quota: Q });
      const r = JSON.parse(fs.readFileSync(path.join(d, 'paris_en_jeu_quota.json'), 'utf8')).rencontres.fantome;
      eq(`${r.etat}|${r.raison}|${r.complete}`, 'incomplete|absente du catalogue, 130 min passees|false',
         'admise, absente du catalogue apres un redeploiement, 131 min apres son coup d envoi : finie « incomplete »');
      etatDisque({ credits: { total: 2780, jours: {}, mois: {} }, rencontres: { fantome: r } });
      eq(enJeu.admet(t, enJeu.config(), Q).ok, true, '... et son reste estime n est plus engage : 2 780 + 0 + 115 <= 3 000, admise');
      nouveau('engagement-encore');
      etatDisque({ rencontres: { tot: { etat: 'admise', tA: K - 2 * MIN, d: K, est: 115, c: 60, cr: 0 } } });
      await enJeu.tic(K + 100 * MIN, { appel: async () => [], catalogue: () => [], horloge: () => K + 100 * MIN, lisEspn: async () => new Map(), quota: Q });
      eq(JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8')).rencontres.tot.etat, 'admise', '(100 min apres le coup d envoi : encore admise, elle peut revenir au catalogue)');
    }

    /* -- comptages et notes de releve [P85, P69, P27, P99, P103] */
    {
      nouveau('compte-prudent');
      const t = K - 2 * MIN;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: Q,
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { comptePrudent: 1, code: 'DELAI' }); throw new Error('delai'); } });
      await p.tic(t);
      eq(enJeu.etat().credits.total, 1, '[P85] un delai sans en-tete compte ce que le socle compte (comptePrudent 1), jamais 0');
    }
    {
      nouveau('complete-puis-refus');
      let t = K - 2 * MIN, nA = 0;
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, quota: Q,
                                 lisEspn: async () => new Map([['a', { etat: 'in', statut: 'STATUS_FIRST_HALF', horloge: 60, periode: 1, score: '0-0', rouges: [0, 0], evenements: [] }]]),
                                 appel: async (c, pa, k, q, pr, info) => { nA++; if (nA > 30) { info.code = 'REFUSE'; throw new Error('refuse'); }
                                   Object.assign(info, { dernier: 1, statut: 200 }); return bourse(t, [1.9, 3.6, 4.4]); } });
      for (let k = 0; k < 32; k++) { await p.tic(t); t += 61000; }
      const r = JSON.parse(fs.readFileSync(enJeu.fichierEtat(), 'utf8')).rencontres.a;
      eq(`${r.etat}|${r.complete}|${r.ok}`, 'incomplete|false|30', '[P69] 30 releves reussies, ESPN apparie, puis le socle REFUSE : « incomplete », jamais complete');
    }
    {
      const d = nouveau('rencontres-max');
      const rs = { enCours: { etat: 'admise', tA: 0, d: K, est: 115, cr: 1 } };
      for (let k = 1; k <= 2000; k++) rs['f' + k] = { etat: 'terminee', tA: k, fin: k + 1 };
      etatDisque({ rencontres: rs });
      await enJeu.tic(K, { appel: async () => [], catalogue: () => [rencontre('neuve', 'Arsenal', 'Everton', 'soccer_epl', K), rencontre('enCours', 'Liverpool', 'Fulham', 'soccer_epl', K)],
                           horloge: () => K, lisEspn: async () => new Map(), quota: () => null });
      const E = JSON.parse(fs.readFileSync(path.join(d, 'paris_en_jeu_quota.json'), 'utf8')).rencontres;
      eq(`${!!E.enCours}|${!!E.f1}|${Object.keys(E).length}`, 'true|false|2001',
         '[P27] 2 002 entrees : les deux plus anciennes devraient sortir — la finie sort, la rencontre EN COURS (la plus ancienne) reste : 2 001');
    }
    {
      const uneReleve = async (nom, evs) => {
        nouveau(nom);
        const t = K - 2 * MIN;
        const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, lisEspn: async () => new Map(), quota: Q,
                                   appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return evs(t); } });
        await p.tic(t);
        return lisJournal().find((l) => l.k === 'c').ev[0];
      };
      eq((await uneReleve('orientation-ext', (t) => bourse(t, [1.9, 3.6, 4.4], 'Arsenal', 'Fulham'))).o, 0,
         '[P99] le fournisseur a le bon domicile mais un autre exterieur : orientation 0 (les deux noms comptent)');
      /* P105 : un prix de cote arriere <= 1 n'est pas une cote : la ligne h2h_lay est ecartee */
      const avecLay = (lay) => (t) => { const x = bourse(t, [1.9, 3.6, 4.4]); x[0].bookmakers[0].markets.push({ key: 'h2h_lay', outcomes: [
        { name: 'Arsenal', price: lay[0] }, { name: 'Draw', price: lay[1] }, { name: 'Everton', price: lay[2] }] }); return x; };
      eq(JSON.stringify((await uneReleve('lay-sain', avecLay([1.92, 3.7, 4.6]))).lay), '[1.92,3.7,4.6]', 'h2h_lay lu par nom : [1,92 ; 3,7 ; 4,6]');
      eq((await uneReleve('lay-un', avecLay([1, 3.7, 4.6]))).lay, undefined, 'un prix arriere de 1,00 : la ligne h2h_lay est ecartee');
      const e = await uneReleve('somme-basse', (t) => bourse(t, [2.2, 3.6, 4.4]));
      eq(`${e.s}|${e.pb}`, '0.9596|undefined', '[P103] cotes 2,2 / 3,6 / 4,4 : somme des inverses 0,96 < 1,00 : notee, aucune p (une bourse sous 1 n est jamais vivante)');
    }

    /* -- ESPN lu toutes les 15 s, pas a chaque tic de 5 s [P126] */
    {
      nouveau('espn-cadence');
      let t = K - 2 * MIN, lus = 0;
      const vus = [];
      const p = enJeu.planifie({ cle: true, minuteries: false, horloge: () => t, catalogue: () => cat, quota: Q,
                                 lisEspn: async () => { lus++; vus.push((t - K) / 1000); return new Map(); },
                                 appel: async (c, pa, k, q, pr, info) => { Object.assign(info, { dernier: 1, statut: 200 }); return bourse(t, [1.9, 3.6, 4.4]); } });
      for (let k = 0; k < 12; k++) { await p.tic(t); t += 5000; }
      eq(`${lus}|${vus.join(',')}`, '4|-120,-105,-90,-75', '12 tics de 5 s (60 s) : QUATRE lectures ESPN, a -120, -105, -90 et -75 s');
    }

    /* -- les gardes : une SOUS-condition a la fois [G05, G06, G08, G09, G10, G11, G12, G14, G15, G16, G18, G04] */
    {
      const P = Object.assign({}, enJeu.PORTE, { delaiS: 60, cadenceS: 60, delaiMs: 60000, cadenceMs: 60000, garde: 0.03, fermeMin: 80, marge: 0.10 });
      const pb = [0.5, 0.3, 0.2];
      const cv = enJeu.habille(pb, 0.10)['1'];
      const td = Date.UTC(2026, 9, 23, 19, 20);
      const lec = (t, x) => Object.assign({ t, et: 'in', pe: 1, h: 1200, st: 'STATUS_FIRST_HALF', s: '0-0', r: [0, 0] }, x || {});
      const base = () => ({ d: { t: td, o: '1', cv }, i: { t: td - 10000, e: { pb, lu: td - 15000, ref: 'b', o: 1 } },
                            j: { t: td + 70000, e: { pb: pb.slice(), lu: td + 66000, ref: 'b', o: 1 } },
                            ei: lec(td - 10000), ed: lec(td), ej: lec(td + 65000, { h: 1275 }), cf: cv, regle: 'stricte', tol: 0, P });
      const refusPar = (f) => { const c = base(); f(c); const r = enJeu.accepte(c); return r.ok ? 'acceptee' : r.refus; };
      const SOUS = [
        ['bourseVivante', 'vue apres la demande mais 64 s avant j (fraicheur 20 s)', (c) => { c.j.e.lu = td + 6000; }],
        ['bourseSeule', 'reference Pinnacle a la releve i', (c) => { c.i.e.ref = 'p'; }],
        ['orientation', 'fournisseur inverse a la releve i', (c) => { c.i.e.o = 0; }],
        ['entreeVivante', 'ancienne entree a la releve i', (c) => { c.i.e.vi = 0; }],
        ['nonFermee', 'rencontre SUSPENDUE a j', (c) => { c.j.e.su = 1; }],
        ['espnVivant', 'ESPN lu « post » a j', (c) => { c.ej.et = 'post'; }],
        ['minute', 'periode 3 (prolongation)', (c) => { Object.assign(c.ej, { pe: 3, h: 5500, st: 'STATUS_FIRST_HALF_EXTRA_TIME' }); }],
        ['miTemps', '2e periode, horloge sous 2 700', (c) => { Object.assign(c.ej, { pe: 2, h: 2000 }); }],
        ['rouge', 'rouge vu ENTRE la releve i et la demande (le parieur l a vu)', (c) => { c.ed.r = [0, 1]; c.ej.r = [0, 1]; }],
        ['garde', 'cote x p fraiche = 0,98 (sous 1, au-dessus de 0,97)', (c) => { c.j.e.pb = [0.98 / cv, 0.3, 1 - 0.3 - 0.98 / cv]; }],
        ['scoreRef', 'une garde qui LEVE (lecture bancale) vaut refus', (c) => { Object.defineProperty(c.ed, 's', { get() { throw new Error('lecture bancale'); } }); }],
      ];
      eq(enJeu.accepte(base()).ok, true, '(le scenario de base passe)');
      for (const [garde, quoi, f] of SOUS) eq(refusPar(f), garde, `${quoi} : refusee par ${garde}`);
      /* G04 : « vue apres la demande » n'est jugeable qu'a un delai court (a 60 s, la fraicheur l'implique) */
      const P10 = Object.assign({}, P, { delaiS: 10, cadenceS: 10, delaiMs: 10000, cadenceMs: 10000 });
      const c10 = Object.assign(base(), { P: P10 });
      c10.j = { t: td + 12000, e: { pb: pb.slice(), lu: td + 2000, ref: 'b', o: 1 } };
      c10.ej = lec(td + 11000, { h: 1211 });
      eq(enJeu.accepte(c10).refus, 'bourseVivante', 'delai 10 s, bourse vue 2 s apres la demande (fraiche de 10 s) : refusee — la bourse doit etre vue 5 s APRES la demande');
      c10.j.e.lu = td + 6000;
      eq(enJeu.accepte(c10).ok, true, '(la meme, vue 6 s apres la demande : acceptee)');
      /* l'offre [O1, O4, O7] */
      const b0 = base();
      eq(enJeu.offre(b0.i, Object.assign({}, b0.ed, { h: 2750 }), b0.i.t, P, 0.10), null, 'offre : arrets de jeu de la 1re periode (horloge 2 750) : rien');
      eq(enJeu.offre(Object.assign({}, b0.i, { e: Object.assign({}, b0.i.e, { lu: undefined }) }), b0.ed, b0.i.t, P, 0.10), null, 'offre : bourse sans last_update : rien (jamais un NaN qui laisse passer)');
      eq(enJeu.offre(b0.i, Object.assign({}, b0.ed, { et: 'post' }), b0.i.t, P, 0.10), null, 'offre : ESPN lu « post » : rien');
      /* O5 (troisieme passage) : la fermeture a la 80e n'etait plus tenue que par une fausse fuite de fin de match, disparue avec la datation exacte */
      const ed2 = (h) => Object.assign({}, b0.ed, { pe: 2, h, st: 'STATUS_SECOND_HALF' });
      eq(`${!!enJeu.offre(b0.i, ed2(4799), b0.i.t, P, 0.10)}|${enJeu.offre(b0.i, ed2(4800), b0.i.t, P, 0.10)}`, 'true|null',
         'offre : 2e periode a 79:59, offerte ; a 80:00 (PARIS_EN_JEU_FERME_MIN), plus rien');
      ok(enJeu.offre(b0.i, b0.ed, b0.i.t, P, 0.10), '(offre : le scenario de base est offert)');
    }

    /* -- la porte : chaque condition, SEULE rouge, ferme la porte ; la porte ecrite d'avance ne bouge pas [A31-A36, A02, A06, A10, A18, A21, A22] */
    {
      const P0 = { projection: 9000 };
      eq(enJeu.bilan(sain, P0).porte.verte, true, '(le journal sain : vert)');
      const SEULE = { G1: { g1AcceptesMax: -1 }, G2: { g2PartMax: -1 }, G3: { g3VivanteMin: 1.01 }, G4: { g4MuetMax: -1 }, G5: { g5CreditsRencontreMax: 1 }, G6: { g6AccepteesMin: 1.01 } };
      for (const [k, x] of Object.entries(SEULE)) {
        const b = enJeu.bilan(sain, Object.assign({}, P0, x));
        eq(`${b.porte.verte}|${b.porte.raisons.length}|${b.porte.raisons[0].slice(0, 8)}`, `false|1|${k} red: `, `${k} seule rouge (${JSON.stringify(x)}) : la porte se ferme, par ${k} seule`);
      }
      eq(JSON.stringify(enJeu.PORTE), JSON.stringify({ evenementsMin: 40, rencontresMin: 20, clubsMin: 5, joursMin: 14, deltasS: [5, 15, 30], g1AcceptesMax: 0,
        g2FenetreS: 120, g2VuApresS: 20, g2AbsorbeMin: 0.5, g2MouvementMin: 0.05, g2AvantS: 120, g2ApresS: 180, g2PartMax: 0.05, g2JugeablesMin: 20,
        g3VivanteMin: 0.95, g3HorsEvenementS: 120, g3RencontresClub: 3, g3ClubsMin: 4, g4MuetMax: 0.02, g5CoutUnMin: 0.99, g5CreditsRencontreMax: 100,
        g5ProjectionMax: 16000, g6AccepteesMin: 0.50, g6HorsEvenementS: 180, g6Tolerance: 0.10, favoriseMin: 1.02, marges: [0.06, 0.10, 0.15],
        retardEspnMaxS: 20, retardEspnLecturesMin: 5 }),
         'la porte ECRITE D AVANCE, cle par cle (EXPLOITATION 8.12) : une porte non atteinte fait glisser la date, jamais le seuil');
      ok(Object.isFrozen(enJeu.PORTE), '... et figee (Object.freeze)');
      /* G2 sous 20 jugeables mais deja plus de 5 % de 20 en fuites : rouge, sans attendre */
      const g2tot = enJeu.bilan(sain.filter((l) => !l.id || ['sim-0', 'sim-1', 'sim-2'].includes(l.id) || (l.k === 'c' && l.ids.some((i) => ['sim-0', 'sim-1', 'sim-2'].includes(i)))),
                                Object.assign({}, P0, { g2AbsorbeMin: 2 }));
      ok(g2tot.conditions.G2.jugeables < 20 && g2tot.conditions.G2.fuites >= 2 && g2tot.porte.raisons.some((x) => x.startsWith('G2 red:')),
         `G2 : ${g2tot.conditions.G2.fuites} fuites sur ${g2tot.conditions.G2.jugeables} jugeables (sous 20) — plus de 5 % de 20 deja vus : « G2 red », pas « not enough »`);
    }
    delete process.env.PARIS_EN_JEU;
  }

  fini = true;
  /* le bac a sable de l'essai (journaux synthetiques, fichiers de purge de 20 Mo) : retire quand tout est vert */
  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* rien */ }
  logVrai(`\nparis_en_jeu.test.js : ${n} verifications OK`);
})().catch((e) => { logVrai('RATE ' + (e && e.stack || e)); process.exit(1); });
