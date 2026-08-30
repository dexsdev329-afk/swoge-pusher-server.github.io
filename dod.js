'use strict';
/*
 * SWOGE : DEAD SWOGE — le moteur.
 *
 * Cinq rouleaux, trois rangees, 243 facons de gagner, un Wild qui s'etire et
 * deux etages de tours gratuits. Meme charpente que `bonanza.js` : un flux
 * d'octets verifiable, un tour qui se rejoue a l'identique depuis ses trois
 * entrees, et un taux de retour qu'on MESURE au lieu de le calculer a la
 * main.
 *
 * ---- CE QUI DIFFERE DE BONANZA, ET POURQUOI CA CHANGE LE CODE ----
 *
 * Bonanza est un jeu de CASES : on regarde la grille entiere, on cherche des
 * amas de huit, on fait tomber, on recommence. Ici on regarde des COLONNES :
 * un symbole paie s'il apparait sur des rouleaux ADJACENTS en partant du
 * premier, peu importe la rangee. C'est ce qu'on appelle 243 facons — trois
 * positions sur chacun des cinq rouleaux, 3^5 = 243 chemins possibles.
 *
 * La consequence est qu'il n'y a pas de « ligne » a dessiner et pas de
 * cascade a jouer : un tour se lit d'un coup. Toute la tension vient
 * d'ailleurs — du Wild.
 *
 * ---- LE WILD QUI S'ETIRE (xNudge) ----
 *
 * Il ne tombe que sur les trois rouleaux du MILIEU. Quand il tombe, il
 * S'ETIRE pour remplir sa colonne entiere, et il gagne un multiplicateur egal
 * au nombre de rangees qu'il a du ajouter, plus une :
 *
 *     il couvre deja 3 rangees  ->  x1   (il n'a rien ajoute)
 *     il en couvre 2            ->  x2
 *     il en couvre 1            ->  x3
 *
 * Le petit vaut donc plus que le grand, et c'est voulu : le grand est facile,
 * le petit demande que le tirage soit avare. Les poids plus bas rendent le x3
 * six fois plus rare que le x1.
 *
 * Les multiplicateurs de plusieurs Wilds SE MULTIPLIENT entre eux. Trois
 * Wilds a x3 font x27 sur un seul tour.
 *
 * ---- ET EN TOURS GRATUITS, C'EST LE MULTIPLICATEUR QUI COLLE ----
 *
 * Un rouleau qui a attrape un Wild garde son multiplicateur jusqu'a la fin
 * des tours gratuits, et un nouveau Wild sur ce meme rouleau AJOUTE le sien.
 * Le total du tour reste le produit des trois. Un rouleau a x5 et un autre a
 * x4 font x20, et ca ne redescend jamais.
 *
 * ---- CE QUI COLLE EST LE MULTIPLICATEUR, PAS LE SYMBOLE ----
 *
 * Premiere version : le Wild lui-meme restait, et le rouleau restait donc
 * entierement Wild jusqu'a la fin. Mesure : 1 233 % de retour. La maison
 * perdait douze fois la mise a chaque tour.
 *
 * La raison n'etait pas le multiplicateur, c'etait le COMPTAGE DES CHEMINS.
 * Trois rouleaux entierement Wild donnent 3 x 3 x 3 = 27 chemins a n'importe
 * quel symbole present sur le premier rouleau — sur CHAQUE tour gratuit, et
 * multiplie par le produit des trois multiplicateurs. Deux emballements qui
 * se multiplient l'un l'autre.
 *
 * Le multiplicateur seul garde toute la montee — c'est lui qu'on regarde,
 * c'est lui qui fait dire « il est a x12 » — sans figer le plateau. Les
 * symboles retombent normalement, les chemins restent ceux d'un tour
 * ordinaire, et l'escalier reste entier.
 */

const crypto = require('crypto');

/* ================== LE PLATEAU ================== */

const ROULEAUX = 5, RANGEES = 3;
const CASES = ROULEAUX * RANGEES;

/* Les symboles qui paient, du moins cher au plus cher. */
const BAS   = ['j', 'q', 'k', 'a'];
const HAUTS = ['lanterne', 'pelle', 'crane'];
const PAYANTS = BAS.concat(HAUTS);
const WILD = 'wild';
const DEAD = 'dead', DEADER = 'deader';       // les deux scatters
const TOUS = PAYANTS.concat([WILD, DEAD, DEADER]);

