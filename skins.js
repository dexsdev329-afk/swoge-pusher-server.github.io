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
 * ---- LE PRIX SUIT LA PUISSANCE, PAS L'ORDRE D'ARRIVEE ----
 *
 * `puissance` va de 1 (le plus abordable) a 5 (le plus cher). Le barème est
 * une PROGRESSION, pas des nombres tapes au hasard : chaque palier vaut
 * environ le double du precedent, pour que la difference se voit sur le
 * porte-monnaie autant que sur le personnage.
 */

const PUISSANCE_PRIX = { 1: 15000, 2: 35000, 3: 75000, 4: 150000, 5: 300000, 6: 600000 };

const SKINS = [
  {
    id: 'andy', nom: 'Andy', puissance: 1,
    pouvoir: 'Always caught off guard. Never ready.',
    couleur: '#FFC53D',
  },
  {
    id: 'claude', nom: 'Claude', puissance: 2,
    pouvoir: 'Answers everything, even what nobody asked.',
    couleur: '#E08A3C',
  },
  {
    id: 'pepe', nom: 'Pepe', puissance: 3,
    pouvoir: 'The oldest meme still standing runs the fastest.',
    couleur: '#7CFF9B',
  },
  {
    id: 'landwolf', nom: 'Landwolf', puissance: 4,
    pouvoir: 'Never in a hurry. Never puts the cigarette down either.',
    couleur: '#B48CFF',
  },
  {
    id: 'ogswoge', nom: 'OG Swoge', puissance: 5,
    pouvoir: 'The mascot itself. Rarely dethroned.',
    couleur: '#FF4655',
  },
  {
    id: 'brett', nom: 'Brett', puissance: 6,
    pouvoir: 'Grins at everything. Understands none of it.',
    couleur: '#5AC8FF',
  },
];

/* ---- LE CADEAU PIXEL ----
 *
 * Chacun des six a maintenant une seconde image : une version pixel, offerte
 * a l'achat. `pixel: true` le DIT plutot que de le laisser deviner par
 * convention de fichier — le jour ou un skin arrive sans cadeau, un flag
 * absent est une reponse claire, une absence de fichier serait juste une
 * image cassee que personne ne comprendrait. */
const CADEAU_PIXEL = new Set(['andy', 'claude', 'pepe', 'landwolf', 'ogswoge', 'brett']);

/* Un identifiant qui n'existe pas doit se comporter comme un identifiant
   absent, jamais comme une exception qui remonte n'importe ou. */
function skin(id) { return SKINS.find((s) => s.id === id) || null; }

function prixDe(id) {
  const s = skin(id);
  return s ? (PUISSANCE_PRIX[s.puissance] || 0) : 0;
}

/* Le catalogue complet, pret pour la page — le prix est CALCULE ici et
   jamais tape a la main sur une fiche, pour que les skins restent sur
   la meme droite si un jour on ajuste le barème. */
function catalogue() {
  return SKINS.map((s) => ({ id: s.id, nom: s.nom, puissance: s.puissance,
                             prix: prixDe(s.id), pouvoir: s.pouvoir, couleur: s.couleur,
                             pixel: CADEAU_PIXEL.has(s.id) }));
}

module.exports = { SKINS, PUISSANCE_PRIX, CADEAU_PIXEL, skin, prixDe, catalogue };
