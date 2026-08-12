'use strict';
/*
 * Les sessions. Un jeton remplace une signature : il faut donc qu'il soit
 * IMPOSSIBLE d'en fabriquer un, d'en repousser la date, ou d'en changer
 * l'adresse. On ne se contente pas de verifier qu'un bon jeton passe — on
 * essaie reellement de les bricoler.
 *
 * Le second volet demarre le VRAI serveur et enchaine les deux facons
 * d'entrer, parce qu'une charge d'accueil differente entre connexion et
 * reprise donnerait une page reprise qui n'affiche pas la meme chose.
 */
const assert = require('assert');

process.env.PORT = String(8700 + (process.pid % 200));
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/session-test-');
process.env.RPC_URL = '';
process.env.SESSION_TTL_SEC = '3600';

const S = require('./session');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const SECRET = 'secret-de-test-0123456789';
const A = '0x' + 'ab'.repeat(20);

// ------------------------------------------------------- aller-retour
{
  const t = S.emettre(SECRET, A, 3600);
  eq(S.lire(SECRET, t), A, 'un jeton valide rend son adresse');
  eq(S.lire(SECRET, S.emettre(SECRET, A.toUpperCase(), 3600)), A, 'adresse normalisee en minuscules');
  ok(S.restant(t) > 3500 && S.restant(t) <= 3600, 'la duree restante est coherente');
  ok(t.split('.').length === 4, 'quatre morceaux');
  ok(t.startsWith('v1.'), 'la version est en tete');
}

// --------------------------------------------------- on essaie de tricher
{
  const t = S.emettre(SECRET, A, 3600);
  const [v, a, exp, sig] = t.split('.');
  const B = '0x' + 'cd'.repeat(20);

  eq(S.lire('autre-secret', t), null, 'un autre secret ne relit rien');
  eq(S.lire(SECRET, `${v}.${B}.${exp}.${sig}`), null, 'changer l adresse invalide');
  eq(S.lire(SECRET, `${v}.${a}.${Number(exp) + 999999}.${sig}`), null, 'repousser la date invalide');
  eq(S.lire(SECRET, `v2.${a}.${exp}.${sig}`), null, 'changer la version invalide');
  eq(S.lire(SECRET, `${v}.${a}.${exp}.`), null, 'empreinte vide refusee');
  eq(S.lire(SECRET, `${v}.${a}.${exp}.${sig}x`), null, 'empreinte allongee refusee');
  eq(S.lire(SECRET, `${v}.${a}.${exp}`), null, 'jeton tronque refuse');
  eq(S.lire(SECRET, ''), null, 'jeton vide refuse');
  eq(S.lire(SECRET, null), null, 'jeton absent refuse');
  eq(S.lire(SECRET, 42), null, 'jeton qui n est pas une chaine refuse');
  eq(S.lire(SECRET, `${v}.pas-une-adresse.${exp}.${sig}`), null, 'adresse malformee refusee');
  eq(S.lire(SECRET, `${v}.${a}.pasunedate.${sig}`), null, 'date malformee refusee');
  eq(S.lire('', t), null, 'sans secret, rien ne passe');

  // et on ne peut pas en fabriquer un sans le secret
  const faux = `v1.${B}.${Math.floor(Date.now() / 1000) + 9999}.` + 'A'.repeat(43);
  eq(S.lire(SECRET, faux), null, 'un jeton fabrique de toutes pieces est refuse');
}

// ------------------------------------------------------------ expiration
{
  const perime = S.emettre(SECRET, A, 60);
  // on reconstruit le meme jeton avec une date passee, signee correctement
  const crypto = require('crypto');
  const exp = Math.floor(Date.now() / 1000) - 10;
  const corps = `v1.${A}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(corps).digest('base64url');
  eq(S.lire(SECRET, `${corps}.${sig}`), null, 'un jeton perime est refuse MEME bien signe');
  eq(S.restant(`${corps}.${sig}`), 0, 'duree restante nulle');
  ok(S.lire(SECRET, perime) === A, 'un jeton encore vivant passe');
  assert.throws(() => S.emettre('', A, 60), /secret/); n++;
  assert.throws(() => S.emettre(SECRET, 'pas-une-adresse', 60), /adresse/); n++;
}

// ================= le serveur : connexion puis reprise =================
const WebSocket = require('ws');
const { ethers } = require('ethers');
require('./server');

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
function ouvrir() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, recu }));
  });
}
const env = (ws, o) => ws.send(JSON.stringify(o));
const dernier = (recu, t) => [...recu].reverse().find((m) => m.type === t);

(async () => {
  const portefeuille = ethers.Wallet.createRandom();

  // --- 1. connexion normale, par signature ---
  const c1 = await ouvrir();
  await attendre(200);
  const message = `SWOGE Pusher login\nnonce: ${dernier(c1.recu, 'hello').loginNonce}`;
  env(c1.ws, { type: 'login', message, signature: await portefeuille.signMessage(message) });
  await attendre(300);
  const auth1 = dernier(c1.recu, 'auth');
  ok(auth1, 'connexion par signature acceptee');
  ok(auth1.session, 'un jeton de session est remis');
  eq(auth1.sessionTtl, 3600, 'la duree est annoncee');
  eq(S.lire('mauvais-secret', auth1.session), null, 'le jeton ne se relit pas sans le bon secret');

  // --- 2. nouvelle page : on reprend SANS signer ---
  const c2 = await ouvrir();
  await attendre(200);
  env(c2.ws, { type: 'resume', token: auth1.session });
  await attendre(300);
  const auth2 = dernier(c2.recu, 'auth');
  ok(auth2, 'reprise acceptee sans aucune signature');
  eq(auth2.resumed, true, 'la reprise est annoncee comme telle');
  eq(auth2.address, auth1.address, 'meme compte');
  eq(auth2.balance, auth1.balance, 'meme solde');

  /* Les deux charges doivent porter les MEMES cles : une page reprise qui
     manquerait un bareme afficherait une table vide sans rien dire. */
  const cles1 = Object.keys(auth1).filter((k) => k !== 'session' && k !== 'welcomeGranted' && k !== 'resumed').sort();
  const cles2 = Object.keys(auth2).filter((k) => k !== 'session' && k !== 'welcomeGranted' && k !== 'resumed').sort();
  eq(cles2.join(','), cles1.join(','), 'connexion et reprise envoient les memes donnees');

  // --- 3. un jeton bricole ne passe pas ---
  const c3 = await ouvrir();
  await attendre(200);
  env(c3.ws, { type: 'resume', token: auth1.session.slice(0, -3) + 'zzz' });
  await attendre(250);
  ok(dernier(c3.recu, 'resumeFailed'), 'un jeton bricole est refuse');
  ok(!dernier(c3.recu, 'auth'), 'et rien n est ouvert');

  // --- 4. sans jeton du tout ---
  const c4 = await ouvrir();
  await attendre(200);
  env(c4.ws, { type: 'resume', token: '' });
  await attendre(250);
  ok(dernier(c4.recu, 'resumeFailed'), 'une reprise sans jeton est refusee');

  // --- 5. le jeton de reprise reste utilisable ---
  const c5 = await ouvrir();
  await attendre(200);
  env(c5.ws, { type: 'resume', token: auth2.session });
  await attendre(300);
  ok(dernier(c5.recu, 'auth'), 'le jeton remis a la reprise sert a son tour');

  [c1, c2, c3, c4, c5].forEach((c) => c.ws.close());
  console.log(`session.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
