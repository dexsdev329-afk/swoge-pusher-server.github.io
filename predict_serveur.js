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
/* Martingale ACTIVE par defaut (demande explicite) : la mise double apres une
   perte et revient a la mise de base apres un gain — la banque bouge beaucoup
   plus, et « se rattrape »… jusqu a une serie perdante qui touche le plafond ou
   vide la caisse, la ou elle repart d une caisse neuve. C est le comportement
   voulu ET l honnetete de la page : une martingale ne se rattrape pas toujours.
   PREDICT_MART=0 revient a la mise a plat. */
const MART = process.env.PREDICT_MART !== '0';
const HISTO_MAX = 300;
const FICHIER = path.join(cfg.DATA_DIR, 'predict.json');
/* ---- LE JOURNAL EN AJOUT SEUL (A5, rapport du 26/09/2026) ----
 * Le 26 septembre, les 1 209 trades de la session 2 n'ont pu être relus que
 * par un rejeu du moteur (97 % des sens retrouvés, 84 % des issues) : le
 * serveur ne gardait que 300 trades, sans la confiance, sans égalité, et une
 * ruine effaçait la caisse. Une ligne par round résolu (label EXACT, égalité,
 * mise réelle, confiance, session), une ligne par ruine. ~250 octets par ligne,
 * 288 par jour : ~26 Mo par an. */
const JOURNAL = path.join(cfg.DATA_DIR, 'predict_journal.jsonl');
/* ---- CE QUE PAIERAIT PANCAKESWAP ----
 * Le papier paie 1:1 et une égalité ne coûte rien. PancakeSwap prend 3 % du
 * pool : à pools équilibrés la cote est 0,97 × 2 = 1,94×, un gain rapporte
 * +0,94 × la mise, une égalité donne tout le pool au trésor (perdu). Point
 * mort : 1 / 1,94 = 51,5 %. */
const PANCAKE_GAIN = 0.94;
const POINT_MORT = 100 / (1 + PANCAKE_GAIN);   /* 51,5 % */
/* ---- LA CONFIANCE, MESURÉE ----
 * Rejeu du 26/09 (17 jours, 4 732 rounds) : HIGH 46,1 % sur 1 617 (IC 43,7–48,6),
 * MEDIUM 49,7 % sur 2 342, LOW 49,9 % sur 773. Détecter 2 points au-dessus de
 * 50 % demande ~1 700 rounds par niveau : sous ce seuil, la carte dit
 * « not enough rounds (n/1,700) » et ne conclut rien. */
const CONF_MIN = 1700;
const HL = 'https://api.hyperliquid.xyz/info';

/* Le reseau, injectable pour les essais : aucun appel sortant en test. */
let _post = (body) => fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
function _reseau(fn) { _post = fn; }

let bank = neuveBanque();
let mart = neuveMart();
let S = etatNeuf();
/* `cumul` et `plat` traversent les ruines : ce sont les deux cumuls que la
 * page n'avait pas (le 26/09 à 22:06 elle aurait affiché « +2 %, 100 % » sur
 * 2 trades, deux caisses ruinées cachées derrière `sessions: 3`). `plat` joue
 * la mise de base à plat sur les MÊMES appels : le coût propre de la
 * martingale devient lisible sans l'éteindre. */
function cumulNeuf() { return { trades: 0, wins: 0, losses: 0, egal: 0, mise: 0, pl: 0, plPancake: 0, depuis: Date.now() }; }
function etatNeuf() {
  return { compteur: 0, round: null, dernier: [], sessions: 1, depuis: Date.now(), maj: 0,
           service: { ok: null, quand: 0, message: null },
           cumul: cumulNeuf(), plat: cumulNeuf(), ruines: [], ruinesAvantJournal: 0,
           parConfiance: { HIGH: { n: 0, justes: 0, egal: 0 }, MEDIUM: { n: 0, justes: 0, egal: 0 }, LOW: { n: 0, justes: 0, egal: 0 } } };
}
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
      depuis: S.depuis, round: S.round,
      cumul: S.cumul, plat: S.plat, ruines: S.ruines, ruinesAvantJournal: S.ruinesAvantJournal, parConfiance: S.parConfiance }));
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
      /* Les cumuls toutes caisses : absents d'un fichier d'avant le 27/09. Les
         ruines d'avant n'ont laissé que leur NOMBRE (sessions − 1) : on le dit
         tel quel, sans inventer leurs montants. */
      S.cumul = o.cumul || cumulNeuf();
      S.plat = o.plat || cumulNeuf();
      S.ruines = Array.isArray(o.ruines) ? o.ruines : [];
      S.ruinesAvantJournal = typeof o.ruinesAvantJournal === 'number' ? o.ruinesAvantJournal
        : (Array.isArray(o.ruines) ? 0 : Math.max(0, (o.sessions || 1) - 1));
      S.parConfiance = o.parConfiance || etatNeuf().parConfiance;
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
/* Une ligne au journal, en ajout seul. Synchrone mais minuscule (une ligne par
 * round de 5 min) ; une erreur de disque ne casse jamais le relevé. */
