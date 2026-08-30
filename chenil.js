'use strict';
/*
 * SWOGE : LE CHENIL — le moteur.
 *
 * Cinq rouleaux, trois rangees, VINGT LIGNES FIXES. C'est la difference de
 * fond avec DEAD SWOGE, qui paie par 243 chemins : ici un symbole ne paie
 * que s'il tombe SUR une ligne dessinee, et seule la meilleure combinaison
 * de chaque ligne est payee.
 *
 * ---- CE QUI VIENT DU JEU QUI A INSPIRE CELUI-CI, ET CE QUI N'EN VIENT PAS
 *
 * La FORME est reprise : wild sur les trois rouleaux du milieu avec un
 * multiplicateur tire a chaque tour, scatter sur les rouleaux 1-3-5, un
 * nombre de tours gratuits TIRE et non fixe, wilds collants pendant le
 * bonus, pas de redeclenchement.
 *
 * Les CHIFFRES, non. Ni les gains, ni les poids, ni le prix des achats :
 * ils sont mesures ici, sur ce moteur. Un bareme recopie d'un autre jeu ne
 * dit rien du retour du notre — c'est l'erreur qui a coute 3,4x de trop sur
 * DEAD SWOGE avant qu'on la mesure.
 *
 * ---- POURQUOI DES LIGNES ET NON DES CHEMINS ----
 *
 * DEAD SWOGE paie par chemins : trois cranes sur trois rouleaux paient
 * autant de fois qu'il y a de facons de les relier. C'est ce qui rend son
 * retour si difficile a mesurer — la variance explose. Vingt lignes fixes
 * donnent un jeu qui paie plus souvent et moins gros, et dont le retour se
 * mesure dix fois plus vite. Les deux jeux ne se ressemblent donc pas, et
 * c'est voulu.
 */

const crypto = require('crypto');

/* ================== LA GRILLE ================== */

const ROULEAUX = 5, RANGEES = 3, CASES = ROULEAUX * RANGEES;

/* Les symboles, du plus pauvre au plus riche. */
const BAS = ['dix', 'j', 'q', 'k', 'a'];
const HAUTS = ['beagle', 'etoile', 'noeud', 'collier'];
const PAYANTS = BAS.concat(HAUTS);
const WILD = 'wild';
const BONUS = 'bonus';
const TOUS = PAYANTS.concat([WILD, BONUS]);

/* Le Wild ne tombe que sur les trois rouleaux du milieu, le Bonus que sur
   le premier, le troisieme et le cinquieme. Ecrits en base ZERO comme les
   indices de rouleau ; la page les affiche en base un. */
const ROULEAUX_WILD = [1, 2, 3];
const ROULEAUX_BONUS = [0, 2, 4];

/* ================== LES VINGT LIGNES ================== */
/*
 * Chaque ligne donne la RANGEE visitee sur chacun des cinq rouleaux. Les
 * trois premieres sont les rangees droites ; les suivantes montent,
 * descendent, ou font des creux et des bosses. Elles sont ecrites en clair
 * plutot que generees : une ligne generee est une ligne que personne ne
 * peut verifier a l'oeil, et le joueur, lui, les voit dessinees.
 */
const LIGNES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 0, 1, 2, 1],
  [1, 2, 1, 0, 1], [0, 0, 1, 0, 0], [2, 2, 1, 2, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 1, 0, 1, 0],
  [2, 1, 2, 1, 2], [0, 2, 0, 2, 0],
];

/* ================== LE BAREME ==================
 *
 * En multiples de la MISE TOTALE, pour une ligne. Il est plus PLAT que
 * celui de DEAD SWOGE, et c'est delibere : la-bas, trois symboles bas
 * paient 0,03x, ce qui s'arrondit a zero des que la mise est basse — le jeu
 * annoncait « WIN +0 ». Ici le plus petit gain vaut 0,10x, donc un
 * $SWOGE entier des la mise minimale.
 */
const BAREME = {
  dix:      { 3: 0.47, 4: 0.93, 5: 1.40 },
  j:        { 3: 0.47, 4: 0.93, 5: 1.63 },
  q:        { 3: 0.47, 4: 1.16, 5: 1.63 },
  k:        { 3: 0.70, 4: 1.16, 5: 1.63 },
  a:        { 3: 0.70, 4: 1.16, 5: 1.86 },
  beagle:   { 3: 1.16, 4: 2.33, 5: 3.49 },
  etoile:   { 3: 1.40, 4: 2.56, 5: 3.95 },
  noeud:    { 3: 1.40, 4: 2.79, 5: 4.19 },
  collier:  { 3: 1.86, 4: 3.72, 5: 5.58 },
};

