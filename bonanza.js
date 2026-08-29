'use strict';
/*
 * SWOGE BONANZA — la machine, et rien qu'elle.
 *
 * Ce fichier ne connait ni solde, ni joueur, ni socket. On lui donne une
 * graine et une mise, il rend un tour complet. C'est ce qui le rend
 * verifiable : rejouez les memes graines, vous obtenez les memes symboles.
 *
 * ---- COMMENT ON GAGNE ----
 *
 * Il n'y a AUCUNE ligne de paiement. On compte les symboles identiques
 * n'importe ou sur la grille de 30 cases ; a partir de huit, ca paie. C'est
 * ce qu'on appelle « pay anywhere », et ca change tout par rapport a une
 * machine a lignes : la position ne compte pas, seulement le nombre.
 *
 * ---- LA CASCADE ----
 *
 * Les symboles gagnants disparaissent, on retire au hasard pour les
 * remplacer, et on recompte. Tant qu'il y a un gain, ca continue. Un seul
 * tour peut donc payer dix fois.
 *
 * ---- POURQUOI LES SYMBOLES SONT TIRES CASE PAR CASE ----
 *
 * Une machine classique fait tourner cinq rouleaux : chaque colonne suit une
 * bande figee. Ici, chaque case est tiree independamment des autres, selon un
 * poids par symbole. C'est le modele qui convient au « pay anywhere » — la
 * colonne ne veut plus rien dire — et surtout c'est le seul qui reste
 * VERIFIABLE simplement : trente tirages, un par case, dans l'ordre.
 *
 * ---- LE TAUX DE RETOUR ----
 *
 * Il n'est pas choisi, il est MESURE. Sur 1,2 million de tours simules :
 *
 *     RTP           94,65 %
 *     intervalle a 95 %   93,14 % a 96,16 %
 *     bonus ouvert  1 tour sur 201
 *
 * ---- ET IL A FALLU LE REGLER DEUX FOIS ----
 *
 * La premiere mesure — 95,00 % sur 4,8 millions de tours — valait pour une
 * regle FAUSSE : les scatters ne comptaient qu'au premier jet. Corrigee (ils
 * comptent pendant toute la cascade, comme dans le jeu d'origine), le bonus
 * s'ouvrait un tour sur 87 au lieu de 219 et le RTP montait a 152 % : la
 * maison perdait cinquante-deux pour cent a chaque tour.
 *
 * Le poids de la sucette est le levier, et il est BRUTAL — de 22 a 8, le
 * bonus passe de 1 tour sur 87 a 1 sur 3 750. Mesure du reglage retenu, 17
 * et 0,13, contre les voisins sur 200 000 tours chacun :
 *
 *     chance de bombe 0,130   RTP  94,89 %   1 tour sur 200
 *     chance de bombe 0,145   RTP  97,42 %   1 tour sur 200
 *     chance de bombe 0,160   RTP 101,69 %   1 tour sur 200
 *
 * Le jeu revient donc exactement ou il avait ete concu, avec la bonne regle.
 *
 * L'intervalle n'est pas de la coquetterie. Ce jeu a une variance enorme — les
 * bombes des tours gratuits vont jusqu'a x100 et s'additionnent — au point
 * qu'un echantillon de 250 000 tours donne des ecarts de HUIT POINTS d'une
 * graine a l'autre. Annoncer « 95 % » sans l'intervalle laisserait croire a
 * une precision qui n'existe pas, et on reglerait le jeu sur du bruit.
 *
 * `simule()` en bas du fichier refait la mesure quand on veut. Un taux qu'on
 * annonce sans l'avoir mesure est un taux qu'on invente.
 */
const crypto = require('crypto');

/* ---------- les symboles, du plus faible au plus fort ---------- */
const SYMBOLES = ['banane','raisin','pasteque','prune','pomme',
                  'bonbon_bleu','bonbon_vert','bonbon_violet','coeur'];
const SCATTER = 'sucette';
const TOUS = SYMBOLES.concat([SCATTER]);

const COLONNES = 6, RANGEES = 5, CASES = COLONNES * RANGEES;
const MIN_AMAS = 8;              // huit exemplaires pour payer

/* ---------- le bareme, en multiples de la MISE TOTALE ----------
 * Trois paliers : 8-9, 10-11, 12 et plus. C'est le decoupage de la machine
 * qu'on copie, et il a une consequence agreable : le douzieme symbole vaut
 * beaucoup plus cher que le onzieme, donc une cascade qui en rajoute un seul
 * peut multiplier le gain par cinq. */
