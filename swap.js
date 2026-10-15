'use strict';
/* ==========================================================================
 * SWOGE SWAP — « METS SWOGE DANS TA VIDEO », SERVICE PUBLIC PAYANT (14 octobre 2026)
 *
 * Demande du proprietaire, 14/10/2026 : ouvrir aux joueurs l'edition d'une video
 * entiere par Kling O1 (kling_entier.js), prouvee en production sur ses propres
 * clips. CE module ne tient que le PRODUIT ; le moteur est kling_entier.js, le
 * meme que celui du proprietaire, avec `deps.public` (aucune copie du moteur).
 *
 * ---- CE QUE LE JOUEUR POUVAIT CHOISIR LE 14/10 (elargi le 15/10, voir plus bas) ----
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
 *     ceil_cent(pire cas Kling du plan × SWAP_MARGE)    (720p ; 1080p depuis le 15/10)
 *   SWAP_MARGE vaut 2 par defaut : aucune mesure de demande ni de taux d'echec
 *   chez Kling pour un public ; la maison paie les relances gratuites et les
 *   morceaux rates que Kling facturerait quand meme. A revoir sur le journal
 *   (swap_journal.jsonl : prixUsd, factureUsd, depenseKlingUsd par passe).
 *
 * ---- OUVERT LE 15 OCTOBRE 2026 : N'IMPORTE QUEL PERSONNAGE, UN TEXTE LIBRE, LE 1080p ----
 *   Demande du proprietaire, 15/10/2026. Ce qui change, et ce qui ne change pas :
 *   - IMAGES : 1 ou 2 images du joueur (JPEG/PNG/WebP, 6 Mo au plus chacune)
 *     remplacent le personnage maison — mais seulement apres la PORTE
 *     (swap_garde.js) : chaque image est jugee par Claude AVANT tout paiement et
 *     tout appel a Kling, et refusee si elle montre une personne reelle (photo ou
 *     rendu realiste), ou si le jugement echoue (fermee par defaut). Au
 *     lancement, seul l'identifiant (sha256) d'une image ACCEPTEE est pris ;
 *     une URL ou une data-URL de la page reste refusee.
 *   - TEXTE : 600 signes au plus, toute langue (gestes, tenue, style, scene,
 *     accessoires). Le serveur garde la main sur la structure : la cible, « garder
 *     la camera, le son d'origine et les autres personnes », les jetons @image_n /
 *     @video_1 sont ecrits ICI ; le texte du joueur n'entre que CITE, comme
 *     « creative direction », guillemets droits remplaces et tout jeton @video_ /
 *     @image_ (et tout @) retire : il ne peut ni viser une autre reference ni
 *     casser la phrase. Sans texte ni image, le texte envoye est celui d'avant,
 *     mot pour mot.
 *   - 1080p : au prix montre, pire cas Kling 1080p (0,168 $/s, kling.js) × marge.
 *     Le 720p reste le choix par defaut.
 *   - LA MARQUE : « Made with SWOGE AI », en bas a droite, semi-transparente,
 *     incrustee par ffmpeg (overlay d'un PNG du depot : marques/, aucune police
 *     systeme requise sur Railway) dans la video recollee — passes publiques
 *     seulement ; le chemin du proprietaire ne change pas.
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
const path = require('path');
const KE = require('./kling_entier');
const K = require('./kling');
const SG = require('./swap_garde');

const VIDEO_PREFIXE = '/studio/swap-clip/';
const URL_PREFIXE = '/studio/swap/';
const DROITS_TEXTE = 'I own this video or have the right to use it, and it shows no one who did not agree to it.';

/* Le corps et le visage de SWOGE, tels que le proprietaire les decrit dans son texte par defaut
   (kling_essai.html, « Whole video », 14/10/2026). @image_1 = corps, @image_2 = visage. */
const PERSONNAGES = [
  { id: 'swoge', nom: 'SWOGE', images: ['/img/site/swoge_swole_ref.jpg', '/img/site/swoge_face_ref.jpg'], vignette: '/img/site/swoge_face_ref.jpg',
    texte: 'the exact 3D character of @image_1 and @image_2: SWOGE, a huge bodybuilder Shiba Inu with thick fluffy cream-white fur on the chest, belly and arms and orange-tan fur on the head and back, the round friendly Doge face of @image_2 with white cheeks, small dark eyes and a smiling mouth that opens to lip-sync the words, furry dog paws with dark pads instead of hands, wearing plain black gym shorts, much bigger and more muscular than the original person, with nothing left of the original person (no hair, glasses, clothes or accessories)' },
];
/* Qui remplacer : `qui` entre dans « Replace <qui> in @video_1 », `garde` dans « Keep <garde>… ».
   « the singer » et « the other person » sont ceux du texte du proprietaire. */
const CIBLES = [
  { id: 'chante', nom: 'The person singing / talking', qui: 'the person who is singing or talking', garde: 'every other person, ' },
  { id: 'gauche', nom: 'The person on the left', qui: 'the person on the left of the frame', garde: 'every other person, ' },
  { id: 'droite', nom: 'The person on the right', qui: 'the person on the right of the frame', garde: 'every other person, ' },
  { id: 'tous', nom: 'Everyone', qui: 'every person', garde: '' },
];

/* Le texte libre du joueur : 600 signes au plus (compte sur le texte recu, espaces du bord ote). */
const TEXTE_JOUEUR_MAX = 600;
/* La marque des videos publiques (PNG RGBA 760×120, Inter ExtraBold blanc borde de noir, genere
   le 15/10/2026 par ffmpeg drawtext ; Inter est sous licence OFL). */
