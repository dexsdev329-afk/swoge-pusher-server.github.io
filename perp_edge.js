'use strict';
/* ==========================================================================
 * PERP EDGE — CHERCHER UN VRAI EDGE AVANT DE PARLER DE LEVIER
 *
 * « Le but final est d'utiliser du levier, mais là on ne gagne pas. » Le levier
 * multiplie l'edge ; si l'edge est nul ou négatif, il multiplie la perte. Avant
 * de le construire, on MESURE : le signal d'entrée prédit-il la direction ?
 *
 * On rejoue le VRAI scoreur (`ai_perp.note`) sur de vraies bougies Bitget, et on
 * simule la sortie stop/cible/temps exacte du bot (STOP 3σ / CIBLE 5σ / 12 h).
 * Barrières asymétriques → point mort d'une marche aléatoire = 3/(3+5) = 37,5 %
 * de réussite. En dessous, le signal est PIRE que le hasard.
 *
 * Le financement n'est pas connu bougie par bougie dans l'historique public :
 * cette mesure isole donc l'edge de DIRECTION (prix). Si l'edge de prix est déjà
 * ≤ 0, le financement (une traînée qui s'ajoute) ne fait que l'aggraver — c'est
 * décisif. On compare quatre directions :
 *   note      — la décision actuelle du bot (scoreur + vétos + seuil)
 *   trend     — suivre la tendance courte (signe de ecartEma)
 *   fond      — suivre la tendance de fond (signe de fond, 4 h)
 *   contre    — l'inverse de trend (ce que le scoreur penche à faire)
 *
 * Lecture seule, aucun ordre, aucune clé. Sortie : un tableau par marché.
 *   node perp_edge.js
 * ======================================================================== */

const P = require('./ai_perp');

const BASE = 'https://api.bitget.com/api/v2/mix/market';
const PRODUIT = 'USDT-FUTURES';
const SEUIL = Number(process.env.PERP_SEUIL || 55);
const STOP_VOL = 3.0, CIBLE_VOL = 5.0, TENUE_BARS = 48;   /* 48 × 15 min = 12 h */
const BARRIERE_PM = STOP_VOL / (STOP_VOL + CIBLE_VOL) * 100;   /* = 37,5 % */
const SYMBOLES = (process.env.PERP_SYMBOLES || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT').split(',');

async function unLot(sym, gran, endTime) {
  let u = BASE + '/candles?symbol=' + sym + '&productType=' + PRODUIT + '&granularity=' + gran + '&limit=1000';
  if (endTime) u += '&endTime=' + endTime;
  const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + sym);
  const j = await r.json();
  return (j.data || []).map((c) => ({ t: +c[0], o: +c[1], h: +c[2], b: +c[3], c: +c[4], v: +c[5] }))
    .filter((c) => isFinite(c.c)).sort((a, b) => a.t - b.t);
}
/* Paging : on remonte le temps par lots de 1000 jusqu'au nombre voulu. */
async function candles(sym, gran, vise) {
  let tout = await unLot(sym, gran, null);
  while (tout.length < vise && tout.length) {
    const avant = await unLot(sym, gran, tout[0].t);
    const neuf = avant.filter((c) => c.t < tout[0].t);
    if (!neuf.length) break;
    tout = neuf.concat(tout);
  }
  return tout;
}

/* Construire le `m` que `mesures()` attend, depuis des fenêtres de bougies.
   Financement/carnet/interet/marque = inconnus dans l'historique → null (ces
   agents s'abstiennent). var24 est calculée depuis les bougies (96 × 15 min). */
function marcheDepuis(sym, c15, jusqu4) {
  const der = c15[c15.length - 1].c;
  const il96 = c15.length >= 97 ? c15[c15.length - 97].c : null;
  return { sym, prix: der, financement: null, marque: null, index: null, bid: null, ask: null,
           var24: il96 ? (der - il96) / il96 : null, volume: null,
           m15: c15.slice(-100), h4: jusqu4.slice(-60) };
}

/* Rejouer la sortie exacte du bot sur les bougies suivantes. Rend le sens du
   résultat : +1 cible atteinte, -1 stop atteint, 0 sortie au temps (signe du
   mouvement), et le rendement brut % (prix seul, hors financement). */
function issue(sens, prix, vol, avenir) {
  const stop = prix * (1 - sens * STOP_VOL * vol / 100);
  const cible = prix * (1 + sens * CIBLE_VOL * vol / 100);
  for (let k = 0; k < avenir.length && k < TENUE_BARS; k++) {
    const bar = avenir[k];
    if (sens > 0) {
      if (bar.b <= stop) return { g: -1, brut: (stop - prix) / prix * 100 * sens };
      if (bar.h >= cible) return { g: 1, brut: (cible - prix) / prix * 100 * sens };
    } else {
      if (bar.h >= stop) return { g: -1, brut: (stop - prix) / prix * 100 * sens };
      if (bar.b <= cible) return { g: 1, brut: (cible - prix) / prix * 100 * sens };
    }
  }
  const dern = avenir[Math.min(avenir.length, TENUE_BARS) - 1];
  if (!dern) return null;
  const brut = (dern.c - prix) / prix * 100 * sens;
  return { g: brut > 0 ? 1 : -1, brut, temps: true };
}

