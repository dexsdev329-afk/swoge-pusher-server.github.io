'use strict';
/* Le bareme des degats vit chez les personnages, et la garde de chargement
   plus bas le LIT plutot que d'en recopier une deuxieme copie ici : deux
   tables a tenir d'accord finissent toujours par se contredire. L'arete ne
   va que dans ce sens — `personnages.js` ne connait pas la boutique — donc
   pas de cycle. */
const personnages = require('./personnages');
/*
 * LA BOUTIQUE — coffres, raretes, objets.
 *
 * ---- ce que ce fichier est, et ce qu'il n'est pas ----
 *
 * Il ne touche NI aux soldes, NI a la chaine, NI au reseau. Il repond a une
 * seule question : « voici une empreinte et un coffre, quel objet sort ? ».
 * C'est un module pur, donc entierement verifiable tout seul — et c'est
 * exactement ce qu'on veut d'un tirage qui coute de l'argent.
 *
 * Le debit, le solde et l'inventaire vivent dans `game.js`, comme pour tous
 * les autres jeux. Un module de tirage qui saurait debiter serait un module
 * qu'on ne peut plus tester sans monter un serveur.
 *
 * ---- pourquoi les poids sont sur DIX MILLE ----
 *
 * Chaque table de coffre somme a exactement 10 000. Un poids EST donc sa
 * probabilite en centiemes de pour-cent, lisible sans calcul : 19 pour le
 * legendaire du coffre de bois, c'est 0,19 %. On peut le publier tel quel
 * dans la page, et personne n'a a nous croire sur parole.
 *
 * La verification est faite AU CHARGEMENT, et elle JETTE. Une table qui ne
 * somme pas a 10 000 ne fausse pas un affichage : elle fausse les chances
 * reelles, silencieusement, et la derniere rarete absorbe l'ecart. Mieux vaut
 * un serveur qui refuse de demarrer qu'un serveur qui ment.
 *
 * ---- pourquoi le tirage se fait en DEUX temps ----
 *
 * D'abord la rarete, ensuite l'objet dans cette rarete. Une seule table plate
 * sur trente objets marcherait aussi, mais ajouter un objet epique y
 * changerait la probabilite de TOUS les autres epiques — et il faudrait
 * republier la table entiere a chaque nouveaute. En deux temps, la chance de
 * tomber sur « un epique » est fixee par le coffre et ne bouge jamais ; seul
 * le partage a l'interieur de la rarete se resserre.
 *
 * Les deux tirages prennent des tranches DIFFERENTES de la meme empreinte —
 * bits 0..59 pour la rarete, 60..119 pour l'objet. Meme methode que le Coin
 * Pusher, qui prend le lot sur une tranche et le jackpot sur une autre.
 *
 * ---- les identifiants ----
 *
 * Ils sont NUMERIQUES et definitifs, ranges par blocs de mille et par rarete.
 * Ce sont eux qui deviendront les `id` du contrat ERC-1155 le jour ou les
 * objets sortiront en NFT : un identifiant qui bouge apres coup ferait
 * pointer un jeton deja emis sur un autre objet. On peut ajouter dans un
 * bloc, jamais renumeroter.
 */

/*
 * ============================== LES SAISONS ==============================
 *
 * Une saison est une COLLECTION FERMEE : ses six familles, ses trente objets,
 * ses trois coffres, ses plafonds. Elle ne se melange a aucune autre — on ne
 * peut pas tirer une arme dans un coffre a fruits, et la planche de collection
 * d'une saison ne montre jamais les objets d'une autre.
 *
 * ---- pourquoi une saison plutot qu'une grande collection ----
 *
 * L'alternative etait d'ajouter les armes aux fruits : une planche de soixante
 * cases, puis quatre-vingt-dix avec les armures. Elle a ete ecartee pour une
 * raison qui n'est pas d'ergonomie mais de parole donnee — ceux qui ont achete
 * des fruits l'ont fait sur l'annonce d'une edition de 9 600 pieces. Gonfler
 * cette edition apres coup dilue ce qu'ils ont paye, et aucune explication ne
 * rattrape ca.
 *
 * ---- CE QUI OUVRE LA SAISON SUIVANTE ----
 *
 * La regle, une fois pour toutes :
 *
 *   • une saison s'ouvre a TOUT LE MONDE quand la precedente a rendu ses trois
 *     lignes completes — la course finie est ce qui « termine » une saison ;
 *   • les trois gagnants y entrent DES LEUR PROPRE LIGNE finie, sans attendre
 *     les autres. C'est la recompense d'etre arrive premier, et elle a un
 *     effet reel : le premier entre seul dans une edition intacte.
 *
 * Une consequence qui n'est pas un defaut mais qu'il vaut mieux avoir vue : le
 * TROISIEME gagnant n'a aucune avance. Sa ligne finie est exactement l'instant
 * ou la saison s'ouvre pour tous. L'avance existe pour le premier et le
 * deuxieme, et c'est tout — la regle reste enonçable en une phrase, ce qui
 * vaut mieux qu'une exception ecrite pour rattraper un cas sans importance.
 *
 * La saison 1 n'a pas de condition : elle est le point de depart.
 */
const SAISONS = [
  { n: 1, cle: 'fruits',  nom: 'Season 1 — Devil Fruits', sujet: 'fruit'  },
  { n: 2, cle: 'armes',   nom: 'Season 2 — Weapons',      sujet: 'weapon' },
  { n: 3, cle: 'armures', nom: 'Season 3 — Armor',        sujet: 'armor'  },
  { n: 4, cle: 'bagues',  nom: 'Season 4 — Rings',        sujet: 'ring'   },
];

/* Les raretes, de la plus commune a la plus rare. L'ordre compte : il sert a
   trier l'inventaire et a peindre la page.

   Elles sont COMMUNES A TOUTES LES SAISONS, plafonds compris : une arme
   mythique est aussi rare qu'un fruit mythique, a dix exemplaires. Donner a
   chaque saison ses propres plafonds aurait rendu les deux collections
   incomparables — et la premiere question d'un acheteur sur un marche
   secondaire est « c'est rare comment, par rapport a quoi ? ». */
const RARETES = [
  { cle: 'commun',     nom: 'Common',    bloc: 1000, couleur: '#9AA7BF', plafond: 1000 },
  { cle: 'rare',       nom: 'Rare',      bloc: 2000, couleur: '#5AC8FF', plafond:  400 },
  { cle: 'epique',     nom: 'Epic',      bloc: 3000, couleur: '#C07BFF', plafond:  150 },
  { cle: 'legendaire', nom: 'Legendary', bloc: 4000, couleur: '#FFC53D', plafond:   40 },
  { cle: 'mythique',   nom: 'Mythic',    bloc: 5000, couleur: '#FF4655', plafond:   10 },
  /* ---- LA RELIQUE : LE SEUL CRAN QU'ON NE PEUT PAS ACHETER ----
   * Aucun coffre n'en contient, aucune ligne de boutique n'en propose. Elle
   * ne tombe que dans le sac blanc a ruban rouge, au fond du monde. C'est ce
   * qui la separe du mythique : le mythique est cher, la relique est
   * IMPOSSIBLE a payer.
   * Le plafond n'est pas une decoration — il est plus bas que celui du
   * mythique parce qu'un objet dont personne ne peut fabriquer l'offre doit
   * rester compte comme les autres. */
  { cle: 'relique',    nom: 'Relic',     bloc: 6000, couleur: '#FFFFFF', plafond:    4 },
];

/*
 * ---- LES PLAFONDS, ET POURQUOI ILS SONT ICI ET PAS DANS UNE NOTE « A FAIRE »
 *
 * « Mythique 0,01 % » dit a quel point c'est DUR A OBTENIR. Ca ne dit rien de
 * COMBIEN IL EN EXISTERA. Sans plafond, les deux n'ont aucun rapport : les
 * coffres etant illimites, le nombre de Void Fruits monte tant que les gens
 * jouent, et un objet dont l'offre n'a pas de borne ne peut pas tenir sa
 * valeur — l'offre grimpe, la demande est finie.
 *
 * Un plafond ne se pose pas apres coup. On ne peut pas reprendre des
 * exemplaires deja distribues : le jour ou la boutique ouvre, la quantite
 * maximale de chaque fruit est fixee pour toujours.
 *
 * L'edition entiere, six fruits par rarete :
 *
 *   commun       1 000 x 6 = 6 000
 *   rare           400 x 6 = 2 400
 *   epique         150 x 6 =   900
 *   legendaire      40 x 6 =   240
 *   mythique        10 x 6 =    60
 *                             -----
 *                             9 600 fruits, jamais un de plus
 *
 * ---- ce que ces nombres decident, et qu'on ne voit pas en les lisant ----
 *
 * Reunir les six fruits d'une rarete demande en moyenne 6 x H6 = 14,7
 * exemplaires de cette rarete — c'est le probleme du collectionneur de
 * vignettes, et le chiffre ne depend NI du coffre NI du prix. Le plafond
 * decide donc directement combien de collections completes existeront :
 *
 *   commun      6 000 / 14,7 =  408 colonnes completes possibles
 *   rare        2 400 / 14,7 =  163
 *   epique        900 / 14,7 =   61
 *   legendaire    240 / 14,7 =   16
 *   mythique       60 / 14,7 =    4
 *
 * QUATRE joueurs, au total, pourront un jour aligner les six mythiques. Ce
 * n'est pas un effet de bord du plafond, c'est ce que le plafond VEUT dire —
 * et c'est la seule facon de le comprendre avant de le figer.
 *
 * L'autre consequence : le coffre de bois epuise les communs vers 7 900
 * ouvertures. La boutique n'est pas un robinet, c'est une edition qui se
 * ferme.
 *
 * Ce sont des nombres de DEPART : ils se changent sur ces cinq lignes tant
 * que rien n'est ouvert. Ce qui ne se change pas, c'est le mecanisme.
 *
 * ---- ET CE QUE CE PLAFOND NE VAUT PAS ----
 *
 * Un compteur dans ce fichier est une PROMESSE. Personne d'exterieur ne peut
 * l'auditer, et pour qui achete sur un marche secondaire, une rarete
 * invérifiable ne vaut rien. Le meme plafond dans le `maxSupply` du contrat
 * ERC-1155 est une GARANTIE, verifiable par n'importe qui, pour toujours.
 * Les deux doivent porter les memes nombres, et c'est le contrat qui compte.
 */

/* Les six pouvoirs. Chacun a SA silhouette de fruit et SA couleur : c'est ce
   qui les distingue dans une rangee, bien avant qu'on lise un nom.
   `genre` dit ce que la famille servira plus tard — bordure de photo, avatar,
   habillage de table, trophee. Il est porte par la FAMILLE et non par le
   fruit : les cinq etats d'un meme pouvoir sont le meme pouvoir. */
