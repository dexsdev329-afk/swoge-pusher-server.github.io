'use strict';
/* ==========================================================================
 * LE REPERE SANS RISQUE + LE BANC PAPIER PRE-ENREGISTRE (04/10/2026)
 * ==========================================================================
 *
 * Conclusion de la chasse a l'edge (46 agents, 04/10) : AUCUN avantage prouve
 * net de couts a notre taille. Les deux pistes les plus proches (retournement
 * du week-end sur les perps HL xyz et sur les pools actions Robinhood) tombent
 * des qu'on corrige le BIAIS DE SELECTION — leurs heures d'entree/sortie
 * avaient ete choisies SUR les memes week-ends qui les rendaient positives.
 *
 * Deux garde-fous, tires de ce constat :
 *
 *  1. LE REPERE SANS RISQUE. « Ne rien faire » rapporte le taux sans risque
 *     (T-bill ~4,0 %/an au 04/10). Chaque mesure se compare a lui : une
 *     colonie qui perd 4,3 % par trade coute une ANNEE de T-bill a chaque fois.
 *     `sansRisque(jours)` rend ce que le repere donne sur la duree de la tenue.
 *
 *  2. LE BANC PRE-ENREGISTRE. Pour qu'une piste ne soit pas jugee sur les
 *     memes donnees qui l'ont fait choisir, on FIGE sa regle (heures, seuils)
 *     AVANT de mesurer, avec sa date. Ensuite on ne fait qu'AJOUTER des
 *     observations ; aucune heure ne se re-choisit. Le banc refuse de conclure
 *     sous `minObs`, et montre TOUJOURS le resultat face au repere sans risque.
 *
 * Ce fichier ne touche ni le reseau ni une cle : il recoit des observations
 * (des rendements) et rend des statistiques. Les feeds (prix HL, pools RH,
 * campagnes Merkl) l'ALIMENTENT ailleurs ; ici, le coeur se teste sans internet.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

/* T-bill ~4,0 %/an (releve de la chasse a l'edge, 04/10 ; steakUSDG 3,6 %).
   Reglable par l'environnement si le taux bouge. */
const TAUX_SANS_RISQUE = Number(process.env.TAUX_SANS_RISQUE || 0.04);

/** Ce que « ne rien faire » rapporte sur `jours` jours, en fraction (0,01 = 1 %).
 *  Avec `capitalUsd`, en dollars. C'est la ligne de repere de toute mesure. */
function sansRisque(jours, capitalUsd) {
  const f = TAUX_SANS_RISQUE * (Number(jours) || 0) / 365;
  return capitalUsd != null ? Math.round(f * capitalUsd * 100) / 100 : f;
}

const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

/** Une serie de rendements (en %, dans l'ordre du temps) : n, moyenne, t, moities. */
function serie(v) {
  const n = v.length;
  if (!n) return { n: 0, net: null, t: null, moitie1: null, moitie2: null };
  const m = v.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - m) * (x - m), 0) / (n - 1)) : null;
  const h = n >> 1, moy = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return { n, net: r2(m), t: sd && sd > 0 ? r2(m / (sd / Math.sqrt(n))) : null,
           moitie1: r2(moy(v.slice(0, h))), moitie2: r2(moy(v.slice(h))) };
}

/**
 * Un banc PRE-ENREGISTRE. deps : { dossier, nom, enregistreLe, regle, tenueJours, minObs }
 *   - enregistreLe : la DATE ou la regle a ete figee (ISO). Figee = non rejouee.
 *   - regle : le texte de la regle (heures, seuils) — ce sur quoi on ne revient pas.
 *   - tenueJours : la duree d'une position, pour la comparer au repere sans risque.
 *   - minObs : sous ce nombre d'observations, le banc NE conclut pas.
 * Rend { ajoute(rendementPct, meta?), vue(), _etat }.
 */
