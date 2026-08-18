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
  landwolf: { hp: 800, mp: 300, att: 60, def: 35, spd: 45, dex: 45, vit: 70, wis: 45 }, // encaisseur nonchalant
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
};

/**
 * Le bonus qu'apporte une rarete, sur la stat de sa famille.
 *
 * MEME POIDS que `boutique.prixRachat` : `1000 / plafond`. Ce n'est pas une
 * coincidence — c'est la meme question, « combien cette rarete pese-t-elle
 * face aux autres ? », posee deux fois pour deux usages differents. Un objet
 * dont dix exemplaires existent au monde doit peser cent fois plus qu'un
 * objet qui en compte mille, ici comme au rachat.
 */
function bonusDe(rarete, plafondDe) {
  const p = plafondDe(rarete);
  if (!p) return 0;
  return Math.round(1000 / p);
}

module.exports = {
  STATS, BASE, FAMILLE_STAT,
  NIVEAU_MAX, NIVEAU_BASE, NIVEAU_PUISSANCE, XP_BASE, XP_PUISSANCE,
  volumePour, xpPour, xpDuVolume, niveauDeXp, statAuNiveau, bonusDe,
};