const FAMILLES = [
  // ---- saison 1, les fruits
  { saison: 1, cle: 'chance', nom: 'Luck',   forme: 'pomme',   couleur: '#7CFF9B', genre: 'cadre'   },
  { saison: 1, cle: 'or',     nom: 'Gold',   forme: 'poire',   couleur: '#FFC53D', genre: 'cadre'   },
  { saison: 1, cle: 'eclair', nom: 'Flash',  forme: 'banane',  couleur: '#5AC8FF', genre: 'table'   },
  { saison: 1, cle: 'oeil',   nom: 'Sight',  forme: 'raisin',  couleur: '#C07BFF', genre: 'avatar'  },
  { saison: 1, cle: 'garde',  nom: 'Guard',  forme: 'courge',  couleur: '#8DA0C4', genre: 'trophee' },
  { saison: 1, cle: 'chaos',  nom: 'Chaos',  forme: 'carambole', couleur: '#FF4655', genre: 'trophee' },

  /* ---- saison 2, les armes ----
   *
   * `forme` porte ici l'ORIENTATION autant que la silhouette, et ce n'est pas
   * de la decoration : dans la rangee du classement une vignette fait trente
   * pixels, et a cette taille une epee et une lance sont toutes les deux « un
   * trait vertical ». Chaque famille a donc sa pose — droite, de biais, en
   * diagonale, en arc, tete lourde en haut, croisee en X — et c'est ce qui
   * rend la rangee lisible au lieu de six traits identiques. */
  { saison: 2, cle: 'lame',    nom: 'Blade',   forme: 'epee droite',      couleur: '#5AC8FF', genre: 'cadre'   },
  { saison: 2, cle: 'hache',   nom: 'Axe',     forme: 'hache de biais',   couleur: '#E08A3C', genre: 'trophee' },
  { saison: 2, cle: 'lance',   nom: 'Spear',   forme: 'lance diagonale',  couleur: '#7CFF9B', genre: 'table'   },
  { saison: 2, cle: 'arc',     nom: 'Bow',     forme: 'arc courbe',       couleur: '#FFC53D', genre: 'avatar'  },
  { saison: 2, cle: 'marteau', nom: 'Hammer',  forme: 'marteau lourd',    couleur: '#B48CFF', genre: 'trophee' },
  { saison: 2, cle: 'dagues',  nom: 'Daggers', forme: 'dagues croisees',  couleur: '#FF4655', genre: 'cadre'   },

  /* ---- saison 3, l'armure ----
   *
   * Six pieces d'un meme harnais, pas six armures completes : on equipe UNE
   * piece a la fois (comme un fruit ou une arme), la piece choisie disant
   * quelle famille elle vient d'honorer. */
  { saison: 3, cle: 'casque',     nom: 'Helm',      forme: 'casque',          couleur: '#8DA0C4', genre: 'avatar'  },
  { saison: 3, cle: 'plastron',   nom: 'Cuirass',   forme: 'plastron',        couleur: '#FF4655', genre: 'trophee' },
  { saison: 3, cle: 'epaulieres', nom: 'Pauldrons', forme: 'epaulieres',      couleur: '#B48CFF', genre: 'cadre'   },
  { saison: 3, cle: 'gantelets',  nom: 'Gauntlets', forme: 'gantelets',       couleur: '#E08A3C', genre: 'trophee' },
  { saison: 3, cle: 'jambieres',  nom: 'Greaves',   forme: 'jambieres',       couleur: '#7CFF9B', genre: 'table'   },
  { saison: 3, cle: 'bouclier',   nom: 'Shield',    forme: 'bouclier',        couleur: '#5AC8FF', genre: 'cadre'   },

  /* ---- saison 4, les bagues ----
   *
   * Six pierres, comme les six pouvoirs des fruits — la couleur de la gemme
   * fait la famille, exactement comme la forme la faisait pour les fruits. */
  { saison: 4, cle: 'grenat',    nom: 'Garnet',    forme: 'bague a gemme ronde',   couleur: '#FF4655', genre: 'trophee' },
  { saison: 4, cle: 'saphir',    nom: 'Sapphire',  forme: 'bague a gemme goutte',  couleur: '#5AC8FF', genre: 'cadre'   },
  { saison: 4, cle: 'emeraude',  nom: 'Emerald',   forme: 'bague a gemme hexagone',couleur: '#7CFF9B', genre: 'table'   },
  { saison: 4, cle: 'topaze',    nom: 'Topaz',     forme: 'bague a gemme carree',  couleur: '#E08A3C', genre: 'trophee' },
  { saison: 4, cle: 'amethyste', nom: 'Amethyst',  forme: 'bague a gemme etoile',  couleur: '#C07BFF', genre: 'avatar'  },
  { saison: 4, cle: 'onyx',      nom: 'Onyx',      forme: 'bague a gemme octogone',couleur: '#8DA0C4', genre: 'cadre'   },
];

/*
 * LES FRUITS DU SWOGE — six pouvoirs, cinq degres chacun.
 *
 * ---- pourquoi des fruits, et pas trente objets ----
 *
 * Une collection se reconnait a son LANGAGE, pas a ses sujets. Un os, des des
 * et un tapis n'ont rien en commun : trente dessins, trente directions. Un
 * fruit couvert de spirales est immediatement du meme monde que le suivant,
 * quelle que soit sa forme — c'est le motif qui fait la serie, la silhouette
 * qui fait l'objet, et la couleur qui fait le pouvoir.
 *
 * Six silhouettes franchement differentes : ronde, en poire, allongee et
 * courbee, en grappe, cotelee, etoilee. A soixante-dix-huit pixels dans une
 * grille, la forme est tout ce qu'on lit.
 *
 * ---- LE POUVOIR EST DU DECOR, ET C'EST ECRIT ----
 *
 * `pouvoir` est une phrase, pas une regle. Aucun fruit ne touche a quoi que
 * ce soit — ni aux chances, ni aux gains, ni a une mise. Sur un site ou l'on
 * joue de l'argent, un objet qui a l'air de « donner de la chance » serait
 * une affirmation fausse sur un produit de jeu, et le fait qu'elle soit
 * sous-entendue plutot qu'ecrite n'y changerait rien. La page le dit donc
 * noir sur blanc, sous la collection.
 *
 * Le jour ou un fruit servira vraiment a quelque chose, ce sera cosmetique —
 * une bordure, un avatar, un habillage de table — et jamais une odds.
 */
