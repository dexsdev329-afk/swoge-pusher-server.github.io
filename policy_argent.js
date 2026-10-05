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
/* Les bornes dependent de la TRESORERIE du jeton (part du tresor), comme AgencyPad :
   un gros tresor permet de plus gros gestes. Un plafond ABSOLU en dollars reste
   en garde-fou pour la phase prudente (meme avec un gros tresor, on ne depasse pas).
   Le plafond effectif d'un cran = min(part% du tresor, plafond absolu). */
const DEFAUTS = {
  partParActionPct: 5,     /* un geste <= 5 % du tresor du jeton */
  partParHeurePct: 10,     /* <= 10 % du tresor / heure glissante */
  partParJourPct: 25,      /* <= 25 % du tresor / jour glissant */
  maxParActionUsd: 10,     /* garde-fou absolu : jamais plus de 10 $ par action (phase prudente) */
  maxParHeureUsd: 25,
  maxParJourUsd: 100,
  impactMaxPct: 1,         /* impact-prix estime <= 1 % (phase prudente) */
  cooldownSec: 3600,       /* au moins 1 h entre deux gestes (phase prudente) */
};
/* Le plafond effectif : le plus petit entre la part du tresor et le plafond absolu. */
function plafond(pct, abs, tresorUsd) {
  const parPart = (pct != null && tresorUsd != null) ? pct / 100 * tresorUsd : Infinity;
  const parAbs = abs != null ? abs : Infinity;
  const v = Math.min(parPart, parAbs);
  return Number.isFinite(v) ? v : 0;   /* ni part ni absolu defini → 0 (rien permis, fail-closed) */
}
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
    /* Les plafonds effectifs dependent du TRESOR du jeton (part %), bornes par les absolus. */
    const tresor = ctx.tresorUsd != null ? rond(ctx.tresorUsd) : null;
    const capAction = rond(plafond(lim.partParActionPct, lim.maxParActionUsd, tresor));
    const capHeure = rond(plafond(lim.partParHeurePct, lim.maxParHeureUsd, tresor));
    const capJour = rond(plafond(lim.partParJourPct, lim.maxParJourUsd, tresor));
    if (m > capAction) return refus('over the per-action cap ($' + capAction + ' = min of ' + (lim.partParActionPct || 0) + '% of treasury and the absolute cap)');
    if (intent.impactPrixPct != null && Number(intent.impactPrixPct) > lim.impactMaxPct) return refus('price impact too high (> ' + lim.impactMaxPct + '%)');
    if (tresor != null && m > tresor) return refus('not enough treasury (have $' + tresor + ')');
    const dernier = histo(token)[0];
    if (dernier && (now - dernier.quand) < lim.cooldownSec * 1000) return refus('cooldown: wait ' + Math.ceil((lim.cooldownSec * 1000 - (now - dernier.quand)) / 1000) + 's');
    const heure = sommeDepuis(token, 3600e3, now), jour = sommeDepuis(token, 86400e3, now);
    if (rond(heure + m) > capHeure) return refus('over the hourly cap ($' + capHeure + '; used $' + rond(heure) + ')');
    if (rond(jour + m) > capJour) return refus('over the daily cap ($' + capJour + '; used $' + rond(jour) + ')');
    return { autorise: true, capAction, reste: { heure: rond(capHeure - heure - m), jour: rond(capJour - jour - m) } };
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