const BAREME = {
  banane:        [0.25, 0.75,  2],
  raisin:        [0.40, 0.90,  4],
  pasteque:      [0.50, 1.00,  5],
  prune:         [0.80, 1.20,  8],
  pomme:         [1.00, 1.50, 10],
  bonbon_bleu:   [1.50, 2.00, 12],
  bonbon_vert:   [2.00, 5.00, 15],
  bonbon_violet: [2.50, 10.0, 25],
  coeur:         [10.0, 25.0, 50],
};
/* Le scatter paie ou qu'il tombe, et n'a pas besoin de huit exemplaires. */
const BAREME_SCATTER = { 4: 3, 5: 5, 6: 100 };
const SCATTERS_POUR_TOURS = 4;   // a partir de quatre, les tours gratuits s'ouvrent
const TOURS_GRATUITS = 10;

/* ---------- les poids ----------
 * Plus le symbole paie, moins il sort. Le scatter est rare : c'est lui qui
 * porte l'essentiel de la variance, parce que les tours gratuits valent bien
 * plus qu'un amas de coeurs. */
const POIDS = {
  banane:        195, raisin:        170, pasteque:      150,
  prune:         120, pomme:         105, bonbon_bleu:    82,
  bonbon_vert:    62, bonbon_violet:  40, coeur:          14,
  sucette:        17,
};
function poidsTotal(){ return TOUS.reduce((s, k) => s + POIDS[k], 0); }

/* Les multiplicateurs des bombes, en tours gratuits seulement. Rares et
   gros : c'est la promesse du mode, et la raison qu'on a de le vouloir. */
const BOMBES = [2,2,2,3,3,3,4,4,5,5,6,8,10,12,15,20,25,50,100];
/* PLUSIEURS bombes par tour gratuit, et leurs multiplicateurs S'ADDITIONNENT.
 * Une bombe unique ne suffisait pas : les tours gratuits ne rendaient que
 * 11,7 % quand ils doivent porter l'essentiel du retour. C'est l'addition qui
 * fait le mode — trois bombes a 5, 10 et 25 donnent x40 sur le tour. */
const BOMBES_ESSAIS = 6;         // occasions de bombe par tour gratuit
let CHANCE_BOMBE = 0.13;         // reglee par mesure — voir la note de RTP plus bas

const GAIN_MAX = 21100;          // plafond, en multiples de la mise

/* ================== L'ALEA VERIFIABLE ==================
 * Meme construction que le Plinko et le Crash de la maison : un flux d'octets
 * HMAC-SHA256(graineServeur, graineClient:nonce:compteur). On consomme les
 * octets a la demande ; rejouer les trois entrees redonne le meme tour, case
 * par case. */