const ITEMS = [
  // ---- communs (1000) : le fruit encore vert, spirales ternes, aucune lueur
  { id: 1001, cle: 'fruit_pousse',   nom: 'Sprout Fruit',   rarete: 'commun', famille: 'chance',
    pouvoir: 'A faint tug on the odds. Nobody has ever proven it.' },
  { id: 1002, cle: 'fruit_cuivre',   nom: 'Copper Fruit',   rarete: 'commun', famille: 'or',
    pouvoir: 'Coins feel slightly heavier in your hand.' },
  { id: 1003, cle: 'fruit_brise',    nom: 'Breeze Fruit',   rarete: 'commun', famille: 'eclair',
    pouvoir: 'You blink a little faster than the table.' },
  { id: 1004, cle: 'fruit_lueur',    nom: 'Glimpse Fruit',  rarete: 'commun', famille: 'oeil',
    pouvoir: 'You catch the edge of what is coming, then lose it.' },
  { id: 1005, cle: 'fruit_ecorce',   nom: 'Bark Fruit',     rarete: 'commun', famille: 'garde',
    pouvoir: 'A thin skin between you and a bad night.' },
  { id: 1006, cle: 'fruit_etincelle',nom: 'Spark Fruit',    rarete: 'commun', famille: 'chaos',
    pouvoir: 'Small things go wrong around you. Rarely yours.' },

  // ---- rares (2000) : le fruit mur, spirales nettes, un liseré de lumiere
  { id: 2001, cle: 'fruit_trefle',   nom: 'Clover Fruit',   rarete: 'rare', famille: 'chance',
    pouvoir: 'Four leaves. You stopped counting after the third.' },
  { id: 2002, cle: 'fruit_argent',   nom: 'Silver Fruit',   rarete: 'rare', famille: 'or',
    pouvoir: 'Every pocket you reach into has something in it.' },
  { id: 2003, cle: 'fruit_elan',     nom: 'Dash Fruit',     rarete: 'rare', famille: 'eclair',
    pouvoir: 'You act before the clock finishes its swing.' },
  { id: 2004, cle: 'fruit_intuition',nom: 'Insight Fruit',  rarete: 'rare', famille: 'oeil',
    pouvoir: 'You know which card he wishes he had.' },
  { id: 2005, cle: 'fruit_fer',      nom: 'Iron Fruit',     rarete: 'rare', famille: 'garde',
    pouvoir: 'What hits you leaves a mark on itself.' },
  { id: 2006, cle: 'fruit_ruse',     nom: 'Trick Fruit',    rarete: 'rare', famille: 'chaos',
    pouvoir: 'The table changes its mind. So do you.' },

  // ---- epiques (3000) : la peau s'illumine, les spirales rougeoient
  { id: 3001, cle: 'fruit_fortune',  nom: 'Fortune Fruit',  rarete: 'epique', famille: 'chance',
    pouvoir: 'Doors you never knocked on open anyway.' },
  { id: 3002, cle: 'fruit_or',       nom: 'Gold Fruit',     rarete: 'epique', famille: 'or',
    pouvoir: 'What you touch keeps a little of its shine on you.' },
  { id: 3003, cle: 'fruit_eclair',   nom: 'Flash Fruit',    rarete: 'epique', famille: 'eclair',
    pouvoir: 'Between two heartbeats you have already decided.' },
  { id: 3004, cle: 'fruit_oracle',   nom: 'Oracle Fruit',   rarete: 'epique', famille: 'oeil',
    pouvoir: 'You see the round end while it is still starting.' },
  { id: 3005, cle: 'fruit_bastion',  nom: 'Bastion Fruit',  rarete: 'epique', famille: 'garde',
    pouvoir: 'A wall grows where you stand still.' },
  { id: 3006, cle: 'fruit_fracas',   nom: 'Havoc Fruit',    rarete: 'epique', famille: 'chaos',
    pouvoir: 'Order leaves the room when you enter it.' },

  // ---- legendaires (4000) : le fruit rayonne, halo dore, spirales vivantes
  { id: 4001, cle: 'fruit_miracle',  nom: 'Miracle Fruit',  rarete: 'legendaire', famille: 'chance',
    pouvoir: 'The impossible happens once. To you, twice.' },
  { id: 4002, cle: 'fruit_tresor',   nom: 'Treasure Fruit', rarete: 'legendaire', famille: 'or',
    pouvoir: 'Buried things surface where you walk.' },
  { id: 4003, cle: 'fruit_foudre',   nom: 'Thunder Fruit',  rarete: 'legendaire', famille: 'eclair',
    pouvoir: 'The sound arrives long after you are gone.' },
  { id: 4004, cle: 'fruit_prescience',nom: 'Foresight Fruit', rarete: 'legendaire', famille: 'oeil',
    pouvoir: 'Tomorrow is a room you have already walked through.' },
  { id: 4005, cle: 'fruit_egide',    nom: 'Aegis Fruit',    rarete: 'legendaire', famille: 'garde',
    pouvoir: 'Nothing has reached you in a very long time.' },
  { id: 4006, cle: 'fruit_tempete',  nom: 'Storm Fruit',    rarete: 'legendaire', famille: 'chaos',
    pouvoir: 'You do not break the rules. They break near you.' },

  // ---- mythiques (5000) : la lumiere sort de l'interieur, le fruit flotte
  { id: 5001, cle: 'fruit_destin',   nom: 'Destiny Fruit',  rarete: 'mythique', famille: 'chance',
    pouvoir: 'It was always going to be you.' },
  { id: 5002, cle: 'fruit_midas',    nom: 'Midas Fruit',    rarete: 'mythique', famille: 'or',
    pouvoir: 'Even the things you regret turn to gold.' },
  { id: 5003, cle: 'fruit_temps',    nom: 'Time Fruit',     rarete: 'mythique', famille: 'eclair',
    pouvoir: 'You have already read this line.' },
  { id: 5004, cle: 'fruit_omniscient',nom: 'Omniscient Fruit', rarete: 'mythique', famille: 'oeil',
    pouvoir: 'There is nothing left to guess. That is the curse.' },
  { id: 5005, cle: 'fruit_immortel', nom: 'Immortal Fruit', rarete: 'mythique', famille: 'garde',
    pouvoir: 'The house has stopped trying.' },
  { id: 5006, cle: 'fruit_neant',    nom: 'Void Fruit',     rarete: 'mythique', famille: 'chaos',
    pouvoir: 'Where it is, the rules simply are not written yet.' },

  /* ==================== SAISON 2 — LES ARMES ====================
   *
   * Meme grille : six familles, cinq degres. La rarete se lit sur l'ETAT de
   * l'arme et non sur sa forme — ebrechee, entretenue, gravee de lueurs,
   * auréolée d'or, puis fendue de lumiere. C'est la meme progression que les
   * fruits verts jusqu'aux fruits incandescents, et c'est voulu : un joueur
   * qui a appris a lire une collection sait deja lire l'autre.
   *
   * Les identifiants continuent dans les memes blocs de rarete — 1007 a 1012
   * pour les communes. Les blocs de mille existaient exactement pour ca :
   * ajouter sans renumeroter, parce qu'un identifiant qui bouge apres coup
   * ferait pointer un jeton deja emis sur un autre objet. */

  // ---- communes : l'arme de troupe, piquee, ebrechee, sans lueur
  { id: 1007, cle: 'arme_ebreche',  nom: 'Notched Blade',   rarete: 'commun', famille: 'lame',
    pouvoir: 'It has cut something. Nobody remembers what.' },
  { id: 1008, cle: 'arme_bucheron', nom: "Woodsman's Axe",  rarete: 'commun', famille: 'hache',
    pouvoir: 'Honest work first, everything else after.' },
  { id: 1009, cle: 'arme_chasse',   nom: 'Hunting Spear',   rarete: 'commun', famille: 'lance',
    pouvoir: 'Reach is the whole argument.' },
  { id: 1010, cle: 'arme_arc_court', nom: "Hunter's Bow",   rarete: 'commun', famille: 'arc',
    pouvoir: 'Quiet, patient, and already gone.' },
  { id: 1011, cle: 'arme_maillet',  nom: 'Iron Maul',       rarete: 'commun', famille: 'marteau',
    pouvoir: 'No edge. It never needed one.' },
  { id: 1012, cle: 'arme_couteaux', nom: 'Rusted Knives',   rarete: 'commun', famille: 'dagues',
    pouvoir: 'Two of them, because one is never enough.' },

  // ---- rares : entretenue, tranchant net, poignee refaite
  { id: 2007, cle: 'arme_tranchant', nom: 'Keen Blade',     rarete: 'rare', famille: 'lame',
    pouvoir: 'The edge finds the gap before you do.' },
  { id: 2008, cle: 'arme_guerre',    nom: 'War Axe',        rarete: 'rare', famille: 'hache',
    pouvoir: 'It stopped being a tool a long time ago.' },
  { id: 2009, cle: 'arme_pique',     nom: 'Pike',           rarete: 'rare', famille: 'lance',
    pouvoir: 'A wall of them decides the field.' },
  { id: 2010, cle: 'arme_arc_long',  nom: 'Longbow',        rarete: 'rare', famille: 'arc',
    pouvoir: 'The answer arrives before the question.' },
  { id: 2011, cle: 'arme_marteau',   nom: 'War Hammer',     rarete: 'rare', famille: 'marteau',
    pouvoir: 'Armour is a suggestion.' },
  { id: 2012, cle: 'arme_jumelles',  nom: 'Twin Fangs',     rarete: 'rare', famille: 'dagues',
    pouvoir: 'One to parry. One to finish.' },

  // ---- epiques : les gravures s'allument de l'interieur
  { id: 3007, cle: 'arme_runes',   nom: 'Runed Blade',      rarete: 'epique', famille: 'lame',
    pouvoir: 'The grooves hum when something is coming.' },
  { id: 3008, cle: 'arme_fendoir', nom: 'Stormsplitter',    rarete: 'epique', famille: 'hache',
    pouvoir: 'The air parts before the head does.' },
  { id: 3009, cle: 'arme_croc',    nom: "Serpent's Fang",   rarete: 'epique', famille: 'lance',
    pouvoir: 'It strikes twice on the same thrust.' },
  { id: 3010, cle: 'arme_murmure', nom: 'Whisperwind',      rarete: 'epique', famille: 'arc',
    pouvoir: 'You never hear the string.' },
  { id: 3011, cle: 'arme_tonnerre', nom: 'Thunderhead',     rarete: 'epique', famille: 'marteau',
    pouvoir: 'The sound lands a full second late.' },
  { id: 3012, cle: 'arme_ombre',   nom: 'Shadowbite',       rarete: 'epique', famille: 'dagues',
    pouvoir: 'They are drawn before the room notices.' },

  // ---- legendaires : halo dore, gravures en fusion
  { id: 4007, cle: 'arme_aube',    nom: 'Dawnbreaker',      rarete: 'legendaire', famille: 'lame',
    pouvoir: 'Night ends where it is pointed.' },
  { id: 4008, cle: 'arme_bourreau', nom: 'Skullrender',     rarete: 'legendaire', famille: 'hache',
    pouvoir: 'It has never needed a second swing.' },
  { id: 4009, cle: 'arme_perceciel', nom: 'Skypiercer',     rarete: 'legendaire', famille: 'lance',
    pouvoir: 'Thrown once. It has not come down.' },
  { id: 4010, cle: 'arme_corde_solaire', nom: 'Sunstring',  rarete: 'legendaire', famille: 'arc',
    pouvoir: 'The arrow is light, and light does not miss.' },
  { id: 4011, cle: 'arme_seisme',  nom: 'Earthshaker',      rarete: 'legendaire', famille: 'marteau',
    pouvoir: 'The ground agrees with it.' },
  { id: 4012, cle: 'arme_sang',    nom: 'Bloodwhisper',     rarete: 'legendaire', famille: 'dagues',
    pouvoir: 'They tell you where to cut. You listen.' },

  // ---- mythiques : le metal se fend, la lumiere sort, l'arme flotte
  { id: 5007, cle: 'arme_faille',  nom: 'Worldcleaver',     rarete: 'mythique', famille: 'lame',
    pouvoir: 'The cut stays open after the blade is gone.' },
  { id: 5008, cle: 'arme_montagne', nom: 'Mountainfall',    rarete: 'mythique', famille: 'hache',
    pouvoir: 'It was a mountain. Then it was not.' },
  { id: 5009, cle: 'arme_lance_divine', nom: 'Godspear',    rarete: 'mythique', famille: 'lance',
    pouvoir: 'It was thrown from somewhere above the sky.' },
  { id: 5010, cle: 'arme_chant_final', nom: 'Endsong',      rarete: 'mythique', famille: 'arc',
    pouvoir: 'The last note anyone hears.' },
  { id: 5011, cle: 'arme_enclume', nom: 'Worldanvil',       rarete: 'mythique', famille: 'marteau',
    pouvoir: 'Everything that exists was shaped on it.' },
  { id: 5012, cle: 'arme_faucheuse', nom: "Reaper's Pair",  rarete: 'mythique', famille: 'dagues',
    pouvoir: 'One takes the body. One takes the rest.' },

  /* ==================== SAISON 3 — L'ARMURE ====================
   *
   * Six pieces, cinq degres — meme grille que les deux saisons precedentes.
   * Les identifiants continuent dans les memes blocs de rarete : 1013 a 1018
   * pour les communes. */

  // ---- communes : le metal terne, cabosse, sans lueur
  { id: 1013, cle: 'casque_cabosse',    nom: 'Dented Helm',      rarete: 'commun', famille: 'casque',
    pouvoir: "Someone else's dent. You never asked." },
  { id: 1014, cle: 'plastron_rouille',  nom: 'Rusted Cuirass',   rarete: 'commun', famille: 'plastron',
    pouvoir: 'It has stopped a blow. It does not say which.' },
  { id: 1015, cle: 'epaulieres_fissure',nom: 'Cracked Pauldrons',rarete: 'commun', famille: 'epaulieres',
    pouvoir: 'The crack is older than the owner.' },
  { id: 1016, cle: 'gantelets_usure',   nom: 'Worn Gauntlets',   rarete: 'commun', famille: 'gantelets',
    pouvoir: 'The knuckles remember more than the owner does.' },
  { id: 1017, cle: 'jambieres_use',     nom: 'Scuffed Greaves',  rarete: 'commun', famille: 'jambieres',
    pouvoir: 'Every scuff is a room left in a hurry.' },
  { id: 1018, cle: 'bouclier_fissure',  nom: 'Cracked Shield',   rarete: 'commun', famille: 'bouclier',
    pouvoir: 'It took the hit so you would not have to.' },

  // ---- rares : entretenue, polie, refaite
  { id: 2013, cle: 'casque_guet',       nom: 'Watch Helm',       rarete: 'rare', famille: 'casque',
    pouvoir: 'You hear the room a half-second early.' },
  { id: 2014, cle: 'plastron_trempe',   nom: 'Tempered Cuirass', rarete: 'rare', famille: 'plastron',
    pouvoir: 'Folded a hundred times, forgiving none of them.' },
  { id: 2015, cle: 'epaulieres_garde',  nom: 'Guard Pauldrons',  rarete: 'rare', famille: 'epaulieres',
    pouvoir: 'Squared shoulders, borrowed confidence.' },
  { id: 2016, cle: 'gantelets_fer',     nom: 'Iron Gauntlets',   rarete: 'rare', famille: 'gantelets',
    pouvoir: 'A handshake here is a decision.' },
  { id: 2017, cle: 'jambieres_agile',   nom: 'Swift Greaves',    rarete: 'rare', famille: 'jambieres',
    pouvoir: 'You are already gone by the time the door notices.' },
  { id: 2018, cle: 'bouclier_acier',    nom: 'Steel Shield',     rarete: 'rare', famille: 'bouclier',
    pouvoir: 'Nothing personal gets through this first.' },

  // ---- epiques : les gravures s'allument de l'interieur
  { id: 3013, cle: 'casque_rune',       nom: 'Runed Helm',       rarete: 'epique', famille: 'casque',
    pouvoir: 'The visor remembers faces you forgot.' },
  { id: 3014, cle: 'plastron_rune',     nom: 'Runed Cuirass',    rarete: 'epique', famille: 'plastron',
    pouvoir: 'The engravings tighten before the danger does.' },
  { id: 3015, cle: 'epaulieres_rune',   nom: 'Runed Pauldrons',  rarete: 'epique', famille: 'epaulieres',
    pouvoir: 'They square themselves before you decide to stand tall.' },
  { id: 3016, cle: 'gantelets_rune',    nom: 'Runed Gauntlets',  rarete: 'epique', famille: 'gantelets',
    pouvoir: 'The grip tightens on its own, sometimes.' },
  { id: 3017, cle: 'jambieres_rune',    nom: 'Runed Greaves',    rarete: 'epique', famille: 'jambieres',
    pouvoir: 'The ground feels slightly further away, in a good way.' },
  { id: 3018, cle: 'bouclier_rune',     nom: 'Runed Shield',     rarete: 'epique', famille: 'bouclier',
    pouvoir: 'It leans forward before you know you need it to.' },

  // ---- legendaires : halo dore, le metal rayonne
  { id: 4013, cle: 'casque_soleil',     nom: 'Sunhelm',          rarete: 'legendaire', famille: 'casque',
    pouvoir: 'Look at it wrong and it looks back, brighter.' },
  { id: 4014, cle: 'plastron_soleil',   nom: 'Sunplate',         rarete: 'legendaire', famille: 'plastron',
    pouvoir: 'Warm to the touch, even in a cold room.' },
  { id: 4015, cle: 'epaulieres_soleil', nom: 'Sunpauldrons',     rarete: 'legendaire', famille: 'epaulieres',
    pouvoir: 'Light rests on them like it has nowhere better to be.' },
  { id: 4016, cle: 'gantelets_soleil',  nom: 'Sungrip',          rarete: 'legendaire', famille: 'gantelets',
    pouvoir: 'What it closes around, it does not easily give back.' },
  { id: 4017, cle: 'jambieres_soleil',  nom: 'Sunstride',        rarete: 'legendaire', famille: 'jambieres',
    pouvoir: 'Footsteps that catch the light before the sound does.' },
  { id: 4018, cle: 'bouclier_soleil',   nom: 'Sunward',          rarete: 'legendaire', famille: 'bouclier',
    pouvoir: 'Held up, it makes the room feel like morning.' },

  // ---- mythiques : le metal se fend, la lumiere sort, l'armure flotte
  { id: 5013, cle: 'casque_divin',      nom: 'Godhelm',          rarete: 'mythique', famille: 'casque',
    pouvoir: 'It was worn once by someone the story forgot to name.' },
  { id: 5014, cle: 'plastron_coeur_monde', nom: 'Worldheart',    rarete: 'mythique', famille: 'plastron',
    pouvoir: 'Something in it still beats, slowly, on its own.' },
  { id: 5015, cle: 'epaulieres_titan',  nom: 'Titan Pauldrons',  rarete: 'mythique', famille: 'epaulieres',
    pouvoir: 'Once carried a weight the story left out.' },
  { id: 5016, cle: 'gantelets_monde',   nom: 'Worldgrip',        rarete: 'mythique', famille: 'gantelets',
    pouvoir: 'It has held something the size of an argument, and won.' },
  { id: 5017, cle: 'jambieres_monde',   nom: 'Worldstride',      rarete: 'mythique', famille: 'jambieres',
    pouvoir: 'One step here is a mile somewhere else.' },
  { id: 5018, cle: 'bouclier_mur_monde',nom: 'Worldwall',        rarete: 'mythique', famille: 'bouclier',
    pouvoir: 'Behind it, the argument was already over.' },

  /* ==================== SAISON 4 — LES BAGUES ====================
   *
   * Six gemmes, cinq degres. Les identifiants continuent : 1019 a 1024 pour
   * les communes. */

  // ---- communes : la pierre brute, sans taille, sans lueur
  { id: 1019, cle: 'ring_braise',   nom: 'Ember Ring',   rarete: 'commun', famille: 'grenat',
    pouvoir: 'Still warm, from a fire nobody remembers lighting.' },
  { id: 1020, cle: 'ring_goutte',   nom: 'Drop Ring',    rarete: 'commun', famille: 'saphir',
    pouvoir: 'One clear thought, held a moment longer than usual.' },
  { id: 1021, cle: 'ring_feuille',  nom: 'Leaf Ring',    rarete: 'commun', famille: 'emeraude',
    pouvoir: 'Light on the hand, lighter on the step.' },
  { id: 1022, cle: 'ring_ambre',    nom: 'Amber Ring',   rarete: 'commun', famille: 'topaze',
    pouvoir: 'Something old, kept warm on purpose.' },
  { id: 1023, cle: 'ring_violette', nom: 'Violet Ring',  rarete: 'commun', famille: 'amethyste',
    pouvoir: 'A question you have not asked out loud yet.' },
  { id: 1024, cle: 'ring_ardoise',  nom: 'Slate Ring',   rarete: 'commun', famille: 'onyx',
    pouvoir: 'Plain, cold, and entirely unbothered.' },

  // ---- rares : la gemme taillee, la monture polie
  { id: 2019, cle: 'ring_grenat',   nom: 'Garnet Ring',  rarete: 'rare', famille: 'grenat',
    pouvoir: 'A little colour returns to a tired face.' },
  { id: 2020, cle: 'ring_saphir',   nom: 'Sapphire Ring',rarete: 'rare', famille: 'saphir',
    pouvoir: 'The noise in the room quiets, just for you.' },
  { id: 2021, cle: 'ring_emeraude',  nom: 'Emerald Ring', rarete: 'rare', famille: 'emeraude',
    pouvoir: 'Something in you keeps growing back.' },
  { id: 2022, cle: 'ring_topaze',   nom: 'Topaz Ring',   rarete: 'rare', famille: 'topaze',
    pouvoir: 'It catches attention it never asked for.' },
  { id: 2023, cle: 'ring_amethyste',nom: 'Amethyst Ring',rarete: 'rare', famille: 'amethyste',
    pouvoir: 'You start finishing sentences early. You are usually right.' },
  { id: 2024, cle: 'ring_onyx',     nom: 'Onyx Ring',    rarete: 'rare', famille: 'onyx',
    pouvoir: 'Nothing reflects off it. Nothing gets through it either.' },

  // ---- epiques : la gemme s'allume de l'interieur
  { id: 3019, cle: 'ring_sang',     nom: 'Bloodstone Ring', rarete: 'epique', famille: 'grenat',
    pouvoir: 'It beats along, very quietly, out of rhythm with you.' },
  { id: 3020, cle: 'ring_maree',    nom: 'Tide Ring',       rarete: 'epique', famille: 'saphir',
    pouvoir: 'Thoughts arrive in the order you actually needed them.' },
  { id: 3021, cle: 'ring_bosquet',  nom: 'Grove Ring',      rarete: 'epique', famille: 'emeraude',
    pouvoir: 'Roots you cannot see are holding you upright.' },
  { id: 3022, cle: 'ring_feu_solaire', nom: 'Sunfire Ring', rarete: 'epique', famille: 'topaze',
    pouvoir: 'The room brightens, and nobody notices why.' },
  { id: 3023, cle: 'ring_etoile',   nom: 'Star Ring',       rarete: 'epique', famille: 'amethyste',
    pouvoir: 'It points at something before you look up.' },
  { id: 3024, cle: 'ring_fer',      nom: 'Iron Ring',       rarete: 'epique', famille: 'onyx',
    pouvoir: 'It closes ranks before you tell it to.' },

  // ---- legendaires : une aura vive, des etincelles
  { id: 4019, cle: 'ring_phenix',   nom: 'Phoenix Ring', rarete: 'legendaire', famille: 'grenat',
    pouvoir: 'Everything it has lost, it has gotten back.' },
  { id: 4020, cle: 'ring_tempete',  nom: 'Storm Ring',   rarete: 'legendaire', famille: 'saphir',
    pouvoir: 'Somewhere behind your eyes, it is always about to rain.' },
  { id: 4021, cle: 'ring_sauvage',  nom: 'Wild Ring',    rarete: 'legendaire', famille: 'emeraude',
    pouvoir: 'It has never once asked permission.' },
  { id: 4022, cle: 'ring_couronne', nom: 'Crown Ring',   rarete: 'legendaire', famille: 'topaze',
    pouvoir: 'Worn once by someone people still argue about.' },
  { id: 4023, cle: 'ring_oracle',   nom: 'Oracle Ring',  rarete: 'legendaire', famille: 'amethyste',
    pouvoir: 'It answers before the question is finished.' },
  { id: 4024, cle: 'ring_vide',     nom: 'Void Ring',    rarete: 'legendaire', famille: 'onyx',
    pouvoir: 'Whatever it takes in, it does not give back.' },

  // ---- mythiques : incandescente, la bague levite
  { id: 5019, cle: 'ring_flamme_eternelle', nom: 'Eternal Flame Ring', rarete: 'mythique', famille: 'grenat',
    pouvoir: 'It has never once gone out. Nobody has tried very hard.' },
  { id: 5020, cle: 'ring_abysse',   nom: 'Abyss Ring',        rarete: 'mythique', famille: 'saphir',
    pouvoir: 'It thinks, sometimes, before you do.' },
  { id: 5021, cle: 'ring_arbre_monde', nom: 'World Tree Ring', rarete: 'mythique', famille: 'emeraude',
    pouvoir: 'Every root it has ever grown is still somewhere, listening.' },
  { id: 5022, cle: 'ring_souverain',nom: 'Sovereign Ring',    rarete: 'mythique', famille: 'topaze',
    pouvoir: 'It does not ask to be obeyed. It simply is.' },
  { id: 5023, cle: 'ring_destinee', nom: 'Fate Ring',         rarete: 'mythique', famille: 'amethyste',
    pouvoir: 'It already knows how this sentence ends.' },
  { id: 5024, cle: 'ring_eclipse',  nom: 'Eclipse Ring',      rarete: 'mythique', famille: 'onyx',
    pouvoir: 'For a moment, standing near it, nothing can quite see you.' },
];

