'use strict';
/*
 * Les fiches des joueurs, ecrites par morceaux.
 *
 * ---- le probleme, mesure ----
 *
 * `state.json` etait reecrit EN ENTIER a chaque sauvegarde, c'est-a-dire au
 * plus toutes les 1,2 seconde. Serialiser, stringifier, ecrire et fsync sont
 * tous les quatre bloquants : pendant ce temps le serveur ne repond a
 * personne, ni a un clic, ni a un retrait.
 *
 *      joueurs   serialize  stringify   write   fsync    total
 *          200        4,6        2,2      0,3     2,1      9 ms
 *        1 000       18,1       10,5      0,8     3,2     33 ms
 *        5 000       74,7       54,2     44,3    12,6    186 ms
 *       20 000      304,1      220,4    137,9    43,8    706 ms
 *      100 000     1946,4     3459,0    552,4   185,6   6144 ms
 *
 * Le palier qui compte n'est pas un nombre de joueurs, c'est le moment ou une
 * sauvegarde dure plus longtemps que l'intervalle entre deux sauvegardes :
 * vers trente mille fiches, le serveur ne rattrape plus jamais son retard.
 *
 * A noter, parce que ca change le remede : le disque n'est PAS le goulot. Le
 * write et le fsync font un quart du cout ; les trois autres quarts sont du
 * calcul en memoire, que changer de base de donnees ne corrigerait pas. Ce qui
 * le corrige, c'est de cesser de reecrire vingt mille fiches quand trente ont
 * bouge.
 *
 * ---- le remede ----
 *
 * Les fiches sont reparties en fragments, par les premiers chiffres de
 * l'adresse. Une fiche qui bouge salit son fragment ; a la sauvegarde on
 * n'ecrit que les fragments salis. Le cout cesse de dependre du nombre total
 * de joueurs et ne depend plus que de l'activite reelle : trente joueurs
 * actifs coutent vingt-cinq millisecondes, qu'il y en ait vingt mille inscrits
 * ou cent mille.
 *
 * L'adresse est un condensat : ses premiers chiffres sont uniformes, les
 * fragments se remplissent donc egalement sans qu'on ait rien a equilibrer.
 *
 * ---- ce qui est garde ----
 *
 * Chaque fragment s'ecrit comme s'ecrivait `state.json` : fichier temporaire,
 * fsync, puis rename atomique. Une coupure au milieu laisse le fragment
 * PRECEDENT intact — on perd au pire les quelques secondes d'un millieme des
 * fiches, la ou l'ancien format pouvait laisser un fichier tronque contenant
 * tout le monde.
 *
 * `state.json` n'est pas abandonne : il continue d'etre ecrit en entier, mais
 * rarement. C'est l'instantane qu'on telecharge, celui qu'on restaure, et
 * celui qui reste lisible par n'importe quoi. Les fragments sont plus frais,
 * donc ils gagnent a la relecture.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DOSSIER = path.join(cfg.DATA_DIR, 'fragments');
const TETE = path.join(DOSSIER, 'tete.json');

/*
 * Combien de fragments ? Une sauvegarde coute (fragments salis) x (fiches par
 * fragment) : plus il y en a, moins on reecrit. Mesure, avec trente joueurs
 * actifs :
 *
 *              256 fragments   4096 fragments
 *    20 000        82 ms            25 ms
 *   100 000       335 ms            53 ms
 *
 * Trois chiffres, donc — 4096. Le plancher de 20 ms est le prix des fsync, il
 * ne descendra pas, et c'est tres bien : c'est ce qui rend l'ecriture reelle.
 * Le cout en echange est un dossier de quelques milliers de petits fichiers,
 * ce qui ne coute rien a personne.
 */
const CHIFFRES = 3;
const NB = Math.pow(16, CHIFFRES);

/** Le fragment d'une adresse : ses premiers chiffres, apres le `0x`. */
function fragmentDe(addr, chiffres) {
  const c = chiffres || CHIFFRES;
  const a = String(addr).toLowerCase();
  const h = a.startsWith('0x') ? a.slice(2, 2 + c) : a.slice(0, c);
  return (h + '000').slice(0, c);
}
const cheminFragment = (f) => path.join(DOSSIER, f + '.json');

/* L'index : quel fragment contient quelles adresses. Sans lui, reecrire un
   fragment demanderait de parcourir tous les joueurs pour retrouver les
   siens — soit exactement le cout qu'on essaie de supprimer. */
let index = new Map();
/* Vrai quand ce qui est sur le disque n'a pas la meme forme que ce qu'on
   ecrirait aujourd'hui — un nombre de fragments change. On ne melange pas les
   deux : on reconstruit une fois, entierement. Sans ca, une fiche resterait
   dans un ancien fragment que plus rien ne reecrit, et ressusciterait avec son
   vieux solde au redemarrage suivant. */
let aReconstruire = false;
function indexe(addr) {
  const f = fragmentDe(addr);
  let s = index.get(f);
  if (!s) { s = new Set(); index.set(f, s); }
  s.add(String(addr).toLowerCase());
  return f;
}

/** Ecriture atomique d'un objet JSON. Le seul chemin d'ecriture de ce module. */
function ecrit(chemin, obj) {
  const tmp = chemin + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, chemin);
}

