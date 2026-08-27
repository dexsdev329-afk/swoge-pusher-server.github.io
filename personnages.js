'use strict';
/*
 * LES PERSONNAGES — stats, niveau et equipement PAR SKIN.
 *
 * ---- ce que ce fichier est, et ce qu'il n'est pas ----
 *
 * Un skin achete dans skins.js n'etait qu'une apparence. Ce module lui donne
 * une PROGRESSION QUI LUI EST PROPRE : chaque skin possede est sa propre
 * classe, avec son propre niveau, sa propre XP, ses propres stats. Jouer avec
 * Landwolf actif ne fait pas progresser Pepe — exactement comme RotMG, ou
 * jouer un Wizard ne fait pas monter le Warrior.
 *
 * ---- CE QUE CE FICHIER NE FAIT PAS ENCORE, VOLONTAIREMENT ----
 *
 * Aucune de ces stats ne touche a un vrai combat. ATT, DEF, SPD… existent
 * pour etre LUES et COMPARE, pas pour changer l'issue d'une manche : le jeu
 * qui les utilisera vraiment viendra plus tard. Les poser maintenant sans
 * pretendre qu'elles font deja quelque chose est le seul choix honnete tant
 * que ce jeu n'existe pas.
 *
 * Comme boutique.js et skins.js, ce module est PUR : aucun solde, aucun
 * inventaire, aucun reseau. Il repond a « voici un niveau et un equipement,
 * quelles sont les stats ? ». La possession, l'XP accumulee et l'equipement
 * choisi vivent dans game.js, comme pour boutique.js.
 *
 * ---- LES HUIT STATS, ET D'OU ELLES VIENNENT ----
 *
 * HP, MP, ATT, DEF, SPD, DEX, VIT, WIS — les huit stats de Realm of the Mad
 * God (realmeye.com/wiki/character-stats). Le nombre n'est pas invente : le
 * jeu de personnage promis a un joueur qui connait deja ce vocabulaire, et le
 * reutiliser evite d'en inventer un neuvieme dont personne n'a besoin.
 *
 * ---- LA TABLE DE BASE PAR SKIN ----
 *
 * Six archetypes distincts, dans l'esprit des dix-neuf classes de RotMG : une
 * stat haute, une stat basse, jamais un profil plat — sauf Brett, qui est
 * VOLONTAIREMENT plat. C'est la reponse au « sixieme personnage qui est
 * toutes les classes possibles » : pas un septieme skin a dessiner, celui
 * qu'on a deja rempli ce role dans la grille des six.
 *
 * Ces nombres sont le PLAFOND — la valeur au niveau maximum, sans
 * equipement. Comme la table « Base stat cap comparison » de RotMG.
 */
const STATS = ['hp', 'mp', 'att', 'def', 'spd', 'dex', 'vit', 'wis'];

const BASE = {
  andy:     { hp: 700, mp: 300, att: 55, def: 25, spd: 65, dex: 75, vit: 40, wis: 50 }, // rodeur nerveux
  claude:   { hp: 700, mp: 400, att: 50, def: 25, spd: 50, dex: 60, vit: 40, wis: 75 }, // caster analytique
  pepe:     { hp: 750, mp: 300, att: 60, def: 25, spd: 75, dex: 70, vit: 40, wis: 50 }, // coureur
  landwolf: { hp: 800, mp: 300, att: 60, def: 35, spd: 45, dex: 45, vit: 71, wis: 45 }, // encaisseur nonchalant — vit=71 pas 70 : casse l'egalite de somme avec claude (skins.js s'en sert pour classer la puissance)
  ogswoge:  { hp: 800, mp: 300, att: 70, def: 40, spd: 45, dex: 45, vit: 75, wis: 45 }, // tank, le mascotte
  brett:    { hp: 750, mp: 350, att: 55, def: 50, spd: 55, dex: 55, vit: 52, wis: 55 }, // generaliste — VOLONTAIREMENT plat
};

/* ======================================================================
 * LE NIVEAU ET L'XP — UNE COURBE DEDIEE, PAS CELLE DU COMPTE
 * ======================================================================
 *
 * L'XP de compte mesure une VIE ENTIERE sur le site (niveau 100, des
 * milliards de volume). Celle-ci mesure UNE CLASSE, et doit se sentir comme
 * RotMG : un PALIER a 20, atteignable en quelques jours de jeu actif avec ce
 * skin porte — pas en quelques mois. Le plafond, lui, est monte a 100 depuis
 * (note juste en dessous), mais c'est un prolongement : le palier est reste ce
 * qu'il etait, et c'est encore lui qui donne son rythme aux debuts.
 *
 * Meme forme mathematique que l'XP de compte (game.js), reprise ici pour la
 * meme raison qu'elle existe la-bas : deriver l'XP du volume EXACTEMENT comme
 * on derive le niveau du volume, avec l'exposant qui relie les deux courbes,
 * pour que les deux methodes de calcul ne puissent jamais se contredire.
 */