/* Les coffres. Le prix est en $SWOGE, la table en dix-milliemes.
   Trois paliers, et le meme catalogue derriere les trois : le coffre cher ne
   donne pas acces a d'autres objets, il donne PLUS DE CHANCES pour les memes.
   C'est la seule forme honnete — un objet reserve au coffre a 2,5 millions
   serait invendable a qui n'a pas 2,5 millions, et il n'aurait aucune valeur
   pour les autres. */
const TOTAL = 10000;

/*
 * ---- LES PRIX SONT CALES SUR LE COUT D'UNE LIGNE ----
 *
 * Une LIGNE, ce sont les cinq raretes d'une meme famille. Et il a fallu
 * corriger une erreur de raisonnement avant de pouvoir chiffrer quoi que ce
 * soit : on calculait le cout d'une ligne CHOISIE D'AVANCE — « je veux les
 * cinq Chaos ». Personne ne joue comme ca. Un collectionneur ouvre des
 * coffres et termine la famille qui se presente : c'est le mythique qui
 * decide de la ligne, pas l'inverse.
 *
 * La difference n'est pas un detail. Attendre UN mythique precis, c'est un
 * sur trois mille par coffre dore ; attendre N'IMPORTE LEQUEL des six, c'est
 * un sur cinq cents. Le cout reel etait cinq fois plus bas que le chiffre
 * qu'on regardait.
 *
 * ---- LE PRIX NE PEUT PAS TOUT ----
 *
 * Il a d'abord ete cale pour que 99 joueurs sur 100 restent sous cent
 * millions, ce qui donnait un dixieme centile a cinq millions. Trop bon
 * marche a l'entree : la cible est devenue « que le joueur chanceux paie
 * deja cinquante millions ».
 *
 * LES DEUX NE PEUVENT PAS TENIR ENSEMBLE, et c'est arithmetique. Le prix est
 * un simple multiplicateur : il deplace TOUS les centiles dans le meme
 * rapport. L'ecart entre le chanceux et le malchanceux, lui, est fixe par la
 * LOI du tirage. Mesure sur quatre mille parcours au coffre dore :
 *
 *   126 coffres au dixieme centile, 2 345 au quatre-vingt-dix-neuvieme,
 *   soit un rapport de 18,6 — INDEPENDANT du prix.
 *
 * Un dixieme centile a 50 M impose donc un quatre-vingt-dix-neuvieme vers
 * 930 M. C'est le choix qui a ete fait, en connaissance de cause.
 *
 * Etat actuel, coffre dore a 40 000 — les montants ont ensuite ete divises
 * par dix pour rentrer dans l'echelle du jeton, voir le bloc des prix :
 *
 *   1 sur 10 avant      5,2 M   0,5 % de la supply
 *   la moitie avant    16,6 M   1,7 %
 *   9 sur 10 avant     46,1 M   4,6 %
 *   99 sur 100 avant   92,7 M   9,3 %
 *
 * ---- ce qui pourrait couper la queue, et n'est pas en place ----
 *
 * Un COMPTEUR DE PITIE — « apres N coffres sans mythique, le suivant en est
 * un » — tronque la loi au lieu de la deplacer, et donne un vrai maximum.
 * Mesure a 2 500 coffres : pire cas exactement N x prix, sans rien changer
 * au dixieme centile ni a la mediane. C'est le SEUL levier qui agit sur
 * l'ecart ; le prix, non.
 *
 * Ces prix ne touchent PAS a la rarete : les plafonds en sont independants.
 * Il y aura toujours soixante mythiques et quatre collections mythiques
 * completes. On rend la collection accessible sans la rendre commune.
 */
