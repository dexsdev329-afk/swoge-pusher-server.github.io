'use strict';
/*
 * SWOGE Morpion — trois cases alignees, un contre un, chacun mise.
 *
 * Meme forme que le Connect 4 : ce fichier ne connait ni les soldes, ni les
 * sockets, ni les joueurs. Il connait une grille et des regles, ce qui permet
 * de le verifier EXHAUSTIVEMENT — les 9 cases, les 8 alignements, et les
 * 255 168 parties possibles — sans simuler un serveur.
 *
 * ---- une remarque qui compte pour de l'argent ----
 *
 * Le morpion est un jeu NUL a jeu parfait. Deux joueurs qui ne se trompent
 * jamais font partie nulle a tous les coups. C'est pour ca que la partie nulle
 * REND LES DEUX MISES et que la maison ne prend rien dessus : prendre une
 * commission sur une issue que les deux joueurs peuvent forcer reviendrait a
 * faire payer l'egalite, et le jeu ne se jouerait pas deux fois.
 *
 * L'horloge est courte — une partie dure une minute — parce que c'est un jeu
 * ou l'on voit le coup en une seconde, et qu'une attente de quarante-cinq
 * secondes devant trois cases est insupportable.
 */

const COLONNES = 3;
const RANGEES = 3;
const CASES = 9;

/** Les huit alignements. Ecrits une fois, en clair : c'est plus court que le
    code qui les calculerait, et on les relit sans se demander s'ils y sont
    tous. */
const LIGNES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],   // les rangees
  [0, 3, 6], [1, 4, 7], [2, 5, 8],   // les colonnes
  [0, 4, 8], [2, 4, 6],              // les diagonales
];

function nouvelle() { return new Array(CASES).fill(0); }

/** Les cases encore libres. */
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
    this.jeu = 'mp';
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
  }

  /**
   * S'asseoir en face. La partie demarre a cet instant.
   *
   * @param premier 1 ou 2 — QUI OUVRE LE JEU. Celui qui pose la table jouait
   *   toujours le premier coup, et au Puissance 4 comme au morpion c'est un
   *   avantage connu et mesurable : le premier joueur gagne la partie parfaite.
   *   Ouvrir une table revenait donc a choisir le bon cote. Le tirage vient de
   *   game.js, qui seul detient la graine du serveur ; ce module ne decide de
   *   rien, il applique. Sans valeur, on garde l'ancien comportement — les
   *   tests qui appellent rejoindre a deux arguments continuent de passer.
   */
  rejoindre(addr, now, premier) {
    if (this.phase !== ATTENTE) throw new Error('this match is no longer open');
    if (addr === this.joueurs[0]) throw new Error('you cannot join your own match');
    if (this.reserve && addr !== this.reserve)
      throw new Error('this rematch is reserved for another player');
    this.joueurs[1] = addr;
    if (premier === 1 || premier === 2) this.tour = premier;
    this.phase = EN_COURS;
    this.echeance = now + this.coupMs;
    return this;
  }

  jeton(addr) {
    if (addr === this.joueurs[0]) return 1;
    if (addr === this.joueurs[1]) return 2;
    return 0;
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

    this.grille[c] = qui;
    this.coups.push(c);

    const ligne = gagne(this.grille, c);
    if (ligne) { this._fin(qui, 'aligne', now); this.ligne = ligne; }
    else if (pleine(this.grille)) this._fin(null, 'grille pleine', now);
    else { this.tour = qui === 1 ? 2 : 1; this.echeance = now + this.coupMs; }
    return { case: c, jeton: qui };
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
      jeu: 'mp', id: this.id, mise: this.mise, phase: this.phase,
      joueurs: this.joueurs.slice(), grille: this.grille.slice(),
      tour: this.tour, gagnant: this.gagnant, raison: this.raison,
      ligne: this.ligne, coups: this.coups.slice(),
      reserve: this.reserve, revancheDe: this.revancheDe,
      reste: this.phase === EN_COURS ? Math.max(0, this.echeance - (now || 0)) : 0,
      coupMs: this.coupMs,
    };
  }
}

module.exports = {
  COLONNES, RANGEES, CASES, LIGNES, ATTENTE, EN_COURS, FINIE,
  nouvelle, jouables, gagne, pleine, Partie,
  partage: require('./puissance4').partage,
};
