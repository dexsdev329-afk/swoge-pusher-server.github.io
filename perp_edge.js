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
 * L'edge de DIRECTION (prix) est mesuré d'abord ; puis, depuis le 23 septembre
 * 2026, le NET : on retranche les frais aller-retour Bitget (maker 0,04 % /
 * taker 0,12 %) ET le financement réel lu sur l'historique Bitget (toutes les
 * 8 h). C'est le net qui décide — un edge brut sous le coût aller-retour n'est
 * pas un edge. On compare quatre directions :
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

/* ---- LE COÛT RÉEL : frais aller-retour + financement (23 septembre 2026) ----
 * Le brut ci-dessus est le prix seul. Un edge ne compte que NET. Frais Bitget
 * USDT-M (grille publique, vérifiée le 23/09/2026) : taker 0,06 %/côté, maker
 * 0,02 %/côté → aller-retour 0,12 % (taker) ou 0,04 % (maker). Le financement
 * se paie toutes les 8 h (00/08/16 UTC) ; un long paie quand le taux est
 * positif, un short l'encaisse. On le lit sur l'historique Bitget, on ne le
 * devine plus. */
const FRAIS_TK = Number(process.env.PERP_FRAIS_TAKER || 0.06) * 2;   /* aller-retour %, taker */
const FRAIS_MK = Number(process.env.PERP_FRAIS_MAKER || 0.02) * 2;   /* aller-retour %, maker */
/* MESURÉ le 23 septembre 2026 (n=13 923 trades, 31 j, BTC/ETH/SOL/XRP/DOGE,
 * financement réel Bitget) : le financement moyen par trade est ~0 % — la
 * stratégie prend longs ET shorts, les taux s'annulent, ce n'est PAS la
 * traînée redoutée. Le coût qui mord est le frais aller-retour. Résultat net
 * par trade : géométrie 4σ/6σ → +0,110 % maker, +0,030 % taker ; 4σ/5σ →
 * +0,086 % maker ; 3σ/5σ (actuelle) → +0,048 % maker mais −0,032 % taker.
 * Verdict : en MAKER l'edge est net-positif dès l'actuel, et 4σ/6σ l'est même
 * en taker. La rentabilité tient à l'exécution (maker) + une sortie plus large
 * (4σ/6σ), pas à un nouveau signal. */

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

/* L'historique du financement (taux toutes les 8 h), trié par temps croissant.
   100 points × 8 h = 33 j, assez pour couvrir la fenêtre de bougies. */
async function financementHist(sym) {
  const u = BASE + '/history-fund-rate?symbol=' + sym + '&productType=' + PRODUIT + '&pageSize=100';
  const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status + ' financement ' + sym);
  const j = await r.json();
  return (j.data || []).map((d) => ({ t: +d.fundingTime, taux: +d.fundingRate }))
    .filter((d) => isFinite(d.taux)).sort((a, b) => a.t - b.t);
}
/* Le financement payé sur une position, en % du notionnel. Un long (sens>0)
   PAIE le taux positif ; un short l'ENCAISSE. Coût = +sens × taux à chaque
   règlement traversé dans (tEntree, tSortie]. Rendu en % (positif = coûte). */