const COFFRES = [
  // ---- saison 1
  { saison: 1, cle: 'bois', nom: 'Wooden Chest', prix: 4000, image: 'bois',
    table: [['commun', 7600], ['rare', 2100], ['epique', 280], ['legendaire', 19], ['mythique', 1]] },
  { saison: 1, cle: 'or', nom: 'Golden Chest', prix: 40000, image: 'or',
    table: [['commun', 4500], ['rare', 3800], ['epique', 1400], ['legendaire', 280], ['mythique', 20]] },
  { saison: 1, cle: 'mythe', nom: 'Mythic Chest', prix: 400000, image: 'mythe',
    table: [['commun', 1000], ['rare', 3400], ['epique', 3900], ['legendaire', 1500], ['mythique', 200]] },

  /* ---- saison 2 ----
   *
   * MEMES PRIX ET MEMES TABLES que la saison 1, et ce n'est pas de la
   * paresse : les plafonds sont les memes, donc le cout d'une ligne est le
   * meme, donc changer les prix rendrait une saison mecaniquement plus chere a
   * collectionner que l'autre sans que rien ne le justifie. Le jour ou une
   * saison doit couter plus, ce sera une decision ecrite ici, avec sa raison.
   *
   * `image` est SEPARE de `cle`. Le dessin des caisses d'armes n'existe pas
   * encore ; en attendant elles empruntent celui des coffres a fruits, et le
   * jour ou l'art arrive on change ce seul mot. Sans ce champ, il aurait fallu
   * ou bien renommer les clefs — qui partent dans les fiches des joueurs — ou
   * bien afficher trois cadres casses. */
  { saison: 2, cle: 'armes_bois', nom: 'Weapon Crate', prix: 4000, image: 'bois',
    table: [['commun', 7600], ['rare', 2100], ['epique', 280], ['legendaire', 19], ['mythique', 1]] },
  { saison: 2, cle: 'armes_or', nom: 'Golden Armoury', prix: 40000, image: 'or',
    table: [['commun', 4500], ['rare', 3800], ['epique', 1400], ['legendaire', 280], ['mythique', 20]] },
  { saison: 2, cle: 'armes_mythe', nom: 'Mythic Armoury', prix: 400000, image: 'mythe',
    table: [['commun', 1000], ['rare', 3400], ['epique', 3900], ['legendaire', 1500], ['mythique', 200]] },

  /* ---- saison 3 : memes prix et memes tables, meme raison qu'a la saison 2 —
     l'art des caisses d'armure n'existe pas encore, elles empruntent celui
     des coffres a fruits en attendant. */
  { saison: 3, cle: 'armures_bois', nom: 'Armor Crate', prix: 4000, image: 'bois',
    table: [['commun', 7600], ['rare', 2100], ['epique', 280], ['legendaire', 19], ['mythique', 1]] },
  { saison: 3, cle: 'armures_or', nom: 'Golden Armory', prix: 40000, image: 'or',
    table: [['commun', 4500], ['rare', 3800], ['epique', 1400], ['legendaire', 280], ['mythique', 20]] },
  { saison: 3, cle: 'armures_mythe', nom: 'Mythic Armory', prix: 400000, image: 'mythe',
    table: [['commun', 1000], ['rare', 3400], ['epique', 3900], ['legendaire', 1500], ['mythique', 200]] },

  /* ---- saison 4 : idem. */
  { saison: 4, cle: 'bagues_bois', nom: 'Ring Box', prix: 4000, image: 'bois',
    table: [['commun', 7600], ['rare', 2100], ['epique', 280], ['legendaire', 19], ['mythique', 1]] },
  { saison: 4, cle: 'bagues_or', nom: 'Golden Jewel Box', prix: 40000, image: 'or',
    table: [['commun', 4500], ['rare', 3800], ['epique', 1400], ['legendaire', 280], ['mythique', 20]] },
  { saison: 4, cle: 'bagues_mythe', nom: 'Mythic Jewel Box', prix: 400000, image: 'mythe',
    table: [['commun', 1000], ['rare', 3400], ['epique', 3900], ['legendaire', 1500], ['mythique', 200]] },
];

/*
 * ---- LA COURSE AUX TROIS PREMIERES LIGNES ----
 *
 * Completer une famille — ses cinq raretes — paie, pour les trois premiers
 * joueurs seulement. Ensuite la course est finie, definitivement.
 *
 * Quatre regles, qui doivent exister AVANT le premier coffre parce qu'on ne
 * peut pas les inventer quand quelqu'un reclame :
 *
 *   1. UN SEUL PRIX PAR JOUEUR. Sans cette regle, celui qui complete trois
 *      familles rafle les trois places, et la course n'oppose personne. Le
 *      deuxieme prix va au deuxieme JOUEUR, pas a la deuxieme ligne.
 *
 *   2. L'ORDRE EST CELUI DU SERVEUR. Les achats sont traites un par un, dans
 *      l'ordre d'arrivee : deux joueurs ne peuvent pas completer « en meme
 *      temps ». Il n'y a donc pas de regle d'egalite a ecrire, et c'est
 *      voulu — une egalite sur un prix de cinquante millions n'a aucune
 *      solution qui paraisse juste a tout le monde.
 *
 *   3. LE PRIX EST PAYE AU MOMENT OU LA CINQUIEME CASE SE REMPLIT, pas sur
 *      reclamation. Un prix qu'il faut aller chercher est un prix que
 *      quelqu'un oubliera, et il n'y a aucune raison de le lui faire perdre.
 *
 *   4. LA LISTE DES GAGNANTS PART AU FICHIER. Sans ca, un redemarrage
 *      rouvrirait la course et repaierait — le genre de defaut qui coute
 *      quatre-vingt-dix millions sans rien afficher d'anormal.
 *
 * Ce que ca change a la nature de la boutique, et qu'il faut assumer : un
 * coffre pouvait jusqu'ici ne JAMAIS rendre de jetons, ce qui justifiait
 * qu'il ne compte ni dans les quetes ni dans le retour par jeu. Il peut
 * desormais mener a un gain — une fois, au bout d'une collection, pour trois
 * joueurs. Le gain est donc journalise comme tel.
 */
/*
 * ---- L'ECHELLE A ETE RATTRAPEE PAR LA SUPPLY, PAS PAR LE RAISONNEMENT ----
 *
 * Ces montants ont d'abord ete cales les uns SUR LES AUTRES : combien coute
 * une ligne, combien rapporte de la completer. Personne n'avait rapporte le
 * resultat au jeton. Il valait 50, 30 et 10 millions, soit NEUF POUR CENT de
 * la supply totale distribues a trois joueurs — et le coffre mythique a lui
 * seul coutait 0,4 % de tout ce qui existera.
 *
 * Les reperes du site donnent l'echelle juste, et ils etaient sous les yeux :
 *
 *   un jeton lache au Coin Pusher              1
 *   graine du jackpot, retrait minimum    10 000    0,001 %
 *   pari sportif maximum                 100 000    0,01 %
 *   gain maximum d'un bulletin         5 000 000    0,5 %
 *
 * Tout le jeu vit entre un et cent mille. La boutique tournait trois ordres
 * de grandeur au-dessus.
 *
 * Apres division par dix, chaque montant retombe sur un repere qui existe
 * deja : le coffre mythique vaut quatre paris sportifs au plafond, et le
 * premier prix vaut exactement le gain maximum d'un bulletin combine — la
 * plus grosse chose qu'on puisse deja gagner sur ce site.
 *
 *   premier prix   5 000 000   0,5 %
 *   deuxieme       3 000 000   0,3 %
 *   troisieme      1 000 000   0,1 %
 *   ------------------------------------
 *   total          9 000 000   0,9 % de la supply
 */
const PRIX_LIGNE = [5000000, 3000000, 1000000];

// ------------------------------------------------------------ les recherches

const FAMILLE = new Map(FAMILLES.map((f) => [f.cle, f]));
const RARETE = new Map(RARETES.map((r) => [r.cle, r]));
const COFFRE = new Map(COFFRES.map((c) => [c.cle, c]));

/* ---- LA SAISON D'UN OBJET SE DEDUIT DE SA FAMILLE ----
 *
 * Elle n'est ecrite nulle part sur les trente lignes d'objets, et c'est
 * volontaire : une famille appartient a une seule saison, donc l'objet aussi.
 * Portee deux fois, l'information finirait par diverger — un objet marque
 * saison 1 dans une famille de saison 2 se tirerait dans le mauvais coffre, et
 * rien a l'ecran ne le dirait. Ici la question ne peut pas se poser. */
/*
 * ====================== LES TROUVAILLES ======================
 *
 * Quarante pieces qui ne passent JAMAIS par la boutique. Aucun coffre ne les
 * contient, aucune ligne du catalogue ne les propose, et il n'existe aucun
 * moyen de les payer : elles tombent, ou elles n'existent pas pour vous.
 *
 * ---- pourquoi une serie separee et pas des raretes en plus ----
 *
 * A puissance egale, la question « pourquoi chasser plutot qu'acheter ? » a
 * une reponse simple : parce qu'on n'a pas de $SWOGE. Une piece trouvee vaut
 * exactement ce que vaut une piece achetee de la meme rarete — le monde est
 * l'autre chemin vers le meme equipement, pas un raccourci vers un meilleur.
 * Un joueur qui ne depose jamais rien peut donc s'equiper entierement, et
 * c'est le contraire d'un detail : c'est ce qui fait qu'il y a un jeu.
 *
 * La RELIQUE est la seule exception, et elle va dans l'autre sens : elle est
 * au-dessus de tout ce que la boutique vend, et on ne peut que la trouver.
 *
 * ---- l'anneau decide de la rarete ----
 *
 *   terre commun, marais rare, neige epique, cendres legendaire, lave
 *   mythique, et la relique au coeur.
 *
 * C'est la meme pente que le sol sous les pieds : on lit ce qu'on peut gagner
 * a la couleur du terrain, sans une ligne d'interface.
 *
 * `drop: true` est ce qui les tient hors du commerce. Il est porte par
 * l'objet et pas par une liste a cote : une liste s'oublie, un champ non.
 */
