'use strict';
/*
 * LES COUPES : INVENTAIRE (0 credit) ET OBSERVATION A 48 H, RIEN DE VENDU
 * (lot 6 de la cle 20K, 11/10/2026, EXPLOITATION 8.11).
 *
 * Ce lot est une OBSERVATION : PARIS_COUPES_OBSERVE, PARIS_COUPES_OBSERVE_H et
 * PARIS_COUPES sont vides par defaut. L'essai tient ces promesses, chacune
 * avec la verification qui tombe si son garde-fou est retire :
 *  1. rien par defaut : aucune coupe en service, aucun appel, catalogue et
 *     carnet de la reference figee du socle (essais/reference) octet pour
 *     octet, aucune minuterie de plus ;
 *  2. l'inventaire coute 0 credit : /events seulement (0 credit, la doc), aucun
 *     /odds avec la fenetre a 0, aucune rencontre de coupe au catalogue ni
 *     ouverte, catalogue et carnet identiques octet pour octet a ceux d'un
 *     import sans coupe ; l'appariement ESPN (par espn.releve) dit les non
 *     appariees avec les noms ESPN du meme jour, les noms sans drapeau, ceux
 *     qui ne le tiennent que de la ligue, et les doublons ; ESPN en panne ne
 *     leve rien et ne conclut rien ;
 *  3. l'observation payante : 1 credit, classe 3, seulement si une rencontre
 *     commence dans les 48 h, jamais deux releves a moins de 2 h, jamais
 *     prioritaire (refusee quand le jour est pris, la ou un championnat vendu
 *     passe) ; la releve forcee T-45/T-20 en classe 2, une fois par creneau ;
 *  4. une coupe observee n'entre jamais au catalogue, meme au prix frais, et
 *     une rencontre de coupe deja au catalogue est SUSPENDUE ;
 *  5. PARIS_COUPES (la vente) est lue, dite et IGNOREE : rien n'est vendu ;
 *  6. les cles se disent : coupe dans les listes des championnats, cle hors
 *     des huit, fenetre illisible (echoue ferme) ;
 *  7. l'etalonnage ne paie et ne touche jamais une coupe ;
 *  8. la prolongation : les huit coupes reglees a la main au-dela de 90 min ;
 *  9. noms, pays, identifiants ;
 * 10. le suivi d'avant-match, hors de note() : jamais ecrase par un releve en
 *     direct, « aucun » et « retire » comptes, lecture refusee = rien ecrit,
 *     contenu illisible mis de cote ;
 * 11. la porte : chaque seuil juste au-dessus ET juste en dessous, et le
 *     serveur seul ne l'ouvre jamais (D hors serveur) ;
 * 12. la derive, sur le journal (outils/age_prix.js --coupes) : paires de
 *     meme reference, avant le coup d'envoi, a 3 h au plus, comptees par
 *     rencontre, double chance coupee au-dessus de 0,93, reference des
 *     championnats sur les memes jours, et la MEME porte que le serveur.
 * Aucun reseau : `fetch` est remplace par un faux fournisseur qui facture
 * marches x regions (https://the-odds-api.com/liveapi/guides/v4/), 0 pour
 * /events et pour une reponse /odds vide, et par un faux ESPN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-des-coupes';
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
const HUIT = [UEL, UECL, FA, 'soccer_england_efl_cup', DFB, 'soccer_spain_copa_del_rey', 'soccer_italy_coppa_italia', 'soccer_france_coupe_de_france'];

// --------------------------------------------------- le faux fournisseur
const T0 = Date.now();
const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('e1', 'Arsenal', 'Everton', T0 + 30 * H), ev('e2', 'Chelsea', 'Liverpool', T0 + 50 * H)],
  soccer_spain_la_liga: [ev('s1', 'Real Madrid', 'Getafe', T0 + 30 * H)],
  [UEL]: [ev('u1', 'FC Copenhagen', 'Ajax', T0 + 30 * H), ev('u2', 'Real Betis', 'Lyon', T0 + 60 * H),
          ev('u3', 'Celtic', 'Roma', T0 + 40 * MIN), ev('u4', 'Porto', 'Nice', T0 + 8 * 24 * H)],
  /* la meme affiche que e1, sous la cle de la FA Cup, une heure plus tard : un doublon */
  [FA]: [ev('f1', 'Arsenal', 'Everton', T0 + 31 * H)],
  [DFB]: [ev('d1', 'Bayern Munich', 'Hamburger SV', T0 + 60 * H)],
};
const livre = (key, e, c1, cn, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
const avec = (e, livres) => Object.assign({}, e, { bookmakers: livres });
const trois = (e, p) => [livre('betfair_ex_eu', e, ...p.map((x) => Math.round(100 / (x * 1.02)) / 100)),
  livre('pinnacle', e, ...p.map((x) => Math.round(100 / (x * 1.03)) / 100)), livre('unibet_eu', e, ...p.map((x) => Math.round(100 / (x * 1.06)) / 100))];
const ODDS = {
  soccer_epl: () => EVENTS.soccer_epl.map((e) => avec(e, trois(e, [0.5, 0.27, 0.23]))),
  soccer_spain_la_liga: () => EVENTS.soccer_spain_la_liga.map((e) => avec(e, trois(e, [0.7, 0.18, 0.12]))),
  [UEL]: () => EVENTS[UEL].map((e) => avec(e, trois(e, [0.45, 0.28, 0.27]))),
  [FA]: () => EVENTS[FA].map((e) => avec(e, trois(e, [0.55, 0.25, 0.20]))),
  [DFB]: () => EVENTS[DFB].map((e) => avec(e, trois(e, [0.8, 0.13, 0.07]))),
};
/* ESPN : les noms qu'il donne, le meme jour (le Copenhague a son nom danois) */
const espnEv = (id, dom, ext, quand) => ({ id, date: new Date(quand).toISOString().slice(0, 16) + 'Z',
  status: { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } },
  competitions: [{ competitors: [{ homeAway: 'home', score: '0', team: { displayName: dom } }, { homeAway: 'away', score: '0', team: { displayName: ext } }] }] });