/* ---- LE PLAFOND MONTE A CENT, ET LE CHEMIN DES VINGT PREMIERS NE BOUGE PAS
 *
 * DEMANDE : « on peut monter notre personnage jusqu'au level 100 et avoir de
 * meilleures stats, comme ca dans SWOGE World ».
 *
 * Deux pieges, mesures avant d'ecrire :
 *
 * 1. MONTER LE PLAFOND AFFAIBLIT TOUT LE MONDE. `statAuNiveau` interpole
 *    « niveau max = cent pour cent de la naissance ». Passer le max de vingt a
 *    cent aurait ramene un personnage niveau vingt de sept cents points de vie
 *    a quatre cent dix-sept — soixante pour cent. Un joueur se serait fait
 *    voler la moitie de son personnage pendant son sommeil.
 * 2. LA COURBE DE VINGT NE VA PAS JUSQU'A CENT. En cube, le niveau cent
 *    demanderait deux cent cinquante MILLIONS de volume mise, contre deux
 *    millions pour le vingtieme. Cent vingt-cinq fois plus : injouable, et
 *    quatre-vingts niveaux qui ne veulent rien dire.
 *
 * D'ou la forme retenue : VINGT RESTE LE PALIER. Tout ce qui menait au
 * vingtieme niveau est inchange, au chiffre pres — meme courbe, meme XP, meme
 * volume, memes stats. Au-dela commence une seconde pente, plus douce, qui
 * mene a cent : c'est un PROLONGEMENT, pas un remplacement.
 *
 * Et la Fame ne bouge pas non plus : sa cassure reste calee sur le PALIER et
 * non sur le nouveau plafond. Elle a ete choisie pour faire du vingtieme
 * niveau « un premier palier lisible, puis un long entretien » — la deplacer a
 * cent aurait double la Fame facile de tout le jeu sans que personne ne l'ait
 * demande.
 */
const NIVEAU_MAX = 100;
const NIVEAU_PALIER = 20;      // le premier palier : la naissance a tout donne ici
const NIVEAU_BASE = 250;       // volume (sur ce skin) pour le niveau 1
const NIVEAU_PUISSANCE = 3;    // niveau 20 = 250 * 20^3 = 2 000 000 de volume
const XP_BASE = 100;
const XP_PUISSANCE = 2;        // niveau 20 = 100 * 20^2 = 40 000 xp

/* ---- CE QUE COUTE LE DERNIER NIVEAU ----
 * Ecrit comme une INTENTION — « quatre fois le palier » — et non comme un
 * exposant. L'exposant s'en deduit juste en dessous : le jour ou l'on veut un
 * niveau cent plus cher ou moins cher, on change ce nombre-la, celui qu'on
 * sait lire, et le reste suit. */
const VOLUME_CENT = 4 * NIVEAU_BASE * Math.pow(NIVEAU_PALIER, NIVEAU_PUISSANCE);   // 8 000 000

const XP_PALIER = XP_BASE * Math.pow(NIVEAU_PALIER, XP_PUISSANCE);                 // 40 000
/* L'XP du dernier niveau, DERIVEE du volume vise par la meme relation que
   partout ailleurs (`xpDuVolume`) : les deux courbes ne peuvent pas diverger. */
const XP_CENT = XP_BASE * Math.pow(VOLUME_CENT / NIVEAU_BASE, XP_PUISSANCE / NIVEAU_PUISSANCE);
/* La pente du haut, deduite des deux bouts. On ne l'ecrit pas a la main :
   un exposant recopie serait un troisieme chiffre a tenir d'accord. */
const XP_PUISSANCE_HAUT =
  Math.log(XP_CENT / XP_PALIER) / Math.log(NIVEAU_MAX / NIVEAU_PALIER);

/** Le volume (sur ce skin) qu'il faut pour atteindre le niveau n.
 *  DERIVE de l'XP, par la relation inverse de `xpDuVolume` : sous le palier
 *  cela rend exactement `250 * n^3`, comme avant, au chiffre pres. */
function volumePour(n) {
  return Math.round(NIVEAU_BASE *
    Math.pow(xpPour(n) / XP_BASE, NIVEAU_PUISSANCE / XP_PUISSANCE));
}
/** L'XP dediee qu'il faut pour atteindre le niveau n. */
function xpPour(n) {
  const x = Math.max(1, Math.min(NIVEAU_MAX, Number(n) || 1));
  if (x <= NIVEAU_PALIER) return XP_BASE * Math.pow(x, XP_PUISSANCE);
  /* ARRONDI, et ce n'est pas cosmetique : la courbe doit etre RECIPROQUE —
     traduire le niveau en volume puis le volume en xp doit retomber sur le
     meme nombre. Sous le palier c'est gratuit, `100 * n^2` etant entier ; au
     dessus la pente rend des decimales, et l'aller-retour ne retombait plus
     juste. L'essai `personnages.test.js` le verifie a chacun des cent
     niveaux, et c'est lui qui l'a dit. */
  return Math.round(XP_PALIER * Math.pow(x / NIVEAU_PALIER, XP_PUISSANCE_HAUT));
}
/** Le volume (sur ce skin), traduit en XP dediee. Meme derivation que
 *  Game.xpDuVolume, sur cette courbe-ci. */
