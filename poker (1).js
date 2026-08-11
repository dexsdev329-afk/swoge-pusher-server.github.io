'use strict';
/*
 * SWOGE Poker — moteur de table (Texas Hold'em, 6 places max).
 *
 * Ce module est volontairement SANS dépendance au réseau : il ne connaît ni
 * WebSocket ni joueurs connectés. Il expose une table déterministe qu'on peut
 * piloter et tester entièrement hors ligne, ce qui est indispensable ici :
 * une erreur d'évaluation de main paie le mauvais joueur en argent réel.
 *
 * Cartes : entier 0..51, rang = c % 13 (0=2 … 12=As), couleur = (c / 13) | 0.
 */

const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'hdcs';
const cardStr = (c) => RANKS[c % 13] + SUITS[(c / 13) | 0];
const parseCard = (s) => RANKS.indexOf(s[0]) + 13 * SUITS.indexOf(s[1]);

// ---------------------------------------------------------------- évaluation

const CAT = { HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5,
              FULL: 6, QUADS: 7, STRAIGHT_FLUSH: 8 };
const CAT_NAME = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
                  'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

/** Meilleure suite dans un ensemble de rangs. Renvoie le rang haut, ou -1.
 *  L'As compte aussi comme 1 (roue A-2-3-4-5, rang haut = 3 pour le 5). */
function straightHigh(rankSet) {
  const has = (r) => rankSet.has(r);
  for (let hi = 12; hi >= 3; hi--) {
    if (has(hi) && has(hi - 1) && has(hi - 2) && has(hi - 3) && has(hi - 4)) return hi;
  }
  // roue : A,2,3,4,5 -> rangs 12,0,1,2,3
  if (has(12) && has(0) && has(1) && has(2) && has(3)) return 3;
  return -1;
}

/**
 * Évalue les 5 meilleures cartes parmi 5 à 7. Renvoie un score entier
 * comparable : catégorie d'abord, puis les rangs départageurs.
 */
function evaluate(cards) {
  const bySuit = [[], [], [], []];
  const countByRank = new Array(13).fill(0);
  for (const c of cards) {
    bySuit[(c / 13) | 0].push(c % 13);
    countByRank[c % 13]++;
  }

  // couleur / quinte flush
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (bySuit[s].length >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const set = new Set(bySuit[flushSuit]);
    const sf = straightHigh(set);
    if (sf >= 0) return score(CAT.STRAIGHT_FLUSH, [sf]);
    const top = bySuit[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
    return score(CAT.FLUSH, top);
  }

  // groupes par nombre d'occurrences, puis par rang décroissant
  const groups = [];
  for (let r = 12; r >= 0; r--) if (countByRank[r]) groups.push([countByRank[r], r]);
  groups.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));

  const st = straightHigh(new Set(cards.map((c) => c % 13)));
  const [n0, r0] = groups[0];
  const n1 = groups[1] ? groups[1][0] : 0;
  const r1 = groups[1] ? groups[1][1] : 0;

  if (n0 === 4) return score(CAT.QUADS, [r0, kickers(groups, [r0], 1)[0]]);
  if (n0 === 3 && n1 >= 2) return score(CAT.FULL, [r0, r1]);
  if (st >= 0) return score(CAT.STRAIGHT, [st]);
  if (n0 === 3) return score(CAT.TRIPS, [r0, ...kickers(groups, [r0], 2)]);
  if (n0 === 2 && n1 === 2) {
    // Avec trois paires, seules les deux plus hautes comptent — et le kicker est
    // la plus haute carte restante, qui peut appartenir a la troisieme paire.
    const pairRanks = groups.filter((g) => g[0] >= 2).map((g) => g[1]).sort((a, b) => b - a);
    const pairHi = pairRanks[0], pairLo = pairRanks[1];
    return score(CAT.TWO_PAIR, [pairHi, pairLo, kickers(groups, [pairHi, pairLo], 1)[0]]);
  }
  if (n0 === 2) return score(CAT.PAIR, [r0, ...kickers(groups, [r0], 3)]);
  return score(CAT.HIGH, kickers(groups, [], 5));
}

/**
 * Rangs restants, hors `exclude`, du plus haut au plus bas, limités à `n`.
 * On trie par RANG et non par taille de groupe : la plus haute carte restante
 * peut appartenir a une paire (trois paires, ou carre accompagne d'une paire
 * plus basse qu'une carte isolee). Trier par groupe donnait un mauvais kicker.
 */
function kickers(groups, exclude, n) {
  const out = groups
    .map((g) => g[1])
    .filter((r) => !exclude.includes(r))
    .sort((a, b) => b - a)
    .slice(0, n);
  while (out.length < n) out.push(0);
  return out;
}

/** Encode catégorie + départageurs en un seul entier comparable. */
function score(cat, ranks) {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (ranks[i] == null ? 0 : ranks[i] + 1);
  return v;
}

function handName(sc) {
  let v = sc;
  for (let i = 0; i < 5; i++) v = Math.floor(v / 15);
  return CAT_NAME[v] || '?';
}

// ------------------------------------------------------------------ mélange

/** Mélange Fisher-Yates déterministe à partir d'une graine (équité prouvable). */
function shuffledDeck(serverSeed, tableId, handNo) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  let stream = Buffer.alloc(0);
  let counter = 0;
  const nextByte = () => {
    if (!stream.length) {
      stream = crypto.createHmac('sha256', serverSeed)
        .update(`${tableId}:${handNo}:${counter++}`).digest();
    }
    const b = stream[0];
    stream = stream.slice(1);
    return b;
  };
  // tirage sans biais par rejet
  for (let i = deck.length - 1; i > 0; i--) {
    const bound = i + 1;
    const limit = 256 - (256 % bound);
    let x;
    do { x = nextByte(); } while (x >= limit);
    const j = x % bound;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// -------------------------------------------------------------- pots annexes

/**
 * Répartit la mise totale en pots (principal + annexes) à partir de ce que
 * chaque joueur a engagé sur toute la main. Un joueur à tapis ne peut gagner
 * que la part à laquelle il a contribué.
 * @param contrib  { seatIndex: montant engagé }
 * @param eligible seatIndex[] encore en lice au showdown (non couchés)
 */
function buildPots(contrib, eligible) {
  const levels = [...new Set(Object.values(contrib).filter((v) => v > 0))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    let amount = 0;
    const seats = [];
    for (const [seat, c] of Object.entries(contrib)) {
      if (c > prev) amount += Math.min(c, lvl) - prev;
      if (c >= lvl && eligible.includes(Number(seat))) seats.push(Number(seat));
    }
    if (amount > 0) pots.push({ amount, eligible: seats });
    prev = lvl;
  }
  // fusionne les pots consécutifs ayant les mêmes ayants droit
  const merged = [];
  for (const p of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.length === p.eligible.length &&
        last.eligible.every((s) => p.eligible.includes(s))) last.amount += p.amount;
    else merged.push(p);
  }
  return merged;
}

module.exports = {
  RANKS, SUITS, cardStr, parseCard,
  evaluate, handName, score, CAT, CAT_NAME,
  shuffledDeck, buildPots, straightHigh,
};
