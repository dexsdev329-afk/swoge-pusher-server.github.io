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
/*
 * ---- CINQ ANNEAUX, DU BORD AU COEUR ----
 *
 * Trois ne suffisaient plus : le saut de la neige a la lave demandait de
 * passer d'un squelette a un golem qui frappe trois fois plus fort, sans
 * rien entre les deux. Deux anneaux s'intercalent, et chacun apporte UNE
 * chose nouvelle plutot qu'un cran de difficulte de plus.
 *
 * La regle qui gouverne tout : ON LIT LE DANGER AU SOL. Chaque anneau a sa
 * propre tuile, et un joueur doit pouvoir dire ou il est sans regarder la
 * mini-carte. C'est pour ca qu'ajouter des anneaux exigeait d'abord des
 * dessins de sol — un anneau qui ressemble a son voisin est un piege.
 *
 * Les rayons sont donnes en part du demi-cote de la carte. Ils se resserrent
 * vers le centre : l'anneau exterieur est le plus grand parce qu'on y passe
 * le plus de temps, et le coeur est petit parce qu'on n'y survit pas
 * longtemps.
 */
const ANNEAUX = [
  { biome: 'lave',    jusqua: 0.20 },   // le coeur
  { biome: 'cendres', jusqua: 0.38 },   // ce qui a brule
  { biome: 'neige',   jusqua: 0.58 },   // le froid
  { biome: 'marais',  jusqua: 0.78 },   // la boue
  { biome: 'terre',   jusqua: Infinity }, // la plaine, ou l'on apprend
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
  /* ---- TOUT LE MONDE TIRE, ET GARDE SON CONTACT ----
   *
   * Les creatures de contact ne tiraient pas, celles qui tiraient ne
   * touchaient pas. On les contournait donc toujours de la meme facon : on
   * courait autour des unes et on fuyait les autres.
   *
   * Elles font maintenant les DEUX, comme dans RotMG : elles poursuivent,
   * elles blessent en touchant, et elles decochent quand la distance le
   * permet. Il n'y a plus d'endroit sur (ni loin ni pres), seulement des
   * endroits qu'on choisit.
   *
   * Le tir frappe MOINS FORT que le contact (`tir.att` est toujours plus bas
   * que `att`) : sans ca, ajouter une attaque a distance a six creatures
   * aurait double la difficulte du monde d'un coup. Le tir gene, le contact
   * punit.
   */
  lime: {
    cle: 'lime', nom: 'Lime',
    pv: 60, att: 25, def: 0,
    vitesse: 70,          // unites/s — plus lent que le joueur (260)
    rayon: 34,            // pour les collisions et les tirs
    vue: 420,             // au-dela, il ne poursuit pas
    contact: true,        // il poursuit et blesse en touchant
    cadence: 1.1,         // coups par seconde au contact
    /* Il crache, lentement, sans aucun effet. C'est la creature sur laquelle
       on apprend a esquiver : lui donner un etat en plus punirait la seule
       chose qu'il est la pour enseigner. */
    tir: { portee: 300, vitesse: 240, sprite: 'bave', att: 14, cadence: 0.5 },
    xp: 75,
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
    /* La BRULURE. Elle ignore la defense — c'est la seule chose du jeu qu'une
       armure ne bloque pas, donc la seule raison de reculer quand on est bien
       protege. Le golem devient ainsi ce qu'il doit etre : pas un mur de
       points de vie, une raison de ne pas rester. */
    tir: { portee: 460, vitesse: 320, sprite: 'braise', att: 48, cadence: 0.4,
           effet: 'brulure' },
    xp: 600,
  },
  /* Le revenant de glace : l'anneau du milieu n'avait que le lime et le
     squelette. Plus dur que le squelette, moins que le golem — c'est ce qui
     donne une pente au lieu d'une marche. */
  glace: {
    cle: 'glace', nom: 'Ice Revenant',
    pv: 260, att: 68, def: 14,
    vitesse: 96, rayon: 40, vue: 580,
    contact: true, cadence: 0.85,
    /* Le RALENTISSEMENT, et c'est le pire de sa part : il court deja plus
       vite que les autres. Etre ralenti devant un revenant, c'est le voir
       arriver en sachant qu'on n'ira pas plus loin. Le contre existe et il
       est clair — l'abattre AVANT qu'il touche, ou avoir garde son pouvoir. */
    tir: { portee: 420, vitesse: 300, sprite: 'gel', att: 30, cadence: 0.55,
           effet: 'ralenti' },
    xp: 300,
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
    tir: { portee: 470, vitesse: 360, sprite: 'maudit', cadence: 0.55 },
    xp: 260,
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
    tir: { portee: 520, vitesse: 300, sprite: 'oeil', att: 34, cadence: 0.4,
           effet: 'paralyse' },
    xp: 480,
  },
  /* ---- LE RODEUR DU MARAIS ----
   * Sa specialite n'est ni un etat ni une forme de tir : c'est la VITESSE.
   * A 150 unites par seconde il est de loin le plus rapide du monde — un
   * squelette en fait 105 — et il est le premier a poser la question « je
   * fuis ou je me bats ? » a un joueur qui pouvait jusque-la toujours fuir.
   *
   * Il reste distancable : le personnage le plus lent court a 202. On perd du
   * terrain lentement, jamais d'un coup. C'est de l'inquietude, pas une
   * condamnation.
   *
   * Peu de vie et presque pas de defense, comme tout ce qui va vite. */
  rodeur: {
    cle: 'rodeur', nom: 'Bog Stalker',
    pv: 150, att: 48, def: 6,
    vitesse: 150, rayon: 36, vue: 640,
    contact: true, cadence: 1.0,
    tir: { portee: 300, vitesse: 300, sprite: 'bave', att: 20, cadence: 0.5 },
    xp: 190,
  },
  /* ---- L'ORACLE DES CENDRES ----
   * Il ne prend ni la vie ni le controle : il prend le MANA. C'est la seule
   * creature qui s'attaque a ce qu'on garde en reserve, et depuis que le mana
   * paie le pouvoir du fruit, se faire vider par un oracle veut dire perdre
   * son eclair au moment ou l'on en aurait eu besoin.
   *
   * L'effet est INSTANTANE et non un etat : rien a decompter, rien a dont on
   * puisse etre immunise. Le contre est evident et propre — l'abattre en
   * premier, ou lancer son pouvoir avant qu'il ne touche.
   *
   * Il garde ses distances comme l'archer et la meduse : de pres il ne vaut
   * rien, et c'est ce qui rend la reponse lisible. */
  oracle: {
    cle: 'oracle', nom: 'Ash Oracle',
    pv: 280, att: 55, def: 16,
    vitesse: 62, rayon: 40, vue: 660,
    contact: false, cadence: 0.45,
    tir: { portee: 560, vitesse: 290, sprite: 'rune', att: 38, cadence: 0.45,
           drainMp: 40 },
    xp: 420,
  },
  /* ---- LA NUEE : LA PLUS PETITE CHOSE DU MONDE ----
   * Toutes les creatures faisaient la meme taille a l'ecran. Celle-ci est
   * dessinee a 48 pixels contre 102 pour le lime — assez pour qu'on sache ce
   * qui arrive avant d'avoir lu sa barre de vie, et c'est tout l'interet
   * d'avoir enfin des tailles.
   *
   * Un rayon de 16 la rend aussi plus difficile a toucher que tout le reste.
   * C'est le prix assume de la petitesse : elle meurt d'un seul coup, encore
   * faut-il le placer.
   *
   * Elle ne vaut rien seule : quarante points de vie, seize de degat. Elle
   * vaut par le NOMBRE — dans le marais elle pese deux fois ses voisines. Ce
   * qu'elle apprend, c'est qu'on ne peut pas tout abattre avant que ca
   * arrive : il faut choisir, ou reculer.
   *
   * Elle est rapide, mais moins que le rodeur : celui-la reste la creature
   * dont on parle quand on parle de vitesse. */
  nuee: {
    cle: 'nuee', nom: 'Mite Swarm',
    pv: 40, att: 16, def: 0,
    vitesse: 140, rayon: 16, vue: 400,
    contact: true, cadence: 1.2,
    tir: { portee: 240, vitesse: 260, sprite: 'bave', att: 9, cadence: 0.45 },
    xp: 45,
  },
  /* ---- LE COLOSSE : LE GOLEM, EN PLUS GROS ----
   * Il ne fait rien que le golem de magma ne fasse deja : il brule, il blesse
   * au contact, il est lent. Sa difference est sa TAILLE — rayon 78 contre 46
   * — et ce que la taille change vraiment : on ne le contourne pas dans un
   * passage etroit, on ne le perd pas de vue, et ses deux cent trente pixels
   * disent de loin qu'il ne faut pas etre la.
   *
   * Lui inventer un etat de plus aurait ete gratuit. Ce qu'on verifie ici,
   * c'est qu'une creature puisse etre dangereuse par son encombrement. */
  colosse: {
    cle: 'colosse', nom: 'Magma Colossus',
    pv: 900, att: 140, def: 30,
    vitesse: 52, rayon: 78, vue: 700,
    contact: true, cadence: 0.55,
    tir: { portee: 520, vitesse: 300, sprite: 'braise', att: 60, cadence: 0.35,
           effet: 'brulure' },
    xp: 1300,
  },
  /* ---- LE GARDIEN : LE PREMIER BOSS ----
   * Trois cent quinze pixels, seize cents points de vie, et une gerbe de
   * QUATRE lames en eventail large.
   *
   * Le squelette lance deja trois os — mais serres (ecart 0,22), qu'on esquive
   * en se decalant sur le cote. Le gardien ouvre a 0,50 : se decaler ne suffit
   * plus, il faut FERMER LA DISTANCE et entrer dans l'eventail la ou les
   * lames ne se sont pas encore ecartees. Deux creatures qui tirent en gerbe
   * et demandent le geste inverse — c'est ca, la difference, pas le nombre.
   *
   * Ses lames sont decoupees dans son propre dessin (tirs/eclat). Lui preter
   * un projectile d'arme de joueur aurait fait arriver quatre-vingt-cinq
   * degats sous l'image d'un coup qu'on tire soi-meme. */
  gardien: {
    cle: 'gardien', nom: 'Vault Guardian',
    pv: 1600, att: 160, def: 38,
    vitesse: 68, rayon: 105, vue: 760,
    contact: true, cadence: 0.5,
    tir: { portee: 620, vitesse: 380, sprite: 'eclat', att: 85, cadence: 0.5,
           tirs: 4, ecart: 0.50 },
    xp: 3000,
  },
  skeleton: {
    cle: 'skeleton', nom: 'Skeleton',
    pv: 180, att: 55, def: 8,
    vitesse: 105,
    rayon: 38,
    vue: 560,
    contact: true,
    cadence: 0.9,
    /* Sa specialite n'est pas un etat mais une FORME : trois os en eventail.
       On ne les esquive pas en reculant, seulement en se decalant sur le
       cote — c'est le seul monstre qui punit la fuite en ligne droite, et ca
       suffit a le rendre different sans lui donner d'effet. */
    tir: { portee: 380, vitesse: 340, sprite: 'os', att: 26, cadence: 0.45,
           tirs: 3, ecart: 0.22 },
    xp: 200,
  },
};