/* Le Wild ne tombe QUE sur les rouleaux du milieu. Sur le premier il
   donnerait des gains gratuits a chaque tour ; sur le dernier il ne servirait
   qu'a prolonger. Au milieu, il complete — c'est la seule position ou il est
   a la fois utile et rare. */
const ROULEAUX_WILD = [1, 2, 3];
function wildPossible(r){ return ROULEAUX_WILD.indexOf(r) >= 0; }

/* ---- LE BAREME, PAR NOMBRE DE ROULEAUX ADJACENTS ----
 * En multiples de la mise, pour UN chemin. Le nombre de chemins multiplie
 * ensuite : trois `crane` avec deux positions sur le deuxieme rouleau font
 * deux chemins, donc deux fois la ligne du bareme.
 * Rien ici n'est un chiffre rond par hasard : ils ont ete bouges jusqu'a ce
 * que `simule()` rende le retour vise. Les changer demande de remesurer. */
/* ---- CES CHIFFRES SONT PETITS, ET C'EST NORMAL ----
 * Un bareme de LIGNES paie une fois par ligne ; un bareme de 243 CHEMINS paie
 * une fois par chemin, et un tour ordinaire en aligne plusieurs a la fois sur
 * plusieurs symboles. Le premier bareme ecrit ici etait celui d'un jeu a
 * lignes — mesure, il rendait 237 % sur le seul jeu de base. Divise par
 * trois et demi. */
const BAREME = {
  j:        { 3: 0.03, 4: 0.09, 5: 0.30 },
  q:        { 3: 0.03, 4: 0.09, 5: 0.30 },
  k:        { 3: 0.04, 4: 0.12, 5: 0.45 },
  a:        { 3: 0.04, 4: 0.12, 5: 0.45 },
  lanterne: { 3: 0.07, 4: 0.24, 5: 0.75 },
  pelle:    { 3: 0.12, 4: 0.35, 5: 1.20 },
  crane:    { 3: 0.18, 4: 0.60, 5: 2.40 },
};

/* Les poids du tirage, PAR ROULEAU : le premier et le dernier n'ont pas de
   Wild, et les scatters sont plus rares au milieu. Une table par rouleau
   plutot qu'une table unique — sans quoi il faudrait ecrire des exceptions
   ailleurs, et une exception dans un tirage est un endroit ou l'on se
   trompe. */
/* ---- LES POIDS SONT AU DIXIEME, ET IL Y A UNE RAISON ----
 * Ils etaient entiers. Passer le scatter `dead` de 3 a 4 a fait tomber la
 * frequence du bonus de 1 sur 132 a 1 sur 62 et le retour de 87 % a 131 % :
 * trois scatters n'importe ou sur quinze cases, c'est un effet CUBIQUE, et un
 * entier est un cran beaucoup trop gros pour le regler. Au dixieme, on vise. */
function poidsDe(r) {
  const p = { j: 2000, q: 2000, k: 1700, a: 1700, lanterne: 1200, pelle: 800, crane: 500 };
  /* ---- LE WILD EST LE REGLAGE LE PLUS SENSIBLE DU JEU ----
   * Il complete les chemins ET il multiplie : les deux effets se multiplient
   * l'un l'autre. Mesure : passer son poids de 4,0 a 3,6 — dix pour cent —
   * fait tomber le retour de 98,3 % a 82,9 %. Quinze points pour un dixieme.
   * D'ou le centieme ici : un cran de ce curseur vaut encore 0,4 point de
   * retour, et c'est le plus fin qu'on puisse se permettre sans que la mesure
   * ne distingue plus rien. */
  p[WILD]   = wildPossible(r) ? 395 : 0;
  p[DEAD]   = 290;
  p[DEADER] = 100;
  return p;
}
const POIDS = [];
for (let r = 0; r < ROULEAUX; r++) POIDS.push(poidsDe(r));
const POIDS_TOTAL = POIDS.map((p) => TOUS.reduce((s, k) => s + p[k], 0));

/* La taille du Wild qui tombe, et donc son multiplicateur. Le x3 est six fois
   plus rare que le x1 : c'est ce rapport qui empeche le mode gratuit de
   s'emballer, et c'est la premiere valeur a bouger si le retour derape. */
