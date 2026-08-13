'use strict';
/*
 * Le journal du joueur : ses depots, ses retraits, et chacune de ses manches.
 *
 * ---- pourquoi ce n'est PAS dans state.json ----
 *
 * L'etat du jeu est un seul fichier JSON, relu en entier au demarrage et
 * reecrit en entier toutes les dix secondes. Y ranger chaque manche de chaque
 * joueur « a vie » le ferait grossir sans fin : au bout d'un million de
 * manches, chaque sauvegarde reecrirait des dizaines de megaoctets pour un
 * solde qui a bouge de trois jetons. Le serveur ralentirait a mesure que les
 * joueurs jouent — exactement l'inverse de ce qu'on veut.
 *
 * Le journal est donc a cote : UN FICHIER PAR JOUEUR, en append-only.
 *
 *   • ecrire coute une ligne ajoutee en fin de fichier, quoi qu'il y ait
 *     avant : le prix ne monte pas avec l'anciennete du joueur ;
 *   • lire l'historique d'un joueur, c'est lire SON fichier — pas parcourir
 *     celui de tout le monde. C'est la seule lecture qu'on fasse jamais, et
 *     elle devient triviale ;
 *   • un fichier corrompu ou perdu ne coute que l'historique d'un joueur, pas
 *     celui du casino.
 *
 * L'argent, lui, reste dans state.json. Le journal RACONTE, il ne fait pas
 * autorite : une ligne perdue ne change aucun solde.
 *
 * ---- lire par la fin ----
 *
 * On veut toujours les evenements les plus RECENTS. Relire un fichier de dix
 * megaoctets pour en afficher vingt lignes serait absurde, donc on lit la
 * queue par morceaux, en remontant, et on s'arrete des qu'on en a assez.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DOSSIER = path.join(cfg.DATA_DIR, 'journal');
const MORCEAU = 64 * 1024;          // taille d'un morceau lu depuis la fin
const MAX_MORCEAUX = 24;            // ~1,5 Mo remonte au plus, soit des milliers de lignes

let pret = false;
function dossier() {
  if (!pret) { try { fs.mkdirSync(DOSSIER, { recursive: true }); pret = true; } catch (e) { /* disque en lecture seule */ } }
  return DOSSIER;
}

/* Le nom du fichier vient de l'adresse, et rien d'autre ne doit pouvoir s'y
   glisser : une adresse est 0x suivi de quarante hexa, on le verifie plutot
   que de faire confiance a l'appelant. */
