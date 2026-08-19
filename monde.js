'use strict';
/*
 * LE MONDE DE COMBAT — la carte, les monstres, et les regles de degats.
 *
 * ---- ce que ce fichier est, et ce qu'il n'est pas ----
 *
 * Comme boutique.js, skins.js et personnages.js, ce module est PUR : il ne
 * garde AUCUN monstre vivant, aucune position, aucun joueur. Il repond a
 * « quel biome y a-t-il ici ? », « que vaut un squelette ? », « combien de
 * degats fait cette arme contre cette defense ? ». Les monstres qui existent
 * vraiment, avec leurs points de vie du moment, vivent dans server.js — au
 * meme endroit que les positions du Nexus, et pour la meme raison : c'est le
 * SERVEUR qui tranche, jamais le navigateur.
 *
 * Ce point n'est pas un detail d'architecture. Les objets achetes avec du
 * vrai $SWOGE sont detruits a la mort du personnage, et l'XP nourrit la
 * fame. Un combat calcule dans le navigateur laisserait n'importe qui
 * s'attribuer des niveaux, ne jamais mourir, et garder des objets qu'il
 * aurait du perdre. Le client DESSINE ce monde ; il ne le decide pas.
 *
 * ---- LA CARTE : POURQUOI DES ANNEAUX ----
 *
 * Trois surfaces nous ont ete donnees — terre, neige, lave — et RotMG met
 * ses terres les plus dures AU CENTRE (les Godlands), entourees de zones
 * plus calmes. On garde cette disposition : on entre par le bord, sur la
 * terre, et plus on avance vers le coeur, plus ca chauffe. La difficulte se
 * lit donc sur le SOL, sans une seule ligne d'interface : un joueur qui voit
 * de la lave sait qu'il est loin de chez lui.
 */

const TUILE = 128;                       // meme pas que le Nexus
/* La carte grandit AVEC son peuplement, jamais avant : cinq especes et cent
   monstres sur soixante tuiles de cote donnent la meme densite qu'avant sur
   quarante. Une carte plus grande a population egale, c'est juste plus de
   marche entre deux combats. */
const CARTE = { cols: 60, rows: 60 };    // 7680 x 7680 unites de monde
const MONDE = { w: CARTE.cols * TUILE, h: CARTE.rows * TUILE };
const CENTRE = { x: MONDE.w / 2, y: MONDE.h / 2 };

/* Les rayons des anneaux, en fraction de la demi-largeur. Le coeur de lave
   est petit : c'est l'endroit ou l'on va chercher les niveaux, pas celui ou
   l'on traine. */
const ANNEAUX = [
  { biome: 'lave',  jusqua: 0.28 },
  { biome: 'neige', jusqua: 0.60 },
  { biome: 'terre', jusqua: Infinity },
];

/** Le biome sous un point du monde. */
function biomeEn(x, y) {
  const dx = x - CENTRE.x, dy = y - CENTRE.y;
  const r = Math.sqrt(dx * dx + dy * dy) / (MONDE.w / 2);
  for (const a of ANNEAUX) if (r <= a.jusqua) return a.biome;
  return 'terre';
}

/*
 * ---- LES MONSTRES ----
 *
 * Deux especes, celles dont on a le dessin. Leurs chiffres sont cales sur ce
 * qu'un joueur PEUT reellement faire, pas choisis au hasard :
 *
 *   au niveau 1  : ATT 28, DEF 13, 350 PV, arme commune 20-30
 *   au niveau 20 : ATT 55, DEF 25, 700 PV, arme mythique 90-120
 *
 * Le lime doit tomber en deux ou trois coups meme au niveau 1, sinon le
 * premier pas dans le monde est un mur. Le squelette doit demander une
 * dizaine de coups au debut et un ou deux a la fin : c'est ce qui fait
 * SENTIR les niveaux.
 *
 * `xp` n'est pas derive d'une formule : le derivait de `pv` seul aurait
 * sous-paye un monstre qui frappe fort sans encaisser. Les deux valeurs sont
 * posees pour qu'un personnage complet coute quelques centaines de morts —
 * 40 000 XP pour le niveau 20, soit environ 200 squelettes.
 */
