'use strict';
/* ==========================================================================
 * SWOGE DANS LES EDITIONS KLING O1 — LE TEXTE ET LES REFERENCES (15 octobre 2026)
 *
 * UNE seule source pour ce que Kling lit quand SWOGE remplace quelqu'un :
 * l'edition d'un clip et la video entiere du proprietaire (kling_edition.js,
 * kling_entier.js), et SWOGE Swap (swap.js). La page du proprietaire
 * (kling_essai.html) porte le meme texte par defaut ; un essai le compare.
 *
 * ---- CE QUI A ETE MESURE LE 15/10/2026 (clip « Chuckie », deux personnes :
 *      un garcon au ukulele a gauche, le chanteur a droite) ----
 *   1. Kling a remplace la MAUVAISE personne (celle de gauche) : le texte disait
 *      « the singer ». D'ou une cible de POSITION (gauche / centre / droite /
 *      seule personne) et la phrase « The other people stay exactly as they are ».
 *   2. Le corps etait un culturiste HUMAIN (peau nue bronzee, mains humaines) avec
 *      une tete de shiba. D'ou « fur EVERYWHERE », « no bare human skin anywhere »,
 *      « furry dog paws … instead of human hands », et l'element Kling
 *      (swoge_element.js) qui decrit le personnage par plusieurs vues.
 *   Le meme jour, le proprietaire a donne l'image de reference : le meme « Swole
 *   Doge » (img/site/swoge_meme_ref.jpg, 1170×1141) — petite tete de Doge sur un
 *   cou epais, buste et bras enormes, jambes courtes et fines, fourrure
 *   creme-beige UNIFORME (plus d'« orange-tan » sur la tete et le dos). Le short
 *   noir reste seulement comme garde de pudeur.
 *
 * ---- LES REFERENCES ----
 *   Sans element : @image_1 = le corps entier (le meme), @image_2 = le visage.
 *   Avec l'element : @element_1 seul (l'`id` de son entree, video-omni.md).
 * ======================================================================== */

/* @image_1 : le corps entier (le meme, choix du proprietaire le 15/10/2026, 1170×1141,
   rapport 1,03, dans les bornes O1 : >= 300 px, 1:2,5 a 2,5:1). */
const REF_CORPS = '/img/site/swoge_meme_ref.jpg';
/* @image_2 : le visage (image de la video SWOGE 3D, 768×768, 14/10/2026). */
const REF_VISAGE = '/img/site/swoge_face_ref.jpg';

/**
 * Le personnage, a mettre apres « Replace <qui> in @video_1 with ». `ref` vrai : cite
 * @element_1 ; faux : @image_1 (corps) et @image_2 (visage) ; un objet { corps, visage } :
 * d'autres jetons (l'image O1 cite <<<image_n>>>, premiere_image.js).
 */
function personnage(ref) {
  const r = ref && typeof ref === 'object' ? ref : null;
  const element = !!ref && !r;
  const qui = r ? r.corps + ' (full body) and ' + r.visage + ' (face)' : element ? '@element_1' : '@image_1 (full body) and @image_2 (face)';
  const visage = r ? ' of ' + r.visage : element ? '' : ' of @image_2';
  return 'the exact SWOGE character of ' + qui + ': the Swole Doge, a 3D Shiba Inu with a small Doge head on a thick tall neck, '
    + 'an enormous muscular upper body with huge arms, and short thin legs, much bigger than the original person. '
    + 'Thick fluffy cream-beige fur EVERYWHERE, one uniform colour; no bare human skin anywhere: chest, belly, arms and legs are all thick fur. '
    + 'Furry dog paws with dark pads and small dark claws instead of human hands. Plain black gym shorts. '
    + 'The face is the round friendly Doge face' + visage + ' (cream-white cheeks, small dark eyes, black nose, smile), NOT a realistic wolf-like Shiba; its mouth follows the words. '
    + 'Nothing is kept from the replaced person: no hair, skin, glasses, clothes or accessories';
}

/* Qui remplacer. `qui` entre dans « Replace <qui> in @video_1 », `autres` suit la phrase.
   « seule » est le choix par defaut du proprietaire ; `cache` : accepte, plus propose. */
const AUTRES = ' The other people stay exactly as they are.';
const CIBLES = [
  { id: 'gauche', nom: 'The person on the left', qui: 'ONLY the person on the LEFT side of the frame', autres: AUTRES },
  { id: 'centre', nom: 'The person in the center', qui: 'ONLY the person in the CENTER of the frame', autres: AUTRES },
  { id: 'droite', nom: 'The person on the right', qui: 'ONLY the person on the RIGHT side of the frame', autres: AUTRES },
  { id: 'seule', nom: 'The only person in the video', qui: 'the only person', autres: '' },
  /* d'avant le 15/10 : plus propose, accepte pour une page restee ouverte */
  { id: 'tous', nom: 'Everyone', qui: 'every person', autres: '', cache: true },
];
/* Les anciens identifiants encore acceptes : « chante » (« the person singing / talking ») a
   choisi la MAUVAISE personne le 15/10/2026 ; une vieille page qui l'envoie vise la seule personne. */