function xpDuVolume(volume) {
  const v = Number(volume) || 0;
  if (v <= 0) return 0;
  const e = XP_PUISSANCE / NIVEAU_PUISSANCE;
  return XP_BASE * Math.pow(v / NIVEAU_BASE, e);
}
/** Le niveau que donne une XP dediee. */
function niveauDeXp(xp) {
  const x = Number(xp) || 0;
  if (x < XP_BASE) return 0;
  /* Deux pentes, donc deux inverses. Le meme `1e-9` des deux cotes : sans lui
     une XP posee EXACTEMENT sur un palier rend le niveau d'en dessous, par le
     dernier bit de la division. */
  if (x <= XP_PALIER) {
    const n = Math.floor(Math.pow(x / XP_BASE, 1 / XP_PUISSANCE) + 1e-9);
    return Math.max(0, Math.min(NIVEAU_MAX, n));
  }
  let n = Math.floor(
    NIVEAU_PALIER * Math.pow(x / XP_PALIER, 1 / XP_PUISSANCE_HAUT) + 1e-9);
  /* ---- ET LA TABLE FAIT FOI, LUE AVEC LE MEME ARRONDI QU'ELLE ----
   * `xpPour` arrondit au-dessus du palier ; la forme fermee, elle, ne connait
   * pas cet arrondi et retombait un cran trop bas sur la moitie des niveaux du
   * haut. On la recale donc sur la table plutot que d'ajuster une epsilon au
   * juge — deux comparaisons au plus, et le resultat est JUSTE par
   * construction.
   *
   * La comparaison se fait sur l'XP ARRONDIE, parce que la table l'est aussi :
   * une XP derivee d'un volume (`xpDuVolume`) tombe a un cheveu SOUS son
   * palier — 39 999.999… pour 40 000 — et la comparer brute rendait le niveau
   * d'en dessous. Arrondir des deux cotes, c'est comparer deux choses de meme
   * nature ; la tolerance ainsi accordee vaut moins d'un point d'XP. */
  const t = Math.round(x);
  while (n < NIVEAU_MAX && t >= xpPour(n + 1)) n++;
  while (n > NIVEAU_PALIER && t < xpPour(n)) n--;
  return Math.max(0, Math.min(NIVEAU_MAX, n));
}

/**
 * ==================== LA FAME ====================
 *
 * Deux taux, comme dans RotMG : genereux jusqu'au plafond de niveau, deux
 * fois plus lent apres. La cassure tombe exactement sur le plafond, ce qui
 * fait de « monter niveau 20 » un premier palier lisible, et de tout ce qui
 * suit un long entretien.
 *
 * ---- ce qu'on garde de RotMG, et ce qu'on adapte ----
 *
 * On garde les DEUX TAUX tels quels (900 puis 2000 XP par point). On
 * n'adapte pas le SEUIL : le leur vaut 18 050 XP, le notre 40 000 — c'est
 * notre propre courbe de niveaux, et la recopier aurait place la cassure au
 * milieu de nulle part. Consequence assumee : atteindre le niveau 20 rend
 * ~44 points chez nous contre ~20 chez eux. La Fame est une monnaie neuve,
 * sans economie existante a respecter, donc son abondance absolue importe
 * moins que sa FORME — un palier franc, puis un ralentissement net.
 *
 * ---- pourquoi la Fame n'est pas STOCKEE sur le personnage ----
 *
 * Elle se deduit de son XP, qui se deduit lui-meme de son volume mise. La
 * garder a cote serait un troisieme chiffre a tenir d'accord avec les deux
 * autres — et le jour ou ils divergeraient, c'est la Fame qui aurait tort
 * sans que rien ne le dise. Seul le TOTAL DU COMPTE est stocke, parce que
 * lui ne se deduit de rien : il est la somme de ce que les morts
 * successives ont verse.
 */
const XP_PAR_FAME = 900;          // jusqu'au plafond de niveau
const XP_PAR_FAME_APRES = 2000;   // au-dela

function fameDeXp(xp) {
  const x = Math.max(0, Number(xp) || 0);
  /* Le PALIER, pas le plafond : voir la note en tete de fichier. Deplacer la
     cassure a cent aurait double la Fame facile de tout le jeu. */
  const plafond = xpPour(NIVEAU_PALIER);
  if (x <= plafond) return Math.floor(x / XP_PAR_FAME);
  /* La partie sous le plafond est comptee ENTIEREMENT au premier taux, puis
     le surplus au second. Repartir de zero au-dela ferait chuter la Fame au
     moment precis ou l'on atteint le plafond — on serait puni d'avoir
     progresse. */
  return Math.floor(plafond / XP_PAR_FAME)
       + Math.floor((x - plafond) / XP_PAR_FAME_APRES);
}

/*
 * ---- LA STAT AU NIVEAU N ----
 *
 * Interpolation LINEAIRE entre un plancher (la moitie du plafond, au niveau
 * 1) et le plafond complet (au niveau 20). Ce n'est pas la courbe exacte de
 * RotMG — personne ne l'a publiee palier par palier — c'est la plus simple
 * qui soit honnete : elle part de quelque chose et arrive exactement au
 * plafond annonce, sans pretendre a une precision qu'on n'a pas.
 */
/* Ce que les quatre-vingts niveaux du haut ajoutent AU-DESSUS de la naissance,
   au bout. Un pour un : au niveau cent, le personnage vaut le double de ce que
   sa naissance lui permettait. */
