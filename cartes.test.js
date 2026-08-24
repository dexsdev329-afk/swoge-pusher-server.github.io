'use strict';
/*
 * LES CARTES DES JOUEURS : QUI PEUT ECRIRE, ET JUSQU'OU.
 *
 * ---- CE QUI EST EN JEU ----
 *
 * Une carte est le travail de quelqu'un, gardee sur notre disque, visible de
 * tous. Trois choses peuvent mal tourner, et aucune ne leve d'erreur :
 *
 *  1. QUELQU'UN ECRIT SUR LA CARTE D'UN AUTRE. La page peut griser un bouton ;
 *     un bouton grise se degrise dans une console en dix secondes et le
 *     message part quand meme. La regle ne vaut que si le SERVEUR refuse.
 *  2. UN ENVOI DEBORDE. Ce sont des ecrits d'inconnus : sans plafonds, un seul
 *     message remplit le disque ou la memoire, et le serveur tombe pour tout
 *     le monde.
 *  3. UNE SAUVEGARDE PERD OU ECRASE. Un redeploiement qui efface les cartes ne
 *     laisse aucune trace ; pire, un compteur qui repart a un donne a la
 *     prochaine carte le numero d'une carte deja la, qui disparait au premier
 *     enregistrement.
 *
 * Les trois se verifient ici, sur le module, sans navigateur : ce sont des
 * regles de serveur, elles doivent tenir meme si aucune page ne les respecte.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const carte = (nom, cases, cote) => ({ nom, cote: cote || 16, cases });
const case1 = [{ c: 1, l: 1, s: 'grass' }];

/* ================== 1. L'ENTONNOIR ================== */
console.log('-- ce qui entre, et ce qui est refuse --');
{
  const v = Game.carteValide;
  ok(!v(null), 'rien du tout est refuse');
  ok(!v(carte('', case1)), 'une carte sans nom est refusee');
  ok(!v(carte('essai', null)), 'une carte sans liste de cases est refusee');
  ok(!v({ nom: 'essai', cote: 16 }), 'une carte dont les cases manquent est refusee');
  ok(!v(carte('essai', case1, 2)), 'un cote trop petit est refuse');
  ok(!v(carte('essai', case1, cfg.CARTE_COTE + 1)),
     `un cote au-dela de ${cfg.CARTE_COTE} est refuse`);
  const trop = [];
  for (let i = 0; i <= cfg.CARTE_CASES; i++) trop.push({ c: 0, l: 0, s: 'grass' });
  ok(!v(carte('essai', trop, 16)),
     `un envoi de ${trop.length} cases est refuse d'emblee (plafond ${cfg.CARTE_CASES})`);

  const bon = v(carte('Ma carte', case1));
  ok(!!bon, 'une carte bien formee passe');
  eq(bon.cases.length, 1, 'et garde sa case');

  /* Ce qui est HORS de la grille ne doit pas y entrer par la bande : un
     numero de colonne negatif indexerait a l'envers chez qui dessine. */
  const dehors = v(carte('essai', [
    { c: -1, l: 0, s: 'grass' }, { c: 0, l: -1, s: 'grass' },
    { c: 16, l: 0, s: 'grass' }, { c: 0, l: 16, s: 'grass' },
    { c: 2, l: 2, s: 'grass' },
  ]));
  eq(dehors.cases.length, 1, 'les quatre cases hors de la grille sont ecartees, la bonne reste');

  /* Une cle est une FORME, pas un membre d'une liste : le catalogue vit dans
     l'autre depot et change a chaque planche. Mais la forme, elle, protege —
     c'est elle qui empeche un nom de fichier deguise. */
  const cles = v(carte('essai', [
    { c: 0, l: 0, s: '../../etc/passwd' }, { c: 1, l: 0, s: 'A' },
    { c: 2, l: 0, s: 'grass' }, { c: 3, l: 0, o: 'obj boxe' },
    { c: 4, l: 0, o: 'boxe' },
  ]));
  eq(cles.cases.length, 2, 'seules les cles bien formees survivent (chemin, majuscule et espace ecartes)');

  const vide = v(carte('essai', [{ c: 0, l: 0 }, { c: 1, l: 1, s: 'grass' }]));
  eq(vide.cases.length, 1, 'une case sans sol ni objet ne compte pas : elle ne dit rien');

  const double = v(carte('essai', [
    { c: 3, l: 3, s: 'grass' }, { c: 3, l: 3, s: 'dirt' }, { c: 4, l: 4, s: 'snow' },
  ]));
  eq(double.cases.length, 2, 'une coordonnee repetee ne compte qu une fois');
  eq(double.cases.find((k) => k.c === 3).s, 'dirt', 'et c est la derniere qui gagne');
}

