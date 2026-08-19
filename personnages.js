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
const FAMILLE_STAT = {
  // saison 1 — fruits
  chance: 'dex',   // la chance recompense le reflexe
  or: 'hp',        // la richesse, la vitalite
  eclair: 'spd',   // l'eclair va vite
  oeil: 'wis',     // voir, c'est savoir
  garde: 'def',    // garder, c'est defendre
  chaos: 'att',    // le chaos frappe fort
  // saison 2 — armes
  lame: 'dex',
  hache: 'att',
  lance: 'def',
  arc: 'spd',
  marteau: 'vit',
  dagues: 'mp',
  // saison 3 — armure : une piece, une stat, comme un fruit ou une arme
  casque: 'wis',        // voir venir
  plastron: 'hp',       // le coeur protege
  epaulieres: 'vit',    // porter le poids
  gantelets: 'att',     // frapper plus fort
  jambieres: 'spd',     // courir plus loin
  bouclier: 'def',      // encaisser
  // saison 4 — bagues
  grenat: 'vit',        // la pierre rouge, la vitalite
  saphir: 'mp',         // la pierre bleue, l'esprit
  emeraude: 'dex',      // la pierre verte, l'agilite
  topaze: 'att',        // la pierre doree, la force
  amethyste: 'wis',     // la pierre violette, la clairvoyance
  onyx: 'def',          // la pierre noire, la garde
};

/**
 * ============ LE BONUS D'EQUIPEMENT, A L'ECHELLE DE LA STAT ============
 *
 * ---- ce qui n'allait pas ----
 *
 * Le bonus valait `1000 / plafond` : un seul chiffre par rarete, le meme
 * pour les huit stats. Ca mesurait bien la RARETE, mais ca ignorait
 * l'ECHELLE de ce qu'on augmente. Un mythique donnait +100, ce qui vaut
 * un huitieme de barre de vie (700 points) mais TRIPLE une sagesse de 50.
 * La meme piece etait donc anecdotique sur une jauge et absurde sur un
 * attribut, sans que rien ne le dise.
 *
 * ---- d'ou viennent ces chiffres ----
 *
 * De realmeye.com/wiki/rings, paliers 1 a 5 (Standard, Greater, Superior,
 * Paramount, Exalted) — c'est-a-dire cinq paliers pour nos cinq raretes.
 * RotMG resout exactement le meme probleme avec deux baremes :
 *
 *      palier :  Standard  Greater  Superior  Paramount  Exalted
 *      HP / MP :     +30      +60       +80       +100      +120
 *      attribut :     +3       +6        +7         +8        +9
 *
 * Le rapport est d'environ dix entre les deux, et il n'est pas arbitraire :
 * c'est le rapport entre les echelles: une vie se compte en centaines, un
 * attribut en dizaines. Nos propres bases sont du meme ordre (700-800 de
 * vie, 25-75 d'attribut), donc le bareme se transpose tel quel.
 *
 * ---- ce qui n'est PAS grade ici ----
 *
 * Le genre de l'objet. Une armure legendaire et une bague legendaire
 * donnent le meme +8 sur la meme stat. Dans RotMG une armure lourde pese
 * plus qu'un anneau sur la defense — mais les valeurs exactes des armures
 * ne sont pas extractibles du wiki (rendues en JavaScript), et poser un
 * facteur invente serait exactement l'erreur qu'on vient de corriger. Le
 * jour ou on veut cette nuance, elle s'ajoute ici, avec sa source.
 */
const BONUS_RARETE = {
  commun:     { jauge: 30,  attribut: 3 },
  rare:       { jauge: 60,  attribut: 6 },
  epique:     { jauge: 80,  attribut: 7 },
  legendaire: { jauge: 100, attribut: 8 },
  mythique:   { jauge: 120, attribut: 9 },
};
/* Les deux stats qui se comptent en centaines. Toutes les autres sont des
   attributs — ecrire la liste courte plutot que la longue evite d'oublier
   une stat ajoutee plus tard et de lui donner par defaut le bareme des
   jauges, qui serait dix fois trop fort. */
const JAUGES = ['hp', 'mp'];

function bonusDe(rarete, stat) {
  const b = BONUS_RARETE[rarete];
  if (!b) return 0;
  return JAUGES.indexOf(stat) >= 0 ? b.jauge : b.attribut;
}

module.exports = {
  STATS, BASE, FAMILLE_STAT, BONUS_RARETE, JAUGES,
  NIVEAU_MAX, NIVEAU_BASE, NIVEAU_PUISSANCE, XP_BASE, XP_PUISSANCE,
  XP_PAR_FAME, XP_PAR_FAME_APRES,
  volumePour, xpPour, xpDuVolume, niveauDeXp, statAuNiveau, bonusDe, fameDeXp,
};