function journal(o) {
  try { fs.mkdirSync(path.dirname(JOURNAL), { recursive: true }); fs.appendFileSync(JOURNAL, JSON.stringify(o) + '\n'); }
  catch (e) { console.warn('[predict] journal : ' + e.message); }
}
function nouvelleSession() {
  /* La caisse ruinée est NOTÉE avant d'être remplacée : la liste des ruines et
     le cumul toutes caisses survivent, eux. */
  const st = bank.stats();
  const ruine = { session: S.sessions, t: Date.now(), trades: st.trades, wins: st.wins, losses: st.losses,
                  solde: st.solde, pl: st.pl, haut: st.haut };
  S.ruines.push(ruine);
  journal(Object.assign({ type: 'ruine' }, ruine));
  bank = neuveBanque();
  mart = neuveMart();
  S.sessions++;
  S.dernier.unshift({ session: true, t: Date.now(), sessionN: S.sessions,
    note: 'bankroll ruined — fresh paper session #' + S.sessions });
  if (S.dernier.length > HISTO_MAX) S.dernier.pop();
}

/* ---- resoudre un round sur le mouvement REEL ----
 * ÉGALITÉ (fermeture = ouverture) : `egal`, P/L 0, hors du win rate, et la
 * martingale ne bouge pas. Le 26/09 : 5 égalités sur 126 trades réels (4 %,
 * pas de 0,005 du prix médian), comptées GAGNÉES pour DOWN — DOWN flatté de
 * +3,1 points, le total de +1,6.
 * L'équivalent PancakeSwap les met à 0 et les compte à part : une égalité
 * papier n'est PAS une égalité on-chain. Elle vient du pas de 0,005 du prix
 * médian Hyperliquid ; Chainlink a 8 décimales, et la chaîne a donné 0
 * égalité sur 29 959 rounds réglés (relevé du 26/09, pancake.md). Sur
 * PancakeSwap, un mouvement de moins de 0,005 se règle ~pile ou face à
 * ~1,94× : ~−0,03 × mise, pas −1. La compter perdue biaisait le chiffre de
 * −0,97 × 4 % ≈ −3,9 % de la mise par round — plus que toute la marge de
 * 1,5 point au-dessus du point mort (53 % hors égalités + 4 % d'égalités :
 * +2,6 %/round en vrai, −1,3 % affiché). Même règle que `resumeConfiance`. */