const TAILLES_WILD = [
  { taille: 3, multi: 1, poids: 6 },
  { taille: 2, multi: 2, poids: 3 },
  { taille: 1, multi: 3, poids: 1 },
];
const TAILLES_TOTAL = TAILLES_WILD.reduce((s, t) => s + t.poids, 0);

/* Les deux etages de tours gratuits. */
/* ---- LE RETOUR AU JOUEUR, MESURE SUR CE MOTEUR ----
 *
 * Affiche au joueur sur l'ecran d'information de la page. Il est MESURE
 * ici, pas recopie du jeu qui a inspire celui-ci — leur 96,51 % vaut pour
 * leurs poids, pas pour les notres.
 *
 * Il a fallu s'y reprendre. Une mesure isolee ne vaut rien sur ce jeu :
 * l'ecart-type ENTRE GRAINES est de 1,34 point, et sur 40 mesures le plus
 * bas donne 93,60 % quand le plus haut donne 99,20 %. Presque tout le
 * retour tient dans une serie de tours gratuits rare et grosse, donc une
 * seule graine dit surtout laquelle elle a tiree. Trois graines annoncaient
 * 94,83 %, dix en annoncaient 96,57 % : le desaccord etait celui du bruit,
 * pas du moteur.
 *
 * On POOLE donc, et l'intervalle vient de la dispersion entre graines —
 * c'est elle qui porte la queue lourde, pas la variance interne d'une
 * mesure.
 *
 *     40 mesures independantes de 400 000 tours = 16 millions de tours
 *     moyenne  96,35 %      mediane 96,36 %      (les deux a 0,01 point)
 *     intervalle 95 % : 95,94 % .. 96,77 %,  soit +-0,41 point
 *
 * La frequence, elle, est un simple oui/non : loi binomiale, intervalle
 * calcule, convergence rapide. Sur 4 millions de tours : un bonus tous les
 * 143 tours (141 a 144), dont un `deader` tous les 3 172.
 *
 * A REMESURER a chaque changement de poids, de bareme ou de tailles de
 * Wild — `mesure()` est la, et `dod_regles.test.js` verifie que le chiffre
 * publie n'a pas derive du moteur.
 */
const RTP = 96.35, RTP_IC = 0.41, RTP_TOURS = 16000000, BONUS_UN_SUR = 143;

const SCATTERS_POUR_TOURS = 3;
const TOURS = { [DEAD]: 12, [DEADER]: 18 };

/* Le plafond, en multiples de la mise. Il existe pour la meme raison que
   celui de Bonanza : un mode gratuit dont les multiplicateurs se cumulent n'a
   pas de maximum naturel, et une maison doit savoir ce qu'elle peut devoir.
   Mesure : il ne mord que sur un tour sur plusieurs centaines de milliers. */
const GAIN_MAX = 25000;

/* ================== L'ALEA VERIFIABLE ==================
 * Identique a Bonanza, au Plinko et au Crash de la maison : un flux d'octets
 * HMAC-SHA256(graineServeur, graineClient:nonce:compteur). Rejouer les trois
 * entrees redonne le meme tour, rouleau par rouleau. */
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
/* Un entier dans [0,max) sans biais : on rejette ce qui tombe dans la portion
   incomplete du dernier tour de roue. Un modulo simple favoriserait les
   premieres valeurs — invisible sur un tour, mesurable sur un million. */
function entier(octet, max) {
  const limite = Math.floor(65536 / max) * max;
  for (;;) {
    const v = (octet() << 8) | octet();
    if (v < limite) return v % max;
  }
}
function tireSymbole(octet, r) {
  let x = entier(octet, POIDS_TOTAL[r]);
  for (const k of TOUS) { x -= POIDS[r][k]; if (x < 0) return k; }
  return PAYANTS[0];
}
function tireTailleWild(octet) {
  let x = entier(octet, TAILLES_TOTAL);
  for (const t of TAILLES_WILD) { x -= t.poids; if (x < 0) return t; }
  return TAILLES_WILD[0];
}

/* ================== UN TOUR ==================
 *
 * `collants` porte, en tours gratuits, le multiplicateur deja acquis sur
 * chaque rouleau. En jeu de base il est vide et le Wild ne vaut que pour son
 * tour.
 */
