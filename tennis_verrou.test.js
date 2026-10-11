'use strict';
/*
 * LE VERROU D'HEURE REELLE DU TENNIS (11/10/2026).
 *
 * ---- ce que l'essai tient ----
 * Le proprietaire veut le tennis au prix du marche. Ce qui l'empechait : sans
 * signal « commence », un parieur parierait sur un match deja en cours au prix
 * d'avant-match. Le signal vient du tableau public d'ESPN (atp, wta). L'essai
 * tient, sur des extraits REDUITS des copies du 11/10 (bancs_tennis_espn.json,
 * champs lus seulement — outil de reduction hors depot) :
 *  1. la lecture des deux tableaux : groupings[].competitions[] ET
 *     competitions[], le SIMPLE du circuit seul (ni double, ni l'autre circuit
 *     d'un tournoi mixte, ni « TBD », ni trois joueurs), l'etat le plus avance
 *     entre deux journees, « pre » SEULEMENT sous STATUS_SCHEDULED sans score
 *     ni suspension, les jeux et le vainqueur, les jours demandes (trois au
 *     plus a toute heure) ;
 *  2. l'appariement : ordre inverse, accents, initiales (autant que de jetons
 *     restants, jeton plein exige), homonymes ambigus refuses, autre jour
 *     refuse des deux cotes, un seul candidat ou rien, jamais devine ;
 *  3. la releve : ESPN muet, refuse ou illisible -> le circuit entier en
 *     panne, rien d'apparie ; le vainqueur dans le sens du catalogue ; les
 *     403/429 de TOUS les tableaux comptes ;
 *  4. prix_ligues : PARIS_TENNIS_VERROU vide ou `observe` = rien ne change ;
 *     `actif` leve `venteImpossible` pour ATP/WTA seulement ;
 *  5. paris.ouvert : tennis VENDU sous verrou actif ferme sans appariement,
 *     ferme apres 150 s, ferme a « in », ferme a l'heure ESPN - 60 s, ferme
 *     sur un « pre » suspendu ou deja marque (la pluie, puis un redemarrage) ;
 *     l'Elo ferme plus tot, rien de plus ; drapeau vide = comme avant ;
 *  6. le module : eteint = 0 requete et 0 fichier lu (meme par etat) ;
 *     observe = rien de pose ; recul sur 403/429 (le sien ET celui des autres
 *     tableaux), plafond 30 min ; le carnet (derniere passe avant l'heure,
 *     vues en jeu avant l'heure, passages pre -> in, compte du jour sur le
 *     volume, purge, ecriture par .tmp) ; les portes T1 (et sa justesse), T2,
 *     T3 a leurs seuils ; lecture refusee jamais ecrasee ;
 *  7. deux vrais serveurs (processus enfants) : `--cablage` (actif) — la
 *     minuterie posee par server.js ferme et ouvre une vraie rencontre
 *     vendue, /paris/import porte `tennis`, /paris/calendrier la montre puis
 *     la retire, SIGTERM l'arrete — et `--cablage-eteint` (variable vide) —
 *     aucune minuterie, 0 requete tennis, 0 fichier, le vendu suspendu.
 * Aucun reseau : `prendre` (ou `fetch`) est remplace.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const ETEINT = process.argv.includes('--cablage-eteint');
const CABLAGE = process.argv.includes('--cablage') || ETEINT;
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), CABLAGE ? 'tennis-cablage-' : 'tennis-verrou-'));
process.env.DATA_DIR = BAC;

let n = 0;
const logVrai = console.log;
const ok = (c, m) => { assert.ok(c, m); n++; logVrai('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); n++; logVrai('  ok  ' + m); };
let fini = false;
process.on('exit', (c) => {
  if (c === 0 && !fini) { console.error('RATE : l essai s est arrete avant sa fin (' + n + ' verifications)'); process.exitCode = 1; }
  /* le bac part TOUJOURS, essai vert ou rouge : les dossiers tennis-verrou-* restaient apres chaque rouge
     (relecture du 11/10 : 130 dossiers, tous d'executions arretees avant leur rmSync) */
  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (err) { /* rien */ }
});