/* Ce qui apparait dans chaque anneau, et en quelle quantite. La lave a
   desormais son espece propre — elle empruntait le squelette faute de dessin.
   Le coeur est moins peuple que le bord : ses habitants valent trois fois
   plus cher a tuer, et une foule de golems ne serait pas dure, elle serait
   impraticable. */
/*
 * Ce qui vit dans chaque anneau. La progression n'est pas « les memes
 * creatures en plus nombreuses » : chaque anneau INTRODUIT quelque chose, et
 * ce quelque chose est ce qu'il faut apprendre pour passer au suivant.
 *
 *   terre    on apprend a esquiver un projectile          (lime)
 *   marais   on apprend qu'on peut se faire canarder      (+ archer)
 *   neige    on apprend a se decaler, et a perdre le controle (+ squelette, meduse)
 *   cendres  on apprend a fuir malgre son armure          (+ revenant)
 *   lave     on apprend qu'on ne tient pas debout ici     (+ golem)
 */
/* `poids` dit la RARETE, jamais l'appartenance : sans lui un boss sortirait
   aussi souvent qu'un lime, et l'anneau de lave en compterait quatre. Absent
   vaut 1. C'est la MEME table qui dit qui vit ou — on n'en ouvre pas une
   seconde, on lui ajoute une colonne. */
