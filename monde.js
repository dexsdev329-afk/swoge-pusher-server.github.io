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
  /* ---- LA MEDUSE : LE MONSTRE QUI PARALYSE ----
   *
   * Tous les autres enlevent de la vie. Elle enleve le DEPLACEMENT, ce qui
   * est bien pire dans un monde ou l'on survit en bougeant : deux secondes et
   * demie clouee au sol a portee d'un golem de magma, et c'est fini.
   *
   * Trois choses la rendent jouable plutot qu'injuste :
   *
   *   1. ON PEUT ENCORE TIRER. C'est la difference entre PARALYSER et
   *      ETOURDIR : on perd les jambes, pas les bras. Il reste donc une
   *      reponse — abattre ce qui approche — au lieu de regarder mourir.
   *   2. ELLE TIRE LENTEMENT (une fois toutes les deux secondes et demie) et
   *      elle est LENTE. On la voit venir, on peut la contourner, et c'est
   *      elle qu'il faut viser en premier.
   *   3. ON NE PEUT PAS ETRE RE-PARALYSE TOUT DE SUITE (voir PARALYSIE).
   *      Sans cette regle, trois meduses ensemble donneraient une mort sans
   *      aucune action possible, et « pas de contre-jeu » est la seule chose
   *      qu'un monstre n'a pas le droit d'etre.
   *
   * Elle vaut cher en XP parce qu'elle change la facon de jouer un secteur,
   * pas parce qu'elle a beaucoup de vie.
   */
  meduse: {
    cle: 'meduse', nom: 'Medusa',
    /* Le dessin n'existe pas encore : elle emprunte celui du revenant de
       glace, teinte par la page. Le jour ou l'image arrive, on retire cette
       ligne et rien d'autre ne bouge — c'est pour ca qu'elle est ici, en
       donnee, et pas dans un `if` cote page. */
    sprite: 'glace',
    pv: 300, att: 40, def: 12,
    vitesse: 60, rayon: 42, vue: 640,
    contact: false,
    cadence: 0.4,
    tir: { portee: 520, vitesse: 300, sprite: 'maudit', paralyse: true },
    xp: 480,
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
  /* La meduse n'est PAS sur la terre : l'anneau exterieur est celui ou l'on
     apprend, et perdre le controle de son personnage avant d'avoir compris
     qu'on peut encore tirer ferait abandonner. Elle attend la neige. */
  neige: { especes: ['lime', 'skeleton', 'glace', 'archer', 'meduse'], nombre: 42 },
  lave:  { especes: ['lave', 'archer', 'meduse'], nombre: 18 },
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

/*
 * ================== LA PARALYSIE ==================
 *
 * Perdre le deplacement, garder le tir. La duree est calee sur ce qu'il faut
 * pour que ce soit une VRAIE peur sans etre une condamnation : deux secondes
 * et demie, c'est le temps qu'un golem de magma met a porter deux coups.
 *
 * L'IMMUNITE est la piece essentielle, et elle ne vient pas de RotMG — la-bas
 * l'enchainement de paralysies est possible et c'est une cause de mort
 * celebre. Chez nous la mort detruit l'equipement paye en vrai $SWOGE : une
 * mort sans aucune action possible n'est pas une difficulte, c'est un vol.
 * Apres chaque paralysie, un temps ou un nouveau tir paralysant ne fait que
 * des degats. Trois meduses ensemble restent donc dangereuses sans jamais
 * pouvoir clouer quelqu'un au sol indefiniment.
 *
 * L'immunite est plus longue que la paralysie : on passe donc toujours plus
 * de temps a pouvoir bouger qu'a ne pas le pouvoir, quel que soit le nombre
 * de meduses. C'est la propriete qu'on veut, et un test la verifie.
 */
const PARALYSIE = { duree: 2.5, immunite: 3.5 };

/*
 * ================== LA REGENERATION ==================
 *
 * La FORME vient de RotMG : (stat + 1) x coefficient par seconde, double au
 * repos. Le « + 1 » compte — un personnage a 0 de vitalite se soigne quand
 * meme, tres lentement, plutot que jamais.
 *
 * Le COEFFICIENT, lui, n'est pas celui de RotMG, et c'est deliberé. J'ai
 * commence par reprendre son 0.12 tel quel, et le test l'a refuse tout de
 * suite : a 75 de vitalite ca donne 9.1 PV/s, alors qu'un lime — le monstre
 * le plus faible du jeu — n'enleve que 4.4 PV/s a un personnage bien defendu,
 * plancher de degats oblige. Autrement dit, TOUS nos personnages au niveau
 * maximum devenaient litteralement invulnerables a l'anneau exterieur. Le
 * chiffre de RotMG est cale sur les degats de RotMG, ou les monstres ordinaires
 * frappent a cinquante ou cent ; le recopier sans regarder nos monstres, c'est
 * copier la moitie d'un equilibre.
 *
 * 0.05 est le plus grand coefficient rond qui garde le monstre le plus faible
 * dangereux pour le personnage le mieux defendu : la limite calculee est
 * 0.057, on descend au cran rond en dessous. Un test le verifie personnage par
 * personnage, pas sur une moyenne.
 *
 * Ce que ca donne : 40 de vitalite regenere 2.1 PV/s au combat et 4.1 au
 * repos ; 75 de vitalite, 3.8 et 7.6. Remplir une barre vide au calme demande
 * entre une minute trois quarts et trois minutes. C'est lent, et ca doit
 * l'etre pour deux raisons qui vont dans le meme sens : dans un jeu ou la mort
 * detruit l'equipement, se soigner ne doit jamais etre plus rentable que ne
 * pas se faire toucher — et nous VENDONS des potions de vie a 10 $SWOGE. Une
 * regeneration genereuse ne rendrait pas seulement les monstres inoffensifs,
 * elle viderait la boutique de son rayon le plus utile.
 *
 * Le REPOS double le debit, et c'est ce qui rend la vitalite lisible : tant
 * qu'on court et qu'on tire on se soigne au ralenti, des qu'on decroche pour
 * souffler la barre remonte deux fois plus vite.
 */
const REGEN_COEF = 0.05;
const REGEN_REPOS = 2;
/* Le delai avant que le repos compte. Assez court pour recompenser un
   decrochage volontaire, assez long pour qu'une pause entre deux tirs ne
   suffise pas. */
const REPOS_DELAI = 1.2;

function regenParSeconde(stat, auRepos) {
  const v = (Math.max(0, Number(stat) || 0) + 1) * REGEN_COEF;
  return auRepos ? v * REGEN_REPOS : v;
}

/*
 * ================== LES POUVOIRS DU FRUIT ==================
 *
 * Le mana ne servait a rien. Il sert maintenant a UNE chose : le pouvoir du
 * fruit, declenche a la barre d'espace. Trois pouvoirs, pas six — et surtout
 * pas un par famille invente a la main. Celui qu'on obtient se DEDUIT de ce
 * que le fruit favorise deja (voir PROFIL_FAMILLE cote personnages) :
 *
 *   force ou vie   (att, hp)  -> FOUDRE : un eclair, gros degats, immediat
 *   vitesse        (spd, dex) -> RAFALE : la cadence de l'arme multipliee
 *   garde ou savoir(def, wis) -> STASE  : les monstres autour figent 5 s
 *
 * Un fruit d'attaque frappe fort, un fruit de vitesse tire vite, un fruit de
 * defense arrete le monde : le pouvoir prolonge le fruit au lieu de le
 * contredire. Et parce que la regle passe par la stat, ajouter un septieme
 * fruit demain lui donne automatiquement le bon pouvoir.
 *
 * Les couts sont cales sur la regeneration de mana, pas tires au hasard :
 * avec 50 de sagesse on regagne 6.1 mana/s, donc la foudre (60) revient
 * toutes les dix secondes environ et la stase (75) toutes les douze. Le
 * temps de recharge est la pour empecher d'en enchainer deux avec une reserve
 * pleine, jamais pour etre la vraie limite — la vraie limite, c'est le mana.
 */
const POUVOIRS = {
  foudre: {
    nom: 'Lightning', cout: 60, recharge: 6, portee: 520,
    /* Trois fois le coup maximum de l'arme portee. Le multiplicateur suit
       l'arme au lieu d'etre un chiffre fixe : sinon la foudre ecraserait tout
       au debut et ne vaudrait plus rien avec une arme mythique. */
    facteur: 3,
  },
  rafale: {
    nom: 'Rapid fire', cout: 45, recharge: 8, duree: 4,
    /* Deux fois et demie la cadence. Au-dela, le client n'arrive plus a
       suivre le rythme des projectiles et le gain devient invisible. */
    facteur: 2.5,
  },
  stase: {
    nom: 'Stasis', cout: 75, recharge: 12, rayon: 380,
    /* Cinq secondes, la duree demandee. Un monstre en stase ne bouge pas, ne
       frappe pas et ne tire pas — il reste une cible. */
    duree: 5,
  },
};

/* La stat dominante du fruit -> son pouvoir. */
const POUVOIR_PAR_STAT = {
  att: 'foudre', hp: 'foudre',
  spd: 'rafale', dex: 'rafale',
  def: 'stase',  wis: 'stase',
  /* mp et vit ne sont dominants d'aucun fruit ; les lister quand meme evite
     qu'un fruit ajoute plus tard reparte sans pouvoir en silence. */
  mp: 'stase', vit: 'foudre',
};

/** Le pouvoir d'un porteur, a partir de la stat principale de son fruit.
    Rend `null` sans fruit : le poing nu ne lance pas d'eclair. */
function pouvoirDeStat(stat) {
  if (!stat) return null;
  const cle = POUVOIR_PAR_STAT[stat];
  return cle && POUVOIRS[cle] ? cle : null;
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
  REGEN_COEF, REGEN_REPOS, REPOS_DELAI, POUVOIRS, POUVOIR_PAR_STAT, PARALYSIE,
  biomeEn, degatsInfliges, degatsSubis, tirageArme, pointDansBiome, peuplement,
  regenParSeconde, pouvoirDeStat,
};
