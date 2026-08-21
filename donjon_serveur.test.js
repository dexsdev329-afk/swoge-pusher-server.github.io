'use strict';
/*
 * LE DONJON BRANCHE SUR LE SERVEUR — le circuit complet, par la socket.
 *
 * `donjon.test.js` verifie la SIMULATION : la forme des salles, l'isolation,
 * ce qui tombe. Ce fichier verifie ce que server.js en fait, et c'est un autre
 * metier — les instances, qui partage laquelle, et quand elles meurent.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. ON N'ENTRE QUE SI L'ON EST DESSUS. Le client dit « j'entre » et rien
 *    d'autre : s'il pouvait nommer la porte, nommer un identifiant suffirait a
 *    entrer depuis l'autre bout de la carte, et un donjon est exactement ce
 *    qu'on aurait interet a atteindre sans le meriter.
 * 2. UNE PORTE, UN DONJON. Deux joueurs qui franchissent la meme porte
 *    arrivent au meme endroit — c'est ce qui permet de s'y donner rendez-vous.
 *    Une instance par joueur aurait rendu le donjon solitaire sans que rien ne
 *    l'annonce.
 * 3. ON RESSORT LA OU L'ON EST ENTRE, meme si la porte s'est refermee
 *    entre-temps. Un donjon dont la sortie depend d'un compte a rebours
 *    exterieur est un piege.
 * 4. UN DONJON VIDE MEURT. Sinon vingt-quatre portes franchies une fois
 *    laissent vingt-quatre simulations a faire tourner pour personne.
 * 5. LE MONDE OUVERT NE S'ARRETE PAS PENDANT CE TEMPS-LA.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/dsrv-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';

/* Le canal est remplace par un carnet : on ne veut pas envoyer de messages,
   on veut savoir CE QU'ON AURAIT ENVOYE. Une annonce qui part deux fois, ou
   qui ne part pas, ne se voit d'aucune autre facon. */