const GAIN_HAUT = 1.0;
function statAuNiveau(cap, niveau) {
  const n = Math.max(1, Math.min(NIVEAU_MAX, Number(niveau) || 1));
  const plancher = cap * 0.5;
  /* Jusqu'au palier : EXACTEMENT la courbe d'avant. Au vingtieme niveau on a
     cent pour cent de sa naissance, comme toujours — personne ne perd rien. */
  if (n <= NIVEAU_PALIER) {
    return Math.round(plancher + (cap - plancher) * (n - 1) / (NIVEAU_PALIER - 1));
  }
  /* Au-dela, on ajoute par-dessus le plafond de naissance. */
  return Math.round(cap + cap * GAIN_HAUT *
    (n - NIVEAU_PALIER) / (NIVEAU_MAX - NIVEAU_PALIER));
}

/* ======================================================================
 * LES POTIONS DE STAT — LE SEUL MOYEN DE DEPASSER SON PLAFOND
 * ======================================================================
 *
 * `statAuNiveau` rend le plafond d'un personnage : au niveau 20, il a tout ce
 * que sa naissance lui permettait, et plus rien ne monte. L'equipement ajoute
 * par-dessus, mais il se retire — c'est un pret, pas un acquis.
 *
 * Une potion de stat est le seul gain qui reste ATTACHE au personnage. Elle
 * ajoute au-dessus du plafond, elle ne se retire pas... et elle disparait
 * avec lui. C'est ce qui la rend interessante : elle transforme du temps de
 * jeu en quelque chose qu'on a peur de perdre.
 *
 * ---- pourquoi une borne, et pourquoi pas le meme pas partout ----
 *
 * Il y a une borne au nombre de potions — quarante aujourd'hui, vingt a
 * l'origine. Sans elle, un personnage n'aurait plus de forme : la difference
 * entre les six visages tient a leurs plafonds, et un nombre illimite de
 * potions les rendrait tous identiques a la fin.
 *
 * Le PAS, lui, ne peut pas etre le meme pour tout le monde. Les huit stats ne
 * vivent pas sur la meme echelle : l'attaque tourne autour de 55, les points
 * de vie autour de 700. Un « +1 » partout donnerait +36 % d'attaque et +2,8 %
 * de vie pour le meme effort — la potion de vie ne vaudrait pas la peine
 * d'etre ramassee. La vie et le mana avancent donc par cinq — le bareme de
 * RotMG, ou une potion de vie donne +5 HP et une potion d'attaque +1 — ce qui
 * faisait +100 au bout des vingt, et fait +200 au bout des quarante.
 */
/* ---- ON EN BOIT DEUX FOIS PLUS, MAIS PAS DEUX FOIS PLUS FORT ----
 * DEMANDE : « on peut boire plus de potions de stats pour etre plus fort ».
 *
 * Le plafond DUR passe de vingt a quarante : c'est lui qui bridait la vie, et
 * elle seule. Une serie complete de potions de vie donne desormais +200 au
 * lieu de +100 — deux fois plus, litteralement.
 *
 * La PART de la naissance, elle, monte d'un quart a trois dixiemes et PAS a
 * une moitie, et ce n'est pas de la prudence : c'est une mesure. A la moitie,
 * une seule serie de potions de defense DOUBLAIT la survie contre six
 * creatures de milieu de jeu — Medusa, Cave Lieutenant, Hoodrat, Cursed
 * Archer, Bog Stalker, Green Bandit — jusqu'a +183 %. C'est exactement
 * l'accident que la note ci-dessous decrit et que `butin.test.js` interdit :
 * la defense se SOUSTRAIT des degats, donc quelques points de plus font
 * basculer tout un anneau du jeu contre le plancher de degats, d'un coup.
 * Trois dixiemes est le plus haut chiffre qui tienne encore la regle (pire
 * cas mesure : +88 % au palier, +64 % au niveau cent).
 *
 * Ce qui NE change pas, c'est la regle : une potion reste bornee par ce que la
 * naissance a donne. C'est elle qui garde aux six visages des formes
 * differentes, et c'etait la raison d'etre de `SUP_PART` — pas son chiffre. */
const SUP_MAX = 40;                         // le plafond dur, potions par stat
const SUP_PAS = { hp: 5, mp: 5 };           // les six autres avancent par 1

/* ---- ET POURQUOI VINGT NE PEUT PAS ETRE LE PLAFOND DE TOUT ----
 *
 * Les huit stats ne vivent pas sur la meme echelle. La defense d'andy plafonne
 * a 25 ; ses points de vie a 700. Vingt potions donnent donc +80 % de defense
 * et +14 % de vie — mais ce chiffre-la n'est meme pas le vrai probleme.
 *
 * Le vrai probleme se lit dans les degats. `degatsSubis` a un PLANCHER : on
 * encaisse toujours au moins 15 % du coup, quelle que soit l'armure. Vingt
 * points de defense en plus poussent le joueur contre ce plancher au milieu
 * du jeu et nulle part ailleurs. Mesure faite contre trois creatures :
 *
 *     lime (att 25)      +20 def : +0 %    (deja au plancher sans rien)
 *     squelette (att 55) +20 def : +200 %  (il tombe au plancher)
 *     gardien (att 160)  +20 def : +17 %   (l'attaque depasse l'armure)
 *
 * Une potion qui ne vaut rien en bas, tout au milieu et peu en haut n'est pas
 * equilibrable : ce n'est pas une courbe, c'est un accident. Cent points de
 * vie donnent +14 % partout, ce qui est ennuyeux mais honnete.
 *
 * D'ou la regle : UNE POTION NE PEUT JAMAIS DONNER PLUS D'UNE PART FIXE DE CE
 * QUE LA NAISSANCE A DONNE. Quarante est le plafond dur ; en dessous, chaque
 * stat s'arrete la ou son propre plafond le lui dit. Le compte devient donc,
 * pour andy :
 *
 *     hp 700 -> 40 potions (+200, +29 %)   def 25 -> 7  (+7,  +28 %)
 *     mp 300 -> 18 (+90, +30 %)            spd 65 -> 19 (+19, +29 %)
 *     att 55 -> 16 (+16, +29 %)            dex 75 -> 22 (+22, +29 %)
 *     vit 40 -> 12 (+12, +30 %)            wis 50 -> 15 (+15, +30 %)
 *
 * Toutes entre 28 et 30 % : la vie a cesse d'etre la mauvaise affaire qu'elle
 * etait a +14 %, et c'est le plafond dur releve qui l'a permis. Aucune n'est
 * un piege, aucune n'est un raccourci.
 */