const ITEMS_DROP = [
  // ---- l'anneau de terre : commun ----
  { id: 6101, cle: 'arme_vagabond',      nom: "Wanderer's Blade", rarete: 'commun', famille: 'lame' },
  { id: 6102, cle: 'fruit_germe',        nom: 'Seedling Fruit',   rarete: 'commun', famille: 'garde',
    pouvoir: 'It has not decided what it wants to be yet.' },
  { id: 6103, cle: 'plastron_cuir',      nom: "Traveller's Leathers", rarete: 'commun', famille: 'plastron' },
  { id: 6104, cle: 'ring_cuivre_terni',  nom: 'Tarnished Copper Band', rarete: 'commun', famille: 'topaze' },
  { id: 6105, cle: 'arme_ecaille',       nom: 'Chipped Shortsword', rarete: 'commun', famille: 'lame' },
  { id: 6106, cle: 'plastron_rapiece',   nom: 'Patched Jerkin',   rarete: 'commun', famille: 'plastron' },
  { id: 6107, cle: 'ring_mat',           nom: 'Dull Band',        rarete: 'commun', famille: 'topaze' },
  { id: 6108, cle: 'fruit_pepin',        nom: 'Seed Charm',       rarete: 'commun', famille: 'garde',
    pouvoir: 'Small, dry, and stubbornly alive.' },

  // ---- le marais : rare ----
  { id: 6201, cle: 'arme_ronce',         nom: 'Bramble Spear',    rarete: 'rare', famille: 'lance' },
  { id: 6202, cle: 'fruit_bourbe',       nom: 'Mire Fruit',       rarete: 'rare', famille: 'chance',
    pouvoir: 'Whatever was going to bite you bit something else.' },
  { id: 6203, cle: 'plastron_mousse',    nom: 'Mosscloak Mail',   rarete: 'rare', famille: 'plastron' },
  { id: 6204, cle: 'ring_vase',          nom: 'Silt Ring',        rarete: 'rare', famille: 'emeraude' },
  { id: 6205, cle: 'arme_os_courbe',     nom: 'Bone Kris',        rarete: 'rare', famille: 'dagues' },
  { id: 6206, cle: 'plastron_lichen',    nom: 'Lichen Cuirass',   rarete: 'rare', famille: 'plastron' },
  { id: 6207, cle: 'ring_tourbe',        nom: 'Peat Ring',        rarete: 'rare', famille: 'emeraude' },
  { id: 6208, cle: 'fruit_marecage',     nom: 'Bog Fruit',        rarete: 'rare', famille: 'chance',
    pouvoir: 'It drips. You have stopped asking what.' },

  // ---- la neige : epique ----
  { id: 6301, cle: 'arme_givre',         nom: 'Frostbite Blade',  rarete: 'epique', famille: 'lame' },
  { id: 6302, cle: 'fruit_gel',          nom: 'Rime Fruit',       rarete: 'epique', famille: 'oeil',
    pouvoir: 'Cold enough to make you notice things.' },
  { id: 6303, cle: 'plastron_bourrasque', nom: 'Snowdrift Plate', rarete: 'epique', famille: 'plastron' },
  { id: 6304, cle: 'ring_flocon',        nom: 'Snowflake Ring',   rarete: 'epique', famille: 'saphir' },
  { id: 6305, cle: 'arme_stalactite',    nom: 'Glacier Longsword', rarete: 'epique', famille: 'lame' },
  { id: 6306, cle: 'plastron_fourrure',  nom: 'Furlined Plate',   rarete: 'epique', famille: 'plastron' },
  { id: 6307, cle: 'ring_grele',         nom: 'Hail Ring',        rarete: 'epique', famille: 'saphir' },
  { id: 6308, cle: 'fruit_cristal',      nom: 'Crystal Fruit',    rarete: 'epique', famille: 'oeil',
    pouvoir: 'You see one second further than you did.' },

  // ---- les cendres : legendaire ----
  { id: 6401, cle: 'arme_suie',          nom: 'Sootfang Blade',   rarete: 'legendaire', famille: 'lame' },
  { id: 6402, cle: 'fruit_cendre',       nom: 'Ashen Fruit',      rarete: 'legendaire', famille: 'chaos',
    pouvoir: 'Something burned to make this. It remembers.' },
  { id: 6403, cle: 'plastron_scorie',    nom: 'Slag Plate',       rarete: 'legendaire', famille: 'plastron' },
  { id: 6404, cle: 'ring_charbon',       nom: 'Cinder Ring',      rarete: 'legendaire', famille: 'onyx' },
  { id: 6405, cle: 'arme_hache_noire',   nom: 'Blackened Greataxe', rarete: 'legendaire', famille: 'hache' },
  { id: 6406, cle: 'plastron_obsidienne', nom: 'Obsidian Breastplate', rarete: 'legendaire', famille: 'plastron' },
  { id: 6407, cle: 'ring_tison',         nom: 'Smoulder Ring',    rarete: 'legendaire', famille: 'onyx' },
  { id: 6408, cle: 'fruit_charbon',      nom: 'Charred Fruit',    rarete: 'legendaire', famille: 'eclair',
    pouvoir: 'It cracks when you move fast. So do you.' },

  // ---- la lave : mythique ----
  { id: 6501, cle: 'arme_coulee',        nom: 'Molten Edge',      rarete: 'mythique', famille: 'lame' },
  { id: 6502, cle: 'fruit_magma',        nom: 'Magma Fruit',      rarete: 'mythique', famille: 'or',
    pouvoir: 'It beats. You would rather it did not.' },
  { id: 6503, cle: 'plastron_fournaise', nom: 'Furnace Plate',    rarete: 'mythique', famille: 'plastron' },
  { id: 6504, cle: 'ring_fonte',         nom: 'Moltencore Ring',  rarete: 'mythique', famille: 'grenat' },

  // ---- le coeur : la relique, dans le sac blanc a ruban rouge ----
  { id: 6601, cle: 'arme_aurore',        nom: 'Crimson Dawn',     rarete: 'relique', famille: 'lame' },
  { id: 6602, cle: 'plastron_serment',   nom: 'Oathplate',        rarete: 'relique', famille: 'plastron' },
  { id: 6603, cle: 'ring_etoile_rouge',  nom: 'The Red Star',     rarete: 'relique', famille: 'grenat' },
  { id: 6604, cle: 'fruit_coeur',        nom: 'Relic Heart',      rarete: 'relique', famille: 'chaos',
    pouvoir: 'Older than the shop. Older than the coin.' },
];
/*
 * ==================== LES HUIT PIECES DE LA FORGE ====================
 *
 * Ce qu'on ne trouve QUE derriere le portail d'Optimus. Huit dessins, huit
 * pieces, et aucun autre moyen de les obtenir : ni au coffre, ni au marche,
 * ni sur une creature du monde ouvert.
 *
 * ---- POURQUOI ELLES SONT TOUTES DES RELIQUES ----
 *
 * C'est la declaration de design du donjon, et elle tient en une phrase : il
 * ne rend pas les objets plus FORTS, il rend le rang le plus haut
 * ATTEIGNABLE. Une relique se tire aujourd'hui a un sur mille cinq cents dans
 * la lave — autant dire qu'on ne la vise pas, on la subit. Le donjon en fait
 * une expedition : on abat Optimus, on entre, on traverse trois salles, et le
 * fond en rend une a coup sur.
 *
 * Leur donner un rang a elles — plus fort que relique — aurait demande une
 * huitieme colonne dans les deux tables de puissance de personnages.js, un
 * huitieme sac, une huitieme couleur, et surtout aurait mis hors course tout
 * ce que quelqu'un possede aujourd'hui. Le donjon aurait remplace le jeu au
 * lieu de s'y ajouter.
 *
 * Le plafond, lui, ne bouge pas : quatre exemplaires par dessin, comme partout
 * ailleurs. Un donjon qui rendrait la relique atteignable ET illimitee n'aurait
 * pas ouvert un chemin, il aurait supprime le rang.
 *
 * ---- LA FAMILLE EST CE QU'ON VOIT, PAS CE QUE LE FICHIER S'APPELLE ----
 *
 * Les huit dessins sont noirs et bleus, tous : le bleu est la couleur du
 * donjon et ne distingue donc RIEN. C'est la silhouette qui decide, et le
 * metal sous le bleu. Le disque n'est pas un bouclier parce qu'il est rond —
 * c'est un jeu de lames qui se lance, donc `dagues` ; l'anneau n'est pas une
 * bague a saphir parce qu'il gresille de bleu — sa masse est noire et son
 * centre est un trou, donc `onyx`.
 *
 * Aucune n'est un fruit, donc aucune ne porte de phrase `pouvoir` : elle
 * n'aurait rien a dire qu'un fruit dit, et une phrase mise pour faire nombre
 * est exactement ce qui rend les autres moins credibles.
 *
 * Les identifiants prennent la serie 6700, laissee libre par les anneaux :
 * 6100 la terre, 6200 le marais, 6300 la neige, 6400 les cendres, 6500 la
 * lave, 6600 le coeur. Un bloc par lieu, et le donjon est un lieu.
 *
 * `cle` EST le nom du fichier. La page construit l'adresse de l'image avec —
 * `img/shop/<cle>.webp` — et une cle qui ne correspond a rien s'affiche comme
 * un carre vide, sans une erreur nulle part.
 */
const ITEMS_DONJON = [
  { id: 6701, cle: 'dj_lance',    nom: 'Arclance',        rarete: 'relique', famille: 'lance' },
  { id: 6702, cle: 'dj_disque',   nom: 'Ripsaw',          rarete: 'relique', famille: 'dagues' },
  { id: 6703, cle: 'dj_heaume',   nom: 'Forgehelm',       rarete: 'relique', famille: 'casque' },
  { id: 6704, cle: 'dj_couronne', nom: "Foreman's Crown", rarete: 'relique', famille: 'casque' },
  { id: 6705, cle: 'dj_plastron', nom: 'Coreplate',       rarete: 'relique', famille: 'plastron' },
  { id: 6706, cle: 'dj_gantelet', nom: 'Pistongrip',      rarete: 'relique', famille: 'gantelets' },
  { id: 6707, cle: 'dj_bouclier', nom: 'Bulkhead',        rarete: 'relique', famille: 'bouclier' },
  { id: 6708, cle: 'dj_anneau',   nom: 'Dead Circuit',    rarete: 'relique', famille: 'onyx' },
];

/*
 * ---- LE SANCTUAIRE DE CENDRE ----
 *
 * Trois pieces, et elles ne tombent QUE la. C'est la difference avec les huit
 * de la Forge, qui partagent un lot commun a tous les donjons : on peut
 * ramasser un Coreplate dans la cave des pirates, et c'est tres bien — ce
 * sont des reliques de donjon, sans plus de precision.
 *
 * Celles-ci sont l'Idole. Elle porte trente-huit mille points de vie, cinq
 * phases et deux especes d'invocations ; laisser son anneau tomber chez les
 * pirates aurait retire au combat la seule chose qu'il donne et que rien
 * d'autre ne donne. `donjonCle` le dit, et `tireButinDonjon` le respecte.
 *
 * ---- TROIS FAMILLES, DONC TROIS PASSIFS DIFFERENTS ----
 *
 * C'est ce qui en fait un lot plutot que trois exemplaires. La famille decide
 * du passif (voir PASSIF_PAR_STAT) : on choisit donc la famille pour ce que
 * la piece DOIT faire, et le dessin suit — l'anneau a des griffes qui
 * serrent, le gantelet a une grille de fournaise, le masque saigne.
 *
 *   onyx       -> def -> Thornmail  celui qui frappe se blesse
 *   gantelets  -> att -> Kindling   tes coups enflamment
 *   epaulieres -> vit -> Sanguine   une part de ce que tu infliges revient
 *
 * Offensive, defense, soutien : les trois ensemble couvrent un personnage, et
 * chacune seule vaut d'etre portee.
 *
 * Serie 6800, laissee libre : 6600 le coeur, 6700 la Forge, et le Sanctuaire
 * est un lieu de plus.
 */
const ITEMS_SANCTUAIRE = [
  { id: 6801, cle: 'sanc_anneau',    nom: 'Emberbind',    rarete: 'relique', famille: 'onyx' },
  { id: 6802, cle: 'sanc_gantelet',  nom: 'Forgehand',    rarete: 'relique', famille: 'gantelets' },
  { id: 6803, cle: 'sanc_masque',    nom: 'Cast Visage',  rarete: 'relique', famille: 'epaulieres' },
  /* ---- CINQ DE PLUS, POUR QUE LE LOT TIENNE DEBOUT SEUL ----
   * Il en comptait trois, et il empruntait les huit de la Forge pour faire
   * nombre. Maintenant qu'il ne les emprunte plus (voir la garde plus bas),
   * trois pieces feraient un donjon ou l'on retrouve la meme relique une fois
   * sur trois. Huit, comme la Forge : c'est le nombre a partir duquel un
   * deuxieme passage ne rend pas la meme chose. */
  { id: 6804, cle: 'sanc_lame',      nom: 'Cinderfang',   rarete: 'relique', famille: 'lame' },
  { id: 6805, cle: 'sanc_plastron',  nom: 'Slagplate',    rarete: 'relique', famille: 'plastron' },
  { id: 6806, cle: 'sanc_casque',    nom: 'Ashen Crown',  rarete: 'relique', famille: 'casque' },
  { id: 6807, cle: 'sanc_bouclier',  nom: 'Emberwall',    rarete: 'relique', famille: 'bouclier' },
  { id: 6808, cle: 'sanc_dagues',    nom: 'Twin Cinders', rarete: 'relique', famille: 'dagues' },
];
for (const o of ITEMS_SANCTUAIRE) {
  o.donjon = true;
  o.donjonCle = 'sanctuaire';
  ITEMS_DROP.push(o);
}

