'use strict';
/*
 * LE CLASSEMENT DU MONDE — CE QU'ON PERD EN MOURANT.
 *
 * Le niveau plafonne a vingt, et apres ? On continuait de tuer pour du butin,
 * et c'est tout : le monde de combat n'avait pas d'objectif propre.
 *
 * ---- ce que ce fichier doit garantir, dans l'ordre ----
 *
 * 1. ON CLASSE LE PERSONNAGE, PAS LE COMPTE. C'est toute la tension : « tu
 *    meurs, tu perds tout » n'est vrai que si le rang tombe avec le
 *    personnage. Mourir doit faire DISPARAITRE la ligne — pas la faire
 *    reculer, disparaitre.
 * 2. LA LIGNE MONTRE CE QU'IL PORTE. Etre en haut doit faire de vous une
 *    cible ; une ligne qui ne montre qu'un nom ne dit pas ce qu'il y a a
 *    gagner en vous tuant.
 * 3. LE PRIX EST EN OR, JAMAIS EN JETONS. De l'XP payee en $SWOGE serait de
 *    l'argent CREE contre du temps passe, et ca se farme avec un client sans
 *    ecran. C'est la propriete dont l'echec ne se rattrape pas.
 * 4. UNE SEULE FOIS PAR SEMAINE. Un prix paye deux fois est de l'or cree.
 * 5. UNE SEMAINE PASSEE SE RELIT. Les personnages continuent de vivre et
 *    certains meurent : « qui a gagne » n'existe plus nulle part si on ne
 *    l'a pas garde.
 */
const assert = require('assert');
const { Game } = require('./game');
const B = require('./boutique');
const P = require('./personnages');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const adr = (i) => '0x' + String(i).padStart(2, '0').repeat(20);

/* Un joueur avec un personnage et un peu d'XP de combat. Rien d'invente : on
   passe par gagneXpCombat, le chemin que prend une vraie mise a mort. */
function joueur(g, i, skin, xp, nom) {
  const a = adr(i);
  const p = g._p(a);
  p.name = nom || ('Player' + i);
  p.skins = p.skins || {}; p.skins[skin] = true;
  p.skinActif = skin;
  p.persos = p.persos || {};
  p.persos[skin] = { w: require('ethers').BigNumber.from(0), ef: null, ea: null,
                     ar: null, ba: null, xc: 0, sup: {} };
  if (xp > 0) g.gagneXpCombat(a, skin, xp);
  return a;
}

// ================== 1. UN SEUL CALENDRIER POUR TOUT LE JEU
//
// Le prix du monde suit le MEME mois que le classement du casino. Deux
// calendriers dans un seul jeu, c'est un de trop : le joueur retiendrait
// l'un et raterait l'autre, et personne ne saurait dire quel jour on est.
{
  const g = new Game();
  eq(g.prixMonde().mois, Game.moisCle(),
     'le prix du monde est date du mois courant');
  eq(g.classementMonde(null, 5).mois, Game.moisCle(),
     'et le tableau annonce le meme');
  eq(g.prixClassement().mois, Game.moisCle(),
     'exactement celui du classement du casino');
}

