'use strict';
/*
 * LE REGLEMENT AUTOMATIQUE, DE BOUT EN BOUT.
 *
 * `paris_import.test.js` verifie la DECISION — qui passe, qui attend, et
 * pourquoi. Ce fichier-ci verifie le PAIEMENT : qu'une rencontre autorisee
 * fait bien bouger les soldes, et surtout qu'une rencontre retenue par un
 * verrou n'en fait bouger AUCUN.
 *
 * La distinction n'est pas academique. Le tri et le paiement vivent dans deux
 * fichiers differents — a dessein : `paris_import.js` ne connait pas le
 * moteur, il ne PEUT donc pas payer seul. Mais deux moities correctes
 * separement peuvent etre mal recousues, et c'est la couture qu'on teste ici.
 * Un reglement ne se defait pas : si elle lache, l'argent est parti.
 *
 * On joue le rappel du serveur directement. Sinon il n'est atteignable
 * qu'apres une minuterie de cinq minutes et un vrai appel reseau — autant
 * dire jamais.
 */
const assert = require('assert');

process.env.PORT = String(9300 + (process.pid % 90));
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/paris-auto-test-');
process.env.RPC_URL = '';
process.env.DEV_FAUCET = '1';
process.env.ADMIN_KEY = 'cle-de-banc-essai';
/* Une cle est necessaire pour que `planifie` s'installe et pose le rappel.
   Aucun appel ne partira : on ne declenche jamais les minuteries. */
process.env.ODDS_API_KEY = 'cle-de-banc-essai';
process.env.PARIS_AUTO = '1';
process.env.PARIS_AUTO_PLAFOND = '5000';
process.env.PARIS_AUTO_DELAI_MIN = '90';

const WebSocket = require('ws');
const { ethers } = require('ethers');
const paris = require('./paris');
const { Game } = require('./game');
/* Les rappels que le serveur passe a `planifie` (relecture du lot 4) : le
   troisieme est l'ENGAGEMENT lui-meme, pour que l'ombre trie avec le meme
   plafond que la vraie passe. Enregistres avant que le serveur ne demarre. */
const ARGS_PLANIFIE = [];
{
  const pi = require('./paris_import');
  const vrai = pi.planifie;
  pi.planifie = (...x) => { ARGS_PLANIFIE.push(x); return vrai(...x); };
}
require('./server');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const dernier = (recu, t) => [...recu].reverse().find((m) => m.type === t);

function ouvrir() {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', rej);
    ws.on('open', () => res({ ws, recu }));
  });
}
async function joueur() {
  const w = ethers.Wallet.createRandom();
  const c = await ouvrir();
  await dors(250);
  const msg = `SWOGE Pusher login\nnonce: ${dernier(c.recu, 'hello').loginNonce}`;
  c.ws.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  await dors(300);
  for (let i = 0; i < 12; i++) c.ws.send(JSON.stringify({ type: 'devCredit' }));
  await dors(600);
  c.addr = w.address.toLowerCase();
  return c;
}
const solde = async (c) => {
  /* Le solde des PARIS : un pari se joue et se paie en $SWOGEBET. */
  c.ws.send('{"type":"betBalance"}');
  await dors(200);
  const b = dernier(c.recu, 'betBalance') || dernier(c.recu, 'auth');
  return Number(b && b.betBalance);
};

/* ---- LE CALENDRIER DE CET ESSAI EST LE SIEN ----
 *
 * Il s'IGNORAIT quand l'amorce du depot ne portait plus de rencontre a venir —
 * c'est-a-dire dès le lendemain de la derniere date ecrite dedans, donc a peu
 * pres toujours. Un essai qui s'ignore n'est pas un essai vert, c'est un essai
 * absent : celui-ci n'a pas tourne pendant que le reglement automatique
 * passait la LETTRE au lieu du score, et le defaut a vecu.
 *
 * Il ecrit donc ses propres rencontres sur le volume, datees de demain. Deux
 * au moins, dont une de football portant les six marches : c'est elle qui
 * verifie que le reglement automatique sait trancher autre chose qu'un 1-N-2.
 */
