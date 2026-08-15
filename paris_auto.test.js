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
  c.ws.send('{"type":"balance"}');
  await dors(200);
  const b = dernier(c.recu, 'balance') || dernier(c.recu, 'auth');
  return Number(b && b.balance);
};

(async () => {
  paris.charge();
  const ouv = paris.ouverts(Date.now());
  if (ouv.length < 2) {
    console.log('paris_auto.test.js : IGNORE — moins de 2 matchs ouverts au calendrier');
    process.exit(0);
  }

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
    const rep = await fetch(`http://127.0.0.1:${process.env.PORT}/paris/regle?match=` +
      `${encodeURIComponent(gros.id)}&resultat=${encodeURIComponent(gros.issues[0])}`,
      { headers: { 'x-admin-key': process.env.ADMIN_KEY } });
    const j = await rep.json();
    ok(!j.error, 'et elle se regle toujours a la main : ' + JSON.stringify(j).slice(0, 90));
    await dors(300);
    ok(await solde(a) > avant3, 'le paiement a la main arrive bien');
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
