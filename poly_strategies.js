'use strict';
/* ==========================================================================
 * POLYMARKET STRATEGIES — 100 000 VARIATIONS PARAMETRIQUES
 *
 * Comme Pancake Predict, le moteur de base de Polymarket (les 5 baseline +
 * quelques variations) ne trouve pas d'edge suffisant. On genere donc des
 * MILLIERS de combinaisons de parametres et on les teste en papier sur les
 * marches reels : chaque strategie est evaluee independamment sur ses propres
 * observations. On classe par edge (PnL total / nombre de paris resolus).
 *
 * Axes de variation :
 * - STRATEGIE (6 types) : Fair Value, Crowd, Fade, Momentum, MeanRev, Vol-weighted
 * - MARGE/SEUIL (12 valeurs par type) : adapte a la nature de chaque strategie
 * - FENETRE TEMPS (15 bandes) : debut et fin en secondes restantes
 * - AVEC/SANS filtre (2) : ex: vol-weighted oui/non, early entry oui/non
 * - RISQUE/KELLY (3) : mise conservative, standard, aggressive
 *
 * Produit : 6 × 12 × 15 × 2 × 3 = ~6 480 strategies
 * Doublees avec filtres additionnels (prix extremes, momentum, etc) → ~100 000
 * ======================================================================== */

const crypto = require('crypto');

function hashConfig(cfg) {
  const str = JSON.stringify(cfg);
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 8);
}

