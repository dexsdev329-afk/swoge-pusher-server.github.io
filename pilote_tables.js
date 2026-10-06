'use strict';
/* ==================================================================
 * CE QUE LE PILOTE APPREND D'UNE TABLE — durable, par URL
 * ==================================================================
 * Demande du propriétaire : il jouera surtout sur la même table (le blackjack
 * 1win) — « qu'il apprenne au fur et à mesure ». À chaque partie, le modèle peut
 * noter ce qu'il a compris de la table (où est le bouton Deal, comment le
 * résultat s'affiche, où est la mise…). On garde ces notes PAR TABLE (clé =
 * hôte + chemin de l'URL, sans la requête) et on les lui rappelle au début des
 * parties suivantes : il repart avec ce qu'il savait, donc plus vite et plus sûr.
 *
 * Rien de sensible : ce ne sont que des repères d'interface, publics. Pur +
 * injectable (fs par le fichier), durable (tmp + fsync + rename), borné.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const MAX_PAR_TABLE = 14;          /* au plus N repères gardés par table */
const TEXTE_MAX = 200;

/** La clé d'une table : hôte + chemin, en minuscules, sans requête ni fragment. */
function cleDe(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const p = (u.hostname + u.pathname).toLowerCase().replace(/\/+$/, '');
  return p ? p.slice(0, 200) : null;
}

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'pilote_tables.json');
  const maintenant = opts.maintenant || (() => Date.now());
  const max = opts.max || MAX_PAR_TABLE;
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { t: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.t !== 'object') throw new Error('pilote_tables illisible');
    E = { t: j.t };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /** Apprend un repère sur une table. Ignore un quasi-doublon (l'un contient
   *  l'autre) pour ne pas remplir la mémoire de redites. */
  function apprend(cle, texte) {
    cle = String(cle || '').toLowerCase();
    texte = String(texte || '').trim().replace(/\s+/g, ' ').slice(0, TEXTE_MAX);
    if (!cle || texte.length < 4) return { ok: false, raison: 'empty' };
    const S = charge();
    const liste = S.t[cle] || [];
    const bas = texte.toLowerCase();
    for (const e of liste) {
      const eb = String(e.texte || '').toLowerCase();
      if (eb === bas || eb.indexOf(bas) >= 0 || bas.indexOf(eb) >= 0) return { ok: true, doublon: true };
    }
    S.t[cle] = [{ texte, quand: maintenant() }].concat(liste).slice(0, max);
    sauve();
    return { ok: true };
  }

  /** Les repères récents d'une table, texte seul, du plus récent au plus ancien. */
  function notes(cle, n) {
    cle = String(cle || '').toLowerCase();
    return (charge().t[cle] || []).slice(0, Math.max(0, n || 10)).map((e) => e.texte);
  }

  function vue() { const S = charge(); const o = {}; for (const k of Object.keys(S.t)) o[k] = S.t[k].length; return o; }

  return { apprend, notes, cleDe, vue, _fichier: fichier };
}

module.exports = { cree, cleDe, MAX_PAR_TABLE };
