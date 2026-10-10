'use strict';
/*
 * LA FABRIQUE DE LA REFERENCE DU SOCLE (lot 0, 10/10/2026).
 *
 * ---- pourquoi ----
 *
 * Le socle touche le seul chemin par lequel un credit de The Odds API se
 * depense (`paris_import.appel`, `autorise`), la releve des prix
 * (`rafraichitPrix`) et l'ecriture du carnet (`prix_marche.note`). Tous les
 * lots suivants en dependent, et la regle est la meme pour chacun : drapeaux
 * vides, RIEN de ce qui est vendu ne change. « Rien » se prouve octet pour
 * octet, pas a l'oeil : ce script fait tourner le chemin des prix, du
 * calendrier gratuit jusqu'au catalogue vendu, sur un faux fournisseur FIXE et
 * une horloge FIGEE, et ecrit ce qui en sort.
 *
 * usage : node essais/reference/fabrique.js <dossier du code> <dossier de sortie>
 *
 * ---- d'ou vient `attendu/` ----
 *
 * Produit par le code de main D'AVANT le socle, commit
 * 63b6ad078217c8132083cbaaf253e291b5b81135, extrait par `git archive` (jamais
 * par checkout ni stash) :
 *   git -C <depot> archive 63b6ad078217c8132083cbaaf253e291b5b81135 | tar -x -C <brouillon>/ref
 *   node essais/reference/fabrique.js <brouillon>/ref essais/reference/attendu
 * `socle.test.js` refait la meme chose avec le code du depot et exige
 * l'identite. Si CE fichier change (une rencontre de plus, un tour de plus),
 * la reference se refait avec le code de main d'avant le changement qu'on
 * veut juger, jamais avec le code juge.
 *
 * ---- ce qui est fige ----
 *
 * - l'horloge : `Date` est remplace avant le premier require ;
 * - le reseau : `fetch` est remplace avant le premier require ; une URL qui
 *   n'est pas celle du fournisseur fait echouer la fabrique ;
 * - les entrees du depot qui bougent sans le code (forces Elo, totaux par
 *   championnat, pays) : copies figees dans `entrees/`, chargees par leurs
 *   chemins explicites ;
 * - l'environnement : toute variable PARIS_* / ODDS_API_* heritee est
 *   effacee, puis seules les valeurs ci-dessous sont posees — celles de la
 *   production pour les variables qui existaient avant le socle (8.8quater),
 *   aucune pour les drapeaux des lots suivants.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const [codeArg, sortieArg] = process.argv.slice(2);
if (!codeArg || !sortieArg) {
  console.error('usage : node essais/reference/fabrique.js <dossier du code> <dossier de sortie>');
  process.exit(2);
}
const CODE = path.resolve(codeArg), SORTIE = path.resolve(sortieArg);
const ENTREES = path.join(__dirname, 'entrees');

// ------------------------------------------------------- l'environnement
for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k) || k === 'DATA_DIR') delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'socle-ref-'));
Object.assign(process.env, {
  DATA_DIR: BAC,
  ODDS_API_KEY: 'cle-factice-de-la-reference',
  ODDS_API_TOTAL: '20000',
  ODDS_API_LIGUES: 'foot=soccer_epl,foot=soccer_spain_la_liga,foot=soccer_france_ligue_one,nhl=icehockey_nhl,tennis=*',
  PARIS_PRIX_LIGUES: 'soccer_epl,soccer_spain_la_liga',
  PARIS_PRIX_RELEVE_H: '2',
  PARIS_PRIX_AVANT_TOUS: '1',
});

// ------------------------------------------------------------ l'horloge
const VraieDate = Date;
const T0 = VraieDate.UTC(2026, 9, 10, 9, 0, 0);     // samedi 10/10/2026, 09:00 UTC
let MAINTENANT = T0;
class DateFigee extends VraieDate {
  constructor(...a) { if (a.length) super(...a); else super(MAINTENANT); }
  static now() { return MAINTENANT; }
}
global.Date = DateFigee;

// ------------------------------------------------- le faux fournisseur
const H = 3600000, MIN = 60000;
const quand = (dt) => new VraieDate(T0 + dt).toISOString();
const ev = (id, dom, ext, dt) => ({ id, sport_key: '', commence_time: quand(dt), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [
    ev('epl-passe', 'Arsenal', 'Fulham', -2 * H),                     // commencee : jamais importee
    ev('epl-1', 'Arsenal', 'Everton', 3 * H + 5 * MIN),               // 35 min avant au tour 2 : avant-match
    ev('epl-2', 'Chelsea', 'Liverpool', 26 * H),
    ev('epl-3', 'Manchester City', 'Tottenham', 50 * H),             // alias Elo : Tottenham Hotspur
    ev('epl-4', 'Brentford', 'Fulham', 74 * H),                       // marche retire au tour 2
    ev('epl-loin', 'Everton', 'Chelsea', 8 * 24 * H),                 // au-dela de l'horizon de 7 j
  ],
  soccer_spain_la_liga: [
    ev('liga-1', 'Real Madrid', 'Getafe', 6 * H),
    ev('liga-2', 'Barcelona', 'Sevilla', 30 * H),
  ],
  soccer_france_ligue_one: [
    ev('l1-1', 'Lyon', 'Monaco', 28 * H),
    ev('l1-2', 'Marseille', 'Lille', 52 * H),
  ],
  icehockey_nhl: [ev('nhl-1', 'Boston Bruins', 'Toronto Maple Leafs', 12 * H)],
  tennis_atp_paris: [ev('atp-1', 'Cristina Bucsa', 'Iva Jovic', 5 * H),
                     Object.assign(ev('atp-2', 'Iva Jovic', '', 7 * H), { away_team: undefined })],
};
const SPORTS = [
  { key: 'tennis_atp_paris', group: 'Tennis', active: true },
  { key: 'tennis_atp_paris_winner', group: 'Tennis', active: true },   // un classement : ecarte par le joker
  { key: 'tennis_wta_wuhan', group: 'Tennis', active: false },
  { key: 'soccer_epl', group: 'Soccer', active: true },
];
const trois = (key, e, c1, cn, c2) => ({ key, title: key, last_update: quand(-10 * MIN), markets: [{ key: 'h2h', last_update: quand(-10 * MIN), outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
const deux = (key, e, c1, c2) => ({ key, title: key, last_update: quand(-10 * MIN), markets: [{ key: 'h2h', last_update: quand(-10 * MIN), outcomes: [
  { name: e.home_team, price: c1 }, { name: e.away_team, price: c2 }] }] });
const avec = (e, livres) => Object.assign({}, e, { bookmakers: livres });
const E = (l, i) => EVENTS[l][i];
let TOUR = 1;
/* Chaque tour a ses prix : la reference couvre Betfair, Pinnacle, la mediane,
   un Betfair hors bornes, une rencontre sans reference, un marche retire. */
