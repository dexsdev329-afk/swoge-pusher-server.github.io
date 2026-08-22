'use strict';
/*
 * LA PAROLE DES JOUEURS : CE QU'ON DIT, CE QU'ON EN GARDE, ET QUI L'ENTEND.
 *
 * ---- POURQUOI CE FICHIER EXISTE ----
 *
 * C'est la premiere entree du jeu qui soit A LA FOIS ecrite librement par un
 * joueur et affichee sur l'ecran de TOUS les autres. Les deux moities du
 * probleme sont ici, et aucune ne se voit en lisant le code :
 *
 *  1. CE QUI PASSE. Un saut de ligne fait deborder une bulle qui se dessine
 *     sur une ligne ; un renverseur de sens (U+202E) retourne l'affichage de
 *     tout ce qui suit et ne se voit pas dans le champ de saisie de celui qui
 *     le colle ; deux cents espaces sont un texte « non vide » qui n'affiche
 *     rien. Aucun de ces trois-la ne leve d'erreur nulle part.
 *  2. QUI ENTEND. Une bulle envoyee a tout le monde ferait parler, depuis un
 *     donjon, a des gens qui sont a l'autre bout d'une autre carte. Le public
 *     n'est donc pas invente ici : c'est EXACTEMENT celui qui recoit deja les
 *     deplacements de ce joueur. Cet essai ne le recopie pas non plus — il
 *     relit l'instantane de position et verifie que la bulle porte le meme
 *     identifiant, aux memes destinataires.
 *
 * ---- CE QUE CE FICHIER NE CODE PAS EN DUR ----
 *
 * Ni la longueur maximale, ni l'espacement, ni la rafale : ils viennent de
 * `config.js`, comme le moteur les lit. Ni l'identifiant du joueur : il est
 * relu dans l'instantane que le serveur vient d'envoyer. Un nombre recopie ici
 * resterait vert le jour ou l'on change le reglage — c'est-a-dire le jour ou
 * il faut qu'il tombe.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const fs = require('fs');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/parole-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
/* LE PORT SE CHOISIT AVANT LE PREMIER `require` DU SERVEUR. `config.js` le lit
   a son chargement, une fois pour toutes : le poser plus bas laissait le
   serveur ecouter sur 8080 pendant que l'essai frappait ailleurs, et le seul
   symptome etait un « connexion refusee » qui accusait le reseau. */
process.env.PORT = String(9100 + (process.pid % 300));
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {},
  chatEstPublic() { return true; }, enabled() { return true; } } };

const { Game } = require('./game');
const cfg = require('./config');

/* =====================================================================
 *            PREMIERE MOITIE : CE QUI PASSE, SANS RESEAU
 * =====================================================================
 *
 * Le nettoyage et le debit se decident dans `game.js`, en dehors de toute
 * socket. On les eprouve ici avec une horloge FOURNIE : mesurer une pause de
 * deux secondes en dormant deux secondes ne prouverait rien de plus et
 * ajouterait quinze secondes d'attente a chaque execution — un essai qui dort
 * finit par ne plus etre lance.
 */