// ================== 2. ON CLASSE LES PERSONNAGES, ET ON LES TRIE
{
  const g = new Game();
  joueur(g, 1, 'andy', 5000, 'Alice');
  joueur(g, 2, 'pepe', 12000, 'Bob');
  joueur(g, 3, 'brett', 800, 'Carol');
  /* Un personnage sans XP n'est pas au tableau : il n'a rien fait. Ce n'est
     pas une exclusion, c'est la meme regle que pour un mort — zero XP, pas de
     ligne. */
  joueur(g, 4, 'claude', 0, 'Dave');

  const cl = g.classementMonde(null, 20);
  eq(cl.vivants, 3, 'trois personnages ont de l XP, le quatrieme n en a pas');
  eq(cl.top[0].name, 'Bob', 'le premier est celui qui en a le plus');
  eq(cl.top[0].rang, 1, 'et il porte son rang');
  eq(cl.top[2].name, 'Carol', 'le dernier est celui qui en a le moins');
  ok(cl.top[0].xp > cl.top[1].xp && cl.top[1].xp > cl.top[2].xp,
     'le tri est strict, de haut en bas');
  ok(cl.top.every((r) => r.skin), 'chaque ligne nomme le PERSONNAGE, pas seulement le compte');
  ok(cl.top.every((r) => r.niveau > 0), 'et son niveau');

  /* SIX VIES SEPAREES. Un compte a six personnages : ce sont six lignes, six
     facons de monter et six facons de tout perdre. Les fondre en une seule
     rendrait la mort indolore — il resterait toujours les cinq autres. */
  const a = adr(1);
  const p = g._p(a);
  p.skins.pepe = true;
  p.persos.pepe = { w: require('ethers').BigNumber.from(0), ef: null, ea: null,
                    ar: null, ba: null, xc: 0, sup: {} };
  g.gagneXpCombat(a, 'pepe', 30000);
  g._cmCache = null;
  const cl2 = g.classementMonde(a, 20);
  eq(cl2.vivants, 4, 'le deuxieme personnage du meme compte a SA ligne');
  eq(cl2.top[0].skin, 'pepe', 'et il prend la premiere place');
  eq(cl2.top[0].address, a, 'sous le meme compte');
  eq(cl2.moi.length, 2, 'le demandeur recoit ses DEUX lignes');
}

// ================== 3. MOURIR FAIT DISPARAITRE LA LIGNE
//
// C'est la propriete qui donne son sens au tableau. Pas « reculer » :
// disparaitre.
{
  const g = new Game();
  const a = joueur(g, 1, 'andy', 40000, 'Alice');
  joueur(g, 2, 'pepe', 9000, 'Bob');
  g._cmCache = null;
  const avant = g.classementMonde(null, 20);
  eq(avant.top[0].name, 'Alice', 'Alice est en tete');
  eq(avant.vivants, 2, 'et ils sont deux au tableau');

  g.meurt(a, 'andy');
  g._cmCache = null;
  const apres = g.classementMonde(null, 20);
  eq(apres.vivants, 1, 'apres sa mort, il n en reste qu un');
  ok(!apres.top.some((r) => r.address === a && r.skin === 'andy'),
     'Alice n est plus nulle part au tableau');
  eq(apres.top[0].name, 'Bob', 'et Bob a pris la tete sans rien faire');

  /* Elle peut remonter : c'est un tableau de vivants, pas une liste noire. */
  g.gagneXpCombat(a, 'andy', 500);
  g._cmCache = null;
  const rev = g.classementMonde(null, 20);
  ok(rev.top.some((r) => r.address === a && r.skin === 'andy'),
     'et elle revient des qu elle retue quelque chose');
  eq(rev.top[rev.top.length - 1].name, 'Alice', 'tout en bas, ou elle recommence');
}

// ================== 4. LA LIGNE MONTRE CE QU'IL PORTE
{
  const g = new Game();
  const a = joueur(g, 1, 'andy', 9000, 'Alice');
  const arme = B.ITEMS.find((o) => o.saison === 2);
  const armure = B.ITEMS.find((o) => o.saison === 3);
  const p = g._p(a);
  p.objets = { [arme.id]: 1, [armure.id]: 1 };
  p.persos.andy.ea = arme.id;
  p.persos.andy.ar = armure.id;
  g._cmCache = null;
  const r = g.classementMonde(null, 20).top[0];
  eq(r.tenue.length, 2, 'les deux pieces portees voyagent avec la ligne');
  ok(r.tenue.some((o) => o.id === arme.id), 'son arme');
  ok(r.tenue.some((o) => o.id === armure.id), 'et son armure');
  ok(r.tenue.every((o) => o.nom && o.rarete && o.couleur),
     'chacune avec son nom, sa rarete et sa couleur — de quoi savoir ce qu on gagne a le tuer');
  /* Ce qu'il porte, pas ce qu'il POSSEDE : le coffre ne part pas avec lui, et
     l'annoncer ferait viser un joueur pour une epee qu'il a laissee chez
     lui. */
  const autre = B.ITEMS.filter((o) => o.saison === 2)[1];
  p.objets[autre.id] = 1;
  g._cmCache = null;
  eq(g.classementMonde(null, 20).top[0].tenue.length, 2,
     'une piece rangee au coffre ne s affiche pas : elle ne se perd pas non plus');
}