/* Ce que paient TROIS Bonus, ou qu'ils soient. Ils ouvrent aussi le tour. */
const BONUS_PAIE = 5;
const BONUS_POUR_TOURS = 3;

/* ---- LES POIDS ----
 * Le Wild et le Bonus ont un poids NUL sur les rouleaux qui ne les portent
 * pas : c'est la seule facon d'ecrire la regle une fois, plutot qu'un
 * `if` au tirage qu'on oublie a la relecture. */
function poidsDe(r) {
  const p = { dix: 2100, j: 2100, q: 1900, k: 1750, a: 1750,
              beagle: 3150, etoile: 2460, noeud: 2100, collier: 1410 };
  p[WILD] = ROULEAUX_WILD.indexOf(r) >= 0 ? 470 : 0;
  p[BONUS] = ROULEAUX_BONUS.indexOf(r) >= 0 ? 749 : 0;
  return p;
}

/* Le multiplicateur d'un Wild, tire a chaque fois qu'il tombe. */
const MULTIS_WILD = [{ multi: 2, poids: 3 }, { multi: 3, poids: 1 }];

/* ---- LE NOMBRE DE TOURS GRATUITS SE TIRE ----
 * Neuf cases, chacune 1, 2 ou 3 tours, et on additionne : de 9 a 27 tours,
 * centres sur 18. Un nombre FIXE aurait ete plus simple a mesurer, mais le
 * tirage est la moitie de ce qui fait attendre le bonus. */
/* ---- POURQUOI 1 OU 2, ET NON 1, 2 OU 3 ----
 * Avec 1-2-3 la serie faisait 18 tours en moyenne, et comme les Wilds
 * collent, le bonus emportait 52 % du retour pour une frequence de 1 sur
 * 264 : entre deux bonus le jeu ne payait plus rien. A 1 ou 2 la serie fait
 * 12,4 tours, et la repartition tombe a 65 % pour le jeu de base — mesure,
 * pas impression. */
const CASES_TIRAGE = 9;
const TIRAGE_TOURS = [{ n: 1, poids: 5 }, { n: 2, poids: 3 }];

const GAIN_MAX = 5000;

/* ================== LE HASARD, VERIFIABLE ================== */
/*
 * Meme construction que les autres tables : un flux d'octets tire d'un
 * HMAC de la graine du serveur, de celle du joueur et du numero de manche.
 * Le joueur peut donc refaire le calcul apres coup.
 */
function fluxDe(serverSeed, clientSeed, nonce) {
  let bloc = 0, tampon = Buffer.alloc(0), i = 0;
  return function octet() {
    if (i >= tampon.length) {
      tampon = crypto.createHmac('sha256', String(serverSeed))
        .update(String(clientSeed) + ':' + String(nonce) + ':' + bloc++).digest();
      i = 0;
    }
    return tampon[i++];
  };
}
/* Un entier dans [0,max) SANS BIAIS : on rejette ce qui tombe dans la
   portion incomplete du dernier tour de roue, plutot que de prendre un
   modulo qui favoriserait les premieres valeurs.
   DEUX OCTETS, pas un : les poids d'un rouleau totalisent une dizaine de
   milliers, et `Math.floor(256/10000)*10000` vaut ZERO — la premiere
   version bouclait donc sans fin, et la mesure ne rendait jamais la main. */
function entier(octet, max) {
  if (max <= 0) return 0;
  const limite = Math.floor(65536 / max) * max;
  for (;;) {
    const v = (octet() << 8) | octet();
    if (v < limite) return v % max;
  }
}
function tirePondere(octet, table, cle = 'poids') {
  let total = 0;
  for (const t of table) total += t[cle];
  let k = entier(octet, total);
  for (const t of table) { k -= t[cle]; if (k < 0) return t; }
  return table[table.length - 1];
}
/* Les tables sont construites UNE FOIS. Reconstruites a chaque tirage —
   c'est ce que faisait la premiere version — elles coutaient une allocation
   et un filtre par symbole tire, soit quinze par tour : la mesure ne
   finissait pas en six minutes. */
const TABLES = [];
for (let r = 0; r < ROULEAUX; r++) {
  const p = poidsDe(r);
  let total = 0;
  const cumul = TOUS.filter((s) => p[s] > 0)
    .map((s) => { total += p[s]; return { s, jusqua: total }; });
  TABLES.push({ cumul, total });
}
function tireSymbole(octet, r) {
  const t = TABLES[r];
  const k = entier(octet, t.total);
  for (const c of t.cumul) if (k < c.jusqua) return c.s;
  return t.cumul[t.cumul.length - 1].s;
}

/* ================== UN TOUR ================== */
/*
 * `collants` porte, pour chaque rouleau, le multiplicateur d'un Wild reste
 * en place — pendant les tours gratuits seulement. Un rouleau collant ne se
 * retire pas : il REMPLIT sa colonne de Wilds.
 */