console.log('-- ce qu\'il reste d\'un texte --');
{
  const P = Game.textePropre;
  eq(P('bonjour'), 'bonjour', 'un texte ordinaire passe tel quel');
  eq(P('  bonjour  '), 'bonjour', 'les blancs de bord tombent');
  eq(P(''), '', 'le vide reste vide');
  eq(P('   '), '', 'des espaces seuls ne sont pas un texte');
  eq(P(null), '', 'l\'absence de texte non plus');
  eq(P(12), '12', 'ce qui n\'est pas une chaine en devient une');

  /* LA BULLE SE DESSINE SUR UNE LIGNE. Un saut de ligne la fait deborder du
     cadre, et rien en aval ne le rattrape. */
  eq(P('haut\nbas'), 'haut bas', 'un saut de ligne devient un espace');
  eq(P('haut\r\nbas'), 'haut bas', 'un retour chariot aussi, sans doubler l\'espace');
  eq(P('a\tb'), 'a b', 'une tabulation aussi');
  eq(P('a\u2028b'), 'a b', 'le separateur de ligne Unicode aussi');
  eq(P('a\u0000b'), 'a b', 'un octet nul aussi');
  eq(P('\u0007\u0007'), '', 'un texte fait de commandes seules n\'est pas un texte');

  /* LES INVISIBLES. Ils ne se voient pas dans le champ de celui qui les colle,
     et c'est precisement ce qui en fait un outil. */
  eq(P('\u202eabc'), 'abc', 'un renverseur de sens est retire');
  eq(P('a\u200bb'), 'ab', 'une largeur nulle est retiree, sans laisser d\'espace');
  eq(P('\u200b\u200b\u200b'), '', 'un texte fait d\'invisibles est vide');
  eq(P('\ufeffx'), 'x', 'une marque d\'ordre d\'octets est retiree');

  /* LES CHEVRONS. La page qui dessine la bulle vit dans un AUTRE depot : le
     jour ou elle la pose dans un `innerHTML`, une balise suffirait. */
  ok(!/[<>]/.test(P('<img src=x onerror=alert(1)>')), 'aucun chevron ne sort d\'ici');
  ok(!/[<>]/.test(P('</script><script>alert(1)</script>')), 'ni dans une fermeture de balise');

  /* LA LONGUEUR, DEMANDEE AU REGLAGE. */
  eq(Array.from(P('x'.repeat(cfg.DIT_MAX * 3))).length, cfg.DIT_MAX,
     `un texte trop long est coupe a ${cfg.DIT_MAX} points de code`);
  /* ET ELLE SE COMPTE APRES LE NETTOYAGE : compter avant aurait laisse passer
     cent vingt invisibles, c'est-a-dire une bulle vide qui a l'air pleine. */
  eq(P('\u200b'.repeat(cfg.DIT_MAX) + 'court'), 'court',
     'les invisibles ne mangent pas la longueur utile');
  /* ON COMPTE EN POINTS DE CODE. Couper au milieu d'une paire laisserait un
     demi-caractere que la page d'en face ne peut pas afficher. */
  const emojis = '\u{1F600}'.repeat(cfg.DIT_MAX + 10);
  const coupe = P(emojis);
  eq(Array.from(coupe).length, cfg.DIT_MAX, 'les emojis se comptent un par un');
  ok(!/[\uD800-\uDFFF]/.test(coupe.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
     'et la coupe ne laisse aucune demi-paire');
  /* Une demi-paire ARRIVEE telle quelle est retiree, pas transportee. */
  eq(P('a\uD83Db'), 'ab', 'une demi-paire recue est retiree');
}

console.log('\n-- le debit, par joueur --');
{
  const g = new Game({});
  const A = '0xaaa', B = '0xbbb';
  const t0 = 1000000;
  ok(!!g.dit(A, 'un', t0), 'la premiere phrase passe');
  /* L'ESPACEMENT. La bulle vit trente secondes : sans lui, quinze bulles se
     remplaceraient avant que la premiere ait fini d'etre lue. */
  eq(g.dit(A, 'deux', t0 + cfg.DIT_PAUSE_MS - 1), null,
     `une deuxieme avant ${cfg.DIT_PAUSE_MS} ms est ignoree`);
  ok(!!g.dit(A, 'deux', t0 + cfg.DIT_PAUSE_MS),
     'et passe des l\'espacement respecte');
  /* LE VOISIN N'EST PAS PUNI. Le debit est par joueur : un compteur commun
     aurait fait taire toute une carte des qu'un seul parle. */
  ok(!!g.dit(B, 'moi aussi', t0 + cfg.DIT_PAUSE_MS),
     'le debit d\'un joueur ne bride pas celui d\'un autre');

  /* LA RAFALE. L'espacement seul laisse parler indefiniment, une phrase toutes
     les deux secondes. Le plafond GLISSE : un plafond fixe aurait rendu muet a
     vie le premier joueur bavard. */
  const g2 = new Game({});
  const C = '0xccc';
  /* Combien de phrases tiennent dans UNE fenetre en respectant l'espacement :
     ce nombre est deduit des deux reglages, pas choisi. En envoyer plus ferait
     deborder sur la fenetre suivante, et l'essai compterait alors deux rafales
     en croyant en compter une — c'est exactement l'erreur qu'il a faite a sa
     premiere ecriture, et elle accusait le plafond de ne pas tenir. */
  const tiennent = Math.floor((cfg.DIT_FENETRE_MS - 1) / cfg.DIT_PAUSE_MS) + 1;
  ok(tiennent > cfg.DIT_RAFALE,
     `l'espacement seul laisserait passer ${tiennent} phrases par fenetre : c'est le plafond qui mord`);
  let passees = 0;
  for (let i = 0; i < tiennent; i++)
    if (g2.dit(C, 'phrase ' + i, t0 + i * cfg.DIT_PAUSE_MS)) passees++;
  eq(passees, cfg.DIT_RAFALE,
     `au plus ${cfg.DIT_RAFALE} phrases dans une fenetre de ${cfg.DIT_FENETRE_MS} ms`);
  /* Et la fenetre PASSE : une fois qu'elle a glisse, on reparle. */
  ok(!!g2.dit(C, 'plus tard', t0 + cfg.DIT_FENETRE_MS * 2),
     'la fenetre passee, la parole revient');

  /* CE QUI EST REFUSE NE COUTE PAS UNE PLACE. Sinon une page qui envoie des
     blancs epuiserait le droit de parole de son joueur sans qu'aucune bulle
     n'apparaisse jamais. */
  const g3 = new Game({});
  const D = '0xddd';
  for (let i = 0; i < 50; i++) g3.dit(D, '   ', t0 + i);
  ok(!!g3.dit(D, 'enfin quelque chose', t0 + 60),
     'cinquante textes vides n\'ont consomme aucune place');

  /* SANS JOUEUR, PAS DE PAROLE. */
  eq(g3.dit(null, 'anonyme', t0), null, 'un message sans joueur ne produit rien');

  /* ET LE TEXTE RENDU EST LE TEXTE NETTOYE, pas celui recu : c'est lui qui
     part sur le fil, il n'y a pas de deuxieme chance en aval. */
  const g4 = new Game({});
  eq(g4.dit('0xeee', '  salut\nla\u202e  ', t0), 'salut la',
     'ce qui sort du moteur est deja propre');
}

/* =====================================================================
 *          DEUXIEME MOITIE : QUI ENTEND, SUR DE VRAIES SOCKETS
 * ===================================================================== */
(async () => {
  const port = process.env.PORT;

  /* On attrape les simulations en service par le seul chemin qui les traverse
     toutes : leur pas. Sans ca il faudrait exporter la table des mondes du
     serveur, c'est-a-dire ouvrir une porte pour un essai. */
  const { Realm } = require('./realm');
  const ouverts = new Set(), donjonsVus = new Set();
  const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) {
    if (this.plan) donjonsVus.add(this); else ouverts.add(this);
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
  const dort = (ms) => new Promise((r) => setTimeout(r, ms));
  const dits = (s) => s.recus.filter((x) => x.type === 'dit');

  const connecte = async () => {
    const w = ethers.Wallet.createRandom();
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    return { s, addr: w.address.toLowerCase() };
  };
  const vide = (...cs) => { for (const c of cs) c.s.recus.length = 0; };

  /* ---- LE HALL ---- */
  console.log('\n-- dans le hall, ceux qui vous voient bouger vous entendent --');
  const A = await connecte();
  const B = await connecte();
  const HORS = await connecte();          // connecte, jamais entre nulle part
  A.s.send(JSON.stringify({ type: 'nexusJoin' }));
  B.s.send(JSON.stringify({ type: 'nexusJoin' }));
  await dort(400);

  /* L'IDENTIFIANT N'EST PAS RECOPIE : on le relit dans l'instantane de
     position que B vient de recevoir. C'est la definition meme du contrat —
     « le meme identifiant que dans les instantanes de position » — et la seule
     facon de la verifier sans l'ecrire une deuxieme fois. */
  const etat = await attend(B.s, 'nexusEtat');
  const vuDansLeHall = etat.joueurs.find((p) => p.addr === A.addr);
  ok(!!vuDansLeHall, 'B voit bien A bouger dans le hall');
  const idDeA = Object.keys(vuDansLeHall).find((k) => vuDansLeHall[k] === A.addr);
  ok(!!idDeA, `l'instantane de position identifie A par « ${idDeA} »`);

  vide(A, B, HORS);
  A.s.send(JSON.stringify({ type: 'dit', texte: '  bonjour  a  tous  ' }));
  await dort(300);
  eq(dits(B.s).length, 1, 'B recoit exactement une bulle');
  eq(dits(B.s)[0].id, vuDansLeHall[idDeA],
     'et elle porte l\'identifiant sous lequel B le voit deja bouger');
  eq(dits(B.s)[0].texte, 'bonjour a tous', 'le texte arrive nettoye');
  eq(dits(A.s).length, 1, 'A se recoit lui-meme — sinon il croirait que rien n\'est parti');
  eq(dits(HORS.s).length, 0, 'et qui n\'est entre nulle part n\'entend rien');

  console.log('\n-- ce qui est refuse ne produit RIEN, et pas un mot de plus --');
  vide(A, B, HORS);
  A.s.send(JSON.stringify({ type: 'dit', texte: 'trop vite' }));
  await dort(250);
  eq(dits(B.s).length, 0, `une deuxieme phrase avant ${cfg.DIT_PAUSE_MS} ms n'arrive a personne`);
  eq(A.s.recus.filter((m) => m.type === 'error').length, 0,
     'et celui qui parle trop vite ne recoit aucune erreur : le refus est muet');

  vide(A, B);
  B.s.send(JSON.stringify({ type: 'dit', texte: '   \n\t  ' }));
  await dort(250);
  eq(dits(A.s).length, 0, 'un texte vide apres nettoyage ne diffuse rien');
  vide(A, B);
  B.s.send(JSON.stringify({ type: 'dit' }));
  await dort(250);
  eq(dits(A.s).length, 0, 'un message sans texte non plus');

  console.log('\n-- qui n\'est nulle part ne parle a personne --');
  vide(A, B, HORS);
  HORS.s.send(JSON.stringify({ type: 'dit', texte: 'y a quelqu\'un' }));
  await dort(250);
  eq(dits(A.s).length + dits(B.s).length + dits(HORS.s).length, 0,
     'personne ne le voit bouger, donc personne ne l\'entend');

  /* ---- LE MONDE OUVERT ---- */
  console.log('\n-- dans le monde, le meme public que les deplacements --');
  const entreDansLeMonde = async () => {
    const c = await connecte();
    c.s.send(JSON.stringify({ type: 'realmJoin' }));
    await attend(c.s, 'realmEntre');
    return c;
  };
  const D = await entreDansLeMonde();
  const E = await entreDansLeMonde();
  const monde0 = [...ouverts].find((r) => r.joueurs.has(D.addr));
  ok(!!monde0, 'la simulation du monde ouvert a ete retrouvee');
  /* ON LES RAPPROCHE. L'instantane du monde est BORNE en portee — chacun ne
     recoit que ce qui est autour de lui — et deux joueurs nes au hasard sur une
     carte de plusieurs milliers de pixels ne se voient pas. Sans ce
     rapprochement, l'essai n'aurait pas pu relire l'identifiant de D dans la
     vue de E, et aurait accuse la diffusion d'un silence qui n'etait que de la
     distance. */
  {
    const jd = monde0.joueurs.get(D.addr), je = monde0.joueurs.get(E.addr);
    je.x = jd.x; je.y = jd.y;
  }
  await dort(300);
  const vueDeE = await attend(E.s, 'realmEtat');
  const vuDansLeMonde = vueDeE.joueurs.find((p) => String(p.a).toLowerCase() === D.addr);
  ok(!!vuDansLeMonde, 'E voit D bouger dans le monde');
  const idDeD = Object.keys(vuDansLeMonde).find(
    (k) => String(vuDansLeMonde[k]).toLowerCase() === D.addr);
  ok(!!idDeD, `l'instantane du monde identifie D par « ${idDeD} »`);

  vide(A, B, D, E);
  D.s.send(JSON.stringify({ type: 'dit', texte: 'je suis dehors' }));
  await dort(300);
  eq(dits(E.s).length, 1, 'E l\'entend');
  eq(String(dits(E.s)[0].id).toLowerCase(), String(vuDansLeMonde[idDeD]).toLowerCase(),
     'sous le meme identifiant que dans l\'instantane de position');
  eq(dits(D.s).length, 1, 'et D se recoit lui-meme');
  eq(dits(A.s).length + dits(B.s).length, 0,
     'ceux du hall n\'entendent rien — ils ne le voient pas bouger');

  /* ---- LE DONJON ---- */
  console.log('\n-- un donjon n\'entend pas le monde, et le monde n\'entend pas le donjon --');
  /* La porte n'est pas fabriquee a la main : c'est `_ouvrePortail` du vrai
     monde qui la pose, avec ses vraies regles. */
  const CLE = Object.keys(M.DONJONS)[0];
  const poseLaPorte = (addr) => {
    const j = monde0.joueurs.get(addr);
    const ouvreur = M.DONJONS[CLE].ouvreur;
    const t = M.MONSTRES[ouvreur];
    const faux = { id: monde0._nouvelId(), espece: ouvreur,
                   biome: (t.biomes && t.biomes[0]) || 'lave',
                   x: j.x, y: j.y, ancreX: j.x, ancreY: j.y,
                   pv: 0, pvMax: t.pv, dir: 'down', cible: null,
                   recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 };
    const p = monde0._ouvrePortail(faux, null, null);
    p.x = j.x; p.y = j.y;
    return p;
  };

  const F = await entreDansLeMonde();
  const G = await entreDansLeMonde();
  const porte = poseLaPorte(F.addr);
  F.s.send(JSON.stringify({ type: 'realmPorte' }));
  await attend(F.s, 'realmEntre');
  const jg = monde0.joueurs.get(G.addr);
  jg.x = porte.x; jg.y = porte.y;
  G.s.send(JSON.stringify({ type: 'realmPorte' }));
  await attend(G.s, 'realmEntre');
  await dort(350);
  const dedans = [...donjonsVus].filter((r) => r.joueurs.has(F.addr) && r.joueurs.has(G.addr));
  eq(dedans.length, 1, 'F et G sont dans la MEME simulation de donjon');

  vide(D, E, F, G, A);
  F.s.send(JSON.stringify({ type: 'dit', texte: 'ca cogne ici' }));
  await dort(300);
  eq(dits(G.s).length, 1, 'G, dans le donjon, l\'entend');
  eq(dits(F.s).length, 1, 'et F se recoit lui-meme');
  eq(dits(E.s).length + dits(D.s).length, 0,
     'ceux du monde ouvert n\'entendent rien — le donjon est une autre simulation');
  eq(dits(A.s).length, 0, 'et ceux du hall non plus');

  /* L'INVERSE, qui est l'autre moitie de la promesse : ce qui se dit dehors
     n'entre pas dans le donjon. Sans cette moitie, un donjon silencieux
     pourrait n'etre qu'un donjon ou personne n'a parle. */
  vide(D, E, F, G);
  E.s.send(JSON.stringify({ type: 'dit', texte: 'et moi je suis dehors' }));
  await dort(300);
  eq(dits(D.s).length, 1, 'D, dehors, entend E');
  eq(dits(F.s).length + dits(G.s).length, 0, 'et personne dans le donjon ne l\'entend');

  console.log('\n-- ce qui part sur le fil est deja propre --');
  /* D vient de parler quelques centaines de millisecondes plus haut : sans
     cette attente, c'est la limite de debit qui ferait taire la bulle, et
     l'essai accuserait le nettoyage d'un silence qui vient du compteur. */
  await dort(cfg.DIT_PAUSE_MS);
  vide(D, E);
  D.s.send(JSON.stringify({ type: 'dit', texte: '<img src=x onerror=alert(1)>\nligne2' }));
  await dort(300);
  eq(dits(E.s).length, 1, 'la bulle part');
  ok(!/[<>]/.test(dits(E.s)[0].texte), 'sans un seul chevron');
  ok(!/[\r\n]/.test(dits(E.s)[0].texte), 'et sans un seul saut de ligne');
  /* Le message ne porte QUE ce que le contrat annonce : un champ de plus
     serait une chose que la page ne lit pas et que le serveur paie a chaque
     bulle, pour chaque destinataire. */
  eq(Object.keys(dits(E.s)[0]).sort().join(','), 'id,texte,type',
     'et le message ne porte que type, id et texte');

  for (const c of [A, B, HORS, D, E, F, G]) c.s.close();
  console.log(`\nparole.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC :', e && e.stack || e); process.exit(1); });
