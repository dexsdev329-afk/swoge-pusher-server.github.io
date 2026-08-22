'use strict';
/*
 * ENTRER A PLUSIEURS DANS LE MEME DONJON — POUR TOUS LES DONJONS.
 *
 * ---- LA QUESTION, TELLE QU'ELLE A ETE POSEE ----
 *
 * « verifie aussi que quand on monte dans le meme portail donjon on puisse le
 * faire ensemble pour TOUS les dungeons ».
 *
 * `donjon_serveur.test.js` verifiait deja qu'a deux on arrive au meme endroit
 * — mais SEULEMENT par la porte de la Forge, la seule qui existait quand il a
 * ete ecrit. Deux donjons sont arrives depuis, et rien ne disait qu'ils se
 * comportaient pareil. Ici on enumere les donjons DEPUIS LE MONDE : le
 * quatrieme sera couvert sans qu'on y pense, et c'est le seul moyen pour que
 * cette phrase reste vraie.
 *
 * ---- CE QUI PEUT CASSER, ET QUI NE SE VOIT PAS ----
 *
 * 1. UNE SIMULATION PAR JOUEUR. On entre a deux, on se retrouve seul, chacun
 *    persuade que l'autre a menti. Rien ne leve d'erreur : les deux donjons
 *    marchent parfaitement, separement.
 * 2. LE MEME DONJON POUR DEUX PORTES. L'inverse : deux equipes qui ne se sont
 *    pas donne rendez-vous se retrouvent dans la meme salle, et le boss de
 *    l'une meurt sous les coups de l'autre.
 * 3. LE PLAFOND QUI REFUSE UN AMI. Le serveur borne le nombre de simulations.
 *    Ce plafond etait teste AVANT qu'on cherche si le donjon existe deja :
 *    quand les vingt-quatre places etaient prises, on ne pouvait plus
 *    REJOINDRE quelqu'un — alors qu'entrer dans un donjon existant ne cree
 *    rien. Et ca tombait precisement quand le serveur est plein, c'est-a-dire
 *    quand il y a le plus de monde avec qui jouer.
 * 4. ARRIVER AILLEURS. Meme simulation, mais deux points d'entree : on est
 *    ensemble sans se voir, ce qui est la version la plus cruelle du premier
 *    defaut.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/dens-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const { Realm } = require('./realm');
  let monde0 = null;
  const ouverts = new Set(), vivants = new Set();
  const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) {
    if (this.plan) vivants.add(this); else ouverts.add(this);
    return pas0.call(this, dt);
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
      if (Date.now() - t0 > (ms || 8000)) return rej(new Error('pas de ' + type));
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
  const donjonsVivants = () => [...vivants].filter((r) => r.joueurs.size > 0);

  /* Un joueur, entre dans le monde ouvert. */
  const entre = async () => {
    const w = ethers.Wallet.createRandom();
    const s = await connecte(w);
    const a = w.address.toLowerCase();
    s.send(JSON.stringify({ type: 'realmJoin' }));
    await attend(s, 'realmEntre');
    if (!monde0) monde0 = [...ouverts].find((r) => r.joueurs.has(a)) || null;
    return { s, a };
  };

  /* ---- LA PORTE D'UN DONJON PRECIS ----
   * On ne fabrique pas la porte a la main : c'est `_ouvrePortail` du VRAI
   * serveur qui la pose, avec ses vraies regles. Ce qu'on choisit, c'est la
   * creature qui meurt — et le monde dit laquelle ouvre quel donjon. */
  const poseLaPorte = (addr, ouvreur) => {
    const j = monde0.joueurs.get(addr);
    const t = M.MONSTRES[ouvreur];
    const m = { id: monde0._nouvelId(), espece: ouvreur, biome: t.biomes && t.biomes[0] || 'lave',
                x: j.x, y: j.y, ancreX: j.x, ancreY: j.y,
                pv: 0, pvMax: t.pv, dir: 'down', cible: null,
                recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 };
    const p = monde0._ouvrePortail(m, null, null);
    p.x = j.x; p.y = j.y;
    return p;
  };

  /* ================== LES DONJONS, ENUMERES DEPUIS LE MONDE ================== */
  const CLES = Object.keys(M.DONJONS);
  console.log(`-- ${CLES.length} donjons a verifier : ${CLES.join(', ')} --`);
  ok(CLES.length >= 3, 'le monde en declare au moins trois');
  /* La creature qui ouvre chaque donjon vient de la table, pas d'ici : sans
     ca, ajouter un donjon demanderait de penser a cet essai. */
  for (const cle of CLES) {
    ok(!!M.DONJONS[cle].ouvreur && !!M.MONSTRES[M.DONJONS[cle].ouvreur],
       `« ${cle} » est ouvert par « ${M.DONJONS[cle].ouvreur} », qui existe`);
  }

  const ouvertsPar = {};
  for (const cle of CLES) {
    console.log(`\n-- ${cle} --`);
    const A = await entre();
    const B = await entre();
    /* A ouvre la porte et entre. */
    const porte = poseLaPorte(A.a, M.DONJONS[cle].ouvreur);
    eq(porte.donjon, cle, `la porte posee mene bien au ${cle}`);
    A.s.recus.length = 0;
    A.s.send(JSON.stringify({ type: 'realmPorte' }));
    const dA = await attend(A.s, 'realmEntre');
    eq(dA.donjon, cle, 'le premier entre');

    /* B accourt sur LA MEME porte. */
    const jb = monde0.joueurs.get(B.a);
    jb.x = porte.x; jb.y = porte.y;
    B.s.recus.length = 0;
    B.s.send(JSON.stringify({ type: 'realmPorte' }));
    const dB = await attend(B.s, 'realmEntre');
    eq(dB.donjon, cle, 'le second entre aussi');
    await dort(350);

    /* UNE SEULE simulation, et les deux dedans. C'est la promesse. */
    const dans = donjonsVivants().filter((r) => r.joueurs.has(A.a) || r.joueurs.has(B.a));
    eq(dans.length, 1, 'une seule simulation les contient tous les deux');
    ok(dans[0].joueurs.has(A.a) && dans[0].joueurs.has(B.a), 'et ils y sont bien tous les deux');
    /* AU MEME ENDROIT. Meme salle et deux points d'entree, c'est etre ensemble
       sans se voir — la version la plus cruelle du defaut qu'on evite. */
    eq(dB.moi.x, dA.moi.x, 'ils arrivent au meme endroit (x)');
    eq(dB.moi.y, dA.moi.y, 'et au meme (y)');
    /* ET ILS SE VOIENT. Sans ca, chacun a la preuve que l'autre a menti. */
    A.s.recus.length = 0;
    const vue = await attend(A.s, 'realmEtat');
    ok(vue.joueurs.some((q) => String(q.a).toLowerCase() === B.a),
       'le premier voit le second dans la salle');
    ouvertsPar[cle] = { A, B, porte, realm: dans[0] };
  }

  /* ================== DEUX PORTES NE SE MELANGENT PAS ================== */
  console.log('\n-- deux portes du meme donjon restent deux donjons --');
  {
    const cle = CLES[0];
    const C = await entre();
    const porte2 = poseLaPorte(C.a, M.DONJONS[cle].ouvreur);
    ok(porte2.id !== ouvertsPar[cle].porte.id, 'la deuxieme porte a son propre identifiant');
    C.s.recus.length = 0;
    C.s.send(JSON.stringify({ type: 'realmPorte' }));
    await attend(C.s, 'realmEntre');
    await dort(350);
    const dc = donjonsVivants().find((r) => r.joueurs.has(C.a));
    ok(!!dc, 'le troisieme est entre');
    ok(dc !== ouvertsPar[cle].realm,
       'et il n\'est PAS avec ceux de la premiere porte — sinon deux equipes se voleraient leur boss');
  }

  /* ================== LE PLAFOND NE SEPARE PAS LES AMIS ================== */
  console.log('\n-- serveur plein : on peut encore REJOINDRE --');
  {
    /* ---- L'ORDRE DE CETTE SCENE EST TOUT ----
     * Premiere version : elle reutilisait la porte ouverte tout en haut, dans
     * la section « forge ». Le serveur a refuse avec « pas-de-portail » — les
     * portes se referment au bout de quelques minutes, et il s'en etait passe
     * bien plus depuis. L'essai accusait alors le plafond d'un refus qui
     * venait d'une porte disparue : deux causes differentes, un seul message
     * a l'arrivee.
     * On ouvre donc la porte des AMIS juste avant de saturer, et l'on sature
     * ensuite. Elle est encore chaude quand on s'en sert. */
    const cle = CLES[0];
    const A2 = await entre();
    const porteAmis = poseLaPorte(A2.a, M.DONJONS[cle].ouvreur);
    A2.s.recus.length = 0;
    A2.s.send(JSON.stringify({ type: 'realmPorte' }));
    await attend(A2.s, 'realmEntre');
    await dort(250);
    const leur = donjonsVivants().find((r) => r.joueurs.has(A2.a));
    ok(!!leur, 'un ami est deja dans un donjon ouvert');

    /* On sature. Le plafond est une constante du serveur qu'on ne peut pas
       lire d'ici : on ouvre des portes jusqu'a ce qu'il refuse, ce qui le
       trouve sans le connaitre — et reste vrai le jour ou il change. */
    let refuse = null, combien = 0;
    for (let k = 0; k < 40 && !refuse; k++) {
      const X = await entre();
      poseLaPorte(X.a, M.DONJONS[cle].ouvreur);
      X.s.recus.length = 0;
      X.s.send(JSON.stringify({ type: 'realmPorte' }));
      await dort(120);
      const r = X.s.recus.filter((m) => m.type === 'realmPorteRefus').pop();
      if (r && r.raison === 'trop-de-donjons') refuse = r;
      else combien++;
    }
    ok(!!refuse, `le serveur finit par refuser d'en OUVRIR un de plus (apres ${combien})`);

    /* Et maintenant la vraie question : un ami peut-il encore rejoindre un
       donjon DEJA OUVERT ? Entrer dedans n'en cree aucun — le plafond protege
       le nombre de simulations, il n'a rien a dire ici. */
    const ami = await entre();
    const jb = monde0.joueurs.get(ami.a);
    jb.x = porteAmis.x; jb.y = porteAmis.y;
    ami.s.recus.length = 0;
    ami.s.send(JSON.stringify({ type: 'realmPorte' }));
    await dort(400);
    const refus2 = ami.s.recus.filter((m) => m.type === 'realmPorteRefus').pop();
    ok(!refus2, `aucun refus${refus2 ? ' — ' + refus2.raison : ''}`);
    const dedans = await attend(ami.s, 'realmEntre');
    eq(dedans.donjon, cle, 'serveur plein, on rejoint quand meme ses amis');
    await dort(300);
    ok(leur.joueurs.has(ami.a), "et c'est bien LEUR salle, pas une nouvelle");
  }

  console.log(`\ndonjons_ensemble.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.log('  RATE ' + (e && e.message ? e.message : e)); process.exit(1); });
