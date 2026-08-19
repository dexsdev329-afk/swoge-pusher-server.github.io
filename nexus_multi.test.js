'use strict';
/*
 * LE NEXUS MULTIJOUEUR, VERIFIE ENTRE DEUX VRAIES CONNEXIONS.
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « Je vois l'autre joueur bouger » ne se prouve pas en lisant le code : il
 * faut deux vraies sockets, faire bouger l'une, et regarder ce que l'AUTRE
 * recoit. On verifie ici les trois proprietes qui comptent :
 *
 *   1. la position circule bien d'un joueur a l'autre, par la diffusion
 *      periodique — pas de message pour chaque mouvement ;
 *   2. le skin diffuse est celui du SERVEUR (`skinActif`), jamais celui que
 *      le client pretend porter — sinon n'importe qui pourrait se deguiser
 *      en un personnage qu'il ne possede pas aux yeux des autres ;
 *   3. qui n'est jamais entre dans le Nexus (`nexusJoin`) n'apparait jamais
 *      dans l'instantane, meme connecte — et qui en sort (la socket se
 *      ferme) en disparait au tick suivant, sans message de depart dedie.
 */
const assert = require('assert');

process.env.PORT = String(9000 + (process.pid % 90));
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/nexus-multi-');
process.env.RPC_URL = '';
process.env.ADMIN_KEY = 'cle-de-test';
process.env.GAME_IMAGE_BASE = 'https://swoleeswoge.dog/media';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

(async () => {
  const tgPath = require.resolve('./telegram');
  require.cache[tgPath] = { id: tgPath, filename: tgPath, loaded: true, exports: {
    notify: () => {}, notifyPhoto: () => {}, sendDocument: () => {},
    chatEstPublic: () => true, enabled: () => true,
  } };

  const ethers = require('ethers');
  const WebSocket = require('ws');
  const { Game } = require('./game');
  let moteur = null;
  const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  require('./server');
  await new Promise((r) => setTimeout(r, 1500));

  const ouvrir = () => new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', rej);
    ws.on('open', () => res({ ws, recu }));
  });
  const dernier = (recu, t) => [...recu].reverse().find((m) => m.type === t);
  const derniers = (recu, t) => recu.filter((m) => m.type === t);
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

  const connecte = async () => {
    const w = ethers.Wallet.createRandom();
    const c = await ouvrir();
    await attendre(200);
    const msg = `SWOGE Pusher login\nnonce: ${dernier(c.recu, 'hello').loginNonce}`;
    c.ws.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attendre(300);
    ok(!!dernier(c.recu, 'auth'), 'la connexion par signature passe');
    return { w, c, addr: w.address.toLowerCase() };
  };

  const j1 = await connecte();
  const j2 = await connecte();
  const j3 = await connecte();      // celui-ci n'entrera jamais dans le Nexus
  ok(!!moteur, 'le moteur a ete attrape par le prototype');

  // j1 porte Brett aux yeux du serveur, quoi que son client pretende plus tard
  moteur._p(j1.addr).skinActif = 'brett';
  moteur._p(j2.addr).skinActif = 'pepe';
  moteur._p(j1.addr).name = 'Enzo';

  // ---- 1. j1 et j2 entrent, j3 reste dehors ----
  j1.c.recu.length = 0; j2.c.recu.length = 0; j3.c.recu.length = 0;
  j1.c.ws.send(JSON.stringify({ type: 'nexusJoin' }));
  j2.c.ws.send(JSON.stringify({ type: 'nexusJoin' }));
  await attendre(400);

  let etats = derniers(j2.c.recu, 'nexusEtat');
  ok(etats.length > 0, `j2 recoit bien des instantanes du Nexus (${etats.length})`);
  let dernier1 = etats[etats.length - 1];
  ok(dernier1.joueurs.some((p) => p.addr === j1.addr), 'j1 (entre) apparait dans l\'instantane que recoit j2');
  ok(dernier1.joueurs.some((p) => p.addr === j2.addr), 'j2 se voit lui-meme dans l\'instantane (filtre cote client)');
  ok(!dernier1.joueurs.some((p) => p.addr === j3.addr), 'j3 (jamais entre) n\'apparait jamais, meme connecte');

  // ---- 2. le mouvement de j1 arrive chez j2, avec le skin du SERVEUR ----
  //
  // On glisse un `skin` dans le message, comme le ferait un client triche :
  // le protocole ne le lit meme pas, et l'instantane doit rester fidele a
  // `skinActif`.
  j2.c.recu.length = 0;
  j1.c.ws.send(JSON.stringify({ type: 'nexusMove', x: 111, y: 222, dir: 'left', anim: 'run', skin: 'ogswoge' }));
  await attendre(400);

  etats = derniers(j2.c.recu, 'nexusEtat');
  ok(etats.length > 0, 'j2 recoit un nouvel instantane apres le mouvement de j1');
  const j1vu = etats[etats.length - 1].joueurs.find((p) => p.addr === j1.addr);
  ok(!!j1vu, 'j1 est toujours present dans l\'instantane');
  eq(j1vu.x, 111, 'la position x diffusee est celle envoyee par j1');
  eq(j1vu.y, 222, 'la position y diffusee est celle envoyee par j1');
  eq(j1vu.dir, 'left', 'la direction diffusee est celle envoyee par j1');
  eq(j1vu.anim, 'run', 'l\'animation diffusee est celle envoyee par j1');
  eq(j1vu.skin, 'brett', 'le skin diffuse est celui du SERVEUR (Brett), pas celui glisse dans le message (OG Swoge)');
  /* Le nom aussi vient du serveur : la liste « joueurs a proximite » du
     panneau montre des gens, et un nom qu'on choisirait soi-meme dans le
     message permettrait de s'afficher sous celui d'un autre. */
  eq(j1vu.nom, 'Enzo', 'le nom diffuse est celui que le SERVEUR connait');

  // ---- 3. des valeurs hors-piste sont assainies, pas propagees telles quelles ----
  j2.c.recu.length = 0;
  j1.c.ws.send(JSON.stringify({ type: 'nexusMove', x: 'nawak', y: 999999, dir: 'diagonale', anim: 'danse' }));
  await attendre(400);
  etats = derniers(j2.c.recu, 'nexusEtat');
  const j1assaini = etats[etats.length - 1].joueurs.find((p) => p.addr === j1.addr);
  eq(j1assaini.x, 0, 'une abscisse non numerique retombe a 0, pas a NaN');
  eq(j1assaini.y, 6000, 'une ordonnee hors bornes est ramenee au plafond');
  eq(j1assaini.dir, 'down', 'une direction inconnue retombe sur "down"');
  eq(j1assaini.anim, 'idle', 'une animation inconnue retombe sur "idle"');

  // ---- 4. j1 part : il disparait de l'instantane suivant, sans message dedie ----
  j2.c.recu.length = 0;
  j1.c.ws.close();
  await attendre(500);
  etats = derniers(j2.c.recu, 'nexusEtat');
  ok(etats.length > 0, 'la diffusion continue apres le depart de j1');
  ok(!etats[etats.length - 1].joueurs.some((p) => p.addr === j1.addr),
     'j1 a disparu de l\'instantane des sa socket fermee');
  ok(etats[etats.length - 1].joueurs.some((p) => p.addr === j2.addr),
     'j2, toujours la, continue d\'apparaitre');

  j2.c.ws.close(); j3.c.ws.close();
  console.log(`nexus_multi.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC :', e.message); process.exit(1); });