const BT = JSON.parse(fs.readFileSync(path.join(__dirname, 'bancs_tennis_espn.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const T = (iso) => Date.parse(iso);
const MIN = 60000, H = 3600000;

const WTA = 'tennis_wta_wuhan_open', ATP = 'tennis_atp_shanghai_masters';
if (ETEINT) cablageEteint(); else if (CABLAGE) cablage(); else principal();

async function principal() {
const e = require('./scores_espn');
const prixLigues = require('./prix_ligues');
const paris = require('./paris');
const tv = require('./tennis_verrou');

/* Un faux ESPN : sert les extraits reduits par circuit, sur chaque journee demandee. */
function servir(opts) {
  const o = opts || {};
  const vus = [];
  const f = async (u) => {
    vus.push(String(u));
    const m = /site\.api\.espn\.com\/apis\/site\/v2\/sports\/tennis\/(atp|wta)\/scoreboard\?dates=(\d{8})$/.exec(String(u));
    if (!m) throw new Error('url inattendue ' + u);
    if (o.jette && o.jette(m[1], m[2])) throw new Error('reseau coupe');
    if (o.refuse && o.refuse(m[1], m[2])) return { ok: false, status: o.statut || 503, json: async () => ({}) };
    if (o.sansEvents && o.sansEvents(m[1], m[2])) return { ok: true, status: 200, json: async () => ({ leagues: [] }) };
    const evs = o.evs ? o.evs(m[1], m[2]) : clone(BT[m[1]].events);
    return { ok: true, status: 200, json: async () => ({ events: evs }) };
  };
  f.vus = vus;
  return f;
}
const M = (id, ligue, dom, ext, iso, extra) => Object.assign({ id, sport: 'tennis', domicile: dom, exterieur: ext, debut: T(iso),
  source: { fournisseur: 'the-odds-api', ligue, evenement: 'ev-' + id } }, extra || {});

await (async () => {
  // ================== 1. LA LECTURE DES DEUX TABLEAUX
  logVrai('\n-- 1. les deux tableaux : le simple du circuit, et lui seul --');
  {
    const a = e.rencontresTennis(clone(BT.atp.events), 'atp');
    eq(a.map((r) => r.id).sort().join(','), '184932,184939,184950,184951',
       'atp : les 4 simples messieurs nommes de Shanghai — ni les deux « TBD v TBD », ni le double, ni le simple DAMES du China Open (tournoi mixte)');
    const w = e.rencontresTennis(clone(BT.wta.events), 'wta');
    eq(w.map((r) => r.id).sort().join(','), '185314,185331,185334,185336,185340,185343,186436',
       'wta : les 7 simples dames (Wuhan, Lisbonne) — ni les doubles, ni le simple MESSIEURS du China Open');
    const vE = w.find((r) => r.id === '186436'), zS = w.find((r) => r.id === '185340'), kK = w.find((r) => r.id === '185314');
    eq(`${vE.etat}|${vE.statut}|${vE.heureValide}`, 'in|STATUS_IN_PROGRESS|true', 'Van Emst - Serban : en jeu (etat « in »), heure valide');
    eq(`${zS.etat}|${zS.heureValide}|${new Date(zS.quand).toISOString()}`, 'pre|false|2026-10-13T04:00:00.000Z',
       'Zhang - Kalinskaya : `timeValid: false` -> une DATE (04:00Z), jamais une heure');
    eq(`${kK.a}|${kK.b}|${kK.tournoi}`, 'Sonay Kartal|Anhelina Kalinina|Dongfeng Voyah Wuhan Open', 'les deux joueuses nommees, le tournoi garde');
    eq(e.rencontresTennis(clone(BT.wta.events), 'xyz').length, 0, 'un circuit inconnu ne lit rien');

    /* competitions[] a plat, sans groupings : lues aussi, sur le `type.slug` de la rencontre */
    const plat = [{ id: 'p', name: 'Flat Open', competitions: [
      { id: 'f1', date: '2026-10-12T09:00Z', timeValid: true, status: { type: { name: 'STATUS_SCHEDULED', state: 'pre' } }, type: { slug: 'womens-singles' },
        competitors: [{ athlete: { displayName: 'Iga Swiatek' } }, { athlete: { displayName: 'Coco Gauff' } }] },
      { id: 'f2', date: '2026-10-12T09:00Z', timeValid: true, status: { type: { name: 'STATUS_SCHEDULED', state: 'pre' } }, type: { slug: 'mens-singles' },
        competitors: [{ athlete: { displayName: 'Jannik Sinner' } }, { athlete: { displayName: 'Carlos Alcaraz' } }] }] }];
    eq(e.rencontresTennis(plat, 'wta').map((r) => r.id).join(','), 'f1', 'events[].competitions[] (a plat) : lu aussi, le simple du circuit seul');
    /* un etat inconnu reste '' (jamais lu comme « pas commence ») ; une rencontre bancale n'emporte qu'elle */
    const bancal = clone(BT.wta.events);
    const wu = bancal.find((x) => x.id === '381-2026').groupings.find((g) => g.grouping.slug === 'womens-singles');
    wu.competitions[0].status.type.state = 'delayed';
    Object.defineProperty(wu.competitions[1], 'competitors', { get() { throw new Error('bancal'); } });
    const lu = e.rencontresTennis(bancal, 'wta');
    eq(`${lu.length}|${(lu.find((r) => r.id === wu.competitions[0].id) || {}).etat}`, '6|',
       'une rencontre qui leve est sautee SEULE (6 sur 7), un etat inconnu reste « » (pas « pre »)');
    /* la meme rencontre sur deux journees, deux etats : la plus avancee gagne */
    const j1 = clone(BT.wta.events), j2 = clone(BT.wta.events);
    j2.find((x) => x.id === '381-2026').groupings[0].competitions.find((c) => c.id === '185314').status.type.state = 'in';
    eq(e.rencontresTennis(j1.concat(j2), 'wta').find((r) => r.id === '185314').etat, 'in',
       'la meme rencontre (meme id) vue « pre » puis « in » sur deux journees : « in » garde (fermer, jamais rouvrir)');
    eq(e.rencontresTennis(j2.concat(j1), 'wta').find((r) => r.id === '185314').etat, 'in', '... dans les deux ordres');
    /* les jours demandes */
    eq(e.joursTennis([T('2026-10-12T03:00Z')]).join(','), '20261011,20261012', '03:00Z le 12 : le jour UTC et celui de New York (la veille)');
    eq(e.joursTennis([T('2026-10-12T15:00Z')]).join(','), '20261012', '15:00Z : un seul jour');
    eq(e.joursTennis([T('2026-10-11T02:00Z'), T('2026-10-12T12:00Z'), T('2026-10-13T12:00Z'), T('2026-10-14T12:00Z'), T('2026-10-15T12:00Z')]).length,
       4, 'jamais plus de TENNIS_JOURS_MAX (4) journees par circuit');
    /* la passe suit [-6 h ; +36 h] : jamais plus de TROIS journees, a toute heure (le commentaire de joursTennis) */
    let pire = 0;
    for (let h = 0; h < 24; h++) for (let q = 0; q < 60; q += 15) {
      const t0 = T('2026-10-11T00:00Z') + h * H + q * MIN;
      const debuts = [];
      for (let d = -6 * H + MIN; d <= 36 * H; d += 15 * MIN) debuts.push(t0 + d);
      pire = Math.max(pire, e.joursTennis(debuts).length);
    }
    eq(pire, 3, 'rencontres de -6 h a +36 h, a toute heure du jour : trois journees au plus (le plafond de 4 n est jamais atteint)');

    /* ---- « pre » seulement quand rien ne dit le contraire (relecture du 11/10) ---- */
    const preSous = (modif) => {
      const evs = clone(BT.wta.events);
      const c = evs.find((x) => x.id === '381-2026').groupings[0].competitions.find((x) => x.id === '185336');
      modif(c);
      return e.rencontresTennis(evs, 'wta').find((r) => r.id === '185336');
    };
    eq(preSous(() => {}).etat, 'pre', 'Fernandez - Alexandrova telle que relevee (STATUS_SCHEDULED, ni score ni suspension) : « pre »');
    eq(preSous((c) => { c.status.type.name = 'STATUS_SUSPENDED'; }).etat, '', 'state « pre » sous STATUS_SUSPENDED : « » (ferme le vendu), jamais « pre »');
    eq(preSous((c) => { c.status.type.name = 'STATUS_DELAYED'; }).etat, '', '... sous STATUS_DELAYED aussi');
    eq(preSous((c) => { delete c.status.type.name; }).etat, '', '... et sans statut nomme');
    eq(preSous((c) => { c.wasSuspended = true; }).etat, '', 'STATUS_SCHEDULED mais wasSuspended : « »');
    eq(preSous((c) => { c.competitors[0].linescores = [{ value: 6 }, { value: 3 }]; c.competitors[1].linescores = [{ value: 4 }, { value: 2 }]; }).etat, '',
       'STATUS_SCHEDULED mais un score au tableau (6-4 3-2) : « » — la pluie, puis un redemarrage qui a efface le « in »');
    eq(preSous((c) => { c.competitors[0].linescores = [{ value: 0 }]; c.competitors[1].linescores = [{ value: 0 }]; }).etat, '',
       '... meme a 0-0 : un tableau de score existe, la rencontre n est plus « a venir » sans doute');
    eq(preSous((c) => { c.competitors[0].linescores = []; c.competitors[1].linescores = [{}]; }).etat, 'pre', 'des linescores vides (sans `value`) ne sont pas un score');
    const vE2 = e.rencontresTennis(clone(BT.wta.events), 'wta').find((r) => r.id === '186436');
    eq(`${vE2.jeux}|${vE2.gagnant}`, '20|null', 'Van Emst - Serban en jeu (6-2 4-6 1-1, copie du 11/10) : 20 jeux deja joues, pas de vainqueur');
    eq(`${e.jeuxJoues([{ linescores: [{ value: 7 }, { value: 'x' }, { value: -1 }] }, {}])}|${e.jeuxJoues([{}, { linescores: null }])}`, '7|null',
       'les jeux : seules les valeurs numeriques positives comptent ; aucune -> null');
    const fini = preSous((c) => { c.status.type = { name: 'STATUS_FINAL', state: 'post' }; c.competitors[1].winner = true; c.competitors[0].winner = false; });
    eq(`${fini.etat}|${fini.gagnant}`, 'post|b', 'une rencontre finie : le vainqueur est lu (le second joueur du tableau)');
    eq(preSous((c) => { c.status.type.state = 'post'; c.competitors[0].winner = true; c.competitors[1].winner = true; }).gagnant, null, 'deux `winner` : aucun vainqueur lu');
    /* un simple a trois joueurs n'existe pas : rien n'est lu */
    eq(preSous((c) => { c.competitors.push({ athlete: { displayName: 'Iga Swiatek' } }); }), undefined, 'trois competiteurs : la rencontre n est pas lue');
  }

  // ================== 2. LES NOMS ET L'APPARIEMENT
  logVrai('\n-- 2. l appariement : les deux noms, le meme jour, un seul candidat --');
  {
    ok(e.memeJoueur('Qinwen Zheng', 'Zheng Qinwen'), 'ordre inverse : « Qinwen Zheng » (The Odds API) = « Zheng Qinwen » (ESPN)');
    ok(e.memeJoueur('Marie Bouzková', 'Marie Bouzkova'), 'accents');
    ok(e.memeJoueur('C. Ruud', 'Casper Ruud') && e.memeJoueur('Casper Ruud', 'C. Ruud'), 'initiales, des deux cotes');
    ok(e.memeJoueur('J.-L. Struff', 'Jan-Lennard Struff'), 'deux initiales pour un prenom compose');
    ok(e.memeJoueur('Alex de Minaur', 'Alex De Minaur'), '« de » n est pas un mot de bruit au tennis');
    eq(e.normaliseJoueur('Łukasz Kubot'), 'lukasz kubot', 'ł, que NFKD ne decompose pas : table fixe');
    eq(e.normaliseJoueur('Holger Rune-Ø'), 'holger rune o', 'ø aussi');
    ok(!e.memeJoueur('Wang Xinyu', 'Wang Xiyu'), '« Wang Xinyu » n est PAS « Wang Xiyu » (adversaires a Wuhan le 12/10)');
    ok(!e.memeJoueur('Joelle Steur', 'Joelle Lilly Sophie Steur'), 'un prenom en moins ne s apparie pas (alias releve seulement)');
    ok(!e.memeJoueur('Sonay Kartal', 'Sonay Kartall') && !e.memeJoueur('C. Ruud', 'Christian Ruud Smith'), 'aucune ressemblance, aucune initiale de trop');
    ok(!e.memeJoueur('C.', 'Casper Ruud') && !e.memeJoueur('C.', 'Casper') && !e.memeJoueur('', 'Casper Ruud'), 'une initiale seule (meme contre un nom d un seul mot) ou un nom vide ne valent personne');
    ok(!e.memeJoueur('C. Ruud', 'Casper Christian Ruud') && !e.memeJoueur('J. L. Struff', 'Jan Struff'), 'autant de jetons restants que d initiales, ni plus ni moins');
    ok(!e.memeJoueur('C. Ruud', 'Casper') && !e.memeJoueur('A. B. Smith', 'Alex Brown'), 'chaque jeton complet doit se retrouver tel quel (le nom) : jamais deviné');
    eq(Object.keys(e.ALIAS_TENNIS).length, 0, 'aucun alias au 11/10/2026 (11 rencontres sur 11 appariees sans)');
    ok(!e.memeJoueur('constructor', 'constructor x'), 'une cle de prototype ne fait pas un alias');

    const w = e.rencontresTennis(clone(BT.wta.events), 'wta'), a = e.rencontresTennis(clone(BT.atp.events), 'atp');
    const ap = (m, l) => e.apparieTennis(m, l);
    const r1 = ap(M('w1', WTA, 'Anhelina Kalinina', 'Sonay Kartal', '2026-10-12T03:00Z'), w);
    eq(r1 && r1.r && r1.r.id, '185314', 'Kalinina - Kartal (domicile/exterieur inverses par rapport a ESPN) : appariee');
    eq((ap(M('w2', WTA, 'Clara Tauson', 'Marie Bouzková', '2026-10-12T04:10Z'), w) || {}).r.id, '185331',
       'Tauson - Bouzková, 20 min avant l heure ESPN : appariee (ecart mesure le 11/10 : 0 a 40 min)');
    eq((ap(M('w3', WTA, 'Ann Li', 'Qinwen Zheng', '2026-10-13T02:00Z'), w) || {}).r.id, '185343',
       'Li - Zheng (ordre inverse) sur une DATE ESPN (04:00Z) : appariee a -2 h');
    eq((ap(M('a1', ATP, 'C. Ruud', 'L. Tien', '2026-10-12T04:00Z'), a) || {}).r.id, '184932', 'C. Ruud - L. Tien (initiales) : appariee');
    const amb = ap(M('w4', WTA, 'Wang X.', 'Wang X.', '2026-10-12T11:30Z'), w);
    eq(`${amb && amb.ambigu}|${amb && amb.r}`, 'true|undefined', '« Wang X. - Wang X. » : les initiales couvrent les deux joueuses, dans les deux sens -> AMBIGU, pas d appariement');
    eq((ap(M('w5', WTA, 'X. Wang', 'Xiyu Wang', '2026-10-12T11:30Z'), w) || {}).r.id, '185334', '... mais « X. Wang - Xiyu Wang » n a qu un sens possible : appariee');
    /* un second candidat (meme affiche, deux heures plus tard, autre identifiant) : ambigu, jamais « le plus proche » */
    const double = w.concat([Object.assign({}, w.find((r) => r.id === '185314'), { id: '999001', quand: T('2026-10-12T05:00Z') })]);
    const a2 = ap(M('w6', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-12T03:00Z'), double);
    eq(`${a2 && a2.ambigu}|${a2 && a2.n}`, 'true|2', 'deux candidats le meme jour : AMBIGU (2), meme si l un est a l heure exacte');
    /* l'autre jour */
    eq(ap(M('w7', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-14T03:00Z'), w), null, 'heure valide a 48 h : un autre jour, refusee');
    eq(ap(M('w8', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-12T15:01Z'), w), null, 'heure valide a 12 h 01 : refusee');
    eq((ap(M('w9', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-12T15:00Z'), w) || {}).r.id, '185314', '... a 12 h pile : appariee (borne incluse)');
    eq(ap(M('w15', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-11T14:59Z'), w), null, 'heure valide a -12 h 01 (catalogue en avance) : refusee');
    eq(ap(M('w16', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-10T03:00Z'), w), null, '... a -48 h : refusee');
    eq((ap(M('w17', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-11T15:00Z'), w) || {}).r.id, '185314', '... a -12 h pile : appariee (borne incluse des deux cotes)');
    eq(ap(M('w10', WTA, 'Shuai Zhang', 'Anna Kalinskaya', '2026-10-14T10:01Z'), w), null, 'date ESPN (13/10 04:00Z) a +30 h 01 : refusee');
    eq((ap(M('w11', WTA, 'Shuai Zhang', 'Anna Kalinskaya', '2026-10-14T10:00Z'), w) || {}).r.id, '185340', '... a +30 h pile : appariee');
    eq(ap(M('w12', WTA, 'Shuai Zhang', 'Anna Kalinskaya', '2026-10-12T19:59Z'), w), null, 'date ESPN a -8 h 01 : refusee');
    eq((ap(M('w13', WTA, 'Shuai Zhang', 'Anna Kalinskaya', '2026-10-12T20:00Z'), w) || {}).r.id, '185340', '... a -8 h pile : appariee');
    /* le circuit et les doubles */
    eq(ap(M('a3', ATP, 'Mirra Andreeva', 'Qinwen Zheng', '2026-10-11T11:35Z'), a), null, 'un simple DAMES sur le tableau atp (China Open) : jamais apparie a une cle atp');
    const avecDouble = clone(BT.wta.events);
    const dbl = avecDouble.find((x) => x.id === '381-2026').groupings.find((g) => g.grouping.slug === 'womens-doubles').competitions[0];
    dbl.competitors = [{ athlete: { displayName: 'Sonay Kartal' } }, { athlete: { displayName: 'Anhelina Kalinina' } }];
    eq((ap(M('w14', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-12T03:00Z'), e.rencontresTennis(avecDouble, 'wta')) || {}).r.id, '185314',
       'un DOUBLE aux memes noms le meme jour n est pas un candidat : le simple reste unique');
  }

  // ================== 3. LA RELEVE, ET CE QUI LA MET EN PANNE
  logVrai('\n-- 3. la releve : un tableau muet, refuse ou illisible met le circuit entier en panne --');
  const LOT = [
    M('w1', WTA, 'Anhelina Kalinina', 'Sonay Kartal', '2026-10-12T03:00Z'),
    M('w2', WTA, 'Qinwen Zheng', 'Ann Li', '2026-10-13T02:00Z'),
    M('w3', WTA, 'Sarah Van Emst', 'Raluka Serban', '2026-10-11T16:00Z'),
    M('w4', WTA, 'Wang X.', 'Wang X.', '2026-10-12T11:30Z'),
    M('w5', WTA, 'Leylah Fernandez', 'Jessica Pegula', '2026-10-12T03:00Z'),
    M('a1', ATP, 'C. Ruud', 'L. Tien', '2026-10-12T04:00Z'),
    M('a2', ATP, 'Alex de Minaur', 'Karen Khachanov', '2026-10-13T04:00Z'),
    M('x1', 'tennis_itf_men_x', 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-12T03:00Z'),
    Object.assign(M('f1', 'soccer_epl', 'Arsenal', 'Chelsea', '2026-10-12T15:00Z'), { sport: 'foot' }),
  ];
  {
    const f = servir();
    const r = await e.releveTennisTableau(LOT, { prendre: f });
    const res = Object.fromEntries(r.rencontres.map((l) => [l.id, l.resultat]));
    eq(JSON.stringify(res), JSON.stringify({ a1: 'apparie', a2: 'apparie', w1: 'apparie', w2: 'apparie', w3: 'apparie', w4: 'ambigu', w5: 'sans' }),
       'atp puis wta : 6 appariees ou refusees pour une raison dite ; ni l ITF ni le football ne sont lus');
    ok(f.vus.every((u) => /\/tennis\/(atp|wta)\/scoreboard\?dates=\d{8}$/.test(u)), 'seulement les deux tableaux tennis, par JOURNEE (dates=AAAAMMJJ)');
    eq(f.vus.filter((u) => /atp/.test(u)).length, 3, 'atp : trois journees (11, 12, 13)');
    const w1 = r.par.get('w1'), w2 = r.par.get('w2'), w3 = r.par.get('w3');
    eq(`${w1.etat}|${new Date(w1.quand).toISOString()}|${w1.heureValide}`, 'pre|2026-10-12T03:00:00.000Z|true', 'w1 : « pre », heure ESPN valide posee');
    eq(`${w2.quand}|${w2.heureValide}|${new Date(w2.dateEspn).toISOString()}`, '0|false|2026-10-13T04:00:00.000Z', 'w2 : une DATE ESPN -> quand 0 (jamais posee comme heure), dateEspn gardee');
    eq(w3.etat, 'in', 'w3 : ESPN la voit EN JEU');
    ok(!r.par.has('w4') && !r.par.has('w5'), 'ambigue et sans candidat : rien dans la Map a poser');
    eq(JSON.stringify(r.rencontres.find((l) => l.id === 'w5').proches), JSON.stringify(['Leylah Fernandez v Ekaterina Alexandrova']),
       'sans candidat : les rencontres ESPN du meme jour qui partagent un joueur, pour relever un alias a l oeil');
    eq(r.tours.wta.jours.length, 3, 'wta : journees 11, 12, 13');

    const avant = (e.refusDuJour()['tennis/wta'] || { refus: 0 }).refus;
    const p1 = await e.releveTennisTableau(LOT, { prendre: servir({ refuse: (t, j) => t === 'wta' && j === '20261012' }) });
    eq(p1.rencontres.filter((l) => l.tour === 'wta').map((l) => l.resultat).join(','), 'panne,panne,panne,panne,panne',
       'UNE journee wta refusee (503) : TOUT le circuit wta en panne — un candidat manquant ferait passer l autre pour unique');
    eq(p1.rencontres.filter((l) => l.tour === 'atp').map((l) => l.resultat).join(','), 'apparie,apparie', '... l atp, lu sans refus, reste appariee');
    ok(!p1.par.has('w1') && p1.par.has('a1'), '... rien de wta dans la Map a poser');
    eq(`${p1.tours.wta.lues}|${p1.tours.atp.lues}`, '0|4', '... et aucune rencontre wta comptee comme lue (les journees servies ne sont pas lues a moitie)');
    eq((e.refusDuJour()['tennis/wta'] || {}).refus, avant + 1, 'le refus est compte par tableau (scores_espn.refusDuJour), comme les autres tableaux');
    const p2 = await e.releveTennisTableau(LOT, { prendre: servir({ sansEvents: (t) => t === 'atp' }) });
    eq(`${p2.rencontres.filter((l) => l.tour === 'atp').map((l) => l.resultat).join(',')}|${p2.tours.atp.illisibles}`, 'panne,panne|3',
       'une reponse sans `events` (forme inattendue) : illisible, le circuit en panne');
    const p3 = await e.releveTennisTableau(LOT, { prendre: servir({ jette: () => true }) });
    eq(`${p3.par.size}|${p3.rencontres.every((l) => l.resultat === 'panne')}|${p3.tours.wta.refus}`, '0|true|3', 'ESPN injoignable : rien d apparie, tout en panne');
    /* le cas « sans suivi » d'avant ce lot : inchange (liste vide, pas de compte d'illisible) */
    const refEng = (e.refusDuJour()['soccer/eng.1'] || { refus: 0 }).refus;
    eq(JSON.stringify(await e.tableau('soccer/eng.1', T('2026-10-12T12:00Z'), T('2026-10-12T12:00Z'),
      async () => ({ ok: true, status: 200, json: async () => ({ leagues: [] }) }))), '[]', 'un tableau du football sans `events` : liste vide, comme avant');
    eq((e.refusDuJour()['soccer/eng.1'] || { refus: 0 }).refus, refEng, '... et pas compte comme un refus (seul le suivi du tennis le fait)');

    /* le vainqueur ESPN, dans le sens de NOTRE catalogue (pour la justesse de T1) */
    const finie = (gagne) => servir({ evs: (tour) => {
      const evs = clone(BT[tour].events);
      if (tour === 'wta') {
        const c = evs.find((x) => x.id === '381-2026').groupings[0].competitions.find((x) => x.id === '185314');   // Kartal (1er) v Kalinina (2e)
        c.status.type = { name: 'STATUS_FINAL', state: 'post' };
        c.competitors[0].winner = gagne === 0; c.competitors[1].winner = gagne === 1;
        c.competitors[0].linescores = [{ value: 6 }]; c.competitors[1].linescores = [{ value: 3 }];
      }
      return evs;
    } });
    const lotV = [M('v1', WTA, 'Anhelina Kalinina', 'Sonay Kartal', '2026-10-12T03:00Z'), M('v2', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-12T03:00Z')];
    const k0 = await e.releveTennisTableau([lotV[0]], { prendre: finie(0) }), k1 = await e.releveTennisTableau([lotV[1]], { prendre: finie(0) });
    eq(`${k0.par.get('v1').vainqueur}|${k1.par.get('v2').vainqueur}|${k0.par.get('v1').jeux}`, '2|1|9',
       'Kartal gagne : « 2 » pour Kalinina - Kartal (sens croise), « 1 » pour Kartal - Kalinina (sens droit) ; 9 jeux');
    eq((await e.releveTennisTableau([lotV[0]], { prendre: finie(1) })).par.get('v1').vainqueur, '1', 'Kalinina gagne : « 1 » pour Kalinina - Kartal');
    eq((await e.releveTennisTableau([lotV[0]], { prendre: servir() })).par.get('v1').vainqueur, null, 'pas finie : aucun vainqueur');

    /* les 403/429 de TOUS les tableaux, comptes (le tennis recule sur eux, §6) */
    const b0 = e.blocages();
    const statut = (s) => async () => ({ ok: false, status: s, json: async () => ({}) });
    await e.tableau('soccer/esp.1', T('2026-10-12T12:00Z'), T('2026-10-12T12:00Z'), statut(429));
    await e.tableau('soccer/esp.1', T('2026-10-12T12:00Z'), T('2026-10-12T12:00Z'), statut(503));
    await e.tableau('hockey/nhl', T('2026-10-12T12:00Z'), T('2026-10-12T12:00Z'), statut(403));
    const b1 = e.blocages();
    eq(`${(b1['soccer/esp.1'] || 0) - (b0['soccer/esp.1'] || 0)}|${(b1['hockey/nhl'] || 0) - (b0['hockey/nhl'] || 0)}`, '1|1',
       'scores_espn.blocages : un 429 (football) et un 403 (NHL) comptes par tableau ; un 503 n est pas un blocage');
  }

  // ================== 4. PRIX_LIGUES : LE DRAPEAU
  logVrai('\n-- 4. PARIS_TENNIS_VERROU : vide ou observe, rien ne change ; actif, ATP/WTA seulement --');
  {
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,tennis_wta_*,tennis_itf_men_x';
    const pm = require('./prix_marche');
    eq(`${prixLigues.verrouTennis()}|${prixLigues.venteImpossible(WTA)}|${prixLigues.tennisSousVerrou(WTA)}`, '|true|false',
       'vide : le tennis vendu reste `venteImpossible` (comme avant), jamais sous verrou');
    ok(prixLigues.refusees().some((x) => /tennis_wta_\* \(tennis : aucune vente au marche sans verrou d heure reelle — PARIS_TENNIS_VERROU=actif le leve/.test(x)),
       'vide : dit au demarrage (refusees), avec la variable qui le leve');
    eq(pm.aRelever(new Set([WTA])).has(WTA), false, 'vide : jamais releve (0 credit)');
    eq(pm.issuesDe('tennis', WTA), null, 'vide : jamais note');
    process.env.PARIS_TENNIS_VERROU = 'observe';
    eq(`${prixLigues.verrouTennis()}|${prixLigues.venteImpossible(WTA)}|${prixLigues.tennisSousVerrou(WTA)}|${pm.aRelever(new Set([WTA])).has(WTA)}`, 'observe|true|false|false',
       'observe : exactement comme vide pour la vente');
    process.env.PARIS_TENNIS_VERROU = ' Actif ';
    eq(`${prixLigues.verrouTennis()}|${prixLigues.venteImpossible(WTA)}|${prixLigues.tennisSousVerrou(WTA)}`, 'actif|false|true',
       'actif (espaces et casse toleres) : le tennis WTA vendu n est plus `venteImpossible`, il est SOUS VERROU');
    eq(`${pm.aRelever(new Set([WTA])).has(WTA)}|${JSON.stringify(pm.issuesDe('tennis', WTA))}`, 'true|["1","2"]', 'actif : releve et note a deux issues, comme les autres sports vendus');
    eq(`${prixLigues.venteImpossible('tennis_itf_men_x')}|${prixLigues.tennisSousVerrou('tennis_itf_men_x')}`, 'true|false',
       'actif : une cle tennis hors ATP/WTA (aucun tableau) reste impossible a vendre');
    ok(prixLigues.refusees().some((x) => /tennis_itf_men_x .*seuls tennis_atp_\* et tennis_wta_\* ont un tableau ESPN/.test(x))
       && !prixLigues.refusees().some((x) => /^PARIS_PRIX_LIGUES tennis_wta_\* /.test(x)), 'actif : l ITF reste dite refusee, plus la WTA');
    eq(`${prixLigues.tennisSousVerrou(ATP)}|${prixLigues.venteImpossible(ATP)}`, 'false|false', 'actif : une cle ATP NON vendue n est pas sous verrou (elle reste a l Elo)');
    process.env.PARIS_TENNIS_VERROU = 'oui';
    eq(`${prixLigues.verrouTennis()}|${prixLigues.verrouTennisInvalide()}|${prixLigues.venteImpossible(WTA)}`, '|oui|true',
       'une valeur inconnue (« oui ») : IGNOREE, comme vide (echoue ferme), et rendue pour etre dite');
    delete process.env.PARIS_TENNIS_VERROU;
  }

  // ================== 5. PARIS.OUVERT
  logVrai('\n-- 5. paris.ouvert : le tennis vendu sous verrou ouvre seulement apparie, frais, « pre » --');
  {
    const t0 = T('2026-10-11T20:00Z');
    const vendu = (id, extra) => Object.assign({ id, sport: 'tennis', debut: t0 + 2 * H, cotesGenerees: true,
      prixMarche: { ref: 'pinnacle', t: new Date(t0 - 10 * MIN).toISOString(), livres: 3 }, source: { ligue: WTA, evenement: 'ev-' + id } }, extra || {});
    const elo = (id) => ({ id, sport: 'tennis', debut: t0 + 2 * H, cotesGenerees: true, source: { ligue: ATP, evenement: 'ev-' + id } });
    const pose = (id, s, t) => paris.poseHeuresReelles(new Map([[id, s]]), t);

    eq(`${paris.ouvert(vendu('o1'), t0)}|${paris.ouvert(elo('o2'), t0)}`, 'false|true', 'vide : le tennis vendu FERME (venteImpossible), l Elo ouvert — comme avant');
    pose('o1', { quand: 0, etat: 'pre' }, t0);
    eq(paris.ouvert(vendu('o1'), t0 + 10000), false, 'vide : meme apparie « pre », le tennis vendu reste ferme');
    process.env.PARIS_TENNIS_VERROU = 'actif';
    eq(paris.ouvert(vendu('o3'), t0), false, 'actif : vendu, JAMAIS apparie -> FERME');
    eq(paris.ouvert(vendu('o3', { prixMarche: null }), t0), false, 'actif : vendu sans prix du marche -> ferme (comme les autres championnats)');
    pose('o3', { quand: 0, etat: 'pre' }, t0);
    eq(paris.ouvert(vendu('o3'), t0 + 10000), true, 'actif : apparie « pre » il y a 10 s -> OUVERT au prix du marche');
    eq(paris.ouvert(vendu('o3'), t0 + paris.TENNIS_APPARIEMENT_MAX_MS), true, '... a 150 s pile : ouvert');
    eq(paris.ouvert(vendu('o3'), t0 + paris.TENNIS_APPARIEMENT_MAX_MS + 1), false, '... a 150 s + 1 ms (ESPN muet depuis deux passes) : FERME');
    paris.poseHeuresReelles(new Map(), t0 + 60000);
    eq(paris.ouvert(vendu('o3'), t0 + 151000), false, 'une passe qui ne rend RIEN pour elle (panne) ne rafraichit pas son appariement');
    pose('o3', { quand: 0, etat: 'pre' }, t0 + 120000);
    eq(paris.ouvert(vendu('o3'), t0 + 151000), true, 'la passe suivante l apparie de nouveau : rouverte');
    pose('o3', { quand: 0, etat: 'in' }, t0 + 180000);
    eq(paris.ouvert(vendu('o3'), t0 + 181000), false, 'ESPN la voit EN JEU, 1 h 57 avant l heure du catalogue : FERMEE');
    pose('o3', { quand: 0, etat: 'pre' }, t0 + 240000);
    eq(paris.ouvert(vendu('o3'), t0 + 241000), false, '... et un « pre » ensuite ne la rouvre jamais');
    pose('o4', { quand: t0 + 30 * MIN, etat: 'pre' }, t0 + 27 * MIN);
    eq(`${paris.ouvert(vendu('o4'), t0 + 28 * MIN)}|${paris.ouvert(vendu('o4'), t0 + 29 * MIN)}`, 'true|false',
       'heure ESPN valide (t0 + 30 min), appariement frais : fermee 60 s avant, meme si le catalogue la dit dans 2 h');
    pose('o5', { quand: 0, etat: '' }, t0);
    eq(paris.ouvert(vendu('o5'), t0 + 1000), false, 'un etat ESPN inconnu (« ») n est pas « pre » : fermee');
    eq(paris.ouvert(vendu('o6', { cotesGenerees: false }), t0), false, 'une cote relevee a la main ne dispense pas du verrou');
    /* l'Elo sous verrou actif : rien de plus de vendu, seulement ferme plus tot */
    eq(paris.ouvert(elo('o7'), t0), true, 'actif : le tennis a l Elo (cle non vendue) reste ouvert sans appariement — comme avant');
    pose('o7', { quand: 0, etat: 'in' }, t0);
    eq(paris.ouvert(elo('o7'), t0 + 1000), false, '... mais ESPN le voit en jeu : ferme (second verrou, comme au football)');

    /* le cas de la relecture du 11/10 : la pluie interrompt Fernandez - Alexandrova, le serveur redemarre
       (HEURES_REELLES n'a jamais vu son « in »), ESPN la rend state « pre » sous STATUS_SUSPENDED, avec un score */
    const pluie = (abime) => servir({ evs: (tour) => {
      const evs = clone(BT[tour].events);
      if (tour === 'wta' && abime) {
        const c = evs.find((x) => x.id === '381-2026').groupings[0].competitions.find((x) => x.id === '185336');
        abime(c);
      }
      return evs;
    } });
    const fa = (id) => M(id, WTA, 'Leylah Fernandez', 'Ekaterina Alexandrova', '2026-10-12T03:00Z');
    const p8 = await e.releveTennisTableau([fa('o8')], { prendre: pluie((c) => {
      c.status.type.name = 'STATUS_SUSPENDED'; c.wasSuspended = true;
      c.competitors[0].linescores = [{ value: 6 }, { value: 3 }]; c.competitors[1].linescores = [{ value: 4 }, { value: 2 }];
    }) });
    paris.poseHeuresReelles(p8.par, t0);
    eq(`${p8.par.get('o8').etat}|${paris.ouvert(vendu('o8'), t0 + 1000)}`, '|false',
       'suspendue (pluie) puis redemarrage : ESPN dit state « pre » sous STATUS_SUSPENDED, 6-4 3-2 -> etat « », le tennis vendu reste FERME');
    const p9 = await e.releveTennisTableau([fa('o9')], { prendre: pluie((c) => { c.competitors[0].linescores = [{ value: 1 }]; c.competitors[1].linescores = [{ value: 0 }]; }) });
    paris.poseHeuresReelles(p9.par, t0);
    eq(paris.ouvert(vendu('o9'), t0 + 1000), false, '... un score sous STATUS_SCHEDULED aussi');
    const p10 = await e.releveTennisTableau([fa('o10')], { prendre: pluie(null) });
    paris.poseHeuresReelles(p10.par, t0);
    eq(paris.ouvert(vendu('o10'), t0 + 1000), true, 'la meme rencontre telle que relevee le 11/10 (STATUS_SCHEDULED, sans score) : ouverte — la regle ne ferme que le doute');
    delete process.env.PARIS_TENNIS_VERROU;
  }

  // ================== 6. LE MODULE
  logVrai('\n-- 6. le module : eteint, observe, actif, recul, carnet, porte --');
  {
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,tennis_wta_*';
    const now = T('2026-10-11T16:00Z');
    const CAT = [
      M('w1', WTA, 'Anhelina Kalinina', 'Sonay Kartal', '2026-10-12T03:00Z'),
      M('w2', WTA, 'Qinwen Zheng', 'Ann Li', '2026-10-13T02:00Z'),
      M('w3', WTA, 'Sarah Van Emst', 'Raluka Serban', '2026-10-11T18:00Z'),
      M('w4', WTA, 'Leylah Fernandez', 'Jessica Pegula', '2026-10-12T03:00Z'),
      M('a1', ATP, 'C. Ruud', 'L. Tien', '2026-10-12T04:00Z'),
      M('a2', ATP, 'Alex de Minaur', 'Karen Khachanov', '2026-10-13T04:00Z'),
      M('a3', ATP, 'Taylor Fritz', 'Stefanos Tsitsipas', '2026-10-13T04:01Z'),      // au-dela de 36 h : hors du lot
      M('w9', WTA, 'Sonay Kartal', 'Anhelina Kalinina', '2026-10-11T15:00Z'),        // deja commencee pour le catalogue : suivie pour la mesure seule
      M('w8', WTA, 'Clara Tauson', 'Marie Bouzkova', '2026-10-12T04:10Z', { ferme: now - H }),   // fermee par l import : hors du lot
    ];
    tv.oublie();
    let f = servir();
    eq(await tv.passe(CAT, now, { prendre: f }), null, 'eteint : la passe rend null');
    eq(`${f.vus.length}|${fs.existsSync(tv.fichier())}`, '0|false', 'eteint : 0 requete, aucun fichier');
    eq(tv.planifie({ catalogue: () => CAT, pose: () => { throw new Error('jamais'); } }), null, 'eteint : planifie ne pose AUCUNE minuterie');
    /* eteint, /paris/import (etat) ne touche pas au disque : un carnet d'avant, meme illisible, n'est ni lu ni mis de cote */
    fs.writeFileSync(tv.fichier(), '{carnet d un ancien observe');
    const e0 = tv.etat(now);
    eq(`${e0.mode}|${e0.carnet.rencontres}|${fs.readFileSync(tv.fichier(), 'utf8')}|${fs.readdirSync(BAC).filter((x) => /tennis_verrou/.test(x)).length}`,
       'off|null|{carnet d un ancien observe|1', 'eteint : etat() ne lit ni ne renomme le carnet (0 fichier touche)');
    eq(`${e0.porte.T1.wta.ok}|${e0.porte.T2.wta.ok}|${e0.porte.T3.wta.ok}`, 'null|null|null', '... et ses portes ne concluent rien');
    fs.rmSync(tv.fichier());

    process.env.PARIS_TENNIS_VERROU = 'observe';
    f = servir();
    eq(await tv.passe(CAT, now, { prendre: f }), null, 'observe : la passe ne rend rien a poser');
    ok(f.vus.length > 0, `observe : les tableaux sont lus (${f.vus.length} requetes)`);
    const p = tv.etat(now).passe;
    eq(`${p.rencontres}|${JSON.stringify(p.parTournoi[WTA])}|${JSON.stringify(p.parTournoi[ATP])}`,
       '6|{"rencontres":4,"appariees":3,"ambigues":0,"sans":1,"panne":0}|{"rencontres":2,"appariees":2,"ambigues":0,"sans":0,"panne":0}',
       'la couverture de la passe, par tournoi : wta 3/4, atp 2/2 ; hors du lot : au-dela de 36 h, fermee ; deja commencee : hors de la couverture');
    eq(`${p.apres}|${f.vus.length}`, '1|6', 'deja commencee (w9, 1 h apres son heure) : suivie pour la mesure seule, 0 requete de plus (3 journees par circuit)');
    eq(JSON.stringify(p.vendues), '{"rencontres":4,"appariees":3}', 'les rencontres VENDUES (tennis_wta_*) et combien sont appariees');
    eq(p.nonAppariees.map((x) => x.id + ':' + x.resultat).join(','), 'w4:sans', 'les non appariees, avec leur raison');
    ok(tv.flush() && fs.existsSync(tv.fichier()), 'le carnet est ecrit sur le volume (deux temps)');
    const c = JSON.parse(fs.readFileSync(tv.fichier(), 'utf8'));
    eq(`${c.rencontres.w3.et}|${c.rencontres.w3.av}|${c.rencontres.w1.ap}|${c.rencontres.w4.ap}`, 'in|120|1|0',
       'au carnet : Van Emst - Serban vue EN JEU 120 min avant l heure du catalogue ; w1 appariee, w4 non');

    /* la mesure sur les rencontres dont l'heure est passee */
    const m1 = tv.mesure(T('2026-10-13T12:00Z'));
    eq(`${m1.parCircuit.wta.rencontres}|${m1.parCircuit.wta.appariees}|${m1.parCircuit.wta.enJeuAvant.n}|${m1.parCircuit.wta.enJeuAvant.maxMin}`, '4|3|1|120',
       'la mesure (14 j, heure passee) : wta 3/4 appariees, 1 vue en jeu 120 min avant l heure du catalogue');
    eq(tv.mesure(T('2026-10-11T17:00Z')).parCircuit.wta, undefined, 'avant leur heure, les rencontres ne comptent pas encore');
    /* la DERNIERE passe avant l'heure fait foi : appariee, puis absente du tableau = non appariee a la porte */
    const sans185314 = servir({ evs: (tour) => {
      const evs = clone(BT[tour].events);
      if (tour === 'wta') for (const ev of evs) for (const g of ev.groupings) g.competitions = g.competitions.filter((x) => x.id !== '185314');
      return evs;
    } });
    await tv.passe(CAT, now + 30000, { prendre: sans185314 });
    const cw1 = tv.carnet().rencontres.w1;
    eq(`${cw1.ap}|${cw1.a}|${cw1.n}`, '0|1|2', 'la derniere passe fait foi : appariee puis perdue = non appariee a la porte (1 appariement sur 2 passes garde pour lecture)');

    /* actif : la Map a poser, et le recul */
    process.env.PARIS_TENNIS_VERROU = 'actif';
    const par = await tv.passe(CAT, now + MIN, { prendre: servir() });
    eq(`${par instanceof Map}|${[...par.keys()].sort().join(',')}`, 'true|a1,a2,w1,w2,w3', 'actif : la Map des seules rencontres appariees, a poser au second verrou');
    eq(par.get('w3').etat, 'in', '... avec leur etat ESPN');
    const vu403 = servir({ refuse: () => true, statut: 403 });
    const p403 = await tv.passe(CAT, now + 2 * MIN, { prendre: vu403 });
    eq(`${p403.size}|${!!tv.etat(now + 2 * MIN).recul}|${tv.etat(now + 2 * MIN).recul.pasS}`, '0|true|120', '403 : rien a poser, la passe recule de 2 min');
    const pendant = servir();
    eq(`${await tv.passe(CAT, now + 3 * MIN, { prendre: pendant })}|${pendant.vus.length}`, 'null|0', 'pendant le recul : 0 requete (le tennis vendu vieillit et ferme)');
    await tv.passe(CAT, now + 4 * MIN + 1000, { prendre: servir({ refuse: () => true, statut: 429 }) });
    eq(tv.etat(now + 4 * MIN + 1000).recul.pasS, 240, '429 ensuite : le recul double (4 min)');
    await tv.passe(CAT, now + 9 * MIN, { prendre: servir() });
    eq(`${tv.etat(now + 9 * MIN).recul}|${tv.etat(now + 9 * MIN).espn.reculs}`, 'null|2', 'une passe sans refus : plus de recul, les reculs comptes');
    await tv.passe(CAT, now + 9 * MIN + 30000, { prendre: servir({ refuse: () => true, statut: 403 }) });
    eq(tv.etat(now + 9 * MIN + 30000).recul.pasS, 120, '... et le pas est remis a 2 min (un 403 apres une passe saine ne recule pas de 8 min)');
    const p503 = await tv.passe(CAT, now + 12 * MIN, { prendre: servir({ refuse: () => true, statut: 503 }) });
    eq(`${p503.size}|${tv.etat(now + 12 * MIN).recul}`, '0|null', '503 : rien a poser, mais aucun recul (seuls 403 et 429 reculent)');
    const vide = await tv.passe([], now + 13 * MIN, { prendre: servir() });
    eq(`${vide instanceof Map}|${vide.size}`, 'true|0', 'aucun tennis dans les 36 h : 0 requete, Map vide');

    /* un 403/429 sur un AUTRE tableau ESPN (le football) : le tennis cede la place, sans rien demander */
    await tv.passe(CAT, now + 14 * MIN, { prendre: servir() });
    eq(tv.etat(now + 14 * MIN).recul, null, '(une passe saine : plus de recul, pas remis a zero)');
    await e.tableau('soccer/esp.1', now, now, async () => ({ ok: false, status: 429, json: async () => ({}) }));
    const pa = servir();
    const ra = await tv.passe(CAT, now + 15 * MIN, { prendre: pa });
    const ea = tv.etat(now + 15 * MIN);
    eq(`${ra}|${pa.vus.length}|${ea.recul && ea.recul.pasS}|${ea.espn.ailleurs}`, 'null|0|120|1',
       'un 429 sur le football depuis la derniere passe : le tennis recule de 2 min SANS une requete (le tennis vendu ferme)');
    const pb = servir();
    eq(`${await tv.passe(CAT, now + 16 * MIN, { prendre: pb })}|${pb.vus.length}`, 'null|0', '... pendant le recul : 0 requete');
    await e.tableau('hockey/nhl', now, now, async () => ({ ok: false, status: 403, json: async () => ({}) }));
    const pc = servir();
    await tv.passe(CAT, now + 17 * MIN + 1000, { prendre: pc });
    eq(`${pc.vus.length}|${tv.etat(now + 17 * MIN + 1000).recul.pasS}`, '0|240', '... un nouveau 403 ailleurs (NHL) a la fin du recul : le recul double (4 min), toujours 0 requete');
    const pd = servir();
    const rd = await tv.passe(CAT, now + 21 * MIN + 2000, { prendre: pd });
    eq(`${rd instanceof Map}|${pd.vus.length > 0}|${tv.etat(now + 21 * MIN + 2000).recul}`, 'true|true|null', '... rien de neuf ailleurs ensuite : le tennis relit, le recul tombe');
    const ref403 = servir({ refuse: (tour) => tour === 'wta', statut: 403 });
    await tv.passe(CAT, now + 22 * MIN, { prendre: ref403 });
    const pe = servir();
    await tv.passe(CAT, now + 24 * MIN + 1000, { prendre: pe });
    ok(pe.vus.length > 0, 'les 403 du TENNIS ne comptent pas comme « ailleurs » (le recul propre suffit) : apres son recul, la passe relit');

    /* le recul plafonne a 30 min (2, 4, 8, 16, 30, 30) */
    let tt = now + 30 * MIN;
    const pas = [];
    for (let i = 0; i < 6; i++) {
      await tv.passe(CAT, tt, { prendre: servir({ refuse: () => true, statut: 429 }) });
      const r6 = tv.etat(tt).recul;
      pas.push(r6.pasS);
      tt += r6.pasS * 1000 + 1000;
    }
    eq(pas.join(','), '120,240,480,960,1800,1800', 'six 429 de suite : le recul double puis plafonne a 30 min (RECUL_MAX_MS)');

    /* le compte du jour, sur le volume : tics, requetes, refus, 403/429 par circuit, et « ailleurs » */
    tv.flush();
    const jc = JSON.parse(fs.readFileSync(tv.fichier(), 'utf8')).jours['2026-10-11'];
    ok(jc && jc.tics.actif >= 10 && jc.tics.observe === 2 && jc.wta.bloques >= 3 + 3 && jc.atp.bloques >= 6 && jc.ailleurs === 2 && jc.atp.requetes > 0,
       `le compte du jour est ECRIT au carnet (un redeploiement ne l efface pas) : ${JSON.stringify(jc)}`);
    tv.oublie();
    process.env.PARIS_TENNIS_VERROU = 'actif';
    eq(JSON.stringify(tv.etat(now).jours['2026-10-11']), JSON.stringify(jc), '... et relu tel quel apres un redemarrage (oublie)');

    /* T3 : un vrai passage pre -> in, vu en actif a 60 s d'ecart */
    tv.oublie();
    fs.rmSync(tv.fichier(), { force: true });
    const passage = (etatKK, dateKK, ls, valide) => servir({ evs: (tour) => {
      const evs = clone(BT[tour].events);
      if (tour === 'wta') {
        const c = evs.find((x) => x.id === '381-2026').groupings[0].competitions.find((x) => x.id === '185314');
        if (etatKK === 'in') { c.status.type = { name: 'STATUS_IN_PROGRESS', state: 'in' }; c.date = dateKK; c.timeValid = valide !== false; }
        if (ls) { c.competitors[0].linescores = [{ value: ls[0] }]; c.competitors[1].linescores = [{ value: ls[1] }]; }
      }
      return evs;
    } });
    const T3a = now + 40 * MIN;
    await tv.passe(CAT, T3a, { prendre: passage('pre') });
    await tv.passe(CAT, T3a + MIN, { prendre: passage('in', new Date(T3a - 2 * MIN).toISOString().replace(/:00\.000Z$/, 'Z'), [0, 0]) });
    const k3 = tv.carnet().rencontres.w1;
    eq(`${k3.dp === T3a}|${k3.en === T3a + MIN}|${k3.ed === T3a - 2 * MIN}|${k3.jx}|${k3.mo}|${k3.ec}`, 'true|true|true|0|a|60',
       'au carnet : derniere vue « pre », premiere vue « in » 60 s apres, l heure qu ESPN ecrit (2 min avant), 0 jeu, en actif');
    const m3 = tv.mesure(T('2026-10-12T04:00Z')).parCircuit.wta.passages;
    eq(`${m3.n}|${m3.apresUnJeu}|${m3.preApresDebutS.p95}|${m3.inApresDebutS.p95}`, '1|0|120|180',
       'la mesure : 1 passage, 0 apres un jeu, « pre » vu 120 s apres le debut ecrit par ESPN, « in » vu 180 s apres');
    /* le meme passage en observe (15 min d'ecart) ne compte pas pour T3 */
    tv.oublie();
    fs.rmSync(tv.fichier(), { force: true });
    process.env.PARIS_TENNIS_VERROU = 'observe';
    await tv.passe(CAT, T3a, { prendre: passage('pre') });
    await tv.passe(CAT, T3a + 15 * MIN, { prendre: passage('in', new Date(T3a + 5 * MIN).toISOString(), [1, 0]) });
    const k4 = tv.carnet().rencontres.w1;
    eq(`${k4.mo}|${k4.ec}|${k4.jx}|${tv.mesure(T('2026-10-12T04:00Z')).parCircuit.wta.passages.n}`, 'o|900|1|0',
       'observe : le passage est note (15 min, 1 jeu) mais ne compte pas pour T3 (ni actif, ni <= 150 s)');
    process.env.PARIS_TENNIS_VERROU = 'actif';
    /* en actif, mais ESPN ne donne qu'une DATE au premier « in » (timeValid faux) : pas d'heure de debut, pas de T3 */
    tv.oublie();
    fs.rmSync(tv.fichier(), { force: true });
    await tv.passe(CAT, T3a, { prendre: passage('pre') });
    await tv.passe(CAT, T3a + MIN, { prendre: passage('in', '2026-10-12T04:00Z', [0, 0], false) });
    const k5 = tv.carnet().rencontres.w1;
    eq(`${k5.en === T3a + MIN}|${k5.ed}|${tv.mesure(T('2026-10-12T04:00Z')).parCircuit.wta.passages.n}`, 'true|0|0',
       'premier « in » sans heure valide (04:00Z = une date) : le passage est vu, mais aucune heure de debut ESPN, il ne compte pas pour T3');
    /* une rencontre suivie APRES son heure : mesuree, jamais posee */
    tv.oublie();
    fs.rmSync(tv.fichier(), { force: true });
    const apresH = T('2026-10-12T03:00Z') + 2 * H;     // 2 h apres l'heure de w1
    const mApres = await tv.passe(CAT, apresH, { prendre: passage('pre') });
    ok(mApres instanceof Map && !mApres.has('w1') && !tv.carnet().rencontres.w1,
       'w1, 2 h apres son heure et jamais vue avant : ni posee (paris.ouvert la ferme a son heure), ni au carnet (pas de couverture)');
    /* vue avant son heure, puis perdue APRES : la couverture (T1) reste celle de la derniere passe AVANT l'heure */
    await tv.passe(CAT, T('2026-10-12T02:00Z'), { prendre: passage('pre') });
    await tv.passe(CAT, apresH, { prendre: sans185314 });
    const kA = tv.carnet().rencontres.w1;
    eq(`${kA.ap}|${kA.n}|${kA.a}|${kA.de === T('2026-10-12T02:00Z')}`, '1|1|1|true',
       'w1 appariee a 02:00Z (avant son heure), absente a 05:00Z (apres) : toujours appariee a la porte, rien de compte apres l heure');

    /* la porte T1 : seuils ecrits d'avance */
    tv.oublie();
    const st = tv.carnet();
    const remplit = (nb, app, tournois) => {
      st.rencontres = {};
      for (let i = 0; i < nb; i++) st.rencontres['r' + i] = { l: 'tennis_wta_t' + (i % tournois), c: 'wta', d: T('2026-10-10T12:00Z'), ap: i < app ? 1 : 0, n: 1, a: 1 };
    };
    remplit(100, 95, 3);
    eq(JSON.stringify(tv.etat(T('2026-10-11T12:00Z')).porte.T1.wta.ok), 'true', 'T1 : 95/100 sur 3 tournois -> passe (95 % pile, borne incluse)');
    remplit(100, 94, 3);
    eq(tv.etat(T('2026-10-11T12:00Z')).porte.T1.wta.ok, false, 'T1 : 94/100 -> ne passe pas');
    remplit(99, 99, 3);
    eq(tv.etat(T('2026-10-11T12:00Z')).porte.T1.wta.ok, null, 'T1 : 99 rencontres -> pas assez (null), meme a 100 %');
    remplit(100, 100, 2);
    eq(tv.etat(T('2026-10-11T12:00Z')).porte.T1.wta.ok, null, 'T1 : 2 tournois -> pas assez (null)');
    remplit(100, 100, 3);
    eq(tv.etat(T('2026-10-24T11:59Z')).porte.T1.wta.ok, true, 'T1 : 100/100 sur 3 tournois, 13 j 23 h 59 apres : compte encore');
    eq(tv.etat(T('2026-10-24T12:01Z')).porte.T1.wta.ok, null, 'T1 : au-dela de 14 jours, les rencontres ne comptent plus');
    eq(tv.etat(T('2026-10-11T12:00Z')).porte.T1.atp.ok, null, 'T1 par circuit : l atp sans rencontre -> null');

    /* T1, la justesse : le vainqueur ESPN de la rencontre appariee contre le resultat lu par l'ombre du reglement */
    const regJ = require('./reglement_journal');
    const ombre = (res) => { fs.writeFileSync(path.join(BAC, 'reglement_journal.json'), JSON.stringify({ v: 1, ombre: res })); regJ.oublie(); };
    remplit(100, 100, 3);
    st.rencontres.r1.vq = '1'; st.rencontres.r2.vq = '2'; st.rencontres.r3.vq = '1';
    ombre({ r1: { dernierFini: { resultat: '1' } }, r2: { alors: { resultat: '2' } }, r9: { dernierFini: { resultat: '2' } } });
    const j1 = tv.etat(T('2026-10-11T12:00Z'));
    eq(`${j1.porte.T1.wta.ok}|${j1.mesure.parCircuit.wta.justesse.comparees}|${j1.mesure.parCircuit.wta.justesse.desaccords}`, 'true|2|0',
       'T1 : 2 rencontres comparees au reglement (r3 sans resultat, r9 sans vainqueur ESPN), 0 desaccord -> passe');
    ok(/matching checked on 2 settled games/.test(j1.porte.T1.wta.raison), '... et le nombre compare est dit');
    ombre({ r1: { dernierFini: { resultat: '2' } }, r2: { alors: { resultat: '2' } } });
    const j2 = tv.etat(T('2026-10-11T12:00Z'));
    eq(`${j2.porte.T1.wta.ok}|${j2.mesure.parCircuit.wta.justesse.ids.join(',')}`, 'false|r1',
       'T1 : UN desaccord (r1 : ESPN dit 1, le reglement 2) -> ne passe pas, quelle que soit la couverture');
    remplit(10, 10, 3); st.rencontres.r1.vq = '1';
    eq(tv.etat(T('2026-10-11T12:00Z')).porte.T1.wta.ok, false, '... meme avec trop peu de rencontres pour la couverture : un faux appariement ferme');
    fs.rmSync(path.join(BAC, 'reglement_journal.json')); regJ.oublie();

    /* T2 : les 7 derniers jours complets du carnet */
    const ref = T('2026-10-20T12:00Z');
    const remplitJours = (nb, modif) => {
      st.jours = {};
      for (let i = 1; i <= nb; i++) {
        const j = new Date(ref - i * 24 * H).toISOString().slice(0, 10);
        st.jours[j] = { tics: { actif: 1300 }, ailleurs: 0, atp: { requetes: 4000, refus: 40, bloques: 0 }, wta: { requetes: 4000, refus: 0, bloques: 0 } };
        if (modif) modif(st.jours[j], i);
      }
    };
    const T2 = () => tv.etat(ref).porte.T2;
    remplitJours(7);
    eq(`${T2().atp.ok}|${T2().wta.ok}`, 'true|true', 'T2 : 7 jours pleins, refus 1 % pile (borne incluse), aucun 403/429 -> passe');
    remplitJours(7, (x, i) => { if (i === 3) x.atp.refus = 41; });
    eq(`${T2().atp.ok}|${T2().wta.ok}`, 'false|true', 'T2 : 1,03 % de refus un jour sur l atp -> l atp ne passe pas, la wta si');
    remplitJours(7, (x, i) => { if (i === 5) x.ailleurs = 1; });
    eq(`${T2().atp.ok}|${T2().wta.ok}`, 'false|false', 'T2 : un 403/429 sur un AUTRE tableau (le football) un seul jour -> aucun circuit ne passe');
    remplitJours(7, (x, i) => { if (i === 2) x.wta.bloques = 1; });
    eq(`${T2().atp.ok}|${T2().wta.ok}`, 'true|false', 'T2 : un 403/429 du tableau wta -> la wta ne passe pas');
    remplitJours(7, (x, i) => { if (i === 7) x.tics.actif = 1199; });
    eq(T2().atp.ok, null, 'T2 : un jour a 1 199 tics actifs (moins de 20 h) -> pas encore (null)');
    remplitJours(6);
    eq(T2().atp.ok, null, 'T2 : 6 jours -> pas encore');
    remplitJours(7, (x, i) => { if (i === 4) { x.atp.requetes = 0; x.atp.refus = 0; } });
    eq(`${T2().atp.ok}|${T2().wta.ok}`, 'null|true', 'T2 : un jour sans requete atp -> null pour l atp seule');
    remplitJours(8, (x, i) => { if (i === 8) x.ailleurs = 3; });
    eq(T2().atp.ok, true, 'T2 : un 429 il y a 8 jours (hors des 7 derniers) ne compte plus');
    st.jours = {};

    /* T3 : 100 passages, 5 % apres un jeu au plus, « pre » au plus 300 s apres le debut ESPN au 95e centile */
    const remplitT3 = (nb, unJeu, tard, modif) => {
      st.rencontres = {};
      const d0 = T('2026-10-10T12:00Z');
      for (let i = 0; i < nb; i++) {
        const pad = i < tard ? 900 : 60;
        st.rencontres['t' + i] = { l: 'tennis_atp_t' + (i % 3), c: 'atp', d: d0, ap: 1, n: 1, a: 1, et: 'in', mo: 'a', ec: 60,
                                   ed: d0 - H, dp: d0 - H + pad * 1000, en: d0 - H + pad * 1000 + 60000, jx: i < unJeu ? 1 : 0 };
        if (modif) modif(st.rencontres['t' + i], i);
      }
    };
    const T3 = () => tv.etat(T('2026-10-11T12:00Z')).porte.T3.atp;
    remplitT3(100, 5, 5);
    eq(T3().ok, true, 'T3 : 100 passages, 5 % deja un jeu (borne incluse), « pre » vu 15 min apres le debut sur 5 % -> p95 = 60 s, passe');
    remplitT3(100, 6, 0);
    eq(T3().ok, false, 'T3 : 6 % des passages deja a un jeu -> ne passe pas');
    remplitT3(100, 0, 6);
    eq(T3().ok, false, 'T3 : « pre » vu 15 min apres le debut ESPN sur 6 % -> p95 = 900 s > 300 s, ne passe pas');
    remplitT3(99, 0, 0);
    eq(T3().ok, null, 'T3 : 99 passages -> pas encore');
    remplitT3(100, 0, 0, (r, i) => { if (i === 0) r.ec = 151; });
    eq(T3().ok, null, 'T3 : un passage a 151 s d ecart (une passe ratee de trop) ne compte pas -> 99, pas encore');
    remplitT3(100, 0, 0, (r, i) => { if (i === 0) r.mo = 'o'; });
    eq(T3().ok, null, '... un passage vu en observe non plus');
    remplitT3(100, 0, 0, (r, i) => { if (i === 0) r.ed = 0; });
    eq(T3().ok, null, '... ni un passage sans heure ESPN valide');
    remplitT3(100, 0, 0, (r, i) => { if (i === 0) r.et = 'post'; });
    eq(T3().ok, null, '... ni une rencontre vue directement finie');
    eq(tv.centile([5, 1, 4, 2, 3], 0.95), 5, 'centile au rang le plus proche : le 95e de 5 valeurs est la plus grande');

    /* le carnet : illisible mis de cote, lecture refusee jamais ecrasee */
    tv.oublie();
    fs.writeFileSync(tv.fichier(), '{pas du json');
    const lu = tv.carnet();
    ok(lu && Object.keys(lu.rencontres).length === 0 && fs.readdirSync(BAC).some((x) => /^tennis_verrou\.json\.illisible-/.test(x)),
       'carnet illisible : mis de cote (.illisible-…), on repart vide');
    tv.oublie();
    fs.rmSync(tv.fichier(), { force: true });
    fs.mkdirSync(tv.fichier());
    eq(tv.carnet(), null, 'lecture refusee (un dossier a sa place) : null, rien n est note');
    const pr = await tv.passe(CAT, now, { prendre: servir() });
    ok(pr instanceof Map && pr.size === 5 && fs.statSync(tv.fichier()).isDirectory(), '... la passe pose quand meme le verrou, et le fichier n est jamais ecrase');
    fs.rmSync(tv.fichier(), { recursive: true, force: true });
    tv.oublie();

    /* le carnet : purge a 14 jours a l'ecriture, et toujours en deux temps (.tmp, puis renomme) */
    const vieux = { l: WTA, c: 'wta', d: Date.now() - 15 * 24 * H, n: 1, a: 1, ap: 1 }, recent = Object.assign({}, vieux, { d: Date.now() - 2 * 24 * H });
    fs.writeFileSync(tv.fichier(), JSON.stringify({ v: 1, rencontres: { vieux, recent }, jours: { '2020-01-01': { tics: { actif: 1 } } } }));
    const ecrits = [];
    const wfs = fs.writeFileSync;
    fs.writeFileSync = function (p, ...reste) { ecrits.push(String(p)); return wfs.call(this, p, ...reste); };
    try { await tv.passe(CAT, now, { prendre: servir() }); tv.flush(); } finally { fs.writeFileSync = wfs; }
    const purge = JSON.parse(fs.readFileSync(tv.fichier(), 'utf8'));
    ok(!purge.rencontres.vieux && purge.rencontres.recent && !purge.jours['2020-01-01'] && purge.rencontres.w1,
       'purge a l ecriture : une rencontre de 15 jours et un jour de 2020 sortent du fichier ; une de 2 jours et la passe restent');
    const versCarnet = ecrits.filter((x) => /tennis_verrou/.test(x));
    ok(versCarnet.length > 0 && versCarnet.every((x) => /tennis_verrou\.json\.tmp$/.test(x)),
       `chaque ecriture du carnet vise le .tmp, jamais le fichier lui-meme (${versCarnet.length} ecriture(s))`);
    fs.rmSync(tv.fichier(), { force: true });
    tv.oublie();

    /* planifie : actif pose, observe ne pose rien ; la ligne de demarrage */
    const poses = [];
    /* UNE base, lue avant le tic : le tic lit Date.now() APRES (t >= base), donc a2, posee a base + 36 h pile,
       reste dans l'horizon (t + 36 h). Relire Date.now() dans le catalogue la faisait sortir quand l'horloge
       avancait d'une milliseconde entre les deux lectures (2 rouges sur 14, verification du 11/10). */
    const base = Date.now();
    const h = tv.planifie({ catalogue: () => CAT.map((m) => Object.assign({}, m, { debut: base + (m.debut - now) })), pose: (x, t) => poses.push([x, t]), minuteries: false,
      prendre: servir({ evs: (tour) => { const evs = clone(BT[tour].events); for (const ev of evs) for (const g of ev.groupings) for (const c of g.competitions) c.date = new Date(base + (T(c.date) - now)).toISOString(); return evs; } }) });
    ok(h && typeof h.tic === 'function' && h.mode === 'actif', 'actif : planifie rend la poignee');
    await h.tic();
    eq(`${poses.length}|${poses[0] && [...poses[0][0].keys()].sort().join(',')}`, '1|a1,a2,w1,w2,w3', 'un tic actif POSE la Map (le serveur la donne a paris.poseHeuresReelles)');
    h.arrete();
    process.env.PARIS_TENNIS_VERROU = 'observe';
    const h2 = tv.planifie({ catalogue: () => CAT, pose: () => poses.push('jamais'), minuteries: false, prendre: servir() });
    await h2.tic();
    eq(poses.length, 1, 'un tic observe ne pose RIEN');
    h2.arrete();
    const traces = [];
    console.log = (...a) => traces.push(a.join(' '));
    try {
      for (const v of [undefined, 'observe', 'actif', 'oui']) {
        if (v === undefined) delete process.env.PARIS_TENNIS_VERROU; else process.env.PARIS_TENNIS_VERROU = v;
        tv.planifie({ catalogue: () => [], minuteries: false });
      }
    } finally { console.log = logVrai; }
    ok(/^\[tennis\] verrou d heure reelle : ETEINT \(PARIS_TENNIS_VERROU vide\) : aucune requete, le tennis vendu au marche reste SUSPENDU$/.test(traces[0]), 'demarrage, vide : ETEINT, dit');
    ok(/OBSERVE : tableaux ESPN atp\/wta toutes les 15 min.*rien n est pose ni vendu de plus, 0 credit/.test(traces[1]), 'demarrage, observe : dit');
    ok(/ACTIF : .*toutes les 60 s.*moins de 150 s \(vendu : tennis_wta_\*\)/.test(traces[2]), 'demarrage, actif : la cadence, l age maximal et ce qui est vendu');
    ok(/ETEINT.*PARIS_TENNIS_VERROU « oui » IGNORE/.test(traces[3]), 'demarrage, valeur inconnue : IGNOREE et dite');
    delete process.env.PARIS_TENNIS_VERROU;
    tv.oublie();
  }

  // ================== 7. LE VRAI SERVEUR
  logVrai('\n-- 7. le vrai serveur (processus enfant) : server.js branche la minuterie, pose, ferme, dit --');
  {
    const { spawnSync } = require('child_process');
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete env[k];
    for (const [arg, nom] of [['--cablage', 'actif'], ['--cablage-eteint', 'eteint']]) {
      const c = spawnSync(process.execPath, [__filename, arg], { env, encoding: 'utf8', timeout: 180000 });
      const lignes = String(c.stdout || '').split('\n');
      for (const l of lignes) if (/^ {2}ok {2}/.test(l)) { n++; logVrai(l.replace(/^ {2}ok {2}/, `  ok  [serveur ${nom}] `)); }
      eq(`${c.status}|${lignes.some((l) => /^CABLAGE FINI$/.test(l))}`, '0|true',
         `le serveur enfant (${nom}) a fini vert` + (c.status ? ' — ' + String(c.stdout || '').split('\n').filter((l) => /RATE|Error/.test(l)).slice(0, 3).join(' / ') + String(c.stderr || '').slice(0, 400) : ''));
    }
  }

  fini = true;
  logVrai(`\ntennis_verrou.test.js : ${n} verifications OK`);
  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (err) { /* rien */ }
})().catch((err) => { logVrai('RATE ' + ((err && err.stack) || err)); process.exit(1); });
}

/*
 * ================== LE CABLAGE DANS LE VRAI SERVEUR (processus enfant) ==================
 * Le serveur tourne DANS ce processus (comme paris_en_jeu_cablage.test.js) :
 * `fetch` est remplace AVANT tout `require` — un faux ESPN tennis, rien
 * d'autre. La minuterie du module est coupee (`minuteries: false`) : l'essai
 * appelle le tic que server.js a arme, avec SES dependances.
 */
/* un port LIBRE, donne par le systeme (comme agent_route.test.js) : 9700 + pid % 90 pouvait tomber sur
   celui d'une autre suite lancee en meme temps (cinema_serveur : 9500 + pid % 300) */
function portLibre() { return new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => r(q)); }); }); }

async function cablage() {
  const T0 = Date.now();
  const PORT = await portLibre();
  Object.assign(process.env, {
    PORT: String(PORT), RPC_URL: '', ADMIN_KEY: 'cle-de-banc-tennis',
    AI_COLONIE: '0', POLY_PAPIER: '0', DEPLOIEMENT_V4: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', MONITEUR_URL: '',
    PARIS_TENNIS_VERROU: 'actif', PARIS_PRIX_LIGUES: 'soccer_epl,tennis_wta_*',
  });
  const DEBUT = T0 + 2 * H;
  const match = (id, ligue, dom, ext, extra) => Object.assign({ id, sport: 'tennis', competition: 'Tennis', domicile: dom, exterieur: ext,
    debut: new Date(DEBUT).toISOString(), marches: { '1n2': { cotes: { 1: 1.8, 2: 2.0 } } }, cotesGenerees: true,
    source: { fournisseur: 'the-odds-api', ligue, evenement: 'ev-' + id } }, extra || {});
  const prix = { ref: 'pinnacle', t: new Date(T0 - 5 * MIN).toISOString(), livres: 3, p: { 1: 0.53, 2: 0.47 } };
  fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify({ sports: [{ cle: 'tennis', nom: 'Tennis', actif: true }], matchs: [
    match('kar-kal', WTA, 'Sonay Kartal', 'Anhelina Kalinina', { prixMarche: prix }),
    match('fer-ale', WTA, 'Leylah Fernandez', 'Ekaterina Alexandrova', { prixMarche: prix }),
    match('rud-tie', ATP, 'Casper Ruud', 'Learner Tien'),
  ] }));
  /* le faux reseau : les deux tableaux tennis, dates ramenees a DEBUT ; tout le reste refuse */
  const fetchVrai = global.fetch;
  const VUS = { espn: 0, refuses: 0 };
  const etat = { kk: 'pre', muet: false };
  global.fetch = async (u0, op) => {
    const u = String(u0);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return fetchVrai(u0, op);
    const m = /site\.api\.espn\.com\/apis\/site\/v2\/sports\/tennis\/(atp|wta)\/scoreboard\?dates=\d{8}$/.exec(u);
    if (m) {
      VUS.espn++;
      if (etat.muet) throw new Error('ESPN muet');
      const evs = clone(BT[m[1]].events);
      for (const ev of evs) for (const g of ev.groupings || []) for (const c of g.competitions || []) {
        if (['185314', '185336', '184932'].includes(String(c.id))) c.date = new Date(DEBUT).toISOString().replace(/:00\.000Z$/, 'Z');
        if (String(c.id) === '185314') c.status.type.state = etat.kk;
      }
      return { ok: true, status: 200, json: async () => ({ events: evs }) };
    }
    VUS.refuses++;
    throw new Error('aucune requete reseau dans cet essai');
  };
  const traces = [];
  console.log = (...a) => { traces.push(a.map(String).join(' ')); };
  const tvm = require('./tennis_verrou');
  let DEPS = null, POIGNEE = null;
  { const vrai = tvm.planifie; tvm.planifie = (d) => { DEPS = d; POIGNEE = vrai(Object.assign({}, d, { minuteries: false })); return POIGNEE; }; }
  const paris = require('./paris');
  require('./server');
  try {
    for (let k = 0; k < 100 && !POIGNEE; k++) await new Promise((r) => setTimeout(r, 100));
    const base = 'http://127.0.0.1:' + process.env.PORT;
    for (let k = 0; k < 50; k++) { try { if ((await fetchVrai(base + '/health')).ok) break; } catch (err) { /* pas encore */ } await new Promise((r) => setTimeout(r, 100)); }
    const admin = { headers: { 'x-admin-key': process.env.ADMIN_KEY } };

    ok(!!POIGNEE && POIGNEE.mode === 'actif', 'PARIS_TENNIS_VERROU=actif : server.js arme le verrou du tennis');
    ok(traces.some((x) => /^\[tennis\] verrou d heure reelle : ACTIF .*\(vendu : tennis_wta_\*\)/.test(x)), 'la ligne de demarrage est dite (ACTIF, ce qui est vendu)');
    eq(DEPS.catalogue().map((x) => x.id).sort().join(','), 'fer-ale,kar-kal,rud-tie', '`catalogue` : les rencontres du catalogue servi');
    const kk = () => paris.match('kar-kal'), fa = () => paris.match('fer-ale'), rt = () => paris.match('rud-tie');
    eq(`${paris.ouvert(kk(), Date.now())}|${paris.ouvert(fa(), Date.now())}|${paris.ouvert(rt(), Date.now())}`, 'false|false|true',
       'avant toute passe : les deux rencontres VENDUES au marche sont fermees (aucun appariement), l Elo ouvert');

    await POIGNEE.tic();
    eq(`${paris.ouvert(kk(), Date.now())}|${paris.ouvert(fa(), Date.now())}|${paris.ouvert(rt(), Date.now())}`, 'true|true|true',
       'un tic (server.js -> pose -> paris.poseHeuresReelles) : appariees « pre », les deux vendues OUVRENT au prix du marche');
    const cal = await (await fetchVrai(base + '/paris/calendrier')).json();
    eq((cal.matchs.find((x) => x.id === 'kar-kal') || {}).ouvert, true, '/paris/calendrier : Kartal - Kalinina proposee');
    const imp = await (await fetchVrai(base + '/paris/import', admin)).json();
    const tw = imp.tennis && imp.tennis.passe && imp.tennis.passe.parTournoi[WTA];
    eq(`${imp.tennis && imp.tennis.mode}|${tw && tw.appariees}/${tw && tw.rencontres}|${imp.tennis && JSON.stringify(imp.tennis.passe.vendues)}`,
       'actif|2/2|{"rencontres":2,"appariees":2}', '/paris/import -> tennis : mode, couverture du tournoi, vendues appariees');
    ok(imp.tennis.porte && imp.tennis.porte.T1 && imp.tennis.porte.T1.wta.ok === null, '... et la porte T1 (pas assez de rencontres : null)');

    etat.kk = 'in';
    await POIGNEE.tic();
    eq(`${paris.ouvert(kk(), Date.now())}|${paris.ouvert(fa(), Date.now())}`, 'false|true', 'ESPN voit Kartal - Kalinina EN JEU, 2 h avant le catalogue : FERMEE ; l autre reste ouverte');
    const cal2 = await (await fetchVrai(base + '/paris/calendrier')).json();
    ok(!cal2.matchs.some((x) => x.id === 'kar-kal'), '/paris/calendrier : elle n est plus proposee');

    etat.muet = true;
    const t = Date.now();
    await POIGNEE.tic();
    eq(`${paris.ouvert(fa(), t)}|${paris.ouvert(fa(), t + 151000)}`, 'true|false', 'ESPN muet : rien de pose ; Fernandez - Alexandrova ferme quand son appariement passe 150 s');
    const imp2 = await (await fetchVrai(base + '/paris/import', admin)).json();
    ok(imp2.tennis.espn.refus >= 1 && imp2.espnRefus['tennis/wta'] && imp2.espnRefus['tennis/wta'].refus >= 1,
       'les refus sont comptes (tennis.espn et espnRefus par tableau)');
    ok(VUS.espn >= 4, `ESPN lu par la seule minuterie du tennis (${VUS.espn} requetes)`);

    let arretes = 0;
    const vraiArrete = POIGNEE.arrete;
    POIGNEE.arrete = () => { arretes++; return vraiArrete.call(POIGNEE); };
    const exitVrai = process.exit;
    process.exit = () => {};
    try { process.emit('SIGTERM'); } finally { process.exit = exitVrai; }
    eq(arretes, 1, 'SIGTERM -> shutdown() : le verrou du tennis est arrete, une fois');
    fini = true;
    logVrai('CABLAGE FINI');
    try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (err) { /* rien */ }
    process.exit(0);
  } catch (err) {
    logVrai('RATE ' + ((err && err.stack) || err));
    logVrai(traces.filter((x) => /tennis|Error|erreur/i.test(x)).slice(-10).join('\n'));
    process.exit(1);
  }
}

/*
 * ================== LE VRAI SERVEUR, VERROU VIDE (processus enfant, relecture du 11/10) ==================
 * La promesse « vide = 0 minuterie, 0 requete, 0 fichier » tenue dans server.js
 * lui-meme, pas seulement dans le module : PARIS_TENNIS_VERROU n'est pas pose,
 * la VRAIE `planifie` est appelee (minuteries comprises), et `fetch` compte
 * toute URL des tableaux atp/wta pendant deux secondes.
 */
async function cablageEteint() {
  const T0 = Date.now();
  const PORT = await portLibre();
  Object.assign(process.env, {
    PORT: String(PORT), RPC_URL: '', ADMIN_KEY: 'cle-de-banc-tennis',
    AI_COLONIE: '0', POLY_PAPIER: '0', DEPLOIEMENT_V4: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', MONITEUR_URL: '',
    PARIS_PRIX_LIGUES: 'soccer_epl,tennis_wta_*',
  });
  delete process.env.PARIS_TENNIS_VERROU;
  const DEBUT = T0 + 2 * H;
  const match = (id, ligue, dom, ext, extra) => Object.assign({ id, sport: 'tennis', competition: 'Tennis', domicile: dom, exterieur: ext,
    debut: new Date(DEBUT).toISOString(), marches: { '1n2': { cotes: { 1: 1.8, 2: 2.0 } } }, cotesGenerees: true,
    source: { fournisseur: 'the-odds-api', ligue, evenement: 'ev-' + id } }, extra || {});
  const prix = { ref: 'pinnacle', t: new Date(T0 - 5 * MIN).toISOString(), livres: 3, p: { 1: 0.53, 2: 0.47 } };
  fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify({ sports: [{ cle: 'tennis', nom: 'Tennis', actif: true }], matchs: [
    match('kar-kal', WTA, 'Sonay Kartal', 'Anhelina Kalinina', { prixMarche: prix }),
    match('rud-tie', ATP, 'Casper Ruud', 'Learner Tien'),
  ] }));
  const fetchVrai = global.fetch;
  const VUS = { tennis: 0 };
  global.fetch = async (u0, op) => {
    const u = String(u0);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return fetchVrai(u0, op);
    if (/\/sports\/tennis\/(atp|wta)\/scoreboard/.test(u)) VUS.tennis++;
    throw new Error('aucune requete reseau dans cet essai');
  };
  const traces = [];
  console.log = (...a) => { traces.push(a.map(String).join(' ')); };
  const tvm = require('./tennis_verrou');
  let appele = 0, POIGNEE = 'pas encore';
  { const vrai = tvm.planifie; tvm.planifie = (d) => { appele++; POIGNEE = vrai(d); return POIGNEE; }; }
  const paris = require('./paris');
  require('./server');
  try {
    for (let k = 0; k < 100 && !appele; k++) await new Promise((r) => setTimeout(r, 100));
    const base = 'http://127.0.0.1:' + process.env.PORT;
    for (let k = 0; k < 50; k++) { try { if ((await fetchVrai(base + '/health')).ok) break; } catch (err) { /* pas encore */ } await new Promise((r) => setTimeout(r, 100)); }
    const admin = { headers: { 'x-admin-key': process.env.ADMIN_KEY } };

    eq(`${appele}|${POIGNEE}`, '1|null', 'PARIS_TENNIS_VERROU vide : server.js appelle la VRAIE planifie, qui ne rend rien (aucune minuterie armee)');
    ok(traces.some((x) => /^\[tennis\] verrou d heure reelle : ETEINT \(PARIS_TENNIS_VERROU vide\)/.test(x)), 'la ligne de demarrage dit ETEINT');
    await new Promise((r) => setTimeout(r, 2000));
    eq(VUS.tennis, 0, 'deux secondes de serveur : 0 requete vers tennis/atp ou tennis/wta');
    const imp = await (await fetchVrai(base + '/paris/import', admin)).json();
    eq(`${imp.tennis && imp.tennis.mode}|${imp.tennis && imp.tennis.carnet.rencontres}|${imp.tennis && imp.tennis.passe}`, 'off|null|null',
       '/paris/import -> tennis : mode off, aucun carnet lu, aucune passe');
    eq(fs.readdirSync(BAC).filter((x) => /tennis_verrou/.test(x)).length, 0, 'aucun fichier tennis_verrou.json ecrit sur le volume');
    eq(`${paris.ouvert(paris.match('kar-kal'), Date.now())}|${paris.ouvert(paris.match('rud-tie'), Date.now())}`, 'false|true',
       'comme avant ce lot : le tennis VENDU au marche reste suspendu (venteImpossible), l Elo ouvert');
    fini = true;
    logVrai('CABLAGE FINI');
    process.exit(0);
  } catch (err) {
    logVrai('RATE ' + ((err && err.stack) || err));
    logVrai(traces.filter((x) => /tennis|Error|erreur/i.test(x)).slice(-10).join('\n'));
    process.exit(1);
  }
}