const PEUPLEMENT = {
  terre:   { especes: ['lime'], nombre: 40 },
  /* L'archer arrive des le marais : c'est la premiere creature qu'on ne peut
     pas simplement contourner, et l'apprendre tot vaut mieux que l'apprendre
     au milieu de trois autres. */
  /* La nuee pese plus que ses voisines : c'est une nuee, elle n'existe qu'au
     pluriel. Elle n'est PAS dans la terre — l'anneau du debut apprend a
     esquiver un projectile, et on n'apprend pas ca sous seize creatures. */
  marais:  { especes: ['lime', 'archer', 'rodeur', 'nuee'], nombre: 38,
             poids: { nuee: 2.2 } },
  /* La meduse n'est PAS avant la neige : perdre le controle de son
     personnage avant d'avoir compris qu'on peut encore tirer ferait
     abandonner. */
  neige:   { especes: ['lime', 'skeleton', 'archer', 'meduse', 'nuee'], nombre: 40,
             poids: { nuee: 1.5 } },
  cendres: { especes: ['skeleton', 'glace', 'archer', 'meduse', 'oracle', 'colosse'],
             nombre: 30, poids: { colosse: 0.4 } },
  /* Un seul gardien pour dix-huit places : 0,25 sur un total de 5,05, soit
     cinq pour cent. Un boss qu'on croise a chaque passage n'est plus un boss. */
  lave:    { especes: ['lave', 'glace', 'meduse', 'oracle', 'colosse', 'gardien'],
             nombre: 18, poids: { colosse: 0.8, gardien: 0.25 } },
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

/*
 * ================== CE QUE VALENT LES STATISTIQUES ==================
 *
 * Quatre des huit servaient deja : l'attaque multiplie les degats, la defense
 * les soustrait, la vitalite et la sagesse remplissent les deux barres. Deux
 * ne servaient a RIEN — la DEXTERITE et la VITESSE etaient affichees dans le
 * panneau, montaient avec les niveaux, se payaient en equipement, et ne
 * changeaient strictement rien. C'est corrige ici.
 *
 * ---- LA DEXTERITE : LA CADENCE ----
 *
 * Meme forme que les degats, et ce n'est pas un hasard : `0.5 + stat/50` est
 * deja la loi de l'attaque, et deux stats qui font le meme genre de chose
 * doivent obeir a la meme courbe, sinon personne ne peut comparer une bague
 * d'attaque a une bague de dexterite. A 0 on tire a moitie vitesse, a 50 au
 * rythme nominal de l'arme, a 100 au double.
 *
 * Le PLAFOND a 2 n'est pas cosmetique : une dague tire deja quatre fois par
 * seconde, et chaque tir est un message reseau. Au-dela du double, on paie en
 * trafic une difference que l'oeil ne voit plus.
 *
 * ---- LA VITESSE : LE DEPLACEMENT ----
 *
 * Elle ne peut PAS suivre la meme loi : 260 n'est pas un bareme par point,
 * c'est deja la vitesse d'un personnage entier. On garde donc 260 pour andy
 * (65 de vitesse) et on etale autour — de 202 pour un debutant lourd a 302
 * pour un coureur equipe. Vingt pour cent de part et d'autre : assez pour
 * choisir un personnage la-dessus, pas assez pour que le plus lent se fasse
 * rattraper par un squelette (105) ni que le plus rapide sorte de l'ecran.
 */
const CADENCE_MAX = 2;
function cadenceDe(dex) {
  return Math.min(CADENCE_MAX, 0.5 + Math.max(0, Number(dex) || 0) / 50);
}

const VITESSE_BASE = 170, VITESSE_PAR_POINT = 1.4;
function vitesseDe(spd) {
  return VITESSE_BASE + Math.max(0, Number(spd) || 0) * VITESSE_PAR_POINT;
}

/* La vitesse de reference, celle d'un personnage sans statistique de vitesse
   du tout. Elle sert de repli partout ou l'on ne connait pas encore le
   joueur — et c'est elle que le client utilise avant sa premiere fiche. */
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
 * ================== LA TOMBE ==================
 *
 * Mourir laisse une pierre sur place, une minute durant, avec le nom de
 * celui qui est tombe. Ce n'est pas de la decoration : c'est la seule facon
 * dont un joueur apprend qu'un endroit est dangereux AVANT d'y aller. Trois
 * tombes au bord de la lave en disent plus long que n'importe quel avis.
 *
 * Une minute, parce que c'est ce qu'il faut pour qu'un autre joueur passe par
 * la. Plus court et personne ne la verrait ; plus long et le monde finirait
 * pave de pierres qui ne racontent plus rien.
 *
 * Le plafond n'est pas une optimisation : c'est un garde-fou. Rien n'empeche
 * en principe cent morts dans la meme minute, et une liste sans borne finit
 * par voyager en entier vers chaque client.
 */
const TOMBE = { duree: 60, plafond: 80 };

/*
 * ================== LES TROIS ETATS ==================
 *
 * Un monstre peut retirer autre chose que des points de vie. Trois etats,
 * trois facons de gener, et chacun appartient a une creature :
 *
 *   PARALYSE  on ne bouge plus, deux secondes — la Meduse
 *   RALENTI   on bouge a moitie vitesse — le Revenant de glace
 *   BRULURE   on perd de la vie seconde apres seconde — le Golem de magma
 *
 * ---- CE QUI LES REND JOUABLES PLUTOT QU'INJUSTES ----
 *
 * 1. AUCUN N'EMPECHE DE TIRER. On perd les jambes, jamais les bras. Il reste
 *    toujours une reponse — abattre ce qui approche — au lieu de regarder
 *    mourir. C'est la difference entre paralyser et etourdir, et on ne fera
 *    jamais d'etourdissement.
 *
 * 2. CHACUN A SON IMMUNITE, ET ELLE EST PLUS LONGUE QUE L'ETAT LUI-MEME
 *    pour les deux qui retirent le CONTROLE (paralysie, ralentissement) : on
 *    passe donc toujours plus de temps a se gouverner qu'a le subir, quel que
 *    soit le nombre de creatures en face. La brulure n'a pas cette contrainte
 *    parce qu'elle ne prend le controle de rien — elle ne fait que des degats,
 *    et des degats, c'est le metier des monstres. Ce qu'on borne pour elle,
 *    c'est ce qu'elle coute par seconde dans le pire cas. Apres un etat, un nouveau
 *    tir du meme genre ne fait que des degats pendant un temps. Ca ne vient
 *    pas de RotMG — la-bas l'enchainement est possible et c'est une cause de
 *    mort celebre. Chez nous la mort detruit l'equipement paye en vrai
 *    $SWOGE : une mort sans aucune action possible n'est pas une difficulte,
 *    c'est un vol.
 *
 * 3. LES IMMUNITES SONT SEPAREES. Sortir d'une paralysie ne protege pas d'une
 *    brulure. Sinon un seul monstre suffirait a rendre tous les autres
 *    inoffensifs, et le joueur apprendrait a se faire toucher expres.
 *
 * La brulure IGNORE la defense, et c'est voulu : c'est la seule chose du jeu
 * qu'une armure ne bloque pas, donc la seule raison de fuir plutot que
 * d'encaisser. Sans elle, un personnage bien defendu n'a jamais aucune raison
 * de reculer.
 */
const EFFETS = {
  /* DEUX secondes, pas plus. Elle s'attrape en se faisant TOUCHER par un
     projectile — donc elle s'esquive, et c'est ce qui la rend acceptable —
     mais deux secondes clouees au sol dans la lave, c'est deja deux coups de
     golem encaisses sans pouvoir reculer. Au-dela on ne joue plus, on
     regarde. */
  paralyse: { duree: 2, immunite: 3.5 },
  /* ---- QUARANTE POUR CENT, ET PAS CINQUANTE ----
   * J'avais mis la moitie. Le test de peuplement a montre ce que ca donnait :
   * le personnage le plus lent tombait a 101, et un squelette en fait 105. Il
   * se faisait donc RATTRAPER en etant ralenti — freine, puis rejoint, puis
   * mordu jusqu'a la fin, sans aucune sortie. Ce n'est pas de la difficulte.
   *
   * A 0.6, le plus lent des personnages tombe a 121 : au-dessus de toutes les
   * creatures sauf le rodeur du marais, qui vit seul dans un anneau ou rien
   * ne ralentit. Le ralentissement reste tres sensible — on perd deux
   * cinquiemes de sa vitesse — mais fuir ne cesse jamais d'exister.
   *
   * Trois secondes : le temps de traverser une clairiere en se sachant en
   * retard. */
  ralenti:  { duree: 3.0, immunite: 3.5, facteur: 0.6 },
  /* Huit points par seconde pendant cinq : quarante au total, soit environ
     six pour cent d'une reserve pleine. Assez pour qu'on y pense, pas assez
     pour tuer a soi seul — c'est ce qui vient AVEC qui tue. */
  brulure:  { duree: 5.0, immunite: 3.0, parSeconde: 8 },
};

/* L'ancien nom, garde parce que trois fichiers le lisent. Ce n'est pas une
   copie : c'est la meme entree de la meme table. */
const PARALYSIE = EFFETS.paralyse;

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

/*
 * ==================== LE BUTIN ====================
 *
 * ---- pourquoi un sac AU SOL et pas un objet dans l'inventaire ----
 *
 * Un butin qui atterrit directement dans le sac ne se voit pas, ne se dispute
 * pas, et ne demande jamais de choisir. Un sac pose par terre fait les trois :
 * il faut ALLER le chercher, souvent au milieu de ce qui reste vivant, et il
 * ne dure pas. C'est la seule facon de rendre une bonne trouvaille memorable
 * au lieu d'etre une ligne qui defile.
 *
 * ---- une minute, puis plus jamais ----
 *
 * Meme duree que la tombe, et pour la meme raison : assez pour revenir apres
 * avoir nettoye la zone, trop court pour thesauriser un coin de carte. Un sac
 * qui reste indefiniment transformerait le monde en entrepot.
 *
 * ---- huit creatures, huit potions ----
 *
 * Chaque espece laisse tomber UNE stat, toujours la meme. C'est ce qui donne
 * une raison d'aller chercher telle creature plutot que la plus proche : un
 * personnage qui manque de defense sait ou aller. Un tirage au hasard parmi
 * les huit aurait donne le meme nombre de potions et aucune decision.
 *
 * La liste des stats n'est pas reecrite ici : elle se lit dans
 * POUVOIR_PAR_STAT, qui les porte deja toutes les huit. Deux listes de stats
 * dans le meme fichier finiraient par ne plus se ressembler.
 */
const SAC = {
  /* ---- HUIT PLACES, COMME LE SAC DU JOUEUR ----
   * Un sac au sol n'est pas un objet qu'on absorbe en marchant dessus : c'est
   * un CONTENANT qu'on ouvre. On voit ce qu'il y a, on prend ce qu'on veut, on
   * laisse le reste. Sans ca, un sac a deux objets dont un qu'on ne peut pas
   * porter serait impossible a vider a moitie — et le joueur perdrait la
   * trouvaille en la trouvant.
   * Huit, le meme nombre que son propre sac : deux grilles de tailles
   * differentes l'une au-dessus de l'autre se lisent mal. */
  cases: 8,
  duree: 60,      // une minute au sol
  /* Meme borne que les tombes : une liste sans plafond finirait par voyager
     en entier vers chaque client, dix fois par seconde. */
  plafond: 120,
  rayon: 56,      // a quelle distance on le ramasse
};

/* L'ordre EST celui des colonnes de objets/sacs.webp. Le dessin et la regle
   ne peuvent pas diverger tant qu'ils sont la meme liste. */
const SACS = ['brun', 'bleu', 'violet', 'or', 'rouge', 'blanc'];

const STATS_POTION = Object.keys(POUVOIR_PAR_STAT);

const POTION_DE = {
  lime: 'hp', skeleton: 'att', archer: 'dex', rodeur: 'spd',
  glace: 'def', meduse: 'wis', oracle: 'mp', lave: 'vit',
  /* Le colosse est de la meme famille que le golem : meme potion. Lui en
     donner une neuvieme aurait demande une neuvieme stat. */
  colosse: 'vit',
  /* Le boss donne N'IMPORTE LAQUELLE. C'est ce qui en fait une destination :
     on y va pour ce qui manque, pas pour ce qu'il a. */
  gardien: '*',
  /* La nuee ne donne RIEN. Quarante-cinq points d'experience ne paient pas un
     point permanent, et une creature qu'on croise seize fois par anneau
     rendrait le 1/50 sans objet. */
};

/* ---- L'ANNEAU DECIDE DE CE QU'ON PEUT GAGNER ----
 *
 * On lit deja la difficulte au sol ; on y lit maintenant la recompense. La
 * pente est la meme, et c'est ce qui rend le choix « j'avance ou je reste ? »
 * lisible sans une ligne d'interface : le terrain dit a la fois ce qu'on
 * risque et ce qu'on gagne.
 *
 * Ce fichier ne choisit PAS la piece — il ne connait pas la boutique et n'a
 * aucune raison de la connaitre. Il dit la RARETE, et la couleur du sac qui
 * va avec. Celui qui tient le catalogue tire dedans.
 */
const RARETE_ANNEAU = {
  terre: 'commun', marais: 'rare', neige: 'epique',
  cendres: 'legendaire', lave: 'mythique',
};

/* La couleur EST le prix. Un joueur qui voit un sac dore de l'autre bout de
   la carte sait ce qu'il abandonne s'il ne va pas le chercher — et un sac
   blanc a ruban rouge se voit d'encore plus loin. Le commun et le rare
   partagent le brun : ils sont ordinaires, et un halo sur tout ne distingue
   plus rien. */
const SAC_DE_RARETE = {
  commun: 'brun', rare: 'brun', epique: 'violet',
  legendaire: 'or', mythique: 'rouge', relique: 'blanc',
};

/* Une piece toutes les douze morts au bord, une toutes les cent quarante au
   coeur. Le rapport n'est pas une punition : au bord on s'equipe, au coeur on
   complete. Un mythique aussi frequent qu'un commun aurait rendu la boutique
   inutile en une soiree. */
const CHANCE_EQUIP = {
  commun: 1 / 12, rare: 1 / 18, epique: 1 / 30,
  legendaire: 1 / 60, mythique: 1 / 140,
};

/* ---- LA RELIQUE ----
 * Elle ne tombe QUE dans la lave, et le gardien en donne quarante fois plus
 * souvent que le reste. C'est ce qui fait de lui une destination plutot qu'un
 * gros monstre : on ne va pas au coeur pour ce qu'il y a par terre, on y va
 * pour LUI. */
const CHANCE_RELIQUE = { lave: 1 / 1500 };
const CHANCE_RELIQUE_BOSS = 1 / 40;

/* Un sur cinquante. Le chiffre vient de ce qu'il doit produire : environ une
   potion toutes les vingt minutes de chasse soutenue — assez rare pour qu'on
   s'en souvienne, assez frequent pour qu'on y croie encore.
   Le gardien en donne UNE A COUP SUR : il sort une fois par anneau de lave et
   porte seize cents points de vie. Un boss qu'on peut abattre pour rien ne
   vaut pas le deplacement. */
const CHANCE_POTION = { defaut: 1 / 50, gardien: 1 };
/* Le soin, lui, est ordinaire : c'est du consommable, pas une recompense.
   La nuee fait exception : on en croise seize par anneau, et un sac sur six
   en donnerait presque trois a chaque nettoyage. Ce n'est pas une question
   d'economie — c'est que l'ecran se couvre de bruns et qu'on ne voit plus le
   bleu, le seul qui compte. */
const CHANCE_SOIN = { defaut: 1 / 6, nuee: 1 / 25 };

/**
 * Ce que laisse une creature abattue, ou `null`.
 *
 * UN SEUL tirage par mort, dans cet ordre : la potion de stat d'abord, le
 * soin ensuite. Tirer les deux ferait tomber deux sacs sur la meme depouille,
 * et le sac bleu — le seul qui compte — se perdrait sous le brun.
 */
function butinDe(espece, alea, biome) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  /* ---- LA RELIQUE D'ABORD, PARCE QU'ELLE EST LA PLUS RARE ----
   * Un seul tirage par mort : ce qui passe en premier obtient son vrai taux,
   * ce qui passe apres n'a que ce qui reste. La relique doit donc etre en
   * tete, sinon son 1/1500 deviendrait 1/1800 sans que rien ne le dise. */
  const cr = espece === 'gardien' && CHANCE_RELIQUE[biome] !== undefined
    ? CHANCE_RELIQUE_BOSS
    : (CHANCE_RELIQUE[biome] || 0);
  if (cr && r() < cr) return { sac: SAC_DE_RARETE.relique, contenu: [{ objet: 'relique' }] };

  const stat = POTION_DE[espece];
  if (stat) {
    const c = CHANCE_POTION[espece] === undefined ? CHANCE_POTION.defaut : CHANCE_POTION[espece];
    if (r() < c) {
      const s = stat === '*'
        ? STATS_POTION[Math.min(STATS_POTION.length - 1, Math.floor(r() * STATS_POTION.length))]
        : stat;
      return { sac: 'bleu', contenu: [{ stat: s }] };
    }
  }
  /* L'equipement de l'anneau. Il vient APRES la potion de stat : celle-ci est
     plus rare (1/50 contre 1/12 au bord), et c'est le plus rare qui doit
     tirer en premier. */
  const rar = RARETE_ANNEAU[biome];
  if (rar && r() < CHANCE_EQUIP[rar]) {
    return { sac: SAC_DE_RARETE[rar], contenu: [{ objet: rar }] };
  }

  const cs = CHANCE_SOIN[espece] === undefined ? CHANCE_SOIN.defaut : CHANCE_SOIN[espece];
  if (r() < cs) return { sac: 'brun', contenu: [{ potion: r() < 0.5 ? 'vie' : 'mana' }] };
  return null;
}

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

