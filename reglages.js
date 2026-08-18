'use strict';
/*
 * LES REGLAGES A CHAUD.
 *
 * ---- le probleme ----
 *
 * `config.js` lit `process.env` UNE SEULE FOIS, au chargement du module.
 * Changer un prix de coffre, une recompense de quete, un plafond de credit ou
 * le bareme de rachat imposait de modifier une variable chez l'hebergeur et de
 * REDEMARRER — ce qui coupe toutes les parties en cours. Regler un jeu coutait
 * donc une coupure de service, et on ne regle pas un jeu qu'on n'ose pas
 * regler.
 *
 * ---- la couche ----
 *
 * Un fichier a cote de l'etat, charge au demarrage, modifiable depuis le
 * panneau. `cfg.get('CLE')` rend la surcharge si elle existe, sinon la valeur
 * de l'environnement. Rien d'autre ne change : le code qui lit `cfg.CLE`
 * directement continue de marcher, il ne voit simplement pas la surcharge.
 *
 * ---- pourquoi une LISTE BLANCHE et pas « tout » ----
 *
 * Parce que certaines cles ne sont pas des reglages de jeu, ce sont des
 * fondations. `VAULT_ADDRESS` change l'adresse du coffre : la surcharger
 * enverrait l'argent ailleurs. `ADMIN_KEY` change la serrure depuis l'interieur.
 * `CHAIN_ID`, `SIGNER_PRIVATE_KEY`, `DATA_DIR` : chacune casse le serveur ou
 * l'argent, et aucune n'a de raison de bouger a chaud.
 *
 * La liste dit donc ce qui SE REGLE, et tout le reste est hors d'atteinte —
 * y compris pour quelqu'un qui aurait la cle. C'est le sens d'une liste
 * blanche : l'oubli d'une entree ferme, il n'ouvre pas.
 *
 * ---- pourquoi les bornes ----
 *
 * Un plafond de credit a 10^12 n'est pas un reglage, c'est un accident. Chaque
 * cle porte son type et ses bornes, verifies a l'ecriture : le panneau refuse
 * la valeur au lieu de la faire avaler au moteur.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FICHIER = path.join(cfg.DATA_DIR, 'reglages.json');

/* n = nombre · b = booleen · s = chaine.  min/max bornent les nombres. */
const PERMISES = {
  // ---- la boutique et la collection ----
  RACHAT_BASE:            { t: 'n', min: 0,   max: 100000, quoi: 'Prix de rachat du commun (les autres en derivent)' },
  RACHAT_RECYCLE:         { t: 'b',                        quoi: 'L objet rachete retourne au coffre' },
  RACHAT_VOLUME_MIN:      { t: 'n', min: 0,   max: 1e9,    quoi: 'Volume joue exige pour vendre en instantane' },
  COFFRES_GRATUITS_JOUR:  { t: 'n', min: 0,   max: 100000, quoi: 'Contingent de coffres offerts par jour' },

  // ---- le marche ----
  MARCHE_FRAIS_BPS:       { t: 'n', min: 0,   max: 3000,   quoi: 'Commission du marche, en centiemes de %' },
  MARCHE_PRIX_MIN:        { t: 'n', min: 1,   max: 1e9,    quoi: 'Prix minimum d une annonce' },
  MARCHE_PRIX_MAX:        { t: 'n', min: 1,   max: 1e12,   quoi: 'Prix maximum d une annonce' },
  MARCHE_ANNONCES_MAX:    { t: 'n', min: 1,   max: 500,    quoi: 'Annonces simultanees par joueur' },
  MARCHE_REQUIERT_DEPOT:  { t: 'b',                        quoi: 'Le marche exige un depot' },

  // ---- les quetes et l engagement ----
  QUETE_CIBLE_MAX:        { t: 'n', min: 1,   max: 1e9,    quoi: 'Plafond de la cible d une quete de volume' },
  QUETE_CIBLE_MIN:        { t: 'n', min: 1,   max: 1e9,    quoi: 'Plancher de la cible d une quete de volume' },
  QUETE_CIBLE_MULT:       { t: 'n', min: 0.1, max: 50,     quoi: 'Multiplicateur de la cible sur le volume habituel' },
  QUETE_JETONS_APRES_DEPOT:{t: 'b',                        quoi: 'Les quetes ne paient en jetons qu apres un depot' },
  QUEST_REQUIRE_DEPOSIT:  { t: 'b',                        quoi: 'Les quetes sont fermees sans depot' },
  PARFAIT_XP:             { t: 'n', min: 0,   max: 100000, quoi: 'XP du sans-faute du jour' },
  XP_CONNEXION:           { t: 'n', min: 0,   max: 100000, quoi: 'XP de la connexion quotidienne' },
  XP_QUETE:               { t: 'n', min: 0,   max: 100000, quoi: 'XP par defaut d une quete' },
  XP_PARRAIN:             { t: 'n', min: 0,   max: 100000, quoi: 'XP par filleul' },
  XP_FAMILLE:             { t: 'n', min: 0,   max: 100000, quoi: 'XP d une famille complete' },

  // ---- l argent de la maison ----
  WELCOME_BONUS:          { t: 'n', min: 0,   max: 1e7,    quoi: 'Credit d essai a la premiere connexion' },
  WELCOME_CLAIM:          { t: 'n', min: 0,   max: 1e7,    quoi: 'Recompense de bienvenue apres la premiere mise' },
  PRIX_CLASSEMENT_BPS:    { t: 'n', min: 0,   max: 5000,   quoi: 'Part du revenu versee au classement, en centiemes de %' },
};