// ================== 5. LE PRIX : VINGT MILLE PIECES D'OR, AUX DIX PREMIERS, PAR MOIS
{
  const g = new Game();
  for (let i = 1; i <= 14; i++) joueur(g, i, 'andy', 100000 - i * 1000, 'P' + i);
  g._cmCache = null;
  const prix = g.prixMonde();
  eq(prix.total, cfg.PRIX_MONDE_GOLD, 'la dotation est celle annoncee');
  eq(prix.total, 20000, 'vingt mille pieces');
  eq(prix.gagnants.length, cfg.PRIX_PARTS.length, 'dix gagnants, pas quatorze');
  eq(prix.gagnants.length, 10, 'dix');
  const somme = prix.gagnants.reduce((s, x) => s + x.gold, 0);
  ok(Math.abs(somme - prix.total) <= prix.gagnants.length,
     `tout est distribue, aux arrondis pres (${somme} sur ${prix.total})`);
  /* La repartition DECROIT vite. Un partage plat ne fait courir personne. */
  for (let i = 1; i < prix.gagnants.length; i++) {
    ok(prix.gagnants[i].gold <= prix.gagnants[i - 1].gold,
       `le rang ${i + 1} ne gagne pas plus que le rang ${i}`);
    n -= 1;
  }
  n += 1; ok(true, 'la repartition decroit du premier au dixieme');
  ok(prix.gagnants[0].gold >= prix.total * 0.25,
     `le premier prix vaut le quart de la dotation (${prix.gagnants[0].gold})`);
  ok(prix.gagnants[0].gold > prix.gagnants[9].gold * 10,
     'et dix fois le dixieme : la premiere place se dispute');
}

// ================== 6. IL SE VERSE EN OR, ET UNE SEULE FOIS PAR MOIS
{
  const g = new Game();
  const gagnants = [];
  for (let i = 1; i <= 12; i++) gagnants.push(joueur(g, i, 'andy', 100000 - i * 1000, 'P' + i));
  g._cmCache = null;
  const sem = Game.moisCle();
  const orAvant = gagnants.map((a) => g._p(a).fame || 0);
  const soldeAvant = gagnants.map((a) => g.balanceStr(a));

  const r = g.verseMonde(sem);
  eq(r.gagnants.length, 10, 'dix personnages sont payes');
  eq(g._p(gagnants[0]).fame, orAvant[0] + r.gagnants[0].gold,
     'le premier a recu son or');
  ok(g._p(gagnants[0]).fame > 0, 'et il en a vraiment');
  eq(g._p(gagnants[11]).fame || 0, orAvant[11],
     'le douzieme n a rien recu — il n etait pas dans les dix');

  /* ---- EN OR, PAS EN JETONS ----
   * C'est la propriete dont l'echec ne se rattrape pas. De l'XP payee en
   * $SWOGE, c'est de l'argent CREE contre du temps passe : ca se farme avec
   * un client sans ecran, et le combat etant arbitre par le serveur, la ferme
   * n'aurait meme pas besoin de tricher. */
  const bouge = gagnants.filter((a, i) => g.balanceStr(a) !== soldeAvant[i]);
  eq(bouge.length, 0, 'AUCUN solde en $SWOGE n a bouge : le prix est en or, et rien d autre');

  /* Une seule fois. Un prix paye deux fois est de l'or cree, et personne ne
     s'en plaindrait assez vite pour qu'on le remarque. */
  let refus = null;
  try { g.verseMonde(sem); } catch (e) { refus = e.message; }
  ok(refus && /already paid/.test(refus), 'un second versement est refuse : ' + refus);
  eq(g._p(gagnants[0]).fame, orAvant[0] + r.gagnants[0].gold,
     'et l or du premier n a pas double');
}

