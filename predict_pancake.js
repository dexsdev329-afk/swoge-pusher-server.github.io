'use strict';
/* ==========================================================================
 * PREDICT PANCAKE — ÉTAGE 1 : DEVINER LES VRAIS ROUNDS, SANS ARGENT
 *
 * « connecter son wallet comme swoge ai et que ça joue sur PancakeSwap
 *   Prediction… et faut faire attention, les côtes parfois sont pas
 *   intéressantes. »
 *
 * Ici, ZÉRO argent : on LIT le vrai contrat PancakeSwap Prediction (BNB, BSC),
 * on fait deviner le moteur (le même que la page), on calcule la côte
 * parimutuel de chaque camp, et on ne « miserait » (en papier) QUE si
 * l'espérance est positive. C'est le pont exact vers l'étage 2 (vrai wallet),
 * et ça règle d'avance le piège des côtes : une prédiction juste sur un camp
 * surchargé rend moins que le gaz — donc on saute.
 *
 * ---- LA CÔTE, LE CŒUR DU SUJET ----
 * PancakeSwap est parimutuel : les gagnants se partagent TOUT le pool (les deux
 * camps) moins 3 % de frais, au prorata de leur mise. La côte d'un camp =
 * pool_total × 0,97 / pool_de_ce_camp. Si la foule est sur ton camp, tu gagnes
 * peu (1,1×) ; si peu de monde y est, tu gagnes gros (5×). Notre mise DILUE la
 * côte (on l'ajoute au pool de notre camp) — c'est la vraie côte qu'on toucherait.
 *
 * ---- LA DÉCISION ----
 * EV = p × côte − 1 − gaz/mise. On ne « miserait » que si EV > marge. Une
 * direction pressentie sur une côte pourrie est −EV : on SAUTE, et on le compte.
 *
 * Vérifié sur la chaîne le 21 septembre : contrat 0x18B2…9cdA, rounds de 300 s,
 * frais 3 %, mise mini 0,001 BNB ; round réel côte BULL 2,30× vs BEAR 1,68×.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const E = require('./predict_moteur');   /* le même moteur que la page */

const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const ADDR = process.env.PANCAKE_PREDICTION || '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const HL = 'https://api.hyperliquid.xyz/info';
const TIC_MS = Math.max(10, Number(process.env.PREDICT_PANCAKE_TIC_S || 20)) * 1000;
const STAKE = Math.max(0.0001, Number(process.env.PREDICT_PANCAKE_STAKE || 0.01));   /* mise papier, en BNB */
const GAZ = Math.max(0, Number(process.env.PREDICT_PANCAKE_GAZ || 0.0006));           /* aller-retour bet+claim, en BNB */
const MARGE = Number(process.env.PREDICT_PANCAKE_MARGE || 0.05);                      /* EV mini pour miser (papier) */
const BANK0 = Math.max(0.001, Number(process.env.PREDICT_PANCAKE_BANK || 1));         /* caisse papier, en BNB */
const DECISION_LEAD = Math.max(10, Number(process.env.PREDICT_PANCAKE_LEAD_S || 45)); /* on décide N s avant le lock (pools quasi finaux) */

/* ---- LA MARTINGALE (papier, mesurée avant tout étage réel) ----
 * Le joueur veut « toujours se rattraper » : après un pari perdu on multiplie
 * la mise par MART_FACTEUR ; après un gagnant on repart à la base. MAIS elle ne
 * garantit RIEN — une série plus longue que MART_PALIERS, ou la caisse qui
 * plafonne, casse l'échelle : c'est un « bust », et on le COMPTE (S.mart.busts)
 * pour que la page dise la vérité. Et PancakeSwap paie souvent < 2× (parimutuel) :
 * un gain à 1,7× ne récupère pas autant qu'un doublement plein. Tout ça est
 * papier justement pour MESURER si ça tient avant d'y mettre un vrai BNB. */
const MART = process.env.PREDICT_PANCAKE_MART !== '0';                                /* défaut ON (le joueur l'a demandée) */
const MART_FACTEUR = Math.max(1.1, Number(process.env.PREDICT_PANCAKE_MART_FACTEUR || 2));
const MART_PALIERS = Math.max(1, Math.floor(Number(process.env.PREDICT_PANCAKE_MART_PALIERS || 6)));  /* au-delà : reset (bust) */
const HISTO_MAX = 200;
const FICHIER = path.join(cfg.DATA_DIR, 'predict_pancake.json');