let surcharges = {};

/* ---- POURQUOI ON ECRIT DANS `cfg` PLUTOT QUE D'AJOUTER UN `cfg.get()` ----
 *
 * Un accesseur aurait oblige a reecrire chaque lecture : `cfg.RACHAT_BASE`
 * apparait des dizaines de fois dans game.js, boutique.js et server.js. Il
 * aurait suffi d'en oublier UNE pour que le reglage semble changer sans rien
 * changer — le pire des bugs, parce qu'il ne se signale pas : le panneau
 * affiche la nouvelle valeur et le moteur applique l'ancienne.
 *
 * On pose donc la valeur sur l'objet de configuration lui-meme. Toutes les
 * lectures existantes la voient, sans qu'aucune ait besoin d'etre touchee.
 *
 * Le prix a payer : `cfg` ne porte plus la valeur d'origine. On en prend donc
 * une copie AVANT toute surcharge — c'est elle qui permet de revenir en
 * arriere sans avoir a se souvenir de ce qu'on a change. */
const ORIGINE = {};
let capture = false;
function captureOrigine() {
  if (capture) return;
  for (const k of Object.keys(PERMISES)) ORIGINE[k] = cfg[k];
  capture = true;
}

function applique() {
  captureOrigine();
  for (const k of Object.keys(PERMISES)) {
    cfg[k] = Object.prototype.hasOwnProperty.call(surcharges, k) ? surcharges[k] : ORIGINE[k];
  }
}

function charge() {
  captureOrigine();
  try {
    const brut = fs.readFileSync(FICHIER, 'utf8');
    const o = JSON.parse(brut);
    surcharges = {};
    for (const k of Object.keys(o || {})) if (PERMISES[k]) surcharges[k] = o[k];
    const n = Object.keys(surcharges).length;
    if (n) console.log(`[reglages] ${n} surcharge(s) a chaud : ${Object.keys(surcharges).join(', ')}`);
  } catch (e) { surcharges = {}; }
  applique();
  return surcharges;
}

function ecrit() {
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    fs.writeFileSync(FICHIER, JSON.stringify(surcharges, null, 2));
    return true;
  } catch (e) { console.warn('[reglages] ecriture refusee :', e.message); return false; }
}

/** La valeur en vigueur. Elle est DANS `cfg` — c'est tout l'interet. */
function get(cle) { captureOrigine(); return cfg[cle]; }

/** La valeur d'origine : celle de l'environnement, avant toute surcharge. */
function origine(cle) { captureOrigine(); return ORIGINE[cle]; }

/**
 * Pose une surcharge. Rend `{ ok, avant, apres }` ou `{ ok:false, error }`.
 *
 * `null` REMET LA VALEUR D'ORIGINE — celle de l'environnement. C'est le geste
 * le plus important du panneau : il faut pouvoir revenir en arriere sans se
 * souvenir de ce qu'etait la valeur avant, sinon un mauvais reglage devient
 * definitif faute de savoir quoi retaper.
 */
function pose(cle, valeur) {
  const d = PERMISES[cle];
  if (!d) return { ok: false, error: `"${cle}" is not adjustable at runtime` };
  const avant = get(cle);

  if (valeur === null || valeur === undefined || valeur === '') {
    delete surcharges[cle];
    applique(); ecrit();
    return { ok: true, avant, apres: get(cle), remis: true };
  }

  let v = valeur;
  if (d.t === 'n') {
    v = Number(v);
    if (!Number.isFinite(v)) return { ok: false, error: 'not a number' };
    if (d.min !== undefined && v < d.min) return { ok: false, error: `minimum is ${d.min}` };
    if (d.max !== undefined && v > d.max) return { ok: false, error: `maximum is ${d.max}` };
  } else if (d.t === 'b') {
    v = (v === true || v === 'true' || v === '1' || v === 1);
  } else {
    v = String(v).slice(0, 200);
  }

  surcharges[cle] = v;
  applique(); ecrit();
  return { ok: true, avant, apres: v, remis: false };
}

/** Tout ce que le panneau doit peindre : valeur en vigueur, origine, bornes. */
function etat() {
  return Object.keys(PERMISES).map((cle) => {
    const d = PERMISES[cle];
    const surcharge = Object.prototype.hasOwnProperty.call(surcharges, cle);
    return { cle, quoi: d.quoi, type: d.t, min: d.min, max: d.max,
             valeur: get(cle), origine: origine(cle), surcharge };
  });
}

module.exports = { charge, get, origine, pose, etat, PERMISES, FICHIER };
