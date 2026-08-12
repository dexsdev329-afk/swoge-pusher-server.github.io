'use strict';
/*
 * SWOGE Mines — une grille, des bombes cachees, on encaisse avant de tomber.
 *
 * Grille de 25 cases (5x5). Le joueur choisit le nombre de bombes, puis
 * retourne les cases une par une. Chaque case sure fait monter le
 * multiplicateur ; une bombe et la mise est perdue.
 *
 * Trois decisions de regles, parce qu'elles changent tout :
 *
 *  1. Les bombes sont placees AU DEPART, une fois pour toutes, a partir de la
 *     graine du serveur. Les tirer au moment du clic laisserait la maison
 *     decider apres coup — et la promesse d'equite verifiable ne tiendrait
 *     plus. Le joueur peut recalculer la grille entiere une fois la graine
 *     revelee, et verifier qu'elle n'a pas bouge.
 *
 *  2. L'avantage de la maison est preleve UNE SEULE FOIS, sur le
 *     multiplicateur final. C'est la difference avec le Hi-Lo, ou il est
 *     preleve a chaque pas — et elle est voulue. Au Hi-Lo un pas est un pari
 *     autonome : on decide de le prendre en connaissant sa cote. Ici on
 *     s'engage sur une grille ; prelever a chaque case donnerait 0,97^20 = 54 %
 *     de retour a qui va au bout, une punition invisible au moment de miser.
 *     Preleve une fois, le taux de retour vaut 97 % qu'on ouvre une case ou
 *     vingt, et aucune facon de jouer n'est meilleure qu'une autre.
 *
 *  3. Le multiplicateur est arrondi vers le BAS. Un arrondi au plus proche
 *     rendrait parfois au joueur un centieme de plus que le calcul exact ;
 *     sur des millions de parties, ce sont des jetons crees a partir de rien.
 *
 * Cases : entier 0..24, ligne = c / 5, colonne = c % 5.
 */

const crypto = require('crypto');

const CASES = 25;
const MINES_MIN = 1;
const MINES_MAX = CASES - 1;        // il faut au moins une case sure a ouvrir

// ------------------------------------------------------------------- tirage

/**
 * Flux d'octets deterministe tire de la graine. Le compteur est INCLUS dans le
 * message : sans lui, un HMAC ne donne que 32 octets et un melange de 25 cases
 * en consomme davantage des qu'on rejette.
 */
function octets(serverSeed, clientSeed, nonce) {
  let compteur = 0;
  let flux = Buffer.alloc(0);
  return function () {
    if (!flux.length) {
      flux = crypto.createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${compteur++}`).digest();
    }
    const b = flux[0];
    flux = flux.slice(1);
    return b;
  };
}

/**
 * Entier uniforme dans [0, n[. Le modulo brut favoriserait les premieres
 * valeurs : on rejette au-dela du dernier multiple entier de n.
 */
function auHasard(suivant, n) {
  const limite = 256 - (256 % n);
  let x;
  do { x = suivant(); } while (x >= limite);
  return x % n;
}

/**
 * Place les bombes. Melange de Fisher-Yates sur les 25 cases, puis on garde
 * les `nbMines` premieres. Trie a la fin : la liste ne doit rien dire de
 * l'ordre du melange.
 */
function plateau(serverSeed, clientSeed, nonce, nbMines) {
  if (!(nbMines >= MINES_MIN && nbMines <= MINES_MAX)) throw new Error('nombre de bombes invalide');
  const suivant = octets(serverSeed, clientSeed, nonce);
  const cases = [];
  for (let i = 0; i < CASES; i++) cases.push(i);
  for (let i = CASES - 1; i > 0; i--) {
    const j = auHasard(suivant, i + 1);
    const t = cases[i]; cases[i] = cases[j]; cases[j] = t;
  }
  return cases.slice(0, nbMines).sort((a, b) => a - b);
}

// -------------------------------------------------------------- probabilites

/**
 * Probabilite d'ouvrir `k` cases sures d'affilee, avec `m` bombes sur 25.
 * Produit des tirages sans remise : la premiere case a (25-m)/25 chances
 * d'etre sure, la suivante (24-m)/24, etc.
 */
function chance(m, k) {
  if (k < 0 || k > CASES - m) return 0;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (CASES - m - i) / (CASES - i);
  return p;
}

/**
 * Multiplicateur apres `k` cases sures. Sans avantage maison il vaut
 * exactement 1 / chance, ce qui rend la partie equitable a tout moment.
 */
function multiplicateur(m, k, edgeBps = 0) {
  if (k === 0) return 1;
  const p = chance(m, k);
  if (p <= 0) return 0;
  return arrondi((1 / p) * (1 - edgeBps / 10000));
}

/** Deux decimales, toujours vers le BAS. */
function arrondi(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/** Le multiplicateur le plus haut atteignable : toutes les cases sures. */
function maximum(m, edgeBps = 0) {
  return multiplicateur(m, CASES - m, edgeBps);
}

// ------------------------------------------------------------------- partie

/** Ouvre une partie. Les bombes sont fixees ici, et ne bougeront plus.
    L'avantage maison est retenu DANS l'etat : le lire au moment d'encaisser
    laisserait une partie commencee changer de bareme si la configuration du
    serveur bouge en cours de route. */
function ouvrir({ serverSeed, clientSeed, nonce, mise, nbMines, edgeBps = 0 }) {
  const bombes = plateau(serverSeed, clientSeed, nonce, nbMines);
  return {
    mise, nbMines, bombes, edgeBps,
    ouvertes: [],                  // cases sures retournees, dans l'ordre
    multi: 1,
    fini: false,
    perdu: false,
  };
}

/**
 * Retourne une case. Renvoie le nouvel etat, si la case etait sure, et — quand
 * la partie se termine — la grille complete pour que le joueur voie ce qu'il
 * a evite.
 */
function jouer({ etat, position }) {
  if (etat.fini) throw new Error('partie terminee');
  const p = Math.floor(Number(position));
  if (!(p >= 0 && p < CASES)) throw new Error('case hors grille');
  if (etat.ouvertes.indexOf(p) >= 0) throw new Error('case deja ouverte');

  if (etat.bombes.indexOf(p) >= 0) {
    return {
      etat: { ...etat, fini: true, perdu: true, multi: 0, touchee: p },
      sure: false, position: p,
    };
  }
  const ouvertes = etat.ouvertes.concat([p]);
  const multi = multiplicateur(etat.nbMines, ouvertes.length, etat.edgeBps || 0);
  /* Toutes les cases sures ouvertes : la partie se termine d'elle-meme, sinon
     le joueur resterait sur un plateau ou plus aucun coup n'est possible. */
  const complet = ouvertes.length >= CASES - etat.nbMines;
  return {
    etat: { ...etat, ouvertes, multi, fini: complet, complet },
    sure: true, position: p,
  };
}

/** Encaisse : la mise fois le multiplicateur courant, arrondi a l'entier bas. */
function encaisser(etat) {
  if (etat.fini && !etat.complet) throw new Error('partie terminee');
  if (etat.encaisse) throw new Error('partie terminee');
  if (!etat.ouvertes.length) throw new Error('aucune case ouverte');
  const brut = Math.floor(etat.mise * etat.multi);
  return { payout: brut, net: brut - etat.mise,
           etat: { ...etat, fini: true, encaisse: true } };
}

module.exports = {
  CASES, MINES_MIN, MINES_MAX,
  plateau, chance, multiplicateur, arrondi, maximum,
  ouvrir, jouer, encaisser,
};
