'use strict';
/*
 * SWOGE Connect 4 — un contre un, chacun mise, le gagnant ramasse.
 *
 * Ce fichier ne connait ni les soldes, ni les sockets, ni les joueurs : il
 * connait une grille et des regles. C'est ce qui permet de le verifier
 * EXHAUSTIVEMENT — toutes les positions gagnantes de la grille, pas un
 * echantillon — sans avoir a simuler une partie ni un serveur.
 *
 * Trois decisions de regles, parce qu'elles changent tout :
 *
 *  1. LA GRILLE EST UN TABLEAU PLAT DE 42 CASES, pas un tableau de tableaux.
 *     Une position est un entier, un alignement est un pas constant, et la
 *     detection se ramene a quatre pas : +1 (horizontal), +7 (vertical), +8 et
 *     +6 (les deux diagonales). Avec des lignes et des colonnes separees, la
 *     meme detection demande quatre boucles imbriquees qui se trompent de bord.
 *
 *  2. LE GAGNANT EST CHERCHE AUTOUR DU DERNIER COUP, pas sur toute la grille.
 *     Un alignement ne peut apparaitre qu'en passant par le jeton qu'on vient
 *     de poser. Balayer les 42 cases a chaque coup marche aussi, mais coute
 *     soixante-dix fois plus pour le meme resultat.
 *
 *  3. UNE PARTIE NE PEUT PAS RESTER SUSPENDUE. Chaque coup a une echeance : de
 *     l'argent est bloque tant que la partie n'est pas finie, et un joueur qui
 *     ferme son onglet ne doit pas pouvoir geler la mise de l'autre
 *     indefiniment. Le temps est passe de l'exterieur, jamais lu ici — c'est ce
 *     qui rend le deroule rejouable a la milliseconde dans les tests.
 */

const COLONNES = 7;
const RANGEES = 6;
const CASES = COLONNES * RANGEES;

/** Une grille vide : 42 cases a zero. 1 et 2 sont les deux joueurs. */
function nouvelle() {
  return new Array(CASES).fill(0);
}

/** L'indice de la case (colonne, rangee), rangee 0 tout en bas. */
function idx(col, rangee) {
  return rangee * COLONNES + col;
}

/** La premiere rangee libre d'une colonne, ou -1 si elle est pleine. */
function creux(grille, col) {
  if (!(col >= 0 && col < COLONNES)) return -1;
  for (let r = 0; r < RANGEES; r++) if (grille[idx(col, r)] === 0) return r;
  return -1;
}

/** Les colonnes ou l'on peut encore jouer. */
function jouables(grille) {
  const out = [];
  for (let c = 0; c < COLONNES; c++) if (creux(grille, c) >= 0) out.push(c);
  return out;
}

/**
 * Pose un jeton. Renvoie l'indice de la case remplie.
 * La grille est modifiee EN PLACE : une partie garde une seule grille, et la
 * recopier a chaque coup ferait diverger l'etat sauve de l'etat joue.
 */
function poser(grille, col, joueur) {
  const r = creux(grille, col);
  if (r < 0) throw new Error('column full');
  const i = idx(col, r);
  grille[i] = joueur;
  return i;
}

/*
 * Les quatre directions d'alignement, en pas sur le tableau plat.
 * Le garde-fou est la colonne : un pas de +1 depuis la colonne 6 arrive sur la
 * colonne 0 de la rangee suivante. On compare donc les colonnes a chaque pas au
 * lieu de se fier a l'indice, sinon un alignement fantome traverse la grille.
 */
const PAS = [1, COLONNES, COLONNES + 1, COLONNES - 1];

/** Combien de jetons alignes autour de `depart`, dans la direction `pas`. */
function alignes(grille, depart, pas) {
  const qui = grille[depart];
  if (!qui) return 0;
  let n = 1;
  for (const sens of [1, -1]) {
    let i = depart;
    for (;;) {
      const avant = i;
      i += pas * sens;
      if (i < 0 || i >= CASES) break;
      // le saut de ligne : deux cases voisines sur le tableau plat peuvent etre
      // aux deux bouts de la grille
      const dc = Math.abs((i % COLONNES) - (avant % COLONNES));
      if (dc > 1) break;
      if (grille[i] !== qui) break;
      n++;
    }
  }
  return n;
}

/** Le dernier coup est-il gagnant ? Renvoie les cases alignees, ou null. */
function gagne(grille, dernier) {
  if (dernier == null || !grille[dernier]) return null;
  for (const pas of PAS) {
    if (alignes(grille, dernier, pas) < 4) continue;
    // on remonte la ligne pour rendre les cases exactes : le navigateur les
    // allume, et une case approchee se verrait tout de suite
    const qui = grille[dernier];
    const cases = [dernier];
    for (const sens of [1, -1]) {
      let i = dernier;
      for (;;) {
        const avant = i;
        i += pas * sens;
        if (i < 0 || i >= CASES) break;
        if (Math.abs((i % COLONNES) - (avant % COLONNES)) > 1) break;
        if (grille[i] !== qui) break;
        cases.push(i);
      }
    }
    return cases.sort((a, b) => a - b);
  }
  return null;
}

/** La grille est-elle pleine ? */
function pleine(grille) {
  for (let i = 0; i < CASES; i++) if (grille[i] === 0) return false;
  return true;
}

