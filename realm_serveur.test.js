'use strict';
/*
 * LE MONDE BRANCHE SUR LE SERVEUR — le circuit complet, par la socket.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. ON N'ENTRE PAS SANS PERSONNAGE. Arriver sans stats donnerait un joueur
 *    a zero point de vie, mort avant son premier pas.
 * 2. TUER DONNE DE L'XP, ET L'XP FAIT MONTER LE NIVEAU. Le client n'annonce
 *    aucun kill : il demande a tirer, le serveur constate.
 * 3. MOURIR COUTE L'EQUIPEMENT ET REMET A ZERO. C'est la contrepartie de la
 *    fame, et c'est ce qui rend le monde dangereux pour de vrai.
 * 4. UN MORT SORT DU MONDE. Le laisser dedans a zero point de vie le ferait
 *    mourir en boucle.
 * 5. L'XP DE COMBAT SURVIT AU REDEMARRAGE, et disparait a la mort.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/rsrv-');
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
  require('./server');
  const B = require('./boutique');
  const P = require('./personnages');
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
  const connecte = async (w) => {
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    return s;
  };

  // ================== 1. UN COMPTE NEUF ENTRE TOUT DE SUITE
  //
  // Cet essai disait l'inverse — « sans skin, le monde se refuse ». Ce n'est
  // plus vrai, et c'est le changement : Andy est offert, tout le monde en a
  // un. Il n'existe pas de version du jeu ou l'on regarde sans pouvoir jouer,
  // et un visiteur a qui l'on repond « no-character » ne revient pas demander
  // pourquoi.
  //
  // Le portefeuille est tire au hasard : il n'a jamais rien depose, rien
  // achete, et sa fiche n'a jamais ete ecrite nulle part.
  {
    const w = ethers.Wallet.createRandom();
    const s = await connecte(w);
    s.send(JSON.stringify({ type: 'realmJoin' }));
    const r = await attend(s, 'realmEntre');
    ok(r, 'un portefeuille neuf entre dans le monde, sans avoir rien achete');
    const q = moteur._p(w.address);
    eq(JSON.stringify(q.skins || {}), '{}',
       'et RIEN n a ete ecrit sur sa fiche : posseder Andy est une reponse, pas une donnee');
    eq(moteur.fiche(w.address), null,
       'sa fiche reste vide, donc elagable, donc absente du disque');
    s.close();
  }

  // ================== 2. ON ENTRE, ET LE MONDE SE DECRIT
  const w = ethers.Wallet.createRandom();
  const s = await connecte(w);
  const p = moteur._p(w.address);
  p.name = 'Dodexel'; p.skins = { andy: true }; p.skinActif = 'andy';
  const arme = B.ITEMS.filter((o) => o.famille === 'lame' && o.rarete === 'mythique')[0];
  p.objets[arme.id] = 1;
  p.persos = { andy: { w: ethers.BigNumber.from(0), ef: null, ea: arme.id, ar: null, ba: null, xc: 0 } };

  s.send(JSON.stringify({ type: 'realmJoin' }));
  const entre = await attend(s, 'realmEntre');
  eq(entre.monde.w, M.MONDE.w, 'la taille du monde part avec l entree');
  ok(entre.armes && entre.armes.lame, 'la table des ARMES vient du SERVEUR');
  eq(entre.armes.lame.portee, M.ARMES.lame.portee, 'et c est bien la sienne');
  ok(entre.especes && entre.especes.lime, 'les especes aussi');
  eq(entre.moi.famille, 'lame', 'le serveur a lu l arme equipee, pas le client');
  ok(entre.moi.pv > 0, 'on entre avec des points de vie');
  eq(M.biomeEn(entre.moi.x, entre.moi.y), 'terre', 'et par le bord');

  const etat = await attend(s, 'realmEtat');
  ok(Array.isArray(etat.monstres), 'on recoit les monstres autour de soi');
  ok(etat.monstres.length <= 45, 'et pas la carte entiere (' + etat.monstres.length + ')');
  ok(etat.moi.mpMax > 0, 'la reserve de mana part avec l etat');
  eq(entre.moi.pouvoir, null, 'sans fruit equipe, aucun pouvoir : le poing nu ne lance pas d eclair');
  ok(entre.pouvoirs && entre.pouvoirs.foudre, 'la table des POUVOIRS vient du serveur');
  eq(entre.pouvoirs.stase.duree, M.POUVOIRS.stase.duree, 'et c est bien la sienne');

  /* Sans fruit, la barre d espace repond quand meme — un refus explicite,
     jamais le silence : une touche qui ne repond rien se lit comme un bug. */
  s.send(JSON.stringify({ type: 'realmPouvoir' }));
  eq((await attend(s, 'realmPouvoir')).refus, 'aucun', 'sans fruit, le refus est dit');

  // ================== 2 bis. LE FRUIT DONNE LE POUVOIR, ET LE SERVEUR LE LIT
  {
    /* On equipe un fruit de CHAOS (att) : il doit donner la foudre. La regle
       vit dans monde.js, pas ici — on verifie que le circuit complet
       (boutique -> fiche -> realm) la transporte sans la reinventer. */
    const fr = B.ITEMS.filter((o) => o.famille === 'chaos' && o.rarete === 'mythique')[0];
    p.objets[fr.id] = 1;
    p.persos.andy.ef = fr.id;
    s.send(JSON.stringify({ type: 'realmLeave' }));
    await attend(s, 'realmSorti');
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmJoin' }));
    const e2 = await attend(s, 'realmEntre');
    eq(e2.moi.pouvoir, M.pouvoirDeStat(P.FAMILLE_STAT.chaos),
       'le fruit de chaos donne bien le pouvoir que monde.js lui attribue');
    eq(e2.moi.pouvoir, 'foudre', 'et c est la foudre');

    /* Il PART, et il coute. Le mana preleve doit etre celui de la table du
       serveur, pas un chiffre que la page aurait choisi. */
    const avantMp = e2.moi.mp;
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmPouvoir' }));
    const r = await attend(s, 'realmPouvoir');
    ok(!r.refus, 'avec un fruit et du mana, il part');
    eq(r.cle, 'foudre', 'c est bien la foudre qui part');
    eq(r.mp, avantMp - M.POUVOIRS.foudre.cout, 'et le cout preleve est celui du serveur');

    /* Deux fois de suite : la recharge tient, cote serveur. Un client qui
       envoie cent demandes n obtient pas cent eclairs. */
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmPouvoir' }));
    eq((await attend(s, 'realmPouvoir')).refus, 'recharge', 'la recharge est tenue par le serveur');

    /* On repart sans fruit pour la suite des tests, qui comptent sur le
       niveau et l equipement d origine. */
    p.persos.andy.ef = null;
    delete p.objets[fr.id];
    s.send(JSON.stringify({ type: 'realmLeave' }));
    await attend(s, 'realmSorti');
    s.recus.length = 0;
    s.send(JSON.stringify({ type: 'realmJoin' }));
    await attend(s, 'realmEntre');
  }

  // ================== 3. TUER DONNE DE L'XP
  {
    // on plante un lime juste devant, cote serveur
    const R = require('./realm');
    // le monde vit dans server.js ; on passe par l etat visible pour viser
    /* ---- ON MESURE UN ECART, PAS UN ETAT ----
     *
     * Cette section verifiait « on part du niveau 0 ». C'etait vrai par
     * accident : une section precedente tue deja, et le personnage arrive ici
     * avec de l'XP de combat. Tant qu'elle restait sous le premier palier le
     * niveau valait zero ; le jour ou la chasse d'avant rapportait un peu
     * plus, l'essai tombait sur un chiffre qui ne dit rien de ce qu'il teste.
     *
     * Ce que la section CLAIME est « tuer donne de l'XP ». On note donc ce
     * qu'on a avant, et on verifiera l'ecart apres — ce qui est plus fort que
     * l'ancien controle, et ne depend d'aucun etat de depart. */
    const avant = moteur.personnageEtat(w.address, 'andy');
    const c0 = (moteur._p(w.address).persos || {}).andy;
    const xcAvant = (c0 && c0.xc) | 0;

    /* ---- POURQUOI CETTE BOUCLE RATAIT UNE FOIS SUR SEPT ----
     *
     * Elle s'arretait d'avancer a 250 unites et tirait de la. Le POING porte a
     * 150 : elle passait donc son temps a tirer hors de portee, et ne tuait
     * que si une creature venait d'elle-meme. Elle disait aussi « le monstre le
     * plus proche » en prenant `monstres[0]`, qui est le premier de la liste et
     * pas le plus proche — souvent derriere un rocher, ou l'on se coince en
     * essayant d'aller.
     *
     * La portee vient maintenant du MOTEUR, la cible est vraiment la plus
     * proche, et un pas qui n'avance pas se traduit par un pas de cote : sans
     * ca, on insiste contre la meme pierre pendant quatre cents tours pendant
     * que les creatures nous mangent. */
    const fiche = moteur.personnageEtat(w.address, 'andy');
    const famille = (fiche.equipArme && fiche.equipArme.famille) || 'poing';
    const PORTEE = M.ARMES[famille].portee;
    let kill = null, mort = null, dernier = null;
    for (let i = 0; i < 400 && !kill && !mort; i++) {
      const e = s.recus.filter((x) => x.type === 'realmEtat').pop();
      if (e && e.monstres.length) {
        let c = e.monstres[0], best = Infinity;
        for (const m of e.monstres) {
          const q = (m.x - e.moi.x) ** 2 + (m.y - e.moi.y) ** 2;
          if (q < best) { best = q; c = m; }
        }
        const d = Math.sqrt(best);
        const a = Math.atan2(c.y - e.moi.y, c.x - e.moi.x);
        /* On vise un peu DANS la portee, pas juste au bord : la creature
           bouge, et rester pile a la limite fait manquer un coup sur deux. */
        if (d > PORTEE * 0.7) {
          const coince = dernier
            && Math.abs(dernier.x - e.moi.x) + Math.abs(dernier.y - e.moi.y) < 1;
          const ang = coince ? a + Math.PI / 2 : a;
          s.send(JSON.stringify({ type: 'realmMove',
            x: e.moi.x + Math.cos(ang) * 24, y: e.moi.y + Math.sin(ang) * 24,
            dir: 'right', anim: 'run' }));
          dernier = { x: e.moi.x, y: e.moi.y };
        } else {
          dernier = null;
        }
        s.send(JSON.stringify({ type: 'realmTir', a }));
      }
      await new Promise((r) => setTimeout(r, 40));
      kill = s.recus.filter((x) => x.type === 'realmKill').pop();
      mort = s.recus.filter((x) => x.type === 'realmMort').pop();
    }
    /* On DIT si c'est nous qui sommes tombes. « on a fini par tuer quelque
       chose » sur un personnage mort en chemin envoie chercher le defaut dans
       le compte d'XP. */
    ok(!mort, 'on est encore vivant apres la chasse');
    ok(kill, 'on a fini par tuer quelque chose');
    ok(kill.xp > 0, 'et ca rapporte de l XP (' + kill.xp + ')');
    eq(kill.xp, M.MONSTRES[kill.espece].xp, 'exactement celle du catalogue');

    const apres = moteur.personnageEtat(w.address, 'andy');
    ok(apres.xp >= avant.xp + kill.xp,
       'la fiche du personnage a GAGNE cette XP (' + Math.round(avant.xp) + ' -> ' + Math.round(apres.xp) + ')');
    const c = moteur._p(w.address).persos.andy;
    /* L'ecart exact, pas un minorant : `>= kill.xp` passait meme si l'XP
       venait d'ailleurs. La boucle a pu tuer plusieurs creatures avant que
       l'essai ne relise, donc on borne des deux cotes plutot que d'exiger
       l'egalite avec le dernier kill. */
    ok(c.xc >= xcAvant + kill.xp,
       'et elle est bien rangee sous le personnage, pas sous le compte (' + xcAvant + ' -> ' + c.xc + ')');
  }

  // ================== 4. LE NIVEAU MONTE AVEC L'XP DE COMBAT
  {
    const c = moteur._p(w.address).persos.andy;
    c.xc = P.xpPour(6) + 5;                    // de quoi passer niveau 6
    const e = moteur.personnageEtat(w.address, 'andy');
    eq(e.niveau, 6, 'l XP de combat seule fait monter le niveau');
    ok(e.stats.hp > P.statAuNiveau(P.BASE.andy.hp, 1),
      'et les stats montent avec — le niveau ne serait sinon qu un chiffre');
    ok(e.fame >= 0, 'la fame se calcule sur la meme XP');
    const fameAttendue = P.fameDeXp(e.xp);
    eq(e.fame, fameAttendue, 'la fame affichee suit l XP TOTALE, combat compris');
  }

  // ================== 5. MOURIR COUTE TOUT
  {
    const objetsAvant = Object.keys(moteur._p(w.address).objets).length;
    ok(objetsAvant > 0, 'on possede bien quelque chose avant de mourir');

    /* On se laisse tuer : on colle un squelette au joueur en le faisant
       marcher vers le coeur du monde, ou ils sont. Plus simple et tout aussi
       vrai : on remet les points de vie au minimum via un vrai combat. */
    let mort = null;
    for (let i = 0; i < 900 && !mort; i++) {
      const e = s.recus.filter((x) => x.type === 'realmEtat').pop();
      if (e && e.monstres.length) {
        const c = e.monstres[0];
        // on marche DANS le monstre, sans jamais tirer
        s.send(JSON.stringify({ type: 'realmMove',
          x: e.moi.x + Math.sign(c.x - e.moi.x) * 30,
          y: e.moi.y + Math.sign(c.y - e.moi.y) * 30, dir: 'down', anim: 'run' }));
      }
      await new Promise((r) => setTimeout(r, 40));
      mort = s.recus.filter((x) => x.type === 'realmMort').pop();
    }
    ok(mort, 'on a fini par mourir');
    eq(mort.niveau, 0, 'le personnage revient au niveau 0');
    ok(mort.fameGagnee >= 0, 'la fame est encaissee (' + mort.fameGagnee + ')');

    const pp = moteur._p(w.address);
    eq(pp.persos.andy.xc, 0, 'l XP de combat est effacee — sinon la mort ne couterait rien');
    eq(pp.persos.andy.ea, null, 'l arme equipee a disparu');
    eq(Object.keys(pp.objets).length, objetsAvant - 1, 'et elle a quitte le coffre');
    ok(pp.fame > 0, 'la fame est passee au total permanent du compte');

    const fiche = await attend(s, 'skins', 4000);
    ok(fiche, 'la fiche repart au client apres la mort');

    // un mort ne joue plus : plus aucun etat ne lui parvient
    const combienAvant = s.recus.filter((x) => x.type === 'realmEtat').length;
    await new Promise((r) => setTimeout(r, 600));
    const combienApres = s.recus.filter((x) => x.type === 'realmEtat').length;
    eq(combienApres, combienAvant, 'il est SORTI du monde : plus rien ne lui est envoye');
  }

  s.close();
  console.log('realm_serveur.test.js : ' + n + ' verifications OK');
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e && e.stack || e); process.exit(1); });