function unTour(octet, collants) {
  const grille = new Array(CASES);
  /* Le multiplicateur de chaque rouleau. On part de ce qui colle deja. */
  const multis = new Array(ROULEAUX).fill(0);
  for (let r = 0; r < ROULEAUX; r++) if (collants && collants[r]) multis[r] = collants[r];

  const wilds = [];                       // ce que la page doit animer
  for (let r = 0; r < ROULEAUX; r++) {
    const col = [];
    for (let y = 0; y < RANGEES; y++) col.push(tireSymbole(octet, r));
    /* LE WILD S'ETIRE. Des qu'il apparait une fois dans la colonne, il la
       prend ENTIERE — c'est la mecanique, pas un effet. Sa taille tiree dit
       de combien de rangees il a du grandir, et donc ce qu'il rapporte. */
    if (col.indexOf(WILD) >= 0) {
      const t = tireTailleWild(octet);
      for (let y = 0; y < RANGEES; y++) col[y] = WILD;
      multis[r] += t.multi;
      wilds.push({ rouleau: r, taille: t.taille, multi: t.multi, cumul: multis[r] });
    }
    for (let y = 0; y < RANGEES; y++) grille[y * ROULEAUX + r] = col[y];
  }

  /* Le multiplicateur du tour est le PRODUIT des rouleaux tenus. Une somme
     aurait rendu le troisieme Wild presque sans effet ; le produit est ce qui
     fait qu'un mode gratuit peut s'emballer, et c'est pour ca qu'il existe un
     plafond plus bas. */
  let multi = 1;
  for (let r = 0; r < ROULEAUX; r++) if (multis[r] > 0) multi *= multis[r];

  const gains = gainsDe(grille);
  const scat = compteScatters(grille);
  return {
    grille, wilds, multis, multi,
    lignes: gains.lignes,
    gain: gains.total * multi,
    scatters: scat,
  };
}

/** Les 243 facons. Un symbole paie s'il est present sur des rouleaux
 *  ADJACENTS en partant du premier ; le Wild remplace n'importe lequel. */
function gainsDe(grille) {
  const lignes = [];
  let total = 0;
  for (const s of PAYANTS) {
    const compte = [];
    for (let r = 0; r < ROULEAUX; r++) {
      let n = 0;
      for (let y = 0; y < RANGEES; y++) {
        const c = grille[y * ROULEAUX + r];
        if (c === s || c === WILD) n++;
      }
      compte.push(n);
    }
    /* On s'arrete au premier rouleau vide : c'est ce qui distingue « 243
       facons » d'un simple comptage. Trois puis zero puis trois ne paie que
       trois. */
    let long = 0, chemins = 1;
    for (let r = 0; r < ROULEAUX; r++) {
      if (compte[r] === 0) break;
      long++; chemins *= compte[r];
    }
    if (long >= 3 && BAREME[s][long]) {
      const gain = BAREME[s][long] * chemins;
      total += gain;
      lignes.push({ symbole: s, rouleaux: long, chemins, gain });
    }
  }
  return { total, lignes };
}

function compteScatters(grille) {
  const n = { [DEAD]: 0, [DEADER]: 0 };
  for (let i = 0; i < CASES; i++) if (n[grille[i]] !== undefined) n[grille[i]]++;
  return n;
}

/* ================== LES TOURS GRATUITS ==================
 * Les Wilds collent, leurs multiplicateurs s'ajoutent sur leur rouleau, et le
 * total du tour reste le produit. Un rouleau pris ne se relache plus. */
function serieGratuite(octet, nb) {
  const collants = new Array(ROULEAUX).fill(0);
  const tours = [];
  let total = 0;
  for (let i = 0; i < nb; i++) {
    const t = unTour(octet, collants);
    for (let r = 0; r < ROULEAUX; r++) if (t.multis[r] > 0) collants[r] = t.multis[r];
    tours.push(t);
    total += t.gain;
  }
  return { tours, total };
}

/* ================== LE TOUR COMPLET ================== */

