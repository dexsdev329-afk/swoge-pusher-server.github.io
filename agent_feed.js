'use strict';
/* ==================================================================
 * LE MUR D'UN AGENT DE JETON — le journal durable de ses posts
 * ==================================================================
 *
 * Phase 1, etape 7. L'ordonnanceur (agent_horloge) fait composer un post a
 * chaque agent du a sa cadence. Ce post est TOUJOURS ecrit ici, sur le mur de
 * son jeton — qu'il soit aussi parti sur X (compte du jeton, opt-in) ou non.
 * Le mur est la source de verite montrable : la page du jeton le lit, et il
 * reste meme sans compte X relie (le repli honnete, jamais le compte maison).
 *
 * Fichier `DATA_DIR/agent_feed.json`, ecrit comme les autres stores : tmp,
 * fsync, rename. Un fichier illisible n'est jamais ecrase. Cap par jeton.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PAR_JETON = 60;
const bas = (a) => String(a).toLowerCase();

function cree(opts) {
  const fichier = (opts && opts.fichier) || path.join(require('./config').DATA_DIR, 'agent_feed.json');
  const maintenant = (opts && opts.maintenant) || (() => Date.now());
  const max = (opts && opts.max) || MAX_PAR_JETON;
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { mur: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.mur !== 'object') throw new Error('agent_feed illisible');
    E = { mur: j.mur };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /** Ajoute un post au mur d'un jeton. o : { texte, via, surX, url?, faits? }.
   *  Rend l'entree ecrite (avec id et quand), ou null si texte vide. */
  function ajoute(token, o) {
    o = o || {};
    const texte = String(o.texte || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(token)) || !texte) return null;
    const S = charge();
    const k = bas(token);
    const e = { id: crypto.randomBytes(6).toString('hex'), quand: maintenant(), texte,
      via: o.via || 'modele', surX: !!o.surX, url: o.url || null, faits: Array.isArray(o.faits) ? o.faits.slice(0, 8) : [] };
    const liste = S.mur[k] || [];
    liste.unshift(e);                       /* le plus recent en tete */
    S.mur[k] = liste.slice(0, max);         /* on borne le mur */
    sauve();
    return e;
  }

  /** Les derniers posts d'un jeton, du plus recent au plus ancien. */
  function recent(token, n) {
    const liste = charge().mur[bas(token)] || [];
    return liste.slice(0, Math.max(0, n || 20));
  }

  /** Le mur global : les posts recents tous jetons confondus, du plus recent. */
  function tout(n) {
    const S = charge(), plat = [];
    for (const k of Object.keys(S.mur)) for (const e of S.mur[k]) plat.push(Object.assign({ token: k }, e));
    plat.sort((a, b) => b.quand - a.quand);
    return plat.slice(0, Math.max(0, n || 50));
  }

  function compte(token) { return token ? (charge().mur[bas(token)] || []).length : Object.keys(charge().mur).length; }

  return { ajoute, recent, tout, compte };
}

module.exports = { cree, MAX_PAR_JETON };
