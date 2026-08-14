'use strict';
/*
 * SWOGE Morpion Fantome — trois pions chacun, le quatrieme efface le premier.
 *
 * ---- pourquoi ce jeu existe ----
 *
 * Le morpion ordinaire est NUL a jeu parfait : deux joueurs qui ne se trompent
 * jamais font partie nulle a tous les coups, et le jeu meurt le jour ou les
 * deux ont compris. C'est pour ca que la nulle y rend les deux mises et que la
 * maison n'y prend rien — on ne peut pas faire payer une egalite que les deux
 * joueurs peuvent forcer.
 *
 * Ici, la grille ne se remplit jamais. Chacun n'a que TROIS pions sur le
 * plateau ; poser le quatrieme retire le plus ancien des siens. Il n'y a donc
 * pas de partie nulle par grille pleine, et la position bouge en permanence :
 * la menace qu'on vient de poser disparaitra dans deux coups, et l'adversaire
 * le sait aussi.
 *
 * ---- ce qui rend le jeu jouable, et qui n'est pas evident ----
 *
 * LE PION QUI VA PARTIR EST ANNONCE. `fantome` designe, a chaque instant, le
 * pion que le prochain coup du joueur au trait effacera. Sans lui, un joueur
 * pose un pion gagnant, voit son alignement s'effacer, et conclut que le jeu
 * triche. On ne cache pas la regle pour fabriquer de la surprise : la surprise
 * qu'on fabrique comme ca s'appelle un bug, pour celui qui la subit.
 *
 * ---- et la partie qui ne finit jamais ----
 *
 * Sans grille pleine, rien n'arrete deux joueurs qui tournent en rond. On
 * plafonne donc les coups. Passe le plafond, c'est une nulle — traitee comme
 * celle du morpion ordinaire, les deux mises rendues, la maison ne prend rien.
 * Un plafond qui coute de l'argent transformerait la patience en piege.
 */

const COLONNES = 3;
const RANGEES = 3;
const CASES = 9;

/** Combien de pions un joueur tient sur le plateau. Au-dela, le plus ancien
    part. C'est TOUTE la regle du jeu. */
const PIONS_MAX = 3;

/** Le nombre de coups au bout duquel on declare la nulle. Assez haut pour
    qu'une vraie partie ne le touche jamais, assez bas pour qu'un blocage ne
    dure pas une heure : soixante coups, c'est dix pions poses chacun apres
    que les six premiers sont en place. */
const COUPS_MAX = 60;

/** Les huit alignements, ecrits en clair. */
const LIGNES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function nouvelle() { return new Array(CASES).fill(0); }

function jouables(grille) {
  const out = [];
  for (let i = 0; i < CASES; i++) if (grille[i] === 0) out.push(i);
  return out;
}

/** L'alignement gagnant qui passe par le dernier coup, ou null. */
function gagne(grille, dernier) {
  if (dernier == null || !grille[dernier]) return null;
  const qui = grille[dernier];
  for (const l of LIGNES) {
    if (l.indexOf(dernier) < 0) continue;
    if (grille[l[0]] === qui && grille[l[1]] === qui && grille[l[2]] === qui) return l.slice();
  }
  return null;
}

/* La grille ne se remplit jamais : six pions au maximum pour neuf cases. La
   fonction existe pour que le moteur ait la meme forme que les autres, et elle
   dit la verite — elle ne rendra jamais vrai. */
function pleine(grille) {
  for (let i = 0; i < CASES; i++) if (grille[i] === 0) return false;
  return true;
}

// --------------------------------------------------------------- une partie

const ATTENTE = 'attente';
const EN_COURS = 'en_cours';
const FINIE = 'finie';

class Partie {
  constructor(o) {
    this.jeu = 'mf';
    this.id = o.id;
    this.mise = o.mise;
    this.coupMs = o.coupMs || 20000;
    this.joueurs = [o.createur, null];
    this.reserve = o.reserve || null;
    this.revancheDe = o.revancheDe || null;
    this.grille = nouvelle();
    this.tour = 1;
    this.phase = ATTENTE;
    this.creeA = o.now;
    this.echeance = 0;
    this.coups = [];
    this.gagnant = null;
    this.raison = null;
    this.ligne = null;
    /* Les cases de chacun, DANS L'ORDRE OU ELLES ONT ETE POSEES. C'est la
       seule chose que le morpion ordinaire n'a pas besoin de retenir, et c'est
       toute la difference : sans l'ordre, on ne sait pas lequel efface. */
    this.pions = { 1: [], 2: [] };
    this.efface = [];       // les cases liberees, coup par coup
  }

