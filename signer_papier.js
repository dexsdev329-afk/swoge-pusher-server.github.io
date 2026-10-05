'use strict';
/* ==================================================================
 * LE SIGNER ISOLE (EN PAPIER) — resimule et ne signe que l'approuve
 * ==================================================================
 *
 * Phase 1, etape 8b (en papier), piece 3/3. Modele AgencyPad : un service
 * ISOLE qui, pour un geste DEJA APPROUVE par la politique, resimule la
 * transaction et ne la signe QUE si la simulation correspond a l'intention
 * approuvee. Ici, EN PAPIER : il ne signe aucune vraie transaction, il ecrit
 * une transaction PAPIER dans son journal. Aucune cle, jamais.
 *
 * Les garde-fous testables :
 *   - il n'agit que sur le POOL DU JETON (passe dans l'intention approuvee) ;
 *     si le devis vise un autre pool, il REFUSE (jamais une adresse d'un message) ;
 *   - il resimule : si l'impact-prix live depasse le plafond approuve, il REFUSE ;
 *   - un devis qui echoue → pas de signature ;
 *   - l'execution REELLE n'existe pas ici : c'est un module separe, derriere son
 *     drapeau, a venir. Tant qu'il n'est pas pose, rien ne depense de crypto.
 *
 * Journal papier durable (tmp, fsync, rename). Pur + injectable.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const bas = (a) => String(a).toLowerCase();
const rond = (x) => Math.round(Number(x) * 1e6) / 1e6;

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'signer_papier.json');
  const maintenant = opts.maintenant || (() => Date.now());
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { tx: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.tx !== 'object') throw new Error('signer_papier illisible');
    E = { tx: j.tx };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /**
   * Signe (en papier) un geste APPROUVE.
   * approuve : { token, action, montantUsd, pool, impactMaxPct }.
   * deps.devis(approuve) -> { ok, pool, impactPct, sortie } : la resimulation live.
   * Rend { signe:true, papier:true, recu } ou { signe:false, raison }.
   */
  async function signe(approuve, deps) {
    approuve = approuve || {}; deps = deps || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(approuve.token))) return { signe: false, raison: 'token must be a 0x address' };
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(approuve.pool))) return { signe: false, raison: 'approved intent has no valid pool' };
    if (typeof deps.devis !== 'function') return { signe: false, raison: 'no quoter to re-simulate with' };
    let d;
    try { d = await deps.devis(approuve); } catch (e) { return { signe: false, raison: 'simulation failed: ' + String((e && e.message) || e).slice(0, 80) }; }
    if (!d || d.ok !== true) return { signe: false, raison: 'simulation did not succeed' };
    /* Ne signer que ce qui CORRESPOND a l'intention approuvee. */
    if (bas(d.pool) !== bas(approuve.pool)) return { signe: false, raison: 'pool mismatch: the quote targets a different pool than approved (refused)' };
    if (approuve.impactMaxPct != null && Number(d.impactPct) > Number(approuve.impactMaxPct) + 1e-9) return { signe: false, raison: 'live price impact exceeds the approved ceiling (refused)' };
    const recu = { id: 'paper_' + crypto.randomBytes(6).toString('hex'), mode: 'paper', token: bas(approuve.token), pool: bas(approuve.pool),
      action: approuve.action, montantUsd: rond(approuve.montantUsd), sortie: d.sortie != null ? rond(d.sortie) : null, impactPct: d.impactPct != null ? rond(d.impactPct) : null, quand: maintenant() };
    const S = charge(), k = recu.token;
    S.tx[k] = [recu].concat(S.tx[k] || []).slice(0, 200);
    sauve();
    return { signe: true, papier: true, recu };
  }

  function journal(token, n) { return (charge().tx[bas(token)] || []).slice(0, Math.max(0, n || 20)); }
  function tout(n) {
    const S = charge(), plat = [];
    for (const k of Object.keys(S.tx)) for (const r of S.tx[k]) plat.push(r);
    plat.sort((a, b) => b.quand - a.quand);
    return plat.slice(0, Math.max(0, n || 50));
  }

  return { signe, journal, tout };
}

module.exports = { cree };
