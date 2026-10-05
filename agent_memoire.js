'use strict';
/* ==================================================================
 * LA MÉMOIRE D'UN AGENT — continuité + anti-répétition
 * ==================================================================
 *
 * Amélioration de l'agent (05/10/2026, demande du propriétaire). Jusqu'ici
 * l'esprit était SANS mémoire : à chaque pulsation il ne relisait que ses 5
 * derniers posts, donc il pouvait se répéter et ne construisait aucun fil. Ce
 * module donne à chaque jeton une mémoire DURABLE : ce qu'il a dit, ce qu'il a
 * décidé, les événements qu'il a vus — bornée, pour que le prompt reste court.
 *
 * Deux usages :
 *   - `rappel(token)` : un résumé compact du passé récent, glissé dans le prompt
 *     pour que l'agent ait une continuité (il sait ce qu'il a déjà dit/fait).
 *   - `estRedondant(token, texte)` : AVANT de poster, on refuse un texte trop
 *     proche d'un post récent (chevauchement de mots). Mieux vaut ne rien dire
 *     que répéter — la règle de la maison : montrer, ne pas meubler.
 *
 * Fichier durable (tmp, fsync, rename), comme les autres registres. Pur +
 * injectable (maintenant), aucun réseau.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const bas = (a) => String(a).toLowerCase();
const estAdresse = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const MAX_PAR_JETON = 60;              /* on garde les 60 derniers faits de mémoire par jeton */
const SEUIL_REDONDANCE = 0.6;          /* ≥ 60 % de mots en commun avec un post récent = redondant */
const FENETRE_REDONDANCE = 8;          /* on compare aux 8 derniers posts */

/* Un texte -> un ensemble de mots « utiles » : minuscules, sans URL, sans
   ponctuation ni emoji, sans mots-outils trop courts. Pour mesurer, pas pour afficher. */
function motsDe(texte) {
  const sansUrl = String(texte || '').replace(/https?:\/\/\S+/g, ' ');
  const mots = sansUrl.toLowerCase().replace(/[^a-z0-9$% ]+/g, ' ').split(/\s+/).filter((m) => m.length >= 3);
  return new Set(mots);
}
/* Jaccard : |∩| / |∪|. 1 = identique, 0 = rien en commun. */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const m of a) if (b.has(m)) inter++;
  return inter / (a.size + b.size - inter);
}

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'agent_memoire.json');
  const maintenant = opts.maintenant || (() => Date.now());
  const maxParJeton = opts.max || MAX_PAR_JETON;
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { m: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.m !== 'object') throw new Error('agent_memoire illisible');
    E = { m: j.m };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /** Note un fait de mémoire. { quoi:'post'|'buyback'|'event'|..., texte?, meta? } */
  function note(token, e) {
    if (!estAdresse(token)) return { ok: false, raison: 'bad token' };
    e = e || {};
    const S = charge(), k = bas(token);
    const entree = { quoi: String(e.quoi || 'note').slice(0, 24), quand: e.quand || maintenant() };
    if (e.texte != null) entree.texte = String(e.texte).slice(0, 400);
    if (e.meta != null) { try { entree.meta = JSON.parse(JSON.stringify(e.meta)); } catch (x) {} }
    S.m[k] = [entree].concat(S.m[k] || []).slice(0, maxParJeton);
    sauve();
    return { ok: true };
  }

  /** Le passé récent, du plus récent au plus ancien (compact), pour le prompt. */
  function rappel(token, n) {
    return (charge().m[bas(token)] || []).slice(0, Math.max(0, n || 8));
  }
  /** Les textes des derniers POSTS (pour la déduplication et « ne te répète pas »). */
  function textes(token, n) {
    return (charge().m[bas(token)] || []).filter((x) => x.quoi === 'post' && x.texte).map((x) => x.texte).slice(0, Math.max(0, n || FENETRE_REDONDANCE));
  }

  /** Vrai si `texte` est trop proche d'un post récent (chevauchement de mots).
   *  `recentsExtra` : d'autres textes récents à comparer aussi (ex. le mur). */
  function estRedondant(token, texte, o) {
    o = o || {};
    const seuil = o.seuil != null ? o.seuil : SEUIL_REDONDANCE;
    const cible = motsDe(texte);
    if (cible.size < 3) return false;              /* trop court pour juger : on laisse passer */
    const corpus = textes(token, o.fenetre || FENETRE_REDONDANCE).concat(Array.isArray(o.recentsExtra) ? o.recentsExtra : []);
    for (const t of corpus) {
      if (jaccard(cible, motsDe(t)) >= seuil) return true;
    }
    return false;
  }

  function vue(token) { const l = charge().m[bas(token)] || []; return { compte: l.length, dernier: l[0] || null }; }
  function oublie(token) { const S = charge(); if (S.m[bas(token)]) { delete S.m[bas(token)]; sauve(); } return { ok: true }; }

  return { note, rappel, textes, estRedondant, vue, oublie };
}

module.exports = { cree, motsDe, jaccard, SEUIL_REDONDANCE, MAX_PAR_JETON };
