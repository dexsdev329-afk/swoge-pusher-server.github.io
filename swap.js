'use strict';
/* ==========================================================================
 * SWOGE SWAP — « METS SWOGE DANS TA VIDEO », SERVICE PUBLIC PAYANT (14 octobre 2026)
 *
 * Demande du proprietaire, 14/10/2026 : ouvrir aux joueurs l'edition d'une video
 * entiere par Kling O1 (kling_entier.js), prouvee en production sur ses propres
 * clips. CE module ne tient que le PRODUIT ; le moteur est kling_entier.js, le
 * meme que celui du proprietaire, avec `deps.public` (aucune copie du moteur).
 *
 * ---- CE QUE LE JOUEUR PEUT CHOISIR, ET RIEN D'AUTRE ----
 *   - un personnage MAISON (PERSONNAGES : SWOGE pour commencer — corps
 *     img/site/swoge_swole_ref.jpg en @image_1, visage img/site/swoge_face_ref.jpg
 *     en @image_2, les references de kling_edition.js) ;
 *   - qui remplacer (CIBLES : celui qui chante ou parle, a gauche, a droite, tout
 *     le monde).
 *   Aucune image de reference du joueur, aucun texte libre : le texte envoye a
 *   Kling est construit ICI depuis celui que le proprietaire a mis au point dans
 *   kling_essai.html (14/10/2026). L'outil ne peut pas devenir un « deepfake de
 *   n'importe qui » : il ne met jamais que nos personnages a la place de quelqu'un.
 *   Le joueur coche aussi « j'ai le droit d'utiliser cette video, et elle ne
 *   montre personne qui n'est pas d'accord » : la case est gardee avec la passe.
 *
 * ---- LE PRIX ----
 *   Mesure : Kling O1 « With Video Input » facture 0,126 $/s en 720p, chaque
 *   seconde ENTAMEE de chaque morceau comptee (pricing/base/video.md, lu le
 *   14/10/2026 ; kling.js prixEdition). Le prix montre AVANT de payer :
 *     ceil_cent(pire cas Kling du plan × SWAP_MARGE)    (720p seulement)
 *   SWAP_MARGE vaut 2 par defaut : aucune mesure de demande ni de taux d'echec
 *   chez Kling pour un public ; la maison paie les relances gratuites et les
 *   morceaux rates que Kling facturerait quand meme. A revoir sur le journal
 *   (swap_journal.jsonl : prixUsd, factureUsd, depenseKlingUsd par passe).
 *
 * ---- LES BORNES (env) ----
 *   SWAP_MARGE (2, >= 1), SWAP_MO_MAX (60 Mo, 1-100), SWAP_DUREE_MAX_S (60 s,
 *   3-180), SWAP_PARALLELE (2 passes chez Kling a la fois, 1-8, les autres en
 *   file), SWAP_PLAFOND_JOUR_USD (50 $ de depense Kling engagee par jour UTC ;
 *   0 ferme le service). Le plafond par passe de kling_entier.js (20 $) tient
 *   toujours. 60 s : un clip de telephone typique ; au pire 7 morceaux de 9 s
 *   entamees = 63 s × 0,126 = 7,94 $ chez Kling, 15,88 $ au joueur, sous le
 *   plafond de 100 $ du credit (CREDIT_MAX_USD).
 * ======================================================================== */
const KE = require('./kling_entier');
const K = require('./kling');

const VIDEO_PREFIXE = '/studio/swap-clip/';
const URL_PREFIXE = '/studio/swap/';
const DROITS_TEXTE = 'I own this video or have the right to use it, and it shows no one who did not agree to it.';

/* Le corps et le visage de SWOGE, tels que le proprietaire les decrit dans son texte par defaut
   (kling_essai.html, « Whole video », 14/10/2026). @image_1 = corps, @image_2 = visage. */
const PERSONNAGES = [
  { id: 'swoge', nom: 'SWOGE', images: ['/img/site/swoge_swole_ref.jpg', '/img/site/swoge_face_ref.jpg'], vignette: '/img/site/swoge_face_ref.jpg',
    texte: 'the character of @image_1 (body: huge muscular shirtless Swole Doge, cream-beige fur everywhere, furry dog paws with black pads instead of hands), with exactly the face of @image_2: the classic Doge meme face, pale cream-beige fur (not orange, not red), white cheeks and muzzle, small dark eyes glancing sideways, raised eyebrows, mouth closed in a slight smirk that only opens to lip-sync the words, the head proportionally small on a thick neck' },
];
/* Qui remplacer : `qui` entre dans « Replace <qui> in @video_1 », `garde` dans « Keep <garde>… ».
   « the singer » et « the other person » sont ceux du texte du proprietaire. */
const CIBLES = [
  { id: 'chante', nom: 'The person singing / talking', qui: 'the person who is singing or talking', garde: 'every other person, ' },
  { id: 'gauche', nom: 'The person on the left', qui: 'the person on the left of the frame', garde: 'every other person, ' },
  { id: 'droite', nom: 'The person on the right', qui: 'the person on the right of the frame', garde: 'every other person, ' },
  { id: 'tous', nom: 'Everyone', qui: 'every person', garde: '' },
];