const SUP_PART = 0.3;

/** Ce qu'une potion ajoute a cette stat. */
function supPas(stat) { return SUP_PAS[stat] || 1; }

/**
 * Combien de potions de cette stat un personnage peut boire.
 * `cap` est SON plafond de naissance (BASE[skin][stat]) : deux visages n'ont
 * pas les memes, et c'est justement ce qui les distingue.
 */
function supMaxDe(stat, cap) {
  const c = Math.max(0, Number(cap) || 0);
  if (!c) return 0;
  return Math.max(1, Math.min(SUP_MAX, Math.floor(c * SUP_PART / supPas(stat))));
}

/** Le supplement qu'apportent `n` potions de cette stat, borne comprise. */
function supDe(stat, n, cap) {
  const plafond = cap === undefined ? SUP_MAX : supMaxDe(stat, cap);
  const k = Math.max(0, Math.min(plafond, Number(n) || 0));
  return k * supPas(stat);
}

/* ======================================================================
 * L'EQUIPEMENT — CE QUE CHAQUE FAMILLE APPORTE
 * ======================================================================
 *
 * Un fruit (saison 1) et une arme (saison 2) apportent chacun un bonus a UNE
 * stat, choisie par leur FAMILLE — pas par l'objet individuel, pour que
 * l'association reste lisible sans dresser trente lignes. Toutes les familles
 * des deux saisons couvrent ensemble les huit stats, une fois chacune : ce
 * n'est pas un hasard, c'est ce qui garantit qu'aucune stat ne reste hors de
 * portee de tout equipement possible.
 */
/**
 * ============ CE QU'UN OBJET APPORTE : PROFIL x BUDGET ============
 *
 * Un objet ne donne plus UNE stat mais un PROFIL — une repartition. C'est ce
 * qui fait qu'une hache et un arc, de meme rarete, ne se jouent pas pareil :
 * la hache met tout sur l'attaque, l'arc etale sur la dexterite, la vitesse
 * et un peu d'attaque.
 *
 * ---- pourquoi un profil et pas des chiffres tapes objet par objet ----
 *
 * Il y a 120 objets. Les ecrire un par un, c'est 120 occasions de se tromper
 * et aucune garantie que la rarete progresse vraiment. Ici la FAMILLE dit
 * COMMENT depenser, la RARETE dit COMBIEN — et « legendaire > epique » est
 * vrai par construction, pour les 120, sans avoir a le verifier a la main.
 *
 * ---- l'unite ----
 *
 * 1 point = 1 point d'attribut = 10 points de vie ou de mana. Ce rapport de
 * dix est celui des anneaux de RotMG (realmeye.com/wiki/rings) et celui de
 * nos propres bases : une vie se compte en centaines, un attribut en
 * dizaines.
 *
 * ---- les poids ----
 *
 * Ils totalisent 1 par famille. Un objet mono-stat concentre tout et frappe
 * donc plus fort sur sa stat qu'un objet a trois stats — c'est voulu : c'est
 * le prix de la specialisation, et ca laisse un legendaire specialise battre
 * un mythique polyvalent sur SA stat.
 */