function joue({ serverSeed, clientSeed, nonce, mise }) {
  const octet = fluxDe(serverSeed, clientSeed, nonce);
  const base = unTour(octet, null);
  let multi = base.gain;

  /* Le scatter le plus riche l'emporte : trois `deader` ouvrent le grand
     mode meme si trois `dead` sont tombes en meme temps. */
  let mode = null;
  if (base.scatters[DEADER] >= SCATTERS_POUR_TOURS) mode = DEADER;
  else if (base.scatters[DEAD] >= SCATTERS_POUR_TOURS) mode = DEAD;

  let gratuits = null;
  if (mode) {
    gratuits = serieGratuite(octet, TOURS[mode]);
    multi += gratuits.total;
  }
  if (multi > GAIN_MAX) multi = GAIN_MAX;

  const payout = Math.floor(mise * multi);
  return {
    mise, multi, payout, net: payout - mise,
    mode, scatters: base.scatters,
    toursGratuits: gratuits ? gratuits.tours.length : 0,
    base, gratuits,
  };
}

/* ================== L'ACHAT, EN QUATRE CRANS ==================
 *
 * Les prix ne sont PAS ceux du jeu qui a inspire celui-ci : ils sont mesures
 * ici, sur ce moteur, par `mesureAchat`. Recopier un prix calibre sur un
 * autre moteur, c'est vendre a l'aveugle — et l'erreur ne se voit qu'au
 * releve du coffre.
 */
/* ---- LES PRIX, MESURES SUR CE MOTEUR ----
 *
 * `rendu` est ce que le cran rapporte en moyenne, mesure sur 70 000 a 150 000
 * achats. Le prix le divise par le retour du jeu ordinaire, pour que l'achat
 * porte la MEME marge qu'un tour normal — ni piege, ni cadeau.
 *
 * ---- LES PRIX ONT ETE REFAITS ----
 *
 * Ils avaient ete calibres sur une base ESTIMEE a ~95,4 %. La vraie base,
 * mesuree depuis sur 16 millions de tours, est de 96,35 % : les quatre
 * crans etaient donc tous trop chers, et le moins cher — celui que tout le
 * monde essaie en premier — punissait le joueur de CINQ POINTS.
 *
 *     cran      rendu   ancien prix   ancien retour      nouveau   retour
 *     wild      1,458      1,6x          91,13 %          1,51x    96,56 %
 *     scatter  11,738     12,5x          93,90 %          12,2x    96,21 %
 *     dead     34,370       36x          95,47 %          35,7x    96,27 %
 *     deader  103,571      108x          95,90 %         107,5x    96,34 %
 *
 * Les quatre tiennent maintenant dans 0,35 point autour de la base. Le jeu
 * qui a inspire celui-ci annonce 94,04 % a 94,20 % pour une base a 94,09 %,
 * soit 0,16 point — c'est la bonne echelle de reference : un cran d'achat
 * ne doit etre ni un piege ni un cadeau, juste une autre facon de miser.
 *
 * `rendu` est mesure en POOLANT 40 series de 100 000 achats. Une mesure
 * isolee ne suffit pas : le rendu d'un cran porte la meme queue lourde que
 * le jeu lui-meme.
 *
 * A REFAIRE a chaque fois que la base bouge — un prix juste hier devient
 * faux quand le moteur est reregle, et rien ne le signale.
 *
 * L'ORDRE N'EST PAS CELUI DU JEU QUI A INSPIRE CELUI-CI. Chez lui le
 * « scatter boost » est le cran le moins cher et le « wild drop » vient
 * apres ; ici c'est l'inverse, parce que deux scatters ajoutes ouvrent le
 * mode pres d'une fois sur trois alors qu'un Wild garanti ne fait que
 * completer un tour. Recopier son echelle — 1,5 / 7 / 99 / 499 — aurait
 * vendu le `deader` a cinq fois son prix et le `scatter` a un huitieme du
 * sien. Les prix d'un jeu ne se recopient pas : ils se mesurent sur le
 * moteur qui paie.
 */
/* `quoi` est LU PAR LE JOUEUR, sur l'ecran d'information de la page — ce
   n'est pas un commentaire. Il est donc en anglais comme le reste de ce que
   le joueur voit ; ces quatre phrases se lisaient en francais au milieu
   d'une page anglaise. */
