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
 * ==================== CE QUI BLOQUE LE PASSAGE ====================
 *
 * Le monde etait un tapis : on le traversait en ligne droite, dans n'importe
 * quelle direction, et fuir revenait toujours a courir vers l'exterieur. Une
 * carte sans obstacle n'a qu'une seule tactique.
 *
 * Des blocs solides changent trois choses a la fois, et c'est pour ca qu'ils
 * valent mieux que trois regles separees :
 *
 *   - ils donnent des COUVERTS. Un archer qui canarde de loin cesse d'etre
 *     une fatalite des qu'il y a un rocher entre lui et nous.
 *   - ils rendent la VITESSE utile autrement qu'en ligne droite : contourner
 *     coute du temps, et le colosse ne contourne pas — il attend.
 *   - ils font des COULOIRS, donc des embuscades, donc des endroits qu'on
 *     apprend a ne pas prendre.
 *
 * Ils arretent AUSSI les projectiles, les notres comme les leurs. Un mur
 * qu'on traverse a l'arc n'est pas un mur, c'est une decoration — et le
 * couvert n'existerait pas.
 *
 * Le dessin depend de l'anneau : rocher moussu, souche morte, pilier de
 * glace, aiguille de basalte. On lit donc l'obstacle comme on lit le sol.
 */
const OBSTACLE = {
  rayon: 44,        // le pied du dessin, pas sa hauteur
  nombre: 240,
  /* Une CLAIRIERE au centre exact : c'est la que vit le gardien, et un boss de
     trois cent quinze pixels coince entre deux rochers ne se combat pas, il
     se subit.
     420 et pas 900 : l'anneau de lave s'arrete a 768 du centre, et une
     clairiere plus large que lui aurait laisse tout le coeur sans un seul
     rocher — l'anneau le plus dur du jeu aurait ete le seul terrain plat. */
  clairiere: 420,
};
/* L'index de colonne dans tiles/obstacles.webp. Le marais garde la souche
   morte, la terre le rocher : deux anneaux voisins qui se ressemblent
   effaceraient justement ce que l'obstacle apporte — savoir ou l'on est. */
const OBSTACLE_BIOME = { terre: 0, marais: 1, neige: 2, cendres: 3, lave: 3 };

/*
 * ==================== LES SALLES GARDEES ====================
 *
 * Le monde n'avait qu'une seule raison d'avancer : les monstres y frappent
 * plus fort. C'est une pente, pas une DESTINATION — rien nulle part ne disait
 * « va la ».
 *
 * Une salle gardee en est une. Un carre de dalles de temple, ceint de murs,
 * une seule porte, et des gardiens dedans. On la voit de loin — le sol change
 * — on sait ce qu'elle contient avant d'entrer, et on choisit d'y aller ou
 * non. Vider la salle laisse le butin au centre.
 *
 * ---- pourquoi les murs sont des obstacles comme les autres ----
 *
 * Ils entrent dans la MEME liste que les rochers. Une deuxieme sorte de mur
 * aurait demande sa propre collision, son propre arret de projectiles, son
 * propre tri de dessin — trois occasions d'oublier la moitie d'une regle. Ici
 * il n'y en a qu'une : ce qui est dans la liste bloque, point. Seul le dessin
 * change, et c'est `t` qui le dit.
 *
 * ---- une seule porte ----
 *
 * C'est ce qui fait la difference entre une salle et un enclos. Une entree
 * unique veut dire qu'on sait par ou l'on ressortira, que les gardiens s'y
 * massent, et qu'on ne peut pas se contenter de fuir en ligne droite. Un mur
 * qui aurait quatre ouvertures ne serait qu'une decoration au sol.
 */
/*
 * ==================== LE DONJON ====================
 *
 * Ce qu'Optimus ouvre en mourant. Les quatre creatures qui le peuplent ne
 * naissent nulle part ailleurs : c'est ecrit ICI, et pas en dur dans la
 * simulation, pour qu'un essai puisse demander « quelles especes ne vivent que
 * dans un donjon ? » sans lire realm.js.
 *
 * `boss` est celle du fond. Elle ne se compte pas dans la population : un
 * donjon a UN boss, pas un boss par tirage.
 */
/*
 * ---- LA TABLE DES DONJONS ----
 *
 * Il y en avait un, et il s'appelait `DONJON`. Le deuxieme aurait pu s'ecrire
 * en dupliquant les fonctions de plan avec un `if (nom === 'cave')` dedans —
 * et le troisieme aurait ajoute un `else if`. Une TABLE, plutot : un donjon
 * est une entree, avec ses creatures, son boss, ce qui l'ouvre, et la FORME
 * de son plan. Le jour ou il y en a cinq, `planDeDonjon` ne bouge pas d'une
 * ligne.
 *
 * `forme` nomme le generateur, il ne le contient pas : les plans vivent plus
 * bas, avec les tuiles et les murs, parce que c'est de la geometrie et pas du
 * peuplement.
 */
const DONJONS = {
  forge: {
    nom: 'The Forge',
    forme: 'couloir',
    especes: ['drone', 'ferraille', 'bobine'],
    boss: 'fonderie',
    /* Ce qui l'ouvre. Ecrit ici pour la meme raison : le monde dit QUI ouvre
       un donjon, la simulation se contente de le constater. */
    ouvreur: 'optimus',
    sol: 'donjon',
    mur: 'donjon',
  },
  /* ---- LA CAVE DES PIRATES ----
   *
   * L'autre bout de l'echelle. La Fonderie s'ouvre sur la creature la plus
   * dure de l'anneau le plus dur et garde une relique au fond ; celle-ci
   * s'ouvre bien plus tot et rend des pieces ordinaires. C'est ce qui en fait
   * un premier donjon : on y entre pour APPRENDRE ce qu'est un donjon, pas
   * pour y risquer un equipement paye en argent reel.
   *
   * Sa forme est son autre difference : un reseau de salles rondes de tailles
   * variables, relies par des passages etroits — on ne voit jamais la salle
   * suivante depuis celle ou l'on est, et il faut choisir un embranchement.
   * La Fonderie, elle, est un couloir : trois salles en ligne, et l'on sait
   * toujours ou l'on va. Deux formes, deux facons de se sentir dedans.
   */
  cave: {
    nom: 'Pirate Cave',
    forme: 'grotte',
    especes: ['pirate', 'piratesse', 'lieutenant'],
    boss: 'dreadstump',
    ouvreur: 'carapace',
    sol: 'cave',
    mur: 'cave',
  },
};
/* L'ancien nom pointe sur la Fonderie : tout ce qui disait `DONJON` parlait
   d'elle, et rien de ce qui la nomme n'a besoin de savoir qu'il y en a deux. */
const DONJON = DONJONS.forge;

/*
 * ---- LE PORTAIL ----
 *
 * Ce qu'Optimus laisse en mourant, un peu au-dela de son sac : une porte
 * ouverte dans le sol, qu'on franchit ou non.
 *
 * `PORTAIL_DE` est une TABLE, et pas un drapeau sur Optimus. Un booleen
 * `ouvreDonjon: true` dans MONSTRES aurait dit « celui-la ouvre quelque
 * chose » sans dire quoi ; le jour ou une deuxieme creature ouvre un
 * deuxieme donjon, il aurait fallu un deuxieme booleen et une cascade de
 * `if` pour les distinguer. Ici la reponse EST la valeur : le nom du donjon
 * derriere la porte. Une creature absente de la table n'ouvre rien, ce qui
 * est le cas de vingt et une des vingt-deux.
 *
 * `recul` est la distance DERRIERE la creature, dans le sens ou le tueur
 * l'a poussee. Le sac tombe sur place ; la porte se pose plus loin. Sans ce
 * decalage, les deux occuperaient le meme metre carre : on ramasserait le
 * butin et l'on serait entre dans le donjon du meme pas, sans avoir eu a
 * choisir — or le choix EST la question qu'un portail pose.
 *
 * `duree` est genereuse (trois minutes contre une pour un sac) parce que ce
 * n'est pas la meme decision. Un sac se ramasse sans y penser ; entrer
 * demande de regarder sa vie, son mana et ce qu'on porte, et souvent
 * d'attendre quelqu'un. Une porte qui se refermerait en soixante secondes
 * forcerait a entrer sans reflechir, ou a ne jamais entrer du tout.
 */
const PORTAIL = {
  /* ---- LA PORTE D'ENTREE NE DURE PAS ----
   * Quarante secondes : on vient d'abattre la creature la plus dure de
   * l'anneau, la porte s'ouvre derriere elle, et il faut DECIDER. Trois
   * minutes laissaient le temps de finir son ramassage, de remonter sa vie et
   * d'y entrer au calme — ce qui revenait a supprimer le choix.
   * C'est court, et c'est voulu : la porte fait partie de la recompense, pas
   * un rendez-vous qu'on prend pour plus tard. */
  duree: 40,
  /* ---- LA PORTE DE SORTIE, ELLE, NE SE FERME JAMAIS ----
   * Celle qui s'ouvre sur le cadavre du boss ramene au monde. Lui donner une
   * duree en faisait un piege : on ressort de la salle du fond, on fouille son
   * butin, la porte disparait — et le seul chemin restant est de retraverser
   * trois salles jusqu'a l'entree. Un donjon dont la sortie s'evapore
   * enfermerait un joueur qui a mal juge sa vie, et sa mort lui couterait un
   * equipement paye en argent reel. La difficulte d'un donjon est ce qu'on y
   * rencontre ; jamais le fait d'en repartir.
   * `Infinity` ne traverse pas JSON — `etatPour` le convertit en `null`, et la
   * page sait lire « pas de compte a rebours ». */
  dureeRetour: Infinity,
  rayon: 72,       // a quelle distance on se tient « dessus »
  recul: 190,      // derriere la creature, dans le sens de sa chute
  plafond: 24,
};

/* Qui ouvre quoi. La valeur EST le donjon : voir le commentaire ci-dessus. */
const PORTAIL_DE = Object.keys(DONJONS).reduce((o, k) => {
  /* DERIVE de la table, pas recopie a cote d'elle. Deux listes a tenir
     d'accord finissent toujours par se contredire — et celle-la se
     contredirait en silence : une creature declaree ouvreuse mais absente
     d'ici n'ouvrirait rien, sans qu'aucune erreur ne le dise. */
  o[DONJONS[k].ouvreur] = k;
  return o;
}, {});

/*
 * ---- ET QUI OUVRE LE CHEMIN DU RETOUR ----
 *
 * Une deuxieme table, et pas une valeur speciale dans la premiere. Une porte
 * de retour et une porte de donjon ne se ressemblent que par le dessin : la
 * premiere ramene d'ou l'on vient, la seconde emmene quelque part. Les
 * ecrire dans la meme table aurait demande une valeur reservee —
 * `PORTAIL_DE = { fonderie: null }` — dont personne ne devine le sens six
 * mois plus tard, et dont le `if` de lecture se serait mis a dire « ouvre un
 * donjon » pour quelque chose qui n'en ouvre aucun.
 *
 * Le boss du fond en laisse une : sans elle, l'abattre serait suivi d'une
 * traversee a pied des trois salles qu'on vient de vider, dans le silence.
 * Ce n'est pas de la difficulte, c'est du chemin — et le chemin de retour
 * d'un donjon fini n'a rien a raconter.
 */
/* DERIVE de la table, comme PORTAIL_DE : tout boss de donjon ouvre la porte
   du retour en tombant. L'ecrire a la main aurait laisse le deuxieme donjon
   sans sortie au fond — un joueur enferme apres avoir gagne. */
const RETOUR_DE = Object.keys(DONJONS).reduce((o, k) => {
  o[DONJONS[k].boss] = 1;
  return o;
}, {});

/*
 * ---- LE PLAN DU DONJON ----
 *
 * Trois salles en enfilade, reliees par deux couloirs. On arrive dans la
 * premiere, on traverse la deuxieme, le boss attend dans la troisieme.
 *
 * ---- pourquoi une enfilade, et pas un labyrinthe ----
 *
 * Un donjon n'a pas besoin d'etre difficile a LIRE pour etre difficile a
 * faire. Un labyrinthe ajoute une seule chose : le temps perdu a chercher la
 * sortie, qui n'est pas du jeu. L'enfilade dit tout des la porte — trois
 * salles, le fond est au fond — et laisse la difficulte a ce qui les habite.
 * On sait toujours ou l'on va, jamais si l'on tiendra.
 *
 * ---- pourquoi le sol est un GRILLAGE de tuiles ----
 *
 * Les murs ne sont pas poses a la main : on dessine les tuiles de SOL, et
 * tout ce qui les borde devient un mur. Poser les murs a la main aurait
 * demande de les tenir d'accord avec le sol a chaque changement de forme —
 * et le premier oubli aurait fait un donjon avec un trou dedans, ou un
 * couloir bouche. Ici la forme n'a qu'une seule source : `sol`.
 */
