'use strict';
/* ==================================================================
 * LES ÉVÉNEMENTS D'UN JETON — « poster quand il se passe quelque chose »
 * ==================================================================
 *
 * Amélioration de l'agent (05/10/2026). Avant, l'agent postait sur une MINUTERIE,
 * sans raison. Ici on détecte, à partir d'un instantané de marché RÉEL (DexScreener
 * + GoPlus), s'il se passe quelque chose qui mérite un post — et quoi exactement.
 * L'agent reçoit l'événement comme CONTEXTE : il poste des faits (le vrai chiffre),
 * jamais un chiffre inventé.
 *
 * Pur et déterministe : `detecte(prev, snap)` ne lit aucun réseau — le serveur lui
 * passe l'instantané. Les seuils portent, en commentaire, la raison qui les a fixés
 * (convention de la maison : mesurer, pas deviner). Un petit marché bruite ; on ne
 * déclenche que sur un mouvement net, et une étape (holders) n'est franchie qu'une fois.
 * ================================================================== */

const round = (x, d) => { const p = Math.pow(10, d == null ? 2 : d); return Math.round(Number(x) * p) / p; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

/* Les paliers de détenteurs qu'on fête une fois (franchissement vers le haut). */
const PALIERS_HOLDERS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000];
/* Seuils, avec leur raison :
 *  - PRIX_H1 10 % : en-dessous, sur une paire mince, c'est du bruit d'une poignée de swaps.
 *  - ACHATS_H1 50 + ratio 3:1 : « pression acheteuse » demande ASSEZ d'observations (≥ 50 txns
 *    sur l'heure) ET une nette domination des achats (3 achats pour 1 vente), sinon c'est l'aléa. */
const PRIX_H1 = 10, ACHATS_H1 = 50, RATIO_ACHATS = 3;
/* LA VEILLE SECURITE (05/10) : on alerte le holder sur un CHANGEMENT qui l expose — jamais sur
 * un etat stable (un scan unique ne vaut rien : un proprietaire peut plus tard activer une taxe
 * de vente ou un blocage). On ne declenche que sur une TRANSITION vers le pire, et une seule
 * fois (l instantane precedent porte deja la valeur apres coup). Seuils prudents, a mesurer :
 *  - TAXE_ALERTE 10 % : au-dela, la vente coute cher au holder ; TAXE_HAUSSE 10 points : un saut net.
 *  - LP_CHUTE 40 % : une liquidite qui fond de 40 % d un instantane a l autre = retrait probable. */
const TAXE_ALERTE = 10, TAXE_HAUSSE = 10, LP_CHUTE = 0.40;

/**
 * detecte(prev, snap) : l'événement le plus saillant, ou null.
 * snap : { priceChangeH1, buysH1, sellsH1, holders, liqUsd?, volume24hUsd? } (nombres, réels).
 * prev : l'instantané précédent (pour franchir un palier de holders), ou null.
 * Rend { evenement: { type, detail, force } | null, tous:[...] }.
 */
function detecte(prev, snap) {
  snap = snap || {}; prev = prev || null;
  const evs = [];

  /* ---- LA VEILLE SECURITE, EN PREMIER (elle prime sur tout post de prix) ----
   * Uniquement sur une TRANSITION vers le pire, et seulement si les DEUX instantanes ont une
   * lecture nette (sinon une panne GoPlus ferait une fausse alerte). Force >= 0,9 : un avertissement
   * de rug passe avant une vantardise de prix. Poussee AVANT le prix → gagne les egalites (tri stable). */
  const s = snap.secu || {}, psec = (prev && prev.secu) || {};
  if (psec.honeypot === 0 && s.honeypot === 1) {
    evs.push({ type: 'security_alert', detail: { quoi: 'honeypot' }, force: 1 });
  }
  const pex = (prev && prev.secu) ? psec.canExit : undefined, ex = s.canExit;
  if (pex === true && ex === false) {
    evs.push({ type: 'security_alert', detail: { quoi: 'exit_closed' }, force: 1 });
  }
  const pt = num(psec.sellTaxPct), st = num(s.sellTaxPct);
  if (pt != null && st != null && st - pt >= TAXE_HAUSSE && st >= TAXE_ALERTE) {
    evs.push({ type: 'security_alert', detail: { quoi: 'sell_tax', de: round(pt), a: round(st) }, force: 0.97 });
  }
  const pl = num(prev && prev.liqUsd), l = num(snap.liqUsd);
  if (pl != null && l != null && pl > 0 && l <= pl * (1 - LP_CHUTE)) {
    evs.push({ type: 'security_alert', detail: { quoi: 'liquidity', chutePct: round((1 - l / pl) * 100) }, force: 0.95 });
  }

  const h1 = num(snap.priceChangeH1);
  if (h1 != null) {
    if (h1 >= PRIX_H1) evs.push({ type: 'price_up', detail: { h1pct: round(h1) }, force: clamp01(h1 / 40) });
    else if (h1 <= -PRIX_H1) evs.push({ type: 'price_down', detail: { h1pct: round(h1) }, force: clamp01(-h1 / 40) });
  }

  const buys = num(snap.buysH1), sells = num(snap.sellsH1);
  if (buys != null && buys >= ACHATS_H1 && buys >= RATIO_ACHATS * (sells || 0)) {
    evs.push({ type: 'buy_pressure', detail: { buysH1: buys, sellsH1: sells || 0 }, force: clamp01(buys / 300) });
  }

  const h = num(snap.holders), ph = prev ? num(prev.holders) : null;
  if (h != null && ph != null && h > ph) {
    const palier = PALIERS_HOLDERS.find((p) => ph < p && h >= p);
    if (palier) evs.push({ type: 'holders_milestone', detail: { holders: h, palier }, force: 0.7 });
  }

  evs.sort((a, b) => b.force - a.force);
  return { evenement: evs[0] || null, tous: evs };
}

/* Une phrase courte, factuelle, pour glisser dans le prompt (l'agent reformule dans sa persona). */
function phrase(ev) {
  if (!ev) return null;
  if (ev.type === 'price_up') return 'price is up ' + ev.detail.h1pct + '% in the last hour';
  if (ev.type === 'price_down') return 'price is down ' + Math.abs(ev.detail.h1pct) + '% in the last hour';
  if (ev.type === 'buy_pressure') return ev.detail.buysH1 + ' buys vs ' + ev.detail.sellsH1 + ' sells in the last hour';
  if (ev.type === 'holders_milestone') return 'holders just crossed ' + ev.detail.palier + ' (now ' + ev.detail.holders + ')';
  if (ev.type === 'security_alert') {
    const q = ev.detail.quoi;
    if (q === 'honeypot') return 'SECURITY ALERT: selling is now blocked on this token (honeypot) — warn holders, do not buy';
    if (q === 'exit_closed') return 'SECURITY ALERT: a sell no longer goes through (exit just closed) — warn holders';
    if (q === 'sell_tax') return 'SECURITY ALERT: the sell tax just jumped to ' + ev.detail.a + '% (was ' + ev.detail.de + '%) — warn holders';
    if (q === 'liquidity') return 'SECURITY ALERT: liquidity just dropped ' + ev.detail.chutePct + '% — warn holders, this can be a rug';
    return 'SECURITY ALERT: a safety flag on this token just changed for the worse — warn holders';
  }
  return null;
}

module.exports = { detecte, phrase, PALIERS_HOLDERS, PRIX_H1, ACHATS_H1, RATIO_ACHATS, TAXE_ALERTE, TAXE_HAUSSE, LP_CHUTE };