const CRANS = {
  wild:    { prix: 1.51,  quoi: 'a guaranteed Wild on one of the middle reels' },
  scatter: { prix: 12.2,  quoi: 'two extra scatters in the draw' },
  dead:    { prix: 35.7,  quoi: 'straight into Dead Spins' },
  deader:  { prix: 107.5, quoi: 'straight into Deader Spins' },
};
/* L'ordre d'affichage, du moins cher au plus cher. La page le lit ici
   plutot que de le redecider — deux listes finissent par diverger. */
const CRANS_ORDRE = ['wild', 'scatter', 'dead', 'deader'];

function achete({ serverSeed, clientSeed, nonce, mise, cran }) {
  const c = CRANS[cran];
  if (!c) throw new Error('unknown buy tier');
  const octet = fluxDe(serverSeed, clientSeed, nonce);
  const cout = Math.floor(mise * c.prix);

  if (cran === 'dead' || cran === 'deader') {
    const g = serieGratuite(octet, TOURS[cran === 'dead' ? DEAD : DEADER]);
    let multi = Math.min(g.total, GAIN_MAX);
    const payout = Math.floor(mise * multi);
    return { mise, cran, cout, multi, payout, net: payout - cout,
             mode: cran, toursGratuits: g.tours.length, gratuits: g };
  }

  /* Les deux crans bon marche ne donnent pas de mode : ils forcent UNE chose
     dans un tour ordinaire, et le tour se joue ensuite normalement — scatters
     compris, donc ils peuvent ouvrir le mode par eux-memes. C'est ce qui les
     rend interessants a 1,5 fois la mise. */
  const force = (cran === 'scatter') ? DEAD : WILD;
  const t = unTourForce(octet, force);
  let multi = t.gain;
  let mode = null;
  if (t.scatters[DEADER] >= SCATTERS_POUR_TOURS) mode = DEADER;
  else if (t.scatters[DEAD] >= SCATTERS_POUR_TOURS) mode = DEAD;
  let gratuits = null;
  if (mode) { gratuits = serieGratuite(octet, TOURS[mode]); multi += gratuits.total; }
  if (multi > GAIN_MAX) multi = GAIN_MAX;
  const payout = Math.floor(mise * multi);
  return { mise, cran, cout, multi, payout, net: payout - cout,
           mode, scatters: t.scatters,
           toursGratuits: gratuits ? gratuits.tours.length : 0, base: t, gratuits };
}

/** Un tour ordinaire, mais avec une chose IMPOSEE. On tire d'abord le tour,
 *  puis on pose ce qui est achete — sans quoi il faudrait deux tirages
 *  differents selon le cran, et deux tirages sont deux occasions de diverger
 *  du tour ordinaire. */
function unTourForce(octet, quoi) {
  const t = unTour(octet, null);
  if (quoi === DEAD) {
    /* ---- IL EN FAUT DEUX, PAS UN ----
     * Premiere version : on garantissait UN scatter. Mesure : le cran rendait
     * 0,78x quand un tour ordinaire en rend 0,95. Il rendait le tour PIRE.
     *
     * Deux raisons, et les deux etaient dans le code. Un scatter pose ECRASE
     * le symbole qui etait la, donc il peut casser un chemin gagnant. Et il
     * n'ouvre rien tout seul : il en faut trois. On vendait donc un tour
     * abime contre la promesse d'un tiers de bonus.
     *
     * A deux garantis, il n'en manque plus qu'un — et la, le cran vaut
     * vraiment quelque chose. On pose sur des rouleaux DIFFERENTS : deux
     * scatters sur la meme colonne se verraient mal et ne changeraient pas
     * le compte. */
    /* ---- ET ON EN AJOUTE DEUX, ON NE MONTE PAS JUSQU'A DEUX ----
     * La version d'avant remplissait JUSQU'A deux scatters. Comme il en faut
     * trois pour ouvrir, elle garantissait mathematiquement de ne jamais
     * declencher : le cran rendait 0,60x contre 0,95x pour un tour ordinaire.
     * On paie pour un tour PIRE que gratuit.
     *
     * On en AJOUTE deux, sur des rouleaux qui n'en portent pas. Le tour garde
     * les siens : celui qui en avait deja un se retrouve a trois, et le mode
     * s'ouvre. C'est ca qu'on vend. */
    const AJOUT = 2;
    const pris = new Set();
    for (let r = 0; r < ROULEAUX; r++)
      for (let y = 0; y < RANGEES; y++)
        if (t.grille[y * ROULEAUX + r] === DEAD) pris.add(r);
    let poses = 0, garde = 0;
    while (poses < AJOUT && garde++ < 60) {
      const r = entier(octet, ROULEAUX);
      if (pris.has(r)) continue;
      pris.add(r); poses++;
      t.grille[entier(octet, RANGEES) * ROULEAUX + r] = DEAD;
    }
    t.scatters = compteScatters(t.grille);
    const g = gainsDe(t.grille); t.lignes = g.lignes; t.gain = g.total * t.multi;
    return t;
  }
  /* Un Wild garanti : s'il n'y en a pas, on en pose un sur un rouleau du
     milieu tire au sort, avec sa taille tiree comme les autres. */
  if (!t.wilds.length) {
    const r = ROULEAUX_WILD[entier(octet, ROULEAUX_WILD.length)];
    const ta = tireTailleWild(octet);
    for (let y = 0; y < RANGEES; y++) t.grille[y * ROULEAUX + r] = WILD;
    t.multis[r] = ta.multi;
    t.wilds.push({ rouleau: r, taille: ta.taille, multi: ta.multi, cumul: ta.multi });
    let m = 1;
    for (let k = 0; k < ROULEAUX; k++) if (t.multis[k] > 0) m *= t.multis[k];
    t.multi = m;
    t.scatters = compteScatters(t.grille);
    const g = gainsDe(t.grille); t.lignes = g.lignes; t.gain = g.total * m;
  }
  return t;
}