/* ================== 2. LA PROPRIETE ================== */
console.log('\n-- qui peut ecrire --');
{
  const g = new Game();
  const k = g.enregistreCarte(A, null, carte('Chez A', case1));
  ok(k && k.id, `A cree sa carte (numero ${k.id})`);
  eq(k.addr, A, 'elle porte l adresse de son auteur');

  const vol = g.enregistreCarte(B, k.id, carte('Chez B', case1));
  eq(typeof vol, 'string', 'B ne peut PAS enregistrer par-dessus : ' + vol);
  eq(g.carte(k.id).nom, 'Chez A', 'et la carte de A est intacte');

  const efface = g.supprimeCarte(B, k.id);
  eq(typeof efface, 'string', 'B ne peut pas la supprimer non plus : ' + efface);
  ok(!!g.carte(k.id), 'elle est toujours la');

  /* Visiter, en revanche, est ouvert a tous : c'est tout l'interet. */
  ok(!!g.carte(k.id), 'B peut la LIRE — visiter n est pas modifier');

  const sien = g.enregistreCarte(A, k.id, carte('Chez A, revu', case1));
  eq(sien.nom, 'Chez A, revu', 'A, lui, la modifie');
  eq(g.mesCartes(A).length, 1, 'et il n en a toujours qu une');
  eq(g.mesCartes(B).length, 0, 'B n en a aucune');
}

/* ================== 3. LES PLAFONDS ================== */
console.log('\n-- jusqu ou --');
{
  const g = new Game();
  let dernier = null;
  for (let i = 0; i < cfg.CARTES_PAR_COMPTE; i++) dernier = g.enregistreCarte(A, null, carte('n' + i, case1));
  ok(dernier && dernier.id, `A remplit ses ${cfg.CARTES_PAR_COMPTE} cartes`);
  const trop = g.enregistreCarte(A, null, carte('une de trop', case1));
  eq(typeof trop, 'string', 'la suivante est refusee : ' + trop);
  eq(g.mesCartes(A).length, cfg.CARTES_PAR_COMPTE, 'le compte ne bouge pas');
  /* Le plafond est PAR COMPTE : il ne doit pas fermer la porte aux autres. */
  const chezB = g.enregistreCarte(B, null, carte('Chez B', case1));
  ok(chezB && chezB.id, 'et B peut toujours creer la sienne');
}

/* ================== 4. LA VITRINE ================== */
console.log('\n-- ce que la galerie montre --');
{
  const g = new Game();
  const grand = [];
  for (let i = 0; i < 500; i++) grand.push({ c: i % 20, l: Math.floor(i / 20), s: 'grass' });
  const k = g.enregistreCarte(A, null, carte('Grande', grand, 32));
  g.enregistreCarte(B, null, carte('Chez B', case1));
  const vue = g.vitrineCartes(B);
  eq(vue.length, 2, 'la galerie montre les cartes de tout le monde');
  const mienne = vue.find((q) => q.id !== k.id);
  ok(mienne.mienne === true, 'celle de B est marquee comme sienne');
  ok(vue.find((q) => q.id === k.id).mienne === false, 'celle de A ne l est pas');
  /* Le contenu ne part PAS dans la galerie : trente-deux mille cases par
     carte rendraient la liste injouable des la dixieme. */
  ok(vue.every((q) => !Array.isArray(q.cases)),
     'et elle ne porte pas le contenu, seulement son compte');
  eq(vue.find((q) => q.id === k.id).cases, 500, 'le compte de cases est juste');
}

/* ================== 5. LA SAUVEGARDE ================== */
console.log('\n-- ce qui survit a un redemarrage --');
{
  const g = new Game();
  const k1 = g.enregistreCarte(A, null, carte('Une', case1));
  const k2 = g.enregistreCarte(A, null, carte('Deux', case1));
  /* `serialize()` et non la partie de tete : c'est CE chemin-la que le serveur
     ecrit sur le disque. Eprouver une methode interne aurait laisse passer un
     champ oublie a l'assemblage — la carte serait dans la tete et absente de
     l'archive, et personne ne l'aurait su avant un redemarrage. */
  const st = JSON.parse(JSON.stringify(g.serialize()));

  const g2 = new Game();
  g2.hydrate(st);
  eq(g2.cartes.length, 2, 'les deux cartes traversent la sauvegarde');
  eq(g2.carte(k2.id).nom, 'Deux', 'avec leur nom');
  eq(g2.carte(k1.id).addr, A, 'et leur auteur — sans quoi la propriete se perdrait au redemarrage');

  /* ---- LE CAS QUI COUTE LE PLUS CHER ----
   * Une sauvegarde ecrite AVANT que le compteur existe n'en porte pas. S'il
   * repart a un, la prochaine carte prend le numero d'une carte deja la, et
   * l'ecrase au premier enregistrement — le travail de quelqu'un disparait
   * sans une erreur. */
  const vieux = JSON.parse(JSON.stringify(st));
  delete vieux.cartesNo;
  const g3 = new Game();
  g3.hydrate(vieux);
  ok(g3.cartesNo > k2.id,
     `sans compteur dans la sauvegarde, il se recalcule au-dessus des cartes presentes (${g3.cartesNo} > ${k2.id})`);
  const neuve = g3.enregistreCarte(A, null, carte('Trois', case1));
  ok(neuve.id !== k1.id && neuve.id !== k2.id, 'et la carte suivante n ecrase personne');
  eq(g3.cartes.length, 3, 'les trois coexistent');
}

console.log(`\ncartes.test.js : ${n} verifications OK`);