const ODDS = {
  soccer_epl: () => [
    avec(E('soccer_epl', 1), [trois('betfair_ex_eu', E('soccer_epl', 1), TOUR === 1 ? 1.62 : 1.58, 4.1, 6.2),
      trois('pinnacle', E('soccer_epl', 1), 1.60, 4.0, 5.9), trois('unibet_eu', E('soccer_epl', 1), 1.57, 3.9, 5.6),
      trois('williamhill', E('soccer_epl', 1), 1.58, 3.8, 5.5)]),
    avec(E('soccer_epl', 2), [trois('pinnacle', E('soccer_epl', 2), 2.55, 3.45, 2.85),
      trois('unibet_eu', E('soccer_epl', 2), 2.5, 3.4, 2.8), trois('bwin', E('soccer_epl', 2), 2.45, 3.4, 2.9)]),
    avec(E('soccer_epl', 3), [trois('unibet_eu', E('soccer_epl', 3), 1.45, 4.8, 6.5),
      trois('williamhill', E('soccer_epl', 3), 1.47, 4.6, 6.2)].concat(TOUR === 1 ? [] : [trois('bwin', E('soccer_epl', 3), 1.46, 4.7, 6.4)])),
  ].concat(TOUR === 1 ? [avec(E('soccer_epl', 4), [trois('betfair_ex_eu', E('soccer_epl', 4), 2.3, 3.5, 3.3)])] : []),
  soccer_spain_la_liga: () => [
    avec(E('soccer_spain_la_liga', 0), [trois('betfair_ex_eu', E('soccer_spain_la_liga', 0), 1.3, 8.0, 15.0),   // somme 0,96 : ecartee
      trois('pinnacle', E('soccer_spain_la_liga', 0), 1.22, 7.0, 13.0),
      trois('unibet_eu', E('soccer_spain_la_liga', 0), 1.2, 6.5, 12.0), trois('bwin', E('soccer_spain_la_liga', 0), 1.21, 6.8, 11.0)]),
    avec(E('soccer_spain_la_liga', 1), [trois('betfair_ex_eu', E('soccer_spain_la_liga', 1), 1.76, 4.3, 4.7),   // somme 1,013 : bourse saine
      trois('pinnacle', E('soccer_spain_la_liga', 1), 1.75, 4.2, 4.6), trois('unibet_eu', E('soccer_spain_la_liga', 1), 1.7, 4.0, 4.5),
      trois('bwin', E('soccer_spain_la_liga', 1), 1.72, 4.1, 4.4)]),
  ],
  soccer_france_ligue_one: () => [
    avec(E('soccer_france_ligue_one', 0), [trois('pinnacle', E('soccer_france_ligue_one', 0), 2.2, 3.5, 3.3),
      trois('unibet_eu', E('soccer_france_ligue_one', 0), 2.15, 3.4, 3.25), trois('bwin', E('soccer_france_ligue_one', 0), 2.1, 3.5, 3.4)]),
    avec(E('soccer_france_ligue_one', 1), [trois('pinnacle', E('soccer_france_ligue_one', 1), 1.95, 3.6, 3.9),
      trois('unibet_eu', E('soccer_france_ligue_one', 1), 1.9, 3.5, 3.8), trois('bwin', E('soccer_france_ligue_one', 1), 1.93, 3.55, 3.85)]),
  ],
  icehockey_nhl: () => [avec(E('icehockey_nhl', 0), [deux('pinnacle', E('icehockey_nhl', 0), 1.85, 2.0),
    deux('unibet_eu', E('icehockey_nhl', 0), 1.83, 1.98), deux('bwin', E('icehockey_nhl', 0), 1.86, 1.96)])],
  tennis_atp_paris: () => [],                   // une reponse vide : ne coute rien (doc du fournisseur)
};
const DEJA_UTILISES = 3000;                     // le mois a deja commence
let utilise = 0;
const appels = [];
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://api.the-odds-api.com') throw new Error('fabrique : reseau interdit — ' + u.origin);
  const m = u.pathname.match(/^\/v4\/sports(?:\/([^/]+)\/(events|odds))?$/);
  if (!m) throw new Error('fabrique : chemin inattendu ' + u.pathname);
  const params = {};
  for (const [k, v] of [...u.searchParams.entries()].filter(([k]) => k !== 'apiKey').sort((a, b) => (a[0] < b[0] ? -1 : 1))) params[k] = v;
  let corps, cout = 0;
  if (!m[1]) corps = SPORTS;
  else if (m[2] === 'events') corps = EVENTS[m[1]] || [];
  else {
    corps = ODDS[m[1]] ? ODDS[m[1]]() : [];
    /* « [number of markets specified] x [number of regions specified] », et
       une reponse sans evenement ne compte pas (guide v4 du fournisseur). */
    if (corps.length) cout = params.markets.split(',').length * params.regions.split(',').length;
  }
  utilise += cout;
  appels.push({ t: new VraieDate(MAINTENANT).toISOString(), chemin: u.pathname, params, cout });
  const h = { 'x-requests-remaining': String(20000 - DEJA_UTILISES - utilise),
              'x-requests-used': String(DEJA_UTILISES + utilise), 'x-requests-last': String(cout) };
  const brut = JSON.stringify(corps);
  return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
           json: async () => JSON.parse(brut), text: async () => brut };
};