function fichier(addr) {
  const a = String(addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  return path.join(dossier(), a + '.jsonl');
}

/**
 * Ajoute un evenement. Ne rend rien, ne jette jamais : le journal ne doit
 * jamais empecher une partie de se terminer ni un depot d'etre credite.
 */
function ajoute(addr, evt) {
  const f = fichier(addr);
  if (!f || !evt) return;
  let ligne;
  try { ligne = JSON.stringify({ t: evt.t || Date.now(), ...evt }) + '\n'; }
  catch (e) { return; }
  fs.appendFile(f, ligne, (e) => { if (e) console.warn('[journal]', e.message); });
}

/** Version synchrone, pour les tests : la lecture qui suit voit l'ecriture. */
function ajouteSync(addr, evt) {
  const f = fichier(addr);
  if (!f || !evt) return;
  try { fs.appendFileSync(f, JSON.stringify({ t: evt.t || Date.now(), ...evt }) + '\n'); }
  catch (e) { console.warn('[journal]', e.message); }
}

/**
 * Les evenements d'un joueur, du plus recent au plus ancien.
 *
 * LE CURSEUR EST UNE POSITION DANS LE FICHIER, PAS UN HORODATAGE. C'est le
 * point delicat : trente manches lancees d'affilee partagent la meme
 * milliseconde, et « rends-moi ce qui precede cet instant » en saute alors
 * une a chaque changement de page — silencieusement, et seulement chez les
 * joueurs rapides. Une position d'octet, elle, designe UNE ligne et une
 * seule, quoi qu'il arrive.
 *
 * @param {string} addr
 * @param {object} o  { genre: 'dep'|'wd'|'r'|'st'|null, curseur: number|null, limite: number }
 * @returns {{ evenements: object[], curseur: number|null, encore: boolean }}
 */
function lit(addr, o) {
  const f = fichier(addr);
  const limite = Math.min(Math.max(1, (o && o.limite) || 25), 200);
  const genre = (o && o.genre) || null;
  if (!f || !fs.existsSync(f)) return { evenements: [], curseur: null, encore: false };

  let fd = null;
  try {
    fd = fs.openSync(f, 'r');
    const taille = fs.fstatSync(fd).size;
    const depart = (o && Number.isFinite(o.curseur) && o.curseur >= 0)
      ? Math.min(o.curseur, taille) : taille;

    let fin = depart, reste = '', out = [], positions = [], morceaux = 0, toutLu = false;

    while (out.length < limite && morceaux < MAX_MORCEAUX) {
      if (fin <= 0) { toutLu = true; break; }
      const debut = Math.max(0, fin - MORCEAU);
      const buf = Buffer.alloc(fin - debut);
      fs.readSync(fd, buf, 0, buf.length, debut);
      morceaux++;
      /* `reste` est le HAUT du morceau precedent, encore inexploitable parce
         qu'il commencait au milieu d'une ligne. Colle derriere celui-ci, on
         obtient un texte continu qui commence exactement a `debut` — ce qui
         permet de calculer la position de chaque ligne. */
      const texte = buf.toString('utf8') + reste;
      const parts = texte.split('\n');
      let off = debut;
      if (debut > 0) { reste = parts.shift(); off += reste.length + 1; }
      else reste = '';
      // les positions de depart de chaque ligne complete
      positions.length = 0;
      for (const part of parts) { positions.push(off); off += part.length + 1; }

      for (let i = parts.length - 1; i >= 0 && out.length < limite; i--) {
        const l = parts[i].trim();
        if (!l) continue;
        let e; try { e = JSON.parse(l); } catch (err) { continue; }
        if (genre && e.k !== genre) continue;
        e.__pos = positions[i];
        out.push(e);
      }
      fin = debut;
      if (debut === 0) toutLu = true;
    }

    const dernier = out.length ? out[out.length - 1].__pos : null;
    for (const e of out) delete e.__pos;
    /* « Encore » veut dire : il reste des octets AVANT le dernier rendu. Le
       dire faux dans un sens cacherait de l'historique, dans l'autre il
       afficherait un bouton qui ne rend rien. */
    const encore = dernier !== null ? dernier > 0 : !toutLu;
    return { evenements: out, curseur: dernier, encore };
  } catch (e) {
    console.warn('[journal] lecture:', e.message);
    return { evenements: [], curseur: null, encore: false };
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
}

/** Combien de lignes en tout, et depuis quand — pour l'en-tete du profil. */
function resume(addr) {
  const f = fichier(addr);
  if (!f || !fs.existsSync(f)) return { lignes: 0, depuis: null, octets: 0 };
  try {
    const octets = fs.statSync(f).size;
    /* On compte les sauts de ligne sans tout garder en memoire : un fichier de
       dix megaoctets ne doit pas devenir dix megaoctets de chaine. */
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(MORCEAU);
    let lignes = 0, pos = 0, premiere = null;
    while (pos < octets) {
      const n = fs.readSync(fd, buf, 0, Math.min(MORCEAU, octets - pos), pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (buf[i] === 10) lignes++;
      if (premiere === null) {
        const l = buf.toString('utf8', 0, n).split('\n')[0];
        try { premiere = JSON.parse(l).t; } catch (e) { premiere = null; }
      }
      pos += n;
    }
    fs.closeSync(fd);
    return { lignes, depuis: premiere, octets };
  } catch (e) { return { lignes: 0, depuis: null, octets: 0 }; }
}

module.exports = { ajoute, ajouteSync, lit, resume, DOSSIER, fichier };