const DONJON_TUILE = TUILE;
/* Les trois salles, en tuiles, dans l'ordre ou on les traverse. `cote` est
   l'INTERIEUR ; les murs se posent autour. Elles grandissent : la premiere
   est un sas, la derniere doit contenir un boss de cent quarante-huit unites
   de large qui recule en frappant. */
const DONJON_SALLES = [
  { cote: 9,  role: 'entree' },
  { cote: 11, role: 'fosse' },
  { cote: 11, role: 'fosse' },
  { cote: 13, role: 'fosse' },
  { cote: 15, role: 'fond' },
];
/* ---- ET DES IMPASSES ----
 * Des salles qui ne menent nulle part, accrochees a la chaine. Elles font
 * deux choses qu'une salle de plus dans la file ne ferait pas : elles
 * obligent a CHOISIR a chaque embranchement, et elles recompensent celui qui
 * fouille — c'est la ou tombe le butin qu'on ne trouve pas en courant tout
 * droit. Petites : une impasse grande comme une salle de passage ne se lirait
 * plus comme un ecart. */
const DONJON_IMPASSES = { combien: 3, cote: 7 };
/* Le couloir : trois tuiles de large, trois de long. Trois de large et pas
   une — une seule aurait fait un goulot ou le boss ne passe pas, et ou deux
   joueurs se bousculent. Un donjon ne doit pas etre difficile a cause de sa
   geometrie.
   TROIS de long et non quatre : a quatre, on passait plus de temps dans les
   couloirs que dans les salles, et un donjon qui se traverse au pas de course
   entre deux combats se lit comme vide meme quand il ne l'est pas. */
const DONJON_COULOIR = { long: 3, large: 3 };
/* ---- COMBIEN DE MONDE DANS UN DONJON ----
 * Par TUILE de sol, et non par salle : c'est la seule facon d'avoir la meme
 * densite dans un sas de neuf tuiles de cote et dans une caverne ronde de
 * dix-huit. Le chiffre est deux fois celui d'avant — un donjon qu'on
 * traverse en courant n'est pas un donjon, c'est un couloir avec un boss au
 * bout. */
const PEUPLE_DONJON = { densite: 0.062, plafond: 14 };
const DONJON_ORIGINE = { x: 6, y: 6 };

/* La base de `t` pour un bloc de mur de donjon. Au-dela de MUR_BASE on lit le
   mur de ruine ; au-dela de celui-ci, le mur de donjon. Une seule liste de
   blocs, une seule collision, trois planches — c'est la lecon de MUR_BASE,
   poussee d'un cran. */
const MUR_DONJON = 8;
/* De quoi loger le mur exterieur quand on ramene le plan dans le positif. */
const MARGE_CAVE = 4;

/**
 * Les tuiles de SOL du donjon, en coordonnees de tuile. La forme entiere tient
 * dans cette fonction ; tout le reste s'en deduit.
 *
 * On rend aussi le centre de chaque salle : c'est la qu'on fait naitre les
 * creatures, le boss et la porte de sortie. Les recalculer ailleurs, c'est se
 * donner deux plans a tenir d'accord.
 */
/* ---- UN VRAI MELANGE ----
 * `liste.sort(() => alea() - 0.5)` a l'air d'un melange et n'en est pas un :
 * un comparateur qui repond au hasard n'est pas un ordre, et le tri qui s'en
 * sert rend un resultat BIAISE — sur trois elements, deux ordres sortaient
 * quatre fois plus souvent que les quatre autres. Le donjon avait donc deux
 * formes au lieu de vingt, et le deuxieme passage n'apprenait plus rien.
 * Fisher-Yates, en une boucle : chaque ordre a exactement la meme chance. */
function melange(liste, r) {
  const out = liste.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function planDonjon(alea) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const cle = (c, l) => c + ',' + l;
  const DIRS = { droite: [1, 0], bas: [0, 1], haut: [0, -1] };
  /* Jamais vers la GAUCHE : le donjon reviendrait sur lui-meme et l'on
     n'aurait plus l'impression d'avancer. Trois directions suffisent a casser
     la ligne droite — c'etait tout le probleme. */
  const NOMS = Object.keys(DIRS);

  /* Les rectangles poses, en tuiles. On verifie les chevauchements SUR EUX,
     pas sur le sol deja creuse : relire un ensemble de cinq cents tuiles pour
     placer chaque salle reviendrait a refaire le plan a chaque pose, et une
     salle collee a une autre par un coin passerait quand meme. Deux marges
     entre les bords : sans elles, le mur qui les separe n'aurait nulle part
     ou tenir et les deux salles fusionneraient. */
  const boites = [];
  const chevauche = (x0, y0, x1, y1) => boites.some(
    (b) => x0 <= b.x1 + 1 && x1 >= b.x0 - 1 && y0 <= b.y1 + 1 && y1 >= b.y0 - 1);

  const sol = new Set();
  const salles = [];
  const creuse = (x0, y0, x1, y1) => {
    for (let c = x0; c <= x1; c++) for (let l = y0; l <= y1; l++) sol.add(cle(c, l));
  };

  /* ---- LA CHAINE ----
   * Une salle, un couloir, une salle. Le couloir part du bord de la salle
   * precedente et arrive sur le bord de la suivante, toujours au MILIEU du
   * cote : un couloir qui debouche dans un coin se rate en entrant. */
  let prec = null, dernier = null;
  for (let i = 0; i < DONJON_SALLES.length; i++) {
    const s = DONJON_SALLES[i];
    const demi = Math.floor(s.cote / 2);
    if (!prec) {
      const x0 = DONJON_ORIGINE.x, y0 = DONJON_ORIGINE.y;
      creuse(x0, y0, x0 + s.cote - 1, y0 + s.cote - 1);
      boites.push({ x0, y0, x1: x0 + s.cote - 1, y1: y0 + s.cote - 1 });
      prec = { c: x0 + demi, l: y0 + demi, cote: s.cote };
      salles.push({ role: s.role, cote: s.cote, c: prec.c, l: prec.l,
                    x: (prec.c + 0.5) * DONJON_TUILE, y: (prec.l + 0.5) * DONJON_TUILE });
      continue;
    }
    /* On essaie les trois directions dans un ordre TIRE : sans le tirage, le
       plan serait le meme a chaque partie, et le deuxieme passage dans la
       Fonderie n'aurait plus rien a apprendre. */
    const ordre = melange(NOMS, r);
    /* Deux fois de suite la meme direction fait un couloir droit de deux
       salles — exactement ce qu'on vient de casser. On la met en dernier
       plutot que de l'interdire : l'interdire pourrait ne laisser aucune
       place et faire echouer la pose. */
    if (dernier) {
      const i = ordre.indexOf(dernier);
      if (i >= 0) ordre.push(ordre.splice(i, 1)[0]);
    }
    let pose = null;
    for (const nom of ordre) {
      const d = DIRS[nom];
      const precDemi = Math.floor(prec.cote / 2);
      /* Le centre de la nouvelle salle : on sort du bord de la precedente, on
         traverse le couloir, puis on entre jusqu'au centre de la nouvelle. */
      const loin = precDemi + DONJON_COULOIR.long + demi + 1;
      const c = prec.c + d[0] * loin, l = prec.l + d[1] * loin;
      const x0 = c - demi, y0 = l - demi, x1 = c + demi, y1 = l + demi;
      if (chevauche(x0, y0, x1, y1)) continue;
      pose = { nom, d, c, l, x0, y0, x1, y1 };
      break;
    }
    /* Aucune place : on s'arrete la. Un donjon de quatre salles vaut mieux
       qu'une salle posee dans une autre — et le fond suit le ROLE, pas le
       rang, donc il reste au fond de ce qui existe. */
    if (!pose) break;
    creuse(pose.x0, pose.y0, pose.x1, pose.y1);
    boites.push({ x0: pose.x0, y0: pose.y0, x1: pose.x1, y1: pose.y1 });
    creuseCouloir(sol, prec, pose, cle);
    prec = { c: pose.c, l: pose.l, cote: s.cote };
    dernier = pose.nom;
    salles.push({ role: s.role, cote: s.cote, c: pose.c, l: pose.l,
                  x: (pose.c + 0.5) * DONJON_TUILE, y: (pose.l + 0.5) * DONJON_TUILE });
  }
  /* Le dernier pose porte le role du FOND, quoi qu'il arrive. Sans cette
     ligne, un plan qui s'est arrete tot n'aurait pas de fond du tout — donc
     pas de boss, et une expedition sans rien au bout. */
  if (salles.length && !salles.some((q) => q.role === 'fond')) {
    salles[salles.length - 1].role = 'fond';
  }

  /* ---- LES IMPASSES ----
   * Accrochees aux salles du MILIEU : sur le sas, elles seraient visitees
   * avant d'avoir rien vu ; sur le fond, on tomberait dessus apres le boss,
   * quand il n'y a plus de raison d'explorer. */
  const cote = DONJON_IMPASSES.cote, demiI = Math.floor(cote / 2);
  const candidates = salles.filter((q) => q.role !== 'entree' && q.role !== 'fond');
  for (let k = 0; k < DONJON_IMPASSES.combien && candidates.length; k++) {
    const p = candidates[Math.floor(r() * candidates.length)];
    const ordre = melange(NOMS.concat(['gauche']), r);
    for (const nom of ordre) {
      const d = nom === 'gauche' ? [-1, 0] : DIRS[nom];
      const loin = Math.floor(p.cote / 2) + DONJON_COULOIR.long + demiI + 1;
      const c = p.c + d[0] * loin, l = p.l + d[1] * loin;
      const x0 = c - demiI, y0 = l - demiI, x1 = c + demiI, y1 = l + demiI;
      if (chevauche(x0, y0, x1, y1)) continue;
      creuse(x0, y0, x1, y1);
      boites.push({ x0, y0, x1, y1 });
      creuseCouloir(sol, { c: p.c, l: p.l, cote: p.cote },
                    { c, l, d, x0, y0, x1, y1 }, cle);
      salles.push({ role: 'impasse', cote, c, l,
                    x: (c + 0.5) * DONJON_TUILE, y: (l + 0.5) * DONJON_TUILE });
      break;
    }
  }

  /* ---- ON RAMENE TOUT DANS LE POSITIF ----
   * La chaine monte autant qu'elle descend : la moitie du plan peut donc
   * sortir par le haut. On translate a la fin plutot que de deviner une
   * origine au depart — deviner, c'est se retrouver un jour avec un donjon
   * qui deborde sans que rien ne l'annonce. */
  let cMin = Infinity, lMin = Infinity;
  for (const k of sol) {
    const [c, l] = k.split(',').map(Number);
    if (c < cMin) cMin = c;
    if (l < lMin) lMin = l;
  }
  const dc = DONJON_ORIGINE.x - cMin, dl = DONJON_ORIGINE.y - lMin;
  if (dc || dl) {
    const bouge = new Set();
    for (const k of sol) {
      const [c, l] = k.split(',').map(Number);
      bouge.add(cle(c + dc, l + dl));
    }
    sol.clear();
    for (const k of bouge) sol.add(k);
    for (const q of salles) {
      q.c += dc; q.l += dl;
      q.x = (q.c + 0.5) * DONJON_TUILE;
      q.y = (q.l + 0.5) * DONJON_TUILE;
    }
  }
  return { sol, salles, tuile: DONJON_TUILE };
}

/* Le couloir entre deux salles. En DEUX segments quand il faut — d'abord le
   long de la direction, puis le report — parce qu'un couloir en diagonale
   n'existe pas sur une grille de tuiles : il ferait un escalier ou l'on se
   coince. Ici les salles sont alignees par construction, donc le second
   segment est vide la plupart du temps ; on le garde parce que le jour ou
   elles ne le seront plus, l'oubli ferait un donjon coupe en deux. */