const ALIAS = { chante: 'seule' };
function cible(id) {
  const k = Object.prototype.hasOwnProperty.call(ALIAS, id) ? ALIAS[id] : id;
  return CIBLES.find((c) => c.id === k) || null;
}

/** Le texte par defaut du proprietaire, et celui de SWOGE Swap sans direction du joueur. */
function texte(idCible, element) {
  const c = cible(idCible) || cible('seule');
  return 'Replace ' + c.qui + ' in @video_1 with ' + personnage(element) + '.' + c.autres
    + ' Keep the camera, the background and the original audio unchanged.';
}

/**
 * Un texte ecrit pour les deux images (@image_1 corps, @image_2 visage), rendu pour l'element :
 * « @image_1 (full body) and @image_2 (face) » → « @element_1 », « … face of @image_2 » → « … face »,
 * tout autre @image_1 / @image_2 → @element_1. Sans aucune mention, l'element est nomme en tete.
 * Ne sert QUE quand les references sont exactement celles de SWOGE par defaut.
 */
function versElement(t) {
  let s = String(t || '')
    .replace(/@image_1 \(full body\) and @image_2 \(face\)/g, '@element_1')
    .replace(/@image_1 and @image_2/g, '@element_1')
    .replace(/ of @image_2\b/g, '')
    .replace(/@image_[12]\b/g, '@element_1');
  if (s.indexOf('@element_1') < 0) s = 'SWOGE is @element_1. ' + s;
  return s;
}

/* ---- ANIMER L'IMAGE FIXE DU PROPRIETAIRE (15/10/2026, kling.js lanceAnime) ----
 * L'edition (base_video) a rate 4 fois le 15/10 : mauvaise personne, corps humain, mauvaise
 * tete. Ici rien n'est « remplace » : @image_1 (first_frame) montre deja SWOGE a sa place, et
 * @video_1 (feature_video) ne donne que le mouvement. Le texte dit donc : partir EXACTEMENT de
 * @image_1, garder chaque personnage tel qu'il y est, suivre le mouvement, les gestes, le
 * rythme et la camera de @video_1, garder le decor. Les deux defauts mesures (peau humaine,
 * mains humaines) sont nommes une fois. `refs` : 'element' (@element_1), 'images' (@image_2
 * corps, @image_3 visage) ou rien. `note` : une direction du proprietaire, citee a la fin. */
const NOTE_ANIME_MAX = 400;
function texteAnime(refs, note) {
  const qui = refs === 'element' ? ' SWOGE is @element_1: he keeps exactly the look of @element_1 and of @image_1.'
    : refs === 'images' ? ' @image_2 (full body) and @image_3 (face) show exactly how SWOGE looks: he keeps that look and the look he has in @image_1.'
    : '';
  const n = String(note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, NOTE_ANIME_MAX);
  return 'Start exactly from @image_1: the first frame of the video is @image_1. '
    + 'Keep every character exactly as it looks in @image_1 (same body, fur, face, clothes, proportions and colours) for the whole video; nobody turns into someone else.'
    + qui
    + ' SWOGE, the furry Swole Doge, keeps thick cream-beige fur everywhere and furry dog paws: never human skin, human hands or a human body.'
    + ' Follow the motion, gestures, timing and camera movement of @video_1 exactly. Keep the background of @image_1.'
    + (n ? ' ' + n : '');
}

/* ---- SWOGE SWAP, LE PERSONNAGE D'UN JOUEUR ANIME (15/10/2026, swap_apercu.js) ----
 * Le meme principe que texteAnime, sans rien de propre a SWOGE : @image_1 est l'apercu fait par
 * le serveur (le personnage deja a sa place), @image_2 l'image du joueur ACCEPTEE par la porte
 * (swap_garde.js). Aucune direction du joueur ici : le texte est entierement celui du serveur. */
function texteAnimeLibre() {
  return 'Start exactly from @image_1: the first frame of the video is @image_1. '
    + 'Keep every character exactly as it looks in @image_1 (same body, face, clothes, proportions and colours) for the whole video; nobody turns into someone else.'
    + ' @image_2 shows exactly how the new character looks: it keeps that look and the look it has in @image_1, and never gets the face of a real person.'
    + ' Follow the motion, gestures, timing and camera movement of @video_1 exactly. Keep the background of @image_1.';
}

module.exports = { REF_CORPS, REF_VISAGE, CIBLES, ALIAS, AUTRES, NOTE_ANIME_MAX, cible, personnage, texte, versElement, texteAnime, texteAnimeLibre };