const ESPN = {
  'soccer/uefa.europa': [espnEv('x1', 'F.C. København', 'Ajax Amsterdam', T0 + 30 * H), espnEv('x2', 'Real Betis', 'Lyon', T0 + 60 * H),
                         espnEv('x3', 'Celtic', 'AS Roma', T0 + 40 * MIN)],
  'soccer/eng.fa': [espnEv('y1', 'Arsenal', 'Everton', T0 + 31 * H)],
};
let ESPN_PANNE = false;
const appels = [], espnUrls = [];
let utilise = 0;
const entetes = (h) => ({ get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) });
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (/espn\.com$/.test(u.hostname)) {
    espnUrls.push(String(url));
    if (ESPN_PANNE) return { ok: false, status: 503, json: async () => ({}) };
    const ch = /sports\/(.+?)\/scoreboard/.exec(u.pathname)[1];
    const q = u.searchParams.get('dates') || '';
    const evs = (ESPN[ch] || []).filter((x) => (q.length === 8 ? x.date.slice(0, 10).replace(/-/g, '') === q : x.date.slice(0, 7).replace('-', '') === q));
    return { ok: true, status: 200, json: async () => ({ events: JSON.parse(JSON.stringify(evs)) }) };
  }
  const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
  const ligue = m && m[1], quoi = m ? m[2] : 'sports';
  const marches = u.searchParams.get('markets') || '';
  /* « cost = [number of markets specified] x [number of regions specified] » */
  const cout = quoi === 'odds' ? marches.split(',').length * (u.searchParams.get('regions') || '').split(',').length : 0;
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
const AS = require('./alerte_solde');
AS.oddsEvenement = () => true;

const prixLigues = require('./prix_ligues');
const pm = require('./prix_marche');
const paris = require('./paris');
const espn = require('./scores_espn');
const coupes = require('./coupes');
const imp = require('./paris_import');
const ap = require('./outils/age_prix');

