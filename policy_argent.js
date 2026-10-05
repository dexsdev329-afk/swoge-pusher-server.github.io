'use strict';
/* ==================================================================
 * LE POLICY ENGINE — approuve ou rejette chaque geste d'argent
 * ==================================================================
 *
 * Phase 1, etape 8b (en papier), piece 2/3. Modele AgencyPad : des regles
 * DETERMINISTES decident, contre les propres livres du jeton, si un geste
 * d'argent propose par l'esprit est permis. L'esprit PROPOSE ; la politique
 * DISPOSE. Un geste refuse ne s'execute jamais.
 *
 * Les bornes (en dollars, par jeton) :
 *   - action dans la LISTE BLANCHE (buyback / sell / airdrop / swap) ;
 *   - montant > 0 et <= plafond PAR ACTION ;
 *   - impact-prix estime <= plafond ;
 *   - COOLDOWN : un delai minimal depuis le dernier geste de ce jeton ;
 *   - somme de l'HEURE glissante + montant <= plafond horaire ;
 *   - somme du JOUR glissant + montant <= plafond journalier ;
 *   - montant <= tresor disponible du jeton (on ne depense pas ce qu'on n'a pas).
 *
 * `note()` enregistre un geste APPROUVE (en papier : apres la fausse execution)
 * pour que les fenetres heure/jour et le cooldown le voient. Pur + durable ;
 * aucun mouvement d'argent reel.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const ACTIONS = ['buyback', 'sell', 'airdrop', 'swap'];
const DEFAUTS = {
  maxParActionUsd: 10,     /* un geste ne depasse jamais 10 $ */
  maxParHeureUsd: 25,      /* 25 $ / heure glissante */
  maxParJourUsd: 100,      /* 100 $ / jour glissant */
  impactMaxPct: 2,         /* impact-prix estime <= 2 % */
  cooldownSec: 300,        /* au moins 5 min entre deux gestes */
};
const bas = (a) => String(a).toLowerCase();
const rond = (x) => Math.round(Number(x) * 1e6) / 1e6;

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'policy_argent.json');
  const maintenant = opts.maintenant || (() => Date.now());
  const defauts = Object.assign({}, DEFAUTS, opts.limites || {});
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { gestes: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.gestes !== 'object') throw new Error('policy_argent illisible');
    E = { gestes: j.gestes };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }
  const histo = (token) => (charge().gestes[bas(token)] || []);
  const sommeDepuis = (token, depuisMs, now) => histo(token).filter((g) => g.quand >= now - depuisMs).reduce((s, g) => s + g.montantUsd, 0);

  /** Evalue un geste propose. intent : { token, action, montantUsd, impactPrixPct? }.
   *  ctx : { tresorUsd, limites? }. Rend { autorise, raison?, reste:{heure,jour} }. */
  function evalue(intent, ctx) {
    intent = intent || {}; ctx = ctx || {};
    const lim = Object.assign({}, defauts, ctx.limites || {});
    const now = maintenant();
    const token = intent.token;
    const refus = (raison) => ({ autorise: false, raison });
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(token))) return refus('token must be a 0x address');
    if (!ACTIONS.includes(String(intent.action))) return refus('action must be one of: ' + ACTIONS.join(', '));
    const m = rond(intent.montantUsd);
    if (!(m > 0)) return refus('amount must be positive');
    if (m > lim.maxParActionUsd) return refus('over the per-action cap ($' + lim.maxParActionUsd + ')');
    if (intent.impactPrixPct != null && Number(intent.impactPrixPct) > lim.impactMaxPct) return refus('price impact too high (> ' + lim.impactMaxPct + '%)');
    if (ctx.tresorUsd != null && m > rond(ctx.tresorUsd)) return refus('not enough treasury (have $' + rond(ctx.tresorUsd) + ')');
    const dernier = histo(token)[0];
    if (dernier && (now - dernier.quand) < lim.cooldownSec * 1000) return refus('cooldown: wait ' + Math.ceil((lim.cooldownSec * 1000 - (now - dernier.quand)) / 1000) + 's');
    const heure = sommeDepuis(token, 3600e3, now), jour = sommeDepuis(token, 86400e3, now);
    if (rond(heure + m) > lim.maxParHeureUsd) return refus('over the hourly cap ($' + lim.maxParHeureUsd + '; used $' + rond(heure) + ')');
    if (rond(jour + m) > lim.maxParJourUsd) return refus('over the daily cap ($' + lim.maxParJourUsd + '; used $' + rond(jour) + ')');
    return { autorise: true, reste: { heure: rond(lim.maxParHeureUsd - heure - m), jour: rond(lim.maxParJourUsd - jour - m) } };
  }

  /** Enregistre un geste APPROUVE (apres la fausse execution en papier) : les
   *  fenetres et le cooldown le verront. Rend { ok }. */
  function note(intent) {
    const token = bas(intent.token);
    const S = charge();
    const l = S.gestes[token] || [];
    l.unshift({ action: intent.action, montantUsd: rond(intent.montantUsd), quand: maintenant() });
    S.gestes[token] = l.slice(0, 500);
    sauve();
    return { ok: true };
  }

  function vue(token, now) {
    const t = now || maintenant();
    return { token: bas(token), heureUsd: rond(sommeDepuis(token, 3600e3, t)), jourUsd: rond(sommeDepuis(token, 86400e3, t)),
      dernier: histo(token)[0] || null, limites: defauts };
  }

  return { evalue, note, vue, ACTIONS, limites: defauts };
}

module.exports = { cree, ACTIONS, DEFAUTS };
