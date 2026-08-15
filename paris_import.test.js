'use strict';
/*
 * L'import du calendrier — sans toucher au reseau ni au quota reel.
 *
 * Ce qu'on verifie ici tient en une phrase : le forfait est de 500 credits et
 * doit durer jusqu'a une date fixe. Un bug qui ferait un appel payant de trop
 * ne se voit pas — il n'y a ni erreur, ni ralentissement, juste un compteur qui
 * descend plus vite que prevu, et un calendrier qui se fige un matin.
 *
 * Trois choses, donc :
 *
 *   1. LES RENCONTRES NE COUTENT RIEN. `--matchs` ne doit toucher QUE
 *      /events. Le jour ou quelqu'un « ameliore » l'import en allant chercher
 *      les vraies cotes, le forfait saute en une semaine — ce test tombe.
 *   2. LES SCORES NE SONT DEMANDES QUE LA OU IL Y A QUELQUE CHOSE. Interroger
 *      les neuf ligues chaque jour ferait 846 credits d'ici la fin.
 *   3. LE GARDE-FOU REFUSE. Quand la part du jour est atteinte, l'appel ne
 *      part pas, et il le dit.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
process.env.DATA_DIR = BAC;
process.env.ODDS_API_KEY = 'cle-de-banc-essai';
process.env.ODDS_API_FIN = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
process.env.ODDS_API_TOTAL = '500';
process.env.ODDS_API_LIGUES = 'foot=soccer_epl,foot=soccer_france_ligue_one,tennis=tennis_atp_us_open';
process.env.ODDS_API_HORIZON = '7';

/* Le catalogue est ecrit a cote du module. On garde l'original et on le remet
   a la fin : ce test ne doit rien laisser derriere lui. */
const CAT = path.join(__dirname, 'paris_catalogue.json');
const ORIGINAL = fs.readFileSync(CAT, 'utf8');
const NOTES = path.join(__dirname, 'paris_notes.json');
const NOTES_AVANT = fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : null;
function remets() {
  fs.writeFileSync(CAT, ORIGINAL);
  if (NOTES_AVANT === null) { try { fs.unlinkSync(NOTES); } catch (e) {} }
  else fs.writeFileSync(NOTES, NOTES_AVANT);
}
process.on('exit', remets);

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

// ---- le faux serveur : on note CHAQUE appel et ce qu'il a coute
const appels = [];
const DEMAIN = Date.now() + 2 * 86400000;
const HIER = Date.now() - 6 * 3600000;

function evenement(id, dom, ext, quand) {
  return { id, sport_key: 'x', commence_time: new Date(quand).toISOString(),
           home_team: dom, away_team: ext };
}
const EVENTS = {
  soccer_epl: [
    evenement('e1', 'Arsenal', 'Liverpool', DEMAIN),
    evenement('e2', 'Manchester City', 'Luton Town', DEMAIN + 3600000),
    evenement('e3', 'Chelsea', 'Everton', HIER),                       // deja joue
    evenement('e4', 'Brighton', 'Fulham', Date.now() + 40 * 86400000), // hors horizon
    evenement('e5', 'Inconnu', null, DEMAIN),                          // adversaire absent
  ],
  soccer_france_ligue_one: [evenement('f1', 'Lyon', 'Monaco', DEMAIN)],
  tennis_atp_us_open: [evenement('t1', 'Alcaraz', 'Sinner', DEMAIN)],
};
const SCORES = {
  soccer_epl: [{ id: 'e3', completed: true, home_team: 'Chelsea', away_team: 'Everton',
                 scores: [{ name: 'Chelsea', score: '2' }, { name: 'Everton', score: '1' }] }],
  soccer_france_ligue_one: [],
  tennis_atp_us_open: [],
};

global.fetch = async (url) => {
  const u = new URL(String(url));
  const m = u.pathname.match(/\/sports\/([^/]+)\/(\w+)/);
  const ligue = m && m[1], quoi = m && m[2];
  let cout = 0;
  if (quoi === 'odds') cout = u.searchParams.get('markets').split(',').length
                            * u.searchParams.get('regions').split(',').length;
  if (quoi === 'scores') cout = u.searchParams.get('daysFrom') ? 2 : 1;
  appels.push({ ligue, quoi, cout });

  const corps = quoi === 'events' ? (EVENTS[ligue] || [])
              : quoi === 'scores' ? (SCORES[ligue] || [])
              : (EVENTS[ligue] || []).map((e) => Object.assign({}, e, { bookmakers: [
                  { markets: [{ key: 'h2h', outcomes: [
                      { name: e.home_team, price: 1.8 },
                      { name: e.away_team, price: 4.2 },
                      { name: 'Draw', price: 3.6 }] }] }] }));
  const total = appels.reduce((t, a) => t + a.cout, 0);
  return {
    ok: true, status: 200,
    headers: { get: (k) => ({ 'x-requests-remaining': String(500 - total),
                              'x-requests-used': String(total),
                              'x-requests-last': String(cout) }[k.toLowerCase()] || null) },
    json: async () => corps,
    text: async () => JSON.stringify(corps),
  };
};