function creuseCouloir(sol, de, vers, cle) {
  const demi = Math.floor(DONJON_COULOIR.large / 2);
  const dcs = Math.sign(vers.c - de.c), dls = Math.sign(vers.l - de.l);
  let c = de.c, l = de.l;
  while (c !== vers.c) {
    c += dcs;
    for (let e = -demi; e <= demi; e++) sol.add(cle(c, l + e));
  }
  while (l !== vers.l) {
    l += dls;
    for (let e = -demi; e <= demi; e++) sol.add(cle(c + e, l));
  }
}

/*
 * ---- LA GROTTE : UN RESEAU DE SALLES RONDES ----
 *
 * La Fonderie est un couloir : trois salles carrees en ligne, et l'on sait
 * toujours ou l'on va. La cave est l'inverse — des disques de tailles
 * differentes, relies par des passages etroits, avec des embranchements et des
 * culs-de-sac. On ne voit pas la salle suivante depuis celle ou l'on est.
 *
 * ---- pourquoi on POSE les salles avant de dessiner le sol ----
 *
 * Creuser au fur et a mesure obligerait a savoir, pendant qu'on creuse, ce qui
 * a deja ete creuse — donc a relire le sol pour placer la salle suivante. On
 * construit d'abord une LISTE de disques et de passages, on verifie les
 * chevauchements sur des centres et des rayons (deux soustractions), et on
 * rasterise a la fin, une seule fois.
 *
 * ---- pourquoi le boss est le PLUS LOIN et pas le dernier pose ----
 *
 * Le dernier pose peut tres bien etre une impasse collee a l'entree : le
 * tirage ne garantit rien. « Le plus loin de l'entree » est une propriete du
 * plan et non de l'ordre dans lequel on l'a ecrit — et c'est ce qu'on veut
 * dire quand on dit « au fond ».
 */
const CAVE = {
  salles: 13,
  rayon: { min: 3, max: 6 },
  /* Le fond est nettement plus grand : on doit sentir en entrant qu'on est
     arrive quelque part, et un boss entoure de sbires a besoin de place. */
  rayonBoss: 9,
  /* Des passages plus COURTS qu'a l'origine (trois a huit). A huit tuiles, on
     passait plus de temps dans le noir entre deux cavernes que dans les
     cavernes elles-memes, et la grotte se lisait comme vide alors qu'elle ne
     l'etait pas. */
  couloir: { min: 2, max: 5, large: 2 },
  /* Combien de fois on tente de poser une salle avant d'abandonner celle-la.
     Sans borne, un plan trop serre boucle pour toujours — et un serveur qui
     ne repond plus est pire qu'un donjon avec onze salles au lieu de treize. */
  essais: 60,
};

function planCave(alea) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const ent = (a, b) => a + Math.floor(r() * (b - a + 1));

  const salles = [{ c: 0, l: 0, rayon: ent(CAVE.rayon.min, CAVE.rayon.max), role: 'entree' }];
  const passages = [];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let i = 1; i < CAVE.salles; i++) {
    let pose = null;
    for (let k = 0; k < CAVE.essais && !pose; k++) {
      /* On tire le parent parmi TOUTES les salles : ne prendre que la
         derniere donnerait un serpent, ne prendre que la premiere donnerait
         une etoile. Au hasard, on obtient des branches — ce que montre la
         carte d'origine. */
      const p = salles[Math.floor(r() * salles.length)];
      const d = DIRS[Math.floor(r() * DIRS.length)];
      const rayon = ent(CAVE.rayon.min, CAVE.rayon.max);
      const loin = p.rayon + rayon + ent(CAVE.couloir.min, CAVE.couloir.max);
      const c = p.c + d[0] * loin, l = p.l + d[1] * loin;
      /* Deux salles qui se touchent ne font plus deux salles. La marge de
         deux tuiles laisse la place au mur qui les separe — sans elle, le
         mur n'aurait nulle part ou tenir et les disques fusionneraient. */
      const libre = salles.every((q) => Math.hypot(q.c - c, q.l - l) > q.rayon + rayon + 2);
      if (libre) pose = { c, l, rayon, role: 'salle', de: p };
    }
    if (!pose) continue;
    salles.push(pose);
    passages.push({ a: { c: pose.de.c, l: pose.de.l }, b: { c: pose.c, l: pose.l } });
  }

  /* ---- LE FOND ----
   * Le plus loin de l'entree, mesure sur le plan et non sur l'ordre de pose. */
  let fond = salles[0], loinMax = -1;
  for (const q of salles) {
    const d = Math.hypot(q.c - salles[0].c, q.l - salles[0].l);
    if (d > loinMax) { loinMax = d; fond = q; }
  }
  if (fond !== salles[0]) {
    fond.role = 'fond';
    /* ---- ON L'AGRANDIT AUTANT QUE LA PLACE LE PERMET ----
     * Poser `rayonBoss` sans regarder autour rouvrait le chevauchement qu'on
     * venait d'ecarter : la verification a eu lieu avec l'ANCIEN rayon, et la
     * salle du fond avalait sa voisine. On reprend donc la meme mesure —
     * garder deux tuiles entre les bords — et on s'arrete au premier
     * obstacle. Le fond reste la plus grande salle du plan, simplement pas
     * toujours de la meme taille, ce qui est deja vrai de toutes les autres. */
    let place = CAVE.rayonBoss;
    for (const q of salles) {
      if (q === fond) continue;
      const libre = Math.hypot(q.c - fond.c, q.l - fond.l) - q.rayon - 2;
      if (libre < place) place = libre;
    }
    fond.rayon = Math.max(fond.rayon, Math.min(CAVE.rayonBoss, Math.floor(place)));
  }

  /* ---- ON RAMENE TOUT DANS LE POSITIF ----
   * Les salles poussent dans les quatre sens depuis zero : la moitie du plan
   * est donc en coordonnees negatives. On translate a la fin plutot que de
   * deviner une origine au depart — deviner, c'est se retrouver un jour avec
   * un donjon qui deborde par la gauche sans que rien ne l'annonce. */
  let cMin = Infinity, lMin = Infinity;
  for (const q of salles) {
    cMin = Math.min(cMin, q.c - q.rayon);
    lMin = Math.min(lMin, q.l - q.rayon);
  }
  const dc = MARGE_CAVE - cMin, dl = MARGE_CAVE - lMin;
  for (const q of salles) { q.c += dc; q.l += dl; }
  for (const t of passages) { t.a.c += dc; t.a.l += dl; t.b.c += dc; t.b.l += dl; }

  /* ---- ET MAINTENANT ON CREUSE ---- */
  const sol = new Set();
  const cle = (c, l) => c + ',' + l;
  for (const q of salles) {
    for (let c = q.c - q.rayon; c <= q.c + q.rayon; c++) {
      for (let l = q.l - q.rayon; l <= q.l + q.rayon; l++) {
        /* Un DISQUE, pas un carre : c'est ce qui fait une grotte plutot qu'un
           entrepot. Le demi-pas rend le bord moins dentele. */
        if (Math.hypot(c - q.c, l - q.l) <= q.rayon + 0.5) sol.add(cle(c, l));
      }
    }
  }
  const demi = Math.floor(CAVE.couloir.large / 2);
  for (const t of passages) {
    const dcs = Math.sign(t.b.c - t.a.c), dls = Math.sign(t.b.l - t.a.l);
    const n = Math.max(Math.abs(t.b.c - t.a.c), Math.abs(t.b.l - t.a.l));
    for (let k = 0; k <= n; k++) {
      const c = t.a.c + dcs * k, l = t.a.l + dls * k;
      for (let e = -demi; e <= demi + (CAVE.couloir.large % 2 === 0 ? 0 : 0); e++) {
        /* Le passage est perpendiculaire a sa direction : elargir dans le sens
           de la marche l'allongerait au lieu de l'epaissir. */
        if (dcs) sol.add(cle(c, l + e)); else sol.add(cle(c + e, l));
      }
    }
  }

  return {
    sol,
    salles: salles.map((q) => ({
      role: q.role, cote: q.rayon * 2, rayon: q.rayon, c: q.c, l: q.l,
      x: (q.c + 0.5) * DONJON_TUILE, y: (q.l + 0.5) * DONJON_TUILE,
    })),
    tuile: DONJON_TUILE,
  };
}

/**
 * Les blocs de mur qui ceignent le sol.
 *
 * Toute tuile VIDE qui touche une tuile de sol — de cote ou en diagonale —
 * devient un mur. La diagonale compte : sans elle, les angles rentrants
 * laisseraient un trou d'une tuile par lequel on verrait le neant, et par
 * lequel un projectile passerait en biais.
 *
 * La piece se choisit sur les voisins DE MUR, pas sur les voisins de sol : un
 * mur droit a deux voisins de mur alignes, un angle en a deux
 * perpendiculaires, un bout n'en a qu'un. C'est exactement ce que le dessin
 * doit montrer, et c'est du calcul plutot qu'une table — une table de cent
 * cinquante blocs se serait desaccordee du plan a la premiere retouche.
 */
function mursDonjon(plan, depart) {
  const { sol } = plan;
  const cle = (c, l) => c + ',' + l;
  const mursSet = new Set();
  for (const k of sol) {
    const [c, l] = k.split(',').map(Number);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dl = -1; dl <= 1; dl++) {
        if (!dc && !dl) continue;
        const v = cle(c + dc, l + dl);
        if (!sol.has(v)) mursSet.add(v);
      }
    }
  }
  const out = [];
  let id = depart || 1;
  for (const k of mursSet) {
    const [c, l] = k.split(',').map(Number);
    const N = mursSet.has(cle(c, l - 1)), S = mursSet.has(cle(c, l + 1));
    const O = mursSet.has(cle(c - 1, l)), E = mursSet.has(cle(c + 1, l));
    let piece = 0, tour = 0;
    if (N && S && !O && !E) { piece = 1; }
    else if (O && E && !N && !S) { piece = 0; }
    /* Un angle : deux voisins perpendiculaires. La planche relie le HAUT et la
       DROITE ; chaque quart de tour dans le sens horaire fait avancer le
       coin. */
    else if (N && E && !S && !O) { piece = 2; tour = 0; }
    else if (E && S && !N && !O) { piece = 2; tour = 1; }
    else if (S && O && !N && !E) { piece = 2; tour = 2; }
    else if (O && N && !E && !S) { piece = 2; tour = 3; }
    /* Un bout : un seul voisin. La planche pose sa cassure vers le BAS. */
    else if (N && !S && !O && !E) { piece = 3; tour = 2; }
    else if (S && !N && !O && !E) { piece = 3; tour = 0; }
    else if (O && !E && !N && !S) { piece = 3; tour = 3; }
    else if (E && !O && !N && !S) { piece = 3; tour = 1; }
    /* Trois voisins ou plus (un T, un croisement) : le segment dans le sens le
       plus fourni. Un T n'a pas de planche a lui, et en inventer une
       demanderait une cinquieme piece qui n'existe pas sur la feuille. */
    else piece = (O || E) ? 0 : 1;
    out.push({ i: id++, x: (c + 0.5) * DONJON_TUILE, y: (l + 0.5) * DONJON_TUILE,
               r: SALLE.mur, t: MUR_DONJON + piece, a: tour, donjon: 1 });
  }
  return out;
}

/**
 * Le peuplement du donjon : quelles creatures, ou.
 *
 * Le boss est SEUL dans sa salle. Le melanger aux autres ferait de la derniere
 * porte un mur de creatures, et l'on mourrait sans jamais l'avoir vu. Les
 * trois especes se repartissent entre la fosse et le fond — pas dans le sas :
 * arriver dans un donjon et se faire toucher avant d'avoir pose le pied par
 * terre n'est pas une difficulte, c'est un piege.
 */