/* ======================================================================
 * LE LOT DE L'ARENE — LA MANCHE 1
 * ======================================================================
 *
 * QUATRE pieces, et non huit comme la Forge et le Sanctuaire. Ce n'est pas
 * une economie : c'est la premiere manche d'une serie. Huit maintenant, et il
 * ne resterait rien a donner a la deuxieme sans repeter une famille.
 *
 * Elles sont des RELIQUES, comme les deux autres lots. Le rang ne monte pas
 * parce qu'il n'y a rien au-dessus et qu'inventer un septieme rang pour une
 * premiere manche depenserait toute la marge d'un coup — et parce qu'une
 * septieme rarete fait JETER ce module au chargement tant qu'elle n'est pas
 * exclue des quatre copies du filtre des raretes vendues. Ce qui separe ce lot
 * du Sanctuaire est donc la PIECE, pas le rang : quatre familles qu'il ne
 * donne pas sous cette forme.
 *
 * L'ARME EST DES DAGUES, et c'est le seul endroit ou la manche 1 est vraiment
 * plus forte : a degats egaux, la famille decide du debit. Les dagues tirent
 * deux fois a cadence 4,0 — le meilleur rapport du catalogue. Twin Cinders le
 * fait deja ; Stormfang le fait aussi, et c'est voulu : deux chemins vers la
 * meme arme de tete valent mieux qu'un seul donjon qui la detient.
 */
const ITEMS_ARENA = [
  /* ---- LA SEULE ARME DU JEU QUI ECRIT SES PROPRES DEGATS ----
   * 200-258 la ou la rarete en donne 155-200 : un cran de plus sur le meme
   * escalier, celui qui monte d'un tiers a chaque rang. Ce n'est pas une
   * faveur, c'est le prix affiche du combat — le champion a 700 000 points de
   * vie contre les 380 000 de l'Idole, cinq phases contre trois, et trois
   * vagues d'invoques. Sans ce cran, l'arme du combat le plus dur du jeu
   * frappait exactement comme celle du precedent, et le detour ne valait
   * rien. Voir `degatsDeObjet` pour pourquoi c'est un champ et pas une
   * sixieme rarete, et la garde plus bas pour ce qu'il n'a pas le droit de
   * faire. */
  { id: 6901, cle: 'arn_dagues',   nom: 'Stormfang',   rarete: 'relique', famille: 'dagues',
    degats: [200, 258] },
  { id: 6902, cle: 'arn_casque',   nom: 'Stormcrown',  rarete: 'relique', famille: 'casque' },
  { id: 6903, cle: 'arn_plastron', nom: 'Riftplate',   rarete: 'relique', famille: 'plastron' },
  { id: 6904, cle: 'arn_anneau',   nom: 'Thunderbind', rarete: 'relique', famille: 'onyx' },
];
for (const o of ITEMS_ARENA) {
  o.donjon = true;
  /* Sans `donjonCle`, la garde de chargement REFUSE la piece : elle tomberait
     dans TOUS les donjons. C'est ecrit ici et pas ailleurs pour la meme raison
     que pour les deux autres lots — le marquage vit a cote de la liste. */
  o.donjonCle = 'arena';
  ITEMS_DROP.push(o);
}

/* Un seul lot pour tout ce qui se TROUVE : `item(id)`, l'equipement, la fiche
   au sol, le registre des exemplaires et le rachat ne doivent pas avoir a
   savoir d'ou une piece vient. Ce qui separe les deux provenances est un CHAMP
   sur l'objet, pas une liste que quelqu'un devrait penser a consulter — meme
   raison que `drop`.

   Les deux marquages sont cote a cote pour qu'on lise d'un coup ce qu'une
   piece de la Forge est : une trouvaille (donc hors commerce) ET du donjon
   (donc hors du monde ouvert). L'oubli du second les ferait tomber sur des
   limes, et le donjon n'aurait plus servi a rien. */
/* ---- UN OBJET DE DONJON NOMME LES DONJONS OU IL TOMBE ----
 *
 * Les huit de la Forge n'avaient AUCUNE cle, et le tirage lisait cette absence
 * comme « partout ». C'etait voulu au depart — la cave des pirates n'a aucune
 * piece a elle et vivait de ce lot commun — mais le jour ou le Sanctuaire est
 * arrive avec ses propres reliques, il a herite des huit autres par-dessus.
 * Le joueur l'a vu : il ramassait de l'equipement d'Optimus dans un sanctuaire
 * de feu.
 *
 * La cle accepte donc PLUSIEURS donjons. Le lot commun existe toujours — il
 * est simplement ECRIT au lieu d'etre deduit d'un champ manquant.
 */
for (const o of ITEMS_DONJON) { o.donjon = true; o.donjonCle = ['forge', 'cave']; ITEMS_DROP.push(o); }

/** Ce donjon-la fait-il tomber cette piece ? Une seule reponse, ici, pour que
    le tirage n'ait pas a connaitre la forme du champ. */
function tombeDans(o, cle) {
  if (!o.donjonCle) return false;
  return Array.isArray(o.donjonCle) ? o.donjonCle.indexOf(cle) >= 0 : o.donjonCle === cle;
}

/* ---- ET PLUS JAMAIS DE CLE MANQUANTE ----
 * C'est la garde qui remplace l'ancien defaut. Sans elle, ajouter une piece de
 * donjon en oubliant sa cle la ferait retomber « partout » — c'est-a-dire
 * exactement le bogue qu'on vient de corriger, revenu en silence. Elle refuse
 * au CHARGEMENT : le serveur ne demarre pas plutot que de mal distribuer. */
for (const o of ITEMS_DROP) {
  if (!o.donjon) continue;
  const l = Array.isArray(o.donjonCle) ? o.donjonCle : (o.donjonCle ? [o.donjonCle] : []);
  if (!l.length) {
    throw new Error('boutique : « ' + o.cle + ' » est marque donjon sans donjonCle — '
                    + 'il tomberait dans TOUS les donjons');
  }
}
for (const o of ITEMS_DROP) o.drop = true;

/* ---- ET UNE ARME QUI ECRIT SES DEGATS NE PEUT PAS S'ECRIRE PLUS FAIBLE ----
 *
 * Le champ `degats` court-circuite le bareme de la rarete (`degatsDeObjet`).
 * Deux facons de s'en servir mal, et le chargement refuse les deux :
 *
 *   - LE POSER SUR UNE PIECE DE BOUTIQUE. Une arme qui s'achete doit valoir
 *     ce que sa rarete annonce, sinon le prix ne veut plus rien dire. Seul ce
 *     qui se GAGNE au fond d'un donjon a le droit de sortir du bareme.
 *   - LE POSER SOUS LE BAREME. Une faute de frappe qui rendrait une relique
 *     plus faible qu'une relique ordinaire ne se verrait jamais : on
 *     l'attribuerait a la malchance pendant des semaines. Se tromper vers le
 *     bas doit donc etre IMPOSSIBLE, pas seulement improbable — c'est la meme
 *     regle que `sourceDe`, prise par l'autre bout.
 *
 * Le serveur ne demarre pas plutot que de distribuer une arme dont la fiche
 * ment. */
for (const o of ITEMS.concat(ITEMS_DROP)) {
  if (o.degats === undefined) continue;
  if (!Array.isArray(o.degats) || o.degats.length !== 2
      || !(o.degats[0] > 0) || !(o.degats[1] >= o.degats[0])) {
    throw new Error('boutique : « ' + o.cle + ' » porte un `degats` mal forme — '
                    + 'il faut [min, max], deux nombres croissants');
  }
  if (!o.donjon) {
    throw new Error('boutique : « ' + o.cle + ' » ecrit ses degats sans etre '
                    + 'une piece de donjon — seul ce qui se gagne sort du bareme');
  }
  const bareme = personnages.DEGATS.butin[o.rarete];
  if (bareme && (o.degats[0] < bareme[0] || o.degats[1] < bareme[1])) {
    throw new Error('boutique : « ' + o.cle + ' » s\'ecrit PLUS FAIBLE que sa '
                    + 'rarete (' + o.degats + ' contre ' + bareme + ') — '
                    + 'une arme ne se nerfe pas en silence');
  }
}

for (const o of ITEMS.concat(ITEMS_DROP)) {
  const f = FAMILLE.get(o.famille);
  if (!f) throw new Error('boutique : famille inconnue pour ' + o.id + ', ' + o.famille);
  o.saison = f.saison;
}


/* `item(id)` doit les trouver — un objet qu'on porte, qu'on range au coffre ou
   qu'on perd en mourant passe par la. C'est la SEULE table ou les deux series
   se rejoignent : le tirage des coffres, lui, ne connait que ITEMS. */
const PAR_ID = new Map(ITEMS.concat(ITEMS_DROP).map((o) => [o.id, o]));
/* Indexe par SAISON ET rarete. La clef composee evite le piege qui aurait
   coute le plus cher : `itemsDe('mythique')` rendant les douze mythiques des
   deux saisons, donc un coffre a fruits capable de rendre une arme. */
const PAR_RARETE = new Map();
for (const s of SAISONS)
  for (const r of RARETES)
    PAR_RARETE.set(s.n + ':' + r.cle,
      ITEMS.filter((o) => o.saison === s.n && o.rarete === r.cle));
const SAISON = new Map(SAISONS.map((s) => [s.n, s]));

function item(id) { return PAR_ID.get(Number(id)) || null; }
function coffre(cle) { return COFFRE.get(String(cle)) || null; }
/** Les objets d'une rarete DANS UNE SAISON. La saison n'a pas de defaut :
 *  l'oubli doit rendre une liste vide et casser le test, pas retomber en
 *  silence sur la saison 1. */
function itemsDe(rarete, saison) { return PAR_RARETE.get(Number(saison) + ':' + String(rarete)) || []; }
function rarete(cle) { return RARETE.get(String(cle)) || null; }
function famille(cle) { return FAMILLE.get(String(cle)) || null; }
function saison(n) { return SAISON.get(Number(n)) || null; }
/* TOUT ce qui existe dans cette saison, trouvailles comprises : c'est de
   cette liste que sort ce qu'un joueur peut EQUIPER, et une piece trouvee
   qu'on ne pourrait pas porter n'aurait aucun sens. Ce qui tient les
   trouvailles hors du commerce, c'est le filtre du catalogue, pas celui-ci. */
function itemsDeSaison(n) { return ITEMS.concat(ITEMS_DROP).filter((o) => o.saison === Number(n)); }
function famillesDe(n) { return FAMILLES.filter((f) => f.saison === Number(n)); }
/* ---- COMBIEN DE PIECES FONT UNE FAMILLE COMPLETE ----
 *
 * On comptait `RARETES.length`. C'etait juste tant que toute rarete existait
 * dans toute famille — l'ajout de la relique l'a rendu faux : elle n'existe
 * que dans quatre familles, et une quete « complete une famille » est
 * devenue impossible partout ailleurs, sans qu'aucun message ne le dise.
 *
 * On compte donc les pieces de la famille elle-meme. La reponse ne peut plus
 * se desynchroniser du catalogue, quoi qu'on y ajoute — et les trouvailles
 * n'entrent pas dans le compte, parce qu'une collection est une collection
 * de ce qui se COLLECTIONNE : ce qu'on achete, pas ce qu'on trouve. */
function rangsDeFamille(cle) {
  return ITEMS.filter((o) => o.famille === String(cle)).length;
}
function coffresDe(n) { return COFFRES.filter((c) => c.saison === Number(n)); }

// -------------------------------------------------------------- le controle

/*
 * Ce que le chargement refuse. Chacune de ces trois erreurs est INVISIBLE a
 * l'usage — le serveur tourne, les coffres s'ouvrent, et les chances ne sont
 * pas celles qu'on affiche. C'est la definition d'un defaut qu'il faut
 * attraper au demarrage.
 */
