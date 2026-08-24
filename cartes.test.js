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

/* ================== 1 bis. LES PLAFONDS PASSENT PAR LE TUYAU ================== */
console.log('\n-- une carte pleine tient-elle dans une trame --');
{
  /* ---- LE CHIFFRE VIENT DU SERVEUR, PAS D'ICI ----
   * `maxPayload` est une protection globale posee bien avant ces cartes, et
   * qui agit AVANT toute validation : une trame plus grosse est refusee par la
   * socket, pas par le reglement. Des plafonds plus larges qu'elle seraient un
   * mensonge — la carte serait acceptee par les regles et rejetee par le
   * tuyau, et personne ne comprendrait pourquoi son travail ne s'enregistre
   * pas.
   * Le lien entre les deux est trop facile a rompre pour ne vivre que dans un
   * commentaire : on relit donc la valeur dans `server.js`. La recopier ici
   * aurait fait deux nombres a tenir d'accord, et c'est toujours le second
   * qu'on oublie. */
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const mp = /maxPayload:\s*(\d+)\s*\*\s*(\d+)/.exec(src);
  ok(!!mp, 'la trame maximale se lit dans server.js');
  const MAX = Number(mp[1]) * Number(mp[2]);

  /* La pire carte que le reglement accepte : le cote au plafond, toutes les
     cases remplies, et chacune portant un sol ET un objet aux noms les plus
     longs qu'une cle autorise. */
  const long = 'x'.repeat(24);   // la borne du reglement, pas une cle realiste
  const pire = [];
  for (let c = 0; c < cfg.CARTE_COTE; c++) {
    for (let l = 0; l < cfg.CARTE_COTE; l++) pire.push({ c, l, s: long, o: long });
  }
  ok(pire.length <= cfg.CARTE_CASES,
     `une carte pleine (${pire.length} cases) tient sous le plafond d envoi (${cfg.CARTE_CASES})`);
  const poids = JSON.stringify({ type: 'carteEnregistre', id: 999999,
                                 carte: { nom: long, cote: cfg.CARTE_COTE, cases: pire } }).length;
  ok(poids < MAX,
     `et le message entier pese ${Math.round(poids / 1024)} ko, sous la trame de ${Math.round(MAX / 1024)} ko`);
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

/* ================== 6. LE MODE, CHOISI UNE FOIS ================== */
console.log('\n-- deux facons de dessiner, et le choix ne se reprend pas --');
{
  const v = Game.carteValide;
  eq(v(carte('a', case1)).mode, 'plat',
     'sans mode declare, une carte est plate — comme toutes celles ecrites avant ce champ');
  eq(v(Object.assign(carte('a', case1), { mode: 'iso' })).mode, 'iso',
     'le mode isometrique est garde');
  eq(v(Object.assign(carte('a', case1), { mode: 'dragon' })).mode, 'plat',
     'un mode inconnu retombe sur plat au lieu de passer tel quel');

  const g = new Game();
  const k = g.enregistreCarte(A, null, Object.assign(carte('Iso', case1, 16), { mode: 'iso' }));
  eq(k.mode, 'iso', 'la carte creee garde son mode');
  eq(g.vitrineCartes(A)[0].mode, 'iso', 'et la vitrine le montre, pour que la page sache la dessiner');

  /* ---- CE QUE CE BLOC EMPECHE VRAIMENT ----
   * Le mode decide de ce qui est dessine et le cote borne les cases. Les
   * laisser changer a l'enregistrement permettrait de retrecir une carte sous
   * ses propres cases, ou de declarer « isometrique » une carte pleine de
   * tuiles plates. */
  const r = g.enregistreCarte(A, k.id,
    Object.assign(carte('Iso', case1, 48), { mode: 'plat' }));
  eq(r.mode, 'iso', 'un enregistrement ne peut pas changer le mode apres coup');
  eq(r.cote, 16, 'ni le cote');

  /* Et les cases sont bornees par le cote DE LA CARTE, pas par celui qu'on
     declare : une case en (30,30) envoyee avec « cote 48 » sur une carte de
     seize serait hors de la carte, invisible, et jetee au passage suivant. */
  const r2 = g.enregistreCarte(A, k.id,
    Object.assign(carte('Iso', [{ c: 1, l: 1, s: 'grass' }, { c: 30, l: 30, s: 'grass' }], 48),
                  { mode: 'iso' }));
  eq(r2.cases.length, 1, 'et une case hors de la carte est refusee, meme annoncee avec un grand cote');

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.carte(k.id).mode, 'iso', 'le mode traverse la sauvegarde');
}