/* ================== LA MESURE ==================
 * Le retour ne se calcule pas a la main sur ce jeu : les Wilds collent et
 * leurs multiplicateurs se multiplient. On le mesure, et on donne l'intervalle
 * — une moyenne sans son intervalle sur un jeu a forte variance ne dit rien. */
/* ---- POURQUOI ON NE MESURE PAS EN JOUANT DES MILLIONS DE TOURS ----
 *
 * Premiere version : jouer N tours entiers et faire la moyenne. Sur 250 000
 * tours l'intervalle de confiance faisait +-5 points de retour, et trois
 * reglages voisins rendaient 92,6 %, 101,7 % et 97,6 % — dans un ordre qui
 * n'etait meme pas monotone. Impossible de regler quoi que ce soit : on lisait
 * du bruit.
 *
 * La cause est connue : presque tout le retour tient dans un evenement rare et
 * gros. La moyenne d'un tel melange converge tres lentement.
 *
 * ON DECOMPOSE DONC, et chaque morceau se mesure bien :
 *
 *   1. le JEU DE BASE seul — frequent, petit, il converge vite ;
 *   2. la FREQUENCE du bonus — un simple oui/non, donc une loi binomiale
 *      dont l'intervalle se calcule au lieu de s'estimer, et qui ne demande
 *      meme pas de jouer les tours gratuits ;
 *   3. le GAIN MOYEN d'une serie de tours gratuits, mesure sur des series
 *      jouees a part.
 *
 * RTP = base + P(dead) x moyenne(dead) + P(deader) x moyenne(deader)
 *
 * Le meme travail rend un intervalle dix fois plus etroit, pour moins de
 * calcul. On garde `simuleBrut` pour verifier que la decomposition ne ment
 * pas : les deux doivent tomber d'accord.
 */
