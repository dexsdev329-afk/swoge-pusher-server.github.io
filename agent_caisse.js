'use strict';
/* ==================================================================
 * LA CAISSE D'UN AGENT — la cascade « argent entrant → carburant/trésor/rachat »
 * ==================================================================
 *
 * Amélioration économie (05/10/2026). Un agent coûte de l'argent : chaque pensée
 * paie notre API (c'est NOTRE revenu quand on la recharge en argent réel). Il faut
 * donc une règle claire de répartition de l'argent qui entre (les frais de trading
 * du jeton, ou une recharge payante du créateur) :
 *
 *   - d'abord le CARBURANT (il faut que l'agent puisse penser) — c'est ce qui achète
 *     nos API, donc notre revenu principal ;
 *   - ensuite le TRÉSOR du jeton (fonds investissables, en papier pour l'instant) ;
 *   - enfin, au-delà d'un seuil, une part de RACHAT-et-brûle (secondaire).
 *
 * Modèle AgencyPad, en paliers CUMULATIFS (sur le total déjà reçu, pas sur un seul
 * versement) : le premier argent va entièrement au carburant ; passé un palier, on
 * partage ; tout en haut, une part de rachat. Pur et déterministe : il RÉPARTIT un
 * montant, il ne déplace rien (le serveur crédite ensuite les registres). Tout en
 * dollars. La répartition somme TOUJOURS au montant (aucun centime perdu).
 * ================================================================== */

const r2 = (x) => Math.round(Number(x) * 100) / 100;

/* Les paliers par défaut, en dollars cumulés reçus par l'agent :
 *  - 0 → 20 $   : 100 % carburant (amorçage : l'agent doit pouvoir penser).
 *  - 20 → 100 $ : 50 % carburant / 50 % trésor.
 *  - au-delà    : 50 % carburant / 35 % trésor / 15 % rachat-et-brûle.
 * Carburant d'abord = notre revenu d'abord ; le rachat ne vient qu'une fois l'agent
 * finance et doté. (Chiffres de départ, révisables à la mesure.) */
const PALIERS_DEFAUT = [
  { jusqu: 20, fuel: 1.00, tresor: 0.00, rachat: 0.00 },
  { jusqu: 100, fuel: 0.50, tresor: 0.50, rachat: 0.00 },
  { jusqu: Infinity, fuel: 0.50, tresor: 0.35, rachat: 0.15 },
];

/**
 * repartit(montantUsd, dejaRecuUsd, config) : répartit un montant entrant.
 * dejaRecuUsd : total déjà reçu par cet agent (pour savoir dans quel palier on est).
 * Rend { fuel, tresor, rachat } (dollars), qui somment exactement à montantUsd.
 */
function repartit(montantUsd, dejaRecuUsd, config) {
  const paliers = (config && config.paliers) || PALIERS_DEFAUT;
  let reste = Number(montantUsd);
  if (!(reste > 0)) return { fuel: 0, tresor: 0, rachat: 0 };
  let cumul = Math.max(0, Number(dejaRecuUsd) || 0);
  const acc = { fuel: 0, tresor: 0, rachat: 0 };
  for (const p of paliers) {
    if (reste <= 0) break;
    const capacite = p.jusqu === Infinity ? reste : Math.max(0, p.jusqu - cumul);
    if (capacite <= 0) continue;
    const part = Math.min(reste, capacite);
    acc.fuel += part * p.fuel; acc.tresor += part * p.tresor; acc.rachat += part * p.rachat;
    reste -= part; cumul += part;
  }
  /* On arrondit, puis on recale le carburant pour que la somme = montant au centime. */
  let fuel = r2(acc.fuel), tresor = r2(acc.tresor), rachat = r2(acc.rachat);
  const ecart = r2(Number(montantUsd) - (fuel + tresor + rachat));
  fuel = r2(fuel + ecart);
  return { fuel, tresor, rachat };
}

/** L'autonomie (runway) : combien de temps l'agent peut penser avec ce qu'il a.
 *  soldeUsd / coutParPenseeUsd → pensées ; × cadence → heures/jours (approx). */
function autonomie(soldeUsd, coutParPenseeUsd, cadenceMin) {
  const cout = Number(coutParPenseeUsd);
  const solde = Number(soldeUsd);
  if (!(cout > 0) || !(solde > 0)) return { pensees: 0, heures: 0, jours: 0 };
  const pensees = Math.floor(solde / cout);
  const cad = Math.max(1, Number(cadenceMin) || 60);
  const heures = (pensees * cad) / 60;
  return { pensees, heures: r2(heures), jours: r2(heures / 24) };
}

module.exports = { repartit, autonomie, PALIERS_DEFAUT };