const PROFIL_FAMILLE = {
  // ---- saison 1 : les fruits (pouvoirs) ----
  chaos:  { att: 0.70, hp: 0.30 },   // frapper fort, encaisser un peu
  garde:  { def: 0.60, vit: 0.40 },  // tenir
  eclair: { spd: 0.60, dex: 0.40 },  // aller vite, tirer vite
  oeil:   { wis: 0.60, mp: 0.40 },   // voir et soutenir
  or:     { hp: 1.00 },              // la vie, rien d'autre
  chance: { dex: 0.60, spd: 0.40 },  // le reflexe

  /* ---- saison 2 : les armes n'ont PAS de profil ----
   *
   * Elles en avaient un, et c'etait la divergence de fond avec RotMG : la-bas
   * une arme ne donne AUCUNE statistique, jamais — ni les epees (45-90 au
   * commun jusqu'a 250-305 au dernier tier), ni les arcs, ni les dagues. Elle
   * donne des DEGATS, une portee et un nombre de tirs, point. Ce qui habille
   * le personnage, ce sont l'armure, l'anneau et le sort.
   *
   * Chez nous une lame mythique donnait +15 ATT et +13 DEX EN PLUS de ses
   * 90-120 de degats : elle gagnait deux fois. Le releve l'a chiffre — nos
   * pieces portaient +76 % du plafond d'attaque contre +15 % dans le vrai
   * jeu. L'arme repart donc avec ses seuls degats (DEGATS_ARME, plus bas) et
   * son comportement (portee, tirs, cadence — table ARMES, cote monde).
   *
   * Concretement : pas d'entree ici, pas de budget en saison 2, donc
   * `bonusesDe` rend {} pour toute arme. Ce n'est pas un oubli a reparer.
   */

  // ---- saison 3 : les armures ----
  plastron:   { def: 0.55, hp: 0.45 },             // le tank
  bouclier:   { def: 1.00 },                       // la defense pure
  gantelets:  { att: 0.60, def: 0.40 },            // frapper en restant couvert
  jambieres:  { spd: 0.50, def: 0.30, dex: 0.20 }, // l'armure legere
  epaulieres: { vit: 0.60, hp: 0.40 },             // porter le poids
  casque:     { wis: 0.40, mp: 0.35, def: 0.25 },  // la robe de mage

  // ---- saison 4 : les bagues ----
  // Mono-stat, toutes : c'est leur role. On choisit une bague pour combler
  // exactement le trou de son build, pas pour arrondir trois chiffres.
  onyx:      { def: 1.00 },
  saphir:    { mp: 1.00 },
  grenat:    { vit: 1.00 },
  topaze:    { att: 1.00 },
  amethyste: { wis: 1.00 },
  emeraude:  { dex: 1.00 },
};

/**
 * Le budget, par saison et par rarete. Les armes et surtout les armures
 * pesent plus que les accessoires : ce sont les emplacements principaux, on
 * en porte un de chaque, et c'est ce qui donne du poids au choix d'une
 * armure face a une bague.
 */
/* ====================================================================
 * DEUX ECHELLES, PAS UNE
 * ====================================================================
 *
 * Ce qu'on ACHETE et ce qu'on TROUVE partageaient la meme table. Une commune
 * payee en $SWOGE valait donc exactement une commune ramassee sur un lime —
 * alors que la premiere existe a mille exemplaires pour toute une saison et
 * que la seconde tombe a l'infini.
 *
 * ---- l'escalier, et qui tient quelle marche ----
 *
 * Le monde tient les DEUX PREMIERES marches — le tutoriel — et les DEUX
 * DERNIERES — les trophees. La boutique tient les sept du milieu :
 *
 *   saison 1  o3  < o6  < B8  < o9  < B11 < o12 < B14 < B18 < B20 < o22 < o26
 *   saison 3  o7  < o14 < B18 < o21 < B25 < o29 < B34 < B42 < B47 < o50 < o58
 *   saison 4  o3  < o6  < B7  < o8  < B9  < o10 < B11 < B13 < B15 < o17 < o20
 *
 * (B = boutique, o = butin. Un essai verifie que la suite croit vraiment.)
 *
 * ---- pourquoi les deux derniers rangs du monde restent au-dessus ----
 *
 * Parce que sinon la RARETE et la PUISSANCE marchent en sens inverse, et c'est
 * le genre de defaut qu'on ne voit qu'en comptant. Par saison, en exemplaires
 * qui peuvent exister en meme temps :
 *
 *   mythique du monde     1 identifiant x 10  =  10
 *   legendaire achetee    6 identifiants x 40 = 240
 *   mythique achetee      6 identifiants x 10 =  60
 *
 * La piece la plus rare que le monde puisse produire etait battue par une
 * piece vingt-quatre fois plus abondante, qu'un clic suffit a obtenir. Et il en
 * decoulait une chose pire : au-dessus de la RARE achetee, il n'existait plus
 * aucune reponse qui se farme. Un joueur qui ne paie pas plafonnait a la
 * deuxieme marche sur onze.
 *
 * Rien ne BAISSE pour autant : ce sont les deux rangs du monde qui montent.
 * Personne ne perd un point, aucun prix en $SWOGE n'est a revoir, et ce qui
 * s'achete continue de battre tout ce qu'un joueur rencontre vraiment — le
 * commun, le rare, l'epique et le legendaire du monde. Ce qui reste au-dessus,
 * ce sont dix exemplaires par saison et quatre reliques.
 *
 * ---- et pourquoi le butin ne baisse pas d'un point ----
 *
 * Rendre la boutique meilleure en affaiblissant ce que les gens possedent
 * deja, c'est leur reprendre quelque chose sans le dire. Le seul changement
 * cote butin est une HAUSSE : la saison 4 montait 10, 11, 12 sur ses trois
 * derniers crans, deux ecarts d'un point. Un joueur qui ouvrait une relique —
 * quatre au monde — gagnait +1 sur un legendaire. Le defaut existait avant la
 * boutique ; elle ne fait que le rendre visible.
 */
