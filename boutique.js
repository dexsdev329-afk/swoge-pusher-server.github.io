'use strict';
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

/* Les raretes, de la plus commune a la plus rare. L'ordre compte : il sert a
   trier l'inventaire et a peindre la page. */
const RARETES = [
  { cle: 'commun',     nom: 'Common',    bloc: 1000, couleur: '#9AA7BF', plafond: 1000 },
  { cle: 'rare',       nom: 'Rare',      bloc: 2000, couleur: '#5AC8FF', plafond:  400 },
  { cle: 'epique',     nom: 'Epic',      bloc: 3000, couleur: '#C07BFF', plafond:  150 },
  { cle: 'legendaire', nom: 'Legendary', bloc: 4000, couleur: '#FFC53D', plafond:   40 },
  { cle: 'mythique',   nom: 'Mythic',    bloc: 5000, couleur: '#FF4655', plafond:   10 },
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
  { cle: 'chance', nom: 'Luck',   forme: 'pomme',   couleur: '#7CFF9B', genre: 'cadre'   },
  { cle: 'or',     nom: 'Gold',   forme: 'poire',   couleur: '#FFC53D', genre: 'cadre'   },
  { cle: 'eclair', nom: 'Flash',  forme: 'banane',  couleur: '#5AC8FF', genre: 'table'   },
  { cle: 'oeil',   nom: 'Sight',  forme: 'raisin',  couleur: '#C07BFF', genre: 'avatar'  },
  { cle: 'garde',  nom: 'Guard',  forme: 'courge',  couleur: '#8DA0C4', genre: 'trophee' },
  { cle: 'chaos',  nom: 'Chaos',  forme: 'carambole', couleur: '#FF4655', genre: 'trophee' },
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
 * Etat actuel, coffre dore a 400 000 :
 *
 *   1 sur 10 avant     52 M
 *   la moitie avant   166 M
 *   9 sur 10 avant    461 M
 *   99 sur 100 avant  927 M
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
  { cle: 'bois', nom: 'Wooden Chest', prix: 40000,
    table: [['commun', 7600], ['rare', 2100], ['epique', 280], ['legendaire', 19], ['mythique', 1]] },
  { cle: 'or', nom: 'Golden Chest', prix: 400000,
    table: [['commun', 4500], ['rare', 3800], ['epique', 1400], ['legendaire', 280], ['mythique', 20]] },
  { cle: 'mythe', nom: 'Mythic Chest', prix: 4000000,
    table: [['commun', 1000], ['rare', 3400], ['epique', 3900], ['legendaire', 1500], ['mythique', 200]] },
];

// ------------------------------------------------------------ les recherches

const PAR_ID = new Map(ITEMS.map((o) => [o.id, o]));
const PAR_RARETE = new Map(RARETES.map((r) => [r.cle, ITEMS.filter((o) => o.rarete === r.cle)]));
const FAMILLE = new Map(FAMILLES.map((f) => [f.cle, f]));
const RARETE = new Map(RARETES.map((r) => [r.cle, r]));
const COFFRE = new Map(COFFRES.map((c) => [c.cle, c]));

function item(id) { return PAR_ID.get(Number(id)) || null; }
function coffre(cle) { return COFFRE.get(String(cle)) || null; }
function itemsDe(rarete) { return PAR_RARETE.get(String(rarete)) || []; }
function rarete(cle) { return RARETE.get(String(cle)) || null; }
function famille(cle) { return FAMILLE.get(String(cle)) || null; }

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
  /* LA GRILLE DOIT ETRE PLEINE. Six familles, cinq raretes : trente cases,
     chacune occupee une fois exactement. C'est toute la promesse faite au
     joueur — « il te manque la Clef d'or » n'a de sens que si elle existe.
     Un trou ne se verrait nulle part ailleurs : la case resterait vide a
     l'ecran et ressemblerait a un objet qu'on n'a pas encore trouve. */
  for (const f of FAMILLES) {
    for (const r of RARETES) {
      const n = ITEMS.filter((o) => o.famille === f.cle && o.rarete === r.cle).length;
      if (n !== 1)
        throw new Error('boutique : ' + f.nom + ' en ' + r.nom + ' apparait ' + n + ' fois, pas une');
    }
  }
  for (const c of COFFRES) {
    let somme = 0;
    for (const [cle, poids] of c.table) {
      if (!RARETE.has(cle)) throw new Error('boutique : coffre ' + c.cle + ', rarete inconnue ' + cle);
      if (!(poids > 0)) throw new Error('boutique : coffre ' + c.cle + ', poids nul pour ' + cle);
      if (!itemsDe(cle).length)
        throw new Error('boutique : coffre ' + c.cle + ' peut sortir un ' + cle + ', mais aucun objet ne l est');
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

  /* On descend jusqu'a une rarete qui a encore du stock. */
  const rangs = RARETES.map((r) => r.cle);
  const epuise = [];
  let i = rangs.indexOf(quelle);
  let lot = itemsDe(rangs[i]).filter((o) => restant(o.id, emis) > 0);
  while (!lot.length) {
    epuise.push(rangs[i]);
    if (--i < 0) throw new Error('the collection is fully minted');
    lot = itemsDe(rangs[i]).filter((o) => restant(o.id, emis) > 0);
  }

  /* Bits 60..119 : l'objet, uniformement parmi CEUX QUI RESTENT. Une tranche
     DIFFERENTE de la meme empreinte : reutiliser la premiere lierait l'objet
     a la rarete, et l'objet en tete de liste sortirait bien plus souvent. */
  const r2 = Number(BigInt('0x' + h.slice(15, 30)) % BigInt(lot.length));

  return { item: lot[r2], rarete: rangs[i], r1, r2,
           epuise: epuise.length ? epuise : undefined };
}

/** La table d'un coffre, prete a afficher : rarete, chance en %, exemples. */
function chances(cle) {
  const c = coffre(cle);
  if (!c) return null;
  return c.table.map(([rar, poids]) => ({
    rarete: rar, nom: rarete(rar).nom, couleur: rarete(rar).couleur,
    poids, pourcent: (poids * 100) / TOTAL, objets: itemsDe(rar).length,
  }));
}

/** Le catalogue entier, pour la page. */
function catalogue(emis) {
  return {
    raretes: RARETES.map((r) => ({ cle: r.cle, nom: r.nom, couleur: r.couleur,
                                   plafond: r.plafond })),
    familles: FAMILLES.map((f) => ({ cle: f.cle, nom: f.nom, couleur: f.couleur, genre: f.genre })),
    items: ITEMS.map((o) => ({ id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete,
                               famille: o.famille, pouvoir: o.pouvoir,
                               plafond: rarete(o.rarete).plafond,
                               emis: (emis && emis[o.id]) || 0 })),
    coffres: COFFRES.map((c) => ({ cle: c.cle, nom: c.nom, prix: c.prix, chances: chances(c.cle) })),
  };
}

module.exports = {
  RARETES, FAMILLES, ITEMS, COFFRES, TOTAL,
  item, coffre, itemsDe, rarete, famille, tire, restant, chances, catalogue,
};
