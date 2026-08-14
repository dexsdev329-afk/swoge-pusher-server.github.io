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
const fragments = require('./fragments');
const sante = require('./sante');

const FILE = path.join(cfg.DATA_DIR, 'state.json');
const BAK = FILE + '.bak';
const SECOURS_MS = 5 * 60 * 1000;      // on rafraichit la copie de secours au plus toutes les 5 min

const COMPLET_MS = 5 * 60 * 1000;      // et l'instantane complet, au plus toutes les 5 min
/* En dessous, le fichier unique est plus rapide que les fragments : voir la
   mesure dans le commentaire de `sauveVite`. */
const SEUIL_FRAGMENTS = parseInt(process.env.SEUIL_FRAGMENTS || '2000', 10);

let dernierSecours = 0;
let dernierComplet = 0;
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
  /* Les fragments sont ecrits toutes les secondes, `state.json` toutes les
     cinq minutes : quand les deux existent, les fragments sont forcement les
     plus frais. On ne retombe sur le fichier unique que si leur lecture
     ECHOUE — jamais si elle rend du vide, ce qui serait la meme confusion que
     celle decrite plus haut, un cran plus bas. */
  try {
    const morceaux = fragments.charge();
    if (morceaux) {
      derniersJoueurs = morceaux.players.length;
      console.log(`[store] etat relu depuis les fragments (${derniersJoueurs} joueurs)`);
      return morceaux;
    }
  } catch (e) {
    console.error('[store] FRAGMENTS ILLISIBLES : ' + e.message +
                  ' — on retombe sur state.json, plus ancien mais entier.');
  }

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
      sante.noteEcriture(false);
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

    /* Les fragments sont relus AVANT `state.json` : quand l'etat est REMPLACE
       — une restauration, une remise a zero — il faut donc les refaire, sinon
       le redemarrage suivant rendrait l'ancien etat et la restauration
       n'aurait servi a rien.
     *
     * Mais seulement dans ce cas. L'instantane periodique, lui, ne remplace
     * rien : les fragments sont deja a jour, les reconstruire reecrirait des
     * milliers de fichiers pour rien. */
    if (o && o.reconstruire) {
      try { fragments.reconstruit(obj); }
      catch (e) { console.error('[store] fragments non reconstruits : ' + e.message); }
    }

    derniersJoueurs = obj.players.length;
    sante.noteEcriture(true);
    return true;
  } catch (e) {
    console.error('[store] SAUVEGARDE RATEE:', e.message);
    /* Le signal le plus important de tout le serveur : sans ecriture, les
       joueurs jouent pour rien et le decouvriront au redemarrage. */
    sante.noteEcriture(false);
    return false;
  }
}

/**
 * LA sauvegarde courante : elle n'ecrit que ce qui a bouge.
 *
 * Toutes les cinq minutes elle ecrit en plus l'instantane complet — celui
 * qu'on telecharge, qu'on restaure, et qui reste lisible sans rien connaitre
 * du decoupage. Le cout d'une reecriture entiere redevient acceptable a cette
 * cadence : sept cents millisecondes toutes les cinq minutes a vingt mille
 * joueurs, au lieu des memes sept cents millisecondes chaque seconde.
 *
 * @param {object} jeu l'objet Game
 * @returns {boolean}
 */
function sauveVite(jeu) {
  try {
    /* Le decoupage ne s'allume que quand il paie.
     *
     * Chaque fragment paie son propre fsync. En dessous de quelques milliers
     * de fiches, ecrire trente fragments coute PLUS cher que de reecrire le
     * fichier entier — mesure a 205 joueurs avec trente actifs : 30 ms contre
     * 5. Tant qu'on est petit, on garde donc exactement le comportement
     * d'avant, et on ne paie rien pour un probleme qu'on n'a pas.
     *
     * Le passage est a sens unique : une fois le decoupage en service, il le
     * reste. Faire l'aller-retour a chaque variation d'effectif reecrirait
     * tout dans les deux sens pour rien.
     */
    if (!fragments.actif() && jeu.players.size < SEUIL_FRAGMENTS) {
      const ok = save(jeu.serialize());
      if (ok) jeu.sales = new Set();
      return ok;
    }
    if (!fragments.actif()) {
      console.log(`[store] ${jeu.players.size} fiches : passage a l'ecriture par fragments.`);
      fragments.reconstruit(jeu.serialize());
      jeu.sales = new Set();
      return true;
    }

    const sales = jeu.sales;
    /* Les fragments D'ABORD, toujours. Ce sont eux qui font autorite a la
       relecture : ecrire l'instantane sans eux laisserait sur le disque des
       fragments plus vieux que le fichier, et c'est le fragment qui gagne. */
    if (sales && sales.size) {
      fragments.sauve(jeu, sales);
      /* On vide la liste APRES l'ecriture, et seulement si elle a reussi :
         une adresse effacee d'une liste alors que son fragment n'est pas
         ecrit ne serait plus jamais sauvee. */
      jeu.sales = new Set();
      sante.noteEcriture(true);
    }

    /* L'instantane complet, de loin en loin : c'est celui qu'on telecharge,
       celui qu'on restaure, et le seul lisible sans rien savoir du
       decoupage. `save()` porte les garde-fous — refus d'ecraser un etat
       peuple par du vide, copie de secours, rename atomique. */
    const t = Date.now();
    if (t - dernierComplet > COMPLET_MS) {
      dernierComplet = t;
      return save(jeu.serialize());
    }
    return true;
  } catch (e) {
    console.error('[store] SAUVEGARDE RAPIDE RATEE:', e.message,
                  '— les fiches restent marquees, la prochaine reessaiera.');
    sante.noteEcriture(false);
    return false;
  }
}

module.exports = { load, save, sauveVite, FILE, BAK };