function peuplementDonjon(alea, nom, plan) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const D = DONJONS[nom] || DONJON;
  /* Le plan se fabrique avec LE MEME hasard que la population. Sans cet
     argument il repartait sur `Math.random` : deux appels avec le meme germe
     auraient donne deux donjons differents, et le peuplement n'aurait plus
     ete reproductible — c'est exactement ce qu'un serveur ne doit pas faire
     d'un monde qu'il diffuse. */
  const p = plan || planDonjon(alea);
  const out = [];
  for (const s of p.salles) {
    /* La salle d'arrivee reste VIDE. On y apparait : y poser des creatures
       reviendrait a faire commencer le combat avant que le joueur ait vu ou
       il est. */
    if (s.role === 'entree') continue;
    /* ---- LE NOMBRE SUIT L'AIRE, PAS LE COTE ----
     * On comptait `cote * 0.45`. Un cote fait grandir la salle au CARRE : une
     * salle de quinze tuiles a presque trois fois l'aire d'une de neuf et
     * recevait a peine deux fois plus de monde. Les grandes salles etaient
     * donc vides, et c'est exactement ce qui a ete rapporte — « pas assez de
     * monstres, et trop espace ».
     * Une grotte compte en DISQUES : leur aire n'est pas le carre du cote,
     * elle en fait les trois quarts. Prendre le carre pour tout le monde
     * aurait tasse les cavernes rondes de vingt-sept pour cent de trop. */
    const aire = s.rayon ? Math.PI * s.rayon * s.rayon : s.cote * s.cote;
    /* Le plafond n'est pas une precaution de performance : une salle ou l'on
       ne peut plus se deplacer entre les corps n'est plus une salle, c'est un
       mur qui tire. */
    const n = Math.max(2, Math.min(PEUPLE_DONJON.plafond,
                                   Math.round(aire * PEUPLE_DONJON.densite)));
    const demi = (s.cote / 2 - 1.2) * DONJON_TUILE;
    for (let i = 0; i < n; i++) {
      const e = D.especes[Math.floor(r() * D.especes.length)] || D.especes[0];
      out.push({ espece: e, biome: 'donjon',
                 x: s.x + (r() * 2 - 1) * demi,
                 y: s.y + (r() * 2 - 1) * demi });
    }
  }
  /* LE FOND SE CHERCHE PAR SON ROLE, pas par sa position dans la liste. Dans
     un couloir c'est la derniere salle ; dans une grotte c'est la plus
     eloignee de l'entree, qui peut avoir ete posee n'importe quand. Prendre
     `salles[length-1]` aurait mis le boss dans une impasse au hasard. */
  const fond = p.salles.find((s) => s.role === 'fond') || p.salles[p.salles.length - 1];
  /* Le boss au FOND du fond, pas au centre : on doit le voir en entrant sans
     etre deja a portee de son cercle. */
  out.push({ espece: D.boss, biome: 'donjon', boss: 1,
             x: fond.x + (fond.cote / 2 - 2) * DONJON_TUILE, y: fond.y });
  return out;
}

/**
 * LE PLAN COMPLET D'UN DONJON — tout ce qu'il faut pour en batir un.
 *
 * C'est le seul objet que `realm.js` recoit : il ne connait ni les tuiles, ni
 * les couloirs, ni les especes qui vivent la. Il recoit une liste de blocs,
 * une liste de creatures, un point d'arrivee, et il fait tourner la meme
 * simulation que pour le monde ouvert.
 *
 * `anneaux` merite un mot. Le client dessine son sol en demandant a quel
 * anneau appartient un point — c'est ce qui fait qu'on lit le danger sous ses
 * pieds. Un donjon n'a pas d'anneaux : il n'a qu'un sol, partout. Plutot que
 * d'apprendre au client un deuxieme mode de dessin (« si tu es dans un donjon,
 * ne demande pas »), on lui envoie une liste d'UN anneau qui couvre tout.
 * `biomeEn` rend alors 'donjon' partout, sans une ligne de plus nulle part, et
 * le jour ou un donjon aura deux sols il suffira d'en mettre deux dans la
 * liste.
 */
function planDeDonjon(nom, alea) {
  const cle = DONJONS[nom] ? nom : 'forge';
  const D = DONJONS[cle];
  /* ---- LA FORME EST UNE DONNEE, PAS UN `if` ----
   * `forme` nomme le generateur. Le jour ou un troisieme donjon arrive avec
   * une troisieme forme, il s'ajoute a la table et a cette ligne — le reste
   * de la fonction ne bouge pas, parce que les deux generateurs rendent
   * exactement la meme chose : un sol, des salles, une taille de tuile. */
  const plan = D.forme === 'grotte' ? planCave(alea) : planDonjon(alea);
  const entree = plan.salles.find((x) => x.role === 'entree') || plan.salles[0];
  return {
    nom: cle,
    /* On arrive dans le sas, DECALE de la porte de sortie : au centre exact on
       serait pose dessus, et le panneau proposerait de repartir a la seconde ou
       l'on arrive. */
    entree: { x: entree.x - TUILE * 2, y: entree.y },
    /* La porte de retour, au centre du sas. Elle ne s'ouvre pas : elle est la
       des le premier pas. Un donjon dont la sortie se meriterait enfermerait un
       joueur qui a mal juge sa vie — et sa mort lui couterait un equipement
       paye en argent reel. La difficulte d'un donjon est ce qu'on y rencontre,
       jamais le fait d'y etre coince. */
    sortie: { x: entree.x, y: entree.y },
    obstacles: mursDonjon(plan, 1),
    peuplement: peuplementDonjon(alea, cle, plan),
    /* ---- UN SEUL ANNEAU, ET SA BORNE EST FINIE ----
     * `Infinity` ne traverse pas JSON : il en ressort `null`, et `r <= null`
     * est faux pour tout rayon positif. La page serait donc tombee dans le
     * repli de `biomeEn` et aurait pose le sol du monde ouvert SUR le donjon —
     * les tuiles au bon endroit, la mauvaise texture, et rien nulle part pour
     * dire pourquoi. Quatre-vingt-dix-neuf demi-largeurs de carte : c'est
     * « partout » sans etre l'infini. */
    /* Le sol de CE donjon : la Fonderie a sa pierre, la cave son bois. La
       page lit le biome de l'anneau pour choisir sa planche — un donjon de
       plus, c'est une texture de plus, pas un mode de dessin de plus. */
    anneaux: [{ biome: D.sol || 'donjon', jusqua: 99 }],
    mur: D.mur || 'donjon',
    salles: [],
    /* ---- LE SOL, TUILE PAR TUILE ----
     * Et pas « trois rectangles et deux couloirs » : la page redessinerait
     * alors la forme a partir des memes cinq nombres, et le jour ou le plan
     * gagne une salle, l'un des deux dessins l'oublierait. Mille couples
     * d'entiers partent UNE fois, a l'entree — vingt-cinq kilo-octets, le
     * poids d'une petite image — et la page n'a plus rien a deviner. C'est
     * justement ce qui permet a la forme de CHANGER a chaque partie sans
     * qu'une seule ligne du navigateur ait a le savoir.
     *
     * C'est aussi ce qui permet de remplir de ROCHE tout ce qui n'est pas le
     * donjon. Un sol de donjon etale sur toute la carte aurait donne
     * l'impression d'un monde infini dont on aurait bati quelques pieces au
     * milieu ; la masse de pierre autour des murs est ce qui fait qu'un
     * donjon se lit comme un interieur — et non comme le bord du jeu. */
    tuiles: [...plan.sol].map((k) => {
      const [c, l] = k.split(',').map(Number);
      return [c, l];
    }),
  };
}

const SALLE = {
  /* Neuf tuiles de cote, murs compris : l'interieur fait sept tuiles, soit
     896 unites. Deux gardiens de trois cent quinze pixels y tiennent en se
     deplacant ; a sept tuiles ils se seraient bouscules contre les murs, et
     un combat de boss dans un placard n'est pas un combat. */
  cote: 9,          // en tuiles, murs compris
  mur: 64,          // le rayon de collision d'un bloc de mur (128 de large)
  gardiens: 2,
  /* Qui garde. Ecrit ICI et pas en dur dans la simulation : c'est une regle
     du monde, et un test doit pouvoir demander « quelle espece ne vit QUE
     dans les salles ? » sans lire realm.js. */
  espece: 'gardien',
  /* Le temps avant que les gardiens reviennent. Six minutes : assez pour que
     la salle vaille le detour une fois, trop pour qu'on en fasse une boucle
     de recolte. */
  rearme: 360,
};
/* Les dessins de mur, dans l'ordre des colonnes de tiles/mur_ruine.webp :
   segment horizontal, segment vertical, angle, bout casse. On les decale de
   MUR_BASE pour qu'ils ne se confondent pas avec les quatre rochers — un
   seul champ `t` porte les deux planches, et le decalage dit laquelle. */
const MUR_BASE = 4;

/* Les salles vivent au fond : neige et cendres. Le butin qu'elles gardent n'a
   aucun sens au bord — et une destination qu'on atteint en trois pas n'est pas
   une destination.
   PAS dans la lave, et ce n'est pas un choix : l'anneau du coeur s'arrete a
   768 du centre, la clairiere du gardien errant en prend 420, et une salle de
   neuf tuiles en demande 576 de plus. Il n'y a pas la place. Les cendres sont
   donc l'anneau le plus profond ou une salle tienne, et c'est la que va la
   relique. */
const SALLE_ANNEAUX = { neige: 2, cendres: 2 };
/* Ce qu'on trouve en la vidant. Les cendres gardent la relique : c'est le seul
   endroit du jeu ou l'on puisse la MERITER plutot que la tirer au sort. */
const SALLE_BUTIN = { neige: 'legendaire', cendres: 'relique' };

/**
 * Les salles du monde, et les blocs de mur qui les ceignent.
 *
 * Deterministe comme les rochers, et tiree AVANT eux : les rochers doivent
 * pouvoir eviter les salles, l'inverse n'aurait pas de sens — une salle
 * a moitie mangee par un rocher n'a plus de porte unique.
 */
function salles(alea) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const out = [];
  const cote = SALLE.cote * TUILE;
  const demi = cote / 2;
  for (const biome of Object.keys(SALLE_ANNEAUX)) {
    let poses = 0, essais = 0;
    /* Deux mille essais et pas quatre cents : l'anneau des cendres est etroit
       (768 a 1459), les salles ne doivent ni se toucher ni mordre la
       clairiere, et a quatre cents tirages la deuxieme ne trouvait pas sa
       place une fois sur deux — la table annoncait deux salles et le monde en
       portait une, sans que rien ne le dise. */
    while (poses < SALLE_ANNEAUX[biome] && essais < 2000) {
      essais++;
      const p = pointDansBiome(biome, alea);
      if (!p) continue;
      /* Le centre exact reste degage : c'est l'arene du gardien errant, et
         une salle posee dessus l'enfermerait dedans. */
      const dcx = p.x - CENTRE.x, dcy = p.y - CENTRE.y;
      if (dcx * dcx + dcy * dcy < (OBSTACLE.clairiere + demi) ** 2) continue;
      /* Alignee sur la grille : un mur a cheval sur deux tuiles se dessine de
         travers, et la dalle de temple ne raccorderait plus. */
      const cx = Math.round(p.x / TUILE) * TUILE;
      const cy = Math.round(p.y / TUILE) * TUILE;
      if (cx - demi < TUILE || cy - demi < TUILE ||
          cx + demi > MONDE.w - TUILE || cy + demi > MONDE.h - TUILE) continue;
      /* ---- LE CENTRE DECIDE, PAS LES COINS ----
       * Exiger les quatre coins dans le meme anneau ne place AUCUNE salle :
       * une salle de neuf tuiles a une diagonale de 1628, et l'anneau des
       * cendres ne fait que 691 d'epaisseur. La contrainte etait impossible,
       * et le symptome muet — zero salle, aucune erreur.
       * Elle n'a de toute facon pas de sens : la salle REMPLACE le sol
       * qu'elle occupe par ses dalles de temple. Ce qu'il y avait dessous ne
       * se voit plus. */
      if (biomeEn(cx, cy) !== biome) continue;
      /* Elles ne se touchent pas : deux salles collees n'auraient plus deux
         portes mais un couloir. Deux tuiles de vide entre les murs suffisent —
         a 1,6 fois leur cote, l'ecart demande etait bien plus large que « ne
         pas se toucher », et l'anneau des cendres n'acceptait plus qu'une
         salle sur deux. La table annoncait deux salles, le monde en portait
         une, et rien ne le disait. */
      const ecartSalles = cote + TUILE * 2;
      if (out.some((s) => Math.abs(s.x - cx) < ecartSalles && Math.abs(s.y - cy) < ecartSalles)) continue;
      out.push({ i: out.length + 1, x: cx, y: cy, cote,
                 biome, butin: SALLE_BUTIN[biome],
                 /* La porte, sur un cote tire au sort. Elle occupe la tuile du
                    milieu — donc jamais un angle, qui ne serait pas une porte
                    mais un coin manquant. */
                 porte: ['nord', 'sud', 'ouest', 'est'][Math.min(3, Math.floor(r() * 4))] });
      poses++;
    }
  }
  return out;
}