// ================== 7. UN MOIS PASSE SE RELIT, MEME APRES LES MORTS
//
// Les personnages continuent de vivre, et certains meurent. « Qui a gagne »
// n'existe plus nulle part si on ne l'a pas garde au moment du versement.
{
  const g = new Game();
  const a = joueur(g, 1, 'andy', 50000, 'Alice');
  joueur(g, 2, 'pepe', 20000, 'Bob');
  g._cmCache = null;
  const sem = Game.moisCle();
  const r = g.verseMonde(sem);
  eq(r.gagnants[0].name, 'Alice', 'Alice a gagne ce mois-la');

  /* Elle meurt, et le tableau courant l'oublie — c'est voulu. */
  g.meurt(a, 'andy');
  g._cmCache = null;
  ok(!g.classementMonde(null, 20).top.some((x) => x.address === a),
     'le tableau COURANT ne la montre plus');

  /* Le mois passe, lui, se souvient. */
  const vieux = g.prixMonde(sem);
  eq(vieux.gagnants[0].name, 'Alice', 'mais le mois passe garde son nom');
  eq(vieux.gagnants[0].gold, r.gagnants[0].gold, 'et ce qu elle a touche');
  ok(vieux.verse, 'et elle se dit payee');

  /* Et ca survit a un redemarrage : sans ca, un redeploiement le 1er au matin
     rendrait le prix payable une seconde fois. */
  const etat = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(etat);
  ok(g2.prixMondeVerses && g2.prixMondeVerses[sem],
     'apres un redemarrage, le mois est toujours marque paye');
  let refus = null;
  try { g2.verseMonde(sem); } catch (e) { refus = e.message; }
  ok(refus && /already paid/.test(refus),
     'et un redeploiement ne la fait pas payer deux fois : ' + refus);
}

// ================== LA VITRINE MONTRE LE VRAI CLASSEMENT
//
// La page d'accueil portait trois lignes ecrites a la main : « SwogeKing »,
// « DogeLord », « FlonDoge », avec des rangs — LEGEND, ALPHA, GAMMA — qui
// n'existent nulle part dans le jeu. La Fame est un NOMBRE ; ces titres
// etaient une invention, et une XP inventee au-dessus.
//
// Ce que la vitrine rend doit donc sortir du MEME calcul que le panneau, et
// ne rien porter de plus que ce qu'un visiteur peut voir sans etre connecte.
{
  const g = new Game();
  eq(g.vitrineChiffres().classement.length, 0,
     'sans personne qui joue, la vitrine ne montre aucun classement');

  /* ---- ON REPART D'UN JEU NEUF ----
   * `classementMonde` garde son resultat une seconde — c'est son cache, et il
   * a raison de l'avoir : la vitrine est publique et le panneau se redemande
   * toutes les cinq secondes. Mais peupler le meme jeu dans la meme seconde
   * relirait la liste vide qu'on vient de mesurer, et l'essai accuserait le
   * cache d'un defaut qui n'existe pas. */
  const h = new Game();
  joueur(h, 71, 'shiba', 40000, 'Alice');
  joueur(h, 72, 'shiba', 9000, 'Bob');
  joueur(h, 73, 'shiba', 2000, null);
  /* Le raccourci `joueur()` baptise tout le monde ; celui-la doit rester
     anonyme, c'est le cas qu'on mesure. */
  h._p(adr(73)).name = null;
  joueur(h, 74, 'shiba', 500, 'Dora');
  /* Le quatrieme ne doit PAS sortir : la carte en montre trois. */
  const v = h.vitrineChiffres().classement;
  eq(v.length, 3, 'la vitrine en montre trois, pas un de plus');
  eq(v[0].nom, 'Alice', 'et dans l ordre du panneau');
  eq(v[1].nom, 'Bob', 'deuxieme');

  const panneau = h.classementMonde(null, 3).top;
  eq(v[0].xp, panneau[0].xp, 'l XP est celle du panneau, pas une autre');
  eq(v[0].niveau, panneau[0].niveau, 'le niveau aussi');
  eq(v[0].fame, panneau[0].fame, 'la Fame aussi');

  /* Un joueur sans nom garde la meme convention que le panneau : le debut de
     son adresse. Deux endroits qui nomment les gens autrement, ce sont deux
     personnes differentes pour qui les lit. */
  eq(v[2].nom, adr(73).slice(0, 10),
     'sans nom, c est le debut de l adresse, comme dans le jeu');

  /* Et RIEN d'autre ne sort : une vitrine publique n'est pas un profil. */
  const champs = Object.keys(v[0]).sort().join(',');
  eq(champs, 'fame,niveau,nom,xp',
     'et il ne sort que ces quatre champs : ' + champs);
}

console.log('classement_monde.test.js : ' + n + ' verifications OK');
