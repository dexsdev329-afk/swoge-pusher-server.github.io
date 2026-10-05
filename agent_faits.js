'use strict';
/* ==================================================================
 * LES FAITS LIVE D'UN JETON — ce que l'agent a le DROIT de citer
 * ==================================================================
 *
 * Phase 1 d'AgencyPad-sur-Robinhood, étape 3. L'agent d'un jeton (agent_jeton)
 * compose un post (agent_poste) à partir de FAITS. Ce module fabrique ces
 * faits — des phrases courtes en anglais — à partir des sources qu'on opère
 * déjà (marché, GoPlus chaîne 4663, can_i_sell). La règle du dépôt tient ici
 * aussi : une carte qui montre un chiffre doit dire d'où il vient, et on
 * n'invente JAMAIS un chiffre absent de la source.
 *
 * Deux moitiés, pour que les essais ne sortent pas de la machine :
 *   - `composeFaits(sources)` : PUR. Un objet de valeurs normalisées → la liste
 *     de faits. Aucune valeur manquante n'est devinée : pas de source, pas de fait.
 *   - `recolte(token, deps)` : IO. Appelle des adaptateurs injectables
 *     (deps.marche, deps.goplus, deps.cansell), chacun protégé : une source qui
 *     tombe n'efface pas les autres. Rend { faits, sources }.
 * ================================================================== */

const MAX_FAITS = 8;

/* $12.3K / $1.2M / $0.0000123 — compact, lisible, jamais trompeur. */
function usd(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n >= 1) return '$' + n.toFixed(2).replace(/\.00$/, '');
  if (n === 0) return '$0';
  /* petits prix : garder les premiers chiffres significatifs */
  const s = n.toPrecision(3);
  return '$' + (s.includes('e') ? n.toFixed(12).replace(/0+$/, '') : s);
}

/** Objet de valeurs normalisées → liste de faits (anglais, courts). PUR. */
function composeFaits(sources) {
  const s = sources || {};
  const out = [];
  const pousse = (f) => { if (f && !out.includes(f)) out.push(f); };

  /* --- marché --- */
  if (s.priceUsd != null && Number(s.priceUsd) > 0) pousse('price ' + usd(s.priceUsd));
  if (s.liqUsd != null && usd(s.liqUsd)) pousse('liquidity ' + usd(s.liqUsd));
  if (s.vol24Usd != null && usd(s.vol24Usd)) pousse('24h volume ' + usd(s.vol24Usd));
  if (s.mcapUsd != null && usd(s.mcapUsd)) pousse('market cap ' + usd(s.mcapUsd));
  if (Number.isFinite(s.ageDays) && s.ageDays >= 0) pousse(s.ageDays === 0 ? 'launched today' : 'launched ' + s.ageDays + (s.ageDays === 1 ? ' day ago' : ' days ago'));
  if (Number.isFinite(s.holders) && s.holders >= 0) pousse(s.holders + (s.holders === 1 ? ' holder' : ' holders'));

  /* --- sécurité (GoPlus, chaîne 4663) : seulement ce qui est VÉRIFIÉ vert --- */
  if (s.honeypot === false) pousse('not a honeypot (GoPlus)');
  if (s.taxConnue === true && Number(s.buyTax) === 0 && Number(s.sellTax) === 0) pousse('0% buy/sell tax');
  if (s.renonce === true) pousse('ownership renounced');
  if (s.mintable === false) pousse('not mintable');
  if (s.lpVerrouille === true) pousse('LP locked forever');

  /* --- can_i_sell : la revente simulée --- */
  if (Number.isFinite(s.allerRetourPct) && s.allerRetourPct > 0 && s.allerRetourPct <= 100) pousse('sells back at ~' + Math.round(s.allerRetourPct) + '% round-trip');

  return out.slice(0, MAX_FAITS);
}

/* --- normalisateurs : la forme brute d'une source → nos clés --- */

/** La réponse GoPlus (un token sur une chaîne) → clés normalisées. Tri-état :
 *  une valeur absente reste absente (jamais supposée). */
function deGoPlus(t) {
  if (!t || typeof t !== 'object') return {};
  const n = {};
  if (t.is_honeypot === '0') n.honeypot = false; else if (t.is_honeypot === '1') n.honeypot = true;
  if (t.is_mintable === '0') n.mintable = false; else if (t.is_mintable === '1') n.mintable = true;
  const o = String(t.owner_address || '');
  if (/^0x0{40}$/.test(o.replace(/^0x/, '0x')) || o === '0x0000000000000000000000000000000000000000') n.renonce = true;
  const bt = Array.isArray(t.buy_tax) ? (t.buy_tax.length ? t.buy_tax : null) : (t.buy_tax === '' ? null : t.buy_tax);
  const st = Array.isArray(t.sell_tax) ? (t.sell_tax.length ? t.sell_tax : null) : (t.sell_tax === '' ? null : t.sell_tax);
  if (bt != null && st != null) { n.taxConnue = true; n.buyTax = Number(bt); n.sellTax = Number(st); }
  if (Number.isFinite(Number(t.holder_count))) n.holders = Number(t.holder_count);
  return n;
}

/** Une paire DexScreener → clés de marché. */
function deMarche(p, maintenant) {
  if (!p || typeof p !== 'object') return {};
  const n = {};
  if (p.priceUsd != null) n.priceUsd = Number(p.priceUsd);
  if (p.liquidity && p.liquidity.usd != null) n.liqUsd = Number(p.liquidity.usd);
  if (p.volume && p.volume.h24 != null) n.vol24Usd = Number(p.volume.h24);
  if (p.marketCap != null) n.mcapUsd = Number(p.marketCap); else if (p.fdv != null) n.mcapUsd = Number(p.fdv);
  if (p.pairCreatedAt) n.ageDays = Math.max(0, Math.floor(((maintenant || Date.now()) - Number(p.pairCreatedAt)) / 86400000));
  return n;
}

/**
 * Récolte les faits d'un jeton via des adaptateurs injectables.
 * deps : { marche(token)→pair, goplus(token)→résultatBrut, cansell(token)→{allerRetourPct,lpVerrouille}, maintenant }
 * Chaque source est protégée : une qui tombe n'efface pas les autres.
 */
async function recolte(token, deps) {
  deps = deps || {};
  const now = deps.maintenant ? deps.maintenant() : Date.now();
  let sources = {};
  async function tente(fn, norm) {
    if (typeof fn !== 'function') return;
    try { const brut = await fn(token); if (brut) Object.assign(sources, norm(brut)); }
    catch (e) { /* une source muette ne fait pas rater la récolte */ }
  }
  await tente(deps.marche, (p) => deMarche(p, now));
  await tente(deps.goplus, deGoPlus);
  await tente(deps.cansell, (c) => {
    const n = {};
    if (Number.isFinite(c.allerRetourPct)) n.allerRetourPct = c.allerRetourPct;
    if (c.lpVerrouille === true) n.lpVerrouille = true;
    return n;
  });
  return { faits: composeFaits(sources), sources };
}

module.exports = { composeFaits, recolte, deGoPlus, deMarche, usd, MAX_FAITS };