(function verifie() {
  const vu = new Set();
  for (const o of ITEMS) {
    if (vu.has(o.id)) throw new Error('boutique : identifiant en double, ' + o.id);
    vu.add(o.id);
    const r = RARETE.get(o.rarete);
    if (!r) throw new Error('boutique : rarete inconnue pour ' + o.id + ', ' + o.rarete);
    /* L'identifiant doit tomber dans le bloc de sa rarete. Ce n'est pas de la
       coquetterie : les blocs sont ce qui permettra d'ajouter des objets sans
       renumeroter, et un identifiant hors bloc casse la promesse en silence. */
    if (o.id < r.bloc || o.id >= r.bloc + 1000)
      throw new Error('boutique : ' + o.id + ' est hors du bloc ' + r.bloc + ' de ' + o.rarete);
    if (!FAMILLE.has(o.famille))
      throw new Error('boutique : famille inconnue pour ' + o.id + ', ' + o.famille);
  }
  /* ---- LA GRILLE DU COMMERCE, ET SEULEMENT ELLE ----
     La relique n'en fait pas partie : aucun coffre ne peut la rendre, et
     exiger une piece relique pour chacune des vingt-quatre familles
     reclamerait vingt-quatre objets qu'on ne pourrait jamais obtenir. C'est
     la grille de CE QUI SE VEND qu'on verifie ici, pas la liste de ce qui
     existe. */
  const RARETES_VENDUES = RARETES.filter((r) => r.cle !== 'relique');
  /* LA GRILLE DOIT ETRE PLEINE, SAISON PAR SAISON. Six familles, cinq
     raretes : trente cases, chacune occupee une fois exactement. C'est toute
     la promesse faite au joueur — « il te manque la Clef d'or » n'a de sens
     que si elle existe. Un trou ne se verrait nulle part ailleurs : la case
     resterait vide a l'ecran et ressemblerait a un objet qu'on n'a pas encore
     trouve.

     Le controle est par SAISON depuis qu'il y en a deux. Fait sur l'ensemble,
     il aurait laisse passer une saison a sept familles et une autre a cinq :
     les totaux se compensent, la planche est fausse, et personne ne le voit
     avant qu'un joueur cherche une case qui n'existe pas. */
  for (const s of SAISONS) {
    const fams = famillesDe(s.n);
    if (fams.length !== 6)
      throw new Error('boutique : saison ' + s.n + ' a ' + fams.length + ' familles, pas six');
    for (const f of fams) {
      for (const r of RARETES_VENDUES) {
        const n = ITEMS.filter((o) => o.famille === f.cle && o.rarete === r.cle).length;
        if (n !== 1)
          throw new Error('boutique : ' + f.nom + ' en ' + r.nom + ' apparait ' + n + ' fois, pas une');
      }
    }
    if (!coffresDe(s.n).length)
      throw new Error('boutique : saison ' + s.n + ' n a aucun coffre, ses objets sont introuvables');
  }
  /* Une clef de famille appartient a UNE saison. Deux saisons qui partagent
     « chaos » melangeraient leurs lignes completes : terminer les cinq fruits
     Chaos et les cinq armes Chaos compterait pour une seule et meme ligne. */
  const vuesFam = new Set();
  for (const f of FAMILLES) {
    if (vuesFam.has(f.cle)) throw new Error('boutique : famille en double, ' + f.cle);
    vuesFam.add(f.cle);
    if (!SAISON.has(f.saison))
      throw new Error('boutique : saison inconnue pour la famille ' + f.cle + ', ' + f.saison);
  }
  for (const c of COFFRES) {
    if (!SAISON.has(c.saison))
      throw new Error('boutique : saison inconnue pour le coffre ' + c.cle + ', ' + c.saison);
    let somme = 0;
    for (const [cle, poids] of c.table) {
      if (!RARETE.has(cle)) throw new Error('boutique : coffre ' + c.cle + ', rarete inconnue ' + cle);
      if (!(poids > 0)) throw new Error('boutique : coffre ' + c.cle + ', poids nul pour ' + cle);
      /* DANS SA SAISON. Un coffre d'armes dont la table promet du mythique
         alors qu'aucune arme mythique n'existe rendrait un legendaire par la
         regle d'epuisement — en silence, et en faisant mentir le bouton. */
      if (!itemsDe(cle, c.saison).length)
        throw new Error('boutique : coffre ' + c.cle + ' peut sortir un ' + cle +
                        ', mais aucun objet de la saison ' + c.saison + ' ne l est');
      somme += poids;
    }
    if (somme !== TOTAL)
      throw new Error('boutique : la table du coffre ' + c.cle + ' somme a ' + somme + ', pas ' + TOTAL);
  }
})();

// --------------------------------------------------------------- le tirage

/** Combien il reste d'exemplaires d'un objet, vu un registre d'emis. */
function restant(id, emis) {
  const o = item(id);
  if (!o) return 0;
  return Math.max(0, rarete(o.rarete).plafond - ((emis && emis[id]) || 0));
}

/**
 * L'objet que rend un coffre, pour une empreinte donnee.
 *
 * @param hex   l'empreinte HMAC-SHA256, telle que `game.js` la fabrique avec
 *   la graine du serveur, celle du joueur et le compteur.
 * @param cle   la clef du coffre.
 * @param emis  { id: nombre deja sorti }. Facultatif : sans lui, rien n'est
 *   epuise et le tirage se comporte comme avant les plafonds.
 * @returns { item, rarete, r1, r2, epuise }
 *
 * ---- CE QUI SE PASSE QUAND UN FRUIT EST EPUISE ----
 *
 * La regle est ecrite ici, une seule fois, et elle est publiable telle quelle :
 *
 *   1. on retire dans la MEME rarete, parmi les fruits qui restent ;
 *   2. si toute la rarete est epuisee, on descend d'un cran, puis encore ;
 *   3. si tout est epuise, la collection est complete — `tire` jette plutot
 *      que de rendre quelque chose qui n'existe plus.
 *
 * Un coffre paye rend TOUJOURS un objet tant qu'il en reste un seul. Le cas
 * « rien » n'existe pas, et il ne doit pas exister : c'est le seul endroit ou
 * l'epuisement pourrait couter de l'argent a un joueur sans qu'il l'ait vu
 * venir.
 *
 * On DESCEND, jamais on ne monte. Un mythique epuise qui ferait pleuvoir des
 * legendaires sur les coffres de bois rendrait fausse, dans le mauvais sens,
 * la chance affichee sur le bouton — et c'est la maison qui paierait.
 */
function tire(hex, cle, emis) {
  const c = coffre(cle);
  if (!c) throw new Error('unknown chest');
  const h = String(hex);

  /* Bits 0..59 : la rarete. */
  const r1 = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(TOTAL));
  let reste = r1, quelle = c.table[c.table.length - 1][0];
  for (const [rar, poids] of c.table) { reste -= poids; if (reste < 0) { quelle = rar; break; } }

  /* On descend jusqu'a une rarete qui a encore du stock — DANS LA SAISON DU
     COFFRE, jamais ailleurs. Une caisse d'armes dont les mythiques sont
     epuisees descend sur les armes legendaires, pas sur les fruits : deux
     saisons qui se vident l'une dans l'autre n'en font plus qu'une, et
     l'edition annoncee pour chacune devient fausse. */
  const rangs = RARETES.map((r) => r.cle);
  const epuise = [];
  let i = rangs.indexOf(quelle);
  let lot = itemsDe(rangs[i], c.saison).filter((o) => restant(o.id, emis) > 0);
  while (!lot.length) {
    epuise.push(rangs[i]);
    if (--i < 0) throw new Error('the collection is fully minted');
    lot = itemsDe(rangs[i], c.saison).filter((o) => restant(o.id, emis) > 0);
  }

  /* Bits 60..119 : l'objet, uniformement parmi CEUX QUI RESTENT. Une tranche
     DIFFERENTE de la meme empreinte : reutiliser la premiere lierait l'objet
     a la rarete, et l'objet en tete de liste sortirait bien plus souvent. */
  const r2 = Number(BigInt('0x' + h.slice(15, 30)) % BigInt(lot.length));

  return { item: lot[r2], rarete: rangs[i], r1, r2,
           epuise: epuise.length ? epuise : undefined };
}

/**
 * LE PRIX DE RACHAT d'un objet, par rarete.
 *
 * poids = 1000 / plafond — le meme bareme que le classement des
 * collectionneurs. Le commun vaut 1, le mythique vaut 100. Ecrire cinq
 * nombres a la main les rendrait faux au premier changement de plafond, et
 * faux EN SILENCE : le rachat continuerait de payer l'ancienne echelle.
 */
function prixRachat(rar, base) {
  const r = rarete(rar);
  if (!r || !r.plafond) return 0;
  const b = Number(base) || 0;
  return Math.round(b * 1000 / r.plafond / 10) * 10;
}

/** La table d'un coffre, prete a afficher : rarete, chance en %, exemples. */
function chances(cle) {
  const c = coffre(cle);
  if (!c) return null;
  return c.table.map(([rar, poids]) => ({
    rarete: rar, nom: rarete(rar).nom, couleur: rarete(rar).couleur,
    poids, pourcent: (poids * 100) / TOTAL, objets: itemsDe(rar, c.saison).length,
  }));
}

/**
 * Le catalogue D'UNE SAISON, pour la page.
 *
 * La page n'en recoit jamais deux a la fois : la planche, le classement et les
 * coffres parlent tous de la saison qu'on regarde. Envoyer les soixante objets
 * et laisser la page trier aurait donne deux endroits qui decident de la meme
 * chose — et le jour ou ils ne sont plus d'accord, c'est l'affichage qui ment.
 */
function catalogue(emis, n, cfgRachatBase) {
  const s = saison(n) || SAISONS[0];
  return {
    saison: s.n, saisonNom: s.nom, sujet: s.sujet,
    /* La relique n'apparait pas dans le catalogue : aucun coffre ne peut la
       rendre, et annoncer une rarete qu'aucune ligne ne propose donnerait une
       colonne vide que le joueur passerait sa vie a chercher. */
    raretes: RARETES.filter((r) => r.cle !== 'relique')
                    .map((r) => ({ cle: r.cle, nom: r.nom, couleur: r.couleur,
                                   plafond: r.plafond })),
    familles: famillesDe(s.n).map((f) => ({ cle: f.cle, nom: f.nom, couleur: f.couleur, genre: f.genre })),
    /* ---- LA BOUTIQUE NE VOIT PAS LES TROUVAILLES ----
       Elles n'ont ni prix, ni coffre, ni ligne. Les laisser passer ici les
       afficherait a vendre a un endroit ou rien ne peut les vendre. */
    items: itemsDeSaison(s.n).filter((o) => !o.drop).map((o) => ({ id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete,
                               famille: o.famille, pouvoir: o.pouvoir,
                               plafond: rarete(o.rarete).plafond,
                               /* Le prix de rachat vient d'ici : la page ne doit pas
                                  refaire un calcul dont le serveur est la source. */
                               rachat: prixRachat(o.rarete, cfgRachatBase),
                               emis: (emis && emis[o.id]) || 0 })),
    coffres: coffresDe(s.n).map((c) => ({ cle: c.cle, nom: c.nom, prix: c.prix,
                                          image: c.image || c.cle, chances: chances(c.cle) })),
  };
}

module.exports = {
  RARETES, FAMILLES, ITEMS, ITEMS_DROP, COFFRES, TOTAL, PRIX_LIGNE, SAISONS,
  item, coffre, itemsDe, rarete, famille, tire, restant, chances, catalogue,
  saison, itemsDeSaison, famillesDe, rangsDeFamille, coffresDe, prixRachat,
  tombeDans,
};
