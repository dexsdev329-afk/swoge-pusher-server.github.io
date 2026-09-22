'use strict';
/* ==========================================================================
 * PREDICT PANCAKE — ÉTAGE 2 : LE VRAI JEU, AVEC DE VRAIS BNB
 *
 * « faire une réelle connexion au jeu… comme SWOGE AI. » L'étage 1
 * (`predict_pancake.js`) LIT les vrais rounds et ne mise RIEN — il mesure. Ici,
 * on MISE réellement : on signe `betBull`/`betBear` sur le contrat PancakeSwap
 * Prediction (BNB, BSC), et on réclame (`claim`) les gains.
 *
 * ---- LE MODÈLE : le portefeuille miroir de SWOGE AI, mais ISOLÉ ----
 * Comme le miroir de la colonie, une clé vit chiffrée dans un registre à part
 * (jamais dans `state.json`, jamais dans le canal Telegram), et le serveur signe
 * pour le joueur. MAIS c'est un portefeuille DÉDIÉ à PancakeSwap : le miroir de
 * SWOGE AI tourne sur la chaîne Robinhood, PancakeSwap est sur BSC — deux
 * chaînes, deux caisses. Un bug ici ne peut donc PAS toucher les fonds du miroir
 * de la colonie, et l'inverse est vrai. C'est le choix du propriétaire (isolé).
 *
 * ---- CE QUI DÉCLENCHE UN VRAI PARI — les trois verrous ----
 *   1. `PREDICT_PANCAKE_EXECUTE=1` posé sur l'hôte (comme `MIROIR_EXECUTE`).
 *   2. l'adresse de la session est dans `AI_OWNER` (revérifié CÔTÉ SERVEUR).
 *   3. le joueur a pressé « Play » (`actif`).
 * Il en manque un → tout est en SIMULATION : on décide, on journalise, rien ne
 * part sur la chaîne. Défaut : ÉTEINT. Aucune clé, aucun ordre sans les trois.
 *
 * ---- LA DÉCISION ET LA MISE ----
 * Exactement l'étage 1 : la porte EV saute une côte pourrie, et la MARTINGALE
 * (`prochaineMise`, la même règle mesurée) dimensionne la mise. « Stop » réclame
 * ce qui est réclamable puis balaie le BNB restant vers le portefeuille du
 * COMPTE (l'adresse de la session), jamais vers une adresse d'un message.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const E1 = require('./predict_pancake');   /* la décision et la martingale : une seule source */

const RPC = process.env.BSC_RPC || E1.RPC;
const ADDR = process.env.PANCAKE_PREDICTION || E1.ADDR;
const CHAIN_ID = Number(process.env.BSC_CHAIN_ID || 56);
const EXECUTE = String(process.env.PREDICT_PANCAKE_EXECUTE || '0') === '1';   /* le verrou hôte, comme MIROIR_EXECUTE */
const TIC_MS = Math.max(10, Number(process.env.PREDICT_PANCAKE_TIC_S || 20)) * 1000;
const DECISION_LEAD = Math.max(10, Number(process.env.PREDICT_PANCAKE_LEAD_S || 45));
const MIN_BET = Math.max(0.001, Number(process.env.PREDICT_PANCAKE_MINBET || 0.001));   /* plancher du contrat */
const MAX_BNB = Math.max(MIN_BET, Number(process.env.PREDICT_PANCAKE_MAX_BNB || 5));    /* plafond : c'est une mise, pas un coffre */
const GAZ_RESERVE = Math.max(0, Number(process.env.PREDICT_PANCAKE_GAZ_RESERVE || 0.0004));   /* gaz gardé pour balayer */
const HISTO_MAX = 300;
const FICHIER = path.join(cfg.DATA_DIR, 'predict_pancake_reel.json');

const ABI = [
  'function currentEpoch() view returns (uint256)',
  'function treasuryFee() view returns (uint256)',
  'function minBetAmount() view returns (uint256)',
  'function paused() view returns (bool)',
  'function rounds(uint256) view returns (uint256 epoch,uint256 startTimestamp,uint256 lockTimestamp,uint256 closeTimestamp,int256 lockPrice,int256 closePrice,uint256 lockOracleId,uint256 closeOracleId,uint256 totalAmount,uint256 bullAmount,uint256 bearAmount,uint256 rewardBaseCalAmount,uint256 rewardAmount,bool oracleCalled)',
  'function ledger(uint256,address) view returns (uint8 position,uint256 amount,bool claimed)',
  'function claimable(uint256 epoch,address user) view returns (bool)',
  'function refundable(uint256 epoch,address user) view returns (bool)',
  'function betBull(uint256 epoch) payable',
  'function betBear(uint256 epoch) payable',
  'function claim(uint256[] epochs)',
];