/* ================== 7. L IMAGE, ET LA GALERIE QUI NE DEBORDE PAS ================== */
console.log('\n-- l image jointe, et ce qui est refuse --');
{
  const v = Game.vignetteValide;
  const bonne = 'data:image/webp;base64,' + 'A'.repeat(200);
  eq(v(bonne), bonne, 'une image webp en base64 est gardee');
  ok(v('data:image/png;base64,' + 'A'.repeat(40)), 'le png aussi — tous les navigateurs n encodent pas le webp');
  ok(!v('data:image/svg+xml;base64,' + 'A'.repeat(40)),
     'le SVG est refuse : c est du document, pas de l image, et il peut porter du script');
  ok(!v('data:image/webp;base64,<script>'), 'ce qui n est pas de la base64 est refuse');
  ok(!v('https://ailleurs.example/x.webp'), 'une adresse distante est refusee');
  ok(!v('data:image/webp;base64,' + 'A'.repeat(cfg.CARTE_VIGNETTE_MAX)),
     'et au-dela du plafond, refusee — sans quoi la vignette devient un disque a nous');
  ok(!v(undefined), 'absente vaut refusee : la fiche retombe sur son texte');

  const g = new Game();
  const k = g.enregistreCarte(A, null, Object.assign(carte('Vue', case1), { vignette: bonne }));
  eq(k.vignette, bonne, 'la carte garde son image');
  eq(g.vitrineCartes(A)[0].vignette, bonne, 'et la galerie la montre');
  /* ---- CE QUE CE CAS PROTEGE ----
   * Un navigateur qui ne sait pas fabriquer d'image, ou dont l'image depasse
   * le plafond, ne doit pas EFFACER celle qui etait la : la fiche perdrait
   * son dessin a un enregistrement sans rapport. */
  const r = g.enregistreCarte(A, k.id, carte('Vue', case1));
  eq(r.vignette, bonne, 'un enregistrement sans image garde celle d avant');
  const autre = 'data:image/webp;base64,' + 'B'.repeat(120);
  eq(g.enregistreCarte(A, k.id, Object.assign(carte('Vue', case1), { vignette: autre })).vignette,
     autre, 'et une nouvelle image remplace l ancienne');
}

console.log('\n-- la galerie ne grossit pas sans fin --');
{
  const g = new Game();
  /* Bien plus que le plafond, et par d'AUTRES comptes que celui qui regarde. */
  for (let i = 0; i < cfg.CARTES_VITRINE + 30; i++) {
    const w = '0x' + String(i).padStart(2, '0').repeat(20);
    g.enregistreCarte(w, null, carte('C' + i, case1));
  }
  const mien1 = g.enregistreCarte(A, null, carte('La mienne', case1));
  ok(g.cartes.length > cfg.CARTES_VITRINE, `${g.cartes.length} cartes existent`);
  const vue = g.vitrineCartes(A);
  ok(vue.length <= cfg.CARTES_VITRINE,
     `la galerie en montre ${vue.length}, pas plus de ${cfg.CARTES_VITRINE}`);
  ok(vue.some((q) => q.id === mien1.id),
     'et la sienne y est, quel que soit le nombre de cartes des autres');
  /* Le cas qui compte vraiment : une carte a soi, ANCIENNE, noyee sous les
     nouveautes des autres. C'est celle qu'on vient chercher. */
  const g2 = new Game();
  const vieille = g2.enregistreCarte(A, null, carte('Ma vieille carte', case1));
  vieille.modifie = 1;
  for (let i = 0; i < cfg.CARTES_VITRINE + 10; i++) {
    const w = '0x' + String(i).padStart(2, '0').repeat(20);
    g2.enregistreCarte(w, null, carte('N' + i, case1));
  }
  ok(g2.vitrineCartes(A).some((q) => q.id === vieille.id),
     'meme la plus ancienne des siennes, sous cent cartes plus recentes');
}

