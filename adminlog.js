'use strict';
/*
 * LE JOURNAL DES ACTIONS ADMIN.
 *
 * ---- pourquoi il ne vit PAS dans state.json ----
 *
 * C'est la decision qui fait tout le reste. Le journal doit repondre a « qui a
 * touche a quoi » le jour ou un chiffre est faux — et l'un des gestes qu'il
 * enregistre est justement la RESTAURATION, qui remplace state.json en entier.
 * Un journal range dedans serait efface par le geste qu'il est cense prouver.
 *
 * Il vit donc dans son propre fichier, a cote, et rien de ce que fait le
 * panneau ne le reecrit.
 *
 * ---- pourquoi en AJOUT SEUL, et jamais purge ----
 *
 * `game.dons` — le seul journal qui existait — etait purge a la fenetre
 * glissante de l'enveloppe de credit : la ligne qui sortait de la fenetre
 * disparaissait pour toujours. Un journal qui oublie ne prouve rien ; il
 * rassure, ce qui est pire que de ne rien avoir.
 *
 * Une ligne fait environ 200 octets. Mille actions admin par an font 200 Ko.
 * Il n'y a aucune raison d'en effacer une seule.
 *
 * ---- la forme d'une ligne ----
 *
 *   { t, acteur, action, cible, avant, apres, motif, ip }
 *
 * `avant` et `apres` sont ce qui rend le journal utile plutot que decoratif :
 * « credit de 5 000 » ne dit pas si le solde etait juste ; « 1 200 -> 6 200 »
 * le dit. Quand la valeur n'a pas de sens numerique, on y met ce qui permet de
 * refaire le geste a l'envers.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FICHIER = path.join(cfg.DATA_DIR, 'admin.jsonl');

/* Les gestes qui DEPLACENT DE L'ARGENT. Le motif y est obligatoire — voir
   `ajoute`. La liste est ici, en un seul endroit : deux listes finiraient par
   diverger, et celle qui diverge laisse passer le geste qu'on voulait tracer. */
const ARGENT = new Set(['credit', 'repare', 'burn', 'ownerWithdraw', 'pariRegle',
                        'pariRembourse', 'restore', 'import']);

let pret = false;
function prepare() {
  if (pret) return true;
  try { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); pret = true; }
  catch (e) { console.warn('[adminlog] dossier indisponible :', e.message); }
  return pret;
}

/* Une file, comme dans journal.js et pour la meme raison : `fs.appendFile`
   ouvre un descripteur par appel. Ici la cadence est faible, mais un import de
   matchs peut poser vingt lignes d'affilee, et une ligne perdue est une preuve
   perdue. */
let file = [], occupe = false;

function vide() {
  if (occupe || !file.length || !prepare()) return;
  occupe = true;
  const bloc = file.join('');
  file = [];
  fs.appendFile(FICHIER, bloc, (e) => {
    occupe = false;
    if (e) {
      console.warn('[adminlog] ecriture refusee :', e.message);
      /* On REMET devant. Perdre la ligne serait exactement le defaut qu'on
         corrige ; la garder en memoire jusqu'a la prochaine tentative coute
         quelques octets. */
      file.unshift(bloc);
    }
    if (file.length) vide();
  });
}

/**
 * Pose une ligne. Ne jette jamais : une panne d'ecriture ne doit pas empecher
 * un remboursement de joueur.
 *
 * @returns {string|null} le motif retenu, ou null si l'action a ete refusee
 *          faute de motif (voir ARGENT).
 */
function ajoute(evt) {
  const e = evt || {};
  const action = String(e.action || '?');
  const motif = String(e.motif == null ? '' : e.motif).trim().slice(0, 200);
  const l = {
    t: Date.now(),
    acteur: String(e.acteur || 'admin').slice(0, 60),
    action,
    cible: e.cible == null ? null : String(e.cible).slice(0, 120),
    avant: e.avant === undefined ? null : e.avant,
    apres: e.apres === undefined ? null : e.apres,
    motif,
    ip: e.ip ? String(e.ip).slice(0, 45) : null,
  };
  try { file.push(JSON.stringify(l) + '\n'); vide(); }
  catch (err) { console.warn('[adminlog] ligne illisible :', err.message); }
  return motif;
}

/** Le motif est-il obligatoire pour ce geste ? */
function motifRequis(action) { return ARGENT.has(String(action)); }

/**
 * Relit le journal, le plus recent d'abord.
 *
 * Il se lit en ENTIER puis se filtre : a deux cents octets la ligne, cent
 * mille actions font vingt megaoctets, et on n'y arrivera pas. Le jour ou si,
 * c'est une lecture par blocs depuis la fin — pas une purge.
 */
function lit(o) {
  const opt = o || {};
  let brut = '';
  try { brut = fs.readFileSync(FICHIER, 'utf8'); }
  catch (e) { return { total: 0, lignes: [], fichier: FICHIER }; }

  const tout = [];
  for (const ligne of brut.split('\n')) {
    if (!ligne) continue;
    try { tout.push(JSON.parse(ligne)); } catch (e) { /* ligne tronquee : on saute */ }
  }
  tout.reverse();

  let l = tout;
  const q = String(opt.q || '').trim().toLowerCase();
  if (q) {
    l = l.filter((x) => (x.cible || '').toLowerCase().includes(q)
                     || (x.motif || '').toLowerCase().includes(q)
                     || (x.action || '').toLowerCase().includes(q)
                     || (x.acteur || '').toLowerCase().includes(q));
  }
  if (opt.action) l = l.filter((x) => x.action === opt.action);

  const limite = Math.min(500, Math.max(1, parseInt(opt.limite, 10) || 100));
  const debut = Math.max(0, parseInt(opt.debut, 10) || 0);
  return {
    total: l.length,
    totalBrut: tout.length,
    /* Les gestes vus, pour remplir un filtre sans avoir a maintenir une
       liste a la main. */
    actions: [...new Set(tout.map((x) => x.action))].sort(),
    lignes: l.slice(debut, debut + limite),
    fichier: FICHIER,
  };
}

module.exports = { ajoute, lit, motifRequis, FICHIER, ARGENT };
