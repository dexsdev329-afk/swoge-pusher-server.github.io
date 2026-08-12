'use strict';
/*
 * SWOGE Plinko — la bille tombe, les picots la devient, elle atterrit dans une
 * case qui paie un multiplicateur.
 *
 * Quatre decisions de regles, parce qu'elles changent tout :
 *
 *  1. LA CASE EST TIREE D'ABORD, PAS SIMULEE. Une simulation physique n'est pas
 *     reproductible d'une machine a l'autre : les arrondis flottants different,
 *     et deux verifications du meme coup ne donneraient pas la meme case. La
 *     promesse d'equite verifiable tomberait. On tire donc `rangees` bits de la
 *     graine — un par picot, gauche ou droite — et la case est la somme. Le
 *     chemin complet est renvoye au navigateur, qui anime EXACTEMENT ce chemin :
 *     l'animation ne decide de rien, elle raconte.
 *
 *  2. La loi est celle du triangle de Pascal : la case k a une probabilite
 *     C(n,k)/2^n. Rien d'approche, rien de simule — le taux de retour se
 *     calcule exactement, il n'a pas besoin d'etre estime.
 *
 *  3. Les multiplicateurs sont ENGENDRES, pas recopies. On choisit une forme
 *     (creuse au centre, haute sur les bords) puis on la met a l'echelle pour
 *     que l'esperance vaille exactement 1 - avantage. Une table ecrite a la
 *     main serait invérifiable : personne ne saurait dire d'ou viennent ses
 *     chiffres ni ce qu'ils rendent vraiment.
 *
 *  4. Le rapport entre le bord et le centre est BORNE par la forme. C'est ce
 *     qui empeche un multiplicateur de bord de partir a 5000x sur une mise
 *     plafonnee a 10 000 — la maison doit pouvoir payer ce qu'elle affiche.
 *
 * Cases : entier 0..rangees, de la gauche vers la droite.
 */

const crypto = require('crypto');

const RANGEES = [8, 12, 16];
const RISQUES = ['low', 'medium', 'high'];

/*
 * Forme de la table, par niveau de risque.
 *   gamma — a quel point le creux central est marque (plus haut = plus creux)
 *   plancher — poids du centre par rapport au bord ; c'est LUI qui borne le
 *              rapport bord/centre, donc le multiplicateur maximum
 */
const FORME = {
  low:    { gamma: 2.4, plancher: 0.34 },   // rapport ~3 : peu de casse, peu de gros lots
  medium: { gamma: 4.5, plancher: 0.075 },  // rapport ~13
  high:   { gamma: 7.5, plancher: 0.011 },  // rapport ~90 : le centre coute cher, les bords paient
};

// ------------------------------------------------------------------- tirage

/**
 * Un bit par rangee, tire de la graine. Chaque bit dit de quel cote la bille
 * passe le picot. La case d'arrivee est le nombre de fois ou elle est allee a
 * droite — c'est exactement une loi binomiale, sans avoir a la simuler.
 */
function chemin(serverSeed, clientSeed, nonce, rangees) {
  const bits = [];
  let compteur = 0, flux = Buffer.alloc(0);
  while (bits.length < rangees) {
    if (!flux.length) {
      flux = crypto.createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${compteur++}`).digest();
    }
    const b = flux[0];
    flux = flux.slice(1);
    // 8 bits par octet : on ne jette rien, et le flux reste court a verifier
    for (let i = 7; i >= 0 && bits.length < rangees; i--) bits.push((b >> i) & 1);
  }
  return bits;
}

/** La case d'arrivee : le nombre de passages a droite. */
function caseDe(bits) {
  let k = 0;
  for (const b of bits) k += b;
  return k;
}

// -------------------------------------------------------------- probabilites

/** C(n,k) exact tant que n reste petit — 16 rangees au plus ici. */
function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

/** Probabilite d'atterrir dans la case k : C(n,k) / 2^n. */
function chance(rangees, k) {
  if (k < 0 || k > rangees) return 0;
  return binom(rangees, k) / Math.pow(2, rangees);
}

// ---------------------------------------------------------- multiplicateurs

/**
 * La table des multiplicateurs.
 *
 * On part d'une forme s(k) > 0, creuse au centre, puis on la met a l'echelle :
 *   m(k) = s(k) x (1 - avantage) / somme( P(k) x s(k) )
 * ce qui rend l'esperance EXACTEMENT egale a 1 - avantage, quelle que soit la
 * forme choisie. L'arrondi final se fait vers le BAS : il ne peut que retirer
 * au joueur, jamais lui ajouter des jetons crees a partir de rien.
 */
function table(rangees, risque, edgeBps = 0) {
  if (RANGEES.indexOf(rangees) < 0) throw new Error('nombre de rangees invalide');
  const f = FORME[risque];
  if (!f) throw new Error('risque inconnu');

  const centre = rangees / 2;
  const forme = [];
  for (let k = 0; k <= rangees; k++) {
    const d = Math.abs(k - centre) / centre;          // 0 au centre, 1 au bord
    forme.push(f.plancher + (1 - f.plancher) * Math.pow(d, f.gamma));
  }
  let somme = 0;
  for (let k = 0; k <= rangees; k++) somme += chance(rangees, k) * forme[k];

  const vise = 1 - edgeBps / 10000;
  const base = vise / somme;

  /* L'echelle exacte donne l'esperance voulue AVANT arrondi. Apres arrondi
     vers le bas elle tombe plus bas — et beaucoup plus bas qu'on ne croit :
     en risque faible les multiplicateurs valent tous autour de 1, ou raboter
     un centieme coute un demi pourcent. La table sortait a 96,27 % pour
     97 % vises, un demi-point perdu par le joueur sans que rien ne le dise.
     On remonte donc l'echelle jusqu'a ce que le taux REEL, arrondi compris,
     se colle sous la cible sans jamais la depasser. */
  const evalue = (a) => {
    const t = forme.map((s) => arrondi(s * base * a));
    let e = 0;
    for (let k = 0; k <= rangees; k++) e += chance(rangees, k) * t[k];
    return { t, e };
  };
  let bas = 1, haut = 1.05, meilleur = evalue(1);
  for (let i = 0; i < 60; i++) {
    const mid = (bas + haut) / 2;
    const r = evalue(mid);
    if (r.e <= vise) { if (r.e > meilleur.e) meilleur = r; bas = mid; }
    else haut = mid;
  }
  return meilleur.t;
}

/** Deux decimales, toujours vers le BAS. */
function arrondi(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/** Le taux de retour REEL de la table, arrondis compris. */
function retour(rangees, risque, edgeBps = 0) {
  const t = table(rangees, risque, edgeBps);
  let e = 0;
  for (let k = 0; k <= rangees; k++) e += chance(rangees, k) * t[k];
  return e;
}

// ------------------------------------------------------------------- partie

/**
 * Une bille. Tout se joue d'un coup : pas d'etat a conserver entre deux
 * messages, donc rien qu'un joueur puisse abandonner en cours de route pour
 * garder sa mise.
 */
function lancer({ serverSeed, clientSeed, nonce, mise, rangees, risque, edgeBps = 0 }) {
  const t = table(rangees, risque, edgeBps);
  const bits = chemin(serverSeed, clientSeed, nonce, rangees);
  const k = caseDe(bits);
  const multi = t[k];
  const payout = Math.floor(mise * multi);
  return { mise, rangees, risque, chemin: bits, case: k, multi,
           payout, net: payout - mise, table: t };
}

module.exports = {
  RANGEES, RISQUES, FORME,
  chemin, caseDe, binom, chance, table, arrondi, retour, lancer,
};