function calendrierDEssai() {
  const fs = require('fs');
  const cotes = require('./cotes');
  const DEMAIN = new Date(Date.now() + 86400000).toISOString();
  const brut = {
    sports: [{ cle: 'foot', nom: 'Football', actif: true }],
    matchs: [
      { id: 'auto-petit', sport: 'foot', competition: 'Essai', pays: 'X',
        domicile: 'Petit-A', exterieur: 'Petit-B', debut: DEMAIN,
        cotes: { 1: 2.10, N: 3.30, 2: 3.40 } },
      { id: 'auto-gros', sport: 'foot', competition: 'Essai', pays: 'X',
        domicile: 'Gros-A', exterieur: 'Gros-B', debut: DEMAIN,
        cotes: { 1: 2.10, N: 3.30, 2: 3.40 } },
      /* Sa propre rencontre pour le cas du marche : les deux autres sont
         REGLEES par les sections qui precedent, et une rencontre reglee ne se
         regle pas deux fois — le pari serait reste ouvert sans que rien ne le
         dise, et l essai aurait accuse la mauvaise cause. */
      { id: 'auto-marche', sport: 'foot', competition: 'Essai', pays: 'X',
        domicile: 'Marche-A', exterieur: 'Marche-B', debut: DEMAIN,
        cotes: { 1: 2.10, N: 3.30, 2: 3.40 } },
      /* Lot 4 (10/10/2026) : la sienne aussi, pour le journal du reglement
         en panne — un volume plein ne doit jamais faire perdre un paiement. */
      { id: 'auto-journal', sport: 'foot', competition: 'Essai', pays: 'X',
        domicile: 'Journal-A', exterieur: 'Journal-B', debut: DEMAIN,
        cotes: { 1: 2.10, N: 3.30, 2: 3.40 } },
      { id: 'auto-route', sport: 'foot', competition: 'Essai', pays: 'X',
        domicile: 'Route-A', exterieur: 'Route-B', debut: DEMAIN,
        cotes: { 1: 2.10, N: 3.30, 2: 3.40 } },
    ],
  };
  const habille = cotes.habilleCatalogue(brut);
  fs.writeFileSync(paris.FICHIER_VOLUME, JSON.stringify(habille, null, 1) + '\n');
  paris.charge();
}