function banc(deps) {
  const d = deps || {};
  const fichier = path.join(d.dossier || path.join(process.env.DATA_DIR || '.', 'reperes'), (d.nom || 'banc') + '.json');
  const minObs = d.minObs || 30;
  let S;
  try { S = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch (e) { S = null; }
  if (!S || S.enregistreLe !== d.enregistreLe || S.regle !== d.regle) {
    /* Regle changee = NOUVELLE pre-enregistration : on repart a zero, on ne
       melange pas des observations sous deux regles differentes. */
    S = { nom: d.nom, enregistreLe: d.enregistreLe, regle: d.regle, tenueJours: d.tenueJours || null, obs: [], depuis: new Date().toISOString() };
  }
  function sauve() {
    try { fs.mkdirSync(path.dirname(fichier), { recursive: true }); fs.writeFileSync(fichier + '.tmp', JSON.stringify(S)); fs.renameSync(fichier + '.tmp', fichier); }
    catch (e) { /* un disque plein ne fait pas tomber le banc */ }
  }
  function ajoute(rendementPct, meta) {
    const x = Number(rendementPct);
    if (!isFinite(x)) return false;
    S.obs.push({ r: r2(x), t: Date.now(), meta: meta || null });
    if (S.obs.length > 5000) S.obs.splice(0, S.obs.length - 5000);
    sauve();
    return true;
  }
  function vue() {
    const v = S.obs.map((o) => o.r);
    const s = serie(v);
    const repPct = d.tenueJours != null ? r2(sansRisque(d.tenueJours) * 100) : null;   /* le repere sur la duree d'une tenue, en % */
    const assez = s.n >= minObs;
    const bat = (assez && s.net != null && repPct != null) ? s.net > repPct : null;
    return {
      nom: d.nom, enregistreLe: d.enregistreLe, regle: d.regle, tenueJours: d.tenueJours || null,
      minObs, n: s.n, netPct: s.net, t: s.t, moitie1: s.moitie1, moitie2: s.moitie2,
      repereSansRisquePct: repPct,
      conclut: assez
        ? (s.t != null && Math.abs(s.t) >= 2
            ? (s.net > 0 && bat ? 'edge holds in paper (beats risk-free, t≥2)' : s.net > 0 ? 'positive but does NOT beat risk-free' : 'negative beyond chance')
            : 'no edge: within noise')
        : ('too few: ' + s.n + '/' + minObs + ' observations — pre-registered, keep collecting'),
      beatsRiskFree: bat,
      note: 'Pre-registered on ' + d.enregistreLe + '. Hours/thresholds fixed in advance (no in-sample re-picking). Paper only; compared to doing nothing at the risk-free rate.',
    };
  }
  return { ajoute, vue, _etat: () => S, _fichier: fichier };
}

/* Les trois bancs de la chasse a l'edge, PRE-ENREGISTRES le 04/10. Heures et
   seuils figes ICI, tels que l'etude les a decrits — on ne les re-choisira pas. */
const ENREGISTRE_LE = '2026-10-04';
const BANCS = [
  { nom: 'rh-weekend', tenueJours: 2.55, minObs: 30,
    regle: 'RH stock pools (0.05%). Reference Fri 20:00 ET. If |weekly move| ≥ 1%, take -sign(move) at Sun 17:00 ET, exit Mon 09:00 ET. Net of the measured 4-5 bp round trip.' },
  { nom: 'hl-xyz-weekend', tenueJours: 0.67, minObs: 30,
    regle: 'Hyperliquid xyz stock perps. Reference Fri 20:00 ET. Take -sign(weekly move) at Sun 17:00 ET, exit Mon 09:00 ET. Net of 4 bp round trip (growth-mode taker).' },
  { nom: 'merkl-lp', tenueJours: 7, minObs: 20,
    regle: 'Paper LP on Merkl-subsidised SPY/stock v4 pools on RH Chain. Weekly: fees + USDG incentives − impermanent loss − gas, vs holding the two tokens.' },
];

function bancs(dossier) {
  const out = {};
  for (const b of BANCS) out[b.nom] = banc(Object.assign({ dossier, enregistreLe: ENREGISTRE_LE }, b));
  return out;
}

module.exports = { TAUX_SANS_RISQUE, sansRisque, serie, banc, bancs, BANCS, ENREGISTRE_LE };