const ANNONCES = [];
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(t){ ANNONCES.push({ image: null, texte: String(t) }); },
  notifyPhoto(i, t){ ANNONCES.push({ image: i || null, texte: String(t) }); },
  sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const { Game } = require('./game');
  let moteur = null; const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  /* ---- ON ATTRAPE LES SIMULATIONS ----
   * `plan` est ce qui distingue un donjon d'un monde ouvert. Les compter par ce
   * biais nous evite d'exporter la table des donjons juste pour l'essai — et
   * une table exportee pour un essai finit par etre modifiee par du code de
   * production « puisqu'elle est la ». */
  const { Realm } = require('./realm');
  /* ---- IL Y A PLUSIEURS MONDES OUVERTS ----
   * Cet essai attrapait « la » simulation sans plan : il n'y en avait qu'une.
   * Depuis la deuxieme porte du Nexus il y en a deux, et `monde0` valait celle
   * qui avait battu en dernier — une fois sur deux, celle ou nos joueurs ne
   * sont pas. On les collecte donc toutes, et l'on designe la bonne par LE
   * JOUEUR QU'ELLE CONTIENT, ce qui est de toute facon plus juste que « la
   * seule » : c'est le monde de nos joueurs qui nous interesse, pas le nombre
   * de mondes qui tournent. */
  let monde0 = null;
  const ouverts = new Set();
  const vivants = new Set();
  const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) {
    if (this.plan) vivants.add(this); else ouverts.add(this);
    return pas0.call(this, dt);
  };
  require('./server');
  const M = require('./monde');
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
  const connecte = async (w) => {
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    return s;
  };
  const dort = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Les donjons encore en vie : ceux qui ont au moins un joueur. Une instance
     detruite garde son objet en memoire tant que notre Set le tient — on
     regarde donc ce qui compte, pas ce qui existe. */
  const donjonsVivants = () => [...vivants].filter((r) => r.joueurs.size > 0);

  /* Poser une porte SOUS LES PIEDS d'un joueur, comme si Optimus venait d'y
     tomber. On ne triche pas sur la porte : c'est `_ouvrePortail` du vrai
     serveur qui la fabrique, avec ses vraies regles. */
  const poseLaPorte = (addr) => {
    const j = monde0.joueurs.get(addr);
    const t = M.MONSTRES.optimus;
    const m = { id: monde0._nouvelId(), espece: 'optimus', biome: 'lave',
                x: j.x, y: j.y, ancreX: j.x, ancreY: j.y,
                pv: 0, pvMax: t.pv, dir: 'down', cible: null,
                recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 };
    const p = monde0._ouvrePortail(m, null, null);
    /* Sous les pieds : `_ouvrePortail` la pose derriere la creature, et l'on
       veut pouvoir entrer sans marcher — la marche est l'affaire de
       donjon_page.test.js. */
    p.x = j.x; p.y = j.y;
    return p;
  };

  // ================== 1. ON N'ENTRE PAS DE LOIN
  const wa = ethers.Wallet.createRandom();
  const sa = await connecte(wa);
  const A = wa.address.toLowerCase();
  sa.send(JSON.stringify({ type: 'realmJoin' }));
  await attend(sa, 'realmEntre');
  monde0 = [...ouverts].find((r) => r.joueurs.has(A)) || null;
  ok(!!monde0, 'la simulation du monde ouvert tourne');
  /* Et c'est bien le monde par DEFAUT : on a franchi la porte sans rien
     nommer, on ne doit pas se retrouver dans la carte rouge. */
  ok(ouverts.size >= 1, `les mondes ouverts tournent tous (${ouverts.size})`);

  sa.recus.length = 0;
  sa.send(JSON.stringify({ type: 'realmPorte' }));
  const refus = await attend(sa, 'realmPorteRefus');
  eq(refus.raison, 'pas-de-portail', 'sans porte sous les pieds, on n\'entre nulle part');
  eq(donjonsVivants().length, 0, 'et aucune simulation n\'a ete fabriquee');

  /* MEME AVEC UNE PORTE, MAIS A L'AUTRE BOUT DE LA CARTE. C'est le cas qui
     compte : la porte EXISTE, on la voit dans l'etat, et l'on n'est pas
     dessus. */
  const loin = poseLaPorte(A);
  loin.x = 200; loin.y = 200;
  const j0 = monde0.joueurs.get(A);
  if (Math.hypot(j0.x - 200, j0.y - 200) < M.PORTAIL.rayon) { loin.x = M.MONDE.w - 200; }
  sa.recus.length = 0;
  sa.send(JSON.stringify({ type: 'realmPorte' }));
  const refus2 = await attend(sa, 'realmPorteRefus');
  eq(refus2.raison, 'pas-de-portail', 'une porte a l\'autre bout ne se franchit pas d\'ici');
  eq(donjonsVivants().length, 0, 'toujours aucune simulation');
  monde0.portails.length = 0;

  // ================== 2. DESSUS, ON ENTRE
  const porte = poseLaPorte(A);
  const vieA = monde0.joueurs.get(A).pv - 100;
  monde0.joueurs.get(A).pv = vieA;      // blesse : la vie doit traverser
  sa.recus.length = 0;
  sa.send(JSON.stringify({ type: 'realmPorte' }));
  const dedans = await attend(sa, 'realmEntre');
  eq(dedans.donjon, 'forge', 'le serveur repond par le donjon qu\'elle ouvre');
  ok(dedans.tuiles && dedans.tuiles.length > 300,
     `et le sol part tuile par tuile (${dedans.tuiles ? dedans.tuiles.length : 0})`);
  ok(dedans.obstacles && dedans.obstacles.length > 100, 'les murs avec');
  ok(dedans.sortie && Number.isFinite(dedans.sortie.x), 'et la porte de retour');
  eq(dedans.salles.length, 0, 'un donjon n\'a pas de salles gardees');
  /* LE SOL DU DONJON EST ANNONCE COMME TEL. C'est ce seul anneau qui fait que
     la page pose la pierre et pas la terre. */
  eq(dedans.anneaux.length, 1, 'un seul anneau');
  eq(dedans.anneaux[0].biome, 'donjon', 'et c\'est le donjon');
  ok(Number.isFinite(dedans.anneaux[0].jusqua),
     'dont la borne survit au JSON : `Infinity` en ressortirait `null`');
  eq(dedans.moi.pv, vieA, 'la vie traverse la porte, elle ne se remplit pas');

  await dort(300);
  const D = donjonsVivants();
  eq(D.length, 1, 'une simulation de donjon, et une seule');
  ok(D[0].joueurs.has(A), 'et nous sommes dedans');
  eq(monde0.joueurs.has(A), false, 'et plus dans le monde ouvert');

  /* ---- ON PEUT BOIRE, DEDANS AUSSI ----
   *
   * « Quand je bois une potion de vie dans le dungeon ca ne fonctionne pas. »
   *
   * La route lisait `realm` — LE monde ouvert — au lieu du monde du joueur.
   * Dans un donjon elle ne trouvait donc personne : la potion etait retiree de
   * la pile et ne soignait rien. Bue dans l'endroit le plus dur du jeu, au
   * moment ou elle compte le plus.
   *
   * L'essai le verifie DANS le donjon et pas au bord : c'est la difference
   * entre « la route marche » et « la route marche la ou on s'en sert ». */
  {
    const D0 = donjonsVivants()[0];
    const moi = D0.joueurs.get(A);
    const avantPv = moi.pvMax - 300;
    moi.pv = avantPv;
    moteur._p(A).potions = { vie: 3 };
    sa.recus.length = 0;
    sa.send(JSON.stringify({ type: 'potionBoit', cle: 'vie' }));
    const bue = await attend(sa, 'potionBue');
    ok(bue.pv !== null && bue.pv !== undefined,
       `le serveur repond avec la vie du COMBAT (${bue.pv})`);
    ok(bue.pv > avantPv, `elle a monte (${avantPv} -> ${bue.pv})`);
    eq(D0.joueurs.get(A).pv, bue.pv,
       'et c\'est bien le joueur DU DONJON qui a ete soigne');
    /* Et la potion a bien ete payee : soigner sans debiter serait l'autre
       moitie du meme defaut. */
    eq(moteur._p(A).potions.vie, 2, 'une potion en moins dans la pile');
  }

  /* ON NE S'ENFONCE PAS D'UN DONJON DANS UN AUTRE. */
  sa.recus.length = 0;
  sa.send(JSON.stringify({ type: 'realmPorte' }));
  const refus3 = await attend(sa, 'realmPorteRefus');
  eq(refus3.raison, 'deja-dedans', 'on n\'entre pas dans un donjon depuis un donjon');
  eq(donjonsVivants().length, 1, 'et il n\'y en a toujours qu\'un');

  /* L'ETAT QU'ON RECOIT EST CELUI DU DONJON. Sans ce basculement, on serait
     dedans en voyant le monde du dehors — et l'on tirerait sur des creatures
     qui ne sont pas la. */
  sa.recus.length = 0;
  const etatD = await attend(sa, 'realmEtat');
  ok(Array.isArray(etatD.portails), 'l\'etat porte les portes');
  ok(etatD.portails.some((q) => q.rt === 1), 'dont celle du sas');

  // ================== 2 bis. TOUT LE MONDE APPREND QU'ELLE S'EST OUVERTE
  //
  // C'est ce qui rend le donjon TROUVABLE. Optimus vit dans la lave avec un
  // poids de 0,12 : sans annonce, on pouvait jouer cent heures sans jamais
  // voir une porte s'ouvrir, et trois salles, un boss et huit reliques
  // seraient restes derriere une porte que presque personne ne verrait.
  {
    /* Un temoin, DANS LE MONDE OUVERT et loin de la porte. */
    const wt = ethers.Wallet.createRandom();
    const st = await connecte(wt);
    const T = wt.address.toLowerCase();
    /* Une VRAIE lame du catalogue, equipee par la vraie route : le poing porte
       a cent cinquante, et Optimus pose assez pres pour qu'un poing l'atteigne
       est Optimus assez pres pour tuer le temoin avant le premier
       projectile. */
    const pt = moteur._p(wt.address);
    pt.skins = { andy: true }; pt.skinActif = 'andy';
    const lame = B.ITEMS.concat(B.ITEMS_DROP)
      .find((o) => o.famille === 'lame' && o.rarete === 'mythique');
    pt.objets[lame.id] = (pt.objets[lame.id] || 0) + 1;
    moteur.equipeArme(wt.address, 'andy', lame.id);
    st.send(JSON.stringify({ type: 'realmJoin' }));
    await attend(st, 'realmEntre');
    /* Et un autre, DANS le donjon : lui ne doit rien recevoir. Une porte qu'on
       ne peut pas atteindre depuis l'endroit ou l'on est n'est pas une
       nouvelle, c'est une distraction pendant un combat. */
    const wd = ethers.Wallet.createRandom();
    const sd = await connecte(wd);
    const Dd = wd.address.toLowerCase();
    sd.send(JSON.stringify({ type: 'realmJoin' }));
    await attend(sd, 'realmEntre');
    poseLaPorte(Dd);
    sd.send(JSON.stringify({ type: 'realmPorte' }));
    await attend(sd, 'realmEntre');
    await dort(200);

    const avant = ANNONCES.length;
    st.recus.length = 0; sd.recus.length = 0;
    /* ---- ON L'ABAT PAR LE VRAI CHEMIN ----
     * Appeler `_abat` a la main passerait a cote de tout ce qu'on veut
     * mesurer : c'est la boucle de jeu qui distribue les evenements, et un
     * evenement fabrique dans l'essai n'y entre jamais. On tire donc vraiment,
     * et c'est le serveur qui constate la mort — la meme difference qu'entre
     * un jeu ou l'on peut se donner des niveaux et un jeu ou l'on ne peut
     * pas. */
    const j = monde0.joueurs.get(T);
    const t = M.MONSTRES.optimus;
    const mm = { id: monde0._nouvelId(), espece: 'optimus', biome: 'lave',
                 x: j.x + 280, y: j.y, ancreX: j.x + 280, ancreY: j.y,
                 pv: 1, pvMax: t.pv, dir: 'down', cible: null,
                 recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 };
    monde0.monstres.push(mm);
    /* On compte les portes AVANT : il en traine deja du bloc precedent, et
       « la liste n'est pas vide » aurait ete vrai des le premier tour — la
       boucle de tir n'aurait jamais tourne, et l'essai aurait mesure le
       silence en croyant mesurer une porte. */
    const nAvant = monde0.portails.length;
    for (let tour = 0; tour < 30 && monde0.portails.length === nAvant; tour++) {
      st.send(JSON.stringify({ type: 'realmTir', a: 0,
                               x: Math.round(j.x), y: Math.round(j.y) }));
      await dort(120);
    }
    await dort(400);
    ok(monde0.portails.length > nAvant, 'la porte s\'est ouverte pour de vrai');

    const vu = await attend(st, 'realmPortailOuvert', 3000);
    eq(vu.donjon, 'forge', 'le monde entier apprend qu\'une porte s\'est ouverte');
    ok(Number.isFinite(vu.x) && Number.isFinite(vu.y),
       'avec sa position, pour qu\'on puisse y aller');
    ok(vu.duree > 0, 'et le temps qu\'il reste pour y arriver');
    eq(sd.recus.filter((x) => x.type === 'realmPortailOuvert').length, 0,
       'celui qui est deja dans un donjon n\'en entend pas parler');

    /* CELUI QUI L'A OUVERTE EST MARQUE. Il a deja son propre message — le sien
       dit « derriere toi », celui-la dit « les autres arrivent » — et la page
       ne doit pas lui afficher les deux de la meme facon. */
    const sien = st.recus.filter((x) => x.type === 'realmPortailOuvert').pop();
    eq(sien.mien, true, 'celui qui l\'a ouverte le sait');

    /* ET LE CANAL EST PREVENU, UNE FOIS. */
    const neuves = ANNONCES.slice(avant).filter((a) => /PORTAL/i.test(a.texte));
    eq(neuves.length, 1, 'le canal est prevenu, une seule fois');
    ok(/FORGE/i.test(neuves[0].texte), 'et il dit de quel donjon il s\'agit');
    ok(/portail_forge\.jpg\?/.test(String(neuves[0].image || '')),
       `avec l'image de la porte (${neuves[0].image})`);
    /* ET SON NUMERO DE TIRAGE. Telegram garde les photos par URL : une adresse
       nue fait resservir la copie qu'il a, et un dessin remplace n'apparait
       jamais dans le canal. C'est arrive avec les armures de la saison 3. */
    ok(/[?&]v=\d+/.test(String(neuves[0].image || '')),
       'et le numero de tirage, sans quoi Telegram resservirait son cache');
    /* PAS DE COORDONNEES DANS LE CANAL. Une position lisible par n'importe qui
       ferait de l'annonce une carte au tresor pour quelqu'un qui n'a jamais mis
       les pieds dans le monde. Ceux qui jouent ont deja la fleche a l'ecran. */
    eq(/\b\d{3,}\s*,\s*\d{3,}\b/.test(neuves[0].texte), false,
       'et il ne donne pas la position');

    /* UNE PORTE DE RETOUR N'EST PAS UNE NOUVELLE. Elle ne mene nulle part :
       l'annoncer enverrait tout le monde courir vers une porte qui ramene la
       ou ils sont deja. */
    const avant2 = ANNONCES.length;
    st.recus.length = 0;
    const nAvant2 = monde0.portails.length;
    const mb = { id: monde0._nouvelId(), espece: 'fonderie', biome: 'donjon',
                 x: j.x + 280, y: j.y, ancreX: j.x + 280, ancreY: j.y,
                 pv: 1, pvMax: M.MONSTRES.fonderie.pv, dir: 'down', cible: null,
                 recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 };
    monde0.monstres.push(mb);
    for (let tour = 0; tour < 30 && monde0.portails.length === nAvant2; tour++) {
      st.send(JSON.stringify({ type: 'realmTir', a: 0,
                               x: Math.round(j.x), y: Math.round(j.y) }));
      await dort(120);
    }
    await dort(400);
    ok(monde0.portails.some((q) => q.retour), 'la porte de retour est bien tombee');
    eq(ANNONCES.slice(avant2).filter((a) => /PORTAL/i.test(a.texte)).length, 0,
       'une porte de retour n\'est annoncee nulle part');

    sd.send(JSON.stringify({ type: 'realmLeave' }));
    st.close(); sd.close();
    await dort(300);
    /* On ne retire QUE ce que ce bloc a pose. Vider la liste entiere
       emporterait la porte du bloc precedent — celle par laquelle le premier
       joueur est entre — et la suite se plaindrait de ne pas trouver de
       donjon, tres loin d'ici, sans qu'on voie le rapport. */
    monde0.portails = monde0.portails.filter((q) => q.id === porte.id);
  }

  // ================== 3. UNE PORTE, UN DONJON
  const wb = ethers.Wallet.createRandom();
  const sb = await connecte(wb);
  const Bd = wb.address.toLowerCase();
  sb.send(JSON.stringify({ type: 'realmJoin' }));
  await attend(sb, 'realmEntre');
  /* On le pose SUR la meme porte : c'est ce que fait un ami qui accourt. */
  const jb = monde0.joueurs.get(Bd);
  jb.x = porte.x; jb.y = porte.y;
  sb.recus.length = 0;
  sb.send(JSON.stringify({ type: 'realmPorte' }));
  const dedansB = await attend(sb, 'realmEntre');
  eq(dedansB.donjon, 'forge', 'le deuxieme entre aussi');
  await dort(300);
  eq(donjonsVivants().length, 1, 'et il n\'y a toujours qu\'UNE simulation');
  ok(donjonsVivants()[0].joueurs.has(A) && donjonsVivants()[0].joueurs.has(Bd),
     'les deux sont dans la meme');
  eq(dedansB.moi.x, dedans.moi.x, 'et ils sont arrives au meme endroit');

  /* ET ILS SE VOIENT. Deux joueurs dans le meme donjon qui ne se verraient pas
     auraient chacun la preuve que l'autre a menti. */
  sa.recus.length = 0;
  const vueA = await attend(sa, 'realmEtat');
  ok(vueA.joueurs.some((q) => String(q.a).toLowerCase() === Bd),
     'le premier voit le second');

  // ================== 4. UNE AUTRE PORTE, UN AUTRE DONJON
  const wc = ethers.Wallet.createRandom();
  const sc = await connecte(wc);
  const C = wc.address.toLowerCase();
  sc.send(JSON.stringify({ type: 'realmJoin' }));
  await attend(sc, 'realmEntre');
  const porte2 = poseLaPorte(C);
  ok(porte2.id !== porte.id, 'la deuxieme porte a son propre identifiant');
  sc.recus.length = 0;
  sc.send(JSON.stringify({ type: 'realmPorte' }));
  await attend(sc, 'realmEntre');
  await dort(300);
  eq(donjonsVivants().length, 2, 'deux portes, deux donjons');
  const dc = donjonsVivants().find((r) => r.joueurs.has(C));
  ok(dc && !dc.joueurs.has(A), 'et le troisieme n\'est pas avec les deux premiers');

  /* LES DEUX DONJONS VIVENT AUX MEMES COORDONNEES ET NE SE VOIENT PAS. C'est
     toute la raison d'avoir choisi deux simulations plutot qu'un etage. */
  const da = donjonsVivants().find((r) => r.joueurs.has(A));
  eq(Math.round(da.joueurs.get(A).x), Math.round(dc.joueurs.get(C).x),
     'ils sont a la meme place');
  sc.recus.length = 0;
  const vueC = await attend(sc, 'realmEtat');
  eq(vueC.joueurs.length, 0, 'et pourtant le troisieme est seul');

  // ================== 5. ON RESSORT LA OU L'ON EST ENTRE
  /* ---- MEME SI LA PORTE S'EST REFERMEE ----
   * Le compte a rebours de la porte court pendant qu'on est dedans. Si la
   * sortie dependait d'elle, prendre son temps enfermerait — et sur un jeu ou
   * la mort detruit un equipement paye en argent reel, un donjon dont on ne
   * ressort pas est un vol. On l'efface donc avant de demander a sortir. */
  monde0.portails.length = 0;
  sa.recus.length = 0;
  sa.send(JSON.stringify({ type: 'realmSort' }));
  const sorti = await attend(sa, 'realmEntre');
  eq(sorti.donjon, null, 'on est rendu au monde ouvert');
  eq(sorti.tuiles, null, 'sans plus aucune tuile de donjon');
  eq(sorti.moi.x, Math.round(porte.x), 'et LA OU la porte s\'etait ouverte');
  eq(sorti.moi.y, Math.round(porte.y), 'exactement');
  await dort(300);
  ok(monde0.joueurs.has(A), 'le monde ouvert l\'a repris');

  /* LE DONJON RESTE POUR CELUI QUI Y EST ENCORE. */
  eq(donjonsVivants().length, 2, 'le donjon des deux autres tourne toujours');
  ok(donjonsVivants().some((r) => r.joueurs.has(Bd)), 'le deuxieme y est reste');

  /* ET ON NE SORT PAS D'UN DONJON QUAND ON N'Y EST PAS. */
  sa.recus.length = 0;
  sa.send(JSON.stringify({ type: 'realmSort' }));
  const refus4 = await attend(sa, 'realmPorteRefus');
  eq(refus4.raison, 'pas-dedans', 'et l\'on ne sort pas de ce dans quoi on n\'est pas');

  // ================== 6. UN DONJON VIDE MEURT
  sb.send(JSON.stringify({ type: 'realmSort' }));
  await attend(sb, 'realmEntre');
  await dort(400);
  eq(donjonsVivants().length, 1, 'le donjon vide s\'est efface');
  ok(donjonsVivants()[0].joueurs.has(C), 'celui du troisieme, lui, tourne encore');

  /* PARTIR DU JEU VIDE LE DONJON AUSSI. Une socket qui se ferme au fond d'une
     salle laisserait sinon une simulation vivante pour personne. */
  sc.send(JSON.stringify({ type: 'realmLeave' }));
  await attend(sc, 'realmSorti');
  await dort(400);
  eq(donjonsVivants().length, 0, 'plus un seul donjon en vie');

  // ================== 7. LE MONDE OUVERT N'A PAS BOUGE
  /* Cinq entrees, trois sorties, deux simulations detruites — et le monde,
     lui, continue. C'est la verification qui manque toujours : on repare la
     nouveaute et l'on casse l'ancien sans s'en apercevoir. */
  ok(monde0.monstres.length > 100,
     `le monde ouvert a toujours sa population (${monde0.monstres.length})`);
  sa.recus.length = 0;
  const vueFin = await attend(sa, 'realmEtat');
  ok(Array.isArray(vueFin.monstres), 'et il envoie toujours son etat');
  ok(vueFin.moi.pv > 0, 'et le joueur y est vivant');

  /* LES PIECES DU DONJON N'ONT PAS FUITE DANS LE MONDE PENDANT CE TEMPS. */
  const emis = moteur.boutiqueEmis || {};
  const fuite = B.ITEMS_DROP.filter((o) => o.donjon && emis[o.id] > 0);
  eq(fuite.length, 0, 'aucune piece de la Forge n\'est sortie du registre');

  sa.close(); sb.close(); sc.close();
  console.log(`donjon_serveur.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