// ------------------------------------------------------------- les tours
(async () => {
  /* Un calendrier precedent VIDE sur le volume : l'amorce du depot n'entre pas
     dans la reference. */
  fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify({ sports: [], matchs: [] }) + '\n');
  const cotes = require(path.join(CODE, 'cotes'));
  const paris = require(path.join(CODE, 'paris'));
  const pm = require(path.join(CODE, 'prix_marche'));
  const imp = require(path.join(CODE, 'paris_import'));
  cotes.chargeNotes(path.join(ENTREES, 'paris_notes.json'));
  cotes.chargeButs(path.join(ENTREES, 'paris_buts.json'));
  imp.chargePays(path.join(ENTREES, 'paris_pays.json'));

  /* Tour 1, le demarrage : calendrier (0 credit, les deux championnats vendus
     suspendus faute de prix), prix perimes, puis le calendrier qui en descend. */
  await imp.importeMatchs(); paris.charge();
  await imp.rafraichitPrix(imp.prixPerimes(), 'demarrage', pm.releveMs());
  await imp.importeMatchs(); paris.charge();

  /* Tour 2, deux heures et demie plus tard : l'avant-match d'abord (Arsenal–
     Everton a 35 min), puis la releve periodique (la Liga seule est perimee),
     puis le calendrier. Le marche de Brentford–Fulham est retire. */
  MAINTENANT = T0 + 2.5 * H; TOUR = 2;
  await imp.rafraichitPrix([...new Set(imp.prixAvantMatch(() => false).concat(paris.prixDemandes()))], 'avant le coup d envoi', H);
  await imp.rafraichitPrix(imp.prixPerimes(), 'periodique', pm.releveMs());
  await imp.importeMatchs(); paris.charge();

  /* Tour 3 : l'etalonnage (les championnats au prix frais sont sautes), puis
     le calendrier avec les forces corrigees. */
  MAINTENANT = T0 + 3 * H; TOUR = 3;
  await imp.calibre();
  await imp.importeMatchs(); paris.charge();

  /* Les tours 4 et 5 couvrent le chemin du REFUS, que les trois premiers ne
     touchent pas (sur 20 000 credits, rien n'y est jamais refuse). Le
     compteur est pose comme un samedi charge le laisserait. Ce qui sort du
     garde-fou s'y lit dans `appels.json` (un appel refuse ne part pas), le
     carnet et le compteur. Ajoutes le 10/10/2026 a la relecture du socle ;
     `attendu/` refait avec le code de 63b6ad0, jamais avec le code juge. */
  const FQ = path.join(BAC, 'odds_quota.json');
  const pose = (f) => { const q = imp.etatQuota(); f(q); fs.writeFileSync(FQ, JSON.stringify(q, null, 2) + '\n'); };

  /* Tour 4 : la part du jour est prise. L'etalonnage (sans priorite) est
     refuse sans un appel ; la releve des deux championnats VENDUS passe au-dela
     de la part, en priorite (il reste de quoi en faire une par championnat
     vendu et par jour jusqu'a la fin du mois). */
  MAINTENANT = T0 + 4 * H; TOUR = 4;
  pose((q) => { q.depenseDuJour = imp.partDuJour(q.reste); });
  await imp.calibre();
  await imp.rafraichitPrix(['soccer_epl', 'soccer_spain_la_liga'], 'periodique', 0);
  await imp.importeMatchs(); paris.charge();

  /* Tour 5 : la part prise ET plus de quoi tenir le mois (40 credits pour 2
     championnats vendus sur ~22 jours) : la releve du prix vendu est refusee
     elle aussi, sans un appel (l'alerte privee n'est pas configuree ici). */
  MAINTENANT = T0 + 5 * H; TOUR = 5;
  pose((q) => { q.reste = 40; q.depenseDuJour = imp.partDuJour(40); });
  await imp.rafraichitPrix(['soccer_epl', 'soccer_spain_la_liga'], 'periodique', 0);
  await imp.calibre();
  await imp.importeMatchs(); paris.charge();

  fs.mkdirSync(SORTIE, { recursive: true });
  for (const f of ['paris_catalogue.json', 'paris_prix.json', 'odds_quota.json']) fs.copyFileSync(path.join(BAC, f), path.join(SORTIE, f));
  fs.writeFileSync(path.join(SORTIE, 'appels.json'), JSON.stringify(appels, null, 1) + '\n');
  fs.rmSync(BAC, { recursive: true, force: true });
  console.log(`fabrique : ${appels.length} appel(s), ${utilise} credit(s), sortie dans ${SORTIE}`);
})().catch((e) => { console.error(e); process.exit(1); });
