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
 * RotMG : niveau max a 20, atteignable en quelques jours de jeu actif avec
 * ce skin porte — pas en quelques mois.
 *
 * Meme forme mathematique que l'XP de compte (game.js), reprise ici pour la
 * meme raison qu'elle existe la-bas : deriver l'XP du volume EXACTEMENT comme
 * on derive le niveau du volume, avec l'exposant qui relie les deux courbes,
 * pour que les deux methodes de calcul ne puissent jamais se contredire.
 */
const NIVEAU_MAX = 20;
const NIVEAU_BASE = 250;       // volume (sur ce skin) pour le niveau 1
const NIVEAU_PUISSANCE = 3;    // niveau 20 = 250 * 20^3 = 2 000 000 de volume
const XP_BASE = 100;
const XP_PUISSANCE = 2;        // niveau 20 = 100 * 20^2 = 40 000 xp

/** Le volume (sur ce skin) qu'il faut pour atteindre le niveau n. */
function volumePour(n) {
  const x = Math.max(1, Math.min(NIVEAU_MAX, Number(n) || 1));
  return NIVEAU_BASE * Math.pow(x, NIVEAU_PUISSANCE);
}
/** L'XP dediee qu'il faut pour atteindre le niveau n. */
function xpPour(n) {
  const x = Math.max(1, Math.min(NIVEAU_MAX, Number(n) || 1));
  return XP_BASE * Math.pow(x, XP_PUISSANCE);
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
  const n = Math.floor(Math.pow(x / XP_BASE, 1 / XP_PUISSANCE) + 1e-9);
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
  const plafond = xpPour(NIVEAU_MAX);
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
function statAuNiveau(cap, niveau) {
  const n = Math.max(1, Math.min(NIVEAU_MAX, Number(niveau) || 1));
  const plancher = cap * 0.5;
  return Math.round(plancher + (cap - plancher) * (n - 1) / (NIVEAU_MAX - 1));
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
 * ---- pourquoi vingt, et pourquoi pas le meme pas partout ----
 *
 * Vingt potions par stat, c'est la borne. Au-dela, un personnage n'aurait
 * plus de forme : la difference entre les six visages tient a leurs plafonds,
 * et un nombre illimite de potions les rendrait tous identiques a la fin.
 *
 * Le PAS, lui, ne peut pas etre le meme pour tout le monde. Les huit stats ne
 * vivent pas sur la meme echelle : l'attaque tourne autour de 55, les points
 * de vie autour de 700. Un « +1 » partout donnerait +36 % d'attaque et +2,8 %
 * de vie pour le meme effort — la potion de vie ne vaudrait pas la peine
 * d'etre ramassee. La vie et le mana avancent donc par cinq, ce qui fait +100
 * au bout des vingt : exactement le bareme de RotMG, ou une potion de vie
 * donne +5 HP et une potion d'attaque +1.
 */
const SUP_MAX = 20;                         // le plafond dur, potions par stat
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
 * D'ou la regle : UNE POTION NE PEUT JAMAIS DONNER PLUS D'UN QUART DE CE QUE
 * LA NAISSANCE A DONNE. Vingt reste le plafond dur ; en dessous, chaque stat
 * s'arrete la ou son propre plafond le lui dit. Le compte devient donc :
 *
 *     hp 700 -> 20 potions (+100, +14 %)   def 25 -> 6  (+6,  +24 %)
 *     mp 300 -> 15 (+75, +25 %)            spd 65 -> 16 (+16, +25 %)
 *     att 55 -> 13 (+13, +24 %)            dex 75 -> 18 (+18, +24 %)
 *     vit 40 -> 10 (+10, +25 %)            wis 50 -> 12 (+12, +24 %)
 *
 * Toutes entre 14 et 25 %. Aucune n'est un piege, aucune n'est un raccourci.
 */
const SUP_PART = 0.25;

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
const BUDGET_SAISON = {
  1: { commun: 3, rare: 6,  epique: 9,  legendaire: 12, mythique: 16, relique: 21 },  // fruits
  /* pas de 2 : les armes ne donnent que des degats — voir PROFIL_FAMILLE */
  3: { commun: 7, rare: 14, epique: 21, legendaire: 29, mythique: 38, relique: 50 },  // armures
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
  4: { commun: 3, rare: 6,  epique: 8,  legendaire: 10, mythique: 11, relique: 12 },  // bagues
};

/** Les degats d'une arme, par rarete. Ils ne dependent pas de la famille :
    la famille decide de la portee et du nombre de tirs (cote page), la
    rarete decide de ce que chaque tir enleve. */
const DEGATS_ARME = {
  commun: [20, 30], rare: [30, 45], epique: [45, 65],
  legendaire: [65, 90], mythique: [90, 120],
  /* La relique prolonge l'echelle d'un cran — chacun vaut environ un tiers de
     plus que le precedent (65/45, 90/65, 120/90, 160/120). Son MINIMUM passe
     au-dessus du maximum mythique : le plus mauvais coup d'une relique vaut
     mieux que le meilleur coup de ce que la boutique vend. C'est une phrase
     qu'on peut verifier, et un test la verifie — a 120 elle n'aurait ete
     qu'egale, ce qui ne se defend pas pour une piece qu'on ne peut pas
     acheter. */
  relique: [125, 160],
};

/* Les deux stats qui se comptent en centaines. Toutes les autres sont des
   attributs — ecrire la liste courte plutot que la longue evite d'oublier
   une stat ajoutee plus tard et de lui donner par defaut le bareme des
   jauges, qui serait dix fois trop fort. */
const JAUGES = ['hp', 'mp'];

/**
 * Ce qu'un objet apporte, stat par stat. Rend un objet `{stat: valeur}` —
 * jamais un seul chiffre, parce qu'un objet peut toucher trois stats.
 */
function bonusesDe(rarete, famille, saison) {
  const profil = PROFIL_FAMILLE[famille];
  const table = BUDGET_SAISON[Number(saison)];
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
  STATS, BASE, FAMILLE_STAT, PROFIL_FAMILLE, BUDGET_SAISON, DEGATS_ARME, JAUGES,
  NIVEAU_MAX, NIVEAU_BASE, NIVEAU_PUISSANCE, XP_BASE, XP_PUISSANCE,
  XP_PAR_FAME, XP_PAR_FAME_APRES,
  volumePour, xpPour, xpDuVolume, niveauDeXp, statAuNiveau, fameDeXp,
  bonusesDe, statPrincipale,
  SUP_MAX, SUP_PAS, SUP_PART, supPas, supMaxDe, supDe,
};