/* ---- LE WILD OCCUPE UNE CASE, PAS UNE COLONNE ----
 *
 * Premiere version : un Wild prenait son rouleau ENTIER, par reflexe hérité
 * de DEAD SWOGE ou c'est la mecanique. Ici c'est faux, et ca ruinait le jeu :
 * des que les trois rouleaux du milieu avaient colle, chaque tour gratuit
 * etait un plateau plein de Wilds, donc vingt lignes payees d'office. Le
 * bonus emportait 76 % du retour pour une frequence de 1 sur 250 — le jeu
 * ne payait plus rien entre deux bonus. Mesure, pas impression.
 *
 * Le Wild tombe donc dans SA case et y reste. Ce qui est partage par
 * rouleau, c'est le MULTIPLICATEUR : tous les Wilds d'un meme rouleau
 * portent le meme, tire une fois par tour.
 */
function unTour(octet, collants, pendantBonus) {
  const grille = new Array(CASES);
  const multiDe = new Array(ROULEAUX).fill(0);
  const wilds = [];

  for (let r = 0; r < ROULEAUX; r++) {
    for (let y = 0; y < RANGEES; y++) {
      const i = y * ROULEAUX + r;
      if (collants && collants[i] > 0) { grille[i] = WILD; continue; }
      let s = tireSymbole(octet, r);
      /* Pendant les tours gratuits le Bonus ne tombe pas : le tour ne peut
         pas se redeclencher. On le retire du TIRAGE plutot que de l'ignorer
         au comptage — sinon il s'afficherait sans rien faire, et le joueur
         croirait a un bug. */
      while (pendantBonus && s === BONUS) s = tireSymbole(octet, r);
      grille[i] = s;
    }
    /* Le multiplicateur est tire une fois par rouleau, et seulement s'il y a
       un Wild dessus. Ceux qui collent gardent celui qu'ils avaient. */
    let aWild = false, colleIci = 0;
    for (let y = 0; y < RANGEES; y++) {
      const i = y * ROULEAUX + r;
      if (grille[i] === WILD) { aWild = true; if (collants && collants[i] > 0) colleIci = collants[i]; }
    }
    if (aWild) {
      multiDe[r] = colleIci > 0 ? colleIci : tirePondere(octet, MULTIS_WILD).multi;
      for (let y = 0; y < RANGEES; y++) {
        const i = y * ROULEAUX + r;
        if (grille[i] === WILD)
          wilds.push({ case: i, rouleau: r, rangee: y, multi: multiDe[r],
                       colle: !!(collants && collants[i] > 0) });
      }
    }
  }

  const g = gainsDe(grille, multiDe);
  const nBonus = grille.filter((s) => s === BONUS).length;
  return { grille, wilds, multis: multiDe, lignes: g.lignes, gain: g.total, bonus: nBonus };
}

/* ---- CE QUE PAIENT LES VINGT LIGNES ----
 * Depuis le rouleau de GAUCHE, sur des rouleaux adjacents. Le Wild remplace
 * n'importe quel symbole payant. Les multiplicateurs des Wilds presents sur
 * la ligne S'ADDITIONNENT — comme dans le jeu de reference, et contrairement
 * a DEAD SWOGE ou ils se multiplient. C'est ce qui rend celui-ci plus doux
 * et son retour bien plus facile a mesurer.
 */
function gainsDe(grille, multiDe) {
  const lignes = [];
  let total = 0;

  for (let li = 0; li < LIGNES.length; li++) {
    const l = LIGNES[li];
    const cases = l.map((y, r) => grille[y * ROULEAUX + r]);
    let meilleur = null;
    for (const s of PAYANTS) {
      let n = 0;
      while (n < ROULEAUX && (cases[n] === s || cases[n] === WILD)) n++;
      /* Une ligne entierement Wild ne paie pas comme un symbole invente :
         elle paie le MEILLEUR symbole, ce que la boucle fait deja puisque
         chaque symbole est essaye. */
      if (n < 3) continue;
      const base = (BAREME[s] || {})[n];
      if (!base) continue;
      /* Seuls comptent les multiplicateurs des rouleaux ou la ligne passe
         VRAIMENT sur un Wild : un rouleau peut porter un Wild ailleurs que
         sur cette ligne. */
      let mult = 0;
      for (let r = 0; r < n; r++)
        if (multiDe[r] && cases[r] === WILD) mult += multiDe[r];
      const gain = base * (mult > 0 ? mult : 1);
      if (!meilleur || gain > meilleur.gain)
        meilleur = { ligne: li, symbole: s, rouleaux: n, multi: mult, gain };
    }
    if (meilleur) { lignes.push(meilleur); total += meilleur.gain; }
  }
  return { lignes, total };
}

