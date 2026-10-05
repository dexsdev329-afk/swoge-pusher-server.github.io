'use strict';
/* ==================================================================
 * LE CARBURANT D'UN AGENT DE JETON — le grand-livre qui le finance
 * ==================================================================
 *
 * Phase 1, etape 8. Un agent coute : chaque post fait un appel au modele. Ce
 * module tient, PAR JETON, un solde de carburant en DOLLARS :
 *   - CREDITE par le volume (la part de frais du jeton, cablee plus tard sur
 *     collectFees) ou par un versement du proprietaire ;
 *   - DEBITE a chaque pensee, au cout reel (comme studio_chat facture).
 * Quand le solde tombe sous un plancher, l'agent DORT (l'equivalent du
 * « < 0,1 SOL/h » d'AgencyPad) : on ne depense jamais a credit.
 *
 * Un versement de bienvenue (GRANT) est credite UNE FOIS au premier contact,
 * pour qu'un agent neuf puisse poster quelques fois avant d'etre finance.
 *
 * C'est de la COMPTABILITE, pas un mouvement d'argent on-chain : rien ici ne
 * signe ni ne depense de crypto. Le rachat-et-brule et les pouvoirs trader
 * (argent reel) viennent apres, derriere leur propre drapeau d'execution.
 *
 * Fichier `DATA_DIR/agent_fuel.json`, ecrit comme les autres stores (tmp,
 * fsync, rename). Un fichier illisible n'est jamais ecrase.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const GRANT_DEFAUT_USD = 0.10;        /* de quoi poster quelques fois, le temps d'etre finance */
const PLANCHER_DEFAUT_USD = 0;        /* sous le plancher + cout, l'agent dort */
const MOUVEMENTS_MAX = 100;           /* on garde les derniers mouvements, borne */
const bas = (a) => String(a).toLowerCase();
const estAdresse = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const rond = (x) => Math.round(Number(x) * 1e6) / 1e6;   /* au millionieme de dollar, exact */

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'agent_fuel.json');
  const maintenant = opts.maintenant || (() => Date.now());
  const grant = opts.grantInitialUsd != null ? Number(opts.grantInitialUsd) : GRANT_DEFAUT_USD;
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { fuel: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.fuel !== 'object') throw new Error('agent_fuel illisible');
    E = { fuel: j.fuel };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /* Le compte d'un jeton, cree au premier contact avec le versement de bienvenue. */
  function compte(token) {
    const S = charge(), k = bas(token);
    if (!S.fuel[k]) {
      S.fuel[k] = { soldeUsd: 0, crediteUsd: 0, debiteUsd: 0, mouvements: [] };
      if (grant > 0) pose(S.fuel[k], grant, 'credit', 'welcome grant');
      sauve();
    }
    return S.fuel[k];
  }
  function pose(c, usd, sens, note) {
    const m = { sens, usd: rond(sens === 'credit' ? usd : -usd), note: String(note || '').slice(0, 40), quand: maintenant() };
    c.soldeUsd = rond(c.soldeUsd + m.usd);
    if (sens === 'credit') c.crediteUsd = rond(c.crediteUsd + usd); else c.debiteUsd = rond(c.debiteUsd + usd);
    c.mouvements.unshift(m);
    c.mouvements = c.mouvements.slice(0, MOUVEMENTS_MAX);
  }

  /** Crediter le carburant d'un jeton (versement proprietaire, ou part de frais).
   *  source : 'topup' | 'fees' | ... Rend { ok, solde }. */
  function credite(token, usd, source) {
    if (!estAdresse(token)) return { ok: false, raison: 'token must be a 0x address' };
    usd = rond(usd);
    if (!(usd > 0)) return { ok: false, raison: 'amount must be positive' };
    const c = compte(token); pose(c, usd, 'credit', source || 'topup'); sauve();
    return { ok: true, solde: c.soldeUsd };
  }

  /** Debiter (cout d'une pensee deja faite). Ne descend jamais sous 0 : si le
   *  solde est insuffisant, on debite ce qui reste et on le signale (ne doit pas
   *  arriver si on a appele peutPenser avant). Rend { ok, solde, manque? }. */
  function debite(token, usd, raison) {
    if (!estAdresse(token)) return { ok: false, raison: 'token must be a 0x address' };
    usd = rond(usd);
    if (!(usd > 0)) return { ok: false, raison: 'amount must be positive' };
    const c = compte(token);
    const reel = Math.min(usd, c.soldeUsd);
    if (reel > 0) pose(c, reel, 'debit', raison || 'thought');
    sauve();
    return { ok: true, solde: c.soldeUsd, manque: rond(usd - reel) || 0 };
  }

  /** Reste-t-il de quoi penser ? solde >= cout + plancher. */
  function peutPenser(token, coutUsd, plancherUsd) {
    const c = compte(token);
    return c.soldeUsd >= rond(Number(coutUsd || 0) + Number(plancherUsd != null ? plancherUsd : PLANCHER_DEFAUT_USD)) - 1e-9;
  }

  function solde(token) { return compte(token).soldeUsd; }
  function vue(token) {
    const c = compte(token);
    return { token: bas(token), soldeUsd: c.soldeUsd, crediteUsd: c.crediteUsd, debiteUsd: c.debiteUsd, mouvements: c.mouvements.slice(0, 20) };
  }

  return { credite, debite, peutPenser, solde, vue, GRANT: grant };
}

module.exports = { cree, GRANT_DEFAUT_USD, PLANCHER_DEFAUT_USD };