const BUDGET_BUTIN = {
  1: { commun: 3, rare: 6,  epique: 9,  legendaire: 12, mythique: 22, relique: 26 },  // fruits
  /* pas de 2 : les armes ne donnent que des degats — voir PROFIL_FAMILLE */
  3: { commun: 7, rare: 14, epique: 21, legendaire: 29, mythique: 50, relique: 58 },  // armures
  /* Les bagues suivent le bareme reel des anneaux tiered de RotMG :
     +3, +6, +7, +8, +9, +10, +11 sur sept tiers. Nous en avons cinq, on prend
     les crans qui gardent l'ecart lisible du commun au mythique : 3, 6, 8, 10,
     11. Le mythique s'arrete donc a +11 — la valeur exacte du meilleur anneau
     du vrai jeu, et non plus +16. Une bague comble un trou de build, elle ne
     remplace pas un niveau. */
  /* La relique ne s'envole pas non plus : +12 contre +11. Elle prolonge le
     plafond des anneaux d'un cran, elle ne le renverse pas — c'est la meme
     raison qui avait fait redescendre le mythique de +16 a +11. Une bague
     comble un trou de build, meme quand elle est unique au monde. */
  4: { commun: 3, rare: 6,  epique: 8,  legendaire: 10, mythique: 17, relique: 20 },  // bagues
};

/* L'echelle de la BOUTIQUE. Cinq rangs, pas six : la relique ne se vend pas.
   Chaque cran vaut la moyenne des deux crans de butin qui le suivent —
   c'est de la que sort l'imbrication, et c'est pour ca qu'aucune des deux
   tables n'a ete tapee au jugé. */
const BUDGET_BOUTIQUE = {
  /* `relique: null` plutot qu'une clef absente : les deux rendent {}, mais le
     null DIT que la decision a ete prise — la relique ne se vend pas. */
  1: { commun:  8, rare: 11, epique: 14, legendaire: 18, mythique: 20, relique: null },  // fruits
  3: { commun: 18, rare: 25, epique: 34, legendaire: 42, mythique: 47, relique: null },  // armures
  4: { commun:  7, rare:  9, epique: 11, legendaire: 13, mythique: 15, relique: null },  // bagues
};

const BUDGET = { butin: BUDGET_BUTIN, boutique: BUDGET_BOUTIQUE };
/* L'ancien nom reste : c'est la table de reference, celle du monde. */
const BUDGET_SAISON = BUDGET_BUTIN;

/** Les degats d'une arme, par rarete. Ils ne dependent pas de la famille :
    la famille decide de la portee et du nombre de tirs (cote page), la
    rarete decide de ce que chaque tir enleve. */
const DEGATS_ARME_BUTIN = {
  commun: [20, 30], rare: [30, 45], epique: [45, 65],
  /* Les deux derniers rangs passent au-dessus de tout ce qui se vend — meme
     raison que les budgets : dix exemplaires par saison ne peuvent pas etre
     battus par soixante qu'un clic suffit a obtenir. */
  legendaire: [68, 95], mythique: [120, 155],
  /* La relique prolonge l'echelle d'un cran — chacun vaut environ un tiers de
     plus que le precedent. Son MINIMUM passe au-dessus du maximum de ce que
     la boutique vend : le plus mauvais coup d'une relique vaut mieux que le
     meilleur coup d'une mythique payee. C'est une phrase qu'on peut verifier,
     et un test la verifie.
     Elle est montee de 125-160 a 155-200 le jour ou la boutique a eu sa propre
     echelle : la mythique achetee frappe jusqu'a 150, et une relique a 125 de
     minimum serait passee DESSOUS. Ce n'est pas la relique qu'on a renforcee,
     c'est la phrase qu'on a gardee vraie. */
  relique: [155, 200],
};

/* Les memes crans, decales de la meme facon que les budgets : chaque borne
   est la moyenne des deux crans de butin suivants. L'escalier des degats :
     20,30 | 30,45 | 38,55 | 45,65 | 55,78 | 68,95 | 78,105
           | 102,134 | 116,150 | 120,155 | 155,200
   Onze marches, et la relique tient toujours la derniere. */
const DEGATS_ARME_BOUTIQUE = {
  commun: [38, 55], rare: [55, 78], epique: [78, 105],
  legendaire: [102, 134], mythique: [116, 150], relique: null,
};

const DEGATS = { butin: DEGATS_ARME_BUTIN, boutique: DEGATS_ARME_BOUTIQUE };
/* L'ancien nom reste : c'est la table de reference, celle du monde. */
const DEGATS_ARME = DEGATS_ARME_BUTIN;

/* Les deux stats qui se comptent en centaines. Toutes les autres sont des
   attributs — ecrire la liste courte plutot que la longue evite d'oublier
   une stat ajoutee plus tard et de lui donner par defaut le bareme des
   jauges, qui serait dix fois trop fort. */
const JAUGES = ['hp', 'mp'];

/**
 * Ce qu'un objet apporte, stat par stat. Rend un objet `{stat: valeur}` —
 * jamais un seul chiffre, parce qu'un objet peut toucher trois stats.
 */
function bonusesDe(rarete, famille, saison, source) {
  const profil = PROFIL_FAMILLE[famille];
  const tables = BUDGET[source || 'butin'];
  const table = tables && tables[Number(saison)];
  if (!profil || !table) return {};
  const budget = table[rarete];
  if (!budget) return {};
  const out = {};
  for (const stat of Object.keys(profil)) {
    const pts = Math.round(budget * profil[stat]);
    if (pts <= 0) continue;
    out[stat] = JAUGES.indexOf(stat) >= 0 ? pts * 10 : pts;
  }
  return out;
}

