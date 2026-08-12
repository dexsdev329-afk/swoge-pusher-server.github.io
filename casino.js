'use strict';
/*
 * SWOGE Casino — les deux jeux contre la banque.
 *
 *   • Casino Hold'em : 2 cartes chacun, 5 cartes communes, on bat le croupier.
 *   • Three Card     : 3 cartes chacun, rapide.
 *
 * Difference de fond avec le poker : ici la MAISON joue son propre argent. Au
 * poker on prend une commission sans risque ; ici chaque main peut couter cher.
 * Tout ce qui touche aux gains est donc isole dans ce module, sans reseau, pour
 * pouvoir simuler des centaines de milliers de mains et verifier que le taux de
 * retour tombe bien ou il doit avant qu'un seul jeton reel ne bouge.
 *
 * Cartes : entier 0..51, rang = c % 13 (0=2 … 12=As), couleur = (c / 13) | 0.
 * Meme convention que poker.js, dont on reutilise l'evaluateur 5-parmi-7.
 */

const crypto = require('crypto');
const P = require('./poker');

// ------------------------------------------------------------------ melange

/** Sabot melange de facon deterministe a partir d'une graine (equite prouvable). */
function shoe(serverSeed, clientSeed, nonce) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  let stream = Buffer.alloc(0);
  let counter = 0;
  const nextByte = () => {
    if (!stream.length) {
      stream = crypto.createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${counter++}`).digest();
    }
    const b = stream[0];
    stream = stream.slice(1);
    return b;
  };
  for (let i = deck.length - 1; i > 0; i--) {
    const bound = i + 1;
    const limit = 256 - (256 % bound);   // tirage sans biais par rejet
    let x;
    do { x = nextByte(); } while (x >= limit);
    const j = x % bound;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// -------------------------------------------------- evaluation a trois cartes

const T3 = { HIGH: 0, PAIR: 1, FLUSH: 2, STRAIGHT: 3, TRIPS: 4, STRAIGHT_FLUSH: 5 };
const T3_NAME = ['High card', 'Pair', 'Flush', 'Straight', 'Three of a kind', 'Straight flush'];

/**
 * Evalue une main de TROIS cartes. Attention, l'ordre n'est pas celui du poker
 * a cinq cartes : avec trois cartes il y a 1096 couleurs pour seulement 720
 * quintes, donc la QUINTE BAT LA COULEUR. Inverser les deux est l'erreur
 * classique, et elle paie le mauvais joueur.
 */
function eval3(cards) {
  const rangs = cards.map((c) => c % 13).sort((a, b) => b - a);
  const couleurs = cards.map((c) => (c / 13) | 0);
  const couleur = couleurs[0] === couleurs[1] && couleurs[1] === couleurs[2];

  const [a, b, c] = rangs;
  const brelan = a === b && b === c;
  // l'As compte aussi comme 1 : A-2-3 est une quinte, rang haut = le 3
  const roue = a === 12 && b === 1 && c === 0;
  const suite = roue || (a === b + 1 && b === c + 1);
  const hautSuite = roue ? 1 : a;

  let cat, depart;
  if (brelan && couleur) { cat = T3.STRAIGHT_FLUSH; depart = [a, a, a]; }   // impossible, garde-fou
  else if (brelan) { cat = T3.TRIPS; depart = [a, a, a]; }
  else if (suite && couleur) { cat = T3.STRAIGHT_FLUSH; depart = [hautSuite, 0, 0]; }
  else if (suite) { cat = T3.STRAIGHT; depart = [hautSuite, 0, 0]; }
  else if (couleur) { cat = T3.FLUSH; depart = [a, b, c]; }
  else if (a === b) { cat = T3.PAIR; depart = [a, a, c]; }
  else if (b === c) { cat = T3.PAIR; depart = [b, b, a]; }
  else { cat = T3.HIGH; depart = [a, b, c]; }

  let v = cat;
  for (let i = 0; i < 3; i++) v = v * 15 + (depart[i] + 1);
  return v;
}

function name3(score) {
  let v = score;
  for (let i = 0; i < 3; i++) v = Math.floor(v / 15);
  return T3_NAME[v] || '?';
}
function cat3(score) {
  let v = score;
  for (let i = 0; i < 3; i++) v = Math.floor(v / 15);
  return v;
}

// ----------------------------------------------------------- tables de gains

/* Ces tables fixent l'avantage de la maison. Elles sont exportees pour que le
   client affiche exactement ce que le serveur paie — jamais deux listes. */

const PAY = {
  // --- Three Card ---
  // Pair Plus : paye la main du joueur seule, quoi que fasse le croupier.
  pairPlus: [
    { cat: T3.STRAIGHT_FLUSH, x: 40, label: 'Straight flush' },
    { cat: T3.TRIPS, x: 30, label: 'Three of a kind' },
    { cat: T3.STRAIGHT, x: 6, label: 'Straight' },
    { cat: T3.FLUSH, x: 4, label: 'Flush' },
    { cat: T3.PAIR, x: 1, label: 'Pair' },
  ],
  // Bonus d'Ante : paye meme si le croupier ne se qualifie pas, et meme perdant.
  anteBonus: [
    { cat: T3.STRAIGHT_FLUSH, x: 5, label: 'Straight flush' },
    { cat: T3.TRIPS, x: 4, label: 'Three of a kind' },
    { cat: T3.STRAIGHT, x: 1, label: 'Straight' },
  ],

  // --- Casino Hold'em ---
  // L'Ante paie selon la MEILLEURE main du joueur (5 parmi 7).
  holdemAnte: [
    { cat: P.CAT.STRAIGHT_FLUSH, royale: true, x: 100, label: 'Royal flush' },
    { cat: P.CAT.STRAIGHT_FLUSH, x: 20, label: 'Straight flush' },
    { cat: P.CAT.QUADS, x: 10, label: 'Four of a kind' },
    { cat: P.CAT.FULL, x: 3, label: 'Full house' },
    { cat: P.CAT.FLUSH, x: 2, label: 'Flush' },
  ],
  // Bonus AA : les 2 cartes du joueur + le flop, paye a partir d'une paire d'As.
  aaBonus: [
    { cat: P.CAT.STRAIGHT_FLUSH, royale: true, x: 100, label: 'Royal flush' },
    { cat: P.CAT.STRAIGHT_FLUSH, x: 50, label: 'Straight flush' },
    { cat: P.CAT.QUADS, x: 40, label: 'Four of a kind' },
    { cat: P.CAT.FULL, x: 30, label: 'Full house' },
    { cat: P.CAT.FLUSH, x: 20, label: 'Flush' },
    { cat: P.CAT.STRAIGHT, x: 10, label: 'Straight' },
    { cat: P.CAT.TRIPS, x: 8, label: 'Three of a kind' },
    { cat: P.CAT.TWO_PAIR, x: 7, label: 'Two pair' },
    { cat: 'AA', x: 7, label: 'Pair of aces or better' },
  ],
};

/** Categorie d'un score poker (5 parmi 7). */
function catP(score) {
  let v = score;
  for (let i = 0; i < 5; i++) v = Math.floor(v / 15);
  return v;
}
/** Une quinte flush a l'As est une quinte flush royale. */
function estRoyale(score) {
  if (catP(score) !== P.CAT.STRAIGHT_FLUSH) return false;
  let v = score;
  for (let i = 0; i < 4; i++) v = Math.floor(v / 15);
  return (v % 15) - 1 === 12;         // rang haut = As
}

function multiplicateur(table, score, royale) {
  for (const l of table) {
    if (l.cat === 'AA') continue;
    if (l.cat === catP(score) && (!l.royale || royale)) return l;
  }
  return null;
}

// ------------------------------------------------------------- Three Card

// Le croupier se qualifie avec Dame-haut ou mieux. Le seuil est donc la plus
// FAIBLE main a la Dame, Dame-3-2 : rangs 10, 1 et 0. S'etre trompe de rangs
// ici faisait echouer la qualification presque tout le temps, le joueur
// encaissait son Ante a chaque main et la maison rendait plus de 100 %.
const T3_QUALIF = eval3([10, 1 + 13, 0 + 26]);

/**
 * Une main complete de Three Card. Le joueur mise l'Ante et, optionnellement,
 * le Pair Plus ; `play` dit s'il suit (mise egale a l'Ante) ou se couche.
 *
 * @returns {{cards, dealer, playerScore, dealerScore, qualified, outcome,
 *            payout, detail}}  `payout` = ce qui revient au joueur, mises
 *            comprises. Perdre tout renvoie 0.
 */
function threeCard({ serverSeed, clientSeed, nonce, ante, pairPlus = 0, play }) {
  const d = shoe(serverSeed, clientSeed, nonce);
  const cards = [d[0], d[1], d[2]];
  const dealer = [d[3], d[4], d[5]];
  const ps = eval3(cards), ds = eval3(dealer);
  const detail = [];
  let payout = 0;

  // Le Pair Plus se paie sur la seule main du joueur, meme s'il se couche.
  if (pairPlus > 0) {
    const l = PAY.pairPlus.find((x) => x.cat === cat3(ps));
    if (l) { payout += pairPlus * (l.x + 1); detail.push({ bet: 'pairPlus', x: l.x, label: l.label }); }
    else detail.push({ bet: 'pairPlus', x: -1, label: 'No pair' });
  }

  if (!play) {
    return { cards, dealer, playerScore: ps, dealerScore: ds, qualified: null,
             outcome: 'fold', payout, detail };
  }

  // Le bonus d'Ante tombe quoi qu'il arrive ensuite : il recompense la main,
  // pas le resultat du duel.
  const bonus = PAY.anteBonus.find((x) => x.cat === cat3(ps));
  if (bonus) { payout += ante * bonus.x; detail.push({ bet: 'anteBonus', x: bonus.x, label: bonus.label }); }

  const qualified = ds >= T3_QUALIF;
  let outcome;
  if (!qualified) {
    // Ante paye 1:1, la mise Play est simplement rendue.
    outcome = 'dealer_not_qualified';
    payout += ante * 2 + ante;
    detail.push({ bet: 'ante', x: 1, label: 'Dealer not qualified' });
  } else if (ps > ds) {
    outcome = 'win';
    payout += ante * 2 + ante * 2;
    detail.push({ bet: 'ante+play', x: 1, label: name3(ps) });
  } else if (ps === ds) {
    outcome = 'push';
    payout += ante + ante;
    detail.push({ bet: 'ante+play', x: 0, label: 'Push' });
  } else {
    outcome = 'lose';
    detail.push({ bet: 'ante+play', x: -1, label: name3(ds) });
  }
  return { cards, dealer, playerScore: ps, dealerScore: ds, qualified, outcome, payout, detail };
}

// ---------------------------------------------------------- Casino Hold'em

/** Le croupier se qualifie avec une paire de 4 ou mieux. */
function holdemQualifie(score) {
  const c = catP(score);
  if (c > P.CAT.PAIR) return true;
  if (c < P.CAT.PAIR) return false;
  let v = score;                       // rang de la paire
  for (let i = 0; i < 4; i++) v = Math.floor(v / 15);
  return (v % 15) - 1 >= 2;            // 0=2, 1=3, 2=4 -> paire de 4
}

/** Distribue : 2 cartes au joueur, 2 au croupier (cachees), et le flop. */
function holdemDeal({ serverSeed, clientSeed, nonce }) {
  const d = shoe(serverSeed, clientSeed, nonce);
  return {
    player: [d[0], d[1]],
    dealer: [d[2], d[3]],
    board: [d[4], d[5], d[6]],
    rest: [d[7], d[8]],                // turn et river, revelees a la decision
  };
}

/**
 * Resout la main apres la decision du joueur.
 * @param deal   ce que renvoie holdemDeal
 * @param ante   mise d'Ante
 * @param aa     mise du bonus AA (0 si absente)
 * @param call   true = suit pour 2x l'Ante, false = se couche
 */
function holdemResolve({ deal, ante, aa = 0, call }) {
  const detail = [];
  let payout = 0;

  // Le bonus AA porte sur les 2 cartes du joueur + le flop, donc il se resout
  // meme si le joueur se couche ensuite.
  if (aa > 0) {
    const cinq = deal.player.concat(deal.board);
    const sc = P.evaluate(cinq);
    const c = catP(sc);
    let l = PAY.aaBonus.find((x) => x.cat !== 'AA' && x.cat === c && (!x.royale || estRoyale(sc)));
    if (!l && c === P.CAT.PAIR) {
      let v = sc; for (let i = 0; i < 4; i++) v = Math.floor(v / 15);
      if ((v % 15) - 1 === 12) l = PAY.aaBonus.find((x) => x.cat === 'AA');   // paire d'As
    }
    if (l) { payout += aa * (l.x + 1); detail.push({ bet: 'aa', x: l.x, label: l.label }); }
    else detail.push({ bet: 'aa', x: -1, label: 'Less than a pair of aces' });
  }

  if (!call) {
    return { board: deal.board.slice(), dealer: null, outcome: 'fold', payout, detail,
             playerHand: null, dealerHand: null };
  }

  const board = deal.board.concat(deal.rest);
  const ps = P.evaluate(deal.player.concat(board));
  const ds = P.evaluate(deal.dealer.concat(board));
  const royale = estRoyale(ps);

  // L'Ante paie selon la main du joueur, en plus du duel.
  const l = multiplicateur(PAY.holdemAnte, ps, royale);
  const anteX = l ? l.x : 1;

  const qualified = holdemQualifie(ds);
  let outcome;
  if (!qualified) {
    // Ante paye au bareme, la mise Call est rendue telle quelle.
    outcome = 'dealer_not_qualified';
    payout += ante * (1 + anteX) + ante * 2;
    detail.push({ bet: 'ante', x: anteX, label: l ? l.label : 'Dealer not qualified' });
  } else if (ps > ds) {
    outcome = 'win';
    payout += ante * (1 + anteX) + ante * 4;   // Call = 2x l'Ante, paye 1:1
    detail.push({ bet: 'ante+call', x: anteX, label: P.handName(ps) });
  } else if (ps === ds) {
    outcome = 'push';
    payout += ante + ante * 2;
    detail.push({ bet: 'ante+call', x: 0, label: 'Push' });
  } else {
    outcome = 'lose';
    detail.push({ bet: 'ante+call', x: -1, label: P.handName(ds) });
  }
  return { board, dealer: deal.dealer.slice(), outcome, payout, detail,
           playerHand: P.handName(ps), dealerHand: P.handName(ds), qualified };
}

module.exports = {
  shoe, eval3, name3, cat3, T3, T3_NAME, T3_QUALIF,
  PAY, catP, estRoyale, holdemQualifie,
  threeCard, holdemDeal, holdemResolve,
};
