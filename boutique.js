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

/* Les six familles. `genre` dit ce que la famille servira plus tard — une
   bordure de photo, un avatar, un habillage de table, un trophee de profil.
   Il est porte par la FAMILLE et non par l'objet : les cinq etats d'une clef
   sont la meme clef, ils ne peuvent pas servir a des choses differentes.
   Rien n'est branche pour l'instant, et c'est voulu : l'objet existe, se
   gagne et se garde avant de servir.
   `cle`, sur l'objet, donne le nom du fichier image — `img/shop/<cle>.webp`. */
const FAMILLES = [
  { cle: 'jeton',  nom: 'The Chip',   genre: 'cadre'   },
  { cle: 'masque', nom: 'The Mask',   genre: 'avatar'  },
  { cle: 'carte',  nom: 'The Card',   genre: 'table'   },
  { cle: 'gemme',  nom: 'The Gem',    genre: 'cadre'   },
  { cle: 'cle',    nom: 'The Key',    genre: 'trophee' },
  { cle: 'coupe',  nom: 'The Cup',    genre: 'trophee' },
];

/*
 * Les objets, en GRILLE : six familles, cinq raretes chacune. Ce n'est pas un
 * rangement, c'est le sujet.
 *
 * Trente objets sans lien ne font pas une collection : on en gagne un, on le
 * regarde, et il ne manque rien. Le meme objet decline en cinq etats fait le
 * contraire — posseder la Clef de bronze fait exister, a cote, la Clef d'or
 * qu'on n'a pas. C'est la case vide qui donne envie d'ouvrir le coffre
 * suivant, pas celle qui est pleine.
 *
 * Six SILHOUETTES differentes, et c'est delibere : un disque, un visage, un
 * rectangle, une pierre taillee, une tige, une coupe. Dans une grille a
 * soixante-dix-huit pixels, la forme est tout ce qu'on lit — deux familles qui
 * se ressemblent de loin seraient deux familles qu'on confond.
 *
 * Les identifiants gardent leur bloc de rarete et suivent l'ordre des
 * familles : 1001 est le commun de la premiere famille, 4003 le legendaire de
 * la troisieme. Un identifiant se lit donc sans table.
 */
const ITEMS = [
  // ---- communs (1000) : matiere brute, pas d'or, pas de lumiere
  { id: 1001, cle: 'jeton_argile',    nom: 'Clay Chip',        rarete: 'commun',     famille: 'jeton' },
  { id: 1002, cle: 'masque_paille',   nom: 'Straw Mask',       rarete: 'commun',     famille: 'masque' },
  { id: 1003, cle: 'carte_cornee',    nom: 'Dog-eared Card',   rarete: 'commun',     famille: 'carte' },
  { id: 1004, cle: 'eclat_brut',      nom: 'Rough Shard',      rarete: 'commun',     famille: 'gemme' },
  { id: 1005, cle: 'cle_rouillee',    nom: 'Rusted Key',       rarete: 'commun',     famille: 'cle' },
  { id: 1006, cle: 'coupe_etain',     nom: 'Tin Cup',          rarete: 'commun',     famille: 'coupe' },

  // ---- rares (2000) : argent et email bleu, une gemme
  { id: 2001, cle: 'jeton_argent',    nom: 'Silver Chip',      rarete: 'rare',       famille: 'jeton' },
  { id: 2002, cle: 'masque_bronze',   nom: 'Bronze Mask',      rarete: 'rare',       famille: 'masque' },
  { id: 2003, cle: 'carte_laquee',    nom: 'Lacquered Card',   rarete: 'rare',       famille: 'carte' },
  { id: 2004, cle: 'gemme_azur',      nom: 'Azure Gem',        rarete: 'rare',       famille: 'gemme' },
  { id: 2005, cle: 'cle_laiton',      nom: 'Brass Key',        rarete: 'rare',       famille: 'cle' },
  { id: 2006, cle: 'coupe_argent',    nom: 'Silver Cup',       rarete: 'rare',       famille: 'coupe' },

  // ---- epiques (3000) : or et violet, plusieurs gemmes, une lueur
  { id: 3001, cle: 'jeton_or',        nom: 'Golden Chip',      rarete: 'epique',     famille: 'jeton' },
  { id: 3002, cle: 'masque_jade',     nom: 'Jade Mask',        rarete: 'epique',     famille: 'masque' },
  { id: 3003, cle: 'carte_email',     nom: 'Enamel Card',      rarete: 'epique',     famille: 'carte' },
  { id: 3004, cle: 'gemme_violette',  nom: 'Violet Gem',       rarete: 'epique',     famille: 'gemme' },
  { id: 3005, cle: 'cle_gravee',      nom: 'Runed Key',        rarete: 'epique',     famille: 'cle' },
  { id: 3006, cle: 'coupe_or',        nom: 'Golden Cup',       rarete: 'epique',     famille: 'coupe' },

  // ---- legendaires (4000) : or massif, halo, gemmes partout
  { id: 4001, cle: 'jeton_obsidienne',nom: 'Obsidian Chip',    rarete: 'legendaire', famille: 'jeton' },
  { id: 4002, cle: 'masque_dore',     nom: 'Gilded Mask',      rarete: 'legendaire', famille: 'masque' },
  { id: 4003, cle: 'carte_feuille_or',nom: 'Gold-leaf Card',   rarete: 'legendaire', famille: 'carte' },
  { id: 4004, cle: 'gemme_solaire',   nom: 'Solar Gem',        rarete: 'legendaire', famille: 'gemme' },
  { id: 4005, cle: 'cle_coffre',      nom: 'Vault Key',        rarete: 'legendaire', famille: 'cle' },
  { id: 4006, cle: 'coupe_sertie',    nom: 'Jewelled Cup',     rarete: 'legendaire', famille: 'coupe' },

  // ---- mythiques (5000) : la lumiere vient de l'interieur
  { id: 5001, cle: 'jeton_eternel',   nom: 'Eternal Chip',     rarete: 'mythique',   famille: 'jeton' },
  { id: 5002, cle: 'masque_ascendant',nom: 'Ascendant Mask',   rarete: 'mythique',   famille: 'masque' },
  { id: 5003, cle: 'carte_vivante',   nom: 'Living Card',      rarete: 'mythique',   famille: 'carte' },
  { id: 5004, cle: 'coeur_swoge',     nom: 'Heart of SWOGE',   rarete: 'mythique',   famille: 'gemme' },
  { id: 5005, cle: 'cle_maitresse',   nom: 'Master Key',       rarete: 'mythique',   famille: 'cle' },
  { id: 5006, cle: 'coupe_eternite',  nom: 'Cup of Eternity',  rarete: 'mythique',   famille: 'coupe' },
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
    familles: FAMILLES.map((f) => ({ cle: f.cle, nom: f.nom, genre: f.genre })),
    items: ITEMS.map((o) => ({ id: o.id, cle: o.cle, nom: o.nom,
                               rarete: o.rarete, famille: o.famille })),
    coffres: COFFRES.map((c) => ({ cle: c.cle, nom: c.nom, prix: c.prix, chances: chances(c.cle) })),
  };
}

module.exports = {
  RARETES, FAMILLES, ITEMS, COFFRES, TOTAL,
  item, coffre, itemsDe, rarete, famille, tire, chances, catalogue,
};