function mesure(n = 200000, graine = 'mesure') {
  /* 1 et 2 : un seul balayage suffit, le bonus n'est pas joue. */
  let base = 0, baseC = 0, nDead = 0, nDeader = 0;
  for (let i = 0; i < n; i++) {
    const octet = fluxDe(graine, 'c', i);
    const t = unTour(octet, null);
    base += t.gain; baseC += t.gain * t.gain;
    if (t.scatters[DEADER] >= SCATTERS_POUR_TOURS) nDeader++;
    else if (t.scatters[DEAD] >= SCATTERS_POUR_TOURS) nDead++;
  }
  const pDead = nDead / n, pDeader = nDeader / n;
  const rtpBase = base / n;
  /* La variance du jeu de base n'est PAS negligeable, contrairement a ce que
     cette fonction affirmait d'abord. Deux graines donnaient 95,1 % et 97,6 %
     pour un intervalle annonce de +-0,85 : l'ecart entre les deux mesures
     etait trois fois l'intervalle cense les contenir. Un Wild a x3 sur un
     tour ordinaire multiplie tout le gain du tour, ce qui suffit a donner au
     jeu de base une queue lourde. On la compte. */
  const ecBase = Math.sqrt(Math.max(0, baseC / n - rtpBase * rtpBase));
  const icBase = 1.96 * ecBase / Math.sqrt(n);

  /* 3 : les series, jouees a part. Moins nombreuses, mais chacune compte. */
  const serie = (mode, m) => {
    let s = 0, c = 0;
    for (let i = 0; i < m; i++) {
      const g = serieGratuite(fluxDe(graine + ':' + mode, 'c', i), TOURS[mode]);
      s += g.total; c += g.total * g.total;
    }
    const moy = s / m;
    const ec = Math.sqrt(Math.max(0, c / m - moy * moy));
    return { moy, ic: 1.96 * ec / Math.sqrt(m) };
  };
  const gDead = serie(DEAD, 40000), gDeader = serie(DEADER, 40000);

  const rtp = rtpBase + pDead * gDead.moy + pDeader * gDeader.moy;
  /* L'intervalle : les trois sources ajoutees en quadrature — la base, et les
     deux moyennes de series ponderees par leur frequence. Celui de la
     frequence elle-meme reste negligeable devant les trois. */
  const ic = Math.sqrt(icBase * icBase
                     + Math.pow(pDead * gDead.ic, 2)
                     + Math.pow(pDeader * gDeader.ic, 2));
  return {
    n, rtp, ic, bas: rtp - ic, haut: rtp + ic,
    base: rtpBase, icBase,
    bonus: pDead * gDead.moy + pDeader * gDeader.moy,
    pDead, pDeader, unSur: Math.round(1 / (pDead + pDeader)),
    moyDead: gDead.moy, moyDeader: gDeader.moy,
  };
}

/** La mesure brute, gardee pour controler la decomposition. */
function simuleBrut(n = 200000, graine = 'brut') {
  let somme = 0, carres = 0, bonus = 0, max = 0, plafonne = 0;
  for (let i = 0; i < n; i++) {
    const t = joue({ serverSeed: graine, clientSeed: 'c', nonce: i, mise: 1 });
    somme += t.multi; carres += t.multi * t.multi;
    if (t.mode) bonus++;
    if (t.multi >= GAIN_MAX) plafonne++;
    if (t.multi > max) max = t.multi;
  }
  const moy = somme / n;
  const ec = Math.sqrt(Math.max(0, carres / n - moy * moy));
  const ic = 1.96 * ec / Math.sqrt(n);
  return { n, rtp: moy, ic, bas: moy - ic, haut: moy + ic,
           bonus, unSur: bonus ? Math.round(n / bonus) : Infinity, max, plafonne };
}

/** Le prix JUSTE d'un cran : ce qu'il rend en moyenne, qu'on facturera avec
 *  la meme marge que le jeu ordinaire. */
function mesureAchat(cran, n = 100000, graine = 'achat') {
  let somme = 0, carres = 0;
  for (let i = 0; i < n; i++) {
    const r = achete({ serverSeed: graine, clientSeed: 'c', nonce: i, mise: 1, cran });
    somme += r.multi; carres += r.multi * r.multi;
  }
  const moy = somme / n;
  const ecart = Math.sqrt(Math.max(0, carres / n - moy * moy));
  return { cran, n, rendu: moy, ic: 1.96 * ecart / Math.sqrt(n) };
}

module.exports = {
  RTP, RTP_IC, RTP_TOURS, BONUS_UN_SUR,
  ROULEAUX, RANGEES, CASES, BAS, HAUTS, PAYANTS, WILD, DEAD, DEADER, TOUS,
  ROULEAUX_WILD, BAREME, POIDS, TAILLES_WILD, SCATTERS_POUR_TOURS, TOURS,
  GAIN_MAX, CRANS, CRANS_ORDRE,
  fluxDe, entier, tireSymbole, unTour, gainsDe, compteScatters,
  serieGratuite, joue, achete, unTourForce, mesure, simuleBrut, mesureAchat,
};
