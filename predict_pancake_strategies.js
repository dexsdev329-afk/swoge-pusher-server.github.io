'use strict';
/* ==========================================================================
 * PANCAKE PREDICT — GENERATEUR DE STRATEGIES (PAPIER)
 *
 * Puisqu'aucune edge n'existe avec un seul moteur, on essaie des MILLIERS
 * de variations parametriques en papier : seuils EV, fenetre de decision,
 * escalade de martingale, profondeur de l'historique de cotes. Chacune
 * est mesuree independamment sur ses propres ombres. On classe par edge
 * (pnl / nombre de trades), comme les strategies Polymarket.
 *
 * Chaque strategie a un ID deterministique (hash des parametres) et garde
 * son propre bilan : n_trades, pnl_total, pnl_pct, edge.
 * ======================================================================== */

/* ---- VARIATIONS INDEPENDANTES ----
 * Chaque axe genere K valeurs ; le produit cartesien donne K^N strategies.
 * Exemples :
 * - MARGE (EV threshold) : [0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30]   → 7
 * - DECISION_LEAD (s)    : [10, 20, 30, 45, 60]                          → 5
 * - FINALES_MIN (rounds) : [6, 8, 12, 15, 20]                            → 5
 * - MART_FACTEUR         : [1.5, 1.8, 2.0, 2.5, 3.0]                     → 5
 * - MART_PALIERS         : [3, 4, 5, 6, 7, 8]                            → 6
 * - STAKE (BNB)          : [0.0005, 0.001, 0.002, 0.004, 0.006]          → 5
 * - MART on/off          : [0, 1]                                         → 2
 *
 * Produit : 7 × 5 × 5 × 5 × 6 × 5 × 2 = 10 500 strategies (+ variantes sans martingale)
 */

const crypto = require('crypto');

function hashConfig(cfg) {
  const str = JSON.stringify(cfg);
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 8);
}

function creeStrategies() {
  const strategies = [];

  /* ---- AXES DE VARIATION ---- */
  const MARGES = [0.01, 0.02, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30];
  const LEADS = [10, 15, 20, 30, 45, 60];
  const FINALES_MINS = [6, 8, 10, 12, 15, 20];
  const STAKE_VALUES = [0.0005, 0.0008, 0.001, 0.002, 0.004, 0.006, 0.01];
  const MART_FACTEURS = [1.5, 1.7, 1.9, 2.0, 2.2, 2.5, 3.0];
  const MART_PALIERS_VALUES = [3, 4, 5, 6, 7, 8];

  let id = 0;

  /* Sans martingale : variations de base */
  for (const marge of MARGES) {
    for (const lead of LEADS) {
      for (const finMin of FINALES_MINS) {
        const cfg = {
          marge,
          lead,
          finalesMin: finMin,
          finalesMax: 60,
          mart: false,
          martFacteur: null,
          martPaliers: null,
          stake: 0.002,  /* baseline stake */
          gaz: 0.0001,
          bank0: 1,
        };
        strategies.push({
          id: id++,
          hash: hashConfig(cfg),
          name: `base_M${(marge * 100).toFixed(0)}_L${lead}_F${finMin}`,
          config: cfg,
          stats: { n_trades: 0, pnl_total: 0, pnl_pct: 0, edge: 0, busts: 0 },
        });
      }
    }
  }

  /* Avec martingale : variations de risque/escalade */
  for (const marge of MARGES.filter((m) => m <= 0.10)) {  /* martingale surtout a seuils bas */
    for (const lead of LEADS) {
      for (const finMin of FINALES_MINS) {
        for (const facteur of MART_FACTEURS) {
          for (const paliers of MART_PALIERS_VALUES) {
            for (const stake of STAKE_VALUES) {
              const cfg = {
                marge,
                lead,
                finalesMin: finMin,
                finalesMax: 60,
                mart: true,
                martFacteur: facteur,
                martPaliers: paliers,
                stake,
                gaz: 0.0001,
                bank0: 1,
              };
              strategies.push({
                id: id++,
                hash: hashConfig(cfg),
                name: `mart_M${(marge * 100).toFixed(0)}_L${lead}_F${finMin}_FAC${(facteur * 10).toFixed(0)}_PAL${paliers}_S${(stake * 10000).toFixed(0)}`,
                config: cfg,
                stats: { n_trades: 0, pnl_total: 0, pnl_pct: 0, edge: 0, busts: 0 },
              });
            }
          }
        }
      }
    }
  }

  return strategies;
}

/* ---- SELECTION PAR ROUND ----
 * A chaque round (decision a prendre), on choisit une strategie.
 * Rotation simple (round 0 → strategy 0, round 1 → strategy 1, etc.) pour
 * que toutes les strategies voient un flux constant de rounds. */
function selectStrategy(strategies, roundNumber) {
  if (!strategies.length) return null;
  return strategies[roundNumber % strategies.length];
}

/* ---- MESURE DE L'EDGE ----
 * Pour une strategie donnee, edge = PnL total / nombre de trades.
 * Permet de comparer strategies qui ont vu des volumes differents. */
function computeEdge(stats) {
  if (stats.n_trades <= 0) return 0;
  return stats.pnl_total / stats.n_trades;
}

/* ---- CLASSEMENT ----
 * Les top 20 non-baseline (avec martingale), affichees par edge descendant. */
function rankStrategies(strategies) {
  const withMart = strategies.filter((s) => s.config.mart && s.stats.n_trades > 0);
  withMart.sort((a, b) => {
    const edgeA = computeEdge(a.stats);
    const edgeB = computeEdge(b.stats);
    return edgeB - edgeA;
  });
  return withMart.slice(0, 20);
}

/* ---- EXPORT ---- */
module.exports = {
  creeStrategies,
  selectStrategy,
  computeEdge,
  rankStrategies,
};