/** Les blocs de mur d'une salle. Ils entrent dans la liste des obstacles. */
function mursDe(s, depart) {
  const n = SALLE.cote;
  const demi = (n * TUILE) / 2;
  const x0 = s.x - demi + TUILE / 2;
  const y0 = s.y - demi + TUILE / 2;
  const mid = (n - 1) / 2;
  const out = [];
  let id = depart;
  for (let c = 0; c < n; c++) {
    for (let l = 0; l < n; l++) {
      const bord = (c === 0 || l === 0 || c === n - 1 || l === n - 1);
      if (!bord) continue;
      /* La porte : la tuile du MILIEU du cote tire. */
      if (s.porte === 'nord' && l === 0 && c === mid) continue;
      if (s.porte === 'sud' && l === n - 1 && c === mid) continue;
      if (s.porte === 'ouest' && c === 0 && l === mid) continue;
      if (s.porte === 'est' && c === n - 1 && l === mid) continue;
      const coin = (c === 0 || c === n - 1) && (l === 0 || l === n - 1);
      /* ---- LA PIECE, ET SON QUART DE TOUR ----
       *
       * La planche ne porte qu'UNE orientation de chaque : un segment
       * horizontal, un vertical, un angle, un bout casse. Poser le meme angle
       * aux quatre coins en laisse trois a l'envers — le mur se lit alors
       * comme un decor colle plutot que comme une piece batie.
       *
       * `a` est le nombre de quarts de tour dans le sens horaire. L'angle de
       * la planche relie le HAUT et la DROITE (un coin bas-gauche) : chaque
       * quart de tour le fait avancer d'un coin.
       */
      let piece, tour = 0;
      if (coin) {
        piece = 2;
        const gauche = (c === 0), haut = (l === 0);
        tour = haut ? (gauche ? 1 : 2) : (gauche ? 0 : 3);
      } else if (l === 0 || l === n - 1) {
        piece = 0;                       // segment horizontal, deja dans le bon sens
      } else {
        piece = 1;                       // segment vertical, idem
      }
      /* Le bout casse borde la porte : c'est ce qui fait lire l'ouverture
         comme une ouverture et non comme un trou. Il est tourne pour que sa
         cassure regarde la porte. */
      const versPorte =
        (s.porte === 'nord' && l === 0 && Math.abs(c - mid) === 1) ||
        (s.porte === 'sud' && l === n - 1 && Math.abs(c - mid) === 1) ||
        (s.porte === 'ouest' && c === 0 && Math.abs(l - mid) === 1) ||
        (s.porte === 'est' && c === n - 1 && Math.abs(l - mid) === 1);
      if (versPorte) {
        piece = 3;
        /* La planche pose sa cassure vers le BAS. Un quart de tour la met a
           gauche, deux en haut, trois a droite. */
        if (s.porte === 'nord' || s.porte === 'sud') tour = (c < mid) ? 3 : 1;
        else tour = (l < mid) ? 2 : 0;
      }
      out.push({ i: id++, x: x0 + c * TUILE, y: y0 + l * TUILE,
                 r: SALLE.mur, t: MUR_BASE + piece, a: tour, salle: s.i });
    }
  }
  return out;
}

/** Le point est-il DANS cette salle (murs compris) ? */
function dansLaSalle(s, x, y) {
  const demi = s.cote / 2;
  return x >= s.x - demi && x <= s.x + demi && y >= s.y - demi && y <= s.y + demi;
}

/**
 * Les blocs du monde. Deterministe : le meme `alea` rend la meme carte, et
 * c'est ce qui permet au serveur de la construire une fois et de l'envoyer
 * telle quelle. La page ne les invente pas — elle ne pourrait pas tomber
 * d'accord avec le serveur, et le desaccord se verrait tout de suite : on
 * marcherait dans un rocher, ou on serait arrete par du vide.
 */
function obstacles(alea, listeSalles) {
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const out = [];
  const sal = listeSalles || [];
  /* Les murs des salles ENTRENT dans la liste : une seule sorte de bloc, donc
     une seule collision, un seul arret de projectile, un seul tri de dessin.
     Deux sortes auraient donne trois occasions d'oublier la moitie d'une
     regle. */
  for (const s of sal) for (const m of mursDe(s, out.length + 1)) out.push(m);
  /* Les murs ne comptent PAS dans le quota de rochers : sinon poser une salle
     de plus retirerait vingt-quatre rochers a la carte, et le monde se
     deviderait a mesure qu'on lui ajoute des destinations. */
  const murs = out.length;
  const marge = OBSTACLE.rayon + 24;
  const ecart = OBSTACLE.rayon * 2.4;      // ils ne se touchent pas
  let essais = 0;
  while (out.length - murs < OBSTACLE.nombre && essais < OBSTACLE.nombre * 40) {
    essais++;
    const x = marge + r() * (MONDE.w - 2 * marge);
    const y = marge + r() * (MONDE.h - 2 * marge);
    const dcx = x - CENTRE.x, dcy = y - CENTRE.y;
    if (dcx * dcx + dcy * dcy < OBSTACLE.clairiere * OBSTACLE.clairiere) continue;
    /* Jamais dans une salle, ni collee a son mur : un rocher pose devant la
       porte en ferait une salle sans entree, et personne ne pourrait dire
       pourquoi elle est infranchissable. */
    if (sal.some((s) => dansLaSalle(s, x, y) ||
        (Math.abs(s.x - x) < s.cote / 2 + OBSTACLE.rayon * 2 &&
         Math.abs(s.y - y) < s.cote / 2 + OBSTACLE.rayon * 2))) continue;
    let colle = false;
    for (const o of out) {
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy < ecart * ecart) { colle = true; break; }
    }
    if (colle) continue;
    const b = biomeEn(x, y);
    out.push({ i: out.length + 1, x: Math.round(x), y: Math.round(y),
               r: OBSTACLE.rayon,
               t: OBSTACLE_BIOME[b] === undefined ? 0 : OBSTACLE_BIOME[b] });
  }
  return out;
}

/**
 * L'obstacle qui occupe ce point, ou `null`.
 *
 * `rayon` est celui de ce qui se deplace : un colosse de rayon 78 ne passe
 * pas ou passe une nuee de rayon 16, et c'est exactement ce qu'on veut — les
 * couloirs ne sont pas les memes pour tout le monde.
 */
function bloque(liste, x, y, rayon) {
  const rr = Math.max(0, Number(rayon) || 0);
  for (const o of liste) {
    const dx = o.x - x, dy = o.y - y;
    const d = o.r + rr;
    if (dx * dx + dy * dy < d * d) return o;
  }
  return null;
}

/*
 * ==================== L'ATTAQUE DE ZONE ====================
 *
 * Toutes les attaques du jeu sont des projectiles : elles partent d'un point,
 * vont tout droit, et on les esquive en n'etant pas sur leur ligne. C'est UNE
 * question posee de six facons.
 *
 * Une zone en pose une autre : elle marque le SOL a l'endroit ou l'on se
 * trouve, attend une seconde, puis frappe tout ce qui s'y trouve encore. On ne
 * l'esquive pas en se decalant — il faut PARTIR. Contre un monstre qui vous
 * suit, ca veut dire arreter de tirer et courir : la premiere attaque du jeu
 * qui coute quelque chose a esquiver.
 *
 * ---- pourquoi le cercle rouge n'est pas une decoration ----
 *
 * Sans lui, une attaque qui frappe une zone entiere est injuste : rien ne
 * l'annonce, on ne peut que la subir. Le cercle EST l'attaque — l'annonce et
 * le coup sont la meme chose vue a deux moments. C'est pour ca qu'on ne
 * pouvait pas la faire avant d'avoir son dessin.
 *
 * `annonce` est le temps entre la marque et le coup. Il n'est PAS choisi a
 * l'oreille : la zone tombe sur les pieds du joueur, donc il part toujours du
 * centre, donc il a exactement `rayon` unites a couvrir. Le temps qu'il lui
 * faut est `rayon / sa vitesse`, et il faut y ajouter le temps de VOIR le
 * cercle apparaitre.
 *
 *     annonce >= rayon / vitesse_du_plus_lent + ZONE_REACTION
 *
 * « Le plus lent » n'est pas une precaution de style : c'est un landwolf de
 * niveau 1, a 202 unites par seconde. Avec une annonce d'une seconde et un
 * rayon de 200, il lui restait UN CENTIEME de seconde de marge — autrement
 * dit aucune. Le cercle etait alors une decoration : il annoncait un coup
 * qu'on ne pouvait pas eviter, ce qui est pire que pas d'annonce du tout,
 * parce que ca donne l'impression d'avoir mal joue.
 *
 * Le personnage rapide, lui, sort largement. C'est voulu : la vitesse doit
 * servir a quelque chose. Ce que la zone coute a TOUT LE MONDE, c'est le
 * temps de tir — on ne tire pas en courant hors d'un cercle.
 */
/* Le quart de seconde qu'on laisse pour voir le cercle et decider. C'est un
   PLANCHER, pas une cible : les quatre zones du jeu ont toutes une dizaine de
   centiemes de plus. */
