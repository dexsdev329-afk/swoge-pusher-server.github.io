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
  { cle: 'commun',     nom: 'Common',    bloc: 1000, couleur: '#9AA7BF' },
  { cle: 'rare',       nom: 'Rare',      bloc: 2000, couleur: '#5AC8FF' },
  { cle: 'epique',     nom: 'Epic',      bloc: 3000, couleur: '#C07BFF' },
  { cle: 'legendaire', nom: 'Legendary', bloc: 4000, couleur: '#FFC53D' },
  { cle: 'mythique',   nom: 'Mythic',    bloc: 5000, couleur: '#FF4655' },
];

/* Les objets. `cle` donne le nom du fichier image — `img/shop/<cle>.webp` —
   pour qu'ajouter un objet ne demande pas de toucher a la page.
   `genre` dit ce que l'objet fera plus tard : une bordure de photo, un
   habillage de table, un trophee de profil. Rien n'est branche pour l'instant
   et c'est voulu : l'objet existe, se gagne et se garde avant de servir. */
const ITEMS = [
  // ---- communs (1000) ----
  { id: 1001, cle: 'jeton_bois',      nom: 'Wooden Chip',        rarete: 'commun',     genre: 'cadre' },
  { id: 1002, cle: 'os_shiba',        nom: 'Shiba Bone',         rarete: 'commun',     genre: 'trophee' },
  { id: 1003, cle: 'des_pierre',      nom: 'Stone Dice',         rarete: 'commun',     genre: 'trophee' },
  { id: 1004, cle: 'collier_cuir',    nom: 'Leather Collar',     rarete: 'commun',     genre: 'avatar' },
  { id: 1005, cle: 'carte_cornee',    nom: 'Dog-eared Card',     rarete: 'commun',     genre: 'trophee' },
  { id: 1006, cle: 'torche_eteinte',  nom: 'Spent Torch',        rarete: 'commun',     genre: 'cadre' },
  { id: 1007, cle: 'gobelet_etain',   nom: 'Tin Cup',            rarete: 'commun',     genre: 'trophee' },
  { id: 1008, cle: 'tapis_use',       nom: 'Worn Felt',          rarete: 'commun',     genre: 'table' },
  { id: 1009, cle: 'patte_boue',      nom: 'Muddy Paw',          rarete: 'commun',     genre: 'avatar' },
  { id: 1010, cle: 'cle_rouillee',    nom: 'Rusted Key',         rarete: 'commun',     genre: 'trophee' },

  // ---- rares (2000) ----
  { id: 2001, cle: 'jeton_argent',    nom: 'Silver Chip',        rarete: 'rare',       genre: 'cadre' },
  { id: 2002, cle: 'medaille_lune',   nom: 'Moon Medal',         rarete: 'rare',       genre: 'trophee' },
  { id: 2003, cle: 'lunettes_shiba',  nom: 'Shiba Shades',       rarete: 'rare',       genre: 'avatar' },
  { id: 2004, cle: 'tapis_velours',   nom: 'Velvet Felt',        rarete: 'rare',       genre: 'table' },
  { id: 2005, cle: 'sablier_bleu',    nom: 'Azure Hourglass',    rarete: 'rare',       genre: 'trophee' },
  { id: 2006, cle: 'brasero',         nom: 'Temple Brazier',     rarete: 'rare',       genre: 'cadre' },
  { id: 2007, cle: 'gemme_violette',  nom: 'Violet Gem',         rarete: 'rare',       genre: 'trophee' },
  { id: 2008, cle: 'foulard_soie',    nom: 'Silk Scarf',         rarete: 'rare',       genre: 'avatar' },

  // ---- epiques (3000) ----
  { id: 3001, cle: 'jeton_or',        nom: 'Golden Chip',        rarete: 'epique',     genre: 'cadre' },
  { id: 3002, cle: 'couronne_shiba',  nom: 'Shiba Crown',        rarete: 'epique',     genre: 'avatar' },
  { id: 3003, cle: 'tapis_obsidienne',nom: 'Obsidian Felt',      rarete: 'epique',     genre: 'table' },
  { id: 3004, cle: 'grimoire',        nom: 'Odds Grimoire',      rarete: 'epique',     genre: 'trophee' },
  { id: 3005, cle: 'cadre_temple',    nom: 'Temple Frame',       rarete: 'epique',     genre: 'cadre' },
  { id: 3006, cle: 'orbe_crash',      nom: 'Crash Orb',          rarete: 'epique',     genre: 'trophee' },

  // ---- legendaires (4000) ----
  { id: 4001, cle: 'plaque_swoge',    nom: 'SWOGE Plate',        rarete: 'legendaire', genre: 'cadre' },
  { id: 4002, cle: 'trone_shiba',     nom: 'Shiba Throne',       rarete: 'legendaire', genre: 'table' },
  { id: 4003, cle: 'sceptre_volcan',  nom: 'Volcano Sceptre',    rarete: 'legendaire', genre: 'trophee' },
  { id: 4004, cle: 'masque_or',       nom: 'Gilded Mask',        rarete: 'legendaire', genre: 'avatar' },

  // ---- mythiques (5000) ----
  { id: 5001, cle: 'coeur_swoge',     nom: 'Heart of SWOGE',     rarete: 'mythique',   genre: 'cadre' },
  { id: 5002, cle: 'shiba_ascendant', nom: 'Ascendant Shiba',    rarete: 'mythique',   genre: 'avatar' },
];