// --------------------------------------------------------------- une partie

const ATTENTE = 'attente';   // creee, on attend un adversaire
const EN_COURS = 'en_cours';
const FINIE = 'finie';

/**
 * Une partie. Aucun minuteur a l'interieur : l'heure vient du dehors, ce qui
 * rend le deroule rejouable a la milliseconde dans les tests — et surtout
 * verifiable, ce qu'un setTimeout ne serait pas.
 */
class Partie {
  constructor(o) {
    this.jeu = 'p4';
    this.id = o.id;
    this.mise = o.mise;
    this.coupMs = o.coupMs || 45000;
    this.joueurs = [o.createur, null];   // index 0 -> jeton 1, index 1 -> jeton 2
    /* Une revanche est une table comme une autre, a un detail pres : elle est
       NOMINATIVE. Reserver la place plutot qu'inventer un second mecanisme
       fait tomber gratuitement le debit, le remboursement a l'expiration et
       le reglement — tout ce qui touche a l'argent est deja verifie ici. */
    this.reserve = o.reserve || null;      // adresse seule autorisee a s'asseoir
    this.revancheDe = o.revancheDe || null;
    this.grille = nouvelle();
    this.tour = 1;                       // le createur commence
    this.phase = ATTENTE;
    this.creeA = o.now;
    this.echeance = 0;                   // date limite du coup en cours
    this.coups = [];                     // l'historique, pour rejouer la partie
    this.gagnant = null;                 // 1, 2 ou null
    this.raison = null;                  // 'aligne' | 'grille pleine' | 'temps' | 'abandon'
    this.ligne = null;                   // les 4 cases gagnantes
  }

  /** L'adversaire s'assied. La partie demarre a cet instant. */
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

  /** Le numero de jeton d'un joueur, ou 0 s'il n'est pas dans la partie. */
  jeton(addr) {
    if (addr === this.joueurs[0]) return 1;
    if (addr === this.joueurs[1]) return 2;
    return 0;
  }

  jouer(addr, col, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    if (qui !== this.tour) throw new Error('not your turn');
    if (now > this.echeance) throw new Error('time is up');
    const c = Number(col);
    if (!Number.isInteger(c) || c < 0 || c >= COLONNES) throw new Error('invalid column');

    const i = poser(this.grille, c, qui);
    this.coups.push(c);

    const ligne = gagne(this.grille, i);
    if (ligne) { this._fin(qui, 'aligne', now); this.ligne = ligne; }
    else if (pleine(this.grille)) this._fin(null, 'grille pleine', now);
    else { this.tour = qui === 1 ? 2 : 1; this.echeance = now + this.coupMs; }
    return { case: i, colonne: c, jeton: qui };
  }

  /**
   * Fait avancer l'horloge. Un joueur qui laisse filer son temps perd : sans
   * ca, fermer son onglet gelerait la mise de l'autre pour toujours.
   */
  tick(now) {
    if (this.phase !== EN_COURS || now <= this.echeance) return null;
    const perdant = this.tour;
    this._fin(perdant === 1 ? 2 : 1, 'temps', now);
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

  /** L'adresse du gagnant, ou null (partie nulle ou non finie). */
  adresseGagnante() {
    return this.gagnant ? this.joueurs[this.gagnant - 1] : null;
  }

  /** Ce qu'on envoie au navigateur. */
  etat(now) {
    return {
      jeu: 'p4', id: this.id, mise: this.mise, phase: this.phase,
      joueurs: this.joueurs.slice(), grille: this.grille.slice(),
      tour: this.tour, gagnant: this.gagnant, raison: this.raison,
      ligne: this.ligne, coups: this.coups.slice(),
      reserve: this.reserve, revancheDe: this.revancheDe,
      reste: this.phase === EN_COURS ? Math.max(0, this.echeance - (now || 0)) : 0,
      coupMs: this.coupMs,
    };
  }
}

/**
 * Le partage du pot.
 *
 * La commission est prise sur LE POT ENTIER, pas sur le gain : sur une table a
 * deux ou l'un met 100 et l'autre 100, 5 % du pot vaut 10, et le gagnant
 * repart avec 190. Prendre 5 % du seul benefice rapporterait moitie moins et ne
 * correspondrait pas a ce qui est annonce au joueur.
 *
 * Sur une partie nulle, chacun reprend sa mise et la maison ne prend rien :
 * personne n'a gagne, il n'y a rien a partager. C'est un choix, pas une regle
 * du jeu — d'ou le drapeau.
 */
function partage(mise, rakeBps, nul, rakeSurNul) {
  const pot = mise * 2;
  if (nul && !rakeSurNul) return { pot, rake: 0, gain: 0, rendu: mise };
  const rake = Math.floor(pot * rakeBps / 10000);
  if (nul) {
    // moitie-moitie de ce qui reste, arrondi vers le bas : le reliquat reste a
    // la maison plutot que d'etre cree a partir de rien
    const rendu = Math.floor((pot - rake) / 2);
    return { pot, rake: pot - rendu * 2, gain: 0, rendu };
  }
  return { pot, rake, gain: pot - rake, rendu: 0 };
}

module.exports = {
  COLONNES, RANGEES, CASES, ATTENTE, EN_COURS, FINIE,
  nouvelle, idx, creux, jouables, poser, alignes, gagne, pleine,
  Partie, partage,
};