/** Le texte envoye a Kling : construit ici, jamais recu. */
function prompt(personnage, cible) {
  return 'Replace ' + cible.qui + ' in @video_1 with ' + personnage.texte + '. Keep ' + cible.garde + 'the camera, the background and the original audio unchanged.';
}

const nombre = (v, def, min, max) => { const x = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(x) && x >= min && x <= max ? x : def; };
/** Les reglages, lus dans l'environnement (bornes : voir l'en-tete). */
function reglages(env) {
  env = env || process.env;
  return {
    marge: nombre(env.SWAP_MARGE, 2, 1, 10),
    moMax: nombre(env.SWAP_MO_MAX, 60, 1, KE.ENTREE_OCTETS_MAX / 1048576),
    dureeMaxS: nombre(env.SWAP_DUREE_MAX_S, 60, KE.DECOUPE.min, KE.DUREE_ENTIER_MAX),
    parallele: Math.floor(nombre(env.SWAP_PARALLELE, 2, 1, 8)),
    plafondJourUsd: nombre(env.SWAP_PLAFOND_JOUR_USD, 50, 0, 10000),
  };
}

/** Le prix du joueur : le pire cas Kling × marge, au cent superieur (calcul en micro-dollars entiers). */
function prixClient(prixKlingUsd, marge) {
  const micro = Math.round(Number(prixKlingUsd) * Number(marge) * 1e6);
  return Math.ceil(micro / 1e4 - 1e-9) / 100;
}

/**
 * Le paiement sur le credit en dollars : la MEME reserve durable que les videos du studio
 * (credits.soldeDurable), en micro-dollars convertis en unites 18 decimales (cours 1).
 */
function paieCredit(credits) {
  const W = (usd) => BigInt(Math.round(Number(usd) * 1e6)) * 10n ** 12n;
  const s = () => credits.soldeDurable('swoge swap');
  return {
    reserve: (addr, usd, info) => s().reserve(addr, W(usd), info),
    regle: (jeton, usd) => s().regleJeton(jeton, W(usd)),
    ravive: (jeton) => s().ravive(jeton),
    solde: (addr) => credits.soldeUsd(addr),
  };
}

/**
 * deps : { dossier, kling, site (URL du site, sans / final), moi (URL du serveur), credits | paie,
 *          journal(o), env?, + ce que kling_entier.cree accepte (fetchCdn, maintenant, pollMs…) }
 */
function cree(deps) {
  const R = reglages(deps.env);
  const site = String(deps.site || '').replace(/\/+$/, '');
  const paie = deps.paie || paieCredit(deps.credits);
  const pub = {
    marge: R.marge,
    passesMax: R.parallele,
    plafondJourUsd: R.plafondJourUsd,
    relancesGratuites: 1,
    /* ffmpeg coupe au plus 3 videos a la fois (toutes adresses) */
    decoupesMax: 3,
    /* un plan non lance part apres 2 h ; une passe en suspens se finit seule apres 6 h */
    pretMaxMs: deps.pretMaxMs != null ? deps.pretMaxMs : 2 * 3600e3,
    incompletMaxMs: deps.incompletMaxMs != null ? deps.incompletMaxMs : 6 * 3600e3,
    droitsTexte: DROITS_TEXTE,
    paie,
    prixClient: (x) => prixClient(x, R.marge),
    urlVideo: (id) => URL_PREFIXE + id + '/video',
    choisit(idPerso, idCible) {
      const p = PERSONNAGES.find((x) => x.id === idPerso);
      if (!p) return { ok: false, raison: 'pick one of our characters' };
      const c = CIBLES.find((x) => x.id === idCible);
      if (!c) return { ok: false, raison: 'pick who to replace' };
      return { ok: true, images: p.images.map((u) => site + u), prompt: prompt(p, c), personnage: p.id, cible: c.id };
    },
    catalogue: () => ({ personnages: PERSONNAGES.map((p) => ({ id: p.id, nom: p.nom, vignette: p.vignette })), cibles: CIBLES.map((c) => ({ id: c.id, nom: c.nom })) }),
  };
  const moteur = KE.cree(Object.assign({}, deps, {
    public: pub,
    octetsMax: Math.round(R.moMax * 1048576),
    dureeMax: R.dureeMaxS,
    urlPublique: deps.urlPublique || ((nom) => String(deps.moi || '') + VIDEO_PREFIXE + nom),
    imagesDefaut: PERSONNAGES[0].images.map((u) => site + u),
  }));
  moteur.reglages = R;
  return moteur;
}

module.exports = { cree, reglages, prixClient, paieCredit, prompt, PERSONNAGES, CIBLES, DROITS_TEXTE, VIDEO_PREFIXE, URL_PREFIXE, PRIX_720P: K.EDITION_PRIX['720p'] };
