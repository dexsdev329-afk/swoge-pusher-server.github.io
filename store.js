'use strict';
/*
 * La persistance de l'etat du jeu : soldes, mises en jeu, jackpot, dedoublonnage
 * des depots, position de scan de la chaine. C'est le fichier qui porte l'argent
 * des joueurs, donc c'est le fichier qu'il ne faut jamais perdre.
 *
 * ---- LE DANGER QUI EXISTAIT ----
 *
 * `load()` avalait toute erreur et rendait null. Un null voulait dire deux
 * choses opposees :
 *
 *   • « aucun fichier » — premier demarrage, tout va bien, on part de zero ;
 *   • « fichier illisible » — disque plein, volume pas encore monte, JSON
 *     tronque… et la, partir de zero est une CATASTROPHE : le serveur
 *     demarrait avec zero joueur, et dix secondes plus tard la sauvegarde
 *     automatique ecrasait le bon fichier par un etat vide. Tous les soldes,
 *     effaces par une lecture ratee.
 *
 * Le cas n'est pas theorique : sur Railway, un volume monte quelques instants
 * apres le demarrage du conteneur suffit.
 *
 * Ces deux cas sont donc separes. Un fichier absent rend null. Un fichier
 * PRESENT mais illisible essaie la sauvegarde de secours, et si elle ne vaut
 * rien non plus, JETTE — le serveur refuse de demarrer plutot que d'effacer ce
 * qu'il n'a pas su lire. Un serveur qui ne demarre pas se repare ; des soldes
 * ecrases, non.
 *
 * ---- CE QUI PROTEGE L'ECRITURE ----
 *
 *   • ecriture dans un fichier temporaire, puis rename : le rename est
 *     atomique, donc une coupure au milieu laisse l'ancien fichier intact ;
 *   • fsync avant le rename : sans lui, « ecrit » ne veut dire que « accepte
 *     par le cache du systeme », et une coupure de courant rend un fichier
 *     vide a la place d'un fichier complet ;
 *   • une copie de secours, gardee a cote et rafraichie regulierement, pour le
 *     jour ou le fichier principal serait quand meme perdu ;
 *   • on refuse d'ecrire un etat manifestement vide par-dessus un etat qui ne
 *     l'etait pas : c'est le dernier filet, celui qui aurait suffi a lui seul
 *     a empecher le scenario decrit plus haut.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.DATA_DIR, 'state.json');
const BAK = FILE + '.bak';
const SECOURS_MS = 5 * 60 * 1000;      // on rafraichit la copie de secours au plus toutes les 5 min

let dernierSecours = 0;
let derniersJoueurs = 0;               // combien de joueurs dans le dernier etat CONNU bon

/** Lit un fichier JSON. Rend { etat } , { absent:true } ou { casse:message }. */
function lis(p) {
  let texte;
  try { texte = fs.readFileSync(p, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { absent: true } : { casse: e.message }; }
  if (!texte.trim()) return { casse: 'fichier vide' };
  try {
    const etat = JSON.parse(texte);
    if (!etat || typeof etat !== 'object') return { casse: 'contenu inattendu' };
    if (!Array.isArray(etat.players)) return { casse: 'aucune liste de joueurs' };
    return { etat };
  } catch (e) { return { casse: 'JSON invalide : ' + e.message }; }
}

/**
 * Charge l'etat.
 * @returns {object|null} l'etat, ou null s'il n'y a rien a charger (premier run)
 * @throws  si un fichier existe mais qu'aucune version lisible n'a ete trouvee
 */
function load() {
  const principal = lis(FILE);
  if (principal.etat) {
    derniersJoueurs = principal.etat.players.length;
    return principal.etat;
  }

  const secours = lis(BAK);
  if (principal.absent && secours.absent) return null;      // vrai premier demarrage

  if (principal.casse) console.error(`[store] ETAT PRINCIPAL ILLISIBLE : ${principal.casse}`);
  if (secours.etat) {
    console.error(`[store] on repart de la sauvegarde de secours (${secours.etat.players.length} joueurs) — ` +
                  `le fichier principal est mis de cote sous state.json.corrompu`);
    try { fs.renameSync(FILE, FILE + '.corrompu'); } catch (e) { /* deja absent */ }
    derniersJoueurs = secours.etat.players.length;
    return secours.etat;
  }

  /* Ni l'un ni l'autre. On ne demarre PAS : un serveur qui refuse de partir se
     repare a la main, des soldes ecrases par un etat vide ne se reparent pas. */
  throw new Error(
    `[store] impossible de lire l'etat des joueurs.\n` +
    `  principal : ${FILE} — ${principal.casse || 'absent'}\n` +
    `  secours   : ${BAK} — ${secours.casse || 'absent'}\n` +
    `  Le serveur s'arrete au lieu de demarrer a vide : demarrer a vide\n` +
    `  effacerait tous les soldes a la premiere sauvegarde automatique.\n` +
    `  Verifiez que le volume est bien monte sur ${cfg.DATA_DIR}.`);
}

/**
 * Ecrit l'etat.
 * @param {object} obj
 * @param {object} o { force: true } pour passer outre le garde-fou du vide
 * @returns {boolean}
 */
function save(obj, o) {
  try {
    if (!obj || !Array.isArray(obj.players)) { console.warn('[store] etat invalide, rien ecrit'); return false; }

    /* Le dernier filet. On n'ecrase JAMAIS un etat peuple par un etat vide
       sans le dire : c'est la signature exacte du demarrage rate. Si c'est
       voulu (remise a zero volontaire), l'appelant le demande explicitement. */
    if (!(o && o.force) && obj.players.length === 0 && derniersJoueurs > 0) {
      console.error(`[store] ECRITURE REFUSEE : 0 joueur a ecrire alors que le dernier etat connu en ` +
                    `avait ${derniersJoueurs}. C'est le signe d'un demarrage rate, pas d'une partie.`);
      return false;
    }

    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });

    // la copie de secours, prise sur le fichier PRECEDENT, encore intact
    const t = Date.now();
    if (t - dernierSecours > SECOURS_MS && fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, BAK); dernierSecours = t; }
      catch (e) { console.warn('[store] copie de secours ratee:', e.message); }
    }

    const tmp = FILE + '.tmp';
    const texte = JSON.stringify(obj);
    /* fsync avant le rename : sans lui, « ecrit » ne veut dire que « accepte
       par le cache », et une coupure de courant rend un fichier vide. */
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, texte);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, FILE);            // remplacement atomique

    derniersJoueurs = obj.players.length;
    return true;
  } catch (e) { console.error('[store] SAUVEGARDE RATEE:', e.message); return false; }
}

module.exports = { load, save, FILE, BAK };