/* ================== LA SERIE DE TOURS GRATUITS ================== */

function tireNombreDeTours(octet) {
  const cases = [];
  let n = 0;
  for (let i = 0; i < CASES_TIRAGE; i++) {
    const v = tirePondere(octet, TIRAGE_TOURS).n;
    cases.push(v); n += v;
  }
  return { cases, tours: n };
}

function serieGratuite(octet, nb) {
  const collants = new Array(CASES).fill(0);
  const tours = [];
  let total = 0;
  for (let i = 0; i < nb; i++) {
    const t = unTour(octet, collants, true);
    /* Ce qui est tombe COLLE pour la suite de la serie, avec son
       multiplicateur. Un Wild qui retombe sur un rouleau deja tenu n'ajoute
       rien : le rouleau est deja plein. */
    /* Ce qui est tombe COLLE dans SA CASE, avec son multiplicateur. */
    for (const w of t.wilds) if (!collants[w.case]) collants[w.case] = w.multi;
    tours.push(t);
    total += t.gain;
  }
  return { tours, total };
}

/* ================== LA MANCHE COMPLETE ================== */

function joue({ serverSeed, clientSeed, nonce, mise }) {
  const octet = fluxDe(serverSeed, clientSeed, nonce);
  const base = unTour(octet, null, false);
  let multi = base.gain;

  /* Trois Bonus PAIENT, en plus d'ouvrir la serie. */
  const ouvre = base.bonus >= BONUS_POUR_TOURS;
  if (ouvre) multi += BONUS_PAIE;

  let tirage = null, gratuits = null;
  if (ouvre) {
    tirage = tireNombreDeTours(octet);
    gratuits = serieGratuite(octet, tirage.tours);
    multi += gratuits.total;
  }
  if (multi > GAIN_MAX) multi = GAIN_MAX;

  const payout = Math.floor(mise * multi);
  return {
    mise, multi, payout, net: payout - mise,
    bonus: base.bonus, ouvre,
    toursGratuits: tirage ? tirage.tours : 0,
    tirage, base, gratuits,
  };
}

/* ================== LA MESURE ==================
 *
 * Meme lecon que sur DEAD SWOGE : on DECOMPOSE. Le jeu de base converge
 * vite, la frequence du bonus est une binomiale, et la serie se mesure a
 * part. Mesurer en jouant des manches entieres marcherait ici — la variance
 * est bien plus basse qu'avec des chemins — mais la decomposition reste
 * dix fois plus serree pour le meme calcul.
 */
function mesure(n = 200000, graine = 'mesure') {
  let base = 0, baseC = 0, nOuvre = 0;
  for (let i = 0; i < n; i++) {
    const octet = fluxDe(graine, 'c', i);
    const t = unTour(octet, null, false);
    base += t.gain; baseC += t.gain * t.gain;
    if (t.bonus >= BONUS_POUR_TOURS) nOuvre++;
  }
  const p = nOuvre / n;
  const rtpBase = base / n;
  const ecBase = Math.sqrt(Math.max(0, baseC / n - rtpBase * rtpBase));
  const icBase = 1.96 * ecBase / Math.sqrt(n);

  const m = Math.max(4000, Math.round(n / 10));
  let s = 0, c = 0, sTours = 0;
  for (let i = 0; i < m; i++) {
    const octet = fluxDe(graine + ':serie', 'c', i);
    const tir = tireNombreDeTours(octet);
    const g = serieGratuite(octet, tir.tours);
    const v = g.total + BONUS_PAIE;
    s += v; c += v * v; sTours += tir.tours;
  }
  const moy = s / m;
  const ec = Math.sqrt(Math.max(0, c / m - moy * moy));
  const ic = 1.96 * ec / Math.sqrt(m);

  const rtp = rtpBase + p * moy;
  return {
    n, rtp, ic: Math.sqrt(icBase * icBase + Math.pow(p * ic, 2)),
    base: rtpBase, bonus: p * moy, p, unSur: Math.round(1 / p),
    moySerie: moy, moyTours: sTours / m,
  };
}

module.exports = {
  ROULEAUX, RANGEES, CASES, BAS, HAUTS, PAYANTS, WILD, BONUS, TOUS,
  ROULEAUX_WILD, ROULEAUX_BONUS, LIGNES, BAREME, BONUS_PAIE, BONUS_POUR_TOURS,
  MULTIS_WILD, CASES_TIRAGE, TIRAGE_TOURS, GAIN_MAX,
  poidsDe, fluxDe, unTour, gainsDe, tireNombreDeTours, serieGratuite, joue, mesure,
};