/* ---- ON NE DEMANDE PAS LA SOURCE, ON LA LIT SUR L'OBJET ----
 *
 * `bonusesDe` prend une source parce qu'il ne connait que des chaines. Le
 * reste du serveur, lui, tient l'OBJET DU CATALOGUE : il porte deja le seul
 * fait qui compte — `drop`. Passer par ces deux fonctions-la retire toute
 * occasion de se tromper de table, et il y avait six endroits ou se tromper.
 *
 * Le defaut de `bonusesDe` est le BUTIN, jamais la boutique : un appel oublie
 * quelque part donne alors une piece moins forte, pas une piece dopee. Se
 * tromper vers le bas se voit et se repare ; se tromper vers le haut se
 * decouvre trois semaines plus tard, quand tout le monde en a une. */
function sourceDe(o) { return (o && o.drop) ? 'butin' : 'boutique'; }

function bonusesDeObjet(o) {
  if (!o) return {};
  return bonusesDe(o.rarete, o.famille, o.saison, sourceDe(o));
}

/**
 * LE BUDGET D'UN OBJET : le nombre de points que sa rarete lui accorde.
 *
 * Il etait deja calcule au milieu de `bonusesDe`, ou il servait a repartir
 * les stats. Les passifs en ont besoin AUSSI — leur force suit la meme courbe
 * de rarete, et c'est voulu : une legendaire est plus forte pour la meme
 * raison qu'elle donne plus de points.
 * Le sortir ici plutot que de le recalculer la-bas evite la seule facon de se
 * tromper : deux lectures de la meme table qui finissent par ne plus choisir
 * la meme ligne.
 */
function budgetDe(o) {
  if (!o) return 0;
  const tables = BUDGET[sourceDe(o)];
  const table = tables && tables[Number(o.saison)];
  return (table && table[o.rarete]) || 0;
}

/** Les degats d'une arme du catalogue, ou `null` si ce n'en est pas une.
 *
 * ---- POURQUOI UNE ARME PEUT ECRIRE LES SIENS ----
 *
 * La rarete decidait TOUT : les quatre reliques du jeu frappaient exactement
 * pareil, 155-200, qu'elles tombent d'Optimus, de l'Idole ou du champion de
 * l'arene. Or ces trois-la ne sont pas au meme prix. L'Idole a 380 000 points
 * de vie ; le champion en a 700 000, presque le double, plus cinq phases et
 * trois vagues d'invoques. Rendre la meme arme au bout des deux, c'est dire
 * au joueur que le combat le plus dur du jeu ne valait pas le detour — et
 * c'est ce qui a ete rapporte : « l'arme bleue du boss de la manche 1 doit
 * avoir plus de degats ».
 *
 * ---- ET POURQUOI PAS UNE SIXIEME RARETE ----
 *
 * Parce qu'une rarete n'est pas qu'un chiffre de degats : c'est une couleur,
 * un plafond d'exemplaires, un bloc d'identifiants, une ligne dans chaque
 * fiche et chaque panneau. En ajouter une pour une seule arme aurait touche
 * une dizaine d'endroits pour un besoin qui n'en concerne qu'un.
 *
 * L'echappatoire est donc EXPLICITE et BORNEE : un objet peut porter son
 * propre `degats`, et `boutique.js` refuse au chargement tout ce qui n'est
 * pas un donjon ou qui passerait SOUS le bareme de sa rarete. Un oubli ne
 * peut donc pas produire une arme secretement faible — seulement une arme
 * dont on a ecrit la force en toutes lettres, a cote de son nom. */
function degatsDeObjet(o) {
  if (!o || Number(o.saison) !== 2) return null;
  if (Array.isArray(o.degats) && o.degats.length === 2) return o.degats.slice();
  const t = DEGATS[sourceDe(o)];
  const d = t && t[o.rarete];
  return d ? d.slice() : null;
}

/** La stat PRINCIPALE d'une famille — celle qui pese le plus dans son
    profil. Elle sert a nommer l'objet d'un mot (« +ATT ») la ou la place
    manque. Deduite du profil, jamais listee a cote : deux tables a tenir
    d'accord finiraient par se contredire. */
function statPrincipale(famille) {
  const profil = PROFIL_FAMILLE[famille];
  if (!profil) return null;
  return Object.keys(profil).reduce((a, b) => (profil[b] > profil[a] ? b : a));
}

const FAMILLE_STAT = Object.keys(PROFIL_FAMILLE).reduce((o, f) => {
  o[f] = statPrincipale(f); return o;
}, {});


module.exports = {
  STATS, BASE, FAMILLE_STAT, PROFIL_FAMILLE, JAUGES, budgetDe,
  BUDGET_SAISON, BUDGET_BUTIN, BUDGET_BOUTIQUE, BUDGET,
  DEGATS_ARME, DEGATS_ARME_BUTIN, DEGATS_ARME_BOUTIQUE, DEGATS,
  sourceDe, bonusesDeObjet, degatsDeObjet,
  NIVEAU_MAX, NIVEAU_PALIER, NIVEAU_BASE, NIVEAU_PUISSANCE, XP_BASE, XP_PUISSANCE,
  GAIN_HAUT,
  XP_PAR_FAME, XP_PAR_FAME_APRES,
  volumePour, xpPour, xpDuVolume, niveauDeXp, statAuNiveau, fameDeXp,
  bonusesDe, statPrincipale,
  SUP_MAX, SUP_PAS, SUP_PART, supPas, supMaxDe, supDe,
};