/* ---- OU VIT CHAQUE ESPECE, DEDUIT ET NON DECLARE ----
 *
 * Chaque creature portait sa propre liste de biomes, en face de PEUPLEMENT
 * qui dit la meme chose autrement. Deux tables a tenir d'accord finissent
 * toujours par se contredire — et c'est arrive des le premier changement
 * d'anneaux : l'archer etait annonce dans la neige et peuple dans le marais.
 *
 * PEUPLEMENT est la seule verite : c'est lui qui fait naitre. Le reste s'en
 * deduit.
 */
const BIOMES_ESPECE = Object.keys(PEUPLEMENT).reduce((o, b) => {
  PEUPLEMENT[b].especes.forEach((e) => { (o[e] = o[e] || []).push(b); });
  return o;
}, {});
Object.keys(MONSTRES).forEach((e) => { MONSTRES[e].biomes = BIOMES_ESPECE[e] || []; });

/** La liste complete des monstres a faire naitre au demarrage du monde. */
/** Une espece tiree dans un biome, sa rarete respectee. */
function choisitEspece(p, r) {
  const poids = p.poids || {};
  const de = (e) => (poids[e] === undefined ? 1 : poids[e]);
  let total = 0;
  for (const e of p.especes) total += de(e);
  let d = r() * total;
  for (const e of p.especes) {
    d -= de(e);
    if (d <= 0) return e;
  }
  return p.especes[p.especes.length - 1];
}

