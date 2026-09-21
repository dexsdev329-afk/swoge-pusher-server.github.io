'use strict';
/* ==========================================================================
 * PREDICT — LE RELEVE PARTAGE, COMME LA COLONIE
 *
 * « faut tu fasse colle si ça jouais vraiment noter le win raté les perte
 *   gain de la banque comme Swoge ai. »
 *
 * La page swoge_predict.html montrait un pari papier qui repartait de zero a
 * chaque rechargement, propre a chaque visiteur. Ici le pari tourne UNE fois,
 * sur le serveur, en continu, et son releve — win / raté, gains / pertes de la
 * banque — PERSISTE sur le disque et se sert a tout le monde par /predict/etat.
 * C'est exactement le modele de la colonie : un seul bot, un seul releve
 * partage, qui s'accumule dans le temps.
 *
 * TOUT est papier. Aucune cle, aucun ordre, aucune transaction ne part d'ici.
 * Le marche est le BNB (celui de PancakeSwap Prediction), le prix vient
 * d'Hyperliquid. Un round : prix a l'ouverture contre prix a la fermeture,
 * tranche par le mouvement REEL. Le moteur (predict_moteur.js, le meme que la
 * page) predit UP/DOWN ; on mise a plat, sans martingale par defaut, pour que
 * le releve soit un vrai historique de long terme et non une ruine toutes les
 * heures.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const E = require('./predict_moteur');   /* moteur vendu depuis le depot du site */

const COIN = (process.env.PREDICT_COIN || 'BNB').toUpperCase();
const ROUND_MS = Math.max(30, Number(process.env.PREDICT_ROUND_S || 300)) * 1000;  /* 5 min = PancakeSwap */
const TIC_MS = Math.max(5, Number(process.env.PREDICT_TIC_S || 15)) * 1000;
const BANK0 = Math.max(1, Number(process.env.PREDICT_BANK || 1000));
const MISE = Math.max(0.01, Number(process.env.PREDICT_BET || 10));
const MART = process.env.PREDICT_MART === '1';   /* a plat par defaut : un releve, pas un feu d'artifice */
const HISTO_MAX = 300;
const FICHIER = path.join(cfg.DATA_DIR, 'predict.json');
const HL = 'https://api.hyperliquid.xyz/info';

/* Le reseau, injectable pour les essais : aucun appel sortant en test. */
let _post = (body) => fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
function _reseau(fn) { _post = fn; }

let bank = neuveBanque();
let mart = neuveMart();
let S = { compteur: 0, round: null, dernier: [], sessions: 1, depuis: Date.now(), maj: 0,
          service: { ok: null, quand: 0, message: null } };
let boucle = null;

function neuveBanque() { return new E.BankrollManager(BANK0); }
function neuveMart() { return MART ? new E.MartingaleEngine({ initial: MISE, mult: 2, maxBet: MISE * 16, maxPertes: 6 }) : null; }

/* ---- persistance : atomique, bornee ---- */
function serialiseBanque(b) {
  return { depart: b.depart, solde: b.solde, haut: b.haut, bas: b.bas, gains: b.gains, pertes: b.pertes,
           wins: b.wins, losses: b.losses, serie: b.serie, histo: b.histo.slice(-HISTO_MAX) };
}
function restaureBanque(o) {
  const b = new E.BankrollManager(o.depart || BANK0);
  b.solde = o.solde; b.haut = o.haut; b.bas = o.bas; b.gains = o.gains || 0; b.pertes = o.pertes || 0;
  b.wins = o.wins || 0; b.losses = o.losses || 0; b.serie = o.serie || 0;
  b.histo = Array.isArray(o.histo) ? o.histo : [];
  return b;
}
function sauve() {
  try {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, banque: serialiseBanque(bank),
      compteur: S.compteur, dernier: S.dernier.slice(0, HISTO_MAX), sessions: S.sessions,
      depuis: S.depuis, round: S.round }));
    fs.renameSync(tmp, FICHIER);
  } catch (e) { console.warn('[predict] sauvegarde : ' + e.message); }
}
function charge() {
  try {
    const o = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
    if (o && o.banque) {
      bank = restaureBanque(o.banque);
      S.compteur = o.compteur || 0;
      S.dernier = Array.isArray(o.dernier) ? o.dernier : [];
      S.sessions = o.sessions || 1;
      S.depuis = o.depuis || Date.now();
      S.round = o.round || null;
    }
  } catch (e) { /* pas de fichier : premier demarrage, banque neuve */ }
}

function note(ok, message) { S.service = { ok: ok, quand: Date.now(), message: message || null }; }

