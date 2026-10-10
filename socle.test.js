'use strict';
/*
 * LE SOCLE COMMUN DES LOTS DE LA CLE 20K (lot 0, 10/10/2026).
 *
 * ---- pourquoi ----
 *
 * Avec 20 000 credits par mois, six chantiers vont depenser autre chose que le
 * prix du marche (totaux, deux issues, coupes, reglement, direct). Ils passent
 * TOUS par le meme `appel` et le meme garde-fou `autorise` : le socle les
 * prepare une fois, avant eux, sans rien changer a ce qui se vend. L'essai
 * tient sept promesses, chacune avec un garde-fou qui la fait tomber s'il est
 * retire :
 *  1. drapeaux vides, la sortie du chemin des prix est IDENTIQUE, octet pour
 *     octet, a celle du code de main d'avant le socle (essais/reference/) ;
 *  2. `autorise` en classes 0 a 3 : reserves 0 / 0 / 80 / 160 sur la part du
 *     jour, priorite pour la seule classe 0, alerte pour la seule classe 0,
 *     une classe ecrite de travers refusee ;
 *  3. `appel(…, info)` dit ce qu'a coute l'appel (x-requests-last, jamais 0
 *     par defaut), le statut, le code du fournisseur, et jamais la cle ;
 *  4. un appel sans reponse est abandonne au bout de 15 s et ne bloque plus
 *     la file des releves ;
 *  5. deux appels en vol ne perdent plus un increment du compteur du jour ;
 *  6. la priorite des releves de prix est pour ce qui est VENDU, et le
 *     calendrier ne se refait qu'apres une releve d'une cle vendue ;
 *  7. `note(evs, ligue, now, opts)` et son crochet `apresNote` : appele APRES
 *     l'ecriture du carnet, un abonne qui leve ne change rien, chacun sa
 *     copie (evs compris) ;
 *  8. la projection du mois (la porte des 16 000), qui ne conclut pas avant
 *     le 7, et les exports de lecture d'un livre ;
 *  9. le compte par classe (depense, refus, delais par jour), qui rend la
 *     porte des reserves 80 / 160 jugeable, et les deux compteurs ecrits en
 *     deux temps.
 * Ajouts de la relecture du socle (10/10/2026, trois verifications
 * independantes) : un delai payant compte par prudence, les credits en vol
 * dans le garde-fou, le code du fournisseur lu dans error_code, `vu` qui
 * n'avance qu'avec un en-tete, et une verification par mutant survivant
 * (reserve de priorite a deux cles vendues, copie profonde des abonnes, delai
 * sur le corps d'erreur, erreur reseau qui n'est pas un delai, deux reponses
 * dans le meme tour, projection branchee dans etatImport, cause transmise).
 *
 * Aucun reseau : `fetch` est remplace. Aucune alerte reelle : l'alerte est
 * remplacee par un compteur.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

for (const k of Object.keys(process.env)) if (/^(PARIS_|ODDS_API_)/.test(k)) delete process.env[k];
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'socle-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-du-socle';
process.env.ODDS_API_TOTAL = '20000';
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_france_ligue_one';
process.env.PARIS_PRIX_LIGUES = 'soccer_epl';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); n++; console.log('  ok  ' + m); };
const attente = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------- le faux fournisseur
const DEMAIN = Date.now() + 26 * 3600000;
const ev = (id, dom, ext, t) => ({ id, commence_time: new Date(t).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('s-epl-1', 'Arsenal', 'Everton', DEMAIN), ev('s-epl-2', 'Chelsea', 'Liverpool', DEMAIN + 3600000)],
  soccer_france_ligue_one: [ev('s-l1-1', 'Lyon', 'Monaco', DEMAIN)],
};
const livre = (key, e, c1, cn, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
const ODDS = {
  soccer_epl: () => [
    Object.assign({}, EVENTS.soccer_epl[0], { bookmakers: [livre('betfair_ex_eu', EVENTS.soccer_epl[0], 1.62, 4.1, 6.2),
      livre('pinnacle', EVENTS.soccer_epl[0], 1.6, 4.0, 5.9), livre('unibet_eu', EVENTS.soccer_epl[0], 1.57, 3.9, 5.6),
      livre('williamhill', EVENTS.soccer_epl[0], 1.58, 3.8, 5.5)] }),
    Object.assign({}, EVENTS.soccer_epl[1], { bookmakers: [livre('unibet_eu', EVENTS.soccer_epl[1], 2.55, 3.45, 2.85)] }),   // un seul livre ordinaire : pas de reference
  ],
  soccer_france_ligue_one: () => [Object.assign({}, EVENTS.soccer_france_ligue_one[0], { bookmakers: [
    livre('pinnacle', EVENTS.soccer_france_ligue_one[0], 2.2, 3.5, 3.3)] })],
};
const appels = [];
let utilise = 0;
const entetes = (h) => ({ get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) });
const reponse = (corps, cout) => {
  utilise += cout;
  return { ok: true, status: 200,
    headers: entetes({ 'x-requests-remaining': String(20000 - utilise), 'x-requests-used': String(utilise), 'x-requests-last': String(cout) }),
    json: async () => JSON.parse(JSON.stringify(corps)), text: async () => JSON.stringify(corps) };
};
async function fournisseur(url, o) {
  const u = new URL(String(url));
  const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
  const ligue = m && m[1], quoi = m ? m[2] : 'sports';
  appels.push({ ligue, quoi, signal: !!(o && o.signal), url: String(url) });
  if (quoi === 'events') return reponse(EVENTS[ligue] || [], 0);
  if (quoi === 'odds') { const c = ODDS[ligue] ? ODDS[ligue]() : []; return reponse(c, c.length ? 1 : 0); }
  return reponse([], 0);
}
global.fetch = fournisseur;

/* L'alerte privee remplacee par un compteur : paris_import la lit sur le
   module a chaque appel. */
const AS = require('./alerte_solde');
const alertes = [];
AS.oddsEvenement = (sorte, detail) => { alertes.push({ sorte, detail }); return true; };

const pm = require('./prix_marche');
const imp = require('./paris_import');