/* ================== 8. OU L ON ARRIVE, ET CE QUI BLOQUE ================== */
console.log('\n-- le point de depart --');
{
  const v = Game.carteValide;
  eq(v(carte('a', case1)).depart, null,
     'une carte sans depart est valide : elle n est simplement pas encore jouable');
  const d = v(Object.assign(carte('a', case1, 16), { depart: { c: 3, l: 4 } })).depart;
  eq(d.c + ',' + d.l, '3,4', 'un depart pose est garde');
  eq(v(Object.assign(carte('a', case1, 16), { depart: { c: 30, l: 2 } })).depart, null,
     'un depart hors de la carte est refuse, pas rogne : le rogner le mettrait'
     + ' ailleurs que la ou on l a pose, et sans le dire');
  eq(v(Object.assign(carte('a', case1, 16), { depart: { c: -1, l: 0 } })).depart, null,
     'ni avant le bord');
  eq(v(Object.assign(carte('a', case1, 16), { depart: 'la-bas' })).depart, null,
     'ni ce qui n est pas un point');

  const g = new Game();
  const k = g.enregistreCarte(A, null, Object.assign(carte('Jouable', case1, 16),
                                                     { depart: { c: 1, l: 2 } }));
  eq(k.depart.c, 1, 'la carte creee garde son depart');
  eq(g.vitrineCartes(A)[0].jouable, true, 'et la galerie dit qu on peut y aller');
  const sans = g.enregistreCarte(A, null, carte('Pas jouable', case1, 16));
  eq(g.vitrineCartes(A).find((q) => q.id === sans.id).jouable, false, 'et qu on ne peut pas, sinon');
  /* La vitrine ne porte PAS le point lui-meme : ce qu'on veut y lire est
     « peut-on y aller », pas « ou ». */
  eq(g.vitrineCartes(A)[0].depart, undefined, 'sans dire ou il est');
}

console.log('\n-- l emprise d un element --');
{
  const v = Game.carteValide;
  const avec = (n2) => v(carte('a', [{ c: 1, l: 1, o: 'iso_vault', n: n2 }], 16)).cases[0];
  eq(avec(4).n, 4, 'une emprise de quatre cases est gardee');
  ok(avec(1).n === undefined, 'une case d une seule case n a rien a declarer');
  ok(avec(99).n === undefined,
     `au-dela de ${cfg.CARTE_EMPRISE_MAX} elle est ignoree : un envoi truque bloquerait la carte entiere`);
  ok(avec(-3).n === undefined, 'et une emprise negative aussi');
  /* Une emprise sur une case qui ne porte QUE du sol ne veut rien dire : c'est
     l'objet qui occupe de la place, pas le sol. */
  ok(v(carte('a', [{ c: 1, l: 1, s: 'grass', n: 4 }], 16)).cases[0].n === undefined,
     'et un sol n a pas d emprise : c est l objet qui occupe la place');

  const g = new Game();
  const k = g.enregistreCarte(A, null, carte('Parcelles', [{ c: 2, l: 2, o: 'iso_hotel', n: 5 }], 16));
  eq(k.cases[0].n, 5, 'l emprise traverse l enregistrement');
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.carte(k.id).cases[0].n, 5, 'et la sauvegarde');
}

console.log('\n-- le quart de tour --');
{
  const v = Game.carteValide;
  const avecA = (a) => v(carte('a', [{ c: 1, l: 1, o: 'mur_ville', a }], 16)).cases[0];
  eq(avecA(1).a, 1, 'un quart de tour est garde');
  eq(avecA(3).a, 3, 'trois aussi');
  ok(avecA(0).a === undefined,
     'zero ne s ecrit pas : c est le cas de presque toutes les cases, et l ecrire'
     + ' couterait un octet fois deux mille trois cents');
  ok(avecA(4).a === undefined, 'quatre est un tour complet, donc rien');
  ok(avecA(-1).a === undefined, 'ni un tour negatif');
  ok(avecA('nord').a === undefined, 'ni ce qui n est pas un nombre');
  ok(v(carte('a', [{ c: 1, l: 1, s: 'grass', a: 2 }], 16)).cases[0].a === undefined,
     'et un sol ne tourne pas : il se raboute a ses voisins, un sol tourne ferait une couture');
}

console.log(`\ncartes.test.js : ${n} verifications OK`);
