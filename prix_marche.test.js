'use strict';
/*
 * LE PRIX DU MARCHE — CE QU'ON VEND, D'OU IL VIENT, CE QU'IL COUTE.
 *
 * ---- pourquoi (08/10/2026) ----
 *
 * Nos cotes sortaient d'un Elo : sur les favoris a 75 % et plus, 11 sur 11
 * etaient gagnants pour le parieur malgre 10 % de marge (210 rencontres
 * appariees au marche). Le proprietaire a choisi de vendre le prix du marche,
 * sans payer de forfait : The Odds API gratuite, une fois par jour, plus un
 * passage avant le coup d'envoi pour ce qui porte des paris.
 *
 * L'essai tient quatre promesses, et les refus d'abord :
 *  1. la reference est la bonne (Betfair, sinon Pinnacle, sinon la mediane
 *     d'au moins trois livres), et un prix aberrant ou mince est ecarte ;
 *  2. au prix de reference, AUCUNE issue du 1-N-2 n'est gagnante pour le
 *     parieur — c'est tout l'objet du changement ;
 *  3. sans prix frais (36 h), la rencontre est SUSPENDUE, jamais rendue a
 *     l'Elo en silence ; et la vente la refuse ;
 *  4. le budget : un credit par championnat et par jour, date ecrite sur le
 *     volume (un redeploiement ne repaie rien), l'etalonnage note les prix
 *     sans un credit de plus, et la liste vide remet l'Elo partout.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'prix-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-essai';
process.env.ODDS_API_FIN = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
process.env.ODDS_API_TOTAL = '500';
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_france_ligue_one';
process.env.ODDS_API_HORIZON = '7';
process.env.PARIS_PRIX_LIGUES = 'soccer_epl';     // la Ligue 1 reste a l'Elo dans ce banc

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

const DEMAIN = Date.now() + 2 * 86400000;
const ev = (id, dom, ext, quand) => ({ id, commence_time: new Date(quand).toISOString(), home_team: dom, away_team: ext });
const EVENTS = {
  soccer_epl: [ev('a1', 'Arsenal', 'Ipswich Town', DEMAIN),
               ev('a2', 'Chelsea', 'Everton', DEMAIN + 3600000),
               ev('a3', 'Equipe Inconnue FC', 'Liverpool', DEMAIN + 7200000)],
  soccer_france_ligue_one: [ev('f1', 'Lyon', 'Monaco', DEMAIN)],
};
const livre = (key, e, c1, cn, c2) => ({ key, markets: [{ key: 'h2h', outcomes: [
  { name: e.home_team, price: c1 }, { name: 'Draw', price: cn }, { name: e.away_team, price: c2 }] }] });
/* Arsenal–Ipswich : un gros favori, la case ou l'Elo se trompait. */
const ODDS = {
  soccer_epl: () => [
    Object.assign({}, EVENTS.soccer_epl[0], { bookmakers: [
      livre('betfair_ex_eu', EVENTS.soccer_epl[0], 1.12, 10.5, 30),
      livre('pinnacle', EVENTS.soccer_epl[0], 1.11, 10.0, 26),
      livre('unibet_eu', EVENTS.soccer_epl[0], 1.09, 9.0, 21),
      livre('williamhill', EVENTS.soccer_epl[0], 1.10, 9.5, 23)] }),
    Object.assign({}, EVENTS.soccer_epl[1], { bookmakers: [
      livre('pinnacle', EVENTS.soccer_epl[1], 1.95, 3.6, 4.2),
      livre('unibet_eu', EVENTS.soccer_epl[1], 1.90, 3.5, 4.0),
      livre('williamhill', EVENTS.soccer_epl[1], 1.91, 3.4, 4.1)] }),
    Object.assign({}, EVENTS.soccer_epl[2], { bookmakers: [
      livre('unibet_eu', EVENTS.soccer_epl[2], 6.0, 4.5, 1.55),
      livre('williamhill', EVENTS.soccer_epl[2], 6.2, 4.4, 1.53),
      livre('bwin', EVENTS.soccer_epl[2], 5.8, 4.6, 1.56)] }),
  ],
  soccer_france_ligue_one: () => [Object.assign({}, EVENTS.soccer_france_ligue_one[0], { bookmakers: [
    livre('pinnacle', EVENTS.soccer_france_ligue_one[0], 2.4, 3.4, 3.0)] })],
};
const appels = [];
const PANNE = new Set();   // championnats dont le fournisseur ne repond plus
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (/espn\.com$/.test(u.hostname)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: [] }) };
  const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
  const ligue = m && m[1], quoi = m && m[2];
  if (PANNE.has(ligue)) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ message: 'panne' }), text: async () => 'panne' };
  const cout = quoi === 'odds' ? u.searchParams.get('markets').split(',').length * u.searchParams.get('regions').split(',').length : 0;
  appels.push({ ligue, quoi, cout });
  const corps = quoi === 'events' ? (EVENTS[ligue] || []) : quoi === 'odds' ? (ODDS[ligue] ? ODDS[ligue]() : []) : [];
  const total = appels.reduce((t, a) => t + a.cout, 0);
  return { ok: true, status: 200,
    headers: { get: (k) => ({ 'x-requests-remaining': String(500 - total), 'x-requests-used': String(total), 'x-requests-last': String(cout) }[k.toLowerCase()] || null) },
    json: async () => corps, text: async () => JSON.stringify(corps) };
};