const MONSTRES = {
  lime: {
    cle: 'lime', nom: 'Lime',
    pv: 60, att: 25, def: 0,
    vitesse: 70,          // unites/s — plus lent que le joueur (260)
    rayon: 34,            // pour les collisions et les tirs
    vue: 420,             // au-dela, il ne poursuit pas
    contact: true,        // il blesse en touchant, il ne tire pas
    cadence: 1.1,         // coups par seconde au contact
    xp: 75,
    biomes: ['terre', 'neige', 'lave'],
  },
  /* Le gardien du coeur. Ses chiffres sont poses pour qu'un joueur au
     plafond y arrive et qu'un debutant n'y arrive pas :
       niveau 20, arme mythique : 3 coups pour l'abattre, 10 pour mourir ;
       niveau 1, arme commune  : 105 coups pour l'abattre, 5 pour mourir.
     Ce n'est pas une punition, c'est une frontiere. La lave se voit de loin,
     et elle dit exactement ce qu'elle vaut. */
  lave: {
    cle: 'lave', nom: 'Magma Golem',
    pv: 420, att: 95, def: 20,
    vitesse: 88, rayon: 46, vue: 620,
    contact: true, cadence: 0.75,
    xp: 600,
    biomes: ['lave'],
  },
  /* Le revenant de glace : l'anneau du milieu n'avait que le lime et le
     squelette. Plus dur que le squelette, moins que le golem — c'est ce qui
     donne une pente au lieu d'une marche. */
  glace: {
    cle: 'glace', nom: 'Ice Revenant',
    pv: 260, att: 68, def: 14,
    vitesse: 96, rayon: 40, vue: 580,
    contact: true, cadence: 0.85,
    xp: 300,
    biomes: ['neige', 'lave'],
  },
  /* ---- LE PREMIER MONSTRE QUI TIRE ----
   * Tous les autres blessent au CONTACT : on les contourne, on les distance,
   * on choisit ses combats. L'archer change la donne — il faut se mettre a
   * couvert ou fermer la distance, et c'est ce qui fait qu'une portee d'arme
   * signifie enfin quelque chose.
   * Peu de vie et presque pas de defense : il est dangereux de loin et
   * fragile de pres, ce qui rend la reponse evidente. */
  archer: {
    cle: 'archer', nom: 'Cursed Archer',
    pv: 140, att: 45, def: 4,
    vitesse: 78, rayon: 36, vue: 620,
    contact: false,
    cadence: 0.55,
    /* Il tire de loin mais PAS de partout : sa portee est plus courte que sa
       vue, donc il avance encore avant de decocher. Sans ca il canarderait
       depuis le bord de l'ecran, sans qu'on sache d'ou. */
    tir: { portee: 470, vitesse: 360, sprite: 'maudit' },
    xp: 260,
    biomes: ['neige', 'lave'],
  },
  skeleton: {
    cle: 'skeleton', nom: 'Skeleton',
    pv: 180, att: 55, def: 8,
    vitesse: 105,
    rayon: 38,
    vue: 560,
    contact: true,
    cadence: 0.9,
    xp: 200,
    biomes: ['neige', 'lave'],
  },
};

/* Ce qui apparait dans chaque anneau, et en quelle quantite. La lave a
   desormais son espece propre — elle empruntait le squelette faute de dessin.
   Le coeur est moins peuple que le bord : ses habitants valent trois fois
   plus cher a tuer, et une foule de golems ne serait pas dure, elle serait
   impraticable. */
const PEUPLEMENT = {
  terre: { especes: ['lime'], nombre: 40 },
  neige: { especes: ['lime', 'skeleton', 'glace', 'archer'], nombre: 42 },
  lave:  { especes: ['lave', 'archer'], nombre: 18 },
};

/*
 * ---- LES ARMES ----
 *
 * Portee, cadence, nombre de projectiles et vitesse, par famille. Cette table
 * vivait dans nexus.js. Elle DEVAIT remonter ici : c'est desormais le serveur
 * qui decide si un tir touche, et deux tables — une pour dessiner, une pour
 * trancher — auraient fini par diverger. Une portee plus longue cote client
 * qu'a la lecture du serveur, et le joueur voit son projectile atteindre un
 * monstre qui ne prend rien.
 *
 * Le client la recoit du serveur au lieu de la porter. La teinte reste dedans
 * bien qu'elle ne serve qu'a l'affichage : la sortir mettrait la moitie de la
 * definition d'une arme dans un autre fichier.
 *
 * L'equilibre est celui de RotMG : une portee courte se paie par une cadence
 * elevee. La hache frappe fort et loin de personne ; les dagues piquent vite
 * et pres.
 */