/**
 * Relit tete + fragments et rend l'etat COMPLET, dans la forme exacte que
 * `state.json` avait. Rien en aval n'a donc a savoir que le fichier a ete
 * decoupe.
 *
 * @returns {object|null} l'etat, ou null s'il n'y a pas de fragments
 * @throws  si les fragments existent mais sont illisibles — l'appelant
 *          retombera sur `state.json`, ce qu'il ne peut faire que s'il sait
 *          que la lecture a echoue, et surtout pas si elle a rendu du vide.
 */
function charge() {
  if (!fs.existsSync(TETE)) return null;
  const tete = JSON.parse(fs.readFileSync(TETE, 'utf8'));
  if (!tete || typeof tete !== 'object') throw new Error('tete de fragments illisible');

  index = new Map();
  const players = [];
  let noms;
  try { noms = fs.readdirSync(DOSSIER); } catch (e) { throw new Error('dossier de fragments illisible : ' + e.message); }
  /* On accepte les noms de toutes les longueurs, pas seulement la longueur
     courante : c'est ce qui permet de RELIRE un decoupage different avant de
     le refaire. */
  for (const nom of noms) {
    if (!/^[0-9a-f]{2,4}\.json$/.test(nom)) continue;
    const texte = fs.readFileSync(path.join(DOSSIER, nom), 'utf8');
    if (!texte.trim()) continue;
    const bloc = JSON.parse(texte);
    for (const addr of Object.keys(bloc)) {
      players.push([addr, bloc[addr]]);
      indexe(addr);
    }
  }
  /* La forme du disque n'est pas celle qu'on ecrirait aujourd'hui : on a tout
     relu, mais il faudra tout reecrire avant la premiere sauvegarde partielle.
     Melanger les deux laisserait des fiches dans des fragments que plus rien
     ne reecrit — elles ressusciteraient avec leur vieux solde. */
  aReconstruire = (tete.chiffres || 2) !== CHIFFRES;
  if (aReconstruire)
    console.warn(`[fragments] decoupage different sur le disque (${tete.chiffres || 2} chiffres, ` +
                 `${CHIFFRES} attendus) : tout sera reecrit a la prochaine sauvegarde.`);
  delete tete.chiffres;
  tete.players = players;
  return tete;
}

/**
 * La sauvegarde courante : la tete, et RIEN QUE les fragments salis.
 *
 * @param {object} jeu   l'objet Game — on lui demande `serializeTete()` et
 *                       `fiche(addr)`, une fiche a la fois
 * @param {Set}    sales les adresses touchees depuis la derniere fois
 * @returns {{fragments:number, fiches:number}}
 */
function sauve(jeu, sales) {
  fs.mkdirSync(DOSSIER, { recursive: true });
  /* Un decoupage different sur le disque se solde en une fois, pas fragment
     par fragment. */
  if (aReconstruire) { const etat = jeu.serialize(); reconstruit(etat); return { fragments: -1, fiches: etat.players.length }; }

  /* Une adresse jamais vue doit entrer dans l'index AVANT qu'on decide quoi
     reecrire, sinon son fragment serait reecrit sans elle — et la fiche
     disparaitrait du disque tout en restant en memoire, jusqu'au prochain
     redemarrage qui l'effacerait pour de bon. */
  const aRefaire = new Set();
  for (const addr of sales) aRefaire.add(indexe(addr));

  let fiches = 0;
  for (const f of aRefaire) {
    const bloc = {};
    const membres = index.get(f) || new Set();
    for (const addr of membres) {
      const fi = jeu.fiche(addr);
      /* Une fiche devenue vide sort du fragment, comme elle sortait du
         fichier unique : c'est la barriere contre les comptes jetables. */
      if (fi) { bloc[addr] = fi; fiches++; } else membres.delete(addr);
    }
    if (membres.size === 0) index.delete(f);
    ecrit(cheminFragment(f), bloc);
  }
  const tete = jeu.serializeTete();
  tete.chiffres = CHIFFRES;
  ecrit(TETE, tete);
  return { fragments: aRefaire.size, fiches };
}

/**
 * Reecrit TOUT depuis un etat complet. C'est le chemin de la restauration et
 * du premier passage a ce format : apres lui, les fragments sur le disque
 * disent exactement ce que dit l'etat fourni, et rien d'autre.
 */
function reconstruit(etat) {
  fs.mkdirSync(DOSSIER, { recursive: true });
  /* On efface les fragments existants AVANT d'ecrire les nouveaux. Sans ca,
     une restauration laisserait sur le disque les joueurs qui existaient
     avant et pas dans l'archive : ils reviendraient au redemarrage suivant,
     avec leur solde. */
  try {
    for (const nom of fs.readdirSync(DOSSIER))
      if (/^[0-9a-f]{2,4}\.json$/.test(nom)) fs.unlinkSync(path.join(DOSSIER, nom));
  } catch (e) { /* dossier neuf */ }

  index = new Map();
  const blocs = new Map();
  for (const [addr, fi] of (etat.players || [])) {
    const f = indexe(addr);
    if (!blocs.has(f)) blocs.set(f, {});
    blocs.get(f)[String(addr).toLowerCase()] = fi;
  }
  for (const [f, bloc] of blocs) ecrit(cheminFragment(f), bloc);

  const tete = { chiffres: CHIFFRES };
  for (const k of Object.keys(etat)) if (k !== 'players') tete[k] = etat[k];
  ecrit(TETE, tete);
  aReconstruire = false;
  return blocs.size;
}

/** Vrai si le decoupage est deja en service sur ce disque. */
function actif() { return fs.existsSync(TETE); }

module.exports = { charge, sauve, reconstruit, actif, fragmentDe, DOSSIER, TETE, NB, CHIFFRES };