const pm = require('./prix_marche');
const cotes = require('./cotes');
const paris = require('./paris');
const imp = require('./paris_import');
const { Game } = require('./game');
const credits = () => appels.reduce((t, a) => t + a.cout, 0);
const lisCat = () => JSON.parse(fs.readFileSync(path.join(BAC, 'paris_catalogue.json'), 'utf8')).matchs;
const parEv = (l, e) => l.find((m) => m.source && m.source.evenement === e);

(async () => {
  console.log('\n-- 1. la reference --');
  {
    const e = EVENTS.soccer_epl[0];
    const base = [livre('pinnacle', e, 1.11, 10.0, 26), livre('unibet_eu', e, 1.09, 9.0, 21), livre('williamhill', e, 1.10, 9.5, 23)];
    const r1 = pm.referenceDe(Object.assign({}, e, { bookmakers: [livre('betfair_ex_eu', e, 1.12, 10.5, 30)].concat(base) }));
    eq(r1.ref, 'betfair', 'la bourse Betfair d abord');
    ok(Math.abs(r1.p[1] + r1.p.N + r1.p[2] - 1) < 1e-9, 'probabilites sans marge, somme 1');
    eq(pm.referenceDe(Object.assign({}, e, { bookmakers: base })).ref, 'pinnacle', 'sans Betfair, Pinnacle');
    eq(pm.referenceDe(Object.assign({}, e, { bookmakers: base.slice(1).concat([livre('bwin', e, 1.10, 9.2, 22)]) })).ref,
       'mediane', 'sans l un ni l autre, la mediane d au moins trois livres');
    eq(pm.referenceDe(Object.assign({}, e, { bookmakers: base.slice(1) })), null, 'deux livres ordinaires : pas de prix — on ne devine pas');
    const fige = pm.referenceDe(Object.assign({}, e, { bookmakers: [livre('betfair_ex_eu', e, 1.45, 5.0, 8.0)].concat(base) }));
    eq(fige.ref, 'pinnacle', 'un Betfair a plus de 5 points de la mediane (fige, mince) est ecarte : ' + JSON.stringify(fige.p));
    const arb = pm.referenceDe(Object.assign({}, e, { bookmakers: [livre('betfair_ex_eu', e, 1.20, 12, 40)].concat(base) }));
    eq(arb.ref, 'pinnacle', 'une bourse dont la somme d inverses passe sous 1 (prix perime) est ecartee');
  }

  console.log('\n-- 2. au prix de reference, aucune issue gagnante pour le parieur --');
  {
    /* Barcelone–Getafe du 08/10 : 1,20 chez nous pour 0,905 au marche (+8,6 %). */
    for (const p of [{ 1: 0.905, N: 0.06, 2: 0.035 }, { 1: 0.5, N: 0.27, 2: 0.23 }, { 1: 0.16, N: 0.22, 2: 0.62 }]) {
      const mm = cotes.marchesDuMarche('foot', p);
      const c = mm['1n2'].cotes;
      const ev = Math.max(...['1', 'N', '2'].map((i) => c[i] * p[i] - 1));
      ok(ev < 0, `1-N-2 ${c[1]} / ${c.N} / ${c[2]} : meilleure esperance du parieur ${(ev * 100).toFixed(1)} %`);
      ok(paris.marge(c, 'foot') >= 0.095, `marge du lot ${(paris.marge(c, 'foot') * 100).toFixed(1)} %`);
      ok(Object.keys(mm).length === 6, 'et les cinq autres marches en descendent');
    }
    eq(cotes.marchesDuMarche('foot', { 1: 0.975, N: 0.018, 2: 0.007 }), null,
       'un favori a 97,5 % ne porte pas de marge au-dessus de 1,03 : pas un marche');
  }

  console.log('\n-- 3. l import : sans prix, suspendue ; avec prix, au prix du marche --');
  {
    await imp.importeMatchs();
    paris.charge();
    let l = lisCat();
    const a1 = parEv(l, 'a1'), f1 = parEv(l, 'f1');
    ok(a1 && a1.suspendu && !paris.ouvert(paris.match(a1.id)), 'Premier League sans prix releve : SUSPENDUE, pas a l Elo — ' + (a1 && a1.suspenduRaison));
    ok(f1 && !f1.suspendu && paris.ouvert(paris.match(f1.id)), 'Ligue 1 (hors liste) : a l Elo, ouverte, comme avant');
    const g = new Game(); g._p('0x' + 'a1'.repeat(20)).betBalance = require('ethers').utils.parseUnits('1000000', require('./config').DECIMALS);
    assert.throws(() => g.parie('0x' + 'a1'.repeat(20), a1.id, '1', 1000), /betting is closed/); n++;

    appels.length = 0;
    eq(await imp.rafraichitPrix(['soccer_epl'], 'essai'), 1, 'un releve');
    eq(credits(), 1, 'qui coute UN credit pour tout le championnat');
    await imp.importeMatchs();
    paris.charge();
    l = lisCat();
    const b1 = parEv(l, 'a1'), b2 = parEv(l, 'a2'), b3 = parEv(l, 'a3');
    ok(b1 && !b1.suspendu && b1.prixMarche && b1.prixMarche.ref === 'betfair', 'Arsenal–Ipswich au prix de Betfair');
    ok(b2 && b2.prixMarche && b2.prixMarche.ref === 'pinnacle', 'Chelsea–Everton au prix de Pinnacle');
    ok(b3 && b3.prixMarche && b3.prixMarche.ref === 'mediane' && paris.ouvert(paris.match(b3.id)),
       'une equipe que l Elo ne connait pas se cote quand meme : le prix vient du marche');
    const ref = pm.pour('a1').p, c = b1.marches['1n2'].cotes;
    ok(['1', 'N', '2'].every((i) => c[i] * ref[i] < 1), `Arsenal a ${c[1]} : aucune issue gagnante au prix de Betfair`);
    eq(JSON.stringify(c), JSON.stringify(cotes.marchesDuMarche('foot', ref)['1n2'].cotes), 'et c est exactement ce que le marche donne, plus notre marge');
    ok(paris.match(b1.id).prixMarche && paris.match(b1.id).prixMarche.ref === 'betfair', 'le catalogue en memoire dit d ou vient le prix');
  }

  console.log('\n-- 4. un prix trop vieux suspend --');
  {
    const f = pm.fichier(), c = JSON.parse(fs.readFileSync(f, 'utf8'));
    c.evenements.a1.t -= 37 * 3600000;
    fs.writeFileSync(f, JSON.stringify(c));
    await imp.importeMatchs();
    paris.charge();
    const a1 = parEv(lisCat(), 'a1');
    ok(a1.suspendu && !a1.prixMarche, 'un prix de 37 h ne se vend plus : suspendue — ' + a1.suspenduRaison);
    ok(!paris.ouvert(paris.match(a1.id)), 'et fermee aux paris');
    ok(!parEv(lisCat(), 'a2').suspendu, 'les rencontres au prix frais restent ouvertes');
  }

  console.log('\n-- 5. le budget : une fois par jour, et avant le coup d envoi --');
  {
    const t = Date.now();
    eq(imp.prixPerimes(t).length, 0, 'releve il y a un instant : rien a refaire');
    eq(imp.prixPerimes(t + 23 * 3600000).join(','), 'soccer_epl', '23 h plus tard : le championnat se releve');
    ok(pm.derniere('soccer_epl') > 0 && JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')).ligues.soccer_epl > 0,
       'la date est ECRITE sur le volume : un redeploiement ne repaie rien');
    const b1 = parEv(lisCat(), 'a2');
    const avant = Date.parse(b1.debut) - 3600000;
    const dateLigue = (v) => { const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')); c.ligues.soccer_epl = v; fs.writeFileSync(pm.fichier(), JSON.stringify(c)); };
    dateLigue(avant - 3600000);
    eq(imp.prixAvantMatch((id) => id === b1.id, avant).length, 0, 'une heure avant, avec des paris, mais releve il y a 1 h : rien');
    dateLigue(avant - 4 * 3600000);
    eq(imp.prixAvantMatch((id) => id === b1.id, avant).join(','), 'soccer_epl', 'releve il y a 4 h, une rencontre AVEC paris dans l heure : on releve');
    eq(imp.prixAvantMatch(() => false, avant).length, 0, 'sans paris : on ne depense rien');
    eq(imp.prixAvantMatch((id) => id === b1.id, Date.parse(b1.debut) - 3 * 3600000).length, 0, 'trois heures avant : pas encore');
  }

  console.log('\n-- 6. l etalonnage note les prix sans un credit de plus --');
  {
    const c = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8'));
    c.ligues.soccer_epl = 1;
    fs.writeFileSync(pm.fichier(), JSON.stringify(c));
    appels.length = 0;
    await imp.calibre();
    eq(appels.filter((a) => a.quoi === 'odds').length, 2, 'l etalonnage fait ses deux appels habituels (un par ligue)');
    ok(pm.derniere('soccer_epl') > Date.now() - 60000, 'et la Premier League a son prix du jour, compris dedans');
  }

  console.log('\n-- 7. la liste vide remet l Elo partout --');
  {
    process.env.PARIS_PRIX_LIGUES = '';
    await imp.importeMatchs();
    paris.charge();
    const a1 = parEv(lisCat(), 'a1');
    ok(a1 && !a1.suspendu && !a1.prixMarche && paris.ouvert(paris.match(a1.id)), 'PARIS_PRIX_LIGUES vide : Arsenal revient a l Elo, ouverte');
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
  }

  /* ---- LES TROUS TROUVES A LA RELECTURE DU 08/10 ----
   * Chacun des blocs suivants rejoue un defaut que la premiere version
   * laissait passer, et que la relecture contradictoire a trouve. */

  console.log('\n-- 8. la vente reverifie l age du prix, meme sans import --');
  {
    await imp.importeMatchs();
    paris.charge();
    const m = paris.match(parEv(lisCat(), 'a2').id);
    ok(m.prixMarche && paris.ouvert(m), 'au prix frais : ouverte');
    const t0 = Date.parse(m.prixMarche.t);
    ok(paris.ouvert(m, t0 + 30 * 3600000), '30 h apres le releve : toujours vendable');
    ok(!paris.ouvert(m, t0 + 37 * 3600000),
       '37 h apres, SANS import entre-temps (cle revoquee, fournisseur en panne) : la vente refuse quand meme');
  }

  console.log('\n-- 9. pres du coup d envoi, un prix frais ou rien --');
  {
    const m = paris.match(parEv(lisCat(), 'a2').id);
    const addr = '0x' + 'b2'.repeat(20);
    const g = new Game();
    g._p(addr).betBalance = require('ethers').utils.parseUnits('1000000', require('./config').DECIMALS);
    paris.prixDemandes();
    const sauve = m.prixMarche.t;
    /* Releve 6 h avant le coup d'envoi, pari 2 h avant : prix de 4 h. */
    m.prixMarche.t = new Date(m.debut - 6 * 3600000).toISOString();
    assert.throws(() => g.parie(addr, m.id, '1', 1000, m.debut - 2 * 3600000), /being refreshed/); n++;
    eq(paris.prixDemandes().join(','), 'soccer_epl', 'refuse, et son championnat demande a la minuterie de 10 min');
    eq(paris.prixDemandes().length, 0, 'une demande ne se paie qu une fois');
    g.parie(addr, m.id, '1', 1000, m.debut - 5 * 3600000); n++;      // le meme prix, 5 h avant : on vend
    m.prixMarche.t = new Date(m.debut - 3 * 3600000).toISOString();
    g.parie(addr, m.id, 'N', 1000, m.debut - 2 * 3600000); n++;      // releve il y a 1 h, 2 h avant : on vend
    eq(paris.prixDemandes().length, 0, 'un prix frais ne demande rien');
    m.prixMarche.t = sauve;
  }

  console.log('\n-- 10. un marche retire n a plus de prix --');
  {
    const evs = ODDS.soccer_epl();
    evs[0].bookmakers = [];                                   // Arsenal–Ipswich : 1-N-2 retire
    const c = pm.note([evs[0], evs[2]], 'soccer_epl');        // Chelsea–Everton : absente de la reponse
    eq(c.retires, 2, 'le marche vide ET la rencontre absente sont effaces — ' + JSON.stringify(c));
    ok(!pm.pour('a1') && !pm.pour('a2') && pm.pour('a3'), 'seule la rencontre encore cotee garde son prix');
    await imp.importeMatchs();
    paris.charge();
    ok(parEv(lisCat(), 'a1').suspendu && parEv(lisCat(), 'a2').suspendu,
       'les deux autres sont SUSPENDUES, pas vendues a l ancien prix au moment ou il est faux');
    const avant = Object.keys(pm.lis().evenements).length;
    pm.note([], 'soccer_epl');
    eq(Object.keys(pm.lis().evenements).length, avant, 'une reponse VIDE n efface rien : c est une panne, pas un retrait');
    pm.note(ODDS.soccer_epl(), 'soccer_epl');
  }

  console.log('\n-- 11. un prix colle a l envers suspend --');
  {
    const c = pm.lis(), e = c.evenements.a2;
    [e.dom, e.ext] = [e.ext, e.dom];
    fs.writeFileSync(pm.fichier(), JSON.stringify(c));
    const m = parEv(lisCat(), 'a2');
    const r = imp.avecPrix(m);
    ok(r.suspendu && !r.prixMarche && /orientation/.test(r.suspenduRaison),
       'domicile et exterieur inverses depuis le releve : le favori aurait la cote de l outsider — ' + r.suspenduRaison);
    pm.note(ODDS.soccer_epl(), 'soccer_epl');
    ok(imp.avecPrix(m).prixMarche && !imp.avecPrix(m).suspendu, 'remis a l endroit : au prix');
  }

  console.log('\n-- 12. les marches derives portent la marge mesuree --');
  {
    /* Au 1-N-2 du marche, 10 % ne suffisaient pas sur les buts : 12 % des
       plus/moins et les-deux-marquent restaient battables ; il faut ~22 %. */
    for (const p of [{ 1: 0.905, N: 0.06, 2: 0.035 }, { 1: 0.5, N: 0.27, 2: 0.23 }, { 1: 0.16, N: 0.22, 2: 0.62 }]) {
      const mm = cotes.marchesDuMarche('foot', p);
      const mg = (k) => paris.margeDe(mm[k].cotes, paris.MARCHES[k].issues('foot'), paris.MARCHES[k].couverture);
      const pc = (k) => (mg(k) * 100).toFixed(1) + ' %';
      ok(mg('ou25') >= 0.21 && mg('btts') >= 0.21, `plus/moins ${pc('ou25')}, les-deux-marquent ${pc('btts')}`);
      ok(mg('score') >= 0.30 && mg('hand') >= 0.14, `score exact ${pc('score')}, handicap ${pc('hand')} (margeX 3 et 1,5)`);
      const dc = mm.dc.cotes;
      ok(dc['1X'] * (p[1] + p.N) < 1 && dc[12] * (p[1] + p[2]) < 1 && dc.X2 * (p.N + p[2]) < 1,
         `double chance ${dc['1X']} / ${dc[12]} / ${dc.X2} : exactement fixee par le 1-N-2, aucune issue gagnante`);
    }
  }

  console.log('\n-- 13. la releve des prix passe en priorite, jamais au prix de la fin du mois --');
  {
    const fq = path.join(BAC, 'odds_quota.json');
    const sauve = fs.readFileSync(fq, 'utf8'), q = JSON.parse(sauve);
    const jour = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(fq, JSON.stringify(Object.assign({}, q, { jour, depenseDuJour: imp.partDuJour(q.reste) })));
    assert.throws(() => imp.autorise(1, 'odds essai'), /part du jour/); n++;
    ok(imp.autorise(1, 'prix essai', 6), 'part du jour prise par l etalonnage : la releve des prix passe quand meme');
    const juste = 6 * imp.joursRestants();
    fs.writeFileSync(fq, JSON.stringify(Object.assign({}, q, { jour, reste: juste, depenseDuJour: imp.partDuJour(juste) })));
    /* Plus de quoi relever six championnats par jour jusqu'a la fin : la
       priorite tombe, la part du jour s'applique. */
    assert.throws(() => imp.autorise(1, 'prix essai', 6), /part du jour/); n++;
    fs.writeFileSync(fq, sauve);
  }

  console.log('\n-- 14. jamais deux fois le meme credit --');
  {
    const vieillit = () => { const c = pm.lis(); c.ligues.soccer_epl = 1; fs.writeFileSync(pm.fichier(), JSON.stringify(c)); };
    vieillit();
    appels.length = 0;
    const r = await Promise.all([imp.rafraichitPrix(['soccer_epl'], 'quotidien', imp.PRIX_JOUR_MS),
                                 imp.rafraichitPrix(['soccer_epl'], 'avant le coup d envoi', 3600000)]);
    eq(credits(), 1, 'les minuteries de 30 et 10 min tombent au meme instant : UN credit — ' + JSON.stringify(r));

    vieillit();
    appels.length = 0;
    const tmp = pm.fichier() + '.tmp';
    fs.mkdirSync(tmp);                                        // l'ecriture echoue, comme un volume plein
    await imp.rafraichitPrix(['soccer_epl'], 'essai', imp.PRIX_JOUR_MS);
    await imp.rafraichitPrix(['soccer_epl'], 'essai', imp.PRIX_JOUR_MS);
    eq(credits(), 1, 'carnet impossible a ecrire : la date reste en memoire, la minuterie suivante ne repaie pas');
    fs.rmdirSync(tmp);
    pm.note(ODDS.soccer_epl(), 'soccer_epl');
    ok(pm.lis().ligues.soccer_epl > Date.now() - 60000, 'le volume revenu, la date est ecrite');

    appels.length = 0;
    await imp.calibre();
    eq(appels.filter((a) => a.quoi === 'odds').map((a) => a.ligue).join(','), 'soccer_france_ligue_one',
       'prix de la Premier League frais : l etalonnage ne la repaie pas, son credit va a la ligue encore a l Elo');

    process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_spain_la_liga,soccer_epll';
    eq(imp.prixPerimes(Date.now() + 23 * 3600000).join(','), 'soccer_epl',
       'un championnat sans rencontre au calendrier (treve, cle mal ecrite) ne coute rien');
    process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
  }

  console.log('\n-- 15. une rencontre qui perd son prix reste au calendrier, suspendue --');
  {
    /* Une equipe que l'Elo n'a JAMAIS vue — pas meme a l'etalonnage, qui a
       appris Equipe Inconnue FC aux sections 6 et 14 : sans le marche, elle
       n'est plus cotable. L'ecarter la faisait sortir du calendrier avec ses
       paris, que ni ESPN ni /scores ne reglaient plus. */
    const a4 = ev('a4', 'Nouveau Promu AFC', 'Everton', DEMAIN + 3 * 3600000);
    EVENTS.soccer_epl.push(a4);
    pm.note(ODDS.soccer_epl().concat([Object.assign({}, a4, { bookmakers: [
      livre('unibet_eu', a4, 3.1, 3.4, 2.3), livre('williamhill', a4, 3.0, 3.5, 2.35), livre('bwin', a4, 3.2, 3.3, 2.25)] })]), 'soccer_epl');
    await imp.importeMatchs();
    paris.charge();
    const neuve = parEv(lisCat(), 'a4');
    ok(neuve && neuve.prixMarche && paris.ouvert(paris.match(neuve.id)), 'inconnue de l Elo, au prix du marche : ouverte');
    const c = pm.lis();
    delete c.evenements.a4;
    fs.writeFileSync(pm.fichier(), JSON.stringify(c));
    await imp.importeMatchs();
    paris.charge();
    const a4c = parEv(lisCat(), 'a4');
    ok(a4c && a4c.id === neuve.id && a4c.suspendu && !a4c.prixMarche && !paris.ouvert(paris.match(a4c.id)),
       'son prix perdu : gardee au calendrier sous le meme identifiant, SUSPENDUE — ' + (a4c && a4c.suspenduRaison));

    /* Le fournisseur du calendrier tombe pour la Premier League : ses
       rencontres sont CONSERVEES, et leur prix se reverifie quand meme. */
    pm.note(ODDS.soccer_epl(), 'soccer_epl');
    const d = pm.lis();
    d.evenements.a2.t -= 37 * 3600000;
    fs.writeFileSync(pm.fichier(), JSON.stringify(d));
    PANNE.add('soccer_epl');
    await imp.importeMatchs();
    PANNE.delete('soccer_epl');
    paris.charge();
    const a2 = parEv(lisCat(), 'a2'), a1 = parEv(lisCat(), 'a1');
    ok(a2 && a2.suspendu && !paris.ouvert(paris.match(a2.id)), 'rencontre conservee au prix perime : suspendue — ' + (a2 && a2.suspenduRaison));
    ok(a1 && a1.prixMarche && !a1.suspendu && paris.ouvert(paris.match(a1.id)), 'sa voisine au prix frais : vendue');
  }

  console.log('\n-- 16. observer sans vendre, et la cadence (forfait paye, 09/10) --');
  {
    /* La Ligue 1 du banc est a l'Elo : on l'OBSERVE. Son prix se releve, sa
       couverture et l'ecart de nos cotes se lisent — rien ne se vend au marche. */
    process.env.PARIS_PRIX_OBSERVE = 'soccer_france_ligue_one';
    try {
      appels.length = 0;
      eq(await imp.rafraichitPrix(['soccer_france_ligue_one'], 'essai'), 1, 'un championnat observe se releve');
      eq(credits(), 1, 'pour un credit');
      ok(pm.pour('f1') && pm.lis().couverture.soccer_france_ligue_one && pm.lis().couverture.soccer_france_ligue_one.pinnacle === 1,
         'son prix et sa couverture sont notes (pinnacle 1)');
      await imp.importeMatchs();
      paris.charge();
      const f1 = parEv(lisCat(), 'f1');
      ok(f1 && !f1.suspendu && !f1.prixMarche && paris.ouvert(paris.match(f1.id)), 'observe n est pas vendu : Lyon–Monaco reste a l Elo, ouverte, jamais suspendue');
      const e = imp.etatPrix().soccer_france_ligue_one;
      /* l'attendu, refait a la main : nos cotes Elo x le prix du marche */
      const c = paris.match(f1.id).marches['1n2'].cotes, p = pm.pour('f1').p;
      const attendu = ['1', 'N', '2'].filter((i) => c[i] * p[i] > 1).length;
      ok(e && e.observe === true && e.ecart.avecPrix === 1 && e.ecart.issues === 3 && e.ecart.battables === attendu,
         `etatPrix dit l ecart de nos cotes au marche : ${e && e.ecart.battables}/3 issues battables (attendu ${attendu}), meilleure esperance ${e && e.ecart.esperanceMoyenne}`);
      ok(imp.etatPrix().soccer_epl && !imp.etatPrix().soccer_epl.observe, 'un championnat vendu n est pas marque observe');
      ok(imp.prixPerimes(Date.now() + 23 * 3600000).includes('soccer_france_ligue_one'), 'un championnat observe se releve aussi chaque jour');
    } finally { delete process.env.PARIS_PRIX_OBSERVE; }

    /* La cadence : 22 h par defaut, reglable ; jamais plus espacee que l'age de vente. */
    eq(pm.releveMs(), 22 * 3600000, 'cadence par defaut : 22 h, le forfait gratuit');
    process.env.PARIS_PRIX_RELEVE_H = '3';
    try {
      eq(pm.releveMs(), 3 * 3600000, 'PARIS_PRIX_RELEVE_H=3 : toutes les trois heures');
      ok(imp.prixPerimes(Date.now() + 4 * 3600000).includes('soccer_epl') && !imp.prixPerimes(Date.now() + 3600000).includes('soccer_epl'),
         'a 3 h de cadence : quatre heures plus tard on releve, une heure plus tard non');
      process.env.PARIS_PRIX_RELEVE_H = '99';
      eq(pm.releveMs(), pm.AGE_MAX_MS - 2 * 3600000, 'une cadence plus longue que l age de vente est ramenee sous lui (sinon tout serait suspendu entre deux releves)');
    } finally { delete process.env.PARIS_PRIX_RELEVE_H; }

    /* Avant chaque coup d'envoi, paris ou non, quand on le paie. */
    const b1 = parEv(lisCat(), 'a1');
    const avant = Date.parse(b1.debut) - 3600000;
    const c2 = JSON.parse(fs.readFileSync(pm.fichier(), 'utf8')); c2.ligues.soccer_epl = avant - 4 * 3600000; fs.writeFileSync(pm.fichier(), JSON.stringify(c2));
    eq(imp.prixAvantMatch(() => false, avant).length, 0, 'sans paris : rien avant le coup d envoi (forfait gratuit)');
    process.env.PARIS_PRIX_AVANT_TOUS = '1';
    try {
      eq(imp.prixAvantMatch(() => false, avant).join(','), 'soccer_epl', 'PARIS_PRIX_AVANT_TOUS=1 : on releve avant le coup d envoi, paris ou non');
    } finally { delete process.env.PARIS_PRIX_AVANT_TOUS; }
  }

  console.log(`\nprix_marche.test.js : ${n} verifications OK`);
})().catch((e) => { console.error(e); process.exit(1); });
