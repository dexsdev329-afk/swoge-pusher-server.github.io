'use strict';
/*
 * UN COMPTE, UN SEUL CORPS.
 *
 * `realmPorte` et `realmSort` retirent le joueur du monde qu'ils quittent.
 * `realmJoin`, non — et rien n'empeche deux sockets du meme compte : le
 * serveur les accepte deliberement (`byAddr` tient un ENSEMBLE de sockets par
 * adresse, pour qu'un joueur puisse garder le hall ouvert dans un onglet et
 * jouer dans l'autre).
 *
 * ---- ce que ca donnait ----
 *
 * Deux onglets, deux `realmJoin`, DEUX CORPS : l'un dans le monde vert,
 * l'autre dans le rouge. Ils ramassaient dans le meme sac et versaient leur XP
 * dans le meme personnage — un butin double pour un seul joueur, dont la
 * moitie tombee dans la carte a plancher legendaire.
 *
 * Et le corps oublie pouvait MOURIR pendant qu'on jouait l'autre : `game.meurt`
 * detruisait l'equipement de quelqu'un qui ne regardait pas.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. UN SEUL CORPS, TOUS MONDES CONFONDUS. C'est la seule verification qui
 *    porte vraiment : le reste en decoule.
 * 2. L'ANCIEN ONGLET L'APPREND. Sans message, il reste fige sur son dernier
 *    instantane, dans un monde ou il n'a plus de corps, sans un mot.
 * 3. ET IL SE TAIT. Un onglet evince qui continue d'etre servi serait un
 *    fantome que le premier defaut aurait seulement deplace.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/deuxonglets-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);

  /* ---- ON ATTRAPE LES SIMULATIONS AU PASSAGE ----
   * server.js ne les exporte pas, et c'est tres bien : personne d'autre n'a a
   * y toucher. Mais la seule verification qui compte ici — « combien de corps
   * portent cette adresse, TOUS MONDES CONFONDUS » — ne se lit nulle part
   * ailleurs. On note donc chaque simulation dans laquelle quelqu'un entre,
   * exactement comme le harnais attrape le moteur par `_p`. */
  const { Realm } = require('./realm');
  const mondes = [];
  const rejoint0 = Realm.prototype.rejoint;
  Realm.prototype.rejoint = function (a, f, arr) {
    if (mondes.indexOf(this) < 0) mondes.push(this);
    return rejoint0.call(this, a, f, arr);
  };

  require('./server');
  await new Promise((r) => setTimeout(r, 900));

  const ouvre = () => new Promise((res, rej) => {
    const s = new WebSocket('ws://127.0.0.1:' + port);
    s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  const attend = (s, type, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function tour() {
      const m = s.recus.filter((x) => x.type === type).pop();
      if (m) return res(m);
      if (Date.now() - t0 > (ms || 6000)) return rej(new Error('pas de ' + type));
      setTimeout(tour, 25);
    })();
  });
  const connecte = async (w) => {
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    return s;
  };
  /* Combien de simulations tiennent un corps pour cette adresse. */
  const corps = (addr) => mondes.filter((M) => M.joueurs.has(addr.toLowerCase())).length;

  const w = ethers.Wallet.createRandom();
  const adr = w.address.toLowerCase();

  console.log('\n-- un onglet, un corps --');
  const a = await connecte(w);
  a.send(JSON.stringify({ type: 'realmJoin', monde: 'ouvert' }));
  await attend(a, 'realmEntre');
  eq(corps(adr), 1, 'apres la premiere entree, un seul corps');
  await attend(a, 'realmEtat');
  ok(true, 'et le premier onglet recoit bien les instantanes du monde');

  console.log('\n-- un second onglet, dans l AUTRE monde --');
  const b = await connecte(w);
  /* L'autre carte exprès : c'est le cas qui rapporte, puisque le butin du
     monde rouge a un plancher legendaire. Deux corps dans le meme monde
     seraient deja anormaux ; deux corps dans deux mondes le sont deux fois. */
  b.send(JSON.stringify({ type: 'realmJoin', monde: 'crimson' }));
  await attend(b, 'realmEntre');
  eq(corps(adr), 1, 'il n y a TOUJOURS qu un seul corps, tous mondes confondus');

  console.log('\n-- et l ancien onglet l apprend --');
  const sorti = await attend(a, 'realmSorti');
  eq(sorti.raison, 'autre-onglet', 'avec la raison, pas un depart silencieux');

  console.log('\n-- il se tait ensuite --');
  {
    /* On vide ce qu'il a deja recu, on laisse tourner la boucle du serveur —
       qui pousse un instantane toutes les cent millisecondes — et on regarde
       s'il en arrive encore un seul. */
    a.recus.length = 0;
    a.send(JSON.stringify({ type: 'realmMove', x: 100, y: 100, dir: 'down', anim: 'run' }));
    await new Promise((r) => setTimeout(r, 700));
    eq(a.recus.filter((m) => m.type === 'realmEtat').length, 0,
       'plus aucun instantane ne part vers l onglet evince');
    eq(corps(adr), 1, 'et ses messages ne lui refont pas de corps');
  }

  console.log('\n-- le nouvel onglet, lui, joue normalement --');
  {
    const e = await attend(b, 'realmEtat');
    ok(!!e && e.moi, 'il recoit ses instantanes, avec son propre corps');
    b.send(JSON.stringify({ type: 'realmMove', x: (e.moi.x | 0) + 10, y: e.moi.y | 0, dir: 'right', anim: 'run' }));
    await new Promise((r) => setTimeout(r, 300));
    eq(corps(adr), 1, 'et il reste seul');
  }

  try { a.close(); } catch (e) {}
  try { b.close(); } catch (e) {}
  console.log(`\ndeux_onglets.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.log('  RATE ' + (e && e.message)); process.exit(1); });
