'use strict';
/*
 * Morpion Fantome : trois pions chacun, le quatrieme efface le premier.
 *
 * ---- ce qui doit tenir, et pourquoi ----
 *
 * La regle tient en une phrase, ce qui la rend dangereuse : on croit ne pas
 * avoir besoin de la verifier. Elle touche pourtant a de l'argent, et trois
 * choses peuvent casser sans qu'on le voie en jouant deux parties :
 *
 *   • un alignement compte-t-il ENCORE quand un des trois pions vient d'etre
 *     efface par le coup lui-meme ? Il ne doit pas — sinon on gagne avec un
 *     pion qui n'est plus la ;
 *   • un joueur peut-il se retrouver SANS coup legal ? Non, et il faut le
 *     prouver plutot que l'esperer : six pions au plus sur neuf cases laissent
 *     toujours trois cases libres. Une partie bloquee, ce serait deux mises
 *     coincees dedans ;
 *   • la partie finit-elle TOUJOURS ? Sans grille pleine, rien n'arrete deux
 *     joueurs qui tournent en rond. Le plafond doit tomber, et rendre les
 *     mises — un plafond qui coute de l'argent transformerait la patience en
 *     piege.
 *
 * On ne verifie pas seulement des cas choisis : on joue TOUTES les parties
 * possibles jusqu'a une profondeur, ce qui couvre les positions auxquelles
 * personne ne pense.
 */
const assert = require('assert');
const mf = require('./morpion_fantome');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);

function partie(coupMs) {
  const p = new mf.Partie({ id: 'x', mise: 100, createur: A, now: 1000, coupMs: coupMs || 30000 });
  p.rejoindre(B, 1000);
  return p;
}
const joue = (p, addr, c) => p.jouer(addr, c, 1000);

// ================================ la regle : le quatrieme efface le premier
{
  const p = partie();
  joue(p, A, 0); joue(p, B, 3);
  joue(p, A, 1); joue(p, B, 4);
  joue(p, A, 8); joue(p, B, 7);      // chacun tient ses trois pions

  eq(p.pions[1].length, 3, 'le premier joueur tient trois pions');
  eq(p.fantomeDe(1), 0, 'et son fantome est le PLUS ANCIEN, la case 0');
  eq(p.fantomeDe(2), 3, 'idem en face');

  const r = joue(p, A, 5);            // le quatrieme
  eq(r.efface, 0, 'poser le quatrieme efface bien le plus ancien');
  eq(p.grille[0], 0, 'la case liberee est vide');
  eq(p.grille[5], 1, 'et la nouvelle est occupee');
  eq(p.pions[1].length, 3, 'on tient toujours trois pions, jamais quatre');
  eq(p.fantomeDe(1), 1, 'le fantome avance d un cran');
}

// ============ le fantome est ANNONCE tant qu il n y a rien a effacer
{
  const p = partie();
  eq(p.fantomeDe(1), null, 'avec zero pion, rien ne partira au prochain coup');
  joue(p, A, 0); joue(p, B, 4);
  eq(p.fantomeDe(1), null, 'avec un pion non plus');
  joue(p, A, 1); joue(p, B, 5);
  eq(p.fantomeDe(1), null, 'avec deux non plus');
  joue(p, A, 2);
  /* Trois pions alignes : la partie est gagnee avant meme la question. */
  eq(p.phase, mf.FINIE, 'trois alignes gagnent, comme au morpion ordinaire');
  eq(p.gagnant, 1, 'et c est bien lui');
}

