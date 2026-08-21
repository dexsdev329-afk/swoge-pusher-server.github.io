'use strict';
/*
 * LES SKINS DE PERSONNAGE.
 *
 * ---- ce que ce fichier est, et ce qu'il n'est pas ----
 *
 * Un catalogue de personnages a ACHETER DIRECTEMENT, en dehors de tout
 * tirage. Aucun rapport avec les saisons de boutique.js : celles-la sont des
 * editions fermees qu'on tire au hasard dans un coffre ; un skin se choisit
 * et se paie a prix fixe, disponible en permanence. Deux produits, deux
 * fichiers.
 *
 * Comme boutique.js, ce module est PUR : aucun solde, aucun inventaire,
 * aucun reseau. Il repond a « voici un identifiant, quel est ce skin et
 * combien coute-t-il ? ». Le debit et la possession vivent dans game.js.
 *
 * ---- CE QUE CE FICHIER NE FAIT PAS ENCORE, VOLONTAIREMENT ----
 *
 * Pas d'equipement (fruit de pouvoir, arme, armure, bague) : la demande est
 * d'abord d'ouvrir la vente. Poser des emplacements aujourd'hui sans rien
 * pour les remplir donnerait une promesse a moitie tenue. `puissance` est deja
 * la, en revanche : c'est le seul chiffre qui a du sens tant que les
 * emplacements n'existent pas, et c'est lui qui fixe le prix.
 *
 * Pas de stats de jeu de role (PV, PM, force, defense…) : ce sera le langage
 * du futur jeu de personnage, pas celui d'un skin. Un skin change une
 * apparence ; il ne joue a rien tout seul.
 *
 * ---- LE PRIX SUIT LA PUISSANCE, ET LA PUISSANCE SUIT LES VRAIES STATS ----
 *
 * `puissance` ne se tape plus a la main sur chaque fiche : un chiffre pose
 * a cote finit toujours par mentir un jour, le jour ou on ajuste une stat
 * dans personnages.js sans repenser a venir corriger celui-la. Elle vient
 * maintenant du classement par somme des 8 stats de base (personnages.BASE)
 * — le skin le plus fort coute forcement le plus cher, parce que c'est la
 * MEME donnee qui decide des deux.
 *
 * Le barème lui-meme reste une PROGRESSION, pas des nombres tapes au
 * hasard : chaque palier vaut environ le double du precedent, pour que la
 * difference se voit sur le porte-monnaie autant que sur le personnage.
 */

const personnages = require('./personnages');

const PUISSANCE_PRIX = { 1: 15000, 2: 35000, 3: 75000, 4: 150000, 5: 300000, 6: 600000 };

/* La somme des 8 stats de base — un seul nombre par skin, direct et sans
   ponderation, pour classer sans avoir a choisir quelle stat compte plus
   qu'une autre. */
function forceBrute(id) {
  const b = personnages.BASE[id];
  if (!b) return 0;
  return personnages.STATS.reduce((total, cle) => total + (b[cle] || 0), 0);
}

const SKINS_SANS_PUISSANCE = [
  { id: 'andy', nom: 'Andy', pouvoir: 'Always caught off guard. Never ready.', couleur: '#FFC53D' },
  { id: 'claude', nom: 'Claude', pouvoir: 'Answers everything, even what nobody asked.', couleur: '#E08A3C' },
  { id: 'pepe', nom: 'Pepe', pouvoir: 'The oldest meme still standing runs the fastest.', couleur: '#7CFF9B' },
  { id: 'landwolf', nom: 'Landwolf', pouvoir: 'Never in a hurry. Never puts the cigarette down either.', couleur: '#B48CFF' },
  { id: 'ogswoge', nom: 'OG Swoge', pouvoir: 'The mascot itself. Rarely dethroned.', couleur: '#FF4655' },
  { id: 'brett', nom: 'Brett', pouvoir: 'Grins at everything. Understands none of it.', couleur: '#5AC8FF' },
];

/* Trie une fois par la force reelle, puis numerote 1..6 dans cet ordre —
   la puissance affichee EST le rang, jamais un champ qu'on pourrait
   desynchroniser d'une future retouche de stats. */
const SKINS = SKINS_SANS_PUISSANCE
  .slice()
  .sort((a, b) => forceBrute(a.id) - forceBrute(b.id))
  .map((s, i) => Object.assign({}, s, { puissance: i + 1 }));

/* ---- LE CADEAU PIXEL ----
 *
 * Chacun des six a maintenant une seconde image : une version pixel, offerte
 * a l'achat. `pixel: true` le DIT plutot que de le laisser deviner par
 * convention de fichier — le jour ou un skin arrive sans cadeau, un flag
 * absent est une reponse claire, une absence de fichier serait juste une
 * image cassee que personne ne comprendrait. */