/* Les coffres. Le prix est en $SWOGE, la table en dix-milliemes.
   Trois paliers, et le meme catalogue derriere les trois : le coffre cher ne
   donne pas acces a d'autres objets, il donne PLUS DE CHANCES pour les memes.
   C'est la seule forme honnete — un objet reserve au coffre a 2,5 millions
   serait invendable a qui n'a pas 2,5 millions, et il n'aurait aucune valeur
   pour les autres. */
const TOTAL = 10000;
const COFFRES = [
  { cle: 'bois', nom: 'Wooden Chest', prix: 25000,
    table: [['commun', 7600], ['rare', 2100], ['epique', 280], ['legendaire', 19], ['mythique', 1]] },
  { cle: 'or', nom: 'Golden Chest', prix: 250000,
    table: [['commun', 4500], ['rare', 3800], ['epique', 1400], ['legendaire', 280], ['mythique', 20]] },
  { cle: 'mythe', nom: 'Mythic Chest', prix: 2500000,
    table: [['commun', 1000], ['rare', 3400], ['epique', 3900], ['legendaire', 1500], ['mythique', 200]] },
];

// ------------------------------------------------------------ les recherches

const PAR_ID = new Map(ITEMS.map((o) => [o.id, o]));
const PAR_RARETE = new Map(RARETES.map((r) => [r.cle, ITEMS.filter((o) => o.rarete === r.cle)]));
const RARETE = new Map(RARETES.map((r) => [r.cle, r]));
const COFFRE = new Map(COFFRES.map((c) => [c.cle, c]));

function item(id) { return PAR_ID.get(Number(id)) || null; }
function coffre(cle) { return COFFRE.get(String(cle)) || null; }
function itemsDe(rarete) { return PAR_RARETE.get(String(rarete)) || []; }
function rarete(cle) { return RARETE.get(String(cle)) || null; }

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

/**
 * L'objet que rend un coffre, pour une empreinte donnee.
 *
 * @param hex  l'empreinte HMAC-SHA256 en hexadecimal, telle que `game.js` la
 *   fabrique avec la graine du serveur, celle du joueur et le compteur.
 * @param cle  la clef du coffre.
 * @returns { item, rarete, r1, r2 } — les deux tirages sont rendus pour que
 *   le joueur puisse refaire le calcul lui-meme une fois la graine revelee.
 */
function tire(hex, cle) {
  const c = coffre(cle);
  if (!c) throw new Error('unknown chest');
  const h = String(hex);

  /* Bits 0..59 : la rarete. */
  const r1 = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(TOTAL));
  let reste = r1, quelle = c.table[c.table.length - 1][0];
  for (const [rar, poids] of c.table) { reste -= poids; if (reste < 0) { quelle = rar; break; } }

  /* Bits 60..119 : l'objet, uniformement dans la rarete tiree. Une tranche
     DIFFERENTE de la meme empreinte : reutiliser la premiere lierait l'objet
     a la rarete, et l'objet en tete de liste sortirait bien plus souvent. */
  const lot = itemsDe(quelle);
  const r2 = Number(BigInt('0x' + h.slice(15, 30)) % BigInt(lot.length));

  return { item: lot[r2], rarete: quelle, r1, r2 };
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
function catalogue() {
  return {
    raretes: RARETES.map((r) => ({ cle: r.cle, nom: r.nom, couleur: r.couleur })),
    items: ITEMS.map((o) => ({ id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete, genre: o.genre })),
    coffres: COFFRES.map((c) => ({ cle: c.cle, nom: c.nom, prix: c.prix, chances: chances(c.cle) })),
  };
}

module.exports = {
  RARETES, ITEMS, COFFRES, TOTAL,
  item, coffre, itemsDe, rarete, tire, chances, catalogue,
};