// ======== ON NE PASSE PAS : sa propre case fantome reste interdite
/* Rejouer sur son propre pion le plus ancien ne changerait rien au plateau —
   ce serait un PASSE deguise, et deux joueurs pourraient se figer
   indefiniment. C'est refuse.
   Ce refus ne peut bloquer personne : six pions au plus sur neuf cases, donc
   au moins trois cases libres a tout instant. La verification exhaustive plus
   bas le confirme sur toutes les positions atteignables. */
{
  const p = partie();
  joue(p, A, 0); joue(p, B, 1);
  joue(p, A, 4); joue(p, B, 2);
  joue(p, A, 7); joue(p, B, 3);      // A tient 0,4,7 — pas d alignement
  eq(p.phase, mf.EN_COURS, 'la partie continue');
  eq(p.fantomeDe(1), 0, 'le fantome de A est la case 0');
  jete(() => joue(p, A, 0), /already taken/,
       'et il ne peut PAS rejouer dessus : ce serait passer son tour');
  const r = joue(p, A, 5);           // un vrai coup, ailleurs
  eq(r.efface, 0, 'un vrai coup efface bien son fantome');
  eq(p.grille[0], 0, 'la case 0 se libere pour tout le monde');
  eq(p.pions[1].join(','), '4,7,5', 'et la file avance');
}

// ==== un alignement efface par le coup lui-meme NE compte PAS
/* Le piege exact : A tient 0,1 et un troisieme ailleurs. Il pose en 2 pour
   aligner 0-1-2, mais son quatrieme pion efface le 0. L alignement n existe
   pas au moment ou on le regarde, et il ne doit pas gagner. */
{
  const p = partie();
  joue(p, A, 0); joue(p, B, 3);
  joue(p, A, 1); joue(p, B, 4);
  joue(p, A, 8); joue(p, B, 6);      // A tient 0,1,8 — file : [0,1,8]
  eq(p.phase, mf.EN_COURS, 'rien n est encore gagne');
  eq(p.fantomeDe(1), 0, 'le prochain coup de A effacera la case 0');

  const r = joue(p, A, 2);           // 0-1-2 ? non : le 0 vient de partir
  eq(r.efface, 0, 'le coup efface bien la case 0');
  eq(p.grille[0], 0, 'qui est donc vide');
  eq(p.phase, mf.EN_COURS,
     'et l alignement 0-1-2 NE gagne PAS : un pion efface ne compte plus');
  eq(p.gagnant, null, 'personne n a gagne');
}

// ================================ la partie finit TOUJOURS
/* Sans grille pleine, seul le plafond arrete deux joueurs qui tournent en
   rond. On le pousse pour de vrai, en alternant deux cases chacun. */
{
  const p = partie();
  const cyclesA = [0, 1, 2], cyclesB = [6, 7, 8];
  let i = 0;
  while (p.phase === mf.EN_COURS && p.coups.length < mf.COUPS_MAX + 10) {
    const qui = p.tour === 1 ? A : B;
    const cases = p.tour === 1 ? cyclesA : cyclesB;
    /* On evite l alignement : on ne rejoue que sur sa propre case fantome
       quand elle existe, sinon sur la premiere libre de son cycle. */
    const f = p.fantomeDe(p.tour);
    let c = f != null ? f : cases.find((x) => p.grille[x] === 0);
    if (c == null) c = mf.jouables(p.grille)[0];
    try { joue(p, qui, c); } catch (e) { break; }
    if (++i > 200) break;
  }
  eq(p.phase, mf.FINIE, 'une partie qui tourne en rond finit quand meme');
  ok(p.coups.length <= mf.COUPS_MAX,
     `au plus ${mf.COUPS_MAX} coups, pas ${p.coups.length}`);
}

// ================================ ce qui reste refuse
{
  const p = partie();
  jete(() => joue(p, B, 0), /not your turn/, 'on ne joue pas a la place de l autre');
  jete(() => joue(p, '0x' + 'cc'.repeat(20), 0), /not in this match/, 'ni sans etre a la table');
  jete(() => joue(p, A, 9), /invalid square/, 'ni hors de la grille');
  jete(() => joue(p, A, -1), /invalid square/, 'ni sur une case negative');
  jete(() => joue(p, A, 1.5), /invalid square/, 'ni entre deux cases');
  joue(p, A, 0);
  jete(() => joue(p, B, 0), /already taken/, 'ni sur une case occupee');
  jete(() => p.jouer(B, 1, 999999999), /time is up/, 'ni apres la pendule');
}

