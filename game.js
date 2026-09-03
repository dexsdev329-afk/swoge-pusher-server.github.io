'use strict';
/*
 * Game logic: player balances, provably-fair coin values, winnings.
 *
 * Balance model (all in $SWOGE wei, BigNumber):
 *   deposit  → balance += amount
 *   drop     → balance -= DROP_COST     (and a provably-fair value is locked on the coin)
 *   win      → balance += coinValue     (when the coin is pushed off the front)
 *   withdraw → balance -= amount, cumulativeAuthorized += amount
 *              (the signed voucher authorizes cumulativeAuthorized; the contract
 *               pays cumulative − alreadyWithdrawnOnChain, so it's replay-safe)
 *
 * Provably-fair:
 *   serverSeed (secret) + serverSeedHash (public, sent to clients)
 *   value = POOL[ HMAC(serverSeed, clientSeed:nonce) mod POOL.length ]
 *   Rotating the seed reveals the old serverSeed so players can verify history.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const cfg = require('./config');
const journal = require('./journal');
const casino = require('./casino');
const hilo = require('./hilo');
const mines = require('./mines');
const plinko = require('./plinko');
const bonanza = require('./bonanza');
const dod = require('./dod');
const chenil = require('./chenil');
const boulier = require('./boulier');
const { Salle: BoulierSalle } = require('./boulier_salle');
const crash = require('./crash');
const p4 = require('./puissance4');
/* Les trois duels partagent la meme interface de moteur : une Partie qui sait
   rejoindre, jouer, ticker et dire qui a gagne. C'est ce qui permet a un seul
   chemin d'argent de les servir tous les trois. */
const paris = require('./paris');
const boutique = require('./boutique');
const skins = require('./skins');
const personnages = require('./personnages');
/* `monde` ne requiert rien : le brancher ici ne peut pas faire de cycle. On en
   a besoin pour dire ce qu'un fruit FAIT — voir `sortDuFruit`. */
const monde = require('./monde');

/* ---- LES POTIONS ----
 *
 * Elles ne sont PAS des objets de coffre : pas de rarete, pas de plafond,
 * pas de tirage. On en achete autant qu'on veut a prix fixe, et elles se
 * consomment. Les ranger dans `p.objets` les aurait fait apparaitre dans la
 * collection et compter dans les exemplaires emis — deux mensonges.
 *
 * DEUX places dediees sous le sac, une par type, quatre-vingt-dix-neuf
 * chacune. Un empilement, contrairement au sac : une potion n'est pas un
 * butin qu'on choisit de garder, c'est une reserve.
 */
const POTIONS = {
  vie:  { cle: 'vie',  nom: 'Health Potion', prix: 10, soigne: 100, quoi: 'hp',
          image: 'potion_rouge' },
  mana: { cle: 'mana', nom: 'Magic Potion',  prix: 10, soigne: 100, quoi: 'mp',
          image: 'potion_bleue' },
};
const POTIONS_MAX = 99;

/*
 * ==================== LE MARCHE DES JOUEURS ====================
 *
 * Jusqu'ici la boutique tirait ses potions de nulle part : elle en vendait
 * autant qu'on en demandait, et l'argent partait entier a la maison. Le stock
 * vient desormais des JOUEURS. On met ses potions en vente, quelqu'un les
 * achete, et la moitie du prix revient au vendeur.
 *
 * ---- pourquoi le prix est FIXE ----
 *
 * Parce qu'un prix libre sur un objet fongible ne produit pas un marche, il
 * produit une course vers le bas : il suffit qu'un joueur affiche une unite
 * en dessous pour prendre toute la demande, et le prix tombe a zero en une
 * soiree. A prix fixe il n'y a rien a sous-coter — on ne se bat que sur la
 * QUANTITE mise en vente, ce qui est exactement le comportement recherche.
 *
 * ---- pourquoi une FILE et pas des annonces ----
 *
 * Deux potions de vie sont identiques. Laisser choisir entre elles serait un
 * ecran a lire pour un choix qui n'existe pas. On sert donc dans l'ordre
 * d'arrivee : le premier qui approvisionne est le premier paye. C'est la
 * seule regle a expliquer, et elle recompense celui qui a stocke le premier.
 *
 * ---- pourquoi les potions QUITTENT le vendeur ----
 *
 * Mises en vente, elles sortent de son inventaire tout de suite. Sinon on
 * afficherait quatre-vingt-dix-neuf potions, on les boirait, et l'acheteur
 * paierait pour du vide. Elles reviennent entieres si l'on retire son offre —
 * une potion bloquee pour toujours parce que personne n'achete serait une
 * confiscation.
 *
 * ---- et pourquoi le vendeur n'est paye qu'a la VENTE ----
 *
 * Payer a la mise en vente reviendrait a ce que la maison rachete tout le
 * stock du jeu a credit. L'argent n'existe qu'au moment ou un acheteur le
 * verse ; c'est le meme argent qui se partage, jamais de l'argent cree.
 */
/* UN seul chiffre pour la part. Ecrire « 10 et 5 » puis « 5000 et 2500 »
   invite la faute de frappe qui paie le vendeur plus que l'acheteur n'a
   verse — et cette faute-la se lit comme une fuite de tresorerie, pas comme
   un caractere de travers. La part du vendeur se DEDUIT du prix. */
const REVENTE_MAISON_BPS = 5000;
const REVENTE_PRIX = { vie: 10, mana: 10, stat: 5000 };
/* Ce que touche le vendeur, arrondi a l'INFERIEUR : la maison ne peut jamais
   reverser plus qu'elle n'a encaisse, quel que soit le prix qu'on ecrira ici
   plus tard. */
function partVendeur(prix) {
  return Math.floor(prix * (10000 - REVENTE_MAISON_BPS) / 10000);
}
/* Les cles du marche. Une potion de soin est `vie` ou `mana` ; une fiole de
   stat est `st:att`, `st:def`... — la meme convention que le sac, ou un
   identifiant de boutique est un nombre et une fiole un texte prefixe. */
function cleMarcheValide(cle) {
  const k = String(cle || '');
  if (POTIONS[k]) return k;
  if (k.slice(0, 3) === 'st:' && personnages.STATS.indexOf(k.slice(3)) >= 0) return k;
  return null;
}
function prixMarche(cle) {
  return cle.slice(0, 3) === 'st:' ? REVENTE_PRIX.stat : REVENTE_PRIX[cle];
}

/* ---- LES PLACES DU SAC ----
 * Huit, et UN OBJET PAR PLACE. Le coffre empile parce qu'il est un stock ;
 * le sac ne doit pas, sinon il n'a pas de fond et rien de ce qu'on y met ne
 * coute quoi que ce soit. Le chiffre est ici et non dans nexus.js pour que
 * le refus (« sac plein ») et l'affichage comptent les memes cases. */
/* Le nom lisible des six especes d'oeuf. Ici et pas cote page : c'est le
   serveur qui nomme les choses du jeu, et deux listes de noms finissent
   toujours par se contredire. */
const NOM_OEUF = {
  normal: 'Plain Egg', feu: 'Ember Egg', glace: 'Frost Egg',
  terre: 'Verdant Egg', tenebre: 'Umbral Egg', legendaire: 'Prism Egg',
};
const NOM_FAMILIER = {
  normal: 'Shiba', feu: 'Ember', glace: 'Frost',
  terre: 'Verdant', tenebre: 'Umbra', legendaire: 'Prism',
};
/* Ce que chacun sait faire. La page l'AFFICHE, elle ne l'applique pas : le
   combat est au serveur, et une deuxieme table cote page finirait par
   promettre autre chose que ce qui se passe. */
/* Le nom, et LUI SEUL. Quelle espece fait quoi est une regle du monde, elle
   vit dans monde.js avec les chiffres : deux tables — l'une qui nomme,
   l'autre qui agit — auraient fini par annoncer un pouvoir et en appliquer un
   autre. */
/* ---- LES PASSIFS, NOMMES ET DITS ----
 * Le nom et la phrase vivent ICI et pas dans monde.js : monde.js porte la
 * REGLE — quelle stat donne quel passif, et combien il vaut — et il n'a
 * jamais eu a savoir comment on l'ecrit en anglais.
 * La phrase prend l'effet DEJA calcule : la recalculer ailleurs finirait par
 * annoncer autre chose que ce que le serveur applique. */
const NOM_PASSIF = {
  brulure: 'Kindling', epines: 'Thornmail', vif: 'Unbound',
  vampire: 'Sanguine', lucide: 'Clarity', reserve: 'Wellspring',
  justesse: 'Precision',
};
const PHRASE_PASSIF = {
  brulure: (e) => `your hits burn for ${Math.round(e.valeur)} over ${e.duree}s`,
  epines:  (e) => `attackers take back ${Math.round(e.valeur * 100)}% of their hit`,
  vif:     (e) => `stun, slow and burn last ${Math.round(e.valeur * 100)}% less`,
  vampire: (e) => `you heal ${Math.round(e.valeur * 100)}% of the damage you deal`,
  lucide:  (e) => `mana regenerates ${Math.round(e.valeur * 100)}% faster`,
  reserve: (e) => `your fruit power costs ${Math.round(e.valeur * 100)}% less`,
  justesse: (e) => `${Math.round(e.valeur * 100)}% chance to hit twice as hard`,
};

const NOM_POUVOIR_FAMILIER = {
  mord: 'Bites monsters', brule: 'Sets enemies on fire',
  gele: 'Freezes an enemy', bouclier: 'Shields you, blocks some hits',
  repousse: 'Knocks enemies back', soigne: 'Heals you',
  /* ---- LE SECOND CRAN ----
   * Chaque phrase dit ce qui change par rapport au premier : c'est ce que le
   * joueur veut savoir avant de nourrir, et « frappe en zone » tout seul ne
   * le dit pas. */
  meute:    'Bites everything around you',
  brasier:  'Sets everything around you on fire',
  gresil:   'Freezes everything around you, briefly',
  secousse: 'Knocks back and stuns everything around you',
  abysse:   'Damages everything around you and heals you for part of it',
  aura:     'Heals you and nearby players',
  /* ---- LE TROISIEME CRAN ----
   * Aucune de ces phrases ne parle des monstres : c'est exactement ce qui
   * distingue ce cran des deux autres, et le joueur doit le lire avant de
   * decider s'il vaut la peine d'aller jusqu'au soixantieme niveau. */
  elan:        'Makes you shoot faster for a few seconds',
  ardeur:      'Makes your own hits stronger for a few seconds',
  givre:       'Clears stun, slow and burn, then keeps them off you',
  racines:     'Speeds up your health regeneration for a few seconds',
  emprise:     'Restores part of your mana',
  benediction: 'Shields you and keeps burning off, for a few seconds',
};
function pouvoirFamilier(espece) {
  const cle = monde.POUVOIR_PAR_ESPECE[espece];
  if (!cle) return null;
  return { cle, nom: NOM_POUVOIR_FAMILIER[cle] || cle };
}
/* Ouvrir un deuxieme oeuf de la meme espece ne donne pas un second familier :
   il nourrit celui qu'on a. Le chiffre vaut une bonne poignee de repas — un
   oeuf est la chose la plus rare du jeu, il ne doit pas valoir moins qu'une
   soiree de farm. */
/* Un deuxieme oeuf de la meme espece nourrit celui qu'on a. Il vaut mille
   cinq cents points — de quoi passer du premier au vingt-troisieme niveau
   d'un coup. C'est enorme, et c'est voulu : un oeuf reste la chose la plus
   rare qui tombe, et le doublon serait sans cela la seule trouvaille du jeu
   qui ne serve a rien. */
const XP_OEUF_DOUBLE = 1500;

/* ================== LE REPAS ET LES NIVEAUX ==================
 *
 * ---- CE QU'UN FAMILIER A LE DROIT DE MANGER : TOUT ----
 *
 * Il n'y a plus de cran interdit. Avant, seuls le commun et le rare
 * passaient, et la raison ecrite ici etait bonne : au moment ou une
 * legendaire nourrit mieux qu'elle ne se porte, le meilleur usage d'une
 * legendaire devient de la DETRUIRE, et l'on retire du jeu des pieces dont
 * l'offre est plafonnee a quarante pour la saison.
 *
 * ---- CE QUI REMPLACE L'INTERDICTION ----
 *
 * Le bareme, et rien d'autre :
 *
 *     commun 25   rare 90   epique 150   legendaire 500   mythique 1500
 *
 * Au-dessus du rare, il monte MOINS vite que la rarete. Une legendaire vaut
 * vingt communes a manger alors qu'il en existe vingt-cinq fois moins ; une
 * mythique en vaut soixante alors qu'il en existe cent fois moins. L'echange
 * est donc perdant a chaque cran, et il l'est de plus en plus haut on monte.
 *
 * Le vrai garde-fou est plus fort encore, et c'est un simple compte : il faut
 * 29 700 d'XP pour mener un familier au centieme niveau.
 *
 *     epique      198 pieces … il en existera 150
 *     legendaire   60 pieces … il en existera  40
 *     mythique     20 pieces … il en existera  10
 *
 * Brûler l'EDITION ENTIERE d'un cran, jusqu'a la derniere piece du serveur,
 * ne suffirait pas a monter UN seul compagnon. La regle ne peut donc pas etre
 * exploitee, quel que soit le nombre de joueurs qui s'y mettent.
 *
 * Le rare est la seule exception, et elle est voulue : il rapporte plus que
 * sa rarete (trois fois et demie une commune pour deux fois et demie moins
 * d'exemplaires). C'etait deja le cas avant, et c'etait le but — la commune
 * et la rare sont les deux crans qui n'avaient aucun usage une fois le sac
 * plein.
 *
 * C'est une meilleure regle que l'interdiction, parce qu'elle n'a pas besoin
 * d'etre appliquee : personne ne fera l'echange, et celui qui le fait sait ce
 * qu'il fait. Une interdiction protegeait le joueur de lui-meme ; un mauvais
 * taux de change le laisse libre en rendant l'erreur evidente.
 *
 * Le risque qui reste, et il est reel : un joueur peut detruire une piece
 * rare a laquelle il tenait, en trois clics, sans retour possible. C'est le
 * meme geste que le recyclage, et il est irreversible comme lui.
 *
 * ---- LE NIVEAU SE DEDUIT DE L'XP ----
 *
 * On ne le RANGE pas a cote. Deux chiffres censes s'accorder finissent par se
 * contredire — une sauvegarde a moitie ecrite, un chemin qui donne l'XP sans
 * monter le niveau — et le joueur voit alors un niveau qui ne correspond a
 * rien. C'est la meme regle que la fame, deduite de l'XP du personnage.
 *
 * ---- ET IL SE PAIE EN OR ----
 *
 * L'or (la « fame ») ne se depensait NULLE PART : il montait, et c'etait
 * tout. Le repas est son premier usage. Le prix suit le niveau : sans ca, la
 * derniere marche couterait le prix de la premiere alors qu'elle demande
 * quarante fois plus d'XP, et l'or cesserait de compter des le deuxieme soir.
 */
/* ---- LE BAREME, UN CRAN PAR RARETE ----
 * Ecrit a la main : c'est un reglage, pas une formule. Mais la COUVERTURE,
 * elle, se verifie — une rarete ajoutee demain sans valeur ici aurait rendu
 * ses pieces immangeables en silence, et le joueur se serait fait refuser un
 * repas sans qu'aucune regle affichee ne le dise. */
const REPAS_XP = { commun: 25, rare: 90, epique: 150, legendaire: 500,
                   mythique: 1500, relique: 3000 };
for (const R of boutique.RARETES) {
  if (!(REPAS_XP[R.cle] > 0)) {
    throw new Error('REPAS_XP : rarete sans valeur de repas : ' + R.cle);
  }
}
const REPAS_OR = 5;                     // le plancher ; le niveau ajoute un quart
const NIVEAU_MAX_FAM = monde.FAMILIERS.niveauMax;

/** L'XP TOTALE qu'il faut avoir accumulee pour etre au niveau `n`. */
function paliersFamilier(n) {
  return 3 * (n - 1) * n;               // 6, 18, 36 … 29 700 au centieme
}
/** Le niveau que vaut une XP totale. La seule source de verite. */
function niveauFamilier(xp) {
  const x = Math.max(0, xp | 0);
  let n = 1;
  while (n < NIVEAU_MAX_FAM && x >= paliersFamilier(n + 1)) n++;
  return n;
}
/* ---- ET CE QUE COUTE UN REPAS ----
 *
 * Le prix etait `40 x niveau`. Mesure faite : un personnage de niveau vingt
 * qui meurt rapporte QUARANTE-QUATRE d'or. Un seul repas coutait donc une vie
 * de personnage entiere — deja lourd pour vingt niveaux de familier, et
 * strictement impossible pour cent.
 *
 * Le prix monte donc doucement et part de bas : cinq d'or au premier niveau,
 * trente au centieme. Il reste un vrai puits — c'est le seul du jeu, l'or ne
 * se depensait nulle part avant lui — mais il se paie avec ce que le jeu
 * donne, et non avec ce qu'il ne donne pas.
 */
function prixRepas(niveau) {
  return REPAS_OR + Math.floor(Math.max(1, niveau | 0) / 4);
}

const SAC_CASES = 8;
/* Le bareme d'XP d'un objet, par rarete. Une rarete inconnue ne rapporte rien
   plutot que de rapporter le premier bareme venu : une faute de frappe dans
   une clef doit se voir, pas se payer. */
function xpDeRarete(cle) { return (cfg.XP_OBJET || {})[String(cle)] || 0; }
const DUELS = { p4, mp: require('./morpion'), dm: require('./dames'),
                mf: require('./morpion_fantome'),
                dc: require('./dernier_chiffre') };
const ATTENTE = p4.ATTENTE, EN_COURS = p4.EN_COURS, FINIE = p4.FINIE;
const volcano = require('./volcano');
const { Entrainement } = require('./entrainement');

const WEI = (n) => ethers.utils.parseUnits(String(n), cfg.DECIMALS);
const COST = WEI(cfg.DROP_COST);
const SPIN_COST = WEI(cfg.SPIN_COST || '1');
const MINW = WEI(cfg.MIN_WITHDRAW);
const BN = (n) => ethers.BigNumber.from(n);
const MS_YEAR = BN('31536000000'); // 365*24*3600*1000

class Game {
  constructor() {
    /* Les paris sportifs. Ils vivent plus longtemps qu'une manche : poses
       aujourd'hui, regles apres le match. */
    this.paris = []; this.parisRegles = {}; this.parisSeq = 0;
    /* Les credits envoyes depuis le panneau, sur la fenetre glissante. Ils
       sont l'enveloppe : les perdre au redemarrage rendrait le plafond
       contournable d'un simple redeploiement. */
    this.dons = [];
    /* LE REGISTRE DES EMIS. { id d'objet : nombre deja sorti }, pour toute la
       plateforme. C'est lui qui fait exister les plafonds : sans un compteur
       GLOBAL, chaque inventaire ne connait que sa propre quantite et personne
       ne sait combien de Void Fruits existent. Il vit dans la tete de l'etat,
       pas dans les fiches — il n'appartient a aucun joueur. */
    /* Les compteurs de touches. En tete d'etat et non par joueur : la question
       est « quelle rangee sert », pas « que fait tel joueur ». */
    this.taps = {};
    /* Les annonces du marche. En tete d'etat : elles n'appartiennent a
       personne une fois posees — l'objet est sorti de l'inventaire du vendeur
       et attend son acheteur. */
    this.marche = [];
    this.marcheNo = 1;
    /* LES CARTES DESSINEES PAR LES JOUEURS. En tete d'etat comme les annonces
       du marche, et pour la meme raison : elles n'appartiennent a la fiche de
       personne — chacune porte l'adresse de son auteur, ce qui n'est pas
       pareil. Une carte rangee dans une fiche serait invisible a la galerie
       sans parcourir tous les comptes.
       `cartesNo` ne redemarre jamais a zero : deux cartes qui partageraient un
       numero se remplaceraient l'une l'autre, et c'est le travail de quelqu'un
       qui disparait. Il est donc sauvegarde avec le reste. */
    this.cartes = [];
    this.cartesNo = 1;
    /* LES GALERIES DES SALLES A ECRAN. UNE GALERIE PAR SALLE, rangee par la
       cle de la table `cfg.SALLES_ECRAN` : { cinema: [...], manga: [...] }.
       Chaque galerie est une LISTE, jamais nulle — un champ qui vaut tantot
       `null`, tantot un objet, tantot un tableau oblige chaque lecteur a
       redemander de quelle forme il est aujourd'hui, et le premier qui oublie
       envoie `null.length` a la page. Vide veut dire « rien a l'affiche »,
       et c'est un etat comme un autre.
       Les cles ne sont pas ecrites ici : elles DECOULENT de la table, sans
       quoi ajouter une salle demanderait de penser aussi a ce constructeur. */
    this.cinemas = Game.galeriesVides();
    /* QUAND CHAQUE JOUEUR A PARLE. Ici et pas dans sa fiche : ces horodatages
       ne valent que pour les quinze prochaines secondes, et les ecrire dans
       l'etat sauvegarde ferait grossir chaque sauvegarde d'une ligne par
       bavard, pour une information deja perimee quand on la relit. */
    this._dits = new Map();
    /* Combien d'exemplaires de chaque edition limitee sont partis. */
    this.skinsEmis = {};
    this.boutiqueEmis = {};
    /* LES TROIS PREMIERES LIGNES. Une entree par gagnant, dans l'ordre :
       { addr, nom, famille, prix, t }. C'est cette liste qui dit combien de
       places restent — pas un compteur a cote, qui pourrait diverger. */
    this.boutiqueLignes = [];
    this.players = new Map(); // addr -> { balance, cumulativeAuthorized, clientSeed, nonce, name, dayNet, dayKey, dropsToday, winsToday, questClaimed, hasDeposited }
    this.telegramMap = new Map(); // telegramId (string) -> addr, so the Adsgram reward postback can find the account
    this.seenTx = new Set();  // dedupe deposits
    this.lastBlock = 0;       // deposit-scan watermark (persisted so a restart resumes)
    this.betLastBlock = 0;    // the same, for the $SWOGEBET vault of the bets
    this._stakeRateBps = BN(cfg.STAKE_APR_BPS);
    // progressive jackpot (all wei)
    this.jackpotPot = WEI(cfg.JACKPOT_SEED);
    this._jackpotSeed = WEI(cfg.JACKPOT_SEED);
    this._rakeWei = COST.mul(Math.round(cfg.JACKPOT_RAKE_PCT * 100)).div(10000); // pct, 2-dec
    /* La cagnotte du Boulier. Elle vit a part du jackpot du Coin Pusher : les
       deux montent avec les mises de leur propre jeu, et les melanger ferait
       payer un plein a 90 boules avec l'argent des pieces poussees. */
    this.boulierPot = WEI(cfg.BOULIER_CAGNOTTE_AMORCE);
    this.boulierPleins = [];   // les derniers pleins, pour la page et l'admin
    /* La salle : un tirage, tout le monde dessus. Elle ne connait ni les
       soldes ni les sockets — elle compte le temps et tire. */
    this.boulierSalle = new BoulierSalle({
      graine: cfg.BOULIER_GRAINE || undefined,
      attenteMs: cfg.BOULIER_ATTENTE_MS, tirageMs: cfg.BOULIER_TIRAGE_MS,
      apresMs: cfg.BOULIER_APRES_MS,
    });
    /* Secret des jetons de session. Il vit avec l'etat : sans ca, chaque
       redeploiement deconnecterait tous les joueurs d'un coup. */
    this.sessionSecret = cfg.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    /* La graine de la chaine du Crash vit avec l'etat, comme le secret de
       session : la regenerer a chaque redeploiement casserait l'engagement
       publie, et donc la seule chose qui prouve aux joueurs que les manches a
       venir sont deja ecrites. */
    this.crashGraine = cfg.CRASH_GRAINE || crypto.randomBytes(32).toString('hex');
    this._rotateSeed();
    this._crashTable();
    /* Les parties de Connect 4. Elles ne sont PAS sauvegardees avec l'etat :
       une partie interrompue par un redemarrage rendrait les deux mises (voir
       _p4Rendre), parce qu'une grille a moitie jouee dont les deux joueurs ont
       ete deconnectes n'a plus d'arbitre. */
    this.p4 = new Map();
    /* Les fiches touchees depuis la derniere sauvegarde. Le magasin la vide
       quand il a fini d'ecrire — et seulement s'il a reussi. */
    this.sales = new Set();
    this.p4Seq = 0;
    /* LES TABLES D'ENTRAINEMENT. Elles vivent a cote des duels payants, pas
       dedans : aucun solde ne les traverse, rien n'y est sauvegarde, et elles
       meurent avec le processus. Le seul lien avec la maison est le tirage du
       Dernier Chiffre, qui a besoin de la graine du serveur. */
    this.entrainement = new Entrainement({
      tirage: (partie) => this._tirageDuel(partie),
    });
    /* Le total preleve sur les retraits depuis toujours. Il ne bouge aucun
       solde — il reste dans le coffre — mais c'est le chiffre a bruler. */
    this.fraisCumules = BN(0);
    this.brule = BN(0);          // ce qui est DEJA parti a l'adresse morte
    this.brulages = [];          // les dernieres transactions, pour pouvoir les montrer
  }

  /** (Re)construit la table du Crash a partir de la graine courante. */
  _crashTable() {
    this.crash = new crash.Table({
      graine: this.crashGraine, longueur: cfg.CRASH_CHAINE, sel: cfg.CRASH_SEL,
      edgeBps: cfg.CRASH_EDGE_BPS, plafond: cfg.CRASH_PLAFOND,
      vitesse: cfg.CRASH_VITESSE, attenteMs: cfg.CRASH_ATTENTE_MS,
      apresMs: cfg.CRASH_APRES_MS,
    });
  }

  /**
   * Une fiche qui n'a JAMAIS RIEN FAIT.
   *
   * ---- pourquoi cette question se pose ----
   *
   * Ouvrir un compte ne coute rien : on fabrique une paire de cles chez soi
   * et on signe une phrase. Pas de gaz, pas de transaction, pas de courriel.
   * Le serveur ne peut donc pas distinguer un faux compte d'un vrai AU
   * MOMENT DE LA CONNEXION — a cet instant ils sont identiques.
   *
   * Et chaque fiche pese 559 octets dans un fichier qui est REECRIT EN ENTIER
   * toutes les dix secondes, par un JSON.stringify qui bloque le seul fil
   * d'execution. Vingt mille fiches vides, c'est une seconde de gel a chaque
   * sauvegarde ; deux cent mille, c'est dix secondes toutes les dix secondes,
   * et plus aucune partie ne tourne.
   *
   * On ne filtre donc pas a l'entree — c'est impossible — mais A L'ECRITURE.
   * La difference entre un vrai joueur et une ferme n'apparait que lorsqu'il
   * FAIT quelque chose ; on garde tout ce qui a fait quelque chose, et rien
   * d'autre. Le credit d'essai ne compte pas : il est donne, pas gagne.
   */
  /**
   * Les familles deja completes d'un inventaire, pour les fiches d'avant le
   * registre `xpFamilles`.
   *
   * Posseder une famille entiere ne peut vouloir dire qu'une chose : le bonus
   * a deja ete verse, puisqu'il part a l'instant exact ou la derniere piece
   * arrive. Reconstituer la marque a la lecture evite une migration du fichier
   * ET evite le trou inverse — sans elle, il suffirait de revendre une piece
   * et de la retirer pour encaisser une deuxieme fois les deux mille points.
   */
  static _famillesPossedees(objets) {
    const m = {};
    for (const f of boutique.FAMILLES) {
      const l = boutique.ITEMS.filter((o) => o.famille === f.cle);
      if (l.length && l.every((o) => (objets || {})[o.id])) m[f.cle] = 1;
    }
    return m;
  }

  static estVide(p) {
    if (!p) return true;
    const z = (w) => !w || ethers.BigNumber.from(w).isZero();
    return p.balance.lte(WEI(String(cfg.WELCOME_BONUS || 0)))
      && !p.hasDeposited && z(p.deposited)
      && z(p.wagered) && !(p.betCount > 0)
      && !p.nomChoisi && !p.visage && !p.photo
      && !(p.amis || []).length && !(p.demandes || []).length && !(p.envoyees || []).length
      && !p.parrain && !(p.filleuls || []).length
      && !(p.stakes || []).length && z(p.stakeAccrued) && z(p.stakeClaimTotal)
      && z(p.cumulativeAuthorized) && z(p.bonDu || BN(0)) && !p.tgId
      /* Le solde des paris compte comme une trace, au meme titre que le $SWOGE. */
      && z(p.betBalance || BN(0)) && z(p.betCumulativeAuthorized || BN(0))
      && z(p.betBonDu || BN(0)) && z(p.betDeposited || BN(0))
      && z(p.refDu) && z(p.refTotal) && !(p.attente || []).length
      /* ---- L'XP COMPTE COMME UNE TRACE ----
       *
       * Sans cette ligne, une fiche qui n'a QUE de l'XP — le joueur qui se
       * connecte tous les jours et fait ses quetes sans jamais miser — passe
       * pour vide : elle n'est pas ecrite au fichier, et elle est purgee de la
       * memoire. Sa serie et sa progression disparaissent au redemarrage.
       *
       * C'est exactement le joueur que la separation de l'XP et du volume
       * existe pour rendre possible, et il etait le seul que le systeme
       * effacait. Trouve par le test de redemarrage, pas a la lecture. */
      && !(p.xp > 0) && !(p.streakDay > 0) && !Object.keys(p.objets || {}).length
      && !Object.keys(p.skins || {}).length;
  }

  /**
   * Retire de la memoire les fiches qui n'ont jamais rien fait.
   *
   * `protegees` porte les adresses actuellement connectees : retirer la fiche
   * de quelqu'un qui est devant son ecran lui reprendrait son credit d'essai
   * au milieu de sa visite. Elles reviendront a la purge suivante s'il n'a
   * toujours rien fait.
   */
  purge(protegees) {
    let n = 0;
    for (const [addr, p] of this.players) {
      if (protegees && protegees.has(addr)) continue;
      if (Game.estVide(p)) { this.players.delete(addr); n++; }
    }
    return n;
  }

  /** Snapshot the whole state for persistence (BigNumbers → strings). */
  /**
   * UNE fiche, telle qu'elle est ecrite.
   *
   * Elle est sortie de `serialize()` pour qu'on puisse en ecrire une seule.
   * Reecrire vingt mille fiches parce que trente ont bouge coute, a vingt
   * mille joueurs, sept cents millisecondes pendant lesquelles le serveur ne
   * repond a personne — mesure, pas suppose.
   *
   * Rend null pour une fiche vide : c'est la seule barriere entre un script
   * qui ouvre mille comptes par minute et un fichier de soldes trop lourd
   * pour etre sauve.
   */
  fiche(addr) {
    const p = this.players.get(String(addr).toLowerCase());
    if (!p || Game.estVide(p)) return null;
    return {
        b: p.balance.toString(), c: p.cumulativeAuthorized.toString(),
        bd: (p.bonDu || ethers.BigNumber.from(0)).toString(),
        /* le solde des paris et ses deux compteurs de retrait */
        pb: (p.betBalance || BN(0)).toString(), pc: (p.betCumulativeAuthorized || BN(0)).toString(),
        pbd: (p.betBonDu || BN(0)).toString(), pdp: (p.betDeposited || BN(0)).toString(),
        s: p.clientSeed, n: p.nonce, name: p.name, nc: !!p.nomChoisi,
        /* Le nom a ete PAYE. Sans ca au fichier, le joueur repaierait mille
           jetons a chaque redeploiement, et personne ne comprendrait pourquoi. */
        np: !!p.nomPaye,
        dn: p.dayNet.toString(), dk: p.dayKey,
        dt: p.dropsToday, wt: p.winsToday, qc: p.questClaimed, hd: p.hasDeposited,
        pe: p.primesEntrainement,
        mij: p.miseJour || {}, fac: p.face || {},
        vi: p.visage || null, am: p.amis || [], ph: !!p.photo,
        dm: p.demandes || [], en: p.envoyees || [],
        pa: p.parrain || null, fi: p.filleuls || [],
        rd: (p.refDu || BN(0)).toString(), rt: (p.refTotal || BN(0)).toString(),
        rc: p.revCumul || 0, rp: p.revPaye || 0, att: p.attente || [],
        /* `rap` : ce filleul a deja rapporte au moins une fois. C'est ce
           drapeau qui compte dans la prime de recruteur de SON parrain, et il
           doit survivre a un redemarrage — sans quoi chaque relance remettrait
           tout le monde a « aucune recrue active » et ferait redescendre les
           taux de la moitie des parrains, sans que personne ne comprenne.
           `rap` et pas `ra` : les clefs courtes de ce fichier se marchent
           dessus des qu'on ne regarde pas, et l'une d'elles a deja efface la
           liste de parrainage de tout le monde. */
        rap: !!p.aRapporte,
        rec: p.record || null, mj: p.meilleurJour || null, rb: !!p.refBienvenue,
        bb: (p.bonusBloque || BN(0)).toString(), bc2: p.bonusCible ? p.bonusCible.toString() : null,
        mk: p.moisCle || null, mm: p.moisMise || 0,
        sct: (p.stakeClaimTotal || BN(0)).toString(), tnl: p.trNonLus || 0,
        stk: p.stakes.map((x) => [x.a.toString(), x.s, x.u]), sa: p.stakeAccrued.toString(),
        tw: (p.wagered || ethers.BigNumber.from(0)).toString(), bc: p.betCount || 0,
        /* Le niveau ACQUIS. Sans lui au fichier, la marque se reperdrait a
           chaque redemarrage et serait recalculee sur la courbe du moment —
           donc le durcissement retrograderait tout le monde au premier
           deploiement suivant. */
        nx: p.nivMax || 0,
        dp: (p.deposited || ethers.BigNumber.from(0)).toString(), jx: p.jeux || {},
        bj: p.bj || null, vm: p.volcanoMeter || 0,
        ob: p.objets || {},
        sk: p.skins || undefined, ska: p.skinActif || undefined,
        /* La Fame du COMPTE part au fichier, contrairement a celle des
           personnages : celle-la se deduit de leur volume, celle-ci ne se
           deduit de rien — elle est la somme de ce que les morts passees ont
           verse, et rien au monde ne permettrait de la retrouver si on ne
           l'ecrivait pas. */
        fm: p.fame || undefined,
        /* Le sac part au fichier comme le coffre : ce qu'on a ramasse ne doit
           pas disparaitre parce que le serveur a redemarre. */
        sc: (p.sac && Object.keys(p.sac).length) ? p.sac : undefined,
        /* Les potions aussi : elles sont achetees avec de l'argent reel, et
           les perdre a un redemarrage serait un vol. */
        po: (p.potions && Object.keys(p.potions).length) ? p.potions : undefined,
        /* Les fioles de stat, des deux cotes. Celles du COFFRE survivent a la
           mort — c'est toute la raison d'etre du coffre — donc elles doivent
           d'abord survivre a un redemarrage. Celles du SAC partent au fichier
           pour la meme raison que le sac lui-meme : un redemarrage n'est pas
           une mort. */
        /* `fio`, pas `fi` : `fi` etait DEJA pris par les filleuls, et l'ecraser
           a efface la liste de parrainage de tout le monde a la relecture.
           Quatre essais l'ont dit tout de suite ; sans eux, personne n'aurait
           su avant qu'un joueur ne demande ou etait passe son filleul. */
        fio: (p.fioles && Object.keys(p.fioles).length) ? p.fioles : undefined,
        sfio: (p.sacFioles && Object.keys(p.sacFioles).length) ? p.sacFioles : undefined,
        /* Les oeufs du sac, et les familiers eclos. `soe` et `fam` : deux
           clefs neuves, verifiees libres — la lecon de `fi` contre `fio` a
           coute la liste de parrainage de tout le monde. */
        soe: (p.sacOeufs && Object.keys(p.sacOeufs).length) ? p.sacOeufs : undefined,
        /* Les oeufs ranges au coffre. Une clef separee de `soe` : le sac se
           perd a la mort, le coffre non, et les fondre reviendrait a devoir
           se souvenir, a chaque endroit, de quelle moitie on parle. */
        coe: (p.coffreOeufs && Object.keys(p.coffreOeufs).length) ? p.coffreOeufs : undefined,
        fam: (p.familiers && Object.keys(p.familiers).length) ? p.familiers : undefined,
        /* Lequel est dehors. Sans ca, le familier rentre a l'enclos a chaque
           redemarrage du serveur et le joueur croit l'avoir perdu. */
        fama: p.familierActif || undefined,
        /* Ou chaque chose est posee dans les huit places. Ce n'est pas la
           verite — le compte l'est — mais la reconstruire au hasard a chaque
           redemarrage rebattrait le sac sous les doigts du joueur. */
        scas: (Array.isArray(p.sacCases) && p.sacCases.some(Boolean)) ? p.sacCases : undefined,
        /* Le volume par skin part en chaine wei, comme p.wagered lui-meme —
           meme raison : un BigNumber ne traverse pas JSON.stringify tout
           seul. */
        pr: (p.persos && Object.keys(p.persos).length)
          ? Object.keys(p.persos).reduce((o, id) => { const c = p.persos[id];
              o[id] = { w: (c.w || ethers.BigNumber.from(0)).toString(),
                        ef: c.ef || undefined, ea: c.ea || undefined,
                        ar: c.ar || undefined, ba: c.ba || undefined,
                        /* L'XP GAGNEE AU COMBAT part au fichier ; celle du
                           volume ne part pas, elle se recalcule. Meme regle
                           que pour le compte, un cran plus bas. */
                        xc: c.xc || undefined,
                        /* Les potions bues sont un ACQUIS : elles doivent
                           survivre a un redemarrage du serveur exactement
                           comme un objet du coffre. Seule la mort du
                           personnage les efface — pas un incident
                           d'exploitation. */
                        su: (c.sup && Object.keys(c.sup).length) ? c.sup : undefined,
                      }; return o; }, {})
          : undefined,
        tg: p.tgId || null,
        wg: !!p.welcomeGranted, ww: !!p.welcomeWagered, wc: !!p.welcomeClaimed,
        /* L'XP GAGNEE part au fichier ; l'XP du volume ne part PAS, elle se
           recalcule. Persister une somme deja derivable, c'est se donner deux
           verites a tenir d'accord. */
        xp: p.xp || 0, xps: p.xpSources || undefined, xpf: p.xpFilleuls || undefined,
        xo: p.xpObjets || undefined,
        xfa: p.xpFamilles || undefined,
        cof: p.coffreOffertJour || null, jc: p.jourColl || undefined,
        cre: p.creeLe || undefined, pj: p.parfaitJour || undefined,
        sd: p.streakDay || 0, sl: p.streakLastClaimDay || null,
        ac: p.adCount || 0, ak: p.adDayKey || null, al: p.adLastMs || 0,
    };
  }

  /** Tout l'etat SAUF les fiches : c'est petit, et ca s'ecrit a chaque fois. */
  serializeTete() {
    /* Les duels en cours ne sont PAS rejoues au redemarrage — une grille a
       moitie jouee dont les deux joueurs ont ete deconnectes n'a plus
       d'arbitre. Mais les MISES, elles, ont bel et bien quitte les soldes et
       sont ecrites sur le disque : sans cette liste, un redemarrage au milieu
       d'une partie faisait disparaitre la table AVEC l'argent. On garde donc
       le strict necessaire pour rembourser a la relecture. */
    const duels = [];
    for (const m of this.p4.values()) {
      if (m.phase === FINIE) continue;
      duels.push({ id: m.id, jeu: m.jeu || 'p4', mise: m.mise,
                   joueurs: m.joueurs.filter(Boolean) });
    }
    return { v: 1, serverSeed: this.serverSeed, sessionSecret: this.sessionSecret,
             taps: this.taps || {},
             marche: this.marche || [], marcheNo: this.marcheNo || 1,
             boutiqueEmis: this.boutiqueEmis || {},
             /* Le registre des editions limitees. Il DOIT traverser les
                sauvegardes : un redemarrage qui le remettrait a zero
                remettrait en vente une edition deja epuisee, et personne ne
                le verrait avant que le cinquante et unieme exemplaire ne
                soit vendu. */
             skinsEmis: this.skinsEmis || {},
             boutiqueLignes: this.boutiqueLignes || [],
             compta: this._comptaEcrite(), tunnel: this.tunnel || {},
             prixVerses: this.prixVerses || {},
             /* Les prix du monde deja verses, AVEC leur tableau. Une semaine
                passee ne se reconstruit pas : les personnages ont continue de
                vivre, et certains sont morts — « qui a gagne » n'existe plus
                nulle part ailleurs. */
             prixMondeVerses: this.prixMondeVerses || {},
             graines: this.graines || [], graineDepuis: this.graineDepuis || null,
             manchesGraine: this.manchesGraine || 0,
             /* Les paris traversent les jours : sans eux dans la sauvegarde,
                un redeploiement le vendredi soir efface tout ce qui a ete
                pose pour le samedi. */
             paris: this.paris || [], parisRegles: this.parisRegles || {},
             parisSeq: this.parisSeq || 0,
             dons: this.dons || [],
             jackpotPot: this.jackpotPot.toString(),
             boulierPot: this.boulierPot.toString(),
             boulierPleins: this.boulierPleins || [],
             boulierSalle: this.boulierSalle.sauve(),
             crashGraine: this.crashGraine, crash: this.crash.sauve(),
             fraisCumules: (this.fraisCumules || BN(0)).toString(),
             brule: (this.brule || BN(0)).toString(), brulages: this.brulages || [],
             lastBlock: this.lastBlock, seenTx: Array.from(this.seenTx),
             betLastBlock: this.betLastBlock || 0,
             usage: this.usage || {},
             /* LES GALERIES DES SALLES A ECRAN. Elles sont dans l'etat et
                non dans un fichier a part parce qu'elles tiennent en quelques
                chaines et qu'elles doivent survivre a un redeploiement — une
                salle qui redevient vide a chaque mise en ligne n'est pas une
                salle qu'on prend la peine de remplir.
                On n'ecrit QU'UN champ, et il porte les trois salles. Ecrire
                en plus les anciennes formes pour les vieilles versions
                donnerait plusieurs champs a tenir d'accord, et le jour ou ils
                divergent c'est le plus ancien qu'on relit. La compatibilite se
                joue a la LECTURE, dans `hydrate`, ou elle ne coute qu'une
                conversion. */
             cinemas: this.galeriesToutes(),
             /* Les cartes DOIVENT traverser une sauvegarde : c'est le travail
                de quelqu'un, et un redeploiement qui l'efface ne laisse aucune
                trace. On garde aussi le compteur — voir le constructeur. */
             cartes: this.cartes || [], cartesNo: this.cartesNo || 1,
             duels, telegramMap: Array.from(this.telegramMap) };
  }

  /**
   * UNE SEANCE DE CINEMA, LUE DEPUIS LE PANNEAU D'ADMINISTRATION.
   *
   * ---- POURQUOI LA VALIDATION EST ICI ET PAS DANS LA PAGE ----
   *
   * Ces adresses finissent dans un `iframe.src` SUR LA PAGE DE CHAQUE JOUEUR.
   * Une chaine `javascript:` posee la s'executerait dans le contexte du site,
   * avec la session de celui qui regarde : ce n'est pas une faute de gout,
   * c'est une porte ouverte. Le champ vient du panneau d'administration, donc
   * de quelqu'un de confiance — mais « de confiance » n'est pas « incapable de
   * coller la mauvaise chose », et le jour ou la cle d'admin fuit, c'est cette
   * ligne-ci qui decide si le site sert du code a ses joueurs.
   *
   * On n'accepte donc que http et https, et rien d'autre. La page, elle, ne
   * revalide pas : une regle a deux endroits finit par ne plus dire la meme
   * chose, et c'est celle du serveur qui compte puisque c'est elle qu'on ne
   * peut pas contourner.
   *
   * Cette methode ne pose RIEN : elle rend la seance propre, ou `null`. Un
   * seul endroit nettoie, et `ajouteCinema` decide quoi en faire — sans quoi
   * le jour ou une deuxieme porte d'entree apparait (un import, une reprise de
   * sauvegarde), elle validerait a sa facon.
   */
  static seanceCinema(x) {
    const url = (v) => {
      const t = String(v || '').trim().slice(0, 500);
      if (!t) return '';
      if (!/^https?:\/\//i.test(t)) return '';
      return t;
    };
    const titre = String((x && x.titre) || '').trim().slice(0, 80);
    const affiche = url(x && x.affiche);
    const vf = url(x && x.vf), vo = url(x && x.vo);
    /* Une moitie de seance n'entre pas dans la galerie. Un ecran qui annonce
       un titre sans rien derriere est pire qu'un ecran eteint — le joueur
       traverse la salle pour rien. */
    if (!titre || (!vf && !vo)) return null;
    return { titre, affiche, vf, vo };
  }

  /**
   * LA SALLE, VALIDEE CONTRE LA TABLE.
   *
   * ---- POURQUOI UNE CLE INCONNUE EST REFUSEE, ET NON RABATTUE ----
   *
   * Le reflexe serait de retomber sur le cinema quand la cle ne dit rien. Ce
   * serait le pire des deux mondes : une seance manga atterrirait dans le
   * cinema parce que la cle a ete mal ecrite, elle partirait sur l'ecran de
   * tous les joueurs, et PERSONNE ne comprendrait pourquoi — ni celui qui l'a
   * posee, qui a vu son geste accepte, ni celui qui la regarde. Un refus est
   * lisible ; une salle par defaut ne l'est pas.
   *
   * La table est la seule source : `SALLES_ECRAN` decide, ici comme partout
   * ailleurs. Rend la cle retenue, ou `null`.
   */
  static salleEcran(cle) {
    /* EXACTEMENT la cle de la table, sans rogner ni rabaisser la casse. Une
       normalisation serait une deuxieme regle : « CINEMA » passerait ici mais
       pas dans l'identifiant du panneau ni dans la cle d'etat, et l'on
       chercherait longtemps pourquoi la seance est acceptee et invisible. La
       cle ne vient pas d'un humain qui la tape, elle vient de la section du
       panneau ou l'on ecrit ; elle est donc toujours exacte, et ce qui ne
       l'est pas merite un refus. */
    const k = String(cle == null ? '' : cle);
    const s = (cfg.SALLES_ECRAN || []).find((x) => x && x.cle === k);
    return s ? s.cle : null;
  }

  /** Une galerie vide par salle de la table. Les cles DECOULENT de la table. */
  static galeriesVides() {
    const g = {};
    for (const s of (cfg.SALLES_ECRAN || [])) g[s.cle] = [];
    return g;
  }

  /**
   * LA GALERIE D'UNE SALLE, prete a etre modifiee.
   *
   * Elle LEVE sur une cle inconnue plutot que de rendre une liste vide : une
   * liste vide se laisserait remplir, et la seance serait perdue dans un coin
   * de l'etat que rien ne diffuse ni ne sauvegarde. On ne repete pas la cle
   * telle qu'elle est arrivee dans le message — elle vient du dehors, et un
   * message d'erreur est un endroit ou l'on recopie sans y penser.
   */
  galerieCinema(salle) {
    const k = Game.salleEcran(salle);
    if (!k) {
      const vu = String(salle == null ? '' : salle).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
      throw new Error(`unknown screen room "${vu}"`);
    }
    /* Un etat relu d'une vieille sauvegarde peut encore porter une LISTE ici.
       On la remet en forme plutot que d'y pousser : `[].manga` ne leve pas,
       il pose un champ sur un tableau, que la sauvegarde ne garde pas. */
    if (!this.cinemas || typeof this.cinemas !== 'object' || Array.isArray(this.cinemas))
      this.cinemas = Game.galeriesVides();
    if (!Array.isArray(this.cinemas[k])) this.cinemas[k] = [];
    return this.cinemas[k];
  }

  /**
   * TOUTES LES GALERIES, dans la forme exacte que la table decrit.
   *
   * C'est ce qui part dans la sauvegarde et sur le fil. On ne rend pas
   * `this.cinemas` tel quel : une salle retiree de la table y trainerait
   * encore, et une salle ajoutee y manquerait — la page recevrait alors une
   * salle sans galerie et l'ecran afficherait `undefined.length`.
   */
  galeriesToutes() {
    const g = {};
    for (const s of (cfg.SALLES_ECRAN || [])) {
      const v = this.cinemas && this.cinemas[s.cle];
      g[s.cle] = Array.isArray(v) ? v : [];
    }
    return g;
  }

  /**
   * LES SALLES TELLES QU'ELLES PARTENT SUR LE FIL.
   *
   * ---- POURQUOI UNE LISTE, ET PAS UN OBJET RANGE PAR CLE ----
   *
   * La page range les rangees du catalogue avec la salle ou le joueur se tient
   * en tete, puis « les autres dans l'ordre ou le serveur les annonce ». Cet
   * ordre est donc un CONTRAT, et l'ordre des cles d'un objet n'en est pas un :
   * il depend de la facon dont un moteur enumere, il se perd a la traversee
   * d'un cache, d'un proxy ou d'une relecture. Une liste porte son ordre
   * elle-meme, et c'est celui de la table.
   *
   * ---- POURQUOI LE NOM LISIBLE EST DEDANS ----
   *
   * Sans lui, la page ecrirait « Movies » de son cote pendant que la table dit
   * « Cinema - SWOGE FLIX ». Deux verites qui divergent au premier renommage,
   * et c'est la page qu'on croit, puisque c'est elle qu'on lit. La page doit
   * pouvoir repondre « quelles salles existent, comment les nommer, dans quel
   * ordre » sans une seule chaine ecrite chez elle.
   *
   * Chaque entree : { cle, nom, seances }.
   */
  sallesFil() {
    return (cfg.SALLES_ECRAN || []).map((s) => {
      const v = this.cinemas && this.cinemas[s.cle];
      return { cle: s.cle, nom: s.nom, seances: Array.isArray(v) ? v : [] };
    });
  }

  /**
   * LA GALERIE DU CINEMA SEULE — l'accommodation datee du fil.
   *
   * Posee le 2026-08-23, appelee a disparaitre. La page en service ne lit que
   * l'ancien champ `cinemas` : la retirer du fil aujourd'hui viderait le
   * cinema pour tout le monde entre les deux deploiements. Elle s'en va le
   * jour ou la page lit `salles`, et pas avant.
   */
  galerieHeritee() {
    const k = Game.salleEcran('cinema') || ((cfg.SALLES_ECRAN || [])[0] || {}).cle;
    const v = k && this.cinemas ? this.cinemas[k] : null;
    return Array.isArray(v) ? v : [];
  }

  /**
   * AJOUTER UNE SEANCE A LA GALERIE D'UNE SALLE.
   *
   * Rend la seance retenue, ou `null` si elle a ete refusee — c'est ce `null`
   * que le panneau affiche pour dire « rien n'a ete enregistre », et c'est
   * pour ca qu'il relit toujours ce que le serveur a RETENU au lieu de croire
   * ce qu'il a envoye.
   *
   * Le plafond, lui, LEVE. C'est une autre reponse a une autre question : une
   * seance refusee est mal ecrite, une galerie pleine est bien ecrite mais n'a
   * plus de place. Les confondre aurait fait lire « adresse refusee » a
   * quelqu'un dont l'adresse etait bonne, et il aurait passe la soiree a la
   * recopier.
   *
   * LE PLAFOND EST PAR SALLE. Un plafond commun aurait laisse une salle bien
   * remplie fermer la porte aux deux autres, et le proprietaire aurait lu
   * « la galerie est pleine » devant une galerie vide.
   *
   * La salle est le PREMIER argument et non un champ du formulaire : elle ne
   * vient pas de ce que quelqu'un a tape, elle vient de la section du panneau
   * dans laquelle on ecrit. Un champ de plus dans le corps du message aurait
   * laisse un appelant la deplacer sans le vouloir.
   */
  ajouteCinema(salle, x) {
    const g = this.galerieCinema(salle);
    const c = Game.seanceCinema(x);
    if (!c) return null;
    if (g.length >= cfg.CINEMA_MAX)
      throw new Error(`the gallery is full (${cfg.CINEMA_MAX} shows) - remove one first`);
    g.push(c);
    return c;
  }

  /**
   * RETIRER LA SEANCE D'UN RANG DONNE, DANS UNE SALLE DONNEE.
   *
   * Par RANG et non par titre : deux seances peuvent porter le meme titre —
   * une version courte et une version longue, deux episodes — et retirer
   * « par titre » en aurait alors efface deux d'un coup, dont une que
   * personne n'avait demande a retirer.
   *
   * Le rang vient de la liste que le panneau vient de relire du serveur POUR
   * CETTE SALLE, et le panneau la relit apres chaque operation : il ne peut
   * donc pas designer une place qui n'existe plus. Un rang hors bornes ne
   * retire rien et le dit par `false`, plutot que de retirer la derniere par
   * politesse.
   */
  retireCinema(salle, i) {
    const g = this.galerieCinema(salle);
    const k = Number(i);
    if (!Number.isInteger(k) || k < 0 || k >= g.length) return false;
    g.splice(k, 1);
    return true;
  }

  /**
   * REMPLACER LA SEANCE D'UN RANG DONNE, DANS UNE SALLE DONNEE.
   *
   * Jusqu'ici le panneau ne savait que RETIRER : corriger une faute de frappe
   * dans un titre, ou remplacer un lien mort, demandait de supprimer la
   * seance puis de la ressaisir en entier — quatre champs recopies pour en
   * changer un, et la seance qui disparait de la salle entre les deux.
   *
   * ELLE PASSE PAR LA MEME PORTE QUE L'AJOUT, ET POUR LES TROIS SALLES.
   * `Game.seanceCinema` est le seul endroit qui nettoie et valide, et la
   * modification l'appelle comme `ajouteCinema` : sans cela, l'edition serait
   * une deuxieme entree dans la galerie, celle-la sans controle d'adresse — et
   * il aurait suffi de poser une seance valable puis de la MODIFIER pour
   * glisser n'importe quoi dans l'iframe de chaque joueur. De meme, une salle
   * qui aurait son propre chemin de controle serait une porte derobee : il
   * suffirait de poser la seance dans la salle la moins surveillee. Une regle
   * de securite qui a plusieurs chemins n'en a aucun.
   *
   * Par RANG, pour la meme raison que le retrait : deux seances peuvent
   * porter le meme titre, et « modifier par titre » en aurait change deux.
   *
   * Pas de plafond a verifier : remplacer ne fait pas grandir la galerie.
   * Rend la seance retenue, ou `null` — et `null` ne touche a rien, plutot
   * que de laisser une entree a moitie effacee derriere lui.
   */
  modifieCinema(salle, i, x) {
    const g = this.galerieCinema(salle);
    const k = Number(i);
    if (!Number.isInteger(k) || k < 0 || k >= g.length) return null;
    const c = Game.seanceCinema(x);
    if (!c) return null;
    g[k] = c;
    return c;
  }

  /**
   * LA PAROLE D'UN JOUEUR, AU-DESSUS DE SA TETE.
   *
   * Rend le texte NETTOYE, pret a partir sur le fil, ou `null` — et `null`
   * veut dire « on ne diffuse rien ». Le refus est muet : ni erreur, ni
   * deconnexion. Repondre « trop vite » a chaque message de trop rendrait le
   * flood rentable, puisqu'il suffirait alors d'inonder pour faire emettre le
   * serveur ; et deconnecter punirait d'un plantage apparent celui dont la
   * page a simplement un doigt lourd.
   *
   * ---- POURQUOI LE NETTOYAGE EST ICI, ET NULLE PART AILLEURS ----
   *
   * Ce texte est ecrit par un joueur et s'affiche sur l'ecran de TOUS les
   * autres. C'est la seule entree du jeu qui ait ces deux proprietes a la
   * fois, et c'est la definition meme d'une entree hostile. La page qui
   * l'envoie ne compte pas : on la remplace en ouvrant une console. La page
   * qui l'AFFICHE ne compte pas non plus, parce qu'elle est ailleurs, dans un
   * autre depot, et qu'une regle repartie sur deux depots finit par ne plus
   * dire la meme chose. Ce qui sort d'ici est ce que trente-neuf ecrans
   * recevront ; il n'y a pas de deuxieme chance en aval.
   */
  dit(addr, texte, now) {
    const t = now || Date.now();
    const propre = Game.textePropre(texte);
    /* Vide apres nettoyage : rien a montrer. On refuse AVANT de compter, sinon
       une page qui envoie des blancs consommerait le droit de parole de son
       joueur sans qu'aucune bulle n'apparaisse jamais. */
    if (!propre) return null;
    if (!addr) return null;
    if (!this._dits) this._dits = new Map();

    /* ---- L'ESPACEMENT ET LA RAFALE, MEME MECANIQUE QU'AUX TABLES ----
     * `duelDire` espace (`PHRASE_PAUSE_MS`) puis plafonne (`PHRASE_MAX`). On
     * fait pareil, a une difference pres : le plafond des tables vaut pour
     * toute une partie, qui finit ; ici rien ne finit, donc le plafond
     * GLISSE sur une fenetre. Un plafond fixe aurait rendu muet a vie le
     * premier joueur bavard. */
    const fenetre = this._dits.get(addr) || [];
    const recents = fenetre.filter((t0) => t - t0 < cfg.DIT_FENETRE_MS);
    if (recents.length && t - recents[recents.length - 1] < cfg.DIT_PAUSE_MS) return null;
    if (recents.length >= cfg.DIT_RAFALE) return null;
    recents.push(t);
    this._dits.set(addr, recents);
    /* La table ne garde que les bavards des quinze dernieres secondes. Sans ce
       balayage elle retiendrait une entree par joueur ayant jamais parle, pour
       toujours — une fuite lente, invisible, qui ne se voit qu'au bout de
       plusieurs mois de service. */
    if (this._dits.size > 512) {
      for (const [a, v] of this._dits)
        if (!v.length || t - v[v.length - 1] >= cfg.DIT_FENETRE_MS) this._dits.delete(a);
    }
    return propre;
  }

  /**
   * CE QU'IL RESTE D'UN TEXTE ECRIT PAR UN JOUEUR.
   *
   * Chaque coupe repond a un probleme precis, et aucune n'est cosmetique :
   *
   *  - LES CARACTERES DE COMMANDE ET LES SAUTS DE LIGNE. La bulle se dessine
   *    sur UNE ligne : un retour chariot la fait deborder du cadre, et les
   *    caracteres de commande traversent tout ce qui ne les attend pas —
   *    journaux, consoles, terminaux.
   *  - LES INVISIBLES ET LES RENVERSEURS DE SENS. U+202E retourne l'ordre
   *    d'affichage de tout ce qui suit : une seule de ces marques suffit a
   *    faire lire a l'envers le nom du joueur d'a cote, et elle ne se voit
   *    pas dans le champ de saisie de celui qui la colle.
   *  - LES DEMI-PAIRES. Un emoji coupe en deux au moment de la troncature
   *    laisse un demi-caractere que la page d'en face n'a aucun moyen
   *    d'afficher. On compte donc en POINTS DE CODE, jamais en unites.
   *  - LES CHEVRONS. Ce texte part sur l'ecran de tout le monde, et la page
   *    qui le dessine vit dans un AUTRE depot : le jour ou elle le pose dans
   *    un `innerHTML` plutot que dans un `textContent`, une balise suffirait.
   *    Le cout est « <3 » qui devient « 3 » ; le prix de l'oubli inverse
   *    est du code execute chez chaque joueur. Ce n'est pas un arbitrage
   *    serre.
   *  - LES BLANCS EN RAFALE. Deux cents espaces sont un texte non vide qui
   *    n'affiche rien : sans cette reduction, une bulle vide s'ouvrirait
   *    au-dessus de la tete d'un joueur toutes les deux secondes.
   *
   * La longueur se compte APRES tout le reste : compter avant aurait laisse
   * passer cent vingt caracteres invisibles, c'est-a-dire une bulle vide qui a
   * l'air pleine aux yeux du serveur.
   */
  /* ================== LES CARTES DESSINEES PAR LES JOUEURS ==================
   *
   * ---- LA PROPRIETE VIT ICI, ET NULLE PART AILLEURS ----
   *
   * « Tout le monde peut visiter, personne d'autre ne peut modifier. » La
   * seconde moitie de cette phrase est une regle de SERVEUR. Griser un bouton
   * dans la page ne garde rien : il se degrise dans une console en dix
   * secondes, et le message part quand meme. C'est la meme raison qui met le
   * score du blackjack ici et pas dans le navigateur.
   * Chaque carte porte donc l'adresse de son auteur, et toute ecriture la
   * compare a celle qui demande. Un refus, jamais un rabattement silencieux.
   *
   * ---- UN SEUL ENTONNOIR ----
   *
   * `Game.carteValide` est le seul endroit ou une carte devient acceptable.
   * Creer, enregistrer, renommer : les trois passent par lui. Deux chemins de
   * validation finissent toujours par ne plus verifier la meme chose, et c'est
   * celui qu'on a oublie qui recoit les envois interessants — la galerie des
   * seances a deja paye cette lecon.
   *
   * ---- LE FORMAT, ET CE QU'IL PREVOIT ----
   *
   * Une case vaut { c, l, s, o } : colonne, ligne, cle de sol, cle d'objet.
   * Des noms d'une lettre parce qu'il y en a jusqu'a trente-deux mille dans un
   * envoi, et que « colonne » repete trente-deux mille fois pese plus que la
   * carte.
   * Les cles ne sont PAS verifiees contre une liste d'elements. C'est
   * volontaire : le catalogue vit dans l'autre depot, il change a chaque
   * planche livree, et un serveur qui en tiendrait une copie refuserait un
   * jour une carte parfaitement valide parce que sa liste a lui n'a pas suivi.
   * On verifie donc la FORME — des minuscules, des chiffres, un souligne, au
   * plus trente-deux — et la page ne dessine que ce qu'elle connait. Une carte
   * qui nomme une planche disparue perd un dessin ; elle ne casse rien.
   * Le jour ou la 2,5D arrive, une case gagnera une hauteur sans qu'aucune
   * carte deja enregistree n'ait a etre convertie.
   */
  static cleElement(v) {
    const t = String(v == null ? '' : v).trim();
    if (!t) return null;
    /* VINGT-QUATRE, et ce n'est pas un chiffre rond pris au hasard : la plus
       longue cle du catalogue fait vingt (`pet_shiba_legendaire`), et c'est la
       longueur de cle qui decide de ce qu'une carte pleine PESE — voir le
       calcul dans config.js. Chaque caractere autorise ici retire des cases a
       la carte la plus grande qu'on puisse envoyer. */
    return /^[a-z0-9_]{1,24}$/.test(t) ? t : null;
  }

  /* ---- LES DEUX FACONS DE DESSINER UNE CARTE ----
   *
   * `plat` : une grille de tuiles vue de dessus, ce que l'editeur fait depuis
   * le premier jour. `iso` : des PARCELLES vues de trois quarts, posees sur un
   * fond, chacune portant son propre terrain.
   *
   * Le serveur garde ce choix et ne fait rien d'autre avec. Il ne verifie PAS
   * qu'une carte `iso` ne contient que des parcelles : cela demanderait de
   * connaitre le catalogue, qui vit dans l'autre depot et change a chaque
   * planche livree — le meme raisonnement que pour les cles d'elements, juste
   * au-dessus. Le serveur garde l'INTEGRITE, la page garde la coherence.
   *
   * Deux valeurs et pas un booleen : le jour ou une troisieme facon arrive,
   * elle s'ajoute a cette liste, et les cartes deja enregistrees ne bougent
   * pas. `plat` par defaut, parce que c'est ce que sont toutes les cartes
   * ecrites avant ce champ — un defaut qui les convertirait serait une
   * migration silencieuse.
   */
  static get CARTE_MODES() { return ['plat', 'iso']; }

  /* ---- COMBIEN DE NOMS DISTINCTS UNE CARTE PEUT PORTER ----
   * Le catalogue en compte cent quarante-quatre en tout, familles confondues.
   * Deux cent cinquante-six laisse la place a tout ce qui existe et a tout ce
   * qui vient, et garde l'indice sur trois caracteres au plus — c'est de la
   * que vient l'economie. Une palette plus longue est TRONQUEE plutot que
   * refusee : les cases qui pointaient au-dela perdent leur nom et se font
   * ecarter comme n'importe quelle case vide, sans emporter la carte. */
  static get CARTE_PALETTE_MAX() { return 256; }

  /*
   * LA CARTE, EN INDICES PLUTOT QU'EN NOMS.
   *
   * `{"c":59,"l":59,"s":"cendres"}` fait 28 octets, et jusqu'a 78 si les cles
   * vont au bout de ce que le reglement autorise. `[59,59,4]` en fait onze.
   * Sur trois mille six cents cases — le Nexus — c'est la difference entre
   * deux cent quatre-vingt-un kilo-octets et soixante-cinq, c'est-a-dire entre
   * une carte que la socket jette et une carte qui passe quatre fois.
   *
   * Les OBJETS ne sont pas compactes : ils sont vingt fois moins nombreux et
   * portent chacun jusqu'a huit champs facultatifs. Les compacter aurait
   * demande une position pour chaque champ, donc un format a faire evoluer a
   * chaque champ nouveau — pour economiser un vingtieme du poids.
   *
   * On ne compacte QUE si l'on y gagne : sous quelques dizaines de cases, la
   * palette coute plus que les noms qu'elle remplace.
   */
  static carteCompacte(carte) {
    if (!carte || !Array.isArray(carte.cases)) return carte;
    if (carte.cases.length < 40) return carte;
    const pal = [];
    const rang = new Map();
    const idx = (k) => {
      if (!k) return -1;
      if (rang.has(k)) return rang.get(k);
      if (pal.length >= Game.CARTE_PALETTE_MAX) return -1;
      rang.set(k, pal.length); pal.push(k);
      return pal.length - 1;
    };
    const cases = [];
    for (const q of carte.cases) {
      const is = idx(q.s), io = idx(q.o);
      /* Une case dont le nom n'a pas trouve de place dans la palette repart
         NOMMEE : la tronquer silencieusement ferait un trou dans le sol. */
      if ((q.s && is < 0) || (q.o && io < 0)) { cases.push(q); continue; }
      cases.push(io >= 0 ? [q.c, q.l, is, io] : [q.c, q.l, is]);
    }
    return Object.assign({}, carte, { pal, cases });
  }

  /* ---- L'IMAGE JOINTE A LA CARTE ----
   *
   * Une adresse `data:` ecrite par un inconnu et posee telle quelle dans un
   * `src` : c'est le genre de champ ou l'on se fait avoir. Deux regles, et
   * chacune contre quelque chose de precis.
   *
   * LE TYPE EST BLANC-LISTE. `image/webp` et `image/png`, rien d'autre — et
   * surtout PAS `image/svg+xml`, qui est du document, pas de l'image : un SVG
   * pose dans un `src` peut porter du script. On ne se contente donc pas
   * d'interdire le SVG, on n'autorise que deux formats connus, pour que le
   * troisieme format a la mode ne passe pas par defaut.
   *
   * LA TAILLE EST BORNEE. Sans plafond, l'image devient le moyen de garder ce
   * qu'on veut sur notre disque, sous couvert de vignette.
   *
   * On ne DECODE pas : le serveur ne sait pas lire une image et n'a pas a
   * apprendre. Une base64 valide qui n'est pas une image ne se dessinera pas
   * chez celui qui la regarde, et c'est tout ce qu'elle fera.
   */
  static vignetteValide(v) {
    if (v === undefined || v === null) return null;
    const t = String(v);
    if (t.length > cfg.CARTE_VIGNETTE_MAX) return null;
    return /^data:image\/(webp|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(t) ? t : null;
  }

  static carteValide(x, impose) {
    const nom = Game.textePropre(x && x.nom).slice(0, cfg.CARTE_NOM_MAX);
    if (!nom) return null;
    /* ---- CE QUE LA CARTE IMPOSE A SON PROPRE ENREGISTREMENT ----
     * A la creation, le cote et le mode viennent de l'envoi. A la mise a
     * jour, ils viennent de la CARTE DEJA ENREGISTREE, et ce n'est pas un
     * detail de politesse : les cases sont bornees par le cote, et valider
     * un envoi de quarante-huit pour une carte de seize aurait accepte des
     * cases hors de la carte — jetees au passage suivant, sans que rien ne
     * l'ait dit. Le champ qui borne et le champ qui est borne doivent etre
     * le meme. */
    const cote = impose && impose.cote ? Math.round(Number(impose.cote))
                                       : Math.round(Number((x && x.cote) || 0));
    if (!Number.isInteger(cote) || cote < 4 || cote > cfg.CARTE_COTE) return null;
    const voulu = String((impose && impose.mode) || (x && x.mode) || 'plat');
    const mode = Game.CARTE_MODES.indexOf(voulu) >= 0 ? voulu : 'plat';
    /* ---- LES CASES ARRIVENT NOMMEES, OU EN INDICES ----
     *
     * Une case nommee pese jusqu'a 78 octets ; la meme en indices en pese 18.
     * Une carte de soixante de cote ne tient dans la trame que sous la seconde
     * forme, et c'est ce qui a ouvert le Nexus a l'editeur.
     *
     * Les deux formes entrent par la MEME porte : on developpe la compacte
     * ici, en tete, et pas une ligne de la validation ne sait laquelle est
     * arrivee. L'alternative — deux chemins de validation — aurait fini par
     * n'appliquer les memes regles qu'a l'un des deux, et c'est toujours celui
     * qu'on regarde le moins qui laisse passer.
     *
     * L'ancienne forme n'est PAS retiree, et ne le sera pas : une page qui n'a
     * pas recharge l'envoie toujours, et refuser ses cartes mettrait dehors
     * exactement ceux qui ne sauraient pas pourquoi. Elle garde son propre
     * plafond, plus bas — voir `CARTE_CASES_NOMMEES` : ce qu'un format permet
     * doit tenir dans le tuyau, sinon le refus arrive sans un mot. */
    const pal = Array.isArray(x && x.pal) ? x.pal.slice(0, Game.CARTE_PALETTE_MAX) : null;
    const brut = Array.isArray(x && x.cases) ? x.cases : null;
    if (!brut) return null;
    if (brut.length > cfg.CARTE_CASES) return null;
    /* Le plafond de l'ancienne forme se mesure sur les cases NOMMEES qu'elle
       contient, et non sur la longueur de l'envoi : une carte compacte qui
       porterait quelques cases nommees n'est pas une carte nommee. */
    if (!pal && brut.length > cfg.CARTE_CASES_NOMMEES) return null;
    const nomme = (b) => {
      if (!Array.isArray(b)) return b;
      if (!pal) return null;
      /* `[c, l, iSol]` ou `[c, l, iSol, iObjet]`. Un indice hors palette rend
         `undefined`, que `cleElement` refuse comme le reste : une case sans
         sol ni objet est ecartee plus bas, elle ne casse rien. */
      const e = { c: b[0], l: b[1] };
      if (b[2] != null && b[2] >= 0) e.s = pal[b[2]];
      if (b[3] != null && b[3] >= 0) e.o = pal[b[3]];
      return e;
    };
    /* ---- UNE CASE PAR COORDONNEE, LA DERNIERE GAGNE ----
     * Rien n'empeche un envoi de porter deux fois la meme case. Les garder
     * toutes ferait grossir la carte sans rien changer a ce qu'on voit, et
     * deux dessins superposes sur une case sont une facon simple de depasser
     * le plafond en le respectant. */
    /* ---- L'EMPRISE ET LE QUART DE TOUR, ECRITS PAR CELUI QUI POSE ----
     * Une parcelle isometrique couvre plusieurs cases. Le serveur ne peut pas
     * le deduire : la largeur des planches vit dans le catalogue de l'autre
     * depot. Il la RECOIT donc, bornee, de la page qui a decide ou dessiner —
     * et c'est la meme page qui la redessinera, donc le dessin et la collision
     * ne peuvent pas se contredire. Le pire qu'un envoi truque puisse faire
     * est de bloquer sa PROPRE carte.
     * Bornee par le DOUBLE du cote : un fond doit pouvoir couvrir la carte et
     * deborder — sinon on voit ses bords — mais rien au-dela n'a de sens.
     * Les valeurs par defaut ne s'ecrivent pas. */
    const empMax = Math.min(cfg.CARTE_EMPRISE_MAX, cote * 2);
    const empMin = Math.max(0.01, Number(cfg.CARTE_EMPRISE_MIN) || 0.25);
    const garnis = (e, b) => {
      /* ---- L'EMPRISE SE COMPTE AU CENTIEME DE CASE ----
       * Elle etait un nombre ENTIER de cases : d'une case a deux, du simple
       * au double, et rien entre les deux. Le proprietaire a demande plus de
       * finesse — c'est exactement la meme demande que pour l'angle, et elle
       * se regle de la meme facon.
       * PAS DE MIGRATION : un entier reste un entier valide, les cartes deja
       * enregistrees et les pages qui n'ont pas recharge n'y perdent rien. Le
       * champ n'a pas change de sens, il a gagne deux decimales.
       * Ecrit des qu'il vaut autre chose qu'UNE case — et non « plus d'une » :
       * une demi-case est desormais une taille, et ne pas l'ecrire la
       * ramenerait a une case entiere au prochain chargement. */
      const emp = Math.round(Number(b.n) * 100) / 100;
      if (Number.isFinite(emp) && emp >= empMin && emp <= empMax && emp !== 1) e.n = emp;
      /* ---- L'ANGLE EST EN DEGRES ----
       * C'etaient des quarts de tour, parce qu'une planche de pixels tournee
       * de dix-sept degres est floue. C'est toujours vrai, et le proprietaire
       * a quand meme voulu regler finement : c'est son dessin, et le flou est
       * une chose qu'il voit. On garde donc trois cent soixante positions.
       * `a`, l'ancien champ, entre par la meme porte et vaut quatre-vingt-dix
       * degres par unite — les cartes deja enregistrees et les pages qui n'ont
       * pas recharge n'y perdent rien. */
      const deg = Math.round(Number(b.g));
      if (Number.isInteger(deg) && deg > 0 && deg < 360) e.g = deg;
      else {
        const tour = Math.round(Number(b.a));
        if (Number.isInteger(tour) && tour > 0 && tour < 4) e.g = tour * 90;
      }
      /* ---- ET LE DECALAGE, EN CENTIEMES DE CASE ----
       * Un element se pose sur une case. Pour COMPOSER — coller un toit sur
       * un mur, decaler une passerelle d'un demi-pas — il faut pouvoir sortir
       * de la grille sans en changer. Une case de part et d'autre suffit :
       * au-dela, on deplace l'element, on ne le decale plus. */
      const px = Math.round(Number(b.dx));
      if (Number.isInteger(px) && px !== 0 && Math.abs(px) <= 100) e.dx = px;
      const py = Math.round(Number(b.dy));
      if (Number.isInteger(py) && py !== 0 && Math.abs(py) <= 100) e.dy = py;
      /* ---- LE MIROIR : LE SEUL AUTRE AXE QU'UNE IMAGE PLATE POSSEDE ----
       * Une planche n'a pas de troisieme dimension : la faire tourner autour
       * de sa verticale ou de son horizontale, c'est la RETOURNER. Un bit
       * pour chaque — un pour la gauche-droite, deux pour le haut-bas — et
       * les deux ensemble font un demi-tour, ce qui est coherent et se
       * verifie.
       * Et c'est le seul retournement qui ne FLOUTE RIEN : un miroir echange
       * des pixels, il n'en invente aucun, la ou un angle libre les
       * interpole. */
      const mir = Math.round(Number(b.m));
      if (Number.isInteger(mir) && mir > 0 && mir < 4) e.m = mir;
      /* ---- LE VERROU ----
       * Il n'a AUCUN effet sur le monde : un element verrouille se dessine et
       * bloque exactement comme les autres. Il ne parle qu'a l'editeur, pour
       * qu'un decor de fond ne parte pas sous la main quand on travaille ce
       * qui est pose dessus.
       * Il est garde quand meme cote serveur : sans cela, il faudrait tout
       * reverrouiller a chaque ouverture, et le reglage ne servirait a rien.
       * Un seul etat, donc UN, et jamais autre chose : `v: 7` ne veut rien
       * dire et ouvrirait la porte a un champ qui prend un sens plus tard. */
      if (b.v === 1 || b.v === true) e.v = 1;
      return e;
    };
    const par = new Map();
    const objets = [];
    for (const brute of brut) {
      const b = nomme(brute);
      if (!b || typeof b !== 'object') continue;
      const c = Math.round(Number(b.c)), l = Math.round(Number(b.l));
      if (!Number.isInteger(c) || !Number.isInteger(l)) continue;
      if (c < 0 || l < 0 || c >= cote || l >= cote) continue;
      const sol = Game.cleElement(b.s), obj = Game.cleElement(b.o);
      /* Une case qui ne porte NI sol NI objet ne dit rien : la garder
         reviendrait a transmettre du vide au prix d'une case. */
      if (!sol && !obj) continue;
      if (sol) par.set(c + ',' + l, { c, l, s: sol });
      /* ---- L'ANCIEN FORMAT ENTRE PAR LA MEME PORTE ----
       * Une case portait son objet. Les cartes deja enregistrees, et les pages
       * qui n'ont pas encore recharge, l'envoient toujours ainsi : on le
       * transforme en objet de couche zero au lieu de le jeter. Une migration
       * qui refuserait l'ancien format mettrait dehors tous ceux qui n'ont pas
       * recharge, et ce sont precisement ceux qui ne savent pas pourquoi. */
      if (obj) objets.push(garnis({ c, l, k: obj, z: 0 }, b));
    }
    /* ---- ET LES OBJETS, QUI SONT UNE LISTE ----
     * Plusieurs au meme endroit, chacun sur sa couche : c'est ce qui permet de
     * poser une maison sur un chemin sur un sol, et de dire lequel passe
     * devant. */
    const bruts = Array.isArray(x && x.objets) ? x.objets : [];
    if (bruts.length > cfg.CARTE_OBJETS) return null;
    for (const b of bruts) {
      if (!b || typeof b !== 'object') continue;
      const c = Math.round(Number(b.c)), l = Math.round(Number(b.l));
      if (!Number.isInteger(c) || !Number.isInteger(l)) continue;
      if (c < 0 || l < 0 || c >= cote || l >= cote) continue;
      const k2 = Game.cleElement(b.k);
      if (!k2) continue;
      const z = Math.round(Number(b.z));
      const couche = (Number.isInteger(z) && z >= 0 && z < cfg.CARTE_COUCHES) ? z : 0;
      objets.push(garnis({ c, l, k: k2, z: couche }, b));
    }
    /* Le plafond vaut pour le TOTAL, ancien format compris : sinon on le
       doublerait en envoyant la moitie par chaque porte. */
    if (objets.length > cfg.CARTE_OBJETS) objets.length = cfg.CARTE_OBJETS;
    /* ---- OU L'ON ARRIVE QUAND ON Y ENTRE ----
     * Un point, pas un element : ce n'est pas quelque chose qu'on dessine,
     * c'est une propriete de la carte. Range dans une case, il aurait fallu
     * lui inventer une cle reservee — et le jour ou un element du catalogue
     * porte le meme nom, l'un des deux disparait.
     * Absent tant qu'il n'est pas pose : une carte sans depart n'est pas
     * invalide, elle n'est simplement pas encore jouable, et le dire est le
     * travail de la page, pas un refus ici. */
    let depart = null;
    if (x && x.depart) {
      const dc = Math.round(Number(x.depart.c)), dl = Math.round(Number(x.depart.l));
      if (Number.isInteger(dc) && Number.isInteger(dl)
          && dc >= 0 && dl >= 0 && dc < cote && dl < cote) depart = { c: dc, l: dl };
    }
    const carte = { nom, cote, mode, depart, cases: [...par.values()], objets };
    /* Absente et refusee ne se distinguent pas ici : dans les deux cas la
       carte n'en porte pas, et la fiche retombe sur son texte. Refuser la
       carte ENTIERE pour une vignette trop lourde ferait perdre le dessin
       pour une image de deux centimetres. */
    const vg = Game.vignetteValide(x && x.vignette);
    if (vg) carte.vignette = vg;
    return carte;
  }

  /* ---- UN REFUS SE DIT DANS LA LANGUE DE CELUI QUI LE LIT ----
   *
   * Les raisons sont ecrites en francais, comme tout ce depot. La page, elle,
   * parle trois langues depuis que les drapeaux existent — et un joueur
   * espagnol lisant « cette carte n est pas la votre » n'apprend rien.
   *
   * Le serveur ne traduit pas : traduire demanderait de tenir trois listes
   * ici ET trois dans la page, et la quatrieme langue en demanderait six. Il
   * envoie un CODE stable a cote du texte. La page traduit ce qu'elle
   * connait et retombe sur le texte pour le reste — degrade, jamais muet.
   */
  static codeDuRefus(raison) {
    const T = {
      'carte invalide': 'invalide',
      'carte inconnue': 'inconnue',
      'plafond de cartes atteint': 'plafond',
      'cette carte n est pas la votre': 'pasLaVotre',
    };
    return T[raison] || null;
  }

  /**
   * UNE CARTE DE L'ANCIEN FORMAT, RAMENEE AU NOUVEAU.
   *
   * Les objets vivaient DANS la case, un par case. Ils vivent maintenant dans
   * une liste, ce qui permet d'en poser plusieurs au meme endroit et de dire
   * lequel passe devant. Les cartes deja enregistrees, elles, portent encore
   * l'ancien format.
   *
   * On les convertit A LA LECTURE de la sauvegarde, une fois, plutot que de
   * laisser les deux formats se cotoyer : deux formats vivants, c'est deux
   * chemins a tenir d'accord dans le dessin, dans la collision, dans le
   * plafond — et c'est celui qu'on oublie qui perd le travail de quelqu'un.
   * Ecrit ici et pas dans `carteValide` parce que ce n'est pas une validation :
   * rien n'est refuse, tout est traduit.
   */
  static carteMigree(k) {
    if (!k || !Array.isArray(k.cases)) return k;
    if (Array.isArray(k.objets)) {
      /* Les quarts de tour d'une carte enregistree AVANT les degres. Une
         seule passe, et `a` disparait : deux champs d'angle vivants, ce sont
         deux endroits ou lire l'orientation, et c'est celui qu'on oublie qui
         dessine de travers. */
      for (const o of k.objets) {
        if (o && o.a !== undefined) { if (o.a) o.g = o.a * 90; delete o.a; }
      }
      return k;
    }
    const sols = [], objets = [];
    for (const q of k.cases) {
      if (!q) continue;
      if (q.s) sols.push({ c: q.c, l: q.l, s: q.s });
      if (q.o) {
        const o = { c: q.c, l: q.l, k: q.o, z: 0 };
        if (q.n && q.n !== 1) o.n = q.n;
        /* Le quart de tour de l'ancien format devient un angle. */
        if (q.a) o.g = q.a * 90;
        objets.push(o);
      }
    }
    k.cases = sols; k.objets = objets;
    return k;
  }

  /** Les cartes d'un compte. Toujours une liste, jamais `null`. */
  mesCartes(addr) {
    return this.cartes.filter((k) => k.addr === addr);
  }
  /** Une carte par son numero, quel qu'en soit l'auteur : tout le monde visite. */
  carte(id) {
    const k = Number(id);
    return this.cartes.find((q) => q.id === k) || null;
  }
  /**
   * ENREGISTRE. Cree si `id` est absent, remplace sinon.
   * Rend la carte, ou une chaine qui DIT pourquoi c'est refuse — un `null`
   * unique aurait laisse la page annoncer « erreur » sans savoir laquelle,
   * et le joueur perd son dessin sans comprendre.
   */
  enregistreCarte(addr, id, x) {
    if (id === undefined || id === null || id === '') {
      const c = Game.carteValide(x);
      if (!c) return 'carte invalide';
      if (this.mesCartes(addr).length >= cfg.CARTES_PAR_COMPTE) return 'plafond de cartes atteint';
      const k = { id: this.cartesNo++, addr, nom: c.nom, cote: c.cote, mode: c.mode,
                  cases: c.cases, objets: c.objets, depart: c.depart,
                  vignette: c.vignette || null,
                  cree: Date.now(), modifie: Date.now() };
      this.cartes.push(k);
      return k;
    }
    /* ---- LA CARTE D'ABORD, LA VALIDATION ENSUITE ----
     * L'ordre inverse validait l'envoi contre le cote QU'IL DECLARE, puis
     * gardait celui de la carte : une carte de seize recevait alors des cases
     * bornees a quarante-huit. */
    const k = this.carte(id);
    if (!k) return 'carte inconnue';
    /* LA LIGNE QUI PORTE TOUTE LA REGLE. */
    if (k.addr !== addr) return 'cette carte n est pas la votre';
    const c = Game.carteValide(x, { cote: k.cote, mode: k.mode || 'plat' });
    if (!c) return 'carte invalide';
    /* ---- LE MODE ET LE COTE NE CHANGENT PAS APRES COUP ----
     * Ils se choisissent a la creation. Les laisser changer a
     * l'enregistrement permettrait de retrecir une carte sous ses propres
     * cases — elles seraient toutes hors bornes et jetees au passage suivant,
     * sans que rien ne l'ait dit — et de declarer « isometrique » une carte
     * pleine de tuiles plates, qui ne se dessinerait plus comme elle a ete
     * faite. On garde donc ce que la carte a toujours eu ; `plat` pour celles
     * ecrites avant que ce champ n'existe. */
    k.nom = c.nom; k.cases = c.cases; k.objets = c.objets;
    k.depart = c.depart; k.modifie = Date.now();
    /* L'ANCIENNE image reste si le nouvel envoi n'en porte pas. Un client qui
       ne sait pas en fabriquer — ou dont l'image depasse le plafond — ne doit
       pas EFFACER celle qui etait la : la fiche perdrait son dessin a un
       enregistrement sans rapport. */
    if (c.vignette) k.vignette = c.vignette;
    if (!k.mode) k.mode = 'plat';
    return k;
  }
  supprimeCarte(addr, id) {
    const k = this.carte(id);
    if (!k) return 'carte inconnue';
    if (k.addr !== addr) return 'cette carte n est pas la votre';
    this.cartes = this.cartes.filter((q) => q !== k);
    return k;
  }
  /**
   * LA VITRINE. Ce que tout le monde voit : de quoi choisir une carte a
   * visiter, sans son contenu — une galerie qui enverrait trente-deux mille
   * cases par carte serait injouable des la dixieme.
   */
  vitrineCartes(addr) {
    /* Les siennes d'abord, puis les plus recentes des autres jusqu'au
       plafond. Trier tout le monde ensemble et couper aurait fait disparaitre
       les cartes de celui qui n'a pas dessine depuis longtemps — les siennes,
       justement, celles qu'il vient chercher. */
    const miennes = this.cartes.filter((k) => k.addr === addr);
    const autres = this.cartes.filter((k) => k.addr !== addr)
      .sort((a, b) => b.modifie - a.modifie)
      .slice(0, Math.max(0, cfg.CARTES_VITRINE - miennes.length));
    return miennes.concat(autres).map((k) => ({
      id: k.id, nom: k.nom, cote: k.cote, mode: k.mode || 'plat',
      /* Ce qu'on a POSE, sols et objets confondus : c'est le travail que la
         fiche annonce, pas un detail de format. */
      cases: k.cases.length + ((k.objets && k.objets.length) || 0),
      vignette: k.vignette || null,
      /* Le point de depart ne voyage pas entier dans la vitrine : ce qu'on
         veut y lire est « peut-on y aller », pas « ou ». */
      jouable: !!k.depart,
      modifie: k.modifie, mienne: k.addr === addr,
      auteur: (this.players.get(k.addr) && this.players.get(k.addr).name) || null,
    })).sort((a, b) => b.modifie - a.modifie);
  }

  static textePropre(v) {
    let t = String(v == null ? '' : v);
    /* Commandes, sauts de ligne, et les deux separateurs de ligne Unicode que
       personne ne pense a couper parce qu'ils ne ressemblent pas a un \n. */
    t = t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    /* Invisibles, marques de direction, renverseurs de sens. */
    t = t.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g, '');
    /* Les demi-paires arrivees telles quelles dans le message. */
    t = t.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '');
    t = t.replace(/(^|[^\ud800-\udbff])([\udc00-\udfff])/g, '$1');
    t = t.replace(/[<>]/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, cfg.DIT_MAX).join('').trim();
  }

  /** L'etat COMPLET, tete et fiches. L'export, l'import et l'instantane de
   *  secours passent par la ; la sauvegarde courante, non. */
  serialize() {
    const players = [];
    let vides = 0;
    for (const addr of this.players.keys()) {
      const f = this.fiche(addr);
      if (!f) { vides++; continue; }
      players.push([addr, f]);
    }
    if (vides > 100) console.log(`[store] ${vides} fiche(s) vide(s) non ecrite(s)`);
    const tete = this.serializeTete();
    tete.players = players;
    return tete;
  }

  /** Restore a snapshot produced by serialize() (called once at startup). */
  /**
   * REMPLACE tout l'etat par celui d'une archive. C'est la restauration.
   *
   * ---- pourquoi ce n'est pas hydrate() ----
   *
   * hydrate() AJOUTE : il pose les fiches de l'archive par-dessus celles qui
   * sont deja en memoire. C'est ce qu'il faut au demarrage — la memoire est
   * vide. Ce n'est surtout pas ce qu'il faut pour une restauration : les
   * joueurs qui existent aujourd'hui mais pas dans l'archive resteraient la,
   * avec leur solde d'aujourd'hui, melanges a des soldes d'hier. On croirait
   * avoir restaure ; on aurait fabrique un etat qui n'a jamais existe.
   *
   * On construit donc une instance NEUVE, on l'hydrate, et on transplante ses
   * champs un par un. Tout ce qui existe sur un Game frais est remplace, donc
   * rien de l'ancien ne survit par oubli — pas meme un champ ajoute plus tard
   * dont on aurait oublie de s'occuper ici.
   */
  remplace(st) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.players))
      throw new Error('this file is not a SWOGE state (no players list)');
    const neuf = new Game();
    neuf.hydrate(st);
    const avant = this.players.size;
    for (const k of Object.keys(this)) delete this[k];
    for (const k of Object.keys(neuf)) this[k] = neuf[k];
    return { avant, apres: this.players.size };
  }

  hydrate(st) {
    if (!st) return;
    /* Le secret fixe par l'environnement l'emporte : c'est ainsi qu'on revoque
       toutes les sessions d'un coup, en le changeant sur le serveur. */
    if (st.sessionSecret && !cfg.SESSION_SECRET) this.sessionSecret = st.sessionSecret;
    /* Sans cette ligne, un redemarrage remettrait tous les compteurs a zero
       et les plafonds ne borneraient plus rien — le pire des defauts
       silencieux : la boutique continuerait de fonctionner. */
    if (st.taps && typeof st.taps === 'object') this.taps = st.taps;
    /* Les annonces DOIVENT traverser une sauvegarde : l'objet a quitte
       l'inventaire du vendeur. Les perdre, c'est les detruire. */
    if (Array.isArray(st.marche)) this.marche = st.marche;
    if (st.marcheNo) this.marcheNo = st.marcheNo;
    /* ---- LES CARTES, ET LE COMPTEUR RECALCULE SI BESOIN ----
     * Le compteur est relu, mais on ne LUI FAIT PAS CONFIANCE seul : une
     * sauvegarde ecrite avant qu'il existe n'en porte pas, et repartir a un
     * donnerait a la prochaine carte le numero d'une carte deja la — qui
     * serait alors ecrasee au premier enregistrement. On le remonte donc
     * au-dessus du plus grand numero present, toujours. */
    if (Array.isArray(st.cartes)) this.cartes = st.cartes.map(Game.carteMigree);
    this.cartesNo = Math.max(Number(st.cartesNo) || 1,
                             ...this.cartes.map((k) => (Number(k.id) || 0) + 1), 1);
    if (st.boutiqueEmis && typeof st.boutiqueEmis === 'object') this.boutiqueEmis = st.boutiqueEmis;
    if (st.skinsEmis && typeof st.skinsEmis === 'object') this.skinsEmis = st.skinsEmis;
    /* Sans cette ligne, un redemarrage ROUVRIRAIT la course et repaierait
       quatre-vingt-dix millions, sans rien afficher d'anormal. */
    if (Array.isArray(st.boutiqueLignes)) this.boutiqueLignes = st.boutiqueLignes;
    if (st.serverSeed) { this.serverSeed = st.serverSeed; this.serverSeedHash = crypto.createHash('sha256').update(st.serverSeed).digest('hex'); }
    /* Les graines revelees survivent a tout : elles sont la SEULE facon pour
       un joueur de verifier une manche d'il y a six mois. Les perdre au
       redemarrage reviendrait a retirer la preuve apres l'avoir donnee. */
    if (st.compta) this.compta = st.compta;
    if (st.usage) this.usage = st.usage;
    /* ================== LA RELECTURE ACCEPTE TROIS FORMES ==================
     *
     * C'est le bloc qui compte le plus de tout ce chantier. Le proprietaire a
     * des seances ENREGISTREES EN PRODUCTION. Une relecture qui ne connaitrait
     * que la forme du jour les effacerait au premier redemarrage — sans
     * erreur, sans trace, et personne ne le verrait avant d'avoir traverse le
     * hall pour trouver un ecran eteint.
     *
     *  1. LA FORME DU JOUR : un objet range par cle de salle,
     *     { cinema: [...], manga: [...] }.
     *
     *  2. ACCOMMODATION DATEE 2026-08-23 — `cinemas`, UNE LISTE. C'est la
     *     forme du temps ou il n'y avait qu'une salle. Elle devient la galerie
     *     du CINEMA : ces seances ont ete posees pour le cinema, elles n'ont
     *     jamais eu d'autre salle. Elle s'en va quand plus aucune sauvegarde
     *     en service ne la porte.
     *
     *  3. ACCOMMODATION DATEE 2026-08-23 — `cinema`, UN OBJET UNIQUE. La toute
     *     premiere forme, du temps ou l'on ne pouvait annoncer qu'une chose a
     *     la fois. Elle devient une galerie D'UN ELEMENT dans le cinema.
     *
     * On ne revalide pas ce qui remonte : ces seances sont deja passees par le
     * filtre le jour ou elles ont ete posees, et les refuser ici ferait perdre
     * a la relecture ce que l'enregistrement avait accepte.
     *
     * Une salle absente de la table est LAISSEE DE COTE : la table est la
     * seule verite, et garder la galerie d'une salle qui n'existe plus la
     * ferait partir sur le fil vers des pages qui n'en savent rien. */
    if (!this.cinemas || typeof this.cinemas !== 'object' || Array.isArray(this.cinemas))
      this.cinemas = Game.galeriesVides();
    const HERITEE = Game.salleEcran('cinema') || ((cfg.SALLES_ECRAN || [])[0] || {}).cle;
    if (st.cinemas && !Array.isArray(st.cinemas) && typeof st.cinemas === 'object') {
      for (const sa of (cfg.SALLES_ECRAN || [])) {
        const v = st.cinemas[sa.cle];
        if (Array.isArray(v)) this.cinemas[sa.cle] = v.filter((c) => c && c.titre);
      }
    } else if (Array.isArray(st.cinemas)) {
      if (HERITEE) this.cinemas[HERITEE] = st.cinemas.filter((c) => c && c.titre);
    } else if (st.cinema && st.cinema.titre) {
      if (HERITEE) this.cinemas[HERITEE] = [st.cinema];
    }
    if (Array.isArray(st.paris)) this.paris = st.paris;
    if (st.parisRegles) this.parisRegles = st.parisRegles;
    if (st.parisSeq) this.parisSeq = st.parisSeq;
    if (Array.isArray(st.dons)) this.dons = st.dons;
    if (st.tunnel) this.tunnel = st.tunnel;
    if (st.prixVerses) this.prixVerses = st.prixVerses;
    if (st.prixMondeVerses) this.prixMondeVerses = st.prixMondeVerses;
    if (Array.isArray(st.graines)) this.graines = st.graines;
    if (st.graineDepuis) this.graineDepuis = st.graineDepuis;
    if (st.manchesGraine) this.manchesGraine = st.manchesGraine;
    if (st.jackpotPot) this.jackpotPot = ethers.BigNumber.from(st.jackpotPot);
    /* La cagnotte se relit telle quelle, meme a zero — un `if (st.boulierPot)`
       la remettrait a un million au premier redemarrage suivant un plein, et
       la maison offrirait le cadeau d'ouverture a chaque deploiement. */
    if (st.boulierPot !== undefined && st.boulierPot !== null)
      this.boulierPot = ethers.BigNumber.from(st.boulierPot);
    if (Array.isArray(st.boulierPleins)) this.boulierPleins = st.boulierPleins;
    /* La salle reprend son NUMERO DE MAILLON, pas ses joueurs. Un maillon
       rejoue serait deux manches identiques ; une manche a moitie inscrite dont
       tout le monde a ete deconnecte n'a plus d'arbitre. La fenetre
       d'inscription dure dix secondes, l'exposition est donc de dix secondes —
       la meme que celle du Crash, qui fait pareil depuis toujours. */
    if (st.boulierSalle) this.boulierSalle.charge(st.boulierSalle);
    /* La graine d'environnement l'emporte, comme pour le secret de session :
       c'est ainsi qu'on repart sur une chaine neuve volontairement. Sinon on
       reprend celle de l'etat, et l'index sauve evite de rejouer un maillon
       deja consomme — le meme maillon deux fois, ce serait la meme manche. */
    if (st.crashGraine && !cfg.CRASH_GRAINE) { this.crashGraine = st.crashGraine; this._crashTable(); }
    if (st.crash) this.crash.charge(st.crash);
    if (st.lastBlock) this.lastBlock = st.lastBlock;
    if (st.betLastBlock) this.betLastBlock = st.betLastBlock;
    if (Array.isArray(st.seenTx)) this.seenTx = new Set(st.seenTx);
    if (st.fraisCumules) this.fraisCumules = ethers.BigNumber.from(st.fraisCumules);
    if (st.brule) this.brule = ethers.BigNumber.from(st.brule);
    if (Array.isArray(st.brulages)) this.brulages = st.brulages;
    if (Array.isArray(st.players)) for (const [addr, d] of st.players) {
      this.players.set(addr, {
        balance: ethers.BigNumber.from(d.b || '0'),
        cumulativeAuthorized: ethers.BigNumber.from(d.c || '0'),
        /* ---- LA MIGRATION SUPPOSE QUE LE PASSE EST ENCAISSE ----
         * Les fiches ecrites avant ce champ n'en ont pas. Repartir de leur
         * cumul entier compterait comme « en attente » tous les retraits deja
         * presentes depuis l'ouverture, et le surplus s'effondrerait d'un coup
         * sans qu'un seul jeton ait bouge. On part donc de zero : le seul
         * ecart possible est un bon signe dans l'heure precedant le
         * redemarrage, et il se rattrape au premier retour de la chaine. */
        bonDu: ethers.BigNumber.from(d.bd || '0'),
        /* `pb`/`pc`/`pbd`/`pdp` : les cles `bb`/`bc` etaient deja prises par le
           cadeau de bienvenue, et une cle en double dans la fiche, c'est la
           derniere qui gagne — le solde des paris s'ecrivait a zero. */
        betBalance: ethers.BigNumber.from(d.pb || '0'),
        betCumulativeAuthorized: ethers.BigNumber.from(d.pc || '0'),
        betBonDu: ethers.BigNumber.from(d.pbd || '0'),
        betDeposited: ethers.BigNumber.from(d.pdp || '0'),
        clientSeed: d.s || crypto.randomBytes(8).toString('hex'),
        nonce: d.n || 0, name: d.name || addr.slice(0, 6),
        /* Les etats ecrits avant cette marque n'ont pas de `nc`. Un nom qui
           n'est pas le debut de l'adresse a forcement ete choisi : on le
           reconnait, sinon les joueurs deja nommes perdraient leur nom a la
           premiere connexion suivant la mise a jour. */
        nomChoisi: d.nc !== undefined ? !!d.nc : !!(d.name && d.name !== addr.slice(0, 6)),
        dayNet: ethers.BigNumber.from(d.dn || '0'), dayKey: d.dk || null,
        dropsToday: d.dt || 0, winsToday: d.wt || 0, questClaimed: d.qc || {}, hasDeposited: !!d.hd,
        primesEntrainement: d.pe || {},
        miseJour: (d.mij && typeof d.mij === 'object') ? d.mij : {},
        face: (d.fac && typeof d.fac === 'object') ? d.fac : {},
        visage: d.vi || null, amis: Array.isArray(d.am) ? d.am : [], photo: !!d.ph,
        demandes: Array.isArray(d.dm) ? d.dm : [], envoyees: Array.isArray(d.en) ? d.en : [],
        parrain: d.pa || null, filleuls: Array.isArray(d.fi) ? d.fi : [],
        refDu: ethers.BigNumber.from(d.rd || '0'), refTotal: ethers.BigNumber.from(d.rt || '0'),
        revCumul: Number(d.rc || 0), revPaye: Number(d.rp || 0),
        attente: Array.isArray(d.att) ? d.att : [],
        /* Les fiches ecrites avant ce drapeau n'en ont pas. On le DEDUIT
           plutot que de le mettre a faux : un filleul qui a deja une ligne
           d'eau a forcement rapporte, et repartir a zero ferait perdre leur
           prime a tous les parrains qui l'avaient meritee avant le
           changement. */
        aRapporte: d.rap === undefined ? Number(d.rp || 0) > 0 : !!d.rap,
        record: d.rec || null, meilleurJour: d.mj || null, refBienvenue: !!d.rb,
        objets: (d.ob && typeof d.ob === 'object') ? d.ob : {},
        fioles: (d.fio && typeof d.fio === 'object') ? d.fio : {},
        sacFioles: (d.sfio && typeof d.sfio === 'object') ? d.sfio : {},
        /* Les oeufs du sac. Il n'y a pas de « coffre a oeufs » : un oeuf
           s'ouvre, il ne se collectionne pas. Ce qui survit a la mort, c'est
           le FAMILIER qu'il donne, et il vit ailleurs (`familiers`). */
        sacOeufs: (d.soe && typeof d.soe === 'object') ? d.soe : {},
        coffreOeufs: (d.coe && typeof d.coe === 'object') ? d.coe : {},
        /* Les familiers eclos, par espece. Ils ne meurent jamais et ne se
           perdent jamais — c'est la promesse faite au joueur, et un compte
           qui redemarre doit la tenir aussi. */
        familiers: (d.fam && typeof d.fam === 'object') ? d.fam : {},
        familierActif: d.fama || null,
        sacCases: Array.isArray(d.scas) ? d.scas : null,
        skins: (d.sk && typeof d.sk === 'object') ? d.sk : {},
        persos: (d.pr && typeof d.pr === 'object')
          ? Object.keys(d.pr).reduce((o, id) => { const c = d.pr[id] || {};
              o[id] = { w: ethers.BigNumber.from(c.w || '0'),
                        ef: c.ef || null, ea: c.ea || null,
                        ar: c.ar || null, ba: c.ba || null,
                        xc: Math.max(0, Number(c.xc) || 0),
                        sup: (c.su && typeof c.su === 'object')
                          ? personnages.STATS.reduce((s, k) => {
                              /* On borne AU CHARGEMENT avec le plafond de ce
                                 personnage-la : une sauvegarde ecrite quand
                                 le plafond etait plus haut ne doit pas rendre
                                 un compte qu'on ne pourrait plus atteindre. */
                              const mx = personnages.supMaxDe(k,
                                (personnages.BASE[id] || {})[k]);
                              const v = Math.max(0, Math.min(mx, Number(c.su[k]) || 0));
                              if (v) s[k] = v; return s; }, {})
                          : {},
                      }; return o; }, {})
          : {},
        skinActif: d.ska || null,
        fame: Number(d.fm) || 0,
        sac: (d.sc && typeof d.sc === 'object') ? d.sc : {},
        potions: (d.po && typeof d.po === 'object') ? d.po : {},
        bonusBloque: ethers.BigNumber.from(d.bb || '0'),
        bonusCible: d.bc2 ? ethers.BigNumber.from(d.bc2) : null,
        moisCle: d.mk || null, moisMise: Number(d.mm || 0),
        stakeClaimTotal: ethers.BigNumber.from(d.sct || '0'), trNonLus: d.tnl || 0,
        stakes: Array.isArray(d.stk)
          ? d.stk.map((x) => ({ a: ethers.BigNumber.from(x[0]), s: x[1], u: x[2] }))
          : (d.st && d.st !== '0' // migrate old single-stake format → one locked position
              ? [{ a: ethers.BigNumber.from(d.st), s: d.ss || Date.now(), u: (d.ss || Date.now()) + cfg.STAKE_LOCK_DAYS * 86400000 }]
              : []),
        stakeAccrued: ethers.BigNumber.from(d.sa || '0'),
        wagered: ethers.BigNumber.from(d.tw || '0'), betCount: d.bc || 0,
        /* Fiche relue du disque, donc anterieure au durcissement : si elle ne
           porte pas encore de niveau acquis, on le retrouve avec la courbe qui
           etait en vigueur. C'est la SEULE occasion ou l'ancienne courbe sert,
           et elle ne sert qu'une fois par joueur. */
        nomPaye: !!d.np,
        nivMax: d.nx !== undefined ? d.nx
          : Game._niveauHerite(ethers.BigNumber.from(d.tw || '0')),
        deposited: ethers.BigNumber.from(d.dp || '0'), jeux: d.jx || {},
        bj: d.bj || null, volcanoMeter: d.vm || 0,
        tgId: d.tg || null,
        welcomeGranted: !!d.wg, welcomeWagered: !!d.ww, welcomeClaimed: !!d.wc,
        xp: Number(d.xp) || 0, xpSources: d.xps || {}, xpFilleuls: d.xpf || {},
        xpObjets: d.xo || {},
        xpFamilles: d.xfa || Game._famillesPossedees(d.ob || {}),
        coffreOffertJour: d.cof || null,
        jourColl: d.jc || { coffres: 0, neufs: 0, rarete: 0 },
        creeLe: d.cre || 0, parfaitJour: d.pj || null,
        streakDay: d.sd || 0, streakLastClaimDay: d.sl || null,
        adCount: d.ac || 0, adDayKey: d.ak || null, adLastMs: d.al || 0,
      });
    }
    if (Array.isArray(st.telegramMap)) this.telegramMap = new Map(st.telegramMap.map((e) => [String(e[0]), String(e[1]).toLowerCase()]));

    /* ---- ON REPARE CE QUE LES ANCIENNES REGLES ONT LAISSE PASSER ----
     *
     * Tant que `_equipe` ne comptait pas les exemplaires deja portes, une seule
     * piece pouvait habiller les six personnages, et les sorties du coffre
     * pouvaient la vendre sans la retirer du dos de personne. Ces fiches-la
     * sont sur le disque : une garde qui ne regarde que l'avenir les laisserait
     * en faute pour toujours.
     *
     * On le DIT dans le journal du demarrage. Une reparation silencieuse qui
     * deshabille des personnages ressemble, vue du joueur, a un vol. */
    let repares = 0, cases = 0;
    for (const p of this.players.values()) {
      const vides = this._reconcilieEquipement(p);
      if (vides.length) { repares++; cases += vides.length; }
    }
    if (repares) {
      console.log(`[equipement] ${cases} case(s) portee(s) sans exemplaire sur ${repares} fiche(s) : retirees`);
    }

    /* Les duels interrompus par l'arret : on ne reprend pas la partie — sans
       arbitre ni joueurs connectes, une grille a moitie jouee ne veut plus
       rien dire — mais ON REND LES MISES. Elles avaient quitte les soldes
       avant l'arret ; sans ce remboursement elles disparaissaient avec la
       table, et personne ne pouvait meme dire ou. */
    if (Array.isArray(st.duels)) {
      let rendues = 0, sommes = 0;
      for (const d of st.duels) {
        for (const a of (d.joueurs || [])) {
          if (!a) continue;
          const p = this._p(a);
          p.balance = p.balance.add(WEI(d.mise));
          sommes += Number(d.mise) || 0;
        }
        rendues++;
      }
      if (rendues) console.log(`[duels] ${rendues} partie(s) interrompue(s) : ${sommes} $SWOGE rendus`);
    }
  }

  _today() { return new Date().toISOString().slice(0, 10); } // UTC day key
  // UTC day key shifted by `n` days (n<0 = past). Used for streak "was yesterday?".
  _dayShift(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
  // Called every time a player actually stakes a bet — unlocks the welcome claim.
  // Appele a chaque mise reelle : debloque le bonus de bienvenue ET cumule le
  // total joue a vie (affiche dans le tableau de bord admin).
  _markWager(p, wei, jeu) {
    if (!p) return;
    /* Le compteur AVANT le tirage. C'est le seul endroit traverse par tous les
       jeux au moment ou la mise part, donc avant qu'aucune carte ne soit
       tiree : en le notant ici et en relisant le compteur a la fin de la
       manche, on obtient la PLAGE exacte de numeros utilises. Noter seulement
       le compteur final serait faux des qu'un jeu tire plusieurs fois — au
       blackjack, une main en consomme une dizaine. */
    p.nonceDebut = p.nonce;
    if (!p.welcomeWagered) p.welcomeWagered = true;
    /* La mise du jour, JEU PAR JEU : c'est le compteur des missions. Il se
       tient ici et nulle part ailleurs, pour la meme raison que le reste —
       un jeu qui oublierait de passer par la ne compterait deja ni pour le
       niveau ni pour le tunnel, ce qui se voit tout de suite. */
    /* Le skin PORTE accumule ce volume comme le sien — c'est ce qui fait
       « progression par classe » : jouer avec Landwolf actif ne fait pas
       monter Pepe. Rien ne se passe si aucun skin n'est porte — la mise
       compte toujours pour le compte, elle ne compte simplement pour
       aucune classe. */
    if (wei && p.skinActif) {
      p.persos = p.persos || {};
      const c = p.persos[p.skinActif] || (p.persos[p.skinActif] = { w: BN(0), ef: null, ea: null, sup: {} });
      c.w = (c.w || BN(0)).add(wei);
    }
    if (jeu && wei) {
      this._bumpDay(p);
      if (!p.miseJour) p.miseJour = {};
      p.miseJour[jeu] = (p.miseJour[jeu] || 0) + Number(ethers.utils.formatUnits(wei, cfg.DECIMALS));
    }
    if (wei) {
      /* La PREMIERE mise de sa vie : le dernier passage du tunnel, et celui
         qui separe un curieux d'un joueur. */
      if (!(p.betCount > 0) && p.addr) this.noteTunnel('premieresMises', p.addr);
      /* On compare des niveaux ACQUIS, pas des niveaux calcules. Un joueur
         fige au-dessus de la courbe — parce qu'il avait deja atteint son
         niveau avant qu'elle soit durcie — verrait sinon defiler des montees
         de niveau pour des paliers qu'il a depuis longtemps depasses. */
      const avant = this._niveauAcquis(p, Game.niveauDe(Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS))));
      p.wagered = (p.wagered || BN(0)).add(wei); p.betCount = (p.betCount || 0) + 1;
      /* La montee se constate ICI, au seul endroit ou l'experience bouge. On
         la met de cote plutot que de la notifier : _markWager est appele en
         plein milieu d'une manche, et une fenetre qui s'ouvre a cet instant
         couvrirait le jeu. Le serveur la ramasse une fois la manche finie. */
      const apres = this._niveauAcquis(p, Game.niveauDe(Number(ethers.utils.formatUnits(p.wagered, cfg.DECIMALS))));
      if (apres > avant && p.addr) {
        if (!this.montees) this.montees = [];
        this.montees.push({ addr: p.addr, de: avant, a: apres,
                            palier: Game.PALIERS[Math.min(Math.floor((apres - 1) / 10), 9)],
                            nouveauPalier: Math.floor((apres - 1) / 10) !== Math.floor(Math.max(0, avant - 1) / 10) });
      }
    }
    this._libereCadeau(p);
  }
  /**
   * Comptabilite PAR JEU. Le serveur ne retenait qu'un total de mises, tous
   * jeux confondus : impossible de dire si un joueur gagne anormalement
   * quelque part, ni meme a quoi il joue. On enregistre une manche a la fois,
   * au moment ou elle se conclut.
   *
   * `mise` et `rendu` sont des NOMBRES, pas des wei : ce sont des chiffres
   * d'affichage, jamais des soldes, et personne ne paie avec.
   */
  /* `opts` sert aux jeux dont l'argent ne part pas et ne revient pas dans le
     meme instant. Le Coin Pusher en est un : on lache une piece maintenant,
     et une piece — pas forcement la sienne — tombe plus tard. Les deux moments
     doivent compter, mais une seule fois chacun.
       • suite       : ce versement prolonge une manche deja comptee. On
                       enregistre l'argent, pas une deuxieme manche.
       • sansJournal : pas de ligne d'historique. Trois cents chutes a un jeton
                       noieraient l'onglet « Rounds » et cacheraient tout le
                       reste ; les compteurs, eux, ont besoin de chacune. */
  _manche(p, jeu, mise, rendu, opts) {
    if (!p || !jeu) return;
    const suite = !!(opts && opts.suite);
    /* Le seul point de passage de TOUTES les manches, tous jeux confondus :
       c'est donc ici que le journal se remplit, et nulle part ailleurs. Un
       nouveau jeu qui appelle _manche est journalise sans rien avoir a
       ajouter — et un jeu qui oublierait de l'appeler ne compterait deja pas
       dans les statistiques, ce qui se voit. */
    if (p.addr && !(opts && opts.sansJournal)) journal.ajoute(p.addr, { k: 'r', g: jeu, m: Number(mise) || 0, p: Number(rendu) || 0,
      /* De quoi refaire le calcul soi-meme, une fois la graine du serveur
         revelee : son empreinte, la graine du joueur, et les numeros utilises
         par cette manche. */
      sh: this.serverSeedHash, cs: p.clientSeed,
      n0: p.nonceDebut == null ? p.nonce : p.nonceDebut, n1: p.nonce });
    this.manchesGraine = (this.manchesGraine || 0) + 1;
    this.noteJeu(p, jeu, mise, rendu, suite);
    /* LE point de passage du revenu. Il vaut pour les jeux contre la banque
       comme pour le 1v1 : la somme des mises moins la somme des rendus EST ce
       que la maison garde, commission comprise. */
    this.note('mises', Number(mise) || 0, p.addr);
    this.note('rendus', Number(rendu) || 0, p.addr);
    if (!suite) this.note('manches', 1);
    /* Le volume du MOIS. Il se remet a zero tout seul au changement de mois :
       un classement mensuel qu'il faut penser a reinitialiser finit toujours
       par afficher le mois d'avant. */
    const mc = Game.moisCle();
    if (p.moisCle !== mc) { p.moisCle = mc; p.moisMise = 0; }
    p.moisMise = (p.moisMise || 0) + (Number(mise) || 0);

    if (!p.jeux) p.jeux = {};
    const j = p.jeux[jeu] || (p.jeux[jeu] = { n: 0, mise: 0, rendu: 0, gagne: 0, nul: 0 });
    if (!suite) j.n++;
    j.mise += Number(mise) || 0;
    j.rendu += Number(rendu) || 0;
    if (!suite) {
      if (rendu > mise) j.gagne++;
      else if (rendu === mise) j.nul++;
    }

    /* Le plus gros gain d'une vie de joueur. On le retient au moment ou il
       arrive : le recalculer plus tard voudrait dire relire tout le journal,
       et une statistique qui coute une lecture de fichier ne s'affiche
       jamais. */
    const gain = (Number(rendu) || 0) - (Number(mise) || 0);
    if (gain > 0 && (!p.record || gain > p.record.g))
      p.record = { g: gain, x: mise > 0 ? Number((rendu / mise).toFixed(2)) : 0, j: jeu, t: Date.now() };

    this._revenuParrain(p, jeu, mise, rendu);
  }

  /* ------------------------------------------------------------ parrainage
   *
   * Ce que le parrain touche vient du REVENU reel du filleul, pas de ses
   * depots ni de son volume. Deux consequences qui font tout le systeme :
   *
   *  • se parrainer soi-meme ne rapporte rien. Pour se verser dix pour cent
   *    de ses propres pertes, il faut d'abord en perdre cent. Aucune regle
   *    anti-triche a ecrire : la triche est perdante par construction ;
   *
   *  • un filleul qui GAGNE fait baisser le compteur. Mais on ne reprend
   *    jamais ce qui a ete verse : on garde une ligne d'eau — le plus haut
   *    niveau deja paye — et on ne paie que ce qui la depasse. Un gros coup
   *    du filleul suspend les gains du parrain le temps que le compteur
   *    repasse au-dessus, sans jamais mettre personne en dette.
   */
  _revenuParrain(p, jeu, mise, rendu) {
    if (!p || !p.parrain || !p.hasDeposited) return;
    const parrain = this.players.get(p.parrain);
    if (!parrain) return;

    const rev = Game.PVP[jeu]
      ? (Number(mise) || 0) * (cfg.REFERRAL_PVP_BPS / 10000)
      : (Number(mise) || 0) - (Number(rendu) || 0);
    if (!isFinite(rev)) return;

    p.revCumul = (p.revCumul || 0) + rev;

    /* ---- le filleul se refait : on reprend ce qui n'est pas encore mur ----
     *
     * Sans ca, une part est versee des la manche perdue, et si le filleul
     * reprend tout le lendemain la maison a paye sur un revenu qu'elle n'a
     * plus. Ce qui est deja MUR, en revanche, ne se reprend jamais : le
     * parrain ne peut pas se retrouver en dette. */
    /* ---- LE MEME TAUX POUR VERSER ET POUR REPRENDRE ----
     * La reprise convertissait le revenu en argent avec `REFERRAL_BPS` — dix
     * pour cent, le taux de DEPART — pendant que le versement, lui, utilisait
     * le taux du palier, jusqu'a vingt. Un parrain SWOLE se voyait donc
     * reprendre la moitie de ce qu'on lui avait verse quand son filleul se
     * refaisait : le systeme lui laissait de l'argent que la maison n'avait
     * plus. C'etait invisible — les deux chiffres sont justes chacun de leur
     * cote — et ca ne pouvait que grandir, puisque la part monte.
     * Un seul taux, lu une fois, sert aux deux sens. */
    const part = this.partSurFilleul(p.parrain, p.addr || null) / 10000;

    if (p.revCumul < (p.revPaye || 0)) {
      let manque = ((p.revPaye || 0) - p.revCumul) * part;
      const seaux = p.attente || [];
      while (manque > 1e-9 && seaux.length) {
        const dernier = seaux[seaux.length - 1];
        if (dernier[1] <= manque + 1e-9) { manque -= dernier[1]; seaux.pop(); }
        else { dernier[1] -= manque; manque = 0; }
      }
      /* La ligne d'eau redescend d'autant : ce revenu-la est a regagner. Ce
         qui a deja muri reste acquis, donc la ligne ne descend pas plus bas
         que ce qu'on a pu reprendre. */
      const repris = ((p.revPaye || 0) - p.revCumul) * part - manque;
      p.revPaye = (p.revPaye || 0) - repris / part;
      return;
    }
    if (p.revCumul <= (p.revPaye || 0)) return;         // rien de neuf a verser

    /* La part depend du PALIER du parrain — c'est lui qu'on recompense — ET de
       ce que CE filleul a amene a son tour. Deux filleuls du meme parrain ne
       rapportent donc pas au meme taux, et c'est tout l'interet : « amene
       quelqu'un qui amene » se paie sans qu'un centime vienne d'ailleurs que
       du revenu du filleul direct. */
    const du = (p.revCumul - (p.revPaye || 0)) * part;
    p.revPaye = p.revCumul;
    /* ---- CE FILLEUL A RAPPORTE, ET IL L'AURA TOUJOURS FAIT ----
     * C'est ce drapeau qui compte dans la prime de recruteur de SON parrain a
     * lui. Pose ici et nulle part ailleurs : c'est le seul endroit du fichier
     * ou l'on sait qu'un revenu reel vient d'etre verse a quelqu'un. */
    p.aRapporte = true;
    /* Le revenu vient de monter : c'est peut-etre le moment ou la maison a
       fini de gagner le cadeau du filleul. */
    this._libereCadeau(p);
    if (!(du > 0)) return;

    /* Le gain part EN ATTENTE, range par jour. Un seau par jour et non par
       manche : sept jours de parties feraient sinon des milliers de lignes
       pour un seul filleul. */
    const jour = Math.floor(Date.now() / 86400000);
    if (!Array.isArray(p.attente)) p.attente = [];
    const dernier = p.attente[p.attente.length - 1];
    if (dernier && dernier[0] === jour) dernier[1] += du;
    else {
      p.attente.push([jour, du]);
      /* ---- LE PARRAIN APPREND QUE SON FILLEUL LUI RAPPORTE ----
       *
       * Une seule fois par filleul et par jour : c'est le seau du jour qui
       * vient de s'ouvrir. Annoncer chaque manche ferait des centaines de
       * messages pour un joueur actif, et un signal qu'on coupe ne signale
       * plus rien.
       *
       * On ne fait qu'une NOTE ici — game.js ne connait aucune socket. Le
       * serveur la ramasse, comme il ramasse deja les montees de niveau. */
      (this.gainsParrain = this.gainsParrain || [])
        .push({ parrain: p.parrain, filleul: p.name || null });
    }
  }

  /** Les filleuls qui ont commence a rapporter depuis la derniere fois qu'on
   *  a regarde. Se vide en le lisant, comme `montéesRecentes`. */
  gainsParrainRecents() { const g = this.gainsParrain || []; this.gainsParrain = []; return g; }

  /**
   * Fait murir ce qui a passe le delai : les seaux assez vieux quittent le
   * filleul et deviennent encaissables chez le parrain.
   *
   * Aucun minuteur : on regarde au moment ou quelqu'un demande. Un gain qui
   * murit pendant que personne ne regarde n'a pas besoin d'evenement.
   */
  _murit(addr) {
    const p = this._p(addr);
    const limite = Math.floor(Date.now() / 86400000) - Math.max(0, cfg.REFERRAL_HOLD_DAYS);
    for (const f of (p.filleuls || [])) {
      const q = this._p(f);
      if (!Array.isArray(q.attente) || !q.attente.length) continue;
      const reste = [];
      let mur = 0;
      for (const seau of q.attente) {
        if (seau[0] <= limite) mur += seau[1];
        else reste.push(seau);
      }
      if (mur > 0) {
        const w = WEI(mur.toFixed(6));
        p.refDu = (p.refDu || BN(0)).add(w);
        p.refTotal = (p.refTotal || BN(0)).add(w);
        q.attente = reste;
      }
    }
  }

  /**
   * Le cadeau de parrainage se debloque-t-il ?
   *
   * ---- pourquoi ce n'est PAS un simple volume a miser ----
   *
   * Une mise a atteindre se contourne par le jeu le moins cher : miser vingt
   * mille au blackjack, dont l'avantage maison est d'un demi pour cent, ne
   * coute que cent — pour un cadeau de cinq cents. Le verrou serait joli sur
   * le papier et la recolte resterait rentable.
   *
   * On demande donc la seule chose qui ne se contourne pas : QUE LA MAISON
   * AIT REELLEMENT GAGNE LE MONTANT DU CADEAU sur ce joueur. C'est deja
   * compte, exactement, pour le parrainage (`revCumul`). Impossible de
   * debloquer cinq cents sans en avoir fait perdre cinq cents — quel que
   * soit le jeu choisi.
   *
   * Reste le joueur honnete et chanceux, qui gagne et ne debloquerait jamais.
   * Pour lui, une sortie de secours au VOLUME : au bout de deux cents fois le
   * cadeau mise, le compte est de toute facon largement rentable, meme au jeu
   * le moins cher.
   */
  _libereCadeau(p) {
    if (!p || !p.bonusBloque || p.bonusBloque.lte(0)) return;
    const cadeau = Number(cfg.REFERRAL_WELCOME) || 0;
    const gagne = (p.revCumul || 0) >= cadeau;
    const volume = p.bonusCible && (p.wagered || BN(0)).gte(p.bonusCible);
    if (gagne || volume) { p.bonusBloque = BN(0); p.bonusCible = null; }
  }

  /* ======================================================================
   * LA COMPTABILITE DU MOIS
   *
   * ---- pourquoi le solde d'un joueur ne dit RIEN ----
   *
   * « Il depose 100 000, il lui en reste 80 000, donc il a perdu 20 000 » est
   * faux, et c'est le piege central. La variation d'un solde melange CINQ
   * choses : les depots, les retraits, le resultat des jeux, le rendement du
   * staking, et les envois entre joueurs. Le meme joueur repasse « positif »
   * le mois suivant sans avoir joue une seule fois, simplement parce qu'il a
   * redepose ou touche son rendement.
   *
   * ---- ce qu'on compte, alors ----
   *
   * Le REVENU, c'est ce que la maison garde : mises moins rendus. Un seul
   * point de passage suffit — _manche — et il vaut aussi pour le 1v1 : la
   * somme des mises des deux joueurs moins la somme de ce qui leur est rendu
   * EST la commission, sans avoir a la compter a part.
   *
   * Les COUTS, c'est ce que la maison donne sans contrepartie : rendement de
   * staking, bonus, parrainage, jackpots.
   *
   * Et les DEPOTS ET RETRAITS NE SONT NI L'UN NI L'AUTRE. Un depot de 100 000
   * n'enrichit personne : la maison le DOIT. Les compter comme un gain est
   * l'erreur qui fait couler les casinos — on se croit riche de l'argent des
   * joueurs.
   * ====================================================================== */
  /**
   * LES QUATRE CHIFFRES DE LA VITRINE, ET RIEN D'AUTRE.
   *
   * ---- POURQUOI ILS SORTENT D'ICI ----
   *
   * Les pages d'accueil affichaient « 128K+ joueurs », « $24.8M+ joues »,
   * « 1,284+ parties ». Des chiffres de MAQUETTE, ecrits en dur, et le
   * fichier le disait. Un site qui annonce un volume invente le fait
   * verifier — c'est la premiere chose qu'on cherche a recouper.
   *
   * ---- CE QU'ON REND, ET COMMENT ILS SONT VRAIS ----
   *
   * Les comptes : la taille de la table des joueurs. Le volume, les manches
   * et ce qui a ete rendu : la somme de tous les mois de comptabilite, celle
   * que `note()` remplit a chaque manche par le seul point de passage qui
   * existe. Un jeu qui oublierait de l'appeler ne compterait deja pas dans le
   * bilan mensuel — donc pas davantage ici.
   *
   * Rien par joueur, aucune adresse : ce sont des totaux, et le detail reste
   * derriere la porte du panneau.
   */
  vitrineChiffres() {
    let volume = 0, rendus = 0, manches = 0;
    for (const k of Object.keys(this.compta || {})) {
      const m = this.compta[k] || {};
      volume += Number(m.mises) || 0;
      rendus += Number(m.rendus) || 0;
      manches += Number(m.manches) || 0;
    }
    return {
      /* Les comptes qui existent. Un compte vide est elague ailleurs, donc ce
         nombre ne gonfle pas d'adresses qui ont juste ouvert la page. */
      joueurs: this.players ? this.players.size : 0,
      volume: Number(volume.toFixed(2)),
      manches,
      rendus: Number(rendus.toFixed(2)),
      /* ---- ET LE HAUT DU CLASSEMENT, POUR DE VRAI ----
       * La page d'accueil montrait trois lignes ecrites a la main —
       * « SwogeKing / LEGEND / 984,200 XP » — trois joueurs qui n'existent
       * pas, avec une XP qui n'a jamais ete gagnee et un rang (« LEGEND »,
       * « ALPHA », « GAMMA ») qui ne correspond a rien dans le jeu : la Fame
       * est un NOMBRE ici, pas un titre. C'est la meme faute que les chiffres
       * de la maquette, au meme endroit, et elle se repare de la meme facon —
       * en la lisant sur le serveur.
       * Trois lignes : c'est ce que la carte montre. En demander plus serait
       * envoyer a chaque visiteur un classement que personne ne regarde. */
      classement: this.vitrineClassement(3),
    };
  }

  /**
   * LE HAUT DU CLASSEMENT DU MONDE, EN LECTURE PUBLIQUE.
   *
   * Le meme calcul que le panneau du jeu — `classementMonde`, son cache d'une
   * seconde compris — reduit a ce qu'une vitrine peut montrer. Rien de plus
   * n'en sort : ni adresse complete, ni tenue, ni ce qu'on possede. Le nom
   * s'efface derriere le debut de l'adresse quand il n'y en a pas, exactement
   * comme dans le panneau : deux endroits qui nomment les gens autrement, ce
   * sont deux personnes differentes pour qui les lit.
   */
  vitrineClassement(n) {
    const combien = Math.max(1, Math.min(10, Math.floor(Number(n) || 3)));
    const top = (this.classementMonde(null, combien) || {}).top || [];
    return top.map((r) => ({
      nom: r.name || String(r.address || '').slice(0, 10),
      xp: r.xp, niveau: r.niveau, fame: r.fame,
    }));
  }

  _mois(cle) {
    if (!this.compta) this.compta = {};
    const k = cle || Game.moisCle();
    if (!this.compta[k]) this.compta[k] = {
      mises: 0, rendus: 0,                      // revenu = mises - rendus
      staking: 0, bonus: 0, parrainage: 0, jackpots: 0,   // ce qu'on donne
      /* Les credits envoyes depuis le panneau. Ils COUTENT, au meme titre
         qu'un bonus : les ranger dans le bilan les rendrait invisibles au
         resultat du mois, et un resultat qui ignore ce qu'on donne se lit
         comme un benefice. */
      cadeaux: 0,
      /* ---- L'ARGENT QUI N'EST PAS UNE MISE ----
       * `note()` ecrivait deja ces quatre lignes ; `comptes()` n'en relisait
       * aucune. Les poser ici plutot que de les laisser apparaitre au premier
       * mouvement evite l'autre moitie du defaut : une cle absente se lit
       * `undefined`, et une addition avec `undefined` rend `NaN` — un resultat
       * mensuel a `NaN` ne se remarque que quand on essaie de decider avec.
       *   • boutique et marche : la maison ENCAISSE (coffres, skins, les 5 %).
       *   • primes : la maison PAIE le prix du classement.
       *   • rachat : la maison PAIE aussi, et `note()` l'ecrit deja en NEGATIF
       *     — c'est la seule des quatre dont le signe porte le sens. */
      boutique: 0, marche: 0, primes: 0, rachat: 0,
      depots: 0, retraits: 0, brule: 0,         // bilan, PAS resultat
      manches: 0, joueurs: {},
    };
    return this.compta[k];
  }
  /**
   * Le detail par joueur, reduit a ce qui se lit.
   *
   * Sans borne, il refait exactement le probleme qu'on vient de retirer : une
   * ligne par compte, dans un fichier reecrit en entier toutes les dix
   * secondes. Vingt mille comptes vides le faisaient repasser de 0,3 Ko a
   * 1,8 Mo — mon propre test l'a attrape.
   *
   * On garde les deux cents plus gros de chaque cote. Personne n'a jamais lu
   * la trois-centieme ligne d'un tableau, et ce detail n'est qu'un confort :
   * la verite, elle, est au journal, qui n'oublie rien.
   */
  static _tailleDetail() { return 200; }
  _comptaEcrite() {
    const out = {};
    for (const k of Object.keys(this.compta || {})) {
      const m = this.compta[k];
      const noms = Object.keys(m.joueurs || {});
      let gardes = noms;
      if (noms.length > Game._tailleDetail() * 2) {
        const poids = (a) => Math.abs((m.joueurs[a].mises || 0) - (m.joueurs[a].rendus || 0))
                           + (m.joueurs[a].staking || 0) + (m.joueurs[a].bonus || 0);
        gardes = noms.sort((a, b) => poids(b) - poids(a)).slice(0, Game._tailleDetail() * 2);
      }
      const j = {};
      for (const a of gardes) j[a] = m.joueurs[a];
      out[k] = Object.assign({}, m, { joueurs: j });
    }
    return out;
  }

  /* ==================== CE QUI EST JOUE, ET PAR COMBIEN ====================
   *
   * La comptabilite existante compte l'ARGENT, par mois : mises, rendus,
   * staking. Elle ne dit pas QUEL JEU. Treize jeux tournent, et la seule facon
   * de savoir lequel sert etait de lire les journaux joueur par joueur.
   *
   * Consequence concrete, et c'est ce qui a decide d'ecrire ceci : le bareme du
   * Coin Pusher a ete rerregle sur un raisonnement, sans qu'aucun chiffre ne
   * puisse dire ensuite si ca a change quoi que ce soit. On ne saura jamais
   * pour hier ; on saura pour demain.
   *
   * Trois decisions :
   *
   *  1. PAR JOUR ET PAR JEU. Le mois est trop grossier pour voir l'effet d'un
   *     changement, l'heure trop fine pour quinze joueurs.
   *  2. LES JOUEURS DISTINCTS, pas seulement les manches. Mille manches d'une
   *     seule personne et mille manches de cent personnes sont deux mondes, et
   *     le total ne les distingue pas. On garde donc les adresses vues — mais
   *     bornees : au-dela de PLAFOND_VUS on cesse de les retenir et on compte
   *     ce qui deborde, ce qui est dit dans le resultat plutot que cache.
   *  3. QUATRE-VINGT-DIX JOURS. De quoi comparer un avant et un apres sans
   *     faire grossir l'etat sans fin.
   */
  noteJeu(p, jeu, mise, rendu, suite) {
    if (!jeu) return;
    const jour = new Date().toISOString().slice(0, 10);
    const u = this.usage || (this.usage = {});
    const d = u[jour] || (u[jour] = {});
    const g = d[jeu] || (d[jeu] = { m: 0, mise: 0, rendu: 0, vus: {}, plus: 0 });
    /* `suite` : un versement qui prolonge une manche deja comptee. L'argent
       compte, la manche non — sinon le Coin Pusher afficherait deux fois plus
       de parties qu'il n'y a eu de chutes. */
    if (!suite) g.m++;
    g.mise = Number((g.mise + (Number(mise) || 0)).toFixed(6));
    g.rendu = Number((g.rendu + (Number(rendu) || 0)).toFixed(6));
    const a = p && p.addr;
    if (a) {
      if (g.vus[a]) g.vus[a]++;
      else if (Object.keys(g.vus).length < Game.PLAFOND_VUS) g.vus[a] = 1;
      else g.plus++;
    }
    /* On elague ici plutot que par une minuterie : le nettoyage suit l'usage,
       un serveur qui ne joue pas n'a rien a nettoyer. */
    const cles = Object.keys(u);
    if (cles.length > Game.JOURS_USAGE) {
      cles.sort();
      for (const k of cles.slice(0, cles.length - Game.JOURS_USAGE)) delete u[k];
    }
  }

  static get PLAFOND_VUS() { return 400; }
  static get JOURS_USAGE() { return 90; }

  /**
   * Le tableau, pret a lire : un jour, une ligne par jeu, du plus joue au
   * moins joue. `net` est ce que la maison garde — mises moins rendus.
   */
  usageJour(jour) {
    const d = (this.usage || {})[jour] || {};
    return Object.keys(d).map((jeu) => {
      const g = d[jeu];
      const distincts = Object.keys(g.vus || {}).length;
      return { jeu, manches: g.m, joueurs: distincts, auDela: g.plus || 0,
               mise: Number(g.mise.toFixed(6)), rendu: Number(g.rendu.toFixed(6)),
               net: Number((g.mise - g.rendu).toFixed(6)),
               retour: g.mise > 0 ? Number((g.rendu / g.mise * 100).toFixed(2)) : null };
    }).sort((a, b) => b.manches - a.manches);
  }

  /** Les jours connus, du plus recent au plus ancien. */
  usageJours() { return Object.keys(this.usage || {}).sort().reverse(); }

  /** Note un mouvement au mois en cours. `qui` sert au detail par joueur. */
  note(quoi, montant, qui) {
    const v = Number(montant) || 0;
    if (!v) return;
    const m = this._mois();
    m[quoi] = Number(((m[quoi] || 0) + v).toFixed(6));
    if (qui) {
      /* Les quatre nouvelles lignes sont ici AUSSI. Sans elles, les appels qui
         passent une adresse — `note('boutique', prix, addr)` — la passaient pour
         rien : `j[quoi]` valait `undefined`, et le detail par joueur ne gardait
         aucune trace de ce qu'un compte avait depense en coffres ou rapporte en
         frais de marche. Un argument ignore en silence est pire qu'un argument
         absent : il donne l'impression que la donnee existe quelque part. */
      const j = m.joueurs[qui] || (m.joueurs[qui] = { mises: 0, rendus: 0, staking: 0, bonus: 0,
                                                     boutique: 0, marche: 0, primes: 0, rachat: 0 });
      /* Les fiches ecrites avant ces quatre cles n'en ont pas : on les ouvre a
         la premiere ecriture plutot que de perdre le mouvement. */
      if (j[quoi] === undefined && ['boutique', 'marche', 'primes', 'rachat'].indexOf(quoi) >= 0) j[quoi] = 0;
      if (j[quoi] !== undefined) j[quoi] = Number((j[quoi] + v).toFixed(6));
    }
  }

  /**
   * Le compte du mois, pret a lire.
   *
   * `resultat` est le seul chiffre qui reponde a « le casino a-t-il gagne de
   * l'argent ce mois-ci ». Tout le reste est du detail ou du bilan.
   */
  comptes(cle) {
    const k = cle || Game.moisCle();
    const m = (this.compta && this.compta[k]) || this._mois(k);
    /* ---- LE REVENU DU JEU RESTE LE REVENU DU JEU ----
     *
     * Il ne bouge pas, et c'est deliberé : `cagnotte()` en tire le prix du
     * classement. Y verser le chiffre d'affaires des coffres ferait grossir une
     * cagnotte que des joueurs touchent reellement — un changement de PAIEMENT,
     * qui ne se decide pas dans une correction de comptabilite. */
    const revenu = Number((m.mises - m.rendus).toFixed(6));

    /* ---- CE QUE LE RESULTAT IGNORAIT ----
     *
     * `note()` ecrivait ces quatre lignes au mois depuis le debut ; `comptes()`
     * n'en relisait aucune. Le chiffre d'affaires des coffres et des skins, les
     * cinq pour cent du marche, le prix du classement verse et le rachat
     * instantane paye par la maison n'apparaissaient nulle part — et `resultat`
     * est presente juste au-dessus comme « le seul chiffre qui reponde a le
     * casino a-t-il gagne de l'argent ce mois-ci ». Il repondait a une autre
     * question.
     *
     * `rachat` est deja stocke NEGATIF par son unique appelant : on le
     * retranche donc en changeant son signe, plutot que de le ranger dans les
     * recettes ou il ferait baisser les couts. */
    const boutiqueCa = Number(m.boutique || 0);
    const marcheCa = Number(m.marche || 0);
    const recettes = Number((boutiqueCa + marcheCa).toFixed(6));
    const primes = Number(m.primes || 0);
    const rachat = Number((-(m.rachat || 0)).toFixed(6));

    const couts = Number((m.staking + m.bonus + m.parrainage + m.jackpots +
                          (m.cadeaux || 0) + primes + rachat).toFixed(6));
    return {
      mois: k,
      /* le revenu */
      mises: m.mises, rendus: m.rendus, revenu, manches: m.manches,
      /* ce qu'on encaisse ailleurs qu'aux tables */
      boutique: boutiqueCa, marche: marcheCa, recettes,
      /* ce qui est donne */
      staking: m.staking, bonus: m.bonus, parrainage: m.parrainage, jackpots: m.jackpots,
      cadeaux: m.cadeaux || 0, primes, rachat,
      couts,
      resultat: Number((revenu + recettes - couts).toFixed(6)),
      /* ---- LA TRESORERIE, STAKING MIS A PART ----
       * `autonomie()` compare le drain a ce que le rendement du staking coute
       * PAR AILLEURS : lui donner un chiffre qui contient deja le staking le
       * compterait deux fois. C'est la seule raison pour laquelle cette ligne
       * existe a cote de `resultat`. */
      horsStaking: Number((revenu + recettes - (couts - m.staking)).toFixed(6)),
      /* le bilan — ni gain ni perte */
      depots: m.depots, retraits: m.retraits, brule: m.brule,
      /* les dix joueurs qui ont le plus rapporte ce mois-ci, et les dix qui
         ont le plus coute : c'est la meme question posee dans les deux sens */
      joueurs: Object.keys(m.joueurs).map((a) => ({
        address: a,
        resultat: Number((m.joueurs[a].mises - m.joueurs[a].rendus).toFixed(6)),
        recu: Number((m.joueurs[a].staking + m.joueurs[a].bonus).toFixed(6)),
      })).sort((x, y) => y.resultat - x.resultat),
    };
  }

  /* ======================================================================
   * LE TUNNEL — ou les gens s'arretent
   *
   * Savoir ce qu'on gagne ne dit pas OU CA COINCE. Quatre chiffres par jour y
   * repondent : combien ouvrent une page, combien branchent un portefeuille,
   * combien deposent, combien misent une premiere fois. Les trois passages
   * entre ces quatre-la designent le probleme — le trafic, la friction du
   * portefeuille, ou le premier depot — et evitent de depenser son energie au
   * mauvais endroit.
   *
   * Les adresses vues du jour vivent EN MEMOIRE seulement : c'est un
   * ensemble qui se vide chaque jour, et l'ecrire recreerait exactement le
   * poids qu'on vient de retirer du fichier.
   * ====================================================================== */
  _jour(cle) {
    if (!this.tunnel) this.tunnel = {};
    const k = cle || new Date().toISOString().slice(0, 10);
    if (!this.tunnel[k]) this.tunnel[k] = {
      pages: 0, connexions: 0, nouveaux: 0, deposants: 0, premieresMises: 0, depose: 0,
    };
    return this.tunnel[k];
  }
  /** Une adresse ne compte qu'une fois par jour pour un passage donne. */
  _uneFois(quoi, addr) {
    const jour = new Date().toISOString().slice(0, 10);
    if (!this._vus || this._vusJour !== jour) { this._vus = new Set(); this._vusJour = jour; }
    const cle = quoi + ':' + addr;
    if (this._vus.has(cle)) return false;
    this._vus.add(cle);
    return true;
  }
  noteTunnel(quoi, addr, montant) {
    const j = this._jour();
    if (addr && !this._uneFois(quoi, String(addr).toLowerCase())) return;
    j[quoi] = (j[quoi] || 0) + 1;
    if (montant) j.depose = Number(((j.depose || 0) + Number(montant)).toFixed(6));
    /* On ne garde pas l'histoire complete : soixante jours suffisent a voir
       une tendance, et le fichier ne doit pas grossir sans fin. */
    const cles = Object.keys(this.tunnel).sort();
    while (cles.length > 60) delete this.tunnel[cles.shift()];
  }

  /** Le tunnel des derniers jours, avec les taux de passage. */
  tunnelJours(combien) {
    const cles = Object.keys(this.tunnel || {}).sort().reverse().slice(0, combien || 14);
    return cles.map((k) => {
      const j = this.tunnel[k];
      const t = (a, b) => (b > 0 ? Number((a / b * 100).toFixed(1)) : null);
      return Object.assign({ jour: k }, j, {
        tauxConnexion: t(j.connexions, j.pages),
        tauxDepot: t(j.deposants, j.connexions),
        tauxPremiereMise: t(j.premieresMises, j.deposants),
      });
    });
  }

  /* ======================================================================
   * LE PRIX DU CLASSEMENT
   *
   * Une part du revenu du mois, partagee entre les premiers au volume. Une
   * PART et non un montant fixe : le prix ne peut alors jamais couter plus
   * que ce que le mois a rapporte. Un mois creux paie peu, un mois plein
   * paie bien, et la maison ne peut pas se retrouver a distribuer de
   * l'argent qu'elle n'a pas gagne.
   * ====================================================================== */
  cagnotte(cle) {
    const c = this.comptes(cle);
    const brut = Math.max(0, c.revenu) * (cfg.PRIX_CLASSEMENT_BPS / 10000);
    return Number(brut.toFixed(6));
  }

  /** Qui gagnerait quoi si le mois se terminait maintenant. */
  prixClassement(cle) {
    const k = cle || Game.moisCle();
    const total = this.cagnotte(k);
    const parts = cfg.PRIX_PARTS;
    const somme = parts.reduce((a, b) => a + b, 0) || 100;
    /* Le classement d'un mois PASSE ne se relit pas depuis les compteurs
       courants (ils ont ete remis a zero) : on le reconstruit depuis le
       detail garde avec les comptes. */
    let liste;
    if (k === Game.moisCle()) {
      liste = this.classementMois(null, parts.length).top;
    } else {
      const m = (this.compta || {})[k] || { joueurs: {} };
      liste = Object.keys(m.joueurs || {})
        .map((a) => ({ address: a, mise: m.joueurs[a].mises || 0, name: this._p(a).name }))
        .sort((x, y) => y.mise - x.mise).slice(0, parts.length)
        .map((r, i) => Object.assign(r, { rang: i + 1 }));
    }
    return {
      mois: k, cagnotte: total, part: cfg.PRIX_CLASSEMENT_BPS / 100,
      verse: !!(this.prixVerses && this.prixVerses[k]),
      gagnants: liste.map((r, i) => ({
        rang: i + 1, address: r.address, name: r.name, mise: r.mise,
        prix: Number((total * (parts[i] || 0) / somme).toFixed(6)),
      })),
    };
  }

  /**
   * Verse le prix d'un mois. UNE SEULE FOIS — un prix paye deux fois est de
   * l'argent cree, et personne ne s'en plaindrait assez vite pour qu'on le
   * remarque.
   */
  verseClassement(cle) {
    const k = cle || Game.moisCle();
    if (!this.prixVerses) this.prixVerses = {};
    if (this.prixVerses[k]) throw new Error('prize already paid for ' + k);
    const p = this.prixClassement(k);
    if (!(p.cagnotte > 0)) throw new Error('nothing to share for ' + k);
    const payes = [];
    for (const g of p.gagnants) {
      if (!(g.prix > 0)) continue;
      const w = WEI(g.prix.toFixed(6));
      const q = this._p(g.address);
      q.balance = q.balance.add(w);
      journal.ajoute(g.address, { k: 'rf', s: 'classement', m: g.prix.toFixed(6), rang: g.rang, mois: k });
      payes.push({ rang: g.rang, address: g.address, name: q.name, prix: g.prix });
    }
    this.note('bonus', p.cagnotte);
    this.prixVerses[k] = { t: Date.now(), total: p.cagnotte, n: payes.length };
    return { mois: k, total: p.cagnotte, gagnants: payes };
  }

  /** Les mois dont on a une trace, du plus recent au plus ancien. */
  moisConnus() { return Object.keys(this.compta || {}).sort().reverse(); }

  /* ======================================================================
   * LE CLASSEMENT DU MONDE — CE QU'ON PERD EN MOURANT
   * ======================================================================
   *
   * Le niveau plafonne a vingt, et apres ? On continuait de tuer pour du
   * butin, et c'est tout : le monde de combat n'avait pas d'objectif propre.
   *
   * Celui-ci en est un, et il ne coute presque rien : l'XP s'accumule DEJA
   * au-dela du plafond — seul le niveau affiche s'arrete. Il ne manquait que
   * de la montrer.
   *
   * ---- on classe le PERSONNAGE, pas le compte ----
   *
   * C'est toute la tension. « Tu meurs, tu perds tout » n'est vrai que si le
   * rang tombe avec le personnage. Et il tombe tout seul : mourir remet a
   * zero le volume mise ET l'XP de combat, donc l'XP totale, donc la ligne
   * disparait sans qu'on ait rien a effacer. Un joueur qui possede six
   * personnages en a six au classement : ce sont six vies separees, et six
   * facons de tout perdre.
   *
   * ---- une fois par mois ----
   *
   * Le prix suit le meme calendrier que celui du casino. Deux calendriers
   * dans un seul jeu, c'est un de trop : le joueur retiendrait l'un et
   * raterait l'autre, et personne ne saurait dire quel jour on est.
   *
   * ---- et l'equipement voyage avec la ligne ----
   *
   * Etre en haut doit faire de vous une cible. Une ligne qui ne montre qu'un
   * nom ne dit pas ce qu'il y a a gagner en vous tuant ; une ligne qui montre
   * l'epee mythique, si.
   */
  /** Ce que porte un personnage, en clair, pour la ligne de classement. */
  /*
   * ==================== CE QU'UN PERSONNAGE A DEJA ATTEINT POUR TOUJOURS ====================
   *
   * Pour chaque stat : `max`, ce qu'on peut atteindre en tout — niveau vingt
   * plus toutes les potions — et `atteint`, la part PERMANENTE deja acquise.
   *
   * L'EQUIPEMENT N'Y EST PAS, et c'est le point : il se prete et il se perd a
   * la mort. Une stat qui passerait pour pleine parce qu'on porte une bague
   * redeviendrait creuse en changeant de bague, sans que rien ne l'explique.
   *
   * ---- pourquoi c'est ecrit ICI et une seule fois ----
   *
   * La fiche du joueur s'en sert pour dire ce qui manque et jaunir ce qui est
   * plein ; le classement s'en sert pour afficher « 3/8 ». Deux calculs
   * separes finiraient par ne plus dire la meme chose — et le joueur lirait
   * « 2/8 » au classement devant trois chiffres jaunes sur sa propre fiche,
   * sans aucun moyen de savoir lequel des deux ment.
   */
  _plafondsDe(skinId, c) {
    const base = personnages.BASE[skinId];
    if (!base) return null;
    const niveau = personnages.niveauDeXp(this._xpDe(c));
    const bues = (c && c.sup) || {};
    const out = {};
    for (const s of personnages.STATS) {
      const mx = personnages.supMaxDe(s, base[s]);
      out[s] = {
        max: personnages.statAuNiveau(base[s], personnages.NIVEAU_MAX)
           + personnages.supDe(s, mx, base[s]),
        atteint: personnages.statAuNiveau(base[s], niveau)
               + personnages.supDe(s, bues[s] | 0, base[s]),
      };
    }
    return out;
  }

  /** Combien de stats sont au plafond, sur combien. C'est le « 3/8 ». */
  _statsPleines(skinId, c) {
    const total = personnages.STATS.length;
    const pl = this._plafondsDe(skinId, c);
    if (!pl) return { n: 0, total };
    let n = 0;
    for (const s of personnages.STATS) if (pl[s].atteint >= pl[s].max) n++;
    return { n, total };
  }

  /**
   * Sont-ils amis ? La question se pose depuis le monde de combat — pour
   * teindre un coequipier en vert et pour l'y rejoindre — et elle ne peut pas
   * se poser dans `realm.js`, qui ne connait aucun compte.
   *
   * L'amitie est MUTUELLE dans ce fichier (`accepteAmi` pousse des deux
   * cotes), mais on verifie quand meme les deux sens : une liste reparee a la
   * main, une restauration partielle, et l'un des deux pourrait manquer. Une
   * teleportation qui marcherait dans un sens et pas dans l'autre se lirait
   * comme une panne.
   */
  sontAmis(a, b) {
    const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
    if (!x || !y || x === y) return false;
    const p = this.players.get(x), q = this.players.get(y);
    if (!p || !q) return false;
    return (p.amis || []).indexOf(y) >= 0 && (q.amis || []).indexOf(x) >= 0;
  }

  _tenueDe(c) {
    const out = [];
    for (const champ of ['ea', 'ar', 'ba', 'ef']) {
      const o = c && c[champ] ? boutique.item(c[champ]) : null;
      if (!o) continue;
      const r = boutique.rarete(o.rarete);
      out.push({ id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete,
                 couleur: r ? r.couleur : '#8DA0C4' });
    }
    return out;
  }

  /**
   * Le classement des personnages VIVANTS, a l'XP.
   *
   * Meme precaution que pour le classement du mois : ce calcul parcourt tous
   * les comptes, et une seule socket suffirait a saturer un coeur en le
   * demandant cent fois par seconde. On le fabrique au plus une fois par
   * seconde, et tout le monde recoit le meme.
   */
  classementMonde(addr, limite) {
    const moi = String(addr || '').toLowerCase();
    const t = Date.now();
    if (!this._cmCache || t - this._cmCache.t > 1000) {
      const liste = [];
      for (const [a, p] of this.players) {
        const persos = p.persos || {};
        for (const skin of Object.keys(persos)) {
          const c = persos[skin];
          if (!c) continue;
          const xp = this._xpDe(c);
          if (!(xp > 0)) continue;          // mort, ou jamais joue
          liste.push({ address: a, name: p.name || null, skin,
                       xp: Math.round(xp),
                       niveau: personnages.niveauDeXp(xp),
                       fame: this._fameDe(c),
                       /* ---- COMBIEN DE STATS IL A DEJA POUSSEES AU BOUT ----
                        * Le niveau dit combien il a joue ; ce chiffre-la dit
                        * combien il a INVESTI. Deux personnages de niveau
                        * vingt ne se valent pas si l'un a bu vingt fioles et
                        * l'autre aucune, et c'est invisible sur une ligne de
                        * classement qui ne montre que l'XP. */
                       pleines: this._statsPleines(skin, c),
                       tenue: this._tenueDe(c) });
        }
      }
      liste.sort((x, y) => y.xp - x.xp);
      liste.forEach((r, i) => { r.rang = i + 1; });
      this._cmCache = { t, liste };
    }
    const arr = this._cmCache.liste;
    /* La ligne du demandeur part TOUJOURS, meme s'il est centieme : un
       classement ou l'on ne se trouve pas ne sert a personne. */
    const miennes = arr.filter((r) => r.address === moi);
    return { mois: Game.moisCle(), vivants: arr.length,
             top: arr.slice(0, limite || 20), moi: miennes.slice(0, 6),
             prix: cfg.PRIX_MONDE_GOLD, parts: cfg.PRIX_PARTS.slice() };
  }

  /** Qui gagnerait quoi si le mois se terminait maintenant. */
  prixMonde(cle) {
    const k = cle || Game.moisCle();
    const parts = cfg.PRIX_PARTS;
    const somme = parts.reduce((a, b) => a + b, 0) || 100;
    const total = cfg.PRIX_MONDE_GOLD;
    /* Un mois PAYE ne se reconstruit pas : les personnages ont continue de
       vivre, et certains sont morts. On garde donc le tableau au moment du
       versement, et c'est lui qu'on relit.
       La question est « a-t-il ete paye ? », pas « est-il passe ? ». Les deux
       se ressemblent — le versement tombe dix minutes apres la bascule — et
       elles different justement dans le seul cas qui compte : un mois paye
       qu'on relit AVANT sa bascule rendrait un tableau refait depuis des
       personnages qui ont bouge depuis, donc un autre gagnant que celui qu'on
       a paye. */
    if (this.prixMondeVerses && this.prixMondeVerses[k]) return this.prixMondeVerses[k];
    const liste = this.classementMonde(null, parts.length).top;
    return {
      mois: k, total, verse: !!(this.prixMondeVerses && this.prixMondeVerses[k]),
      gagnants: liste.map((r, i) => ({
        rang: i + 1, address: r.address, name: r.name, skin: r.skin, xp: r.xp,
        gold: Math.round(total * (parts[i] || 0) / somme),
      })),
    };
  }

  /**
   * Verse le prix d'un MOIS, EN OR. Une seule fois — un prix paye deux fois
   * est de l'or cree, et personne ne s'en plaindrait assez vite pour qu'on le
   * remarque.
   *
   * En or, et pas en $SWOGE : le classement du mois recompense du volume
   * DEJA mise — c'est de l'argent qui est entre, redistribue. Recompenser de
   * l'XP en jetons serait de l'argent CREE contre du temps passe, et ca se
   * farme avec un client sans ecran, vingt-quatre heures sur vingt-quatre.
   * L'or, lui, ne s'echange pas contre autre chose que du rang.
   */
  verseMonde(cle) {
    const k = cle || Game.moisCle();
    if (!this.prixMondeVerses) this.prixMondeVerses = {};
    if (this.prixMondeVerses[k]) throw new Error('prize already paid for ' + k);
    const p = this.prixMonde(k);
    const payes = [];
    for (const g of p.gagnants) {
      if (!(g.gold > 0)) continue;
      const q = this._p(g.address);
      q.fame = (q.fame || 0) + g.gold;
      journal.ajoute(g.address, { k: 'rf', s: 'monde', or: g.gold, rang: g.rang, mois: k });
      payes.push({ rang: g.rang, address: g.address, name: q.name, skin: g.skin,
                   xp: g.xp, gold: g.gold });
    }
    /* On garde le tableau tel qu'il etait : le mois prochain, ces personnages
       seront peut-etre morts, et « qui a gagne » ne se reconstruit pas depuis
       des compteurs remis a zero. */
    this.prixMondeVerses[k] = { mois: k, total: p.total, verse: true,
                                t: Date.now(), gagnants: payes };
    return this.prixMondeVerses[k];
  }

  /* ======================================================================
   * LES CENT NIVEAUX
   *
   * L'experience est le volume mise, qui est deja compte depuis toujours :
   * chacun a donc son vrai niveau des le premier jour, sans migration et sans
   * avoir rien perdu. Et il ne se triche pas — chaque point coute l'avantage
   * de la maison.
   * ====================================================================== */
  static get PALIERS() {
    return ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond',
            'Master', 'Champion', 'Legend', 'Mythic', 'SWOLE'];
  }
  /** Le volume cumule qu'il faut pour atteindre le niveau n. */
  static volumePour(n) {
    const x = Math.max(1, Math.min(cfg.NIVEAU_MAX, Number(n) || 1));
    return cfg.NIVEAU_BASE * Math.pow(x, cfg.NIVEAU_PUISSANCE);
  }
  /** Le niveau que donne un volume. Conserve pour la migration et les tests :
   *  c'est la courbe D'AVANT l'XP, celle qui ne connaissait que la depense. */
  static niveauDe(volume) {
    const v = Number(volume) || 0;
    if (v < cfg.NIVEAU_BASE) return 0;
    /* Le petit epsilon n'est pas cosmetique : `pow(1788854/50, 1/3.5)` rend
       19,999999998 et non 20. Sans lui, le joueur qui atteint EXACTEMENT le
       seuil reste au niveau precedent — et c'est precisement le moment ou il
       regarde. */
    const n = Math.floor(Math.pow(v / cfg.NIVEAU_BASE, 1 / cfg.NIVEAU_PUISSANCE) + 1e-9);
    return Math.max(0, Math.min(cfg.NIVEAU_MAX, n));
  }

  /* ======================================================================
   * L'XP
   * ======================================================================
   *
   * Le niveau se lit desormais sur une somme :
   *
   *     xp total  =  xp derive du volume mise  +  xp gagne par les gestes
   *
   * Le premier terme n'est pas stocke : il se RECALCULE du volume cumule, qui
   * existait deja. Rien a migrer, rien qui puisse diverger d'un compteur
   * parallele, et un joueur ne peut pas perdre de niveau parce qu'aucun des
   * deux termes ne descend jamais.
   */

  /** L'XP qu'il faut pour atteindre le niveau n. */
  static xpPour(n) {
    const x = Math.max(1, Math.min(cfg.NIVEAU_MAX, Number(n) || 1));
    return cfg.XP_BASE * Math.pow(x, cfg.XP_PUISSANCE);
  }

  /**
   * Le volume mise, traduit en XP.
   *
   * L'exposant est le RAPPORT des deux puissances, ce qui fait que la
   * traduction rend exactement l'ancien niveau. Ce n'est pas un reglage a
   * gout : c'est la seule valeur qui ne retrograde ni ne promeut personne le
   * jour de la bascule. La verifier est d'ailleurs un test a soi seul.
   */
  static xpDuVolume(volume) {
    const v = Number(volume) || 0;
    if (v <= 0) return 0;
    const e = cfg.XP_PUISSANCE / cfg.NIVEAU_PUISSANCE;
    return cfg.XP_BASE * Math.pow(v / cfg.NIVEAU_BASE, e) * (cfg.XP_VOLUME_BONUS || 1);
  }

  /** Le niveau que donne une XP totale. */
  static niveauDeXp(xp) {
    const x = Number(xp) || 0;
    if (x < cfg.XP_BASE) return 0;
    const n = Math.floor(Math.pow(x / cfg.XP_BASE, 1 / cfg.XP_PUISSANCE) + 1e-9);
    return Math.max(0, Math.min(cfg.NIVEAU_MAX, n));
  }

  /** L'XP totale d'une fiche : le volume traduit, plus ce qui a ete gagne. */
  _xpTotale(p) {
    const v = Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS));
    return Game.xpDuVolume(v) + Math.max(0, Number(p.xp) || 0);
  }

  /**
   * LE SEUL ENDROIT QUI DONNE DE L'XP.
   *
   * Un point d'entree unique, et non un `p.xp +=` dispersé dans cinq
   * methodes : c'est ce qui permet de garder le detail par source, donc de
   * repondre plus tard a « d'ou vient la progression des joueurs » sans
   * rejouer l'historique. Et un plafond negatif impossible : l'XP ne se
   * reprend pas, y compris si un appelant se trompe de signe.
   *
   * Rend le niveau AVANT et APRES, pour que l'appelant puisse annoncer une
   * montee sans la recalculer — et sans risquer de la calculer autrement.
   */
  _gagneXp(p, montant, source) {
    const m = Math.max(0, Math.round(Number(montant) || 0));
    if (!m) return null;
    const avant = this.niveauDeFiche(p);
    p.xp = (Number(p.xp) || 0) + m;
    p.xpSources = p.xpSources || {};
    p.xpSources[source] = (p.xpSources[source] || 0) + m;
    const apres = this.niveauDeFiche(p);
    return { gagne: m, source, avant, apres, monte: apres > avant };
  }

  /** Le niveau d'une fiche, acquis compris. Sert a `_gagneXp` et a `niveau`. */
  niveauDeFiche(p) {
    return this._niveauAcquis(p, Game.niveauDeXp(this._xpTotale(p)));
  }

  /**
   * Le niveau d'un joueur, avec de quoi l'afficher : son palier, et surtout
   * CE QU'IL RESTE A FAIRE. Un niveau sans la marche suivante ne donne envie
   * de rien ; « encore 293 970 mises » se vise.
   */
  /**
   * LE NIVEAU ACQUIS.
   *
   * Un niveau atteint ne se reprend pas — y compris quand la courbe est
   * durcie. Sans cette marque, monter la difficulte retrograderait tous les
   * joueurs existants d'un coup : celui qui etait niveau 34 se reveillerait
   * niveau 21, sans rien avoir fait, et c'est exactement la punition que tout
   * le systeme de niveaux est concu pour eviter.
   *
   * La marque se pose a la premiere lecture, avec la courbe QUI ETAIT EN
   * VIGUEUR. La retrouver depuis l'ancienne puissance est la seule facon
   * d'etre juste : figer le joueur a son niveau calcule aujourd'hui reviendrait
   * a le retrograder puis a graver la retrogradation.
   */
  _niveauAcquis(p, calcule) {
    if (!cfg.NIVEAU_ACQUIS) return calcule;
    if (!(p.nivMax > calcule)) p.nivMax = calcule;      // il monte, il ne descend pas
    return p.nivMax;
  }

  /**
   * La migration, et le piege qu'elle cachait.
   *
   * Elle ne s'applique QU'AUX FICHES RELUES DU DISQUE — celles qui existaient
   * donc avant le durcissement. Ma premiere version la posait paresseusement,
   * a la premiere lecture de n'importe quelle fiche : un joueur NEUF avec le
   * meme volume heritait alors de l'ancienne courbe et arrivait niveau 34 au
   * lieu de 21. Le durcissement n'aurait servi a rien, et personne ne l'aurait
   * vu avant des semaines.
   */
  static _niveauHerite(wagered) {
    const v = Number(ethers.utils.formatUnits(wagered || BN(0), cfg.DECIMALS));
    const av = cfg.NIVEAU_PUISSANCE_AVANT;
    if (!v || v < cfg.NIVEAU_BASE || !(av > 0)) return 0;
    return Math.max(0, Math.min(cfg.NIVEAU_MAX,
      Math.floor(Math.pow(v / cfg.NIVEAU_BASE, 1 / av) + 1e-9)));
  }

  niveau(addr) {
    const p = this._p(addr);
    const v = Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS));
    const xp = this._xpTotale(p);
    const n = this._niveauAcquis(p, Game.niveauDeXp(xp));
    const suivant = Math.min(cfg.NIVEAU_MAX, n + 1);
    const bas = n === 0 ? 0 : Game.xpPour(n);
    const haut = Game.xpPour(suivant);
    const max = n >= cfg.NIVEAU_MAX;
    return {
      niveau: n,
      palier: Game.PALIERS[Math.min(Math.floor(Math.max(0, n - 1) / 10), 9)],
      palierNo: Math.min(Math.floor(Math.max(0, n - 1) / 10) + 1, 10),
      /* L'XP est ce que la page affiche desormais. Le volume reste rendu :
         il est devenu une STATISTIQUE parmi d'autres, ce qu'il aurait toujours
         du etre, et la page en a encore besoin ailleurs. */
      xp: Math.round(xp),
      xpVolume: Math.round(Game.xpDuVolume(v)),
      xpGagne: Math.max(0, Math.round(Number(p.xp) || 0)),
      sources: p.xpSources || {},
      volume: Number(v.toFixed(2)),
      seuil: Math.round(bas),
      prochain: max ? null : Math.round(haut),
      restant: max ? 0 : Math.max(0, Math.round(haut - xp)),
      progression: max ? 100 : Number(Math.max(0, Math.min(100, (xp - bas) / (haut - bas) * 100)).toFixed(1)),
      max,
    };
  }

  /* ---- ce que le niveau ouvre ----
   * On ne code ici que ce qui NE COUTE RIEN a la maison. Tout avantage
   * monetaire doit rester indexe sur ce que le joueur rapporte, sinon on
   * refait la dette du staking en plus petit. */

  /** Les montees de niveau depuis la derniere fois qu'on a regarde. */
  montéesRecentes() { const m = this.montees || []; this.montees = []; return m; }

  /** La photo personnelle : un depot OU le niveau 5. Le niveau est le
   *  meilleur filtre des deux — il demande d'avoir joue, pas seulement
   *  d'etre passe. */
  peutTeleverser(addr) {
    return !cfg.AVATAR_REQUIRE_DEPOSIT || this._p(addr).hasDeposited || this.niveau(addr).niveau >= 5;
  }

  /** Le retrait minimum baisse avec le palier — pure commodite, cout nul. */
  minRetraitDe(addr) {
    const n = this.niveau(addr).niveau;
    const base = Number(cfg.MIN_WITHDRAW);
    if (n >= 40) return Math.max(2000, base / 5);
    if (n >= 20) return Math.max(5000, base / 2);
    return base;
  }

  /** La part de parrainage monte d'un point PAR PALIER : 10 % a Bronze,
   *  20 % a SWOLE. Elle reste un pourcentage du REVENU, donc elle ne peut
   *  jamais couter plus que ce que le filleul a rapporte. */
  partParrainage(addr) {
    const t = cfg.REFERRAL_PALIER_BPS;
    if (!t || !t.length) return cfg.REFERRAL_BPS;
    const i = Math.max(1, this.niveau(addr).palierNo || 1) - 1;
    return t[Math.min(i, t.length - 1)];
  }

  /**
   * Combien de filleuls de CE joueur ont deja rapporte quelque chose.
   *
   * `aRapporte` et pas `hasDeposited`, et surtout pas « inscrit » : la prime
   * du recruteur se gagne sur du REVENU encaisse, jamais sur du recrutement.
   * Compter les inscrits ferait payer la maison pour des comptes vides —
   * c'est-a-dire pour du recrutement — et c'est precisement la forme qu'on ne
   * veut pas avoir a defendre.
   *
   * Le drapeau ne se retire jamais. Un filleul qui se refait fait redescendre
   * son compteur de revenu, mais il a bel et bien rapporte une fois : reprendre
   * la prime du parrain pour ca ferait dependre son taux des series de
   * quelqu'un qu'il ne connait pas.
   */
  recruesActives(addr) {
    const p = this._p(addr);
    let n = 0;
    for (const f of (p.filleuls || [])) {
      if (this._p(f).aRapporte) n++;
    }
    return n;
  }

  /**
   * LA PART SUR UN FILLEUL DONNE.
   *
   * Deux termes, et un seul etage :
   *   — le PALIER du parrain, ce qu'il a merite par son propre jeu ;
   *   — la PRIME de recruteur, ce que CE filleul-la a amene a son tour.
   *
   * La prime est attachee au LIEN, pas au parrain : deux filleuls du meme
   * parrain ne rapportent pas au meme taux si l'un recrute et l'autre non.
   * C'est ce qui fait que « amene quelqu'un qui amene » se paie — sans qu'un
   * centime vienne d'ailleurs que du revenu du filleul direct.
   *
   * Le plafond est le dernier mot. Il ne sert a rien aujourd'hui — vingt plus
   * dix font trente — et c'est exactement pour ca qu'il est la : le jour ou
   * quelqu'un montera une des deux tables sans regarder l'autre, rien d'autre
   * dans ce fichier ne l'arreterait.
   */
  partSurFilleul(parrain, filleul) {
    const base = this.partParrainage(parrain);
    const t = cfg.REFERRAL_RECRUTEUR_BPS;
    let prime = 0;
    if (t && t.length && filleul) {
      const n = this.recruesActives(filleul);
      prime = t[Math.min(n, t.length - 1)] || 0;
    }
    const max = cfg.REFERRAL_PART_MAX_BPS || 10000;
    return Math.min(max, base + prime);
  }

  /** Les jeux ou l'argent va d'un joueur a l'autre, pas a la banque. */
  static get PVP() { return { p4: true, poker: true, mp: true, dm: true }; }

  static moisCle(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
  }

  /**
   * Le classement du mois, au VOLUME MISE.
   *
   * Pas au gain : classer sur les gains, c'est classer sur la chance, et le
   * meme joueur y monte et descend sans rien changer a sa facon de jouer. Le
   * volume, lui, ne depend que de ce qu'on a fait — et c'est la seule mesure
   * qu'un joueur peut reconnaitre comme la sienne.
   *
   * Le demandeur recoit TOUJOURS son propre rang, meme s'il est trois-centieme :
   * un classement ou l'on ne se trouve pas ne sert a personne.
   */
  classementMois(addr, limite) {
    const mc = Game.moisCle();
    const moi = String(addr || '').toLowerCase();
    /* ---- UNE SEULE FABRICATION PAR SECONDE ----
     * Ce calcul parcourt TOUS les joueurs, les trie, et coute 6,6 ms a vingt
     * mille fiches. Node n'a qu'un fil : cent cinquante demandes par seconde
     * — qu'une seule socket envoie sans effort — suffisent a saturer un coeur
     * et a ne plus servir personne. Or le classement ne change pas de facon
     * perceptible en une seconde. On le fabrique donc au plus une fois par
     * seconde et tout le monde recoit le meme, ce qui ramene le cout par
     * demande a rien. */
    const t = Date.now();
    if (!this._clCache || this._clCache.mois !== mc || t - this._clCache.t > 1000) {
      const liste = [];
      for (const [a, p] of this.players) {
        const v = p.moisCle === mc ? (p.moisMise || 0) : 0;
        if (v > 0) liste.push({ address: a, name: p.name, visage: p.visage || null,
                                photo: !!p.photo, mise: v });
      }
      liste.sort((x, y) => y.mise - x.mise);
      liste.forEach((r, i) => { r.rang = i + 1; });
      this._clCache = { t, mois: mc, liste };
    }
    const arr = this._clCache.liste;
    const mien = arr.find((r) => r.address === moi) || null;
    return { mois: mc, joueurs: arr.length, top: arr.slice(0, limite || 50), moi: mien };
  }

  /**
   * Le code d'invitation d'un joueur. Son NOM s'il en a choisi un — c'est
   * lui qu'on partage de vive voix et qu'on retape sans se tromper — sinon
   * huit caracteres de son adresse.
   */
  codeParrain(addr) {
    const p = this._p(addr);
    return p.nomChoisi && p.name ? p.name : String(addr).toLowerCase().slice(2, 10);
  }

  /**
   * Le nom PUBLIC d'un joueur, pour les pages qui n'ont pas de session —
   * le portefeuille, par exemple, qui ne parle qu'a la chaine.
   *
   * ---- IL NE PASSE PAS PAR `_p` ----
   *
   * `_p` CREE la fiche si elle n'existe pas, et la marque sale, donc a
   * ecrire sur disque. Branche sur une route publique, il laisserait
   * n'importe qui faire grossir la table des joueurs et declencher des
   * ecritures en boucle, une adresse inventee a la fois. On lit donc la
   * carte directement, sans rien creer.
   *
   * Meme regle d'affichage que le code de parrainage : le nom choisi s'il
   * y en a un, sinon huit caracteres de l'adresse. Ces noms sont deja
   * publics — ils s'affichent a la table et dans les classements.
   */
  nomPublic(addr) {
    const a = String(addr || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
    const p = this.players.get(a);
    const choisi = !!(p && p.nomChoisi && p.name);
    return { nom: choisi ? p.name : a.slice(2, 10), choisi };
  }

  /** L'adresse derriere un code d'invitation, ou null. */
  resoutCode(code) {
    const c = String(code || '').trim();
    if (!c) return null;
    if (/^0x[0-9a-fA-F]{40}$/.test(c)) return c.toLowerCase();
    const cle = Game.cleNom(c);
    for (const [a, p] of this.players) {
      if (p.nomChoisi && p.name && Game.cleNom(p.name) === cle) return a;
      if (a.slice(2, 10) === c.toLowerCase()) return a;
    }
    return null;
  }

  /**
   * Attache un filleul a son parrain. UNE SEULE FOIS, pour la vie : laisser
   * changer de parrain, c'est laisser deux joueurs se renvoyer le meme
   * filleul et ouvrir une negociation la ou il n'y a qu'un fait.
   */
  lieParrain(filleul, code) {
    const f = String(filleul).toLowerCase();
    const p = this._p(f);
    if (p.parrain) throw new Error('you already have a sponsor');
    const cible = this.resoutCode(code);
    if (!cible) throw new Error('no such invite code');
    if (cible === f) throw new Error('you cannot invite yourself');
    const q = this._p(cible);
    if (q.parrain === f) throw new Error('you two cannot sponsor each other');
    p.parrain = cible;
    if (!Array.isArray(q.filleuls)) q.filleuls = [];
    if (q.filleuls.indexOf(f) < 0) q.filleuls.push(f);
    /* Le compteur repart de zero a l'attache : le parrain ne touche rien sur
       ce qui a ete joue avant lui. */
    p.revCumul = 0; p.revPaye = 0;
    return { parrain: cible, nom: q.name };
  }

  /** Ce que le parrain voit : son lien, ses filleuls, ce qu'ils rapportent. */
  parrainage(addr) {
    const a = String(addr).toLowerCase();
    this._murit(a);
    const p = this._p(a);
    /* SA part a lui, pas celle de tout le monde : afficher 10 % a un joueur
       qui en touche 18 le ferait douter du compte affiche juste a cote. */
    const part = this.partParrainage(a);
    const liste = (p.filleuls || []).map((f) => {
      const q = this._p(f);
      /* ---- LE TAUX DE CE LIEN-LA, ET DE QUOI L'EXPLIQUER ----
       * Depuis que la prime de recruteur existe, deux filleuls du meme parrain
       * ne rapportent plus au meme taux. Afficher un seul chiffre en tete de
       * page ferait mentir la moitie des lignes — et un joueur qui ne peut pas
       * refaire le calcul cesse de croire le total.
       * On envoie donc les DEUX termes, pas seulement leur somme : « 12 %,
       * dont 2 parce qu'il a amene 1 joueur qui joue ». */
      const recrues = this.recruesActives(f);
      const sien = this.partSurFilleul(a, f);
      return {
        address: f, name: q.name, visage: q.visage || null, photo: !!q.photo,
        depose: !!q.hasDeposited,
        part: sien / 100,
        prime: Math.max(0, sien - part) / 100,
        recrues,
        /* Ce que CE filleul a deja rapporte, et non ce qu'il a perdu : c'est
           la seule facon de rendre le calcul verifiable par le parrain. */
        rapporte: ethers.utils.formatUnits(WEI(Math.max(0, (q.revPaye || 0) * (sien / 10000)).toFixed(6)), cfg.DECIMALS),
        // ce qui, chez lui, n'a pas encore passe le delai
        attente: Number(((q.attente || []).reduce((n, x) => n + x[1], 0)).toFixed(6)),
      };
    });
    const parrain = p.parrain ? { address: p.parrain, name: this._p(p.parrain).name } : null;
    /* Ce qui mûrit encore, tous filleuls confondus. */
    const enAttente = { total: 0, plusTot: null };
    for (const f of (p.filleuls || [])) {
      for (const seau of (this._p(f).attente || [])) {
        enAttente.total += seau[1];
        const mur = (seau[0] + Math.max(0, cfg.REFERRAL_HOLD_DAYS)) * 86400000;
        if (enAttente.plusTot === null || mur < enAttente.plusTot) enAttente.plusTot = mur;
      }
    }
    enAttente.total = Number(enAttente.total.toFixed(6));
    return {
      code: this.codeParrain(a),
      part: part / 100,                      // SA part, en pourcentage, pour l'affichage
      partMax: Math.max.apply(null, cfg.REFERRAL_PALIER_BPS) / 100,
      partPalier: (cfg.REFERRAL_PALIER_BPS || []).map((b, i) => ({
        palier: Game.PALIERS[i] || ('palier ' + (i + 1)), part: b / 100 })),
      partPvp: cfg.REFERRAL_PVP_BPS / 100,
      /* ---- LA TABLE DE LA PRIME, ET SON PLAFOND ----
       * La page ne les invente pas : elle affiche « +2 % par recrue active,
       * jusqu'a +10 » avec les chiffres du serveur. Deux tables a tenir
       * d'accord de part et d'autre du reseau finissent par ne plus l'etre, et
       * ce desaccord-la se lit comme un compte faux. */
      primePalier: (cfg.REFERRAL_RECRUTEUR_BPS || []).map((b, i) => ({
        recrues: i, prime: b / 100 })),
      primeMax: Math.max.apply(null, (cfg.REFERRAL_RECRUTEUR_BPS || [0])) / 100,
      partPlafond: (cfg.REFERRAL_PART_MAX_BPS || 10000) / 100,
      /* Combien de MES filleuls rapportent deja — ce que mon propre parrain
         touche grace a moi. Le montrer ferme la boucle : on comprend d'un coup
         d'oeil que recruter des recruteurs paie, parce qu'on est soi-meme le
         recruteur de quelqu'un. */
      mesRecrues: this.recruesActives(a),
      bienvenue: cfg.REFERRAL_WELCOME,
      parrain,
      filleuls: liste,
      du: ethers.utils.formatUnits(p.refDu || BN(0), cfg.DECIMALS),
      total: ethers.utils.formatUnits(p.refTotal || BN(0), cfg.DECIMALS),
      /* Ce qui n'est pas encore mur, et la date ou le plus vieux seau le
         devient. Une somme « en attente » sans date fait croire a un blocage ;
         avec la date, elle se comprend en une seconde. */
      attente: enAttente.total,
      attenteLe: enAttente.plusTot,
      delaiJours: cfg.REFERRAL_HOLD_DAYS,
      /* Ce qui est encore bloque, et combien il reste a miser pour le
         debloquer. Un montant bloque sans compteur pousse le joueur a ecrire
         au support ; avec le compteur, il joue. */
      bloque: ethers.utils.formatUnits(p.bonusBloque || BN(0), cfg.DECIMALS),
      /* Ce qu'il reste a « rendre a la maison » pour debloquer le cadeau.
         C'est le vrai verrou, donc c'est ce chiffre-la qu'il faut montrer —
         un compteur de volume ferait esperer une chose qui n'ouvre rien. */
      resteADonner: (p.bonusBloque && p.bonusBloque.gt(0))
        ? Math.max(0, Number(cfg.REFERRAL_WELCOME) - (p.revCumul || 0)) : 0,
      depotMini: cfg.REFERRAL_WELCOME_MIN,
    };
  }

  /** Le parrain encaisse. Un gain qui se cueille se remarque ; un gain qui
      tombe tout seul dans le solde passe inapercu. */
  reclameParrainage(addr) {
    this._murit(addr);
    const p = this._p(addr);
    const du = p.refDu || BN(0);
    if (du.lte(0)) throw new Error('nothing to claim yet');
    p.refDu = BN(0);
    p.balance = p.balance.add(du);
    const m = ethers.utils.formatUnits(du, cfg.DECIMALS);
    this.note('parrainage', m, String(addr).toLowerCase());
    journal.ajoute(String(addr).toLowerCase(), { k: 'rf', m, n: (p.filleuls || []).length });

    /* ---- L'XP DE PARRAINAGE, ET POURQUOI PAS A L'ATTACHE ----
     *
     * Payer au moment ou un filleul s'attache se ferme en dix minutes : on
     * cree dix adresses, on les lie, on encaisse dix fois. L'XP est donc due
     * UNE FOIS PAR FILLEUL, et seulement quand ce filleul a produit du revenu
     * — c'est-a-dire quand il a vraiment joue. Amener quelqu'un qui joue est
     * l'acte qu'on recompense ; creer une adresse n'en est pas un.
     *
     * `xpFilleuls` retient lesquels ont deja paye. Sans cette marque, chaque
     * reclamation suivante repaierait les memes.
     */
    p.xpFilleuls = p.xpFilleuls || {};
    const neufs = (p.filleuls || []).filter((f) => {
      if (p.xpFilleuls[f]) return false;
      const q = this.players.get(String(f).toLowerCase());
      return !!(q && Number(q.revCumul) > 0);
    });
    if (neufs.length) {
      neufs.forEach((f) => { p.xpFilleuls[f] = 1; });
      this._gagneXp(p, cfg.XP_PARRAIN * neufs.length, 'parrainage');
    }
    return { montant: m, balance: this.balanceStr(addr) };
  }

  /**
   * Les statistiques du profil. TOUT vient de ce qui est deja compte par
   * ailleurs — les compteurs par jeu, le record, le journal. Une statistique
   * qui aurait sa propre source finirait par contredire l'historique affiche
   * juste en dessous, et c'est l'historique qu'on croit.
   */
  stats(addr) {
    const p = this._p(addr);
    const jeux = p.jeux || {};
    let manches = 0, mise = 0, rendu = 0;
    const parJeu = [];
    for (const k of Object.keys(jeux)) {
      const j = jeux[k];
      manches += j.n || 0; mise += j.mise || 0; rendu += j.rendu || 0;
      parJeu.push({ jeu: k, n: j.n || 0, mise: j.mise || 0 });
    }
    parJeu.sort((x, y) => y.n - x.n);
    const r = journal.resume(String(addr).toLowerCase());
    return {
      depuis: r.depuis || null,
      manches, mise, net: rendu - mise,
      /* Les paris ne sont PAS dans `p.jeux` tant qu'ils ne sont pas regles :
         ils ont leur bilan a eux, tenu depuis les paris eux-memes. Sans lui,
         un joueur qui n'a fait que parier voit des zeros partout. */
      paris: this.statsParis(addr),
      favoris: parJeu.slice(0, 3),
      record: p.record || null,
      meilleurJour: p.meilleurJour || null,
      depose: ethers.utils.formatUnits(p.deposited || BN(0), cfg.DECIMALS),
      stakeReclame: ethers.utils.formatUnits(p.stakeClaimTotal || BN(0), cfg.DECIMALS),
      amis: (p.amis || []).length,
      filleuls: (p.filleuls || []).length,
      frais: this.infoFrais(),
      parrainGagne: ethers.utils.formatUnits(p.refTotal || BN(0), cfg.DECIMALS),
    };
  }

  _bumpDay(p) {
    const t = this._today();
    if (p.dayKey === t) return;
    /* Le jour qui se termine vaut peut-etre un record : c'est le seul moment
       ou son total est encore la. Apres la remise a zero, il n'existe plus
       nulle part. */
    if (p.dayKey && p.dayNet && p.dayNet.gt(0)) {
      const net = Number(ethers.utils.formatUnits(p.dayNet, cfg.DECIMALS));
      if (!p.meilleurJour || net > p.meilleurJour.net) p.meilleurJour = { jour: p.dayKey, net };
    }
    p.dayKey = t; p.dayNet = ethers.BigNumber.from(0); p.dropsToday = 0; p.winsToday = 0; p.questClaimed = {};
    p.primesEntrainement = {};
    p.miseJour = {};
    /* Les compteurs de collection du jour. Ils vivent ici, avec les autres,
       parce qu'ils se remettent a zero au meme instant — un compteur du jour
       qui a son propre reveil finit par se decaler d'un jour. */
    p.jourColl = { coffres: 0, neufs: 0, rarete: 0 };
  }
  jackpotStr() { return ethers.utils.formatUnits(this.jackpotPot, cfg.DECIMALS); }

  /* ==================================================================
   * LES PARIS SPORTIFS
   *
   * Ce n'est pas un jeu de casino, et la difference est toute la
   * difficulte : la mise part aujourd'hui, le resultat tombe dans trois
   * jours. Entre les deux, la maison porte un ENGAGEMENT — ce qu'elle devra
   * payer si les paris passent — qui n'existe nulle part ailleurs dans ce
   * serveur, ou chaque manche se regle dans la seconde.
   *
   * Trois regles en decoulent, et aucune n'est negociable :
   *
   *  1. LA COTE EST FIGEE A LA PRISE DU PARI. Elle est recopiee dans le
   *     pari lui-meme. Corriger une faute de frappe dans le catalogue ne
   *     doit jamais changer ce qu'un joueur croyait avoir accepte ;
   *  2. L'ENGAGEMENT EST PLAFONNE PAR MATCH. Sans plafond, quinze joueurs
   *     au maximum sur la meme issue a 7,50 engagent onze millions et
   *     demi sur un seul resultat. L'avantage de la maison est reel a la
   *     longue, mais « a la longue » ne paie pas un coffre vide samedi soir ;
   *  3. LE REGLEMENT NE PAIE QU'UNE FOIS. Un match regle deux fois, c'est
   *     de l'argent cree, et personne ne s'en plaindra assez vite pour
   *     qu'on le remarque.
   * ================================================================== */

  /**
   * Ce qu'on sait d'un match : le catalogue d'abord, LES PARIS ensuite.
   *
   * Un match peut quitter le calendrier — import qui ne le rend plus, volume
   * remis a zero, retention depassee. Tant qu'aucun pari n'y touche, ca n'a
   * aucune importance. Des qu'un pari y touche, c'est de l'argent bloque :
   * la rencontre ne s'affiche plus (« ? – ? »), elle ne remonte plus dans la
   * liste a regler, et `regleMatch` jetait « unknown match ». Le gagnant ne
   * pouvait plus etre paye du tout.
   *
   * On retombe donc sur ce que le pari a GARDE au moment de sa pose. C'est la
   * bonne source de verite : ce qui a ete vendu au joueur, pas ce que le
   * calendrier raconte aujourd'hui. Les paris poses avant que les jambes ne
   * portent cette copie rendent `null` — ils restent reglables, mais a
   * l'aveugle : voir `parisAregler` et `regleMatch`.
   */
  _infosMatch(matchId) {
    const id = String(matchId || '');
    const m = paris.match(id);
    if (m) return m;
    for (const p of (this.paris || [])) {
      for (const j of (p.jambes || [])) {
        if (j.match !== id || !j.domicile) continue;
        return {
          id, sport: j.sport || null, competition: j.competition || '',
          domicile: j.domicile, exterieur: j.exterieur,
          debut: Number(j.debut) || p.t,
          issues: (j.issues && j.issues.length) ? j.issues.slice() : paris.issues(j.sport),
          cotes: {}, horsCalendrier: true,
        };
      }
    }
    return null;
  }

  /** Tous les paris d'un match, regles ou non. */
  _parisDe(matchId) {
    return (this.paris || []).filter((p) =>
      (p.jambes || [{ match: p.match, choix: p.choix }]).some((j) => j.match === matchId));
  }

  /** Ce qu'un pari a choisi sur ce match, ou null s'il n'y touche pas. */
  _jambeSur(pari, matchId) {
    const l = pari.jambes || [{ match: pari.match, choix: pari.choix }];
    for (const j of l) if (j.match === matchId) return j;
    return null;
  }

  /**
   * CE QUE LA MAISON DEVRAIT PAYER AU PIRE SUR CE MATCH.
   *
   * ---- IL SE COMPTAIT PAR REPONSE, IL SE COMPTE PAR SCORE ----
   *
   * Tant qu'un match ne portait qu'une question, deux reponses ne pouvaient
   * pas tomber ensemble : prendre la plus chere suffisait. Des qu'il en porte
   * six, un 2-1 fait gagner EN MEME TEMPS le « 1 », le « 1X », le « 12 », le
   * « oui » des deux equipes, le « plus » de 2,5 et le score exact. Compter
   * reponse par reponse aurait donc annonce le sixieme du vrai engagement, et
   * le plafond n'aurait plus rien plafonne — sur le geste, justement, qui
   * engage la maison sans retour.
   *
   * On balaie donc les scores, et pour chacun on somme ce que TOUT ce qui est
   * pose paierait s'il tombait.
   *
   * ---- POURQUOI HUIT BUTS SUFFISENT ----
   *
   * Au-dela de trois ou quatre buts par equipe, l'ensemble des reponses
   * gagnantes ne depend plus que du signe de l'ecart, du fait qu'il vaille au
   * moins deux, du total au-dessus de 2,5, du fait que les deux aient marque,
   * et de « autre » au score exact. Toutes ces conditions sont deja
   * rencontrees quelque part dans la grille de zero a huit : un 12-0 paie
   * exactement les memes paris qu'un 8-0. La grille n'est donc pas un
   * echantillon, c'est un ENVELOPPE — et un essai le verifie en la comparant
   * a une grille de zero a trente.
   */
  engagementMatch(matchId) {
    const lignes = [];
    for (const p of this._parisDe(matchId)) {
      if (p.regle) continue;
      const j = this._jambeSur(p, matchId);
      if (j) lignes.push({ marche: j.marche, choix: j.choix, rapport: p.rapport });
    }
    if (!lignes.length) return 0;
    let pire = 0;
    for (let a = 0; a <= Game.ENGAGEMENT_BUTS; a++) {
      for (let b = 0; b <= Game.ENGAGEMENT_BUTS; b++) {
        let total = 0;
        for (const l of lignes) if (paris.gagne(l.marche, l.choix, { a, b })) total += l.rapport;
        if (total > pire) pire = total;
      }
    }
    return pire;
  }

  /** Les matchs ouverts, avec la place qu'il reste sur chacun. */
  parisOuverts(now) {
    const t = now || Date.now();
    return paris.ouverts(t).map((m) => {
      const v = paris.vue(m, t);
      v.engagement = Number(this.engagementMatch(m.id).toFixed(6));
      v.place = Math.max(0, cfg.PARI_ENGAGEMENT_MAX - v.engagement);
      return v;
    });
  }

  /**
   * Poser un pari : une seule selection, ou un COMBINE.
   *
   * Le combine multiplie les cotes et exige que TOUTES les selections
   * passent. Une seule fausse et le pari entier est perdu — c'est ce qui le
   * rend interessant pour le joueur (des rapports impossibles en simple) et
   * pour la maison (les marges se multiplient aussi : a 7,7 % la selection,
   * un combine de cinq porte 45 % de marge).
   *
   * MAIS L'ENGAGEMENT EXPLOSE AVEC LUI. Cinq selections a 2,00 font 32 fois
   * la mise : au plafond de mise, c'est 3,2 millions dus sur UN pari. Trois
   * bornes tiennent ca :
   *   • le GAIN d'un pari est plafonne, quel que soit le nombre de jambes ;
   *   • l'engagement d'un match compte le gain ENTIER de chaque combine qui
   *     le touche. C'est majorant — le combine peut encore tomber sur une
   *     autre jambe — et c'est exactement ce qu'on veut d'un garde-fou ;
   *   • deux jambes sur le MEME match sont refusees : elles seraient soit
   *     contradictoires, soit une facon de deguiser un simple en combine.
   */
  parie(addr, matchId, choixRaw, miseRaw, now) {
    return this.parieCombine(addr, [{ match: matchId, choix: choixRaw }], miseRaw, now);
  }

  /**
   * Un simple sur UN MARCHE donne. `parie` reste le raccourci du 1-N-2 : il a
   * des appelants partout, et lui ajouter un argument au milieu aurait fait
   * passer la mise pour un marche dans celui qu'on aurait oublie.
   */
  parieSur(addr, matchId, marche, choixRaw, miseRaw, now) {
    return this.parieCombine(addr, [{ match: matchId, marche, choix: choixRaw }], miseRaw, now);
  }

  parieCombine(addr, selectionsRaw, miseRaw, now) {
    const t = now || Date.now();
    const sel = Array.isArray(selectionsRaw) ? selectionsRaw : [];
    if (!sel.length) throw new Error('pick at least one selection');
    if (sel.length > cfg.PARI_JAMBES_MAX)
      throw new Error('at most ' + cfg.PARI_JAMBES_MAX + ' selections in one bet');

    const vus = new Set();
    const jambes = sel.map((x) => {
      const m = paris.match(x && x.match);
      if (!m) throw new Error('unknown match');
      if (m.debut <= t) throw new Error('betting is closed on ' + m.domicile + ' v ' + m.exterieur);
      /* Deux jambes sur le meme match : soit contradictoires, soit un simple
         deguise en combine pour contourner le plafond de gain. */
      if (vus.has(m.id)) throw new Error('only one selection per match');
      vus.add(m.id);
      /* ---- LA JAMBE PORTE SON MARCHE ----
       * Sans lui, « 1 » serait ambigu des la deuxieme question posee sur la
       * rencontre : le « 1 » du resultat et le « 1 » du handicap ne se reglent
       * pas sur les memes scores. Absent, c'est le 1-N-2 — les paris deja
       * poses n'ont pas de marche ecrit et ce sont tous des 1-N-2. */
      const marche = String((x && x.marche) || paris.MARCHE_BASE);
      const M = paris.MARCHES[marche];
      if (!M) throw new Error('unknown market ' + marche);
      const lot = m.marches && m.marches[marche];
      if (!lot)
        throw new Error('no ' + M.nom + ' on ' + m.domicile + ' v ' + m.exterieur);
      const choix = String(x.choix);
      if (lot.issues.indexOf(choix) < 0)
        throw new Error('pick ' + lot.issues.join(', ') + ' on ' + M.nom + ' — ' +
                        m.domicile + ' v ' + m.exterieur);
      /* LA JAMBE GARDE SA RENCONTRE. Les noms, le coup d'envoi et les issues
         sont recopies ici, une fois, au moment de la vente. Ils ne changeront
         plus : c'est le ticket, pas le calendrier. Sans cette copie, un match
         qui quitte le catalogue emporte avec lui de quoi afficher ET de quoi
         regler le pari — le gagnant devient impayable. Quelques octets par
         pari contre de l'argent bloque : le choix n'en est pas un. */
      return { match: m.id, marche, choix, cote: paris.coteDe(m, marche, choix),
               domicile: m.domicile, exterieur: m.exterieur, debut: m.debut,
               sport: m.sport, competition: m.competition, issues: m.issues.slice() };
    });

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.PARI_MIN)) throw new Error('minimum bet is ' + cfg.PARI_MIN + ' $SWOGEBET');
    if (mise > cfg.PARI_MAX) throw new Error('maximum bet is ' + cfg.PARI_MAX + ' $SWOGEBET');

    const p = this._p(addr);
    /* Le solde des PARIS, pas le $SWOGE : voir la note au debit, plus bas. */
    if ((p.betBalance || BN(0)).lt(WEI(mise))) throw new Error('not enough $SWOGEBET — deposit some in the bet vault');

    let cote = 1;
    for (const j of jambes) cote *= j.cote;
    cote = Math.floor(cote * 1e4) / 1e4;
    const rapport = paris.rapport(cote, mise);
    if (rapport > cfg.PARI_GAIN_MAX)
      throw new Error('this bet could return ' + Math.floor(rapport) +
        ' $SWOGEBET — the cap is ' + cfg.PARI_GAIN_MAX + '. Lower the stake or drop a leg.');

    /* Le plafond, match par match. Le gain ENTIER pese sur CHAQUE match
       touche : c'est majorant, et un garde-fou doit majorer. */
    for (const j of jambes) {
      /* Le meme balayage par SCORE que `engagementMatch`, celui-ci en y
         ajoutant la jambe qu'on est en train de vendre. Deux facons de compter
         l'engagement auraient fini par ne plus rendre le meme chiffre, et
         c'est celle qu'on n'ecrit pas dans le message d'erreur qui laisserait
         passer le pari de trop. */
      const lignes = [{ marche: j.marche, choix: j.choix, rapport }];
      for (const q of (this.paris || [])) {
        if (q.regle) continue;
        for (const b of (q.jambes || [])) {
          if (b.match !== j.match) continue;
          lignes.push({ marche: b.marche, choix: b.choix, rapport: q.rapport });
        }
      }
      let pire = 0;
      for (let a = 0; a <= Game.ENGAGEMENT_BUTS; a++) {
        for (let b2 = 0; b2 <= Game.ENGAGEMENT_BUTS; b2++) {
          let total = 0;
          for (const l of lignes) if (paris.gagne(l.marche, l.choix, { a, b: b2 })) total += l.rapport;
          if (total > pire) pire = total;
        }
      }
      if (pire > cfg.PARI_ENGAGEMENT_MAX) {
        const m = paris.match(j.match);
        throw new Error(m.domicile + ' v ' + m.exterieur + ' is full — ' +
          Math.max(0, Math.floor(cfg.PARI_ENGAGEMENT_MAX - this.engagementMatch(j.match))) +
          ' $SWOGEBET of exposure left');
      }
    }

    /* ---- LA MISE PART DU SOLDE DES PARIS, EN $SWOGEBET ----
     * « Qu'on puisse jouer aux paris qu'avec du SWOGEBET. » Le solde $SWOGE
     * n'est plus touche par un pari : ce qui se mise ici est entre par
     * SwogeBetVault, et ce qui se gagne y retourne (`regleMatch`,
     * `rembourseMatch`). Le compteur de mises du jour et les missions
     * continuent de compter le pari comme une activite — c'est ce qu'ils
     * mesurent — mais le montant, lui, n'est pas du $SWOGE. */
    p.betBalance = (p.betBalance || BN(0)).sub(WEI(mise));
    this._bumpDay(p); p.dropsToday++;
    this._markWager(p, WEI(mise), 'paris');

    if (!this.paris) this.paris = [];
    const pari = {
      id: 'b' + (++this.parisSeq) + '-' + Math.floor(t / 1000).toString(36),
      addr: String(addr).toLowerCase(),
      jambes, cote, mise, rapport, t,
      /* ---- LA MONNAIE DU TICKET ----
         « Des gens ont mise en $SWOGE hier : toutes les mises en $SWOGE
         devront etre payees en $SWOGE. » Un ticket porte donc la monnaie
         dans laquelle sa mise est partie, et c'est elle qui recoit le gain ou
         le remboursement. Un ticket d'avant ce champ n'en a pas : il a ete
         paye en $SWOGE, il sera regle en $SWOGE. */
      jeton: 'swogebet',
      regle: false, gagne: null,
      /* Les champs d'un simple restent remplis : les paris deja poses et les
         pages en service les lisent. */
      match: jambes[0].match, choix: jambes[0].choix,
    };
    this.paris.push(pari);
    journal.ajoute(pari.addr, { k: 'pa', s: 'pose', m: String(mise),
                                match: jambes.map((j) => j.match).join('+'),
                                choix: jambes.map((j) => j.choix).join('+'), cote, rapport });
    return pari;
  }

  /**
   * TOUS les paris, pour le panneau d'administration.
   *
   * Pourquoi une methode a part plutot que `mesParis` sans adresse : ce qui
   * est demande ici n'est pas la meme chose. Le joueur veut SES paris, en
   * clair ; l'exploitant veut retrouver UN pari a partir de son identifiant,
   * savoir qui l'a pose, et voir ce qui est encore en jeu. La recherche porte
   * donc sur l'identifiant du pari, celui du match, l'adresse et le nom —
   * les quatre choses qu'on a sous la main quand quelqu'un signale un
   * probleme.
   *
   * L'identifiant du pari est la piece maitresse : il est affiche au joueur,
   * ecrit dans le journal, et repris ici. Un joueur qui ecrit « mon pari
   * b41-mfx2 n'a pas ete paye » se verifie en une recherche au lieu de
   * fouiller un fichier.
   */
  tousParis(opt) {
    const o = opt || {};
    const q = String(o.q || '').trim().toLowerCase();
    const etat = String(o.etat || 'tous');
    const t = Number(o.now) || Date.now();

    let liste = (this.paris || []);
    if (etat === 'ouvert') liste = liste.filter((p) => !p.regle);
    else if (etat === 'regle') liste = liste.filter((p) => p.regle);

    if (q) {
      liste = liste.filter((p) => {
        if (String(p.id).toLowerCase().includes(q)) return true;
        if (String(p.addr).toLowerCase().includes(q)) return true;
        const f = this.players.get(p.addr);
        const nom = (f && f.name) || '';
        if (nom && String(nom).toLowerCase().includes(q)) return true;
        return (p.jambes || []).some((j) => String(j.match).toLowerCase().includes(q));
      });
    }

    const total = liste.length;
    /* Le total AVANT la tranche : « 3 sur 412 » se lit, « 3 » ne dit rien. */
    const debut = Math.max(0, Number(o.debut) || 0);
    const page = liste.sort((x, y) => y.t - x.t)
      .slice(debut, debut + (Number(o.limite) || 50));

    /* Les sommes portent sur TOUT ce qui est filtre, pas sur la page : c'est
       l'engagement reel qu'on veut voir, pas celui des cinquante premiers. */
    let mise = 0, engage = 0, paye = 0;
    for (const p of liste) {
      mise += p.mise;
      if (!p.regle) engage += p.rapport;
      else if (p.gagne) paye += p.rapport;
      else if (p.gagne === null) paye += p.mise;
    }

    return {
      total, debut, encore: debut + page.length < total,
      resume: { mise: Math.round(mise), engage: Math.round(engage), paye: Math.round(paye),
                ouverts: (this.paris || []).filter((x) => !x.regle).length },
      paris: page.map((p) => {
        const j0 = this._infosMatch(p.match);
        return {
          id: p.id, addr: p.addr,
          nom: (this.players.get(p.addr) || {}).name || null,
          t: p.t, mise: p.mise, cote: p.cote, rapport: p.rapport,
          regle: !!p.regle, gagne: p.regle ? p.gagne : null,
          /* L'etat en un mot, calcule ici : trois pages differentes le
             deduisaient chacune a sa facon, et une seule s'y prenait bien. */
          /* Rencontre introuvable — ni au calendrier, ni sur le ticket : elle
             ne se jouera plus jamais « plus tard ». « running » laissait
             croire qu'il n'y avait rien a faire ; c'est justement l'inverse. */
          etat: !p.regle ? (!j0 || j0.debut <= t ? 'a regler' : 'en cours')
                         : p.gagne === null ? 'rembourse' : p.gagne ? 'gagne' : 'perdu',
          jambes: (p.jambes || []).map((j) => {
            const m = this._infosMatch(j.match);
            return { match: j.match, choix: j.choix, cote: j.cote,
                     domicile: m ? m.domicile : '?', exterieur: m ? m.exterieur : '?',
                     debut: m ? m.debut : null, sport: m ? m.sport : null,
                     issues: m ? m.issues.slice() : [],
                     /* La rencontre n'est plus au calendrier : le panneau le
                        dit plutot que d'afficher « ? – ? » sans explication. */
                     horsCalendrier: !!(m && m.horsCalendrier) || !m,
                     regle: !!(this.parisRegles && this.parisRegles[j.match]),
                     resultat: (this.parisRegles && this.parisRegles[j.match]
                                && this.parisRegles[j.match].resultat) || null };
          }),
        };
      }),
    };
  }

  /**
   * Les rencontres qui ATTENDENT un resultat, pour le panneau.
   *
   * C'est la seule liste qui demande une action humaine : le coup d'envoi est
   * passe, des paris sont en jeu, et rien n'a encore ete decide. Tant qu'elle
   * n'est pas vide, des joueurs attendent d'etre payes.
   *
   * On rend l'exposition ISSUE PAR ISSUE, et c'est le point important : avant
   * de cliquer, on doit voir ce que CHAQUE resultat coute a la maison. Un
   * seul total ne dit rien — c'est la difference entre les issues qui permet
   * de reperer une erreur de saisie avant qu'elle ne paie.
   */
  parisAregler(now) {
    const t = Number(now) || Date.now();
    if (!this.parisRegles) this.parisRegles = {};
    const parMatch = new Map();
    for (const p of (this.paris || [])) {
      if (p.regle) continue;
      for (const j of (p.jambes || [])) {
        if (!parMatch.has(j.match)) parMatch.set(j.match, []);
        parMatch.get(j.match).push({ p, j });
      }
    }
    /* ---- ON PART DU CATALOGUE, PAS DES PARIS ----
     *
     * La liste ne montrait que les rencontres SUR LESQUELLES QUELQU'UN AVAIT
     * MISE. Une rencontre jouee que personne n'avait prise n'apparaissait donc
     * nulle part : elle restait indefiniment « en attente » sans qu'aucun
     * ecran ne le dise, et le jour ou un pari tombait dessus — un combine, un
     * retardataire — elle sortait de nulle part avec plusieurs jours de retard.
     *
     * On enumere donc toutes les rencontres du calendrier, et les paris ne font
     * plus que RENSEIGNER celles qui en ont. Une rencontre sans pari s'affiche
     * a zero : elle ne coute rien a trancher, et la trancher la sort de la
     * liste au lieu de la laisser trainer.
     */
    /* ---- ET LES RENCONTRES QUI ONT QUITTE LE CATALOGUE ----
     *
     * Partir du calendrier ne suffit pas : une rencontre peut en SORTIR alors
     * que des paris y dorment encore. Elle n'apparaissait alors nulle part,
     * aucun bouton ne permettait de la trancher, et `regleMatch` la refusait.
     * Le pari restait ouvert pour toujours — c'est precisement ce qui est
     * arrive au 17 aout, apres un redemarrage qui a rendu au conteneur le
     * calendrier du depot.
     *
     * On ajoute donc toute rencontre PORTANT UN PARI NON REGLE et absente du
     * calendrier. Ce qu'on sait d'elle vient du ticket ; les paris poses avant
     * que les jambes ne gardent leur rencontre n'ont pas de fiche du tout, et
     * on l'affiche alors telle quelle — l'identifiant seul (« spainlaliga-
     * 20260817-dep-elc ») dit deja quelle rencontre c'etait, et le bouton
     * « Refund all » reste toujours disponible en cas de doute.
     */
    const rencontres = paris.catalogue().matchs.slice();
    const auCatalogue = new Set(rencontres.map((m) => m.id));
    for (const id of parMatch.keys()) {
      if (auCatalogue.has(id)) continue;
      const su = this._infosMatch(id);
      rencontres.push(su || {
        id, sport: null, competition: '', domicile: '?', exterieur: '?',
        /* Faute de mieux, la pose du pari : un pari se pose AVANT le coup
           d'envoi, donc l'attente affichee est un minorant honnete. */
        debut: Math.min(...parMatch.get(id).map((x) => x.p.t)),
        issues: paris.ISSUES.slice(), cotes: {},
        horsCalendrier: true, sansFiche: true,
      });
    }

    const sortie = [];
    for (const m of rencontres) {
      const id = m.id;
      if (this.parisRegles[id]) continue;             // deja tranchee
      /* Une rencontre du calendrier qui n'a pas commence n'attend rien. Une
         rencontre SORTIE du calendrier, si : elle ne reviendra pas toute
         seule, et ses paris sont bloques des maintenant. */
      if (m.debut > t && !m.horsCalendrier) continue;
      const lignes = parMatch.get(id) || [];
      const expo = {};
      for (const i of m.issues) expo[i] = 0;
      let mise = 0;
      const joueurs = new Set();
      for (const { p, j } of lignes) {
        /* Le gain ENTIER pese sur l'issue choisie : un combine ne paie que si
           toutes ses jambes passent, mais du point de vue de CE match, c'est
           ce choix-la qui ouvre la porte. Majorant, et un garde-fou majore. */
        expo[j.choix] = (expo[j.choix] || 0) + p.rapport;
        mise += p.mise;
        joueurs.add(p.addr);
      }
      sortie.push({
        id, sport: m.sport, competition: m.competition,
        domicile: m.domicile, exterieur: m.exterieur, debut: m.debut,
        issues: m.issues.slice(),
        cotes: Object.assign({}, (m.marches && m.marches[paris.MARCHE_BASE]
                                  || { cotes: {} }).cotes),
        paris: lignes.length, joueurs: joueurs.size, mise: Math.round(mise),
        expo: Object.fromEntries(m.issues.map((i) => [i, Math.round(expo[i] || 0)])),
        /* Depuis combien de temps elle attend. Une rencontre qui attend depuis
           deux jours est une rencontre qu'on a oubliee. */
        attendDepuisMin: Math.max(0, Math.round((t - m.debut) / 60000)),
        /* Le panneau doit pouvoir le DIRE : une rencontre hors calendrier se
           regle a la main, sans cotes affichees, et merite qu'on regarde son
           identifiant avant de cliquer. */
        horsCalendrier: !!m.horsCalendrier, sansFiche: !!m.sansFiche,
      });
    }
    return sortie.sort((a, b) => a.debut - b.debut);
  }

  /* ================= LE BILAN DES PARIS, PAR JOUEUR =================
   *
   * ---- pourquoi ca ne pouvait pas venir de `p.jeux` ----
   *
   * Les compteurs du profil et du panneau lisent `p.jeux`, qui est ecrit par
   * `_manche` — c'est-a-dire A LA FIN d'une manche. Un pari sportif n'a pas
   * de fin le jour ou il est pose : il se regle le lendemain, ou jamais si le
   * match a disparu du calendrier. Un joueur qui avait mise trois mille
   * jetons le samedi affichait donc « aucune manche enregistree » et zero
   * partout, ce qui se lit comme un compteur casse — et qui l'etait, en un
   * sens : il comptait autre chose que ce qu'on lui demandait.
   *
   * On repart donc de `this.paris`, qui est la source de verite : chaque
   * pari y est range des sa pose, et son etat y est celui d'aujourd'hui.
   *
   * ---- ce que chaque chiffre veut dire, exactement ----
   *
   *   • le TAUX DE REUSSITE porte sur les paris TRANCHES, remboursements
   *     exclus : un match annule n'est ni gagne ni perdu, et le compter en
   *     defaite ferait baisser un taux sans qu'aucun pari n'ait ete perdu ;
   *   • le RESULTAT ne compte que les paris regles. Un pari en cours n'est
   *     ni gagne ni perdu, et l'inscrire en perte affiche un joueur perdant
   *     le samedi soir qui redevient gagnant le dimanche sans avoir rien
   *     fait ;
   *   • ce qui est EN JEU et ce qui EST A GAGNER se disent a part. C'est la
   *     seule paire de chiffres qui reponde a « ou j'en suis, la, tout de
   *     suite ».
   * ================================================================ */

  /** Le bilan de TOUS les parieurs en une passe. `Map` adresse -> bilan. */
  _bilansParis() {
    const par = new Map();
    const vide = () => ({
      total: 0, ouverts: 0, gagnes: 0, perdus: 0, rembourses: 0,
      mise: 0, miseJugee: 0, rendu: 0, enJeu: 0, aGagner: 0, plusGros: null,
    });
    for (const p of (this.paris || [])) {
      const a = String(p.addr || '').toLowerCase();
      if (!a) continue;
      let b = par.get(a);
      if (!b) { b = vide(); par.set(a, b); }
      b.total++;
      b.mise += p.mise;
      if (!p.regle) { b.ouverts++; b.enJeu += p.mise; b.aGagner += p.rapport; continue; }
      /* `gagne === null` : rembourse. La mise revient, donc le resultat ne
         bouge pas — et le pari ne compte dans aucun des deux camps. */
      if (p.gagne === null) { b.rembourses++; continue; }
      b.miseJugee += p.mise;
      if (p.gagne) {
        b.gagnes++; b.rendu += p.rapport;
        if (!b.plusGros || p.rapport > b.plusGros.rendu)
          b.plusGros = { id: p.id, mise: p.mise, cote: p.cote, rendu: p.rapport, t: p.t };
      } else b.perdus++;
    }
    for (const b of par.values()) this._finBilan(b);
    return par;
  }

  /** Les chiffres derives, poses une seule fois, au meme endroit. */
  _finBilan(b) {
    const juges = b.gagnes + b.perdus;
    b.juges = juges;
    /* Sans un seul pari tranche, le taux n'est pas « 0 % » — il n'existe pas.
       Afficher 0 % a quelqu'un dont le premier pari court encore serait une
       information fausse, et decourageante pour rien. */
    b.taux = juges ? Number(((b.gagnes / juges) * 100).toFixed(1)) : null;
    b.net = Number((b.rendu - b.miseJugee).toFixed(6));
    b.mise = Number(b.mise.toFixed(6));
    b.miseJugee = Number(b.miseJugee.toFixed(6));
    b.rendu = Number(b.rendu.toFixed(6));
    b.enJeu = Number(b.enJeu.toFixed(6));
    b.aGagner = Number(b.aGagner.toFixed(6));
    return b;
  }

  /** Le bilan d'UN joueur. Zero partout s'il n'a jamais parie. */
  statsParis(addr) {
    const a = String(addr || '').toLowerCase();
    const b = {
      total: 0, ouverts: 0, gagnes: 0, perdus: 0, rembourses: 0,
      mise: 0, miseJugee: 0, rendu: 0, enJeu: 0, aGagner: 0, plusGros: null,
    };
    for (const p of (this.paris || [])) {
      if (String(p.addr || '').toLowerCase() !== a) continue;
      b.total++; b.mise += p.mise;
      if (!p.regle) { b.ouverts++; b.enJeu += p.mise; b.aGagner += p.rapport; continue; }
      if (p.gagne === null) { b.rembourses++; continue; }
      b.miseJugee += p.mise;
      if (p.gagne) {
        b.gagnes++; b.rendu += p.rapport;
        if (!b.plusGros || p.rapport > b.plusGros.rendu)
          b.plusGros = { id: p.id, mise: p.mise, cote: p.cote, rendu: p.rapport, t: p.t };
      } else b.perdus++;
    }
    return this._finBilan(b);
  }

  /** Les paris d'un joueur, du plus recent au plus ancien. */
  mesParis(addr, limite) {
    const a = String(addr).toLowerCase();
    return (this.paris || []).filter((p) => p.addr === a)
      .sort((x, y) => y.t - x.t).slice(0, limite || 50)
      .map((p) => {
        const m = this._infosMatch(p.match);
        return Object.assign({}, p, {
          domicile: m ? m.domicile : '?', exterieur: m ? m.exterieur : '?',
          debut: m ? m.debut : null, competition: m ? m.competition : '',
          /* Chaque jambe porte SA rencontre. Sans ca, un combine regle
             n'affiche que la premiere : les pages lisent les noms dans le
             calendrier des matchs OUVERTS, et un match joue n'y est plus.
             On recopie la jambe — l'objet range dans `this.paris` ne doit
             pas bouger, il sert au reglement. */
          jambes: (p.jambes || []).map((j) => {
            const mj = this._infosMatch(j.match);
            return Object.assign({}, j, {
              domicile: mj ? mj.domicile : '?', exterieur: mj ? mj.exterieur : '?',
              debut: mj ? mj.debut : null, competition: mj ? mj.competition : '',
              /* Le SPORT, sans quoi la page ne sait pas si « 1 » se dit
                 « Home » ou « Player 1 » : la NFL et le cricket n'ont que
                 deux issues eux aussi, mais opposent des EQUIPES. */
              sport: mj ? mj.sport : null,
              issues: mj ? mj.issues.slice() : [],
            });
          }),
        });
      });
  }

  /**
   * Regler un match. Paie les gagnants, marque les perdants, UNE SEULE FOIS.
   *
   * Le resultat est celui du terrain : '1', 'N' ou '2'. Le reglement se fait
   * a la main, et c'est assume — un service de resultats automatique qui se
   * trompe paie les mauvaises personnes sans que personne ne le sache.
   */
  /**
   * REGLER UNE RENCONTRE — PAR SON SCORE.
   *
   * ---- CE QUE `quoi` ACCEPTE ----
   * Un SCORE, « 2-1 », et c'est la forme a preferer. Ou une lettre, « 1 »,
   * « N », « 2 » — ce que le sport n'a pas de score comptable accepte, et ce
   * que les habitudes de la ligne de commande envoient encore.
   *
   * ---- UN SEUL ARGUMENT, ET LE RESULTAT SE DEDUIT ----
   * On aurait pu prendre les deux, le score ET le resultat. Ils se seraient
   * contredits un jour — un doigt qui glisse, « 2-1 » avec « N » — et rien
   * n'aurait dit lequel croire, pendant que l'un des deux payait les mauvaises
   * personnes. Le score decide de tout ; le resultat en est une lecture.
   *
   * ---- ET C'EST CE QUI REND LES AUTRES PARIS POSSIBLES ----
   * « Les deux equipes marquent » ne se lit pas dans un « 1 » : un 1-0 et un
   * 3-2 donnent la meme lettre et ne paient pas les memes gens. Sans le score
   * enregistre, aucun marche autre que le 1-N-2 n'est reglable — ni
   * aujourd'hui, ni retroactivement.
   */
  regleMatch(matchId, quoi) {
    /* ---- UNE RENCONTRE ABSENTE DU CALENDRIER RESTE REGLABLE ----
     *
     * Refuser net (« unknown match ») protegeait d'une faute de frappe, mais
     * au prix bien plus lourd de rendre IMPAYABLE tout pari dont la rencontre
     * avait quitte le catalogue. Entre les deux, il n'y a pas photo : une
     * faute de frappe sur un identifiant sans pari ne coute rien, un gagnant
     * qu'on ne peut plus payer coute la confiance.
     *
     * On accepte donc a deux conditions : ou bien on sait de quoi il s'agit
     * (catalogue, ou fiche gardee par le ticket), ou bien la rencontre porte
     * au moins un pari NON REGLE — un identifiant invente n'en porte aucun.
     */
    const m = this._infosMatch(matchId);
    const issues = m ? m.issues
      : (this._parisDe(matchId).some((p) => !p.regle) ? paris.ISSUES : null);
    if (!issues) throw new Error('unknown match');
    const score = paris.scoreLu(quoi);
    const resultat = score ? paris.resultatDuScore(score) : String(quoi);
    /* ---- UN NUL SUR UN SPORT QUI N'EN A PAS ----
     * Le tennis, la NBA, la NFL et le cricket se cotent en deux issues : un
     * score a egalite ne peut pas venir de la rencontre, il vient de la
     * saisie. Le laisser passer paierait tout le monde perdant en silence. */
    if (score && issues.indexOf(resultat) < 0)
      throw new Error(`a level score (${score.a}-${score.b}) is impossible here — ` +
                      'this sport settles on ' + issues.join(', '));
    if (issues.indexOf(resultat) < 0)
      throw new Error('result must be a score like 2-1, or one of ' + issues.join(', '));
    if (!this.parisRegles) this.parisRegles = {};
    if (this.parisRegles[matchId]) throw new Error('already settled');
    /* ---- UNE LETTRE NE SAIT PAS TRANCHER LES AUTRES MARCHES ----
     * « 1 » ne dit pas si les deux equipes ont marque : un 1-0 et un 3-2
     * donnent la meme lettre. Regler a la lettre une rencontre portant un pari
     * « les deux equipes marquent » ferait PERDRE tout le monde en silence —
     * la jambe ne trouverait aucun score, ne gagnerait pas, et le pari serait
     * clos. On refuse, en disant quoi faire : donner le score. */
    if (!score) {
      const bloquants = new Set();
      for (const p of this._parisDe(matchId)) {
        if (p.regle) continue;
        const j = this._jambeSur(p, matchId);
        if (j && (j.marche || paris.MARCHE_BASE) !== paris.MARCHE_BASE) bloquants.add(j.marche);
      }
      if (bloquants.size)
        throw new Error('this fixture carries bets on ' + [...bloquants].join(', ') +
          ' — settle it with the final score (like 2-1), not a result letter');
    }

    /* On enregistre le resultat AVANT de regarder les paris : un combine ne
       peut etre juge que quand toutes ses jambes ont un resultat, et c'est
       cette table qui le dit.
       Le SCORE part avec lui, quand on l'a. C'est lui qui rendra reglables les
       marches autres que le 1-N-2 — et une rencontre reglee sans score ne le
       sera jamais, meme plus tard : on ne peut pas deduire un score d'une
       lettre. */
    this.parisRegles[matchId] = { t: Date.now(), resultat,
                                  score: score ? `${score.a}-${score.b}` : null };

    let paye = 0, gagnants = 0, mise = 0, perdus = 0, attente = 0;
    let top = null;
    for (const p of this._parisDe(matchId)) {
      if (p.regle) continue;
      const v = this._jugePari(p);
      if (v === null) { attente++; continue; }      // il reste des jambes a jouer
      p.regle = true; p.gagne = v;
      mise += p.mise;
      const rendu = v ? p.rapport : 0;
      if (rendu > 0) {
        const q = this._p(p.addr);
        /* Le gain revient la ou la mise est partie : au solde des paris pour
           un ticket en $SWOGEBET, au solde $SWOGE pour un ticket d'avant. */
        this._crediteTicket(q, p, WEI(rendu));
        this._bumpDay(q); q.winsToday++;
        paye += rendu; gagnants++;
      } else perdus++;
      /* LE PLUS GROS GAGNANT DE CE REGLEMENT. On le retient au passage plutot
         que de rendre la liste entiere : un match populaire peut regler des
         centaines de paris, et l'appelant n'a besoin que de celui-la pour
         l'annoncer. Retenir tout le tableau ferait porter a chaque reglement
         le poids de son affluence. */
      if (rendu > 0 && (!top || rendu > top.rendu))
        top = { addr: p.addr, mise: p.mise, rendu, cote: p.cote,
                jambes: (p.jambes || []).length || 1 };
      journal.ajoute(p.addr, { k: 'pa', s: 'regle', m: String(p.mise), match: matchId,
                               cote: p.cote, resultat,
                               score: score ? `${score.a}-${score.b}` : undefined,
                               rendu: String(rendu) });
      this._manche(this._p(p.addr), 'paris', p.mise, rendu);
    }
    const r = this.parisRegles[matchId];
    r.gagnants = gagnants; r.paye = paye; r.perdus = perdus; r.attente = attente;
    return { match: matchId, resultat, score: score ? `${score.a}-${score.b}` : null,
             gagnants, perdus, enAttente: attente, paye, mise, net: mise - paye, top };
  }

  /**
   * Un pari est-il gagne, perdu, ou pas encore jugeable ?
   *
   *   true  : toutes les jambes sont tombees du bon cote ;
   *   false : au moins une jambe est perdue — inutile d'attendre les autres,
   *           un combine tombe entierement des la premiere erreur ;
   *   null  : il reste des matchs a jouer.
   */
  /**
   * UNE JAMBE A-T-ELLE GAGNE ?
   *
   * Le SCORE tranche quand on l'a — c'est le seul juge qui sache lire les six
   * marches. La lettre ne sait trancher que le 1-N-2, et c'est ce qui rend le
   * garde de `regleMatch` necessaire : une rencontre portant un pari « les
   * deux equipes marquent » ne peut PAS etre reglee a la lettre.
   */
  static _jambeGagne(jambe, regle) {
    const marche = jambe.marche || paris.MARCHE_BASE;
    if (regle.score) {
      const s = paris.scoreLu(regle.score);
      if (s) return paris.gagne(marche, jambe.choix, s);
    }
    return marche === paris.MARCHE_BASE && regle.resultat === jambe.choix;
  }
  _jugePari(pari) {
    const l = pari.jambes || [{ match: pari.match, choix: pari.choix }];
    let complet = true;
    for (const j of l) {
      const r = (this.parisRegles || {})[j.match];
      if (!r || r.rembourse) { complet = false; continue; }
      if (!Game._jambeGagne(j, r)) return false;     // une seule fausse suffit
    }
    return complet ? true : null;
  }

  /**
   * Rembourser un match — report, annulation, cote saisie de travers.
   *
   * Rendre la mise n'est pas une faveur : un match qui ne se joue pas n'a
   * produit aucun resultat, et garder l'argent reviendrait a encaisser un
   * pari qui n'a jamais eu lieu.
   */
  rembourseMatch(matchId) {
    if (!this.parisRegles) this.parisRegles = {};
    if (this.parisRegles[matchId]) throw new Error('already settled');
    const liste = this._parisDe(matchId).filter((p) => !p.regle);
    let rendu = 0;
    for (const p of liste) {
      p.regle = true; p.gagne = null;
      const q = this._p(p.addr);
      this._crediteTicket(q, p, WEI(p.mise));
      this._bumpDay(q);
      rendu += p.mise;
      journal.ajoute(p.addr, { k: 'pa', s: 'rembourse', m: String(p.mise), match: matchId });
    }
    this.parisRegles[matchId] = { t: Date.now(), resultat: null, rembourse: true,
                                  paris: liste.length, rendu };
    return { match: matchId, paris: liste.length, rendu };
  }

  /** La monnaie d'un ticket : 'swogebet' depuis le coffre des paris, 'swoge'
      pour tout ticket pose avant lui (le champ n'existait pas). */
  static jetonDuTicket(pari) { return pari && pari.jeton === 'swogebet' ? 'swogebet' : 'swoge'; }

  /** Verser a un joueur ce qu'un ticket lui doit, dans la monnaie du ticket. */
  _crediteTicket(q, pari, wei) {
    if (Game.jetonDuTicket(pari) === 'swogebet') q.betBalance = (q.betBalance || BN(0)).add(wei);
    else { q.balance = q.balance.add(wei); q.dayNet = q.dayNet.add(wei); }
  }

  /** Ce que la maison doit encore sur l'ensemble des paris non regles. */
  engagementTotal() {
    const vus = new Set();
    let total = 0;
    for (const p of (this.paris || [])) if (!p.regle) vus.add(p.match);
    for (const id of vus) total += this.engagementMatch(id);
    return Number(total.toFixed(6));
  }

  // ---- Staking: 100% APR, sortie libre a tout moment ----
  _lockMs() { return cfg.STAKE_LOCK_DAYS * 86400000; }

  /* ---- CE QUI FAIT QU UNE POSITION EST BLOQUEE ----
   *
   * C'est la PENALITE, pas la date. Un verrou qui ne coute rien a franchir
   * n'est pas un verrou : l'annoncer quand meme afficherait « bloque jusqu'au
   * 14 aout 2027 » a quelqu'un qui peut sortir dans la seconde, et c'est la
   * pire des deux erreurs — celle qui retient un joueur qui n'avait aucune
   * raison de rester dehors.
   *
   * Poser la question dans ce sens regle aussi les positions DEJA PRISES :
   * elles portent une date d'echeance ecrite au moment du depot, et rien ne
   * la reecrira jamais. En faisant dependre le verrou de la penalite en
   * vigueur, elles se deverrouillent toutes seules le jour ou la penalite
   * tombe a zero, sans migration ni retouche de l'etat.
   */
  _verrouille(pos, now) {
    return cfg.STAKE_EARLY_PENALTY_BPS > 0 && now < pos.u;
  }
  _pendingPos(pos) {
    const elapsed = Date.now() - pos.s;
    if (elapsed <= 0) return BN(0);
    return pos.a.mul(this._stakeRateBps).mul(elapsed).div(10000).div(MS_YEAR); // a × apr × elapsed/yr
  }
  _pendingAll(p) { let y = BN(0); for (const pos of p.stakes) y = y.add(this._pendingPos(pos)); return y; }
  _settleStakes(p) { const now = Date.now(); for (const pos of p.stakes) { p.stakeAccrued = p.stakeAccrued.add(this._pendingPos(pos)); pos.s = now; } }
  _stakedTotal(p) { let s = BN(0); for (const pos of p.stakes) s = s.add(pos.a); return s; }

  /* ---- LE PLAFOND, TOUS JOUEURS CONFONDUS ----
   *
   * A 100 % l'an, chaque jeton en staking engage la maison a en rendre deux
   * dans un an. Le plafond met une borne CONNUE D'AVANCE a cette dette : au
   * maximum 20 % de l'offre en staking, donc au maximum 20 % de l'offre de
   * rendement sur l'annee. Sans lui, un seul gros porteur peut engager le
   * coffre pour une somme qu'on ne decouvrira que douze mois plus tard.
   *
   * La place se LIBERE quand quelqu'un sort : ce n'est pas une porte fermee,
   * c'est une salle pleine.
   */
  plafondStaking() {
    const pct = Math.max(0, Math.min(10000, cfg.STAKE_CAP_BPS || 0));
    if (!pct) return null;                                   // 0 = pas de plafond
    /* L'offre lue sur la chaine si le serveur l'a eue, sinon celle du fichier
       de config. */
    const offre = (this.offreTotale && !this.offreTotale.isZero())
      ? this.offreTotale : WEI(String(cfg.TOKEN_SUPPLY));
    return offre.mul(pct).div(10000);
  }

  /**
   * Le plafond d'UN portefeuille : une part de la salle, pas de l'offre.
   *
   * Si le plafond global bouge, celui-ci suit, et le rapport « combien de
   * portefeuilles au minimum pour remplir la salle » reste celui qui a ete
   * choisi. Rend null quand il n'y a pas de plafond global : plafonner une
   * part d'un infini n'aurait pas de sens.
   */
  plafondJoueur() {
    const salle = this.plafondStaking();
    if (!salle) return null;
    const pct = Math.max(0, Math.min(10000, cfg.STAKE_CAP_JOUEUR_BPS || 0));
    if (!pct) return null;                                   // 0 = pas de plafond par joueur
    return salle.mul(pct).div(10000);
  }

  /**
   * Ce qu'il reste a CE portefeuille.
   *
   * Une position deja ouverte au-dessus du plafond n'est pas rognee : elle
   * reste, et il reste zero. On ne casse pas un engagement pris sous une
   * autre regle — on empeche seulement d'en ajouter.
   */
  placeJoueur(addr) {
    const max = this.plafondJoueur();
    if (!max) return null;
    const deja = this._stakedTotal(this._p(addr));
    return max.gt(deja) ? max.sub(deja) : BN(0);
  }

  /** Ou en est la salle : ce qui est pris, ce qui reste, et le taux de
   *  remplissage. C'est ce que la page de staking affiche AVANT que le joueur
   *  tape un montant — un refus qui arrive apres la saisie est une brimade. */
  capaciteStaking(addr) {
    const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
    const plafond = this.plafondStaking();
    const occupe = this.totalStaked();
    /* Le plafond personnel part AVEC la capacite de la salle, pour la meme
       raison qu'elle : un refus qui arrive apres la saisie est une brimade. */
    const maxJoueur = this.plafondJoueur();
    const perso = addr && maxJoueur ? {
      plafondJoueur: f(maxJoueur),
      dejaJoueur: f(this._stakedTotal(this._p(addr))),
      libreJoueur: f(this.placeJoueur(addr)),
      partSalle: cfg.STAKE_CAP_JOUEUR_BPS / 100,
    } : (maxJoueur ? { plafondJoueur: f(maxJoueur), partSalle: cfg.STAKE_CAP_JOUEUR_BPS / 100 } : {});
    if (!plafond) return { plafond: null, occupe: f(occupe), libre: null, taux: 0, plein: false, ...perso };
    const libre = plafond.gt(occupe) ? plafond.sub(occupe) : BN(0);
    /* On ARRONDIT VERS LE BAS. A 99,9995 %, un arrondi au plus proche affiche
       « 100 % » alors qu'il reste de la place : le joueur renonce a une salle
       qui l'aurait accepte. Cent pour cent ne s'affiche que quand c'est
       vraiment plein. */
    const taux = libre.lte(0) ? 100 : Math.min(99.99, Math.floor(f(occupe) / f(plafond) * 10000) / 100);
    return {
      plafond: f(plafond), occupe: f(occupe), libre: f(libre), taux,
      plein: libre.lte(0),
      partOffre: cfg.STAKE_CAP_BPS / 100,
      ...perso,
    };
  }

  stake(addr, amountStr) {
    const p = this._p(addr);
    const amount = WEI(amountStr);
    if (amount.lte(0)) throw new Error('enter an amount');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    /* Le plafond se verifie AVANT de toucher au solde. Un refus qui arrive
       apres le debit laisserait un joueur sans ses jetons ni son staking. */
    /* On RECOMPTE, on ne tient pas de compteur a cote. Un compteur qui derive
       d'un seul jeton laisserait entrer un peu plus que le plafond a chaque
       fois, sans que rien ne le signale ; la somme, elle, ne peut pas mentir.
       Et une mise en staking est mille fois plus rare qu'une manche : le
       parcours des fiches ne se voit pas. */
    const plafond = this.plafondStaking();
    if (plafond) {
      const occupe = this.totalStaked();
      const libre = plafond.gt(occupe) ? plafond.sub(occupe) : BN(0);
      const joli = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS))
        .toLocaleString('en-US', { maximumFractionDigits: 0 });
      /* Le refus porte TOUJOURS le chiffre exact qui reste. « Pool full » tout
         seul fait ecrire au support ; « il reste 12 400 » fait retaper 12 400. */
      if (libre.lte(0))
        throw new Error('staking pool is full (' + (cfg.STAKE_CAP_BPS / 100) +
          '% of supply) — wait for someone to unstake');
      if (amount.gt(libre))
        throw new Error('only ' + joli(libre) + ' $SWOGE of room left in the staking pool (cap ' +
          joli(plafond) + ', ' + (cfg.STAKE_CAP_BPS / 100) + '% of supply)');
    }
    /* Le plafond PAR PORTEFEUILLE. Le rendement est une subvention payee par
       les manches de tout le monde : qu'un seul portefeuille l'absorbe revient
       a faire payer la salle pour une personne.
     *
     * Ce qui est deja stake n'est pas touche. Une position ouverte sous une
     * autre regle le reste — on empeche d'AJOUTER, on ne retire pas. */
    const maxJoueur = this.plafondJoueur();
    if (maxJoueur) {
      const joli = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS))
        .toLocaleString('en-US', { maximumFractionDigits: 0 });
      const place = this.placeJoueur(addr);
      if (place.lte(0))
        throw new Error('you have reached the per-wallet staking cap of ' + joli(maxJoueur) +
          ' $SWOGE — your current stake stays untouched, you just cannot add to it');
      if (amount.gt(place))
        throw new Error('you can stake ' + joli(place) + ' $SWOGE more (per-wallet cap ' +
          joli(maxJoueur) + ', ' + (cfg.STAKE_CAP_JOUEUR_BPS / 100) + '% of the pool)');
    }
    this._settleStakes(p);
    p.balance = p.balance.sub(amount);
    const now = Date.now();
    p.stakes.push({ a: amount, s: now, u: now + this._lockMs() }); // a=amount, s=lastSettle, u=unlockAt
    journal.ajoute(addr, { k: 'st', s: 'stake', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                           total: ethers.utils.formatUnits(this._stakedTotal(p), cfg.DECIMALS) });
  }

  claimStake(addr) {
    const p = this._p(addr);
    this._settleStakes(p);
    const reward = p.stakeAccrued;
    if (reward.lte(0)) throw new Error('no yield to claim yet');
    p.stakeAccrued = BN(0);
    p.balance = p.balance.add(reward);
    p.stakeClaimTotal = (p.stakeClaimTotal || BN(0)).add(reward);
    const r = ethers.utils.formatUnits(reward, cfg.DECIMALS);
    this.note('staking', r, String(addr).toLowerCase());
    journal.ajoute(addr, { k: 'st', s: 'claim', m: r,
                           total: ethers.utils.formatUnits(this._stakedTotal(p), cfg.DECIMALS) });
    return r;
  }

  /** Unstake EVERYTHING + pay accrued yield. Sortie libre par defaut : tout
   * revient en entier. Si une penalite est remise en vigueur, seules les
   * positions encore bloquees rendent (1 − penalite). */
  unstakeAll(addr) {
    const p = this._p(addr);
    if (!p.stakes.length) throw new Error('nothing staked');
    this._settleStakes(p);
    const now = Date.now();
    let returned = BN(0), penalty = BN(0);
    for (const pos of p.stakes) {
      if (!this._verrouille(pos, now)) { returned = returned.add(pos.a); }
      else {
        const keep = pos.a.mul(10000 - cfg.STAKE_EARLY_PENALTY_BPS).div(10000);
        returned = returned.add(keep);
        penalty = penalty.add(pos.a.sub(keep)); // forfeited → stays in the vault (house)
      }
    }
    const yld = p.stakeAccrued;
    p.stakeAccrued = BN(0);
    p.stakes = [];
    p.balance = p.balance.add(returned).add(yld);
    const f = (w) => ethers.utils.formatUnits(w, cfg.DECIMALS);
    /* La PENALITE est journalisee separement de ce qui revient : c'est
       exactement le chiffre qu'un joueur conteste six mois plus tard, et
       « rendu 500 » sans « penalite 500 » ne permet pas de lui repondre. */
    journal.ajoute(addr, { k: 'st', s: 'unstake', m: f(returned),
                           pen: f(penalty), yld: f(yld), total: '0' });
    return { returned: f(returned), penalty: f(penalty), yield: f(yld) };
  }

  /** Sum of all staked principal (wei). */
  totalStaked() { let s = BN(0); for (const p of this.players.values()) s = s.add(this._stakedTotal(p)); return s; }

  /**
   * COMBIEN DE TEMPS LE COFFRE TIENT.
   *
   * ---- pourquoi un niveau ne suffit pas ----
   *
   * L'alarme de solvabilite compare ce qu'il y a dans le coffre a ce qu'on
   * doit. Elle sonne quand c'est deja passe dessous — c'est-a-dire le jour ou
   * on l'apprend par un joueur qui n'arrive pas a retirer.
   *
   * A 100 % l'an, la dette ne saute pas : elle MONTE, a la seconde, d'un
   * montant qui se calcule. Une salle a cent millions en staking fabrique cent
   * millions de dette par an, soit environ 274 000 par jour, qu'il se passe
   * quelque chose ou non.
   *
   * En face, l'avantage de la maison ENCAISSE tous les jours. Les deux
   * courbes se croisent a une date, et cette date se calcule aujourd'hui.
   * C'est le seul chiffre qui previent au lieu de constater.
   *
   * @param {BigNumber|null} pot ce qu'il y a reellement dans le coffre
   */
  autonomie(pot) {
    const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
    const staked = f(this.totalStaked());
    const bMaison = this.owedBreakdown();
    const stakedMaison = f(bMaison.maisonStaked || BN(0));
    /* Ce que le staking coute chaque jour, que quelqu'un joue ou non.
       LE RENDEMENT QUE LA MAISON SE VERSE A ELLE-MEME N'EST PAS UN DRAIN : il
       sort d'une poche pour entrer dans l'autre. Le compter ferait afficher un
       cout quotidien enorme et une autonomie de quelques jours alors que rien
       ne quitte le coffre. On donne donc les deux — le cout brut, et celui qui
       concerne vraiment des joueurs. */
    const rendementJour = staked * (cfg.STAKE_APR_BPS / 10000) / 365;
    const rendementJoueurs = Math.max(0, staked - stakedMaison) * (cfg.STAKE_APR_BPS / 10000) / 365;
    /* Ce que la maison encaisse chaque jour, mesure sur le mois en cours et
       non estime : c'est le seul des deux chiffres qui puisse surprendre. */
    const c = this.comptes();
    const jours = Math.max(1, new Date().getUTCDate());
    /* Ce n'est plus le seul revenu des tables : les coffres, les skins et les
       cinq pour cent du marche entrent vraiment en caisse, et le prix du
       classement comme le rachat en sortent vraiment. Les ignorer donnait un
       drain surestime, donc une fin de tresorerie annoncee plus proche qu'elle
       ne l'est — le chiffre sur lequel on decide de brider le staking.
       Le staking est exclu de cette ligne : il est deja en face, dans
       `rendementJoueurs`. */
    const revenuJour = (c.horsStaking || 0) / jours;
    /* Le drain se mesure sur le rendement QUI PART VRAIMENT — celui des
       joueurs. C'est lui qui vide le coffre ; l'autre tourne en rond. */
    const drainJour = rendementJoueurs - revenuJour;

    const b = this.owedBreakdown();
    /* Les bons signes et non presentes font partie du du : leurs jetons sont
       encore dans le coffre, et ils ne sont plus dans aucun solde. */
    const du = f(b.balances.add(b.staked).add(b.pending).add(b.jackpot).add(b.bons));
    const surplus = pot ? f(pot) - du : null;

    return {
      /* Ce que la maison tient elle-meme, en clair a cote du surplus. Sans
         cette ligne le surplus monterait de neuf millions sans explication —
         et un chiffre de solvabilite qui bouge sans raison lisible ne sert
         plus a rien. */
      /* Ce que la maison tient elle-meme. Il est COMPRIS dans le « du » —
         ces comptes peuvent retirer — et affiche a part pour que le
         proprietaire lise sa vraie position sans que le chiffre de
         solvabilite devienne faux. */
      maison: f(b.maison), maisonN: b.maisonN, maisonStaked: stakedMaison,
      /* Le surplus SANS les comptes maison — ce qu'il vaudrait si leurs jetons
         etaient une dette. Il n'est plus le chiffre d'alarme, mais il reste
         celui qu'on veut lire le jour ou l'on se demande « et si je devais
         rendre meme ca ». */
      surplusHorsMaison: surplus === null ? null : Number((surplus - f(b.maison)).toFixed(6)),
      staked, rendementJour: Number(rendementJour.toFixed(6)),
      rendementJoueurs: Number(rendementJoueurs.toFixed(6)),
      revenuJour: Number(revenuJour.toFixed(6)),
      drainJour: Number(drainJour.toFixed(6)),
      surplus: surplus === null ? null : Number(surplus.toFixed(6)),
      /* null = le revenu couvre le rendement, la salle se paie toute seule.
         0 = deja sous l'eau. Sinon, le nombre de jours qui restent. */
      joursRestants: (surplus === null) ? null
        : (drainJour <= 0 ? null : Math.max(0, Math.floor(surplus / drainJour))),
      /* Le staking que le REVENU seul pourrait porter, sans rien remettre au
         coffre. C'est le chiffre a comparer au plafond. */
      stakingAutofinance: Number((revenuJour * 365 / (cfg.STAKE_APR_BPS / 10000)).toFixed(0)),
    };
  }

  /** Breakdown (wei) of what the vault owes: player balances, staked, pending
   * yield, and the two progressive pots.
   *
   * LES DEUX CAGNOTTES SONT UNE DETTE, pas une reserve de la maison. Elles ont
   * ete promises : le pot du Coin Pusher se paie au prochain declencheur, celui
   * du Boulier au prochain 10/10. Les laisser hors de ce calcul ferait afficher
   * un surplus retirable superieur d'un million au reel — et le proprietaire
   * retirerait de bonne foi l'argent d'un gagnant qui n'a pas encore joue. */
  /** Cette adresse appartient-elle a la maison ? */
  estMaison(addr) {
    return (cfg.COMPTES_MAISON || []).indexOf(String(addr || '').toLowerCase()) >= 0;
  }

  owedBreakdown() {
    let balances = BN(0), staked = BN(0), pending = BN(0), bons = BN(0);
    /* CE QUE TIENNENT LES COMPTES DE LA MAISON est compte a part, jamais
       retire en silence. Le surplus est un chiffre de solvabilite : s'il monte
       de neuf millions, il faut pouvoir dire d'ou ils viennent. */
    let maison = BN(0), maisonN = 0, maisonStaked = BN(0);
    for (const [addr, p] of this.players) {
      const st = this._stakedTotal(p);
      const pe = p.stakeAccrued.add(this._pendingAll(p));
      /* ---- LES COMPTES DE LA MAISON RESTENT DANS LE « DU » ----
       *
       * Ma premiere version les en sortait, ce qui faisait monter le surplus
       * d'autant. C'etait juste A UNE CONDITION : que ces comptes ne puissent
       * plus retirer. Ils le peuvent — decision du proprietaire — donc leurs
       * jetons sont une creance comme une autre, et les sortir du « du »
       * aurait annonce 81 millions de surplus qui peuvent partir a tout
       * moment. Un chiffre de solvabilite se calcule au pire, jamais au mieux.
       *
       * Ils sont comptes A PART pour l'affichage : le proprietaire doit
       * pouvoir lire « le coffre couvre tout, et 81 M de ce qu'il couvre sont
       * a moi » — deux nombres, pas un seul qui melange les deux. */
      /* ---- EXCLU DU « DU », ET C'EST INDISSOCIABLE DU VERROU DE RETRAIT ----
       *
       * A tout instant, l'exclusion est une comptabilite juste : ces jetons
       * sont a la maison, ils n'attendent aucun joueur. Le danger n'est pas
       * dans la formule, il est dans L'ORDRE DES GESTES.
       *
       * Le proprietaire lit « surplus : 92 M » et le retire. Le coffre tombe
       * a ce qu'on doit aux joueurs. Or la fiche du compte maison porte
       * toujours une creance de 81 M — `p.balance` ne sait pas qu'elle a ete
       * exclue — et `requestWithdraw` ne regarde que cette fiche. Il signerait
       * un bon pour de l'argent qui n'est plus la, et ce sont les joueurs qui
       * paieraient.
       *
       * Le verrou de `requestWithdraw` fait que cette creance ne peut JAMAIS
       * etre exercee. Les deux moities tiennent ensemble ; retirer l'une sans
       * l'autre est le trou. `maison.test.js` echoue si l'une disparait. */
      if (this.estMaison(addr)) {
        maison = maison.add(p.balance).add(st).add(pe);
        maisonStaked = maisonStaked.add(st);
        maisonN++;
        bons = bons.add(p.bonDu || BN(0));
        continue;
      }
      balances = balances.add(p.balance);
      staked = staked.add(st);
      pending = pending.add(pe);
      /* ---- ET LES BONS SIGNES QUI N'ONT PAS ENCORE ETE PRESENTES ----
       *
       * Ceux des comptes maison aussi : `continue` plus haut les sort du
       * « du », mais un bon signe est une creance SUR LA CHAINE, pas sur une
       * fiche. Ils sont donc comptes ici pour tout le monde — c'est justement
       * la ligne qu'on ne peut pas se permettre d'oublier. */
      bons = bons.add(p.bonDu || BN(0));
    }
    return { balances, staked, pending, bons, maison, maisonN, maisonStaked,
             jackpot: this.jackpotPot.add(this.boulierPot),
             jackpotPusher: this.jackpotPot, jackpotBoulier: this.boulierPot };
  }

  /** Everything the vault OWES players right now (wei): balances + staked +
   * pending yield + the jackpot pot + the signed vouchers not yet presented.
   * Owner surplus = vaultPot − this. */
  totalOwed() {
    const b = this.owedBreakdown();
    return b.balances.add(b.staked).add(b.pending).add(b.jackpot).add(b.bons);
  }

  /** Une ligne par joueur pour le tableau de bord proprietaire (/players). */
  playersReport() {
    const f = (w) => ethers.utils.formatUnits(w || BN(0), cfg.DECIMALS);
    const rows = [];
    /* EN UNE PASSE, pas une par joueur : deux cents joueurs fois dix mille
       paris feraient deux millions de comparaisons a chaque rafraichissement
       du panneau, toutes les quinze secondes. */
    const bilans = this._bilansParis();
    for (const [addr, p] of this.players) {
      const staked = this._stakedTotal(p);
      const pending = p.stakeAccrued.add(this._pendingAll(p));
      rows.push({
        address: addr,
        name: p.name || addr.slice(0, 6),
        visage: p.visage || null,          // le visage fait partie de l'identite affichee
        photo: !!p.photo,                  // et sa photo, s'il en a televerse une
        amis: (p.amis || []).length,
        balance: f(p.balance),
        staked: f(staked),
        pending: f(pending),
        wagered: f(p.wagered),                     // total joue a vie
        bets: p.betCount || 0,                     // nombre de mises, tous jeux
        /* LES PARIS SPORTIFS A PART. `bets` compte les mises de casino, qui
           se reglent dans la seconde ; un pari vit plusieurs jours et n'entre
           dans aucun compteur de manche tant qu'il n'est pas tranche. Le
           panneau affichait donc zero pour quelqu'un qui avait trois mille
           jetons engages. */
        paris: bilans.get(addr) || null,
        withdrawn: f(p.cumulativeAuthorized),
        deposited: !!p.hasDeposited,
        depositedAmount: f(p.deposited),
        /* Le seul chiffre qui repond a « d'ou vient cet argent ? » :
           ce qu'il detient, plus ce qu'il a sorti, moins ce qu'il a mis.
           Un joueur normal est LEGEREMENT NEGATIF — c'est l'avantage de la
           maison. Fortement positif sans mise correspondante, c'est une entree
           d'argent qui ne vient pas du jeu. */
        net: f(p.balance.add(staked).add(pending).add(p.cumulativeAuthorized)
                .sub(p.deposited || BN(0))),
        jeux: p.jeux || {},
        tgId: p.tgId || null,
        total: f(p.balance.add(staked).add(pending)),
        /* ---- CE QUE LA TABLE NE DISAIT PAS ----
         *
         * Inscription, derniere visite, niveau, serie, collection. Tous ces
         * champs existaient dans la fiche et aucun n'arrivait au panneau : on
         * ne pouvait donc pas trier les joueurs par anciennete, ni voir d'un
         * coup d'oeil qui n'est plus venu depuis un mois.
         *
         * Ils sont pris DIRECTEMENT sur la fiche, sans recalcul : le niveau
         * et la collection se lisent, ils ne se comptent pas. La table passe
         * toutes les quinze secondes sur deux cents joueurs — ce qui coute
         * cher ici le coute deux cents fois. */
        creeLe: p.creeLe || 0,
        dernierJour: p.dayKey || null,
        niveau: this.niveauDeFiche(p),
        xp: Math.round(this._xpTotale(p)),
        streak: p.streakDay || 0,
        objets: Object.keys(p.objets || {}).length,
      });
    }
    rows.sort((a, b) => parseFloat(b.wagered) - parseFloat(a.wagered));
    return rows;
  }

  /**
   * LA FICHE COMPLETE D'UN JOUEUR, pour le panneau.
   *
   * ---- pourquoi elle ne passe pas par playersReport ----
   *
   * `playersReport()` sert la TABLE : deux cents lignes toutes les quinze
   * secondes. Y ajouter la collection, les quetes du jour et le detail du
   * staking ferait payer a chaque rafraichissement le prix d'une information
   * qu'on ne regarde que sur un joueur a la fois. Les deux vues ont des couts
   * differents parce qu'elles ont des cadences differentes.
   *
   * ---- ce qu'elle doit permettre ----
   *
   * Repondre a « je n'ai pas recu mon gain » sans ouvrir un fichier. Donc :
   * qui il est, ce qu'il a, d'ou ca vient, ou il en est, et ce qu'il a fait.
   * Le `net` est le chiffre qui repond a la derniere question — ce qu'il
   * detient plus ce qu'il a sorti, moins ce qu'il a mis. Un joueur normal est
   * legerement negatif : c'est l'avantage de la maison.
   */
  ficheAdmin(addr) {
    const a = String(addr || '').toLowerCase();
    const p = this.players.get(a);
    if (!p) return null;
    const f = (w) => ethers.utils.formatUnits(w || BN(0), cfg.DECIMALS);
    const staked = this._stakedTotal(p);
    const pending = p.stakeAccrued.add(this._pendingAll(p));

    /* La collection, comptee sur le catalogue et pas sur l'inventaire : c'est
       « 12 sur 30 » qui renseigne, pas « 12 ». */
    const objets = p.objets || {};
    const possedes = boutique.ITEMS.filter((o) => objets[o.id]);
    const familles = boutique.FAMILLES.map((fa) => {
      const l = boutique.ITEMS.filter((o) => o.famille === fa.cle);
      const ai = l.filter((o) => objets[o.id]).length;
      return { cle: fa.cle, nom: fa.nom, saison: fa.saison, a: ai, sur: l.length,
               complete: l.length > 0 && ai === l.length };
    });

    let quetes = [];
    try { quetes = this.quetesDuJour(a).map((q) => this._queteVue(p, q, false)); }
    catch (e) { quetes = []; }

    return {
      /* ---- qui ---- */
      address: a,
      name: p.name || null, nomChoisi: !!p.nomChoisi, nomPaye: !!p.nomPaye,
      visage: p.visage || null, photo: !!p.photo,
      tgId: p.tgId || null,
      /* `creeLe` vaut 0 sur les fiches anterieures a son arrivee. On rend le
         zero tel quel plutot qu'une date inventee : « inconnu » est une
         reponse, « 1er janvier 1970 » est un mensonge. */
      creeLe: p.creeLe || 0,
      dernierJour: p.dayKey || null,

      /* ---- l'argent ---- */
      argent: {
        balance: f(p.balance), staked: f(staked), pending: f(pending),
        total: f(p.balance.add(staked).add(pending)),
        deposited: f(p.deposited), hasDeposited: !!p.hasDeposited,
        withdrawn: f(p.cumulativeAuthorized),
        wagered: f(p.wagered), bets: p.betCount || 0,
        net: f(p.balance.add(staked).add(pending).add(p.cumulativeAuthorized)
               .sub(p.deposited || BN(0))),
        dayNet: f(p.dayNet), meilleurJour: p.meilleurJour || null,
      },

      /* ---- ou il en est ---- */
      progression: {
        niveau: this.niveauDeFiche(p),
        xp: Math.round(this._xpTotale(p)),
        xpGagnee: Math.round(p.xp || 0),
        xpSources: p.xpSources || {},
        collection: { a: possedes.length, sur: boutique.ITEMS.length },
        familles,
        rachatOuvert: this.rachatVerrou(a),
      },

      /* ---- ce qui le fait revenir ---- */
      engagement: {
        streakDay: p.streakDay || 0,
        streakDernier: p.streakLastClaimDay || null,
        coffreOffert: this.coffreOffert(a),
        quetes,
        parfait: this.parfaitEtat ? (() => { try { return this.parfaitEtat(a); } catch (e) { return null; } })() : null,
        amis: (p.amis || []).length,
        parrain: p.parrain || null,
        filleuls: (p.filleuls || []).length,
        refTotal: f(p.refTotal), refDu: f(p.refDu),
      },

      /* ---- ce qu'il a joue ---- */
      jeux: p.jeux || {},
      stakes: this.stakeInfo(a),
      maison: this.estMaison(a),
    };
  }

  stakeInfo(addr) {
    const p = this._p(addr);
    const pending = p.stakeAccrued.add(this._pendingAll(p));
    const now = Date.now();
    let locked = BN(0), unlocked = BN(0), nextUnlock = null;
    for (const pos of p.stakes) {
      if (!this._verrouille(pos, now)) unlocked = unlocked.add(pos.a);
      else { locked = locked.add(pos.a); if (nextUnlock === null || pos.u < nextUnlock) nextUnlock = pos.u; }
    }
    const f = (w) => ethers.utils.formatUnits(w, cfg.DECIMALS);
    return {
      staked: f(this._stakedTotal(p)), locked: f(locked), unlocked: f(unlocked),
      pending: f(pending), aprBps: cfg.STAKE_APR_BPS,
      penaltyBps: cfg.STAKE_EARLY_PENALTY_BPS, lockDays: cfg.STAKE_LOCK_DAYS, nextUnlock,
      /* La salle, vue de l'exterieur. Elle part AVEC l'etat du joueur : sinon
         il decouvre que c'est plein apres avoir tape son montant, ce qui se
         lit comme une panne et non comme une regle. */
      capacite: this.capaciteStaking(addr),
    };
  }

  /**
   * Les missions du jour : trois jeux nommes, qui changent chaque jour.
   *
   * Le tirage n'en est pas un — c'est une rotation calculee a partir du numero
   * du jour. Tout le monde voit donc les memes jeux le meme jour (ce qui se
   * raconte dans le canal), personne ne peut la faire tourner en rechargeant,
   * et le pas etant premier avec la longueur du catalogue, chaque jeu revient
   * a intervalle regulier au lieu d'etre oublie des semaines.
   */
  missionsDuJour(jourKey) {
    const cat = cfg.MISSION_CATALOGUE || [];
    const k = Math.max(0, Math.min(cfg.MISSIONS_PAR_JOUR || 0, cat.length));
    if (!k) return [];
    /* Le numero du jour depuis l'epoque, lu sur la CLE du jour et non sur
       l'horloge : la cle est ce qui remet les compteurs a zero, les deux
       doivent basculer au meme instant. */
    const jour = Math.floor(Date.parse((jourKey || this._today()) + 'T00:00:00Z') / 86400000);
    const out = [];
    for (let i = 0; i < k; i++) {
      const [jeu, nom, page] = cat[(((jour * k + i) % cat.length) + cat.length) % cat.length];
      out.push({ id: 'm:' + jeu, jeu, nom, page, metric: 'mise',
                 label: 'Wager ' + cfg.MISSION_MISE.toLocaleString('en-US') + ' $SWOGE on ' + nom,
                 target: cfg.MISSION_MISE, reward: cfg.MISSION_GAIN });
    }
    return out;
  }

  /* ====================================================================
   * LES CINQ QUETES DU JOUR
   * ====================================================================
   *
   * ---- la selection est CALCULEE, jamais tiree ----
   *
   * Elle se rejoue a partir de la date seule. C'est ce qui permet de repondre
   * a « pourquoi j'ai eu ca » sans stocker un tirage par joueur, et ce qui
   * fait que deux joueurs comparent la meme journee.
   *
   * ---- l'anti-repetition est STRUCTURELLE, pas historique ----
   *
   * Ma premiere idee etait « une quete ne revient pas avant trois jours »,
   * verifiee contre les journees precedentes. Elle ne tient pas : pour
   * calculer aujourd'hui il faudrait calculer hier, qui a besoin d'avant-hier,
   * et ainsi de suite sans fin.
   *
   * Le pas modulaire regle ca sans memoire : la quete d'indice i d'un palier
   * de N sort le jour ou (jour * k + slot) % N == i. Chaque quete revient donc
   * exactement tous les N/k jours, et il suffit que N/k depasse trois. C'est
   * la meme mecanique que la rotation des jeux, qui marchait deja.
   *
   * ---- ce qui est FILTRE avant de tourner ----
   *
   * Les quetes de collection ne sont proposees qu'a qui possede deja un objet,
   * celle du parrainage qu'a qui a un filleul, et les paliers Hard et Elite
   * n'apparaissent qu'apres quelques jours. Une quete impossible sur le papier
   * est pire qu'une quete absente : elle apprend a ne pas lire la liste.
   *
   * Le filtre casse la promesse « tout le monde voit la meme chose », et c'est
   * assume : un debutant voit MOINS de quetes, jamais d'autres.
   */
  _queteEligible(p, q, jours) {
    if (q.cond === 'aDesObjets' && !Object.keys(p.objets || {}).length) return false;
    if (q.cond === 'aDesFilleuls' && !(p.filleuls || []).length) return false;
    /* L'introduction progressive. Montrer les cinq paliers a quelqu'un qui
       n'a rien lui montre surtout ce qu'il n'a pas. */
    if (q.palier === 'hard' && jours < 3) return false;
    if (q.palier === 'elite' && !Object.keys(p.objets || {}).length) return false;
    return true;
  }

  /** Depuis combien de jours cette fiche existe. Sert a l'introduction. */
  _anciennete(p) {
    if (!p.creeLe) return 99;            // fiche d'avant ce champ : pas un debutant
    return Math.max(0, Math.floor((Date.now() - p.creeLe) / 86400000));
  }

  /** La cible d'une quete de volume, calee sur le solde du joueur. */
  _queteCible(p) {
    const solde = Number(ethers.utils.formatUnits(p.balance || BN(0), cfg.DECIMALS));
    const c = Math.min(cfg.QUETE_CIBLE_MAX, solde * cfg.QUETE_CIBLE_MULT);
    return Math.max(cfg.QUETE_CIBLE_MIN, Math.round(c / 10) * 10);
  }

  quetesDuJour(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const jour = Math.floor(Date.parse((p.dayKey || this._today()) + 'T00:00:00Z') / 86400000);
    const anc = this._anciennete(p);
    const pool = cfg.QUETES_POOL || [];
    const jeux = this.missionsDuJour(p.dayKey);       // la rotation des jeux, deja en place
    const cible = this._queteCible(p);

    /* Un compteur de creneau par palier : deux Normal le meme jour doivent
       piocher a deux endroits differents de leur liste. */
    const pris = {}, sortie = [], vus = new Set(), jeuxVus = new Set();
    (cfg.QUETE_COMPO || []).forEach((palier, slot) => {
      const lot = pool.filter((q) => q.palier === palier && this._queteEligible(p, q, anc));
      if (!lot.length) return;
      const k = pris[palier] = (pris[palier] || 0);
      pris[palier]++;
      /* On part de la position calculee, et on avance jusqu'a une quete pas
         encore prise ce jour-la. Sans cette avance, deux creneaux du meme
         palier tomberaient sur la meme quete des que la liste est courte. */
      /* ---- LE PAS DOIT ETRE PREMIER AVEC LA LONGUEUR ----
       *
       * Ma premiere version avancait de `QUETE_COMPO.length` par jour. Sur un
       * palier qui compte exactement ce nombre de quetes, le terme du jour
       * s'annule modulo la longueur : la selection ne bougeait plus JAMAIS.
       * Mesure : huit jours d'affilee, les deux memes quetes Normal.
       *
       * Un pas de 1 est premier avec n'importe quelle longueur — c'est la
       * seule valeur qui ne peut pas retomber dans ce piege quel que soit le
       * nombre de quetes qu'on ajoutera ensuite. Le decalage par creneau
       * suffit a separer deux creneaux d'un meme palier. */
      let q = null;
      for (let d = 0; d < lot.length; d++) {
        const cand = lot[(((jour + slot + d) % lot.length) + lot.length) % lot.length];
        if (vus.has(cand.id)) continue;
        q = cand; break;
      }
      if (!q) return;
      vus.add(q.id);

      const vue = { id: q.id, palier: q.palier, metric: q.metric, cible: q.cible || 1,
                    label: q.label, jeu: null, nom: null, page: null };
      if (q.volume) vue.cible = cible;
      if (q.jeuDuJour) {
        /* PAS DEUX FOIS LE MEME JEU : sinon la journee entiere se joue sur une
           seule table, et on perd la distribution qui est le meilleur effet du
           systeme. */
        const libre = jeux.filter((m) => !jeuxVus.has(m.jeu));
        const m = libre[0] || jeux[k % Math.max(1, jeux.length)];
        if (!m) return;
        jeuxVus.add(m.jeu);
        vue.jeu = m.jeu; vue.nom = m.nom; vue.page = m.page;
        vue.cible = cible;
      }
      vue.label = String(q.label)
        .replace('{cible}', Number(vue.cible).toLocaleString('en-US'))
        .replace('{jeu}', vue.nom || '');
      vue.reward = (cfg.QUETE_GAIN || {})[q.palier] || 0;
      vue.xp = (cfg.QUETE_XP || {})[q.palier] || 0;
      sortie.push(vue);
    });
    return sortie;
  }

  /* Une quete, vue par le joueur. Le meme calcul sert a l'affichage et a la
     reclamation : deux calculs finiraient par diverger, et celui qui diverge
     paie ou refuse de payer a tort. */
  _queteVue(p, q, locked) {
    const cible = q.cible !== undefined ? q.cible : q.target;
    const prog = this._queteProgres(p, q);
    const done = prog >= cible;
    const claimed = !!p.questClaimed[q.id];
    /* LES JETONS ATTENDENT LE PREMIER DEPOT, L'XP NON. La marge anti-farming
       vient du volume mise ; un debutant a 100 jetons voit sa cible tomber a
       300, donc huit d'esperance contre trente distribues. Couper en deux ce
       qui etait ferme d'un bloc garde la retention ouverte a tous et laisse
       une adresse jetable ne rapporter que de l'XP — qui ne se retire pas. */
    const jetons = (cfg.QUETE_JETONS_APRES_DEPOT && !p.hasDeposited) ? 0 : (q.reward || 0);
    return { id: q.id, label: q.label, metric: q.metric, target: cible, reward: jetons,
             recompenseBloquee: jetons !== (q.reward || 0),
             xp: q.xp || 0, palier: q.palier || null,
             jeu: q.jeu || null, nom: q.nom || null, page: q.page || null,
             progress: Math.min(prog, cible), done, claimed, locked,
             claimable: done && !claimed && !locked };
  }

  /**
   * OU EN EST LE JOUEUR SUR CE COMPTEUR.
   *
   * Un seul endroit qui traduit un `metric` en nombre. Deux endroits — un pour
   * l'affichage, un pour la reclamation — finiraient par diverger, et celui
   * qui diverge paie ou refuse de payer a tort.
   *
   * Aucun de ces compteurs n'a demande de toucher au moteur d'un jeu : ils se
   * lisent tous sur ce qui etait deja compte. `jeux` est le nombre de clefs de
   * `miseJour`, et un duel y depose deja son identifiant.
   */
  _queteProgres(p, q) {
    const inv = p.objets || {};
    const mj = p.miseJour || {};
    const jc = p.jourColl || {};
    switch (q.metric) {
      case 'drops': return p.dropsToday || 0;
      case 'wins':  return p.winsToday || 0;
      case 'mise':  return mj[q.jeu] || 0;
      case 'jeux':  return Object.keys(mj).length;
      case 'total': return Object.values(mj).reduce((a, b) => a + b, 0);
      case 'paris': return (mj.paris || 0) > 0 ? 1 : 0;
      case 'duel':  return Game.JEUX_DUEL.some((j) => (mj[j] || 0) > 0) ? 1 : 0;
      case 'parisGagnes': return p.parisGagnesJour || 0;
      case 'coffres': return jc.coffres || 0;
      case 'neufs':   return jc.neufs || 0;
      /* Le RANG de rarete, pas la quantite : « rare ou mieux » est un seuil
         sur l'echelle, et l'echelle est celle de la boutique. */
      case 'rarete':  return jc.rarete || 0;
      case 'sortes':  return Object.keys(inv).filter((k) => inv[k] > 0).length;
      case 'pleines': {
        const fams = {};
        for (const o of boutique.ITEMS) if (inv[o.id]) fams[o.famille] = (fams[o.famille] || 0) + 1;
        /* Le compte de la FAMILLE, pas celui des raretes : depuis la
           relique, toute rarete n'existe pas dans toute famille, et
           `RARETES.length` rendait la quete impossible partout sauf dans
           quatre familles — en silence. */
        return Object.keys(fams).filter((k) => fams[k] === boutique.rangsDeFamille(k)).length;
      }
      case 'serie': return p.streakLastClaimDay === this._today() ? 1 : 0;
      case 'filleul': {
        const t = this._today();
        return (p.filleuls || []).some((f) => {
          const q2 = this.players.get(String(f).toLowerCase());
          return !!(q2 && q2.dayKey === t && Object.keys(q2.miseJour || {}).length);
        }) ? 1 : 0;
      }
      default: return q.cible !== undefined ? q.cible : (q.target || 0);
    }
  }

  static get JEUX_DUEL() { return ['p4', 'mp', 'dm', 'mf', 'dc']; }

  /** Per-player daily quest state (progress + claimable flags). */
  questState(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const locked = cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited;
    return this.quetesDuJour(addr).map((q) => this._queteVue(p, q, locked));
  }

  /**
   * LA JOURNEE PARFAITE.
   *
   * Les cinq quetes du jour reclamees. Elle paie un coffre de bois — le
   * meilleur objet de recompense du site : une emotion, un objet plafonne,
   * aucune valeur monetaire a defendre.
   *
   * ---- LE PLAFOND N'EST PAS DECORATIF ----
   *
   * La saison 1 compte 9 600 pieces. Un coffre par joueur et par jour, c'est
   * l'edition entiere en six cents jours a seize joueurs — et en DIX-NEUF a
   * cinq cents. Une edition brulee ne se rattrape pas, et personne ne s'en
   * apercevrait avant qu'il soit trop tard. Le compteur est donc global, remis
   * a zero chaque jour, et il rend l'XP seule quand il est atteint plutot que
   * de refuser : le joueur a fait le travail.
   */
  parfaitEtat(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const l = this.questState(addr);
    const total = l.length;
    const faites = l.filter((q) => q.claimed).length;
    return {
      total, faites,
      pret: total > 0 && faites >= total && p.parfaitJour !== p.dayKey,
      pris: p.parfaitJour === p.dayKey,
      coffre: Game.COFFRE_OFFERT,
      xp: cfg.PARFAIT_XP,
      restantGlobal: Math.max(0, cfg.COFFRES_GRATUITS_JOUR - this._coffresGratuitsDuJour()),
    };
  }

  /* Le compteur global des coffres gratuits — coffre du jour ET journee
     parfaite. Il vit en memoire et repart a zero chaque jour : sa raison
     d'etre est de borner une ferme d'adresses dans la journee, pas de tenir
     une comptabilite. Un redemarrage le remet a zero, ce qui est le bon
     compromis : l'edition, elle, est protegee par ses plafonds par objet. */
  _coffresGratuitsDuJour() {
    const t = this._today();
    if (this.coffresGratuitsJour !== t) { this.coffresGratuits = 0; this.coffresGratuitsJour = t; }
    return this.coffresGratuits || 0;
  }
  _prendCoffreGratuit() {
    if (this._coffresGratuitsDuJour() >= cfg.COFFRES_GRATUITS_JOUR) return false;
    this.coffresGratuits = this._coffresGratuitsDuJour() + 1;
    return true;
  }

  reclameParfait(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const e = this.parfaitEtat(addr);
    if (e.pris) throw new Error('already claimed today');
    if (!e.pret) throw new Error(`finish all ${e.total} quests first (${e.faites}/${e.total})`);
    p.parfaitJour = p.dayKey;
    this._gagneXp(p, cfg.PARFAIT_XP, 'parfait');
    /* Le coffre passe par le MEME chemin que tous les autres. Sous le plafond
       global il part ; au-dessus, l'XP seule — refuser apres coup une
       recompense annoncee serait pire que la reduire. */
    let gagne = null;
    if (this._prendCoffreGratuit()) gagne = this.boutiqueAchat(addr, Game.COFFRE_OFFERT, { gratuit: true });
    return { xp: cfg.PARFAIT_XP, gagne, plafonne: !gagne };
  }

  /** Claim a completed quest → credit its reward. Throws on any invalid claim. */
  claimQuest(addr, id) {
    const p = this._p(addr); this._bumpDay(p);
    /* Les missions du jour se cherchent dans la liste DU JOUR : celle d'hier
       n'existe plus, et un identifiant garde de la veille ne doit pas payer
       aujourd'hui. */
    /* Les quetes du jour se cherchent dans la liste DU JOUR : celle d'hier
       n'existe plus, et un identifiant garde de la veille ne doit pas payer
       aujourd'hui. */
    const q = this.quetesDuJour(addr).find((x) => x.id === id);
    if (!q) throw new Error('unknown quest');
    if (cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited) throw new Error('deposit first to unlock quests');
    const vue = this._queteVue(p, q, false);
    if (!vue.done) throw new Error('quest not complete yet');
    if (p.questClaimed[q.id]) throw new Error('already claimed today');
    p.questClaimed[q.id] = true;
    /* On paie CE QUE LA VUE ANNONCE, jamais la valeur brute du pool : deux
       calculs de la recompense finiraient par diverger, et celui qui diverge
       paie ce que le joueur n'a pas vu. */
    const r = WEI(vue.reward);
    p.balance = p.balance.add(r);
    p.dayNet = p.dayNet.add(r);
    /* L'XP suit le PALIER de la quete. C'est elle qui porte la progression :
       les jetons restent symboliques parce qu'ils se comparent a une mise et
       perdent la comparaison, l'XP ne se compare a rien. */
    this._gagneXp(p, q.xp || cfg.XP_QUETE, 'quete');
    return vue.reward;
  }

  // ---- Telegram link (for the Adsgram reward postback) ----
  linkTelegram(addr, tgId) {
    if (!tgId) return;
    tgId = String(tgId);
    const p = this._p(addr);
    p.tgId = tgId;
    this.telegramMap.set(tgId, addr.toLowerCase());
  }

  // ---- New-player welcome bonus (granted once, on first authenticated login) ----
  /** Grant the demo credit exactly once. Returns the granted amount (0 if already given). */
  grantWelcome(addr) {
    const p = this._p(addr);
    if (p.welcomeGranted) return 0;
    p.welcomeGranted = true;
    if (cfg.WELCOME_BONUS > 0) { p.balance = p.balance.add(WEI(cfg.WELCOME_BONUS)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(cfg.WELCOME_BONUS)); this.note('bonus', cfg.WELCOME_BONUS); }
    return cfg.WELCOME_BONUS;
  }

  /** Claim the extra welcome reward — allowed only after the player has wagered. */
  claimWelcome(addr) {
    const p = this._p(addr);
    if (!p.welcomeGranted) throw new Error('welcome bonus not granted yet');
    if (!p.welcomeWagered) throw new Error('play your welcome bonus first');
    if (p.welcomeClaimed) throw new Error('welcome reward already claimed');
    p.welcomeClaimed = true;
    const r = WEI(cfg.WELCOME_CLAIM);
    p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r);
    return cfg.WELCOME_CLAIM;
  }

  // ---- 7-day login ladder ----
  /**
   * Le palier que la reclamation d'AUJOURD'HUI crediterait (1..N), sans rien
   * modifier.
   *
   * UN TROU NE REMET PLUS A ZERO. Avant, rater une journee renvoyait le joueur
   * au palier 1 : il revenait le surlendemain, voyait « Claim day 1 » a la
   * place de « day 2 » et concluait, a raison, que la reclamation ne marchait
   * pas. Une echelle qui punit l'absence punit surtout ceux qui reviennent.
   * On avance donc d'un palier a chaque journee reclamee, quel que soit
   * l'ecart ; la seule regle qui reste est UNE reclamation par journee.
   */
  _streakToday(p) {
    const rewards = cfg.STREAK_REWARDS, N = rewards.length || 1;
    if (p.streakLastClaimDay === this._today()) return { day: p.streakDay, claimedToday: true };
    // jamais rien reclame -> palier 1 ; sinon le suivant, qui reboucle N -> 1
    const day = p.streakLastClaimDay ? (p.streakDay % N) + 1 : 1;
    return { day, claimedToday: false };
  }

  /** Public streak state for the UI. */
  streakState(addr) {
    const p = this._p(addr);
    const rewards = cfg.STREAK_REWARDS;
    const s = this._streakToday(p);
    return { day: s.day, claimedToday: s.claimedToday, rewards,
             todayReward: rewards[(s.day - 1) % rewards.length] || 0,
             claimable: !s.claimedToday };
  }

  /** Claim today's streak reward (once per UTC day). Returns { day, reward }. */
  claimStreak(addr) {
    const p = this._p(addr);
    const s = this._streakToday(p);
    if (s.claimedToday) throw new Error('streak already claimed today');
    const reward = cfg.STREAK_REWARDS[(s.day - 1) % cfg.STREAK_REWARDS.length] || 0;
    p.streakDay = s.day;
    p.streakLastClaimDay = this._today();
    if (reward > 0) { const r = WEI(reward); p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r); }
    /* REVENIR VAUT DE L'XP. C'est la source la plus importante des cinq : elle
       est la seule qu'un joueur puisse toucher sans engager un seul jeton. */
    const x = this._gagneXp(p, cfg.XP_CONNEXION, 'connexion');
    return { day: s.day, reward, xp: x ? x.gagne : 0, niveauMonte: !!(x && x.monte) };
  }

  /** Combined welcome + streak state for the client. */
  bonusState(addr) {
    const p = this._p(addr);
    return {
      welcome: { granted: !!p.welcomeGranted, wagered: !!p.welcomeWagered, claimed: !!p.welcomeClaimed,
                 amount: cfg.WELCOME_BONUS, reward: cfg.WELCOME_CLAIM,
                 claimable: !!p.welcomeGranted && !!p.welcomeWagered && !p.welcomeClaimed },
      streak: this.streakState(addr),
      ad: this.adState(addr),
    };
  }

  // ---- Rewarded video ads (Adsgram) ----
  _adBump(p) { const t = this._today(); if (p.adDayKey !== t) { p.adDayKey = t; p.adCount = 0; } }
  /** How many ad rewards are left today + cooldown remaining (seconds). */
  adState(addr) {
    const p = this._p(addr); this._adBump(p);
    const left = Math.max(0, cfg.AD_DAILY_CAP - (p.adCount || 0));
    const cool = Math.max(0, Math.ceil((p.adLastMs + cfg.AD_COOLDOWN_SEC * 1000 - Date.now()) / 1000));
    return { reward: cfg.AD_REWARD, dailyCap: cfg.AD_DAILY_CAP, watchedToday: p.adCount || 0, left, cooldown: cool, blockId: cfg.ADSGRAM_BLOCK_ID };
  }

  /**
   * Credit an Adsgram rewarded video, looked up by Telegram id. Enforces the
   * daily cap + cooldown so the reward postback can't be replayed for free coins.
   * Returns { ok, reward, balance, addr } or { ok:false, reason }.
   */
  grantAdReward(tgId) {
    tgId = String(tgId || '');
    const addr = this.telegramMap.get(tgId);
    if (!addr) return { ok: false, reason: 'unknown_user' };
    const p = this._p(addr); this._adBump(p);
    const now = Date.now();
    if (now < p.adLastMs + cfg.AD_COOLDOWN_SEC * 1000) return { ok: false, reason: 'cooldown', addr };
    if ((p.adCount || 0) >= cfg.AD_DAILY_CAP) return { ok: false, reason: 'daily_cap', addr };
    p.adCount = (p.adCount || 0) + 1;
    p.adLastMs = now;
    const r = WEI(cfg.AD_REWARD);
    p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r);
    return { ok: true, reward: cfg.AD_REWARD, balance: this.balanceStr(addr), addr };
  }

  /** Top `n` players by today's net gain (winners only). */
  leaderboard(n) {
    const t = this._today(), arr = [];
    for (const p of this.players.values()) {
      if (p.dayKey === t && p.dayNet.gt(0)) arr.push({ name: p.name, net: ethers.utils.formatUnits(p.dayNet, cfg.DECIMALS) });
    }
    arr.sort((a, b) => parseFloat(b.net) - parseFloat(a.net));
    return arr.slice(0, n);
  }

  _rotateSeed() {
    this.serverSeed = crypto.randomBytes(32).toString('hex');
    this.serverSeedHash = crypto.createHash('sha256').update(this.serverSeed).digest('hex');
    this.graineDepuis = Date.now();
    this.manchesGraine = 0;
  }

  /**
   * Y a-t-il une main EN COURS quelque part ?
   *
   * Une main de blackjack, une grille de Mines, une serie de Hi-Lo tirent
   * plusieurs fois, a plusieurs secondes d'intervalle. Tourner la graine au
   * milieu ferait tirer les premieres cartes avec l'ancienne et les suivantes
   * avec la nouvelle : la manche porterait UNE empreinte alors que deux
   * graines l'ont produite, et elle serait invérifiable — exactement le
   * contraire du but recherche. On attend donc que les tables soient vides.
   */
  partiesEnCours() {
    let n = 0;
    for (const p of this.players.values()) {
      /* Le blackjack tire AU FIL DE L'EAU, avec la graine du moment : une
         rotation en pleine main ferait tirer les premieres cartes avec
         l'ancienne et les suivantes avec la nouvelle. C'est le cas grave. */
      if (p.bj && p.bj.stage !== 'done') { n++; continue; }
      /* Les Mines, le Hi-Lo et les tables de casino, eux, FIGENT leur graine
         au debut de la manche (p.X.graine) : une rotation ne les couperait
         pas. On les attend quand meme, pour une autre raison — la ligne
         d'historique porte l'empreinte EN VIGUEUR a la fin de la manche, et
         apres une rotation ce serait la nouvelle alors que l'ancienne a tire.
         Le joueur verifierait avec la mauvaise graine et croirait a une
         tricherie. */
      if (p.mines && p.mines.etat && !p.mines.etat.fini) { n++; continue; }
      if (p.hilo && p.hilo.etat && !p.hilo.etat.fini) { n++; continue; }
      if (p.casino && p.casino.stage && p.casino.stage !== 'done') { n++; continue; }
    }
    return n;
  }

  /**
   * Tourne la graine et REVELE la precedente.
   *
   * C'est le geste qui donne son sens a tout le reste. L'empreinte annoncee
   * d'avance engage la maison ; la graine publiee apres coup permet de
   * VERIFIER. Sans elle, le joueur n'a qu'une promesse : il ne peut recalculer
   * aucune manche, et « provably fair » ne veut rien dire.
   *
   * @param {boolean} force  tourner meme si une main est en cours (a eviter)
   */
  tourneGraine(force) {
    const enCours = this.partiesEnCours();
    if (enCours && !force)
      throw new Error(`${enCours} hand(s) still running — rotation would split a round in two`);
    const revelee = {
      h: this.serverSeedHash,
      s: this.serverSeed,
      t0: this.graineDepuis || null,
      t1: Date.now(),
      n: this.manchesGraine || 0,
    };
    if (!Array.isArray(this.graines)) this.graines = [];
    this.graines.unshift(revelee);
    if (this.graines.length > cfg.FAIRNESS_GARDE) this.graines.length = cfg.FAIRNESS_GARDE;
    this._rotateSeed();
    return { revelee, nouvelle: this.serverSeedHash };
  }

  /**
   * Ce que tout le monde peut lire — y compris qui n'a pas de compte.
   *
   * La graine EN COURS n'y figure jamais : la publier laisserait predire les
   * manches a venir. Seules les graines retirees du service sont ouvertes.
   */
  equite() {
    return {
      empreinteActuelle: this.serverSeedHash,
      depuis: this.graineDepuis || null,
      manches: this.manchesGraine || 0,
      /* Les formules, jeu par jeu. Une preuve qu'on ne sait pas refaire n'est
         pas une preuve : le mode d'emploi fait partie de la promesse. */
      /* Les formules, jeu par jeu — et A LA VIRGULE PRES.
       *
       * Ce bloc a ete ecrit deux fois : la premiere version oubliait que
       * chaque jeu SUFFIXE la graine du joueur (« …:plinko », « …:mines »)
       * et que le numero est incremente AVANT le tirage. Un joueur qui aurait
       * suivi cette documentation aurait trouve un resultat different du sien
       * et en aurait conclu qu'on triche. Une preuve fausse est pire que pas
       * de preuve : elle accuse.
       */
      formules: {
        empreinte: 'sha256(graine_serveur) == empreinte annoncee',
        numero: "le numero utilise par une manche est n1 (celui d'ARRIVEE) : il est incremente avant le tirage. n0 et n1 encadrent les numeros consommes, utile au blackjack qui en prend une dizaine par main.",
        graineJoueur: "chaque jeu ajoute son propre suffixe a la graine du joueur : ':plinko', ':mines', ':hilo', ':boulier', ':casino' (Hold'em et Three Card). Le Coin Pusher n'en ajoute aucun ; le blackjack place ':bj:' avant le numero.",
        pusher: "HMAC_SHA256(graine_serveur, graine_joueur + ':' + n1)",
        blackjack: "HMAC_SHA256(graine_serveur, graine_joueur + ':bj:' + numero), un tirage par carte",
        plinko: "flux d'octets, compteur a partir de 0 : HMAC_SHA256(graine_serveur, graine_joueur + ':plinko' + ':' + n1 + ':' + compteur). Un bit par rangee, du bit de poids fort au plus faible ; 1 = a droite. La case d'arrivee est la somme des bits.",
        mines: "meme flux, avec le suffixe ':mines'",
        boulier: "meme flux, avec le suffixe ':boulier'. Melange de Fisher-Yates partiel sur une urne 1..90 : a chaque pas i de 0 a 29 on tire j uniforme dans [i, 89] (rejet au-dela de 256 - 256 % (90 - i)), on echange, et urne[i] est la boule qui sort. L'ordre rendu est celui du boulier.",
        holdem_three: "meme flux, avec le suffixe ':casino'",
        hilo: "flux : HMAC_SHA256(graine_serveur, graine_joueur + ':hilo' + ':' + n1 + ':' + pas + ':' + essai + ':' + compteur)",
        note: "chaque ligne d'historique porte l'empreinte en vigueur (sh), la graine du joueur (cs) et la plage de numeros de la manche (n0, n1)",
      },
      graines: (this.graines || []).map((g) => ({
        empreinte: g.h, graine: g.s, du: g.t0, au: g.t1, manches: g.n,
      })),
    };
  }

  _p(addr) {
    addr = addr.toLowerCase();
    /* On note l'adresse comme SALE ici, au seul endroit par lequel passe
       toute lecture et toute ecriture d'une fiche.
     *
     * Marquer trop est sans consequence : on reecrit une fiche qui n'avait
     * pas bouge. Marquer trop peu perd de l'argent. Entre les deux il n'y a
     * pas d'hesitation possible, et c'est pourquoi la marque est posee a
     * l'ACCES et non a la mutation : il faudrait sinon retrouver les cent
     * quarante endroits qui modifient une fiche, et n'en oublier aucun —
     * aujourd'hui, et a chaque fonctionnalite ajoutee ensuite.
     */
    if (this.sales) this.sales.add(addr);
    let p = this.players.get(addr);
    /* La fiche porte son adresse. Sans elle, tout code qui ne recoit que la
       fiche — _manche, appele par les dix-neuf fins de manche — ne sait pas de
       QUI il parle, et ne peut donc rien journaliser. Elle est reposee aussi
       pour les fiches relues du disque, qui datent d'avant. */
    if (p && !p.addr) p.addr = addr;
    if (!p) {
      p = { addr, balance: ethers.BigNumber.from(0), cumulativeAuthorized: ethers.BigNumber.from(0),
            /* Ce qui a ete AUTORISE et qu'on n'a pas encore vu partir de la
               chaine. Le bon est cumulatif : tant qu'il n'est pas presente, les
               jetons sont toujours dans le coffre, mais ils ne sont plus dans
               le solde du joueur — donc plus dans le « du », donc comptes dans
               le surplus du proprietaire. Il pouvait les retirer de bonne foi. */
            bonDu: ethers.BigNumber.from(0),
            /* ---- LE SOLDE DES PARIS, EN $SWOGEBET ----
               Un second solde, avec son propre cumul de retrait et son propre
               « du » : ce qui entre par SwogeBetVault ne se melange jamais au
               $SWOGE, et un bon signe pour un coffre ne vaut rien chez
               l'autre. Voir `creditBetDeposit` et `requestBetWithdraw`. */
            betBalance: BN(0), betCumulativeAuthorized: BN(0), betBonDu: BN(0), betDeposited: BN(0),
            clientSeed: crypto.randomBytes(8).toString('hex'), nonce: 0, name: addr.slice(0, 6),
            nomChoisi: false,
            deposited: BN(0), jeux: {}, visage: null, amis: [], demandes: [], envoyees: [],
            parrain: null, filleuls: [], refDu: BN(0), refTotal: BN(0), revCumul: 0, revPaye: 0,
            attente: [],
            record: null, meilleurJour: null, stakeClaimTotal: BN(0), trNonLus: 0,
            bonusBloque: BN(0), bonusCible: null,
            moisCle: null, moisMise: 0,
            refBienvenue: false,
            dayNet: ethers.BigNumber.from(0), dayKey: null,
            dropsToday: 0, winsToday: 0, questClaimed: {}, hasDeposited: false, miseJour: {}, face: {},
            primesEntrainement: {},
            stakes: [], stakeAccrued: ethers.BigNumber.from(0), volcanoMeter: 0,
            wagered: ethers.BigNumber.from(0), betCount: 0,
            tgId: null, welcomeGranted: false, welcomeWagered: false, welcomeClaimed: false,
            streakDay: 0, streakLastClaimDay: null, adCount: 0, adDayKey: null, adLastMs: 0,
            /* L'XP GAGNEE — celle des gestes. Celle du volume se recalcule et
               n'est donc pas ici : un compteur derivable qu'on stocke est un
               deuxieme endroit ou la verite peut diverger. */
            xp: 0, xpSources: {}, xpFilleuls: {}, xpObjets: {}, xpFamilles: {},
            coffreOffertJour: null,
            jourColl: { coffres: 0, neufs: 0, rarete: 0 }, creeLe: Date.now(),
            /* L'inventaire de la boutique : identifiant d'objet -> quantite.
               Un objet plat, pas une Map : il part au fichier tel quel. */
            objets: {}, sac: {}, potions: {},
            /* Les skins possedes, et celui qu'on porte. Registre a part de
               `objets` : un skin ne vient d'aucun coffre et n'appartient a
               aucune saison. */
            skins: {}, skinActif: null,
            /* La progression PAR SKIN : id -> { w: volume mise sous ce skin,
               ef: fruit equipe, ea: arme equipee }. Vide tant qu'aucun skin
               n'a ete porte pendant une mise. */
            persos: {} };
      this.players.set(addr, p);
    }
    return p;
  }

  /**
   * ================== CELUI QU'ON DONNE ==================
   *
   * Andy appartient a tout le monde : il n'existe pas de version du jeu ou
   * l'on regarde sans pouvoir jouer. Un visiteur qui ouvre le monde de combat
   * et se fait repondre « no-character » ne revient pas expliquer pourquoi.
   *
   * ---- pourquoi c'est une QUESTION et pas une ECRITURE ----
   *
   * La premiere version le posait sur la fiche, dans `_p`. Ca marchait, et ca
   * cassait autre chose : une fiche qui possede un skin n'est plus vide, donc
   * plus elaguable, donc ECRITE SUR LE DISQUE. Chaque visiteur qui charge la
   * page — y compris celui qui repart aussitot — serait devenu une ligne
   * permanente du fichier de sauvegarde. Trois essais l'ont dit tout de suite,
   * et l'un d'eux compte les fiches ecrites.
   *
   * On ne stocke donc rien. Posseder Andy est une reponse, pas une donnee : la
   * fiche d'un visiteur reste vide, et il joue quand meme.
   */
  possedeSkin(p, id) {
    if (!id) return false;
    if (skins.OFFERT.has(id)) return true;
    return !!(p && p.skins && p.skins[id]);
  }

  /**
   * Le skin PORTE. Meme raison : posseder un personnage sans le porter, c'est
   * se faire refuser l'entree du monde — la meme panne, vue d'un cran plus
   * loin. Un compte qui n'a rien choisi porte donc celui qu'on offre.
   */
  skinActifDe(p) {
    if (p && p.skinActif && this.possedeSkin(p, p.skinActif)) return p.skinActif;
    for (const id of skins.OFFERT) return id;
    return null;
  }

  /**
   * Le nom de DEPANNAGE, celui que la page envoie au moment de la connexion —
   * en pratique les six premiers caracteres de l'adresse.
   *
   * Il ne doit JAMAIS ecraser un nom choisi. Toutes les pages envoient
   * `name` a chaque connexion : sans cette garde, un joueur se donne un nom
   * dans son profil, change de jeu, et se retrouve affiche « 0x24d7 » a la
   * table suivante — son nom disparait au premier rechargement. C'est
   * exactement ce qui arrivait.
   */
  setName(addr, name) {
    const p = this._p(addr);
    if (p.nomChoisi) return p.name;              // un nom choisi ne se remplace pas
    p.name = String(name || '').slice(0, 24) || addr.slice(0, 6);
    return p.name;
  }

  /* Les vingt-quatre visages proposes. Une LISTE FERMEE, et pas une chaine
     libre : ce nom et cette image s'affichent chez les AUTRES joueurs, au
     poker, au Crash, au Connect 4. Laisser passer n'importe quel texte, c'est
     laisser un joueur en coller un autre dans le HTML de la table. */
  /** La forme comparable d'un nom : sans casse et sans accents. */
  static cleNom(n) {
    return String(n || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  /* Les medailles peintes. Le serveur n'en connait que le CODE : l'image
     vit sur le site, elle change sans qu'on redemarre quoi que ce soit, et
     un joueur ne peut pas en inventer une — la liste fermee reste la seule
     verite. Elles passent devant les frimousses : c'est ce qui se voit a
     une table de poker. */
  static get BADGES() { return ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']; }
  /* Les medailles, et rien d'autre. Les frimousses etaient la AVANT que les
     medailles existent : les garder revenait a proposer deux qualites de
     visage cote a cote, et a laisser un joueur choisir la moins bonne sans
     savoir pourquoi. Celles deja portees par un joueur continuent de
     s'afficher — on ne lui reprend pas son visage — mais on n'en propose
     plus. */
  static get VISAGES() { return Game.BADGES.slice(); }

  /**
   * Le nom public d'un joueur, tel qu'il choisit de le porter.
   *
   * Les espaces de bout sont retires — c'est une faute de frappe, pas une
   * intention. Tout le reste est REFUSE plutot que corrige en silence : un
   * joueur qui tape un nom pris, trop court ou plein de balises doit
   * l'apprendre, pas se retrouver affiche sous autre chose.
   */
  setPublicName(addr, nom) {
    const n = String(nom == null ? '' : nom).trim();
    if (n.length < 3) throw new Error('name must be at least 3 characters');
    if (n.length > 18) throw new Error('name must be 18 characters at most');
    /* Lettres, chiffres, espace, tiret, souligne et point. Rien d'autre : ce
       nom part dans le HTML des tables des autres joueurs. */
    if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) throw new Error('letters, digits, space, . _ - only');
    if (/^\s|\s$|\s{2,}/.test(n)) throw new Error('no double or trailing spaces');
    /* La cle d'unicite ignore la casse ET les accents : « Eliott » et
       « Éliott » se ressemblent assez a l'ecran d'une table pour qu'on prenne
       l'un pour l'autre, et se faire passer pour un autre joueur est
       precisement ce qu'un nom public ne doit pas permettre. */
    const cle = Game.cleNom(n);
    for (const [a, p] of this.players)
      if (a !== String(addr).toLowerCase() && Game.cleNom(p.name || '') === cle)
        throw new Error('that name is taken');
    const p = this._p(addr);

    /* ---- LE PRIX DU NOM ----
     *
     * Un nom unique retire quelque chose a tous les autres joueurs, pour
     * toujours. Gratuit, cette rarete se fait ramasser en une soiree.
     *
     * Trois cas ne paient PAS, et c'est deliberé :
     *   • reposer exactement le nom qu'on possede deja — sinon changer sa
     *     photo, qui passe par le meme formulaire, couterait mille jetons ;
     *   • celui qui avait deja choisi son nom avant l'entree en vigueur du
     *     prix : on ne facture pas retroactivement ;
     *   • le prix mis a zero par configuration.
     *
     * Le montant est BRULE, pas encaisse : il rejoint le tas a bruler, celui
     * des frais de retrait. Un prix sur l'identite qui finit dans une poche
     * ressemble a un peage ; le meme prix retire de la circulation profite a
     * tous les porteurs, y compris a celui qui vient de payer.
     */
    if (this.doitPayerNom(p)) {
      const prix = Number(cfg.NAME_PRICE) || 0;
      const w = WEI(String(prix));
      if (p.balance.lt(w))
        throw new Error('a unique name costs ' + prix + ' $SWOGE — you have ' +
                        Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS)).toFixed(2));
      p.balance = p.balance.sub(w);
      /* Le meme tas que les frais de retrait : ce qui est ici attend d'etre
         brule, et sera compte comme brule quand la transaction aura eu lieu. */
      this.fraisCumules = (this.fraisCumules || BN(0)).add(w);
      p.nomPaye = true;
      this.note('brule', prix);
      journal.ajoute(addr, { k: 'nm', s: 'name', m: String(prix), nom: n });
    }

    p.name = n;
    /* La marque qui protege ce nom : a partir d'ici, la connexion d'une page
       ne le remplacera plus (voir setName). */
    p.nomChoisi = true;
    return n;
  }

  /**
   * Qui doit payer. UNE SEULE FOIS dans sa vie : le prix achete le droit
   * d'avoir un nom a soi, pas chaque changement. Facturer chaque changement
   * ferait payer mille jetons une faute de frappe, et le joueur garderait le
   * nom fautif plutot que de repayer — ce qui donne exactement le contraire de
   * ce qu'on cherche.
   *
   * Et personne n'est facture retroactivement : celui qui avait deja choisi
   * son nom avant l'entree en vigueur du prix le garde, et peut encore en
   * changer. Ils sont une quinzaine ; les faire payer pour un nom qu'ils ont
   * depuis des semaines serait incomprehensible.
   */
  doitPayerNom(p) {
    return (Number(cfg.NAME_PRICE) || 0) > 0 && !p.nomPaye && p.nomChoisi !== true;
  }

  /** Ce que coute le prochain nom, pour l'afficher AVANT que le joueur tape
   *  quoi que ce soit. Un prix decouvert au moment du refus se lit comme une
   *  panne ; annonce d'avance, il se lit comme une regle. */
  prixNom(addr) {
    const p = this._p(addr);
    return { prix: Number(cfg.NAME_PRICE) || 0, du: this.doitPayerNom(p) ? (Number(cfg.NAME_PRICE) || 0) : 0,
             brule: true, solde: Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS)) };
  }

  /** Le visage, choisi dans la liste fermee. */
  setVisage(addr, v) {
    const liste = Game.VISAGES;
    const s = String(v == null ? '' : v);
    if (liste.indexOf(s) < 0) throw new Error('unknown avatar');
    this._p(addr).visage = s;
    return s;
  }

  /** Ce que les autres joueurs voient d'un joueur. */
  profilPublic(addr) {
    const p = this._p(addr);
    /* `photo` dit seulement QU'IL Y EN A UNE. L'image elle-meme se demande a
       /avatar/<adresse>, ce qui la met dans le cache du navigateur au lieu de
       la recopier dans chaque message de table. */
    /* Le niveau part avec le profil public : il apparait donc d'un coup aux
       duels, dans la liste d'amis, au classement et aux tables, sans qu'aucun
       de ces endroits ait a le demander. */
    const n = this.niveau(addr);
    /* `nomChoisi` dit si le nom est une IDENTITE ou juste le debut d'une
       adresse. C'est la meme distinction qui decide si une page publique
       existe : sans nom choisi, il n'y a rien a partager. */
    return { address: String(addr).toLowerCase(), name: p.name, nomChoisi: !!p.nomChoisi,
             visage: p.visage || null, photo: !!p.photo,
             niveau: n.niveau, palier: n.palier, palierNo: n.palierNo };
  }
  /**
   * Ce qu'on montre sur une page de profil PUBLIQUE.
   *
   * Construit par ADDITION, jamais en filtrant `stats()`. La difference n'est
   * pas de style : filtrer, c'est publier par defaut et retirer ensuite — le
   * jour ou quelqu'un ajoute un champ a `stats()`, il se retrouve en ligne
   * sans que personne l'ait decide. Ici, ce qui n'est pas ecrit ci-dessous
   * n'existe pas.
   *
   * Ce qui n'y sera jamais : le solde, le total depose, le gain net, les
   * revenus de parrainage. Le solde de quelqu'un ne regarde personne, et
   * afficher combien il a depose designe une cible.
   *
   * Ce qui y est : ce que le canal Telegram annonce deja publiquement — le
   * nom, le niveau, les grosses victoires — plus ce qui se lit deja aux
   * tables : contre qui on joue, et comment ca tourne.
   */
  profilPage(addr) {
    const a = String(addr).toLowerCase();
    const p = this.players.get(a);
    if (!p) return null;
    const pub = this.profilPublic(a);
    const n = this.niveau(a);
    const jeux = p.jeux || {};

    let manches = 0;
    const parJeu = [];
    for (const k of Object.keys(jeux)) {
      const j = jeux[k];
      manches += j.n || 0;
      parJeu.push({ jeu: k, n: j.n || 0, gagne: j.gagne || 0 });
    }
    parJeu.sort((x, y) => y.n - x.n);

    /* Les rivalites : ceux qu'on a le plus croises. Un adversaire rencontre
       une fois n'est pas une rivalite, c'est une rencontre. */
    const face = [];
    for (const [adv, c] of Object.entries(p.face || {})) {
      const total = (c.v || 0) + (c.d || 0) + (c.n || 0);
      if (total < 2) continue;
      const q = this.players.get(adv);
      face.push({ adresse: adv, nom: q ? q.name : adv.slice(0, 6),
                  niveau: q ? this.niveau(adv).niveau : 0,
                  v: c.v || 0, d: c.d || 0, n: c.n || 0, total });
    }
    face.sort((x, y) => y.total - x.total);

    return {
      adresse: a, nom: pub.name, visage: pub.visage, photo: pub.photo,
      niveau: pub.niveau, palier: pub.palier, palierNo: pub.palierNo,
      volume: n.volume, seuil: n.seuil, prochain: n.prochain,
      manches,
      favoris: parJeu.filter((x) => x.n > 0).slice(0, 3),
      /* La plus grosse victoire est deja annoncee dans le canal au moment ou
         elle tombe : la republier ici n'apprend rien de nouveau a personne. */
      record: p.record ? { gain: p.record.g, multi: p.record.x, jeu: p.record.j, quand: p.record.t } : null,
      duels: {
        joues: face.reduce((t, x) => t + x.total, 0),
        gagnes: face.reduce((t, x) => t + x.v, 0),
        rivaux: face.slice(0, 5),
      },
      amis: (p.amis || []).length,
      depuis: journal.resume(a).depuis || null,
    };
  }

  /** Trouve un joueur par son NOM public, pour les adresses partageables. */
  parNom(nom) {
    const q = String(nom || '').trim().toLowerCase();
    if (!q) return null;
    if (/^0x[0-9a-f]{40}$/.test(q)) return this.players.has(q) ? q : null;
    for (const [a, p] of this.players)
      if (p.nomChoisi && String(p.name || '').toLowerCase() === q) return a;
    return null;
  }

  /**
   * Graine du joueur. Le DEUX-POINTS est interdit, et ce n'est pas cosmetique.
   *
   * Chaque jeu fabrique son message en collant des morceaux avec ce separateur :
   * la machine a sous utilise `graine:numero`, le blackjack `graine:bj:numero`,
   * les autres `graine:casino`, `graine:hilo`, `graine:mines`, `graine:plinko`.
   * Un joueur qui choisissait la graine « X:bj » obtenait pour la machine a
   * sous le message « X:bj:12 » — exactement celui du blackjack pour la graine
   * « X ». Deux jeux differents partageaient alors le meme tirage, et le
   * cloisonnement sur lequel repose toute l'equite tombait.
   *
   * En retirant le separateur de ce que le joueur controle, aucune graine ne
   * peut plus se faire passer pour un autre jeu.
   */
  setClientSeed(addr, seed) {
    const p = this._p(addr);
    const propre = String(seed || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (propre) p.clientSeed = propre;
    return p.clientSeed;
  }

  balanceWei(addr) { return this._p(addr).balance; }
  balanceStr(addr) { return ethers.utils.formatUnits(this._p(addr).balance, cfg.DECIMALS); }

  /** Credit an on-chain deposit once (deduped by tx hash). */
  creditDeposit({ player, amount, tx }) {
    if (this.seenTx.has(tx)) return false;
    this.seenTx.add(tx);
    const p = this._p(player);
    p.balance = p.balance.add(amount);
    p.hasDeposited = true; // unlocks daily quests (real skin in the game)
    /* Le TOTAL depose, et pas seulement un oui/non. Sans lui il est impossible
       de dire si un gros solde vient d'un gros depot ou de nulle part — c'est
       exactement la question qu'on n'a pas su trancher le jour ou un joueur a
       ete soupconne de tricher. */
    p.deposited = (p.deposited || BN(0)).add(amount);
    /* L'adresse ET la transaction. Le joueur qui conteste un depot six mois
       plus tard ne se souvient pas d'un montant : il se souvient d'un
       virement, et c'est le hash qui permet d'aller le regarder sur la
       chaine. L'adresse de depart est la sienne — le coffre credite celui qui
       a envoye — mais l'ecrire noir sur blanc evite d'avoir a le supposer. */
    this.note('depots', ethers.utils.formatUnits(amount, cfg.DECIMALS));
    this.noteTunnel('deposants', player, ethers.utils.formatUnits(amount, cfg.DECIMALS));
    journal.ajouteSync(player, { k: 'dep', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                                 tx, from: String(player).toLowerCase() });

    /* Le cadeau du filleul, verse a son PREMIER depot reel et une seule fois.
       Personne ne partage un lien qui ne donne rien a l'ami ; et l'attacher
       au depot plutot qu'au clic empeche d'ouvrir cent comptes vides pour
       ramasser cent cadeaux. */
    if (p.parrain && !p.refBienvenue && Number(cfg.REFERRAL_WELCOME) > 0 &&
        (p.deposited || BN(0)).gte(WEI(cfg.REFERRAL_WELCOME_MIN))) {
      p.refBienvenue = true;
      const cadeau = WEI(cfg.REFERRAL_WELCOME);
      p.balance = p.balance.add(cadeau);
      /* Le cadeau entre dans le solde mais NE PEUT PAS EN SORTIR tant que la
         mise a atteindre n'est pas faite. C'est le seul verrou qui coute
         quelque chose a qui vient seulement le ramasser : pour retirer, il
         faut jouer, et jouer coute l'avantage de la maison. */
      p.bonusBloque = (p.bonusBloque || BN(0)).add(cadeau);
      p.bonusCible = (p.wagered || BN(0)).add(cadeau.mul(Math.round(cfg.REFERRAL_WELCOME_ROLLOVER)));
      journal.ajoute(player, { k: 'rf', s: 'welcome', m: String(cfg.REFERRAL_WELCOME),
                               mise: ethers.utils.formatUnits(p.bonusCible.sub(p.wagered || BN(0)), cfg.DECIMALS) });
    }
    return true;
  }

  canDrop(addr) { return this._p(addr).balance.gte(COST); }

  /**
   * Consume 1 drop cost. Returns { value, jackpotWon } (both provably-fair):
   *   value      = coin value paid when it reaches the front (0 = empty)
   *   jackpotWon = wei won from the progressive pot on this drop (0 if not)
   * Returns null if the balance can't cover the drop.
   */
  drop(addr) {
    const p = this._p(addr);
    if (p.balance.lt(COST)) return null;
    p.balance = p.balance.sub(COST);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(COST); p.dropsToday++; this._markWager(p, COST, 'pusher');
    /* LA CHUTE EST LA MANCHE. Le Coin Pusher ne passait par aucun point de
       reglage : il ne comptait ni pour le classement du mois, ni pour le
       revenu de la maison, ni pour la mesure d'usage — le jeu qui donne son
       nom au serveur etait invisible aux trois. Ce qui revient plus tard
       arrive par win(), et se raccroche a cette manche-ci. */
    this._manche(p, 'pusher', Number(cfg.DROP_COST) || 0, 0, { sansJournal: true });
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    // weighted provably-fair pick over cfg.PRIZES ([value, weight]) — bits 0..14
    let r = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(cfg.PRIZE_TOTAL));
    let value = 0;
    for (let i = 0; i < cfg.PRIZES.length; i++) { r -= cfg.PRIZES[i][1]; if (r < 0) { value = cfg.PRIZES[i][0]; break; } }
    // progressive jackpot: feed the pot, then roll the trigger on bits 15..29
    this.jackpotPot = this.jackpotPot.add(this._rakeWei);
    let jackpotWon = ethers.BigNumber.from(0);
    const jr = Number(BigInt('0x' + h.slice(15, 30)) % BigInt(cfg.JACKPOT_ODDS));
    if (jr === 0) {
      jackpotWon = this.jackpotPot;
      this.note('jackpots', ethers.utils.formatUnits(jackpotWon, cfg.DECIMALS), p.addr);
      p.balance = p.balance.add(jackpotWon);
      p.dayNet = p.dayNet.add(jackpotWon);
      this.jackpotPot = this._jackpotSeed;
    }
    return { value, jackpotWon };
  }

  /** Give back a drop cost (the table was full, so no coin was placed). */
  refund(addr) { const p = this._p(addr); p.balance = p.balance.add(COST); }

  canSpin(addr) { return this._p(addr).balance.gte(SPIN_COST); }

  /**
   * SWOGE Smash: one spin. Deducts SPIN_COST, rolls a provably-fair multiplier
   * from cfg.SPIN_PRIZES (RTP = 50%) and credits (multiplier × SPIN_COST).
   * Fully synchronous — like drop() — so two concurrent spins can never both
   * pass the balance check (Node is single-threaded; the second sees the
   * already-deducted balance). Returns { mult, payout } or null if too poor.
   */
  spin(addr, betRaw) {
    const p = this._p(addr);
    // Mise variable (defaut : l'ancien cout fixe, pour les clients pas encore a jour)
    let bet = Math.floor(Number(betRaw));
    if (!(bet >= 1)) bet = Number(cfg.SPIN_COST || '1');
    if (bet < cfg.SMASH_MIN_BET) bet = cfg.SMASH_MIN_BET;
    if (bet > cfg.SMASH_MAX_BET) return { error: 'max bet is ' + cfg.SMASH_MAX_BET + ' $SWOGE' };
    const betWei = WEI(bet);
    if (p.balance.lt(betWei)) return null;
    p.balance = p.balance.sub(betWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei, 'smash');
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    let r = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(cfg.SPIN_TOTAL));
    let mult = 0;
    for (let i = 0; i < cfg.SPIN_PRIZES.length; i++) { r -= cfg.SPIN_PRIZES[i][1]; if (r < 0) { mult = cfg.SPIN_PRIZES[i][0]; break; } }
    let payout = 0;
    if (mult > 0) {
      const pay = betWei.mul(mult);
      p.balance = p.balance.add(pay);
      this._bumpDay(p); p.dayNet = p.dayNet.add(pay); p.winsToday++;
      payout = mult * bet;
    }
    this._manche(p, 'smash', bet, payout);
    return { mult, payout, bet };
  }

  volcanoMeterOf(addr) { return this._p(addr).volcanoMeter || 0; }

  /**
   * SWOGE Spin (Volcano). One spin at `bet` $SWOGE. Deducts the bet, computes a
   * provably-fair outcome server-side (client only animates it, so wins can't be
   * faked), tracks the per-player collect meter, and credits base×bet. RTP ~70%.
   * Returns { outcome, bet, payout, balance, fairness } or { error }.
   */
  volcanoSpin(addr, bet) {
    const p = this._p(addr);
    bet = Math.floor(Number(bet));
    if (!cfg.VOLCANO_BETS.includes(bet)) throw new Error('invalid bet');
    const betWei = WEI(bet);
    if (p.balance.lt(betWei)) return { error: 'need_deposit' };
    p.balance = p.balance.sub(betWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei, 'spin');
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    const out = volcano.spinAll(volcano.rngFrom(h), p.volcanoMeter || 0);
    p.volcanoMeter = out.meter;
    let payout = 0;
    if (out.totalInternal > 0) {
      const payWei = WEI(out.totalInternal * bet);
      p.balance = p.balance.add(payWei);
      this._bumpDay(p); p.dayNet = p.dayNet.add(payWei); p.winsToday++;
      payout = out.totalInternal * bet;
    }
    this._manche(p, 'spin', bet, payout);
    return { outcome: out, bet, payout, balance: this.balanceStr(addr), fairness: this.fairness(addr) };
  }

  /** Buy the bonus directly: costs bet × VOLCANO_BONUS_COST_MULT, runs a guaranteed bonus. */
  volcanoBuyBonus(addr, bet) {
    const p = this._p(addr);
    bet = Math.floor(Number(bet));
    if (!cfg.VOLCANO_BETS.includes(bet)) throw new Error('invalid bet');
    const cost = bet * cfg.VOLCANO_BONUS_COST_MULT;
    const costWei = WEI(cost);
    if (p.balance.lt(costWei)) return { error: 'need_deposit' };
    p.balance = p.balance.sub(costWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(costWei); p.dropsToday++; this._markWager(p, costWei, 'spin');
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    const bonus = volcano.runBonus(3, volcano.rngFrom(h));
    let payout = 0;
    if (bonus.total > 0) {
      const payWei = WEI(bonus.total * bet);
      p.balance = p.balance.add(payWei);
      this._bumpDay(p); p.dayNet = p.dayNet.add(payWei); p.winsToday++;
      payout = bonus.total * bet;
    }
    this._manche(p, 'spinBonus', cost, payout);
    return { outcome: { bonus }, bet, cost, payout, balance: this.balanceStr(addr), fairness: this.fairness(addr) };
  }

  // ===== SWOGE Blackjack (provably-fair, infinite deck, dealer stands on 17) =====
  // rank index: 0=A, 1..8 = 2..9, 9=10, 10=J, 11=Q, 12=K
  /* ---- LA CARTE PORTE SON ENSEIGNE ----
   *
   * Le tirage rendait un RANG (0..12) et la page inventait l'enseigne dans le
   * navigateur, a partir d'un sel local. Deux consequences :
   *
   *   • un joueur qui verifie l'equite ne pouvait pas reconstituer sa main
   *     TELLE QU'IL L'AVAIT VUE — les piques affiches n'existaient nulle part
   *     sur le serveur ;
   *   • aucun pari annexe n'etait constructible. Perfect Pairs et 21+3
   *     demandent l'enseigne, et les batir sur celle du navigateur aurait
   *     laisse le joueur recharger la page jusqu'a tomber sur une paire
   *     parfaite a 25:1.
   *
   * La carte est un nombre de 0 a 51 : rang = n % 13, enseigne = n / 13. Le
   * tirage consomme le meme jeton de la suite provably-fair qu'avant, seule
   * l'interpretation change — les graines deja publiees restent verifiables.
   *
   * LES MAINS EN COURS AU DEPLOIEMENT portent des valeurs 0..12 : elles se
   * relisent comme des cartes d'enseigne 0. Faux, mais jouable — on ne casse
   * pas une main en cours pour une enseigne.
   *
   * ATTENTION A QUI LIT UNE CARTE : tout code qui comparait la valeur brute a
   * un rang (« r >= 9 donc c'est une figure ») doit passer par rangDe. C'est
   * exactement ce qui a fait tomber bj_audit.test.js au premier essai, et le
   * defaut etait dans le test, pas ici.
   */
  static rangDe(carte) { return ((Number(carte) || 0) % 13 + 13) % 13; }
  static enseigneDe(carte) { return Math.floor(((Number(carte) || 0) % 52 + 52) % 52 / 13); }
  /* L'ordre des enseignes est celui des planches de la page : 0 coeur,
     1 carreau, 2 trefle, 3 pique. Les deux premieres sont rouges. Perfect
     Pairs distingue trois paliers et c'est la SEULE chose qui les separe. */
  static couleurDe(carte) { return Game.enseigneDe(carte) < 2 ? 0 : 1; }

  /* ---------------------------------------------------- LES PARIS ANNEXES
   *
   * Les deux premiers se jouent AVANT la donne et se resolvent DES la donne :
   * ils ne lisent que les deux cartes du joueur et la carte VISIBLE du
   * croupier. Aucun des deux ne touche a la carte cachee, donc les payer tout
   * de suite ne revele rien — c'est ce qui permet de les regler avant meme
   * que le joueur ait tire.
   *
   * L'assurance, elle, est d'une autre nature : elle se propose APRES la donne,
   * uniquement sur un As decouvert, et elle PARIE sur la carte cachee. Elle a
   * donc son propre temps de jeu (l'etape 'insurance'), et pas une case a
   * remplir avant de distribuer.
   *
   * Les deux fonctions ci-dessous sont pures : elles ne lisent que des cartes.
   * C'est ce qui les rend mesurables a un million de coups sans lancer une
   * seule partie — voir bj_annexes.test.js.
   */
  /** Perfect Pairs : les deux cartes du joueur. null si ce n'est pas une paire. */
  static ppRang(a, b) {
    if (Game.rangDe(a) !== Game.rangDe(b)) return null;
    if (Game.enseigneDe(a) === Game.enseigneDe(b)) return 'parfaite';
    if (Game.couleurDe(a) === Game.couleurDe(b)) return 'couleur';
    return 'mixte';
  }
  /** 21+3 : les deux cartes du joueur et la carte visible du croupier. */
  static tp3Rang(a, b, c) {
    const r = [a, b, c].map(Game.rangDe).sort((x, y) => x - y);
    const memeEnseigne = Game.enseigneDe(a) === Game.enseigneDe(b) && Game.enseigneDe(b) === Game.enseigneDe(c);
    if (r[0] === r[1] && r[1] === r[2]) return memeEnseigne ? 'brelanServi' : 'brelan';
    /* L'As vaut UN ou QUATORZE : A-2-3 se lit tel quel (rangs 0,1,2), mais
       D-R-A se trie en 0,11,12 et demande son propre cas. L'oublier retirerait
       une suite sur douze au joueur, silencieusement. */
    const suite = (r[0] + 1 === r[1] && r[1] + 1 === r[2]) || (r[0] === 0 && r[1] === 11 && r[2] === 12);
    if (suite && memeEnseigne) return 'quinteFlush';
    if (memeEnseigne) return 'couleur';
    if (suite) return 'quinte';
    return null;
  }

  _bjDraw(p) {
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':bj:' + p.nonce).digest('hex');
    p.nonce++;
    return Number(BigInt('0x' + h.slice(0, 15)) % BigInt(52));
  }
  _bjVal(cartes) { return this._bjValRangs((cartes || []).map(Game.rangDe)); }
  _bjValRangs(ranks) {
    let sum = 0, aces = 0;
    for (const r of ranks) { if (r === 0) { sum += 11; aces++; } else if (r >= 9) sum += 10; else sum += r + 1; }
    while (sum > 21 && aces) { sum -= 10; aces--; }
    return sum;
  }
  _bjDealerPlay(p) { while (this._bjVal(p.bj.dc) < 17) p.bj.dc.push(this._bjDraw(p)); }
  /* Une main COMMENCEE AVANT ce deploiement — ou relue d'une sauvegarde — n'a
     pas de case annexe. On la lui donne, vide, plutot que de laisser chaque
     lecteur tester l'existence du champ : c'est le meme choix qu'a l'arrivee
     des enseignes, on ne casse pas une main en cours. */
  static _bjAnn(b) {
    if (!b.ann) b.ann = {};
    for (const k of ['pp', 'tp', 'ins']) if (!b.ann[k]) b.ann[k] = { mise: 0, rang: null, gain: 0 };
    return b.ann;
  }
  _bjPublic(p, reveal) {
    const b = p.bj, show = reveal || b.stage === 'done';
    Game._bjAnn(b);
    return {
      bet: b.bet, doubled: !!b.doubled, stage: b.stage,
      player: { cards: b.pc.slice(), value: this._bjVal(b.pc) },
      dealer: { cards: show ? b.dc.slice() : [b.dc[0]], value: show ? this._bjVal(b.dc) : this._bjVal([b.dc[0]]), hidden: !show },
      canDouble: b.stage === 'player' && b.pc.length === 2 && p.balance.gte(WEI(b.bet)),
      result: b.result || null, payout: b.payout || 0,
      /* Les annexes voyagent toujours, meme vides : la page peut alors les
         peindre sans se demander si le champ existe. */
      annexes: {
        pp:  { mise: b.ann.pp.mise,  rang: b.ann.pp.rang,  gain: b.ann.pp.gain },
        tp:  { mise: b.ann.tp.mise,  rang: b.ann.tp.rang,  gain: b.ann.tp.gain },
        ins: { mise: b.ann.ins.mise, rang: b.ann.ins.rang, gain: b.ann.ins.gain },
      },
      /* Ce que le joueur a le droit de poser sur l'assurance, MAINTENANT. La
         page ne recalcule pas la moitie de la mise dans son coin : elle
         afficherait un maximum que le serveur refuse des que le solde manque. */
      insuranceMax: b.stage === 'insurance' ? this._bjAssuranceMax(p) : 0,
      balance: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
      fairness: { serverSeedHash: this.serverSeedHash, nonce: p.nonce },
    };
  }
  /** Mise annexe acceptable, ou l'erreur exacte qui dit pourquoi elle ne l'est pas. */
  _bjMiseAnnexe(v, nom) {
    if (v == null || v === '') return 0;
    const m = Math.floor(Number(v));
    if (!isFinite(m) || m < 0) throw new Error('bad ' + nom + ' side bet');
    if (m === 0) return 0;
    if (m > cfg.BJ_SIDE_MAX_BET) throw new Error('side bets are capped at ' + cfg.BJ_SIDE_MAX_BET + ' $SWOGE');
    return m;
  }
  _bjAssuranceMax(p) {
    const moitie = Math.floor(p.bj.bet / 2);
    const solde = Math.floor(Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS)));
    return Math.max(0, Math.min(moitie, solde));
  }
  /** Credite un pari annexe et l'inscrit sous son propre nom de jeu. */
  _bjPaieAnnexe(p, cle, jeu, rang, mult) {
    const a = Game._bjAnn(p.bj)[cle];
    if (!(a.mise > 0)) return;
    a.rang = rang;
    a.gain = rang ? a.mise * (mult + 1) : 0;
    if (a.gain > 0) {
      p.balance = p.balance.add(WEI(a.gain));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(a.gain)); p.winsToday++;
    }
    /* Chaque annexe tient SON compte, sous son propre nom. Les noyer dans
       « bj » cacherait exactement ce qu'on a besoin de surveiller : une table
       de gain trop genereuse se voit sur la ligne du pari concerne, pas sur
       celle de la main principale qui, elle, est saine. */
    this._manche(p, jeu, a.mise, a.gain);
  }
  /* Les deux annexes d'avant-donne, reglees d'un coup. Elles ne lisent que
     pc[0], pc[1] et dc[0] : la carte cachee n'entre pas dans le calcul. */
  _bjResoutAnnexes(p) {
    const b = p.bj; Game._bjAnn(b);
    if (b.ann.pp.mise > 0) {
      const rang = Game.ppRang(b.pc[0], b.pc[1]);
      this._bjPaieAnnexe(p, 'pp', 'bj_pp', rang, rang ? cfg.BJ_PP_PAY[rang] : 0);
    }
    if (b.ann.tp.mise > 0) {
      const rang = Game.tp3Rang(b.pc[0], b.pc[1], b.dc[0]);
      this._bjPaieAnnexe(p, 'tp', 'bj_213', rang, rang ? cfg.BJ_213_PAY[rang] : 0);
    }
  }
  /* Les naturels. Extrait de bjBet parce que l'assurance s'intercale avant :
     sur un As decouvert, on demande d'abord au joueur, ON REGARDE ENSUITE. */
  _bjNaturels(p) {
    const b = p.bj, amt = b.bet, w = WEI(amt);
    const pv = this._bjVal(b.pc), dv = this._bjVal(b.dc);
    if (pv !== 21 && dv !== 21) { b.stage = 'player'; return; }
    if (pv === 21 && dv === 21) {
      b.stage = 'done'; b.result = 'push'; b.payout = amt;
      p.balance = p.balance.add(w); this._bumpDay(p); p.dayNet = p.dayNet.add(w);
      this._manche(p, 'bj', amt, amt);
    } else if (pv === 21) {
      const credit = amt * 2.5;
      p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); p.winsToday++;
      b.stage = 'done'; b.result = 'blackjack'; b.payout = credit;
      this._manche(p, 'bj', amt, credit);
    } else {
      b.stage = 'done'; b.result = 'dealer_blackjack'; b.payout = 0;
      this._manche(p, 'bj', amt, 0);
    }
  }
  /* L'assurance non repondue vaut REFUS. Un client qui ignore l'etape (une
     page pas encore rechargee, un script tiers) doit pouvoir tirer ou rester
     comme avant : sans ca, sa main resterait ouverte pour toujours et il ne
     pourrait plus miser.
     Rend vrai quand ce refus a TERMINE la main — le croupier avait son
     blackjack. Le geste demande n'a alors plus lieu d'etre, et ce n'est pas
     une faute du joueur : on lui rend l'etat final au lieu d'une erreur. Le
     signal est volontairement etroit : rester sur une main deja finie AUTREMENT
     reste une erreur, et l'audit y tient. */
  _bjPasseAssurance(addr, p) {
    if (!p.bj || p.bj.stage !== 'insurance') return false;
    this.bjInsure(addr, 0);
    return p.bj.stage === 'done';
  }
  _bjSettle(p, stake) {   // stake already deducted; credit the return
    const pv = this._bjVal(p.bj.pc), dv = this._bjVal(p.bj.dc);
    let res, credit = 0;
    if (pv > 21) res = 'bust';
    else if (dv > 21 || pv > dv) { res = 'win'; credit = stake * 2; }
    else if (pv < dv) res = 'lose';
    else { res = 'push'; credit = stake; }
    if (credit > 0) { p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); if (res === 'win') p.winsToday++; }
    p.bj.stage = 'done'; p.bj.result = res; p.bj.payout = credit;
    this._manche(p, 'bj', stake, credit);
  }

  bjState(addr) { const p = this._p(addr); return p.bj ? this._bjPublic(p, false) : null; }

  // ----------------------------------------------------------------- casino
  // Deux jeux contre la banque : Casino Hold'em et Three Card. Toute la logique
  // de gain vit dans casino.js, teste hors ligne ; ici on ne fait que debiter,
  // garder l'etat entre la donne et la decision, puis crediter.

  /** Vue publique : jamais les cartes du croupier avant la decision. */
  _casinoPublic(p, fini) {
    const s = p.casino;
    if (!s) return null;
    const v = {
      game: s.game, stage: fini ? 'done' : s.stage,
      ante: s.ante, side: s.side,
      player: s.player.slice(),
      board: s.board ? s.board.slice() : [],
      result: null,
    };
    if (fini && s.result) {
      v.dealer = s.result.dealer ? s.result.dealer.slice() : (s.dealer || []).slice();
      v.board = (s.result.board || s.board || []).slice();
      const engage = s.game === 'holdem'
        ? s.ante * (s.called ? 3 : 1) + s.side
        : s.ante * (s.called ? 2 : 1) + s.side;
      v.result = {
        outcome: s.result.outcome, payout: s.result.payout, detail: s.result.detail,
        fee: s.result.fee || 0, staked: engage, net: s.result.payout - engage,
        playerHand: s.result.playerHand || null, dealerHand: s.result.dealerHand || null,
      };
    }
    return v;
  }

  casinoState(addr) { const p = this._p(addr); return p.casino ? this._casinoPublic(p, p.casino.stage === 'done') : null; }

  /**
   * Distribue une main. `side` est le Pair Plus (Three Card) ou le bonus AA
   * (Hold'em). Les mises partent tout de suite : rien ne doit pouvoir etre
   * distribue sans que le solde ait deja ete debite.
   */
  casinoDeal(addr, gameId, anteRaw, sideRaw) {
    const p = this._p(addr);
    if (p.casino && p.casino.stage !== 'done') throw new Error('hand in progress');
    if (gameId !== 'holdem' && gameId !== 'three') throw new Error('unknown game');

    const ante = Math.floor(Number(anteRaw));
    const side = Math.max(0, Math.floor(Number(sideRaw) || 0));
    if (!(ante >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (ante > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (side > cfg.CASINO_MAX_BET) throw new Error('side bet too large');

    // Hold'em : suivre coute 2x l'Ante, on exige donc 3x l'Ante des le depart,
    // sinon le joueur decouvre son flop sans pouvoir payer la suite.
    const requis = ante * (gameId === 'holdem' ? 3 : 2) + side;
    if (p.balance.lt(WEI(requis))) throw new Error('not enough $SWOGE to see the hand through');

    const debit = WEI(ante + side);
    p.balance = p.balance.sub(debit);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(debit); p.dropsToday++; this._markWager(p, debit, gameId);

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':casino', nonce: p.nonce };

    if (gameId === 'three') {
      const d = casino.shoe(graine.serverSeed, graine.clientSeed, graine.nonce);
      p.casino = { game: 'three', stage: 'decide', ante, side, graine,
                   player: [d[0], d[1], d[2]], dealer: [d[3], d[4], d[5]], board: [] };
    } else {
      const deal = casino.holdemDeal(graine);
      p.casino = { game: 'holdem', stage: 'decide', ante, side, graine, deal,
                   player: deal.player, dealer: deal.dealer, board: deal.board };
    }
    return this._casinoPublic(p, false);
  }

  /** Suivre ou se coucher. Credite le gain et referme la main. */
  casinoDecide(addr, suit) {
    const p = this._p(addr);
    const s = p.casino;
    if (!s || s.stage !== 'decide') throw new Error('no hand to decide');

    // Suivre engage une mise supplementaire : elle doit etre debitee AVANT que
    // le resultat soit connu, sinon un joueur a sec pourrait suivre gratuitement.
    let extra = 0;
    if (suit) extra = s.game === 'holdem' ? s.ante * 2 : s.ante;
    if (extra > 0) {
      if (p.balance.lt(WEI(extra))) throw new Error('not enough $SWOGE to call');
      p.balance = p.balance.sub(WEI(extra));
      this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(extra)); this._markWager(p, WEI(extra), s.game);
    }

    const feeBps = cfg.CASINO_WIN_FEE_BPS;
    const r = s.game === 'three'
      ? casino.threeCard(Object.assign({}, s.graine, { ante: s.ante, pairPlus: s.side, play: !!suit, feeBps }))
      : casino.holdemResolve({ deal: s.deal, ante: s.ante, aa: s.side, call: !!suit, feeBps });

    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.outcome === 'win' || r.outcome === 'dealer_not_qualified') p.winsToday++;
    }
    s.result = r; s.stage = 'done'; s.called = !!suit;
    const vue = this._casinoPublic(p, true);
    this._manche(p, s.game, vue.result.staked, r.payout);
    return vue;
  }

  // ------------------------------------------------------------------ hi-lo
  // Plus haut ou plus bas. La mise part au premier tirage ; a partir de la, le
  // joueur ne risque plus que ce qu'il a deja engage. Tout le calcul vit dans
  // hilo.js, teste hors ligne.

  _hiloPublic(p) {
    const s = p.hilo;
    if (!s) return null;
    const e = s.etat;
    return {
      mise: e.mise, carte: e.carte, rang: e.rang, pas: e.pas,
      multi: e.multi, fini: !!e.fini, perdu: !!e.perdu, encaisse: !!e.encaisse,
      peutMonter: !!e.peutMonter, peutDescendre: !!e.peutDescendre,
      // ce que rapporterait chaque pari, pour l'afficher AVANT de cliquer
      multHigher: e.peutMonter ? hilo.multiplicateur(e.rang, 'higher', cfg.HILO_EDGE_BPS) : 0,
      multLower: e.peutDescendre ? hilo.multiplicateur(e.rang, 'lower', cfg.HILO_EDGE_BPS) : 0,
      gain: Math.floor(e.mise * e.multi),
      dernier: s.dernier || null,
    };
  }

  hiloState(addr) { const p = this._p(addr); return this._hiloPublic(p); }

  /** Ouvre une partie : la mise est debitee tout de suite. */
  hiloStart(addr, miseRaw) {
    const p = this._p(addr);
    if (p.hilo && !p.hilo.etat.fini) throw new Error('game in progress');

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise), 'hilo');

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':hilo', nonce: p.nonce };
    p.hilo = { graine, etat: hilo.ouvrir(Object.assign({ mise }, graine)), dernier: null };
    return this._hiloPublic(p);
  }

  /** Un pas : plus haut ou plus bas. Rien n'est debite, la mise est deja partie. */
  hiloStep(addr, sens) {
    const p = this._p(addr);
    const s = p.hilo;
    if (!s || s.etat.fini) throw new Error('no game in progress');
    const avant = s.etat.carte;
    const r = hilo.jouer(Object.assign({ etat: s.etat, sens, edgeBps: cfg.HILO_EDGE_BPS }, s.graine));
    s.etat = r.etat;
    s.dernier = { sens, avant, carte: r.carte, gagne: r.gagne,
                  egalites: r.egalites, mult: r.multiplicateurDuPas };
    // une partie perdue se conclut ICI, pas a l'encaissement : sans ca on ne
    // compterait que les parties gagnantes et le taux serait de 100 %
    if (s.etat.fini && s.etat.perdu) this._manche(p, 'hilo', s.etat.mise, 0);
    return this._hiloPublic(p);
  }

  /** Encaisse le multiplicateur courant. */
  hiloCashOut(addr) {
    const p = this._p(addr);
    const s = p.hilo;
    if (!s || s.etat.fini) throw new Error('no game to cash out');
    const r = hilo.encaisser(s.etat);
    s.etat = r.etat;
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    const v = this._hiloPublic(p);
    v.payout = r.payout; v.net = r.net;
    this._manche(p, 'hilo', v.mise, r.payout);
    return v;
  }

  // ------------------------------------------------------------------ mines
  // Une grille de 25 cases, des bombes placees a l'ouverture. Tout le calcul
  // vit dans mines.js, verifie hors ligne.

  /**
   * Vue publique. Les bombes ne sortent QUE lorsque la partie est finie : les
   * envoyer plus tot reviendrait a donner la solution, et aucun affichage cote
   * navigateur ne peut cacher une donnee qu'on lui a transmise.
   */
  _minesPublic(p) {
    const s = p.mines;
    if (!s) return null;
    const e = s.etat;
    const v = {
      mise: e.mise, nbMines: e.nbMines,
      ouvertes: e.ouvertes.slice(),
      multi: e.multi,
      fini: !!e.fini, perdu: !!e.perdu, encaisse: !!e.encaisse, complet: !!e.complet,
      // ce que rapporterait la case suivante, pour l'afficher AVANT de cliquer
      multiSuivant: e.fini ? 0
        : mines.multiplicateur(e.nbMines, e.ouvertes.length + 1, e.edgeBps),
      gain: Math.floor(e.mise * e.multi),
      maximum: mines.maximum(e.nbMines, e.edgeBps),
    };
    if (e.fini) {
      v.bombes = e.bombes.slice();          // la grille se decouvre a la fin
      if (e.touchee != null) v.touchee = e.touchee;
    }
    return v;
  }

  minesState(addr) { const p = this._p(addr); return this._minesPublic(p); }

  /**
   * Multiplicateur de la PREMIERE case pour chaque nombre de bombes propose.
   * Calcule ici, et envoye au navigateur, pour qu'il n'ait aucune formule a
   * lui : deux sources de verite finissent toujours par diverger, et c'est
   * l'affichage qui aurait tort au pire moment — juste avant de miser.
   */
  minesBareme() {
    const out = {};
    for (const m of cfg.MINES_CHOIX) out[m] = mines.multiplicateur(m, 1, cfg.MINES_EDGE_BPS);
    return out;
  }

  /** Ouvre une partie : la mise est debitee tout de suite. */
  minesStart(addr, miseRaw, nbMinesRaw) {
    const p = this._p(addr);
    if (p.mines && !p.mines.etat.fini) throw new Error('game in progress');

    /* Pas de Math.floor ici, contrairement a la mise : le nombre de bombes est
       un choix pris dans une liste, pas un montant. Recevoir 2,5 veut dire que
       le client s'est trompe — l'arrondir en silence masquerait sa faute et
       ferait jouer une grille que personne n'a demandee. */
    const nbMines = Number(nbMinesRaw);
    if (!Number.isInteger(nbMines) || nbMines < mines.MINES_MIN || nbMines > mines.MINES_MAX)
      throw new Error('mines must be a whole number between ' + mines.MINES_MIN + ' and ' + mines.MINES_MAX);

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise), 'mines');

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':mines', nonce: p.nonce };
    p.mines = { graine, etat: mines.ouvrir(Object.assign({ mise, nbMines, edgeBps: cfg.MINES_EDGE_BPS }, graine)) };
    return this._minesPublic(p);
  }

  /** Retourne une case. Rien n'est debite : la mise est deja partie. */
  minesPick(addr, position) {
    const p = this._p(addr);
    const s = p.mines;
    if (!s || s.etat.fini) throw new Error('no game in progress');
    const r = mines.jouer({ etat: s.etat, position });
    s.etat = r.etat;
    if (s.etat.fini && s.etat.perdu) this._manche(p, 'mines', s.etat.mise, 0);
    const v = this._minesPublic(p);
    v.dernier = { position: r.position, sure: r.sure };
    return v;
  }

  /** Encaisse le multiplicateur courant. */
  minesCashOut(addr) {
    const p = this._p(addr);
    const s = p.mines;
    if (!s || s.etat.encaisse || s.etat.perdu) throw new Error('no game to cash out');
    const r = mines.encaisser(s.etat);
    s.etat = r.etat;
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    const v = this._minesPublic(p);
    v.payout = r.payout; v.net = r.net;
    this._manche(p, 'mines', v.mise, r.payout);
    return v;
  }

  // ----------------------------------------------------------------- plinko
  // Une bille, un coup. Rien a conserver entre deux messages : il n'y a donc
  // aucun etat qu'un joueur puisse abandonner en cours de route pour garder sa
  // mise, contrairement au Hi-Lo et au Mines.

  /** Le bareme complet, pour que le navigateur affiche les godets sans calculer. */
  plinkoTable(rangees, risque) {
    return plinko.table(rangees, risque, cfg.PLINKO_EDGE_BPS);
  }

  /** Toutes les tables d'un coup : envoyees a la connexion, jamais recalculees. */
  plinkoBaremes() {
    const out = {};
    for (const r of plinko.RANGEES)
      for (const q of plinko.RISQUES) out[r + ':' + q] = this.plinkoTable(r, q);
    return out;
  }

  /** Lache une bille. La mise part et le gain revient dans le meme geste. */
  plinkoDrop(addr, miseRaw, rangeesRaw, risqueRaw) {
    const p = this._p(addr);

    const rangees = Number(rangeesRaw);
    if (!Number.isInteger(rangees) || plinko.RANGEES.indexOf(rangees) < 0)
      throw new Error('rows must be one of ' + plinko.RANGEES.join(', '));
    const risque = String(risqueRaw || '');
    if (plinko.RISQUES.indexOf(risque) < 0)
      throw new Error('risk must be one of ' + plinko.RISQUES.join(', '));

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise), 'plinko');

    p.nonce++;
    const r = plinko.lancer({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':plinko', nonce: p.nonce,
      mise, rangees, risque, edgeBps: cfg.PLINKO_EDGE_BPS,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    this._manche(p, 'plinko', r.mise, r.payout);
    return { mise: r.mise, rangees: r.rangees, risque: r.risque,
             chemin: r.chemin, case: r.case, multi: r.multi,
             payout: r.payout, net: r.net, table: r.table };
  }

  // ---------------------------------------------------------------- bonanza
  /*
   * SWOGE BONANZA — grille 6x5, gains « pay anywhere », cascades.
   *
   * Un coup unique, comme le Plinko : tout le tour est calcule ici, cascades
   * et tours gratuits compris, et rendu d'un bloc. Rien ne reste en suspens
   * entre deux messages, donc rien qu'un joueur puisse abandonner en cours de
   * route pour garder sa mise — c'est ce qui rend inutile toute gestion de
   * partie interrompue.
   *
   * La page ne DECIDE de rien : elle recoit la suite des grilles et rejoue
   * l'animation. Un joueur qui ouvre la console voit le resultat plus tot,
   * il ne le change pas.
   */
  bonanzaBareme() {
    return {
      colonnes: bonanza.COLONNES, rangees: bonanza.RANGEES,
      symboles: bonanza.SYMBOLES, scatter: bonanza.SCATTER,
      minAmas: bonanza.MIN_AMAS, bareme: bonanza.BAREME,
      baremeScatter: bonanza.BAREME_SCATTER,
      scattersPourTours: bonanza.SCATTERS_POUR_TOURS,
      toursGratuits: bonanza.TOURS_GRATUITS,
      gainMax: bonanza.GAIN_MAX, prixBonus: bonanza.PRIX_BONUS,
      min: cfg.CASINO_MIN_BET, max: cfg.CASINO_MAX_BET,
    };
  }

  bonanzaSpin(addr, miseRaw) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise));
    this._markWager(p, WEI(mise), 'bonanza');

    p.nonce++;
    const r = bonanza.joue({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':bonanza',
      nonce: p.nonce, mise,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    this._manche(p, 'bonanza', r.mise, r.payout);
    return r;
  }

  // ---------------------------------------------------------------- dead or doge
  /* Le bareme part a la connexion, comme celui de Bonanza : la page dessine
     les gains et les prix d'achat depuis CE qui paie, jamais depuis une copie
     ecrite a cote. Deux tables finissent toujours par diverger, et c'est
     celle de la page qu'on ne pense pas a remesurer. */
  dodBareme() {
    return {
      rouleaux: dod.ROULEAUX, rangees: dod.RANGEES,
      bas: dod.BAS, hauts: dod.HAUTS, wild: dod.WILD,
      dead: dod.DEAD, deader: dod.DEADER,
      rouleauxWild: dod.ROULEAUX_WILD,
      bareme: dod.BAREME, taillesWild: dod.TAILLES_WILD,
      scattersPourTours: dod.SCATTERS_POUR_TOURS, tours: dod.TOURS,
      gainMax: dod.GAIN_MAX,
      /* Les trois mecaniques du mode gratuit partent AVEC le bareme. La page
         ecrivait ses regles a la main : elle annoncait encore des
         multiplicateurs qui se multiplient et un bonus qu'on ne peut pas
         relancer, deux jours apres que le moteur eut cesse de faire l'un et
         l'autre. Une regle recopiee finit toujours par mentir. */
      croissance: dod.CROISSANCE, plafondRouleau: dod.PLAFOND_ROULEAU,
      deuxScattersWild: dod.DEUX_SCATTERS_WILD, surclasseTours: dod.SURCLASSE_TOURS,
      crans: dod.CRANS, cransOrdre: dod.CRANS_ORDRE,
      min: cfg.CASINO_MIN_BET, max: cfg.CASINO_MAX_BET,
      /* Le retour au joueur part AVEC le bareme, comme tout le reste : la
         page ne doit pas en garder de copie, sinon elle annoncera l'ancien
         le jour ou le moteur sera reregle. */
      rtp: dod.RTP, rtpIc: dod.RTP_IC, rtpN: dod.RTP_TOURS,
      bonusUnSur: dod.BONUS_UN_SUR,
      gainVu: dod.GAIN_VU, gainVuTours: dod.GAIN_VU_TOURS,
    };
  }

  /* ==================== SWOGE LE CHENIL ====================
   * Meme forme que DEAD SWOGE : le bareme part avec l'etat, la page n'en
   * garde aucune copie, et le tour est DECIDE ICI avant que le moindre
   * rouleau bouge cote joueur.
   */
  chenilBareme() {
    return {
      rouleaux: chenil.ROULEAUX, rangees: chenil.RANGEES,
      bas: chenil.BAS, hauts: chenil.HAUTS,
      wild: chenil.WILD, bonus: chenil.BONUS,
      rouleauxWild: chenil.ROULEAUX_WILD, rouleauxBonus: chenil.ROULEAUX_BONUS,
      lignes: chenil.LIGNES, bareme: chenil.BAREME,
      multisWild: chenil.MULTIS_WILD,
      bonusPourTours: chenil.BONUS_POUR_TOURS, bonusPaie: chenil.BONUS_PAIE,
      casesTirage: chenil.CASES_TIRAGE, tirageTours: chenil.TIRAGE_TOURS,
      gainMax: chenil.GAIN_MAX,
      min: cfg.CASINO_MIN_BET, max: cfg.CASINO_MAX_BET,
      rtp: chenil.RTP, rtpIc: chenil.RTP_IC, rtpN: chenil.RTP_TOURS,
      bonusUnSur: chenil.BONUS_UN_SUR,
    };
  }

  chenilSpin(addr, miseRaw) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise));
    this._markWager(p, WEI(mise), 'chenil');

    p.nonce++;
    const r = chenil.joue({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':chenil',
      nonce: p.nonce, mise,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    this._manche(p, 'chenil', r.mise, r.payout);
    return r;
  }

  dodSpin(addr, miseRaw) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise));
    this._markWager(p, WEI(mise), 'dod');

    p.nonce++;
    const r = dod.joue({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':dod',
      nonce: p.nonce, mise,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    this._manche(p, 'dod', r.mise, r.payout);
    return r;
  }

  /* ---- L'ACHAT, EN QUATRE CRANS ----
   * LE PLAFOND PORTE SUR LE COUT, PAS SUR LA MISE — meme raison que pour
   * Bonanza : le cran `deader` coute 108 fois la mise, donc une mise de 1 000
   * engage 108 000. Un plafond de table qui ne regarderait que la mise
   * nominale ne voudrait plus rien dire.
   */
  dodAchat(addr, miseRaw, cranRaw) {
    const p = this._p(addr);
    const cran = String(cranRaw || '');
    const c = dod.CRANS[cran];
    if (!c) throw new Error('unknown buy tier');
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    const cout = Math.floor(mise * c.prix);
    if (cout > cfg.CASINO_MAX_BET) {
      throw new Error('buy costs ' + cout + ' $SWOGE — max is ' + cfg.CASINO_MAX_BET);
    }
    if (p.balance.lt(WEI(cout))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(cout));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(cout));
    this._markWager(p, WEI(cout), 'dod');

    p.nonce++;
    const r = dod.achete({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':dod',
      nonce: p.nonce, mise, cran,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    /* La manche est enregistree sur le COUT, pas sur la mise : c'est ce que le
       joueur a reellement risque. */
    this._manche(p, 'dod', r.cout, r.payout);
    return r;
  }

  /* ---- L'ACHAT DU BONUS ----
   * On paie `PRIX_BONUS` fois la mise et on entre directement dans les dix
   * tours gratuits. Le prix est MESURE, pas choisi : voir la note en tete de
   * `bonanza.js`. A 73x, l'achat rend 94,73 % contre 94,65 % pour le jeu
   * normal — mesure sur 250 000 achats.
   *
   * LE PLAFOND PORTE SUR LE COUT, PAS SUR LA MISE. Une mise de 10 000
   * couterait 730 000 : le plafond de table ne voudrait plus rien dire s'il
   * ne s'appliquait qu'a la mise nominale. On refuse donc l'achat dont le
   * COUT depasse le maximum de la table, comme pour n'importe quel autre
   * engagement.
   */
  bonanzaAchat(addr, miseRaw) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    const cout = mise * bonanza.PRIX_BONUS;
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (cout > cfg.CASINO_MAX_BET) {
      throw new Error('buying the bonus costs ' + bonanza.PRIX_BONUS + '× the bet — max bet for a buy is '
                      + Math.floor(cfg.CASINO_MAX_BET / bonanza.PRIX_BONUS) + ' $SWOGE');
    }
    if (p.balance.lt(WEI(cout))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(cout));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(cout));
    this._markWager(p, WEI(cout), 'bonanza');

    p.nonce++;
    const r = bonanza.achete({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':bonanza',
      nonce: p.nonce, mise,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    /* La manche est enregistree sur le COUT, pas sur la mise nominale :
       c'est ce que le joueur a reellement engage. */
    this._manche(p, 'bonanza', r.cout, r.payout);
    return r;
  }

  // ---------------------------------------------------------------- boulier
  // 90 boules, 30 sortent, une grille de 10. Un coup unique comme le Plinko :
  // rien a conserver entre deux messages, donc rien qu'un joueur puisse
  // abandonner en cours de route pour garder sa mise.
  //
  // La difference avec tous les autres jeux de la maison : le prix est FIXE.
  // C'est la cagnotte qui l'impose (voir BOULIER_PRIX dans config.js). On joue
  // plusieurs grilles au lieu de miser plus gros — et les grilles d'une meme
  // manche partagent les memes 30 boules, parce qu'un boulier ne tourne qu'une
  // fois.

  /** Ce qu'il faut au navigateur pour tout afficher sans calculer une formule. */
  boulierBareme() {
    return {
      boules: boulier.BOULES, tirees: boulier.TIREES, grille: boulier.GRILLE,
      prix: cfg.BOULIER_PRIX, grillesMax: cfg.BOULIER_GRILLES_MAX,
      table: boulier.table(),
      partCagnotteBps: boulier.CAGNOTTE_BPS,
      partPleinBps: boulier.CAGNOTTE_PART_BPS,
      retourBareme: boulier.retourBareme(),
      retourTotal: boulier.retourTotal(),
    };
  }

  /** La cagnotte en SWOGE lisibles, comme jackpotStr() pour le Coin Pusher. */
  boulierPotStr() { return ethers.utils.formatUnits(this.boulierPot, cfg.DECIMALS); }

  /** L'etat affiche a la connexion et a chaque changement de phase. */
  boulierEtat(now, addr) {
    const e = this.boulierSalle.etat(now || Date.now(), addr);
    e.cagnotte = this.boulierPotStr();
    e.pleins = (this.boulierPleins || []).slice(0, 10);
    return e;
  }

  /**
   * Inscrit des grilles sur la manche EN COURS D'ATTENTE.
   *
   * L'ordre des operations n'est pas negociable. La cagnotte est alimentee a
   * l'inscription, pas au tirage : sinon un joueur qui fait un plein emporterait
   * un pot auquel sa propre mise n'a pas encore contribue, et le pot repartirait
   * en dessous de ce que le cycle a collecte.
   */
  boulierInscrit(addr, grillesRaw, now) {
    const p = this._p(addr);
    if (!Array.isArray(grillesRaw) || grillesRaw.length < 1)
      throw new Error('play at least one grid');
    if (grillesRaw.length > cfg.BOULIER_GRILLES_MAX)
      throw new Error('at most ' + cfg.BOULIER_GRILLES_MAX + ' grids per draw');

    const prix = cfg.BOULIER_PRIX;
    const mise = prix * grillesRaw.length;
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    /* La salle valide et refuse AVANT tout debit : phase fermee, plafond de la
       manche atteint, grille mal formee. Une manche refusee ne doit rien avoir
       touche. */
    this.boulierSalle.inscrire(addr, p.name, grillesRaw, prix, cfg.BOULIER_GRILLES_MAX);

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise), 'boulier');

    const versement = boulier.partCagnotte(prix) * grillesRaw.length;
    this.boulierPot = this.boulierPot.add(WEI(versement));

    return { etat: this.boulierEtat(now || Date.now(), addr), mise };
  }

  /**
   * Le tirage est sorti : on paie tout le monde.
   *
   * Les joueurs sont servis DANS L'ORDRE D'INSCRIPTION. Ca ne compte que pour
   * la cagnotte — deux pleins la meme manche prennent chacun 80 % de ce qui
   * RESTE — mais alors ca compte vraiment, et un ordre qui depend du parcours
   * d'une Map serait un ordre que personne ne peut prevoir ni verifier.
   */
  boulierRegle(sortie) {
    const prix = cfg.BOULIER_PRIX;
    const out = [];
    for (const [addr, j] of this.boulierSalle.joueurs) {
      const p = this._p(addr);
      let payout = 0, cagnotteGagnee = 0;
      const lignes = j.grilles.map((g) => {
        const t = boulier.touches(g, sortie);
        const l = { grille: g.slice(), touches: t, n: t.length,
                    lot: boulier.lot(t.length, prix), plein: false };
        if (t.length === boulier.GRILLE) {
          /* Le pot est debite de ce qui est REELLEMENT verse, pas de la part
             brute : un pot de 200 002 donne 160 001,6 et le solde ne connait
             que des SWOGE entiers. Le reste fractionnaire demeure dans le pot,
             ou il servira au gagnant suivant. */
          const part = this.boulierPot.mul(boulier.CAGNOTTE_PART_BPS).div(10000);
          const swoge = Math.floor(Number(ethers.utils.formatUnits(part, cfg.DECIMALS)));
          this.boulierPot = this.boulierPot.sub(WEI(swoge));
          l.plein = true; l.cagnotte = swoge;
          cagnotteGagnee += swoge; payout += swoge;
        }
        payout += l.lot;
        return l;
      });

      if (cagnotteGagnee > 0) {
        this.boulierPleins.unshift({ t: Date.now(), addr, nom: p.name, gain: cagnotteGagnee });
        this.boulierPleins = this.boulierPleins.slice(0, 50);
      }
      if (payout > 0) {
        p.balance = p.balance.add(WEI(payout));
        this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(payout));
        if (payout > j.mise) p.winsToday++;
      }
      this._manche(p, 'boulier', j.mise, payout);
      this.boulierSalle.note(addr, lignes, payout, cagnotteGagnee);
      out.push({ addr, mise: j.mise, lignes, payout, net: payout - j.mise,
                 cagnotteGagnee, balance: this.balanceStr(addr) });
    }
    return out;
  }

  /** L'horloge de la salle. server.js diffuse ce qui en sort. */
  boulierTick(now) {
    const evs = this.boulierSalle.tick(now);
    for (const ev of evs) {
      /* Le reglement se fait A LA SORTIE DES BOULES, pas a la fin de
         l'animation : le joueur qui ferme l'onglet pendant que les boules
         tombent a deja ete paye, exactement comme au solo. L'animation ne fait
         que raconter. */
      if (ev.type === 'boulierTirage') {
        ev.resultats = this.boulierRegle(ev.sortie);
        ev.joueurs = this.boulierSalle.liste();
        ev.cagnotte = this.boulierPotStr();
      }
    }
    return evs;
  }

  // ------------------------------------------------------------------ crash
  // Une seule manche pour tout le monde. Contrairement au Plinko, la mise part
  // AVANT de savoir quoi que ce soit, et le gain revient plus tard — au retrait,
  // ou jamais. Le solde suit donc deux chemins separes : le debit a la mise, le
  // credit a l'encaissement.

  /** L'etat de la table pour un joueur donne, avec son propre pari. */
  crashEtat(now, addr) {
    const e = this.crash.etat(now || Date.now());
    e.edgeBps = cfg.CRASH_EDGE_BPS;
    e.min = cfg.CASINO_MIN_BET;
    e.max = cfg.CASINO_MAX_BET;
    e.joueurs = this._crashNoms(e.joueurs);
    if (addr) e.moi = this.crash.pari(addr);
    return e;
  }

  /**
   * La table du Crash ne connait que des adresses — c'est voulu, elle ignore
   * tout des joueurs. Mais une liste de 0x25…47f ne dit rien a personne : on y
   * remet les noms au moment de sortir, la ou ils sont connus.
   */
  _crashNoms(liste) {
    return (liste || []).map((j) => Object.assign({ name: this._p(j.addr).name }, j));
  }

  /**
   * Poser une mise sur la manche en cours. La mise est debitee tout de suite :
   * un solde qui ne bougerait qu'au crash laisserait le joueur miser deux fois
   * le meme jeton sur deux onglets.
   */
  crashMise(addr, miseRaw, autoRaw, now) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    // parier() est ce qui peut encore refuser (mises fermees, deja en table) :
    // on l'appelle AVANT de toucher au solde, pour n'avoir rien a annuler.
    const r = this.crash.parier(addr, mise, autoRaw, now || Date.now());

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise));
    p.dropsToday++; this._markWager(p, WEI(mise), 'crash');
    return { manche: r.manche, mise, auto: r.auto, balance: this.balanceStr(addr) };
  }

  /** Encaisser a la main. Le multiplicateur vient de l'horloge du serveur. */
  crashRetrait(addr, now) {
    const ev = this.crash.retirer(addr, now || Date.now());
    this._crediteRetrait(ev);
    return ev;
  }

  /** Le credit d'un encaissement, manuel ou automatique — un seul chemin. */
  _crediteRetrait(ev) {
    const p = this._p(ev.addr);
    if (ev.payout > 0) {
      p.balance = p.balance.add(WEI(ev.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(ev.payout));
      if (ev.net > 0) p.winsToday++;
    }
    this._manche(p, 'crash', ev.mise, ev.payout);
    ev.balance = this.balanceStr(ev.addr);
    return ev;
  }

  /**
   * Fait avancer la manche. Renvoie les evenements a diffuser tels quels ;
   * les soldes, eux, sont deja a jour quand la fonction rend la main.
   */
  crashTick(now) {
    const evs = this.crash.tick(now || Date.now());
    for (const ev of evs) {
      if (ev.type === 'crashDepart') ev.joueurs = this._crashNoms(ev.joueurs);
      else if (ev.type === 'crashRetrait') this._crediteRetrait(ev);
      else if (ev.type === 'crashFin') {
        // Les perdants ont ete debites a la mise : il ne reste qu'a inscrire la
        // manche a leur compteur, pour que la comptabilite par jeu soit juste.
        // La table garde les paris jusqu'a l'ouverture de la manche suivante :
        // la mise perdue est donc encore lisible ici, et nulle part apres.
        for (const addr of ev.perdants) {
          const pari = this.crash.pari(addr);
          this._manche(this._p(addr), 'crash', pari ? pari.mise : 0, 0);
        }
      }
    }
    return evs;
  }


  // ------------------------------------------------------------ LA BOUTIQUE
  /*
   * Un coffre s'achete avec le solde de jeu, comme une mise, et rend un objet
   * au lieu de jetons.
   *
   * ---- ce que ce n'est PAS, et pourquoi ca compte ----
   *
   * Un achat de coffre n'est PAS une manche. Il ne passe donc ni par
   * `_manche`, ni par `_markWager`, et il n'avance aucune quete du jour.
   *
   * Deux raisons, et la seconde suffirait :
   *
   *   • le journal et l'audit calculent un retour par jeu — mise contre
   *     rendu. Un coffre ne rend jamais de jetons : le compter comme une mise
   *     ferait apparaitre un jeu a 0 % de retour au milieu des autres, et
   *     fausserait le retour global du site, qui est publie ;
   *   • les quetes du jour paient en jetons. Si acheter un coffre les faisait
   *     avancer, on pourrait les remplir sans jamais jouer — et une quete qui
   *     s'achete ne recompense plus rien.
   *
   * L'argent, lui, est bien compte : `note('boutique', ...)` le porte au mois,
   * du cote de la maison.
   */

  /**
   * LA COURSE AUX TROIS PREMIERES LIGNES.
   *
   * Appelee apres chaque objet range. Rend l'entree du gagnant si ce fruit
   * vient de completer une famille et qu'il reste une place, sinon null.
   *
   * Le controle « ce joueur a-t-il deja gagne » porte sur l'ADRESSE et pas
   * sur la famille : celui qui complete trois familles ne doit pas rafler
   * les trois places, sinon la course n'oppose personne.
   */
  _boutiqueLigne(p, item, now) {
    if (!this.boutiqueLignes) this.boutiqueLignes = [];
    /* ---- CETTE COURSE EST CELLE DE LA SAISON 1 ----
     *
     * Le controle est explicite plutot que deduit. Aujourd'hui il ne change
     * rien : la saison 2 n'ouvre a personne avant que les trois lignes de la
     * saison 1 soient tombees, et les trois gagnants sont deja bloques par la
     * regle d'adresse — aucune ligne d'armes ne peut donc atteindre un prix.
     * Mais « ca ne peut pas arriver » est une propriete de l'enchainement
     * actuel, pas une regle ecrite, et la premiere personne qui touchera a la
     * porte la cassera sans le voir.
     *
     * Quand la saison 2 aura sa propre course, elle aura sa propre liste et
     * ses propres montants. Elle ne se greffe pas sur celle-ci : les trois
     * places de la saison 1 appartiennent a la saison 1, definitivement. */
    if (boutique.famille(item.famille).saison !== 1) return null;
    if (this.boutiqueLignes.length >= boutique.PRIX_LIGNE.length) return null;
    if (this.boutiqueLignes.some((g) => g.addr === p.addr)) return null;

    const inv = p.objets || {};
    const manque = boutique.ITEMS.some(
      (o) => o.famille === item.famille && !inv[o.id]);
    if (manque) return null;

    const rang = this.boutiqueLignes.length;          // 0, 1 ou 2
    const prix = boutique.PRIX_LIGNE[rang];
    p.balance = p.balance.add(WEI(prix));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(prix));
    const fam = boutique.famille(item.famille);
    const g = { addr: p.addr, nom: p.name || p.addr.slice(0, 6),
                famille: item.famille, familleNom: fam ? fam.nom : item.famille,
                rang: rang + 1, prix, t: now || Date.now() };
    this.boutiqueLignes.push(g);
    /* Journalise comme un gain, parce que c'en est un : un coffre pouvait
       jusqu'ici ne jamais rendre de jetons, ce n'est plus vrai. */
    journal.ajoute(p.addr, { k: 'r', g: 'boutique', m: 0, p: prix });
    this.note('primes', prix, p.addr);
    return g;
  }

  /**
   * LE CLASSEMENT DES COLLECTIONNEURS.
   *
   * ---- ce qu'on classe, et pourquoi pas autre chose ----
   *
   * Le rang se joue sur le nombre de fruits DIFFERENTS, pas sur la quantite
   * totale. Compter les doublons ferait gagner celui qui ouvre le plus de
   * coffres de bois, alors que la collection se termine en trouvant ce qu'on
   * n'a pas — et c'est ce que la planche montre depuis le debut.
   *
   * A egalite, on departage par la RARETE : un joueur a douze fruits dont un
   * mythique passe devant un joueur a douze communs. Le poids d'une rarete
   * est l'inverse de son plafond — dix mythiques contre mille communs, donc
   * un mythique vaut cent communs. Le bareme n'est pas invente : il sort des
   * plafonds, et il se recalculera tout seul si on les change.
   *
   * ---- le cout ----
   *
   * Une passe sur les fiches, comme le panneau d'administration. La
   * difference est qu'ici tout le monde peut demander — on renvoie donc
   * seulement le haut du classement et la ligne du demandeur, jamais la
   * liste entiere.
   */
  boutiqueClassement(addr, limite, saison) {
    /* La COLLECTION, donc ce qui se collectionne : les pieces vendues. Les
       trouvailles ne s'achetent pas, ne s'echangent pas contre du $SWOGE et
       n'ont pas de plafond d'edition — les compter dans « 7 sur 30 »
       changerait le denominateur sous les yeux des joueurs sans qu'aucun
       coffre ne permette jamais de le remplir. */
    const objets = boutique.itemsDeSaison(saison || 1).filter((o) => !o.drop);
    const poids = {};
    for (const r of boutique.RARETES) poids[r.cle] = 1000 / r.plafond;
    const rangRarete = {};
    boutique.RARETES.forEach((r, i) => { rangRarete[r.cle] = i; });

    const l = [];
    for (const [a, p] of this.players) {
      const inv = p.objets;
      if (!inv) continue;
      let sortes = 0, score = 0, meilleure = -1, familles = {};
      for (const o of objets) {
        if (!inv[o.id]) continue;
        sortes++;
        score += poids[o.rarete] || 0;
        if (rangRarete[o.rarete] > meilleure) meilleure = rangRarete[o.rarete];
        familles[o.famille] = (familles[o.famille] || 0) + 1;
      }
      if (!sortes) continue;
      /* Les familles COMPLETES, parce que c'est ce que la course recompense
         et que le classement doit parler de la meme chose que la course. */
      let pleines = 0;
      for (const k of Object.keys(familles)) if (familles[k] === boutique.rangsDeFamille(k)) pleines++;
      /* CE QU'IL POSSEDE, en trente caracteres.
         La page dessine la rangee de fruits en allumant ceux qu'il a : il lui
         faut donc la liste, pas seulement le compte. Une chaine de 0 et de 1
         dans l'ordre du catalogue tient en trente octets par joueur — envoyer
         un tableau d'identifiants en couterait cinq fois plus pour dire la
         meme chose, et il faudrait le croiser cote page. */
      const avoir = objets.map((o) => (inv[o.id] ? '1' : '0')).join('');
      l.push({ addr: a, nom: p.name || a.slice(0, 6), sortes, score: Math.round(score),
               pleines, avoir,
               meilleure: meilleure >= 0 ? boutique.RARETES[meilleure].cle : null });
    }
    l.sort((x, y) => (y.sortes - x.sortes) || (y.score - x.score) || (y.pleines - x.pleines));
    l.forEach((x, i) => { x.rang = i + 1; });

    const moi = addr ? l.find((x) => x.addr === String(addr).toLowerCase()) : null;
    const n = Math.max(1, Math.min(50, Number(limite) || 10));
    return {
      total: l.length,
      top: l.slice(0, n).map((x) => ({ rang: x.rang, nom: x.nom, sortes: x.sortes,
                                       pleines: x.pleines, meilleure: x.meilleure,
                                       avoir: x.avoir })),
      /* Sa ligne part TOUJOURS, meme s'il est deja dans le haut : la page
         choisit de la repeter ou non, le serveur ne devine pas. */
      moi: moi ? { rang: moi.rang, sortes: moi.sortes, pleines: moi.pleines,
                   meilleure: moi.meilleure, avoir: moi.avoir } : null,
      sur: objets.length,
    };
  }

  /**
   * ================== LES QUATRE SAISONS SONT OUVERTES ==================
   *
   * Il y avait ici une porte : la saison N n'ouvrait qu'une fois la course de
   * la saison N-1 terminee (ses trois lignes completes), les trois gagnants y
   * entrant en avance. Elle est levee — les quatre saisons sont ouvertes a
   * tout le monde, tout le temps.
   *
   * ---- pourquoi ----
   *
   * Le personnage porte QUATRE emplacements : fruit, arme, armure, bague, un
   * par saison. Tant que les saisons 3 et 4 restaient fermees, deux de ces
   * quatre cases etaient inatteignables pour tout le monde sauf trois
   * joueurs — on montrait a chacun une fiche de personnage a moitie
   * verrouillee, et personne ne pouvait s'equiper vraiment. La porte coutait
   * plus qu'elle ne rapportait.
   *
   * La COURSE, elle, continue : elle donne des prix et un classement
   * (`boutiqueLignes`, `PRIX_LIGNE`). Elle ne commande simplement plus
   * l'acces aux saisons — c'est une competition, plus un verrou.
   *
   * ---- pourquoi la fonction reste ----
   *
   * Ses trois appelants — la lecture d'une collection, l'ouverture d'un
   * coffre, la liste des saisons — la consultent toujours. Les garder cote
   * SERVEUR, la ou l'on debite, est ce qui fait qu'une porte est une porte :
   * la page ne peut que cacher un bouton, et un message se refabrique a la
   * main. Refermer une saison un jour redevient donc une seule ligne, ici,
   * sans avoir a retrouver les trois endroits qui debitent.
   */
  boutiqueSaisonOuverte(addr, n) {
    return true;
  }

  /**
   * L'etat de chaque saison POUR CE JOUEUR : ouverte ou non, et pourquoi.
   *
   * Le « pourquoi » compte autant que le verrou. Une saison grisee sans
   * explication se lit comme une panne ; la meme saison avec « 2 lignes sur 3
   * — la saison 2 ouvre a la troisieme » se lit comme une raison de jouer, et
   * c'est exactement ce qu'on veut qu'elle soit.
   */
  boutiqueSaisons(addr) {
    const l = this.boutiqueLignes || [];
    const total = boutique.PRIX_LIGNE.length;
    const a = String(addr || '').toLowerCase();
    const gagnant = l.find((g) => String(g.addr || '').toLowerCase() === a);
    return boutique.SAISONS.map((s) => {
      const ouverte = this.boutiqueSaisonOuverte(addr, s.n);
      return {
        n: s.n, nom: s.nom, sujet: s.sujet, ouverte,
        /* `avance` disait « tu es entre en avance, rang #1 » a un gagnant de
           la course pendant que la saison restait fermee aux autres. Plus
           aucune ne l'est : entrer « en avance » quelque part ou tout le
           monde est deja entre ne veut plus rien dire, et l'afficher serait
           une distinction inventee. Le rang, lui, reste — il dit la place
           dans la course, qui existe toujours. */
        avance: false,
        rang: gagnant ? gagnant.rang : null,
        faites: l.length, sur: total,
      };
    });
  }

  /** Les places restantes et les gagnants, pour la page et l'annonce. */
  boutiqueCourse() {
    const gagnants = this.boutiqueLignes || [];
    return {
      prix: boutique.PRIX_LIGNE,
      gagnants: gagnants.map((g) => ({ nom: g.nom, familleNom: g.familleNom,
                                       rang: g.rang, prix: g.prix, t: g.t })),
      restant: Math.max(0, boutique.PRIX_LIGNE.length - gagnants.length),
    };
  }

  /**
   * L'ETAT DE LA BOUTIQUE POUR L'EXPLOITANT.
   *
   * Deux questions, et elles n'ont pas la meme reponse :
   *
   *   • COMBIEN IL RESTE — ca se lit dans le registre global, et c'est ce qui
   *     dit si l'edition approche de sa fin ;
   *   • QUI A QUOI — ca demande de parcourir les fiches. Le registre sait
   *     combien de Void Fruits sont sortis, il ne sait pas chez qui.
   *
   * ---- pourquoi on parcourt tout, et pourquoi ce n'est pas grave ----
   *
   * Il n'existe pas d'index inverse objet -> joueurs, et on n'en construit pas
   * un : il faudrait le tenir a jour a chaque achat, donc un deuxieme endroit
   * qui peut se desynchroniser du premier. Le parcours coute une passe sur les
   * fiches, sur une page d'administration qu'une personne ouvre de temps en
   * temps. Le mauvais echange serait l'inverse.
   *
   * Les detenteurs sont TRIES par quantite : sur un mythique a dix
   * exemplaires, savoir que quelqu'un en detient quatre est l'information qui
   * compte.
   */
  boutiqueAdmin() {
    const emis = this.boutiqueEmis || {};
    /* Une seule passe sur les fiches, pour tous les objets a la fois. */
    const parObjet = new Map();
    for (const [addr, p] of this.players) {
      const inv = p.objets;
      if (!inv) continue;
      for (const id of Object.keys(inv)) {
        const q = inv[id];
        if (!(q > 0)) continue;
        if (!parObjet.has(id)) parObjet.set(id, []);
        parObjet.get(id).push({ addr, nom: p.name || addr.slice(0, 6), q });
      }
    }
    const items = boutique.ITEMS.map((o) => {
      const det = (parObjet.get(String(o.id)) || []).sort((a, b) => b.q - a.q);
      const plafond = boutique.rarete(o.rarete).plafond;
      const sorti = emis[o.id] || 0;
      return {
        id: o.id, nom: o.nom, cle: o.cle, rarete: o.rarete, famille: o.famille,
        saison: o.saison,
        plafond, emis: sorti, reste: Math.max(0, plafond - sorti),
        /* La somme des inventaires DOIT egaler le registre. Si elle ne
           l'egale pas, l'un des deux ment et la page doit le montrer plutot
           que de choisir lequel croire. */
        detenu: det.reduce((a, d) => a + d.q, 0),
        porteurs: det.length,
        detenteurs: det.slice(0, 12),
      };
    });
    const parRarete = boutique.RARETES.map((r) => {
      const l = items.filter((o) => o.rarete === r.cle);
      return { cle: r.cle, nom: r.nom, couleur: r.couleur, plafond: r.plafond,
               emis: l.reduce((a, o) => a + o.emis, 0),
               total: r.plafond * l.length };
    });
    /* Le detail PAR SAISON. Sans lui, « 412 sur 19 200 » melangeait une
       edition ouverte depuis des mois et une qui n'a pas commence, et le
       chiffre qui compte — « ou en est la saison en cours » — n'etait affiche
       nulle part. */
    const parSaison = boutique.SAISONS.map((s) => {
      const l = items.filter((o) => o.saison === s.n);
      return { n: s.n, nom: s.nom,
               emis: l.reduce((a, o) => a + o.emis, 0),
               edition: l.reduce((a, o) => a + o.plafond, 0),
               porteurs: new Set(l.flatMap((o) => o.detenteurs.map((d) => d.addr))).size };
    });
    return {
      items, parRarete, parSaison,
      lignes: (this.boutiqueLignes || []).map((g) => ({ nom: g.nom, rang: g.rang,
                                                        familleNom: g.familleNom, prix: g.prix, t: g.t })),
      familles: boutique.FAMILLES.map((f) => ({ cle: f.cle, nom: f.nom, couleur: f.couleur, saison: f.saison })),
      edition: boutique.ITEMS.reduce((a, o) => a + boutique.rarete(o.rarete).plafond, 0),
      sortis: Object.values(emis).reduce((a, b) => a + b, 0),
    };
  }

  /* ======================================================================
   * LES SKINS DE PERSONNAGE
   * ======================================================================
   *
   * ---- rien a voir avec les saisons ----
   *
   * La boutique tire au hasard dans une edition fermee. Un skin, lui, s'achete
   * DIRECTEMENT, a prix fixe, et reste disponible en permanence — il n'ouvre
   * ni ne ferme jamais. `p.skins` est donc un registre a part, distinct de
   * `p.objets` : mélanger les deux aurait fait apparaitre un skin dans la
   * collection de fruits, ou compter pour l'edition d'une saison a laquelle il
   * n'appartient pas.
   *
   * ---- ce qui est code, et ce qui ne l'est pas ----
   *
   * Acheter, et porter celui qu'on a achete. C'est tout. Pas d'emplacement
   * pour un fruit de pouvoir, une arme, une armure ou une bague — ces
   * emplacements n'existent nulle part ailleurs sur le site non plus, et les
   * poser ici sans rien pour les remplir promettrait un jeu qui n'est pas
   * construit. Le jour ou il l'est, `p.skins[id]` est deja la pour porter ces
   * emplacements sans rien migrer.
   */
  skinsEtat(addr) {
    const p = this._p(addr);
    return {
      catalogue: skins.catalogue().map((s) => ({
        ...s, possede: this.possedeSkin(p, s.id),
        /* Ce qu'il RESTE, pas ce qui est parti : « 7 left » se lit sans
           soustraction, « 43 sold » demande de connaitre le total. Zero sur un
           skin sans edition ; la page ne l'affiche que s'il y a une edition. */
        emis: (this.skinsEmis || {})[s.id] | 0,
        reste: s.edition ? Math.max(0, s.edition - ((this.skinsEmis || {})[s.id] | 0)) : 0,
      })),
      /* Le skin PORTE, pas le champ brut : un compte qui n'a rien choisi porte
         celui qu'on offre, sinon la page montre « aucun personnage » a
         quelqu'un qui en a un. */
      actif: this.skinActifDe(p),
      /* L'or du compte voyage AVEC le catalogue : le tiroir ne connait que le
         solde en jetons, et n'a aucun autre moyen d'ecrire « vous avez tant
         d'or » sous un prix affiche en or. Il l'AFFICHE seulement — le refus
         reste ici, parce que ce chiffre-la date de la derniere reponse et que
         l'or monte a chaque monstre tue. */
      or: Math.floor(p.fame || 0),
    };
  }

  acheteSkin(addr, id) {
    const p = this._p(addr);
    const s = skins.skin(id);
    if (!s) throw new Error('unknown skin');
    p.skins = p.skins || {};
    /* ---- CELUI QU'ON DONNE SE « PREND » AUSSI ----
     * Un joueur qui touche Andy dans la boutique ne doit pas recevoir un refus
     * pour un personnage gratuit. On note qu'il l'a pris — c'est un geste
     * deliberé, contrairement au simple fait de charger la page — et on le lui
     * met sur le dos. Rien n'est debite : il ne coute rien.
     * Ecrire ici et pas dans `_p` est TOUTE la difference : un visiteur qui
     * passe reste une fiche vide, qui ne part pas au disque. */
    if (skins.OFFERT.has(id)) {
      p.skins = p.skins || {};
      const avait = !!p.skins[id];
      p.skins[id] = true;
      p.skinActif = id;
      return { id, prix: 0, offert: true, deja: avait,
               actif: this.skinActifDe(p), balance: this.balanceStr(addr) };
    }
    if (this.possedeSkin(p, id)) throw new Error('you already own this skin');
    /* ---- L'EDITION LIMITEE ----
     *
     * On compte les exemplaires DEJA VENDUS avant de toucher au solde. Une
     * edition qui deborderait d'un seul exemplaire n'est plus une edition, et
     * c'est le genre de promesse dont on ne se releve pas quand elle est
     * payee en jetons reels.
     *
     * Le registre vit ICI et non dans skins.js : ce fichier-la est pur, il
     * dit combien il en EXISTE, pas combien il en reste. Deux endroits qui
     * compteraient les memes exemplaires finiraient par n'en pas compter le
     * meme nombre.
     */
    const edition = skins.editionDe(id);
    if (edition > 0) {
      this.skinsEmis = this.skinsEmis || {};
      const emis = this.skinsEmis[id] | 0;
      if (emis >= edition) {
        throw new Error('this edition is sold out — ' + edition + ' of ' + edition + ' claimed');
      }
    }
    const prix = skins.prixDe(id);
    /* ---- DEUX MONNAIES, ET SURTOUT PAS DEUX UNITES DU MEME COMPTE ----
     *
     * L'or se ramasse en jouant et ne sort jamais du jeu ; le $SWOGE se
     * depose et se retire. Un skin paye en or ne doit donc toucher NI le
     * solde, NI le net du jour, NI le chiffre d'affaires de la boutique :
     * ces trois-la comptent de l'argent reel, et y verser un nombre qui n'est
     * jamais entre en caisse gonfle un chiffre sur lequel on decide ensuite
     * pour de vrai.
     *
     * Le refus le DIT dans la bonne unite. « not enough $SWOGE » devant un
     * bouton marque GOLD envoie le joueur deposer des jetons pour un achat
     * qui n'en demande pas.
     */
    const monnaie = skins.monnaieDe(id);
    if (monnaie === 'or') {
      const or = p.fame || 0;
      if (or < prix) {
        throw new Error(`not enough gold — this skin costs ${prix.toLocaleString('en-US')}, you have ${Math.floor(or).toLocaleString('en-US')}`);
      }
      p.fame = or - prix;
    } else {
      const w = WEI(prix);
      if (p.balance.lt(w)) throw new Error(`not enough $SWOGE — this skin costs ${prix.toLocaleString('en-US')}`);
      p.balance = p.balance.sub(w);
      this._bumpDay(p); p.dayNet = p.dayNet.sub(w);
    }
    p.skins[id] = true;
    /* Le compteur monte APRES le debit et l'attribution, d'un seul tenant :
       rien ne peut s'intercaler entre les trois, et une exception plus haut
       n'aura pas consomme un exemplaire pour rien. */
    if (edition > 0) {
      this.skinsEmis = this.skinsEmis || {};
      this.skinsEmis[id] = (this.skinsEmis[id] | 0) + 1;
    }
    /* Le skin qu'on vient d'acheter devient celui qu'on porte : sans ce
       geste, payer ne changerait rien a l'ecran, et l'achat semblerait n'avoir
       servi a rien tant qu'on n'a pas trouve un second endroit pour l'activer.
       Un second geste pourra toujours re-choisir parmi ceux deja possedes. */
    p.skinActif = id;
    /* `note('boutique')` est le chiffre d'affaires en jetons : un achat en or
       n'y entre pas. Le journal, lui, garde la ligne dans les deux cas — un
       joueur doit retrouver ce qu'il a paye — mais il porte l'unite avec, sinon
       la page relit vingt mille et affiche « $SWOGE ». */
    if (monnaie !== 'or') this.note('boutique', prix, String(addr).toLowerCase());
    journal.ajoute(String(addr).toLowerCase(),
                   { k: 'sk', id, m: String(prix), mo: monnaie === 'or' ? 'or' : undefined });
    return { id, prix, monnaie, or: p.fame || 0,
             actif: this.skinActifDe(p), balance: this.balanceStr(addr) };
  }

  choisitSkin(addr, id) {
    const p = this._p(addr);
    if (!this.possedeSkin(p, id)) throw new Error('you do not own this skin');
    p.skinActif = id;
    return { actif: id };
  }

  /* ======================================================================
   * LE PERSONNAGE — niveau, xp, equipement, UN SKIN A LA FOIS
   * ======================================================================
   *
   * Rien ici ne touche a un vrai combat. Ces stats existent pour etre lues,
   * pas pour changer l'issue d'une manche : voir personnages.js.
   */
  _persoDe(p, id) {
    return (p.persos && p.persos[id]) || { w: BN(0), ef: null, ea: null, ar: null, ba: null, xc: 0, sup: {} };
  }

  /** Le volume mise d'un personnage, en unites lisibles. Volume -> XP -> Fame
      est une chaine que DEUX endroits parcourent : la fiche qui l'affiche, et
      la mort qui la verse. L'ecrire deux fois, c'est se garantir qu'un jour
      le chiffre montre au joueur ne sera plus celui qu'on lui donne. */
  _volumeDe(c) {
    return Number(ethers.utils.formatUnits((c && c.w) || BN(0), cfg.DECIMALS));
  }
  /**
   * L'XP TOTALE d'un personnage : celle que le volume mise lui donne, PLUS
   * celle qu'il est alle chercher en tuant des monstres.
   *
   * Une seule fonction pour les deux termes, et tout ce qui parle d'XP passe
   * par elle. Le niveau affiche, la fame gagnee a la mort et la barre de
   * progression lisaient auparavant `xpDuVolume` chacun de leur cote : y
   * ajouter le combat a trois endroits aurait suffi a en oublier un, et le
   * joueur aurait vu son niveau monter sans que sa fame suive.
   *
   * Le volume ne se stocke pas — il se derive de `c.w`. Le combat, si :
   * personne ne peut le recalculer apres coup.
   */
  _xpDe(c) {
    return personnages.xpDuVolume(this._volumeDe(c)) + Math.max(0, Number(c && c.xc) || 0);
  }
  _fameDe(c) {
    return personnages.fameDeXp(this._xpDe(c));
  }

  /**
   * LE SEUL ENDROIT QUI DONNE DE L'XP DE COMBAT.
   *
   * Comme `_gagneXp` pour le compte : un point d'entree unique plutot qu'un
   * `c.xc +=` disperse. C'est appele par la boucle du monde, jamais par un
   * message du client — le navigateur ne dit pas ce qu'il a tue, il demande
   * seulement a tirer, et le serveur constate.
   */
  gagneXpCombat(addr, skinId, xp) {
    const n = Math.max(0, Math.floor(Number(xp) || 0));
    if (!n) return null;
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) return null;
    p.persos = p.persos || {};
    const c = p.persos[skinId] || (p.persos[skinId] = { w: BN(0), ef: null, ea: null, ar: null, ba: null, xc: 0, sup: {} });
    const avant = personnages.niveauDeXp(this._xpDe(c));
    c.xc = Math.max(0, Number(c.xc) || 0) + n;
    const apres = personnages.niveauDeXp(this._xpDe(c));
    return { xp: n, total: Math.round(this._xpDe(c)), niveau: apres,
             monte: apres > avant ? apres : 0 };
  }

  /**
   * L'etat complet d'UN skin, pret a peindre : son niveau, son XP, ses huit
   * stats (base + equipement), et ce qui est actuellement equipe.
   *
   * `null` si le skin n'est pas possede — un personnage qu'on ne possede pas
   * n'a pas de fiche a montrer, pas une fiche vide.
   */
  personnageEtat(addr, skinId) {
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) return null;
    const base = personnages.BASE[skinId];
    if (!base) return null;
    const c = this._persoDe(p, skinId);
    const volume = this._volumeDe(c);
    const xp = this._xpDe(c);
    const niveau = personnages.niveauDeXp(xp);
    const xpNiveau = personnages.xpPour(niveau);
    const xpProchain = niveau >= personnages.NIVEAU_MAX ? null : personnages.xpPour(niveau + 1);

    /* Ce qu'un objet equipe apporte : un PROFIL, plusieurs stats a la fois.
       `bonus` est donc un objet {stat: valeur}, pas un chiffre — une hache
       ne donne que de l'attaque, un casque en donne trois. `stat` reste la
       stat principale, pour les endroits ou la place manque.
       Un objet qui n'existe plus ne casse pas la fiche, il ne donne rien. */
    const bonusDe = (itemId) => {
      const o = itemId ? boutique.item(itemId) : null;
      if (!o) return null;
      const bonus = personnages.bonusesDeObjet(o);
      /* Une ARME rend {} depuis qu'elle ne donne plus de stats : rendre null
         ici viderait la case d'arme de la fiche alors qu'elle porte une
         epee. Ce qui compte pour une arme, ce sont ses degats — ils partent
         quelques lignes plus bas. On ne renonce donc que sur un objet qui
         n'apporte NI stat NI degats, c'est-a-dire rien du tout. */
      const degats = personnages.degatsDeObjet(o);
      if (!Object.keys(bonus).length && !degats) return null;
      /* La couleur suit ici : la page dessine la case d'equipement dans la
         MEME couleur que la carte du catalogue, sans avoir a recharger le
         catalogue juste pour ca. */
      const r = boutique.rarete(o.rarete);
      /* La FAMILLE part avec la ligne : c'est elle qui decide de la portee,
         du nombre de tirs et du dessin du projectile. La page la deduisait
         de la cle (`arme_ebreche`), ce qui rendait « arme » au lieu de
         « lame » — un champ qui existe deja ne se redevine pas. */
      /* ---- « OG » : LA PIECE EST NUMEROTEE ----
       * Les pieces de la BOUTIQUE existent en nombre fini et se paient en
       * $SWOGE : quarante legendaires pour toute une saison, quatre reliques.
       * Celles qui tombent dans le monde ne coutent rien.
       * Rien ne les distinguait a l'oeil, et c'est la seule chose qu'un joueur
       * a besoin de savoir avant de risquer une piece dans la lave. Le drapeau
       * part d'ICI : la page ne peut pas le deviner, les deux familles
       * partagent les memes saisons et les memes raretes — seul le catalogue
       * sait laquelle se vend.
       */
      const ligne = { item: o.id, nom: o.nom, cle: o.cle, rarete: o.rarete,
                      famille: o.famille, og: !o.drop,
                      couleur: r ? r.couleur : '#8DA0C4',
                      stat: personnages.FAMILLE_STAT[o.famille] || null, bonus };
      /* Le fruit PORTE est celui dont on a le plus besoin de connaitre le
         pouvoir : c'est celui que la barre d'espace va lancer. */
      const sort = Game.sortDuFruit(o);
      if (sort) ligne.sort = sort;
      /* Le PASSIF d'une armure ou d'une bague. Il ne se declenche pas, donc
         rien ne le montrerait a l'usage : sa fiche est le seul endroit ou le
         joueur peut apprendre qu'il l'a. */
      const passif = Game.passifDe(o);
      if (passif) ligne.passif = passif;
      /* Les degats ne concernent que les armes : les poser sur une bague
         laisserait croire qu'elle frappe. */
      if (degats) ligne.degats = degats.slice();
      return ligne;
    };
    const bFruit = bonusDe(c.ef);
    const bArme = bonusDe(c.ea);
    const bArmure = bonusDe(c.ar);
    const bBague = bonusDe(c.ba);

    const stats = {};
    const portes = [bFruit, bArme, bArmure, bBague].filter(Boolean);
    /* ---- LES POTIONS BUES, ET CE QU'ELLES AJOUTENT ----
     * Elles s'ajoutent au meme endroit que l'equipement, c'est-a-dire
     * AU-DESSUS du plafond de niveau. La difference est qu'elles ne se
     * retirent pas : l'equipement est un pret, la potion est un acquis — un
     * acquis qui meurt avec le personnage. */
    const bues = c.sup || {};
    personnages.STATS.forEach((s) => {
      let v = personnages.statAuNiveau(base[s], niveau);
      v += personnages.supDe(s, bues[s], base[s]);
      /* On additionne ce que CHAQUE piece donne sur CETTE stat. Le test
         precedent ne regardait que la stat principale : avec des profils a
         plusieurs stats, tout le reste du bonus aurait ete perdu en
         silence — l'objet aurait promis trois lignes et n'en aurait rendu
         qu'une. */
      for (const p of portes) v += (p.bonus[s] || 0);
      stats[s] = v;
    });

    return {
      skin: skinId, niveau, xp: Math.round(xp),
      xpNiveau: Math.round(xpNiveau),
      xpProchain: xpProchain === null ? null : Math.round(xpProchain),
      volume: Math.round(volume),
      stats, base,
      /* Ce qui a ete bu part avec la fiche : sans ce compte, la page ne
         pourrait pas ecrire « 12 / 20 », et le joueur boirait a l'aveugle
         jusqu'a ce que la potion cesse silencieusement de faire effet. */
      sup: personnages.STATS.reduce((o, s) => {
        const mx = personnages.supMaxDe(s, base[s]);
        const k = Math.max(0, Math.min(mx, (c.sup || {})[s] | 0));
        /* Le plafond part TOUJOURS, meme a zero potion : la page doit pouvoir
           ecrire « 0 / 6 » sur la defense et « 0 / 20 » sur la vie. Sans ca
           elle afficherait le meme vingt partout et le joueur decouvrirait la
           vraie borne en se faisant refuser une potion. */
        o[s] = { potions: k, max: mx, bonus: personnages.supDe(s, k, base[s]) };
        return o;
      }, {}),
      /* ---- LE PLAFOND PERMANENT DE CHAQUE STAT ----
       *
       * Ce qu'on peut atteindre POUR TOUJOURS : le niveau vingt, plus toutes
       * les potions que cette stat accepte. L'equipement n'y entre pas, et ce
       * n'est pas un oubli — il se prete, il se perd a la mort, et une piece
       * qui pousse au-dessus du plafond ne « maxe » rien du tout. Le compter
       * ferait dire « c'est plein » a un joueur qui perdrait tout en changeant
       * de casque.
       *
       * Il part d'ICI plutot que d'etre recalcule par la page. La page a deja
       * `base` et la table des potions : elle POURRAIT le refaire. Mais ce
       * serait la meme formule ecrite a deux endroits, et le jour ou la courbe
       * des niveaux change, l'un des deux dirait encore l'ancien plafond — le
       * joueur verrait « il te manque 3 » sur une stat deja pleine, et n'aurait
       * aucun moyen de savoir lequel des deux chiffres ment.
       *
       * `atteint` est la part PERMANENTE deja acquise : niveau plus potions
       * bues, sans l'equipement. C'est elle qu'il faut comparer au plafond —
       * comparer le total avec equipement ferait passer une stat pour pleine
       * des qu'on porte une bague.
       */
      plafond: this._plafondsDe(skinId, c),
      /* Le meme « 3/8 » que le classement affiche a cote du nom. Il part d'ici
         plutot que d'etre recompte par la page : c'est le serveur qui sait ce
         qu'est une stat pleine. */
      pleines: this._statsPleines(skinId, c),
      equipFruit: bFruit, equipArme: bArme, equipArmure: bArmure, equipBague: bBague,
      /* La Fame que ce personnage a accumulee — elle ne compte pour rien tant
         qu'il vit. `fameCompte` est celle qui est deja acquise, versee par les
         morts precedentes : les deux ensemble disent « ce que tu as » et « ce
         que tu risques ». */
      fame: this._fameDe(c),
      fameCompte: p.fame || 0,
    };
  }

  /**
   * Equipe (ou retire, si `itemId` est vide) un fruit, une arme, une armure
   * ou une bague sur un skin. `genre` vaut 'fruit', 'arme', 'armure' ou
   * 'bague' — quatre methodes separees auraient duplique cette meme suite de
   * verifications quatre fois.
   */
  /* ======================================================================
   * PORTER N'EST PAS POSSEDER — ET LE REGISTRE DOIT SUIVRE
   * ======================================================================
   *
   * `p.objets` est le STOCK. Les quatre champs d'un personnage ne sont que des
   * DESIGNATIONS : porter, c'est etre pointe par quelqu'un qui peut mourir
   * (voir `meurt`). Rien ne relie les deux tout seul, et c'est ce qui manquait.
   *
   * Sans lien, un exemplaire unique habillait les six personnages a la fois, et
   * les trois sorties du coffre qui RAPPORTENT DE L'ARGENT — la vente au
   * marche, le rachat instantane — le laissaient partir sans le retirer du dos
   * de personne. Le joueur encaissait et gardait la piece ; sur le rachat,
   * c'est la maison qui payait.
   */

  /** Combien d'exemplaires de `id` sont sur le dos de quelqu'un, tous
      personnages confondus. On compte les CASES occupees, pas les personnages :
      une regle qui suppose qu'un meme objet ne peut pas tenir deux cases se
      trompera le jour ou une famille en tiendra deux. */
  _portes(p, id) {
    const persos = (p && p.persos) || {};
    let n = 0;
    for (const k of Object.keys(persos)) {
      const c = persos[k];
      if (!c) continue;
      if (c.ef === id) n++;
      if (c.ea === id) n++;
      if (c.ar === id) n++;
      if (c.ba === id) n++;
    }
    return n;
  }

  /** Ce qu'on possede MOINS ce qui est deja porte : les exemplaires dont on
      peut reellement disposer. C'est ce chiffre-la, et jamais `p.objets`, que
      doit regarder tout ce qui fait SORTIR une piece du coffre. */
  _libres(p, id) {
    return Math.max(0, ((p.objets || {})[id] || 0) - this._portes(p, id));
  }

  /** Le refus commun aux sorties du coffre, ou `null` si la piece peut partir.
      Un seul texte pour une seule regle : trois formulations differentes
      obligeraient le joueur a comprendre trois fois qu'il doit d'abord la
      retirer. */
  _refusPorte(p, id, qte) {
    /* ---- CE REFUS-CI NE PARLE QUE DE CE QUI EST PORTE ----
     * Un joueur qui ne possede RIEN a zero exemplaire libre, mais son probleme
     * n'est pas qu'il porte quelque chose : c'est qu'il n'a rien. Lui repondre
     * « retire-la d'abord » l'enverrait chercher une piece qui n'existe pas.
     * Le refus de possession appartient a l'appelant, qui a le sien. */
    if (!this._portes(p, id)) return null;
    const libres = this._libres(p, id);
    if (libres >= qte) return null;
    const total = (p.objets || {})[id] || 0;
    return libres === 0
      ? 'That one is being worn — take it off first'
      : `only ${libres} of your ${total} are free — the others are being worn`;
  }

  /**
   * REMET D'ACCORD CE QUI EST PORTE ET CE QUI EST POSSEDE.
   *
   * Les gardes ci-dessus empechent d'arriver dans cet etat a partir de
   * maintenant. Elles ne defont pas les fiches DEJA ECRITES sur le disque : une
   * garde qui ne regarde que l'avenir laisserait un compte deja en faute le
   * rester pour toujours, avec six personnages habilles par un exemplaire.
   *
   * ---- QUI GARDE LA PIECE ----
   *
   * LE PERSONNAGE QU'ON PORTE, d'abord. Ce sont des exemplaires identiques, et
   * n'importe quel choix serait defendable — sauf celui qui deshabille le
   * personnage que le joueur a sous les yeux. Se voir retirer son arme sur la
   * fiche ouverte se lit comme un vol ; la meme piece retiree d'un personnage
   * qu'on ne joue pas se lit comme un rangement.
   *
   * Les autres suivent dans l'ordre alphabetique : un ordre stable rend deux
   * chargements de la meme sauvegarde identiques, ce qu'un parcours au hasard
   * ne ferait pas.
   */
  _reconcilieEquipement(p) {
    const persos = (p && p.persos) || {};
    const objets = (p && p.objets) || {};
    const CHAMPS = ['ef', 'ea', 'ar', 'ba'];
    const vus = {};
    const vides = [];
    const actif = p && p.skinActif;
    const ordre = Object.keys(persos).sort();
    if (actif && ordre.indexOf(actif) > 0) {
      ordre.splice(ordre.indexOf(actif), 1);
      ordre.unshift(actif);
    }
    for (const k of ordre) {
      const c = persos[k];
      if (!c) continue;
      for (const champ of CHAMPS) {
        const id = c[champ];
        if (!id) continue;
        vus[id] = (vus[id] || 0) + 1;
        if (vus[id] > (objets[id] || 0)) {
          c[champ] = null;
          vides.push({ skin: k, champ, item: id });
        }
      }
    }
    return vides;
  }

  /**
   * UN EXEMPLAIRE QUI SORT DU JEU REDESCEND DU REGISTRE DES EMIS.
   *
   * Sans ca il resterait compte comme existant pour toujours, et l'offre se
   * reduirait en silence : le panneau continuerait d'annoncer « il en reste
   * mille » sur des pieces qui n'existent plus, jusqu'a ce que le butin cesse
   * de tomber pour tout le monde.
   *
   * La regle vivait ecrite en quatre exemplaires — la mort, le rachat, le sac
   * au sol, et pas le repas. C'est exactement comme ca qu'elle a fini par
   * manquer a l'un d'eux : un seul endroit, maintenant.
   */
  _recycle(itemId, qte) {
    this.boutiqueEmis = this.boutiqueEmis || {};
    const id = Number(itemId);
    const n = Math.max(0, Math.floor(Number(qte) || 0));
    if (!n) return this.boutiqueEmis[id] || 0;
    this.boutiqueEmis[id] = Math.max(0, (this.boutiqueEmis[id] || 0) - n);
    return this.boutiqueEmis[id];
  }

  _equipe(addr, skinId, itemId, genre) {
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) throw new Error('you do not own this skin');
    p.persos = p.persos || {};
    const c = p.persos[skinId] || (p.persos[skinId] = { w: BN(0), ef: null, ea: null, ar: null, ba: null, xc: 0, sup: {} });
    const CHAMPS = { fruit: 'ef', arme: 'ea', armure: 'ar', bague: 'ba' };
    const SUJETS = { fruit: 'fruit', arme: 'weapon', armure: 'armor', bague: 'ring' };
    const champ = CHAMPS[genre];

    if (itemId === null || itemId === undefined || itemId === '') {
      c[champ] = null;
      return this.personnageEtat(addr, skinId);
    }
    const o = boutique.item(itemId);
    if (!o) throw new Error('unknown item');
    const sai = boutique.saison(o.saison);
    const attendu = SUJETS[genre];
    const article = /^[aeiou]/.test(attendu) ? 'an' : 'a';
    if (!sai || sai.sujet !== attendu) throw new Error(`this item is not ${article} ${attendu}`);
    /* ---- UN EXEMPLAIRE, UN PORTEUR ----
     *
     * « J'en possede au moins un » ne suffisait pas : la meme piece unique
     * pouvait habiller les six personnages, chacun avec ses degats et ses
     * bonus. La rarete annoncee — dix mythiques pour toute une saison — ne
     * voulait alors plus rien dire, et la mort n'en detruisait qu'une copie
     * sur six.
     *
     * Remettre CETTE case sur la piece qu'elle porte deja n'est pas un
     * deuxieme port : sans cette exception, re-cliquer sur l'objet qu'on a
     * sur le dos serait refuse comme un doublon de soi-meme. */
    if (c[champ] !== o.id && this._libres(p, o.id) < 1) {
      throw new Error(((p.objets || {})[o.id] > 0)
        ? 'all your copies of this one are already worn — take one off first'
        : 'you do not own this item');
    }
    c[champ] = o.id;
    return this.personnageEtat(addr, skinId);
  }
  /**
   * ================== S'EQUIPER DEPUIS LE SAC, EN UN SEUL GESTE ==================
   *
   * Un double-clic sur une piece du sac la porte, et celle qu'on portait
   * revient DANS LE SAC. C'est le geste qu'on fait cent fois par partie —
   * ramasser une meilleure epee et la mettre — et il ne doit rien couter de
   * plus qu'un aller-retour.
   *
   * ---- pourquoi un seul message, et pas trois ----
   *
   * La page le faisait en deux temps : « range au coffre », puis « equipe ».
   * Ca marchait, mais ca laissait l'ancienne piece AU COFFRE — que le joueur
   * ne voit pas depuis le monde de combat. Il croyait donc l'avoir perdue.
   * Et surtout : deux messages, c'est deux moments ou la piece n'est nulle
   * part. Un joueur y a deja laisse une arme.
   *
   * Tout se verifie AVANT la premiere ecriture. Ensuite, plus rien ne peut
   * echouer : on sort du sac, on porte, on rend l'ancienne. Trois ecritures
   * qui ne peuvent plus refuser.
   *
   * ---- la place ne manque jamais ----
   *
   * On sort une piece du sac et on en remet une : le compte ne bouge pas.
   * C'est la seule raison pour laquelle cet echange n'a pas besoin de place
   * libre, et c'est aussi pour ca qu'il ne peut pas se faire en deux temps —
   * en deux temps, le sac est plein entre les deux.
   */
  equipeDuSac(addr, skinId, itemId) {
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) throw new Error('you do not own this skin');
    const id = Number(itemId);
    const o = boutique.item(id);
    if (!o) throw new Error('Unknown item');
    const sai = boutique.saison(o.saison);
    const GENRE = { fruit: 'ef', weapon: 'ea', armor: 'ar', ring: 'ba' };
    const champ = sai ? GENRE[sai.sujet] : null;
    if (!champ) throw new Error('That one cannot be worn');
    p.sac = p.sac || {};
    if (!(p.sac[id] > 0)) throw new Error('That one is not in your backpack');
    p.persos = p.persos || {};
    const c = p.persos[skinId]
      || (p.persos[skinId] = { w: BN(0), ef: null, ea: null, ar: null, ba: null, xc: 0, sup: {} });
    const ancien = c[champ];
    /* Deja porte : il n'y a rien a faire, et surtout rien a echanger contre
       soi-meme — ce qui ferait sortir la piece du sac sans rien rendre. */
    if (ancien === id) return { item: id, ancien: null, deja: true };
    /* L'ancienne piece ne revient au sac que si PLUS PERSONNE ne la porte.
       C'est la meme regle que le coffre : un objet porte par un personnage
       qu'on ne joue pas est porte quand meme. */
    const porteAilleurs = (q) => Object.keys(p.persos).some((k) => {
      if (k === skinId) return false;
      const x = p.persos[k];
      return x && (x.ef === q || x.ea === q || x.ar === q || x.ba === q);
    });

    /* OU elle etait. La piece qu'on rend reprendra cette case-la : c'est le
       geste que le joueur a fait, et il en suit le resultat des yeux. */
    const cases = this._casesDuSac(p);
    const ou = cases.indexOf(id);

    /* ---- ON DECIDE DU SORT DE L'ANCIENNE AVANT DE TOUCHER A QUOI QUE CE SOIT ----
     *
     * Trois cas, et un seul rend la piece au sac :
     *   - personne d'autre ne la porte et elle est bien au coffre : elle rentre ;
     *   - un AUTRE personnage la porte : elle reste au coffre, c'est la meme
     *     regle que « on ne sort pas du coffre ce qu'on porte » ;
     *   - elle n'est PAS au coffre : etat impossible en theorie. On ne la rend
     *     donc pas, plutot que de laisser `_bouge` lever une exception APRES
     *     avoir equipe la nouvelle — ce qui laisserait le personnage habille et
     *     la piece nulle part. C'est exactement la panne qu'on nous a
     *     rapportee : « une de mes armes a disparu ».
     */
    const ailleurs = ancien ? porteAilleurs(ancien) : false;
    const auCoffre = ancien ? ((p.objets || {})[ancien] || 0) > 0 : false;
    const rendable = !!ancien && !ailleurs && auCoffre;
    if (ancien && !ailleurs && !auCoffre) {
      /* On le DIT. Un etat impossible qui arrive quand meme et que personne
         ne journalise, c'est un bug qu'on ne trouvera jamais : il ne laisse
         qu'un joueur qui affirme avoir perdu une piece. */
      console.warn('[equipeDuSac] piece portee absente du coffre :',
                   addr, skinId, champ, ancien);
    }

    // --- a partir d'ici, plus aucun refus possible
    this._bouge(addr, 'sac', 'objets', id, 'item');
    c[champ] = id;
    if (ou >= 0) cases[ou] = null;
    let rendu = null;
    if (rendable) {
      this._bouge(addr, 'objets', 'sac', ancien, 'item');
      const place = ou >= 0 ? ou : cases.indexOf(null);
      if (place >= 0) cases[place] = ancien;
      rendu = ancien;
    }
    p.sacCases = cases;
    /* `garde` dit pourquoi elle n'est pas revenue quand elle n'est pas
       revenue. Sans ce mot, la page ne peut que se taire, et se taire est
       precisement ce qui fait croire a une perte. */
    return { item: id, ancien: ancien || null, rendu, place: ou, deja: false,
             garde: ancien && !rendu ? (ailleurs ? 'porte-ailleurs' : 'coffre') : null };
  }

  equipeFruit(addr, skinId, itemId) { return this._equipe(addr, skinId, itemId, 'fruit'); }
  equipeArme(addr, skinId, itemId) { return this._equipe(addr, skinId, itemId, 'arme'); }
  equipeArmure(addr, skinId, itemId) { return this._equipe(addr, skinId, itemId, 'armure'); }
  equipeBague(addr, skinId, itemId) { return this._equipe(addr, skinId, itemId, 'bague'); }

  /**
   * ================== LA MORT, ET CE QUI SURVIT ==================
   *
   * La regle, celle de RotMG : ce qu'on PORTAIT est perdu, ce qui restait au
   * COFFRE est garde. Le personnage repart de zero — niveau 0, ses quatre
   * emplacements vides.
   *
   * ---- ou est le coffre, exactement ----
   *
   * C'est `p.objets`. Il l'a toujours ete : tout ce qu'on achete y tombe et y
   * reste. Ce qui change aujourd'hui, c'est qu'EQUIPER devient un acte a
   * risque — l'objet reste compte dans `p.objets`, mais il est designe par un
   * des quatre champs du personnage, et c'est cette designation qui le rend
   * mortel. On ne deplace donc rien entre deux listes : porter, c'est
   * simplement etre pointe par un personnage qui peut mourir.
   *
   * ---- pourquoi on retire l'exemplaire et pas la ligne ----
   *
   * On decremente. Un joueur qui possede trois exemplaires du meme fruit et
   * en portait un doit lui en rester deux — pas zero. La ligne ne disparait
   * que si c'etait le dernier, et c'est le seul cas ou la case du coffre se
   * vide vraiment.
   *
   * ---- ce que cette methode ne fait PAS ----
   *
   * Elle ne decide pas qu'on est mort. Elle applique la consequence. Le
   * moment de la mort appartiendra a la carte de combat, qui n'existe pas
   * encore ; l'ecrire ici en avance reviendrait a inventer des degats.
   */
  meurt(addr, skinId) {
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) throw new Error('you do not own this skin');
    p.persos = p.persos || {};
    const c = p.persos[skinId];
    /* Un personnage jamais joue n'a pas de fiche : il n'a donc rien porte,
       rien a perdre, et rien a remettre a zero. */
    if (!c) return { skin: skinId, perdus: [], niveau: 0, fameGagnee: 0, fameTotale: p.fame || 0 };

    /* ---- LA FAME SE TOUCHE EN MOURANT ----
     *
     * C'est le seul moment ou elle sort du personnage. Tant qu'il vit, elle
     * est un score en suspens ; sa mort la verse au compte, definitivement.
     * On la calcule AVANT de remettre le volume a zero — apres, l'XP dont
     * elle se deduit n'existe plus, et on verserait zero. */
    const fameGagnee = this._fameDe(c);
    /* L'XP aussi, et pour la meme raison : le bilan de fin l'affiche, et
       apres la remise a zero elle vaudrait zero. */
    const xpAvant = this._xpDe(c);
    p.fame = (p.fame || 0) + fameGagnee;

    const CHAMPS = ['ef', 'ea', 'ar', 'ba'];
    /* ---- CE QUI EST DETRUIT RETOURNE DANS LE POOL ----
     *
     * Un objet mort disparait du coffre du joueur ; s'il ne redescendait pas
     * aussi du REGISTRE des exemplaires emis, il resterait compte comme
     * existant pour toujours. Chaque mort aurait alors reduit l'offre en
     * silence, et les raretes seraient devenues introuvables sans que
     * personne puisse dire pourquoi — un plafond de dix mythiques, dix morts,
     * plus jamais un seul, alors que le panneau continue d'annoncer dix.
     *
     * C'est exactement le raisonnement du rachat (`RACHAT_RECYCLE`), et pour
     * la meme raison : ce qui sort du monde doit pouvoir y revenir. La mort
     * est meme le cas le plus evident — l'objet a ete PERDU, pas consomme. */
    const recycle = (id, qte) => this._recycle(id, qte);

    const perdus = [];
    p.objets = p.objets || {};
    for (const champ of CHAMPS) {
      const id = c[champ];
      if (!id) continue;
      const o = boutique.item(id);
      perdus.push({ id, cle: o ? o.cle : null, nom: o ? o.nom : null,
                    rarete: o ? o.rarete : null });
      if (p.objets[id] > 1) p.objets[id] -= 1;
      else delete p.objets[id];
      recycle(id, 1);
      c[champ] = null;
    }
    /* ---- ET LES AUTRES PERSONNAGES QUI PORTAIENT LE MEME EXEMPLAIRE ----
     * La mort DETRUIT une piece du stock. Si un autre personnage la portait —
     * possible sur toutes les fiches ecrites avant que `_equipe` ne l'empeche —
     * il continuerait de l'afficher, et de frapper avec, sur un exemplaire qui
     * n'existe plus. On les deshabille ici, au moment ou le stock baisse. */
    const desequipes = this._reconcilieEquipement(p);
    /* Le niveau vient du volume mise sous ce personnage : le remettre a zero
       EST la remise a niveau 0. Toucher au niveau sans toucher au volume
       laisserait les deux en desaccord, et le prochain calcul ressusciterait
       le niveau perdu. */
    /* LE SAC PART AUSSI. Il contient ce qu'on transportait — butin, potions —
       et c'est justement le sens du sac : ce qui n'a pas ete mis a l'abri au
       coffre disparait avec le personnage. Sans ca, le sac serait un second
       coffre gratuit, et deposer ses trouvailles ne servirait a rien. */
    /* ---- CE QUI A ETE BU MEURT AUSSI ----
     * C'est toute la tension de la potion de stat : elle ne se retire pas,
     * elle ne se range pas au coffre, et il n'existe aucun moyen de la mettre
     * a l'abri. Vingt potions d'attaque, c'est vingt sacs bleus retrouves — et
     * une seule mort. La garder ici ferait d'un personnage mort un personnage
     * neuf mais deja fort, ce qui viderait la mort de son sens. */
    const supPerdu = personnages.STATS.reduce((o, s) => {
      const k = Math.max(0, ((c.sup || {})[s] | 0));
      if (k) o[s] = k;
      return o;
    }, {});
    c.sup = {};

    const sac = p.sac || {};
    /* On compte les EXEMPLAIRES, pas les lignes : le sac a huit places et
       chacune porte un objet, donc trois epees identiques sont trois pertes
       et trois retours au pool. */
    let sacPerdu = 0;
    const sacDetail = [];
    for (const id of Object.keys(sac)) {
      const qte = Math.max(0, sac[id] | 0);
      if (!qte) continue;
      const o = boutique.item(Number(id));
      sacPerdu += qte;
      recycle(Number(id), qte);
      if (o) sacDetail.push({ id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete, qte });
    }
    p.sac = {};
    /* ---- LES FIOLES DU SAC MEURENT AUSSI ----
     * Celles du COFFRE, non : c'est exactement la difference entre les deux,
     * et la seule raison d'aller les y ranger. Une fiole transportee est une
     * fiole risquee — comme une piece. */
    const fiolesPerdues = {};
    for (const k of Object.keys(p.sacFioles || {})) {
      const q = Math.max(0, p.sacFioles[k] | 0);
      if (q) fiolesPerdues[k] = q;
    }
    p.sacFioles = {};
    /* ---- ET L'OEUF QU'ON N'AVAIT PAS ENCORE OUVERT ----
     * Il etait dans le SAC : c'est du butin transporte, et le sac se perd. Le
     * FAMILIER, lui, ne se perd jamais — mais il faut l'avoir fait eclore.
     * C'est ce qui donne sa tension a la trouvaille : on peut rentrer tout de
     * suite l'ouvrir, ou continuer sa sortie avec lui dans le dos. */
    const oeufsPerdus = {};
    for (const k of Object.keys(p.sacOeufs || {})) {
      const q = Math.max(0, p.sacOeufs[k] | 0);
      if (q) oeufsPerdus[k] = q;
    }
    p.sacOeufs = {};
    p.sacCases = null;

    c.w = BN(0);
    /* ET L'XP DE COMBAT AVEC. Le volume seul ne suffit plus depuis que tuer
       des monstres fait monter : ne remettre que lui laisserait un personnage
       « mort » revenir au niveau qu'il avait gagne sur le terrain. On
       recommence a zero, comme dans le jeu d'origine — c'est la contrepartie
       de la fame qu'on vient d'encaisser. */
    c.xc = 0;
    /* L'ECRAN DE FIN a besoin de tout ca d'un seul coup : ce qu'on a perdu,
       nommement, ce qu'on avait gagne, et ce qui reste. Le renvoyer en une
       fois evite au client d'aller le rechercher piece par piece au moment
       precis ou il doit afficher un bilan. */
    return { skin: skinId, perdus, sacPerdu, sacDetail, desequipes, niveau: 0,
             /* Ce qu'on transportait et qu'on n'avait pas range : l'ecran de
                fin le nomme, sinon le joueur decouvre la perte trois parties
                plus tard en cherchant ses fioles. */
             fiolesPerdues, oeufsPerdus,
             /* Les potions bues font partie du bilan : c'est souvent la
                perte la plus lourde, et la seule qu'aucun coffre n'aurait pu
                eviter. Ne pas la nommer donnerait un ecran de fin qui ment
                par omission. */
             supPerdu,
             xp: Math.round(xpAvant), fameGagnee, fameTotale: p.fame,
             skins: Object.keys(p.skins || {}) };
  }

  /**
   * Ce que le joueur peut equiper : ses fruits (saison 1), ses armes
   * (saison 2), ses pieces d'armure (saison 3) et ses bagues (saison 4)
   * qu'il possede reellement, avec le bonus que chacun donnerait.
   *
   * Independant de la saison actuellement parcourue dans la boutique — un
   * fruit achete pendant la saison 1 reste equipable meme si la page est
   * ouverte sur la saison 2. C'est pour ca que ce n'est pas `boutiqueEtat`
   * qui repond ici : celui-la ne rend qu'UNE saison a la fois.
   */
  equipablesPour(addr) {
    const p = this._p(addr);
    const objets = p.objets || {};
    const ligne = (o) => {
      const r = boutique.rarete(o.rarete);
      const l = { id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete, og: !o.drop,
                  couleur: r ? r.couleur : '#8DA0C4', famille: o.famille, pouvoir: o.pouvoir,
                  stat: personnages.FAMILLE_STAT[o.famille] || null,
                  bonus: personnages.bonusesDeObjet(o),
                  /* Ce que le fruit DECLENCHE. `pouvoir` juste au-dessus est
                     la phrase d'ambiance de la boutique — jolie, et muette sur
                     les chiffres qu'on subit en combat. */
                  ...(Game.sortDuFruit(o) ? { sort: Game.sortDuFruit(o) } : {}),
                  quantite: objets[o.id] || 0 };
      /* Une arme n'a plus de stats : sans ses degats, la liste de choix
         montrerait cinq epees indistinctes. Les degats SONT sa fiche. */
      const d = personnages.degatsDeObjet(o);
      if (d) l.degats = d.slice();
      return l;
    };
    const possede = (o) => (objets[o.id] || 0) > 0;
    return {
      fruits: boutique.itemsDeSaison(1).filter(possede).map(ligne),
      armes: boutique.itemsDeSaison(2).filter(possede).map(ligne),
      armures: boutique.itemsDeSaison(3).filter(possede).map(ligne),
      bagues: boutique.itemsDeSaison(4).filter(possede).map(ligne),
      /* Les fioles de stat mises a l'abri. Elles ne s'equipent pas — on les
         BOIT — mais elles vivent au meme endroit et se rangent par le meme
         geste, et le coffre est l'ecran ou l'on decide quoi emporter. */
      fioles: this.fiolesPour(addr),
      /* ---- LE SAC N'EST PAS LE COFFRE ----
       *
       * Le coffre (`p.objets`) contient ce qu'on a ACHETE : il est a l'abri,
       * et c'est de la qu'on s'equipe. Le sac (`p.sac`) contient ce qu'on
       * RAMASSE dans le monde — butin, potions — et il part avec le
       * personnage s'il meurt.
       *
       * Il est vide aujourd'hui, et c'est exact : rien ne peut encore tomber,
       * puisqu'il n'y a ni monstre ni coffre au sol. Le remplir avec les
       * objets du coffre, comme on le faisait, montrait au joueur ses achats
       * a un endroit ou ils ne sont pas — et laissait croire qu'ils
       * risquaient de disparaitre. */
      sac: this.sacPour(addr),
      potions: this.potionsPour(addr),
    };
  }

  /**
   * ==================== RANGER, ET REPRENDRE ====================
   *
   * Le SAC porte ce qu'on ramasse : il part avec le personnage s'il meurt.
   * Le COFFRE porte ce qu'on a mis a l'abri : il survit a tout. Passer de
   * l'un a l'autre est donc le seul geste qui change le RISQUE d'un objet,
   * et c'est pour ca qu'il ne se fait qu'a la salle du coffre.
   *
   * Deux regles, et elles ne sont pas symetriques :
   *  - on range ce qu'on veut, toujours ;
   *  - on ne REPREND pas une piece qu'on PORTE. L'equipement se lit dans le
   *    coffre ; la sortir mettrait le personnage a porter quelque chose qui
   *    n'y est plus, et la prochaine lecture de sa fiche le desequiperait
   *    tout seul sans que personne comprenne pourquoi.
   */
  _bouge(addr, de, vers, itemId, quoi) {
    const p = this._p(addr);
    const id = Number(itemId);
    const o = boutique.item(id);
    if (!o) throw new Error('Unknown item');
    p[de] = p[de] || {};
    p[vers] = p[vers] || {};
    if (!(p[de][id] > 0)) throw new Error('You do not have that ' + quoi);
    p[de][id] -= 1;
    if (p[de][id] <= 0) delete p[de][id];
    p[vers][id] = (p[vers][id] || 0) + 1;
    return { item: id, nom: o.nom };
  }

  /** Du sac vers le coffre : l'objet est desormais a l'abri de la mort. */
  rangeAuCoffre(addr, itemId) {
    return this._bouge(addr, 'sac', 'objets', itemId, 'item');
  }

  /** Du coffre vers le sac : l'objet repart avec nous, et se perd si on meurt. */
  sortDuCoffre(addr, itemId) {
    const p = this._p(addr);
    const id = Number(itemId);
    /* Porte sur UN personnage quelconque : on refuse — un objet porte par un
       personnage qu'on ne joue pas est porte quand meme.
       On compte maintenant les EXEMPLAIRES au lieu de chercher une occurrence :
       celui qui en possede trois et en porte un doit pouvoir sortir les deux
       autres. L'ancienne version refusait les trois. */
    const refus = this._refusPorte(p, id, 1);
    if (refus) throw new Error(refus);
    if (this.sacRempli(addr) >= SAC_CASES) {
      throw new Error('Your backpack is full — ' + SAC_CASES + ' slots, one item each');
    }
    return this._bouge(addr, 'objets', 'sac', itemId, 'item');
  }

  /**
   * Le contenu du sac, pret a peindre. UNE ENTREE PAR EXEMPLAIRE.
   *
   * Le coffre empile — « x3 » sur une ligne — parce qu'il est un stock. Le
   * sac, non : il a HUIT PLACES, et chaque objet en prend une, meme si le
   * voisin est identique. C'est ce qui fait que le sac se remplit, qu'il faut
   * choisir, et qu'un aller-retour au coffre a un sens. Un sac qui empile
   * n'a pas de fond, et rien de ce qu'on y met ne coute quoi que ce soit.
   *
   * On garde `p.sac` compact en memoire ({id: nombre}) et on DEPLIE ici :
   * persister huit lignes identiques serait du gaspillage, et la regle des
   * places est une regle d'usage, pas de rangement.
   */
  /**
   * ================== LES CASES DU SAC ==================
   *
   * `p.sac` compte ce qu'on porte — {identifiant: nombre} — et ne dit pas OU.
   * Tant qu'on ne faisait qu'ajouter et retirer, l'ordre des cles suffisait :
   * personne ne regarde a quelle place tombe une piece ramassee.
   *
   * Il ne suffit plus depuis qu'on ECHANGE. Prendre l'arme de la case 2 et y
   * remettre celle qu'on portait, c'est un geste dont le joueur suit le
   * resultat des yeux : si sa piece reapparait ailleurs, il la croit perdue —
   * et il vient le dire.
   *
   * On garde donc une liste de cases A COTE du compte. Elle n'est PAS la
   * verite : le compte l'est. On la remet d'accord avec lui a chaque lecture,
   * et une liste absente ou abimee ne coute rien — elle se reconstruit.
   */
  _casesDuSac(p) {
    const sac = p.sac || {};
    const fioles = p.sacFioles || {};
    const oeufs = p.sacOeufs || {};
    /* Ce que le sac contient, sous UNE seule forme : une clef par unite
       possible. Un identifiant de boutique est un nombre, une fiole de stat
       est « st:<stat> » — deux formes dans une meme liste, parce qu'une seule
       liste veut dire une seule verite sur ce que contient le sac. */
    /* ---- LES FIOLES S'EMPILENT, LES PIECES NON ----
     *
     * Une piece par case : le sac compte des PLACES, et c'est ce qui fait
     * qu'emporter du butin coute quelque chose. Une fiole de stat, elle, n'est
     * pas du butin qu'on choisit de garder — c'est une reserve, comme les
     * potions de soin qui ont deja leur pile. Trois fioles de defense
     * mangeaient trois des huit places et le sac etait plein avant d'avoir
     * ramasse quoi que ce soit.
     *
     * Une case porte donc TOUTES les fioles d'une meme stat. Deux stats
     * differentes restent deux cases : ce sont deux objets differents, et les
     * confondre dans une pile obligerait a lire un chiffre pour savoir
     * laquelle on boit. */
    const compte = {};
    const places = {};          // combien de CASES chaque clef demande
    for (const k of Object.keys(sac)) {
      if (sac[k] > 0) { compte[Number(k)] = sac[k] | 0; places[Number(k)] = sac[k] | 0; }
    }
    /* Les fioles de stat ne passent PLUS par la grille : elles vivent dans
       leur reserve, envoyee a part par `fiolesPour`. Les laisser ici leur
       aurait garde une case chacune — c'est-a-dire exactement le probleme
       qu'on vient d'enlever. */
    /* ---- LES OEUFS S'EMPILENT AUSSI ----
     * Meme raison que les fioles : ce n'est pas du butin qu'on choisit de
     * garder, c'est une trouvaille qu'on rapporte. Et l'on n'en porte jamais
     * beaucoup — a une chance sur cinq mille, deux oeufs dans le meme sac
     * sont deja une histoire. */
    for (const k of Object.keys(oeufs)) {
      if (oeufs[k] > 0) { compte['oe:' + k] = oeufs[k] | 0; places['oe:' + k] = 1; }
    }

    const cases = Array.isArray(p.sacCases) ? p.sacCases.slice(0, SAC_CASES) : [];
    while (cases.length < SAC_CASES) cases.push(null);
    /* Ce que les cases pretendent contenir, borne par ce qu'on a vraiment.
       Une case qui montre une piece de plus que le compte se vide. */
    const vus = {};
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      /* Trois formes dans une meme liste : un nombre pour une piece, « st: »
         pour une pile de fioles, « oe: » pour un oeuf. Une seule liste veut
         dire une seule verite sur ce que contient le sac. */
      const cle = (typeof c === 'string' && (c.slice(0, 3) === 'st:' || c.slice(0, 3) === 'oe:'))
        ? c : Number(c);
      if (!(compte[cle] > 0)) { cases[i] = null; continue; }
      /* C'est `places` et non `compte` qui borne : une pile de fioles n'a
         droit qu'a UNE case, quelle que soit sa hauteur. Sans ca la deuxieme
         fiole de defense reprendrait une case a elle. */
      if ((vus[cle] || 0) >= places[cle]) { cases[i] = null; continue; }
      vus[cle] = (vus[cle] || 0) + 1;
      cases[i] = cle;
    }
    /* Et ce qui n'a pas encore de case en prend une — la premiere libre. */
    for (const cle of Object.keys(compte)) {
      const vraie = (cle.slice(0, 3) === 'st:' || cle.slice(0, 3) === 'oe:') ? cle : Number(cle);
      for (let q = vus[vraie] || 0; q < places[cle]; q++) {
        const libre = cases.indexOf(null);
        if (libre < 0) break;
        cases[libre] = vraie;
      }
    }
    p.sacCases = cases;
    return cases;
  }

  /**
   * ================== DEPLACER UNE PIECE DANS SON SAC ==================
   *
   * Huit places, et le droit de les ranger. Ce n'est pas un confort : le sac
   * se lit d'un coup d'oeil en combat, et « ma potion est toujours en bas a
   * droite » vaut une demi-seconde a chaque fois qu'on la cherche.
   *
   * On ECHANGE les deux places plutot que d'inserer et decaler. Un decalage
   * bouge tout ce qui suit — le joueur en deplace une et en retrouve six
   * ailleurs. L'echange ne touche qu'a ce qu'on a designe, et il n'a pas
   * besoin de case libre.
   */
  deplaceSac(addr, de, vers) {
    const p = this._p(addr);
    const a = Math.floor(Number(de)), b = Math.floor(Number(vers));
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('bad slot');
    if (a < 0 || b < 0 || a >= SAC_CASES || b >= SAC_CASES) throw new Error('bad slot');
    const cases = this._casesDuSac(p);
    if (a === b) return { de: a, vers: b, bouge: false };
    /* Une case VIDE peut etre la source : ca ne fait rien, et refuser
       obligerait la page a savoir ce qu'elle tient avant de le lacher. */
    const x = cases[a], y = cases[b];
    cases[a] = y; cases[b] = x;
    p.sacCases = cases;
    return { de: a, vers: b, bouge: true };
  }

  sacPour(addr) {
    const p = this._p(addr);
    const cases = this._casesDuSac(p);
    const out = [];
    for (let i = 0; i < cases.length; i++) {
      const id = cases[i];
      if (id === null || id === undefined) continue;
      /* ---- PLUS DE FIOLE ICI ----
       * Il y avait a cet endroit une branche « st: » qui fabriquait une case
       * de fiole. Elle ne pouvait plus rien produire : depuis que les fioles
       * vivent dans leur propre reserve, `_casesDuSac` ne fait plus entrer
       * aucune clef « st: » dans la grille, et `fioles.test.js` verifie
       * justement qu'aucune fiole ne figure dans ce que rend `sacPour`.
       *
       * Du code mort qui a l'air vivant n'est pas neutre : trois assertions de
       * ce depot interrogeaient encore `sacPour` pour trouver une fiole, et
       * cherchaient donc dans une fenetre qui ne peut plus rien montrer. La
       * reserve se lit avec `fiolesPour`. */
      /* UN OEUF. Meme raison que la fiole : pas d'identifiant de boutique, et
         il n'en aura pas — il ne se vend pas, il ne s'achete pas, et il n'a
         donc rien a faire dans les plafonds de saison. */
      if (typeof id === 'string' && id.slice(0, 3) === 'oe:') {
        const es = id.slice(3);
        out.push({ oeuf: es, nom: NOM_OEUF[es] || 'Egg', cle: 'oeuf_' + es,
                   rarete: es === 'legendaire' ? 'relique' : 'mythique',
                   couleur: es === 'legendaire' ? '#FFFFFF' : '#FF4655',
                   quantite: Math.max(1, (p.sacOeufs || {})[es] | 0),
                   note: 'Hatch it at Petworld',
                   place: i });
        continue;
      }
      const o = boutique.item(id);
      if (!o) continue;
      const r = boutique.rarete(o.rarete);
      const d = personnages.degatsDeObjet(o);
      out.push({ id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete,
                 couleur: r ? r.couleur : '#8DA0C4', saison: o.saison,
                 /* Numerotee, donc payee : voir `bonusDe`. */
                 og: !o.drop,
                 stat: personnages.FAMILLE_STAT[o.famille] || null,
                 bonus: personnages.bonusesDeObjet(o),
                 /* Meme raison que dans la liste d'equipement : une arme
                    posee dans le sac ne se lit que par ses degats. */
                 ...(d ? { degats: d.slice() } : {}),
                 /* Et un fruit ne se lit que par ce qu'il DECLENCHE : ses deux
                    lignes de bonus ne disent rien de la foudre. */
                 ...(Game.sortDuFruit(o) ? { sort: Game.sortDuFruit(o) } : {}),
                 /* `place` identifie CETTE CASE, pas cet objet : deux
                    exemplaires identiques doivent pouvoir se deplacer
                    separement — et une piece rendue doit retrouver la sienne. */
                 place: i });
    }
    return out;
  }

  /**
   * ==================== LES POTIONS ====================
   * Achat a prix fixe, sans tirage ni plafond. Le solde est debite ici et
   * nulle part ailleurs — c'est la regle de tout ce fichier.
   */
  potionsPour(addr) {
    const p = this._p(addr);
    const pot = p.potions || {};
    return Object.keys(POTIONS).map((k) => ({
      cle: k, nom: POTIONS[k].nom, prix: POTIONS[k].prix,
      soigne: POTIONS[k].soigne, quoi: POTIONS[k].quoi, image: POTIONS[k].image,
      max: POTIONS_MAX, quantite: Math.max(0, pot[k] | 0),
    }));
  }

  achetePotion(addr, cle, quantite) {
    const t = POTIONS[cle];
    if (!t) throw new Error('Unknown potion');
    const n = Math.max(1, Math.min(POTIONS_MAX, Math.floor(Number(quantite) || 1)));
    const p = this._p(addr);
    p.potions = p.potions || {};
    const deja = Math.max(0, p.potions[cle] | 0);
    /* On plafonne A L'ACHAT plutot que de refuser : quelqu'un qui a
       quatre-vingt-quinze potions et en demande dix en veut visiblement le
       maximum, et lui rendre une erreur au lieu de quatre potions serait
       pedant. On ne facture que ce qu'on livre. */
    const livre = Math.min(n, POTIONS_MAX - deja);
    if (livre <= 0) throw new Error('You already carry ' + POTIONS_MAX + ' of those');

    /* ---- PAS A CREDIT, ET PAS A MOITIE ----
     *
     * Un solde insuffisant refuse l'achat EN ENTIER. Livrer « ce qu'on peut
     * payer » serait une surprise : on demande dix potions, on en recoit
     * trois, et le compte est vide sans qu'on ait rien decide.
     *
     * A ne pas confondre avec le plafond de PORT, juste au-dessus, qui lui
     * livre partiellement — et c'est la bonne facon de le traiter : quelqu'un
     * qui en porte quatre-vingt-quinze et en demande dix en veut visiblement
     * le maximum. La difference tient en une phrase : ce que le SAC ne peut
     * pas contenir n'est pas une surprise, ce que le SOLDE ne peut pas payer
     * en est une. */
    if (p.balance.lt(WEI(t.prix * livre))) throw new Error('Not enough $SWOGE');

    /* ---- LE STOCK DES JOUEURS PASSE EN PREMIER ----
     *
     * Servir la maison d'abord aurait rendu les annonces invisibles : personne
     * n'aurait jamais rien vendu, puisque l'acheteur serait toujours tombe sur
     * le fond avant la file. L'ordre EST le marche.
     *
     * `_acheteAuxJoueurs` a deja debite l'acheteur et paye les vendeurs pour
     * ce qu'elle a servi ; il ne reste ici qu'a livrer et a facturer le
     * complement. */
    const desJoueurs = this._acheteAuxJoueurs(p, cle, livre);
    if (desJoueurs > 0) this._potDonne(p, cle, desJoueurs);

    const reste = livre - desJoueurs;
    /* ---- ET LA MAISON DERRIERE ----
     *
     * Un marche vide ne doit pas devenir un jeu sans potions : ici la mort
     * detruit un equipement paye en argent reel, et « il n'y en avait plus »
     * serait une perte causee par la boutique. La maison reste donc au fond de
     * la file — jamais devant. Le jour ou le stock des joueurs tiendra tout
     * seul, POTIONS_FOND_MAISON=0 ferme le robinet sans toucher au reste. */
    let deLaMaison = 0;
    if (reste > 0 && cfg.POTIONS_FOND_MAISON) {
      deLaMaison = reste;
      const cout = WEI(t.prix * deLaMaison);
      p.balance = p.balance.sub(cout);
      this._bumpDay(p); p.dayNet = p.dayNet.sub(cout);
      this._potDonne(p, cle, deLaMaison);
    }
    const total = desJoueurs + deLaMaison;
    /* Le stock, lui, PEUT manquer, et ce n'est pas la meme chose qu'un solde
       insuffisant : demander dix potions quand deux existent n'est pas acheter
       a credit, c'est demander plus qu'il n'y en a. On livre les deux, comme
       le plafond de port livre ce qui tient. */
    if (total <= 0) {
      throw new Error('No ' + t.nom + ' for sale right now — players stock the shop');
    }
    return { cle, livre: total, quantite: p.potions[cle] || 0,
             prix: t.prix * total, desJoueurs, deLaMaison,
             balance: this.balanceStr(addr) };
  }

  /**
   * ==================== CE QU'ON RAMASSE DANS LE MONDE ====================
   *
   * Deux methodes, deux natures. Une potion de soin est du STOCK : elle entre
   * dans la meme pile que celles qu'on achete, avec le meme plafond. Une
   * potion de stat est un ACQUIS : elle se boit sur-le-champ et ne se range
   * nulle part — il n'existe aucun moyen de la mettre a l'abri, et c'est ce
   * qui fait tout son prix.
   */

  /** Combien de potions de cette stat ce personnage peut encore boire. */
  supRestant(addr, skinId, stat) {
    if (personnages.STATS.indexOf(stat) < 0) return 0;
    const base = personnages.BASE[skinId];
    if (!base) return 0;
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) return 0;
    const c = this._persoDe(p, skinId);
    const deja = Math.max(0, ((c.sup || {})[stat] | 0));
    return Math.max(0, personnages.supMaxDe(stat, base[stat]) - deja);
  }

  /**
   * Boire une potion de stat trouvee au sol.
   *
   * Elle n'est jamais stockee : entre le sac au sol et la statistique du
   * personnage, il n'y a pas d'etape. La ranger quelque part aurait ouvert la
   * seule chose que cette potion ne doit pas permettre — la mettre a l'abri.
   */
  boitStat(addr, skinId, stat) {
    if (personnages.STATS.indexOf(stat) < 0) throw new Error('Unknown stat');
    const p = this._p(addr);
    if (!this.possedeSkin(p, skinId)) throw new Error('No such character');
    p.persos = p.persos || {};
    const c = p.persos[skinId]
      || (p.persos[skinId] = { w: BN(0), ef: null, ea: null, ar: null, ba: null, xc: 0, sup: {} });
    c.sup = c.sup || {};
    const base = personnages.BASE[skinId];
    /* Le plafond depend du PERSONNAGE, pas de la potion : la defense d'andy
       s'arrete a six, ses points de vie a vingt. Un plafond unique aurait
       rendu la potion de defense trois fois plus forte que toutes les autres
       — mesure faite : +200 % de survie contre un squelette. */
    const mx = personnages.supMaxDe(stat, base[stat]);
    const deja = Math.max(0, c.sup[stat] | 0);
    if (deja >= mx) throw new Error('Already at ' + mx + '/' + mx);
    c.sup[stat] = deja + 1;
    return { stat, potions: c.sup[stat], max: mx,
             pas: personnages.supPas(stat),
             bonus: personnages.supDe(stat, c.sup[stat], base[stat]) };
  }

  /**
   * Ranger une potion de soin trouvee au sol.
   *
   * Elle entre dans la MEME pile que celles de la boutique : deux piles
   * separees — l'achetee et la trouvee — auraient demande au joueur de savoir
   * laquelle il boit, pour aucune difference. Le plafond est celui de
   * l'achat, et pour la meme raison : c'est un plafond de PORT, pas de
   * commerce.
   */
  donnePotion(addr, cle) {
    const t = POTIONS[cle];
    if (!t) throw new Error('Unknown potion');
    const p = this._p(addr);
    p.potions = p.potions || {};
    const deja = Math.max(0, p.potions[cle] | 0);
    if (deja >= POTIONS_MAX) throw new Error('You already carry ' + POTIONS_MAX + ' of those');
    p.potions[cle] = deja + 1;
    return { cle, nom: t.nom, quantite: p.potions[cle], max: POTIONS_MAX };
  }

  /**
   * ==================== ECHANGER AVEC LE SOL ====================
   *
   * Le sac au sol n'est pas seulement une source : on peut y DEPOSER. C'est ce
   * qui rend l'echange possible — poser son epee commune dans le sac, prendre
   * celle qu'on vient de trouver, et repartir sans etre passe par le coffre.
   *
   * Les deux methodes ne touchent QUE `p.sac`. Ou va l'objet ensuite (dans un
   * sac au sol qui expire dans une minute) ne regarde pas ce fichier : c'est
   * realm.js qui tient le sol.
   */

  /**
   * ==================== CE QUE LE MONDE FAIT TOMBER ====================
   *
   * `monde.js` decide de la RARETE, `realm.js` fait tomber le sac, et ni l'un
   * ni l'autre ne connait la boutique. Le registre des exemplaires emis, lui,
   * vit ici — c'est donc ici que la rarete devient une piece.
   *
   * ---- le plafond vaut aussi pour ce qui tombe ----
   *
   * `RARETES` annonce quatre exemplaires de chaque relique. Ce chiffre ne
   * voulait rien dire tant que rien ne comptait les pieces TROUVEES : la table
   * promettait une rarete que le monde pouvait produire sans fin.
   *
   * On inscrit donc au moment ou la piece TOMBE, pas au ramassage. Deux
   * joueurs qui courent vers le meme sac ne doivent pas pouvoir emporter la
   * derniere relique chacun — et entre les deux il y a une minute pendant
   * laquelle la piece existe deja au sol.
   */
  /**
   * ================== UNE SALLE GARDEE DONNE TOUJOURS QUELQUE CHOSE ==================
   *
   * « Il y a quatre boss ou il y a des coffres proteges ; parfois j'ouvre le
   * coffre et il n'y a rien dedans. »
   *
   * C'etait vrai, et c'etait mecanique. La saison ne porte que SEIZE reliques
   * en tout. Les deux salles a relique en donnent une par nettoyage et se
   * rearment toutes les six minutes : le stock part en trois quarts d'heure.
   * Ensuite, tuer deux gardiens de seize cents points de vie ne donnait plus
   * RIEN — pas un sac vide, pas de sac du tout.
   *
   * La rarete rare doit rester rare : on ne fabrique pas de reliques en plus.
   * Mais une salle gardee promet un tresor, et cette promesse-la doit tenir.
   * On DESCEND donc d'un cran tant qu'il reste quelque chose : une legendaire
   * plutot qu'une relique, et ainsi de suite. Le joueur repart avec ce que la
   * saison peut encore donner, jamais avec rien.
   *
   * L'ordre vient de `boutique.RARETES` et n'est pas recopie ici : une
   * septieme rarete ajoutee un jour doit entrer dans l'echelle toute seule.
   */
  tireButinGaranti(rarete, alea) {
    const rangs = boutique.RARETES.map((r) => r.cle);
    let i = rangs.indexOf(String(rarete));
    if (i < 0) i = rangs.length - 1;
    for (let k = i; k >= 0; k--) {
      const piece = this.tireButin(rangs[k], alea);
      /* `repli` dit au monde qu'on n'a pas donne ce qui etait promis. La page
         peut alors l'ecrire ; sans ca, un joueur qui connait la salle croirait
         a un vol. */
      if (piece) return k === i ? piece : { ...piece, repli: rangs[i] };
    }
    return null;
  }

  /* ---- CE QUE FAIT UN FRUIT ----
   *
   * Le pouvoir d'un fruit n'est ecrit nulle part SUR le fruit : il se deduit
   * de sa stat dominante (`POUVOIR_PAR_STAT`), et ses chiffres vivent dans
   * `POUVOIRS`. On portait donc un fruit sans savoir ce qu'il declenchait —
   * la seule facon de l'apprendre etait d'aller le lancer dans un combat.
   *
   * La page pourrait le deduire elle aussi, au prix de DEUX tables recopiees
   * du serveur. Deux copies d'une table de regles finissent toujours par
   * diverger, et le fruit dirait alors « 3x » quand le serveur en applique
   * deux. C'est donc le serveur qui l'ecrit, une fois, en toutes lettres.
   *
   * Les chiffres de la phrase sont LUS dans la table, jamais tapes : regler
   * l'equilibre d'un pouvoir doit changer sa description dans le meme geste.
   */
  static sortDuFruit(o) {
    if (!o) return null;
    /* ---- SEULE LA SAISON DES FRUITS DONNE UN POUVOIR ----
     *
     * Le test etait `FAMILLE_STAT[o.famille]`, avec ce commentaire : « elle ne
     * connait que les familles de FRUITS : une armure ou une lame n'y est
     * pas ». C'ETAIT FAUX. `FAMILLE_STAT` contient aussi `plastron`,
     * `casque`, `epaulieres`, `onyx`, `saphir`… — les familles d'armures et
     * de bagues, parce qu'elles ont elles aussi une stat dominante.
     *
     * Consequence mesuree : 45 armures et 41 bagues annoncaient un pouvoir,
     * soit 86 fiches. Et le joueur ne le recevait JAMAIS — le pouvoir reel
     * vient de `etat.equipFruit`, l'emplacement fruit et lui seul (voir
     * `statFruit` dans server.js). On vendait « Rusted Cuirass · Stasis ·
     * 75 MP » a quelqu'un qui n'aurait jamais de Stasis.
     *
     * Le discriminant est desormais la SAISON. Elle est portee par l'objet,
     * elle vient du catalogue, et elle ne peut pas se mettre a signifier
     * autre chose : la saison 1 EST celle des fruits.
     */
    const S = boutique.SAISONS.find((x) => x.cle === 'fruits');
    if (!S || o.saison !== S.n) return null;
    if (!o.famille) return null;
    const stat = personnages.FAMILLE_STAT[o.famille];
    if (!stat) return null;
    const cle = monde.POUVOIR_PAR_STAT[stat];
    const P = cle ? monde.POUVOIRS[cle] : null;
    if (!P) return null;
    const quoi = cle === 'foudre'
      ? `${P.facteur}× your best hit, up to ${P.portee} away`
      : cle === 'rafale'
        ? `${P.facteur}× fire rate for ${P.duree}s`
        : `freezes everything within ${P.rayon} for ${P.duree}s`;
    return { cle, nom: P.nom, cout: P.cout, recharge: P.recharge, quoi };
  }

  /**
   * LE PASSIF D'UN OBJET, ou `null`.
   *
   * ---- UNE CHOSE PAR SAISON, ET C'EST LA REGLE QUI TIENT TOUT ----
   *
   * Le fruit donne un POUVOIR, l'arme des DEGATS, l'armure et la bague un
   * PASSIF. Un objet qui donnerait les deux ferait de la saison 1 un cran de
   * plus au lieu d'un choix.
   *
   * Le discriminant est la SAISON, comme pour `sortDuFruit`, et pour la meme
   * raison : c'est le seul fait que l'objet porte et qui ne peut pas se
   * mettre a signifier autre chose. Le tester sur la famille etait exactement
   * la faute qui a mis un pouvoir sur 86 armures et bagues.
   *
   * ---- ET SA FORCE VIENT DU BUDGET DE RARETE ----
   *
   * Celui-la meme qui decide des bonus de stats. Une legendaire est plus
   * forte qu'une commune pour la meme raison qu'elle donne plus de points, et
   * l'ecart n'a pas a etre regle une seconde fois. La source compte aussi :
   * une piece de butin et une piece de boutique n'ont pas le meme budget, et
   * `sourceDe` le sait deja.
   */
  static passifDe(o) {
    if (!o) return null;
    const S = boutique.SAISONS.filter((x) => x.cle === 'armures' || x.cle === 'bagues')
                              .map((x) => x.n);
    if (S.indexOf(Number(o.saison)) < 0) return null;
    const stat = personnages.FAMILLE_STAT[o.famille];
    const cle = stat ? monde.passifDeStat(stat) : null;
    if (!cle) return null;
    const budget = personnages.budgetDe(o);
    const e = monde.passifEffet(cle, budget);
    if (!e) return null;
    return { ...e, nom: NOM_PASSIF[cle] || cle,
             quoi: (PHRASE_PASSIF[cle] || (() => ''))(e) };
  }

  /** Ce qu'une piece emporte avec elle quand elle tombe ou qu'on la pose. */
  ficheAuSol(o) {
    if (!o) return null;
    const r = boutique.rarete(o.rarete);
    const d = personnages.degatsDeObjet(o);
    const b = personnages.bonusesDeObjet(o);
    const sort = Game.sortDuFruit(o);
    return { item: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete,
             couleur: r ? r.couleur : null, og: !o.drop,
             ...(Object.keys(b).length ? { bonus: b } : {}),
             ...(d ? { degats: d } : {}),
             ...(sort ? { sort } : {}) };
  }

  /*
   * ---- DEUX PROVENANCES, UN SEUL CORPS ----
   *
   * Les huit pieces de la Forge sont des trouvailles comme les autres — meme
   * liste, meme registre, meme plafond. Ce qui les separe est OU elles
   * tombent, et ca ne se devine pas : si le monde ouvert pouvait les rendre, on
   * aurait les memes reliques en abattant des limes, et franchir le portail
   * n'aurait plus servi a rien. Le donjon serait devenu une salle gardee avec
   * un decor different.
   *
   * Le partage se fait donc ici, une seule fois, sur le champ `donjon` :
   * `tireButin` prend tout SAUF le donjon, `tireButinDonjon` ne prend que lui.
   * Le corps est commun aux deux — pas par economie de lignes, mais parce que
   * c'est lui qui tient le PLAFOND. Deux copies, et le jour ou l'une apprend a
   * compter autrement, la relique du donjon sort cinq fois au lieu de quatre
   * sans qu'aucun essai ne s'en apercoive.
   *
   * `tireButinGaranti` n'a rien a filtrer : il descend les rangs en appelant
   * `tireButin`, donc il herite de l'exclusion sans la reecrire. C'est la
   * raison pour laquelle il passe par lui au lieu de refaire le tirage.
   */
  _tireDuLot(lot, rarete, alea) {
    const rang = lot.filter((o) => o.rarete === String(rarete));
    if (!rang.length) return null;
    this.boutiqueEmis = this.boutiqueEmis || {};
    const dispo = rang.filter((o) => boutique.restant(o.id, this.boutiqueEmis) > 0);
    if (!dispo.length) return null;
    const r = typeof alea === 'function' ? alea() : Math.random();
    const o = dispo[Math.min(dispo.length - 1, Math.floor(r * dispo.length))];
    this.boutiqueEmis[o.id] = (this.boutiqueEmis[o.id] || 0) + 1;
    /* Le nom, la cle d'image ET LA FICHE partent AVEC la piece : les retrouver
       au moment d'envoyer l'etat du monde les recalculerait pour chaque
       client, dix fois par seconde. La fiche sert au survol — c'est au sol,
       devant un sac, que la question « est-ce que ca vaut mieux que ce que je
       porte ? » se pose. */
    return this.ficheAuSol(o);
  }

  /** Ce que le MONDE OUVERT fait tomber : les anneaux, jamais la Forge. */
  tireButin(rarete, alea) {
    return this._tireDuLot(boutique.ITEMS_DROP.filter((o) => !o.donjon), rarete, alea);
  }

  /**
   * Ce que la FORGE fait tomber : les huit, et rien d'autre.
   *
   * Meme mecanique que `tireButin` a la piece pres — meme registre, meme
   * plafond, meme fiche au sol. Un donjon qui tirerait « autrement » aurait son
   * propre compte d'exemplaires, donc sa propre facon de le rater.
   */
  /**
   * @param quel  le donjon ou l'on se trouve, ou rien.
   *
   * ---- UNE PIECE PEUT APPARTENIR A UN DONJON PRECIS ----
   *
   * Les huit reliques de la Forge n'appartiennent a aucun : elles tombent dans
   * n'importe quel donjon, et c'est tres bien — ce sont des reliques de
   * donjon, sans plus de precision.
   *
   * Celles du Sanctuaire portent `donjonCle`. L'Idole a trente-huit mille
   * points de vie, cinq phases et deux especes d'invocations ; laisser son
   * anneau tomber chez les pirates aurait retire au combat la seule chose
   * qu'il donne et que rien d'autre ne donne.
   *
   * Le filtre est ecrit dans ce sens-la — « les sans-cle, PLUS celles d'ici »
   * — et pas « celles d'ici seulement ». La cave des pirates n'a aucune piece
   * a elle : la regle stricte lui aurait vide son lot en silence, et son boss
   * aurait cesse de rendre quoi que ce soit de rare.
   */
  tireButinDonjon(rarete, alea, quel) {
    /* ---- LE DONJON NOMME SES PIECES, PAS L'INVERSE ----
     * Le filtre lisait une cle MANQUANTE comme « tombe partout ». Les huit
     * reliques de la Forge n'en avaient pas : elles tombaient donc aussi dans
     * le Sanctuaire, et l'on y ramassait l'equipement d'Optimus. La question
     * est posee une seule fois, dans la boutique, ou la forme du champ est
     * connue — et une piece sans cle ne demarre plus le serveur. */
    const lot = boutique.ITEMS_DROP.filter((o) => o.donjon && boutique.tombeDans(o, quel));
    return this._tireDuLot(lot, rarete, alea);
  }

  /**
   * Une piece qui a fini sa minute au sol sans etre ramassee redescend du
   * registre.
   *
   * Sans ce retour, le plafond se viderait tout seul : quatre reliques tombees
   * dans un coin desert, et plus jamais une seule, alors que personne n'en a
   * recu une. C'est exactement le raisonnement de la mort d'un personnage —
   * ce qui sort du monde doit pouvoir y revenir.
   */
  rendButin(itemId) {
    return this._recycle(itemId, 1);
  }

  /** Un objet ramasse entre dans le sac, s'il y reste une place. */
  prendDuSol(addr, itemId) {
    const id = Number(itemId);
    const o = boutique.item(id);
    if (!o) throw new Error('Unknown item');
    if (this.sacRempli(addr) >= SAC_CASES) {
      throw new Error('Your backpack is full — ' + SAC_CASES + ' slots, one item each');
    }
    const p = this._p(addr);
    p.sac = p.sac || {};
    p.sac[id] = (p.sac[id] || 0) + 1;
    return { item: id, nom: o.nom, rarete: o.rarete };
  }

  /**
   * Une FIOLE du sac s'en va au sol.
   *
   * Elle n'a pas d'identifiant de catalogue — c'est une stat, pas un objet —
   * donc `poseAuSol` ne pouvait pas la prendre : `Number('att')` vaut NaN. On
   * pouvait ramasser une fiole et ne plus jamais s'en defaire autrement qu'en
   * la buvant, et un sac de huit places dont une case ne se vide pas est un
   * sac de sept places.
   *
   * Le retour a la MEME forme que sous un monstre : c'est ainsi que le sol
   * les porte, et c'est ainsi que le ramassage sait les reprendre.
   */
  poseFioleAuSol(addr, stat) {
    const st = String(stat || '');
    if (personnages.STATS.indexOf(st) < 0) throw new Error('Unknown stat');
    const p = this._p(addr);
    p.sacFioles = p.sacFioles || {};
    if (!(p.sacFioles[st] > 0)) throw new Error('That one is not in your backpack');
    p.sacFioles[st] -= 1;
    if (p.sacFioles[st] <= 0) delete p.sacFioles[st];
    p.sacCases = null;   // la case se libere : on laisse la liste se refaire
    return { stat: st };
  }

  /* ====================================================================
   * LES FAMILIERS
   * ====================================================================
   *
   * Un oeuf s'ouvre UNE fois et donne un familier. Le familier ne meurt
   * jamais : ni quand son porteur meurt dans le monde vert, ni quand il tombe
   * dans le rouge. C'est la promesse faite au joueur, et elle tient a une
   * seule chose — le familier ne vit pas sur le personnage, il vit sur le
   * COMPTE. Le poser sur `p.persos[skin]` l'aurait fait disparaitre avec le
   * personnage, et « a vie » serait devenu « jusqu'a la prochaine lave ».
   *
   * Un familier par espece, pas un par oeuf : ouvrir un deuxieme oeuf de feu
   * ne donne pas un second chien de feu, il fait progresser celui qu'on a.
   * Sinon la collection deviendrait un inventaire a gerer, et le mot
   * « familier » ne voudrait plus rien dire.
   */
  ouvreOeuf(addr, espece) {
    const es = String(espece || '');
    if (!monde.OEUFS.includes(es)) throw new Error('Unknown egg');
    const p = this._p(addr);
    p.sacOeufs = p.sacOeufs || {};
    if (!(p.sacOeufs[es] > 0)) throw new Error('You have no ' + (NOM_OEUF[es] || 'egg'));
    p.familiers = p.familiers || {};
    /* ---- ON N'ECLOT PAS DEUX FOIS LA MEME ESPECE ----
     *
     * Le doublon nourrissait le familier qu'on avait. C'etait la reponse a une
     * question qui n'existe plus : « que faire d'un oeuf inutile ? ». Il n'est
     * plus inutile — il se range au coffre, et il se VEND.
     *
     * Et le refus arrive AVANT que l'oeuf ne quitte le sac. C'est le seul
     * ordre acceptable : un refus qui aurait deja consomme l'oeuf detruirait
     * la chose la plus rare du jeu pour un geste que le joueur n'a pas voulu.
     */
    if (p.familiers[es]) {
      throw new Error('You already have ' + (NOM_FAMILIER[es] || 'that pet') +
                      ' — store the egg in your vault or sell it');
    }
    /* ET MAINTENANT SEULEMENT, il quitte le sac. */
    p.sacOeufs[es] -= 1;
    if (p.sacOeufs[es] <= 0) delete p.sacOeufs[es];
    p.sacCases = null;
    /* Pas de `niveau` range ici : il se deduit de l'XP (voir familierPour).
       L'ecrire aurait cree le deuxieme chiffre qu'on cherche justement a ne
       pas avoir. */
    p.familiers[es] = { xp: 0, ne: Math.floor(Date.now() / 1000) };
    return { espece: es, nouveau: true, familier: this.familierPour(p.familiers[es], es) };
  }

  /** La fiche d'un familier, telle que la page la lit. */
  familierPour(f, espece) {
    if (!f) return null;
    const xp = Math.max(0, f.xp | 0);
    /* Le niveau se DEDUIT — il n'est pas relu depuis la sauvegarde. Les
       anciennes fiches en portent un ; l'ignorer les repare toutes seules
       plutot que de trainer un chiffre qui peut mentir. */
    const niveau = niveauFamilier(xp);
    const prochain = niveau >= NIVEAU_MAX_FAM ? null : paliersFamilier(niveau + 1);
    return { espece, nom: NOM_FAMILIER[espece] || 'Pet',
             niveau, xp,
             /* De quoi peindre une barre SANS refaire le calcul cote page :
                les deux bornes du palier courant, et le prix du repas. Une
                seconde formule dans le navigateur finirait par promettre un
                niveau qui n'arrive pas. */
             xpBas: paliersFamilier(niveau), xpHaut: prochain,
             max: niveau >= NIVEAU_MAX_FAM,
             prixRepas: niveau >= NIVEAU_MAX_FAM ? null : prixRepas(niveau),
             pouvoir: pouvoirFamilier(espece),
             /* Ce que son pouvoir vaut A CE NIVEAU-LA. Le panneau montre donc
                ce que le prochain repas achete, au lieu d'un niveau qui monte
                sans qu'on voie quoi que ce soit changer. La formule est au
                monde ; la page n'en tient pas de copie. */
             effet: monde.familierEffet(
               (monde.POUVOIR_PAR_ESPECE || {})[espece], niveau),
             /* ---- ET CE QUE LE NIVEAU SUIVANT DONNE ----
              * Le niveau achete de la FREQUENCE. Sans ce chiffre, le panneau
              * montre une barre qui se remplit sans jamais dire vers quoi —
              * et le repas devient un geste qu'on fait sans savoir pourquoi.
              * Il vient du serveur comme le reste : une seconde formule dans
              * la page finirait par promettre une cadence qui n'arrive pas. */
             suivant: niveau >= NIVEAU_MAX_FAM ? null : monde.familierEffet(
               (monde.POUVOIR_PAR_ESPECE || {})[espece], niveau + 1),
             /* ---- SES DEUX GESTES, OUVERTS OU NON ----
              *
              * Le panneau montre AUSSI ce qui est encore ferme, avec le
              * niveau qui l'ouvre. C'est le seul endroit ou le joueur peut
              * apprendre qu'il y a autre chose a aller chercher : un pouvoir
              * qu'on ne voit pas ne se merite pas, et la courbe de nourriture
              * demande une raison d'y croire.
              *
              * La liste vient du MONDE, phrase comprise : deux tables — l'une
              * qui nomme, l'autre qui agit — auraient fini par annoncer un
              * pouvoir et en appliquer un autre. */
             pouvoirs: (monde.pouvoirsDe ? monde.pouvoirsDe(espece, niveau) : [])
               .map((p) => ({ ...p, nom: NOM_POUVOIR_FAMILIER[p.cle] || p.cle })) };
  }

  /* ---- LES REGLES DU REPAS, TELLES QUE LA PAGE LES ANNONCE ----
   * Elles partent d'ICI. Une page qui ecrirait « Common and Rare only » de
   * son cote continuerait de le promettre le jour ou l'on ouvre l'epique, et
   * un joueur se ferait refuser un repas sans comprendre pourquoi. */
  static reglesFamilier() {
    return { rarete: Object.keys(REPAS_XP), xp: { ...REPAS_XP },
             niveauMax: NIVEAU_MAX_FAM };
  }

  /* ---- CELUI QUI TROTTE DERRIERE ----
   *
   * Un seul familier sort a la fois. Les six a la queue leu leu auraient fait
   * du hall une fourriere, et surtout : le jour ou ils se battront, six chiens
   * par joueur multiplieraient par six tout ce qu'il y a a simuler et a
   * diffuser. Un compagnon, c'est un.
   *
   * On VERIFIE qu'il est eclos avant de le rendre. Un compte qui aurait garde
   * la cle d'un familier disparu — une espece retiree, une sauvegarde
   * bricolee — ferait chercher a la page un dessin qui n'existe pas. */
  familierActifDe(addr) {
    const p = this._p(addr);
    const a = p.familierActif || null;
    if (!a || !p.familiers || !p.familiers[a]) return null;
    return a;
  }

  /** Le niveau du familier SORTI, ou 1. La simulation le demande a chaque
      entree : ce que son pouvoir vaut en depend, et le recalculer la-bas
      aurait mis la courbe a deux endroits. */
  niveauFamilierDe(addr) {
    const es = this.familierActifDe(addr);
    if (!es) return 1;
    const p = this._p(addr);
    return niveauFamilier((p.familiers[es] || {}).xp);
  }

  /** Choisir lequel sort. `null` les renvoie tous a l'enclos. */
  sortFamilier(addr, espece) {
    const p = this._p(addr);
    if (espece === null || espece === undefined || espece === '') {
      p.familierActif = null;
      return { actif: null };
    }
    const es = String(espece);
    if (!monde.OEUFS.includes(es)) throw new Error('Unknown pet');
    p.familiers = p.familiers || {};
    if (!p.familiers[es]) throw new Error('You have not hatched that one');
    p.familierActif = es;
    return { actif: es };
  }

  /** L'or DEJA acquis — celui qu'on peut depenser. Pas celui que le
      personnage vivant rapportera : celui-la n'est verse qu'a sa mort, et le
      confondre avec l'autre laisserait payer avec une somme qu'on n'a pas. */
  orDe(addr) { return this._p(addr).fame || 0; }

  /* ---- LE REPAS ----
   *
   * On donne une piece du SAC, jamais du coffre : ce qu'on nourrit, c'est du
   * butin qu'on rapporte, pas ce qu'on a range. Prendre au coffre aurait
   * aussi rendu possible de vider un coffre entier sans jamais sortir du
   * hall — l'inverse exact de ce qui doit faire marcher les gens.
   *
   * TOUT est verifie avant que quoi que ce soit ne bouge. Retirer la piece
   * puis s'apercevoir que l'or manque aurait detruit un objet pour rien, et
   * c'est le genre de perte dont un joueur ne se remet pas.
   */
  nourritFamilier(addr, espece, itemId) {
    const p = this._p(addr);
    const es = String(espece || '');
    p.familiers = p.familiers || {};
    const f = p.familiers[es];
    if (!f) throw new Error('You have not hatched that one');

    const fiche = this.familierPour(f, es);
    if (fiche.max) throw new Error(fiche.nom + ' is already at max level');

    const id = Number(itemId);
    const o = boutique.item(id);
    if (!o) throw new Error('Unknown item');
    p.sac = p.sac || {};
    if (!(p.sac[id] > 0)) throw new Error('That one is not in your backpack');

    /* Toutes les raretes nourrissent — la garde de couverture au chargement
       le garantit. Ce qui reste ici ne peut donc arriver que si l'objet porte
       une rarete inconnue de la table des raretes : une faute de frappe dans
       un catalogue, pas un refus de regle. On le DIT comme tel plutot que de
       laisser croire au joueur qu'il a mal choisi. */
    const gagne = REPAS_XP[o.rarete];
    if (!(gagne > 0)) {
      throw new Error('Unknown rarity on that item: ' + o.rarete);
    }
    const prix = fiche.prixRepas;
    const or = p.fame || 0;
    if (or < prix) throw new Error('Need ' + prix + ' gold — you have ' + Math.floor(or));

    /* ---- ET MAINTENANT SEULEMENT, ON TOUCHE ---- */
    p.sac[id] -= 1;
    if (p.sac[id] <= 0) delete p.sac[id];
    /* ---- LA PIECE MANGEE REDESCEND DU REGISTRE ----
     *
     * Elle est DETRUITE, exactement comme celle qu'on perd en mourant. Sans ce
     * retour, elle restait comptee comme existante pour toujours : un familier
     * mene au niveau 100 mange plus de mille pieces communes, et la table de
     * butin du monde n'en contient que huit mille. Sept familiers suffisaient
     * a fermer le robinet des communes pour TOUT LE MONDE — `tireButin` rend
     * `null` une fois le lot sature — pendant que le panneau continuait
     * d'annoncer « il en reste mille » sur des pieces mangees depuis
     * longtemps. */
    this._recycle(id, 1);
    /* Les cases se reparent d'elles-memes au prochain `_casesDuSac` : une
       case qui montre une piece de plus que le compte se vide. */
    p.fame = or - prix;
    f.xp = (f.xp | 0) + gagne;

    const apres = this.familierPour(f, es);
    return { familier: apres, gagne, prix, or: p.fame,
             /* « Il a monte » est une question de la PAGE : elle en fait un
                son et une couleur. La lui faire recalculer en comparant deux
                fiches serait lui demander de connaitre la courbe. */
             monte: apres.niveau > fiche.niveau, item: id };
  }

  /** Tous les familiers d'un compte, pour le panneau. */
  familiersDe(addr) {
    const p = this._p(addr);
    const actif = this.familierActifDe(addr);
    const out = [];
    for (const es of monde.OEUFS) {
      if (!p.familiers || !p.familiers[es]) continue;
      const f = this.familierPour(p.familiers[es], es);
      /* Lequel est dehors : le panneau doit pouvoir le montrer sans redemander
         l'information dans un second message. */
      f.actif = es === actif;
      out.push(f);
    }
    return out;
  }

  /* ================== LE COFFRE A OEUFS ==================
   *
   * Le sac a huit places et on le perd en mourant. Un oeuf qu'on ne peut plus
   * faire eclore — parce qu'on a deja l'animal — n'avait donc que deux
   * sorts : occuper une place jusqu'a la prochaine mort, ou etre jete. Les
   * deux reviennent a detruire la chose la plus rare du jeu.
   *
   * Il a maintenant sa reserve, au coffre, avec le reste de ce qu'on garde.
   * Elle est SANS LIMITE de place, et c'est deliberé : le sac compte des
   * places parce qu'emporter du butin doit couter quelque chose ; le coffre
   * ne compte rien parce qu'y ranger ne coute rien. Ajouter un plafond ici
   * n'aurait produit qu'une seule chose — des joueurs qui jettent des oeufs.
   */
  oeufsDuCoffre(addr) {
    /* DERIVE, jamais recalcule. La vue du coffre et la vue complete
       repondaient a la meme question par deux boucles differentes : le jour
       ou l'une aurait change, l'autre aurait continue de dire l'ancienne
       reponse, et le joueur aurait vu deux comptes pour un seul coffre. */
    return this.oeufsDuJoueur(addr)
      .filter((x) => x.coffre > 0)
      .map((x) => ({ espece: x.espece, nom: x.nom, cle: x.cle,
                     quantite: x.coffre, eclos: x.eclos }));
  }

  /**
   * LES OEUFS D'UN COMPTE, LES DEUX MOITIES ENSEMBLE.
   *
   * Le sac ET le coffre, par espece, en UNE seule reponse. Deux accesseurs —
   * l'un pour le sac, l'autre pour le coffre — auraient laisse la page les
   * demander a deux moments differents et les afficher dans deux etats
   * differents ; et c'est exactement ce qui s'etait passe : le coffre etait
   * envoye a chaque message, le sac presque jamais, et le rayon des animaux
   * dessinait des oeufs vieux de plusieurs secondes.
   *
   * On rend meme les especes qu'on n'a nulle part ? Non : filtrees. Une liste
   * de six lignes dont quatre vides ne dit rien de plus qu'une liste de deux,
   * et elle coute une place a l'ecran a chaque fois.
   *
   * Meme forme que `fiolesPour` — `sac` et `coffre` cote a cote — parce que
   * c'est la meme question posee sur une autre chose, et que la page a deja
   * appris a la lire.
   */
  oeufsDuJoueur(addr) {
    const p = this._p(addr);
    const sac = p.sacOeufs || {}, coffre = p.coffreOeufs || {};
    return monde.OEUFS.map((es) => ({
      espece: es, nom: NOM_OEUF[es] || 'Egg', cle: 'oeuf_' + es,
      sac: Math.max(0, sac[es] | 0), coffre: Math.max(0, coffre[es] | 0),
      /* Ce qu'on peut en faire, dit par le SERVEUR : c'est lui qui sait si
         l'animal est deja eclos, et la page ne doit pas avoir a le deduire
         d'une seconde liste. */
      eclos: !!(p.familiers || {})[es],
    })).filter((x) => x.sac > 0 || x.coffre > 0);
  }

  /** Du sac au coffre. */
  rangeOeuf(addr, espece) {
    const es = String(espece || '');
    if (!monde.OEUFS.includes(es)) throw new Error('Unknown egg');
    const p = this._p(addr);
    p.sacOeufs = p.sacOeufs || {};
    if (!(p.sacOeufs[es] > 0)) throw new Error('That one is not in your backpack');
    p.sacOeufs[es] -= 1;
    if (p.sacOeufs[es] <= 0) delete p.sacOeufs[es];
    p.sacCases = null;
    p.coffreOeufs = p.coffreOeufs || {};
    p.coffreOeufs[es] = (p.coffreOeufs[es] | 0) + 1;
    return { espece: es, coffre: p.coffreOeufs[es] };
  }

  /** Et du coffre au sac. */
  sortOeuf(addr, espece) {
    const es = String(espece || '');
    if (!monde.OEUFS.includes(es)) throw new Error('Unknown egg');
    const p = this._p(addr);
    p.coffreOeufs = p.coffreOeufs || {};
    if (!(p.coffreOeufs[es] > 0)) throw new Error('That one is not in your vault');
    /* ---- LE SAC PEUT ETRE PLEIN ----
     * On verifie AVANT de retirer du coffre. L'ordre inverse ferait
     * disparaitre l'oeuf entre les deux : sorti du coffre, refuse par le sac,
     * nulle part. C'est la faute la plus chere du jeu et elle ne coute qu'une
     * ligne a eviter. */
    if (this.sacRempli(addr) >= monde.SAC.cases && !(p.sacOeufs || {})[es]) {
      throw new Error('Your backpack is full');
    }
    p.coffreOeufs[es] -= 1;
    if (p.coffreOeufs[es] <= 0) delete p.coffreOeufs[es];
    p.sacOeufs = p.sacOeufs || {};
    p.sacOeufs[es] = (p.sacOeufs[es] | 0) + 1;
    p.sacCases = null;
    return { espece: es, sac: p.sacOeufs[es] };
  }

  /** Un oeuf du sac s'en va au sol. Meme geste que la fiole, meme forme. */
  poseOeufAuSol(addr, espece) {
    const es = String(espece || '');
    if (!monde.OEUFS.includes(es)) throw new Error('Unknown egg');
    const p = this._p(addr);
    p.sacOeufs = p.sacOeufs || {};
    if (!(p.sacOeufs[es] > 0)) throw new Error('That one is not in your backpack');
    p.sacOeufs[es] -= 1;
    if (p.sacOeufs[es] <= 0) delete p.sacOeufs[es];
    p.sacCases = null;
    return { oeuf: es };
  }

  /** Et du sol au sac. */
  prendOeuf(addr, espece) {
    const es = String(espece || '');
    if (!monde.OEUFS.includes(es)) throw new Error('Unknown egg');
    if (this.sacRempli(addr) >= SAC_CASES) {
      throw new Error('Your backpack is full — ' + SAC_CASES + ' slots, one item each');
    }
    const p = this._p(addr);
    p.sacOeufs = p.sacOeufs || {};
    p.sacOeufs[es] = (p.sacOeufs[es] || 0) + 1;
    return { oeuf: es };
  }

  /**
   * Un objet du sac s'en va au sol.
   *
   * On ne verifie PAS qu'il est porte : un objet porte n'est pas dans le sac,
   * il est sur le personnage. C'est `sortDuCoffre` qui doit s'en soucier,
   * parce que lui va chercher dans le coffre ou dorment les pieces portees.
   */
  poseAuSol(addr, itemId) {
    const id = Number(itemId);
    const o = boutique.item(id);
    if (!o) throw new Error('Unknown item');
    const p = this._p(addr);
    p.sac = p.sac || {};
    if (!(p.sac[id] > 0)) throw new Error('That one is not in your backpack');
    p.sac[id] -= 1;
    if (p.sac[id] <= 0) delete p.sac[id];
    p.sacCases = null;   // la case se libere : on laisse la liste se refaire
    /* La MEME fiche que pour une piece qui tombe d'un monstre : au sol, une
       piece posee par un joueur et une piece lachee par un colosse doivent se
       survoler pareil. */
    return this.ficheAuSol(o);
  }

  /* ====================================================================
   * MOURIR DANS LA CARTE ROUGE : ON PERD SA SORTIE, PAS SON COMPTE
   * ====================================================================
   *
   * `meurt` detruit l'equipement porte, vide le coffre du personnage et remet
   * le niveau a zero. C'est la regle du monde vert, et elle est juste : ce qui
   * vous tue la-bas est une creature que le jeu a posee, et vous saviez en
   * descendant dans la lave ce que vous risquiez.
   *
   * Dans la carte rouge, ce qui vous tue est QUELQU'UN. Un equipement achete
   * en $SWOGE qui change de main sur l'issue d'un affrontement entre deux
   * joueurs n'est pas une regle de jeu, c'est une mise — et a trente-neuf
   * joueurs, trois bons possederaient toutes les reliques en deux semaines,
   * apres quoi plus personne n'entrerait. On ne perd donc QUE le sac : ce
   * qu'on a ramasse pendant la sortie, qui ne coutait rien ce matin.
   *
   * Le personnage, lui, ne meurt pas : il rentre au Nexus, entier, avec son
   * niveau et son equipement. La sanction est le temps perdu et le butin
   * laisse sur place — assez pour que courir vers la sortie soit un vrai
   * choix, pas assez pour qu'une mauvaise nuit fasse quitter le jeu.
   */
  videLeSac(addr, max) {
    const p = this._p(addr);
    const plafond = Math.max(0, Math.floor(Number(max) || 0)) || 8;
    const rangs = boutique.RARETES.map((r) => r.cle);
    const lot = [];
    /* Les pieces d'equipement, une entree par EXEMPLAIRE : deux epees
       identiques font deux objets au sol, pas un objet compte deux fois — le
       ramassage prend place par place. */
    for (const id of Object.keys(p.sac || {})) {
      const o = boutique.item(Number(id));
      if (!o) continue;
      const n = Math.max(0, p.sac[id] | 0);
      for (let k = 0; k < n; k++) {
        lot.push({ id: Number(id), rang: rangs.indexOf(o.rarete), fiche: this.ficheAuSol(o) });
      }
    }
    /* Les fioles de stat portees. Elles voyagent au sol sous la forme exacte
       qu'a une fiole tombee d'un monstre — le sol n'a ainsi qu'une seule
       facon de lire une fiole.
       Rang -1 : elles passent APRES les pieces a rarete egale. Ce n'est pas
       un jugement de valeur, c'est qu'on en porte des piles et qu'une pile
       remplirait le sac au sol a elle seule. */
    for (const st of Object.keys(p.sacFioles || {})) {
      const n = Math.max(0, p.sacFioles[st] | 0);
      for (let k = 0; k < n; k++) lot.push({ stat: st, rang: -1, fiche: { stat: st } });
    }
    /* L'OEUF EN TETE. Rang au-dessus de la relique : c'est la chose la plus
       rare du jeu, et si une seule place reste au sol, c'est elle qui doit la
       prendre. Le vainqueur vient chercher ca. */
    for (const es of Object.keys(p.sacOeufs || {})) {
      const n = Math.max(0, p.sacOeufs[es] | 0);
      for (let k = 0; k < n; k++) lot.push({ oeuf: es, rang: rangs.length, fiche: { oeuf: es } });
    }

    /* ---- ON NE LACHE QUE CE QUI TIENT PAR TERRE ----
     *
     * Un sac au sol a huit places. Vider un inventaire de vingt fioles en
     * ferait DISPARAITRE douze : sorties de l'inventaire, refusees par le
     * sol, detruites sans un mot — la faute la plus chere du jeu, et la plus
     * facile a ecrire sans s'en apercevoir.
     *
     * On trie donc par rarete DECROISSANTE et l'on ne sort que ce qui tient.
     * Le reste ne quitte jamais le sac. Le vainqueur emporte ce qu'il y avait
     * de mieux, ce qui est exactement ce qu'on veut qu'il vienne chercher. */
    lot.sort((a2, b2) => b2.rang - a2.rang);
    const tombe = [];
    for (const e of lot.slice(0, plafond)) {
      if (e.oeuf) {
        p.sacOeufs[e.oeuf] -= 1;
        if (p.sacOeufs[e.oeuf] <= 0) delete p.sacOeufs[e.oeuf];
      } else if (e.stat) {
        p.sacFioles[e.stat] -= 1;
        if (p.sacFioles[e.stat] <= 0) delete p.sacFioles[e.stat];
      } else {
        p.sac[e.id] -= 1;
        if (p.sac[e.id] <= 0) delete p.sac[e.id];
      }
      tombe.push(e.fiche);
    }
    p.sacCases = null;
    /* Les potions de soin ne tombent PAS. Elles se comptent par centaines, et
       une mort en poserait quatre-vingt-dix au sol : le sac au sol serait
       plein de consommables et le vainqueur n'aurait de place pour rien
       d'autre. Ce qui se dispute, ce sont les pieces. */
    return tombe;
  }

  /** Boire. Rend ce qu'il faut RENDRE — la vie appartient au monde, pas a ce
      fichier, et c'est server.js qui la pose sur le joueur en jeu. */
  boitPotion(addr, cle) {
    const t = POTIONS[cle];
    if (!t) throw new Error('Unknown potion');
    const p = this._p(addr);
    p.potions = p.potions || {};
    if (!(p.potions[cle] > 0)) throw new Error('You have no ' + t.nom);
    p.potions[cle] -= 1;
    if (!p.potions[cle]) delete p.potions[cle];
    return { cle, quoi: t.quoi, soigne: t.soigne, reste: p.potions[cle] || 0 };
  }

  /** Combien d'objets le sac porte, toutes lignes confondues. */
  /* ====================================================================
   * LES FIOLES DE STAT NE SE BOIVENT PLUS EN LES RAMASSANT
   * ====================================================================
   *
   * Une fiole trouvee etait bue sur place, tout de suite, sans qu'on ait rien
   * demande. Deux consequences, et les deux sont mauvaises :
   *
   *   - a son plafond, elle etait REFUSEE et restait par terre jusqu'a la fin
   *     de sa minute. Une potion trouvee dans la lave se perdait parce qu'on
   *     avait deja bu six defenses ;
   *   - et il n'existait aucun moyen d'en garder une pour le personnage
   *     suivant. Elles meurent avec celui qui les boit — c'est voulu — mais
   *     rien ne permettait de les mettre a l'abri AVANT de boire.
   *
   * Elles occupent donc une place du sac, comme une piece, et le coffre en
   * garde une reserve. Boire devient un geste : un double-clic, pas un pas de
   * cote.
   *
   * ---- comment une fiole tient dans un sac fait pour des identifiants ----
   *
   * `p.sac` compte des objets du CATALOGUE, par identifiant. Une fiole n'en
   * est pas un et ne doit pas en devenir un : lui donner un identifiant de
   * boutique la ferait entrer dans les plafonds de saison, les statistiques de
   * rarete et le rachat, ou elle n'a rien a faire.
   *
   * Elle vit donc a cote, dans `p.sacFioles` — {stat: nombre} — et les CASES
   * du sac portent soit un identifiant (un nombre), soit la chaine
   * « st:<stat> ». Deux formes dans une meme liste, c'est un test de plus a
   * chaque lecture ; une seule liste, c'est une seule verite sur ce que
   * contient le sac, et huit places qui restent huit.
   */
  sacRempli(addr) {
    const p = this._p(addr);
    const sac = p.sac || {};
    /* ---- LES FIOLES DE STAT N'Y SONT PLUS ----
     * Elles ont leur propre reserve (monde.FIOLE_PILE), a cote du sac, comme
     * les potions de soin. Les compter ici bornait le nombre de STATS
     * differentes qu'on pouvait porter a ce qui restait de sac : avec quatre
     * pieces d'equipement, on portait quatre sortes de fioles et pas une de
     * plus.
     * Ce compte doit dire la meme chose que `_casesDuSac`, sinon le refus
     * « sac plein » tombe alors qu'il reste des cases vides a l'ecran. */
    const oeufs = p.sacOeufs || {};
    return Object.keys(sac).reduce((n, id) => n + Math.max(0, sac[id] | 0), 0)
         + Object.keys(oeufs).reduce((n, k) => n + (oeufs[k] > 0 ? 1 : 0), 0);
  }

  /** Les fioles de stat mises a l'ABRI. Elles survivent a la mort — c'est
      toute la raison d'etre du coffre — et ne comptent pas dans les huit
      places du sac. */
  fiolesPour(addr) {
    const p = this._p(addr);
    const coffre = p.fioles || {}, sac = p.sacFioles || {};
    return personnages.STATS.map((s, i) => ({
      cle: s, coffre: Math.max(0, coffre[s] | 0), sac: Math.max(0, sac[s] | 0),
      /* Sa colonne sur la planche des fioles, et combien il y en a. La page
         devait sinon connaitre l'ordre des huit stats, et cet ordre n'existe
         chez elle que dans le monde de combat. */
      col: i, cols: personnages.STATS.length,
      pas: personnages.supPas(s),
    })).filter((x) => x.coffre > 0 || x.sac > 0);
  }

  /** Ramasser une fiole : elle prend une place, elle ne se boit pas. */
  prendFiole(addr, stat) {
    if (personnages.STATS.indexOf(stat) < 0) throw new Error('Unknown stat');
    const p = this._p(addr);
    p.sacFioles = p.sacFioles || {};
    /* Le seul plafond est celui de SA PILE. Le refus regardait le sac entier,
       donc une fiole de defense de plus etait refusee parce qu'une piece
       d'armure occupait une case a l'autre bout — deux choses qui n'ont plus
       rien a voir l'une avec l'autre. */
    if ((p.sacFioles[stat] || 0) >= monde.FIOLE_PILE) {
      throw new Error('You already carry ' + monde.FIOLE_PILE + ' of those');
    }
    p.sacFioles[stat] = (p.sacFioles[stat] || 0) + 1;
    return { stat };
  }

  /** Du sac au COFFRE : c'est le geste qui met a l'abri. */
  rangeFiole(addr, stat) {
    const p = this._p(addr);
    p.sacFioles = p.sacFioles || {};
    if (!(p.sacFioles[stat] > 0)) throw new Error('That one is not in your backpack');
    p.sacFioles[stat] -= 1;
    if (p.sacFioles[stat] <= 0) delete p.sacFioles[stat];
    p.fioles = p.fioles || {};
    p.fioles[stat] = (p.fioles[stat] || 0) + 1;
    p.sacCases = null;
    return { stat, coffre: p.fioles[stat] };
  }

  /**
   * TOUT RANGER, D'UN GESTE.
   *
   * Ranger huit stats une par une demandait huit clics et huit allers-retours
   * avec le serveur — et c'est le geste qu'on fait CHAQUE FOIS qu'on rentre,
   * parce que ce qu'on porte meurt avec le personnage. Un geste qu'on repete
   * a chaque retour et qui coute huit clics, c'est un geste qu'on finit par
   * ne plus faire, et une reserve entiere perdue a la mort suivante.
   *
   * UNE SEULE reponse, et pas huit messages : huit `fioleRange` a la suite,
   * c'est huit repeintures du panneau, et un echec au quatrieme laisserait la
   * moitie du travail fait sans que rien ne le dise.
   *
   * Le PLAFOND du coffre n'existe pas — c'est le sac qui est borne, pas lui.
   * Rien ne peut donc etre refuse a mi-chemin, et l'on n'a pas besoin de tout
   * verifier avant de bouger quoi que ce soit.
   *
   * On rend CE QUI A BOUGE, pas seulement « c'est fait » : la page doit
   * pouvoir dire « 12 rangees » plutot qu'un silence qui ressemble a une
   * panne quand il n'y avait rien a ranger.
   */
  rangeToutesLesFioles(addr) {
    const p = this._p(addr);
    p.sacFioles = p.sacFioles || {};
    p.fioles = p.fioles || {};
    const bouge = {};
    let total = 0;
    for (const stat of Object.keys(p.sacFioles)) {
      const q = Math.max(0, p.sacFioles[stat] | 0);
      if (!q) continue;
      p.fioles[stat] = (p.fioles[stat] || 0) + q;
      bouge[stat] = q;
      total += q;
      delete p.sacFioles[stat];
    }
    p.sacCases = null;
    return { range: bouge, total };
  }

  /** Et du coffre au sac : elle redevient perissable. */
  sortFiole(addr, stat) {
    const p = this._p(addr);
    p.fioles = p.fioles || {};
    if (!(p.fioles[stat] > 0)) throw new Error('You have none of those');
    /* Meme plafond que le ramassage, et pour la meme raison : la reserve est
       a elle, le sac ne la concerne plus. */
    p.sacFioles = p.sacFioles || {};
    if ((p.sacFioles[stat] || 0) >= monde.FIOLE_PILE) {
      throw new Error('You already carry ' + monde.FIOLE_PILE + ' of those');
    }
    p.fioles[stat] -= 1;
    if (p.fioles[stat] <= 0) delete p.fioles[stat];
    p.sacFioles = p.sacFioles || {};
    p.sacFioles[stat] = (p.sacFioles[stat] || 0) + 1;
    p.sacCases = null;
    return { stat, coffre: p.fioles[stat] || 0 };
  }

  /**
   * BOIRE une fiole qu'on possede. Du sac d'abord, du coffre ensuite : ce
   * qu'on porte est ce qui peut se perdre, donc ce qu'on consomme en premier.
   * Le plafond est verifie AVANT de retirer la fiole — sinon un refus la
   * detruirait, et c'est precisement ce qu'on cherchait a rendre impossible.
   */
  boitFiole(addr, skinId, stat) {
    const p = this._p(addr);
    const dansLeSac = (p.sacFioles || {})[stat] > 0;
    const auCoffre = (p.fioles || {})[stat] > 0;
    if (!dansLeSac && !auCoffre) throw new Error('You have none of those');
    const r = this.boitStat(addr, skinId, stat);   // leve si le plafond est atteint
    if (dansLeSac) {
      p.sacFioles[stat] -= 1;
      if (p.sacFioles[stat] <= 0) delete p.sacFioles[stat];
      p.sacCases = null;
    } else {
      p.fioles[stat] -= 1;
      if (p.fioles[stat] <= 0) delete p.fioles[stat];
    }
    return { ...r, ou: dansLeSac ? 'sac' : 'coffre' };
  }

  /** Le catalogue et l'inventaire du joueur, prets a peindre. */
  boutiqueEtat(addr, saison) {
    const p = this._p(addr);
    const saisons = this.boutiqueSaisons(addr);
    /* Une saison demandee mais fermee retombe sur la saison 1 : la page recoit
       alors une collection qu'elle a le droit de montrer, et la liste des
       saisons lui dit pourquoi l'autre n'est pas la. Rendre une erreur aurait
       laisse un panneau vide pour un cas qui n'est pas une faute. */
    let n = Number(saison) || 1;
    if (!this.boutiqueSaisonOuverte(addr, n)) n = 1;
    return { catalogue: boutique.catalogue(this.boutiqueEmis || {}, n, cfg.RACHAT_BASE),
             /* La page a besoin de la porte AVANT le clic, pas de l'erreur
                apres : un bouton qui repond « non » a un geste qu'il proposait
                est une faute d'interface, pas un garde-fou. */
             rachat: this.rachatVerrou(addr),
             inventaire: p.objets || {},
             saisons, saison: n,
             course: this.boutiqueCourse(),
             classement: this.boutiqueClassement(addr, 10, n) };
  }

  /* ======================================================================
   * LE COFFRE DU JOUR
   * ======================================================================
   *
   * Un coffre de bois offert chaque jour, sans condition et sans depot. Trois
   * regles, et la troisieme est celle qui compte :
   *
   *   1. UN PAR JOUR (jour UTC), le meme pour tout le monde ;
   *   2. IL NE S'ACCUMULE PAS. Manquer trois jours ne donne pas trois coffres.
   *      Un stock qui s'empile transforme une raison de revenir DEMAIN en une
   *      raison de revenir un jour — c'est-a-dire en rien ;
   *   3. MANQUER UN JOUR NE PUNIT PAS. Celui d'hier est perdu, celui
   *      d'aujourd'hui est la. Une serie se casse ; un cadeau quotidien, non.
   *      Sans cette regle, le joueur qui s'absente une semaine revient devant
   *      une porte fermee, et c'est le moment exact ou l'on perd quelqu'un.
   *
   * C'est le coffre de BOIS de la saison 1, jamais le dore ni le mythique :
   * l'objet offert doit valoir quelque chose sans valoir ce que les autres
   * paient.
   */
  static get COFFRE_OFFERT() { return 'bois'; }

  /** L'etat du coffre du jour, pour la page et pour la pastille. */
  coffreOffert(addr) {
    const p = this._p(addr);
    const jour = this._today();
    const c = boutique.coffre(Game.COFFRE_OFFERT);
    return {
      dispo: p.coffreOffertJour !== jour,
      coffre: Game.COFFRE_OFFERT,
      nom: c ? c.nom : Game.COFFRE_OFFERT,
      image: c ? (c.image || c.cle) : Game.COFFRE_OFFERT,
      valeur: c ? c.prix : 0,
      /* La derniere fois qu'il l'a pris. La page s'en sert pour dire « revenez
         demain » plutot que d'afficher un bouton mort. */
      prisLe: p.coffreOffertJour || null,
    };
  }

  /**
   * Ouvre le coffre du jour. Le MEME chemin que l'achat — meme tirage, memes
   * plafonds, meme registre, meme annonce — sans le debit.
   *
   * La marque est posee AVANT le tirage. Posee apres, une erreur au milieu du
   * tirage laisserait le coffre encore disponible alors qu'un objet est deja
   * sorti du stock : le joueur le reprendrait, et l'edition y perdrait une
   * piece a chaque incident.
   */
  ouvreCoffreOffert(addr) {
    const p = this._p(addr);
    const jour = this._today();
    if (p.coffreOffertJour === jour) throw new Error('today\'s free chest is already open — come back tomorrow');
    /* Le MEME plafond que la journee parfaite. Les deux sortent de la meme
       edition ; un plafond sur l'une et pas sur l'autre ne protege rien,
       il suffit de prendre l'autre. */
    if (!this._prendCoffreGratuit())
      throw new Error('today\'s free chests are all gone — come back tomorrow');
    p.coffreOffertJour = jour;
    return this.boutiqueAchat(addr, Game.COFFRE_OFFERT, { gratuit: true });
  }

  /**
   * TOUT CE QUI ATTEND LE JOUEUR, en un seul nombre.
   *
   * C'est ce que porte la pastille du bouton profil. Elle existe parce qu'une
   * recompense qu'il faut penser a aller chercher est une recompense que
   * personne ne va chercher — et parce que c'est la pastille qui ramene un
   * joueur, jamais le bouton.
   *
   * On ne compte QUE ce qui se reclame en un geste et se perd si on ne le fait
   * pas. Une quete a moitie faite n'y est pas : une pastille qui s'allume pour
   * quelque chose qu'on ne peut pas resoudre apprend a l'ignorer, et une
   * pastille ignoree ne sert plus a rien pour de bon.
   */
  enAttente(addr) {
    const p = this._p(addr);
    const coffre = this.coffreOffert(addr).dispo;
    const serie = !this._streakToday(p).claimedToday;
    let quetes = 0;
    try { quetes = this.questState(addr).filter((q) => q.done && !q.claimed).length; } catch (e) {}
    const transferts = p.trNonLus || 0;
    let parfait = false;
    try { parfait = this.parfaitEtat(addr).pret; } catch (e) {}
    return { coffre, serie, quetes, transferts, parfait,
             total: (coffre ? 1 : 0) + (serie ? 1 : 0) + quetes + (transferts ? 1 : 0) +
                    (parfait ? 1 : 0) };
  }

  /**
   * ================== LES TOUCHES, COMPTEES ==================
   *
   * Ce que les joueurs touchent vraiment, bouton par bouton. Un total pour
   * tout le monde : jamais qui a clique. La question est « quelle rangee
   * sert », pas « que fait tel joueur ».
   *
   * ---- ces nombres viennent du CLIENT, donc ils se bornent ----
   *
   * N'importe qui peut envoyer ce message a la main et annoncer un million de
   * touches sur la rangee de son choix. Le degat serait faible — ils ne
   * servent qu'a reordonner un menu — mais un chiffre qu'on sait faux ne sert
   * plus a rien du tout, et on le decouvrirait le jour ou on s'en sert.
   *
   * Trois bornes : la FORME de la clef, le NOMBRE de clefs par message, et le
   * compte par clef. Aucune ne rend le chiffre exact face a quelqu'un de
   * determine ; ensemble elles rendent le mensonge lent.
   */
  noteTaps(taps) {
    if (!taps || typeof taps !== 'object') return 0;
    this.taps = this.taps || {};
    let pris = 0;
    for (const cle of Object.keys(taps).slice(0, 60)) {
      if (!/^(menu|bar|jeu):[a-z0-9_:-]{1,40}$/.test(cle)) continue;
      const n = Math.max(0, Math.min(100, Math.floor(Number(taps[cle]) || 0)));
      if (!n) continue;
      this.taps[cle] = (this.taps[cle] || 0) + n;
      pris += n;
    }
    return pris;
  }

  /**
   * Les touches, triees, pour le panneau d'administration.
   *
   * Regroupees par FAMILLE — le tiroir, la barre du bas, les jeux — parce que
   * comparer une rangee de menu a une tuile de jeu ne veut rien dire : elles
   * n'ont ni la meme surface ni le meme nombre d'occasions d'etre touchees.
   * Le seul classement qui informe est celui d'une famille contre elle-meme.
   */
  tapsAdmin() {
    const t = this.taps || {};
    const fam = { menu: [], bar: [], jeu: [] };
    for (const cle of Object.keys(t)) {
      const i = cle.indexOf(':');
      const f = cle.slice(0, i), reste = cle.slice(i + 1);
      if (!fam[f]) continue;
      fam[f].push({ cle: reste, n: t[cle] });
    }
    const out = {};
    for (const f of Object.keys(fam)) {
      const l = fam[f].sort((a, b) => b.n - a.n);
      const total = l.reduce((a, x) => a + x.n, 0);
      out[f] = { total, lignes: l.map((x) => ({ cle: x.cle, n: x.n,
                 pct: total ? +(100 * x.n / total).toFixed(1) : 0 })) };
    }
    return out;
  }

  /**
   * Ouvre un coffre. Debite, tire, range l'objet, et rend de quoi refaire le
   * calcul soi-meme une fois la graine du serveur revelee.
   */
  boutiqueAchat(addr, cle, options) {
    const gratuit = !!(options && options.gratuit);
    const c = boutique.coffre(cle);
    if (!c) throw new Error('unknown chest');
    /* LA PORTE, AVANT LE DEBIT. Elle est ici et pas dans la page : la page ne
       peut que cacher un bouton, et un message se refabrique a la main. */
    if (!this.boutiqueSaisonOuverte(addr, c.saison)) {
      const l = this.boutiqueLignes || [];
      throw new Error('season ' + c.saison + ' opens when the season ' + (c.saison - 1) +
                      ' race ends — ' + l.length + ' of ' + boutique.PRIX_LIGNE.length +
                      ' lines completed');
    }
    const p = this._p(addr);
    const prix = WEI(c.prix);
    /* Le coffre offert emprunte TOUT le reste du chemin — meme tirage, memes
       plafonds, meme registre, meme annonce. Seul le debit saute. Un second
       chemin de tirage serait un second endroit ou les plafonds peuvent se
       tromper, et personne ne le verrait avant qu'un objet sorte en trop. */
    if (!gratuit) {
      if (p.balance.lt(prix)) throw new Error('not enough $SWOGE');
      p.balance = p.balance.sub(prix);
      this._bumpDay(p); p.dayNet = p.dayNet.sub(prix);
    }

    /* `:shop:` separe ce tirage de tous les autres. Sans cette marque, un
       coffre et un lancer du Coin Pusher tires au MEME numero par le meme
       joueur donneraient la meme empreinte — et deux jeux qui partagent leur
       hasard ne sont plus verifiables independamment. */
    const nonce = p.nonce;
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':shop:' + nonce).digest('hex');
    p.nonce++;

    this.boutiqueEmis = this.boutiqueEmis || {};
    const t = boutique.tire(h, cle, this.boutiqueEmis);
    p.objets = p.objets || {};
    /* NEUF OU DOUBLON : la question se pose AVANT de ranger l'objet, c'est le
       seul instant ou la reponse existe encore.
     *
     * ---- POURQUOI DEUX QUESTIONS ET PAS UNE ----
     *
     * `neuf` dit « je ne l'ai pas en main » ; `premiere` dit « je ne l'ai
     * JAMAIS eu ». Tant que rien ne sortait de l'inventaire, les deux etaient
     * la meme phrase. Le rachat instantane les separe : on vend l'objet, il
     * quitte l'inventaire, et le prochain tirage le rendrait « neuf » une
     * deuxieme fois. Payer l'XP sur `neuf` ouvrirait alors une boucle —
     * tirer, revendre, retirer — dont le cout est un coffre et le gain une
     * XP deja touchee.
     *
     * `xpObjets` est le meme registre que `xpFilleuls` : la marque de ce qui
     * a deja paye. La condition garde `!p.objets[...]` DEVANT, et c'est ce qui
     * evite une migration : un joueur qui possede deja l'objet echoue sur le
     * premier terme, meme si son registre est vide parce qu'il date d'avant. */
    const neuf = !p.objets[t.item.id];
    p.xpObjets = p.xpObjets || {};
    const premiere = neuf && !p.xpObjets[t.item.id];
    p.objets[t.item.id] = (p.objets[t.item.id] || 0) + 1;
    /* Le compteur global monte ICI, au meme instant que l'inventaire. Les
       deux ne peuvent pas diverger : il n'y a pas de chemin entre les deux
       lignes ou une erreur puisse s'inserer. */
    this.boutiqueEmis[t.item.id] = (this.boutiqueEmis[t.item.id] || 0) + 1;

    /* Un coffre offert n'est pas du revenu : le compter fausserait le chiffre
       d'affaires et, par ricochet, le prix du classement qui en est une part. */
    if (!gratuit) this.note('boutique', c.prix, addr);

    /* La ligne vient-elle de se completer ? On regarde APRES avoir range
       l'objet : c'est le seul instant ou la reponse peut changer. */
    /* `boutiqueAchat` ne recoit pas d horloge — les autres jeux en passent une
       pour etre rejouables, celui-ci n en a pas besoin : le tirage vient du
       HMAC, pas du temps. L horodatage du gagnant est donc pris ici. */
    const ligne = this._boutiqueLigne(p, t.item, Date.now());

    /* ---- L'XP DE COLLECTION ----
     *
     * Seul un objet JAMAIS POSSEDE en donne. Payer les doublons ferait monter
     * le plus vite celui qui ouvre le plus de coffres — c'est-a-dire celui qui
     * depense le plus, et on serait revenu exactement au probleme que la
     * separation de l'XP et du volume repare.
     *
     * La famille complete paie une deuxieme fois, et sans condition de course :
     * les trois prix de la saison 1 recompensent les trois PREMIERS, l'XP
     * recompense l'exploit lui-meme, pour tout le monde et a tout moment. */
    /* Les quetes de collection lisent ces trois-la. Le rang de rarete est
       garde au MAXIMUM du jour et non au dernier tire : « sors un rare »
       serait sinon annule par le commun suivant. */
    this._bumpDay(p);
    p.jourColl = p.jourColl || { coffres: 0, neufs: 0, rarete: 0 };
    p.jourColl.coffres++;
    if (neuf) p.jourColl.neufs++;
    const rangR = boutique.RARETES.findIndex((r) => r.cle === t.item.rarete);
    if (rangR > (p.jourColl.rarete || 0)) p.jourColl.rarete = rangR;

    let xpGagne = 0;
    if (premiere) {
      p.xpObjets[t.item.id] = 1;
      const r = xpDeRarete(t.item.rarete);
      const g = this._gagneXp(p, r, 'collection');
      if (g) xpGagne += g.gagne;
    }
    /* ---- LA FAMILLE A SON PROPRE REGISTRE ----
     *
     * Elle ne peut pas se raccrocher a `premiere`. Un joueur qui a revendu une
     * piece puis la retire completerait sa famille pour la PREMIERE fois sur
     * un tirage qui n'est pas une premiere : le bonus ne serait jamais verse a
     * quelqu'un qui l'a pourtant merite. On demande donc a la famille ce qu'on
     * demande a l'objet — a-t-elle deja paye — et on le lui demande a elle.
     *
     * `xpFamilles` est reconstitue a la lecture du fichier pour les fiches
     * d'avant (voir `hydrate`) : celui qui possede la famille entiere a
     * forcement deja touche le bonus, puisqu'il se verse a l'instant ou elle
     * se complete. */
    if (neuf) {
      const fam = boutique.ITEMS.filter((o) => o.famille === t.item.famille);
      p.xpFamilles = p.xpFamilles || {};
      if (fam.length && !p.xpFamilles[t.item.famille] && fam.every((o) => p.objets[o.id])) {
        p.xpFamilles[t.item.famille] = 1;
        const gf = this._gagneXp(p, cfg.XP_FAMILLE, 'famille');
        if (gf) xpGagne += gf.gagne;
      }
    }

    return { coffre: c.cle, coffreNom: c.nom, prix: c.prix,
             coffreImage: c.image || c.cle, saison: c.saison, gratuit,
             neuf, xp: xpGagne, niveau: this.niveauDeFiche(p),
             ligne,
             item: t.item, rarete: t.rarete,
             quantite: p.objets[t.item.id],
             emis: this.boutiqueEmis[t.item.id],
             plafond: boutique.rarete(t.item.rarete).plafond,
             epuise: t.epuise,
             balance: this.balanceStr(addr),
             preuve: { sh: this.serverSeedHash, cs: p.clientSeed, n: nonce, r1: t.r1, r2: t.r2 } };
  }

  // ---------------------------------------------------------- les duels 1v1
  /*
   * Connect 4, morpion et dames partagent EXACTEMENT le meme argent : on mise
   * a la creation ou a l'entree, la somme ne revient qu'a la fin, et le pot
   * est partage de la meme facon. Il n'y a donc qu'un seul chemin d'argent
   * pour les trois — et pas trois copies qui divergeraient au premier
   * correctif.
   *
   * Ce qui change d'un jeu a l'autre tient dans le moteur de regles et dans
   * quelques reglages (mises, pendule). Le moteur est designe par la partie
   * elle-meme (`partie.jeu`), donc rejoindre, jouer, abandonner et regler
   * n'ont meme pas besoin de savoir a quel jeu ils ont affaire : l'identifiant
   * suffit.
   */

  _duelCfg(jeu) {
    /* Le prefixe des reglages, par jeu. Une table plutot qu'une cascade de
       ternaires : le quatrieme jeu a montre que la cascade se relit mal et
       qu'on y oublie une branche. */
    const p = { mp: 'MP', dm: 'DM', mf: 'MF', dc: 'DC', p4: 'P4' }[jeu] || 'P4';
    const v = (k, d) => (cfg[p + '_' + k] !== undefined ? cfg[p + '_' + k] : d);
    return {
      min: v('MIN', cfg.P4_MIN), max: v('MAX', cfg.P4_MAX),
      coupMs: v('COUP_MS', cfg.P4_COUP_MS),
      attenteMs: v('ATTENTE_MS', cfg.P4_ATTENTE_MS),
      revancheMs: v('REVANCHE_MS', cfg.P4_REVANCHE_MS),
      rakeBps: v('RAKE_BPS', cfg.P4_RAKE_BPS),
      rakeSurNul: v('RAKE_SUR_NUL', cfg.P4_RAKE_SUR_NUL),
    };
  }
  _moteur(jeu) { return DUELS[jeu] || DUELS.p4; }

  _duelVerifie(jeu, miseRaw, addr) {
    const c = this._duelCfg(jeu);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= c.min)) throw new Error('minimum bet is ' + c.min + ' $SWOGE');
    if (mise > c.max) throw new Error('maximum bet is ' + c.max + ' $SWOGE');
    const p = this._p(addr);
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');
    return mise;
  }

  _duelDebite(addr, mise, jeu) {
    const p = this._p(addr);
    p.balance = p.balance.sub(WEI(mise));
    // dropsToday compte pour les quetes du jour. Tous les autres jeux
    // l'incrementent a la mise ; le Connect 4 l'avait oublie, et une partie
    // ne faisait donc avancer aucune quete.
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise), jeu);
  }

  _duelCredite(addr, montant) {
    if (!(montant > 0)) return;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(montant));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(montant));
  }

  /** Ouvre une table et attend un adversaire. */
  duelCreer(jeu, addr, miseRaw, now) {
    const mise = this._duelVerifie(jeu, miseRaw, addr);
    for (const m of this.p4.values())
      if (m.phase !== FINIE && m.jeton(addr)) throw new Error('you already have a match running');
    const t = now || Date.now();
    const id = jeu + (++this.p4Seq) + '-' + Math.floor(t / 1000).toString(36);
    const partie = new (this._moteur(jeu).Partie)({
      id, mise, createur: addr, now: t, coupMs: this._duelCfg(jeu).coupMs });
    this._duelDebite(addr, mise, jeu);
    this.p4.set(id, partie);
    return partie;
  }

  /* ---- QUI OUVRE LE JEU ----
   *
   * Celui qui posait la table jouait toujours le premier coup. Au Puissance 4
   * et au morpion ce n'est pas un detail : le premier joueur a un avantage
   * connu et mesurable — au Puissance 4 il gagne meme la partie parfaite.
   * Ouvrir une table revenait donc a choisir le bon cote, et l'autre payait la
   * meme mise pour le mauvais.
   *
   * LE TIRAGE SORT DE LA GRAINE DU SERVEUR, pas de Math.random. Trois raisons :
   *
   *   • aucun des deux joueurs ne peut le predire — l'identifiant de la table
   *     est fabrique ici, et la graine n'est connue de personne avant sa
   *     revelation ;
   *   • personne ne peut CHOISIR sa table : un robot qui ne rejoindrait que
   *     les parties ou il ouvre devrait deviner la graine ;
   *   • il se VERIFIE apres coup, comme le reste de la maison. La graine
   *     revelee, n'importe qui recalcule HMAC(graine, 'duel:<id>') et retrouve
   *     qui devait commencer.
   *
   * On ne consomme aucun jeton de la suite provably-fair : le tirage se derive
   * de l'identifiant seul, et ne decale donc ni les cartes ni les billes des
   * autres jeux.
   */
  _duelPremier(id) {
    const h = crypto.createHmac('sha256', this.serverSeed).update('duel:' + String(id)).digest('hex');
    return Number(BigInt('0x' + h.slice(0, 15)) % BigInt(2)) === 0 ? 1 : 2;
  }

  /** S'asseoir en face. La partie demarre a cet instant, et le tirage dit qui ouvre. */
  duelRejoindre(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    /* Sa propre table AVANT le controle general : un joueur qui clique sur sa
       propre partie a besoin d'entendre « c'est la tienne », pas « tu as deja
       une partie en cours » — qui est vrai mais n'explique rien. */
    if (partie.joueurs[0] === addr) throw new Error('you cannot join your own match');
    if (partie.reserve && partie.reserve !== addr)
      throw new Error('this rematch is reserved for another player');
    const mise = this._duelVerifie(partie.jeu || 'p4', partie.mise, addr);
    /* On ne tient qu'une partie a la fois — mais une table a soi qui attend
       encore n'est pas une partie : on la retire et on rend la mise. Sans ca,
       ouvrir une table puis en rejoindre une autre serait impossible sans
       passer par un bouton « annuler » que personne ne trouve. */
    const t = now || Date.now();
    const retirees = [];
    for (const m of this.p4.values()) {
      if (m.phase !== FINIE && m.jeton(addr)) {
        if (m.phase === ATTENTE && m.joueurs[0] === addr) { retirees.push(m); continue; }
        throw new Error('you already have a match running');
      }
    }
    for (const m of retirees) this._duelFerme(m, 'retiree', t);
    this._duelDebite(addr, mise, partie.jeu || 'p4');
    partie.rejoindre(addr, t, this._duelPremier(partie.id));
    return { partie, retirees };
  }

  /** Le createur retire sa table tant que personne ne s'est assis. */
  duelAnnuler(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    if (partie.joueurs[0] !== addr) throw new Error('this table is not yours');
    if (partie.phase !== ATTENTE) throw new Error('this match has already started');
    this._duelFerme(partie, 'retiree', now || Date.now());
    return partie;
  }

  _duelFerme(partie, raison, now) {
    this._duelRendre(partie);
    partie.phase = FINIE;
    partie.raison = raison;
    partie.finA = now;
    partie.echeance = 0;
    return partie;
  }

  /**
   * La revanche : « On remet ca ? » — avec une somme, qui n'est pas forcement
   * celle d'avant.
   *
   * L'offre EST une table, simplement nominative : le demandeur paie tout de
   * suite, comme pour n'importe quelle table, et l'autre s'assied avec
   * duelRejoindre. Si personne ne repond, l'expiration rend la mise. Rien de
   * neuf ne touche a l'argent, donc rien de neuf ne peut le perdre.
   */
  duelRevanche(addr, idPrecedent, miseRaw, now) {
    const avant = this.p4.get(String(idPrecedent));
    if (!avant) throw new Error('previous match not found');
    if (avant.phase !== FINIE) throw new Error('this match is not over yet');
    if (!avant.jeton(addr)) throw new Error('you were not in this match');
    const adversaire = avant.joueurs[avant.jeton(addr) === 1 ? 1 : 0];
    if (!adversaire) throw new Error('there is no opponent to challenge');

    const jeu = avant.jeu || 'p4';
    const mise = this._duelVerifie(jeu, miseRaw, addr);
    for (const m of this.p4.values())
      if (m.phase !== FINIE && m.jeton(addr)) throw new Error('you already have a match running');
    /* Une seule offre en attente vers le meme adversaire : sinon dix clics
       bloquent dix mises et l'autre ne peut en accepter qu'une. */
    for (const m of this.p4.values())
      if (m.phase === ATTENTE && m.reserve === adversaire && m.joueurs[0] === addr)
        throw new Error('you already sent a rematch request');

    const t = now || Date.now();
    const id = jeu + (++this.p4Seq) + '-' + Math.floor(t / 1000).toString(36);
    const partie = new (this._moteur(jeu).Partie)({
      id, mise, createur: addr, now: t, coupMs: this._duelCfg(jeu).coupMs,
      reserve: adversaire, revancheDe: avant.id });
    this._duelDebite(addr, mise, jeu);
    this.p4.set(id, partie);
    return partie;
  }

  duelJouer(addr, id, coup, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    const t = now || Date.now();
    /* ---- LA MISE PEUT MONTER EN COURS DE PARTIE ----
       Au Pierre-Feuille-Bandit, suivre une relance engage les DEUX joueurs
       pour un tour de mise de plus. On verifie donc les deux soldes AVANT que
       le coup existe : une relance acceptee qu'un joueur ne peut pas payer
       laisserait une partie a moitie financee, et il n'y a pas de reparation
       propre a ca. Le moteur annonce le cout, il ne connait aucun solde. */
    if (typeof partie.coutSi === 'function') {
      const du = partie.coutSi(addr, coup);
      if (du > 0) for (const a of partie.joueurs) {
        if (a && this._p(a).balance.lt(WEI(du)))
          throw new Error('one of you cannot cover the raise (' + du + ' $SWOGE more each)');
      }
    }
    const r = partie.jouer(addr, coup, t);
    /* Ce que le moteur a decide de prelever. On le draine tout de suite : une
       file qui traine, c'est une mise engagee que personne n'a payee. */
    if (Array.isArray(partie.aDebiter) && partie.aDebiter.length) {
      for (const d of partie.aDebiter.splice(0)) this._duelDebite(d.addr, d.montant, partie.jeu);
    }
    /* LE TIRAGE, pour les jeux qui en demandent un.
       Le moteur ne tire rien lui-meme : la graine du serveur vaut de l'argent
       tant qu'elle n'est pas revelee, et un moteur de duel finit dans l'etat
       sauvegarde. Il dit QUAND, on lui rend le resultat et de quoi le
       refaire. */
    if (typeof partie.besoinTirage === 'function' && partie.besoinTirage()) {
      const d = this._tirageDuel(partie);
      partie.revele(d.nombre, d.preuve, t);
    }
    const reglement = partie.phase === FINIE ? this._duelRegle(partie) : null;
    return { partie, coup: r, reglement };
  }

  /**
   * Un tirage de duel, refaisable par n'importe qui une fois la graine
   * revelee.
   *
   * Les DEUX choix entrent dans l'empreinte. Sans eux, le nombre ne
   * dependrait que de la graine et de l'identifiant de partie — le serveur le
   * connaitrait donc avant que les joueurs aient choisi. Avec eux, il ne peut
   * etre calcule qu'une fois les deux nombres verrouilles, par personne
   * d'autre que celui qui detient la graine, et personne ne detient la graine
   * a ce moment-la sauf le serveur, qui s'est deja engage sur son empreinte.
   */
  _tirageDuel(partie) {
    const moteur = this._moteur(partie.jeu);
    const min = moteur.MIN || 1, max = moteur.MAX || 100;
    const entree = [partie.id, partie.choix[1], partie.choix[2]].join(':');
    const h = crypto.createHmac('sha256', this.serverSeed).update(entree).digest('hex');
    const brut = parseInt(h.slice(0, 13), 16);
    return {
      nombre: min + (brut % (max - min + 1)),
      preuve: { empreinte: this.serverSeedHash, entree, hmac: h },
    };
  }

  duelAbandonner(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    partie.abandonner(addr, now || Date.now());
    return { partie, reglement: this._duelRegle(partie) };
  }

  /**
   * Le reglement. Appele UNE SEULE FOIS par partie : `regle` garde la trace,
   * sinon un abandon suivi d'un tick paierait le gagnant deux fois.
   */
  _duelRegle(partie) {
    if (partie.regle) return null;
    partie.regle = true;
    const jeu = partie.jeu || 'p4';
    const c = this._duelCfg(jeu);
    const nul = !partie.gagnant;
    const r = this._moteur(jeu).partage(partie.mise, c.rakeBps, nul, c.rakeSurNul);
    if (nul) {
      for (const a of partie.joueurs) if (a) {
        this._duelCredite(a, r.rendu);
        this._manche(this._p(a), jeu, partie.mise, r.rendu);
      }
      this._faceAFace(partie.joueurs[0], partie.joueurs[1], 'n');
    } else {
      const gagnant = partie.adresseGagnante();
      const perdant = partie.joueurs[partie.gagnant === 1 ? 1 : 0];
      this._duelCredite(gagnant, r.gain);
      const pg = this._p(gagnant);
      this._bumpDay(pg); pg.winsToday++;
      this._manche(pg, jeu, partie.mise, r.gain);
      if (perdant) this._manche(this._p(perdant), jeu, partie.mise, 0);
      this._faceAFace(gagnant, perdant, 'v');
    }
    return r;
  }

  /**
   * Le face-a-face : qui a battu qui, et combien de fois.
   *
   * Sans ce compteur, « rivalites » ne veut rien dire — on saurait qu'un
   * joueur a gagne quarante duels, jamais CONTRE QUI. Or c'est la seule
   * statistique qui donne envie de reprendre une partie, et la seule qui
   * fasse d'un adversaire quelqu'un plutot qu'une couleur.
   *
   * On le tient au reglement, le seul endroit traverse par toutes les fins de
   * partie — victoire, nulle et abandon compris.
   */
  _faceAFace(gagnant, perdant, issue) {
    if (!gagnant || !perdant || gagnant === perdant) return;
    const pose = (a, b, k) => {
      const p = this._p(a);
      if (!p.face) p.face = {};
      const c = p.face[String(b).toLowerCase()] || (p.face[String(b).toLowerCase()] = { v: 0, d: 0, n: 0 });
      c[k]++;
    };
    if (issue === 'n') { pose(gagnant, perdant, 'n'); pose(perdant, gagnant, 'n'); }
    else { pose(gagnant, perdant, 'v'); pose(perdant, gagnant, 'd'); }
  }

  /** Rend les mises : une table qu'on ferme sans avoir joue ne coute rien. */
  _duelRendre(partie) {
    if (partie.regle) return;
    partie.regle = true;
    for (const a of partie.joueurs) if (a) this._duelCredite(a, partie.mise);
  }

  /**
   * Fait avancer les parties. Renvoie ce qui a change, pour diffusion.
   * Deux echeances : le coup, et l'attente d'un adversaire — une table sans
   * preneur ne doit pas retenir une mise indefiniment.
   */
  duelTick(now) {
    const t = now || Date.now();
    const evs = [];
    for (const [id, partie] of this.p4) {
      const c = this._duelCfg(partie.jeu || 'p4');
      if (partie.phase === EN_COURS) {
        if (partie.tick(t)) evs.push({ type: 'p4Fin', partie, reglement: this._duelRegle(partie) });
      } else if (partie.phase === ATTENTE &&
                 t - partie.creeA > (partie.reserve ? c.revancheMs : c.attenteMs)) {
        /* Une revanche tient moins longtemps qu'une table ouverte : elle
           s'adresse a quelqu'un qui est encore devant son ecran, et elle
           immobilise une mise en attendant sa reponse. */
        this._duelRendre(partie);
        partie.phase = FINIE; partie.raison = 'expiree';
        evs.push({ type: 'p4Expire', partie });
      } else if (partie.phase === FINIE && t - (partie.finA || partie.creeA) > 120000) {
        this.p4.delete(id);   // on ne garde pas les parties finies plus de deux minutes
      }
    }
    return evs;
  }

  /**
   * Les tables ouvertes, pour la fenetre « rejoindre une partie ».
   * Les revanches n'y figurent pas : elles sont nominatives, et les voir
   * afficher une place qu'on ne peut pas prendre serait pire que de ne pas
   * les voir du tout.
   */
  duelLobby(jeu) {
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== ATTENTE || m.reserve) continue;
      if (jeu && (m.jeu || 'p4') !== jeu) continue;
      /* Le profil public porte le niveau, le visage et la photo : le
         vestibule les recoit donc sans avoir a les demander. */
      const q = this.profilPublic(m.joueurs[0]);
      out.push({ id: m.id, jeu: m.jeu || 'p4', mise: m.mise, createur: m.joueurs[0],
                 nom: q.name, niveau: q.niveau, palier: q.palier,
                 visage: q.visage, photo: q.photo, creeA: m.creeA });
    }
    return out.sort((a, b) => b.creeA - a.creeA);
  }

  /**
   * LES PARTIES EN COURS, pour les regarder.
   *
   * Le vestibule ne montrait que les tables qui ATTENDENT. A quatre heures du
   * matin il est vide, et une plateforme qui parait vide convertit tres mal —
   * alors qu'une partie peut tres bien etre en train de se jouer.
   *
   * Ce que ca rend possible, et qui ne coute rien : un spectateur. Il ne mise
   * pas, ne joue pas, n'existe pas pour la partie — il regarde. C'est ce qui
   * transforme un moment a deux en evenement avec public, et ce qui fait qu'une
   * page ouverte a n'importe quelle heure a quelque chose a montrer.
   */
  duelsEnCours(jeu) {
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== EN_COURS) continue;
      if (jeu && (m.jeu || 'p4') !== jeu) continue;
      const j = m.joueurs.map((a) => (a ? this.profilPublic(a) : null));
      out.push({
        id: m.id, jeu: m.jeu || 'p4', mise: m.mise, depuis: m.creeA,
        tour: m.tour,
        joueurs: j.map((q) => q && { address: q.address, nom: q.name, niveau: q.niveau,
                                     palier: q.palier, visage: q.visage, photo: q.photo }),
      });
    }
    /* Les plus grosses mises en tete : c'est ce qu'on a envie de regarder. */
    return out.sort((a, b) => (b.mise - a.mise) || (b.depuis - a.depuis));
  }

  /** Les demandes de revanche qui attendent la reponse de `addr`. */
  duelInvitations(addr, now, jeu) {
    const t = now || Date.now();
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== ATTENTE || m.reserve !== addr) continue;
      if (jeu && (m.jeu || 'p4') !== jeu) continue;
      out.push({ id: m.id, jeu: m.jeu || 'p4', mise: m.mise, de: m.joueurs[0],
                 nom: this._p(m.joueurs[0]).name, revancheDe: m.revancheDe,
                 reste: Math.max(0, this._duelCfg(m.jeu || 'p4').revancheMs - (t - m.creeA)) });
    }
    return out.sort((a, b) => a.reste - b.reste);
  }

  /** L'etat d'une partie, avec les noms — la table n'en connait pas. */
  /**
   * L'etat d'une partie, VU PAR `pour`.
   *
   * Le second parametre n'existe que pour les jeux a information cachee : Le
   * Dernier Chiffre ne doit pas descendre le nombre de l'adversaire dans la
   * page, sinon le second a choisir gagne a tous les coups en ouvrant sa
   * console. Les autres moteurs l'ignorent — leur plateau est public par
   * nature. Sans `pour`, on obtient la vue d'un SPECTATEUR, qui est la plus
   * pauvre : c'est le bon defaut, un oubli cache au lieu de reveler.
   */
  duelEtat(id, now, pour) {
    const m = this.p4.get(String(id));
    if (!m) return null;
    const e = m.etat(now || Date.now(), pour || null);
    e.jeu = m.jeu || 'p4';
    e.noms = m.joueurs.map((a) => (a ? this._p(a).name : null));
    /* Le profil PUBLIC, pas des champs recopies a la main : nom, visage, photo
       et niveau viennent tous de la meme source, donc la table montre
       exactement ce que montrent le vestibule, la liste d'amis et le
       classement. Deux sources finiraient par se contredire, et c'est celle
       qu'on a sous les yeux pendant la partie qu'on croit. */
    e.profils = m.joueurs.map((a) => (a ? this.profilPublic(a) : null));
    /* L'ancien champ reste : les pages en service le lisent encore. */
    e.visages = m.joueurs.map((a) => (a ? { visage: this._p(a).visage || null, photo: !!this._p(a).photo, address: a } : null));
    e.rakeBps = this._duelCfg(e.jeu).rakeBps;
    return e;
  }

  /**
   * Une phrase toute faite, dite a la table.
   *
   * Ce qui arrive ici est un IDENTIFIANT, jamais un texte : il n'y a donc rien
   * a filtrer, et rien qu'un joueur puisse ecrire. Un identifiant inconnu est
   * refuse — c'est ce qui garantit que la liste est vraiment fermee, et non
   * simplement celle que le client veut bien afficher.
   *
   * Seuls les DEUX joueurs parlent. Un spectateur entend la table sans jamais
   * pouvoir y parler : il n'a rien mise, et lui ouvrir la parole rouvrirait
   * a tout le monde la surface qu'on vient de fermer.
   */
  duelDire(addr, id, phraseId, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    if (partie.phase !== EN_COURS) throw new Error('this match is not running');
    const place = partie.joueurs.indexOf(addr);
    if (place < 0) throw new Error('you are not at this table');
    const phrase = (cfg.PHRASES || []).find((x) => x[0] === phraseId);
    if (!phrase) throw new Error('unknown phrase');

    const t = now || Date.now();
    if (!partie.dits) partie.dits = {};
    const d = partie.dits[addr] || (partie.dits[addr] = { t: 0, n: 0 });
    /* On plafonne AVANT d'espacer : celui qui a tout dit doit lire « vous avez
       assez parle », pas « attendez trois secondes » quinze fois de suite. */
    if (d.n >= cfg.PHRASE_MAX) throw new Error('you have said enough for this match');
    if (t - d.t < cfg.PHRASE_PAUSE_MS) throw new Error('slow down');
    d.t = t; d.n++;

    return { partie, joueur: place + 1, id: phrase[0], emote: phrase[1], texte: phrase[2],
             nom: this._p(addr).name, reste: cfg.PHRASE_MAX - d.n };
  }

  /** La partie en cours d'un joueur, s'il en a une. */
  // ------------------------------------------------- le mode entrainement
  /*
   * Les memes six jeux, contre un bot, gratuitement.
   *
   * Ces methodes ne sont qu'un guichet : tout est dans entrainement.js, qui
   * n'a acces a aucun solde. On les met ici pour que server.js n'ait qu'un
   * seul interlocuteur — et pour que la frontiere reste visible, c'est-a-dire
   * qu'on voie d'un coup d'oeil que RIEN dans ce bloc ne touche a l'argent.
   */

  entrainementOuvrir(addr, jeu, now) {
    return this.entrainement.ouvrir(addr, String(jeu || ''), now || Date.now());
  }
  entrainementJouer(addr, coup, now) {
    const r = this.entrainement.jouer(addr, coup, now || Date.now());
    r.prime = this._entrainementPrime(addr, r.partie);
    return r;
  }

  /**
   * LA PRIME : battre un bot rapporte des $SWOGE.
   *
   * ---- pourquoi elle est payee ICI et pas dans entrainement.js ----
   *
   * entrainement.js n'a acces a aucun solde, et c'est une propriete qu'on
   * tient a garder : elle se verifie en lisant le fichier. Il annonce donc
   * qu'une partie est finie et qui l'a gagnee ; c'est ce guichet-ci, qui a
   * deja les soldes en main, qui decide de payer. Toute la creation de
   * $SWOGE du mode entrainement tient donc dans cette seule fonction.
   *
   * ---- ce qui est verifie, et pourquoi chaque verification existe ----
   *
   * • GAGNER, pas finir. Une nulle ne paie pas : au morpion le bot est
   *   parfait, donc la nulle est le meilleur resultat atteignable et serait
   *   sinon une rente a un coup ;
   * • UNE SEULE FOIS PAR PARTIE. Le drapeau est pose sur la partie elle-meme.
   *   Sans lui, redemander l'etat d'une partie gagnee la repaierait ;
   * • UNE SEULE FOIS PAR JEU ET PAR JOUR. C'est le plafond, et il porte sur
   *   LE JEU, pas sur le compte : voir config.js pour le raisonnement — en
   *   deux mots, le Dernier Chiffre se gagne une fois sur quatre en un seul
   *   message, donc un plafond global se viderait au meme jeu en une minute.
   *
   * Rend null quand il n'y a rien a payer, et un objet quand il y a quelque
   * chose a annoncer — y compris « plafond atteint », que le joueur doit voir
   * plutot que de croire a un oubli.
   */
  _entrainementPrime(addr, partie) {
    if (!partie || partie.phase !== FINIE) return null;
    const jeton = partie.jeton(addr);
    if (!jeton || partie.gagnant !== jeton) return null;     // nulle ou defaite
    if (partie.primeVue) return null;                        // deja traitee
    partie.primeVue = true;

    const prime = Number(cfg.ENTRAINEMENT_PRIME) || 0;
    if (prime <= 0) return null;
    const jeu = partie.jeu;
    const p = this._p(addr);
    this._bumpDay(p);
    if (!p.primesEntrainement) p.primesEntrainement = {};
    const max = Number(cfg.ENTRAINEMENT_PRIMES_JOUR) || 0;
    const deja = p.primesEntrainement[jeu] || 0;
    if (max > 0 && deja >= max) return { jeu, prime: 0, plafond: true };

    p.primesEntrainement[jeu] = deja + 1;
    p.balance = p.balance.add(WEI(prime));
    p.dayNet = p.dayNet.add(WEI(prime));
    this.sales.add(addr);
    return { jeu, prime, plafond: false };
  }
  entrainementAbandonner(addr, now) {
    /* Abandonner, c'est perdre, et une partie perdue ne peut jamais payer :
       le controle du vainqueur echoue a chaque appel, autant de fois qu'on
       demande. On passe quand meme par le guichet plutot que de decider ici
       qu'il n'y a rien a faire — le jour ou l'abandon donnerait autre chose
       qu'une defaite, c'est la-bas que ce serait ecrit. */
    const partie = this.entrainement.abandonner(addr, now || Date.now());
    this._entrainementPrime(addr, partie);
    return partie;
  }
  entrainementFermer(addr) { return this.entrainement.fermer(addr); }
  /**
   * L'etat d'une table d'entrainement, HABILLE COMME UNE VRAIE.
   *
   * C'est tout le truc : les six pages savent deja dessiner une table de duel,
   * avec les deux visages, les deux noms et la pendule. On leur rend donc
   * exactement la meme forme — `noms`, `profils`, `visages` — et elles peignent
   * la partie d'entrainement sans une ligne de code en plus. Une deuxieme
   * facon de dessiner un damier, c'est un deuxieme endroit ou le corriger.
   *
   * Le bot recoit un nom et un visage comme n'importe qui. Sans ca la page
   * affiche un siege vide en face du joueur, et la partie a l'air cassee.
   */
  entrainementEtat(addr, now) {
    const e = this.entrainement.etat(addr, now || Date.now());
    if (!e) return null;
    const moi = this._p(addr);
    e.noms = e.joueurs.map((a) => (a === Entrainement.BOT ? e.botNom : (a ? moi.name : null)));
    e.profils = e.joueurs.map((a) => (a === Entrainement.BOT
      ? { name: e.botNom, visage: 'robot', photo: false, address: Entrainement.BOT, niveau: 0, bot: true }
      : (a ? this.profilPublic(a) : null)));
    e.visages = e.joueurs.map((a) => (a === Entrainement.BOT
      ? { visage: 'robot', photo: false, address: Entrainement.BOT }
      : (a ? { visage: moi.visage || null, photo: !!moi.photo, address: a } : null)));
    /* Aucune commission : il n'y a pas de pot. La page lit ce champ pour
       annoncer « le gagnant prend X moins Y » — a zero, elle n'annonce rien,
       ce qui est exactement juste. */
    e.rakeBps = 0;
    return e;
  }
  /** La pendule des tables d'entrainement. Rend celles qui viennent d'expirer,
      pour que le serveur previenne leurs joueurs. */
  entrainementTick(now) {
    const finies = this.entrainement.tick(now || Date.now());
    /* La pendule peut, en principe, faire perdre le bot : aux jeux a coups
       simultanes il n'a pas de tour a lui, et l'echeance tombe sur les deux.
       On passe donc par le meme guichet plutot que de supposer que le joueur
       est forcement le perdant. */
    for (const f of finies) f.prime = this._entrainementPrime(f.addr, f.partie);
    return finies;
  }

  duelMienne(addr) {
    for (const m of this.p4.values())
      if (m.phase !== FINIE && m.jeton(addr)) return m;
    return null;
  }

  /* Les anciens noms restent : le Connect 4 est deja en service, et une
     partie en cours ne doit pas tomber parce qu'on a range le code. */
  p4Creer(addr, mise, now) { return this.duelCreer('p4', addr, mise, now); }
  p4Rejoindre(addr, id, now) { return this.duelRejoindre(addr, id, now); }
  p4Annuler(addr, id, now) { return this.duelAnnuler(addr, id, now); }
  p4Revanche(addr, idAvant, mise, now) { return this.duelRevanche(addr, idAvant, mise, now); }
  p4Jouer(addr, id, colonne, now) { return this.duelJouer(addr, id, colonne, now); }
  p4Abandonner(addr, id, now) { return this.duelAbandonner(addr, id, now); }
  p4Tick(now) { return this.duelTick(now); }
  p4Lobby() { return this.duelLobby('p4'); }
  p4Invitations(addr, now) { return this.duelInvitations(addr, now, 'p4'); }
  p4Etat(id, now) { return this.duelEtat(id, now); }
  p4Mienne(addr) { return this.duelMienne(addr); }
  _p4Regle(partie) { return this._duelRegle(partie); }
  _p4Rendre(partie) { return this._duelRendre(partie); }
  _p4Credite(addr, m) { return this._duelCredite(addr, m); }
  _p4Debite(addr, m) { return this._duelDebite(addr, m, 'p4'); }
  _p4Verifie(mise, addr) { return this._duelVerifie('p4', mise, addr); }

  // ------------------------------------------------------------------ poker
  // Le poker se joue en jetons entiers sur la table (1 jeton = 1 $SWOGE). La
  // cave sort du solde a l'arrivee et y retourne au depart. Ce n'est pas une
  // mise : ce qui est reellement joue est compte main par main via pokerWager.

  /** Sort `amount` du solde pour l'emmener sur une table. */
  pokerBuyIn(addr, amountRaw) {
    const p = this._p(addr);
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) throw new Error('invalid buy-in');
    const w = WEI(amt);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(w);
    return amt;
  }

  /** Ramene des jetons de table dans le solde (depart, exclusion, tapis vide). */
  pokerCashOut(addr, amountRaw) {
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) return 0;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(amt));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(amt));
    return amt;
  }

  /** Ce qu'un joueur a reellement engage sur une main : compte comme une mise. */
  pokerWager(addr, amountRaw) {
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) return;
    const p = this._p(addr);
    this._bumpDay(p); p.dropsToday++;
    this._markWager(p, WEI(amt), 'poker');
  }

  /** Une main gagnee : compte pour les quetes et le classement du jour. */
  pokerWin(addr) { const p = this._p(addr); this._bumpDay(p); p.winsToday++; }

  /**
   * Une main de poker, reglee.
   *
   * Le poker ne passait par aucun point de reglage : ni classement, ni
   * revenu, ni mesure d'usage. Il en a pourtant tout ce qu'il faut — ce que
   * chaque siege a REELLEMENT engage (le remboursement de la mise non suivie
   * est deja retire) et ce que chaque siege a recu. Leur difference, sur une
   * main entiere, EST le rake : la comptabilite tombe juste sans qu'on ait a
   * lui declarer la commission separement.
   */
  pokerManche(addr, mise, rendu) {
    const m = Number(mise) || 0;
    if (!(m > 0)) return;
    this._manche(this._p(addr), 'poker', m, Number(rendu) || 0);
  }

  /**
   * @param annexes {pp, tp} — les mises annexes d'avant-donne, en $SWOGE.
   *
   * TOUT EST DEBITE AVANT LE PREMIER TIRAGE. Debiter la main, distribuer, puis
   * decouvrir que l'annexe ne passe pas laisserait une main jouee sur une mise
   * que le joueur n'a pas les moyens de tenir. On refuse d'abord, on donne
   * ensuite — et le refus ne consomme aucun jeton de la suite provably-fair.
   */
  bjBet(addr, amountRaw, annexes) {
    const p = this._p(addr);
    if (p.bj && p.bj.stage !== 'done') throw new Error('hand in progress');
    const amt = Math.floor(Number(amountRaw));
    if (!(amt >= cfg.BJ_MIN_BET)) throw new Error('bet too small');
    if (amt > cfg.BJ_MAX_BET) throw new Error('max bet is ' + cfg.BJ_MAX_BET + ' $SWOGE');
    const pp = this._bjMiseAnnexe(annexes && annexes.pp, 'perfect pairs');
    const tp = this._bjMiseAnnexe(annexes && annexes.tp, '21+3');
    const w = WEI(amt + pp + tp);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); p.dropsToday++; this._markWager(p, w, 'bj');
    p.bj = { bet: amt, pc: [this._bjDraw(p), this._bjDraw(p)], dc: [this._bjDraw(p), this._bjDraw(p)], stage: 'player', doubled: false, result: null, payout: 0,
             ann: { pp: { mise: pp, rang: null, gain: 0 }, tp: { mise: tp, rang: null, gain: 0 }, ins: { mise: 0, rang: null, gain: 0 } } };
    this._bjResoutAnnexes(p);
    /* L'ASSURANCE PASSE AVANT LE NATUREL DU CROUPIER. C'est tout son interet :
       on la propose sans savoir, et le tour d'apres on regarde. Verifier le
       blackjack du croupier d'abord la viderait de son sens. */
    if (Game.rangDe(p.bj.dc[0]) === 0 && this._bjAssuranceMax(p) > 0) p.bj.stage = 'insurance';
    else this._bjNaturels(p);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  /**
   * L'assurance. Se propose sur un As decouvert, se borne a la moitie de la
   * main, paie 2:1 si la carte cachee vaut dix. Zero = refus, et refuser est
   * une reponse valide qui fait avancer la main.
   */
  bjInsure(addr, amountRaw) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'insurance') throw new Error('no insurance to take');
    const max = this._bjAssuranceMax(p);
    const m = Math.floor(Number(amountRaw) || 0);
    if (m < 0) throw new Error('bad insurance');
    if (m > max) throw new Error('insurance is at most half your bet');
    if (m > 0) {
      const w = WEI(m);
      p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); this._markWager(p, w, 'bj');
      Game._bjAnn(p.bj).ins.mise = m;
      /* On lit la carte cachee ICI, pour l'assurance seulement. Elle reste
         cachee dans l'etat public : _bjPublic ne la revele qu'a 'done'. */
      const naturel = this._bjVal(p.bj.dc) === 21;
      this._bjPaieAnnexe(p, 'ins', 'bj_ins', naturel ? 'payee' : null, cfg.BJ_INS_PAY);
    }
    this._bjNaturels(p);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjHit(addr) {
    const p = this._p(addr);
    if (this._bjPasseAssurance(addr, p)) return this._bjPublic(p, true);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) > 21) this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjStand(addr) {
    const p = this._p(addr);
    if (this._bjPasseAssurance(addr, p)) return this._bjPublic(p, true);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, true);
  }

  bjDouble(addr) {
    const p = this._p(addr);
    if (this._bjPasseAssurance(addr, p)) return this._bjPublic(p, true);
    if (!p.bj || p.bj.stage !== 'player' || p.bj.pc.length !== 2) throw new Error('cannot double now');
    const w = WEI(p.bj.bet);
    if (p.balance.lt(w)) throw new Error('not enough to double');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); this._markWager(p, w, 'bj'); p.bj.doubled = true;
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) <= 21) this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.bet * 2);
    return this._bjPublic(p, true);
  }

  /** A coin was pushed off the front → credit its owner. */
  win(addr, value) {
    if (!value) return;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(value));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(value)); p.winsToday++;
    /* Ce qui tombe se rattache a la chute deja comptee : `suite`. Une piece
       qui atteint le bord n'est pas une nouvelle partie — souvent ce n'est
       meme pas la piece qu'on vient de lacher. */
    this._manche(p, 'pusher', 0, Number(value) || 0, { suite: true, sansJournal: true });
  }

  /**
   * Le frais de retrait, en wei, sur un montant brut. Le meme pour tous.
   *
   * Il n'est verse a personne : il reste dans le coffre pour etre BRULE. Un
   * pour cent qui part dans la poche de la maison est une taxe ; le meme un
   * pour cent retire de la circulation profite a tous les porteurs, celui qui
   * retire compris.
   */
  fraisRetrait(addr, brut) {
    if (!(cfg.WITHDRAW_FEE_BPS > 0)) return BN(0);
    return brut.mul(cfg.WITHDRAW_FEE_BPS).div(10000);
  }

  /** Ce que le joueur doit savoir AVANT de valider. */
  infoFrais() {
    return {
      taux: cfg.WITHDRAW_FEE_BPS / 100,
      du: cfg.WITHDRAW_FEE_BPS > 0,
      brule: true,
      mini: cfg.MIN_WITHDRAW,
    };
  }

  /**
   * Ce qui attend d'etre brule : preleve moins deja brule.
   *
   * On garde les DEUX totaux et non un seul compteur qu'on remettrait a
   * zero : « combien a-t-on brule depuis le debut » est la question qu'on
   * pose quand on doute d'une promesse, et un compteur remis a zero ne sait
   * plus y repondre.
   */
  aBruler() {
    const p = (this.fraisCumules || BN(0)).sub(this.brule || BN(0));
    return p.gt(0) ? p : BN(0);
  }

  /**
   * Note un brulage qui a EU LIEU sur la chaine. Le serveur ne brule pas
   * lui-meme : les jetons sont dans le coffre, et seule la cle du
   * proprietaire peut les en sortir. Ce qu'on enregistre ici, c'est la
   * preuve — un hash de transaction que n'importe qui peut aller verifier.
   */
  enregistreBrulage(montantStr, tx) {
    const w = WEI(String(montantStr));
    if (w.lte(0)) throw new Error('nothing to burn');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ''))) throw new Error('a real transaction hash is required');
    if (this.brulages.some((b) => b.tx.toLowerCase() === String(tx).toLowerCase()))
      throw new Error('this transaction is already recorded');
    this.brule = (this.brule || BN(0)).add(w);
    this.brulages.unshift({ t: Date.now(), m: ethers.utils.formatUnits(w, cfg.DECIMALS), tx: String(tx) });
    if (this.brulages.length > 50) this.brulages.length = 50;
    return { total: ethers.utils.formatUnits(this.brule, cfg.DECIMALS),
             reste: ethers.utils.formatUnits(this.aBruler(), cfg.DECIMALS) };
  }

  /**
   * Les depots du JOURNAL compares a ceux de l'ETAT.
   *
   * ---- pourquoi cette comparaison, et pas une autre ----
   *
   * Les deux nombres sont ecrits dans la meme respiration : le solde monte,
   * puis la ligne part au journal. Mais ils vivent dans DEUX FICHIERS. Le
   * journal est ajoute ligne a ligne, tout de suite ; l'etat est reecrit en
   * entier, une seconde plus tard. Un arret entre les deux — un redeploiement,
   * deux instances qui se marchent dessus — laisse donc le journal en avance
   * sur l'etat : la ligne « Deposit +12 602 » existe, et le solde ne l'a
   * jamais vue.
   *
   * C'est precisement ce cas que cette methode trouve, et l'ecart qu'elle
   * rend est exactement ce qu'il faut recrediter.
   */
  verifieDepots(addr) {
    const a = String(addr).toLowerCase();
    const p = this._p(a);
    /* Le journal ecrit en differe : ce qui attend encore en memoire doit
       partir avant qu'on le relise, sinon le controle sous-estime le journal
       et conclut qu'il n'y a rien a reparer. */
    journal.videSync();
    let curseur = null, lignes = [], somme = 0, tours = 0;
    for (;;) {
      const r = journal.lit(a, { genre: 'dep', curseur, limite: 200 });
      for (const e of r.evenements) {
        /* LA LIGNE DE REPARATION NE COMPTE PAS. Elle est ecrite au journal
           pour que le joueur voie la correction dans son historique — mais
           l'inclure dans le total remettrait le journal en avance sur l'etat
           qu'on vient d'aligner, et la reparation suivante recrediterait la
           meme somme. Une boucle qui cree de l'argent a chaque tour. */
        if (e.tx === 'repair') { lignes.push({ t: e.t, m: e.m, tx: 'repair' }); continue; }
        somme += Number(e.m) || 0;
        lignes.push({ t: e.t, m: e.m, tx: e.tx });
      }
      if (!r.encore || r.curseur === null || ++tours > 40) break;
      curseur = r.curseur;
    }
    const compte = Number(ethers.utils.formatUnits(p.deposited || BN(0), cfg.DECIMALS));
    const ecart = Number((somme - compte).toFixed(6));
    return {
      address: a,
      journal: Number(somme.toFixed(6)),
      etat: compte,
      ecart,
      /* Un ecart NEGATIF n'est pas une panne : le journal est plus jeune que
         les comptes. Un depot fait avant sa mise en service est dans l'etat
         et pas dans le journal, et c'est exactement ce que ca donne. Seul un
         ecart POSITIF signale un credit perdu — le journal ne peut pas
         inventer une ligne. */
      diagnostic: ecart > 0.000001
        ? 'CREDIT PERDU : le journal prouve ' + ecart + ' $SWOGE que l etat n a pas'
        : ecart < -0.000001
          ? 'normal : ' + (-ecart) + ' $SWOGE deposes avant la mise en service du journal'
          : 'les deux fichiers disent la meme chose',
      solde: this.balanceStr(a),
      mouvements: this.mouvements(a),
      depots: lignes.slice(0, 20),
    };
  }

  /**
   * Ou est passe l'argent, par grande categorie.
   *
   * « J'ai depose et je ne le vois plus » a deux reponses possibles : le
   * credit s'est perdu, ou il a ete joue. La premiere se lit dans l'ecart
   * ci-dessus ; la seconde se lit ici, et il faut les deux — sinon on repare
   * un solde qui n'avait rien perdu, et on cree de l'argent.
   */
  mouvements(addr) {
    const a = String(addr).toLowerCase();
    journal.videSync();
    const t = { depots: 0, reparations: 0, retraits: 0, mise: 0, rendu: 0, recu: 0, envoye: 0,
                stake: 0, stakeClaim: 0, parrainage: 0, manches: 0, lignes: 0 };
    let curseur = null, tours = 0;
    for (;;) {
      const r = journal.lit(a, { curseur, limite: 200 });
      for (const e of r.evenements) {
        t.lignes++;
        const m = Number(e.m) || 0;
        if (e.k === 'dep') { if (e.tx === 'repair') t.reparations += m; else t.depots += m; }
        else if (e.k === 'wd') t.retraits += m;
        else if (e.k === 'r') { t.manches++; t.mise += Number(e.m) || 0; t.rendu += Number(e.p) || 0; }
        else if (e.k === 'tr') { if (e.sens === 'in') t.recu += m; else t.envoye += m; }
        else if (e.k === 'st') { if (e.s === 'claim') t.stakeClaim += m; else if (e.s === 'stake') t.stake += m; }
        else if (e.k === 'rf') t.parrainage += m;
      }
      if (!r.encore || r.curseur === null || ++tours > 60) break;
      curseur = r.curseur;
    }
    for (const k of Object.keys(t)) t[k] = Number(t[k].toFixed(6));
    t.resultatDesJeux = Number((t.rendu - t.mise).toFixed(6));
    return t;
  }

  /**
   * Recredite un ecart constate. Ce n'est PAS un cadeau : c'est la reparation
   * d'un depot reel dont la trace existe au journal et que l'etat a perdu.
   * Le montant est donc plafonne par l'ecart — on ne peut rien creer avec.
   */
  repareDepots(addr) {
    const v = this.verifieDepots(addr);
    if (!(v.ecart > 0)) throw new Error('nothing to repair: state matches the journal');
    const a = String(addr).toLowerCase();
    const p = this._p(a);
    const w = WEI(v.ecart.toFixed(6));
    p.balance = p.balance.add(w);
    p.deposited = (p.deposited || BN(0)).add(w);
    p.hasDeposited = true;
    journal.ajouteSync(a, { k: 'dep', m: v.ecart.toFixed(6), tx: 'repair',
                            from: a, note: 'lost credit restored' });
    return { ...this.verifieDepots(a), rendu: v.ecart };
  }

  /* ================================================================
   * CREDITER UN JOUEUR DEPUIS LE PANNEAU
   *
   * Un dedommagement, un lot de concours, une erreur a rattraper. Ces jetons
   * ne viennent d'AUCUN depot : ils augmentent ce que la maison doit sans
   * rien ajouter au coffre. C'est pour ca que ca se compte.
   *
   * UNE ENVELOPPE GLISSANTE, pas un compteur par envoi. Ce qui est borne est
   * le TOTAL sorti sur les douze dernieres heures, tous joueurs confondus :
   * un plafond par envoi se contourne en dix clics, et dix clics passent
   * inapercus la ou un seul gros montant se remarque.
   *
   * Elle se libere au fur et a mesure : un envoi de cent mille fait de la
   * place douze heures apres avoir ete fait, pas au prochain minuit. Le
   * panneau montre les deux, la jauge et le compte a rebours, parce que
   * « vous ne pouvez plus envoyer » sans dire QUAND se lit comme une panne.
   * ================================================================ */

  /** Les envois encore DANS la fenetre, du plus recent au plus ancien. */
  _donsRecents(now) {
    const t = Number(now) || Date.now();
    const depuis = t - cfg.CREDIT_ADMIN_FENETRE_H * 3600000;
    /* On PURGE : la liste ne sert qu'a la fenetre, et un tableau qui grandit
       pour toujours finit dans chaque sauvegarde, toutes les dix secondes. */
    this.dons = (this.dons || []).filter((d) => d && Number(d.t) > depuis);
    return this.dons.slice().sort((a, b) => b.t - a.t);
  }

  /**
   * Ce qui reste a envoyer, et quand le reste revient. C'est ce que le
   * panneau dessine — jauge et barre de temps.
   */
  enveloppeCredit(now) {
    const t = Number(now) || Date.now();
    const fenetre = cfg.CREDIT_ADMIN_FENETRE_H * 3600000;
    const dons = this._donsRecents(t);
    const utilise = dons.reduce((s, d) => s + (Number(d.montant) || 0), 0);
    const reste = Math.max(0, cfg.CREDIT_ADMIN_MAX - utilise);
    /* Le PROCHAIN envoi a sortir de la fenetre : c'est lui qui rend de la
       place, et c'est donc l'heure qu'il faut afficher — pas celle du dernier
       envoi, qui est la plus lointaine des deux. */
    const plusVieux = dons.length ? dons[dons.length - 1] : null;
    return {
      max: cfg.CREDIT_ADMIN_MAX, fenetreH: cfg.CREDIT_ADMIN_FENETRE_H,
      utilise: Number(utilise.toFixed(6)), reste: Number(reste.toFixed(6)),
      envois: dons.length,
      /* Dans combien de temps de la place se libere, et combien. */
      libereDansMs: plusVieux ? Math.max(0, plusVieux.t + fenetre - t) : 0,
      libereMontant: plusVieux ? Number(plusVieux.montant) || 0 : 0,
      /* Et dans combien de temps l'enveloppe est ENTIEREMENT rendue. */
      videDansMs: dons.length ? Math.max(0, dons[0].t + fenetre - t) : 0,
      derniers: dons.slice(0, 12).map((d) => ({
        t: d.t, addr: d.addr, montant: Number(d.montant) || 0,
        nom: (this.players.get(d.addr) || {}).name || null,
      })),
    };
  }

  /** Le joueur vise : son nom public, ou son adresse. */
  trouveJoueur(cible) {
    const s = String(cible || '').trim();
    if (!s) return null;
    const bas = s.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(bas)) return this.players.has(bas) ? bas : null;
    /* La MEME cle que l'unicite des noms : sans elle, « Éliott » ne
       retrouverait pas « Eliott », et l'exploitant conclurait que le joueur
       n'existe pas. */
    const cle = Game.cleNom(s);
    for (const [a, p] of this.players)
      if (p.name && Game.cleNom(p.name) === cle) return a;
    return null;
  }

  /**
   * Crediter. Le montant est en $SWOGE entiers, la cible un nom ou une
   * adresse. Rend de quoi rafraichir le panneau ET prevenir le joueur.
   */
  crediteJoueur(cible, montantRaw, now, note) {
    const t = Number(now) || Date.now();
    const addr = this.trouveJoueur(cible);
    if (!addr) throw new Error('unknown player — check the name, or paste the address');

    const montant = Math.floor(Number(montantRaw));
    if (!(montant > 0)) throw new Error('amount must be a positive whole number');

    const env = this.enveloppeCredit(t);
    if (env.reste <= 0) {
      const h = Math.floor(env.libereDansMs / 3600000);
      const mn = Math.round((env.libereDansMs % 3600000) / 60000);
      throw new Error(`${env.max} $SWOGE already sent in the last ${env.fenetreH} h — ` +
        `${env.libereMontant} frees up in ${h} h ${mn} min`);
    }
    if (montant > env.reste)
      throw new Error(`only ${Math.floor(env.reste)} $SWOGE left in this ${env.fenetreH} h window ` +
        `(cap ${env.max})`);

    const p = this._p(addr);
    const w = WEI(montant);
    p.balance = p.balance.add(w);
    this._bumpDay(p); p.dayNet = p.dayNet.add(w);

    if (!this.dons) this.dons = [];
    this.dons.push({ t, addr, montant, note: note ? String(note).slice(0, 120) : '' });

    /* Le joueur doit pouvoir le LIRE dans son historique : un solde qui monte
       tout seul, sans ligne pour l'expliquer, se signale comme un bug — ou
       pire, se prend pour un gain qu'on ira chercher a nouveau. */
    journal.ajoute(addr, { k: 'ca', m: String(montant),
                           note: note ? String(note).slice(0, 120) : '' });
    /* La comptabilite le compte a part : ce n'est ni un depot, ni un gain de
       jeu, et le confondre avec l'un des deux fausserait les deux. */
    this.note('cadeaux', String(montant));

    return {
      addr, nom: (this.players.get(addr) || {}).name || null,
      montant, solde: this.balanceStr(addr),
      enveloppe: this.enveloppeCredit(t),
    };
  }

  /**
   * ================== LE CADEAU DE PARRAINAGE NE SORT PAS SANS ETRE JOUE ==================
   *
   * `p.bonusBloque` est la part du solde qui vient du cadeau de bienvenue et
   * qui n'a pas encore ete misee. Le verrou etait ecrit dans `requestWithdraw`
   * ET NULLE PART AILLEURS — alors que le retrait n'est pas la seule porte de
   * sortie. Un virement vers un second portefeuille passait, et le cadeau
   * ressortait de la, sans une seule mise et sans frais. Le marche joueur
   * faisait la meme chose, au prix de cinq pour cent.
   *
   * Le commentaire qui pose le cadeau dit que ce verrou est « le seul qui coute
   * quelque chose a qui vient seulement le ramasser ». Il ne coutait rien.
   *
   * Le message dit COMBIEN il reste a miser : « bloque » sans chiffre fait
   * revenir le joueur toutes les cinq minutes.
   */
  _gardeCadeau(p, montant) {
    const bloque = (p && p.bonusBloque) || BN(0);
    if (!bloque.gt(0)) return null;
    if (!montant.gt(p.balance.sub(bloque))) return null;
    const reste = (p.bonusCible || BN(0)).sub(p.wagered || BN(0));
    return 'play ' + ethers.utils.formatUnits(reste.gt(0) ? reste : BN(0), cfg.DECIMALS) +
           ' $SWOGE more to unlock your referral gift';
  }

  /** Request a withdrawal of `amountStr` $SWOGE. Returns cumulativeAuthorized (wei) or throws. */
  requestWithdraw(addr, amountStr) {
    /* ---- L'AUTRE MOITIE DE `COMPTES_MAISON` ----
     *
     * Les jetons de ce compte ont ete sortis du « du », donc annonces comme
     * surplus retirable par le proprietaire. Sa fiche porte pourtant toujours
     * la creance : si le surplus est retire ET que ce bon est signe, le coffre
     * doit deux fois la meme somme, et ce sont les joueurs qui n'obtiennent
     * plus leur retrait.
     *
     * Ce refus n'est pas une precaution : c'est ce qui rend l'exclusion sure.
     * L'argent d'un compte maison sort par le retrait du proprietaire — qui,
     * lui, se lit dans le surplus et le fait donc baisser. */
    if (this.estMaison(addr))
      throw new Error('house accounts do not withdraw — their tokens are already counted as house surplus. Use the owner withdrawal.');
    const p = this._p(addr);
    const amount = WEI(amountStr);
    /* Le minimum baisse avec le palier : c'est un confort qui ne coute rien
       a la maison, et qui se remarque tout de suite. */
    const mini = this.minRetraitDe(addr);
    if (amount.lt(WEI(String(mini)))) throw new Error('below minimum withdraw (' + mini + ' $SWOGE)');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    const refusCadeau = this._gardeCadeau(p, amount);
    if (refusCadeau) throw new Error(refusCadeau);
    /* Le frais se prend sur le brut, et le joueur n'est autorise a tirer que
       le NET : la difference reste dans le coffre, donc dans le surplus du
       proprietaire. Rien n'est cree, rien n'est detruit ici — c'est un
       deplacement, et il doit se retrouver au jeton pres. */
    const frais = this.fraisRetrait(addr, amount);
    const net = amount.sub(frais);
    p.balance = p.balance.sub(amount);
    p.cumulativeAuthorized = p.cumulativeAuthorized.add(net);
    /* ---- CE QUI SORT DU SOLDE N'EST PAS ENCORE SORTI DU COFFRE ----
     * Entre l'autorisation et la presentation du bon, les jetons sont toujours
     * la. Sans cette ligne, `owedBreakdown` voyait le solde baisser et rien le
     * remplacer : le surplus montait d'autant, et « Fill safe surplus »
     * proposait de retirer de l'argent deja promis par un bon signe. */
    p.bonDu = (p.bonDu || BN(0)).add(net);
    this.fraisCumules = (this.fraisCumules || BN(0)).add(frais);
    this.note('retraits', ethers.utils.formatUnits(net, cfg.DECIMALS));
    this.note('brule', ethers.utils.formatUnits(frais, cfg.DECIMALS));
    /* On journalise l'AUTORISATION, pas l'encaissement : c'est le moment ou le
       solde quitte le compte, et c'est celui que le joueur reconnait. Le bon
       peut encore etre presente plus tard a la chaine — ou jamais. */
    journal.ajoute(addr, { k: 'wd', m: ethers.utils.formatUnits(net, cfg.DECIMALS),
                           brut: amountStr,
                           frais: ethers.utils.formatUnits(frais, cfg.DECIMALS),
                           to: String(addr).toLowerCase(),
                           cum: ethers.utils.formatUnits(p.cumulativeAuthorized, cfg.DECIMALS) });
    return p.cumulativeAuthorized;
  }

  /**
   * ================== LE BON QU'ON N'A PAS ENCAISSE ==================
   *
   * Le bon est CUMULATIF : le contrat paie l'ecart entre le cumul signe et ce
   * que le joueur a deja tire. Le resigner ne peut donc RIEN payer de plus, et
   * c'est exactement ce qui rend cette porte sans danger — elle ne cree aucune
   * autorisation, elle redonne celle qui existe deja.
   *
   * Sans elle, un joueur qui refuse dans son portefeuille, dont la transaction
   * echoue, ou qui ferme l'onglet, se retrouvait avec un solde a zero, un bon
   * perime dans l'heure et aucun moyen d'en redemander un : `requestWithdraw`
   * exige `montant <= solde`, et son solde venait d'etre vide. Son argent
   * n'etait pas perdu — le cumul le portait toujours — mais il ne pouvait le
   * reprendre qu'en redeposant assez pour redeclencher un retrait. C'est la
   * reclamation la plus chere qui soit, et la plus difficile a croire.
   */
  bonEnAttente(addr) {
    const p = this._p(addr);
    return { cumulative: p.cumulativeAuthorized, du: p.bonDu || BN(0) };
  }

  /**
   * Ce que LA CHAINE dit avoir deja paye a ce joueur, d'ou l'on deduit ce qui
   * reste du. Le serveur ne voit pas les transactions : il ne peut que
   * demander, et il ne demande qu'aux moments ou il parle deja de retrait.
   *
   * On ne l'appelle JAMAIS sans contrat en face (`chain.suitLesRetraits`) : un
   * zero rendu par absence de coffre remettrait tout le cumul en attente, et
   * le surplus du proprietaire s'effondrerait sans qu'un jeton ait bouge.
   */
  noteRetireOnChain(addr, retireWei) {
    const p = this._p(addr);
    const tire = (retireWei && retireWei._isBigNumber)
      ? retireWei : BN(String(retireWei || '0'));
    const reste = p.cumulativeAuthorized.sub(tire);
    p.bonDu = reste.gt(0) ? reste : BN(0);
    return p.bonDu;
  }

  /* ==================== LE SOLDE DES PARIS, EN $SWOGEBET ====================
   *
   * « Il faudrait faire le contrat vault SWOGEBET pour qu'on puisse jouer aux
   *   paris qu'avec du SWOGEBET. »
   *
   * Un second coffre (SwogeBetVault, meme modele que le coffre $SWOGE) et un
   * second solde par joueur. Les quatre gestes ci-dessous sont les jumeaux de
   * `creditDeposit`, `requestWithdraw`, `bonEnAttente` et `noteRetireOnChain`,
   * sur les champs `bet*` de la fiche — et sur EUX SEULS. Rien ici ne touche
   * le $SWOGE : un pari ne peut ni se financer avec, ni y verser un gain.
   *
   * Ce qui est volontairement plus simple que le $SWOGE :
   *   - pas de cadeau de bienvenue, donc pas de verrou de mise a atteindre ;
   *   - pas de palier : le minimum de retrait est celui du coffre, en clair ;
   *   - le frais de retrait est le meme taux (WITHDRAW_FEE_BPS) : ce qui est
   *     retenu reste dans le coffre des paris, et se compte a part.
   * ======================================================================== */
  betBalanceStr(addr) { return ethers.utils.formatUnits(this._p(addr).betBalance || BN(0), cfg.DECIMALS); }

  creditBetDeposit({ player, amount, tx }) {
    if (this.seenTx.has(tx)) return false;
    this.seenTx.add(tx);
    const p = this._p(player);
    p.betBalance = (p.betBalance || BN(0)).add(amount);
    p.betDeposited = (p.betDeposited || BN(0)).add(amount);
    this.note('depotsBet', ethers.utils.formatUnits(amount, cfg.DECIMALS));
    journal.ajouteSync(player, { k: 'depb', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                                 tx, from: String(player).toLowerCase() });
    return true;
  }

  /** Autorise un retrait de `amountStr` $SWOGEBET. Rend le cumul (wei) ou leve. */
  requestBetWithdraw(addr, amountStr) {
    if (this.estMaison(addr))
      throw new Error('house accounts do not withdraw — use the owner withdrawal.');
    const p = this._p(addr);
    const amount = WEI(amountStr);
    const mini = WEI(String(cfg.BET_MIN_WITHDRAW));
    if (amount.lt(mini)) throw new Error('below minimum withdraw (' + cfg.BET_MIN_WITHDRAW + ' $SWOGEBET)');
    if (amount.gt(p.betBalance || BN(0))) throw new Error('amount exceeds your $SWOGEBET balance');
    const frais = this.fraisRetrait(addr, amount);
    const net = amount.sub(frais);
    p.betBalance = p.betBalance.sub(amount);
    p.betCumulativeAuthorized = (p.betCumulativeAuthorized || BN(0)).add(net);
    p.betBonDu = (p.betBonDu || BN(0)).add(net);
    this.betFraisCumules = (this.betFraisCumules || BN(0)).add(frais);
    this.note('retraitsBet', ethers.utils.formatUnits(net, cfg.DECIMALS));
    journal.ajoute(addr, { k: 'wdb', m: ethers.utils.formatUnits(net, cfg.DECIMALS),
                           brut: amountStr,
                           frais: ethers.utils.formatUnits(frais, cfg.DECIMALS),
                           to: String(addr).toLowerCase(),
                           cum: ethers.utils.formatUnits(p.betCumulativeAuthorized, cfg.DECIMALS) });
    return p.betCumulativeAuthorized;
  }

  bonBetEnAttente(addr) {
    const p = this._p(addr);
    return { cumulative: p.betCumulativeAuthorized || BN(0), du: p.betBonDu || BN(0) };
  }

  noteBetRetireOnChain(addr, retireWei) {
    const p = this._p(addr);
    const tire = (retireWei && retireWei._isBigNumber)
      ? retireWei : BN(String(retireWei || '0'));
    const reste = (p.betCumulativeAuthorized || BN(0)).sub(tire);
    p.betBonDu = reste.gt(0) ? reste : BN(0);
    return p.betBonDu;
  }

  // ------------------------------------------------------------- les amis
  /*
   * Une liste d'adresses, et un virement de solde a solde.
   *
   * Le virement ne touche PAS la chaine : il deplace deux nombres dans l'etat
   * du serveur, ce qui est instantane et gratuit — c'est tout l'interet. Mais
   * c'est de l'argent, donc trois regles :
   *
   *  1. l'expediteur doit avoir DEPOSE au moins une fois. Sans ca, ouvrir dix
   *     portefeuilles jetables, ramasser dix bonus de bienvenue et tout
   *     rassembler sur un onzieme ne couterait rien ;
   *  2. on ne s'envoie rien a soi-meme — ca ne veut rien dire et ca fabrique
   *     de faux mouvements dans l'historique ;
   *  3. debit et credit dans la MEME instruction, sans await entre les deux.
   *     Node est mono-thread : rien ne peut s'intercaler, donc la somme des
   *     deux soldes ne peut pas bouger.
   */
  /** La fiche publique d'une adresse, connue ou non. */
  _vu(a) {
    const q = this.players.get(a);
    if (!q) return { address: a, name: a.slice(0, 6), visage: null, photo: false, connu: false };
    /* On passe par le profil public : ainsi une ligne d'ami porte exactement
       ce qu'une ligne de duel ou de classement porte — meme nom, meme visage,
       meme niveau. Les recopier a la main ici les ferait diverger un jour. */
    return Object.assign(this.profilPublic(a), { connu: true });
  }

  /**
   * Tout ce que l'ecran des amis a besoin de savoir : les amis, les demandes
   * RECUES et celles qu'on a envoyees. Les trois ensemble, parce qu'ils se
   * lisent ensemble — savoir qu'on a une demande en attente sans savoir de
   * qui ne sert a rien.
   */
  amis(addr) {
    const p = this._p(addr);
    return {
      amis: (p.amis || []).map((a) => this._vu(a)),
      recues: (p.demandes || []).map((a) => this._vu(a)),
      envoyees: (p.envoyees || []).map((a) => this._vu(a)),
    };
  }

  /** Combien de demandes attendent une reponse — pour la pastille. */
  amisEnAttente(addr) { return (this._p(addr).demandes || []).length; }

  /** Les envois d'argent recus qu'il n'a pas encore regardes. */
  transfertsNonLus(addr) { return this._p(addr).trNonLus || 0; }
  vuTransferts(addr) { const p = this._p(addr); const n = p.trNonLus || 0; p.trNonLus = 0; return n; }

  /**
   * Cherche des joueurs par NOM. On cherche sur le nom choisi, pas sur
   * l'adresse : personne ne retient une adresse, et c'est justement pour ca
   * que les joueurs se donnent des noms.
   */
  chercheJoueurs(q, moi, max) {
    const cle = Game.cleNom(String(q || '').trim());
    if (cle.length < 2) return [];
    const a_moi = String(moi || '').toLowerCase();
    const debut = [], dedans = [];
    for (const [a, p] of this.players) {
      if (a === a_moi) continue;
      const n = Game.cleNom(p.name || '');
      if (!n) continue;
      const i = n.indexOf(cle);
      if (i === 0) debut.push(this._vu(a));
      else if (i > 0) dedans.push(this._vu(a));
      if (debut.length >= (max || 8)) break;
    }
    // ceux dont le nom COMMENCE par la recherche d'abord : c'est ce qu'on tape
    return debut.concat(dedans).slice(0, max || 8);
  }

  /** L'adresse visee, donnee soit telle quelle, soit par un nom exact. */
  _cible(x) {
    const s = String(x || '').trim();
    if (/^0x[0-9a-f]{40}$/i.test(s)) return s.toLowerCase();
    const cle = Game.cleNom(s);
    if (cle.length < 2) return null;
    for (const [a, p] of this.players) if (Game.cleNom(p.name || '') === cle) return a;
    return null;
  }

  /**
   * Envoie une demande d'ami. On ne devient pas l'ami de quelqu'un sans qu'il
   * l'ait accepte — sinon n'importe qui remplit la liste de n'importe qui.
   * Si l'autre nous avait deja demande, on accepte au lieu de croiser deux
   * demandes qui s'attendent.
   */
  amiDemande(addr, cible) {
    const moi = String(addr).toLowerCase();
    const a = this._cible(cible);
    if (!a) throw new Error('no player found with that name or address');
    if (a === moi) throw new Error('that is you');
    const p = this._p(moi), q = this._p(a);
    if (!p.amis) p.amis = [];
    if (p.amis.indexOf(a) >= 0) throw new Error('already in your friends');
    if (p.amis.length >= 100) throw new Error('friend list is full (100)');

    // il nous avait deja demande : on scelle tout de suite
    if ((p.demandes || []).indexOf(a) >= 0) return this.amiAccepte(moi, a);

    if (!p.envoyees) p.envoyees = [];
    if (p.envoyees.indexOf(a) >= 0) throw new Error('request already sent');
    if (!q.demandes) q.demandes = [];
    if (q.demandes.length >= 200) throw new Error('that player has too many pending requests');
    p.envoyees.push(a);
    q.demandes.push(moi);
    return { etat: this.amis(moi), vers: a };
  }

  amiAccepte(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').toLowerCase();
    const p = this._p(moi), q = this._p(a);
    if ((p.demandes || []).indexOf(a) < 0) throw new Error('no request from that player');
    p.demandes = p.demandes.filter((x) => x !== a);
    q.envoyees = (q.envoyees || []).filter((x) => x !== moi);
    if (!p.amis) p.amis = [];
    if (!q.amis) q.amis = [];
    // l'amitie va DANS LES DEUX SENS : un seul cote et l'autre ne voit rien
    if (p.amis.indexOf(a) < 0) p.amis.push(a);
    if (q.amis.indexOf(moi) < 0) q.amis.push(moi);
    return { etat: this.amis(moi), avec: a };
  }

  amiRefuse(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').toLowerCase();
    const p = this._p(moi), q = this._p(a);
    p.demandes = (p.demandes || []).filter((x) => x !== a);
    q.envoyees = (q.envoyees || []).filter((x) => x !== moi);
    return this.amis(moi);
  }

  /** Retire des DEUX cotes : garder l'autre moitie n'aurait aucun sens. */
  amiRetire(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').toLowerCase();
    const p = this._p(moi), q = this._p(a);
    p.amis = (p.amis || []).filter((x) => x !== a);
    q.amis = (q.amis || []).filter((x) => x !== moi);
    p.envoyees = (p.envoyees || []).filter((x) => x !== a);
    q.demandes = (q.demandes || []).filter((x) => x !== moi);
    return this.amis(moi);
  }

  /**
   * Envoie du $SWOGE d'un solde a un autre.
   * @returns {{ montant:string, vers:string, solde:string }}
   */
  transfere(addr, vers, montantStr) {
    const moi = String(addr).toLowerCase();
    const dest = String(vers || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(dest)) throw new Error('enter a valid 0x… address');
    if (dest === moi) throw new Error('you cannot send to yourself');

    const p = this._p(moi);
    if (cfg.TRANSFER_REQUIRE_DEPOSIT && !p.hasDeposited)
      throw new Error('deposit once before sending $SWOGE to others');

    let montant;
    try { montant = WEI(String(montantStr)); }
    catch (e) { throw new Error('enter a valid amount'); }
    if (montant.lte(0)) throw new Error('enter an amount');
    if (montant.lt(WEI(String(cfg.TRANSFER_MIN)))) throw new Error('minimum transfer is ' + cfg.TRANSFER_MIN + ' $SWOGE');
    if (montant.gt(p.balance)) throw new Error('amount exceeds your balance');
    /* La MEME regle qu'au retrait : sans elle, le cadeau sortait par ici, vers
       un deuxieme portefeuille, sans frais et sans une seule mise. */
    const refusCadeau = this._gardeCadeau(p, montant);
    if (refusCadeau) throw new Error(refusCadeau);

    const q = this._p(dest);
    // debit et credit d'un seul tenant : rien ne peut s'intercaler
    p.balance = p.balance.sub(montant);
    q.balance = q.balance.add(montant);

    const m = ethers.utils.formatUnits(montant, cfg.DECIMALS);
    /* Le destinataire n'est peut-etre pas la. Un message qui passe pendant
       qu'on est deconnecte n'a jamais existe : on compte donc les envois
       recus non vus, et la pastille les porte jusqu'a ce qu'il regarde. */
    q.trNonLus = (q.trNonLus || 0) + 1;
    journal.ajoute(moi, { k: 'tr', sens: 'out', m, autre: dest });
    journal.ajoute(dest, { k: 'tr', sens: 'in', m, autre: moi });
    return { montant: m, vers: dest,
             solde: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
             nomDest: q.name };
  }

  /* ======================================================================
   * LE RACHAT IMMEDIAT
   * ======================================================================
   *
   * La vitrine demande un acheteur. Celui qui veut se debarrasser d'un commun
   * maintenant n'a pas envie d'attendre trois jours. La maison le reprend a un
   * prix fixe, connu d'avance, et volontairement bien plus bas que ce qu'un
   * joueur en donnerait : c'est une sortie de secours, pas le prix du marche.
   *
   * ---- L'OBJET RETOURNE AU STOCK, IL N'EST PAS DETRUIT ----
   *
   * Et ce n'est pas un choix de confort. Si le rachat detruisait, c'est le
   * COMMUN qui partirait en premier — il est le moins bien paye, donc le plus
   * revendu. A dix pour cent de revente, les mille exemplaires d'un commun
   * disparaissent en dix mille tirages. Le jour ou ils sont partis, PLUS
   * PERSONNE ne peut completer cette famille : c'est justement la piece dont
   * tout le monde a besoin pour finir une ligne, et la course s'arreterait
   * faute de matiere.
   *
   * Le plafond cesse donc de dire « dix seront tirees en tout » pour dire
   * « dix existent a la fois ». La planche l'ecrit ainsi — voir le libelle
   * envoye avec le catalogue. Annoncer l'un et faire l'autre serait pire que
   * les deux.
   *
   * ---- ce que la maison y gagne ----
   *
   * Elle a vendu un coffre 4 000, elle reprend l'objet pour ~500, et elle peut
   * le revendre. Le joueur ressort avec ce qu'il voulait — de la liquidite
   * immediate — et l'edition ne se vide pas.
   */
  prixRachatDe(itemId) {
    const o = boutique.item(itemId);
    return o ? boutique.prixRachat(o.rarete, cfg.RACHAT_BASE) : 0;
  }

  /**
   * LA PORTE DU RACHAT, ET DE QUOI L'AFFICHER.
   *
   * ---- pourquoi il en faut une du tout ----
   *
   * Le rachat est le seul geste du site qui transforme un objet en jetons
   * SANS acheteur en face. Le marche ne cree rien — un joueur paie, un autre
   * encaisse. Le rachat, lui, EMET. Il faut donc que la matiere premiere ait
   * coute quelque chose, et il y a exactement un endroit ou elle ne coute
   * rien : le coffre offert chaque jour.
   *
   * ---- pourquoi le volume et pas le depot ----
   *
   * Un depot se retire. La porte s'ouvrirait avec de l'argent qu'on reprend
   * ensuite, donc elle ne couterait rien a franchir — et une porte gratuite
   * n'est pas une porte. Le volume est DEPENSE : l'avoir joue, c'est avoir
   * laisse l'avantage de la maison sur la table.
   *
   * ---- pourquoi on renvoie le detail et pas un oui/non ----
   *
   * Un bouton grise sans explication se lit « casse ». Avec le chiffre et ce
   * qui reste, il se lit « pas encore » — et il devient une raison de jouer au
   * lieu d'une raison de partir. C'est la meme information, ce n'est pas le
   * meme produit.
   */
  rachatVerrou(addr) {
    const p = this._p(addr);
    const volume = Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS));
    const requis = Number(cfg.RACHAT_VOLUME_MIN) || 0;
    return { requis, volume: Math.floor(volume),
             reste: Math.max(0, Math.ceil(requis - volume)),
             ouvert: volume >= requis };
  }

  boutiqueRachat(addr, itemId, qteStr) {
    const p = this._p(addr);
    const o = boutique.item(itemId);
    if (!o) throw new Error('unknown item');
    const qte = Math.max(1, Math.floor(Number(qteStr) || 1));
    const ai = (p.objets || {})[o.id] || 0;
    if (ai < qte) throw new Error(qte > 1 ? `you only own ${ai} of these` : 'you do not own this item');
    /* ---- ET SURTOUT PAS ICI ----
     * Le rachat est la seule sortie ou c'est LA MAISON qui paie. Vendre une
     * piece qu'on garde sur le dos y revenait a se faire crediter sans rien
     * rendre — et le registre redescendant juste apres, la boutique pouvait
     * reemettre l'exemplaire pendant que le fantome habillait toujours six
     * personnages. */
    const refusRachat = this._refusPorte(p, o.id, qte);
    if (refusRachat) throw new Error(refusRachat);

    /* La porte. Le message porte LE CHIFFRE QUI MANQUE : « il faut jouer plus »
       ne dit pas quoi faire, « il te reste 34 000 » si. */
    const v = this.rachatVerrou(addr);
    if (!v.ouvert) {
      throw new Error(`play ${v.reste.toLocaleString('en-US')} more volume to unlock instant sell` +
                      ` (${v.volume.toLocaleString('en-US')} / ${v.requis.toLocaleString('en-US')})`);
    }

    const unite = this.prixRachatDe(o.id);
    if (!(unite > 0)) throw new Error('this item cannot be sold back');
    const total = unite * qte;

    /* Tout d'un seul tenant. */
    p.objets[o.id] -= qte;
    if (!p.objets[o.id]) delete p.objets[o.id];
    p.balance = p.balance.add(WEI(total));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(total));

    /* ---- LE REGISTRE REDESCEND ----
     *
     * C'est ce qui remet l'objet en circulation. Jamais sous zero : un
     * registre negatif ferait afficher plus d'exemplaires restants qu'il n'en
     * existe, et le plafond ne voudrait plus rien dire. */
    if (cfg.RACHAT_RECYCLE) this._recycle(o.id, qte);

    /* Un rachat est une DEPENSE de la maison, pas une recette. La compter
       comme du revenu gonflerait le chiffre d'affaires et, par ricochet, le
       prix du classement qui en est une part. */
    this.note('rachat', -total, String(addr).toLowerCase());
    journal.ajoute(String(addr).toLowerCase(), { k: 'rc', item: o.id, m: String(total), q: qte });
    return { item: o.id, qte, unite, total, recycle: !!cfg.RACHAT_RECYCLE,
             balance: this.balanceStr(addr) };
  }

  /* ======================================================================
   * LE MARCHE
   * ======================================================================
   *
   * ---- l'objet est MIS SOUS SEQUESTRE, pas marque « en vente » ----
   *
   * A la mise en vente, l'objet QUITTE l'inventaire du vendeur et vit dans
   * l'annonce. Un drapeau « en vente » laisse sur place aurait demande de se
   * souvenir de le verifier partout — a la vente, au compte de la collection,
   * au classement, a la ligne complete — et il aurait suffi d'un endroit
   * oublie pour vendre deux fois le meme objet.
   *
   * Le sequestre rend la question impossible a poser : il n'est nulle part
   * ailleurs. En contrepartie il faut le RENDRE a l'annulation, et il doit
   * traverser les sauvegardes — les deux sont testes.
   *
   * ---- il ne fabrique rien ----
   *
   * `boutiqueEmis` n'est jamais touche par une vente. Une piece vendue est la
   * meme piece, chez quelqu'un d'autre. C'est la propriete qui protege
   * l'edition, et c'est la premiere chose que le test verifie.
   */

  /** Ce que le joueur possede VRAIMENT, hors ce qu'il a mis en vente. */
  _possede(p, itemId) { return (p.objets || {})[itemId] || 0; }

  marcheVend(addr, itemId, prixStr, qteStr) {
    const moi = String(addr).toLowerCase();
    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before selling items');

    const o = boutique.item(itemId);
    if (!o) throw new Error('unknown item');
    /* ---- LA QUANTITE ----
     *
     * Une annonce porte N exemplaires du meme objet. L'alternative — N
     * annonces d'un exemplaire — remplissait la vitrine de lignes identiques
     * et mangeait le quota d'annonces pour rien. Ici, cinq communs font une
     * ligne qui dit « x5 ». */
    const qte = Math.max(1, Math.floor(Number(qteStr) || 1));
    if (this._possede(p, o.id) < qte)
      throw new Error(qte > 1 ? `you only own ${this._possede(p, o.id)} of these` : 'you do not own this item');
    /* ---- CE QU'ON PORTE N'EST PAS A VENDRE ----
     * Le sequestre retire la piece du coffre, jamais du dos du personnage : le
     * vendeur encaissait des $SWOGE reels et gardait l'arme, qui continuait de
     * frapper. La meme regle qu'au coffre, au meme endroit dans l'ordre — juste
     * apres la possession, avant que le moindre chiffre bouge. */
    const refusVente = this._refusPorte(p, o.id, qte);
    if (refusVente) throw new Error(refusVente);

    const prix = Math.floor(Number(prixStr) || 0);
    if (!(prix >= cfg.MARCHE_PRIX_MIN))
      throw new Error('minimum price is ' + cfg.MARCHE_PRIX_MIN + ' $SWOGE');
    if (prix > cfg.MARCHE_PRIX_MAX)
      throw new Error('maximum price is ' + cfg.MARCHE_PRIX_MAX + ' $SWOGE');

    this.marche = this.marche || [];
    /* Les potions ne mangent pas le quota : vendre vingt-cinq potions ne doit
       pas empecher de mettre une epee en vitrine. Ce sont deux etals. */
    const miennes = this.marche.filter((a) => a.vendeur === moi && !a.pot).length;
    if (miennes >= cfg.MARCHE_ANNONCES_MAX)
      throw new Error('you already have ' + miennes + ' items for sale');

    /* SEQUESTRE ET ANNONCE D'UN SEUL TENANT : rien ne peut s'intercaler entre
       le retrait de l'inventaire et la creation de l'annonce. */
    p.objets[o.id] -= qte;
    if (!p.objets[o.id]) delete p.objets[o.id];
    const a = { id: this.marcheNo++, vendeur: moi, nomVendeur: p.name || moi.slice(0, 6),
                item: o.id, prix, qte, t: Date.now() };
    this.marche.push(a);
    journal.ajoute(moi, { k: 'mv', item: o.id, m: String(prix), q: qte });
    return this._annonceVue(a);
  }

  /*
   * ==================== LE MARCHE DES ANIMAUX ====================
   *
   * MEME liste, meme sequestre, meme chemin pour l'argent que les pieces et
   * les potions. Une annonce d'oeuf se reconnait a son champ `oeuf`, une
   * annonce de familier a son `fam`. Ouvrir une troisieme liste aurait voulu
   * dire reecrire une troisieme fois « la chose quitte le vendeur AVANT que
   * l'annonce existe » — et la rater d'un cote, c'est dupliquer ce qui tombe
   * une fois sur mille deux cents.
   *
   * ---- pourquoi le prix est LIBRE ----
   *
   * Le comptoir a potions est a prix fixe, et pour une bonne raison : deux
   * potions de vie sont identiques, donc un prix libre n'y produit pas un
   * marche mais une course vers le bas. Un oeuf de tenebre n'est pas une
   * potion, et un Prism de niveau quatre-vingts encore moins : il n'existe
   * qu'un exemplaire de CETTE bete, avec CETTE progression. Il n'y a rien a
   * sous-coter, donc rien a effondrer.
   *
   * ---- pourquoi le familier PART ----
   *
   * Vendre une copie serait fabriquer un familier. Celui qui achete recoit
   * exactement celui que l'autre a nourri, avec son XP ; le vendeur ne l'a
   * plus. C'est ce qui donne un prix a une progression — et c'est la seule
   * forme de vente qui ne cree rien.
   *
   * ---- et pourquoi on ne peut pas ACHETER un familier qu'on a deja ----
   *
   * Un compte ne tient qu'un exemplaire par espece : `p.familiers` est indexe
   * par elle. Deux Prism n'y rentrent pas, et l'achat ecraserait le premier.
   * Refuser est la seule reponse qui ne detruise rien. Un OEUF, lui, s'achete
   * meme si l'on a l'animal : il se range au coffre et se revend.
   */
  marcheVendOeuf(addr, espece, prixStr) {
    const moi = String(addr).toLowerCase();
    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before selling');
    const es = String(espece || '');
    if (!monde.OEUFS.includes(es)) throw new Error('unknown egg');
    p.coffreOeufs = p.coffreOeufs || {};
    if (!(p.coffreOeufs[es] > 0)) throw new Error('that egg is not in your vault');
    const prix = this._prixDAnnonce(prixStr);
    this._placeDansLaVitrine(moi);
    /* SEQUESTRE ET ANNONCE D'UN SEUL TENANT. */
    p.coffreOeufs[es] -= 1;
    if (p.coffreOeufs[es] <= 0) delete p.coffreOeufs[es];
    const a = { id: this.marcheNo++, vendeur: moi, nomVendeur: p.name || moi.slice(0, 6),
                oeuf: es, prix, qte: 1, t: Date.now() };
    this.marche = this.marche || [];
    this.marche.push(a);
    journal.ajoute(moi, { k: 'mv', oeuf: es, m: String(prix) });
    return this._annonceVue(a);
  }

  marcheVendFamilier(addr, espece, prixStr) {
    const moi = String(addr).toLowerCase();
    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before selling');
    const es = String(espece || '');
    p.familiers = p.familiers || {};
    const f = p.familiers[es];
    if (!f) throw new Error('you do not have that pet');
    const prix = this._prixDAnnonce(prixStr);
    this._placeDansLaVitrine(moi);
    /* Il quitte le compte, et il SORT s'il etait dehors : un compagnon qui
       continuerait de trotter derriere un vendeur qui ne l'a plus se lirait
       comme une vente qui n'a pas pris. */
    const xp = Math.max(0, f.xp | 0);
    delete p.familiers[es];
    if (p.familierActif === es) p.familierActif = null;
    const a = { id: this.marcheNo++, vendeur: moi, nomVendeur: p.name || moi.slice(0, 6),
                fam: { espece: es, xp }, prix, qte: 1, t: Date.now() };
    this.marche = this.marche || [];
    this.marche.push(a);
    journal.ajoute(moi, { k: 'mv', fam: es, m: String(prix) });
    return this._annonceVue(a);
  }

  /** Le prix d'une annonce, borne comme celui d'une piece. */
  _prixDAnnonce(prixStr) {
    const prix = Math.floor(Number(prixStr) || 0);
    if (!(prix >= cfg.MARCHE_PRIX_MIN))
      throw new Error('minimum price is ' + cfg.MARCHE_PRIX_MIN + ' $SWOGE');
    if (prix > cfg.MARCHE_PRIX_MAX)
      throw new Error('maximum price is ' + cfg.MARCHE_PRIX_MAX + ' $SWOGE');
    return prix;
  }

  /** Le quota d'annonces, compte comme pour les pieces. */
  _placeDansLaVitrine(moi) {
    this.marche = this.marche || [];
    const miennes = this.marche.filter((a) => a.vendeur === moi && !a.pot).length;
    if (miennes >= cfg.MARCHE_ANNONCES_MAX)
      throw new Error('you already have ' + miennes + ' items for sale');
  }

  marcheAnnule(addr, id) {
    const moi = String(addr).toLowerCase();
    const i = (this.marche || []).findIndex((a) => a.id === Number(id));
    if (i < 0) throw new Error('this listing no longer exists');
    const a = this.marche[i];
    if (a.vendeur !== moi) throw new Error('this listing is not yours');
    if (a.pot) throw new Error('use the potion counter to take those back');
    /* On RETIRE d'abord, on rend ensuite : l'inverse laisserait une fenetre ou
       l'objet est a la fois dans l'inventaire et en vente. */
    this.marche.splice(i, 1);
    const p = this._p(moi);
    /* ---- ET L'ANIMAL REVIENT LA D'OU IL VIENT ----
     * L'oeuf au coffre, le familier au compte. Une annonce retiree qui ne
     * rendrait rien serait une confiscation — et c'est justement ce que le
     * sequestre est cense empecher. */
    if (a.oeuf) {
      p.coffreOeufs = p.coffreOeufs || {};
      p.coffreOeufs[a.oeuf] = (p.coffreOeufs[a.oeuf] | 0) + 1;
      return { annule: a.id, oeuf: a.oeuf };
    }
    if (a.fam) {
      p.familiers = p.familiers || {};
      /* Il a pu en racheter un de la meme espece pendant que l'annonce
         courait. On garde alors le MEILLEUR des deux : rendre l'ancien
         ecraserait celui qu'il vient de payer. */
      const deja = p.familiers[a.fam.espece];
      if (!deja || (deja.xp | 0) < (a.fam.xp | 0)) {
        p.familiers[a.fam.espece] = { xp: a.fam.xp | 0, ne: Math.floor(Date.now() / 1000) };
      }
      return { annule: a.id, fam: a.fam.espece };
    }
    p.objets = p.objets || {};
    p.objets[a.item] = (p.objets[a.item] || 0) + (a.qte || 1);
    return { annule: a.id, item: a.item, qte: a.qte || 1 };
  }

  marcheAchete(addr, id) {
    const moi = String(addr).toLowerCase();
    const i = (this.marche || []).findIndex((x) => x.id === Number(id));
    if (i < 0) throw new Error('this listing no longer exists');
    const a = this.marche[i];
    if (a.pot) throw new Error('potions are bought by quantity, not by listing');
    /* ACHETER SA PROPRE ANNONCE EST REFUSE. Ce n'est pas une precaution
       theorique : c'est ainsi qu'on fabrique un faux prix de reference, en se
       vendant a soi-meme pour cinquante millions devant tout le monde. */
    if (a.vendeur === moi) throw new Error('you cannot buy your own listing');

    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before buying items');
    /* ---- ON NE TIENT QU'UN EXEMPLAIRE PAR ESPECE ----
     * `p.familiers` est indexe par l'espece : deux Prism n'y rentrent pas, et
     * l'achat ecraserait le premier — donc detruirait la progression que
     * l'acheteur a payee ailleurs. Le refus est la seule reponse qui ne
     * detruise rien, et il arrive AVANT que l'argent ne bouge. */
    if (a.fam && (p.familiers || {})[a.fam.espece]) {
      throw new Error('you already have that pet');
    }
    const prix = WEI(a.prix);
    if (p.balance.lt(prix)) throw new Error('not enough $SWOGE');
    /* Et ici aussi : acheter a un complice est un virement deguise. Il coute
       cinq pour cent au lieu de rien, ce qui rend la fuite moins rentable —
       pas moins reelle. */
    const refusCadeauM = this._gardeCadeau(p, prix);
    if (refusCadeauM) throw new Error(refusCadeauM);

    const v = this._p(a.vendeur);
    const frais = prix.mul(cfg.MARCHE_FRAIS_BPS).div(10000);
    const net = prix.sub(frais);

    /* Tout d'un seul tenant : l'annonce part, l'argent passe, l'objet arrive.
       Aucune de ces trois lignes ne peut echouer une fois ici. */
    /* L'annonce ne part que si elle se vide. Sinon elle reste, avec un
       exemplaire de moins : c'est ce qui permet a cinq personnes d'acheter la
       meme ligne l'une apres l'autre. */
    if ((a.qte || 1) > 1) a.qte = (a.qte || 1) - 1;
    else this.marche.splice(i, 1);
    p.balance = p.balance.sub(prix);
    v.balance = v.balance.add(net);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(prix);
    this._bumpDay(v); v.dayNet = v.dayNet.add(net);
    /* L'animal arrive chez l'acheteur. L'oeuf au coffre — il n'a pas de place
       dans un sac qui pourrait etre plein, et un achat qui echoue faute de
       place aurait pris l'argent. Le familier avec SON XP : c'est celui que
       l'autre a nourri, pas un neuf. */
    if (a.oeuf) {
      p.coffreOeufs = p.coffreOeufs || {};
      p.coffreOeufs[a.oeuf] = (p.coffreOeufs[a.oeuf] | 0) + 1;
    } else if (a.fam) {
      p.familiers = p.familiers || {};
      p.familiers[a.fam.espece] = { xp: a.fam.xp | 0, ne: Math.floor(Date.now() / 1000) };
    } else {
      p.objets = p.objets || {};
      p.objets[a.item] = (p.objets[a.item] || 0) + 1;
    }

    const mF = Number(ethers.utils.formatUnits(frais, cfg.DECIMALS));
    if (mF > 0) this.note('marche', mF, moi);
    v.trNonLus = (v.trNonLus || 0) + 1;
    journal.ajoute(moi, { k: 'ma', item: a.item, m: String(a.prix), autre: a.vendeur });
    journal.ajoute(a.vendeur, { k: 'mvend', item: a.item,
                                m: ethers.utils.formatUnits(net, cfg.DECIMALS), autre: moi });

    /* ---- LA LIGNE PEUT SE FERMER PAR UN ACHAT ----
     *
     * `_boutiqueLigne` est appele ici comme il l'est apres un coffre. C'est
     * une DECISION et non un effet de bord : la course recompense d'avoir
     * reuni une famille, pas d'avoir eu de la chance. Celui a qui il manque
     * un legendaire peut donc l'acheter — c'est exactement ce que le marche
     * existe pour permettre, et le prix qu'il paiera est fixe par celui qui
     * le detient.
     *
     * Ce qui ne suit PAS : l'XP. Deux comptes complices se revendraient le
     * meme objet en boucle, et chaque aller-retour paierait sa prime de
     * « jamais possede ». */
    const item = boutique.item(a.item);
    const ligne = item ? this._boutiqueLigne(p, item, Date.now()) : null;

    /* ---- CE QUE LE VENDEUR DOIT APPRENDRE ----
     *
     * C'est le seul comptoir du jeu ou deux joueurs echangent des $SWOGE
     * reels contre un bien, et c'etait le seul sans aucun signal : le vendeur
     * ne recevait qu'un compteur d'envois non lus, sa page continuait
     * d'afficher l'ancien solde et son annonce comme si elle courait toujours.
     * Un joueur qui ne voit pas sa vente aboutir conclut que le marche ne
     * marche pas — et le marche est justement ce qui donne une valeur aux
     * oeufs, aux familiers et aux legendaires.
     *
     * La description passe par `_annonceVue`, la MEME que la vitrine : la page
     * sait deja la dessiner, et une seconde forme d'annonce serait une seconde
     * facon de se tromper. Avec `qte: 1`, parce qu'on decrit CE QUI VIENT DE
     * PARTIR, pas ce qui reste en ligne. */
    const vente = {
      id: a.id,
      vendeur: a.vendeur,
      acheteur: moi,
      nomAcheteur: p.name || moi.slice(0, 6),
      prix: a.prix,
      frais: mF,
      net: Number(ethers.utils.formatUnits(net, cfg.DECIMALS)),
      /* Ce qu'il reste EN LIGNE apres ce depart : zero veut dire que l'annonce
         est fermee. Le vendeur doit pouvoir lire « il t'en reste trois » sans
         aller rouvrir la vitrine. */
      reste: this.marche.indexOf(a) >= 0 ? (a.qte || 1) : 0,
      annonce: this._annonceVue({ ...a, qte: 1 }),
    };

    return { item: a.item, prix: a.prix, vendeur: a.vendeur, ligne,
             frais: mF, vente, balance: this.balanceStr(moi) };
  }

  _annonceVue(a) {
    /* ---- UNE ANNONCE D'ANIMAL N'A PAS D'OBJET DE BOUTIQUE ----
     * `boutique.item(undefined)` rend rien, et la vitrine afficherait une
     * ligne sans nom ni couleur. On la decrit donc a part — c'est la meme
     * forme (`item`), remplie autrement, pour que la page n'ait qu'une facon
     * de lire une annonce. */
    if (a.oeuf) {
      return { id: a.id, prix: a.prix, qte: 1,
               vendeur: a.vendeur, nomVendeur: a.nomVendeur, t: a.t,
               oeuf: a.oeuf,
               item: { cle: 'oeuf_' + a.oeuf, nom: NOM_OEUF[a.oeuf] || 'Egg',
                       rarete: a.oeuf === 'legendaire' ? 'relique' : 'mythique',
                       rareteNom: a.oeuf === 'legendaire' ? 'Relic' : 'Mythic',
                       couleur: a.oeuf === 'legendaire' ? '#FFFFFF' : '#FF4655',
                       genre: 'oeuf' } };
    }
    if (a.fam) {
      const f = this.familierPour({ xp: a.fam.xp }, a.fam.espece);
      return { id: a.id, prix: a.prix, qte: 1,
               vendeur: a.vendeur, nomVendeur: a.nomVendeur, t: a.t,
               fam: f,
               item: { cle: 'pet_' + a.fam.espece, nom: f.nom + ' \u00b7 Lv ' + f.niveau,
                       rarete: 'relique', rareteNom: 'Pet', couleur: '#7CFF9B',
                       genre: 'familier' } };
    }
    const o = boutique.item(a.item) || {};
    const r = boutique.rarete(o.rarete) || {};
    return { id: a.id, prix: a.prix, qte: a.qte || 1,
             vendeur: a.vendeur, nomVendeur: a.nomVendeur, t: a.t,
             item: { id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete, famille: o.famille,
                     /* Le nom AFFICHABLE de la rarete part d'ici. La page
                        montrait la clef interne — « Mythique », « Legendaire » —
                        parce qu'elle n'avait que ca sous la main. Le serveur,
                        lui, connait les deux. */
                     rareteNom: r.nom || o.rarete, couleur: r.couleur || null,
                     saison: o.saison, plafond: r.plafond || 0,
                     emis: (this.boutiqueEmis || {})[o.id] || 0 } };
  }

  /**
   * La vitrine. Triee par rarete puis par prix : c'est l'ordre dans lequel on
   * cherche — on veut d'abord savoir s'il existe un mythique, ensuite combien.
   */
  marcheListe(addr, saison) {
    const moi = String(addr || '').toLowerCase();
    const inv = (this.players.get(moi) || {}).objets || {};
    const mesFam = (this.players.get(moi) || {}).familiers || {};
    const rang = {};
    boutique.RARETES.forEach((r, i) => { rang[r.cle] = i; });
    const l = (this.marche || [])
      /* Les annonces de potions vivent dans la MEME liste mais n'ont pas
         d'objet de boutique : `_annonceVue` les rendrait avec un item vide, et
         la vitrine afficherait des lignes sans nom ni rarete. */
      .filter((a) => !a.pot)
      .map((a) => this._annonceVue(a))
      /* Les animaux n'ont pas de saison : filtrer dessus les ferait
         disparaitre des que l'on choisit un onglet, c'est-a-dire presque
         toujours. */
      .filter((a) => !saison || a.oeuf || a.fam || a.item.saison === Number(saison))
      /* `jaiDeja` est calcule ICI et non dans la page : c'est le seul filtre
         qui compte vraiment pour un collectionneur — on ouvre un marche pour
         combler un trou, pas pour racheter ce qu'on a. */
      /* `jaiDeja` est la question du COLLECTIONNEUR, et elle n'a pas la meme
         reponse pour un animal : pour une piece c'est « j'en ai deja une »,
         pour un familier c'est « je ne PEUX pas l'acheter » — un compte ne
         tient qu'un exemplaire par espece. Pour un oeuf, c'est « je l'ai deja
         fait eclore », donc je ne pourrai pas l'ouvrir. */
      .map((a) => Object.assign(a, {
        jaiDeja: a.fam ? !!(mesFam || {})[a.fam.espece]
               : a.oeuf ? !!(mesFam || {})[a.oeuf]
               : !!inv[a.item.id],
        mien: a.vendeur === moi }));
    /* Les animaux d'abord, quelle que soit leur rarete nominale : c'est ce
       qu'on vient chercher, et les noyer entre deux epees communes reviendrait
       a ne pas les vendre. Ensuite l'ordre habituel — le plus rare en tete,
       puis le moins cher. */
    const animal = (a) => (a.oeuf || a.fam) ? 1 : 0;
    l.sort((x, y) => (animal(y) - animal(x)) ||
                     (rang[y.item.rarete] - rang[x.item.rarete]) || (x.prix - y.prix));
    return { annonces: l, miennes: l.filter((a) => a.vendeur === moi).map((a) => a.id),
             frais: cfg.MARCHE_FRAIS_BPS / 100,
             min: cfg.MARCHE_PRIX_MIN, max: cfg.MARCHE_PRIX_MAX };
  }

  /*
   * ==================== LE MARCHE DES POTIONS ====================
   *
   * MEME marche que celui des pieces — meme liste, meme sequestre, meme
   * chemin pour l'argent. Une annonce de potion se reconnait a son champ
   * `pot` ; une annonce de piece a son `item`. Ouvrir une deuxieme liste
   * aurait voulu dire ecrire une deuxieme fois « l'objet quitte l'inventaire
   * avant que l'annonce existe », et c'est exactement la phrase qu'on ne veut
   * ecrire qu'une fois : la rater du deuxieme cote, c'est dupliquer des
   * potions.
   *
   * Trois choses les separent, et elles se lisent toutes ici :
   *   - le prix n'est pas choisi, il est IMPOSE (voir REVENTE_PRIX) ;
   *   - la maison prend la moitie, pas les frais du marche aux pieces ;
   *   - on n'achete pas UNE annonce, on achete UNE QUANTITE : deux potions de
   *     vie sont identiques, choisir entre elles serait un ecran a lire pour
   *     un choix qui n'existe pas. On sert donc dans l'ordre d'arrivee.
   */

  /**
   * Combien il en a SOUS LA MAIN — ce qui est en vente n'est plus a lui.
   *
   * Une fiole de stat vit a DEUX endroits : le coffre, ou elle survit a la
   * mort, et le sac, ou elle part avec le personnage. On compte les deux. Ne
   * regarder que le coffre laissait le comptoir vide devant un joueur qui a la
   * fiole sur lui — et lui dire « tu n'en as pas » pendant qu'elle est dans
   * son sac est la pire reponse possible : elle est fausse.
   */
  _potInventaire(p, cle) {
    if (cle.slice(0, 3) === 'st:') {
      const st = cle.slice(3);
      return Math.max(0, ((p.fioles || {})[st]) | 0)
           + Math.max(0, ((p.sacFioles || {})[st]) | 0);
    }
    return Math.max(0, ((p.potions || {})[cle]) | 0);
  }

  /**
   * Retirer de l'inventaire pour sequestrer. Rend ce qui a REELLEMENT ete pris.
   *
   * Pour une fiole de stat, on prend DU SAC D'ABORD. C'est la meme regle que
   * pour la boire : ce qu'on porte est ce qui peut se perdre, donc ce dont on
   * se defait en premier. Vider le coffre pendant qu'une fiole risque sa peau
   * dans le sac serait exactement le contraire.
   */
  _potRetire(p, cle, n) {
    const pris = Math.min(n, this._potInventaire(p, cle));
    if (pris <= 0) return 0;
    if (cle.slice(0, 3) === 'st:') {
      const st = cle.slice(3);
      let reste = pris;
      p.sacFioles = p.sacFioles || {};
      const duSac = Math.min(reste, Math.max(0, p.sacFioles[st] | 0));
      if (duSac > 0) {
        p.sacFioles[st] -= duSac;
        if (p.sacFioles[st] <= 0) delete p.sacFioles[st];
        reste -= duSac;
      }
      if (reste > 0) {
        p.fioles = p.fioles || {};
        p.fioles[st] -= reste;
        if (p.fioles[st] <= 0) delete p.fioles[st];
      }
      p.sacCases = null;
    } else {
      p.potions = p.potions || {};
      p.potions[cle] -= pris;
      if (p.potions[cle] <= 0) delete p.potions[cle];
    }
    return pris;
  }

  /**
   * Livrer. Rend ce qui a REELLEMENT tenu.
   *
   * Les potions de soin ont un plafond de PORT — quatre-vingt-dix-neuf — et il
   * s'applique aussi bien a l'achat qu'au retrait d'une annonce. C'est
   * pourquoi cette methode rend un nombre au lieu de reussir en silence :
   * l'appelant doit pouvoir ne facturer que ce qu'il a livre, et ne retirer de
   * l'annonce que ce qu'il a rendu. Une fiole de stat, elle, va au COFFRE, qui
   * n'a pas de fond.
   */
  _potDonne(p, cle, n, versLeSac) {
    if (n <= 0) return 0;
    if (cle.slice(0, 3) === 'st:') {
      const st = cle.slice(3);
      /* ---- ELLE REVIENT LA OU ON LA VOIT ----
       * Reprendre une annonce la rendait toujours au COFFRE. Celui qui l'avait
       * mise en vente depuis son sac ne la retrouvait donc nulle part ou il
       * l'avait laissee : ni dans le sac, ni sur lui — il fallait deviner
       * d'aller ouvrir le coffre. On la rend au SAC quand sa pile a de la
       * place, et au coffre seulement quand elle est pleine. Un achat, lui, va
       * toujours au coffre : on ne vient pas d'acheter pour risquer tout de
       * suite.
       *
       * ---- ET CE N'EST PLUS LE SAC DE BUTIN QUI DECIDE ----
       * Cette condition lisait `sacRempli() < SAC_CASES`, ecrite du temps ou
       * une fiole occupait une des huit places. Elles ont quitte la grille
       * depuis, pour leur propre reserve — mais la condition est restee. Elle
       * envoyait donc au coffre la fiole d'un joueur dont le sac etait plein
       * d'ARMURE, alors que sa reserve de fioles etait vide : exactement le
       * « il faut deviner d'aller ouvrir le coffre » que ces lignes venaient
       * de corriger, ressuscite par un plafond qui n'a plus rien a voir.
       * Le seul plafond qui compte pour une fiole est celui de SA PILE —
       * `monde.FIOLE_PILE`, le meme que `prendFiole` fait respecter. */
      if (versLeSac) {
        p.sacFioles = p.sacFioles || {};
        const deja = Math.max(0, p.sacFioles[st] | 0);
        /* Ce qui tient dans la pile y va ; le reste passe au coffre plutot que
           de se perdre ou de faire echouer la reprise entiere. */
        const tient = Math.max(0, Math.min(n, monde.FIOLE_PILE - deja));
        if (tient > 0) {
          p.sacFioles[st] = deja + tient;
          p.sacCases = null;
        }
        if (tient >= n) return n;
        p.fioles = p.fioles || {};
        p.fioles[st] = (p.fioles[st] || 0) + (n - tient);
        return n;
      }
      p.fioles = p.fioles || {};
      p.fioles[st] = (p.fioles[st] || 0) + n;
      return n;
    }
    p.potions = p.potions || {};
    const deja = Math.max(0, p.potions[cle] | 0);
    const tient = Math.min(n, POTIONS_MAX - deja);
    if (tient <= 0) return 0;
    p.potions[cle] = deja + tient;
    return tient;
  }

  _nomMarche(cle) {
    if (cle.slice(0, 3) === 'st:') return cle.slice(3).toUpperCase() + ' potion';
    return POTIONS[cle].nom;
  }

  /** Les annonces de potions, les plus anciennes d'abord : premier arrive, premier paye. */
  _filePotions(cle) {
    return (this.marche || [])
      .filter((a) => a.pot === cle && (a.qte || 0) > 0)
      .sort((x, y) => (x.t || 0) - (y.t || 0));
  }

  /**
   * L'etat du marche aux potions pour un joueur : ce qu'il a, ce qu'il a mis
   * en vente, et ce que le serveur a en stock.
   */
  potionsMarche(addr) {
    const moi = String(addr || '').toLowerCase();
    const p = this._p(moi);
    /* ---- « EN STOCK » VEUT DIRE « QUE TU PEUX ACHETER » ----
     *
     * Le compte incluait SES PROPRES annonces. L'achat, lui, les saute — on ne
     * se rachete pas a soi-meme, on y perdrait la moitie du prix a chaque
     * tour. Un joueur seul a vendre lisait donc « 1 en stock » et se faisait
     * repondre « rupture de stock » en cliquant : les deux phrases etaient
     * justes chacune de son cote, et ensemble elles decrivaient une panne.
     *
     * Une seule definition, celle de l'acheteur : ce qui est en vente ET qui
     * n'est pas a lui. Ce qu'il a mis en vente se lit a cote, dans `enVente` —
     * c'est une autre question, et elle a deja sa reponse. */
    /* ---- DEUX CHIFFRES, PARCE QU'IL Y A DEUX QUESTIONS ----
     *
     * `stock` : ce que CE joueur peut acheter — donc tout sauf ses propres
     * annonces, qu'il ne se rachete pas. C'est lui qui commande le bouton.
     * `total` : tout ce qui est en vente, le sien compris. C'est lui qui
     * decide si la ligne EXISTE au rayon.
     *
     * N'en garder qu'un cassait quelque chose a chaque fois. Avec le total
     * seul, un vendeur unique lisait « 1 en stock » et se faisait repondre
     * « rupture » en cliquant. Avec le stock seul, il mettait ses potions en
     * vente et voyait un magasin VIDE — sans aucun moyen de verifier que son
     * annonce existait. Les deux questions sont legitimes ; elles ont chacune
     * leur chiffre. */
    const stock = {}, mien = {}, total = {};
    for (const a of (this.marche || [])) {
      if (!a.pot) continue;
      total[a.pot] = (total[a.pot] || 0) + (a.qte || 0);
      if (a.vendeur === moi) mien[a.pot] = (mien[a.pot] || 0) + (a.qte || 0);
      else stock[a.pot] = (stock[a.pot] || 0) + (a.qte || 0);
    }
    const cles = Object.keys(POTIONS).concat(personnages.STATS.map((s) => 'st:' + s));
    return {
      maison: REVENTE_MAISON_BPS / 100,
      /* Le fond de la maison ne concerne QUE les potions de soin : une fiole
         de stat n'a jamais eu de vendeur autre qu'un joueur, et lui en
         fabriquer un ici detruirait la seule chose qui fait son prix. */
      fond: !!cfg.POTIONS_FOND_MAISON,
      lignes: cles.map((k) => ({
        cle: k, nom: this._nomMarche(k),
        stat: k.slice(0, 3) === 'st:' ? k.slice(3) : null,
        image: POTIONS[k] ? POTIONS[k].image : null,
        /* SA colonne sur la planche des fioles, comptee ici : l'ordre des
           stats n'existe cote page que dans le monde de combat, et la laisser
           le deviner dessinerait huit fois la meme fiole. */
        col: k.slice(0, 3) === 'st:' ? personnages.STATS.indexOf(k.slice(3)) : 0,
        cols: personnages.STATS.length,
        pas: k.slice(0, 3) === 'st:' ? personnages.supPas(k.slice(3)) : 0,
        prix: prixMarche(k), gain: partVendeur(prixMarche(k)),
        stock: stock[k] || 0, total: total[k] || 0,
        enVente: mien[k] || 0, jai: this._potInventaire(p, k),
        /* Le plafond de port, pour que la page grise « acheter » avant le
           clic plutot qu'apres le refus. */
        porte: POTIONS[k] ? POTIONS_MAX : 0,
      })),
    };
  }

  /**
   * METTRE EN VENTE.
   *
   * Le sequestre et l'annonce sont d'un seul tenant, comme pour les pieces :
   * rien ne peut s'intercaler entre le retrait de l'inventaire et la creation
   * de l'annonce. Un joueur qui approvisionne DEUX fois garde sa place dans la
   * file — sa premiere annonce grossit au lieu d'en creer une seconde. C'est
   * volontaire : la file recompense d'avoir stocke tot, et retomber au bout
   * parce qu'on ajoute une potion punirait exactement le comportement qu'on
   * cherche a obtenir.
   */
  metPotionEnVente(addr, cleBrute, quantite) {
    const cle = cleMarcheValide(cleBrute);
    if (!cle) throw new Error('Unknown potion');
    const moi = String(addr).toLowerCase();
    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before selling');
    const veut = Math.max(1, Math.floor(Number(quantite) || 1));
    const jai = this._potInventaire(p, cle);
    if (jai <= 0) throw new Error('You have no ' + this._nomMarche(cle) + ' to sell');
    const n = Math.min(veut, jai);

    this.marche = this.marche || [];
    const pris = this._potRetire(p, cle, n);
    if (pris <= 0) throw new Error('You have no ' + this._nomMarche(cle) + ' to sell');
    const deja = (this.marche || []).find((a) => a.pot === cle && a.vendeur === moi);
    if (deja) deja.qte = (deja.qte || 0) + pris;
    else {
      this.marche.push({ id: this.marcheNo++, vendeur: moi,
                         nomVendeur: p.name || moi.slice(0, 6),
                         pot: cle, prix: prixMarche(cle), qte: pris, t: Date.now() });
    }
    p.sacCases = null;
    journal.ajoute(moi, { k: 'pv', pot: cle, q: pris, m: String(prixMarche(cle)) });
    return { cle, misEnVente: pris, ...this.potionsMarche(moi) };
  }

  /**
   * REPRENDRE CE QU'ON A MIS EN VENTE.
   *
   * Sans ce geste, une potion que personne n'achete serait confisquee. On ne
   * rend que ce qui TIENT — le plafond de port existe toujours — et l'annonce
   * ne perd que ce qui a ete rendu : autrement une reprise refusee par le
   * plafond detruirait des potions au lieu de ne rien faire.
   */
  retirePotionDeLaVente(addr, cleBrute, quantite) {
    const cle = cleMarcheValide(cleBrute);
    if (!cle) throw new Error('Unknown potion');
    const moi = String(addr).toLowerCase();
    const i = (this.marche || []).findIndex((a) => a.pot === cle && a.vendeur === moi);
    if (i < 0) throw new Error('You have none of those for sale');
    const a = this.marche[i];
    const veut = Math.max(1, Math.floor(Number(quantite) || 1));
    const p = this._p(moi);
    const rendu = this._potDonne(p, cle, Math.min(veut, a.qte || 0), true);
    if (rendu <= 0) throw new Error('You already carry ' + POTIONS_MAX + ' of those');
    a.qte = (a.qte || 0) - rendu;
    if (a.qte <= 0) this.marche.splice(i, 1);
    p.sacCases = null;
    return { cle, repris: rendu, ...this.potionsMarche(moi) };
  }

  /**
   * ACHETER AUX JOUEURS.
   *
   * Interne : ne touche ni au plafond de port ni au fond de la maison, et ne
   * livre rien. Elle prend l'argent, elle paie les vendeurs, et elle rend
   * combien d'exemplaires elle a reussi a reunir. C'est l'appelant qui livre —
   * parce que lui seul sait quoi faire du reste.
   *
   * On saute SES PROPRES annonces. Se les racheter serait perdre la moitie du
   * prix a chaque tour pour rien ; en faire une erreur bloquerait un joueur qui
   * a mis dix potions en vente et veut en acheter d'autres.
   */
  _acheteAuxJoueurs(p, cle, veut) {
    const moi = String(p.addr || '').toLowerCase();
    const file = this._filePotions(cle).filter((a) => a.vendeur !== moi);
    const dispo = file.reduce((n, a) => n + (a.qte || 0), 0);
    const prix = prixMarche(cle);
    /* On ne prend que ce que le SOLDE permet : facturer d'abord et decouvrir
       ensuite qu'il manque de quoi payer laisserait un achat a moitie fait. */
    const solde = Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS));
    const payables = prix > 0 ? Math.floor(solde / prix) : 0;
    const n = Math.min(veut, dispo, payables);
    if (n <= 0) return 0;

    const part = partVendeur(prix);
    let reste = n;
    for (const a of file) {
      if (reste <= 0) break;
      const k = Math.min(reste, a.qte || 0);
      if (k <= 0) continue;
      a.qte -= k;
      reste -= k;
      const v = this._p(a.vendeur);
      const net = WEI(part * k);
      v.balance = v.balance.add(net);
      this._bumpDay(v); v.dayNet = v.dayNet.add(net);
      v.trNonLus = (v.trNonLus || 0) + 1;
      journal.ajoute(a.vendeur, { k: 'pvend', pot: cle, q: k,
                                  m: String(part * k), autre: moi });
    }
    /* Les annonces videes partent MAINTENANT : une annonce a zero exemplaire
       resterait dans la file et compterait comme du stock. */
    this.marche = (this.marche || []).filter((a) => !a.pot || (a.qte || 0) > 0);

    const cout = WEI(prix * n);
    p.balance = p.balance.sub(cout);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(cout);
    /* La part de la maison, notee comme celle du marche aux pieces : c'est du
       revenu de la meme nature, il se lit au meme endroit. */
    const maison = (prix - part) * n;
    if (maison > 0) this.note('marche', maison, moi);
    journal.ajoute(moi, { k: 'pa', pot: cle, q: n, m: String(prix * n) });
    return n;
  }

  /**
   * ACHETER UNE FIOLE DE STAT.
   *
   * Il n'y a PAS de fond de la maison ici, et il ne faut pas qu'il y en ait :
   * une fiole de stat est un acquis permanent, et la seule chose qui la rend
   * chere est qu'aucune n'existe que celles qu'un joueur est alle chercher. En
   * vendre a volonte reviendrait a vendre des statistiques.
   */
  acheteFioleAuMarche(addr, stat, quantite) {
    const cle = cleMarcheValide('st:' + String(stat || ''));
    if (!cle) throw new Error('Unknown stat');
    const moi = String(addr).toLowerCase();
    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before buying');
    const veut = Math.max(1, Math.floor(Number(quantite) || 1));
    const dispo = this._filePotions(cle)
      .filter((a) => a.vendeur !== moi)
      .reduce((n, a) => n + (a.qte || 0), 0);
    if (dispo <= 0) throw new Error('No ' + this._nomMarche(cle) + ' for sale right now');
    const prix = prixMarche(cle);
    /* Meme regle que pour les potions de soin : on borne par ce qui EXISTE,
       puis on refuse en entier si le solde ne suit pas. Livrer une fiole sur
       trois parce que le compte s'est vide en route serait la surprise que
       `potions.test.js` interdit depuis le premier jour. */
    const veutVraiment = Math.min(veut, dispo);
    if (p.balance.lt(WEI(prix * veutVraiment))) throw new Error('Not enough $SWOGE');
    const pris = this._acheteAuxJoueurs(p, cle, veutVraiment);
    if (pris <= 0) throw new Error('Not enough $SWOGE');
    this._potDonne(p, cle, pris);
    p.sacCases = null;
    return { cle, stat: cle.slice(3), achete: pris, paye: prix * pris,
             balance: this.balanceStr(moi), fioles: this.fiolesPour(moi),
             ...this.potionsMarche(moi) };
  }

  fairness(addr) {
    const p = this._p(addr);
    return { serverSeedHash: this.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce };
  }
}

/* ---- LA GRILLE DE SCORES SUR LAQUELLE ON MESURE L'ENGAGEMENT ----
 * Voir `engagementMatch` : ce n'est pas un echantillon, c'est une enveloppe.
 * Au-dela de quatre buts par equipe, l'ensemble des reponses gagnantes ne
 * change plus — un 12-0 paie exactement les memes paris qu'un 8-0. */
Game.ENGAGEMENT_BUTS = 8;

module.exports = { Game, COST, MINW };
