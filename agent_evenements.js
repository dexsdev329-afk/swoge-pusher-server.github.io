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

/**
 * detecte(prev, snap) : l'événement le plus saillant, ou null.
 * snap : { priceChangeH1, buysH1, sellsH1, holders, liqUsd?, volume24hUsd? } (nombres, réels).
 * prev : l'instantané précédent (pour franchir un palier de holders), ou null.
 * Rend { evenement: { type, detail, force } | null, tous:[...] }.
 */
function detecte(prev, snap) {
  snap = snap || {}; prev = prev || null;
  const evs = [];

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
  return null;
}

module.exports = { detecte, phrase, PALIERS_HOLDERS, PRIX_H1, ACHATS_H1, RATIO_ACHATS };