function coutFinancement(fund, sens, tEntree, tSortie) {
  let somme = 0;
  for (const f of fund) { if (f.t > tEntree && f.t <= tSortie) somme += f.taux; }
  return sens * somme * 100;
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
function issue(sens, prix, vol, avenir, stopV, cibleV) {
  const sv = stopV || STOP_VOL, cv = cibleV || CIBLE_VOL;
  const stop = prix * (1 - sens * sv * vol / 100);
  const cible = prix * (1 + sens * cv * vol / 100);
  for (let k = 0; k < avenir.length && k < TENUE_BARS; k++) {
    const bar = avenir[k];
    if (sens > 0) {
      if (bar.b <= stop) return { g: -1, brut: (stop - prix) / prix * 100 * sens, sortT: bar.t };
      if (bar.h >= cible) return { g: 1, brut: (cible - prix) / prix * 100 * sens, sortT: bar.t };
    } else {
      if (bar.h >= stop) return { g: -1, brut: (stop - prix) / prix * 100 * sens, sortT: bar.t };
      if (bar.b <= cible) return { g: 1, brut: (cible - prix) / prix * 100 * sens, sortT: bar.t };
    }
  }
  const dern = avenir[Math.min(avenir.length, TENUE_BARS) - 1];
  if (!dern) return null;
  const brut = (dern.c - prix) / prix * 100 * sens;
  return { g: brut > 0 ? 1 : -1, brut, temps: true, sortT: dern.t };
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

/* Le régime (comme le trait `regime` du bot) et la force du fond (4 h). */
function regimeDe(vol) { return vol < 0.08 ? 'calme' : vol < 0.18 ? 'normal' : vol < 0.35 ? 'agite' : 'tempete'; }
function fondBucket(f) { const a = Math.abs(f); return a < 1 ? 'plat <1%' : a < 4 ? 'moyen 1-4%' : 'fort >4%'; }

function agrege() { return { n: 0, cible: 0, stop: 0, temps: 0, gagne: 0, brut: 0, fund: 0, netMk: 0, netTk: 0 }; }
function ajoute(a, r) {
  a.n++; if (r.g > 0) a.gagne++; if (r.temps) a.temps++; else if (r.g > 0) a.cible++; else a.stop++;
  a.brut += r.brut;
  const fund = (typeof r.fund === 'number') ? r.fund : 0;   /* coût de financement %, 0 si non calculé */
  a.fund += fund;
  a.netMk += r.brut - fund - FRAIS_MK;   /* net d'aller-retour maker + financement réel */
  a.netTk += r.brut - fund - FRAIS_TK;   /* net d'aller-retour taker + financement réel */
}
function ligne(nom, a) {
  if (!a.n) return '  ' + nom.padEnd(9) + '  (aucune entrée)';
  const w = (a.gagne / a.n * 100), mb = (a.brut / a.n);
  const verdict = w >= BARRIERE_PM ? 'AU-DESSUS du hasard' : 'sous le hasard';
  return '  ' + nom.padEnd(9) + '  n=' + String(a.n).padStart(4)
    + '  gagné ' + w.toFixed(1).padStart(5) + '%  (pt mort ' + BARRIERE_PM.toFixed(1) + '%)  '
    + 'brut moy ' + (mb >= 0 ? '+' : '') + mb.toFixed(3) + '%  · ' + verdict;
}
/* La ligne NETTE : brut, financement moyen, puis net maker et net taker par
   trade. Le signe du net décide — un edge n'existe que s'il franchit zéro. */
function ligneNet(nom, a) {
  if (!a.n) return '  ' + nom.padEnd(11) + '  (aucune entrée)';
  const mb = a.brut / a.n, mf = a.fund / a.n, nmk = a.netMk / a.n, ntk = a.netTk / a.n;
  const sg = (v) => (v >= 0 ? '+' : '') + v.toFixed(3) + '%';
  return '  ' + nom.padEnd(11) + '  n=' + String(a.n).padStart(4)
    + '  brut ' + sg(mb).padStart(8) + '  financ ' + sg(mf).padStart(8)
    + '  NET maker ' + sg(nmk).padStart(8) + (nmk > 0 ? ' ✅' : ' ❌')
    + '  · net taker ' + sg(ntk).padStart(8) + (ntk > 0 ? ' ✅' : ' ❌');
}

(async () => {
  console.log('PERP EDGE — edge de DIRECTION (brut, prix seul) PUIS net (frais + financement réel)');
  console.log('Point mort d\'une marche aléatoire (stop 3σ / cible 5σ) = ' + BARRIERE_PM.toFixed(1) + '% de réussite\n');
  const tot = { note: agrege(), trend: agrege(), fond: agrege(), contre: agrege() };
  /* Pour la direction gagnante (trend), on découpe par régime et par force du
     fond : on cherche OÙ la tendance paie, pour ne la prendre que là. */
  const parReg = {}, parFnd = {};
  /* Balayage de la géométrie de sortie (stop σ / cible σ) sur la tendance :
     on cherche celle qui maximise l'espérance par trade (brut moyen). */
  const GEOMS = [[2, 3], [2, 4], [2.5, 4], [3, 4], [3, 5], [3, 6], [4, 5], [4, 6], [2.5, 5]];
  const sweep = {}; GEOMS.forEach((g) => sweep[g.join('/')] = agrege());
  for (const sym of SYMBOLES) {
    let c15, c4;
    try { c15 = await candles(sym, '15m', Math.max(300, Number(process.env.PERP_EDGE_VISE || 3000))); c4 = await candles(sym, '4H', 200); }
    catch (e) { console.log(sym + ' : lecture ratée — ' + e.message); continue; }
    let fund = [];
    try { fund = await financementHist(sym); }
    catch (e) { console.log(sym + ' : financement raté — ' + e.message + ' (net calculé hors financement)'); }
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
      const tEntree = c15[i].t;
      const dirs = {
        note: noteDir(x),
        trend: x.ecartEma > 0 ? 1 : x.ecartEma < 0 ? -1 : 0,
        fond: x.fond > 0 ? 1 : x.fond < 0 ? -1 : 0,
        contre: x.ecartEma > 0 ? -1 : x.ecartEma < 0 ? 1 : 0,
      };
      for (const k of Object.keys(dirs)) {
        const s = dirs[k]; if (!s) continue;
        const r = issue(s, x.prix, vol, avenir); if (!r) continue;
        r.fund = coutFinancement(fund, s, tEntree, r.sortT);
        ajoute(par[k], r); ajoute(tot[k], r);
      }
      /* Découpe de la tendance par régime et par force du fond. */
      if (dirs.trend) {
        const r = issue(dirs.trend, x.prix, vol, avenir);
        if (r) {
          r.fund = coutFinancement(fund, dirs.trend, tEntree, r.sortT);
          const rg = regimeDe(vol), fb = fondBucket(x.fond);
          (parReg[rg] || (parReg[rg] = agrege())) && ajoute(parReg[rg], r);
          (parFnd[fb] || (parFnd[fb] = agrege())) && ajoute(parFnd[fb], r);
        }
        for (const g of GEOMS) { const rg2 = issue(dirs.trend, x.prix, vol, avenir, g[0], g[1]); if (rg2) { rg2.fund = coutFinancement(fund, dirs.trend, tEntree, rg2.sortT); ajoute(sweep[g.join('/')], rg2); } }
      }
    }
    console.log(sym.replace('USDT', '') + ' (' + (c15.length) + ' bougies 15 min ≈ ' + Math.round(c15.length / 96) + ' j)');
    for (const k of ['note', 'trend', 'fond', 'contre']) console.log(ligne(k, par[k]));
    console.log('');
  }
  console.log('TOUS MARCHÉS CONFONDUS');
  for (const k of ['note', 'trend', 'fond', 'contre']) console.log(ligne(k, tot[k]));

  console.log('\nLA TENDANCE, DÉCOUPÉE PAR RÉGIME (où elle paie)');
  for (const rg of ['calme', 'normal', 'agite', 'tempete']) if (parReg[rg]) console.log(ligne(rg, parReg[rg]));
  console.log('\nLA TENDANCE, DÉCOUPÉE PAR FORCE DU FOND (4 h)');
  for (const fb of ['plat <1%', 'moyen 1-4%', 'fort >4%']) if (parFnd[fb]) console.log(ligne(fb, parFnd[fb]));
  console.log('\nGÉOMÉTRIE DE SORTIE (stop σ / cible σ) — celle qui maximise le brut moyen gagne');
  const clas = GEOMS.map((g) => g.join('/')).sort((a, b) => (sweep[b].brut / sweep[b].n) - (sweep[a].brut / sweep[a].n));
  for (const key of clas) console.log(ligne(key + (key === '3/5' ? ' (actuel)' : ''), sweep[key]));

  /* ---- LE VERDICT NET : le brut ne compte pas, seul le net décide ---- */
  console.log('\nNET PAR TRADE (frais aller-retour Bitget maker ' + FRAIS_MK.toFixed(2) + '% / taker ' + FRAIS_TK.toFixed(2) + '% + financement réel)');
  console.log('  — la décision du bot et la tendance, tous marchés :');
  for (const k of ['note', 'trend']) console.log(ligneNet(k, tot[k]));
  console.log('  — par géométrie de sortie (classée par net maker) :');
  const clasNet = GEOMS.map((g) => g.join('/')).sort((a, b) => (sweep[b].netMk / sweep[b].n) - (sweep[a].netMk / sweep[a].n));
  for (const key of clasNet) console.log(ligneNet(key + (key === '3/5' ? ' (actuel)' : ''), sweep[key]));
})().catch((e) => { console.error('ÉCHEC :', e && e.stack || e); process.exit(1); });