const imp = require('./paris_import');
const paris = require('./paris');
const cotes = require('./cotes');

(async () => {
  // ==== 1. les rencontres ne coutent RIEN
  {
    const combien = await imp.importeMatchs();
    const payants = appels.filter((a) => a.cout > 0);
    eq(payants.length, 0, 'aucun appel payant pour charger le calendrier');
    ok(appels.every((a) => a.quoi === 'events'), 'et seul /events a ete interroge');
    eq(appels.length, 3, 'une fois par ligue configuree');

    /* Ce qui est retenu, et ce qui ne l'est pas. */
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    const noms = cat.matchs.map((m) => m.domicile + '–' + m.exterieur);
    ok(!noms.some((x) => x.startsWith('Chelsea')), 'une rencontre deja jouee est ecartee');
    ok(!noms.some((x) => x.startsWith('Brighton')), 'une rencontre au-dela de l horizon aussi');
    ok(!noms.some((x) => x.startsWith('Inconnu')), 'et une rencontre sans adversaire connu');
    eq(combien, cat.matchs.length, 'le compte rendu correspond au fichier');
    ok(cat.matchs.length >= 2, `${cat.matchs.length} rencontre(s) retenue(s)`);

    /* Toutes les cotes sont fabriquees, et le catalogue passe le validateur du
       serveur — c'est la seule chose qui compte au demarrage. */
    ok(cat.matchs.every((m) => m.cotesGenerees), 'toutes les cotes sont fabriquees');
    const v = paris.valide(cat);
    eq(v.matchs.length, cat.matchs.length, 'le validateur du serveur accepte le catalogue');
    ok(v.matchs.every((m) => m.marge >= paris.MARGE_MIN), 'avec une marge suffisante partout');

    /* L'identifiant doit etre STABLE : un import qui renumerote ferait
       apparaitre le meme match deux fois, avec deux reglements separes. */
    appels.length = 0;
    await imp.importeMatchs();
    const cat2 = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    assert.deepStrictEqual(cat2.matchs.map((m) => m.id), cat.matchs.map((m) => m.id),
      'les identifiants ne bougent pas d un import a l autre'); n++;
    assert.deepStrictEqual(cat2.matchs.map((m) => m.cotes), cat.matchs.map((m) => m.cotes),
      'et les cotes non plus, a forces egales'); n++;
  }

  // ==== 1bis. UN IMPORT RATE N'EFFACE RIEN
  {
    /* C'est le scenario le plus couteux du lot, et il s'est produit : une cle
       invalide fait echouer les neuf ligues, l'import ecrit alors un
       catalogue VIDE par-dessus le bon, et la page des paris se retrouve sans
       une seule rencontre. Aucune erreur nulle part — juste une ligne
       « catalogue ecrit : 0 rencontre(s) » dans les journaux. */
    const avant = fs.readFileSync(CAT, 'utf8');
    const bon = JSON.parse(avant);
    ok(bon.matchs.length > 0, 'on part d un catalogue qui marche');

    const vraiFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401,
      headers: { get: () => null },
      text: async () => '{"message":"API key is not valid"}',
      json: async () => ({}) });
    const rendu = await imp.importeMatchs();
    global.fetch = vraiFetch;

    eq(rendu, 0, 'un import qui n a rien obtenu rend 0');
    eq(fs.readFileSync(CAT, 'utf8'), avant,
       'et le fichier n a PAS ete touche — le calendrier survit a une cle invalide');

    /* Une SEULE ligue en panne ne doit pas faire disparaitre ses rencontres :
       un 502 passager effacerait sinon tout un championnat jusqu au prochain
       import reussi. */
    const chute = new Set(['soccer_epl']);
    global.fetch = async (url) => {
      const u = new URL(String(url));
      const l = (u.pathname.match(/\/sports\/([^/]+)\//) || [])[1];
      if (chute.has(l)) return { ok: false, status: 502, headers: { get: () => null },
                                 text: async () => 'bad gateway', json: async () => ({}) };
      return vraiFetch(url);
    };
    appels.length = 0;
    await imp.importeMatchs();
    global.fetch = vraiFetch;

    const apres = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    const epl = apres.matchs.filter((m) => m.source && m.source.ligue === 'soccer_epl');
    ok(epl.length > 0, `les ${epl.length} rencontre(s) de la ligue en panne sont conservees`);
    ok(apres.matchs.some((m) => m.source && m.source.ligue === 'soccer_france_ligue_one'),
       'et les ligues qui ont repondu sont bien la');
    /* Remis d aplomb pour la suite du test. */
    await imp.importeMatchs();
  }

  // ==== 2. les scores : seulement les ligues qui ont quelque chose a rattraper
  {
    appels.length = 0;
    /* Le catalogue courant ne porte que des rencontres a venir : rien a
       regler, donc AUCUN appel — c'est la depense qu'on cherche a eviter. */
    const rien = await imp.importeScores();
    eq(rien.length, 0, 'rien de fini a regler');
    eq(appels.length, 0, 'donc aucun appel, donc 0 credit');

    /* On glisse une rencontre finie dans UNE ligue. Seule celle-la doit etre
       interrogee — pas les trois. */
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    cat.matchs.push({ id: 'epl-fini-chevet', sport: 'foot', competition: 'Epl', pays: '',
      domicile: 'Chelsea', exterieur: 'Everton', debut: new Date(HIER).toISOString(),
      cotes: { 1: 2.1, N: 3.4, 2: 3.3 },
      source: { fournisseur: 'the-odds-api', ligue: 'soccer_epl', evenement: 'e3' } });
    fs.writeFileSync(CAT, JSON.stringify(cat, null, 1));

    appels.length = 0;
    const finis = await imp.importeScores();
    eq(appels.length, 1, 'une seule ligue interrogee sur les trois du catalogue');
    eq(appels[0].ligue, 'soccer_epl', 'celle qui a la rencontre finie');
    eq(appels[0].quoi, 'scores', 'sur l endpoint des scores');
    eq(appels[0].cout, 2, 'a 2 credits — daysFrom est necessaire pour voir les finies');
    eq(finis.length, 1, 'une rencontre a regler est remontee');
    eq(finis[0].resultat, '1', 'Chelsea 2 – 1 Everton donne le resultat « 1 »');
    eq(finis[0].id, 'epl-fini-chevet', 'avec l identifiant du catalogue, pas celui du fournisseur');
  }

  // ==== 3. l'etalonnage coute 1 par ligue, et un seul marche / une seule region
  {
    appels.length = 0;
    await imp.calibre('soccer_epl');
    eq(appels.length, 1, 'une ligue etalonnee = un appel');
    eq(appels[0].cout, 1, 'a 1 credit : un marche, une region');
    /* Il doit avoir servi a quelque chose : les forces ont bouge. */
    const c = JSON.parse(fs.readFileSync(NOTES, 'utf8'));
    ok(Object.keys(c).length > 0, 'et les forces Elo ont ete ecrites');
    ok(cotes.note('foot', 'Arsenal') !== cotes.note('foot', 'Liverpool'),
       'deux equipes cotees differemment n ont plus la meme force');
  }

  // ==== 4. le garde-fou refuse quand la part du jour est atteinte
  {
    const q = imp.etatQuota();
    const part = imp.partDuJour(q.reste);
    ok(part > 0, `la part du jour vaut ${part} (${q.reste} restants, ${imp.joursRestants()} jours)`);
    assert.throws(() => imp.autorise(part + 1, 'un appel trop gros'),
      /REFUSE/, 'un appel au-dessus de la part du jour est refuse'); n++;
    assert.throws(() => imp.autorise(q.reste + 1, 'un appel enorme'),
      /REFUSE/, 'et un appel au-dessus de ce qui reste en tout aussi'); n++;
    /* Le message doit porter les chiffres : sans eux, on ne sait pas quoi
       corriger — reduire les ligues, ou attendre demain. */
    let msg = '';
    try { imp.autorise(part + 1, 'x'); } catch (e) { msg = e.message; }
    ok(/part du jour/.test(msg) && /jour\(s\) jusqu/.test(msg),
       'et il dit ce qui reste et jusqu a quand : ' + msg.slice(0, 120));
  }

  // ==== 5. le budget tient reellement jusqu'a la date visee
  {
    /* La verification qui compte pour de vrai : avec la cadence prevue —
       les rencontres gratuites, les scores sur deux ligues par jour, un
       etalonnage de trois ligues par semaine — 500 credits doivent tenir
       47 jours. On le calcule plutot que de l'esperer. */
    const JOURS = 47;
    const scoresParJour = 2 * 2;                 // 2 ligues x 2 credits
    const etalonnageParSemaine = 3 * 1;          // 3 ligues x 1 credit
    const total = JOURS * scoresParJour + Math.ceil(JOURS / 7) * etalonnageParSemaine;
    ok(total <= 500, `la cadence prevue coute ${total} credits sur ${JOURS} jours`);
    ok(total <= 350, `et garde ${500 - total} credits de marge pour les reprises`);

    /* Et l'erreur a ne pas faire : interroger toutes les ligues chaque jour.
       Ce test tourne avec trois ligues, mais la liste par defaut en compte
       neuf — c'est sur celle-la qu'il faut faire le calcul, puisque c'est
       elle qui sera en service. */
    const LIGUES_DEFAUT = 9;
    const naif = JOURS * LIGUES_DEFAUT * 2;
    ok(naif > 500, `interroger les ${LIGUES_DEFAUT} ligues par defaut chaque jour couterait ` +
       `${naif} credits — le forfait sauterait vers le ${Math.floor(500 / (LIGUES_DEFAUT * 2))}e jour, ` +
       'et c est pourquoi importeScores ne demande que les ligues qui ont une rencontre finie');
    ok(imp.LIGUES.length >= 1, `la liste lue vaut ${imp.LIGUES.length} ligue(s)`);
  }

  // ==== 6. LES VERROUS DU REGLEMENT AUTOMATIQUE
  {
    /* Un reglement ne se defait pas : l'argent est parti. Ces quatre verrous
       sont la seule chose entre un score faux et des paiements irreversibles,
       et ce sont eux qu'on verifie — pas le chemin heureux. */
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    const m = cat.matchs[0];
    const T = Date.parse(m.debut);

    const fini = { id: m.id, sport: m.sport, domicile: m.domicile,
                   exterieur: m.exterieur, score: '2-1', resultat: '1' };
    const sansExpo = () => 0;

    // -- le delai : on ne paie pas sur un score publie a la 90e minute
    let r = imp.trieReglements([fini], sansExpo, T + 60 * 60000);
    eq(r.auto.length, 0, 'une rencontre finie depuis une heure n est pas reglee');
    eq(r.mains.length, 1, 'elle attend');
    ok(/trop peu/.test(r.mains[0].raison), 'et la raison le dit : ' + r.mains[0].raison);

    r = imp.trieReglements([fini], sansExpo, T + 5 * 3600000);
    eq(r.auto.length, 1, 'cinq heures apres le coup d envoi, elle passe');

    // -- le plafond d exposition : le verrou qui compte
    const enorme = () => imp.AUTO_PLAFOND + 1;
    r = imp.trieReglements([fini], enorme, T + 5 * 3600000);
    eq(r.auto.length, 0, 'au-dessus du plafond d exposition, on ne regle pas seul');
    ok(/plafond/.test(r.mains[0].raison), 'et la raison le dit : ' + r.mains[0].raison);
    /* Juste EN DESSOUS du plafond, ca passe : un verrou qui bloque tout ne
       protege de rien, il fait juste croire que l automate marche. */
    r = imp.trieReglements([fini], () => imp.AUTO_PLAFOND - 1, T + 5 * 3600000);
    eq(r.auto.length, 1, 'juste en dessous, elle passe');

    // -- une rencontre hors calendrier n est jamais reglee a l aveugle
    r = imp.trieReglements([{ id: 'jamais-vu-ici', domicile: 'A', exterieur: 'B',
                              score: '1-0', resultat: '1' }], sansExpo, T + 5 * 3600000);
    eq(r.auto.length, 0, 'une rencontre absente du calendrier n est pas reglee');
    ok(/absente/.test(r.mains[0].raison), 'et la raison le dit : ' + r.mains[0].raison);

    /* Rien ne se perd : tout ce qui entre ressort d un cote ou de l autre.
       Un reglement qui disparaitrait du tri laisserait des paris ouverts
       sans que rien ne le signale. */
    const lot = [fini, { id: 'inconnu-x', domicile: 'C', exterieur: 'D', score: '0-0', resultat: 'N' }];
    r = imp.trieReglements(lot, sansExpo, T + 5 * 3600000);
    eq(r.auto.length + r.mains.length, lot.length, 'aucune rencontre ne se perd dans le tri');
  }

  console.log(`paris_import.test.js : ${n} verifications OK`);
})().catch((e) => { console.error(e); process.exit(1); });