function peuplement(alea) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const out = [];
  for (const biome of Object.keys(PEUPLEMENT)) {
    const p = PEUPLEMENT[biome];
    for (let i = 0; i < p.nombre; i++) {
      const espece = choisitEspece(p, r);
      const pos = pointDansBiome(biome, alea);
      if (pos) out.push({ espece, x: pos.x, y: pos.y, biome });
    }
  }
  return out;
}

module.exports = {
  TUILE, CARTE, MONDE, CENTRE, ANNEAUX, MONSTRES, PEUPLEMENT, PLANCHER,
  ARMES, DEGATS_POING, VITESSE_JOUEUR, CADENCE_MAX,
  cadenceDe, vitesseDe,
  REGEN_COEF, REGEN_REPOS, REPOS_DELAI, POUVOIRS, POUVOIR_PAR_STAT, PARALYSIE, EFFETS, TOMBE,
  SAC, SACS, POTION_DE, CHANCE_POTION, CHANCE_SOIN, STATS_POTION, butinDe,
  RARETE_ANNEAU, SAC_DE_RARETE, CHANCE_EQUIP, CHANCE_RELIQUE, CHANCE_RELIQUE_BOSS,
  biomeEn, degatsInfliges, degatsSubis, tirageArme, pointDansBiome, peuplement,
  choisitEspece,
  regenParSeconde, pouvoirDeStat,
};