function creeStrategies() {
  const strategies = [];

  /* ---- AXES DE VARIATION ---- */

  /* Marges pour Fair Value */
  const MARGES_FV = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10];

  /* Seuils pour Crowd (quand acheter le favori) */
  const SEUILS_CROWD = [0.50, 0.52, 0.55, 0.58, 0.60, 0.65, 0.70, 0.72, 0.75, 0.80, 0.85, 0.90];

  /* Seuils pour Fade (quand acheter l'outsider) */
  const SEUILS_FADE = [0.60, 0.65, 0.70, 0.72, 0.75, 0.78, 0.80, 0.82, 0.85, 0.88, 0.90, 0.95];

  /* Seuils d'extremes pour Mean Reversion */
  const SEUILS_EXTREMES_BAS = [0.20, 0.25, 0.30, 0.35, 0.40];
  const SEUILS_EXTREMES_HAUT = [0.55, 0.60, 0.65, 0.70];

  /* Volatilite min pour Vol-weighted (en fractions de sigma) */
  const VOL_THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5];

  /* Momentum : force minimale pour decider */
  const MOMENTUM_FORCES = [0.001, 0.002, 0.003, 0.005, 0.008, 0.010, 0.015, 0.020, 0.025, 0.030, 0.040, 0.050];

  /* Profit-taking : a quel gain % se retirer d'une position */
  const PROFIT_TARGETS = [0.02, 0.03, 0.05, 0.07, 0.10];

  /* Stop-loss : limite de perte avant d'abandonner une strategie */
  const STOP_LOSSES = [0.05, 0.10, 0.20];

  /* Delai d'entree : secondes a attendre avant d'evaluer les entrees */
  const ENTRY_DELAYS = [0, 15, 30, 45];

  /* Fenetres de temps : [debut, fin] en secondes restantes */
  const FENETRES = [
    [600, 480],  /* 10-8 min */
    [540, 420],  /* 9-7 min */
    [480, 360],  /* 8-6 min */
    [440, 320],  /* 7.33-5.33 min */
    [420, 300],  /* 7-5 min */
    [380, 280],  /* 6.33-4.67 min */
    [360, 240],  /* 6-4 min */
    [320, 200],  /* 5.33-3.33 min */
    [300, 180],  /* 5-3 min */
    [260, 140],  /* 4.33-2.33 min */
    [240, 120],  /* 4-2 min */
    [200, 100],  /* 3.33-1.67 min */
    [180, 60],   /* 3-1 min */
    [120, 30],   /* 2-0.5 min */
    [90, 20]     /* 1.5-0.33 min */
  ];

  /* Mises : fraction de la banque par pari (Kelly, conservative, aggressive) */
  const KELLY_FACTORS = [0.5, 1.0, 1.5];  /* 50%, 100%, 150% of Kelly */

  /* Filtres additionnels */
  const WITH_VOL_FILTER = [false, true];      /* appliquer un filtre vol ? */
  const WITH_PRICE_FILTER = [false, true];    /* refuser les prix extremes (< 0.1 ou > 0.9) ? */

  let id = 0;

  /* ---- FAIR VALUE : variations de marge, fenetre, profit-target, stop-loss ---- */
  for (const marge of MARGES_FV) {
    for (const fenetre of FENETRES) {
      for (const kelly of KELLY_FACTORS) {
        for (const volFilter of WITH_VOL_FILTER) {
          for (const priceFilter of WITH_PRICE_FILTER) {
            for (const profitTarget of PROFIT_TARGETS) {
              for (const stopLoss of STOP_LOSSES) {
                const cfg = {
                  type: 'fair_value',
                  marge,
                  fenetre,
                  kelly,
                  volFilter,
                  priceFilter,
                  profitTarget,
                  stopLoss,
                  banque0: 1000
                };
                strategies.push({
                  id: id++,
                  hash: hashConfig(cfg),
                  name: `fv_m${(marge*100).toFixed(0)}_t${fenetre[0]}_k${(kelly*100).toFixed(0)}_pt${(profitTarget*100).toFixed(0)}_sl${(stopLoss*100).toFixed(0)}`,
                  config: cfg,
                  stats: { n_paris: 0, pnl_total: 0, pnl_pct: 0, edge: 0, resolus: 0, gagnes: 0 }
                });
              }
            }
          }
        }
      }
    }
  }

  /* ---- CROWD : variations de seuil, fenetre, profit-target, stop-loss ---- */
  for (const seuil of SEUILS_CROWD) {
    for (const fenetre of FENETRES) {
      for (const kelly of KELLY_FACTORS) {
        for (const volFilter of WITH_VOL_FILTER) {
          for (const profitTarget of PROFIT_TARGETS) {
            for (const stopLoss of STOP_LOSSES) {
              const cfg = {
                type: 'crowd',
                seuil,
                fenetre,
                kelly,
                volFilter,
                profitTarget,
                stopLoss,
                banque0: 1000
              };
              strategies.push({
                id: id++,
                hash: hashConfig(cfg),
                name: `crowd_s${(seuil*100).toFixed(0)}_t${fenetre[0]}_k${(kelly*100).toFixed(0)}_pt${(profitTarget*100).toFixed(0)}_sl${(stopLoss*100).toFixed(0)}`,
                config: cfg,
                stats: { n_paris: 0, pnl_total: 0, pnl_pct: 0, edge: 0, resolus: 0, gagnes: 0 }
              });
            }
          }
        }
      }
    }
  }

  /* ---- FADE : variations de seuil, fenetre, profit-target, stop-loss ---- */
  for (const seuil of SEUILS_FADE) {
    for (const fenetre of FENETRES) {
      for (const kelly of KELLY_FACTORS) {
        for (const volFilter of WITH_VOL_FILTER) {
          for (const profitTarget of PROFIT_TARGETS) {
            for (const stopLoss of STOP_LOSSES) {
              const cfg = {
                type: 'fade',
                seuil,
                fenetre,
                kelly,
                volFilter,
                profitTarget,
                stopLoss,
                banque0: 1000
              };
              strategies.push({
                id: id++,
                hash: hashConfig(cfg),
                name: `fade_s${(seuil*100).toFixed(0)}_t${fenetre[0]}_k${(kelly*100).toFixed(0)}_pt${(profitTarget*100).toFixed(0)}_sl${(stopLoss*100).toFixed(0)}`,
                config: cfg,
                stats: { n_paris: 0, pnl_total: 0, pnl_pct: 0, edge: 0, resolus: 0, gagnes: 0 }
              });
            }
          }
        }
      }
    }
  }

  /* ---- MOMENTUM : variations de force, fenetre, profit-target, stop-loss ---- */
  for (const force of MOMENTUM_FORCES) {
    for (const fenetre of FENETRES) {
      for (const kelly of KELLY_FACTORS) {
        for (const priceFilter of WITH_PRICE_FILTER) {
          for (const profitTarget of PROFIT_TARGETS) {
            for (const stopLoss of STOP_LOSSES) {
              const cfg = {
                type: 'momentum',
                force,
                fenetre,
                kelly,
                priceFilter,
                profitTarget,
                stopLoss,
                banque0: 1000
              };
              strategies.push({
                id: id++,
                hash: hashConfig(cfg),
                name: `mom_f${(force*1000).toFixed(0)}_t${fenetre[0]}_k${(kelly*100).toFixed(0)}_pt${(profitTarget*100).toFixed(0)}_sl${(stopLoss*100).toFixed(0)}`,
                config: cfg,
                stats: { n_paris: 0, pnl_total: 0, pnl_pct: 0, edge: 0, resolus: 0, gagnes: 0 }
              });
            }
          }
        }
      }
    }
  }

  /* ---- MEAN REVERSION : variations d'extremes, fenetre, profit-target, stop-loss ---- */
  for (const seuilBas of SEUILS_EXTREMES_BAS) {
    for (const seuilHaut of SEUILS_EXTREMES_HAUT) {
      if (seuilBas >= seuilHaut) continue;  /* skip invalid ranges */
      for (const fenetre of FENETRES) {
        for (const kelly of KELLY_FACTORS) {
          for (const profitTarget of PROFIT_TARGETS) {
            for (const stopLoss of STOP_LOSSES) {
              const cfg = {
                type: 'meanrev',
                seuilBas,
                seuilHaut,
                fenetre,
                kelly,
                profitTarget,
                stopLoss,
                banque0: 1000
              };
              strategies.push({
                id: id++,
                hash: hashConfig(cfg),
                name: `mr_${(seuilBas*100).toFixed(0)}_${(seuilHaut*100).toFixed(0)}_t${fenetre[0]}_k${(kelly*100).toFixed(0)}_pt${(profitTarget*100).toFixed(0)}_sl${(stopLoss*100).toFixed(0)}`,
                config: cfg,
                stats: { n_paris: 0, pnl_total: 0, pnl_pct: 0, edge: 0, resolus: 0, gagnes: 0 }
              });
            }
          }
        }
      }
    }
  }

  /* ---- VOL-WEIGHTED : variations de seuil vol, fenetre, profit-target, stop-loss ---- */
  for (const volThreshold of VOL_THRESHOLDS) {
    for (const fenetre of FENETRES) {
      for (const kelly of KELLY_FACTORS) {
        for (const priceFilter of WITH_PRICE_FILTER) {
          for (const profitTarget of PROFIT_TARGETS) {
            for (const stopLoss of STOP_LOSSES) {
              const cfg = {
                type: 'vol_weighted',
                volThreshold,
                fenetre,
                kelly,
                priceFilter,
                profitTarget,
                stopLoss,
                banque0: 1000
              };
              strategies.push({
                id: id++,
                hash: hashConfig(cfg),
                name: `vol_v${(volThreshold*100).toFixed(0)}_t${fenetre[0]}_k${(kelly*100).toFixed(0)}_pt${(profitTarget*100).toFixed(0)}_sl${(stopLoss*100).toFixed(0)}`,
                config: cfg,
                stats: { n_paris: 0, pnl_total: 0, pnl_pct: 0, edge: 0, resolus: 0, gagnes: 0 }
              });
            }
          }
        }
      }
    }
  }

  return strategies;
}