function resous(r, prixFerme) {
  const egal = prixFerme === r.ouvre;
  const monte = prixFerme > r.ouvre;
  const gagne = !egal && ((r.sens === 'UP') === monte);
  const issue = egal ? 'egal' : gagne ? 'gagne' : 'perdu';
  const pl = egal ? 0 : gagne ? r.mise : -r.mise;
  bank.applique(pl, { sens: r.sens, mise: r.mise, gagne: gagne, egal: egal });   /* pl 0 : ni win ni loss */
  if (mart && !egal) mart.resultat(gagne);
  /* Les cumuls qui traversent les ruines : martingale (mises réelles) et plate. */
  const plPk = egal ? 0 : gagne ? PANCAKE_GAIN * r.mise : -r.mise;
  const plPlat = egal ? 0 : gagne ? MISE : -MISE, plPlatPk = egal ? 0 : gagne ? PANCAKE_GAIN * MISE : -MISE;
  for (const [c, m, a, b] of [[S.cumul, r.mise, pl, plPk], [S.plat, MISE, plPlat, plPlatPk]]) {
    c.trades++; c.mise += m; c.pl += a; c.plPancake += b;
    if (egal) c.egal++; else if (gagne) c.wins++; else c.losses++;
  }
  const niv = S.parConfiance[r.confiance];
  if (niv) { if (egal) niv.egal++; else { niv.n++; if (gagne) niv.justes++; } }
  S.dernier.unshift({ n: r.n, t: Date.now(), sens: r.sens, prob: r.prob, confiance: r.confiance || null, mise: r.mise,
    ouvre: r.ouvre, ferme: prixFerme, gagne: gagne, egal: egal, issue: issue, pl: pl, solde: bank.solde });
  if (S.dernier.length > HISTO_MAX) S.dernier.pop();
  journal({ type: 'round', n: r.n, tOuvre: r.tOuvre, tFerme: Date.now(), sens: r.sens, prob: r.prob, confiance: r.confiance || null,
            ouvre: r.ouvre, ferme: prixFerme, issue: issue, mise: r.mise, pl: pl, solde: bank.solde, session: S.sessions,
            martingale: !!mart, platPl: plPlat });
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

/* ---- les chiffres montrés, chacun avec son n ---- */
function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.round((c - m) / d * 1000) / 10, Math.round((c + m) / d * 1000) / 10];
}
const pct = (k, n) => (n ? Math.round(k / n * 1000) / 10 : null);
const arrondi = (x) => Math.round(x * 100) / 100;
function resumeCumul(c) {
  const n = c.wins + c.losses;   /* les égalités hors du taux */
  return { trades: c.trades, wins: c.wins, losses: c.losses, egal: c.egal, winRate: pct(c.wins, n), wilson: wilson(c.wins, n),
           mise: arrondi(c.mise), pl: arrondi(c.pl), plPancake: arrondi(c.plPancake), depuis: c.depuis };
}
/* Le taux mesuré par niveau de confiance. Verdict : sous CONF_MIN rien ;
 * « edge » seulement si la borne basse dépasse le point mort PancakeSwap ;
 * « worse than a coin flip » si la borne haute reste sous 50 %. */
function resumeConfiance() {
  const o = { min: CONF_MIN, pointMort: Math.round(POINT_MORT * 10) / 10, niveaux: {} };
  for (const niv of ['HIGH', 'MEDIUM', 'LOW']) {
    const c = S.parConfiance[niv] || { n: 0, justes: 0, egal: 0 };
    const w = wilson(c.justes, c.n);
    let verdict;
    if (c.n < CONF_MIN) verdict = 'not enough rounds (' + c.n + '/' + CONF_MIN.toLocaleString('en-US') + ')';
    else if (w[0] > POINT_MORT) verdict = 'edge: above the ' + (Math.round(POINT_MORT * 10) / 10) + '% PancakeSwap break-even';
    else if (w[1] < 50) verdict = 'worse than a coin flip';
    else verdict = 'coin flip';
    o.niveaux[niv] = { n: c.n, justes: c.justes, egal: c.egal, taux: pct(c.justes, c.n), wilson: w, verdict, conclut: c.n >= CONF_MIN };
  }
  return o;
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
    /* Toutes caisses confondues, jamais remis à zéro par une ruine. */
    toutesCaisses: Object.assign(resumeCumul(S.cumul), { ruines: S.ruines.length + S.ruinesAvantJournal,
                                                         ruinesAvantJournal: S.ruinesAvantJournal }),
    ruines: S.ruines.slice(-20),
    /* La mise de base à plat sur les mêmes appels, à côté de la martingale. */
    plat: Object.assign(resumeCumul(S.plat), { miseFixe: MISE }),
    /* Ce que les mêmes appels auraient rendu chez PancakeSwap (gain +0,94×),
       égalités papier exclues (artefact du pas de prix, voir resous) et
       comptées à côté : le chiffre porte sur `jugees` rounds. */
    pancakeEquivalent: { gain: PANCAKE_GAIN, pointMort: Math.round(POINT_MORT * 10) / 10,
                         plPlat: arrondi(S.plat.plPancake), plMartingale: arrondi(S.cumul.plPancake), trades: S.cumul.trades,
                         egalitesExclues: S.cumul.egal, jugees: S.cumul.trades - S.cumul.egal },
    parConfiance: resumeConfiance(),
    note: 'Paper only, shared, server-side. A heuristic on short-term direction sits near 50% — this is not an edge. Ties are not wins: they pay 0 here. A paper tie comes from the 0.005 price step of the feed; on-chain PancakeSwap ties were 0 in 29,959 rounds, so the PancakeSwap-equivalent figure leaves paper ties out and says how many.',
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
function _reset() { bank = neuveBanque(); mart = neuveMart(); S = etatNeuf(); }
function _mart() { return mart; }

module.exports = { demarre, arrete, charge, etat, tic, resous, COIN, ROUND_MS, JOURNAL, POINT_MORT, CONF_MIN, _reseau, _ref, _reset, _mart };
