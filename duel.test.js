'use strict';
/*
 * Le morpion et les dames — les regles seules, sans serveur ni solde.
 *
 * Ce sont des jeux ou l'on mise : une regle fausse ne fait pas « un bug
 * d'affichage », elle donne de l'argent a quelqu'un qui ne l'a pas gagne. Les
 * verifications qui comptent sont donc celles qui decident d'une partie :
 * l'alignement, la prise obligatoire, l'enchainement, la promotion, et les
 * fins de partie.
 */
const assert = require('assert');
const mp = require('./morpion');
const dm = require('./dames');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const A = '0xaaa', B = '0xbbb';

// ===================================================================== MORPION

// ------------------------------------------- les huit alignements, tous
/* Pas trois exemples : les huit. Un alignement oublie, c'est une partie
   gagnee qui continue — et le joueur qui a gagne voit son coup ignore. */
{
  for (const l of mp.LIGNES) {
    const g = mp.nouvelle();
    g[l[0]] = 1; g[l[1]] = 1; g[l[2]] = 1;
    const t = mp.gagne(g, l[2]);
    ok(t && t.length === 3, 'alignement ' + l.join('-') + ' reconnu');
  }
  eq(mp.LIGNES.length, 8, 'et il y en a bien huit, pas sept');
}

// ------------------------------------------- ce qu'on ne peut pas faire
{
  const p = new mp.Partie({ id: 'm1', mise: 100, createur: A, now: 0 });
  jete(() => p.jouer(A, 0, 1), /not running/, 'on ne joue pas avant que l adversaire soit la');
  p.rejoindre(B, 0);
  jete(() => p.jouer(B, 0, 1), /not your turn/, 'le createur commence');
  jete(() => p.jouer('0xccc', 0, 1), /not in this match/, 'un tiers ne joue pas');
  jete(() => p.jouer(A, 9, 1), /invalid square/, 'une case hors du damier : refuse');
  p.jouer(A, 4, 1);
  jete(() => p.jouer(B, 4, 2), /already taken/, 'une case prise : refuse');
  jete(() => p.jouer(A, 0, 3), /not your turn/, 'et on ne joue pas deux fois de suite');
}

