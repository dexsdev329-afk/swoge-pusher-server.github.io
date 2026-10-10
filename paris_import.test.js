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
/* Le prix du marche (08/10/2026) a son propre essai, prix_marche.test.js, qui
   l'exerce AVEC l'import. Ici on mesure la mecanique de l'import (credits,
   identifiants, rencontres deplacees) : sans prix releve, les grands
   championnats seraient suspendus et chaque essai d'ouverture le verrait. */
process.env.PARIS_PRIX_LIGUES = '';

/* ---- OU LE CATALOGUE S'ECRIT ----
 *
 * SUR LE VOLUME (`DATA_DIR`), et plus a cote du module. Le dossier de
 * l'application est efface a chaque redeploiement : le calendrier importe y
 * disparaissait, et avec lui la possibilite de regler les paris poses sur ses
 * rencontres. Le fichier du depot n'est plus qu'une AMORCE, lue tant que le
 * volume est vide — ce test la laisse donc intacte.
 */
const CAT = path.join(BAC, 'paris_catalogue.json');
const AMORCE = path.join(__dirname, 'paris_catalogue.json');
const ORIGINAL = fs.readFileSync(AMORCE, 'utf8');
const NOTES = path.join(__dirname, 'paris_notes.json');
const NOTES_AVANT = fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : null;
function remets() {
  /* L'amorce ne doit pas avoir bouge : si elle a bouge, c'est que l'import
     ecrit encore dans le depot, et le bug est de retour. */
  if (fs.readFileSync(AMORCE, 'utf8') !== ORIGINAL) {
    console.error('\n[!] l amorce du depot a ete REECRITE par l import');
    fs.writeFileSync(AMORCE, ORIGINAL);
    process.exitCode = 1;
  }
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

const SPORTS_LISTE = [];
global.fetch = async (url) => {
  const u = new URL(String(url));
  /* ---- ESPN N'EST PAS THE ODDS API ----
   * Le reglement consulte d'abord les tableaux publics d'ESPN, qui sont
   * gratuits. Ce banc-la compte les CREDITS, donc les appels payants : laisser
   * les appels gratuits entrer dans le compteur ferait echouer « une seule
   * ligue interrogee » sur une depense qui n'a pas eu lieu.
   * On leur repond un tableau vide : ce fichier mesure le budget de The Odds
   * API, et la couverture d'ESPN a son propre essai. */
  if (/espn\.com$/.test(u.hostname)) {
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => ({ events: [] }) };
  }
  /* La liste des sports (gratuite) : c est elle que lit le joker du tennis. */
  if (/\/sports\/?$/.test(u.pathname)) {
    appels.push({ ligue: null, quoi: 'sports', cout: 0 });
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => SPORTS_LISTE, text: async () => '[]' };
  }
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
    /* Les rencontres IMPORTEES ont des cotes fabriquees. Les autres — celles
       du calendrier precedent, que l'import conserve desormais — gardent les
       leurs : une cote relevee a la main vaut mieux que la notre. */
    const importees = cat.matchs.filter((m) => m.source);
    ok(importees.length > 0, `${importees.length} rencontre(s) importee(s)`);
    ok(importees.every((m) => m.cotesGenerees),
       'toutes les cotes des rencontres importees sont fabriquees');
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

  // ==== 1bis-a. UN IMPORT REUSSI N'EFFACE PAS LES AUTRES RENCONTRES
  {
    /* Le bug le plus couteux de la serie, et il s'est produit EN PRODUCTION :
       le premier import reel a efface vingt et une rencontres ecrites a la
       main — sept de Championship, quatorze de tennis — parce qu'aucune ligue
       suivie ne les rendait.
       Ce n'est pas cosmetique. Un pari porte l'identifiant de son match ; si
       le match quitte le catalogue, `regleMatch` jette « unknown match ». La
       rencontre ne peut plus etre REGLEE, seulement remboursee — donc celui
       qui avait gagne ne peut plus etre paye. */
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    const etranger = {
      id: 'ecrit-a-la-main-1', sport: 'foot', competition: 'Championship', pays: '',
      domicile: 'Bristol City', exterieur: 'Millwall',
      debut: new Date(Date.now() + 3 * 86400000).toISOString(),
      cotes: { 1: 2.1, N: 3.3, 2: 3.4 },
    };
    const vieux = Object.assign({}, etranger, { id: 'ecrit-a-la-main-vieux',
      debut: new Date(Date.now() - 120 * 86400000).toISOString() });
    cat.matchs.push(etranger, vieux);
    fs.writeFileSync(CAT, JSON.stringify(cat, null, 1));

    appels.length = 0;
    await imp.importeMatchs();
    const apres = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    const ids = apres.matchs.map((m) => m.id);

    ok(ids.includes('ecrit-a-la-main-1'),
       'une rencontre a venir qu AUCUNE ligue ne rend est CONSERVEE — sinon ses paris sont bloques');
    ok(ids.some((x) => x.startsWith('epl-')) || apres.matchs.some((m) => m.source),
       'et les rencontres importees sont bien la, elles aussi');
    ok(!ids.includes('ecrit-a-la-main-vieux'),
       'une rencontre vieille de quatre mois finit par sortir du catalogue');

    /* Le remplacement reste possible : une rencontre importee ECRASE
       l'ancienne de meme identifiant — horaire et cotes peuvent bouger. */
    const doublons = ids.filter((x, i) => ids.indexOf(x) !== i);
    eq(doublons.length, 0, 'et aucun identifiant n apparait deux fois');
    paris.valide(apres); n++;
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

  // ==== 1ter. LES DRAPEAUX
  {
    /* `/events` ne rend QUE des noms : ni pays, ni code, ni logo. Le drapeau
       vient donc d'ailleurs, et il vaut mieux ne pas en mettre que d'en
       mettre un faux — un mauvais drapeau est pris pour une information. */
    eq(imp.paysDe('Bolton', 'soccer_epl'), 'GB',
       'un club de championnat national herite du pays de sa ligue');
    eq(imp.paysDe('Lyon', 'soccer_france_ligue_one'), 'FR', 'idem en Ligue 1');
    eq(imp.paysDe('Real Madrid', 'soccer_uefa_champs_league'), 'ES',
       'en Ligue des champions la ligue ne dit rien : la table prend le relais');
    eq(imp.paysDe('PARIS  sg', 'soccer_uefa_champs_league'), 'FR',
       'et elle ignore la casse et les espaces en trop');
    eq(imp.paysDe('Etcheverry T. M.', 'tennis_atp_us_open'), 'AR',
       'au tennis c est la table seule — et c est la que le drapeau sert le plus');
    eq(imp.paysDe('Equipe Jamais Vue', 'tennis_atp_us_open'), null,
       'un nom inconnu ne recoit AUCUN drapeau, jamais un au hasard');
    eq(imp.paysDe('Equipe Jamais Vue', 'soccer_epl'), 'GB',
       'sauf si sa ligue le dit avec certitude');

    /* Et le catalogue ecrit les porte bien. */
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    const avecDrapeau = cat.matchs.filter((m) => m.paysDomicile && m.paysExterieur);
    ok(avecDrapeau.length > 0, `${avecDrapeau.length} rencontre(s) sur ${cat.matchs.length} portent leurs deux drapeaux`);
    /* Absent, null, ou deux majuscules : les rencontres conservees du
       calendrier precedent n'ont pas forcement la clef, et `paris.valide`
       transforme l'absence en null. Ce qu'on interdit, c'est une valeur
       PRESENTE et mal formee — elle donnerait deux lettres a l'ecran au lieu
       d'un drapeau. */
    ok(cat.matchs.every((m) => m.paysDomicile == null || /^[A-Z]{2}$/.test(m.paysDomicile)),
       'un code de pays est soit absent, soit deux majuscules — jamais autre chose');
    /* Le validateur du serveur refuse tout ce qui n'est pas ISO2 : un code de
       travers donnerait deux lettres chinoises a l'ecran au lieu d'un drapeau. */
    const v = paris.valide(cat);
    ok(v.matchs.some((m) => m.paysDomicile), 'le validateur du serveur les garde');
  }

  // ==== 1quater. UNE ERREUR NE DOIT PAS VIDER LE COMPTEUR
  {
    /* Le piege : une reponse d'erreur ne porte AUCUN en-tete de quota, et
       `Number(null)` vaut ZERO — qui est fini. On ecrivait donc « 0 credit
       restant » a la premiere erreur venue, apres quoi le garde-fou refusait
       tout appel payant et plus rien ne se reglait. Pour une cle mal
       recopiee. */
    const vraiFetch = global.fetch;
    const avant = imp.etatQuota().reste;
    ok(avant > 0, `on part de ${avant} credit(s)`);

    global.fetch = async () => ({ ok: false, status: 401,
      headers: { get: () => null },              // une erreur : pas d en-tetes
      text: async () => '{"message":"API key is not valid"}', json: async () => ({}) });
    await imp.importeMatchs();
    global.fetch = vraiFetch;

    eq(imp.etatQuota().reste, avant,
       'une reponse sans en-tete de quota ne touche PAS au compteur');
    ok(imp.partDuJour(imp.etatQuota().reste) > 1,
       'et la part du jour reste utilisable — sinon plus rien ne se reglerait');

    /* Le compte rendu doit dire ce qui s'est passe, sinon la question
       « pourquoi pas plus de matchs ? » n'a pas de reponse lisible. */
    const e = imp.etatImport();
    eq(e.cle, true, 'l etat dit que la cle est posee');
    ok(e.dernier.matchs && e.dernier.matchs.ecrit === false,
       'et que le dernier import n a rien ecrit');
    ok(/no league answered/.test(e.dernier.matchs.pourquoi || ''),
       'en disant pourquoi : ' + e.dernier.matchs.pourquoi);
    ok((e.dernier.matchs.echouees || []).length > 0, 'et quelles ligues ont echoue');
    /* La cle elle-meme ne doit JAMAIS ressortir. */
    ok(!JSON.stringify(e).includes(process.env.ODDS_API_KEY),
       'et la cle n apparait nulle part dans l etat');
    await imp.importeMatchs();                 // on remet le catalogue d aplomb
  }

  // ==== 1 bis. UNE LIGUE DONT LE SPORT N EST PAS DECLARE EST ECARTEE
  /*
   * `ODDS_API_LIGUES` est une variable d environnement : c est la porte la plus
   * large de ce module, et la seule que quelqu un ouvre pour elargir le
   * calendrier. Une ligne « hockey=icehockey_nhl » passait sans un mot, et la
   * faute ressortait bien plus loin — a la validation du catalogue, sur un
   * message qui parlait d un identifiant de match et non de la ligne qu on
   * venait d ecrire.
   *
   * Et avant ce garde, `issues()` rendait CELLES DU FOOTBALL a tout sport
   * inconnu : trois issues pour un sport qui n en a peut-etre que deux, avec
   * un nul cote au hasard. Rien ne cassait, rien ne le disait.
   */
  {
    const frais = process.env.ODDS_API_LIGUES;
    process.env.ODDS_API_LIGUES =
      'foot=soccer_epl,hockey=icehockey_nhl,tennis=tennis_atp_us_open';
    delete require.cache[require.resolve('./paris_import')];
    const dit = [];
    const vraiErr = console.error;
    console.error = (...a2) => dit.push(a2.join(' '));
    const imp2 = require('./paris_import');
    console.error = vraiErr;

    const gardees = imp2.LIGUES.map((l) => l.sport + '=' + l.clef);
    eq(gardees.join(','), 'foot=soccer_epl,tennis=tennis_atp_us_open',
       'la ligue au sport inconnu est ecartee, les autres passent — un import'
       + ' qui refuserait TOUT priverait le calendrier pour une ligne de trop');
    ok(dit.some((m2) => /hockey/.test(m2) && /SPORTS dans paris\.js/.test(m2)),
       'et on le DIT, en nommant le sport et le fichier ou le declarer : '
       + (dit[0] || 'rien').slice(0, 90));

    process.env.ODDS_API_LIGUES = frais;
    delete require.cache[require.resolve('./paris_import')];
    require('./paris_import');
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
    /* 08/10/2026 : `/scores` rend le score final, prolongation comprise, sans
       le dire. Mais en CHAMPIONNAT il n'y a pas de prolongation : le banc
       d'ESPN de ce fichier rend un tableau vide, et ce Chelsea–Everton de
       Premier League se regle seul, comme avant. */
    ok(!finis[0].aMain, 'un football de championnat venu de The Odds API se regle seul');
    ok(imp.prolongationPossible({ source: { ligue: 'soccer_uefa_champs_league' } })
       && imp.prolongationPossible({ source: { ligue: 'soccer_usa_mls' } })
       && imp.prolongationPossible({ source: { ligue: 'soccer_spain_copa_del_rey' } })
       && !imp.prolongationPossible({ source: { ligue: 'soccer_epl' } }),
       'la C1, les series MLS et toute coupe peuvent aller en prolongation ; la Premier League non');

    /* ---- ET SEULEMENT LA OU DE L ARGENT ATTEND ----
     *
     * Un score ne sert QU A regler des paris — les forces Elo se recalent par
     * `--calibre`, qui est un autre appel. Une rencontre finie sur laquelle
     * personne n a mise n a donc rien a nous apprendre, et on la payait deux
     * credits par jour, pendant trois jours, par ligue.
     *
     * Le meme calcul vaut pour une rencontre DEJA REGLEE : la releve tourne
     * chaque jour et repassait dessus jusqu a ce qu elle sorte de la fenetre.
     * Depuis que le reglement automatique fonctionne, elles sont tranchees des
     * la premiere passe — les deux suivantes ne servaient plus a rien.
     */
    appels.length = 0;
    const vide = await imp.importeScores(() => false);
    eq(appels.length, 0,
       'aucun pari en attente : AUCUN appel, donc zero credit la ou l on en'
       + ' depensait deux par jour et par ligue');
    eq(vide.length, 0, 'et rien ne remonte, evidemment');

    appels.length = 0;
    const cible = await imp.importeScores((id) => id === 'epl-fini-chevet');
    eq(appels.length, 1, 'un pari en attente sur UNE rencontre rouvre la depense');
    eq(cible.length, 1, 'et la rencontre remonte a regler');

    /* SANS RAPPEL, ON DEMANDE POUR TOUT. Le module ne connait pas le moteur :
       en l absence de reponse, mieux vaut depenser un credit de trop que
       laisser un gagnant impaye. */
    appels.length = 0;
    await imp.importeScores();
    eq(appels.length, 1,
       'sans rappel, on garde l ancien comportement : on demande pour tout');
    eq(finis[0].id, 'epl-fini-chevet', 'avec l identifiant du catalogue, pas celui du fournisseur');
  }

  // ==== 2 bis. LE COMPTE DE CHAQUE /scores PAYE, ET LA COUPE ETEINTE (lot 4, 10/10/2026)
  /*
   * La porte B (EXPLOITATION 8.10) se juge cle par cle sur ce que le
   * fournisseur a REELLEMENT facture (x-requests-last), jamais sur une
   * supposition : le cout d'un /scores vide ou en erreur n'est pas documente.
   * Une erreur ne porte pas d'en-tete : son cout est null (JAMAIS 0, l'intention
   * du commentaire d'`appel`), puis deduit de x-requests-used a l'appel
   * suivant si rien d'autre n'a ete facture entre les deux, sinon
   * « indecidable ». La coupe ne vise que les cles NON cochees « Scores &
   * Results », et reste ETEINTE par defaut.
   */
  {
    const rj = require('./reglement_journal');
    const H1 = 3600000;
    /* Les credits de cette section ne sont pas ceux des suivantes : le
       compteur du banc est remis tel quel a la fin (sinon la part du jour,
       21, est mangee et le § 9 voit ses /scores refuses). */
    const QUOTA = path.join(BAC, 'odds_quota.json'), CLASSES = path.join(BAC, 'odds_classes.json');
    const lit = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    const quotaAvant = lit(QUOTA), classesAvant = lit(CLASSES);
    /* et elle part d'une journee vierge : ses ~20 credits ne doivent pas
       dependre de ce que les sections d'avant ont deja depense */
    if (quotaAvant) fs.writeFileSync(QUOTA, JSON.stringify(Object.assign(JSON.parse(quotaAvant), { depenseDuJour: 0 }), null, 2) + '\n');
    const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    if (!cat.sports.some((s) => s.cle === 'cricket')) cat.sports.push({ cle: 'cricket', nom: 'Cricket', actif: true });
    const crick = (id, ligue, debut, ev) => ({ id, sport: 'cricket', competition: 'Essai', pays: '', domicile: 'India ' + id, exterieur: 'Australia ' + id,
      debut: new Date(debut).toISOString(), cotes: { 1: 1.8, 2: 1.95 }, source: { fournisseur: 'the-odds-api', ligue, evenement: ev || id } });
    /* ipl-x, hun-x, puis odi-x : les ligues s'interrogent dans l'ordre du
       calendrier, et la deduction (B3) lit l'appel QUI PRECEDE l'erreur et
       celui QUI LA SUIT */
    cat.matchs.push(crick('ipl-x', 'cricket_ipl', HIER), crick('hun-x', 'cricket_the_hundred', HIER), crick('odi-x', 'cricket_odi', HIER),
                    crick('odi-jeune', 'cricket_odi', Date.now() - 1 * H1),
                    /* un ODI commence il y a 11 h : surement fini (un ODI dure ~8 h) */
                    crick('odi-fin', 'cricket_odi', Date.now() - 11 * H1));
    fs.writeFileSync(CAT, JSON.stringify(cat, null, 1));
    const lignesDe = async (f) => { const lu = [], vrai = console.log; console.log = (...x) => { lu.push(x.join(' ')); }; try { await f(); } finally { console.log = vrai; } return lu; };
    const entrees = (clef) => rj.brut().scores.filter((e) => e.clef === clef);

    /* B1 : cricket_odi rend [] avec x-requests-last = 2 */
    appels.length = 0;
    let dits = await lignesDe(() => imp.importeScores((id) => id === 'odi-x'));
    eq(appels.filter((a) => a.quoi === 'scores').map((a) => a.ligue).join(','), 'cricket_odi', 'un seul /scores, pour la cle du pari');
    let b = rj.bilanScores(Date.now(), 30).cricket_odi;
    ok(b && b.appels === 1 && b.credits === 2 && b.appariees === 0 && b.inutiles === 1,
       'le journal compte : 1 appel, 2 credits lus, 0 appariee, 1 inutile — ' + JSON.stringify(b && { appels: b.appels, credits: b.credits, appariees: b.appariees, inutiles: b.inutiles }));
    ok(dits.some((x) => /^\[odds\] scores cricket_odi : 2 credit\(s\), 0 rendue\(s\), 0 finie\(s\), 0 appariee\(s\) — INUTILE$/.test(x)),
       'la ligne de journal dit INUTILE : ' + (dits.find((x) => /scores cricket_odi :/.test(x)) || 'rien'));

    /* B2 : une 422 sans en-tete, UNKNOWN_SPORT dans le corps, seule */
    const vraiFetch = global.fetch;
    /* le compteur du fournisseur continue celui du banc : il ne recule jamais */
    let utilise = Number(imp.etatQuota().utilise) || 0;
    const factureSans = new Set(['cricket_the_hundred']);
    let intrus = false;
    global.fetch = async (url) => {
      const u = new URL(String(url));
      if (/espn\.com$/.test(u.hostname)) return vraiFetch(url);
      const ligue = (u.pathname.match(/\/sports\/([^/]+)\//) || [])[1];
      if (ligue === 'intrus') {                      // un autre appel paye, facture sans en-tete
        utilise += 1;
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'erreur', json: async () => ({}) };
      }
      appels.push({ ligue, quoi: 'scores', cout: 2 });
      utilise += 2;                                  // le fournisseur facture, en-tete ou pas
      if (factureSans.has(ligue) && intrus) {
        /* pendant la 422, un AUTRE appel paye part (une releve de prix en
           parallele) et revient sans en-tete : la deduction ne doit plus rien
           conclure */
        intrus = false;
        try { await imp.appel('/sports/intrus/odds', { regions: 'eu' }, 1, 'intrus (essai)', undefined, {}); } catch (er) { /* attendu */ }
      }
      if (factureSans.has(ligue)) {
        return { ok: false, status: 422, headers: { get: () => null },
                 text: async () => '{"message":"Unknown sport","error_code":"UNKNOWN_SPORT"}', json: async () => ({}) };
      }
      return { ok: true, status: 200, headers: { get: (k) => ({ 'x-requests-remaining': String(20000 - utilise), 'x-requests-used': String(utilise), 'x-requests-last': '2' }[k.toLowerCase()] || null) },
               json: async () => [], text: async () => '[]' };
    };
    try {
      await lignesDe(() => imp.importeScores((id) => id === 'hun-x'));
      const e = entrees('cricket_the_hundred').pop();
      ok(e && e.cout === null, 'une erreur sans en-tete : credits null, JAMAIS 0 — ' + JSON.stringify(e && e.cout));
      eq(e && e.statut, 422, 'statut 422');
      eq(e && e.code, 'UNKNOWN_SPORT', 'code UNKNOWN_SPORT, lu dans le corps');
      ok(e && e.indecidable === true, 'seule, sans appel suivant : « indecidable »');
      /* le journal en panne a ce moment-la ne fait pas lever la releve */
      const vraiDeduit = rj.deduitCout;
      rj.deduitCout = () => { throw new Error('volume plein (essai)'); };
      let leve = null;
      try { await lignesDe(() => imp.importeScores((id) => id === 'hun-x')); } catch (er) { leve = er; } finally { rj.deduitCout = vraiDeduit; }
      ok(!leve, 'deduitCout qui leve sur la derniere erreur de la passe : importeScores ne leve pas');
      b = rj.bilanScores(Date.now(), 30).cricket_the_hundred;
      ok(b && b.credits === 0 && b.indecidables === 1 && b.inutiles === 0, 'et elle ne compte ni comme credit ni comme inutile');

      /* B3 : la meme 422, ENTRE deux /scores qui portent leurs en-tetes. La
         422 de B2 a ete facturee sans le dire : le compteur lu avant B2
         (au debut de B3, un appel PLUS TARD) l'aurait absorbee — d'ou la
         lecture de l'appel QUI PRECEDE dans la meme passe. */
      const avant = utilise;
      dits = await lignesDe(() => imp.importeScores((id) => id === 'ipl-x' || id === 'hun-x' || id === 'odi-x'));
      eq(appels.slice(-3).map((a) => a.ligue).join(','), 'cricket_ipl,cricket_the_hundred,cricket_odi', 'trois /scores, dans l ordre du calendrier');
      const e2 = entrees('cricket_the_hundred').pop();
      eq(e2 && e2.coutDeduit, 2, `son cout est deduit de x-requests-used (${avant} -> ${utilise}) : 2, pas 4 (la 422 de B2 n est pas absorbee)`);
      ok(dits.some((x) => /scores cricket_the_hundred : 2 credit\(s\) deduit\(s\) de x-requests-used/.test(x)), 'et la deduction se dit');
      b = rj.bilanScores(Date.now(), 30).cricket_the_hundred;
      ok(b.credits === 2 && b.deduits === 1 && b.inutiles === 1 && b.indecidables === 1, 'deduit, il compte : 2 credits, 1 inutile ; celle de B2 reste indecidable');
      /* sans appel a en-tete AVANT elle dans la passe : indecidable, jamais devine */
      dits = await lignesDe(() => imp.importeScores((id) => id === 'hun-x' || id === 'odi-x'));
      const e3 = entrees('cricket_the_hundred').pop();
      ok(e3 && e3.indecidable === true && e3.coutDeduit === undefined, 'la 422 en tete de passe, meme suivie d un appel a en-tete : indecidable');
      /* un autre appel paye, sans en-tete, entre l'erreur et l'appel suivant :
         x-requests-used compte les deux, la deduction ne conclut pas */
      intrus = true;
      await lignesDe(() => imp.importeScores((id) => id === 'ipl-x' || id === 'hun-x' || id === 'odi-x'));
      ok(!intrus, 'l appel intrus est bien parti pendant la 422');
      const e4 = entrees('cricket_the_hundred').pop();
      ok(e4 && e4.indecidable === true && e4.coutDeduit === undefined,
         'un autre appel facture entre la 422 et l appel suivant : indecidable, jamais 3 credits attribues a la 422 — ' + JSON.stringify(e4 && { d: e4.coutDeduit, i: e4.indecidable }));
    } finally { global.fetch = vraiFetch; }

    /* B4 : la coupe, ETEINTE par defaut */
    const T = Date.now();
    const deja = rj.bilanScores(T, 30).cricket_odi.inutiles;
    for (let i = 0; i < 4; i++) rj.noteAppelScores('cricket_odi', { t: T - (i + 1) * 86400000, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
    const inut = rj.bilanScores(T, 30).cricket_odi.inutiles;
    ok(inut === deja + 4 && inut >= 5, `${inut} appels payes inutiles sur 30 jours pour cricket_odi (${deja} de B1 a B3, 4 de plus sur les jours d avant)`);
    appels.length = 0;
    await lignesDe(() => imp.importeScores((id) => id === 'odi-x'));
    eq(appels.filter((a) => a.ligue === 'cricket_odi').length, 1, 'PARIS_SCORES_COUPE non posee : l appel part quand meme (on compte, on ne coupe pas)');
    process.env.PARIS_SCORES_COUPE = '1';
    try {
      appels.length = 0;
      let finisC;
      dits = await lignesDe(async () => { finisC = await imp.importeScores((id) => id === 'odi-x' || id === 'odi-fin'); });
      eq(appels.filter((a) => a.ligue === 'cricket_odi').length, 0, 'PARIS_SCORES_COUPE=1 et au moins 5 inutiles sur 30 jours : PLUS aucun /scores pour cricket_odi');
      /* Relecture du lot 4 : ses rencontres partent « a la main » quand leur
         FORMAT est surement fini (ODI : 10 h), jamais au mur des 200 min du
         football — sinon un ODI en cours serait annonce « resultat a
         saisir » sur le canal public. */
      const f = finisC.find((x) => x.id === 'odi-fin');
      ok(f && f.coupe && /scores plus demandes pour cricket_odi .*verifier que la rencontre est finie/.test(f.aMain || ''),
         'et sa rencontre de 11 h part « a la main », avec sa raison : ' + (f && f.aMain));
      ok(!finisC.some((x) => x.id === 'odi-x'), 'celle de 6 h (un ODI dure ~8 h) n est encore nulle part : ' + finisC.map((x) => x.id).join(','));
      ok(dits.some((x) => /scores cricket_odi : jamais appariee sur \d+ appel\(s\) paye\(s\) inutile\(s\) en 30 jours — plus demandee, a regler a la main/.test(x)), 'la coupe se dit');
      const r = imp.trieReglements([f], () => 0, Date.now());
      ok(!r.auto.length && r.mains.length === 1, 'le tri la garde a la main');
      /* une cle COCHEE n'est jamais coupee */
      for (let i = 0; i < 6; i++) rj.noteAppelScores('soccer_france_ligue_one', { t: T - i * 3600000, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
      eq(imp.clefCoupee('soccer_france_ligue_one', Date.now()), null, 'une cle cochee « Scores & Results » (Ligue 1), six inutiles : JAMAIS coupee');
      /* une cle qui a apparie une fois n'est jamais coupee */
      for (let i = 0; i < 6; i++) rj.noteAppelScores('cricket_ipl', { t: T - i * 3600000, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
      ok(imp.clefCoupee('cricket_ipl', Date.now()) !== null, 'cricket_ipl, six inutiles : coupee');
      rj.noteAppelScores('cricket_ipl', { t: T, cout: 2, statut: 200, appariees: 1, vieux: true, declencheurs: 1 });
      eq(imp.clefCoupee('cricket_ipl', Date.now()), null, 'une seule appariee sur 30 jours : jamais coupee');
      /* un appel paye pour un match EN COURS est precoce, pas inutile */
      for (let i = 0; i < 6; i++) rj.noteAppelScores('cricket_big_bash', { t: T - i * 3600000, cout: 2, statut: 200, vieux: false, declencheurs: 1 });
      eq(imp.clefCoupee('cricket_big_bash', Date.now()), null, 'six appels precoces (match en cours) : pas une raison de couper');
      /* plus de 30 jours : hors fenetre */
      for (let i = 0; i < 6; i++) rj.noteAppelScores('cricket_psl', { t: T - (31 + i) * 86400000, cout: 2, statut: 200, vieux: true, declencheurs: 1 });
      eq(imp.clefCoupee('cricket_psl', Date.now()), null, 'six inutiles d il y a plus de 30 jours : hors fenetre glissante');
      /* gratuits (x-requests-last a 0) : rien a economiser, rien a couper */
      for (let i = 0; i < 6; i++) rj.noteAppelScores('cricket_asia_cup', { t: T - i * 3600000, cout: 0, statut: 200, vieux: true, declencheurs: 1 });
      eq(imp.clefCoupee('cricket_asia_cup', Date.now()), null, 'six reponses a 0 credit : rien a couper');
      const pB = imp.bilanReglement(Date.now()).porteB;
      ok(pB.cricket_asia_cup && pB.cricket_asia_cup.motif === 'gratuit' && pB.cricket_asia_cup.verdict === null, 'porte B : « rien a economiser » attend ses 30 jours (motif gratuit)');
      ok(pB.soccer_france_ligue_one && pB.soccer_france_ligue_one.cochee && pB.soccer_france_ligue_one.verdict === null, 'porte B : une cle cochee n est jamais jugee');
      ok(pB.cricket_odi && pB.cricket_odi.coupee === true && pB.cricket_odi.verdict === null, 'porte B : cricket_odi coupee par la variable, verdict attendu a 30 jours');
    } finally { delete process.env.PARIS_SCORES_COUPE; }

    /* B5 : un pari sur un match commence il y a 1 h — PARIS_SCORES_SAUTE_ENCOURS */
    appels.length = 0;
    dits = await lignesDe(() => imp.importeScores((id) => id === 'odi-jeune'));
    eq(appels.filter((a) => a.ligue === 'cricket_odi').length, 1, 'drapeau eteint : le /scores part pour un match commence il y a 1 h (comme avant)');
    ok(dits.some((x) => /scores cricket_odi : 2 credit\(s\).* — precoce/.test(x)), 'et il est compte « precoce », pas inutile');
    process.env.PARIS_SCORES_SAUTE_ENCOURS = '1';
    try {
      appels.length = 0;
      dits = await lignesDe(() => imp.importeScores((id) => id === 'odi-jeune'));
      eq(appels.length, 0, 'PARIS_SCORES_SAUTE_ENCOURS=1 : plus de /scores paye pour lui');
      ok(dits.some((x) => /1 rencontre\(s\) commencee\(s\) depuis moins de 200 min — pas de score paye/.test(x)), 'et ca se dit');
      appels.length = 0;
      await lignesDe(() => imp.importeScores((id) => id === 'odi-x'));
      eq(appels.filter((a) => a.ligue === 'cricket_odi').length, 1, 'un match fini depuis 6 h, lui, est toujours paye');
    } finally { delete process.env.PARIS_SCORES_SAUTE_ENCOURS; }
    /* remis : le calendrier sans les rencontres de cette section */
    const cat2 = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    cat2.matchs = cat2.matchs.filter((m) => !['ipl-x', 'odi-x', 'hun-x', 'odi-jeune', 'odi-fin'].includes(m.id));
    fs.writeFileSync(CAT, JSON.stringify(cat2, null, 1));
    paris.charge(CAT);
    for (const [f, v] of [[QUOTA, quotaAvant], [CLASSES, classesAvant]]) { if (v === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, v); }
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
       Ce test tourne avec trois ligues, mais c'est sur la liste par defaut
       qu'il faut faire le calcul, puisque c'est elle qui sera en service —
       neuf ligues au depart, vingt-six depuis le 18 septembre 2026, dont le
       joker du tennis qui en vaut autant qu il y a de tournois en cours. */
    const LIGUES_DEFAUT = imp.LIGUES_DEFAUT.length;
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
    /* lot 4 : « pas encore », pas « a la main » — la passe frequente ne la
       publie pas sur le canal public (paris_auto.test.js compte les envois) */
    eq(r.mains[0].attente, true, 'et elle est marquee « en attente » (attente: true)');

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

  // ================== LA NFL ARRIVE A LA SEMAINE 1, PAS EN PRESAISON
  //
  // En aout, seize matchs de presaison se jouent — mesure faite — et The Odds
  // API les range sous une clef separee. L'ajouter tiendrait en une ligne, et
  // c'est justement pourquoi ce refus doit etre ECRIT : sans lui, la prochaine
  // personne qui voit un onglet NFL vide en aout ajoutera la ligne, avec les
  // meilleures intentions.
  //
  // Les titulaires jouent un quart-temps en presaison. Nos cotes sortent d'un
  // Elo bati sur des equipes COMPLETES : elles n'y veulent rien dire. Ouvrir un
  // marche dont on sait que le prix est faux, c'est offrir de l'argent a qui le
  // remarque.
  {
    /* La liste PAR DEFAUT, et non celle du banc : cet essai pose
       `ODDS_API_LIGUES` en tete de fichier, ce qui masquerait justement la
       decision qu'on vient verifier. */
    const dedans = imp.LIGUES_DEFAUT.map((x) => x.split('=')[1]);
    ok(dedans.indexOf('americanfootball_nfl') >= 0, 'la NFL est suivie');
    const pre = dedans.filter((k) => /preseason/i.test(k));
    eq(pre.length, 0,
       'et AUCUNE presaison n est suivie' + (pre.length ? ' — ' + pre.join(', ') : ''));
  }

  // ================== ON DEMANDE LA MEME FENETRE QU ON FILTRE
  //
  // Des paris tennis attendaient depuis TROIS CENTS HEURES dans le panneau. La
  // cause n'etait pas le tennis : on demandait `daysFrom=1` — les rencontres
  // finies depuis la veille — alors que la boucle du dessus retient tout ce qui
  // a moins de TROIS jours. Une rencontre de deux jours etait donc mise dans la
  // liste, payee deux credits, et absente de la reponse. Elle glissait ensuite
  // hors des trois jours, ou plus rien ne la regardait : elle restait a regler
  // pour toujours.
  //
  // Le cout ne change pas — `daysFrom` vaut deux credits quelle que soit sa
  // valeur. On demandait moins pour le meme prix.
  {
    /* On lit la SOURCE, pas les appels du banc : le compteur d'appels est
       remis a zero entre les sections, et ce qu'on verifie ici est un accord
       entre deux constantes, pas un passage. */
    const src = fs.readFileSync(path.join(__dirname, 'paris_import.js'), 'utf8');
    /* La valeur REELLEMENT envoyee, pas la premiere du fichier : les
       commentaires en parlent aussi, et un essai qui lit un commentaire ne
       verifie rien. */
    const m = /appel\(`\/sports\/\$\{clef\}\/scores`, \{ daysFrom: (\d+) \}/.exec(src);
    ok(!!m, 'la fenetre demandee se lit dans le code');
    const fen = /const FENETRE = (\d+) \* 86400000/.exec(src);
    ok(!!fen, 'et la fenetre filtree aussi');
    eq(Number(m[1]), Number(fen[1]),
       'les deux sont la MEME : ce qu on filtre est ce qu on demande');
    /* Et la source gratuite, elle, n'a pas de fenetre d'API : on ne lui impose
       pas celle de l'autre, sinon l'arriere reste bloque. */
    const esp = /const FEN_ESPN = (\d+) \* 86400000/.exec(src);
    ok(!!esp && Number(esp[1]) > Number(fen[1]),
       `ESPN remonte plus loin (${esp ? esp[1] : '?'} jours contre ${fen[1]})`
       + ' — c est ce qui rattrape ce qui a rate son creneau');
  }

  /* ==========================================================================
   * LA DATE JUSQU'A LAQUELLE LE QUOTA DOIT TENIR SE CALCULE
   *
   * Elle valait `2026-09-30`, ecrit en dur. Le forfait se recharge au premier
   * du mois : le 1er octobre, `joursRestants()` serait retombe a son plancher
   * de 1 et `partDuJour` — 90 % du solde divise par les jours restants —
   * aurait autorise quatre cent cinquante credits EN UN JOUR. Le garde-fou ne
   * se serait pas plaint : il aurait simplement cesse de garder.
   * ======================================================================== */
  console.log('\n-- la fin de periode suit le calendrier, elle ne s ecrit pas a la main --');
  {
    const fixe = process.env.ODDS_API_FIN;
    delete process.env.ODDS_API_FIN;
    /* Des mois de 31, de 30, un fevrier ordinaire et un fevrier bissextile :
       c est le calendrier qui repond, pas une table ecrite a la main. */
    ok(imp.finDuMois(Date.parse('2026-09-10T10:00:00Z')) === '2026-09-30', 'septembre finit le 30');
    ok(imp.finDuMois(Date.parse('2026-10-01T00:00:00Z')) === '2026-10-31',
       'et le 1er octobre bascule sur le 31 octobre, sans que personne n y touche');
    ok(imp.finDuMois(Date.parse('2026-12-31T23:00:00Z')) === '2026-12-31',
       'le dernier jour de l annee est encore dans son propre mois');
    ok(imp.finDuMois(Date.parse('2027-02-05T00:00:00Z')) === '2027-02-28', 'un fevrier ordinaire finit le 28');
    ok(imp.finDuMois(Date.parse('2028-02-05T00:00:00Z')) === '2028-02-29', 'et un fevrier bissextile le 29');
    ok(imp.fin() === imp.finDuMois(), 'sans variable posee, la fin de periode est celle du mois en cours');
    /* Et le jour du basculement il reste un mois entier a rationner, pas un
       seul jour — c est tout ce que ce correctif change. */
    /* Le nombre de jours attendu se RECALCULE ici, sur la meme horloge : un
       seuil ecrit en dur (« moins de cent ») serait tombe le 30 du mois, ou
       joursRestants vaut legitimement 1. Un essai qui depend du jour ou on le
       lance ne mesure pas ce qu il croit. */
    const attendus = Math.max(1, Math.ceil((Date.parse(imp.finDuMois() + 'T23:59:59Z') - Date.now()) / 86400000));
    const j = imp.joursRestants();
    ok(j === attendus, `il reste ${j} jour(s), et c est bien ce que le calendrier dit (${attendus})`);
    ok(imp.partDuJour(500) === Math.max(1, Math.floor(500 * 0.9 / attendus)),
       `la part du jour suit ce compte : ${imp.partDuJour(500)} credit(s) sur 500`);
    /* Et le point du correctif : le 1er octobre, l ancienne date figee au
       30 septembre donnait UN jour restant, donc 450 credits autorises dans la
       journee. La date qui roule en donne trente et un. */
    const avant = Math.max(1, Math.ceil((Date.parse('2026-09-30T23:59:59Z') - Date.parse('2026-10-01T12:00:00Z')) / 86400000));
    const apres = Math.max(1, Math.ceil((Date.parse(imp.finDuMois(Date.parse('2026-10-01T12:00:00Z')) + 'T23:59:59Z') - Date.parse('2026-10-01T12:00:00Z')) / 86400000));
    ok(avant === 1 && apres === 31,
       `le 1er octobre : la date figee laissait ${avant} jour (450 credits autorises d un coup), celle qui roule en laisse ${apres}`);
    /* La variable garde la priorite : viser un tournoi reste possible. La date
       se calcule sur l horloge, sinon l essai tomberait le jour ou elle passe. */
    const tournoi = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    process.env.ODDS_API_FIN = tournoi;
    ok(imp.fin() === tournoi, 'et une date A VENIR posee a la main l emporte toujours');
    /* 08/10/2026 : la variable etait restee posee sur 2026-09-30 en production —
       « 469 credit(s), part du jour 422 jusqu au 2026-09-30 » au journal. Une
       echeance passee ne vise plus rien : elle retombe sur la fin du mois. */
    process.env.ODDS_API_FIN = '2026-09-30';
    ok(imp.fin() === imp.finDuMois(), 'une date DEJA PASSEE est ignoree : retour a la fin du mois en cours');
    ok(imp.partDuJour(469) === Math.max(1, Math.floor(469 * 0.9 / attendus)),
       `et la part du jour redevient ${imp.partDuJour(469)} sur 469, pas ${Math.floor(469 * 0.9)} d un coup`);
    process.env.ODDS_API_FIN = '30/09/2026';
    ok(imp.fin() === imp.finDuMois(), 'une date illisible aussi');
    if (fixe === undefined) delete process.env.ODDS_API_FIN; else process.env.ODDS_API_FIN = fixe;
  }

  // ==== 10. LE TENNIS SUIT LES TOURNOIS TOUT SEUL
  /*
   * Le 18 septembre 2026, la liste par defaut portait encore les deux cles de
   * l US Open, inactives depuis dix jours : le tennis etait vide, et rien ne
   * le disait. « tennis=* » lit les cles actives sur /sports — gratuit — au
   * moment de l import. Ce qu on verifie : les cles actives entrent, les
   * inactives et les classements non, un joker d un autre sport est refuse
   * en le disant, la liste n est relue qu apres douze heures, et tout cela ne
   * coute pas un credit.
   */
  {
    const frais = process.env.ODDS_API_LIGUES;
    process.env.ODDS_API_LIGUES = 'foot=soccer_epl,tennis=*,nba=*';
    delete require.cache[require.resolve('./paris_import')];
    const dit = [];
    const vraiErr = console.error;
    console.error = (...a2) => dit.push(a2.join(' '));
    const imp3 = require('./paris_import');
    console.error = vraiErr;
    ok(dit.some((m2) => /nba=\*/.test(m2) && /tennis/.test(m2)),
       'le joker d un autre sport est ecarte en le disant : ' + (dit[0] || 'rien').slice(0, 80));
    eq(imp3.LIGUES.map((l) => l.sport + '=' + l.clef).join(','), 'foot=soccer_epl,tennis=*',
       'la liste ecrite garde le joker tel quel');
    SPORTS_LISTE.splice(0, SPORTS_LISTE.length,
      { key: 'tennis_atp_us_open', active: false, group: 'Tennis' },
      { key: 'tennis_wta_guadalajara_open', active: true, group: 'Tennis' },
      { key: 'tennis_atp_tokyo', active: true, group: 'Tennis' },
      { key: 'tennis_atp_french_open_winner', active: true, group: 'Tennis' },
      { key: 'basketball_nba', active: true, group: 'Basketball' },
      { key: 'soccer_epl', active: true, group: 'Soccer' });
    const avant = appels.length;
    const l1 = await imp3.liguesEnService();
    eq(l1.map((l) => l.sport + '=' + l.clef).join(','),
       'foot=soccer_epl,tennis=tennis_wta_guadalajara_open,tennis=tennis_atp_tokyo',
       'en service, le joker vaut les tournois ACTIFS — ni l US Open fini, ni le classement, ni la NBA');
    eq(appels.slice(avant).map((a) => a.quoi).join(','), 'sports', 'lus en un appel a /sports');
    eq(appels.slice(avant).reduce((t, a) => t + a.cout, 0), 0, 'qui ne coute rien');
    const l2 = await imp3.liguesEnService();
    eq(appels.length, avant + 1, 'et la liste n est pas relue avant douze heures');
    eq(l2.length, l1.length, 'la seconde lecture rend la meme chose');
    ok(imp3.etatImport().jokers && /tennis=tennis_wta_guadalajara_open\+tennis_atp_tokyo/.test(imp3.etatImport().jokers.cles.join(' ')),
       'et l etat de l import DIT ce que le joker a donne : ' + imp3.etatImport().jokers.cles.join(' '));
    process.env.ODDS_API_LIGUES = frais;
    delete require.cache[require.resolve('./paris_import')];
    require('./paris_import');
  }

  // ==== 9. UNE RENCONTRE DEPLACEE NE RESTE PAS OUVERTE (08/10/2026)
  {
    /* L'identifiant porte la DATE. Une rencontre deplacee d'un jour revient
     * sous un AUTRE identifiant, et l'ancienne entree restait ouverte jusqu'a
     * son ancienne heure : avancee, elle acceptait des paris apres le vrai
     * match, puis ESPN la reglait avec le vrai score. Trois cas, et le
     * quatrieme qui ne doit RIEN fermer. */
    console.log('\n-- une rencontre deplacee ne reste pas ouverte --');
    const garde = JSON.parse(JSON.stringify(EVENTS));
    const LOIN = Date.now() + 4 * 86400000;
    EVENTS.soccer_epl = [evenement('dep1', 'Arsenal', 'Liverpool', LOIN),
                         evenement('dep2', 'Manchester City', 'Luton Town', LOIN + 3600000),
                         evenement('dep3', 'Chelsea', 'Everton', LOIN + 7200000)];
    EVENTS.soccer_france_ligue_one = [evenement('f1', 'Lyon', 'Monaco', DEMAIN)];
    await imp.importeMatchs();
    const lis = () => JSON.parse(fs.readFileSync(CAT, 'utf8')).matchs;
    const de = (ev, l) => (l || lis()).filter((m) => m.source && m.source.evenement === ev);
    const [a1] = de('dep1'), [a2] = de('dep2'), [a3] = de('dep3'), [lyon] = de('f1');
    ok(a1 && a2 && a3 && lyon && !a1.ferme && !a2.ferme && !a3.ferme, 'les quatre rencontres sont au calendrier, ouvertes');

    /* Un autre jour que LOIN : un autre identifiant. A MIDI UTC, pas « maintenant
       + 30 h » : lance entre 18 h et 19 h UTC, maintenant + 30 h tombait apres
       minuit et l'avance d'une heure plus bas (AVANCEE - 1 h) avant — un jour,
       donc un identifiant, de plus, et un troisieme ticket regle au score
       (releve du 08/10 : rouge a 18 h, vert a 19 h 22, meme code).
       A J+1 et non J+2 : DEMAIN met e1 (Arsenal–Liverpool lui aussi) a J+2, la
       nouvelle entree aurait pris le suffixe -2 et l'essai n'aurait plus jamais
       exerce l'identifiant sans collision. Une seule lecture de l'horloge : lue
       trois fois, un passage de mois entre deux lectures donnait une date
       passee de quatre semaines. */
    const J0 = new Date(), AVANCEE = Date.UTC(J0.getUTCFullYear(), J0.getUTCMonth(), J0.getUTCDate() + 1, 12);
    const REPORTEE = LOIN + 2 * 86400000;
    EVENTS.soccer_epl = [evenement('dep1', 'Arsenal', 'Liverpool', AVANCEE),
                         evenement('dep2', 'Manchester City', 'Luton Town', REPORTEE)];   // dep3 n'est plus rendue
    EVENTS.soccer_france_ligue_one = [];                                                 // une reponse vide ne prouve rien
    await imp.importeMatchs();
    let l = lis();
    const v1 = l.find((m) => m.id === a1.id), n1 = de('dep1', l).find((m) => m.id !== a1.id);
    ok(v1 && v1.ferme && /avancee/.test(v1.fermeRaison), 'AVANCEE : l ancienne entree est fermee — ' + (v1 && v1.fermeRaison));
    eq(Date.parse(v1.debut), AVANCEE, 'et prend la vraie heure, pour qu ESPN la retrouve et que le ticket dise vrai');
    ok(n1 && !n1.ferme, 'la nouvelle entree, elle, est ouverte');
    const v2 = l.find((m) => m.id === a2.id);
    ok(v2 && v2.ferme && /reportee/.test(v2.fermeRaison), 'REPORTEE : fermee aussi — ' + (v2 && v2.fermeRaison));
    const v3 = l.find((m) => m.id === a3.id);
    ok(v3 && v3.ferme && /plus rendue/.test(v3.fermeRaison), 'PLUS RENDUE par une ligue qui a repondu : fermee — ' + (v3 && v3.fermeRaison));
    const v4 = l.find((m) => m.id === lyon.id);
    ok(v4 && !v4.ferme, 'une ligue qui rend une liste VIDE ne ferme rien : un trou de reponse n est pas un deplacement');

    paris.charge(CAT);
    ok(!paris.ouvert(paris.match(a1.id)), 'le serveur la voit fermee aux paris');
    ok(paris.ouvert(paris.match(n1.id)), 'et la nouvelle ouverte');
    const t5 = Date.parse(v1.debut) + 5 * 3600000;
    let r = imp.trieReglements([{ id: a1.id, sport: 'foot', domicile: 'Arsenal', exterieur: 'Liverpool',
                                 score: '2-1', resultat: '1' }], () => 0, t5);
    eq(r.auto.length, 0, 'une rencontre fermee par l import ne se regle jamais seule');
    ok(/fermee/.test(r.mains[0].raison), 'elle attend la main, et le dit : ' + r.mains[0].raison);
    r = imp.trieReglements([{ id: n1.id, sport: 'foot', domicile: 'Arsenal', exterieur: 'Liverpool',
                              score: '2-2', resultat: 'N', aMain: 'football fini en STATUS_FINAL_AET (ESPN)' }], () => 0, t5);
    eq(r.auto.length, 0, 'un resultat marque « a la main » par la releve non plus');
    ok(/AET/.test(r.mains[0].raison), 'avec la raison de la releve : ' + r.mains[0].raison);

    await imp.importeMatchs();
    l = lis();
    const w1 = l.find((m) => m.id === a1.id);
    ok(w1 && w1.ferme === v1.ferme && w1.fermeRaison === v1.fermeRaison, 'un import de plus ne refait rien : la fermeture reste la premiere');
    ok(JSON.stringify(w1.marches) === JSON.stringify(v1.marches), 'et ses cotes ne bougent plus : une rencontre fermee n est jamais retarifee');

    /* ---- REPORTEE : ELLE GARDE SON HEURE ----
       Si le report est annule et que le match se joue a son heure, ses
       gagnants doivent remonter dans « a regler » ce jour-la. */
    eq(Date.parse(v2.debut), Date.parse(a2.debut), 'REPORTEE : l entree fermee garde son heure d origine, pas l heure annoncee');
    EVENTS.soccer_epl = [evenement('dep1', 'Arsenal', 'Liverpool', AVANCEE - 3600000),
                         evenement('dep2', 'Manchester City', 'Luton Town', Date.parse(a2.debut) + 3 * 86400000)];
    await imp.importeMatchs();
    l = lis();
    eq(Date.parse(l.find((m) => m.id === a1.id).debut), AVANCEE - 3600000, 'une entree DEJA fermee suit encore une avance du fournisseur');
    eq(Date.parse(l.find((m) => m.id === a2.id).debut), Date.parse(a2.debut), 'mais jamais un report');
    /* Le report ANNULE : l'evenement revient a son jour d'origine. La version
       fraiche reprend l'identifiant de sa premiere entree (meme evenement, meme
       base) : c'est elle qui porte les paris d'avant, rouverte a son heure. */
    EVENTS.soccer_epl = [evenement('dep1', 'Arsenal', 'Liverpool', AVANCEE - 3600000),
                         evenement('dep2', 'Manchester City', 'Luton Town', Date.parse(a2.debut))];
    await imp.importeMatchs();
    l = lis();
    const r2 = l.find((m) => m.id === a2.id);
    ok(r2 && !r2.ferme && r2.source.evenement === 'dep2' && Date.parse(r2.debut) === Date.parse(a2.debut),
       'report annule : la premiere entree revient, ouverte, a son heure');
    ok(de('dep2', l).filter((m) => !m.ferme).length === 1, 'et une seule entree de l evenement reste ouverte');

    /* ---- LES DEUX ENTREES D'UN MEME EVENEMENT SE REGLENT ----
       Joue, l'evenement porte l'ancienne entree (fermee) et la nouvelle : `find`
       n'en reglait qu'une. */
    const cat9 = JSON.parse(fs.readFileSync(CAT, 'utf8'));
    for (const m of cat9.matchs) if (m.id === a1.id || m.id === n1.id) m.debut = new Date(HIER).toISOString();
    fs.writeFileSync(CAT, JSON.stringify(cat9, null, 1));
    paris.charge(CAT);
    SCORES.soccer_epl.push({ id: 'dep1', completed: true, home_team: 'Arsenal', away_team: 'Liverpool',
                             scores: [{ name: 'Arsenal', score: '1' }, { name: 'Liverpool', score: '1' }] });
    const regles9 = await imp.importeScores();
    const ids9 = regles9.filter((f) => f.score === '1-1').map((f) => f.id).sort();
    eq(ids9.join(','), [a1.id, n1.id].sort().join(','), 'les deux entrees de l evenement recoivent le score');
    r = imp.trieReglements(regles9.filter((f) => f.score === '1-1'), () => 0, Date.now() + 3600000);
    ok(r.mains.some((f) => f.id === a1.id) && r.auto.some((f) => f.id === n1.id),
       'l ancienne (fermee) part a la main, la nouvelle se regle seule');
    SCORES.soccer_epl.pop();

    /* ---- RENOMMEE, MEME HEURE : un autre identifiant, la meme rencontre ---- */
    const LOIN3 = Date.now() + 5 * 86400000;
    EVENTS.soccer_epl = [evenement('ren', 'Tottenham Hotspur', 'Everton', LOIN3)];
    await imp.importeMatchs();
    const [tot] = de('ren');
    EVENTS.soccer_epl = [evenement('ren', 'Spurs', 'Everton', LOIN3)];
    await imp.importeMatchs();
    l = lis();
    const totV = l.find((m) => m.id === tot.id), totN = de('ren', l).find((m) => m.id !== tot.id);
    ok(totV && totV.ferme && /reprise sous l identifiant/.test(totV.fermeRaison),
       'equipe RENOMMEE par le fournisseur : l ancienne entree est fermee — ' + (totV && totV.fermeRaison));
    ok(totN && !totN.ferme, 'la nouvelle est ouverte : jamais deux entrees ouvertes pour un meme match');

    /* ---- UN PROGRAMME DOUBLE GARDE SES IDENTIFIANTS ----
       Le suffixe « -2 » suivait l'ordre de la reponse : le match 2 prenait
       l'identifiant du match 1 des que celui-ci, commence, n'etait plus
       importe — et ses paris se seraient regles avec le score du match 2. */
    const J = Date.parse(new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10) + 'T06:00:00Z');
    EVENTS.soccer_epl = [evenement('dh1', 'Arsenal', 'Chelsea', J), evenement('dh2', 'Arsenal', 'Chelsea', J + 5 * 3600000)];
    await imp.importeMatchs();
    const id1 = de('dh1')[0].id, id2 = de('dh2')[0].id;
    ok(id1 !== id2 && id2 === id1 + '-2', `deux matchs le meme jour : ${id1} et ${id2}`);
    EVENTS.soccer_epl = [evenement('dh2', 'Arsenal', 'Chelsea', J + 5 * 3600000), evenement('dh1', 'Arsenal', 'Chelsea', J)];
    await imp.importeMatchs();
    l = lis();
    eq(de('dh1', l).map((m) => m.id).join(','), id1, 'la reponse dans l autre ordre : chacun garde SON identifiant (match 1)');
    eq(de('dh2', l).map((m) => m.id).join(','), id2, '(match 2)');
    EVENTS.soccer_epl = [evenement('dh1', 'Arsenal', 'Chelsea', Date.now() - 600000), evenement('dh2', 'Arsenal', 'Chelsea', J + 5 * 3600000)];
    await imp.importeMatchs();
    l = lis();
    const e1 = l.find((m) => m.id === id1), e2 = l.find((m) => m.id === id2);
    ok(e1 && e1.source.evenement === 'dh1', 'le match 1 commence (plus importe) garde son entree : ' + (e1 && e1.source.evenement));
    ok(e2 && e2.source.evenement === 'dh2' && !e2.ferme, 'et le match 2 garde la sienne, ouverte — il ne prend pas celle du match 1');

    for (const k of Object.keys(EVENTS)) delete EVENTS[k];
    Object.assign(EVENTS, garde);
  }

  console.log(`paris_import.test.js : ${n} verifications OK`);
})().catch((e) => { console.error(e); process.exit(1); });
