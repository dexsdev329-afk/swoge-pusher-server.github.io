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

  // ================== 7. ON NE SORT PAS DU COFFRE CE QU'ON PORTE
  {
    await geste('sortir du coffre une piece portee', async () => {
      s.recus.length = 0;
      s.send(JSON.stringify({ type: 'sortCoffre', item: A2 }));
    });
    const rep = s.recus.filter((x) => x.type === 'equipable').pop();
    ok(rep && rep.error, 'le serveur refuse, et il dit pourquoi : ' + (rep && rep.error));
    eq(moteur._p(A).persos.andy.ea, A2, 'et elle reste portee');
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
      const quoi = Math.floor(alea() * 5);
      if (quoi === 0) s.send(JSON.stringify({ type: 'realmDepose', item: id }));
      else if (quoi === 1) {
        const sac = monde.sacs[0];
        if (sac) s.send(JSON.stringify({ type: 'realmRamasse', i: sac.id, place: Math.floor(alea() * sac.contenu.length) }));
      } else if (quoi === 2) s.send(JSON.stringify({ type: 'rangeCoffre', item: id }));
      else if (quoi === 3) s.send(JSON.stringify({ type: 'sortCoffre', item: id }));
      else s.send(JSON.stringify({ type: 'equipeArme', skin: 'andy', item: alea() < 0.3 ? null : id }));
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