function h4Jusqu(c4, t) { return c4.filter((c) => c.t <= t); }

function noteDir(x) {
  /* La décision du bot : par sens, sécurité + véto de tendance + seuil, meilleure note. */
  let best = null;
  for (const sens of [1, -1]) {
    // sécurité
    if (x.vol15 === null || x.vol15 < 0.04 || x.vol15 > 0.6) continue;
    if (x.fond === null || x.ecartEma === null) continue;
    // véto de tendance (le mur de fond)
    const mur = Number(process.env.PERP_FOND_MUR || 8);
    if (sens > 0 && x.fond < -mur) continue;
    if (sens < 0 && x.fond > mur) continue;
    const an = P.note(x, sens);
    if (an.score < SEUIL) continue;
    if (!best || an.score > best.score) best = { sens, score: an.score };
  }
  return best ? best.sens : 0;
}

function agrege() { return { n: 0, cible: 0, stop: 0, temps: 0, gagne: 0, brut: 0 }; }
function ajoute(a, r) { a.n++; if (r.g > 0) a.gagne++; if (r.temps) a.temps++; else if (r.g > 0) a.cible++; else a.stop++; a.brut += r.brut; }
function ligne(nom, a) {
  if (!a.n) return '  ' + nom.padEnd(9) + '  (aucune entrée)';
  const w = (a.gagne / a.n * 100), mb = (a.brut / a.n);
  const verdict = w >= BARRIERE_PM ? 'AU-DESSUS du hasard' : 'sous le hasard';
  return '  ' + nom.padEnd(9) + '  n=' + String(a.n).padStart(4)
    + '  gagné ' + w.toFixed(1).padStart(5) + '%  (pt mort ' + BARRIERE_PM.toFixed(1) + '%)  '
    + 'brut moy ' + (mb >= 0 ? '+' : '') + mb.toFixed(3) + '%  · ' + verdict;
}

(async () => {
  console.log('PERP EDGE — edge de DIRECTION, hors financement (celui-ci ne peut qu\'aggraver)');
  console.log('Point mort d\'une marche aléatoire (stop 3σ / cible 5σ) = ' + BARRIERE_PM.toFixed(1) + '% de réussite\n');
  const tot = { note: agrege(), trend: agrege(), fond: agrege(), contre: agrege() };
  for (const sym of SYMBOLES) {
    let c15, c4;
    try { c15 = await candles(sym, '15m', Math.max(300, Number(process.env.PERP_EDGE_VISE || 3000))); c4 = await candles(sym, '4H', 200); }
    catch (e) { console.log(sym + ' : lecture ratée — ' + e.message); continue; }
    const par = { note: agrege(), trend: agrege(), fond: agrege(), contre: agrege() };
    for (let i = 100; i < c15.length - 2; i++) {
      const fen15 = c15.slice(0, i + 1);
      const jusq4 = h4Jusqu(c4, c15[i].t);
      if (jusq4.length < 51) continue;                    /* fond (ema 50 en 4 h) pas encore lisible */
      const x = P.mesures(marcheDepuis(sym, fen15, jusq4));
      x.sym = sym;
      if (x.vol15 === null || x.vol15 < 0.04 || x.vol15 > 0.6) continue;   /* sécurité : mort / tempête */
      if (x.fond === null || x.ecartEma === null) continue;
      const avenir = c15.slice(i + 1);
      const vol = x.vol15;
      const dirs = {
        note: noteDir(x),
        trend: x.ecartEma > 0 ? 1 : x.ecartEma < 0 ? -1 : 0,
        fond: x.fond > 0 ? 1 : x.fond < 0 ? -1 : 0,
        contre: x.ecartEma > 0 ? -1 : x.ecartEma < 0 ? 1 : 0,
      };
      for (const k of Object.keys(dirs)) {
        const s = dirs[k]; if (!s) continue;
        const r = issue(s, x.prix, vol, avenir); if (!r) continue;
        ajoute(par[k], r); ajoute(tot[k], r);
      }
    }
    console.log(sym.replace('USDT', '') + ' (' + (c15.length) + ' bougies 15 min ≈ ' + Math.round(c15.length / 96) + ' j)');
    for (const k of ['note', 'trend', 'fond', 'contre']) console.log(ligne(k, par[k]));
    console.log('');
  }
  console.log('TOUS MARCHÉS CONFONDUS');
  for (const k of ['note', 'trend', 'fond', 'contre']) console.log(ligne(k, tot[k]));
})().catch((e) => { console.error('ÉCHEC :', e && e.stack || e); process.exit(1); });