const ABI = [
  'function currentEpoch() view returns (uint256)',
  'function treasuryFee() view returns (uint256)',
  'function rounds(uint256) view returns (uint256 epoch,uint256 startTimestamp,uint256 lockTimestamp,uint256 closeTimestamp,int256 lockPrice,int256 closePrice,uint256 lockOracleId,uint256 closeOracleId,uint256 totalAmount,uint256 bullAmount,uint256 bearAmount,uint256 rewardBaseCalAmount,uint256 rewardAmount,bool oracleCalled)',
];

/* ---- Le lecteur de chaîne, injectable pour les essais (aucun appel réel) ---- */
let _chaine = null;
function chaineReelle() {
  const { ethers } = require('ethers');
  const prov = new ethers.providers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(ADDR, ABI, prov);
  return {
    epoch: async () => (await c.currentEpoch()).toNumber(),
    fee: async () => (await c.treasuryFee()).toNumber() / 10000,   /* 300 -> 0.03 */
    round: async (ep) => {
      const r = await c.rounds(ep);
      return {
        epoch: r.epoch.toString(), lock: r.lockTimestamp.toNumber(), close: r.closeTimestamp.toNumber(),
        lockPrice: r.lockPrice.toString(), closePrice: r.closePrice.toString(),
        bull: Number(ethers.utils.formatEther(r.bullAmount)),
        bear: Number(ethers.utils.formatEther(r.bearAmount)),
        total: Number(ethers.utils.formatEther(r.totalAmount)),
        oracleCalled: r.oracleCalled,
      };
    },
  };
}
function chaine() { if (!_chaine) _chaine = chaineReelle(); return _chaine; }
function _chaineTest(obj) { _chaine = obj; }

/* ---- Les bougies BNB (pour la prédiction), injectable aussi ---- */
let _bougies = async (iv) => {
  const now = Date.now();
  const sec = iv === '1m' ? 60 : iv === '5m' ? 300 : iv === '15m' ? 900 : 3600;
  const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'BNB', interval: iv, startTime: now - sec * 1000 * 300, endTime: now } }) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const a = await r.json();
  return (Array.isArray(a) ? a : []).map((c) => ({ o: +c.o, c: +c.c, h: +c.h, l: +c.l, v: +c.v }));
};
function _reseau(fn) { _bougies = fn; }

async function predit() {
  const moteur = new E.PredictionEngine();
  const parIv = {};
  for (const iv of ['1m', '5m', '15m', '1h']) { try { parIv[iv] = await _bougies(iv); } catch (e) { parIv[iv] = []; } }
  const multi = moteur.multiHorizons(parIv);
  return (multi['5m'] && multi['5m'].assez) ? multi['5m'] : moteur.evalue(parIv['5m'] || []);
}

/* ---- L'état, persistant ---- */
let S = { bank: BANK0, wins: 0, losses: 0, skips: 0, mises: 0, pl: 0,
          enAttente: {}, dernier: [], depuis: Date.now(), maj: 0, fee: 0.03,
          round: null, service: { ok: null, quand: 0, message: null },
          miseCourante: STAKE, mart: { palier: 0, palierMax: 0, busts: 0 } };
let boucle = null;

function sauve() {
  try {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S));
    fs.renameSync(tmp, FICHIER);
  } catch (e) { console.warn('[pancake] sauvegarde : ' + e.message); }
}
function charge() {
  try { const o = JSON.parse(fs.readFileSync(FICHIER, 'utf8')); if (o && typeof o.bank === 'number') S = Object.assign(S, o); }
  catch (e) { /* premier démarrage */ }
}
function note(ok, m) { S.service = { ok, quand: Date.now(), message: m || null }; }

/* La côte parimutuel d'un camp, NOTRE mise incluse (elle dilue la côte).
 * `stake` par défaut à la mise de base : la martingale passe une mise plus grosse. */
function cote(sideAmt, total, fee, stake) {
  const s = stake > 0 ? stake : STAKE;
  const a = sideAmt + s, t = total + s;
  return a > 0 ? (t * (1 - fee)) / a : null;
}