  rejoindre(addr, now) {
    if (this.phase !== ATTENTE) throw new Error('this match is no longer open');
    if (addr === this.joueurs[0]) throw new Error('you cannot join your own match');
    if (this.reserve && addr !== this.reserve)
      throw new Error('this rematch is reserved for another player');
    this.joueurs[1] = addr;
    this.phase = EN_COURS;
    this.echeance = now + this.coupMs;
    return this;
  }

  jeton(addr) {
    if (addr === this.joueurs[0]) return 1;
    if (addr === this.joueurs[1]) return 2;
    return 0;
  }

  /**
   * Le pion que le PROCHAIN coup de `qui` effacera, ou null s'il lui reste de
   * la place. Annonce a l'ecran : c'est ce qui separe une regle d'un piege.
   */
  fantomeDe(qui) {
    const a = this.pions[qui] || [];
    return a.length >= PIONS_MAX ? a[0] : null;
  }

  jouer(addr, coup, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    if (qui !== this.tour) throw new Error('not your turn');
    if (now > this.echeance) throw new Error('time is up');
    const c = Number(coup);
    if (!Number.isInteger(c) || c < 0 || c >= CASES) throw new Error('invalid square');
    if (this.grille[c] !== 0) throw new Error('square already taken');

    /* ON EFFACE AVANT DE POSER, et l'ordre est tout.
       L'alignement se juge sur le plateau TEL QU'IL EST une fois le coup
       joue. Poser d'abord et effacer ensuite ferait gagner un joueur avec un
       pion qui disparait dans le meme geste — il verrait sa ligne s'afficher
       gagnante puis s'evaporer, et conclurait que le jeu triche.

       On ne peut pas jouer sur une case occupee, y compris la sienne : ca
       rendrait le passage possible et deux joueurs pourraient se figer
       indefiniment. Aucun risque de blocage en echange — six pions au plus
       sur neuf cases, il reste toujours au moins trois cases libres. */
    let parti = null;
    const a = this.pions[qui];
    if (a.length >= PIONS_MAX) {
      parti = a.shift();
      this.grille[parti] = 0;
    }

    this.grille[c] = qui;
    a.push(c);
    this.coups.push(c);
    this.efface.push(parti);

    const ligne = gagne(this.grille, c);
    if (ligne) { this._fin(qui, 'aligne', now); this.ligne = ligne; }
    /* Pas de grille pleine ici — elle ne peut pas arriver. Ce qui arrete une
       partie qui tourne en rond, c'est le plafond de coups, et il rend les
       mises comme une nulle ordinaire. */
    else if (this.coups.length >= COUPS_MAX) this._fin(null, 'trop long', now);
    else { this.tour = qui === 1 ? 2 : 1; this.echeance = now + this.coupMs; }
    return { case: c, jeton: qui, efface: parti };
  }

  tick(now) {
    if (this.phase !== EN_COURS || now <= this.echeance) return null;
    this._fin(this.tour === 1 ? 2 : 1, 'temps', now);
    return this;
  }

  abandonner(addr, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    this._fin(qui === 1 ? 2 : 1, 'abandon', now);
    return this;
  }

  _fin(gagnant, raison, now) {
    this.phase = FINIE;
    this.gagnant = gagnant;
    this.raison = raison;
    this.finA = now;
    this.echeance = 0;
  }

  adresseGagnante() { return this.gagnant ? this.joueurs[this.gagnant - 1] : null; }

  etat(now) {
    return {
      jeu: 'mf', id: this.id, mise: this.mise, phase: this.phase,
      joueurs: this.joueurs.slice(), grille: this.grille.slice(),
      tour: this.tour, gagnant: this.gagnant, raison: this.raison,
      ligne: this.ligne, coups: this.coups.slice(),
      /* Ce que la page doit pouvoir peindre en gris : le pion qui partira au
         prochain coup de chacun. Les DEUX sont envoyes — voir le fantome de
         l'adversaire fait partie du jeu, c'est meme la seule information qui
         permet de prevoir son coup. */
      pions: { 1: this.pions[1].slice(), 2: this.pions[2].slice() },
      fantome: { 1: this.fantomeDe(1), 2: this.fantomeDe(2) },
      pionsMax: PIONS_MAX, coupsMax: COUPS_MAX,
      reserve: this.reserve, revancheDe: this.revancheDe,
      reste: this.phase === EN_COURS ? Math.max(0, this.echeance - (now || 0)) : 0,
      coupMs: this.coupMs,
    };
  }
}

module.exports = {
  COLONNES, RANGEES, CASES, LIGNES, PIONS_MAX, COUPS_MAX,
  ATTENTE, EN_COURS, FINIE,
  nouvelle, jouables, gagne, pleine, Partie,
  partage: require('./puissance4').partage,
};