const ZONE_REACTION = 0.25;

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
  /*
   * ==================== LES PIRATES DE LA CAVE ====================
   *
   * Trois sbires et un roi, et ils ne vivent QUE dans la cave — aucun n'est
   * dans `PEUPLEMENT`, donc aucun ne nait dans le monde ouvert. C'est ce qui
   * fait qu'un donjon est un endroit : on n'y croise rien qu'on croise
   * ailleurs.
   *
   * Ils ont leurs propres dessins depuis les planches de pirates : plus
   * d'emprunt, donc plus de `sprite`. La page lit l'absence de ce champ et
   * cesse d'elle-meme de les teinter en violet — c'est exactement pour ca que
   * l'emprunt vivait en donnee et pas dans un `if` cote page.
   *
   * Ils sont VOLONTAIREMENT faibles. La Fonderie s'ouvre sur la creature la
   * plus dure de l'anneau le plus dur ; la cave s'ouvre bien plus tot et sert
   * a apprendre ce qu'est un donjon. Des sbires de six cents points de vie y
   * seraient une lecon qu'on ne peut pas suivre.
   */
  pirate: {
    pv: 220, att: 34, def: 6, vitesse: 74, rayon: 40, vue: 520,
    contact: true, cadence: 0.55,
    tir: { portee: 380, vitesse: 260, sprite: 'vide', att: 26, cadence: 0.7 },
    xp: 120,
  },
  /* Elle tire plus vite et de plus loin, et elle encaisse moins : deux
     creatures qui ne se jouent pas pareil valent mieux que deux barres de vie
     differentes. */
  piratesse: {
    pv: 180, att: 26, def: 4, vitesse: 82, rayon: 38, vue: 620,
    contact: false, cadence: 0.5,
    tir: { portee: 540, vitesse: 320, sprite: 'vide', att: 30, cadence: 0.42 },
    xp: 130,
  },
  /* Le lieutenant est le seul des trois qui punisse une erreur de placement :
     il frappe une ZONE, annoncee. C'est la premiere fois qu'un joueur voit ce
     dessin au sol, et c'est fait pour — il l'apprend ici, sur une creature qui
     ne le tue pas. */
  lieutenant: {
    /* 340 et non 460 : au-dessus, il tenait plus longtemps que le drone de la
       Fonderie — une machine de l'anneau de lave. Un elite de premier donjon
       qui encaisse mieux qu'une creature de fin de jeu, c'est l'echelle des
       difficultes qui se retourne. Il reste le plus dur des trois pirates, et
       c'est tout ce qu'on lui demande. */
    pv: 340, att: 42, def: 12, vitesse: 66, rayon: 46, vue: 640,
    contact: true, cadence: 0.5,
    tir: { portee: 460, vitesse: 280, sprite: 'vide', att: 34, cadence: 0.6 },
    zone: { annonce: 1.3, rayon: 150, att: 52, cadence: 0.25 },
    xp: 300,
  },
  /* ---- DREADSTUMP, LE ROI PIRATE ----
   * Il tient huit fois un sbire, mais il reste douze fois plus tendre que la
   * Fonderie : c'est un PREMIER boss. Il doit se sentir comme un mur sans en
   * etre un — on doit pouvoir le battre au niveau huit avec de la place et un
   * peu de patience. */
  dreadstump: {
    pv: 1800, att: 78, def: 20, vitesse: 62, rayon: 72, vue: 820,
    contact: true, cadence: 0.42,
    tir: { portee: 620, vitesse: 340, sprite: 'vide', att: 58, cadence: 0.45 },
    zone: { annonce: 1.5, rayon: 200, att: 84, cadence: 0.22 },
    xp: 2200,
  },
  meduse: {
    cle: 'meduse', nom: 'Medusa',
    /* Elle a son propre dessin depuis le serpent : plus d'emprunt, donc plus
       de `sprite`. La page lit l'absence de ce champ et cesse d'elle-meme de
       la teinter en violet — c'est exactement pour ca que l'emprunt vivait
       ici, en donnee, et pas dans un `if` cote page. */
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
    /* Son ONDE DE CHOC. Elle ne fait pas plus mal que son tir — elle demande
       autre chose : arreter de tirer et sortir. C'est ce qui donne enfin une
       raison de ne pas rester colle a lui en le mitraillant. */
    zone: { annonce: 1.3, rayon: 190, att: 100, cadence: 0.18 },
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
  /* ---- LE BRASIER : LE BOSS DE LA LAVE ----
   * Il remplace le gardien dore, qui gardait les salles ET errait dans la
   * lave. La meme creature dans deux roles, c'est un role qui n'existe pas :
   * on ne savait pas, en croisant un gardien, si l'on venait de trouver un
   * tresor ou un monstre de plus.
   *
   * Sa NOVA est la premiere attaque du jeu qu'on esquive en partant plutot
   * qu'en se decalant. */
  brasier: {
    cle: 'brasier', nom: 'Emberlord',
    pv: 1800, att: 170, def: 40,
    vitesse: 74, rayon: 90, vue: 780,
    contact: true, cadence: 0.5,
    tir: { portee: 600, vitesse: 340, sprite: 'braise', att: 90, cadence: 0.45,
           effet: 'brulure' },
    zone: { annonce: 1.35, rayon: 200, att: 150, cadence: 0.22, effet: 'brulure' },
    xp: 3200,
  },
  /* ---- LA MACHINE : LE MORTIER DES CENDRES ----
   * Elle tire loin et fort, et surtout elle POSE. Son obus n'a pas d'effet —
   * elle n'en a pas besoin : cent quarante degats d'un coup suffisent a faire
   * bouger n'importe qui. */
  machine: {
    cle: 'machine', nom: 'Siege Engine',
    pv: 1400, att: 150, def: 44,
    vitesse: 58, rayon: 84, vue: 820,
    contact: true, cadence: 0.45,
    tir: { portee: 660, vitesse: 400, sprite: 'tesson', att: 78, cadence: 0.4 },
    zone: { annonce: 1.45, rayon: 220, att: 140, cadence: 0.2 },
    xp: 2600,
  },
  /* ---- LA CARAPACE : CELLE QU'ON NE DISTANCE PAS ----
   * Son coup au sol RALENTIT. C'est la combinaison qui la rend dangereuse :
   * ralenti dans une zone qu'il faut quitter, on n'en sort pas — a moins
   * d'avoir commence a partir avant qu'elle ne frappe. */
  carapace: {
    cle: 'carapace', nom: 'Deep Carapace',
    pv: 1200, att: 130, def: 52,
    vitesse: 66, rayon: 96, vue: 700,
    contact: true, cadence: 0.6,
    tir: { portee: 420, vitesse: 280, sprite: 'acide', att: 60, cadence: 0.5 },
    zone: { annonce: 1.4, rayon: 210, att: 110, cadence: 0.24, effet: 'ralenti' },
    xp: 2400,
  },
  /* ---- LA BANDE ----
   * Trois creatures qui vont ensemble : elles se ressemblent, elles se
   * jouent differemment. C'est le contraire de la meduse, qui empruntait le
   * dessin du revenant de glace et devenait un piege — ici chacune a le sien,
   * et chacune apprend quelque chose.
   *
   * Le RAT court. Il n'a pas de tir et ne fait presque pas de degats : ce qu'il
   * enseigne, c'est qu'on ne distance pas tout. A cent quarante-cinq, il va
   * plus vite qu'un debutant lourd (202 avec le frein d'un ralentissement) et
   * moins vite qu'un coureur — le seul monstre du jeu contre lequel courir
   * n'est pas toujours la reponse. */
  hoodrat: {
    cle: 'hoodrat', nom: 'Hoodrat',
    pv: 130, att: 42, def: 6,
    vitesse: 145, rayon: 26, vue: 620,
    contact: true, cadence: 0.75,
    /* Il tire COURT. Toutes les creatures de ce jeu tirent — c'etait la regle
       posee le jour ou l'on a arrete de faire des monstres qui se contentent
       de foncer. Mais trois cents unites de portee sur un monstre qui court a
       cent quarante-cinq, ca ne fait pas un tireur : ca fait un poursuivant
       qui ne lache pas prise pendant qu'on recule. */
    tir: { portee: 300, vitesse: 260, sprite: 'croissant', att: 30, cadence: 0.4 },
    xp: 95,
  },
  /* Le VERT tire de loin et ne s'approche pas. Il est la reponse au rat :
     l'un force a bouger, l'autre punit de bouger sans regarder. */
  sylvain: {
    cle: 'sylvain', nom: 'Green Bandit',
    pv: 210, att: 48, def: 12,
    vitesse: 84, rayon: 30, vue: 720,
    contact: false, cadence: 0.5,
    tir: { portee: 580, vitesse: 310, sprite: 'epine', att: 46, cadence: 0.5 },
    xp: 160,
  },
  /* L'OR encaisse. Vingt-six de defense sur une creature qu'on croise dans les
     cendres : c'est le premier monstre ordinaire qu'une arme commune ne suffit
     plus a abattre, et c'est ce qu'il doit apprendre. */
  couronne: {
    cle: 'couronne', nom: 'Gold Crown',
    pv: 430, att: 82, def: 26,
    vitesse: 76, rayon: 38, vue: 680,
    contact: true, cadence: 0.6,
    tir: { portee: 480, vitesse: 285, sprite: 'tesson', att: 55, cadence: 0.35 },
    xp: 390,
  },
  /* ---- OPTIMUS ----
   * Le plus dur du monde ouvert, et le seul qui ne laisse pas un sac : il
   * laisse un PORTAIL. C'est ce qui en fait autre chose qu'un colosse avec
   * plus de points de vie — on ne le tue pas pour ce qu'il porte, on le tue
   * pour ce qu'il ouvre.
   *
   * Deux mille six cents points de vie et cent quatre-vingt-dix d'attaque : il
   * ne se tue pas seul au niveau vingt, et c'est voulu. Sa zone annonce plus
   * longtemps que les autres — 1,35 seconde — parce qu'elle est aussi plus
   * large : la promesse reste la meme, on doit pouvoir en sortir en courant. */
  optimus: {
    cle: 'optimus', nom: 'Optimus',
    pv: 2600, att: 190, def: 55,
    vitesse: 92, rayon: 92, vue: 900,
    contact: true, cadence: 0.45,
    tir: { portee: 700, vitesse: 420, sprite: 'vide', att: 100, cadence: 0.5 },
    /* 1,45 s pour 230 unites de rayon : la regle est qu'un personnage LENT —
       202 unites par seconde — doit pouvoir en sortir avec un quart de seconde
       de reaction. 230/202 + 0,25 fait 1,39 ; on prend 1,45. Le chiffre n'est
       pas choisi, il est calcule, et un essai le recalcule. */
    zone: { annonce: 1.45, rayon: 230, att: 160, cadence: 0.2 },
    xp: 5200,
  },
  /* ==================== LES CREATURES DU DONJON ====================
   *
   * Elles ne naissent dans AUCUN anneau : `biomes` reste vide, comme pour le
   * gardien des salles. On ne les rencontre que derriere un portail, et c'est
   * ce qui fait du portail autre chose qu'une porte de plus.
   *
   * Elles sont plus dures que tout ce qui erre dehors, a un cran pres : la
   * moins forte des quatre encaisse deux fois ce qu'encaisse un squelette, et
   * la plus forte tient tete a un colosse. Un donjon qui se nettoie avec
   * l'equipement du marais ne serait qu'un anneau de plus.
   */
  drone: {
    cle: 'drone', nom: 'Drone Sentinel',
    pv: 380, att: 95, def: 20,
    /* Il VOLE : cent vingt, plus vite que tout ce qui marche dehors sauf le
       rat. On ne le distance pas, on l'abat. */
    vitesse: 120, rayon: 40, vue: 800,
    contact: true, cadence: 0.6,
    tir: { portee: 620, vitesse: 400, sprite: 'plasma', att: 70, cadence: 0.55 },
    xp: 620,
  },
  ferraille: {
    cle: 'ferraille', nom: 'Scrapjaw',
    pv: 900, att: 135, def: 34,
    vitesse: 96, rayon: 52, vue: 720,
    contact: true, cadence: 0.5,
    tir: { portee: 360, vitesse: 300, sprite: 'scie', att: 80, cadence: 0.35 },
    xp: 980,
  },
  /* La BOBINE paralyse. C'est la seule du donjon qui le fasse, et deux
     secondes clouees au milieu de trois autres machines, ca se paie. */
  bobine: {
    cle: 'bobine', nom: 'Coil Warden',
    pv: 620, att: 110, def: 26,
    vitesse: 84, rayon: 46, vue: 820,
    contact: false, cadence: 0.5,
    /* LE MEME DESSIN QUE LA MEDUSE, et c'est voulu. Un essai refuse qu'un
       projectile veuille dire deux choses : si la bobine tirait le plasma du
       drone en y ajoutant la paralysie, le joueur apprendrait « le trait bleu
       cloue » — faux une fois sur deux, et impossible a jouer.
       On fait donc l'inverse : UN dessin pour la paralysie, dans tout le jeu.
       Ce qu'on voit venir, on sait ce que ca fait, quelle que soit la creature
       qui l'a lance. C'est la seule facon d'apprendre un jeu en le jouant. */
    tir: { portee: 700, vitesse: 340, sprite: 'oeil', att: 65, cadence: 0.4,
           effet: 'paralyse' },
    xp: 840,
  },
  /* La FONDERIE tient le fond du donjon. Sa zone annonce 1,5 s pour 240
     unites : 240/202 + 0,25 fait 1,44, on prend 1,5. Le chiffre se calcule,
     il ne se choisit pas. */
  /* ---- IL EST DERRIERE OPTIMUS, DONC IL EST PIRE QU'OPTIMUS ----
   * Il portait mille cinq cents points de vie, contre deux mille six cents
   * pour la creature qui ouvre sa porte. On aurait donc traverse un boss de
   * lave, un couloir et deux salles pleines pour trouver au fond quelque
   * chose de plus facile que ce par quoi on etait entre — et le donjon se
   * serait lu comme une salle de repos.
   * Trois mille six cents : une porte ne peut pas etre plus dure que ce
   * qu'elle garde. Le reste suit — il frappe plus fort qu'Optimus mais il est
   * lent (62 contre 92), et c'est cette lenteur qui rend sa salle jouable : on
   * ne le distance pas en marchant, on le distance en choisissant quand
   * s'arreter pour tirer. */
  fonderie: {
    cle: 'fonderie', nom: 'Foundry Brute',
    pv: 3600, att: 205, def: 62,
    vitesse: 62, rayon: 74, vue: 760,
    contact: true, cadence: 0.55,
    tir: { portee: 520, vitesse: 320, sprite: 'braise', att: 118, cadence: 0.4,
           effet: 'brulure' },
    zone: { annonce: 1.5, rayon: 240, att: 178, cadence: 0.18 },
    xp: 7400,
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
  marais:  { especes: ['lime', 'archer', 'rodeur', 'nuee', 'hoodrat'], nombre: 38,
             poids: { nuee: 2.2, hoodrat: 1.4 } },
  /* La meduse n'est PAS avant la neige : perdre le controle de son
     personnage avant d'avoir compris qu'on peut encore tirer ferait
     abandonner. */
  neige:   { especes: ['lime', 'skeleton', 'archer', 'meduse', 'nuee', 'carapace',
                       'hoodrat', 'sylvain'],
             nombre: 40, poids: { nuee: 1.5, carapace: 0.18, hoodrat: 1.2 } },
  cendres: { especes: ['skeleton', 'glace', 'archer', 'meduse', 'oracle', 'colosse',
                       'machine', 'sylvain', 'couronne'],
             nombre: 30, poids: { colosse: 0.4, machine: 0.22, couronne: 0.6 } },
  /* Le GARDIEN n'erre plus ici : il ne vit que dans les salles. La meme
     creature dans deux roles, c'est un role qui n'existe pas — on ne savait
     pas, en croisant un gardien, si l'on venait de trouver un tresor ou un
     monstre de plus. Le brasier prend sa place, et un seul pour dix-huit
     places : un boss qu'on croise a chaque passage n'est plus un boss. */
  /* OPTIMUS a le poids le plus faible du jeu : 0,12 sur un total de 5,17, soit
     deux pour cent. Sur dix-huit places, ca fait un Optimus toutes les trois
     visites de l'anneau de lave environ. C'est ce qu'on veut d'une creature
     qui ouvre un donjon — on le CHERCHE, on ne le croise pas. */
  lave:    { especes: ['lave', 'glace', 'meduse', 'oracle', 'colosse', 'brasier',
                       'couronne', 'optimus'],
             nombre: 18, poids: { colosse: 0.8, brasier: 0.25, couronne: 0.5, optimus: 0.12 } },
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
 * Le PLAFOND existe pour le TRAFIC : chaque tir est un message, et une dague
 * en tire deja quatre par seconde avant le moindre bonus.
 *
 * Il valait 2, et 2 se touchait AVANT le premier objet : andy a 75 de
 * dexterite au niveau vingt, et 0,5 + 75/50 fait exactement 2. Toute la
 * dexterite vendue en boutique — bagues d'emeraude, jambieres, fruits de
 * chance — ne faisait donc rien du tout pour lui. Une statistique qu'on paie
 * et qui ne change rien est pire qu'une statistique absente : elle ment.
 *
 * On monte donc a 2,75, ce qui couvre la dexterite maximale atteignable
 * (111 avec trois pieces mythiques de boutique, soit un facteur 2,72). Le
 * cout, mesure et non suppose : une dague passe de huit a onze messages par
 * seconde, soit trente de plus par seconde pour dix joueurs. Le serveur tourne
 * a 0,65 ms par tour de cent millisecondes.
 *
 * Personne ne perd rien : le plafond ne fait que monter.
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
const CADENCE_MAX = 2.75;
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

/*
 * ==================== CE QUE FAIT UN FAMILIER ====================
 *
 * ---- il agit SEUL, et c'est tout l'interet ----
 *
 * Un compagnon qu'il faut declencher est une deuxieme touche de pouvoir : on
 * l'oublie, ou on l'appuie en boucle. Celui-ci a une recharge et frappe des
 * qu'elle est finie, sur ce qui est a portee. Le joueur ne le pilote pas — il
 * choisit LEQUEL sortir, et c'est la que se joue la decision.
 *
 * ---- il ne meurt jamais, et il n'est pas une cible ----
 *
 * C'est la promesse faite au joueur : l'oeuf tombe une fois sur cinq mille,
 * et ce qu'il en sort ne se perd pas. Un familier qu'un monstre peut abattre
 * l'aurait rendue fausse le premier soir. Il n'a donc pas de points de vie,
 * et rien ne le vise.
 *
 * ---- ses effets partent du MAITRE ----
 *
 * Le familier n'a pas de position cote serveur : il trotte derriere son
 * maitre, a moins d'une longueur de laisse, et c'est la page qui le fait
 * trotter. Mesurer sa portee depuis le joueur plutot que depuis lui coute
 * soixante unites d'imprecision sur deux cent soixante — moins que le rayon
 * d'un monstre — et evite de simuler, diffuser et synchroniser une deuxieme
 * creature par joueur. Le jour ou l'on voudra qu'il se fasse toucher, il
 * faudra la position ; ce jour-la ce commentaire dira ou regarder.
 *
 * ---- pourquoi une aide, et jamais une arme ----
 *
 * Les chiffres sont volontairement petits devant ceux d'une arme. Un familier
 * qui tuerait a lui seul ferait du jeu une chose qu'on regarde, et un joueur
 * sans oeuf serait derriere pour une raison qu'il ne controle pas : il n'y a
 * aucune facon de FARMER un un-sur-cinq-mille. L'aide se voit, elle ne
 * remplace pas.
 */
const FAMILIERS = {
  portee: 260,           // autour du maitre, pour tout ce qui vise
  recharge: 5,           // secondes entre deux gestes — la cadence du legendaire
  niveauMax: 20,
  /* Le chien ordinaire MORD. Il n'a pas d'effet, il a des degats : c'est le
     seul des six a etre simplement utile, et c'est ce qui le rend jouable
     quand on n'a que lui. */
  mord:     { degats: 12, parNiveau: 3 },
  /* Le feu BRULE. La brulure ignore la defense — c'est deja la regle du jeu
     pour celle que l'on subit, et deux brulures aux regles differentes
     seraient deux choses portant le meme nom. */
  brule:    { duree: 3.5, parSeconde: 5, parNiveau: 0.5 },
  /* La glace FIGE. Court : une stase de cinq secondes existe deja, elle coute
     soixante-quinze de mana et douze secondes de recharge. Celle-ci est
     gratuite et automatique, elle ne peut donc pas valoir autant. */
  gele:     { duree: 1.4, parNiveau: 0.07 },
  /* Les tenebres REPOUSSENT tout ce qui est trop pres. Pas de degats : c'est
     une porte de sortie, et une porte de sortie qui tue en plus n'aurait plus
     aucune raison d'etre choisie contre le chien qui mord. */
  repousse: { rayon: 190, force: 120, parNiveau: 5 },
  /* La terre PROTEGE. Une reduction, pas une immunite : un bouclier qui
     annule ferait des secondes ou l'on ne risque rien, et l'esquive — la
     seule competence du jeu — cesserait de compter pendant ce temps-la. */
  bouclier: { duree: 3.0, reduction: 0.30, parNiveau: 0.010 },
  /* Le legendaire SOIGNE, en part des points de vie MAXIMUM. Un chiffre fixe
     aurait guéri un debutant en trois battements et un joueur de niveau vingt
     jamais. */
  soigne:   { part: 0.030, parNiveau: 0.0035 },
};

/* ---- QUELLE ESPECE FAIT QUOI ----
 * Ici, avec les chiffres, et pas a cote des noms anglais : c'est une REGLE du
 * monde. Deux tables — l'une qui nomme, l'autre qui agit — auraient fini par
 * annoncer un pouvoir et en appliquer un autre. */
const POUVOIR_PAR_ESPECE = {
  normal: 'mord', feu: 'brule', glace: 'gele',
  terre: 'bouclier', tenebre: 'repousse', legendaire: 'soigne',
};

/* ---- LES CHIFFRES D'UN FAMILIER, A SON NIVEAU ----
 * Une seule formule, ici. Le serveur l'applique et la page l'AFFICHE — deux
 * calculs finiraient par promettre autre chose que ce qui se passe. */
function familierEffet(pouvoir, niveau) {
  const b = FAMILIERS[pouvoir];
  if (!b) return null;
  const n = Math.max(1, Math.min(FAMILIERS.niveauMax, niveau | 0)) - 1;
  const out = { pouvoir, portee: FAMILIERS.portee, recharge: FAMILIERS.recharge };
  switch (pouvoir) {
    case 'mord':     out.degats = b.degats + b.parNiveau * n; break;
    case 'brule':    out.duree = b.duree; out.parSeconde = b.parSeconde + b.parNiveau * n; break;
    case 'gele':     out.duree = b.duree + b.parNiveau * n; break;
    case 'repousse': out.rayon = b.rayon; out.force = b.force + b.parNiveau * n; break;
    case 'bouclier': out.duree = b.duree;
                     /* Plafonnee : la formule seule atteindrait 49 % au
                        vingtieme, et l'on retomberait sur le bouclier qui
                        annule dont on ne veut pas. */
                     out.reduction = Math.min(0.5, b.reduction + b.parNiveau * n); break;
    case 'soigne':   out.part = b.part + b.parNiveau * n; break;
  }
  return out;
}

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
/* ---- LES SACS, DU PLUS COMMUN AU PLUS RARE ----
 * Et « oeuf » a part, en dernier : ce n'est pas un cran de rarete de plus, ce
 * n'est meme pas un objet — c'est la seule chose du jeu qui ne se porte pas,
 * ne se vend pas et ne se perd pas. Elle merite son propre sac, et surtout
 * son propre DESSIN : un joueur qui voit un sac blanc court deja ; il faut
 * qu'il sache, de loin, que celui-la n'est pas une relique. */
const SACS = ['brun', 'bleu', 'violet', 'or', 'rouge', 'blanc', 'oeuf'];

const STATS_POTION = Object.keys(POUVOIR_PAR_STAT);

const POTION_DE = {
  lime: 'hp', skeleton: 'att', archer: 'dex', rodeur: 'spd',
  glace: 'def', meduse: 'wis', oracle: 'mp', lave: 'vit',
  /* Le colosse est de la meme famille que le golem : meme potion. Lui en
     donner une neuvieme aurait demande une neuvieme stat. */
  colosse: 'vit',
  /* Les BOSS donnent n'importe laquelle. C'est ce qui en fait des
     destinations : on y va pour ce qui manque, pas pour ce qu'ils ont. */
  gardien: '*', brasier: '*', machine: '*', carapace: '*', optimus: '*',
  /* La bande donne ce que sa facon de jouer enseigne : le rat, de la vitesse ;
     le vert, de la dexterite ; l'or, de la defense. Une potion qui n'a rien a
     voir avec la creature qui la lache est une potion qu'on ne se rappelle pas
     ou trouver. */
  hoodrat: 'spd', sylvain: 'dex', couronne: 'def',
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
  /* Le donjon est DERRIERE la lave : on n'y entre qu'en abattant la creature
     la plus dure de l'anneau le plus dur. Ses machines rendent donc du
     mythique, comme la lave — pas mieux. Ce qui fait la difference est au fond
     de la troisieme salle, et c'est BUTIN_GARANTI qui le dit.
     Faire du donjon un anneau de plus aurait ete la facon paresseuse : il
     aurait suffi d'y rester pour depasser tout le reste du jeu, sans jamais
     avoir a le finir. */
  donjon: 'mythique',
  /* ---- ET LA CAVE, DEVANT ----
   * Elle s'ouvre sur un boss de neige et non sur celui de la lave : ses
   * pirates rendent donc du RARE, comme le marais. Lui donner du mythique
   * parce que « c'est un donjon » aurait fait du premier donjon le meilleur
   * endroit du jeu, et il n'y aurait plus eu de raison d'aller plus loin. Le
   * mot « donjon » ne vaut rien en soi ; c'est ce qu'on a du abattre pour y
   * entrer qui fixe le prix. */
  cave: 'rare',
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

/* ==================== LES OEUFS ====================
 *
 * Un oeuf tombe de N'IMPORTE QUELLE creature, une fois sur cinq mille. Ce
 * n'est pas le butin d'un anneau ni la recompense d'un boss : c'est la seule
 * chose du jeu qu'on ne peut ni viser, ni farmer, ni acheter. On la trouve.
 *
 * ---- LE CHIFFRE, ET CE QU'IL VEUT DIRE ----
 *
 * Une fois sur cinq mille. A trois cents creatures abattues dans l'heure, ca
 * fait un oeuf toutes les dix-sept heures de jeu. C'est volontairement plus
 * rare qu'une relique (1/1500) : une relique s'equipe et se remplace, un
 * familier se garde a vie.
 *
 * ---- ET LES SIX N'ONT PAS LE MEME POIDS ----
 *
 * Le legendaire est le seul qui SOIGNE. S'il tombait aussi souvent que les
 * cinq autres, il serait une issue sur six d'un tirage deja rare — donc la
 * moitie des familiers du serveur au bout d'un mois. A quatre pour cent d'une
 * chance sur cinq mille, il reste ce qu'il doit etre : une histoire qu'on
 * raconte.
 *
 * Le sac est BLANC, celui des reliques. Deux choses peuvent partager une
 * couleur quand elles disent la meme : « traverse la carte pour celui-la ».
 */
const OEUF = {
  /* ---- UN SUR MILLE DEUX CENTS, ET PAS UN SUR CINQ MILLE ----
   * Le premier chiffre etait juste sur le papier et faux dans le jeu : a
   * quinze creatures par minute, il mettait le premier oeuf a cinq heures de
   * farm, et le legendaire a plus de cent. Avec quelques dizaines de joueurs,
   * cela voulait dire que Petworld, l'enclos, les niveaux et les six pouvoirs
   * existaient pour personne. Une chose si rare que personne ne la voit
   * n'est pas rare : elle est absente.
   * Un sur mille deux cents met le premier oeuf a environ une heure — assez
   * pour rester une trouvaille dont on parle, assez peu pour que le contenu
   * batir autour serve. Le legendaire garde sa rarete par ses POIDS : quatre
   * sur cent des oeufs, donc un sur trente mille morts. */
  chance: 1 / 1200,
  sac: 'oeuf',
  /* Poids, pas probabilites : on les somme et l'on tire dedans. Ecrire des
     pourcentages obligerait a verifier a la main qu'ils font cent. */
  especes: [
    { cle: 'normal', poids: 40 },
    { cle: 'feu', poids: 14 },
    { cle: 'glace', poids: 14 },
    { cle: 'terre', poids: 14 },
    { cle: 'tenebre', poids: 14 },
    { cle: 'legendaire', poids: 4 },
  ],
};
const OEUFS = OEUF.especes.map((e) => e.cle);

/** Quelle espece d'oeuf, tiree a ses poids. */
function tireOeuf(alea) {
  const r = typeof alea === 'function' ? alea() : Math.random();
  const total = OEUF.especes.reduce((t, e) => t + e.poids, 0);
  let seuil = r * total;
  for (const e of OEUF.especes) {
    seuil -= e.poids;
    if (seuil < 0) return e.cle;
  }
  /* Un flottant qui tombe pile sur le total ne doit pas rendre `undefined` :
     on rend le dernier, qui est celui qu'il visait. */
  return OEUF.especes[OEUF.especes.length - 1].cle;
}

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
/* Quelles especes comptent comme boss pour la relique. Le brasier a pris la
   place du gardien dans la lave ; le gardien reste dans les salles, ou son
   butin est garanti par la salle elle-meme. */
const BOSS = { gardien: 1, brasier: 1, machine: 1, carapace: 1, optimus: 1,
               fonderie: 1, dreadstump: 1 };

/*
 * ---- CELUI QUI OUVRE LE DONJON DOIT EXISTER ----
 *
 * Optimus pese 0,12 sur les cinq et quelques de l'anneau de lave : deux pour
 * cent de dix-huit places, soit 0,38 Optimus vivant en moyenne. Autrement dit
 * il n'y en a AUCUN dans le monde deux fois sur trois — et comme le
 * repeuplement retire une creature au hasard dans la table du monde entier, en
 * abattre un revenait a en attendre quatre cents autres avant d'en revoir un.
 *
 * Le probleme n'est pas qu'il soit rare. C'est qu'il est la seule porte vers
 * la Fonderie : une rarete sur le chemin d'un donjon ne rend pas la chasse
 * plus precieuse, elle la rend IMPOSSIBLE A PLANIFIER. « Je vais chercher
 * Optimus » doit etre un projet qu'on peut se donner, pas un pari sur la
 * composition du monde.
 *
 * On garantit donc qu'il y en a toujours un — jamais deux, son poids reste
 * minuscule et c'est le socle qui fait tout le travail — et on met un delai
 * entre sa mort et sa renaissance. Sans ce delai, un joueur poste sur le
 * cadavre en enchainerait un toutes les secondes, et un donjon dont la
 * recompense est GARANTIE deviendrait une chaine de montage.
 */
const SOCLE = { optimus: 1 };
const SOCLE_DELAI = { optimus: 180 };

/* Dans quel anneau vit une espece. On le LIT dans la table de peuplement au
   lieu de l'ecrire une deuxieme fois : le jour ou Optimus demenage, il
   demenage a un seul endroit. */
function biomeDe(espece) {
  for (const b of Object.keys(PEUPLEMENT)) {
    if (PEUPLEMENT[b].especes.indexOf(espece) >= 0) return b;
  }
  return null;
}

/*
 * ---- A QUELLE DISTANCE ON PEUT LE FAIRE NAITRE ----
 *
 * `repeuple` refuse toute naissance a moins de 900 unites d'un joueur, et la
 * regle est bonne : 900, c'est la portee de vue d'un gros monstre, et voir une
 * creature apparaitre a portee est une punition sans cause.
 *
 * Sauf qu'Optimus vit dans la lave, et que la lave est un DISQUE de 768 unites
 * de rayon — plus petit que la regle elle-meme. Aucun point de la lave n'est a
 * 900 unites d'un joueur qui s'y trouve : tant qu'on chasse dans la lave, le
 * boss de la lave ne peut pas renaitre. Le joueur qui le cherche etait
 * exactement celui qui l'empechait d'exister.
 *
 * On borne donc l'ecart a ce que l'anneau peut OFFRIR, calcule sur la forme de
 * l'anneau plutot qu'ecrit a la main : le jour ou les anneaux bougent, ce
 * chiffre bouge avec eux.
 */
function ecartDeNaissance(espece, defaut) {
  const max = Number(defaut) || 900;
  const b = biomeDe(espece);
  const i = ANNEAUX.findIndex((a) => a.biome === b);
  if (i < 0) return max;
  const dedans = i === 0 ? 0 : ANNEAUX[i - 1].jusqua;
  const dehors = Math.min(ANNEAUX[i].jusqua, 0.94);
  /* La distance que l'anneau garantit QUEL QUE SOIT l'endroit ou se tient le
     joueur : pour un disque, un joueur au centre et une naissance au bord ;
     pour un anneau creux, deux points opposes de son bord interieur. */
  const garanti = (i === 0 ? dehors : 2 * dedans) * (MONDE.w / 2);
  /* Les quinze pour cent de marge evitent d'avoir a tomber sur LE point
     parfait : sans eux, un seul tirage sur des milliers conviendrait. */
  return Math.round(Math.min(max, garanti * 0.85));
}

/* Une naissance isolee, dans l'anneau de l'espece. Meme forme que ce que rend
   `peuplement` : `repeuple` ne doit pas avoir deux sortes de creatures a
   savoir poser. */
function placeUne(espece, alea) {
  const b = biomeDe(espece);
  if (!b) return null;
  const pos = pointDansBiome(b, alea);
  return pos ? { espece, x: pos.x, y: pos.y, biome: b } : null;
}

/* Et l'inverse : une naissance dans un anneau DONNE, l'espece tiree selon les
   poids de cet anneau. C'est ce qu'il faut pour reboucher un trou la ou il
   est, plutot que n'importe ou dans le monde. */
function naitDans(biome, alea) {
  const p = PEUPLEMENT[biome];
  if (!p) return null;
  const r = () => (typeof alea === 'function' ? alea() : Math.random());
  const pos = pointDansBiome(biome, alea);
  if (!pos) return null;
  return { espece: choisitEspece(p, r), x: pos.x, y: pos.y, biome };
}

/*
 * ---- CE QUI TOMBE A COUP SUR ----
 *
 * Le fond d'un donjon ne se tire pas au sort. Tout le reste du jeu est une
 * question de chance — un sur cent quarante pour du mythique, un sur mille
 * cinq cents pour une relique — et c'est ce qui rend la chasse tenable : on
 * ne vise rien, on ramasse ce qui vient.
 *
 * Un donjon est l'inverse. On y entre EXPRES, apres avoir abattu la creature
 * la plus dure de l'anneau le plus dur, et l'on traverse trois salles pour
 * arriver au fond. Une expedition dont la recompense serait tiree au sort
 * n'est pas une expedition, c'est une machine a sous avec des escaliers — et
 * sur un site ou l'on joue deja de l'argent, la difference n'est pas une
 * nuance de gout.
 *
 * Une TABLE, pas un drapeau sur la creature : le jour ou un deuxieme donjon
 * garde un autre rang, il s'ecrit ici, et `butinDe` ne bouge pas d'une ligne.
 */
/* ---- CE QUI TOMBE A COUP SUR, AU FOND ----
 * Une table, pas un drapeau : chaque boss de donjon nomme le rang qu'il
 * garantit. Dreadstump rend de l'EPIQUE — un cran au-dessus de ce que ses
 * pirates laissent, un cran sous le mythique du monde ouvert. On repart de la
 * cave avec quelque chose de sur, sans que ce soit mieux que ce qu'on trouve
 * en jouant normalement : c'est ce qui en fait un premier donjon plutot qu'un
 * raccourci. */
const BUTIN_GARANTI = { fonderie: 'relique', dreadstump: 'epique' };

/* Un sur cinquante. Le chiffre vient de ce qu'il doit produire : environ une
   potion toutes les vingt minutes de chasse soutenue — assez rare pour qu'on
   s'en souvienne, assez frequent pour qu'on y croie encore.
   Le gardien en donne UNE A COUP SUR : il sort une fois par anneau de lave et
   porte seize cents points de vie. Un boss qu'on peut abattre pour rien ne
   vaut pas le deplacement. */
const CHANCE_POTION = { defaut: 1 / 50, gardien: 1, brasier: 1, machine: 0.7,
                        carapace: 0.7, optimus: 1 };
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
  /* ---- CE QUI EST GARANTI NE PASSE PAS PAR LES DES ----
   * En tete, et sans consommer un seul tirage : une creature dont le butin est
   * promis ne doit pas pouvoir se retrouver, au bout de la chaine, avec une
   * potion de soin parce qu'un de a mal tourne. */
  const g = BUTIN_GARANTI[espece];
  if (g) return { sac: SAC_DE_RARETE[g], contenu: [{ objet: g }] };
  /* ---- L'OEUF AVANT TOUT LE RESTE ----
   * Un seul tirage par mort : ce qui passe en premier obtient son vrai taux,
   * ce qui passe apres n'a que ce qui reste. L'oeuf est plus rare que la
   * relique (1/5000 contre 1/1500) — il doit donc tirer avant elle, sinon son
   * chiffre ne serait plus celui qu'on a ecrit.
   * Et de N'IMPORTE QUELLE creature : c'est ce qui fait qu'un lime du bord
   * vaut encore la peine au bout de trente heures de jeu. */
  if (r() < OEUF.chance) return { sac: OEUF.sac, contenu: [{ oeuf: tireOeuf(r) }] };
  /* ---- LA RELIQUE ENSUITE, PARCE QU'ELLE EST LA PLUS RARE DU RESTE ----
   * Un seul tirage par mort : ce qui passe en premier obtient son vrai taux,
   * ce qui passe apres n'a que ce qui reste. La relique doit donc etre en
   * tete, sinon son 1/1500 deviendrait 1/1800 sans que rien ne le dise. */
  const cr = BOSS[espece] && CHANCE_RELIQUE[biome] !== undefined
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
  FAMILIERS, familierEffet, POUVOIR_PAR_ESPECE,
  ZONE_REACTION,
  SAC, SACS, POTION_DE, CHANCE_POTION, CHANCE_SOIN, STATS_POTION, butinDe, BOSS,
  SOCLE, SOCLE_DELAI, biomeDe, placeUne, naitDans, ecartDeNaissance,
  BUTIN_GARANTI, OEUF, OEUFS, tireOeuf,
  RARETE_ANNEAU, SAC_DE_RARETE, CHANCE_EQUIP, CHANCE_RELIQUE, CHANCE_RELIQUE_BOSS,
  OBSTACLE, OBSTACLE_BIOME, obstacles, bloque,
  SALLE, SALLE_ANNEAUX, SALLE_BUTIN, MUR_BASE, salles, mursDe, dansLaSalle, DONJON,
  PORTAIL, PORTAIL_DE, RETOUR_DE, MUR_DONJON, DONJON_TUILE, DONJON_SALLES,
  DONJON_COULOIR, DONJON_ORIGINE, DONJON_IMPASSES, PEUPLE_DONJON,
  planDonjon, planCave, CAVE, DONJONS, mursDonjon, peuplementDonjon, planDeDonjon,
  biomeEn, degatsInfliges, degatsSubis, tirageArme, pointDansBiome, peuplement,
  choisitEspece,
  regenParSeconde, pouvoirDeStat,
};
