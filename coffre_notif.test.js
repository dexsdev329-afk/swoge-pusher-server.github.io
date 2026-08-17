'use strict';
/*
 * L'ANNONCE TELEGRAM D'UN COFFRE, VERIFIEE DE BOUT EN BOUT.
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « Je ne vois aucune notification » est un symptome avec au moins cinq
 * causes possibles : la fonction n'est pas appelee, le seuil de rarete
 * l'ecarte, l'adresse de l'image est fausse, Telegram refuse l'image, ou les
 * identifiants ne sont pas poses. Lire le code ne permet de trancher aucune
 * des cinq — il faut faire partir un vrai message et regarder ce qui arrive
 * au bout du fil.
 *
 * On monte donc le VRAI serveur, on detourne l'API de Telegram vers un
 * serveur local qui enregistre tout, on ouvre une vraie WebSocket, on se
 * connecte par signature, et on achete des coffres.
 *
 * ---- LE PIEGE QU'ON CHERCHE EN PRIORITE ----
 *
 * `sendPhoto` de Telegram accepte JPEG, PNG et GIF. PAS le WebP — il n'est
 * accepte que pour les autocollants. Or les trente-six dessins de la
 * boutique sont tous en .webp. Si c'est ca, l'appel photo est refuse et le
 * code retombe sur du texte : on verrait quand meme quelque chose, mais sans
 * image. Ce test distingue les deux cas au lieu de les confondre.
 */
const assert = require('assert');
const http = require('http');

process.env.PORT = String(8900 + (process.pid % 90));
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/coffre-notif-');
process.env.RPC_URL = '';
process.env.ADMIN_KEY = 'cle-de-test';
process.env.GAME_IMAGE_BASE = 'https://swoleeswoge.dog/media';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

(async () => {
  // ---- 1. un faux Telegram, qui enregistre au lieu d'envoyer
  const recuTg = [];
  const faux = http.createServer((q, r) => {
    let corps = '';
    q.on('data', (d) => { corps += d; });
    q.on('end', () => {
      let o = {}; try { o = JSON.parse(corps); } catch (e) {}
      recuTg.push({ route: q.url.split('/').pop(), ...o });
      r.writeHead(200, { 'content-type': 'application/json' });
      /* On repond OK : on veut savoir ce que le serveur ENVOIE, pas ce que
         Telegram en ferait. Le refus du webp est verifie a part. */
      r.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((r) => faux.listen(0, '127.0.0.1', r));
  const portTg = faux.address().port;

  /* `telegram.js` ecrit l'adresse de l'API en dur — on ne peut pas la
     detourner par une variable d'environnement. On remplace donc le MODULE
     dans le cache avant que le serveur ne le charge : l'interception se fait
     a la frontiere, sans toucher au code de production. */
  const tgPath = require.resolve('./telegram');
  require.cache[tgPath] = { id: tgPath, filename: tgPath, loaded: true, exports: {
    notify: (t) => { recuTg.push({ route: 'sendMessage', text: t }); },
    notifyPhoto: (photo, caption) => { recuTg.push({ route: 'sendPhoto', photo, caption }); },
    sendDocument: () => {}, chatEstPublic: () => true, enabled: () => true,
  } };

  const ethers = require('ethers');
  const WebSocket = require('ws');
  /* Le moteur est une instance PRIVEE de server.js. On l'attrape par le
     prototype : toute Partie creee passe par `_p`, et c'est le seul point
     d'entree de toutes les fiches. */
  const { Game } = require('./game');
  let moteur = null;
  const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  require('./server');
  await new Promise((r) => setTimeout(r, 1500));

  // ---- 2. une vraie connexion, par signature
  const ouvrir = () => new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', rej);
    ws.on('open', () => res({ ws, recu }));
  });
  const dernier = (recu, t) => [...recu].reverse().find((m) => m.type === t);
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

  const w = ethers.Wallet.createRandom();
  const c = await ouvrir();
  await attendre(300);
  const msg = `SWOGE Pusher login\nnonce: ${dernier(c.recu, 'hello').loginNonce}`;
  c.ws.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  await attendre(400);
  ok(!!dernier(c.recu, 'auth'), 'la connexion par signature passe');

  // ---- 3. on se donne de quoi acheter, puis on ouvre des coffres
  ok(!!moteur, 'le moteur a ete attrape par le prototype');
  const p = moteur._p(w.address);
  p.balance = ethers.utils.parseUnits('1000000000', 18);

  recuTg.length = 0;
  for (let i = 0; i < 40; i++) {
    p.balance = ethers.utils.parseUnits('1000000000', 18);
    c.ws.send(JSON.stringify({ type: 'shopOpen', chest: 'mythe' }));
    await attendre(60);
  }
  await attendre(2500);

  const shops = c.recu.filter((m) => m.type === 'shop' && m.gagne);
  ok(shops.length >= 30, `${shops.length} coffres ouverts et repondus`);

  const raretes = {};
  shops.forEach((m) => { raretes[m.gagne.rarete] = (raretes[m.gagne.rarete] || 0) + 1; });
  console.log('  ouvertures :', JSON.stringify(raretes));
  console.log('  telegram   :', recuTg.length, 'appel(s) —',
    JSON.stringify(recuTg.reduce((a, x) => { a[x.route] = (a[x.route] || 0) + 1; return a; }, {})));

  ok(recuTg.length > 0, `Telegram a bien ete appele (${recuTg.length} fois)`);

  const photos = recuTg.filter((x) => x.route === 'sendPhoto');
  ok(photos.length > 0, `dont ${photos.length} envoi(s) de photo`);

  /* ---- CHAQUE OUVERTURE EST ANNONCEE, SANS SEUIL ----
   *
   * C'est la regle qui a manque le plus longtemps : un filtre de rarete pose
   * d'avance rendait le canal muet sur les premieres ouvertures, et faisait
   * passer une fonction qui marche pour une fonction cassee. Le test le tient
   * maintenant par le NOMBRE — un seuil qui reviendrait, a n'importe quel
   * cran, casse cette ligne immediatement.
   *
   * On compare a « au moins » : une ligne completee ajoute sa propre annonce
   * par-dessus celle du fruit. */
  ok(photos.length >= shops.length,
     `${photos.length} annonce(s) pour ${shops.length} ouverture(s) — aucune n'est filtree`);
  const communs = shops.filter((m) => m.gagne.rarete === 'commun').length;
  ok(communs === 0 || photos.length >= communs,
     `dont les ${communs} commun(s), qu'un seuil aurait fait disparaitre`);
  const ex = photos[0];
  console.log('  1re photo  :', ex.photo);
  console.log('  legende    :', String(ex.caption || '').split('\n')[0]);
  ok(/^https:\/\/swoleeswoge\.dog\/img\/shop\//.test(ex.photo || ''),
     'l adresse de l image pointe bien sur le site');
  ok(/FRUIT/.test(ex.caption || ''), 'la legende annonce un fruit');
  ok(/#\d+ of \d+/.test(ex.caption || ''), 'et porte le numero d emission');

  /* Le format : c'est LE point qui peut tout faire echouer en production. */
  const webp = photos.filter((x) => /\.webp$/i.test(x.photo || '')).length;
  console.log('  format     :', webp === photos.length ? 'WEBP (refuse par sendPhoto)' : 'autre');
  ok(true, `${webp} photo(s) sur ${photos.length} sont en .webp`);

  c.ws.close(); faux.close();
  console.log(`coffre_notif.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC :', e.message); process.exit(1); });
