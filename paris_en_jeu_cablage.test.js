'use strict';
/*
 * LE CABLAGE DU DIRECT EN JEU DANS server.js (lot 7 de la cle 20K, 11/10/2026).
 *
 * `paris_en_jeu.test.js` tient le MODULE avec des dependances fabriquees a la
 * main. Ce fichier-ci tient la COUTURE : ce que server.js lui passe vraiment,
 * avec PARIS_EN_JEU=observe — la seule configuration ou il tourne. Deux
 * moities correctes separement peuvent etre mal recousues (meme raison que
 * paris_auto.test.js) :
 *  1. `cle`, `appel` (LE garde-fou du socle), `quota` (la part du jour et la
 *     reserve de la CLASSE 2, 80), `projection`, `catalogue`, `estRegle` ;
 *  2. la passe ESPN PARTAGEE (`directSuivies`) : elle passe par le `prendre`
 *     du module (ses refus a part), nourrit le cache de l'affichage
 *     (`/paris/calendrier` -> `directs`) et le SECOND VERROU (`paris.ouvert`
 *     ferme une rencontre qu'ESPN voit en jeu avant notre heure) ;
 *  3. de bout en bout, un tic du vrai module dans le vrai serveur : admission,
 *     releve /odds par le vrai `appel` comptee en classe 2, ESPN lu, journal ;
 *  4. `/paris/import` (admin) porte `enJeu` en mode `observe`.
 *
 * Le serveur tourne DANS ce processus (comme paris_auto.test.js) : `fetch` est
 * remplace AVANT tout `require`, il sert un faux The Odds API et un faux ESPN
 * et REFUSE tout le reste. Aucun reseau, aucun credit. Les minuteries du
 * module sont coupees (`minuteries: false`) : l'essai appelle le tic lui-meme.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
/* ---- LE SECOND DEMARRAGE : SANS ODDS_API_KEY (mutation du 11/10/2026, V01) ----
 * `cle: true` au lieu de `!!process.env.ODDS_API_KEY` survivait : ce processus
 * a toujours une cle. Le meme fichier, relance par l'essai avec `--sans-cle`,
 * demarre un second vrai serveur SANS cle et dit ce que server.js a passe. */
const SANS_CLE = process.argv.includes('--sans-cle');
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'en-jeu-cablage-'));
Object.assign(process.env, {
  PORT: String((SANS_CLE ? 9600 : 9500) + (process.pid % 90)), DATA_DIR: BAC, RPC_URL: '', ADMIN_KEY: 'cle-de-banc-cablage',
  ODDS_API_KEY: 'cle-de-banc-cablage', ODDS_API_TOTAL: '20000', PARIS_EN_JEU: 'observe',
  AI_COLONIE: '0', POLY_PAPIER: '0', DEPLOIEMENT_V4: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', MONITEUR_URL: '',
});
if (SANS_CLE) delete process.env.ODDS_API_KEY;

