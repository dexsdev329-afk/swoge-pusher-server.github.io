'use strict';
/*
 * TIRER EN COURANT.
 *
 * « A l'arret ca touche bien les ennemis ; quand je cours, ca a du mal a
 * toucher. »
 *
 * Le projectile naissait a la derniere position ANNONCEE par la page, et elle
 * date d'au plus 120 ms — le rythme auquel elle envoie ses pas. A l'arret,
 * c'est la meme position : tout va bien, et c'est pour ca que le defaut
 * passait inapercu. En courant a 220 unites par seconde, ce sont vingt-six
 * unites de retard, plus le reseau. Le tir naissait derriere le personnage et
 * suivait l'angle vise depuis l'avant : on visait juste, et on ratait.
 *
 * La position voyage donc AVEC le tir. Ce qui compte, et que cet essai
 * protege :
 *
 * 1. LE TIR PART D'OU LE JOUEUR EST, pas d'ou il etait.
 * 2. ET PAS D'OU IL PRETEND ETRE. La position passe par le meme controle que
 *    les pas — pas de teleportation, pas de traversee de rocher, pas de
 *    deplacement pendant une paralysie. Un tricheur qui annonce un point a
 *    l'autre bout de la carte tire depuis la ou il pouvait aller, pas de la.
 * 3. TIRER N'EST PAS MARCHER : le regard et l'animation ne changent pas.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/rtir-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.DEV_FAUCET = '1';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };
process.on('unhandledRejection', (e) => {
  console.log('  RATE essai interrompu : ' + (e && e.message ? e.message : e));
  process.exit(1);
});

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const { Game } = require('./game');
  let moteur = null; const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  const { Realm } = require('./realm');
  let monde = null; const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) { monde = this; return pas0.call(this, dt); };
  /* ---- ON NOTE LE POINT DE NAISSANCE ----
   * Un projectile AVANCE : le lire deux cent cinquante millisecondes plus
   * tard, c'est le lire cent quarante unites plus loin, et conclure qu'il est
   * ne au mauvais endroit. On releve donc sa position a l'instant ou il
   * nait. */
  let ne = null; const tire0 = Realm.prototype.tire;
  Realm.prototype.tire = function (addr, a) {
    const k = tire0.call(this, addr, a);
    if (k > 0) { const t = this.tirs[this.tirs.length - 1]; ne = { x: t.x, y: t.y, a: t.a }; }
    return k;
  };
  require('./server');
  const M = require('./monde');
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
  const w = ethers.Wallet.createRandom();
  const s = await ouvre();
  const h = await attend(s, 'hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  await attend(s, 'auth');
  for (let i = 0; i < 20; i++) { s.send(JSON.stringify({ type: 'devCredit' })); await new Promise((r) => setTimeout(r, 40)); }
  await new Promise((r) => setTimeout(r, 400));
  s.send(JSON.stringify({ type: 'skinBuy', id: 'andy' }));
  await attend(s, 'skins');
  s.send(JSON.stringify({ type: 'realmJoin' }));
  await attend(s, 'realmEntre');
  await new Promise((r) => setTimeout(r, 400));
  const A = w.address;
  /* La clef exacte sous laquelle le monde nous connait : `etatPour` la
     demande telle quelle, et se tromper de casse rend `null` sans rien dire. */
  const CLE = monde.joueurs.has(A) ? A : A.toLowerCase();
  const j = monde.joueurs.get(CLE);
  ok(!!j, 'on est dans le monde');
  const attendreTir = async () => {
    /* La cadence : on laisse la recharge finir, sinon le deuxieme tir est
       refuse et l'essai mesure le premier deux fois. */
    for (let i = 0; i < 40 && j.recharge > 0; i++) await new Promise((r) => setTimeout(r, 30));
  };

  // ================== 1. LE TIR PART D'OU L'ON EST
  {
    /* On se place au calme, loin des bords, et on vide ce qui vole. */
    j.x = M.MONDE.w / 2; j.y = 400; j.recharge = 0;
    monde.tirs.length = 0;
    await attendreTir();
    /* On COURT : la page annonce sa nouvelle position avec le tir. Cent
       unites plus loin, c'est moins d'un dixieme de seconde de course — un
       pas honnete. */
    const versX = j.x + 100;
    ne = null;
    s.send(JSON.stringify({ type: 'realmTir', a: 0, x: Math.round(versX), y: Math.round(j.y) }));
    await new Promise((r) => setTimeout(r, 250));
    ok(!!ne, 'un projectile est ne');
    console.log('   annonce en x = ' + Math.round(versX) + ', projectile ne en x = ' + (ne ? Math.round(ne.x) : '-'));
    ok(ne && Math.abs(ne.x - versX) < 6,
       `il part d ou le joueur se trouve (${ne ? Math.round(ne.x) : '-'} contre ${Math.round(versX)})`);
    ok(Math.abs(j.x - versX) < 6, 'et le joueur y est bien, cote serveur');
  }

  // ================== 2. SANS POSITION, RIEN NE CHANGE
  //
  // Une vieille page qui n'envoie que l'angle doit continuer de tirer. Elle
  // tirera d'ou le serveur la croit — c'est ce qu'elle faisait deja.
  {
    j.x = 1000; j.y = 1000; j.recharge = 0;
    monde.tirs.length = 0;
    await attendreTir();
    ne = null;
    s.send(JSON.stringify({ type: 'realmTir', a: 0 }));
    await new Promise((r) => setTimeout(r, 250));
    ok(!!ne, 'le tir part quand meme');
    ok(ne && Math.abs(ne.x - 1000) < 2 && Math.abs(ne.y - 1000) < 2,
       'depuis la position que le serveur connait');
  }

  // ================== 3. ON NE SE TELEPORTE PAS EN TIRANT
  //
  // C'est le point qui compte : la position voyage avec le tir, mais elle
  // passe par le MEME controle que les pas. Sinon un tir par image suffirait
  // a traverser la carte.
  {
    j.x = 1000; j.y = 1000; j.recharge = 0;
    monde.tirs.length = 0;
    await attendreTir();
    ne = null;
    s.send(JSON.stringify({ type: 'realmTir', a: 0, x: 7000, y: 1000 }));
    await new Promise((r) => setTimeout(r, 250));
    const parcouru = Math.abs(j.x - 1000);
    console.log('   annonce a 6000 unites : le serveur en accorde ' + Math.round(parcouru));
    ok(parcouru < 400,
       `un bond de six mille unites est ramene a ce que la vitesse permet (${Math.round(parcouru)})`);
    ok(ne && Math.abs(ne.x - 7000) > 5000,
       `et le projectile part de la position CORRIGEE, pas de celle annoncee (${ne ? Math.round(ne.x) : '-'})`);
  }

  // ================== 4. PARALYSE, ON TIRE SANS AVANCER
  //
  // Le refus vit dans le serveur. Un tir qui porterait sa position
  // contournerait la paralysie — la meme faille que la page, par une autre
  // porte.
  {
    j.x = 1000; j.y = 1000; j.recharge = 0;
    j.paralyse = 3;
    monde.tirs.length = 0;
    await attendreTir();
    s.send(JSON.stringify({ type: 'realmTir', a: 0, x: 1200, y: 1000 }));
    await new Promise((r) => setTimeout(r, 250));
    ok(Math.abs(j.x - 1000) < 2,
       `paralyse, on ne se deplace pas en tirant (x = ${Math.round(j.x)})`);
    j.paralyse = 0;
  }

  // ================== 5. TIRER N'EST PAS MARCHER
  {
    j.x = 1000; j.y = 1000; j.recharge = 0;
    j.dir = 'up'; j.anim = 'idle';
    await attendreTir();
    s.send(JSON.stringify({ type: 'realmTir', a: 0, x: 1050, y: 1000 }));
    await new Promise((r) => setTimeout(r, 250));
    eq(j.dir, 'up', 'le regard ne change pas');
    eq(j.anim, 'idle', 'ni l animation : on ne patine pas sur place');
  }

  // ================== 6. ET ON TOUCHE VRAIMENT, EN COURANT
  //
  // Le vrai test : un monstre devant soi, on court vers lui en tirant. C'est
  // la situation exacte qui ratait.
  {
    /* A PORTEE DE SON ARME. Le personnage n'en porte aucune : il tire donc au
       poing, dont la portee est de cent cinquante unites. Poser la cible a
       six cents, c'est mesurer qu'un projectile meurt avant d'arriver — ce
       qui est vrai, et sans rapport avec la question. */
    const arme = M.ARMES[j.famille] || M.ARMES.poing;
    const loin = Math.round(arme.portee * 0.55);
    j.x = 1000; j.y = 1000; j.recharge = 0;
    monde.tirs.length = 0;
    monde.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: 1000 + loin, y: 1000,
                        ancreX: 1000 + loin, ancreY: 1000, pv: 100000, pvMax: 100000,
                        dir: 'down', cible: null, recharge: 0, rechargeT: 0,
                        stase: 0, errX: 0, errY: 0, errChrono: 0 }];
    const pv0 = monde.monstres[0].pv;
    /* On court vers lui en tirant, comme un joueur. Chaque tir annonce la
       position du moment — c'est exactement ce que fait la page. */
    for (let k = 0; k < 30; k++) {
      const cible = monde.monstres[0];
      /* Le monstre ne bouge pas : on le fige a chaque tour, sinon il vient au
         contact et la question n'est plus la meme. */
      cible.x = 1000 + loin; cible.y = 1000; cible.stase = 9;
      const a = Math.atan2(cible.y - j.y, cible.x - j.x);
      /* On avance vers lui sans l'atteindre : au contact, la question n'est
         plus « est-ce qu'on touche en courant ». */
      const nx = Math.min(1000 + loin - 60, j.x + 12);
      s.send(JSON.stringify({ type: 'realmTir', a, x: Math.round(nx), y: Math.round(j.y) }));
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 400));
    const perdu = pv0 - monde.monstres[0].pv;
    console.log('   en courant vers lui : ' + perdu + ' degats portes');
    ok(perdu > 0, `on le touche en courant (${perdu} degats)`);
  }

  // ================== 7. LA CADENCE ANNONCEE PORTE TOUT
  //
  // La page se limitait a la cadence de l'ARME. Le serveur, lui, la multiplie
  // par la dexterite et par la rafale : il acceptait donc deux fois plus de
  // tirs qu'elle n'en demandait. La dexterite ne servait a rien, et « Rapid
  // fire » ne faisait que dessiner une aura.
  //
  // Elle part donc dans l'etat, calculee une seule fois, la ou la regle vit.
  {
    j.rafale = 0; j.paralyse = 0;
    const e = monde.etatPour(CLE, 1400);
    const arme = M.ARMES[j.famille] || M.ARMES.poing;
    ok(e && e.moi && e.moi.c > 0, `l etat annonce une cadence (${e && e.moi && e.moi.c})`);
    const attendue = arme.cadence * (j.cadence || 1);
    ok(Math.abs(e.moi.c - attendue) < 0.05,
       `elle vaut l arme FOIS la dexterite (${e.moi.c} contre ${attendue.toFixed(2)})`);
    ok(e.moi.c > arme.cadence,
       `donc plus que l arme seule (${e.moi.c} contre ${arme.cadence}) — la dexterite sert enfin`);

    /* ---- ET LA RAFALE LA MULTIPLIE ----
     * « Rapid fire » doit faire tirer plus vite. C'est tout ce qu'il fait, et
     * c'est pour ca qu'on le lit dans la cadence et nulle part ailleurs. */
    j.rafale = 3;
    const f = monde.etatPour(CLE, 1400);
    ok(f.moi.c > e.moi.c * 2,
       `en rafale, elle plus que double (${f.moi.c} contre ${e.moi.c})`);
    ok(Math.abs(f.moi.c - e.moi.c * M.POUVOIRS.rafale.facteur) < 0.05,
       `exactement le facteur du pouvoir (x${M.POUVOIRS.rafale.facteur})`);
    /* Et le serveur ACCEPTE ce rythme : annoncer une cadence qu'il refuserait
       ferait tirer la page dans le vide une fois sur deux. */
    j.recharge = 0;
    monde.tirs.length = 0;
    let partis = 0;
    for (let k = 0; k < 12; k++) {
      partis += monde.tire(CLE, 0);
      /* Le temps passe comme dans le jeu : c'est la recharge qui decide. */
      /* Un peu PLUS que la periode annoncee, pas un peu moins :
         `1/(c*1.05)` est plus court que `1/c`, et refusait un tir sur deux. */
      monde.pas(1.05 / f.moi.c);
    }
    ok(partis >= 10, `douze demandes au rythme annonce, ${partis} tirs partis`);
    j.rafale = 0;
  }

  s.close();
  console.log('tir_course.test.js : ' + n + ' verifications OK');
  process.exit(0);
})();