function fluxDe(serverSeed, clientSeed, nonce) {
  let tampon = Buffer.alloc(0), compteur = 0;
  return function octet() {
    if (!tampon.length) {
      tampon = crypto.createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${compteur++}`).digest();
    }
    const b = tampon[0]; tampon = tampon.slice(1); return b;
  };
}
/* Un entier dans [0,max) sans biais : on rejette les valeurs qui tombent dans
   la portion incomplete du dernier tour de roue. Un simple modulo favoriserait
   les premieres valeurs — invisible sur un tour, mesurable sur un million. */
function entier(octet, max) {
  const limite = Math.floor(65536 / max) * max;
  for (;;) {
    const v = (octet() << 8) | octet();
    if (v < limite) return v % max;
  }
}
function tireSymbole(octet) {
  let r = entier(octet, poidsTotal());
  for (const k of TOUS) { r -= POIDS[k]; if (r < 0) return k; }
  return TOUS[TOUS.length - 1];
}

/* ================== UN TOUR ================== */

function grilleNeuve(octet) {
  const g = new Array(CASES);
  for (let i = 0; i < CASES; i++) g[i] = tireSymbole(octet);
  return g;
}

/** Ce que paie une grille : les amas de 8+, et les scatters. */
function gainsDe(grille) {
  const compte = {};
  for (const s of grille) compte[s] = (compte[s] || 0) + 1;
  const amas = [];
  let total = 0;
  for (const s of SYMBOLES) {
    const n = compte[s] || 0;
    if (n < MIN_AMAS) continue;
    const palier = n >= 12 ? 2 : n >= 10 ? 1 : 0;
    const mult = BAREME[s][palier];
    amas.push({ symbole: s, nombre: n, multi: mult });
    total += mult;
  }
  return { amas, multi: total, scatters: compte[SCATTER] || 0 };
}

/** La cascade : on retire ce qui a gagne, le reste tombe, on comble par le haut.
 *  Les colonnes tombent VRAIMENT — on ne redistribue pas toute la grille, sinon
 *  l'animation cote page ne pourrait pas montrer ce qui s'est passe. */
function faitTomber(grille, gagnants, octet) {
  const g = grille.slice();
  for (let c = 0; c < COLONNES; c++) {
    const colonne = [];
    for (let r = RANGEES - 1; r >= 0; r--) {
      const i = r * COLONNES + c;
      if (!gagnants.has(g[i])) colonne.push(g[i]);
    }
    for (let r = RANGEES - 1, k = 0; r >= 0; r--, k++) {
      const i = r * COLONNES + c;
      g[i] = k < colonne.length ? colonne[k] : tireSymbole(octet);
    }
  }
  return g;
}

/** Un tour complet, cascades comprises. `gratuit` ajoute les bombes. */
function unTour(octet, gratuit) {
  const etapes = [];
  let grille = grilleNeuve(octet);
  let multiTotal = 0, scattersVus = 0, tours = 0;

  for (;;) {
    const g = gainsDe(grille);
    /* ---- LES SCATTERS COMPTENT PENDANT TOUTE LA CASCADE ----
     * Ils ne comptaient qu'au PREMIER jet. C'est faux : dans le jeu d'origine,
     * quatre sucettes qui arrivent une par une au fil des cascades ouvrent le
     * bonus tout autant que quatre tombees d'un coup — et c'est meme la facon
     * la plus frequente de le declencher.
     *
     * Le maximum, et non la somme : une sucette ne fait jamais partie d'un
     * amas gagnant (`gainsDe` ne parcourt que `SYMBOLES`), donc elle n'est
     * jamais retiree par une cascade. Elle RESTE sur la grille. Les additionner
     * d'une etape a l'autre compterait dix fois la meme sucette. */
    if (g.scatters > scattersVus) scattersVus = g.scatters;
    if (!g.amas.length) { etapes.push({ grille, amas: [], multi: 0 }); break; }
    multiTotal += g.multi;
    etapes.push({ grille, amas: g.amas, multi: g.multi });
    const gagnants = new Set(g.amas.map((a) => a.symbole));
    grille = faitTomber(grille, gagnants, octet);
    tours++;
    if (tours > 30) break;      // garde-fou : une cascade ne peut pas tourner sans fin
  }

  /* Les bombes tombent meme sans gain — on les montre — mais elles ne
     multiplient que s'il y a quelque chose a multiplier. */
  const bombes = [];
  if (gratuit) {
    for (let i = 0; i < BOMBES_ESSAIS; i++) {
      if (entier(octet, 10000) < CHANCE_BOMBE * 10000) bombes.push(BOMBES[entier(octet, BOMBES.length)]);
    }
  }
  const somme = bombes.reduce((a, b) => a + b, 0);
  if (somme > 0 && multiTotal > 0) multiTotal *= somme;
  return { etapes, multi: multiTotal, scatters: scattersVus, bombes, bombe: somme };
}

/* ---------------------------------------------------- L'ACHAT DU BONUS
 *
 * On paie un prix fixe en multiples de la mise et on entre DIRECTEMENT dans
 * les tours gratuits, sans jet de base.
 *
 * LE PRIX N'EST PAS CHOISI, IL EST CALCULE. Un tour gratuit rend en moyenne
 * un certain multiple ; le prix doit etre ce multiple divise par le taux de
 * retour vise, sinon l'achat paie mieux — ou moins bien — que le jeu normal.
 * Un achat mal tarife, c'est une fuite a chaque clic, et elle ne se voit pas
 * dans les comptes avant des milliers de tours.
 *
 * `mesureAchat()` plus bas refait la mesure. PRIX_BONUS y est accroche : si
 * le barème ou les bombes changent, il faut relancer et remettre le chiffre.
 */
/* MESURE sur 200 000 achats simules : une serie de dix tours gratuits rend
 * en moyenne 69,34x la mise (IC 95 % ±0,40), le plus gros vu a 2 691x. Pour
 * que l'achat rende AUTANT que le jeu normal — 94,65 % — il doit couter
 * 69,34 / 0,9465 = 73,3x. Retenu : 73.
 *
 * A 100x, le premier chiffre venu, l'achat n'aurait rendu que 69 % : trente
 * points de moins que le jeu normal, sur le bouton le plus cher de la page.
 * Un joueur qui compte s'en apercevrait, et il aurait raison. */
let PRIX_BONUS = 73;             // en multiples de la mise — MESURE, voir ci-dessus

/** La serie de tours gratuits seule, sans jet de base. */
function serieGratuite(octet) {
  const gratuits = [];
  let multi = 0;
  for (let i = 0; i < TOURS_GRATUITS; i++) {
    const t = unTour(octet, true);
    gratuits.push(t);
    multi += t.multi;
  }
  if (multi > GAIN_MAX) multi = GAIN_MAX;
  return { gratuits, multi };
}

function achete({ serverSeed, clientSeed, nonce, mise }) {
  const octet = fluxDe(serverSeed, clientSeed, nonce);
  const r = serieGratuite(octet);
  const cout = mise * PRIX_BONUS;
  const payout = Math.floor(mise * r.multi);
  return {
    mise, cout, multi: r.multi, payout, net: payout - cout,
    scatters: SCATTERS_POUR_TOURS, toursGratuits: r.gratuits.length,
    base: { etapes: [], multi: 0 }, gratuits: r.gratuits, achat: true,
  };
}

/** Ce que rend un achat, en moyenne, et donc ce qu'il doit couter. */
function mesureAchat(n = 200000, graine = 'achat') {
  let somme = 0, sc = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const r = achete({ serverSeed: graine, clientSeed: 'c', nonce: i, mise: 100 });
    somme += r.multi; sc += r.multi * r.multi;
    if (r.multi > max) max = r.multi;
  }
  const moy = somme / n;
  const ec = Math.sqrt(Math.max(0, sc / n - moy * moy));
  return { tours: n, moyenne: moy, ic: 1.96 * ec / Math.sqrt(n), max };
}

/**
 * Le tour que le serveur appelle.
 * Rend le detail complet : la page rejoue l'animation a partir de ca, elle ne
 * decide de rien.
 */
function joue({ serverSeed, clientSeed, nonce, mise }) {
  const octet = fluxDe(serverSeed, clientSeed, nonce);
  const base = unTour(octet, false);

  let multi = base.multi;
  const scat = base.scatters;
  if (BAREME_SCATTER[scat]) multi += BAREME_SCATTER[scat];

  const gratuits = [];
  if (scat >= SCATTERS_POUR_TOURS) {
    for (let i = 0; i < TOURS_GRATUITS; i++) {
      const t = unTour(octet, true);
      gratuits.push(t);
      multi += t.multi;
    }
  }
  if (multi > GAIN_MAX) multi = GAIN_MAX;

  const payout = Math.floor(mise * multi);
  return {
    mise, multi, payout, net: payout - mise,
    scatters: scat, toursGratuits: gratuits.length,
    base, gratuits,
  };
}

/* ================== LA MESURE ==================
 * Le taux de retour ne se calcule pas a la main sur ce jeu : la cascade et
 * les tours gratuits s'empilent. On le mesure. */
function simule(n = 200000, graine = 'mesure') {
  let mise = 0, rendu = 0, max = 0;
  let toursGratuitsDeclenches = 0, toursGagnants = 0;
  for (let i = 0; i < n; i++) {
    const r = joue({ serverSeed: graine, clientSeed: 'c', nonce: i, mise: 100 });
    mise += 100; rendu += r.payout;
    if (r.multi > max) max = r.multi;
    if (r.toursGratuits) toursGratuitsDeclenches++;
    if (r.payout > 0) toursGagnants++;
  }
  return {
    tours: n,
    rtp: rendu / mise,
    gainMoyen: rendu / n / 100,
    plusGrosGain: max,
    fréquenceGain: toursGagnants / n,
    fréquenceToursGratuits: toursGratuitsDeclenches / n,
  };
}

/* Expose UNIQUEMENT pour le reglage par mesure. Le serveur n'y touche pas. */
function _regle(o) {
  if (o.chanceBombe !== undefined) CHANCE_BOMBE = o.chanceBombe;
  if (o.poids) for (const k in o.poids) { POIDS[k] = o.poids[k]; }
  return { CHANCE_BOMBE, POIDS: Object.assign({}, POIDS) };
}

module.exports = {
  _regle,
  SYMBOLES, SCATTER, TOUS, COLONNES, RANGEES, CASES, MIN_AMAS,
  BAREME, BAREME_SCATTER, SCATTERS_POUR_TOURS, TOURS_GRATUITS,
  POIDS, BOMBES, GAIN_MAX, PRIX_BONUS, achete, mesureAchat,
  joue, simule, gainsDe, grilleNeuve, fluxDe,
};