let n = 0;
const logVrai = console.log;
const ok = (c, m) => { assert.ok(c, m); n++; logVrai('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); n++; logVrai('  ok  ' + m); };
/* ---- UN ESSAI QUI S'ARRETE AVANT SA FIN N'EST PAS VERT ----
 * Une promesse jamais tenue (une releve qui n'aboutit pas) vide la boucle de
 * Node, qui sort alors en SILENCE avec le code 0 : la mutation du 11/10/2026
 * (tic reentrant) passait ainsi pour verte sans avoir fini. */
let fini = false;
process.on('exit', (c) => { if (c === 0 && !fini) { console.error('RATE : l essai s est arrete avant sa fin (' + n + ' verifications)'); process.exitCode = 1; } });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60000;
const T0 = Date.now();
const jour = new Date(T0).toISOString().slice(0, 10);

/* ---- LE CATALOGUE : une rencontre suivie commencee il y a 10 min, une autre dans 50 min ---- */
const SPORTS = [{ cle: 'foot', nom: 'Football', actif: true }];
const match = (id, dom, ext, debut) => ({ id, sport: 'foot', competition: 'La Liga', domicile: dom, exterieur: ext,
  debut: new Date(debut).toISOString(), marches: { '1n2': { cotes: { 1: 1.9, N: 3.5, 2: 4.2 } } },
  source: { fournisseur: 'the-odds-api', ligue: 'soccer_spain_la_liga', evenement: 'ev-' + id } });
const DEBUT_BAR = T0 - 10 * MIN, DEBUT_OSA = T0 + 50 * MIN;
fs.writeFileSync(path.join(BAC, 'paris_catalogue.json'), JSON.stringify({ sports: SPORTS,
  matchs: [match('bar-get', 'Barcelona', 'Getafe', DEBUT_BAR), match('osa-rma', 'Osasuna', 'Real Madrid', DEBUT_OSA)] }));
/* le compteur du socle : 123 credits deja depenses aujourd'hui, 15 000 restants, vu ce mois-ci */
fs.writeFileSync(path.join(BAC, 'odds_quota.json'), JSON.stringify({ reste: 15000, utilise: 5000, vu: new Date(T0).toISOString(),
  depenseDuJour: 123, jour }));

/* ---- LE RESEAU : un faux The Odds API (les /odds du direct seulement), un faux ESPN, rien d'autre ---- */
const fetchVrai = global.fetch;
const VUS = { odds: [], espn: 0, refuses: [] };
let osasunaEnJeu = false;
const espnEv = (id, dom, ext, debut, h, a, clock) => ({ id, date: new Date(debut).toISOString(),
  status: { clock, displayClock: Math.floor(clock / 60) + "'", period: 1,
            type: { name: 'STATUS_FIRST_HALF', state: 'in', completed: false, shortDetail: Math.floor(clock / 60) + "'" } },
  competitions: [{ competitors: [{ homeAway: 'home', score: String(h), team: { id: id + '1', displayName: dom } },
                                 { homeAway: 'away', score: String(a), team: { id: id + '2', displayName: ext } }],
                   details: h ? [{ type: { text: 'Goal' }, clock: { value: 300 }, team: { id: id + '1' }, scoringPlay: true, redCard: false }] : [] }] });
global.fetch = async (u0, op) => {
  const u = String(u0);
  if (/^http:\/\/127\.0\.0\.1:/.test(u)) return fetchVrai(u0, op);
  if (/site\.api\.espn\.com\/apis\/site\/v2\/sports\/soccer\/esp\.1\/scoreboard/.test(u)) {
    VUS.espn++;
    const evs = [espnEv('e1', 'Barcelona', 'Getafe', DEBUT_BAR, 1, 0, 600)];
    if (osasunaEnJeu) evs.push(espnEv('e2', 'Osasuna', 'Real Madrid', T0 - 2 * MIN, 0, 0, 120));
    return { ok: true, status: 200, json: async () => ({ events: evs }) };
  }
  const x = new URL(u);
  if (x.hostname === 'api.the-odds-api.com' && /\/sports\/soccer_spain_la_liga\/odds$/.test(x.pathname) && x.searchParams.get('eventIds')) {
    VUS.odds.push({ ids: x.searchParams.get('eventIds'), markets: x.searchParams.get('markets'), regions: x.searchParams.get('regions') });
    const lu = new Date(Date.now() - 3000).toISOString();
    const evs = [{ id: 'ev-bar-get', home_team: 'Barcelona', away_team: 'Getafe', commence_time: new Date(DEBUT_BAR).toISOString(),
                   bookmakers: [{ key: 'betfair_ex_eu', last_update: lu, markets: [{ key: 'h2h', last_update: lu, outcomes: [
                     { name: 'Barcelona', price: 1.3 }, { name: 'Draw', price: 5.2 }, { name: 'Getafe', price: 11 }] }] }] }];
    return { ok: true, status: 200, json: async () => evs, text: async () => JSON.stringify(evs),
             headers: { get: (k) => ({ 'x-requests-remaining': '14999', 'x-requests-used': '5001', 'x-requests-last': '1' }[String(k).toLowerCase()] || null) } };
  }
  VUS.refuses.push(u.replace(/apiKey=[^&]+/, 'apiKey=***'));
  throw new Error('aucune requete reseau dans cet essai');
};

/* ---- LES LIGNES DU SERVEUR : gardees pour les essais qui les lisent, tues a l'ecran ---- */
const traces = [];
console.log = (...a) => { traces.push(a.map(String).join(' ')); };
const dit = (re) => traces.some((s) => re.test(s));

/* ---- CE QUE server.js PASSE AU MODULE, capte avant son demarrage ---- */
const enJeu = require('./paris_en_jeu');
let DEPS = null, POIGNEE = null;
{
  const vrai = enJeu.planifie;
  enJeu.planifie = (d) => { DEPS = d; POIGNEE = vrai(Object.assign({}, d, { minuteries: false })); return POIGNEE; };
}
const imp = require('./paris_import');
const paris = require('./paris');
require('./server');

(async () => {
  for (let k = 0; k < 100 && !DEPS; k++) await dors(100);
  if (SANS_CLE) {
    logVrai('SANS-CLE ' + JSON.stringify({ cle: DEPS ? DEPS.cle : 'absent', actif: POIGNEE ? POIGNEE.actif : 'absent',
                                           dit: traces.some((x) => /^\[en-jeu\] sans ODDS_API_KEY : inerte/.test(x)) }));
    fini = true;
    try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* rien */ }
    process.exit(0);
  }
  const base = 'http://127.0.0.1:' + process.env.PORT;
  for (let k = 0; k < 50; k++) { try { if ((await fetchVrai(base + '/health')).ok) break; } catch (e) { /* pas encore */ } await dors(100); }

  logVrai('\n-- 1. ce que server.js passe au module --');
  ok(!!DEPS && POIGNEE && POIGNEE.actif === true, 'PARIS_EN_JEU=observe et une cle : le serveur branche le module, actif');
  ok(dit(/^\[en-jeu\] OBSERVATION : 8 club\(s\).*rien de vendu ne change/), 'la ligne de demarrage est dite');
  eq(DEPS.cle, true, '`cle` : ODDS_API_KEY est posee');
  ok(DEPS.appel === imp.appel, '`appel` : LE garde-fou du socle (paris_import.appel), aucun autre chemin vers le fournisseur');
  const q = DEPS.quota();
  const qs = imp.etatQuota();
  eq(JSON.stringify(q), JSON.stringify({ depense: 123, part: imp.partDuJour(qs.reste), reserve: 80 }),
     '`quota` : la depense du jour du socle (123), sa part du jour, la reserve de la CLASSE 2 (80)');
  eq(q.reserve, imp.RESERVES_CLASSE[2], '... la reserve est celle de la classe 2 du socle, pas un chiffre recopie');
  const pr = DEPS.projection();
  const ps = imp.projectionMois(imp.etatQuota());
  eq(JSON.stringify(pr), JSON.stringify({ credits: ps.credits, jourDuMois: ps.jourDuMois, mois: new Date(T0).toISOString().slice(0, 7) }),
     '`projection` : celle du socle (x-requests-used x 30 / jour du mois), avec son mois');
  eq(DEPS.catalogue().map((m) => m.id).sort().join(','), 'bar-get,osa-rma', '`catalogue` : les rencontres du catalogue servi');
  eq(DEPS.estRegle('bar-get'), false, '`estRegle` : lit le moteur sans lever (rien de regle)');

  logVrai('\n-- 2. la passe ESPN partagee : le prendre du module, le cache de l affichage, le second verrou --');
  {
    const osa = paris.match('osa-rma');
    eq(paris.ouvert(osa, Date.now()), true, 'avant : Osasuna - Real Madrid (dans 50 min) est ouverte aux paris');
    osasunaEnJeu = true;
    let parLePrendre = 0;
    const avant = VUS.espn;
    const prendre = async (u, op) => { parLePrendre++; return global.fetch(u, op); };
    const par = await DEPS.lisEspn([paris.match('bar-get'), osa], Date.now(), prendre);
    osasunaEnJeu = false;
    ok(parLePrendre >= 1 && VUS.espn - avant === parLePrendre, `ESPN lu par le \`prendre\` du module, et seulement par lui (${parLePrendre} requete(s))`);
    ok(parLePrendre <= 2, `6 h de marge : un ou deux jours de tableau, jamais trois (${parLePrendre})`);
    const s = par.get('bar-get');
    eq(`${s && s.score}|${s && s.etat}|${s && s.horloge}|${JSON.stringify(s && s.evenements)}`, '1-0|in|600|[["d","b",300]]',
       'la releve rend score, etat, horloge et faits dans NOTRE orientation');
    eq(paris.ouvert(osa, Date.now()), false, 'apres : ESPN la voit en jeu -> FERMEE par le second verrou (poseHeuresReelles)');
    const cal = await (await fetchVrai(base + '/paris/calendrier')).json();
    const d = (cal.directs || []).find((x) => x.id === 'bar-get');
    eq(d && d.score, '1-0', '/paris/calendrier -> directs : le cache de l affichage a recu la releve (meme cache, pas un troisieme)');
  }

  logVrai('\n-- 3. de bout en bout : un tic du vrai module dans le vrai serveur --');
  {
    await POIGNEE.tic(Date.now());
    eq(VUS.odds.length, 1, 'une releve /odds (La Liga), par le vrai appel');
    eq(`${VUS.odds[0].ids}|${VUS.odds[0].markets}|${VUS.odds[0].regions}`, 'ev-bar-get|h2h|eu', '... eventIds de la seule rencontre suivie, h2h, eu');
    const classes = JSON.parse(fs.readFileSync(path.join(BAC, 'odds_classes.json'), 'utf8'));
    eq(classes.jours[jour] && classes.jours[jour]['2'] && classes.jours[jour]['2'].depense, 1, 'le socle la compte en CLASSE 2');
    eq(JSON.parse(fs.readFileSync(path.join(BAC, 'odds_quota.json'), 'utf8')).depenseDuJour, 124, 'et dans la depense du jour (123 + 1)');
    const L = enJeu.lisLignes(fs.readFileSync(path.join(BAC, 'paris_en_jeu', jour + '.jsonl'), 'utf8'));
    const a = L.find((l) => l.k === 'a' && l.id === 'bar-get');
    eq(a && a.ok, 1, 'la rencontre suivie est admise (part du jour du socle moins 80)');
    ok(!L.some((l) => l.id === 'osa-rma'), 'la rencontre pas encore commencee n est pas suivie');
    const e = L.find((l) => l.k === 'e' && l.id === 'bar-get');
    eq(`${e && e.s}|${e && e.et}|${e && e.h}`, '1-0|in|600', 'ESPN lu par la passe partagee, ecrit au journal');
    const c = L.find((l) => l.k === 'c');
    eq(`${c && c.ev[0].id}|${c && c.ev[0].ref}|${c && c.ev[0].o}|${c && c.ev[0].lu > 0}|${c && c.x}`, 'bar-get|b|1|true|1',
       'la releve au journal : reference bourse, orientation, last_update du marche, 1 credit');
    ok(!fs.readFileSync(path.join(BAC, 'paris_en_jeu', jour + '.jsonl'), 'utf8').includes('cle-de-banc-cablage'), 'le journal ne porte jamais la cle');
  }

  logVrai('\n-- 4. /paris/import porte enJeu --');
  {
    const r = await fetchVrai(base + '/paris/import', { headers: { 'x-admin-key': process.env.ADMIN_KEY } });
    const j = await r.json();
    eq(`${r.status}|${j.enJeu && j.enJeu.mode}|${j.enJeu && j.enJeu.credits.total}|${j.enJeu && j.enJeu.suivies.join(',')}`, '200|observe|1|bar-get',
       '/paris/import -> enJeu : mode observe, 1 credit, la rencontre suivie');
    eq((await fetchVrai(base + '/paris/en-jeu/journal?jour=' + jour)).status, 401, 'le journal sans la cle : ferme');
    const rj = await fetchVrai(base + '/paris/en-jeu/journal?jour=' + jour, { headers: { 'x-admin-key': process.env.ADMIN_KEY } });
    eq(`${rj.status}|${(await rj.text()).split('\n').filter(Boolean).length > 2}`, '200|true', 'avec la cle : le .jsonl du jour');
  }
  ok(!VUS.refuses.some((u) => /eventIds=/.test(u)), 'aucune releve du direct refusee par le faux reseau (toutes servies)');

  /* ---- LES COUTURES QUE LA MUTATION DU 11/10/2026 LAISSAIT PASSER (V04, V01, V11) ---- */
  logVrai('\n-- 5. estRegle lit le moteur, la cle vient de l environnement, l arret arrete le direct --');
  {
    /* V04 : `estRegle: () => false` passait (seul le cas « pas regle » etait lu). Une rencontre
       reglee par la vraie route admin doit se lire reglee (la garde nonReglee du bilan en depend). */
    const r = await fetchVrai(base + '/paris/regle', { method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY, 'content-type': 'application/json' },
                                                     body: JSON.stringify({ match: 'osa-rma', score: '0-0', motif: 'essai du cablage (rencontre sans pari)' }) });
    eq(r.status, 200, 'POST /paris/regle (admin) sur Osasuna - Real Madrid, sans pari : 200');
    eq(`${DEPS.estRegle('osa-rma')}|${DEPS.estRegle('bar-get')}`, 'true|false', '`estRegle` : la rencontre reglee se lit reglee, l autre non');
  }
  {
    /* V01 : un second vrai serveur, demarre SANS ODDS_API_KEY (meme fichier, `--sans-cle`) */
    const { spawnSync } = require('child_process');
    const env = Object.assign({}, process.env); delete env.ODDS_API_KEY;
    const c = spawnSync(process.execPath, [__filename, '--sans-cle'], { env, encoding: 'utf8', timeout: 120000 });
    const ligne = String(c.stdout || '').split('\n').find((x) => x.startsWith('SANS-CLE '));
    eq(`${c.status}|${ligne ? ligne.slice(9) : 'aucune ligne : ' + String(c.stderr || '').slice(0, 200)}`, '0|{"cle":false,"actif":false,"dit":true}',
       'un serveur sans ODDS_API_KEY, PARIS_EN_JEU=observe : `cle` faux, module INERTE, et dit au demarrage');
  }
  if (VUS.refuses.length) logVrai(`  (le serveur a tente ${VUS.refuses.length} autre(s) requete(s), toutes refusees par le faux reseau)`);
  {
    /* V11 : l'arret du serveur (SIGTERM, un redeploiement) arrete les minuteries du direct */
    let arretes = 0;
    const vraiArrete = POIGNEE.arrete;
    POIGNEE.arrete = () => { arretes++; return vraiArrete.call(POIGNEE); };
    /* shutdown() finit par process.exit : tenu le temps de lire ce qu'il a fait (l'essai sort lui-meme ensuite) */
    const exitVrai = process.exit;
    let sortie = 'aucune';
    process.exit = (c) => { sortie = c; };
    try { process.emit('SIGTERM'); } finally { process.exit = exitVrai; }
    eq(arretes, 1, `SIGTERM -> shutdown() : le direct est arrete (enJeu.arrete), une fois (sortie demandee : ${sortie})`);
  }
  fini = true;
  logVrai(`\nparis_en_jeu_cablage.test.js : ${n} verifications OK`);
  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* rien */ }
  process.exit(0);
})().catch((e) => { logVrai('RATE ' + (e && e.stack || e)); process.exit(1); });