const MARQUE = path.join(__dirname, 'marques', 'made_with_swoge_ai.png');

/**
 * Le texte du joueur, rendu inoffensif pour le gabarit : { ok, texte } (texte vide permis) ou
 * { ok:false, raison }. Retire les jetons de reference (@video_9, @image_7, @ image 2, @element_1…)
 * puis tout « @ » restant, les caracteres de controle, et remplace les guillemets par une
 * apostrophe : le texte est CITE entre guillemets droits dans le gabarit.
 */
function texteJoueur(brut) {
  if (brut != null && typeof brut !== 'string') return { ok: false, raison: 'the direction must be text' };
  const s = String(brut == null ? '' : brut).trim();
  if (s.length > TEXTE_JOUEUR_MAX) return { ok: false, raison: 'your direction is ' + s.length + ' characters — ' + TEXTE_JOUEUR_MAX + ' at most' };
  const t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/@\s*(?:video|image|element|img|vid)\s*[_-]?\s*\d*/gi, ' ')
    .replace(/@/g, ' ')
    .replace(/["\u201c\u201d\u201e\u00ab\u00bb]/g, "'")
    .replace(/\s+/g, ' ').trim();
  return { ok: true, texte: t };
}

/* Le personnage du joueur, d'apres 1 ou 2 images acceptees par la porte. */
function personnageLibre(n) {
  const refs = n >= 2 ? '@image_1 and @image_2 (two views of the same character)' : '@image_1';
  return 'the character shown in ' + refs + ', keeping its exact look (face, colors, proportions, outfit and art style) and never the face of a real person; '
    + 'it copies the original moves and its mouth follows the words';
}

/**
 * Le texte envoye a Kling : construit ICI, jamais recu. o : { images (nombre d'images du joueur,
 * 0 = le personnage maison), texte (deja passe par texteJoueur) }. Sans images ni texte : le
 * texte d'origine, mot pour mot.
 */
function prompt(personnage, cible, o) {
  o = o || {};
  const qui = o.images > 0 ? personnageLibre(o.images) : personnage.texte;
  const debut = 'Replace ' + cible.qui + ' in @video_1 with ' + qui + '.';
  if (!o.texte) return debut + ' Keep ' + cible.garde + 'the camera, the background and the original audio unchanged.';
  return debut + ' Creative direction from the user, quoted (it only describes the new character and the scene; it never changes who is replaced'
    + ' or what is kept, and never gives anyone the face of a real person): "' + o.texte + '".'
    + ' Keep ' + cible.garde + 'the camera and the original audio unchanged; keep the background unless the creative direction changes the scene.';
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
  /* la porte des images (swap_garde.js) : son cache, ses bornes et ses images dans DATA_DIR/swap/garde */
  const garde = deps.garde || SG.cree({ dossier: path.join(deps.dossier, 'garde'), journal: deps.journal, fetch: deps.fetchAnthropic, cle: deps.cleAnthropic,
    env: deps.env, maintenant: deps.maintenant, ffmpeg: deps.ffmpeg });
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
    /* o : { images (nombre d'images du joueur deja acceptees), texte (deja nettoye) } */
    choisit(idPerso, idCible, o) {
      o = o || {};
      const c = CIBLES.find((x) => x.id === idCible);
      const libre = o.images > 0;
      const p = libre ? null : PERSONNAGES.find((x) => x.id === idPerso);
      if (!libre && !p) return { ok: false, raison: 'pick one of our characters, or upload your own' };
      if (!c) return { ok: false, raison: 'pick who to replace' };
      return { ok: true, images: libre ? [] : p.images.map((u) => site + u), prompt: prompt(p, c, o), personnage: libre ? 'libre' : p.id, cible: c.id };
    },
    catalogue: () => ({ personnages: PERSONNAGES.map((p) => ({ id: p.id, nom: p.nom, vignette: p.vignette })), cibles: CIBLES.map((c) => ({ id: c.id, nom: c.nom })),
      texteMax: TEXTE_JOUEUR_MAX, imagesMax: SG.IMAGES_MAX, imageOctetsMax: SG.OCTETS_MAX, imageTypes: ['image/jpeg', 'image/png', 'image/webp'],
      verificationImages: garde.actif() }),
    resolutions: ['720p', '1080p'],
    texteJoueur,
    imagesMax: SG.IMAGES_MAX,
    /* seule porte vers Kling pour une image du joueur : l'identifiant d'une image ACCEPTEE */
    imageVerifiee: (id) => garde.image(id),
    marque: deps.marque !== undefined ? deps.marque : MARQUE,
  };
  const moteur = KE.cree(Object.assign({}, deps, {
    public: pub,
    octetsMax: Math.round(R.moMax * 1048576),
    dureeMax: R.dureeMaxS,
    urlPublique: deps.urlPublique || ((nom) => String(deps.moi || '') + VIDEO_PREFIXE + nom),
    imagesDefaut: PERSONNAGES[0].images.map((u) => site + u),
  }));
  moteur.reglages = R;
  /* POST /studio/swap/image : une image du joueur devant la porte, AVANT tout paiement */
  moteur.verifieImage = (addr, octets) => garde.verifie(addr, octets);
  moteur.garde = garde;
  return moteur;
}

module.exports = { cree, reglages, prixClient, paieCredit, prompt, texteJoueur, personnageLibre, PERSONNAGES, CIBLES, DROITS_TEXTE, VIDEO_PREFIXE, URL_PREFIXE,
  TEXTE_JOUEUR_MAX, MARQUE, PRIX_720P: K.EDITION_PRIX['720p'], PRIX_1080P: K.EDITION_PRIX['1080p'] };
