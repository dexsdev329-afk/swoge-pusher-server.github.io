'use strict';
/*
 * SWOGE Hi-Lo — plus haut ou plus bas.
 *
 * Une carte est posee. Le joueur annonce HIGHER ou LOWER. La carte suivante
 * tombe : bonne reponse, le multiplicateur grimpe et on peut continuer ou
 * encaisser ; mauvaise reponse, la mise est perdue.
 *
 * Trois decisions de regles, parce qu'elles changent tout :
 *
 *  1. Chaque carte est tiree d'un jeu de 52 COMPLET (tirage avec remise). Un
 *     sabot qui se vide obligerait a rejouer tout l'historique pour verifier
 *     une main ; la, chaque tirage se verifie seul avec son numero d'ordre.
 *
 *  2. Meme rang = EGALITE, on rejoue le pas. Ni gain ni perte, multiplicateur
 *     inchange. C'est la regle la plus lisible : l'autre variante (egalite =
 *     perte) cache un avantage maison de 7,7 % que le joueur ne voit nulle part.
 *
 *  3. L'avantage de la maison est PAR PAS, applique sur le multiplicateur.
 *     Sur un jeu a chaine, prelever une commission a l'encaissement donnerait
 *     un taux de retour different selon la prudence du joueur — de 87 % a 99 %
 *     selon le multiplicateur choisi. Par pas, il est identique pour tous.
 *
 * Cartes : entier 0..51, rang = c % 13 (0=2 … 12=As), couleur = (c / 13) | 0.
 * Meme convention que poker.js et casino.js.
 */

const crypto = require('crypto');

const RANGS = 13;
const HAUT = RANGS - 1;             // indice de l'As
const NOM_RANG = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// ------------------------------------------------------------------- tirage

/**
 * Tire une carte de facon deterministe. `pas` distingue les tirages successifs
 * d'une meme partie, `essai` les reprises apres egalite : deux coordonnees, donc
 * jamais deux fois la meme carte pour deux evenements differents.
 */
function tirer(serverSeed, clientSeed, nonce, pas, essai) {
  let compteur = 0;
  let flux = Buffer.alloc(0);
  const octet = () => {
    if (!flux.length) {
      flux = crypto.createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${pas}:${essai}:${compteur++}`).digest();
    }
    const b = flux[0];
    flux = flux.slice(1);
    return b;
  };
  // 52 ne divise pas 256 : on rejette au-dela de 208 pour rester uniforme
  const limite = 256 - (256 % 52);
  let x;
  do { x = octet(); } while (x >= limite);
  return x % 52;
}

// -------------------------------------------------------------- probabilites

/**
 * Probabilite de gagner, sachant qu'une egalite fait rejouer le pas.
 * Sur 52 cartes, 4 partagent le rang courant : il en reste 48 qui tranchent,
 * dont 4 par rang strictement au-dessus (ou en dessous).
 */
function chance(rang, sens) {
  const au_dessus = HAUT - rang;                  // nombre de rangs plus hauts
  const n = sens === 'higher' ? au_dessus : rang;
  return n / (RANGS - 1);                         // = 4n / 48
}

/** Le pari est-il seulement possible ? Rien n'est plus haut qu'un As. */
function possible(rang, sens) {
  return chance(rang, sens) > 0;
}

/**
 * Multiplicateur d'un pas. Sans avantage maison il vaut 1 / chance, ce qui rend
 * le pas exactement equitable ; l'avantage le rabote d'autant.
 */
function multiplicateur(rang, sens, edgeBps = 0) {
  const p = chance(rang, sens);
  if (p <= 0) return 0;
  const brut = 1 / p;
  return arrondi(brut * (1 - edgeBps / 10000));
}

/** Deux decimales : un multiplicateur qui traine 12 chiffres est illisible. */
function arrondi(x) {
  return Math.floor(x * 100 + 1e-9) / 100;        // toujours vers le BAS
}

// ------------------------------------------------------------------- partie

/** Ouvre une partie : une mise, une premiere carte, multiplicateur a 1. */
function ouvrir({ serverSeed, clientSeed, nonce, mise }) {
  const carte = tirer(serverSeed, clientSeed, nonce, 0, 0);
  return {
    mise,
    carte,
    rang: carte % 13,
    pas: 0,
    multi: 1,
    fini: false,
    peutMonter: possible(carte % 13, 'higher'),
    peutDescendre: possible(carte % 13, 'lower'),
  };
}

/**
 * Joue un pas. Retourne le nouvel etat, la carte tiree, et la liste des cartes
 * ecartees pour egalite (elles se sont bien produites, il faut pouvoir les
 * verifier). `edgeBps` est l'avantage de la maison par pas.
 */
function jouer({ etat, sens, serverSeed, clientSeed, nonce, edgeBps = 0 }) {
  if (etat.fini) throw new Error('partie terminee');
  if (sens !== 'higher' && sens !== 'lower') throw new Error('sens inconnu');
  if (!possible(etat.rang, sens)) throw new Error('pari impossible sur ce rang');

  const pas = etat.pas + 1;
  const mult = multiplicateur(etat.rang, sens, edgeBps);

  // Egalite : le pas est rejoue. Boucle bornee en pratique (1 chance sur 13),
  // mais on la borne aussi en dur : un HMAC ne doit jamais pouvoir bloquer.
  const egalites = [];
  let carte, rang, essai = 0;
  for (;;) {
    carte = tirer(serverSeed, clientSeed, nonce, pas, essai);
    rang = carte % 13;
    if (rang !== etat.rang) break;
    egalites.push(carte);
    if (++essai > 200) { rang = etat.rang; break; }
  }

  const gagne = (sens === 'higher') ? rang > etat.rang : rang < etat.rang;
  if (!gagne) {
    return {
      etat: { ...etat, carte, rang, pas, fini: true, perdu: true, multi: 0,
              peutMonter: false, peutDescendre: false },
      carte, egalites, gagne: false, multiplicateurDuPas: mult,
    };
  }
  const multi = arrondi(etat.multi * mult);
  return {
    etat: {
      ...etat, carte, rang, pas, multi, fini: false, perdu: false,
      peutMonter: possible(rang, 'higher'),
      peutDescendre: possible(rang, 'lower'),
    },
    carte, egalites, gagne: true, multiplicateurDuPas: mult,
  };
}

/** Encaisse : la mise fois le multiplicateur courant, arrondi a l'entier bas. */
function encaisser(etat) {
  if (etat.fini) throw new Error('partie terminee');
  const brut = Math.floor(etat.mise * etat.multi);
  return { payout: brut, net: brut - etat.mise,
           etat: { ...etat, fini: true, encaisse: true } };
}

module.exports = {
  RANGS, HAUT, NOM_RANG,
  tirer, chance, possible, multiplicateur, arrondi,
  ouvrir, jouer, encaisser,
};
