'use strict';
/*
 * SWOGE Boulier — 90 boules, 30 sortent, une grille de 10 numeros.
 *
 * Le joueur coche 10 numeros entre 1 et 90. Le boulier tourne et lache 30
 * boules, une par une. Le lot depend du nombre de numeros de la grille qui
 * sont sortis. Les 10 sur 10 emportent la cagnotte.
 *
 * ---- pourquoi 30 boules et une grille de 10 ----
 *
 * C'est le seul reglage qui accroche un million a la grille pleine. La
 * probabilite d'un plein suit une loi hypergeometrique :
 *
 *      P(k touches) = C(D,k) * C(N-D, K-k) / C(N,K)
 *
 * et pour le plein elle se reduit a C(D,K) / C(N,K). Avec 90 boules :
 *
 *      grille de  5, 30 tirees  ->  1 sur 308         (le reglage d'origine)
 *      grille de  8, 30 tirees  ->  1 sur 13 244
 *      grille de 10, 30 tirees  ->  1 sur 190 402     <- retenu
 *      grille de 10, 20 tirees  ->  1 sur 30 963 246
 *
 * Une cagnotte vaut ce qu'elle encaisse entre deux gains : 5 % de 100 SWOGE
 * pris 190 402 fois font 952 012 SWOGE. C'est ce chiffre-la qui dicte la
 * taille de la grille, pas l'inverse. Un plein a 1 sur 308 ne pourrait
 * jamais porter plus de 15 SWOGE ; un plein a 1 sur 31 millions ne tomberait
 * pas une fois dans la vie du casino.
 *
 * ---- pourquoi ce bareme-la ----
 *
 * 85,02 % en lots fixes, 5 % a la cagnotte : 90,02 % rendu, 9,98 % garde.
 * Les lots sont ronds parce qu'un bareme se lit avant de miser, et qu'un
 * 73,4x ne se retient pas. Le poids de chaque palier dans le retour :
 *
 *      0/10   1 sur 76        1x      1,3 pt
 *      5/10   1 sur 7         1x     13,6 pt
 *      6/10   1 sur 20        4x     20,2 pt
 *      7/10   1 sur 82       15x     18,3 pt
 *      8/10   1 sur 552      75x     13,6 pt
 *      9/10   1 sur 6 664  1200x     18,0 pt
 *     10/10   1 sur 190 402  cagnotte
 *
 * Le lot a ZERO touche n'est pas une fantaisie : sans lui, rater toute la
 * grille est le resultat le plus frustrant du jeu alors qu'il est presque
 * aussi rare qu'un 7/10. Il coute 1,3 point de retour et il rend le pire
 * tirage lisible.
 *
 * Rien n'est paye de 1 a 4 touches. C'est voulu : le jeu doit etre dur, et
 * l'argent du bareme vaut mieux concentre sur les paliers hauts que dilue en
 * remboursements que personne ne remarque.
 *
 * ---- pourquoi la cagnotte s'auto-finance ----
 *
 * Le gagnant emporte 80 % du pot ; les 20 % restants amorcent le cycle
 * suivant. En regime etabli le pot vaut 952 012 / 0,8 = 1 190 016 au moment
 * du gain, il en part 952 012 — exactement ce qui a ete collecte. La maison
 * ne remet jamais un SWOGE apres le versement initial, et pourtant le pot ne
 * repart jamais de zero. Un pot qui redemarre a zero est un pot que plus
 * personne ne regarde pendant six mois.
 *
 * Boules : entier 1..90. Grille : 10 entiers distincts, tries.
 */

const crypto = require('crypto');

const BOULES = 90;                  // numeros 1..90
const TIREES = 30;                  // boules qui sortent du boulier
const GRILLE = 10;                  // numeros coches par le joueur

/* Multiplicateur de la mise d'UNE grille, par nombre de touches. Le 10 vaut
   zero ici : il ne se paie pas au bareme mais sur la cagnotte, et melanger
   les deux dans la meme table ferait compter le plein deux fois. */
const BAREME = { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 4, 7: 15, 8: 75, 9: 1200, 10: 0 };

/* Part de chaque mise versee a la cagnotte, en points de base. */
const CAGNOTTE_BPS = 500;           // 5,00 %
/* Part du pot emportee par un plein. Le reste amorce le cycle suivant. */
const CAGNOTTE_PART_BPS = 8000;     // 80,00 %

// ------------------------------------------------------------ combinatoire

/** C(n,k) en flottant. Suffisant : les plus gros comptes ici tiennent large
 *  sous 2^53, et une version exacte en BigInt ne servirait qu'a diviser. */
function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** Probabilite d'obtenir exactement `k` touches. Loi hypergeometrique. */
function chance(k) {
  return comb(TIREES, k) * comb(BOULES - TIREES, GRILLE - k) / comb(BOULES, GRILLE);
}

/**
 * Taux de retour du BAREME SEUL, cagnotte exclue. C'est le nombre que la
 * suite de tests surveille : il ne doit pas bouger sans qu'on l'ait voulu.
 */