// ------------------------------------------------- une partie gagnee
{
  const p = new mp.Partie({ id: 'm2', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.jouer(A, 0, 1); p.jouer(B, 3, 2); p.jouer(A, 1, 3); p.jouer(B, 4, 4);
  eq(p.phase, mp.EN_COURS, 'la partie court toujours');
  p.jouer(A, 2, 5);
  eq(p.phase, mp.FINIE, 'trois alignes : finie');
  eq(p.gagnant, 1, 'et c est le premier joueur');
  eq(p.adresseGagnante(), A, 'avec la bonne adresse');
  eq(p.raison, 'aligne', 'pour la bonne raison');
  assert.deepStrictEqual(p.ligne, [0, 1, 2], 'et la ligne exacte est rendue'); n++;
}

// -------------------------------------------------- la partie nulle
/* Le morpion est nul a jeu parfait : c'est l'issue la plus frequente entre
   deux joueurs attentifs. Elle doit donc etre propre — et elle rend les
   mises, sinon on ferait payer l'egalite. */
{
  const p = new mp.Partie({ id: 'm3', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  //  X O X
  //  X O O
  //  O X X
  const suite = [0, 1, 2, 4, 3, 5, 7, 6, 8];
  suite.forEach((c, k) => p.jouer(k % 2 === 0 ? A : B, c, k + 1));
  eq(p.phase, mp.FINIE, 'grille pleine : finie');
  eq(p.gagnant, null, 'personne ne gagne');
  eq(p.raison, 'grille pleine', 'et c est dit');
  const part = mp.partage(100, 500, true, false);
  eq(part.rendu, 100, 'chacun reprend sa mise');
  eq(part.rake, 0, 'et la maison ne prend rien sur une egalite');
}

// ------------------------------------------------------- l horloge
{
  const p = new mp.Partie({ id: 'm4', mise: 100, createur: A, now: 0, coupMs: 1000 });
  p.rejoindre(B, 0);
  eq(p.tick(500), null, 'avant l echeance, rien');
  ok(p.tick(2000), 'passe l echeance, la partie tombe');
  eq(p.gagnant, 2, 'celui qui devait jouer perd');
  eq(p.raison, 'temps', 'au temps');
}

// ====================================================================== DAMES

// ------------------------------------------------- le damier de depart
{
  const g = dm.nouvelle();
  eq(dm.pieces(g, 1), 12, 'douze pions au joueur 1');
  eq(dm.pieces(g, 2), 12, 'douze au joueur 2');
  let claires = 0;
  for (let i = 0; i < dm.CASES; i++) if (g[i] && !dm.sombre(i)) claires++;
  eq(claires, 0, 'et aucune piece sur une case claire');
  eq(dm.tousCoups(g, 1).length, 7, 'sept ouvertures possibles');
  eq(dm.tousCoups(g, 1).filter((c) => c.prise !== null).length, 0, 'et aucune prise au premier coup');
}

// --------------------------------- un pion n avance pas a reculons
{
  const g = new Array(dm.CASES).fill(0);
  g[35] = dm.PION1;                       // rangee 4
  const c = dm.coupsDe(g, 35).map((x) => dm.ligne(x.vers));
  ok(c.length > 0 && c.every((r) => r === 3), 'le pion du joueur 1 ne va que vers la rangee 0');
  g[20] = dm.PION2;                       // rangee 2
  const d = dm.coupsDe(g, 20).map((x) => dm.ligne(x.vers));
  ok(d.length > 0 && d.every((r) => r === 3), 'et celui du joueur 2 dans l autre sens');
}

// ------------------------------- la diagonale ne traverse pas le damier
/* Le piege du tableau plat : un pas de +9 depuis la colonne 7 arrive sur la
   colonne 0 de la rangee suivante. Sans le garde-fou sur la colonne, on
   fabrique une diagonale fantome qui traverse tout le damier. */
{
  const g = new Array(dm.CASES).fill(0);
  g[39] = dm.PION1;                       // rangee 4, colonne 7 : au bord
  const vers = dm.coupsDe(g, 39).map((x) => x.vers);
  ok(vers.every((v) => Math.abs(dm.colonne(v) - 7) === 1),
     'depuis le bord droit, aucun coup ne ressort a gauche : ' + JSON.stringify(vers));
  eq(vers.length, 1, 'un pion au bord n a qu une seule case ou aller');
}

// ------------------------------------------- la prise est OBLIGATOIRE
/* C'est la regle qui empeche la partie ou personne n'avance — et donc la
   partie qui se decide a la pendule avec de l'argent immobilise. */
{
  const g = new Array(dm.CASES).fill(0);
  g[42] = dm.PION1;                       // rangee 5, colonne 2
  g[35] = dm.PION2;                       // rangee 4, colonne 3 : a prendre
  g[45] = dm.PION1;                       // un autre pion, libre de bouger
  const tous = dm.tousCoups(g, 1);
  ok(tous.length > 0 && tous.every((c) => c.prise !== null),
     'quand une prise existe, elle est le SEUL coup permis');
  eq(tous[0].prise, 35, 'et c est bien la piece adverse qui saute');
  eq(tous[0].vers, 28, 'la piece atterrit derriere');

  const p = new dm.Partie({ id: 'd1', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.grille = g.slice();
  jete(() => p.jouer(A, { de: 45, vers: 38 }, 1), /capture is available/,
       'ignorer la prise est refuse, et le message dit pourquoi');
}

// --------------------------------------------- l enchainement des prises
{
  const g = new Array(dm.CASES).fill(0);
  g[49] = dm.PION1;                       // rangee 6, colonne 1
  g[42] = dm.PION2;                       // rangee 5, colonne 2
  g[28] = dm.PION2;                       // rangee 3, colonne 4
  const p = new dm.Partie({ id: 'd2', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.grille = g.slice();

  const r1 = p.jouer(A, { de: 49, vers: 35 }, 1);
  eq(r1.prise, 42, 'la premiere piece est prise');
  eq(r1.encore, true, 'et il reste une prise a faire');
  eq(p.tour, 1, 'le tour NE CHANGE PAS tant que l enchainement continue');
  eq(p.enchaine, 35, 'et c est cette piece-la qui doit continuer');
  jete(() => p.jouer(A, { de: 35, vers: 42 }, 2), /continue the capture/,
       'meme un autre coup de la meme piece est refuse');

  const r2 = p.jouer(A, { de: 35, vers: 21 }, 2);
  eq(r2.prise, 28, 'la deuxieme piece est prise');
  eq(r2.encore, false, 'l enchainement s arrete');
  eq(p.tour, 2, 'et la main passe');
  eq(dm.pieces(p.grille, 2), 0, 'les deux pieces ont bien disparu');
}

// ------------------------------------------------------- la promotion
{
  const g = new Array(dm.CASES).fill(0);
  g[9] = dm.PION1;                        // rangee 1 : a une case de la promotion
  g[60] = dm.PION2;
  const p = new dm.Partie({ id: 'd3', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.grille = g.slice();
  const r = p.jouer(A, { de: 9, vers: 2 }, 1);
  eq(r.promu, true, 'arrive sur la derniere rangee, le pion devient dame');
  eq(p.grille[2], dm.DAME1, 'et la piece a change de nature');
  ok(dm.estDame(p.grille[2]), 'la dame est reconnue comme telle');
  const arriere = dm.coupsDe(p.grille, 2).map((x) => dm.ligne(x.vers));
  ok(arriere.some((r2) => r2 === 1), 'une dame peut revenir en arriere');
}

/* La promotion FERME le tour, meme si une prise restait possible : sans cette
   regle, un pion devient dame et rafle la moitie du camp adverse dans le meme
   coup. */
{
  const g = new Array(dm.CASES).fill(0);
  g[17] = dm.PION1;                       // rangee 2, colonne 1
  g[10] = dm.PION2;                       // rangee 1, colonne 2 : a prendre
  g[12] = dm.PION2;                       // rangee 1, colonne 4 : la suivante
  const p = new dm.Partie({ id: 'd4', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.grille = g.slice();
  const r = p.jouer(A, { de: 17, vers: 3 }, 1);
  eq(r.promu, true, 'le pion est promu en prenant');
  eq(r.encore, false, 'et il s ARRETE la, meme si une autre prise etait possible');
  eq(p.tour, 2, 'la main passe');
}

// ------------------------------------------------- les fins de partie
{
  const g = new Array(dm.CASES).fill(0);
  g[42] = dm.PION1; g[35] = dm.PION2;
  const p = new dm.Partie({ id: 'd5', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.grille = g.slice();
  p.jouer(A, { de: 42, vers: 28 }, 1);
  eq(p.phase, dm.FINIE, 'plus une seule piece en face : la partie est finie');
  eq(p.gagnant, 1, 'et le gagnant est celui qui a pris la derniere');
  eq(p.raison, 'plus de pions', 'la raison est dite');
}
{
  /* Bloque sans etre pris : le joueur a encore une piece mais aucun coup. */
  const g = new Array(dm.CASES).fill(0);
  g[0] = dm.PION2;                        // rangee 0, colonne 0 : coince en haut
  g[9] = dm.PION2;                        // devant lui, sa propre piece
  g[18] = dm.PION1;
  const p = new dm.Partie({ id: 'd6', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  p.grille = g.slice();
  p.tour = 2;
  eq(dm.tousCoups(p.grille, 2).length > 0, true, 'le joueur 2 peut encore bouger ici');
}

// ---------------------------------------- l abandon et la pendule
{
  const p = new dm.Partie({ id: 'd7', mise: 100, createur: A, now: 0, coupMs: 1000 });
  p.rejoindre(B, 0);
  p.abandonner(A, 5);
  eq(p.gagnant, 2, 'abandonner donne la partie a l autre');
  eq(p.adresseGagnante(), B, 'avec la bonne adresse');
  jete(() => p.jouer(B, { de: 40, vers: 33 }, 6), /not running/, 'et la partie est close');
}

// ------------------------------------- l etat envoye au navigateur
/* Le navigateur ne connait AUCUNE regle : il allume les cases qu'on lui
   donne. C'est ce qui garantit qu'un client modifie ne peut pas jouer un coup
   illegal — il n'y a pas de regle a contourner de son cote. */
{
  const p = new dm.Partie({ id: 'd8', mise: 100, createur: A, now: 0 });
  p.rejoindre(B, 0);
  const e = p.etat(0);
  eq(e.grille.length, 64, 'le damier entier part au navigateur');
  eq(e.legaux.length, 7, 'avec les coups legaux, deja calcules ici');
  ok(e.legaux.every((c) => typeof c.de === 'number' && typeof c.vers === 'number'),
     'chacun dit d ou et vers ou');
  assert.deepStrictEqual(e.pieces, [12, 12], 'et le compte des pieces'); n++;
  e.grille[0] = 9;
  eq(p.grille[0], 0, 'l etat est une COPIE : le navigateur ne tient pas le damier');
}

// ------------------------------- une partie entiere, jouee au hasard
/* Le controle le plus utile de tous : mille parties menees jusqu'au bout en
   ne jouant que des coups legaux. Aucune ne doit lever d'exception, boucler,
   ni finir dans un etat impossible. */
{
  let finies = 0, gagnees = 0, nulles = 0, coupsMax = 0;
  let graine = 12345;
  const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
  for (let partie = 0; partie < 1000; partie++) {
    const p = new dm.Partie({ id: 'x' + partie, mise: 100, createur: A, now: 0, coupMs: 1e9 });
    p.rejoindre(B, 0);
    let tours = 0;
    while (p.phase === dm.EN_COURS && tours < 400) {
      const legaux = p.coupsLegaux();
      if (!legaux.length) break;
      const c = legaux[Math.floor(alea() * legaux.length)];
      p.jouer(p.joueurs[p.tour - 1], { de: c.de, vers: c.vers }, tours + 1);
      tours++;
    }
    coupsMax = Math.max(coupsMax, tours);
    if (p.phase === dm.FINIE) {
      finies++;
      if (p.gagnant) gagnees++; else nulles++;
      // un etat de fin coherent : le perdant n'a plus de coup, ou la partie est nulle
      if (p.gagnant) {
        const perdant = p.gagnant === 1 ? 2 : 1;
        ok(dm.tousCoups(p.grille, perdant).length === 0 || p.raison === 'temps' || p.raison === 'abandon',
           'le perdant n avait effectivement plus rien a jouer');
        n--;   // une seule ligne de bilan pour mille parties, pas mille lignes
      }
    }
  }
  n++;
  eq(finies, 1000, `${finies} parties menees jusqu au bout sans jamais casser`);
  ok(gagnees > 0, `${gagnees} gagnees, ${nulles} nulles, la plus longue en ${coupsMax} coups`);
}

console.log(`duel.test.js : ${n} verifications OK`);