/* ==================== LE CHIFFREMENT DES CLÉS ====================
 * Identique au miroir (AES-256-GCM + scrypt), mais SA propre clé maîtresse et
 * SON propre sel : `PREDICT_PANCAKE_CLE`. Sans elle, ce module ne crée AUCUN
 * portefeuille — écrire une clé en clair « en attendant » est le geste qu'on
 * regrette. La clé ne vit que dans l'environnement de l'hôte. */
const SEL = Buffer.from('swoge-predict-pancake-v1');
let _cleCache = null;
function cleMaitresse() {
  const brut = String(process.env.PREDICT_PANCAKE_CLE || '').trim();
  if (!brut) return null;
  if (!_cleCache || _cleCache.brut !== brut) _cleCache = { brut, cle: crypto.scryptSync(brut, SEL, 32) };
  return _cleCache.cle;
}
function chiffre(texte) {
  const k = cleMaitresse();
  if (!k) throw new Error('PREDICT_PANCAKE_CLE is not configured');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const out = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return 'v1.' + iv.toString('hex') + '.' + c.getAuthTag().toString('hex') + '.' + out.toString('hex');
}
function dechiffre(paquet) {
  const k = cleMaitresse();
  if (!k) throw new Error('PREDICT_PANCAKE_CLE is not configured');
  const m = String(paquet || '').split('.');
  if (m.length !== 4 || m[0] !== 'v1') throw new Error('unreadable key envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(m[1], 'hex'));
  d.setAuthTag(Buffer.from(m[2], 'hex'));
  return Buffer.concat([d.update(Buffer.from(m[3], 'hex')), d.final()]).toString('utf8');
}

/* ==================== LA CHAÎNE — réelle, ou injectée pour l'essai ====================
 * Un objet de haut niveau : l'étage 1 fait pareil (aucune BigNumber ne sort du
 * module). L'essai injecte un faux qui enregistre les paris sans rien signer. */
function chaineReelle() {
  const { ethers } = require('ethers');
  const prov = new ethers.providers.StaticJsonRpcProvider(RPC, CHAIN_ID);
  const lecture = new ethers.Contract(ADDR, ABI, prov);
  const F = (x) => Number(ethers.utils.formatEther(x));
  const signeur = (c) => new ethers.Contract(ADDR, ABI, new ethers.Wallet(dechiffre(c.cle), prov));
  return {
    epoch: async () => (await lecture.currentEpoch()).toNumber(),
    fee: async () => (await lecture.treasuryFee()).toNumber() / 10000,
    minBet: async () => { try { return F(await lecture.minBetAmount()); } catch (e) { return MIN_BET; } },
    paused: async () => { try { return await lecture.paused(); } catch (e) { return false; } },
    round: async (ep) => {
      const r = await lecture.rounds(ep);
      return { epoch: r.epoch.toString(), lock: r.lockTimestamp.toNumber(), close: r.closeTimestamp.toNumber(),
               lockPrice: r.lockPrice.toString(), closePrice: r.closePrice.toString(),
               bull: F(r.bullAmount), bear: F(r.bearAmount), total: F(r.totalAmount), oracleCalled: r.oracleCalled };
    },
    ledger: async (ep, addr) => {
      const l = await lecture.ledger(ep, addr);
      return { side: Number(l.position) === 0 ? 'BULL' : Number(l.position) === 1 ? 'BEAR' : null,
               montant: F(l.amount), claimed: l.claimed };
    },
    claimable: async (ep, addr) => { try { return await lecture.claimable(ep, addr); } catch (e) { return false; } },
    refundable: async (ep, addr) => { try { return await lecture.refundable(ep, addr); } catch (e) { return false; } },
    balance: async (addr) => F(await prov.getBalance(addr)),
    betBull: async (c, ep, miseBNB) => (await (await signeur(c).betBull(ep, { value: ethers.utils.parseEther(String(miseBNB)) })).wait()).transactionHash,
    betBear: async (c, ep, miseBNB) => (await (await signeur(c).betBear(ep, { value: ethers.utils.parseEther(String(miseBNB)) })).wait()).transactionHash,
    claim: async (c, eps) => (await (await signeur(c).claim(eps)).wait()).transactionHash,
    sweep: async (c, vers) => {
      const w = new ethers.Wallet(dechiffre(c.cle), prov);
      const bal = await w.getBalance();
      const prix = await prov.getGasPrice();
      const cout = prix.mul(21000);
      if (bal.lte(cout)) return { tx: null, montant: 0, vide: true };
      const montant = bal.sub(cout);
      const t = await w.sendTransaction({ to: vers, value: montant, gasLimit: 21000, gasPrice: prix });
      await t.wait();
      return { tx: t.hash, montant: F(montant), vide: false };
    },
  };
}
let _chaine = null;
function chaine() { if (!_chaine) _chaine = chaineReelle(); return _chaine; }
function _chaineTest(obj) { _chaine = obj; }

/* La prédiction : la MÊME que l'étage 1 (moteur, BNB). Injectable pour l'essai. */
let _predit = () => E1.predit();
function _predicteur(fn) { _predit = fn; }

/* ==================== LE REGISTRE (fichier à part, 0600, hors Telegram) ==================== */
let R = { v: 1, comptes: {} };
function norm(a) { return String(a || '').toLowerCase(); }
function charge() {
  try { const j = JSON.parse(fs.readFileSync(FICHIER, 'utf8')); if (j && j.comptes) R = j; }
  catch (e) { /* registre neuf */ }
  return R;
}
function sauve() {
  try {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(R), { mode: 0o600 });
    fs.renameSync(tmp, FICHIER);
  } catch (e) { console.warn('[pancake-reel] sauvegarde impossible :', e.message); }
}
function fiche(joueur) { return R.comptes[norm(joueur)] || null; }
function note(c, txt, extra) {
  c.journal = c.journal || [];
  c.journal.unshift(Object.assign({ t: Date.now(), txt: String(txt) }, extra || {}));
  if (c.journal.length > HISTO_MAX) c.journal.pop();
}
function neuf() {
  return { adr: null, cle: null, cree: 0, actif: false, joue: 0, solde: 0,
           enAttente: {}, fermees: [], journal: [], wins: 0, losses: 0, skips: 0, mises: 0, pl: 0,
           mart: { palier: 0, palierMax: 0, busts: 0 }, miseCourante: E1.STAKE };
}