const CADEAU_PIXEL = new Set(['andy', 'claude', 'pepe', 'landwolf', 'ogswoge', 'brett']);

/* ---- CELUI QU'ON DONNE ----
 *
 * Andy est offert. Tout le monde en a un, sans avoir rien depose ni rien
 * gagne : il n'existe pas de version du jeu ou l'on regarde sans pouvoir
 * jouer.
 *
 * C'est une decision d'ACCUEIL, pas de puissance — et c'est pour ca qu'elle
 * est ecrite ici, nommement, au lieu d'etre deduite du barème. « Le moins
 * fort est offert » aurait l'air plus propre et serait faux : le jour ou l'on
 * retouche une stat dans personnages.js, le classement bouge, et c'est un
 * AUTRE personnage qui deviendrait gratuit sans que personne l'ait decide.
 * Andy reste Andy.
 */
const OFFERT = new Set(['andy']);

/* ---- LES EDITIONS LIMITEES ----
 *
 * Un skin ordinaire est disponible en permanence : c'est ce qui le separe des
 * saisons de boutique.js, qui sont des editions fermees tirees au sort. Un
 * skin d'EDITION, lui, se choisit et se paie comme les autres — mais il n'en
 * existe qu'un nombre fixe, et quand il n'y en a plus, il n'y en a plus.
 *
 * ---- pourquoi le prix est ecrit ici, et pas deduit ----
 *
 * Le prix des autres suit la PUISSANCE : c'est la meme donnee qui decide du
 * classement et du tarif, donc les deux ne peuvent pas diverger. Une edition
 * limitee ne se range pas sur cette droite — ce qu'on paie, c'est la rarete,
 * pas la force. Le laisser sur le bareme aurait voulu dire choisir ses stats
 * pour obtenir un prix, c'est-a-dire fabriquer une puissance pour justifier
 * un tarif.
 *
 * ---- pourquoi le compteur n'est PAS ici ----
 *
 * Ce fichier est PUR : il ne connait ni solde, ni inventaire, ni combien
 * d'exemplaires sont partis. Il dit COMBIEN IL EN EXISTE ; game.js tient le
 * registre de ce qui a ete emis, exactement comme il le fait deja pour les
 * plafonds de saison. Deux endroits qui compteraient les memes exemplaires
 * finiraient par n'en pas compter le meme nombre — et sur un produit vendu
 * en jetons reels, ce desaccord-la se lit comme une edition trahie.
 */
const EDITIONS = {
  /* id: { exemplaires, prix } */
};

/* Un identifiant qui n'existe pas doit se comporter comme un identifiant
   absent, jamais comme une exception qui remonte n'importe ou. */
function skin(id) { return SKINS.find((s) => s.id === id) || null; }

function prixDe(id) {
  if (OFFERT.has(id)) return 0;
  /* L'edition passe AVANT le bareme : son prix est une decision, pas un
     calcul, et le bareme n'a rien a dire sur elle. */
  if (EDITIONS[id]) return EDITIONS[id].prix;
  const s = skin(id);
  return s ? (PUISSANCE_PRIX[s.puissance] || 0) : 0;
}

/** Combien d'exemplaires existent, ou `0` pour un skin sans limite. */
function editionDe(id) {
  return EDITIONS[id] ? EDITIONS[id].exemplaires : 0;
}

/* Le catalogue complet, pret pour la page — le prix est CALCULE ici et
   jamais tape a la main sur une fiche, pour que les skins restent sur
   la meme droite si un jour on ajuste le barème. */
function catalogue() {
  return SKINS.map((s) => ({ id: s.id, nom: s.nom, puissance: s.puissance,
                             prix: prixDe(s.id), pouvoir: s.pouvoir, couleur: s.couleur,
                             pixel: CADEAU_PIXEL.has(s.id),
                             /* `offert` le DIT, plutot que de laisser la page
                                deduire « prix a zero donc gratuit » : un prix
                                a zero peut aussi vouloir dire « prix inconnu »,
                                et les deux ne s'affichent pas pareil. */
                             offert: OFFERT.has(s.id),
                             /* Zero veut dire « sans limite ». La page ne
                                l'affiche que s'il est non nul : ecrire
                                « illimite » sur cinq lignes sur six aurait
                                dilue la seule qui compte. */
                             edition: editionDe(s.id) }));
}

module.exports = { SKINS, PUISSANCE_PRIX, CADEAU_PIXEL, OFFERT, EDITIONS,
                   skin, prixDe, editionDe, catalogue };
