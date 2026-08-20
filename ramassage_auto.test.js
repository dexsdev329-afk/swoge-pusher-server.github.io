'use strict';
/*
 * MARCHER SUR UN SAC LE VIDE.
 *
 * C'etait le geste le plus frequent du jeu, et le plus penible : ouvrir une
 * grille, viser une case, double-cliquer, recommencer — pendant qu'un colosse
 * arrive.
 *
 * ---- ce que ce fichier protege, dans l'ordre ----
 *
 * 1. CE QUI NE RENTRE PAS RESTE. Un sac plein, une potion au plafond : la
 *    piece ne disparait pas, elle attend la fin de sa minute. Un ramassage
 *    automatique qui DETRUIT ce qu'il ne peut pas prendre serait pire que pas
 *    de ramassage du tout — et c'est le seul defaut de cette fonction qui
 *    coute de l'argent reel.
 * 2. Ce qui rentre rentre : objets dans le sac, potions dans la pile.
 * 3. Il ne tourne pas en rond. Refuser une place ne la retire pas de la
 *    liste : reessayer la meme pour toujours bloquerait le serveur entier.
 * 4. Il ne parle que quand il se passe quelque chose. Dix fois par seconde et
 *    par joueur, un « rien » serait dix messages par seconde pour dire qu'il
 *    ne se passe rien.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/rauto-');
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
  require('./server');
  const M = require('./monde');
  const B = require('./boutique');
  await new Promise((r) => setTimeout(r, 900));

  const s = await new Promise((res, rej) => {
    const w = new WebSocket('ws://127.0.0.1:' + port);
    w.recus = [];
    w.on('message', (d) => { try { w.recus.push(JSON.parse(d)); } catch (e) {} });
    w.on('open', () => res(w)); w.on('error', rej);
  });
  const attend = (type, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function tour() {
      const m = s.recus.filter((x) => x.type === type).pop();
      if (m) return res(m);
      if (Date.now() - t0 > (ms || 6000)) return rej(new Error('pas de ' + type));
      setTimeout(tour, 25);
    })();
  });
  const w = ethers.Wallet.createRandom();
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  await attend('auth');
  for (let i = 0; i < 20; i++) { s.send(JSON.stringify({ type: 'devCredit' })); await new Promise((r) => setTimeout(r, 40)); }
  await new Promise((r) => setTimeout(r, 400));
  s.send(JSON.stringify({ type: 'skinBuy', id: 'andy' }));
  await attend('skins');
  s.send(JSON.stringify({ type: 'realmJoin' }));
  await attend('realmEntre');
  await new Promise((r) => setTimeout(r, 500));

  const A = w.address;
  const CLE = monde.joueurs.has(A) ? A : A.toLowerCase();
  const j = monde.joueurs.get(CLE);
  ok(!!j, 'on est dans le monde');
  const p = moteur._p(A);

  /* Poser un sac SOUS LES PIEDS, comme le fait une mort de monstre. */
  const poseSac = (contenu) => {
    monde.sacs.length = 0;
    const sac = { id: 90000 + monde.sacs.length, x: j.x, y: j.y, sac: 'brun',
                  reste: M.SAC.duree, contenu: contenu.slice() };
    monde.sacs.push(sac);
    return sac;
  };
  const tourne = async (ms) => { await new Promise((r) => setTimeout(r, ms || 500)); };
  /* ---- ON ATTEND LA CONDITION, PAS UNE DUREE ----
   * Le ramassage tourne au rythme du monde, dix fois par seconde. Un delai
   * fixe marche neuf fois sur dix et rate la dixieme, quand le sac est pose
   * juste apres un tour — et un essai qui tombe au hasard vaut moins qu'un
   * essai absent. */
  const jusqua = async (cond, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 3000)) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };

  // ================== 1. UN OBJET SE RAMASSE TOUT SEUL
  {
    p.sac = {}; p.sacCases = null;
    const arme = B.ITEMS_DROP.find((o) => o.saison === 2);
    const sac = poseSac([{ item: arme.id, cle: arme.cle, nom: arme.nom, rarete: arme.rarete }]);
    s.recus.length = 0;
    await jusqua(() => sac.contenu.length === 0);
    eq((p.sac || {})[arme.id] || 0, 1, 'la piece est dans le sac du joueur, sans un geste');
    eq(sac.contenu.length, 0, 'et le sac au sol est vide');
    eq(monde.sacs.indexOf(sac), -1, 'il a meme disparu : un sac vide ne se rouvre pas');
    const dit = s.recus.filter((x) => x.type === 'realmRamasse');
    ok(dit.length >= 1, 'la page est prevenue');
    ok(dit[0].auto, 'et elle sait que c est automatique');
    ok(Array.isArray(dit[0].sacJoueur), 'avec le sac complet, pour le peindre');
  }

  // ================== 2. UNE POTION VA DANS LA PILE
  {
    const avant = moteur.potionsPour(A).find((x) => x.cle === 'vie');
    poseSac([{ potion: 'vie' }, { potion: 'mana' }]);
    s.recus.length = 0;
    await jusqua(() => monde.sacs.length === 0);
    const apres = moteur.potionsPour(A).find((x) => x.cle === 'vie');
    eq(apres.quantite, avant.quantite + 1, 'la fiole de vie est dans la pile');
    const mana = moteur.potionsPour(A).find((x) => x.cle === 'mana');
    ok(mana.quantite >= 1, 'et celle de mana aussi');
    eq(monde.sacs.length, 0, 'le sac au sol a ete vide en entier, en un seul passage');
  }

  // ================== 3. CE QUI NE RENTRE PAS RESTE
  //
  // La propriete qui coute de l'argent reel si elle casse.
  {
    /* On remplit le sac du joueur : huit places, huit pieces. */
    p.sac = {}; p.sacCases = null;
    const huit = B.ITEMS_DROP.slice(0, 8);
    huit.forEach((o) => { p.sac[o.id] = 1; });
    eq(moteur.sacRempli(A), 8, 'le sac du joueur est plein');

    const neuvieme = B.ITEMS_DROP[9];
    const sac = poseSac([{ item: neuvieme.id, cle: neuvieme.cle, nom: neuvieme.nom,
                           rarete: neuvieme.rarete }]);
    s.recus.length = 0;
    await tourne(700);
    eq(sac.contenu.length, 1, 'la piece est TOUJOURS dans le sac au sol');
    eq(sac.contenu[0].item, neuvieme.id, 'et c est bien la meme');
    eq((p.sac || {})[neuvieme.id] || 0, 0, 'elle n est pas entree dans un sac plein');
    eq(moteur.sacRempli(A), 8, 'qui n a pas debordé');
    ok(monde.sacs.indexOf(sac) >= 0, 'et le sac au sol existe encore : il finira sa minute');
    /* ET IL SE TAIT. Un refus par tour, dix fois par seconde, remplirait la
       socket pour dire « toujours pas » — et la page afficherait un message
       d'erreur en boucle. */
    const cris = s.recus.filter((x) => x.type === 'realmRamasse');
    eq(cris.length, 0, `il ne dit rien tant qu il ne prend rien (${cris.length} messages)`);
  }

  // ================== 4. ET DES QU ON FAIT DE LA PLACE, CA ENTRE
  {
    const sac = monde.sacs[0];
    ok(sac && sac.contenu.length === 1, 'la piece attend toujours');
    const attendue = sac.contenu[0].item;
    /* On vide une place, comme un joueur qui equipe ou qui jette. */
    const premier = Object.keys(p.sac)[0];
    delete p.sac[premier]; p.sacCases = null;
    await jusqua(() => ((p.sac || {})[attendue] || 0) > 0);
    eq((p.sac || {})[attendue] || 0, 1, 'elle entre au tour suivant, sans qu on repasse dessus');
  }

  // ================== 5. IL NE TOURNE PAS EN ROND
  //
  // Refuser une place ne la retire pas de la liste. Reessayer la meme pour
  // toujours bloquerait le serveur entier — pas seulement ce joueur.
  {
    p.sac = {}; p.sacCases = null;
    B.ITEMS_DROP.slice(0, 8).forEach((o) => { p.sac[o.id] = 1; });
    const bloque = B.ITEMS_DROP[9];
    /* Trois pieces qui ne rentrent pas, et une potion qui rentre EN DERNIER :
       si la boucle restait coincee sur la premiere, la potion ne serait jamais
       prise. */
    poseSac([
      { item: bloque.id, cle: bloque.cle, nom: bloque.nom, rarete: bloque.rarete },
      { item: bloque.id, cle: bloque.cle, nom: bloque.nom, rarete: bloque.rarete },
      { item: bloque.id, cle: bloque.cle, nom: bloque.nom, rarete: bloque.rarete },
      { potion: 'vie' },
    ]);
    const avant = moteur.potionsPour(A).find((x) => x.cle === 'vie').quantite;
    const t0 = Date.now();
    await jusqua(() => moteur.potionsPour(A).find((x) => x.cle === 'vie').quantite > avant);
    const apres = moteur.potionsPour(A).find((x) => x.cle === 'vie').quantite;
    eq(apres, avant + 1, 'la potion du FOND est prise, malgre trois refus devant elle');
    eq(monde.sacs[0].contenu.length, 3, 'et les trois qui ne rentrent pas sont restees');
    ok(Date.now() - t0 < 3000, 'sans que le serveur y passe la journee');
  }

  // ================== 6. LE GESTE A LA MAIN MARCHE TOUJOURS
  //
  // Le ramassage automatique n'a pas remplace le double-clic : il l'a
  // devance. Les deux passent par le meme chemin, et c'est voulu — deux
  // copies auraient fini par diverger sur le plafond d'une potion.
  {
    p.sac = {}; p.sacCases = null;
    /* On coupe l'automatique en s'ecartant, pour verifier la main seule. */
    const arme = B.ITEMS_DROP.find((o) => o.saison === 2);
    monde.sacs.length = 0;
    const loin = { id: 91000, x: j.x + 4000, y: j.y, sac: 'brun', reste: M.SAC.duree,
                   contenu: [{ item: arme.id, cle: arme.cle, nom: arme.nom, rarete: arme.rarete }] };
    monde.sacs.push(loin);
    await tourne(400);
    eq(loin.contenu.length, 1, 'un sac a l autre bout de la carte ne se vide pas tout seul');
    eq((p.sac || {})[arme.id] || 0, 0, 'et rien n arrive dans le sac du joueur');

    /* On se met dessus et on demande a la main. */
    j.x = loin.x; j.y = loin.y;
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmRamasse', i: loin.id, place: 0 }));
    await tourne(500);
    eq((p.sac || {})[arme.id] || 0, 1, 'le double-clic prend, comme avant');
  }

  // ================== 7. ON NE SE REPREND PAS CE QU'ON VIENT DE POSER
  //
  // Le ramassage automatique vide un sac des qu'on marche dessus. Poser une
  // piece a ses pieds la lui redonnait donc dans le meme dixieme de seconde :
  // jeter quelque chose devenait impossible sans courir en meme temps.
  {
    monde.sacs.length = 0;
    p.sac = {}; p.sacCases = null;
    const arme = B.ITEMS_DROP.find((o) => o.saison === 2);
    p.sac[arme.id] = 1;
    j.x = 3000; j.y = 3000;
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmDepose', item: arme.id }));
    await jusqua(() => monde.sacs.length === 1);
    await tourne(500);      // et on laisse plusieurs tours passer : il doit RESTER
    eq(monde.sacs.length, 1, 'un sac apparait sous ses pieds');
    eq(monde.sacs[0].contenu.length, 1, 'et la piece y RESTE');
    eq((p.sac || {})[arme.id] || 0, 0, 'elle n est pas revenue dans le sac du joueur');

    /* Et des qu'on s'ecarte, elle redevient ramassable — par soi comme par
       les autres. Il suffit de revenir dessus. */
    const sac = monde.sacs[0];
    j.x = sac.x + M.SAC.rayon * 3; j.y = sac.y;
    await tourne(400);
    eq(sac.pose, null, 's ecarter rend le sac a tout le monde');
    j.x = sac.x; j.y = sac.y;
    await jusqua(() => ((p.sac || {})[arme.id] || 0) > 0);
    eq((p.sac || {})[arme.id] || 0, 1, 'et en repassant dessus, on la reprend');
  }

  // ================== 8. UNE FIOLE DE STAT SE RAMASSE, ELLE NE SE BOIT PLUS
  //
  // Elle etait bue sur place. A son plafond elle etait REFUSEE, et restait par
  // terre jusqu'a la fin de sa minute : une potion trouvee dans la lave se
  // perdait parce qu'on avait deja bu six defenses.
  {
    monde.sacs.length = 0;
    p.sac = {}; p.sacFioles = {}; p.sacCases = null;
    j.x = 3500; j.y = 3500;
    const avant = moteur.personnageEtat(A, 'andy').stats.def;
    poseSac([{ stat: 'def' }]);
    s.recus.length = 0;
    await jusqua(() => monde.sacs.length === 0);
    eq(monde.sacs.length, 0, 'la fiole est ramassee en marchant dessus');
    eq(moteur.personnageEtat(A, 'andy').stats.def, avant,
       'et AUCUNE stat ne bouge : elle attend dans le sac');
    const l = moteur.sacPour(A).find((x) => x.fiole === 'def');
    ok(l, 'elle est bien dans le sac, a une place');
    eq(moteur.sacRempli(A), 1, 'qu elle occupe');
    const dit = s.recus.filter((x) => x.type === 'realmRamasse').pop();
    ok(dit && dit.stat === 'def', 'la page est prevenue de ce qu on a pris');
    ok(dit && Array.isArray(dit.fioles), 'avec la reserve complete, pour la peindre');

    /* ---- ET AU PLAFOND, ELLE SE RAMASSE QUAND MEME ----
     * C'est tout le changement : la fiole ne se perd plus parce qu'on est
     * plein. On la garde, on la range au coffre, on la boit plus tard. */
    const mx = require('./personnages').supMaxDe('def', require('./personnages').BASE.andy.def);
    /* On passe par le chemin du jeu : `boitStat` cree la fiche du personnage
       si elle n'existe pas, et c'est elle qui porte le plafond. */
    for (let k = 0; k < mx; k++) moteur.boitStat(A, 'andy', 'def');
    p.sac = {}; p.sacFioles = {}; p.sacCases = null;
    poseSac([{ stat: 'def' }]);
    await jusqua(() => monde.sacs.length === 0);
    console.log('   plafond de defense : ' + mx + ' — la fiole est prise quand meme');
    eq(monde.sacs.length, 0, 'au plafond, elle se ramasse quand meme');
    ok(moteur.sacPour(A).some((x) => x.fiole === 'def'),
       'et elle attend dans le sac au lieu de finir sa minute par terre');
  }

  s.close();
  console.log('ramassage_auto.test.js : ' + n + ' verifications OK');
  process.exit(0);
})();