/* ==================== LA VIE D'UN COMPTE ==================== */
function pret() {
  if (!cleMaitresse()) return { ok: false, pourquoi: 'PREDICT_PANCAKE_CLE is not configured on the host — no wallet is created without it' };
  return { ok: true };
}

async function cree(joueur) {
  const p = pret();
  if (!p.ok) throw new Error(p.pourquoi);
  const j = norm(joueur);
  if (!/^0x[0-9a-f]{40}$/.test(j)) throw new Error('not a player address');
  if (R.comptes[j]) throw new Error('this account already has a PancakeSwap wallet');
  const { ethers } = require('ethers');
  const w = ethers.Wallet.createRandom();
  const c = neuf();
  c.adr = w.address; c.cle = chiffre(w.privateKey); c.cree = Date.now();
  R.comptes[j] = c;
  note(c, 'PancakeSwap wallet created (BSC). Fund it with BNB to play.');
  sauve();
  return { adresse: w.address, cle: w.privateKey };   /* la clé une seule fois — jamais dans un état/journal */
}

function revele(joueur) {
  const c = fiche(joueur);
  if (!c) throw new Error('no PancakeSwap wallet on this account');
  return { adresse: c.adr, cle: dechiffre(c.cle) };   /* c'est SA clé */
}

async function demarre(joueur) {
  const c = fiche(joueur);
  if (!c) throw new Error('no PancakeSwap wallet on this account');
  if (c.actif) return { actif: true, deja: true };
  let solde = 0;
  try { solde = await chaine().balance(c.adr); c.solde = solde; } catch (e) { /* réseau : on tente quand même en simulation */ }
  if (EXECUTE) {
    if (solde < MIN_BET) throw new Error('fund the PancakeSwap wallet first — at least ' + MIN_BET + ' BNB on BSC');
    if (solde > MAX_BNB) throw new Error('over the ceiling of ' + MAX_BNB + ' BNB. This is a stake, not a vault: take some out first');
  }
  c.actif = true; c.joue = Date.now();
  note(c, EXECUTE ? 'Play — real BNB bets on BSC when the odds and the martingale say so'
                  : 'Play — dry run: PREDICT_PANCAKE_EXECUTE is off, decisions are logged, nothing is signed');
  sauve();
  return { actif: true, deja: false, execute: EXECUTE, solde: solde };
}

/** Stop : réclamer ce qui est réclamable, puis balayer le BNB restant vers le
 *  portefeuille du COMPTE (l'adresse de la session), jamais une adresse reçue. */
