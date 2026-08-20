'use strict';
/*
 * L'ECHANGE — ET LA SEULE REGLE QUI COMPTE : RIEN NE DISPARAIT.
 *
 * Un joueur a perdu une arme en echangeant : elle n'etait ni dans son sac,
 * ni par terre. C'est la faute la plus chere du jeu — les pieces se paient en
 * vrai $SWOGE — et c'est aussi la plus facile a ecrire sans s'en rendre
 * compte, parce qu'elle demande DEUX ecritures : sortir d'un endroit, entrer
 * dans un autre. Entre les deux, la piece n'est nulle part, et tout ce qui
 * peut echouer la-dedans la detruit.
 *
 * Cet essai ne verifie donc pas « le message repond bien ». Il compte les
 * PIECES, partout ou une piece peut se trouver — le sac, le coffre, les
 * quatre emplacements portes, et tous les sacs poses au sol — avant et apres
 * chaque geste. Le total ne doit jamais bouger.
 *
 * Un refus est un resultat acceptable. Une disparition n'en est pas un.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/rech-');
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
  /* Le monde vit dans server.js et n'est exporte nulle part. On l'attrape au
     passage : c'est lui qui tient les sacs poses au sol, et sans eux on ne
     peut pas COMPTER — donc pas conclure. */
  const { Realm } = require('./realm');
  let monde = null; const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) { monde = this; return pas0.call(this, dt); };
  require('./server');
  const B = require('./boutique');
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
  const entre = await attend(s, 'realmEntre');
  await new Promise((r) => setTimeout(r, 400));
  ok(!!monde, 'le monde tourne et on peut le compter');
  const A = w.address;

  /* ---- OU UNE PIECE PEUT SE TROUVER ----
   * Cinq endroits, et il faut les cinq. En oublier un ferait passer une
   * disparition pour un deplacement. */
  /* Une piece PORTEE reste au coffre : s'equiper ne sort rien, ca pose une
     etiquette. Compter les quatre emplacements EN PLUS du coffre compterait
     donc deux fois la meme piece — et le total se mettrait a bouger des qu'on
     change d'arme, pour rien. On compte les trois endroits ou une piece
     EXISTE, et on verifie a part que ce qu'on porte s'y trouve. */
  function inventaire() {
    const p = moteur._p(A);
    const c = {};
    const met = (id) => { if (id !== null && id !== undefined) c[id] = (c[id] || 0) + 1; };
    Object.keys(p.sac || {}).forEach((id) => { for (let k = 0; k < p.sac[id]; k++) met(id); });
    Object.keys(p.objets || {}).forEach((id) => { for (let k = 0; k < p.objets[id]; k++) met(id); });
    for (const sac of monde.sacs) for (const o of sac.contenu) if (o.item) met(o.item);
    return c;
  }
  /* ON NE PORTE QUE CE QU'ON POSSEDE. C'est l'autre moitie du compte : une
     piece portee qui aurait quitte le coffre serait invisible au comptage
     ci-dessus, et c'est exactement la forme que prend une disparition. */
  function porteFantome() {
    const p = moteur._p(A);
    const manquants = [];
    Object.keys(p.persos || {}).forEach((k) => {
      const q = p.persos[k]; if (!q) return;
      [q.ef, q.ea, q.ar, q.ba].forEach((id) => {
        if (id && !((p.objets || {})[id] > 0)) manquants.push(id);
      });
    });
    return manquants;
  }
  const total = (c) => Object.keys(c).reduce((t, k) => t + c[k], 0);
  const memeChose = (a, b) => {
    const cles = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of cles) if ((a[k] || 0) !== (b[k] || 0)) return k;
    return null;
  };
  /* Fait le geste, puis recompte. Rend l'identifiant de la piece qui a bouge
     en trop ou en moins — ou `null` si tout est en place. */
  /* ---- ON EMPECHE LE PERSONNAGE DE MOURIR ----
   * Il passe tout l'essai debout au milieu de l'anneau de terre, et un lime
   * finit par en venir a bout. La mort DETRUIT l'equipement — c'est la regle
   * du jeu, et c'est justement pour ca qu'elle n'a rien a faire ici : elle
   * ferait passer une regle voulue pour la fuite qu'on cherche. On lui rend
   * donc ses points de vie avant chaque geste. */
  const j0 = () => monde.joueurs.get(A) || monde.joueurs.get(A.toLowerCase());
  const debout = () => { const q = j0(); if (q) q.pv = q.pvMax; };

  async function geste(nom, faire) {
    debout();
    const avant = inventaire();
    await faire();
    await new Promise((r) => setTimeout(r, 350));
    debout();
    const apres = inventaire();
    const fantome = porteFantome();
    ok(fantome.length === 0,
       `${nom} : on ne porte que ce qu on possede` +
       (fantome.length ? ` (${fantome.join(', ')} portes sans etre au coffre)` : ''));
    const perdu = memeChose(avant, apres);
    ok(perdu === null,
       `${nom} : rien ne disparait (${total(avant)} pieces avant, ${total(apres)} apres` +
       (perdu ? `, l objet ${perdu} passe de ${avant[perdu] || 0} a ${apres[perdu] || 0}` : '') + ')');
    return { avant, apres };
  }

  /* La fiche du personnage se cree au premier equipement, pas a l'achat du
     skin. On la fait naitre par le chemin normal — retirer l'arme — plutot
     que de la fabriquer a la main : une fiche fabriquee ici pourrait differer
     de celle du jeu, et l'essai mesurerait alors autre chose. */
  moteur.equipeArme(A, 'andy', null);
  /* La fiche du personnage se cree au premier equipement, pas a l'achat du
     skin. On la fait naitre par le chemin normal — retirer l'arme — plutot
     que de la fabriquer a la main : une fiche fabriquee ici pourrait differer
     de celle du jeu, et l'essai mesurerait alors autre chose. */
  moteur.equipeArme(A, 'andy', null);
  const p = moteur._p(A);
  const ARME = B.ITEMS.concat(B.ITEMS_DROP).filter((o) => o.famille === 'lame');
  const A1 = ARME[0].id, A2 = ARME[1].id, A3 = ARME[2].id;
  const j = monde.joueurs.get(A.toLowerCase()) || monde.joueurs.get(A);
  ok(!!j, 'le joueur est dans le monde');

  // ================== 1. POSER UNE PIECE PAR TERRE, SANS SAC DESSOUS
  //
  // Le serveur SAIT le faire : `depose` cree un sac s'il n'y en a pas. C'est
  // le geste le plus simple du jeu — jeter ce dont on ne veut pas.
  {
    p.sac = {}; p.sac[A1] = 1;
    monde.sacs.length = 0;
    const r = await geste('jeter une piece a ses pieds', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'realmDepose', item: A1 }));
    });
    const rep = s.recus.filter((x) => x.type === 'realmDepose').pop();
    ok(rep && !rep.refus, 'le serveur accepte' + (rep && rep.refus ? ' (refus: ' + rep.refus + ')' : ''));
    eq(monde.sacs.length, 1, 'un sac apparait sous ses pieds');
    eq((p.sac || {})[A1] || 0, 0, 'et la piece n est plus dans le sac du joueur');
    eq(r.apres[A1], 1, 'elle est quelque part, une fois');
  }

  // ================== 2. LA REPRENDRE
  {
    const r = await geste('la reprendre', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'realmRamasse', i: monde.sacs[0].id, place: 0 }));
    });
    eq((p.sac || {})[A1] || 0, 1, 'elle est revenue dans le sac');
    eq(monde.sacs.length, 0, 'et le sac vide a disparu');
    eq(r.apres[A1], 1, 'toujours une seule');
  }

  // ================== 3. L'ECHANGE : SA PIECE CONTRE CELLE DU SOL
  //
  // C'est le geste qui a coute une arme a un joueur. Le sac est PLEIN — c'est
  // le cas ou l'echange sert a quelque chose, et c'est aussi celui ou l'ordre
  // des deux ecritures compte.
  {
    p.sac = {};
    const bourre = B.ITEMS.slice(0, 8).map((o) => o.id);
    bourre.forEach((id) => { p.sac[id] = (p.sac[id] || 0) + 1; });
    eq(moteur.sacRempli(A), 8, 'le sac du joueur est plein (8)');
    monde.sacs.length = 0;
    monde.sacs.push({ id: 90001, x: j.x, y: j.y, sac: 'or', reste: 60,
                      contenu: [{ item: A2, cle: null, nom: null, rarete: null }] });

    /* Le geste tel que la page l'envoie : on POSE la sienne, puis on PREND
       la leur. Deux messages a la suite sur la meme socket. */
    const r = await geste('echanger, sac plein', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'realmDepose', item: bourre[0] }));
      s.send(JSON.stringify({ type: 'realmRamasse', i: 90001, place: 0 }));
    });
    ok(r.apres[bourre[0]] >= 1, `la piece posee existe encore (${r.apres[bourre[0]] || 0})`);
    ok(r.apres[A2] >= 1, `et celle qu on a prise aussi (${r.apres[A2] || 0})`);
    eq((p.sac || {})[A2] || 0, 1, 'la trouvaille est dans le sac du joueur');
    const auSol = monde.sacs.reduce((t, q) => t + q.contenu.filter((o) => o.item === bourre[0]).length, 0);
    eq(auSol + ((p.sac || {})[bourre[0]] || 0), 1,
       'et la sienne est quelque part : au sol ou dans le sac, pas les deux, pas zero');
  }

  // ================== 4. PRENDRE AVEC UN SAC PLEIN : ON REFUSE, ON NE PERD PAS
  {
    p.sac = {};
    B.ITEMS.slice(0, 8).forEach((o) => { p.sac[o.id] = (p.sac[o.id] || 0) + 1; });
    monde.sacs.length = 0;
    monde.sacs.push({ id: 90002, x: j.x, y: j.y, sac: 'or', reste: 60,
                      contenu: [{ item: A3, cle: null, nom: null, rarete: null }] });
    await geste('prendre avec un sac plein', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'realmRamasse', i: 90002, place: 0 }));
    });
    const rep = s.recus.filter((x) => x.type === 'realmRamasse').pop();
    eq(rep && rep.refus, 'sac-plein', 'le serveur refuse, et il le dit');
    eq(monde.sacs.length, 1, 'le sac au sol est toujours la');
    eq(monde.sacs[0].contenu.length, 1, 'avec sa piece dedans');
  }

  // ================== 5. POSER SUR UN SAC AU SOL DEJA PLEIN
  {
    p.sac = {}; p.sac[A1] = 1;
    monde.sacs.length = 0;
    monde.sacs.push({ id: 90003, x: j.x, y: j.y, sac: 'or', reste: 60,
                      contenu: B.ITEMS.slice(10, 18).map((o) => ({ item: o.id, cle: null, nom: null, rarete: null })) });
    eq(monde.sacs[0].contenu.length, 8, 'le sac au sol est plein (8)');
    await geste('poser sur un sac plein', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'realmDepose', item: A1 }));
    });
    const rep = s.recus.filter((x) => x.type === 'realmDepose').pop();
    ok(rep && rep.refus, 'le serveur refuse' + (rep && !rep.refus ? ' (il a accepte !)' : ''));
    eq((p.sac || {})[A1] || 0, 1, 'et la piece est RENDUE au sac du joueur');
  }

  // ================== 5 bis. POSER DANS UN SAC QUI ALLAIT EXPIRER
  //
  // C'est ce qui a coute une arme a un joueur. Un sac tombe d'un monstre a
  // soixante secondes a vivre. Poser SA piece dedans a la cinquante-neuvieme,
  // c'est la confier a un sac qui disparait dans une seconde — ni dans le sac,
  // ni par terre : detruite, sans un mot.
  {
    p.sac = {}; p.sac[A1] = 1;
    monde.sacs.length = 0;
    monde.sacs.push({ id: 90004, x: j.x, y: j.y, sac: 'brun', reste: 0.4, contenu: [] });
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmDepose', item: A1 }));
    await new Promise((r) => setTimeout(r, 300));
    const sac = monde.sacs.find((q) => q.id === 90004);
    ok(sac, 'le sac est encore la juste apres qu on y a pose sa piece');
    ok(sac && sac.reste > 30,
       `et sa minute REPART (${sac ? sac.reste.toFixed(1) : '-'} s devant lui)`);
    /* Et une seconde plus tard, il n'a evidemment pas disparu. */
    await new Promise((r) => setTimeout(r, 1200));
    const encore = monde.sacs.find((q) => q.id === 90004);
    ok(encore && encore.contenu.some((o) => o.item === A1),
       'une seconde plus tard, la piece est toujours par terre');
    /* On la reprend, pour laisser le compte propre a la suite. */
    s.send(JSON.stringify({ type: 'realmRamasse', i: 90004, place: 0 }));
    await new Promise((r) => setTimeout(r, 300));
  }

  // ================== 6. S'EQUIPER D'UNE TROUVAILLE : L'ANCIENNE NE MEURT PAS
  //
  // La page envoie deux messages a la suite : ranger au coffre, puis equiper.
  // Ce qu'on portait avant doit rester quelque part — le coffre. Le joueur ne
  // le trouvera ni dans son sac ni par terre, et c'est normal ; ce qui ne
  // serait pas normal, c'est qu'il ne soit nulle part.
  {
    p.sac = {}; p.objets = {};
    p.objets[A1] = 1;
    moteur._p(A).persos.andy.ea = A1;          // on porte la premiere
    p.sac[A2] = 1;                              // et on vient de trouver la seconde
    const r = await geste('s equiper de la trouvaille', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'rangeCoffre', item: A2 }));
      s.send(JSON.stringify({ type: 'equipeArme', skin: 'andy', item: A2 }));
    });
    eq(moteur._p(A).persos.andy.ea, A2, 'la trouvaille est portee');
    eq(r.apres[A1], 1, 'et l ancienne existe toujours');
    eq((p.objets || {})[A1] || 0, 1, 'elle est au COFFRE — pas perdue, juste ailleurs');
  }

  // ================== 6 bis. L'ECHANGE EN UN GESTE : L'ANCIENNE REVIENT AU SAC
  //
  // Un double-clic sur une piece du sac la porte, et celle qu'on portait
  // revient DANS LE SAC — pas au coffre, que le joueur ne voit pas depuis le
  // monde de combat. C'est le geste qu'on fait cent fois par partie.
  {
    p.sac = {}; p.objets = {};
    p.objets[A1] = 1; moteur._p(A).persos.andy.ea = A1;   // on porte A1
    p.sac[A2] = 1;                                         // on vient de trouver A2
    const r = await geste('echanger son arme en un geste', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: A2 }));
    });
    const rep = s.recus.filter((x) => x.type === 'equipeDuSac').pop();
    ok(rep && !rep.error, 'le serveur accepte' + (rep && rep.error ? ' (' + rep.error + ')' : ''));
    eq(moteur._p(A).persos.andy.ea, A2, 'la trouvaille est portee');
    eq((p.sac || {})[A1] || 0, 1, 'et l ANCIENNE est revenue dans le sac');
    eq((p.sac || {})[A2] || 0, 0, 'la trouvaille, elle, a quitte le sac');
    eq(rep && rep.rendu, A1, 'la reponse dit ce qui est revenu');
    eq(r.apres[A1], 1, 'aucune des deux n a ete dupliquee');
    eq(r.apres[A2], 1, 'ni l autre');
    /* La page recoit les TROIS etats d'un coup : si l'un manquait, elle
       montrerait un instant un sac sans la piece et un personnage sans arme. */
    ok(rep && rep.etat && rep.etat.equipArme && rep.etat.equipArme.item === A2,
       'la fiche repart avec, deja a jour');
    ok(rep && Array.isArray(rep.sacJoueur), 'et le sac aussi');
    ok(rep && rep.equipable, 'et la liste de ce qu on peut porter');
  }

  // ================== 6 bis 2. LA PIECE RENDUE REPREND LA MEME CASE
  //
  // « J'avais un item emplacement 2, une arme ; je l'echange contre l'arme
  // equipee : l'arme equipee doit prendre l'emplacement 2. » C'est un geste
  // dont on suit le resultat des yeux — si la piece reapparait ailleurs, on la
  // croit perdue.
  {
    p.sac = {}; p.objets = {};
    const autres = B.ITEMS.filter((o) => o.famille !== 'lame').slice(0, 4).map((o) => o.id);
    autres.forEach((x) => { p.sac[x] = 1; });
    p.sac[A2] = 1;
    p.objets[A1] = 1; moteur._p(A).persos.andy.ea = A1;
    /* On lit la case que le serveur lui donne, on ne la decide pas : c'est
       celle que la page montrera. */
    const avantSac = moteur.sacPour(A);
    const laCase = avantSac.find((o) => o.id === A2);
    ok(laCase, 'la trouvaille est dans le sac');
    console.log('   elle occupe la case ' + (laCase ? laCase.place : '-'));

    const r = await geste('rendre a la meme case', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: A2 }));
    });
    const apresSac = moteur.sacPour(A);
    const rendue = apresSac.find((o) => o.id === A1);
    ok(rendue, 'l ancienne arme est bien dans le sac');
    eq(rendue && rendue.place, laCase.place,
       `et a la MEME case (${rendue ? rendue.place : '-'} au lieu de ${laCase.place})`);
    /* Et les autres pieces n'ont pas bouge : un echange ne reorganise pas le
       sac autour de lui. */
    const bouge = autres.filter((x) => {
      const a = avantSac.find((o) => o.id === x), b = apresSac.find((o) => o.id === x);
      return !a || !b || a.place !== b.place;
    });
    eq(bouge.length, 0, 'et le reste du sac n a pas bouge d une case');
    eq(r.apres[A1], 1, 'rien n a ete duplique');
  }

  // ================== 6 ter. LE SAC PLEIN N'EMPECHE PAS L'ECHANGE
  //
  // Un pour un : le compte du sac ne bouge pas. C'est la seule raison pour
  // laquelle cet echange n'a pas besoin de place libre — et c'est aussi
  // pourquoi il ne peut pas se faire en deux temps, ou le sac est plein entre
  // les deux.
  {
    p.sac = {}; p.objets = {};
    const bourre = B.ITEMS.filter((o) => o.famille !== 'lame').slice(0, 7).map((o) => o.id);
    bourre.forEach((id) => { p.sac[id] = 1; });
    p.sac[A3] = 1;                       // la huitieme place : la trouvaille
    p.objets[A1] = 1; moteur._p(A).persos.andy.ea = A1;
    eq(moteur.sacRempli(A), 8, 'le sac est plein (8) et l une des places est la trouvaille');
    const r = await geste('echanger avec un sac plein', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: A3 }));
    });
    const rep = s.recus.filter((x) => x.type === 'equipeDuSac').pop();
    ok(rep && !rep.error, 'il passe quand meme' + (rep && rep.error ? ' (' + rep.error + ')' : ''));
    eq(moteur._p(A).persos.andy.ea, A3, 'la trouvaille est portee');
    eq((p.sac || {})[A1] || 0, 1, 'et l ancienne a pris sa place dans le sac');
    eq(moteur.sacRempli(A), 8, 'le sac est toujours plein — un pour un');
    eq(r.apres[A3], 1, 'rien n a ete duplique');
  }

  // ================== 6 quater. LES REFUS NE COUTENT RIEN
  {
    p.sac = {}; p.objets = {};
    p.objets[A1] = 1; moteur._p(A).persos.andy.ea = A1;
    p.sac[A2] = 1;
    /* Une piece qu'on n'a PAS dans le sac. */
    await geste('equiper une piece qu on n a pas', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: A3 }));
    });
    let rep = s.recus.filter((x) => x.type === 'equipeDuSac').pop();
    ok(rep && rep.error, 'le serveur refuse : ' + (rep && rep.error));
    eq(moteur._p(A).persos.andy.ea, A1, 'et rien n a bouge');

    /* Un objet qui n'est pas un equipement. */
    const potion = B.ITEMS.find((o) => o.saison === 1);
    p.sac[potion.id] = 1;
    await geste('equiper au mauvais emplacement', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: potion.id }));
    });
    rep = s.recus.filter((x) => x.type === 'equipeDuSac').pop();
    /* Un fruit EST un equipement : il va dans sa case a lui, pas dans celle
       de l'arme. C'est ce qu'on veut — viser juste n'a aucun interet. */
    ok(rep && !rep.error, 'un fruit va dans SA case, sans qu on ait a viser');
    eq(moteur._p(A).persos.andy.ef, potion.id, 'le fruit est porte');
    eq(moteur._p(A).persos.andy.ea, A1, 'et l arme n a pas bouge');

    /* Deux fois la meme : on ne l'echange pas contre elle-meme. */
    p.sac = {}; p.objets = {}; p.objets[A1] = 1;
    moteur._p(A).persos.andy.ea = A1; moteur._p(A).persos.andy.ef = null;
    p.sac[A1] = 1;
    const r = await geste('equiper ce qu on porte deja', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: A1 }));
    });
    rep = s.recus.filter((x) => x.type === 'equipeDuSac').pop();
    ok(rep && rep.deja, 'le serveur dit qu elle est deja portee');
    eq((p.sac || {})[A1] || 0, 1, 'et l exemplaire du sac y reste');
    eq(r.apres[A1], 2, 'les deux exemplaires existent toujours');
  }

  // ================== 7. ON NE SORT PAS DU COFFRE CE QU'ON PORTE
  {
    /* On pose l'etat qu'on veut eprouver plutot que d'heriter de celui du
       bloc precedent : un essai qui depend de son voisin se met a mentir des
       qu'on en insere un entre les deux. */
    p.sac = {}; p.objets = {};
    p.objets[A2] = 1;
    moteur._p(A).persos.andy.ea = A2;
    moteur._p(A).persos.andy.ef = null;
    await geste('sortir du coffre une piece portee', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'sortCoffre', item: A2 }));
    });
    const rep = s.recus.filter((x) => x.type === 'equipable').pop();
    ok(rep && rep.error, 'le serveur refuse, et il dit pourquoi : ' + (rep && rep.error));
    eq(moteur._p(A).persos.andy.ea, A2, 'et elle reste portee');
  }

  // ================== 7 bis. CHANGER D'ARME CHANGE CE QUE LE SERVEUR TIRE
  //
  // La fiche n'etait lue qu'a l'ENTREE. On pouvait donc s'equiper d'une epee
  // trouvee en plein combat : la page se mettait a dessiner ses projectiles,
  // et le serveur continuait de tirer avec l'ancienne. On voyait LES DEUX.
  {
    const arc = B.ITEMS.concat(B.ITEMS_DROP).find((o) => o.famille === 'arc');
    ok(!!arc, 'le catalogue porte un arc, dont la gerbe ne ressemble a rien d autre');
    p.sac = {}; p.objets = {};
    p.objets[A1] = 1; moteur._p(A).persos.andy.ea = A1;
    p.sac[arc.id] = 1;
    /* On se rhabille par le chemin normal : entrer, puis echanger. */
    s.send(JSON.stringify({ type: 'realmJoin' }));
    await attend(s, 'realmEntre');
    await new Promise((r) => setTimeout(r, 300));
    const avant = j0();
    ok(!!avant, 'on est dans le monde');
    eq(avant.famille, 'lame', 'et on y porte une lame');
    const pv0 = avant.pv = Math.round(avant.pvMax / 2);   // a moitie blesse

    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: arc.id }));
    await new Promise((r) => setTimeout(r, 400));
    const apres = j0();
    eq(apres.famille, 'arc', 'le serveur tire maintenant a l ARC');
    eq(JSON.stringify(apres.degats), JSON.stringify(B.rarete(arc.rarete) ? apres.degats : null),
       'avec les degats de la piece portee');
    ok(apres.degats && apres.degats[0] > 0, `et ils ne sont pas nuls (${apres.degats})`);

    /* ---- ET ON NE SE SOIGNE PAS EN CHANGEANT D'ARMURE ----
     * Monter le maximum ne remplit pas la jauge. Sans cette regle, enfiler et
     * retirer une armure a repetition serait une fontaine gratuite au milieu
     * de la lave. */
    /* La regeneration continue de tourner pendant qu'on change d'arme — c'est
       normal, et quelques points en plus ne sont pas un soin. Ce qu'on refuse,
       c'est le REMPLISSAGE : la jauge ne doit pas revenir au maximum parce
       qu'on a enfile une armure. */
    ok(apres.pv < apres.pvMax * 0.75,
       `les points de vie ne se sont pas remplis (${apres.pv} sur ${apres.pvMax})`);
    ok(apres.pv - pv0 < 20,
       `ils n ont bouge que de ce que la regeneration donne (${apres.pv - pv0})`);
    ok(apres.pv <= apres.pvMax, 'et ils tiennent sous le maximum');

    /* Le reste de son etat non plus : changer d'arme n'annule pas une
       paralysie et ne remet pas le pouvoir a zero. */
    apres.paralyse = 2; apres.pouvoirRecharge = 3;
    s.send(JSON.stringify({ type: 'equipeArme', skin: 'andy', item: null }));
    await new Promise((r) => setTimeout(r, 300));
    const nu = j0();
    eq(nu.famille, 'poing', 'retirer son arme fait revenir au poing');
    ok(nu.paralyse > 0, 'et la paralysie en cours n est pas effacee');
    ok(nu.pouvoirRecharge > 0, 'ni la recharge du pouvoir');
    nu.paralyse = 0; nu.pouvoirRecharge = 0;
  }

  // ================== 7 ter. CENT ECHANGES DE SUITE, ET RIEN NE SE PERD
  //
  // « J'ai ramasse une arme, je l'ai echangee avec une autre, aucun souci.
  //   J'ai repete ca plusieurs fois : une de mes armes a disparu. »
  //
  // Un echange isole se verifie a l'oeil. Une SEQUENCE, non : il faut la
  // jouer. On ramasse, on echange, on recommence — et a chaque tour on
  // recompte TOUT ce que le compte possede, ou que ce soit : coffre, sac, et
  // ce que portent les six personnages. Le total ne doit jamais bouger.
  {
    p.sac = {}; p.objets = {};
    const armes = B.ITEMS.concat(B.ITEMS_DROP).filter((o) => o.saison === 2).slice(0, 6);
    ok(armes.length >= 4, `on a de quoi tourner (${armes.length} armes)`);
    /* Trois exemplaires au sol, un porte : la situation du joueur. */
    p.objets[armes[0].id] = 1;
    moteur._p(A).persos.andy.ea = armes[0].id;
    const total = () => {
      const q = moteur._p(A);
      const c = {};
      for (const k of Object.keys(q.objets || {})) c[k] = (c[k] || 0) + q.objets[k];
      for (const k of Object.keys(q.sac || {})) c[k] = (c[k] || 0) + q.sac[k];
      return c;
    };
    const somme = (t) => Object.keys(t).reduce((x, k) => x + t[k], 0);
    /* On en ramasse deux de plus par le chemin du monde : `prendDuSol`, celui
       qu'emprunte un vrai butin. */
    moteur.prendDuSol(A, armes[1].id);
    moteur.prendDuSol(A, armes[2].id);
    const t0 = total();
    eq(somme(t0), 3, 'trois pieces en tout : une portee, deux dans le sac');

    let perdues = 0, tours = 0, refus = 0;
    for (let i = 0; i < 100; i++) {
      const q = moteur._p(A);
      const dedans = Object.keys(q.sac || {}).filter((k) => q.sac[k] > 0).map(Number);
      if (!dedans.length) break;
      /* On prend celle du milieu, puis la premiere, puis la derniere : varier
         evite de ne jouer qu'un seul chemin cent fois. */
      const choisie = dedans[i % dedans.length];
      try { moteur.equipeDuSac(A, 'andy', choisie); tours++; }
      catch (e) { refus++; }
      const t = total();
      if (somme(t) !== somme(t0)) { perdues++; break; }
    }
    console.log('   ' + tours + ' echanges joues, ' + refus + ' refus');
    eq(perdues, 0, `cent echanges de suite et le compte tient (${tours} joues)`);
    ok(tours >= 50, `on en a vraiment joue beaucoup (${tours})`);
    const tf = total();
    eq(somme(tf), somme(t0), `le total est le meme qu'au depart (${somme(tf)})`);
    eq(JSON.stringify(tf), JSON.stringify(t0),
       'et piece par piece, pas seulement en nombre');
    /* Et le personnage porte toujours quelque chose : un echange qui laisserait
       la main vide serait une perte deguisee en choix. */
    ok(moteur._p(A).persos.andy.ea, 'il porte encore une arme a la fin');

    /* ---- L'ETAT IMPOSSIBLE NE DETRUIT RIEN ----
     * Une piece portee qui n'est pas au coffre ne devrait pas exister. Si elle
     * existe quand meme — un vieil etat, un bug ailleurs —, l'echange ne doit
     * pas la faire disparaitre en levant une exception APRES avoir equipe la
     * nouvelle. */
    p.sac = {}; p.objets = {};
    p.sac[armes[1].id] = 1;
    moteur._p(A).persos.andy.ea = armes[0].id;   // portee, mais PAS au coffre
    const avant = somme(total());
    let boum = null;
    try { moteur.equipeDuSac(A, 'andy', armes[1].id); } catch (e) { boum = e.message; }
    eq(boum, null, 'l echange passe quand meme' + (boum ? ' (' + boum + ')' : ''));
    eq(moteur._p(A).persos.andy.ea, armes[1].id, 'et la nouvelle est portee');
    eq(somme(total()), avant, 'sans rien creer ni rien detruire');
  }

  // ================== 8. CENT GESTES AU HASARD, ET LE COMPTE TIENT
  //
  // Les essais ci-dessus disent chacun UN chemin. Celui-la les melange : c'est
  // dans l'enchainement que les deux ecritures d'un echange se marchent
  // dessus.
  {
    p.sac = {}; p.objets = {};
    const pieces = ARME.slice(0, 6).map((o) => o.id);
    pieces.forEach((id, k) => { if (k < 3) p.sac[id] = 1; else p.objets[id] = 1; });
    moteur._p(A).persos.andy.ea = null;
    monde.sacs.length = 0;
    const depart = inventaire();
    eq(total(depart), 6, 'on part avec six pieces');

    let graine = 12345;
    const alea = () => { graine = (graine * 1664525 + 1013904223) >>> 0; return graine / 4294967296; };
    for (let tour = 0; tour < 100; tour++) {
      const id = pieces[Math.floor(alea() * pieces.length)];
      const quoi = Math.floor(alea() * 6);
      if (quoi === 0) s.send(JSON.stringify({ type: 'realmDepose', item: id }));
      else if (quoi === 1) {
        const sac = monde.sacs[0];
        if (sac) s.send(JSON.stringify({ type: 'realmRamasse', i: sac.id, place: Math.floor(alea() * sac.contenu.length) }));
      } else if (quoi === 2) s.send(JSON.stringify({ type: 'rangeCoffre', item: id }));
      else if (quoi === 3) s.send(JSON.stringify({ type: 'sortCoffre', item: id }));
      else if (quoi === 4) s.send(JSON.stringify({ type: 'equipeArme', skin: 'andy', item: alea() < 0.3 ? null : id }));
      else s.send(JSON.stringify({ type: 'equipeDuSac', skin: 'andy', item: id }));
      if (tour % 10 === 9) await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 800));
    const fin = inventaire();
    const perdu = memeChose(depart, fin);
    ok(perdu === null,
       `cent gestes melanges : le compte tient (${total(depart)} -> ${total(fin)}` +
       (perdu ? `, l objet ${perdu} passe de ${depart[perdu] || 0} a ${fin[perdu] || 0}` : '') + ')');
  }

  s.close();
  console.log('echange.test.js : ' + n + ' verifications OK');
  process.exit(0);
})();