/* La décision, sur un round en cours de mise. `stake` = la mise (martingale incluse). */
function decide(pred, r, fee, stake) {
  const s = stake > 0 ? stake : STAKE;
  const side = pred.sens === 'UP' ? 'BULL' : pred.sens === 'DOWN' ? 'BEAR' : null;
  if (!side || !pred.assez) return { side: side, wouldBet: false, cote: null, ev: null, mise: s, raison: 'no clear prediction' };
  const m = cote(side === 'BULL' ? r.bull : r.bear, r.total, fee, s);
  if (m == null) return { side, wouldBet: false, cote: null, ev: null, mise: s, raison: 'empty side' };
  const p = pred.prob / 100;
  const ev = p * m - 1 - GAZ / s;
  return { side, cote: Math.round(m * 100) / 100, ev: Math.round(ev * 1000) / 1000, prob: pred.prob, mise: Math.round(s * 1e6) / 1e6,
           wouldBet: ev > MARGE,
           raison: ev > MARGE ? 'EV +' + Math.round(ev * 100) + '% at ' + m.toFixed(2) + 'x'
                              : 'skip: EV ' + Math.round(ev * 100) + '% — the ' + m.toFixed(2) + 'x payout is not worth it' };
}

/* L'échelle martingale, PURE et partagée (étage 1 papier ET étage 2 réel) :
 * elle fait avancer `mart` ({palier, palierMax, busts}) selon l'issue et rend la
 * PROCHAINE mise. Un gagnant remet à la base ; un perdant monte d'un palier
 * (mise × facteur) ; au-delà de `paliers` on casse et on repart (bust compté).
 * Bornée par la caisse : on ne mise jamais plus qu'on n'a. Un seul endroit où
 * la martingale est écrite — c'est la règle mesurée, elle ne doit exister qu'ici. */
function prochaineMise(mart, issue, o) {
  const base = o.base, facteur = o.facteur, paliers = o.paliers, bank = o.bank;
  if (issue === 'win') { mart.palier = 0; }
  else if (issue === 'loss') {
    mart.palier++;
    if (mart.palier > paliers) { mart.busts++; mart.palier = 0; }
  } /* refund : l'échelle ne bouge pas (mise rendue) */
  if (mart.palier > mart.palierMax) mart.palierMax = mart.palier;
  const voulue = base * Math.pow(facteur, mart.palier);
  return Math.round(Math.min(voulue, Math.max(base, bank)) * 1e6) / 1e6;
}

/* L'échelle appliquée à l'état papier de l'étage 1. Sans martingale, mise à plat. */
function escalade(issue) {
  if (!MART) { S.miseCourante = STAKE; return; }
  S.miseCourante = prochaineMise(S.mart, issue, { base: STAKE, facteur: MART_FACTEUR, paliers: MART_PALIERS, bank: S.bank });
}

/* Résoudre un round fermé pour lequel on avait décidé. */
function resous(ep, r, fee) {
  const d = S.enAttente[ep];
  if (!d) return;
  delete S.enAttente[ep];
  const stake = d.mise > 0 ? d.mise : STAKE;   /* la mise réellement engagée (martingale) */
  const lp = Number(r.lockPrice), cp = Number(r.closePrice);
  const gagnant = cp > lp ? 'BULL' : cp < lp ? 'BEAR' : 'TIE';
  let issue = 'skip', pl = 0;
  if (d.wouldBet) {
    const mFinal = cote(d.side === 'BULL' ? r.bull : r.bear, r.total, fee, stake);
    if (gagnant === 'TIE') { issue = 'refund'; pl = -GAZ; }
    else if (gagnant === d.side) { issue = 'win'; pl = (mFinal - 1) * stake - GAZ; S.wins++; }
    else { issue = 'loss'; pl = -stake - GAZ; S.losses++; }
    if (issue !== 'refund') S.mises++;
    S.bank += pl; S.pl += pl;
    escalade(issue);   /* la martingale monte/redescend selon l'issue */
  } else { S.skips++; }
  S.dernier.unshift({ epoch: ep, side: d.side, cote: d.cote, ev: d.ev, prob: d.prob, mise: Math.round(stake * 1e6) / 1e6,
    gagnant, issue, pl: Math.round(pl * 1e6) / 1e6, coteFinale: cote(d.side === 'BULL' ? r.bull : r.bear, r.total, fee, stake),
    bank: Math.round(S.bank * 1e6) / 1e6, palier: S.mart.palier, t: Date.now() });
  if (S.dernier.length > HISTO_MAX) S.dernier.pop();
}