const ARMES = {
  lame:    { portee: 320, tirs: 1, cadence: 3.2, vitesse: 560, teinte: '#cfe8ff' },
  hache:   { portee: 210, tirs: 1, cadence: 1.7, vitesse: 430, teinte: '#ffb06b' },
  lance:   { portee: 420, tirs: 1, cadence: 2.2, vitesse: 640, teinte: '#d8dee9' },
  arc:     { portee: 460, tirs: 2, cadence: 2.6, vitesse: 700, teinte: '#9dff9d' },
  marteau: { portee: 180, tirs: 1, cadence: 1.3, vitesse: 380, teinte: '#ffd76b' },
  dagues:  { portee: 300, tirs: 2, cadence: 4.0, vitesse: 620, teinte: '#c9a0ff' },
  /* Sans arme : court, lent, mais on tire — un joueur qui appuie et ne voit
     rien partir croit que la commande est cassee, pas qu'il lui manque un
     objet. */
  poing:   { portee: 150, tirs: 1, cadence: 1.6, vitesse: 340, teinte: '#8DA0C4' },
};
/* Les degats du poing nu, quand aucune arme n'est portee. Volontairement
   maigres : de quoi tuer un lime a la longue, pas de quoi jouer sans arme. */
const DEGATS_POING = [6, 10];

/* La vitesse du joueur, en unites/s. Le client la connait aussi pour se
   deplacer ; ici elle sert a REFUSER une position impossible — sans quoi une
   position annoncee par le navigateur permettrait de traverser la carte. */
const VITESSE_JOUEUR = 260;

/*
 * ---- LES DEGATS ----
 *
 * La formule de RotMG, pas une invention : les degats de l'arme sont
 * multiplies par (0.5 + ATT/50), puis la defense de la cible est SOUSTRAITE,
 * et le resultat ne descend jamais sous 15 % du coup avant defense. Ce
 * plancher est ce qui empeche une defense elevee de rendre un adversaire
 * strictement invulnerable — dans un jeu ou l'on peut mourir pour de bon,
 * « impossible a blesser » et « long a tuer » ne sont pas la meme chose.
 *
 * ATT 0 frappe donc a moitie, ATT 50 a plein, ATT 75 au double.
 */
const PLANCHER = 0.15;

function degatsInfliges(att, degatsArme, defCible) {
  const brut = Math.max(0, Number(degatsArme) || 0) * (0.5 + Math.max(0, Number(att) || 0) / 50);
  const apres = brut - Math.max(0, Number(defCible) || 0);
  return Math.max(Math.round(brut * PLANCHER), Math.round(apres));
}

/** Ce qu'un monstre enleve au joueur. Meme plancher, meme raison. */
function degatsSubis(attMonstre, defJoueur) {
  const brut = Math.max(0, Number(attMonstre) || 0);
  const apres = brut - Math.max(0, Number(defJoueur) || 0);
  return Math.max(Math.round(brut * PLANCHER), Math.round(apres));
}

/** Un tirage de degats d'arme entre son minimum et son maximum. `alea` est
    fourni par l'appelant pour que ce module reste testable et pur. */
function tirageArme(degats, alea) {
  if (!Array.isArray(degats) || degats.length < 2) return 0;
  const [a, b] = degats;
  return a + (b - a) * (typeof alea === 'function' ? alea() : Math.random());
}

/** Un point libre dans un anneau donne. `alea` rend [0,1). */
function pointDansBiome(biome, alea) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const i = ANNEAUX.findIndex((a) => a.biome === biome);
  if (i < 0) return null;
  const dedans = i === 0 ? 0 : ANNEAUX[i - 1].jusqua;
  const dehors = Math.min(ANNEAUX[i].jusqua, 0.94);   // jamais colle au bord
  /* Racine carree du tirage : sans elle, tirer un rayon uniformement
     entasserait les monstres au bord interieur de l'anneau, ou la surface est
     la plus petite. */
  const rad = Math.sqrt(dedans * dedans + (dehors * dehors - dedans * dedans) * r());
  const ang = r() * Math.PI * 2;
  const d = rad * (MONDE.w / 2);
  return { x: CENTRE.x + Math.cos(ang) * d, y: CENTRE.y + Math.sin(ang) * d };
}

/** La liste complete des monstres a faire naitre au demarrage du monde. */
function peuplement(alea) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const out = [];
  for (const biome of Object.keys(PEUPLEMENT)) {
    const p = PEUPLEMENT[biome];
    for (let i = 0; i < p.nombre; i++) {
      const espece = p.especes[Math.min(p.especes.length - 1, Math.floor(r() * p.especes.length))];
      const pos = pointDansBiome(biome, alea);
      if (pos) out.push({ espece, x: pos.x, y: pos.y, biome });
    }
  }
  return out;
}

module.exports = {
  TUILE, CARTE, MONDE, CENTRE, ANNEAUX, MONSTRES, PEUPLEMENT, PLANCHER,
  ARMES, DEGATS_POING, VITESSE_JOUEUR,
  biomeEn, degatsInfliges, degatsSubis, tirageArme, pointDansBiome, peuplement,
};