function retourBareme() {
  let r = 0;
  for (let k = 0; k <= GRILLE; k++) r += (BAREME[k] || 0) * chance(k);
  return r;
}

/** Taux de retour total : bareme + alimentation de la cagnotte. */
function retourTotal() {
  return retourBareme() + CAGNOTTE_BPS / 10000;
}

/** Le bareme mis en forme pour l'affichage, avec les cotes. */
function table() {
  const out = [];
  for (let k = 0; k <= GRILLE; k++) {
    const p = chance(k);
    out.push({ touches: k, multi: BAREME[k] || 0, cagnotte: k === GRILLE,
               chance: p, unSur: Math.round(1 / p) });
  }
  return out;
}

// ------------------------------------------------------------------ tirage

/**
 * Flux d'octets deterministe tire de la graine. Le compteur est INCLUS dans
 * le message : un HMAC ne rend que 32 octets et un tirage de 30 boules parmi
 * 90 en consomme davantage des qu'on rejette.
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
 * Entier uniforme dans [0, m). Un simple `octet % m` favoriserait les petits
 * restes des que m ne divise pas 256 — sur 90 boules ce biais se mesure, et
 * un joueur qui refait le calcul le verrait.
 */
function borne(suivant, m) {
  const limite = 256 - (256 % m);
  let x;
  do { x = suivant(); } while (x >= limite);
  return x % m;
}

/**
 * Sort les 30 boules DANS L'ORDRE ou elles quittent le boulier.
 *
 * L'ordre n'est pas decoratif : l'animation les lache une par une et le
 * joueur doit pouvoir refaire exactement la meme sequence une fois la graine
 * revelee. Un tirage rendu trie serait invérifiable — n'importe quel ordre
 * donnerait le meme ensemble.
 *
 * Melange de Fisher-Yates partiel : 30 pas sur une urne de 90, donc jamais
 * deux fois la meme boule, et aucun rejet lie a un doublon.
 */
function tirage(serverSeed, clientSeed, nonce) {
  const suivant = octets(serverSeed, clientSeed, nonce);
  const urne = [];
  for (let i = 1; i <= BOULES; i++) urne.push(i);
  const sortie = [];
  for (let i = 0; i < TIREES; i++) {
    const j = i + borne(suivant, BOULES - i);
    const t = urne[i]; urne[i] = urne[j]; urne[j] = t;
    sortie.push(urne[i]);
  }
  return sortie;
}

// ------------------------------------------------------------------ grille

/**
 * Verifie une grille et la rend triee. On refuse au lieu de corriger : une
 * grille a 9 numeros ou avec un doublon veut dire que le client s'est trompe,
 * et la completer en silence ferait jouer des numeros que personne n'a
 * choisis.
 */
function valideGrille(brut) {
  if (!Array.isArray(brut)) throw new Error('grid must be a list of numbers');
  if (brut.length !== GRILLE) throw new Error('pick exactly ' + GRILLE + ' numbers');
  const vu = new Set();
  const g = [];
  for (const v of brut) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > BOULES)
      throw new Error('numbers must be whole numbers between 1 and ' + BOULES);
    if (vu.has(n)) throw new Error('number ' + n + ' is picked twice');
    vu.add(n);
    g.push(n);
  }
  return g.sort((a, b) => a - b);
}

/** Une grille au hasard, pour le bouton « lucky dip ». Hors chaine d'equite :
 *  elle sert a REMPLIR le formulaire, le joueur la voit avant de valider. */
function grilleAuHasard() {
  const urne = [];
  for (let i = 1; i <= BOULES; i++) urne.push(i);
  for (let i = 0; i < GRILLE; i++) {
    const j = i + crypto.randomInt(BOULES - i);
    const t = urne[i]; urne[i] = urne[j]; urne[j] = t;
  }
  return urne.slice(0, GRILLE).sort((a, b) => a - b);
}

/** Les numeros de la grille qui sont sortis, dans l'ordre de la grille. */
function touches(grille, sortie) {
  const s = new Set(sortie);
  return grille.filter((n) => s.has(n));
}

// -------------------------------------------------------------------- lots

/**
 * Ce que rapporte UNE grille, cagnotte exclue.
 * `mise` est le prix d'une grille en SWOGE entiers.
 */
function lot(nbTouches, mise) {
  return Math.floor(mise * (BAREME[nbTouches] || 0));
}

/** Part de la mise d'une grille qui part a la cagnotte. */
function partCagnotte(mise) {
  return Math.floor(mise * CAGNOTTE_BPS / 10000);
}

/** Ce qu'un plein emporte sur un pot de `pot` SWOGE. Le reste amorce la suite. */
function partPlein(pot) {
  return Math.floor(pot * CAGNOTTE_PART_BPS / 10000);
}

module.exports = {
  BOULES, TIREES, GRILLE, BAREME, CAGNOTTE_BPS, CAGNOTTE_PART_BPS,
  comb, chance, retourBareme, retourTotal, table,
  octets, borne, tirage,
  valideGrille, grilleAuHasard, touches,
  lot, partCagnotte, partPlein,
};