/* ---- le prix et les bougies, chez Hyperliquid ---- */
async function prixSpot() {
  const m = await _post({ type: 'allMids' });
  const p = Number(m && m[COIN]);
  return p > 0 ? p : null;
}
async function bougies(iv) {
  const now = Date.now();
  const sec = iv === '1m' ? 60 : iv === '5m' ? 300 : iv === '15m' ? 900 : 3600;
  const a = await _post({ type: 'candleSnapshot', req: { coin: COIN, interval: iv, startTime: now - sec * 1000 * 300, endTime: now } });
  return (Array.isArray(a) ? a : []).map((c) => ({ o: +c.o, c: +c.c, h: +c.h, l: +c.l, v: +c.v }));
}
async function predit() {
  const moteur = new E.PredictionEngine();
  const parIv = {};
  for (const iv of ['1m', '5m', '15m', '1h']) { try { parIv[iv] = await bougies(iv); } catch (e) { parIv[iv] = []; } }
  const multi = moteur.multiHorizons(parIv);
  return (multi['5m'] && multi['5m'].assez) ? multi['5m'] : moteur.evalue(parIv['5m'] || []);
}

/* ---- la banque ruinee repart d'une caisse neuve, et on le NOTE ---- */
function nouvelleSession() {
  bank = neuveBanque();
  mart = neuveMart();
  S.sessions++;
  S.dernier.unshift({ session: true, t: Date.now(), sessionN: S.sessions,
    note: 'bankroll ruined — fresh paper session #' + S.sessions });
  if (S.dernier.length > HISTO_MAX) S.dernier.pop();
}

/* ---- resoudre un round sur le mouvement REEL ---- */
function resous(r, prixFerme) {
  const monte = prixFerme > r.ouvre;
  const gagne = (r.sens === 'UP') === monte;
  const pl = gagne ? r.mise : -r.mise;
  bank.applique(pl, { sens: r.sens, mise: r.mise, gagne: gagne });
  if (mart) mart.resultat(gagne);
  S.dernier.unshift({ n: r.n, t: Date.now(), sens: r.sens, prob: r.prob, mise: r.mise,
    ouvre: r.ouvre, ferme: prixFerme, gagne: gagne, pl: pl, solde: bank.solde });
  if (S.dernier.length > HISTO_MAX) S.dernier.pop();
}

/* ---- un tic : resoudre l'echu, ouvrir le suivant ---- */
async function tic() {
  try {
    const now = Date.now();
    const prix = await prixSpot();
    if (!prix) { note(false, 'no price'); return; }
    let bouge = false;
    if (S.round && now >= S.round.tFerme) { resous(S.round, prix); S.round = null; bouge = true; }
    if (!S.round) {
      const p = await predit();
      if (p && p.assez && p.sens !== 'NEUTRAL') {
        let mise = mart ? mart.prochaine(bank.solde) : Math.min(MISE, bank.solde);
        if (mise <= 0 || bank.solde < MISE) { nouvelleSession(); mise = Math.min(MISE, bank.solde); }
        S.compteur++;
        S.round = { n: S.compteur, ouvre: prix, sens: p.sens, prob: p.prob, confiance: p.confiance,
                    mise: mise, tOuvre: now, tFerme: now + ROUND_MS };
        bouge = true;
      }
    }
    S.maj = now; note(true);
    if (bouge) sauve();
  } catch (e) { note(false, String(e.message || e).slice(0, 80)); }
}

/* ---- ce que la page lit : le releve partage ---- */
function etat() {
  const s = bank.stats();
  return {
    coin: COIN, paper: true, roundSec: ROUND_MS / 1000, martingale: !!mart,
    miseInitiale: MISE, depuis: S.depuis, maj: S.maj, sessions: S.sessions,
    enPause: process.env.PREDICT_AI !== '1',
    service: S.service,
    round: S.round ? { n: S.round.n, sens: S.round.sens, prob: S.round.prob, confiance: S.round.confiance,
                       mise: S.round.mise, ouvre: S.round.ouvre, tFerme: S.round.tFerme } : null,
    banque: s,   /* solde, pl, roi, winRate, lossRate, trades, wins, losses, serie, haut, bas, drawdownMax, depart */
    dernier: S.dernier.slice(0, 60),
    courbe: bank.histo.slice(-60).map((x) => x.solde),
    note: 'Paper only, shared, server-side. A heuristic on short-term direction sits near 50% — this is not an edge.',
  };
}

function demarre() {
  charge();
  if (boucle) return;
  tic();
  boucle = setInterval(tic, TIC_MS);
  if (boucle.unref) boucle.unref();
}
function arrete() { if (boucle) { clearInterval(boucle); boucle = null; } }

/* Pour les essais : etat interne, remise a zero, un tic manuel. */
function _ref() { return S; }
function _reset() { bank = neuveBanque(); mart = neuveMart(); S = { compteur: 0, round: null, dernier: [], sessions: 1, depuis: Date.now(), maj: 0, service: { ok: null, quand: 0, message: null } }; }

module.exports = { demarre, arrete, charge, etat, tic, COIN, ROUND_MS, _reseau, _ref, _reset };