async function arrete(joueur, versAdresse) {
  const c = fiche(joueur);
  if (!c) throw new Error('no PancakeSwap wallet on this account');
  const vers = norm(versAdresse);
  if (!/^0x[0-9a-f]{40}$/.test(vers)) throw new Error('no destination address');
  c.actif = false;
  sauve();
  let reclames = 0, balaye = null;
  if (EXECUTE) {
    try {
      const ch = chaine();
      const aReclamer = [];
      for (const ep of Object.keys(c.enAttente)) {
        try { if (await ch.claimable(Number(ep), c.adr) || await ch.refundable(Number(ep), c.adr)) aReclamer.push(Number(ep)); } catch (e) {}
      }
      if (aReclamer.length) { await ch.claim(c, aReclamer); reclames = aReclamer.length; note(c, 'Claimed ' + reclames + ' round(s) on stop'); }
      balaye = await ch.sweep(c, vers);
      note(c, balaye.vide ? 'Stop — nothing to sweep' : ('Stop — swept ' + balaye.montant + ' BNB to the account wallet'), { tx: balaye.tx || undefined });
    } catch (e) { note(c, 'Stop — sweep failed: ' + (e.message || e)); }
  } else {
    note(c, 'Stop — dry run: nothing was signed and nothing was swept');
  }
  sauve();
  return { actif: false, execute: EXECUTE, reclames, balaye, vers };
}

/* ==================== LA DÉCISION, LA MISE, LA RÉSOLUTION ==================== */
/** Décider près du lock et, si les trois verrous sont là, MISER pour de vrai. */
async function decideEtPlace(c, ep, r, fee, ch) {
  const pred = await _predit();
  const d = E1.decide(pred, r, fee, c.miseCourante);   /* la porte EV, mise = échelle martingale */
  d.place = false; d.reel = false; d.tx = null;
  if (d.wouldBet) {
    if (d.mise < MIN_BET) { d.wouldBet = false; d.raison = 'below the ' + MIN_BET + ' BNB minimum bet'; }
    else if (EXECUTE && c.actif) {
      try {
        const bal = await ch.balance(c.adr); c.solde = bal;
        if (bal < d.mise + GAZ_RESERVE) { d.wouldBet = false; d.raison = 'not enough BNB for the stake + gas'; }
        else {
          d.tx = d.side === 'BULL' ? await ch.betBull(c, ep, d.mise) : await ch.betBear(c, ep, d.mise);
          d.place = true; d.reel = true;
          note(c, 'Bet ' + d.side + ' ' + d.mise + ' BNB on #' + ep + ' at ' + (d.cote != null ? d.cote + 'x' : '—'), { tx: d.tx, epoch: ep });
        }
      } catch (e) { d.wouldBet = false; d.raison = 'bet failed: ' + (e.message || e); note(c, 'Bet failed on #' + ep + ': ' + (e.message || e)); }
    } else {
      d.place = true; /* simulation : on aurait misé */
      note(c, '[dry run] would bet ' + d.side + ' ' + d.mise + ' BNB on #' + ep, { epoch: ep });
    }
  }
  c.enAttente[ep] = d;
  return d;
}

/** Résoudre un round fermé qu'on avait décidé : issue, P/L, martingale, claim. */
async function resous(c, ep, r, fee, ch) {
  const d = c.enAttente[ep];
  if (!d) return;
  delete c.enAttente[ep];
  const stake = d.mise > 0 ? d.mise : E1.STAKE;
  const lp = Number(r.lockPrice), cp = Number(r.closePrice);
  const gagnant = cp > lp ? 'BULL' : cp < lp ? 'BEAR' : 'TIE';
  let issue = 'skip', pl = 0, tx = null;
  if (d.wouldBet && d.place) {
    const mFinal = E1.cote(d.side === 'BULL' ? r.bull : r.bear, r.total, fee, stake);
    if (gagnant === 'TIE') { issue = 'refund'; pl = 0; }
    else if (gagnant === d.side) { issue = 'win'; pl = (mFinal - 1) * stake; c.wins++; }
    else { issue = 'loss'; pl = -stake; c.losses++; }
    if (issue !== 'refund') c.mises++;
    c.pl += pl;
    /* Réclamer le gain / le remboursement réel (les fonds reviennent au wallet). */
    if (d.reel && issue !== 'loss') {
      try { if (await ch.claimable(ep, c.adr) || await ch.refundable(ep, c.adr)) { tx = await ch.claim(c, [ep]); note(c, 'Claimed #' + ep, { tx }); } }
      catch (e) { note(c, 'Claim failed on #' + ep + ': ' + (e.message || e)); }
    }
    /* La martingale : la MÊME règle mesurée que l'étage 1, bornée par la caisse. */
    if (E1.MART) c.miseCourante = E1.prochaineMise(c.mart, issue, { base: E1.STAKE, facteur: E1.MART_FACTEUR, paliers: E1.MART_PALIERS, bank: c.solde || (stake * 2) });
  } else { c.skips++; }
  c.fermees = c.fermees || [];
  c.fermees.unshift({ epoch: ep, side: d.side, cote: d.cote, ev: d.ev, mise: stake, gagnant, issue,
    reel: !!d.reel, pl: Math.round(pl * 1e6) / 1e6, tx, txClaim: tx, palier: c.mart.palier, t: Date.now() });
  if (c.fermees.length > HISTO_MAX) c.fermees.pop();
}