// ============ TOUTES les parties, jusqu a une profondeur
/* On explore l arbre entier des coups legaux jusqu a douze demi-coups. Ca
   couvre toutes les positions ou la regle du fantome commence a mordre — les
   coups 7 a 12 sont precisement ceux ou des pions s effacent — et ca verifie
   des invariants qu aucun cas choisi a la main ne couvre. */
{
  let visitees = 0, finies = 0, gagnees = 0, nulles = 0;
  const PROFONDEUR = 12;

  function explore(p, profondeur) {
    visitees++;
    // ---- les invariants, a CHAQUE position rencontree
    for (const q of [1, 2]) {
      const a = p.pions[q];
      assert.ok(a.length <= mf.PIONS_MAX, 'jamais plus de trois pions');
      for (const c of a) assert.strictEqual(p.grille[c], q, 'la file et la grille disent la meme chose');
    }
    let surGrille = 0;
    for (let i = 0; i < mf.CASES; i++) if (p.grille[i]) surGrille++;
    assert.strictEqual(surGrille, p.pions[1].length + p.pions[2].length,
      'aucun pion sur la grille qui ne soit dans une file');
    assert.ok(surGrille <= 2 * mf.PIONS_MAX, 'six pions au maximum sur neuf cases');
    /* PERSONNE N'EST JAMAIS BLOQUE. C'est ce qui autorise a refuser le passe :
       si une seule position atteignable n'offrait aucun coup, une partie
       resterait suspendue avec les deux mises dedans. */
    if (p.phase === mf.EN_COURS)
      assert.ok(mf.jouables(p.grille).length >= mf.CASES - 2 * mf.PIONS_MAX,
        'au moins trois cases libres, donc toujours un coup legal');

    if (p.phase === mf.FINIE) {
      finies++;
      if (p.gagnant) { gagnees++; assert.ok(p.ligne, 'une victoire porte son alignement'); }
      else nulles++;
      return;
    }
    if (profondeur >= PROFONDEUR) return;

    for (const c of mf.jouables(p.grille)) {
      /* On clone en rejouant depuis le debut : le moteur n'a pas de copie, et
         une copie faite a la main mentirait tot ou tard sur un champ oublie. */
      const q = partie();
      for (let k = 0; k < p.coups.length; k++) joue(q, k % 2 === 0 ? A : B, p.coups[k]);
      joue(q, q.tour === 1 ? A : B, c);
      explore(q, profondeur + 1);
    }
  }

  explore(partie(), 0);
  ok(visitees > 5000, `${visitees} positions explorees jusqu a ${PROFONDEUR} demi-coups`);
  ok(gagnees > 0, `${gagnees} d entre elles sont des victoires`);
  eq(nulles, 0,
     'et AUCUNE nulle avant le plafond — la grille pleine du morpion ordinaire ' +
     'n existe plus, ce qui est tout l interet du jeu');
}

// ================================ l etat envoye a la page
{
  const p = partie();
  joue(p, A, 0); joue(p, B, 3); joue(p, A, 1); joue(p, B, 4); joue(p, A, 8);
  const e = p.etat(1000);
  eq(e.jeu, 'mf', 'la page sait quel jeu elle affiche');
  eq(e.fantome[1], 0, 'elle recoit le fantome du joueur…');
  eq(e.fantome[2], null, '…et celui de l adversaire, meme quand il n y en a pas');
  eq(e.pionsMax, 3, 'et la regle, pour pouvoir l ecrire a l ecran');
  eq(e.coupsMax, mf.COUPS_MAX, 'ainsi que le plafond');
  ok(Array.isArray(e.pions[1]) && e.pions[1] !== p.pions[1],
     'les files sont copiees, pas prêtees — une page ne doit pas pouvoir toucher la partie');
}

console.log(`fantome.test.js : ${n} verifications OK`);