const FCAT = path.join(BAC, 'paris_catalogue.json'), FQ = path.join(BAC, 'odds_quota.json');
const lisCat = () => JSON.parse(fs.readFileSync(FCAT, 'utf8')).matchs;
const deCoupe = (l) => l.filter((m) => m.source && prixLigues.estCoupe(m.source.ligue));
const coupeAppels = (a, quoi) => a.filter((x) => prixLigues.estCoupe(x.ligue) && (!quoi || x.quoi === quoi));
const jour = () => new Date().toISOString().slice(0, 10);
const classes = () => { try { return JSON.parse(fs.readFileSync(path.join(BAC, 'odds_classes.json'), 'utf8')).jours[jour()] || {}; } catch (e) { return {}; } };
const cls = (k, champ) => Number(((classes()[k]) || {})[champ]) || 0;
const poseDepense = (d) => { const q = JSON.parse(fs.readFileSync(FQ, 'utf8')); q.depenseDuJour = d; q.jour = jour(); fs.writeFileSync(FQ, JSON.stringify(q)); };
const dateLigue = (cle, t) => { const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')); c.ligues[cle] = t; fs.writeFileSync(pm.fichier(), JSON.stringify(c)); };
const pose = (o) => { for (const k of ['PARIS_COUPES', 'PARIS_COUPES_OBSERVE', 'PARIS_COUPES_OBSERVE_H']) delete process.env[k]; Object.assign(process.env, o || {}); };
const capte = async (f) => { const l = [], vrai = console.log; console.log = (...a) => { l.push(a.join(' ')); }; try { await f(); } finally { console.log = vrai; } return l; };

(async () => {
  console.log('\n-- 1. rien par defaut : aucune coupe, aucun appel, la reference figee du socle octet pour octet --');
  {
    pose();
    eq(prixLigues.coupes().size + prixLigues.coupesObservees().size, 0, 'drapeaux vides : aucune coupe vendue ni observee');
    ok(!imp.LIGUES_DEFAUT.some((x) => prixLigues.estCoupe(String(x).split('=')[1])) && !prixLigues.LIGUES_DEFAUT.some(prixLigues.estCoupe),
       'aucune coupe dans les listes par defaut (ODDS_API_LIGUES non posee en production, PARIS_PRIX_LIGUES)');
    eq(prixLigues.observeCoupesMs(), 0, 'fenetre payante fermee (0 h)');
    const l = await imp.liguesEnService();
    ok(!l.some((x) => prixLigues.estCoupe(x.clef)), 'aucune coupe en service : ' + l.map((x) => x.clef).join(','));
    appels.length = 0;
    await imp.rafraichitPrix(['soccer_epl', 'soccer_spain_la_liga'], 'essai');
    await imp.importeMatchs();
    eq(coupeAppels(appels).length, 0, 'ni /events ni /odds de coupe');
    eq(deCoupe(lisCat()).length, 0, 'aucune rencontre de coupe au catalogue');
    ok(/coupes : vendues 0, observees 0, rien \(0 credit\)/.test(coupes.ligneDemarrage()), 'la ligne du demarrage le dit : ' + coupes.ligneDemarrage());
    eq(prixLigues.clesIgnorees().length, 0, 'rien d ignore');
    /* la reference figee : produite par le code de main d'AVANT le socle
       (essais/reference/fabrique.js) — pas une seconde execution du code juge */
    const REF = path.join(__dirname, 'essais', 'reference'), SORTIE = fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-ref-'));
    execFileSync(process.execPath, [path.join(REF, 'fabrique.js'), __dirname, SORTIE], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const f of ['appels.json', 'odds_quota.json', 'paris_catalogue.json', 'paris_prix.json'])
      ok(fs.readFileSync(path.join(SORTIE, f), 'utf8') === fs.readFileSync(path.join(REF, 'attendu', f), 'utf8'), `essais/reference/attendu/${f} : identique octet pour octet`);
    ok(!/soccer_(uefa_europa|fa_cup|england_efl|germany_dfb|spain_copa|italy_coppa|france_coupe)/.test(fs.readFileSync(path.join(SORTIE, 'appels.json'), 'utf8')), 'et aucune coupe dans ses appels');
    /* aucune minuterie de plus sans coupe suivie */
    const p0 = imp.planifie(() => {}, () => false, () => 0);
    const n0 = p0.minuteries.length; p0.arrete();
    pose({ PARIS_COUPES_OBSERVE: UEL });
    const lignes = await capte(async () => { const p1 = imp.planifie(() => {}, () => false, () => 0); ok(p1.minuteries.length === n0 + 1, `une coupe suivie : UNE minuterie de plus, l appariement ESPN (${n0} -> ${p1.minuteries.length})`); p1.arrete(); });
    ok(lignes.some((x) => /\[odds\] coupes : vendues 0, observees 1 \(soccer_uefa_europa_league\), inventaire seul \(0 credit\)/.test(x)), 'et le demarrage le dit');
    pose();
  }

  console.log('\n-- 2. l inventaire : 0 credit, rien au catalogue, ESPN dit ce qui ne s apparie pas --');
  {
    const catA = fs.readFileSync(FCAT, 'utf8'), prixA = fs.readFileSync(pm.fichier(), 'utf8');
    pose({ PARIS_COUPES_OBSERVE: HUIT.join(';') });
    eq(prixLigues.coupesObservees().size, 8, 'les huit coupes observees (separateur ;)');
    appels.length = 0;
    const u0 = utilise;
    await imp.importeMatchs();
    eq(coupeAppels(appels, 'events').length, 8, 'un /events par coupe');
    eq(coupeAppels(appels, 'odds').length, 0, 'aucun /odds de coupe (fenetre a 0)');
    eq(utilise - u0, 0, 'l inventaire coute 0 credit (doc : /events ne compte pas)');
    ok(fs.readFileSync(FCAT, 'utf8') === catA, 'catalogue IDENTIQUE octet pour octet a l import sans coupe');
    ok(fs.readFileSync(pm.fichier(), 'utf8') === prixA, 'carnet des prix identique octet pour octet');
    paris.charge();
    eq(deCoupe(paris.catalogue().matchs).length + deCoupe(paris.ouverts()).length, 0, 'aucune rencontre de coupe au catalogue ni ouverte');
    const inv = coupes.lisInventaire();
    eq(Object.keys(inv.coupes[UEL].ev).sort().join(','), 'u1,u2,u3,u4', 'l inventaire garde les quatre rencontres de l Europa League');
    eq(J(imp.etatImport().dernier.matchs.parLigue[UEL]), J({ vues: 4, retenues: 0, observees: 4 }), 'le compte de l import le dit : vues, retenues 0, observees');
    eq(J([...coupes.aVenir(T0, 48 * H)].sort()), J([UEL, FA].sort()), 'a 48 h : l Europa League et la FA Cup (la DFB a 60 h)');
    /* une rencontre que la derniere reponse /events ne rend plus ne declenche rien */
    const fa = EVENTS[FA];
    EVENTS[FA] = [ev('f2', 'Chelsea', 'Fulham', T0 + 70 * H)];
    await imp.importeMatchs();
    ok(!coupes.aVenir(T0, 48 * H).has(FA), 'f1 absente de la derniere reponse /events : la FA Cup n a plus rien a 48 h');
    ok(coupes.lisInventaire().coupes[FA].ev.f1, 'mais f1 reste a l inventaire (elle peut se jouer : 60 jours de garde)');
    EVENTS[FA] = fa;
    await imp.importeMatchs();
    /* la fenetre a 0 : meme appelee a la main, une coupe ne coute rien */
    appels.length = 0;
    await imp.rafraichitPrix([UEL], 'a la main');
    eq(coupeAppels(appels).length, 0, 'rafraichitPrix([coupe]) avec la fenetre a 0 : aucun appel, 0 credit');
    eq(imp.prixPerimes().filter((c) => prixLigues.estCoupe(c)).length, 0, 'prixPerimes ne liste aucune coupe');
    eq(imp.causesAvantMatch(() => false, Date.now()).length, 0, 'ni releve forcee (u3 est a 40 min)');
    /* l'appariement ESPN, par espn.releve */
    espnUrls.length = 0;
    const r = await coupes.apparieEspn({ maintenant: T0 });
    eq(r[UEL].lues, 3, 'Europa League : trois rencontres dans [-3 j ; +7 j] (u4 a J+8 n y est pas)');
    eq(r[UEL].appariees, 2, 'deux appariees : Betis–Lyon a l identique, Celtic–Roma par la normalisation (« AS » est un mot de bruit), sans rien deviner');
    const na = r[UEL].nonAppariees;
    eq(na.length, 1, 'une non appariee');
    ok(na[0] && na[0].affiche === 'FC Copenhagen v Ajax' && na[0].espnMemeJour.includes('F.C. København'), 'FC Copenhagen v Ajax, avec « F.C. København » dans les noms ESPN du meme jour : ' + J(na[0]));
    ok(!espn.meme('FC Copenhagen', 'F.C. København'), 'et aucun rapprochement flou ne l a apparie');
    eq(r[FA].appariees, 1, 'FA Cup : Arsenal v Everton appariee');
    const inv2 = coupes.lisInventaire();
    ok(inv2.coupes[UEL].ev.u1.espn && inv2.coupes[UEL].ev.u1.espn.ok === false && inv2.coupes[UEL].ev.u2.espn.ok === true, 'l inventaire garde le resultat : u1 non, u2 oui');
    ok(espnUrls.every((u) => !/dates=\d{8}-\d{8}/.test(u)), 'jamais une fenetre de dates (refusee par ESPN)');
    eq(espnUrls.length, new Set(espnUrls).size, `chaque URL ESPN n est lue qu une fois par passe (${espnUrls.length})`);
    /* l'etat : non appariees, sans drapeau, doublons */
    const e = imp.etatImport().coupes;
    ok(e && e.observees.length === 8 && e.fenetreH === 0, 'etatImport().coupes : huit observees, fenetre 0');
    ok(e.parCoupe[UEL].espn.nonAppariees.length === 1 && e.parCoupe[UEL].sansDrapeau.includes('FC Copenhagen'), 'non appariees et noms sans drapeau (Europa League, aucun pays de ligue) : ' + J(e.parCoupe[UEL].sansDrapeau));
    ok(!e.parCoupe[FA].sansDrapeau.length, 'la FA Cup prend le drapeau de son pays');
    /* relecture du 11/10 : un nom absent de paris_pays.json prend le pays de la
       coupe EN SILENCE (repli PAYS_LIGUE) — un club gallois en FA Cup aurait le
       drapeau anglais. La seconde liste le montre ; Arsenal est dans
       paris_pays.json, Everton non. */
    eq(J(e.parCoupe[FA].drapeauParLaLigue), J(['Everton']), 'FA Cup : le nom absent de paris_pays.json est liste (drapeau tenu de la ligue seule)');
    eq(J(e.parCoupe[UEL].drapeauParLaLigue), '[]', 'Europa League : rien par la ligue (pas de pays de ligue), tout est dans sansDrapeau');
    ok(e.doublons.length === 1 && e.doublons[0].coupe === FA && e.doublons[0].championnat === 'soccer_epl', 'le doublon Arsenal v Everton (FA Cup et Premier League, 1 h d ecart) est signale : ' + J(e.doublons));
    const li = coupes.lignesInventaire(T0, { matchs: paris.catalogue().matchs });
    ok(li.some((x) => /coupe inventaire soccer_uefa_europa_league : 3 a venir \(7 j\), 2 sous 48 h, ESPN : 1 non appariee\(s\) : « FC Copenhagen v Ajax »/.test(x)), 'la ligne d inventaire : ' + li[0]);
    ok(li.some((x) => /coupe DOUBLON soccer_fa_cup « Arsenal v Everton » aussi sous soccer_epl/.test(x)), 'et la ligne du doublon');
    /* ESPN en panne : rien ne leve, rien ne se conclut */
    ESPN_PANNE = true;
    let leve = null;
    const r2 = await coupes.apparieEspn({ maintenant: T0 }).catch((x) => { leve = x; });
    ESPN_PANNE = false;
    ok(!leve && r2[UEL].panne && /en panne/.test(r2[UEL].panne), 'ESPN en panne : aucune exception, et c est dit');
    const inv3 = coupes.lisInventaire();
    ok(inv3.coupes[UEL].ev.u2.espn.ok === true, 'un appariement vu ne redescend pas sur une panne');
    ok(inv3.coupes[UEL].ev.u1.espn.ok === false, 'une non appariee reste ce qu elle etait');
    const inv4 = JSON.parse(JSON.stringify(inv3)); inv4.coupes[UEL].ev.u3.espn = null; fs.writeFileSync(coupes.fichierInventaire(), JSON.stringify(inv4));
    ESPN_PANNE = true; await coupes.apparieEspn({ maintenant: T0 }); ESPN_PANNE = false;
    eq(coupes.lisInventaire().coupes[UEL].ev.u3.espn, null, 'une rencontre jamais lue reste sans conclusion sur une panne (et ne compte pas pour A)');
    eq(coupes.lisInventaire().coupes[UEL].nonAppariees.length, 1, 'la liste des non appariees d avant n est pas remplacee par celle d une panne');
    await coupes.apparieEspn({ maintenant: T0 });
  }

  console.log('\n-- 3. l observation payante : 48 h, classe 3 jamais prioritaire, releve forcee T-45 en classe 2 --');
  {
    pose({ PARIS_COUPES_OBSERVE: [UEL, FA, DFB].join(','), PARIS_COUPES_OBSERVE_H: '48' });
    await imp.importeMatchs();
    eq(prixLigues.observeCoupesH(), 48, 'fenetre de 48 h');
    const t = Date.now();
    /* la Premier League PERIMEE elle aussi : sans elle, l'ordre ne se juge pas
       (relecture du 11/10 : l'ancienne assertion passait par `|| !per.includes`) */
    const dEpl = pm.derniere('soccer_epl');
    dateLigue('soccer_epl', 1);
    const per = imp.prixPerimes(t);
    dateLigue('soccer_epl', dEpl);
    ok(per.includes(UEL) && per.includes(FA), 'prixPerimes : l Europa League (30 h) et la FA Cup (31 h) — ' + per.join(','));
    ok(!per.includes(DFB), 'pas la DFB-Pokal : sa seule rencontre est a 60 h');
    ok(per.includes('soccer_epl') && per.indexOf(UEL) > per.indexOf('soccer_epl') && per.indexOf(FA) > per.indexOf('soccer_epl'),
       'les coupes APRES les championnats vendus, la Premier League perimee : ' + per.join(','));
    const k3 = cls(3, 'appels'), k0 = cls(0, 'appels');
    appels.length = 0;
    const u0 = utilise;
    const vendues = await imp.rafraichitPrix([UEL, FA], 'periodique', pm.releveMs());
    eq(coupeAppels(appels, 'odds').length, 2, 'deux /odds de coupe');
    eq(utilise - u0, 2, '1 credit chacune (h2h x eu)');
    eq(cls(3, 'appels') - k3, 2, 'comptees en classe 3');
    eq(cls(0, 'appels') - k0, 0, 'jamais en classe 0');
    eq(vendues, 0, 'aucune ne compte comme vendue : le calendrier ne se refait pas pour elles');
    eq(imp.prixPerimes(Date.now()).filter((c) => prixLigues.estCoupe(c)).length, 0, 'tout de suite apres : rien a refaire (jamais deux releves a moins de 2 h)');
    ok(imp.prixPerimes(Date.now() + 2 * H + MIN).includes(UEL), '2 h plus tard : l Europa League se releve');
    /* le suivi d'avant-match, par le crochet apresNote (apres le carnet) */
    const s = coupes.lisSuivi().coupes[UEL];
    ok(s && s.u1 && s.u1.ref === 'betfair' && s.u1.n48 === 1 && s.u1.apresT60 === false, 'le suivi : u1 au prix de Betfair, 1 releve dans les 48 h, aucun apres T-60');
    ok(s.u4 && s.u4.n48 === 0, 'u4 (J+8) au suivi, mais aucun releve dans ses 48 h');
    /* le journal des releves garde la ligne, observee */
    const lj = (await require('./prix_journal').lisJournal()).lignes.filter((x) => x.l === UEL);
    ok(lj.length === 1 && lj[0].o === 1 && lj[0].q === 'periodique', 'le journal des releves garde la ligne de la coupe, marquee observee');
    /* jamais prioritaire : le jour pris, la coupe est refusee, un championnat vendu passe */
    const q = imp.etatQuota(), part = imp.partDuJour(q.reste);
    poseDepense(part - 1);
    const r3 = cls(3, 'refus');
    appels.length = 0;
    await imp.rafraichitPrix(['soccer_epl', UEL], 'jour pris', 0);
    ok(appels.some((a) => a.ligue === 'soccer_epl' && a.quoi === 'odds'), 'le jour pris : la Premier League (vendue, prioritaire) passe');
    eq(coupeAppels(appels, 'odds').length, 0, 'l Europa League est refusee (classe 3, reserve de 160)');
    eq(cls(3, 'refus') - r3, 1, 'et le refus se compte en classe 3');
    poseDepense(0);
    /* la releve forcee T-45/T-20 : u3 a 40 min, dernier releve avant T-60 */
    const u3 = EVENTS[UEL][2], debut3 = Date.parse(u3.commence_time);
    dateLigue(UEL, debut3 - 2 * H);
    const f = coupes.forcees(Date.now());
    ok(f.length === 1 && f[0].cle === UEL && f[0].ageMin > 14 * MIN && f[0].ageMin < 41 * MIN, 'forcees : l Europa League, age minimal entre 15 et 40 min — ' + J(f));
    const causes = imp.causesAvantMatch(() => false, Date.now());
    const cf = causes.find((x) => x.quoi === 'coupe T-45');
    ok(cf && cf.classe === 2 && J(cf.clefs) === J([UEL]), 'causesAvantMatch : la cause « coupe T-45 », classe 2');
    const k2 = cls(2, 'appels');
    appels.length = 0;
    await imp.rafraichitPrix(cf.clefs, cf.quoi, cf.ageMin, { classe: cf.classe });
    eq(coupeAppels(appels, 'odds').length, 1, 'la releve forcee part : 1 credit');
    eq(cls(2, 'appels') - k2, 1, 'en classe 2');
    eq(coupes.forcees(Date.now()).length, 0, 'et ne repart pas au tic suivant (releve posterieur a T-60)');
    ok(coupes.lisSuivi().coupes[UEL].u3.apresT60 === true, 'le suivi le dit : u3 a un releve apres T-60');
    appels.length = 0;
    await imp.rafraichitPrix(cf.clefs, cf.quoi, cf.ageMin, { classe: cf.classe });
    eq(coupeAppels(appels).length, 0, 'la meme cause rejouee : sautee (son age minimal), jamais deux credits pour un creneau');
    /* fenetre fermee : plus rien */
    dateLigue(UEL, debut3 - 2 * H);
    pose({ PARIS_COUPES_OBSERVE: [UEL, FA, DFB].join(','), PARIS_COUPES_OBSERVE_H: '0' });
    eq(coupes.forcees(Date.now()).length + imp.prixPerimes(Date.now() + 3 * H).filter((c) => prixLigues.estCoupe(c)).length, 0, 'fenetre remise a 0 : ni forcee, ni periodique');
    pose({ PARIS_COUPES_OBSERVE: [UEL, FA, DFB].join(','), PARIS_COUPES_OBSERVE_H: '48' });
    dateLigue(UEL, Date.now());
  }

  console.log('\n-- 4. une coupe observee n entre jamais au catalogue ; deja la, elle est suspendue --');
  {
    ok(pm.pour('u1'), 'le carnet a un prix frais pour u1 (observation)');
    await imp.importeMatchs();
    eq(deCoupe(lisCat()).length, 0, 'au prix frais : toujours aucune rencontre de coupe au catalogue');
    const m = { id: 'uefaeuropale-x', sport: 'foot', domicile: 'FC Copenhagen', exterieur: 'Ajax', debut: EVENTS[UEL][0].commence_time, source: { fournisseur: 'the-odds-api', ligue: UEL, evenement: 'u1' } };
    ok(!imp.avecPrix(m).prixMarche, 'avecPrix ne lui pose aucun prix (elle n est pas vendue)');
    /* une rencontre de coupe ecrite a la main dans le catalogue (cote Elo) */
    const cat = JSON.parse(fs.readFileSync(FCAT, 'utf8'));
    const modele = cat.matchs.find((x) => x.source && x.source.evenement === 'e1');
    const main = Object.assign(JSON.parse(J(modele)), { id: 'uefaeuropale-20261012-fcc-aja', competition: 'Europa League', domicile: 'FC Copenhagen', exterieur: 'Ajax',
      debut: EVENTS[UEL][0].commence_time, source: { fournisseur: 'the-odds-api', ligue: UEL, evenement: 'u1' } });
    delete main.prixMarche; delete main.suspendu; delete main.suspenduRaison; main.cotesGenerees = true;
    cat.matchs.push(main);
    fs.writeFileSync(FCAT, JSON.stringify(cat));
    paris.charge();
    ok(paris.ouvert(paris.match(main.id)), 'avant l import, ecrite a la main : ouverte (la porte de paris.ouvert est le lot 10)');
    await imp.importeMatchs();
    paris.charge();
    const apres = lisCat().find((x) => x.id === main.id);
    ok(apres && apres.suspendu === true && /coupe non vendue/.test(apres.suspenduRaison || ''), 'apres l import : gardee (ses paris restent reglables) mais SUSPENDUE — ' + (apres && apres.suspenduRaison));
    ok(!paris.ouvert(paris.match(main.id)), 'donc fermee aux paris');
    const c2 = JSON.parse(fs.readFileSync(FCAT, 'utf8')); c2.matchs = c2.matchs.filter((x) => x.id !== main.id); fs.writeFileSync(FCAT, JSON.stringify(c2)); paris.charge();
  }

  console.log('\n-- 5. PARIS_COUPES (la vente) est lue, dite, et ignoree --');
  {
    pose({ PARIS_COUPES: FA, PARIS_COUPES_OBSERVE: FA, PARIS_COUPES_OBSERVE_H: '48' });
    eq(prixLigues.VENTE_COUPES_CONSTRUITE, false, 'la vente des coupes n est pas construite (lot 10)');
    eq(prixLigues.coupes().size, 0, 'coupes() vide');
    ok(!prixLigues.ligues().has(FA) && !prixLigues.vendue(FA) && !pm.aRelever().has(FA), 'la FA Cup n est ni vendue, ni dans ligues(), ni dans aRelever()');
    ok(prixLigues.coupesObservees().has(FA), 'elle reste observee');
    ok(prixLigues.clesIgnorees().some((x) => /PARIS_COUPES soccer_fa_cup \(vente des coupes pas construite/.test(x)), 'et c est dit : ' + prixLigues.clesIgnorees().join(' ; '));
    ok(/PARIS_COUPES ignoree : vente pas construite, lot 10/.test(coupes.ligneDemarrage()), 'au demarrage aussi');
    await imp.importeMatchs();
    eq(deCoupe(lisCat()).length, 0, 'aucune rencontre de FA Cup au catalogue');
    const k0 = cls(0, 'appels'), k3 = cls(3, 'appels');
    dateLigue(FA, 0);
    appels.length = 0;
    await imp.rafraichitPrix([FA], 'essai');
    ok(coupeAppels(appels, 'odds').length === 1 && cls(0, 'appels') === k0 && cls(3, 'appels') - k3 === 1, 'sa releve reste en classe 3, jamais en classe 0');
    eq(J(imp.etatImport().coupes.vendues), '[]', 'etatImport().coupes.vendues : []');
    pose({ PARIS_COUPES_OBSERVE: [UEL, FA, DFB].join(','), PARIS_COUPES_OBSERVE_H: '48' });
  }

  console.log('\n-- 6. les cles se disent ; la fenetre echoue fermee --');
  {
    const avant = process.env.PARIS_PRIX_LIGUES;
    const brut = prixLigues.ligues();
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl;soccer_uefa_europa_league soccer_spain_la_liga';
    eq(J([...prixLigues.ligues()]), J(['soccer_epl', 'soccer_spain_la_liga']), 'une coupe posee dans PARIS_PRIX_LIGUES en est retiree (separateurs ; et espace)');
    ok(!prixLigues.vendue(UEL), 'et elle n est pas vendue');
    ok(prixLigues.clesIgnorees().some((x) => /PARIS_PRIX_LIGUES soccer_uefa_europa_league/.test(x)), 'et c est dit');
    process.env.PARIS_PRIX_LIGUES = avant;
    ok(prixLigues.ligues() === brut, 'sans coupe dans la liste, ligues() rend le MEME ensemble qu avant ce lot');
    process.env.PARIS_PRIX_OBSERVE = 'soccer_fa_cup,icehockey_nhl';
    eq(J([...prixLigues.observees()]), J(['icehockey_nhl']), 'PARIS_PRIX_OBSERVE privee des coupes');
    delete process.env.PARIS_PRIX_OBSERVE;
    pose({ PARIS_COUPES_OBSERVE: 'soccer_xyz_cup,' + UEL });
    eq(J([...prixLigues.coupesObservees()]), J([UEL]), 'une cle hors des huit n est jamais observee');
    ok(prixLigues.clesIgnorees().some((x) => /PARIS_COUPES_OBSERVE soccer_xyz_cup \(hors des huit coupes/.test(x)), 'et c est dit');
    /* la liste fermee vaut aussi pour la vente : au lot 10, une cle hors des
       huit serait vendue comme une coupe */
    pose({ PARIS_COUPES: 'soccer_xyz_cup,' + FA });
    eq(J([...prixLigues.coupesDemandees()]), J([FA]), 'PARIS_COUPES : une cle hors des huit n est jamais demandee a la vente');
    ok(prixLigues.clesIgnorees().some((x) => /PARIS_COUPES soccer_xyz_cup \(hors des huit coupes/.test(x)), 'et c est dit');
    for (const [v, h] of [[undefined, 0], ['', 0], ['abc', 0], ['-5', 0], ['0', 0], ['0.5', 0.5], ['48', 48], ['168', 168], ['500', 168], ['Infinity', 0], ['1e400', 0]]) {
      pose({ PARIS_COUPES_OBSERVE: UEL, PARIS_COUPES_OBSERVE_H: v });
      if (v === undefined) delete process.env.PARIS_COUPES_OBSERVE_H;
      eq(prixLigues.observeCoupesH(), h, `PARIS_COUPES_OBSERVE_H=${J(v)} -> ${h} h`);
    }
    const planLignes = await capte(async () => { pose({ PARIS_COUPES_OBSERVE: 'soccer_xyz_cup' }); const p = imp.planifie(() => {}, () => false, () => 0); p.arrete(); });
    ok(planLignes.some((x) => /\[odds\] coupes IGNORE\(S\) : PARIS_COUPES_OBSERVE soccer_xyz_cup/.test(x)), 'le demarrage dit la cle ignoree');
    pose({ PARIS_COUPES_OBSERVE: [UEL, FA, DFB].join(','), PARIS_COUPES_OBSERVE_H: '48' });
  }

  console.log('\n-- 7. l etalonnage ne paie et ne touche jamais une coupe --');
  {
    dateLigue('soccer_epl', 1); dateLigue('soccer_spain_la_liga', 1);
    appels.length = 0;
    await imp.calibre();
    ok(appels.some((a) => a.quoi === 'odds' && !prixLigues.estCoupe(a.ligue)), 'l etalonnage releve les championnats');
    eq(coupeAppels(appels, 'odds').length, 0, 'aucun /odds de coupe (les coupes observees sont pourtant en service)');
    ok(J(imp.etatImport().dernier.calibre.ligues).indexOf('soccer_') >= 0 && !imp.etatImport().dernier.calibre.ligues.some((x) => prixLigues.estCoupe(x)), 'aucune coupe dans ses ligues');
    let leve = null;
    await imp.calibre(UEL).catch((x) => { leve = x; });
    ok(leve && /une coupe ne s etalonne pas/.test(leve.message), 'calibre(coupe) leve : ' + (leve && leve.message));
  }

  console.log('\n-- 8. la prolongation : les huit coupes a la main au-dela de 90 min --');
  {
    for (const c of HUIT) ok(imp.prolongationPossible({ source: { ligue: c } }), 'prolongation possible : ' + c);
    ok(!imp.prolongationPossible({ source: { ligue: 'soccer_epl' } }) && !imp.prolongationPossible({ source: { ligue: 'soccer_spain_la_liga' } }), 'pas en championnat');
    ok(imp.prolongationPossible({ source: { ligue: 'soccer_uefa_champs_league' } }) && imp.prolongationPossible({ source: { ligue: 'soccer_usa_mls' } }), 'la C1 et la MLS comme avant');
    for (const c of HUIT.concat(['soccer_epl', 'soccer_uefa_champs_league', 'soccer_usa_mls', 'soccer_scotland_cup']))
      if (imp.prolongationPossible({ source: { ligue: c } }) !== prixLigues.prolongationPossibleLigue(c)) ok(false, 'delegation divergente : ' + c);
    ok(true, 'paris_import.prolongationPossible delegue a prix_ligues.prolongationPossibleLigue');
  }

  console.log('\n-- 9. noms, pays, identifiants --');
  {
    eq(imp.NOM_COMPET(FA), 'FA Cup', 'NOM_COMPET(fa_cup)');
    eq(imp.NOM_COMPET(UECL), 'Conference League', 'NOM_COMPET(conference)');
    eq(imp.NOM_PAYS[imp.PAYS_LIGUE[FA]], 'England', 'FA Cup : England');
    eq(imp.NOM_PAYS[imp.PAYS_LIGUE[UEL]] || '', '', 'Europa League : aucun pays (les clubs melangent les pays)');
    eq(imp.paysDe('Bayern Munich', DFB), 'DE', 'DFB-Pokal : drapeau allemand par la ligue');
    const id1 = imp.identifiant({ clef: FA }, EVENTS[FA][0]), id2 = imp.identifiant({ clef: 'soccer_epl' }, EVENTS.soccer_epl[0]);
    ok(id1.startsWith('facup-') && id2.startsWith('epl-') && id1 !== id2, `la meme affiche, deux identifiants distincts : ${id1} / ${id2}`);
  }

  console.log('\n-- 10. le suivi d avant-match, hors de note() --');
  {
    const L = 'soccer_italy_coppa_italia', D = T0 + 5 * H;
    coupes.noteSuivi({ ligue: L, t: D - 3 * H, refs: [{ id: 'c1', debut: D, ref: 'betfair', livres: 4 }, { id: 'c2', debut: D, ref: null }, { id: 'c3', debut: D, ref: 'pinnacle' }] });
    /* le meme /odds rend la rencontre EN COURS (« upcoming and live games ») */
    coupes.noteSuivi({ ligue: L, t: D + 10 * MIN, refs: [{ id: 'c1', debut: D, ref: 'mediane' }] });
    const s = coupes.lisSuivi().coupes[L];
    ok(s.c1.ref === 'betfair' && s.c1.t === D - 3 * H, 'un releve apres le coup d envoi n ecrase jamais le dernier prix d avant-match');
    eq(s.c2.ref, 'aucun', 'une rencontre sans reference : « aucun », comptee');
    eq(s.c3.ref, 'pinnacle', 'c3 au prix de Pinnacle');
    /* c2 reste dans la reponse, toujours sans reference : elle demeure
       « aucun » (relecture du 11/10 : elle passait a « retire », et l'essai de
       C ne jugeait plus « aucun ») */
    coupes.noteSuivi({ ligue: L, t: D - 50 * MIN, refs: [{ id: 'c1', debut: D, ref: 'betfair' }, { id: 'c2', debut: D, ref: null }] });
    const s2 = coupes.lisSuivi().coupes[L];
    ok(s2.c3.ref === 'retire' && s2.c1.apresT60 === true && s2.c1.n48 === 2, 'absente d une reponse non vide : « retire » ; c1 releve apres T-60, 2 releves dans les 48 h');
    eq(s2.c2.ref, 'aucun', 'c2, presente sans reference : toujours « aucun »');
    eq(coupes.noteSuivi({ ligue: 'soccer_epl', t: D, refs: [{ id: 'z', debut: D + H, ref: 'betfair' }] }), false, 'un championnat n entre jamais au suivi');
    const m = coupes.mesure(L, D + 3 * H);
    eq(J([m.E, m.C, m.A]), J([3, 1, 0]), 'mesure : E 3, C 1 (c1 betfair ; c2 « aucun » et c3 « retire » ne couvrent pas), A 0');
    /* une lecture refusee (EISDIR, pas ENOENT) : rien n'est ecrit */
    const f = coupes.fichierSuivi(), garde = fs.readFileSync(f, 'utf8');
    fs.renameSync(f, f + '.garde'); fs.mkdirSync(f);
    eq(coupes.noteSuivi({ ligue: L, t: D - 20 * MIN, refs: [{ id: 'c9', debut: D, ref: 'betfair' }] }), false, 'lecture refusee : la note rend faux');
    ok(fs.statSync(f).isDirectory() && !fs.readdirSync(BAC).some((x) => /coupes_suivi\.json\.\d+\.tmp/.test(x)), 'et rien n est ecrit par-dessus');
    fs.rmdirSync(f); fs.renameSync(f + '.garde', f);
    ok(fs.readFileSync(f, 'utf8') === garde, 'le suivi est intact');
    /* un contenu qui ne se decode pas : mis de cote, jamais ecrase */
    fs.writeFileSync(f, '{"v":1,"coupes":{"coupe');
    coupes.noteSuivi({ ligue: L, t: D - 20 * MIN, refs: [{ id: 'c9', debut: D, ref: 'betfair' }] });
    ok(fs.readdirSync(BAC).some((x) => x.startsWith('coupes_suivi.json.illisible-')), 'le fichier illisible est mis de cote (.illisible-<t>)');
    ok(coupes.lisSuivi().coupes[L].c9.ref === 'betfair', 'et le suivi repart');
    fs.writeFileSync(f, garde);
  }

  console.log('\n-- 11. la porte : chaque seuil au-dessus et en dessous, jamais ouverte par le serveur seul --');
  {
    const P = coupes.PORTE;
    eq(coupes.N_MIN_D, 189, 'sans rencontre battable, la borne de Wilson passe sous 2 % a 189 rencontres');
    ok(coupes.wilsonHaut(0, 189) < 0.02 && coupes.wilsonHaut(0, 188) >= 0.02, 'wilsonHaut(0, 189) < 2 % <= wilsonHaut(0, 188)');
    const dTient = () => { const d = {}; for (const tr of P.tranches) { d[tr] = {}; for (const mk of P.marches) d[tr][mk] = { n: 189, k: 0, nRef: 30, kRef: 0 }; } return d; };
    const apres = Date.parse('2026-11-07T12:00Z'), avant = Date.parse('2026-11-05T12:00Z');
    const v = (m, d, t, cle) => coupes.porte(cle || UEL, m, d, t);
    eq(v({ E: 8, C: 8, A: 8 }, dTient(), apres).verdict, 'OUVERTE', 'E 8, C 8/8, A 8/8, D tenu, apres le 06/11 : OUVERTE');
    eq(v({ E: 8, C: 8, A: 8 }, null, apres).verdict, 'pas encore', 'sans D (le serveur) : pas encore');
    ok(/D \(mesuree hors serveur/.test(v({ E: 8, C: 8, A: 8 }, null, apres).pourquoi.join(';')), 'et la raison dit ou se mesure D');
    eq(v({ E: 8, C: 8, A: 8 }, dTient(), avant).verdict, 'pas encore', 'avant le 06/11 : pas encore');
    eq(v({ E: 8, C: 8, A: 8 }, dTient(), Date.parse('2026-11-06T00:00Z')).verdict, 'OUVERTE', 'le 06/11 meme : OUVERTE');
    eq(v({ E: 8, C: 8, A: 8 }, dTient(), Date.parse('2026-11-20T00:00Z'), DFB).verdict, 'pas encore', 'une coupe nationale le 20/11 : pas encore (pas avant decembre)');
    eq(v({ E: 8, C: 8, A: 8 }, dTient(), Date.parse('2026-12-01T00:00Z'), DFB).verdict, 'OUVERTE', 'le 01/12 : OUVERTE');
    eq(v({ E: 7, C: 7, A: 7 }, dTient(), apres).verdict, 'pas encore', 'E 7 : pas encore');
    eq(v({ E: 8, C: 7, A: 8 }, dTient(), apres).verdict, 'pas encore', 'C 7/8 (87,5 %) : pas encore');
    eq(v({ E: 10, C: 9, A: 10 }, dTient(), apres).verdict, 'OUVERTE', 'C 9/10 (90 % pile) : tient');
    eq(v({ E: 20, C: 20, A: 19 }, dTient(), apres).verdict, 'OUVERTE', 'A 19/20 (95 % pile) : tient');
    eq(v({ E: 20, C: 20, A: 18 }, dTient(), apres).verdict, 'pas encore', 'A 18/20 (90 %) : pas encore');
    const dAvec = (tr, mk, x) => { const d = dTient(); d[tr][mk] = x; return d; };
    eq(v({ E: 8, C: 8, A: 8 }, dAvec('moins3h', '1n2', { n: 188, k: 0, nRef: 30, kRef: 0 }), apres).verdict, 'pas encore', 'D : 188 rencontres sans battable, pas encore (echantillon)');
    ok(/echantillon/.test(v({ E: 8, C: 8, A: 8 }, dAvec('moins3h', '1n2', { n: 188, k: 0, nRef: 30, kRef: 0 }), apres).criteres.D.cellules['moins3h|1n2'].etat), 'et la cellule dit « echantillon »');
    eq(v({ E: 8, C: 8, A: 8 }, dAvec('apresT60', 'dc', { n: 189, k: 0, nRef: 29, kRef: 0 }), apres).verdict, 'pas encore', 'D : reference de 29 rencontres de championnat, pas encore');
    eq(v({ E: 8, C: 8, A: 8 }, dAvec('de3a48h', 'dc', { n: 10000, k: 105, nRef: 100, kRef: 0 }), apres).verdict, 'pas encore', 'D : 1,05 % contre 0 % + 1 point aux championnats, non');
    eq(v({ E: 8, C: 8, A: 8 }, dAvec('de3a48h', 'dc', { n: 10000, k: 105, nRef: 100, kRef: 1 }), apres).verdict, 'OUVERTE', 'D : 1,05 % contre 1 % + 1 point, tient');
    eq(v({ E: 8, C: 8, A: 8 }, dAvec('moins3h', '1n2', { n: 1000, k: 12, nRef: 1000, kRef: 12 }), apres).verdict, 'pas encore', 'D : 12/1000, borne haute 2,09 % : pas encore, meme egal aux championnats');
    ok(/non : part/.test(v({ E: 8, C: 8, A: 8 }, dAvec('moins3h', '1n2', { n: 1000, k: 30, nRef: 1000, kRef: 30 }), apres).criteres.D.cellules['moins3h|1n2'].etat), 'D : 3 % au-dessus de 2 % : « non »');
    /* le serveur : E, C, A, la porte du jour, jamais OUVERTE */
    const lp = coupes.lignesPorte(apres);
    ok(lp.length === 3 && lp.every((x) => /→ pas encore$/.test(x) && /D hors serveur/.test(x)), 'les lignes de la porte (une par coupe suivie) : ' + lp[0]);
  }

  console.log('\n-- 12. la derive, sur le journal (outils/age_prix.js --coupes) --');
  {
    const D1 = Date.parse('2026-10-22T19:00:00Z'), D0 = Date.parse('2026-10-18T15:00:00Z');
    const L = (t, l, e, o) => Object.assign({ v: 1, m: 'h2h', t, l, q: 'periodique', c: 120, av: 1, am: 2160, n: e.length, s: 'foot', e }, o ? { o: 1 } : {});
    const E = (id, debut, ref, pv) => [id, debut, ref, pv, null, null, null, 4, null, null];
    const P1 = [0.50, 0.26, 0.24], P2 = [0.60, 0.22, 0.18], PF = [0.85, 0.10, 0.05];
    const lignes = [
      /* Europa League, rencontre a : 0,50 -> 0,60 a T-50 min (battable, moins de 3 h ET apres T-60) */
      L(D1 - 2 * H, UEL, [E('a', D1, 'b', P1), E('b', D1, 'b', P1), E('c', D1, 'b', PF), E('d', D1, 'b', P1), E('g', D1, 'b', P1)], true),
      L(D1 - 50 * MIN, UEL, [E('a', D1, 'b', P2), E('b', D1, 'm', P2), E('c', D1, 'b', PF), E('d', D1, 'b', P1)], true),
      /* commencee : jamais une paire ; g relevee 4 h apres : ecart trop grand */
      L(D1 + 5 * MIN, UEL, [E('a', D1, 'b', P1), E('d', D1, 'b', P2)], true),
      L(D1 - 2 * H + 4 * H + MIN, UEL, [], true),
      /* la reference : Premier League le MEME jour (une rencontre, battable) et un autre jour */
      L(D1 - 2 * H, 'soccer_epl', [E('p', D1, 'p', P1), E('q', D0 + 20 * JOUR, 'p', P1)]),
      L(D1 - 50 * MIN, 'soccer_epl', [E('p', D1, 'p', P2)]),
      L(D0 - 2 * H, 'soccer_epl', [E('r', D0, 'p', P1)]),
      L(D0 - 50 * MIN, 'soccer_epl', [E('r', D0, 'p', P2)]),
      /* un sport a deux issues observe : jamais dans la reference */
      L(D1 - 2 * H, 'icehockey_nhl', [E('h', D1, 'p', [0.5, 0.5])], true),
    ];
    lignes[3].e = [E('g', D1, 'b', P2)];
    lignes[3].t = D1 - 2 * H + 3 * H + MIN;    // g : 3 h 01 apres son premier releve (et avant le coup d'envoi)
    lignes[3].e[0][1] = D1 + 5 * H;
    lignes[0].e[4][1] = D1 + 5 * H;
    const r = ap.deriveCoupes(lignes);
    const d = ap.deriveDe(r, [UEL]);
    eq(J([d.moins3h['1n2'].n, d.moins3h['1n2'].k]), J([3, 1]), 'Europa League, moins de 3 h, 1-N-2 : 3 rencontres jugees (a, c, d), 1 battable (a)');
    eq(J([d.apresT60['1n2'].n, d.apresT60['1n2'].k]), J([3, 1]), 'apres T-60 : les memes (releve a T-50 min)');
    ok(ap.cotesVendues(PF).dc && ap.cotesVendues(PF).dc['1X'] > 1, 'c (0,85 / 0,10 / 0,05) : la double chance se cote (1X a ' + (ap.cotesVendues(PF).dc || {})['1X'] + ')');
    eq(d.moins3h.dc.n, 2, 'mais c (1X a 0,95 > 0,93) n est pas comptee : la DC n y serait pas vendue');
    eq(J([d.moins3h['1n2'].nRef, d.moins3h['1n2'].kRef]), J([1, 1]), 'la reference : la Premier League du MEME jour seulement (p ; pas r, un autre jour)');
    ok(r.exclus.refChange === 1 && r.exclus.enJeu >= 2 && r.exclus.ecartTrop >= 1, 'exclus : b (betfair -> mediane), les releves en direct, g (3 h 01) — ' + J(r.exclus));
    ok(!r.cellules.icehockey_nhl, 'un sport observe n entre pas dans la reference');
    const fav = ap.deriveDe(r, [UEL], r.favoris);
    eq(fav.moins3h['1n2'].n, 1, 'les favoris a 75 % et plus, a part : c');
    /* la porte complete, la MEME fonction que le serveur */
    const etatC = { parCoupe: { [UEL]: { mesure: { E: 8, C: 8, A: 8 } } } };
    const PC = ap.portesCoupes(r, etatC, Date.parse('2026-11-07T00:00Z'));
    eq(J(PC[UEL].porte), J(coupes.porte(UEL, { E: 8, C: 8, A: 8 }, ap.deriveDe(r, [UEL]), Date.parse('2026-11-07T00:00Z'))), 'la porte de l outil est celle du serveur (coupes.porte)');
    eq(PC[UEL].porte.verdict, 'pas encore', 'sur 3 rencontres : pas encore (echantillon)');
    const txt = ap.rapportCoupes(r, PC, etatC);
    ok(/DERIVE DES COUPES/.test(txt) && /il faut 189 rencontres/.test(txt) && /soccer_uefa_europa_league : PAS ENCORE/.test(txt), 'le rapport le dit');
    /* la commande, sur un dossier de journal */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-journal-'));
    fs.writeFileSync(path.join(dir, '2026-10-22.jsonl'), lignes.map((x) => J(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'etat.json'), J({ coupes: etatC }));
    const INST = fs.mkdtempSync(path.join(os.tmpdir(), 'coupes-inst-'));
    const DEPOT = path.join(__dirname, '_releves', 'prix_age');
    const avantDepot = fs.existsSync(DEPOT) ? fs.readdirSync(DEPOT).length : 0;
    const sortie = await capte(async () => { eq(await ap.principal(['node', 'age_prix.js', '--dossier', dir, '--coupes', '--instantanes', INST]), 0, 'node outils/age_prix.js --coupes : code 0'); });
    ok(sortie.some((x) => /DERIVE DES COUPES/.test(x)), 'et il imprime la derive');
    ok(fs.readdirSync(INST).some((x) => /^coupes-.*\.json$/.test(x)), 'l instantane va dans --instantanes');
    eq(fs.existsSync(DEPOT) ? fs.readdirSync(DEPOT).length : 0, avantDepot, 'et rien dans _releves/prix_age du depot (relecture du 11/10)');
  }

  console.log(rates ? `\nRATES : ${rates}/${n}` : `\ncoupes.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