async function ticCompte(c) {
  const ch = chaine();
  const now = Math.floor(Date.now() / 1000);
  const fee = await ch.fee();
  const e = await ch.epoch();
  const r = await ch.round(e);
  if (!c.enAttente[e] && r.lock && now >= r.lock - DECISION_LEAD && now < r.lock) {
    await decideEtPlace(c, e, r, fee, ch);
  }
  for (const ep of Object.keys(c.enAttente)) {
    const n = Number(ep);
    if (n >= e - 1) continue;
    try { const rc = await ch.round(n); if (rc.oracleCalled) await resous(c, n, rc, fee, ch); } catch (x) {}
  }
  try { c.solde = await ch.balance(c.adr); } catch (e2) {}
}

async function tic() {
  for (const j of Object.keys(R.comptes)) {
    const c = R.comptes[j];
    if (!c.actif) continue;
    try { await ticCompte(c); } catch (e) { note(c, 'tic: ' + (e.message || e)); }
  }
  sauve();
}

/* ==================== CE QUE L'ÉCRAN MONTRE — jamais la clé ==================== */
function etat(joueur) {
  const c = fiche(joueur);
  const base = { marche: 'BNB', chaine: 'BSC', contrat: ADDR, execute: EXECUTE,
                 configure: !!cleMaitresse(), minBet: MIN_BET, maxBnb: MAX_BNB };
  if (!c) return Object.assign(base, { aWallet: false });
  const n = c.wins + c.losses;
  const enAttente = Object.keys(c.enAttente).map((ep) => {
    const d = c.enAttente[ep]; return { epoch: Number(ep), side: d.side, mise: d.mise, cote: d.cote, ev: d.ev,
      wouldBet: d.wouldBet, place: !!d.place, reel: !!d.reel, tx: d.tx || null };
  });
  return Object.assign(base, {
    aWallet: true, adresse: c.adr, actif: c.actif, solde: c.solde, depuis: c.joue,
    banque: { solde: c.solde, pl: Math.round(c.pl * 1e6) / 1e6, unite: 'BNB',
              wins: c.wins, losses: c.losses, skips: c.skips, mises: c.mises,
              winRate: n ? Math.round(c.wins / n * 1000) / 10 : 0 },
    martingale: { on: E1.MART, facteur: E1.MART_FACTEUR, paliers: E1.MART_PALIERS,
                  palier: c.mart.palier, palierMax: c.mart.palierMax, busts: c.mart.busts,
                  miseCourante: Math.round(c.miseCourante * 1e6) / 1e6 },
    enAttente, fermees: (c.fermees || []).slice(0, 40), journal: (c.journal || []).slice(0, 20),
    note: EXECUTE ? 'Real BNB on BSC when armed (flag + AI_OWNER + Play). Same EV gate and martingale as the paper stage 1. Nothing signs when any lock is missing.'
                  : 'PREDICT_PANCAKE_EXECUTE is OFF: this is a dry run — decisions are logged, nothing is signed. Set the flag on the host to arm real bets.',
  });
}

/* ==================== LA BOUCLE ==================== */
let boucle = null;
function demarreBoucle() { charge(); if (boucle) return; boucle = setInterval(() => { tic().catch(() => {}); }, TIC_MS); if (boucle.unref) boucle.unref(); }
function arreteBoucle() { if (boucle) { clearInterval(boucle); boucle = null; } }
function _reset() { R = { v: 1, comptes: {} }; }

module.exports = {
  cree, revele, demarre, arrete, etat, tic, charge, demarreBoucle, arreteBoucle,
  EXECUTE, ADDR, RPC, CHAIN_ID,
  _chaineTest, _predicteur, _reset, _fiche: fiche, _R: () => R,
};
