'use strict';
/*
 * DEUX PORTES AU NORD — deux mondes ouverts, pas deux coins d'une carte.
 *
 * Le Nexus a maintenant une porte verte et une porte rouge. Ce fichier verifie
 * ce que server.js en fait ; la geometrie et les regles de combat sont
 * l'affaire de monde.test.js et realm.test.js, et elles ne changent pas.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. DEUX SIMULATIONS, PAS UNE. C'est la seule chose vraiment grave : deux
 *    mondes qui partageraient une instance mettraient deux joueurs qui se
 *    croient seuls au meme endroit, et le premier tir le leur apprendrait.
 * 2. ON NE SE VOIT PAS D'UN MONDE A L'AUTRE. Corollaire du 1, mais c'est
 *    l'observable : c'est `etatPour` qui doit ne rien montrer.
 * 3. LE PLANCHER DE RARETE TIENT. Rien ne sort du monde rouge en dessous du
 *    legendaire — y compris le butin GARANTI d'une salle gardee, qui a le
 *    droit de descendre d'un cran quand le stock manque, mais pas sous le
 *    plancher. C'est toute la promesse de la carte.
 * 4. UN DONJON APPARTIENT AU MONDE D'OU L'ON EST ENTRE. Sans ca, entrer dans
 *    un donjon depuis la carte rouge et en ressortir serait la meilleure facon
 *    de sortir du PvP avec un sac plein sans avoir a extraire.
 * 5. UN CLIENT QUI NE DIT RIEN ARRIVE OU IL ARRIVAIT HIER. Un deploiement ne
 *    doit pas mettre dehors ceux qui n'ont pas encore recharge la page.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/deuxm-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const { Game } = require('./game');
  let moteur = null; const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  /* ---- MONDE OUVERT OU DONJON : C'EST UNE QUESTION DE MOMENT ----
   * C'etait « avec plan / sans plan ». La ville de SWOGE +18 est un monde
   * ouvert qui a un plan : ce critere l'aurait rangee parmi les donjons, et
   * l'essai n'aurait rien signale — il aurait juste compte une carte de moins
   * et un donjon de trop. Les mondes ouverts sont ceux qui BATTENT DEJA a la
   * fin du demarrage, avant qu'un seul client soit connecte ; un donjon nait
   * de la porte franchie, donc plus tard. On les attrape par ce biais plutot
   * que d'exporter la table des mondes pour l'essai : une table exportee pour
   * un essai finit par etre modifiee par du code de production « puisqu'elle
   * est la ». */
  const { Realm } = require('./realm');
  const ouverts = new Set(), vivants = new Set();
  let demarrageFini = false;
  const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) {
    if (!demarrageFini) ouverts.add(this);
    else if (!ouverts.has(this)) vivants.add(this);
    return pas0.call(this, dt);
  };
  require('./server');
  const M = require('./monde');
  const B = require('./boutique');
  await new Promise((r) => setTimeout(r, 900));
  demarrageFini = true;

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
  const dort = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Le monde ouvert qui CONTIENT une adresse. C'est la seule facon honnete de
     designer un monde maintenant qu'il y en a plusieurs : par son occupant.
     Les simulations rangent les joueurs sous l'adresse EN MINUSCULES ; chercher
     la forme a majuscules du portefeuille ne trouve jamais rien, et l'essai
     conclurait « il n'est dans aucun monde » alors qu'il y est. */
  const cle = (addr) => String(addr).toLowerCase();
  const mondeDe = (addr) => [...ouverts].find((r) => r.joueurs.has(cle(addr))) || null;

  const wA = ethers.Wallet.createRandom(), wB = ethers.Wallet.createRandom();
  const A = wA.address, Bd = wB.address;
  const sa = await connecte(wA), sb = await connecte(wB);
  for (const ad of [A, Bd]) {
    const p = moteur._p(ad);
    p.skins = { andy: true }; p.skinActif = 'andy';
  }

  /* ================== 1. DEUX PORTES, DEUX MONDES ================== */
  console.log('\n-- deux portes --');
  sa.send(JSON.stringify({ type: 'realmJoin', monde: 'ouvert' }));
  const eA = await attend(sa, 'realmEntre');
  sb.send(JSON.stringify({ type: 'realmJoin', monde: 'crimson' }));
  const eB = await attend(sb, 'realmEntre');
  await dort(400);

  eq(eA.carte, 'ouvert', 'la porte verte annonce sa carte');
  eq(eB.carte, 'crimson', 'la porte rouge annonce la sienne');
  const mA = mondeDe(A), mB = mondeDe(Bd);
  ok(mA && mB, 'les deux joueurs sont dans un monde');
  /* LE COEUR DE L'ESSAI. Deux instances, pas une. */
  ok(mA !== mB, 'et ce ne sont PAS les memes simulations');
  ok(!mA.joueurs.has(cle(Bd)) && !mB.joueurs.has(cle(A)),
     'aucun des deux n\'existe dans le monde de l\'autre');

  /* ---- ON NE SE VOIT PAS ----
   * On les pose l'un SUR l'autre : meme x, meme y. S'ils partageaient quoi que
   * ce soit, c'est ici que ca se verrait. */
  const jA = mA.joueurs.get(cle(A)), jB = mB.joueurs.get(cle(Bd));
  jB.x = jA.x; jB.y = jA.y;
  await dort(400);
  const vueA = mA.etatPour(cle(A), 1400);
  eq((vueA.joueurs || []).filter((o) => cle(o.a) === cle(Bd)).length, 0,
     'colles l\'un sur l\'autre, ils ne se voient pas');

  /* ================== 2. LE PLANCHER DE RARETE ================== */
  console.log('\n-- ce qui tombe dans le rouge --');
  /* On demande au monde lui-meme, par son propre `tireObjet` : c'est la
     fonction que le serveur lui a donnee a la naissance, et c'est elle — pas
     une copie de la regle — qui decide de ce qui tombe. */
  const RANGS = B.RARETES.map((r) => r.cle);
  const plancher = RANGS.indexOf('legendaire');
  const bas = [];
  for (let k = 0; k < 400; k++) {
    const piece = mB.tireObjet('commun', Math.random);
    if (piece) bas.push(piece);
  }
  ok(bas.length > 0, `le monde rouge rend bien quelque chose (${bas.length} sur 400)`);
  const sousLePlancher = bas.filter((p) => RANGS.indexOf(p.rarete) < plancher);
  eq(sousLePlancher.length, 0,
     'meme en demandant du COMMUN, rien ne sort sous le legendaire');
  /* La geographie tient : la lave rend toujours mieux que la terre. Monter le
     plancher ne doit pas ecraser les anneaux — sinon la carte rouge serait
     plate, et il n'y aurait plus aucune raison d'en viser le coeur. */
  const hauts = [];
  for (let k = 0; k < 400; k++) {
    const piece = mB.tireObjet('mythique', Math.random);
    if (piece) hauts.push(piece);
  }
  ok(hauts.length === 0 || hauts.every((p) => RANGS.indexOf(p.rarete) >= plancher),
     `et le mythique reste au-dessus (${hauts.length} pieces)`);

  /* ---- LE BUTIN GARANTI NE DESCEND PAS SOUS LE PLANCHER ----
   * Une salle gardee descend d'un cran quand la saison n'a plus de pieces.
   * Dans le rouge elle a le droit de descendre JUSQU'AU plancher, pas
   * en-dessous : mieux vaut ne rien rendre que rendre moins que promis. */
  const gar = [];
  for (let k = 0; k < 300; k++) {
    const piece = mB.tireObjet('relique', Math.random, true);
    if (piece) gar.push(piece);
  }
  eq(gar.filter((p) => RANGS.indexOf(p.rarete) < plancher).length, 0,
     `le butin garanti non plus (${gar.length} pieces tirees)`);

  /* Et le monde vert, lui, n'a pas change : il rend toujours du commun. */
  const vert = [];
  for (let k = 0; k < 400; k++) {
    const piece = mA.tireObjet('commun', Math.random);
    if (piece) vert.push(piece);
  }
  ok(vert.length === 0 || vert.some((p) => p.rarete === 'commun'),
     `le monde vert rend toujours du commun (${vert.length} pieces)`);

  /* ================== 3. LE DONJON APPARTIENT A SA CARTE ================== */
  console.log('\n-- une porte ouverte depuis le rouge --');
  const poseLaPorte = (R, addr) => {
    const j = R.joueurs.get(addr);
    const t = M.MONSTRES.optimus;
    const m = { id: R._nouvelId(), espece: 'optimus', biome: 'lave',
                x: j.x, y: j.y, ancreX: j.x, ancreY: j.y,
                pv: 0, pvMax: t.pv, dir: 'down', cible: null,
                recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 };
    const p = R._ouvrePortail(m, null, null);
    p.x = j.x; p.y = j.y;
    return p;
  };
  mB.portails.length = 0;
  poseLaPorte(mB, cle(Bd));
  sb.recus.length = 0;
  sb.send(JSON.stringify({ type: 'realmPorte' }));
  const dedans = await attend(sb, 'realmEntre');
  ok(!!dedans.donjon, `on entre dans le donjon depuis la carte rouge (${dedans.donjon})`);
  /* La carte voyage avec le donjon : la page doit savoir qu'elle est toujours
     rattachee au rouge, sinon elle annoncerait la sortie sur la mauvaise. */
  eq(dedans.carte, 'crimson', 'et le donjon se sait rattache au rouge');
  ok(!mB.joueurs.has(cle(Bd)), 'il a bien quitte la carte rouge');

  sb.recus.length = 0;
  sb.send(JSON.stringify({ type: 'realmSort' }));
  const sorti = await attend(sb, 'realmEntre');
  await dort(300);
  eq(sorti.carte, 'crimson', 'et il en RESSORT dans le rouge');
  /* L'observable, pas seulement l'annonce : c'est bien la simulation rouge qui
     l'a repris, pas la verte aux memes coordonnees. */
  ok(mB.joueurs.has(cle(Bd)), 'la simulation rouge l\'a repris');
  ok(!mA.joueurs.has(cle(Bd)), 'et la verte ne l\'a pas vu passer');

  /* ================== 4. UN CLIENT MUET N'EST PAS DEPORTE ================== */
  console.log('\n-- le client qui ne dit rien --');
  const wC = ethers.Wallet.createRandom();
  const sc = await connecte(wC);
  const pc = moteur._p(wC.address);
  pc.skins = { andy: true }; pc.skinActif = 'andy';
  sc.send(JSON.stringify({ type: 'realmJoin' }));          // pas de champ `monde`
  const eC = await attend(sc, 'realmEntre');
  await dort(300);
  eq(eC.carte, 'ouvert', 'sans rien nommer, on arrive dans le monde par defaut');
  ok(mondeDe(wC.address) === mA, 'la meme simulation que la porte verte');

  /* Et une cle inventee ne fabrique pas un monde : elle retombe sur le
     defaut. Refuser aurait ete l'autre choix defendable — mais un joueur mis
     dehors par un mot qu'il n'a pas tape ne revient pas demander pourquoi. */
  const wD = ethers.Wallet.createRandom();
  const sd = await connecte(wD);
  const pd = moteur._p(wD.address);
  pd.skins = { andy: true }; pd.skinActif = 'andy';
  sd.send(JSON.stringify({ type: 'realmJoin', monde: 'atlantide' }));
  const eD = await attend(sd, 'realmEntre');
  await dort(300);
  eq(eD.carte, 'ouvert', 'une carte inventee retombe sur le defaut');

  /* ================== 5. LE NEXUS COMPTE LES TETES ================== */
  console.log('\n-- combien derriere chaque porte --');
  const sn = await connecte(ethers.Wallet.createRandom());
  sn.send(JSON.stringify({ type: 'nexusJoin', skin: 'andy' }));
  sn.send(JSON.stringify({ type: 'nexusMove', x: 100, y: 100, dir: 'down' }));
  const etatN = await attend(sn, 'nexusEtat', 4000);
  ok(etatN.portes && typeof etatN.portes.crimson === 'number',
     `le Nexus annonce le monde de chaque porte (${JSON.stringify(etatN.portes)})`);
  eq(etatN.portes.crimson, mB.joueurs.size,
     'et le chiffre de la porte rouge est celui de la simulation rouge');

  for (const s of [sa, sb, sc, sd, sn]) s.close();
  console.log(`\ndeux_mondes.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('RATE ' + (e && e.message ? e.message : e)); process.exit(1); });