const FQ = path.join(BAC, 'odds_quota.json');
const jour = () => new Date().toISOString().slice(0, 10);
const poseQuota = (reste, depense) => fs.writeFileSync(FQ, JSON.stringify({ reste, utilise: 20000 - reste, vu: null, depenseDuJour: depense, jour: jour() }));
const refus = (f) => { try { f(); return null; } catch (e) { return e; } };
const P = { regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' };

(async () => {
  console.log('\n-- 1. drapeaux vides : la sortie du chemin des prix est celle de main d avant le socle, octet pour octet --');
  {
    const REF = path.join(__dirname, 'essais', 'reference');
    const ATTENDU = path.join(REF, 'attendu');
    const SORTIE = fs.mkdtempSync(path.join(os.tmpdir(), 'socle-sortie-'));
    const fichiers = ['appels.json', 'odds_quota.json', 'paris_catalogue.json', 'paris_prix.json'];
    eq(fs.readdirSync(ATTENDU).sort().join(','), fichiers.join(','), 'la reference porte ses quatre fichiers, rien d autre');
    /* La reference n'est pas vide (une reference vide serait toujours egale). */
    const cat = JSON.parse(fs.readFileSync(path.join(ATTENDU, 'paris_catalogue.json'), 'utf8'));
    const carnet = JSON.parse(fs.readFileSync(path.join(ATTENDU, 'paris_prix.json'), 'utf8'));
    const refs = Object.values(carnet.evenements).map((e) => e.ref).sort().join(',');
    ok(cat.matchs.length === 10 && cat.matchs.filter((m) => m.prixMarche).length === 5 && cat.matchs.filter((m) => m.suspendu).length === 1,
       `reference : 10 rencontres, 5 au prix du marche, 1 suspendue (marche retire) — ${cat.matchs.length} / ${cat.matchs.filter((m) => m.prixMarche).length} / ${cat.matchs.filter((m) => m.suspendu).length}`);
    eq(refs, 'betfair,betfair,mediane,pinnacle,pinnacle', 'le carnet de reference couvre Betfair, Pinnacle et la mediane');
    let sortie;
    try {
      sortie = execFileSync(process.execPath, [path.join(REF, 'fabrique.js'), __dirname, SORTIE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { console.error(e.stdout, e.stderr); throw e; }
    /* Le chemin du REFUS est dans la reference (tours 4 et 5, ajoutes a la
       relecture) : au tour 4 (13:00) la part est prise, seuls les deux
       championnats VENDUS partent, en priorite ; au tour 5 (14:00) plus rien
       de payant ne part. */
    const lAppels = JSON.parse(fs.readFileSync(path.join(ATTENDU, 'appels.json'), 'utf8'));
    const oddsA = (h) => lAppels.filter((a) => a.t === `2026-10-10T${h}:00:00.000Z` && /\/odds$/.test(a.chemin)).map((a) => a.chemin.split('/')[3]).sort().join(',');
    eq(oddsA('13'), 'soccer_epl,soccer_spain_la_liga', 'reference, tour 4 : part prise, l etalonnage est refuse, seuls les vendus partent (priorite)');
    eq(oddsA('14'), '', 'reference, tour 5 : plus de quoi tenir le mois, la releve vendue est refusee elle aussi');
    ok(/40 appel\(s\), 8 credit\(s\)/.test(sortie), 'la fabrique a tourne sur le code du depot : ' + sortie.trim().split('\n').pop());
    for (const f of fichiers) {
      const a = fs.readFileSync(path.join(ATTENDU, f)), b = fs.readFileSync(path.join(SORTIE, f));
      ok(Buffer.compare(a, b) === 0, `${f} : ${b.length} octets, identique a la reference (${a.length} octets)`);
    }
    fs.rmSync(SORTIE, { recursive: true, force: true });
  }

  console.log('\n-- 2. autorise : quatre classes, reserves 0 / 0 / 80 / 160, priorite et alerte pour la seule classe 0 --');
  {
    eq(JSON.stringify(imp.RESERVES_CLASSE), '[0,0,80,160]', 'les reserves du plan : 0, 0, 80, 160');
    poseQuota(20000, 0);
    const part = imp.partDuJour(20000);
    ok(part > 160, `part du jour ${part} sur 20 000 restants (${imp.joursRestants()} jours)`);
    alertes.length = 0;
    /* classe 1 : sans classe dite, comme avant le socle ; jusqu'a la part */
    poseQuota(20000, part - 1);
    ok(imp.autorise(1, 'c1 implicite'), 'classe 1 implicite : passe jusqu a la part');
    ok(imp.autorise(1, 'c1', undefined, 1), 'classe 1 dite : idem');
    poseQuota(20000, part);
    ok(/REFUSE.*part du jour/.test(refus(() => imp.autorise(1, 'c1 implicite')).message), 'classe 1 : refusee a la part');
    ok(refus(() => imp.autorise(1, 'c1', undefined, 1)), 'classe 1 dite : idem');
    /* classe 2 : jusqu'a la part moins 80 */
    poseQuota(20000, part - 81);
    ok(imp.autorise(1, 'c2', undefined, 2), 'classe 2 : passe a part - 81');
    poseQuota(20000, part - 80);
    const e2 = refus(() => imp.autorise(1, 'c2', undefined, 2));
    ok(e2 && /REFUSE/.test(e2.message) && /moins 80/.test(e2.message), 'classe 2 : refusee a part - 80, et le message dit la reserve — ' + (e2 && e2.message.slice(0, 140)));
    ok(imp.autorise(1, 'c1', undefined, 1), 'au meme instant, la classe 1 passe encore');
    /* classe 3 : jusqu'a la part moins 160 */
    poseQuota(20000, part - 161);
    ok(imp.autorise(1, 'c3', undefined, 3), 'classe 3 : passe a part - 161');
    poseQuota(20000, part - 160);
    ok(/moins 160/.test((refus(() => imp.autorise(1, 'c3', undefined, 3)) || {}).message || ''), 'classe 3 : refusee a part - 160');
    ok(imp.autorise(1, 'c2', undefined, 2), 'au meme instant, la classe 2 passe encore');
    /* la priorite : classe 0 seulement */
    poseQuota(20000, part);
    ok(imp.autorise(1, 'c0 implicite', 6), 'part prise : la classe 0 implicite (prioritaire) passe encore, comme avant');
    ok(imp.autorise(1, 'c0', 6, 0), 'la classe 0 dite aussi');
    for (const k of [1, 2, 3]) ok(refus(() => imp.autorise(1, 'c' + k + ' prioritaire', 6, k)), `une classe ${k} qui se dit prioritaire ne passe PAS au-dela de sa limite`);
    eq(alertes.length, 0, 'aucun de ces refus (classes 1 a 3) n alerte');
    /* l'alerte : classe 0 seulement */
    const juste = 6 * imp.joursRestants();
    poseQuota(juste, imp.partDuJour(juste));
    ok(refus(() => imp.autorise(1, 'prix soccer_epl', 6, 0)), 'classe 0 sans de quoi tenir le mois : refusee');
    eq(alertes.length, 1, 'et le proprietaire est prevenu');
    eq(alertes[0] && alertes[0].sorte, 'refus', 'alerte « refus »');
    ok(refus(() => imp.autorise(1, 'prix soccer_epl', undefined, 0)), 'classe 0 sans priorite, part prise : refusee');
    eq(alertes.length, 2, 'et prevenu aussi');
    /* une classe ecrite de travers */
    poseQuota(20000, 0);
    for (const c of ['2', 4, -1, 1.5, NaN, true]) {
      const e = refus(() => imp.autorise(1, 'classe ' + String(c), undefined, c));
      ok(e && /inconnue/.test(e.message), `classe ${JSON.stringify(c)} : refusee (jamais devinee), meme jour vide`);
    }
    eq(alertes.length, 2, 'sans alerte');
    /* null vaut « pas de classe dite », comme undefined : le comportement
       d'avant le socle (mutant A7 de la relecture) */
    ok(imp.autorise(1, 'classe null', undefined, null), 'classe null : passe comme la classe 1 implicite');
    poseQuota(20000, part);
    ok(imp.autorise(1, 'classe null prioritaire', 6, null), 'classe null avec priorite : classe 0 implicite, passe au-dela de la part');
  }

  console.log('\n-- 3. appel(…, info) : ce qu a coute l appel, son statut, son code — jamais la cle --');
  {
    poseQuota(20000, 0);
    const info = { classe: 1 };
    appels.length = 0;
    const evs = await imp.appel('/sports/soccer_epl/odds', P, 1, 'essai info', undefined, info);
    ok(Array.isArray(evs) && evs.length === 2, 'la reponse est rendue');
    eq(info.dernier, 1, 'info.dernier = x-requests-last');
    eq(info.cout, 1, 'info.cout = le meme (le reglement le lit sous ce nom)');
    eq(info.statut, 200, 'info.statut');
    eq(info.code, null, 'info.code : rien a dire');
    eq(info.reste, 20000 - utilise, 'info.reste = x-requests-remaining');
    eq(info.utilise, utilise, 'info.utilise = x-requests-used');
    eq(info.classe, 1, 'la classe donnee reste');
    ok(!JSON.stringify(info).includes(process.env.ODDS_API_KEY), 'la cle n est jamais dans info');
    ok(appels[0].signal, 'fetch recoit un signal d abandon');
    /* une reponse d'erreur : pas d'en-tete, donc pas de 0 invente */
    const avant = imp.etatQuota();
    global.fetch = async () => ({ ok: false, status: 429, headers: entetes({}),
      text: async () => '{"message":"Usage quota has been reached","error_code":"OUT_OF_USAGE_CREDITS"}', json: async () => ({}) });
    const e = await imp.appel('/sports/soccer_epl/odds', P, 1, 'essai erreur', undefined, info).catch((x) => x);
    global.fetch = fournisseur;
    ok(e instanceof Error && /429/.test(e.message), 'l erreur est levee');
    eq(info.statut, 429, 'info.statut 429');
    eq(info.code, 'OUT_OF_USAGE_CREDITS', 'info.code : le code du fournisseur lu dans le corps');
    eq(info.dernier, null, 'info.dernier null sans en-tete — jamais 0');
    eq(info.cout, null, 'info.cout null aussi');
    eq(imp.etatQuota().reste, avant.reste, 'le compteur n est pas touche par une reponse sans en-tete');
    eq(imp.etatQuota().depenseDuJour, avant.depenseDuJour, 'ni la depense du jour');
    /* le code du fournisseur : le champ error_code d'abord ; jamais un mot
       d'une page HTML (avant : « DOCTYPE » sur une 502 de passerelle) */
    const erreur = (status, corps) => async () => ({ ok: false, status, headers: entetes({}), text: async () => corps, json: async () => ({}) });
    global.fetch = erreur(502, '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>');
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'essai 502', undefined, info).catch(() => {});
    eq(info.code, null, 'une page HTML de passerelle : aucun code (avant : DOCTYPE)');
    eq(info.statut, 502, 'mais son statut');
    global.fetch = erreur(422, '{"message":"Invalid markets PLAYER_PROPS parameter","error_code":"INVALID_MARKET"}');
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'essai 422', undefined, info).catch(() => {});
    eq(info.code, 'INVALID_MARKET', 'un corps JSON : son error_code, pas un mot en majuscules du message (avant : PLAYER_PROPS)');
    global.fetch = erreur(500, 'upstream said UPSTREAM_TIMEOUT');
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'essai 500', undefined, info).catch(() => {});
    eq(info.code, 'UPSTREAM_TIMEOUT', 'un corps en texte : le premier code en majuscules, comme avant');
    eq(imp.codeDuCorps('{"message":"OUT_OF_USAGE_CREDITS"}'), 'OUT_OF_USAGE_CREDITS', 'un JSON sans error_code : repli sur le texte, comme avant');
    /* vu : la derniere lecture du compteur du fournisseur — une erreur sans
       en-tete n'en est pas une (le 1er du mois, elle faisait projeter le
       compteur du mois d'avant) */
    const VU = '2026-10-01T00:00:00.000Z';
    fs.writeFileSync(FQ, JSON.stringify({ reste: 19000, utilise: 1000, vu: VU, depenseDuJour: 0, jour: jour() }));
    global.fetch = erreur(502, 'Bad Gateway');
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'essai vu', undefined, info).catch(() => {});
    eq(imp.etatQuota().vu, VU, 'une erreur sans en-tete ne fait pas avancer vu');
    global.fetch = fournisseur;
    await imp.appel('/sports/soccer_epl/events', {}, 0, 'events', undefined, {});
    ok(imp.etatQuota().vu !== VU && Date.now() - Date.parse(imp.etatQuota().vu) < 60000, 'une reponse avec ses en-tetes, si');
    /* le meme objet reutilise : remis a zero */
    await imp.appel('/sports/soccer_epl/events', {}, 0, 'events', undefined, info);
    eq(info.code, null, 'reutilise, info est remis a zero (plus de code d un appel precedent)');
    eq(info.dernier, 0, 'un appel gratuit dit 0 credit, lu dans l en-tete');
    eq(info.statut, 200, 'et son statut');
    /* un refus du garde-fou : rien ne part */
    const part = imp.partDuJour(20000);
    poseQuota(20000, part - 160);
    appels.length = 0;
    const r = await imp.appel('/sports/soccer_france_ligue_one/odds', P, 1, 'observation', undefined, { classe: 3 }).catch((x) => x);
    const i3 = { classe: 3 };
    await imp.appel('/sports/soccer_france_ligue_one/odds', P, 1, 'observation', undefined, i3).catch(() => {});
    ok(r instanceof Error && /REFUSE/.test(r.message), 'classe 3 passee par info.classe : refusee a part - 160');
    eq(i3.code, 'REFUSE', 'info.code = REFUSE');
    eq(i3.statut, null, 'aucun statut : rien n est parti');
    eq(appels.length, 0, 'aucun fetch');
    const i9 = { classe: '3' };
    await imp.appel('/sports/soccer_france_ligue_one/odds', P, 1, 'classe en chaine', undefined, i9).catch(() => {});
    eq(i9.code, 'REFUSE', 'une classe ecrite de travers dans info : refusee, rien ne part');
    eq(appels.length, 0, 'toujours aucun fetch');
    eq(imp.etatImport().quota.enVol, 0, 'apres erreurs et refus, aucun credit ne reste tenu en vol');
  }

  console.log('\n-- 4. un appel sans reponse est abandonne au bout de 15 s, et ne bloque plus la file --');
  {
    eq(imp.DELAI_APPEL_MS, 15000, 'le delai : 15 s');
    poseQuota(20000, 0);
    /* Les minuteries de 15 s sont raccourcies a 40 ms ; on note leurs poignees
       pour verifier qu'elles sont toujours effacees. */
    const vraiST = global.setTimeout, vraiCT = global.clearTimeout;
    const poignees = [], effacees = new Set();
    global.setTimeout = (f, ms, ...a) => {
      const h = vraiST(f, ms === 15000 ? 40 : ms, ...a);
      if (ms === 15000) poignees.push(h);
      return h;
    };
    global.clearTimeout = (h) => { effacees.add(h); return vraiCT(h); };
    const abandon = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const pendu = (url, o) => new Promise((res, rej) => {
      /* sans signal, l'appel resterait pendu pour toujours : c'est la panne */
      if (o && o.signal) o.signal.addEventListener('abort', () => rej(abandon()));
    });
    /* trois secondes au plus, et la minuterie de garde effacee : elle ne
       retient pas le processus apres l'essai */
    const course = (p) => new Promise((res) => {
      const h = vraiST(() => res('PENDU'), 3000);
      p.then(() => 'rendu', (e) => e).then((v) => { vraiCT(h); res(v); });
    });
    const classeDuJour = (k) => Object.assign({ appels: 0, depense: 0, refus: 0, delais: 0 }, (imp.etatClasses().jours[jour()] || {})[k]);
    try {
      global.fetch = pendu;
      const info = {};
      const t0 = Date.now();
      const c0 = classeDuJour(0);
      const r = await course(imp.appel('/sports/soccer_epl/odds', P, 1, 'prix soccer_epl', 1, info));
      ok(r instanceof Error && /delai/.test(r.message), 'sans reponse : abandonne et dit — ' + (r.message || r));
      ok(Date.now() - t0 < 2000, `en ${Date.now() - t0} ms (minuterie raccourcie)`);
      eq(info.code, 'DELAI', 'info.code = DELAI');
      ok(poignees.length >= 1 && effacees.has(poignees[poignees.length - 1]), 'la minuterie est effacee');
      /* Reecrit a la relecture du socle, sur son intention : le compteur du
         jour ne doit pas laisser passer plus que ce que le fournisseur a pu
         facturer. L'ancienne ligne (« rien n a ete compte : aucune reponse »)
         verrouillait l'inverse : un fournisseur durablement lent percait la
         part du jour d'un credit par delai, sans un mot (sonde : 5 delais
         payants, depenseDuJour = 0). Desormais un appel PAYANT abandonne avant
         ses en-tetes est compte par prudence, a son cout attendu. */
      eq(imp.etatQuota().depenseDuJour, 1, 'appel payant abandonne avant ses en-tetes : compte par prudence a son cout attendu (avant : 0)');
      eq(info.comptePrudent, 1, 'info.comptePrudent le dit');
      eq(info.dernier, null, 'x-requests-last reste inconnu : rien n est invente cote fournisseur');
      eq(imp.etatQuota().reste, 20000, 'ni le reste du fournisseur');
      ok(/1 credit\(s\) compte\(s\) par prudence \(delai\)$/.test(r.message), 'le journal le dit, et la ligne finit toujours par (delai)');
      for (let i = 0; i < 4; i++) await course(imp.appel('/sports/soccer_epl/odds', P, 1, 'prix soccer_epl', 1, {}));
      eq(imp.etatQuota().depenseDuJour, 5, 'cinq delais payants : cinq credits comptes (la sonde de la relecture : 0)');
      const c1 = classeDuJour(0);
      ok(c1.delais - c0.delais === 5 && c1.depense - c0.depense === 5, `et le compte par classe les range en classe 0 : +${c1.delais - c0.delais} delais, +${c1.depense - c0.depense} credits`);
      const iG = {};
      const rG = await course(imp.appel('/sports/soccer_epl/events', {}, 0, 'events', undefined, iG));
      ok(rG instanceof Error && iG.code === 'DELAI', 'un appel gratuit abandonne : DELAI aussi');
      eq(imp.etatQuota().depenseDuJour, 5, 'mais il ne compte rien');
      eq(iG.comptePrudent, 0, 'et le dit');
      /* le garde-fou voit les delais : la part du jour atteinte par eux
         refuse la suite */
      const part = imp.partDuJour(20000);
      poseQuota(20000, part - 1);
      await course(imp.appel('/sports/soccer_epl/odds', P, 1, 'etalonnage lent', undefined, {}));
      const iR = {};
      await imp.appel('/sports/soccer_epl/odds', P, 1, 'etalonnage suivant', undefined, iR).catch(() => {});
      eq(iR.code, 'REFUSE', 'une part du jour remplie par des delais refuse l appel suivant (classe 1)');
      poseQuota(20000, 0);
      /* les en-tetes sont arrives, le corps ne vient pas */
      global.fetch = async (url, o) => ({ ok: true, status: 200,
        headers: entetes({ 'x-requests-remaining': '19000', 'x-requests-used': '1000', 'x-requests-last': '1' }),
        json: () => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(abandon()))) });
      const i2 = {};
      const r2 = await course(imp.appel('/sports/soccer_epl/odds', P, 1, 'prix soccer_epl', 1, i2));
      ok(r2 instanceof Error && /delai/.test(r2.message), 'corps qui ne vient pas : abandonne aussi');
      eq(i2.code, 'DELAI', 'info.code = DELAI');
      eq(i2.dernier, 1, 'mais le credit est dit');
      eq(imp.etatQuota().depenseDuJour, 1, 'et compte : la reponse etait payee');
      eq(i2.comptePrudent, 0, 'une seule fois : les en-tetes ont dit le cout, pas de prudence en plus');
      /* un corps d'ERREUR qui ne vient pas : delai aussi (mutant B9) */
      poseQuota(20000, 0);
      global.fetch = async (url, o) => ({ ok: false, status: 502, headers: entetes({}),
        text: () => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(abandon()))) });
      const i4 = {};
      const r4 = await course(imp.appel('/sports/soccer_epl/odds', P, 1, 'erreur lente', undefined, i4));
      ok(r4 instanceof Error && /\(delai\)$/.test(r4.message), 'un corps d erreur qui ne vient pas : abandonne, et la ligne dit (delai) — ' + (r4.message || r4));
      eq(i4.code, 'DELAI', 'info.code = DELAI');
      eq(i4.statut, 502, 'avec le statut deja recu');
      eq(imp.etatQuota().depenseDuJour, 0, 'une erreur sans en-tete n est pas comptee, meme abandonnee');
      /* une erreur reseau immediate n'est PAS un delai (mutant B10) */
      global.fetch = async () => { throw new TypeError('fetch failed'); };
      const i5 = {};
      const r5 = await imp.appel('/sports/soccer_epl/odds', P, 1, 'reseau', undefined, i5).catch((x) => x);
      ok(r5 instanceof TypeError && !/delai/.test(r5.message), 'une erreur reseau immediate remonte telle quelle, sans « delai » — ' + (r5 && r5.message));
      ok(i5.code !== 'DELAI', 'info.code n est pas DELAI');
      eq(imp.etatQuota().depenseDuJour, 0, 'et rien n est compte : la connexion n a pas abouti');
      /* un appel normal : sa minuterie de 15 s ne survit pas */
      global.fetch = fournisseur;
      const avant = poignees.length;
      await imp.appel('/sports/soccer_epl/events', {}, 0, 'events', undefined, {});
      ok(poignees.length === avant + 1 && effacees.has(poignees[avant]), 'appel rendu : sa minuterie de 15 s est effacee (rien ne retient le processus)');
      /* la file des releves : un observe pendu ne bloque pas le vendu qui suit */
      process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
      global.fetch = (url, o) => (/soccer_france_ligue_one/.test(String(url)) ? pendu(url, o) : fournisseur(url, o));
      const r3 = await course(imp.rafraichitPrix(['soccer_france_ligue_one', 'soccer_epl'], 'essai', 0));
      eq(r3, 'rendu', 'la releve rend la main');
      ok(pm.derniere('soccer_epl') > Date.now() - 5000, 'et le championnat vendu qui suivait l observe pendu a ete releve');
      eq(imp.etatImport().quota.enVol, 0, 'apres delais, corps qui ne viennent pas et erreur reseau : aucun credit ne reste tenu en vol');
    } finally {
      global.setTimeout = vraiST; global.clearTimeout = vraiCT; global.fetch = fournisseur;
      delete process.env.PARIS_PRIX_OBSERVE;
    }
  }

  console.log('\n-- 5. deux appels en vol ne perdent plus un increment du compteur du jour --');
  {
    const enVol = [];
    const tenu = (url) => new Promise((res) => enVol.push({ url: String(url), res }));
    const rep = (dernier, reste) => ({ ok: true, status: 200,
      headers: entetes({ 'x-requests-remaining': String(reste), 'x-requests-used': String(20000 - reste), 'x-requests-last': String(dernier) }),
      json: async () => [], text: async () => '[]' });
    const enVolDe = async (k) => { for (let i = 0; i < 100 && enVol.length < k; i++) await attente(1); return enVol.length; };
    /* deux releves payees : la premiere partie revient la derniere */
    poseQuota(20000, 0);
    global.fetch = tenu;
    const pA = imp.appel('/sports/soccer_epl/odds', P, 1, 'course A', undefined, {});
    const pB = imp.appel('/sports/soccer_france_ligue_one/odds', P, 1, 'course B', undefined, {});
    eq(await enVolDe(2), 2, 'deux appels en vol');
    enVol[1].res(rep(1, 19998)); await pB;
    enVol[0].res(rep(1, 19999)); await pA;
    eq(imp.etatQuota().depenseDuJour, 2, 'deux credits payes, deux credits comptes (avant le socle : 1)');
    /* un appel gratuit en vol pendant un payant */
    enVol.length = 0;
    poseQuota(20000, 5);
    const pF = imp.appel('/sports/soccer_epl/events', {}, 0, 'events', undefined, {});
    const pP = imp.appel('/sports/soccer_epl/odds', P, 1, 'payant', undefined, {});
    eq(await enVolDe(2), 2, 'un gratuit et un payant en vol');
    enVol[1].res(rep(1, 19990)); await pP;
    enVol[0].res(rep(0, 19990)); await pF;
    eq(imp.etatQuota().depenseDuJour, 6, 'le gratuit revenu apres n efface pas le credit du payant (avant le socle : 5)');
    /* deux reponses revenues dans le MEME tour, avant toute attente : rien
       n'est attendu entre la relecture et l'ecriture (mutant B23) */
    enVol.length = 0;
    poseQuota(20000, 0);
    const pC = imp.appel('/sports/soccer_epl/odds', P, 1, 'course C', undefined, {});
    const pD = imp.appel('/sports/soccer_france_ligue_one/odds', P, 1, 'course D', undefined, {});
    eq(await enVolDe(2), 2, 'deux appels en vol');
    enVol[0].res(rep(1, 19999)); enVol[1].res(rep(1, 19998));
    await Promise.all([pC, pD]);
    eq(imp.etatQuota().depenseDuJour, 2, 'deux reponses dans le meme tour : deux credits comptes');
    /* ---- la course a la limite (relecture du socle) ----
       `autorise` lisait la depense avant le `fetch` sans compter ce qui etait
       deja parti : trois appels a la limite - 1 passaient tous (sonde : la
       depense finissait a limite + 2). Les credits en vol comptent. */
    const part = imp.partDuJour(20000);
    for (const k of [1, 2, 3]) {
      enVol.length = 0;
      const limite = part - imp.RESERVES_CLASSE[k];
      poseQuota(20000, limite - 1);
      const trois = [0, 1, 2].map((i) => imp.appel('/sports/soccer_epl/odds', P, 1, `limite c${k} ${i}`, undefined, { classe: k })
        .then(() => 'servi', (e) => e));
      await enVolDe(1); await attente(5);
      eq(enVol.length, 1, `classe ${k}, trois appels a limite - 1 : un seul part (avant : les trois)`);
      eq(imp.etatImport().quota.enVol, 1, 'son credit est tenu en vol');
      enVol[0].res(rep(1, 19990));
      const fins = await Promise.all(trois);
      ok(fins.filter((x) => x === 'servi').length === 1 && fins.filter((x) => x instanceof Error && /REFUSE.*\(\+ 1 en vol\)/.test(x.message)).length === 2,
         'un servi, deux refuses — et le refus dit le credit en vol');
      eq(imp.etatQuota().depenseDuJour, limite, `la depense finit a la limite de la classe ${k} (${limite}), pas au-dela`);
      eq(imp.etatImport().quota.enVol, 0, 'le credit en vol est rendu au retour');
    }
    /* la priorite de la classe 0 compte aussi ce qui est en vol : reste -
       en vol - cout >= prioritaire x jours */
    enVol.length = 0;
    const j = imp.joursRestants();
    poseQuota(j + 1, imp.partDuJour(j + 1));
    const deux = [0, 1].map((i) => imp.appel('/sports/soccer_epl/odds', P, 1, 'prix ' + i, 1, { classe: 0 }).then(() => 'servi', (e) => e));
    await enVolDe(1); await attente(5);
    eq(enVol.length, 1, `classe 0 a ${j + 1} restants pour ${j} jour(s) : une releve part, la seconde entamerait la reserve du mois`);
    enVol[0].res(rep(1, j));
    const fins0 = await Promise.all(deux);
    eq(fins0.filter((x) => x === 'servi').length, 1, 'une seule servie');
    eq(imp.etatImport().quota.enVol, 0, 'rien ne reste en vol');
    global.fetch = fournisseur;
  }

  console.log('\n-- 6. la priorite est pour ce qui est VENDU ; le calendrier ne se refait qu apres un vendu --');
  {
    process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
    try {
      const part = imp.partDuJour(20000);
      const odds = () => appels.filter((a) => a.quoi === 'odds').map((a) => a.ligue).join(',');
      /* jour plein : le vendu passe (classe 0), l'observe non (classe 3), sans alerte */
      poseQuota(20000, part);
      appels.length = 0; alertes.length = 0;
      eq(await imp.rafraichitPrix(['soccer_epl', 'soccer_france_ligue_one'], 'essai', 0), 1, 'rend 1 : le seul championnat VENDU releve');
      eq(odds(), 'soccer_epl', 'part du jour prise : seul le vendu part, l observe est refuse');
      eq(alertes.length, 0, 'et le refus de l observe n alerte pas');
      /* l'observe est en classe 3 : refuse a part - 160, accepte a part - 161 */
      poseQuota(20000, part - 160);
      appels.length = 0;
      await imp.rafraichitPrix(['soccer_france_ligue_one'], 'essai', 0);
      eq(odds(), '', 'observe a part - 160 : refuse (classe 3)');
      poseQuota(20000, part - 161);
      eq(await imp.rafraichitPrix(['soccer_france_ligue_one'], 'essai', 0), 0, 'observe a part - 161 : releve, et rend 0 (rien de vendu)');
      eq(odds(), 'soccer_france_ligue_one', 'un credit pour l observe');
      /* la reserve de priorite compte les VENDUS : dix observes de plus ne
         la gonflent pas (avant le socle : aRelever().size, ici 11) */
      process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one,k2,k3,k4,k5,k6,k7,k8,k9,k10';
      eq(pm.aRelever().size, 11, 'onze cles relevees, dont une vendue');
      const j = imp.joursRestants();
      poseQuota(j + 1, imp.partDuJour(j + 1));
      appels.length = 0;
      eq(await imp.rafraichitPrix(['soccer_epl'], 'essai', 0), 1, `reste ${j + 1} pour ${j} jour(s) : la releve du vendu passe (reserve = 1 x ${j}, pas 11 x ${j})`);
      process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
      /* planifie : le calendrier ne se refait qu'apres un vendu */
      poseQuota(20000, 0);
      const ctl = imp.planifie(() => {}, () => false);
      try {
        appels.length = 0;
        await ctl.prix(['soccer_france_ligue_one'], 'essai', 0);
        eq(appels.filter((a) => a.quoi === 'events').length, 0, 'releve d un observe seul : le calendrier n est PAS refait');
        ok(appels.some((a) => a.quoi === 'odds' && a.ligue === 'soccer_france_ligue_one'), 'alors que l observe a bien ete releve');
        appels.length = 0;
        await ctl.prix(['soccer_epl'], 'essai', 0);
        ok(appels.filter((a) => a.quoi === 'events').length >= 1, 'releve d un vendu : le calendrier est refait');
      } finally { ctl.arrete(); }
    } finally { delete process.env.PARIS_PRIX_OBSERVE; }
    /* la reserve de priorite compte TOUS les vendus (ligues().size) : avec
       deux cles vendues, une releve doit laisser 2 x jours restants (mutants
       C10 / C11 : 1 ou true a la place passaient l'essai a une seule cle) */
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_france_ligue_one';
    try {
      const j = imp.joursRestants();
      poseQuota(2 * j, imp.partDuJour(2 * j));
      eq(await imp.rafraichitPrix(['soccer_epl'], 'essai', 0), 0, `deux championnats vendus, ${2 * j} restants pour ${j} jour(s) : refusee (il faut garder 2 x ${j} apres elle)`);
      poseQuota(2 * j + 1, imp.partDuJour(2 * j + 1));
      eq(await imp.rafraichitPrix(['soccer_epl'], 'essai', 0), 1, `${2 * j + 1} restants : elle passe`);
    } finally { process.env.PARIS_PRIX_LIGUES = 'soccer_epl'; }
    /* la cause de la releve arrive jusqu'aux abonnes : « periodique » par
       rafraichitPrix, « etalonnage » par calibre (mutants C8 / C9) */
    const causes = [];
    const dC = pm.apresNote((x) => causes.push(x.ligue + ':' + x.quoi));
    process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
    try {
      poseQuota(20000, 0);
      await imp.rafraichitPrix(['soccer_epl'], 'periodique', 0);
      await imp.calibre('soccer_france_ligue_one');
    } finally { dC(); delete process.env.PARIS_PRIX_OBSERVE; }
    eq(causes.join(','), 'soccer_epl:periodique,soccer_france_ligue_one:etalonnage', 'la cause arrive aux abonnes : periodique (releve), etalonnage (calibre)');
  }

  console.log('\n-- 7. note(evs, ligue, now, opts) et le crochet apresNote --');
  {
    const L = 'soccer_epl', T = Date.now() - 60000;
    const evs = ODDS.soccer_epl();
    const octets = () => fs.readFileSync(pm.fichier(), 'utf8');
    const c0 = pm.note(evs, L, T);
    const sans = octets();
    pm.note(evs, L, T, { quoi: 'periodique', sport: 'foot' });
    eq(octets(), sans, 'opts { quoi, sport } ne change pas un octet du carnet');
    pm.note(evs, L, T, 'periodique');
    eq(octets(), sans, 'une chaine seule non plus');
    ok(refus(() => pm.apresNote(42)) instanceof TypeError, 'apresNote refuse ce qui n est pas une fonction');
    const vus = [];
    let nonGeree = null;
    const garde = (e) => { nonGeree = e; };
    process.on('unhandledRejection', garde);
    const d1 = pm.apresNote(function leve(x) {
      vus.push({ qui: 'a', x, carnet: pm.lis() });
      throw new Error('un abonne qui leve');
    });
    const d2 = pm.apresNote(async function rejette(x) { vus.push({ qui: 'b', x }); throw new Error('un abonne asynchrone qui rejette'); });
    /* l'abonne qui abime touche tout : le compte, une LIGNE de refs (sa
       reference, sa probabilite), et la reponse brute jusque dans ses livres
       (mutants E5 / E6 et relecture : evs etait passe par reference) */
    const d3 = pm.apresNote(function abime(x) {
      x.compte.betfair = 999;
      x.refs[0].p['1'] = 0; x.refs[0].ref = 'abime';
      x.evs[0].bookmakers.length = 0; x.evs.length = 0;
      vus.push({ qui: 'c', x });
      x.refs.length = 0;
    });
    const d4 = pm.apresNote(function lit(x) { vus.push({ qui: 'd', x }); });
    const c1 = pm.note(evs, L, T + 1000, { quoi: 'avant le coup d envoi', sport: 'foot' });
    await attente(5);
    eq(JSON.stringify(c1), JSON.stringify(c0), 'le compte rendu est le meme, abonnes qui levent ou abiment compris');
    eq(vus.map((v) => v.qui).join(''), 'abcd', 'un abonne qui leve n empeche pas les suivants');
    eq(vus[0].carnet.ligues[L], T + 1000, 'le carnet est ECRIT avant le premier abonne');
    ok(vus[0].carnet.evenements['s-epl-1'] && vus[0].carnet.evenements['s-epl-1'].t === T + 1000, 'avec ses rencontres');
    const x = vus[3].x;
    eq(x.ligue, L, 'abonne : la ligue');
    eq(x.t, T + 1000, 'la date de la releve');
    eq(x.quoi, 'avant le coup d envoi', 'la cause (opts.quoi)');
    eq(x.sport, 'foot', 'le sport (opts.sport)');
    eq(x.ecrit, true, 'le carnet a ete ecrit');
    eq(x.evs.length, 2, 'la reponse brute');
    eq(x.compte.betfair, c1.betfair, 'son compte rendu n a pas ete abime par l abonne precedent');
    eq(x.refs.map((r) => r.id + ':' + r.ref).join(','), 's-epl-1:betfair,s-epl-2:null', 'une ligne par rencontre, sa reference ou null');
    eq(JSON.stringify(x.refs[0].p), JSON.stringify(vus[0].carnet.evenements['s-epl-1'].p), 'les memes probabilites que le carnet (une ligne abimee par le precedent ne passe pas)');
    eq(x.refs[0].ref, 'betfair', 'ni sa reference');
    eq(x.evs[0].bookmakers.length, 4, 'la reponse brute de l abonne suivant est entiere, livres compris');
    ok(evs.length === 2 && evs[0].bookmakers.length === 4, 'et celle de l appelant aussi : calibre la relit juste apres note');
    eq(nonGeree, null, 'aucune promesse rejetee laissee sans gestion');
    const avecAbonnes = octets();
    d1(); d2(); d3(); d4();
    pm.note(evs, L, T + 1000, { quoi: 'avant le coup d envoi', sport: 'foot' });
    eq(octets(), avecAbonnes, 'le carnet ecrit avec des abonnes qui levent = le carnet ecrit sans abonne');
    eq(vus.length, 4, 'desabonnes : plus personne n est appele');
    /* un carnet impossible a ecrire : l'abonne le sait */
    const recus = [];
    const d5 = pm.apresNote((y) => recus.push(y));
    const tmp = pm.fichier() + '.tmp';
    fs.mkdirSync(tmp);
    try { pm.note(evs, L, T + 2000); } finally { fs.rmdirSync(tmp); d5(); }
    eq(recus.length === 1 && recus[0].ecrit, false, 'carnet impossible a ecrire : l abonne est appele quand meme, avec ecrit = false');
    /* un abonne qui se desabonne pendant son propre appel ne fait pas sauter
       le suivant (mutant E8) */
    let appele = 0;
    const dUn = pm.apresNote(function unCoup() { dUn(); });
    const dSuivant = pm.apresNote(() => { appele++; });
    pm.note(evs, L, T + 3000);
    pm.note(evs, L, T + 3000);
    dSuivant();
    eq(appele, 2, 'un abonne a un seul coup se desabonne en route : le suivant est appele, a chaque fois');
    /* une chaine seule vaut { quoi } aussi pour les abonnes (mutant E12) */
    const qs = [];
    const dQ = pm.apresNote((y) => qs.push(y.quoi + '/' + y.sport));
    pm.note(evs, L, T + 3000, 'periodique');
    pm.note(evs, L, T + 3000);
    dQ();
    eq(qs.join(','), 'periodique/null,null/null', 'note(…, « periodique ») : quoi = periodique ; sans opts : null');
    process.removeListener('unhandledRejection', garde);
  }

  console.log('\n-- 8. les exports de lecture d un livre, la projection du mois --');
  {
    eq(pm.BOURSE, 'betfair_ex_eu', 'BOURSE');
    const e = ODDS.soccer_epl()[0];
    const lot = pm.lotDuLivre(e.bookmakers[0], e);
    ok(lot && lot[1] === 1.62 && lot.N === 4.1 && lot[2] === 6.2, 'lotDuLivre range le livre sur nos issues');
    eq(pm.lotDuLivre(e.bookmakers[0], Object.assign({}, e, { home_team: 'Autre' })), null, 'une equipe qui ne correspond pas : pas de lot');
    const p = pm.sansMarge(lot);
    ok(Math.abs(p[1] + p.N + p[2] - 1) < 1e-9, 'sansMarge : somme 1');
    const r = pm.referenceDe(e);
    ok(r.ref === 'betfair' && ['1', 'N', '2'].every((i) => r.p[i] === p[i]), 'referenceDe lit la bourse avec ce MEME code');
    const PJ = imp.projectionMois;
    const pr = PJ({ utilise: 6000, vu: '2026-10-10T12:00:00.000Z' }, Date.parse('2026-10-10T13:00:00Z'));
    ok(pr.credits === 18000 && pr.depasse === true && pr.jourDuMois === 10 && pr.seuil === 16000, 'projection : 6 000 le 10 → 18 000 sur le mois, au-dessus de 16 000');
    eq(PJ({ utilise: 5000, vu: '2026-10-10T12:00:00.000Z' }, Date.parse('2026-10-10T13:00:00Z')).depasse, false, '5 000 le 10 → 15 000 : sous la porte');
    eq(PJ({ utilise: 900, vu: '2026-09-30T23:00:00.000Z' }, Date.parse('2026-10-01T01:00:00Z')), null, 'un compteur du mois d avant ne projette rien');
    eq(PJ({ utilise: 0, vu: null }), null, 'jamais lu du fournisseur : rien');
    /* le jour est celui de la derniere lecture du compteur, pas celui de
       l'horloge (mutant A23) */
    const p8 = PJ({ utilise: 4000, vu: '2026-10-08T12:00:00.000Z' }, Date.parse('2026-10-10T13:00:00Z'));
    ok(p8 && p8.jourDuMois === 8 && p8.credits === 15000, '4 000 lus le 8, horloge le 10 : 15 000 sur le mois, jour 8 — ' + JSON.stringify(p8));
    /* « au-dessus de 16 000 » : 16 000 pile ne depasse pas (mutant A20) */
    const p16 = PJ({ utilise: 16000, vu: '2026-10-30T12:00:00.000Z' }, Date.parse('2026-10-30T13:00:00Z'));
    ok(p16 && p16.credits === 16000 && p16.depasse === false, '16 000 le 30 : pile au seuil, ne depasse pas');
    /* un compteur sans `utilise` ne projette rien (mutant A25) */
    eq(PJ({ vu: '2026-10-10T12:00:00.000Z' }, Date.parse('2026-10-10T13:00:00Z')), null, 'sans utilise : rien');
    eq(PJ({ utilise: null, vu: '2026-10-10T12:00:00.000Z' }, Date.parse('2026-10-10T13:00:00Z')), null, 'utilise null : rien (Number(null) vaut 0, pas un compteur)');
    /* elle ne conclut pas avant le 7 du mois : le chiffre, sans verdict */
    eq(imp.PROJECTION_JOURS_MIN, 7, 'sept jours avant de conclure');
    const p1 = PJ({ utilise: 700, vu: '2026-11-01T20:00:00.000Z' }, Date.parse('2026-11-01T21:00:00Z'));
    ok(p1 && p1.credits === 21000 && p1.depasse === null && p1.joursMin === 7, '700 le 1er : 21 000 projetes, mais aucune conclusion (avant : depasse) — ' + JSON.stringify(p1));
    eq(PJ({ utilise: 3000, vu: '2026-11-06T20:00:00.000Z' }, Date.parse('2026-11-06T21:00:00Z')).depasse, null, 'le 6 : toujours pas');
    eq(PJ({ utilise: 4200, vu: '2026-11-07T20:00:00.000Z' }, Date.parse('2026-11-07T21:00:00Z')).depasse, true, 'le 7, 4 200 → 18 000 : au-dessus');
    /* branchee dans etatImport, avec ses vrais chiffres (mutant A24 : une
       projection null passait `'projection' in quota`) */
    poseQuota(20000, 0);
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'projection', undefined, {});
    const pe = imp.etatImport().quota.projection, jm = new Date().getUTCDate();
    ok(pe && pe.utilise === utilise && pe.jourDuMois === jm && pe.credits === Math.round(utilise * 30 / jm) && pe.seuil === 16000 &&
       pe.depasse === (jm < 7 ? null : utilise * 30 / jm > 16000),
       `etatImport().quota.projection : ${JSON.stringify(pe)}`);
  }

  console.log('\n-- 9. le compte par classe (la porte des reserves), et deux compteurs ecrits en deux temps --');
  {
    const FC = path.join(BAC, 'odds_classes.json');
    fs.rmSync(FC, { force: true });
    const part = imp.partDuJour(20000);
    /* le meme jour : la classe 3 depense, puis la classe 1 est refusee —
       exactement ce que la porte 3 doit voir */
    poseQuota(20000, 0);
    await imp.appel('/sports/soccer_france_ligue_one/odds', P, 1, 'observation', undefined, { classe: 3 });
    poseQuota(20000, part);
    const iS = {};
    await imp.appel('/sports/soccer_epl/scores', { daysFrom: 3 }, 2, 'scores soccer_epl', undefined, iS).catch(() => {});
    eq(iS.code, 'REFUSE', 'un /scores (classe 1 implicite) refuse a la part');
    const pc = imp.etatImport().quota.parClasse;
    const auj = pc.jours[jour()] || {};
    ok(auj[3] && auj[3].appels === 1 && auj[3].depense === 1 && auj[3].refus === 0, 'classe 3 : un appel, un credit — ' + JSON.stringify(auj[3]));
    ok(auj[1] && auj[1].refus === 1 && auj[1].depense === 0, 'classe 1 : un refus — ' + JSON.stringify(auj[1]));
    eq(pc.classe1RefuseeQuand23Depensent.join(','), jour(), 'la porte 3 voit le jour ou la classe 1 a ete refusee pendant que la classe 3 depensait');
    eq(pc.joursMin, 14, 'la porte ne se juge qu apres 14 jours de compte');
    eq(pc.tiennent, null, 'un seul jour : pas de conclusion');
    /* quinze jours de compte : la porte conclut */
    const jourD = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const passe = {};
    for (let d = 1; d <= 14; d++) passe[jourD(d)] = { 1: { appels: 3, depense: 3, refus: 0, delais: 0 }, 3: { appels: 2, depense: 2, refus: 0, delais: 0 } };
    fs.writeFileSync(FC, JSON.stringify({ jours: passe }));
    eq(imp.etatClasses().tiennent, true, '14 jours sans classe 1 refusee pendant que 2 ou 3 depensent : les reserves tiennent');
    passe[jourD(3)][1].refus = 2;
    fs.writeFileSync(FC, JSON.stringify({ jours: passe }));
    ok(imp.etatClasses().tiennent === false && imp.etatClasses().classe1RefuseeQuand23Depensent.join(',') === jourD(3), 'un tel jour : elles ne tiennent pas, et le jour est dit');
    /* borne a 40 jours */
    const vieux = {};
    for (let d = 1; d <= 45; d++) vieux[jourD(d)] = { 2: { appels: 1, depense: 1, refus: 0, delais: 0 } };
    fs.writeFileSync(FC, JSON.stringify({ jours: vieux }));
    poseQuota(20000, 0);
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'borne', undefined, { classe: 2 });
    const garde = Object.keys(imp.etatClasses().jours).sort();
    ok(garde.length === 40 && garde[garde.length - 1] === jour() && !garde.includes(jourD(40)) && garde.includes(jourD(39)), `40 jours gardes au plus, aujourd hui compris (${garde[0]} a ${garde[garde.length - 1]})`);
    /* ecrit en deux temps : un .tmp impossible laisse l'ancien compte entier */
    const avantC = fs.readFileSync(FC, 'utf8');
    fs.mkdirSync(FC + '.tmp');
    try { await imp.appel('/sports/soccer_epl/odds', P, 1, 'tmp', undefined, { classe: 2 }); } finally { fs.rmdirSync(FC + '.tmp'); }
    eq(fs.readFileSync(FC, 'utf8'), avantC, 'compte par classe : ecriture coupee, l ancien fichier reste entier');
    /* le compteur du quota aussi (relecture : un JSON coupe rouvrait la part
       du jour) */
    poseQuota(20000, 7);
    const avantQ = fs.readFileSync(FQ, 'utf8');
    fs.mkdirSync(FQ + '.tmp');
    try { await imp.appel('/sports/soccer_epl/odds', P, 1, 'tmp quota', undefined, {}); } finally { fs.rmdirSync(FQ + '.tmp'); }
    eq(fs.readFileSync(FQ, 'utf8'), avantQ, 'odds_quota.json : ecriture coupee, l ancien compteur reste entier (avant : ecrit en place)');
    await imp.appel('/sports/soccer_epl/odds', P, 1, 'quota', undefined, {});
    ok(!fs.existsSync(FQ + '.tmp') && imp.etatQuota().depenseDuJour === 8, 'ecriture normale : renomme, aucun .tmp ne reste, le credit compte');
    /* un compteur illisible se dit (une fois) */
    const lignes = [];
    const vraiLog = console.log;
    console.log = (...a) => { lignes.push(a.join(' ')); };
    try {
      fs.writeFileSync(FQ, '{"reste": 1');
      imp.etatQuota(); imp.etatQuota();
    } finally { console.log = vraiLog; }
    eq(lignes.filter((l) => /compteur illisible/.test(l)).length, 1, 'un compteur illisible est dit au journal, une fois');
    fs.rmSync(FQ, { force: true });
    lignes.length = 0;
    console.log = (...a) => { lignes.push(a.join(' ')); };
    try { imp.etatQuota(); } finally { console.log = vraiLog; }
    eq(lignes.length, 0, 'un compteur absent (premier demarrage) ne dit rien');
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log(`\nsocle.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('RATE', e); process.exit(1); });