/* ---- SELECTION PAR FENETRE ----
 * A chaque fenetre (par actif), on choisit une strategie.
 * Rotation : fenetre 0 → strategie 0, fenetre 1 → strategie 1, etc.
 * Les strategies tournent au meme rythme — chacune voit un flux constant. */
function selectStrategy(strategies, fenetreIndex) {
  if (!strategies.length) return null;
  return strategies[fenetreIndex % strategies.length];
}

/* ---- MESURE DE L'EDGE ----
 * edge = PnL total / nombre de paris resolus.
 * Permet de comparer strategies qui ont vu des volumes differents. */
function computeEdge(stats) {
  if (stats.resolus <= 0) return 0;
  return stats.pnl_total / stats.resolus;
}

/* ---- CLASSEMENT ----
 * Top 100 strategies (avec au moins 20 paris resolus), affichees par edge descendant. */
function rankStrategies(strategies) {
  const qualified = strategies.filter((s) => s.stats.resolus >= 20);
  qualified.sort((a, b) => {
    const edgeA = computeEdge(a.stats);
    const edgeB = computeEdge(b.stats);
    return edgeB - edgeA;
  });
  return qualified.slice(0, 100);
}

/* ---- EXPORT ---- */
module.exports = {
  creeStrategies,
  selectStrategy,
  computeEdge,
  rankStrategies,
  RESOLUS_MIN: 20  /* minimum resolus pour un verdict fiable */
};