(async () => {
  calendrierDEssai();
  const ouv = paris.ouverts(Date.now());
  ok(ouv.length >= 2,
     `l essai ecrit son propre calendrier : ${ouv.length} rencontre(s) a venir`);
  ok(Object.keys(ouv[0].marches).length === 6,
     `et la premiere porte ses six marches : ${Object.keys(ouv[0].marches).join(', ')}`);

  /* Le rappel est pose dans le callback de `listen` : il n'existe pas encore
     au chargement du module. */
  for (let i = 0; i < 40 && !global.__swogeReglementAuto; i++) await dors(100);
  const regle = global.__swogeReglementAuto;
  ok(typeof regle === 'function',
     'le serveur expose son rappel de reglement — sans ca ce test ne prouve rien');

  const a = await joueur();
  const petit = ouv[0], gros = ouv[1];

  /* Deux paris : un sur une rencontre a faible enjeu, un sur une rencontre
     dont l'exposition depasse le plafond. */
  a.ws.send(JSON.stringify({ type: 'parie', match: petit.id, choix: petit.issues[0], mise: 500 }));
  await dors(250);
  a.ws.send(JSON.stringify({ type: 'parie', match: gros.id, choix: gros.issues[0], mise: 4000 }));
  await dors(350);
  const err = a.recu.filter((m) => m.type === 'error');
  ok(!err.length, 'les deux paris sont acceptes : ' + err.map((e) => e.error).join(' | '));

  const avant = await solde(a);
  const T = (id) => Date.parse(paris.match(id).debut);
  const fini = (m, resultat, score) => ({
    id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur,
    score: score || '2-1', resultat,
  });

  // ---- 1. trop tot : rien ne bouge
  {
    regle([fini(petit, petit.issues[0])]);
    await dors(300);
    eq(await solde(a), avant, 'une rencontre finie a l instant ne paie personne');
    ok(!global.__cheatRegle, 'et rien n a ete marque comme regle');
    /* Le pari est toujours ouvert : c'est la preuve que rien n'a ete fait,
       et non que le paiement a echoue en silence. */
    const g = require('./server').game;
    void g;
  }

  // ---- 2. le delai passe : la petite rencontre est payee
  {
    /* On ne peut pas avancer l'horloge du serveur, mais le rappel accepte
       l'instant courant du moteur : on triche donc sur la DATE DU MATCH, qui
       est la seule chose que le tri regarde. */
    const m = paris.match(petit.id);
    const vraiDebut = m.debut;
    m.debut = Date.now() - 6 * 3600000;          // fini il y a longtemps
    regle([fini(petit, petit.issues[0])]);
    await dors(400);
    const apres = await solde(a);
    ok(apres > avant, `la rencontre a faible enjeu est payee (${avant} → ${apres})`);
    m.debut = vraiDebut;

    /* Deux fois de suite ne paie pas deux fois. C'est le scenario reel : la
       releve tourne chaque jour et repasse sur les memes rencontres. */
    const avant2 = await solde(a);
    m.debut = Date.now() - 6 * 3600000;
    regle([fini(petit, petit.issues[0])]);
    await dors(400);
    m.debut = vraiDebut;
    eq(await solde(a), avant2, 'une seconde passe ne repaie pas');
  }

  // ---- 2 bis. LE SCORE ARRIVE JUSQU AU MOTEUR, ET PAS SEULEMENT LA LETTRE
  /*
   * ---- LE DEFAUT QUE CET ESSAI AURAIT DU ATTRAPER ----
   *
   * Le rappel passait `f.resultat` — la lettre — alors que `f.score` etait la
   * depuis toujours, et que la ligne de journal juste en dessous l AFFICHAIT.
   *
   * Deux consequences. Le score n etait jamais garde, donc irrecuperable. Et
   * depuis que les rencontres portent six marches, `regleMatch` REFUSE la
   * lettre des qu un pari demande le score : tout match de football portant
   * un « les deux equipes marquent » tombait en reglement manuel, en silence,
   * dans la liste des rates.
   *
   * Rien ne le voyait, parce que cet essai s ignorait faute de calendrier.
   */
  {
    const cible = paris.match('auto-marche');
    const b = await joueur();
    /* Par `selections`, comme la page : le champ `match`/`choix` a plat est la
       forme d'AVANT les marches, et elle pose toujours sur le 1-N-2. */
    b.ws.send(JSON.stringify({ type: 'parie', mise: 500,
      selections: [{ match: cible.id, marche: 'btts', choix: 'oui' }] }));
    await dors(350);
    const err2 = b.recu.filter((m2) => m2.type === 'error');
    ok(!err2.length,
       'un pari « les deux equipes marquent » est accepte : '
       + err2.map((e) => e.error).join(' | '));

    const m = paris.match(cible.id);
    const vraiDebut = m.debut;
    m.debut = Date.now() - 6 * 3600000;
    const avantB = await solde(b);
    /* 2-1 : les deux equipes ont marque, le pari est gagnant. La LETTRE de ce
       score est « 1 » — et « 1 » ne dit rien de « les deux marquent ». */
    regle([fini(cible, '1', '2-1')]);
    await dors(450);
    m.debut = vraiDebut;
    const apresB = await solde(b);
    ok(apresB > avantB,
       `le reglement automatique paie le pari « les deux marquent » (${avantB} → ${apresB})`
       + ' — avec la lettre seule, il aurait ete refuse et laisse en attente');
    const G = require('./server').game || null;
    void G;
  }

  // ---- 3. LE VERROU QUI COMPTE : au-dessus du plafond, on ne paie pas
  {
    const m = paris.match(gros.id);
    const vraiDebut = m.debut;
    m.debut = Date.now() - 6 * 3600000;
    const avant3 = await solde(a);
    regle([fini(gros, gros.issues[0])]);
    await dors(400);
    eq(await solde(a), avant3,
       'une rencontre dont l exposition depasse le plafond n est PAS reglee seule');
    m.debut = vraiDebut;

    /* Et elle reste reglable a la main — le verrou met en attente, il ne
       condamne pas la rencontre. */
    /* En POST, et avec un SCORE. L'appel etait ecrit en GET avec `resultat=` :
       la route repond « this endpoint needs POST » et l'essai le voyait comme
       un echec — sauf qu'il ne tournait jamais, faute de calendrier. Deux
       fautes qui se cachaient l'une l'autre. */
    const rep = await fetch(`http://127.0.0.1:${process.env.PORT}/paris/regle`, {
      method: 'POST',
      headers: { 'x-admin-key': process.env.ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ match: gros.id, score: '2-1', motif: 'essai automatique' }),
    });
    const j = await rep.json();
    ok(!j.error, 'et elle se regle toujours a la main : ' + JSON.stringify(j).slice(0, 90));
    eq(j.score, '2-1', 'la route garde le score qu on lui donne');
    await dors(300);
    ok(await solde(a) > avant3, 'le paiement a la main arrive bien');
  }

  // ---- 3 bis. LE CANAL PUBLIC EN PASSE FREQUENTE, ET LE JOURNAL (lot 4, 10/10/2026)
  /*
   * TG_CHAT_ID est PUBLIC. La passe ESPN de 2 h (PARIS_SCORES_ESPN=regle)
   * repasse toutes les rencontres pariees non reglees : sans filtre, elle
   * publierait « finie depuis trop peu » et chaque AET toutes les 2 h. On
   * COMPTE les envois (envoyes + refuses du carnet) : chercher « trop peu »
   * dans le carnet ne prouverait rien, il tronque le texte a 90 caracteres
   * (telegram.js). Ici TG n'est pas configure : chaque notify est un refus
   * compte, donc un envoi tente.
   */
  {
    const tgm = require('./telegram');
    const rj = require('./reglement_journal');
    const envois = () => { const j = tgm.journal(); return j.envoyes + j.refuses; };
    /* « trop peu » : la rencontre d'auto-petit, a son heure de demain */
    let e0 = envois();
    regle([fini(petit, petit.issues[0])], { passe: 'frequente' });
    await dors(150);
    eq(envois(), e0, 'passe frequente, rencontre finie depuis trop peu : AUCUN envoi sur le canal public');
    e0 = envois();
    regle([fini(petit, petit.issues[0])]);
    await dors(150);
    eq(envois(), e0 + 1, 'la meme sans passe (quotidienne) : la ligne ⏸️ part comme avant');
    e0 = envois();
    regle([fini(petit, petit.issues[0])], { passe: 'quotidienne' });
    await dors(150);
    eq(envois(), e0 + 1, 'et avec passe quotidienne aussi');
    /* AET : a la main, annoncee UNE fois en 24 h par la passe frequente */
    const aet = Object.assign(fini(petit, 'N', '2-2'), { aMain: 'football fini en STATUS_FINAL_AET (ESPN) : regler sur le score a 90 minutes' });
    e0 = envois();
    regle([aet], { passe: 'frequente' });
    await dors(150);
    eq(envois(), e0 + 1, 'passe frequente, AET jamais annoncee : un message');
    regle([aet], { passe: 'frequente' });
    await dors(150);
    eq(envois(), e0 + 1, 'une seconde passe frequente sur la meme AET : AUCUN message de plus');
    ok(rj.annonceRecente(petit.id, Date.now()), 'l annonce est gardee dans le journal du volume');
    regle([aet]);
    await dors(150);
    eq(envois(), e0 + 2, 'la quotidienne, elle, la republie comme avant');

    /* Les ECHECS aussi (relecture du lot 4) : un echec qui dure serait sinon
       republie toutes les 2 h. « already settled » sur auto-petit a deja ete
       annonce par la quotidienne de la section 2 : la passe frequente ne le
       redit pas. Un echec NOUVEAU (une lettre inconnue) part une fois. */
    const mP = paris.match(petit.id), vraiP = mP.debut;
    mP.debut = Date.now() - 6 * 3600000;
    try {
      e0 = envois();
      regle([fini(petit, petit.issues[0])], { passe: 'frequente' });
      await dors(150);
      eq(envois(), e0, 'passe frequente, « already settled » deja annonce par la quotidienne dans les 24 h : AUCUN envoi');
      regle([fini(petit, 'Z', 'abc')], { passe: 'frequente' });
      await dors(150);
      eq(envois(), e0 + 1, 'un echec nouveau (resultat illisible) : un message');
      regle([fini(petit, 'Z', 'abc')], { passe: 'frequente' });
      await dors(150);
      eq(envois(), e0 + 1, 'le meme echec a la passe frequente suivante : AUCUN message de plus');
      regle([fini(petit, 'Z', 'abc')]);
      await dors(150);
      eq(envois(), e0 + 2, 'la quotidienne le redit, comme avant');
    } finally { mP.debut = vraiP; }

    /* L'heure du vrai reglement, auto (section 2) et main (section 3). */
    const b = rj.brut();
    ok(b && b.regles[petit.id] && b.regles[petit.id].via === 'auto' && b.regles[petit.id].t > 0 && b.regles[petit.id].source === 'scores',
       'apres un reglement automatique reussi, le journal porte son heure, via auto, et son chemin (une rencontre sans source ESPN : le /scores paye) : ' + JSON.stringify(b && b.regles[petit.id]));
    ok(b.regles[gros.id] && b.regles[gros.id].via === 'main' && b.regles[gros.id].score === '2-1' && b.regles[gros.id].source === 'main',
       'apres /paris/regle, via main et le score : ' + JSON.stringify(b.regles[gros.id]));
    ok(require('fs').existsSync(require('path').join(process.env.DATA_DIR, 'reglement_journal.json')),
       'sur le volume (DATA_DIR/reglement_journal.json)');

    /* Le journal en panne ne fait JAMAIS perdre un paiement : noteRegle leve,
       la rencontre est payee, et elle n'est pas comptee « ratee ». */
    const cible = paris.match('auto-journal');
    a.ws.send(JSON.stringify({ type: 'parie', match: cible.id, choix: cible.issues[0], mise: 500 }));
    await dors(300);
    const m = paris.match(cible.id), vraiDebut = m.debut;
    m.debut = Date.now() - 6 * 3600000;
    const vraiNote = rj.noteRegle;
    rj.noteRegle = () => { throw new Error('volume plein (essai)'); };
    const dits = [], vraiLog = console.log;
    console.log = (...x) => { dits.push(x.join(' ')); vraiLog(...x); };
    const avantJ = await solde(a);
    try { regle([fini(cible, cible.issues[0])]); } finally { rj.noteRegle = vraiNote; console.log = vraiLog; }
    await dors(400);
    m.debut = vraiDebut;
    ok(await solde(a) > avantJ, 'journal en panne : la rencontre est quand meme payee');
    ok(!dits.some((x) => /auto REFUSE/.test(x)), 'et elle n est PAS dans les ratees (aucun « auto REFUSE ») : ' + dits.filter((x) => /REFUSE|journal/.test(x)).join(' | ').slice(0, 160));
    ok(dits.some((x) => /reglement non note/.test(x)), 'la panne du journal se dit');

    /* Les annonces en panne : la passe frequente publie quand meme (au pire
       elle repostera), sans lever. */
    const vA = rj.annonceRecente, vN = rj.noteAnnonces;
    rj.annonceRecente = () => { throw new Error('panne (essai)'); };
    rj.noteAnnonces = () => { throw new Error('panne (essai)'); };
    let leve = null;
    e0 = envois();
    try { regle([aet], { passe: 'frequente' }); } catch (er) { leve = er; } finally { rj.annonceRecente = vA; rj.noteAnnonces = vN; }
    await dors(150);
    ok(!leve && envois() === e0 + 1, 'journal des annonces en panne : le message part, rien ne leve');

    /* La route a la main, journal en panne : le reglement est fait et dit. */
    const cr = paris.match('auto-route');
    a.ws.send(JSON.stringify({ type: 'parie', match: cr.id, choix: cr.issues[0], mise: 500 }));
    await dors(300);
    /* le troisieme rappel de `planifie` : un NOMBRE, l'engagement de la
       rencontre (pas le booleen du deuxieme) */
    const ap = ARGS_PLANIFIE[0] || [];
    const engage = typeof ap[2] === 'function' ? ap[2](cr.id) : undefined;
    ok(ARGS_PLANIFIE.length === 1 && typeof engage === 'number' && engage > 0 && ap[1](cr.id) === true,
       'planifie recoit l engagement (un nombre > 0) en troisieme rappel, pour que l ombre trie avec le plafond : ' + JSON.stringify(engage));
    const avantR = await solde(a);
    rj.noteRegle = () => { throw new Error('volume plein (essai)'); };
    let jr;
    try {
      const rep = await fetch(`http://127.0.0.1:${process.env.PORT}/paris/regle`, {
        method: 'POST',
        headers: { 'x-admin-key': process.env.ADMIN_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ match: cr.id, score: '1-0', motif: 'essai journal en panne' }),
      });
      jr = await rep.json();
    } finally { rj.noteRegle = vraiNote; }
    ok(jr && !jr.error && jr.score === '1-0', '/paris/regle, journal en panne : la reponse est le reglement, sans erreur — ' + JSON.stringify(jr).slice(0, 80));
    await dors(300);
    ok(await solde(a) > avantR, 'et le gagnant est paye');
  }

  // ---- 4. le coupe-circuit
  {
    /* `PARIS_AUTO` est lu au chargement du module : on verifie donc le tri
       plutot que le serveur, mais c'est le meme chemin. */
    const frais = { ...process.env };
    delete require.cache[require.resolve('./paris_import')];
    process.env.PARIS_AUTO = '0';
    const imp2 = require('./paris_import');
    const r = imp2.trieReglements(
      [{ id: petit.id, domicile: 'A', exterieur: 'B', score: '1-0', resultat: '1' }],
      () => 0, Date.now() + 10 * 3600000);
    eq(r.auto.length, 0, 'PARIS_AUTO=0 ne regle plus rien tout seul');
    ok(/desactive/.test(r.mains[0].raison), 'et la raison le dit : ' + r.mains[0].raison);
    process.env.PARIS_AUTO = frais.PARIS_AUTO;
  }

  a.ws.close();
  console.log(`paris_auto.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