async function tic() {
  try {
    const ch = chaine();
    const now = Math.floor(Date.now() / 1000);
    S.fee = await ch.fee();
    const e = await ch.epoch();
    /* Le round en cours de MISE est `e` : on décide une fois, près du lock. */
    const rEnCours = await ch.round(e);
    S.round = { epoch: e, lock: rEnCours.lock, bull: rEnCours.bull, bear: rEnCours.bear,
                total: rEnCours.total, coteBull: cote(rEnCours.bull, rEnCours.total, S.fee),
                coteBear: cote(rEnCours.bear, rEnCours.total, S.fee) };
    if (!S.enAttente[e] && rEnCours.lock && now >= rEnCours.lock - DECISION_LEAD && now < rEnCours.lock) {
      const p = await predit();
      const d = decide(p, rEnCours, S.fee, S.miseCourante);   /* la mise du moment = base × échelle martingale */
      S.enAttente[e] = d;
      S.round.decision = d;
    } else if (S.enAttente[e]) {
      S.round.decision = S.enAttente[e];
    }
    /* Les rounds fermés récents : on résout ceux qu'on avait décidés. */
    for (const ep of Object.keys(S.enAttente)) {
      const n = Number(ep);
      if (n >= e - 1) continue;                 /* pas encore fermé */
      try { const rc = await ch.round(n); if (rc.oracleCalled) resous(n, rc, S.fee); } catch (x) {}
    }
    S.maj = Date.now(); note(true); sauve();
  } catch (e) { note(false, String(e.message || e).slice(0, 90)); }
}

function etat() {
  const n = S.wins + S.losses;
  return {
    marche: 'BNB', contrat: ADDR, roundSec: 300, paper: true, fee: S.fee,
    mise: STAKE, gaz: GAZ, marge: MARGE, depuis: S.depuis, maj: S.maj,
    enPause: process.env.PREDICT_PANCAKE !== '1',
    service: S.service,
    round: S.round,
    banque: { depart: BANK0, solde: Math.round(S.bank * 1e6) / 1e6, pl: Math.round(S.pl * 1e6) / 1e6,
              roi: Math.round((S.bank / BANK0 - 1) * 1000) / 10, unite: 'BNB',
              wins: S.wins, losses: S.losses, skips: S.skips, mises: S.mises,
              winRate: n ? Math.round(S.wins / n * 1000) / 10 : 0 },
    martingale: { on: MART, facteur: MART_FACTEUR, paliers: MART_PALIERS,
                  palier: S.mart.palier, palierMax: S.mart.palierMax, busts: S.mart.busts,
                  miseCourante: Math.round(S.miseCourante * 1e6) / 1e6 },
    dernier: S.dernier.slice(0, 40),
    note: MART
      ? 'Paper only. Martingale on: after a losing bet the stake ×' + MART_FACTEUR + ', reset after a win, capped at ' + MART_PALIERS + ' steps (past that the ladder busts — counted). It does NOT guarantee recovery: a long streak, or the bank capping the stake, breaks it, and PancakeSwap often pays under 2× so a win recovers less than a full double. Kept paper to measure whether it survives before any real BNB.'
      : 'Paper only — reads the real PancakeSwap rounds and payouts, bets nothing. It skips a round when the payout (côte) makes the bet negative-EV.',
  };
}

function demarre() { charge(); if (boucle) return; tic(); boucle = setInterval(tic, TIC_MS); if (boucle.unref) boucle.unref(); }
function arrete() { if (boucle) { clearInterval(boucle); boucle = null; } }
function _reset() { S = { bank: BANK0, wins: 0, losses: 0, skips: 0, mises: 0, pl: 0, enAttente: {}, dernier: [], depuis: Date.now(), maj: 0, fee: 0.03, round: null, service: { ok: null, quand: 0, message: null }, miseCourante: STAKE, mart: { palier: 0, palierMax: 0, busts: 0 } }; }

module.exports = { demarre, arrete, charge, etat, tic, decide, cote, resous, predit, prochaineMise,
                   ADDR, RPC, STAKE, GAZ, MARGE, MART, MART_FACTEUR, MART_PALIERS,
                   _chaineTest, _reseau, _reset, _S: () => S };
