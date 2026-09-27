'use strict';
/* ==========================================================================
 * PANCAKE — LE JOURNAL DURABLE DES ROUNDS ET LES OMBRES NOTEES
 *
 * ---- POURQUOI IL EXISTE ----
 *
 * Relevé du 26 septembre 2026 : l'étage 1 ne gardait RIEN — 60 cotes finales et
 * 200 décisions en mémoire, 40 servies, aucun journal. 288 rounds par jour
 * passaient sans laisser de trace mesurable, et chaque question (« le moteur
 * gagne-t-il ? », « l'outsider visible paie-t-il ? ») se tranchait par un rejeu
 * hors ligne de 30 004 rounds relus sur la chaîne. Ce module garde ces rounds
 * sur le disque, et note sur CHACUN un pari fictif par candidat.
 *
 * ---- DEUX FICHIERS, EN AJOUT SEUL, UNE LIGNE PAR ROUND ----
 *
 *   pancake_decisions.jsonl — ce qu'on savait AU MOMENT DE DÉCIDER (T−45 s) :
 *     pool visible, avance sur le lock, note du moteur, camp de chaque
 *     candidat, évaluation de la porte. Écrite AVANT que l'issue existe.
 *   pancake_rounds.jsonl    — ce que le contrat a RÉGLÉ : pools finaux, prix
 *     lock/close, récompense, oracle appelé ou non. Écrite après la clôture,
 *     par la boucle (`src: 'direct'`) ou par le remplissage (`src: 'chaine'`).
 *
 * Les deux ne se mélangent jamais : une ligne de décision ne reçoit pas son
 * issue après coup, on les rapproche par l'epoch. C'est ce qui garantit qu'une
 * règle rejouée plus tard ne lit que ce qu'elle aurait pu lire. L'historique
 * rempli depuis la chaîne n'a PAS de ligne de décision (le pool visible de
 * l'époque est perdu) : il ne rejoue que les règles qui ne lisent pas le pool
 * visible, et il est déjà « vu » — seuls les rounds futurs sont une preuve
 * neuve (rapport du 26/09, A2).
 *
 * TAILLE, mesurée le 27/09/2026 : 275 octets par round réglé (moyenne des
 * 2 880 derniers rounds du relevé du 26/09, mis au format du journal), ~480 par
 * décision (ligne complète, raison de la porte retirée : elle se relit de ses
 * chiffres). Soit ~215 Ko par jour, ~78 Mo par an. Le remplissage de 104 jours
 * ajoute ~8,3 Mo une seule fois (30 004 rounds).
 *
 * ---- LE REMPLISSAGE DEPUIS LA CHAÎNE (borné, lent exprès, reprenable) ----
 *
 * `rounds(epoch)` est une lecture publique et gratuite. ABI et RPC vérifiés le
 * 27 septembre 2026 sur bsc-dataseed.binance.org, bsc-rpc.publicnode.com et
 * bsc-dataseed1.defibit.io : `currentEpoch()` (0x76671808) = 519 197,
 * `rounds(uint256)` (0x8c65c81f) décodé à l'identique du relevé du 26/09
 * (epoch 519 000), `bufferSeconds()` = 30, `intervalSeconds()` = 300,
 * `treasuryFee()` = 300. Un lot JSON-RPC de 50 appels toutes les 10 s : 104
 * jours (~30 000 rounds) en ~1 h 40, une seule fois. Reprenable : un epoch
 * déjà écrit est sauté, un redémarrage repart là où il s'était arrêté. Chaque
 * pas est un appel asynchrone planifié par `setTimeout` : il ne bloque jamais
 * la boucle. `PREDICT_PANCAKE_REMPLISSAGE=0` l'éteint.
 *
 * ---- LES OMBRES (A3) : UN PARI FICTIF PAR CANDIDAT, SUR CHAQUE ROUND ----
 *
 * Candidats : le camp du moteur, son inverse, l'outsider VISIBLE à la décision,
 * et « toujours BULL » comme témoin. Chacun est payé à la cote FINALE réelle,
 * notre mise diluée dans son camp, frais du contrat, gaz réel ; une ÉGALITÉ
 * lock = close est comptée PERDUE (le contrat V2 donne tout le pool à la
 * trésorerie, `_calculateRewards`, branche « House wins ») ; un round annulé
 * (oracle non appelé) est remboursé : il ne compte pas. Aucune ombre ne touche
 * la caisse papier — elle reste à 0 pari EXPRÈS : on mesure, on ne mise pas.
 * La carte montre n, le taux (Wilson 95 %), l'EV ± erreur-type, t, les deux
 * moitiés et le nombre de candidats ; elle ne conclut qu'à n ≥ 500, t ≥ 2,7
 * et les deux moitiés positives. 2,7 et non 2 : quatre candidats regardés en
 * même temps, sur un jeu où ~40 règles ont déjà été essayées (relevé du 26/09,
 * §5 : sur 40 essais, un t ≈ 2 est attendu par hasard).
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ADDR = process.env.PANCAKE_PREDICTION || '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
/* Lu sur le contrat le 27/09/2026 : bufferSeconds() = 30. Un round dont
 * l'oracle n'est pas appelé passé close + 30 s ne le sera plus jamais
 * (`endRound` exige `block.timestamp <= closeTimestamp + bufferSeconds`), et
 * le contrat le rend remboursable (`refundable`) exactement à ce moment-là. */
const BUFFER_S = 30;
const ROUNDS_PAR_JOUR = 288;
const REMPLIT = process.env.PREDICT_PANCAKE_REMPLISSAGE !== '0';
const REMPLIT_JOURS = Math.max(1, Math.min(365, Number(process.env.PREDICT_PANCAKE_REMPLISSAGE_JOURS || 104)));
const REMPLIT_LOT = Math.max(1, Math.min(100, Number(process.env.PREDICT_PANCAKE_REMPLISSAGE_LOT || 50)));
const REMPLIT_PAS_MS = Math.max(0, Number(process.env.PREDICT_PANCAKE_REMPLISSAGE_MS || 10000));
const RPCS = [process.env.BSC_RPC || 'https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'];

/* Le gaz RÉEL d'un pari, mesuré le 24 septembre 2026 sur les reçus du contrat
 * (bloc 123 777 537) : pari 99–119 k, claim 94 k de gaz à 0,05–0,1 gwei, soit
 * ~0,00002 BNB l'aller-retour — 1 % d'une mise de 0,002. Les ombres le paient
 * sur chaque pari. (La porte, elle, compte 0,0001 : c'est sa marge.) */
const OMBRE_GAZ = 0.00002;
const OMBRE_MIN = 500;   /* relevé du 26/09, §10 : sous 500 paris d'ombre, on ne conclut pas */
const OMBRE_T = 2.7;
const CANDIDATS = [
  { id: 'moteur', nom: 'Engine side', texte: 'the side the indicator engine picks' },
  { id: 'inverse', nom: 'Engine inverse', texte: 'the opposite side (what the paper bot is set to bet)' },
  { id: 'outsider', nom: 'Visible underdog', texte: 'the smaller visible pool at decision time' },
  { id: 'bull', nom: 'Always BULL', texte: 'control: no signal at all' },
];

function dossier() { return process.env.DATA_DIR || require('./config').DATA_DIR; }
function fichierRounds() { return path.join(dossier(), 'pancake_rounds.jsonl'); }
function fichierDecisions() { return path.join(dossier(), 'pancake_decisions.jsonl'); }

/* ---- l'état en mémoire (reconstruit du disque au démarrage) ---- */
let J = neuf();
function neuf() {
  return {
    pret: false, indexe: null, attente: [],
    vus: new Set(), plusHaut: 0, plusBas: 0, lignesRounds: 0, lignesDecisions: 0,
    decVues: new Set(), enAttente: new Map(),
    series: { moteur: [], inverse: [], outsider: [], bull: [] }, annules: 0, cache: null,
    rem: { actif: false, fini: false, cible: 0, plancher: 0, curseur: 0, ecrits: 0, lots: 0, erreurs: 0, derniereErreur: null, maj: 0 },
    minuterie: null, file: Promise.resolve(),
  };
}

/* ---- l'écriture : en ajout seul, sérialisée, jamais bloquante ---- */
function ecrit(fichier, texte) {
  J.file = J.file.then(async () => {
    try { await fs.promises.mkdir(path.dirname(fichier), { recursive: true }); await fs.promises.appendFile(fichier, texte); }
    catch (e) { console.warn('[pancake-journal] écriture : ' + e.message); }
  });
  return J.file;
}

/* Un round réglé, sous une forme unique : celle de `rounds()` du contrat, que
 * la boucle ou le remplissage l'aient lu. Les montants en BNB, les prix en
 * entiers Chainlink (texte, 8 décimales). */
function ligneRound(ep, r, src) {
  return { ep: Number(ep), start: r.start != null ? r.start : null, lock: r.lock, close: r.close,
           lp: String(r.lockPrice != null ? r.lockPrice : r.lp), cp: String(r.closePrice != null ? r.closePrice : r.cp),
           tot: r.total != null ? r.total : r.tot, bull: r.bull, bear: r.bear,
           rb: r.rb != null ? r.rb : null, rw: r.rw != null ? r.rw : null,
           oc: !!(r.oracleCalled != null ? r.oracleCalled : r.oc), src, t: Date.now() };
}

/* Réglé = oracle appelé, ou annulé pour de bon (close + buffer dépassé). */
function regle(r, nowS) { return !!r && (r.oracleCalled === true || annule(r, nowS)); }
function annule(r, nowS) { return !!r && r.oracleCalled === false && r.close > 0 && nowS > r.close + BUFFER_S; }

/* Le camp gagnant d'un round réglé : BULL, BEAR, TIE (tout au trésor) ou
 * CANCELLED (remboursé). Les prix sont des entiers : comparés en BigInt. */
function gagnantDe(l) {
  if (!l.oc) return 'CANCELLED';
  let lp, cp; try { lp = BigInt(l.lp); cp = BigInt(l.cp); } catch (e) { lp = Number(l.lp); cp = Number(l.cp); }
  return cp > lp ? 'BULL' : cp < lp ? 'BEAR' : 'TIE';
}

/* Le rendement d'une ombre, par unité de mise : cote finale réelle, notre mise
 * diluée dans notre camp, gaz réel ; égalité = perdu ; annulé = null (remboursé,
 * ne compte pas). Pur. */
function rendement(side, l, fee, mise) {
  const g = gagnantDe(l);
  if (g === 'CANCELLED' || !side) return null;
  const gaz = OMBRE_GAZ / mise;
  if (g !== side) return { r: -1 - gaz, g: false };
  const camp = side === 'BULL' ? l.bull : l.bear;
  const cote = (l.tot + mise) * (1 - fee) / (camp + mise);
  return { r: cote - 1 - gaz, g: true };
}

function noteOmbres(dec, l) {
  if (!dec || !dec.cand) return;
  const fee = typeof dec.fee === 'number' ? dec.fee : 0.03;
  const mise = dec.mise > 0 ? dec.mise : 0.002;
  if (gagnantDe(l) === 'CANCELLED') { J.annules++; J.cache = null; return; }
  for (const c of CANDIDATS) {
    const x = rendement(dec.cand[c.id], l, fee, mise);
    if (x) J.series[c.id].push([dec.ep, x.r, x.g ? 1 : 0]);
  }
  J.cache = null;
}

/* ---- ajouter : un round réglé, une décision ---- */
function ajouteRound(ep, r, src) {
  if (!J.pret) { J.attente.push(['r', ep, r, src]); return false; }
  ep = Number(ep);
  if (J.vus.has(ep)) return false;
  const l = ligneRound(ep, r, src || 'direct');
  J.vus.add(ep); J.lignesRounds++;
  if (ep > J.plusHaut) J.plusHaut = ep;
  if (!J.plusBas || ep < J.plusBas) J.plusBas = ep;
  const dec = J.enAttente.get(ep);
  if (dec) { J.enAttente.delete(ep); noteOmbres(dec, l); }
  ecrit(fichierRounds(), JSON.stringify(l) + '\n');
  return true;
}
function ajouteDecision(d) {
  if (!J.pret) { J.attente.push(['d', d]); return false; }
  const ep = Number(d.ep);
  if (J.decVues.has(ep)) return false;
  J.decVues.add(ep); J.lignesDecisions++;
  if (!J.vus.has(ep)) J.enAttente.set(ep, d);
  ecrit(fichierDecisions(), JSON.stringify(d) + '\n');
  return true;
}
function aDecide(ep) { return J.decVues.has(Number(ep)); }

/* ---- relire le disque (flux, jamais tout en mémoire d'un coup) ---- */
async function lisLignes(fichier, fn) {
  if (!fs.existsSync(fichier)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(fichier, 'utf8'), crlfDelay: Infinity });
  for await (const s of rl) { if (!s) continue; let o; try { o = JSON.parse(s); } catch (e) { continue; } fn(o); }
}
function indexe() {
  if (J.indexe) return J.indexe;
  J.indexe = (async () => {
    /* D'abord les décisions (petites), puis les rounds réglés : chaque round
       qui a sa décision donne ses ombres. */
    await lisLignes(fichierDecisions(), (d) => {
      const ep = Number(d.ep); if (!(ep > 0) || J.decVues.has(ep)) return;
      J.decVues.add(ep); J.lignesDecisions++; J.enAttente.set(ep, d);
    });
    await lisLignes(fichierRounds(), (l) => {
      const ep = Number(l.ep); if (!(ep > 0) || J.vus.has(ep)) return;
      J.vus.add(ep); J.lignesRounds++;
      if (ep > J.plusHaut) J.plusHaut = ep;
      if (!J.plusBas || ep < J.plusBas) J.plusBas = ep;
      const dec = J.enAttente.get(ep);
      if (dec) { J.enAttente.delete(ep); noteOmbres(dec, l); }
    });
    J.pret = true;
    const a = J.attente; J.attente = [];
    for (const x of a) { if (x[0] === 'r') ajouteRound(x[1], x[2], x[3]); else ajouteDecision(x[1]); }
  })().catch((e) => { console.warn('[pancake-journal] index : ' + e.message); J.pret = true; });
  return J.indexe;
}

/* ---- régler les rounds récents, depuis la boucle (quelques lectures par tic) ----
 * De max(plus haut écrit + 1, e − 12) à e − 2 (e − 1 est verrouillé, e en
 * mise), plus les rounds décidés encore ouverts. Un round pas encore réglé
 * arrête rien : on le relira au tic suivant. */
async function regleRecents(ch, e, nowS) {
  if (!J.pret) return 0;
  const aLire = new Set();
  for (let k = Math.max(J.plusHaut + 1, e - 12); k <= e - 2; k++) if (!J.vus.has(k)) aLire.add(k);
  for (const k of J.enAttente.keys()) if (k <= e - 2 && k >= e - 300) aLire.add(k);
  let n = 0;
  for (const k of [...aLire].sort((a, b) => a - b)) {
    try { const r = await ch.round(k); if (regle(r, nowS) && ajouteRound(k, r, 'direct')) n++; } catch (x) { /* au tic suivant */ }
  }
  return n;
}

/* ==================== LE REMPLISSAGE DEPUIS LA CHAÎNE ==================== */
let _lecteur = null;
function lecteurReel() {
  const { ethers } = require('ethers');
  const I = new ethers.utils.Interface([
    'function currentEpoch() view returns (uint256)',
    'function rounds(uint256) view returns (uint256 epoch,uint256 startTimestamp,uint256 lockTimestamp,uint256 closeTimestamp,int256 lockPrice,int256 closePrice,uint256 lockOracleId,uint256 closeOracleId,uint256 totalAmount,uint256 bullAmount,uint256 bearAmount,uint256 rewardBaseCalAmount,uint256 rewardAmount,bool oracleCalled)']);
  let tour = 0;
  /* Jamais l'URL dans une erreur : RPCS[0] est BSC_RPC, et un fournisseur à clé
   * (NodeReal, QuickNode, Ankr) met la clé dans le chemin. Le message finit
   * dans remplissage.derniereErreur, servi sans authentification par
   * /predict/pancake — et c'est le même point d'accès qui signe l'étage réel.
   * On ne nomme que le rang dans la rotation (« rpc#0 »). */
  async function lot(appels) {
    const i = tour++ % RPCS.length, url = RPCS[i], nom = 'rpc#' + i;
    const ctl = new AbortController(); const minut = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(appels), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + nom);
      const res = await r.json();
      if (!Array.isArray(res) || res.length !== appels.length || res.some((x) => x.error || x.result == null)) throw new Error('incomplete batch from ' + nom);
      return res.sort((a, b) => a.id - b.id);
    } catch (e) {
      /* fetch lui-même peut citer l'URL (« Failed to parse URL from … ») :
       * tout message qui sort d'ici est lavé. */
      throw new Error(masqueUrl(String((e && e.message) || e), url, nom));
    } finally { clearTimeout(minut); }
  }
  const F = (x) => Number(ethers.utils.formatEther(x));
  return {
    epoch: async () => I.decodeFunctionResult('currentEpoch', (await lot([{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: ADDR, data: I.encodeFunctionData('currentEpoch') }, 'latest'] }]))[0].result)[0].toNumber(),
    rounds: async (eps) => {
      const res = await lot(eps.map((ep, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: ADDR, data: I.encodeFunctionData('rounds', [ep]) }, 'latest'] })));
      return res.map((x) => {
        const r = I.decodeFunctionResult('rounds', x.result);
        return { epoch: r.epoch.toString(), start: r.startTimestamp.toNumber(), lock: r.lockTimestamp.toNumber(), close: r.closeTimestamp.toNumber(),
                 lockPrice: r.lockPrice.toString(), closePrice: r.closePrice.toString(),
                 total: F(r.totalAmount), bull: F(r.bullAmount), bear: F(r.bearAmount),
                 rb: F(r.rewardBaseCalAmount), rw: F(r.rewardAmount), oracleCalled: r.oracleCalled };
      });
    },
  };
}
/* Retire d'un message toute URL (chemin, requête, identifiants compris). */
function masqueUrl(m, url, nom) {
  if (url) m = m.split(url).join(nom || 'rpc');
  return m.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]*/gi, nom || 'rpc');
}
function lecteur() { if (!_lecteur) _lecteur = lecteurReel(); return _lecteur; }
function _lecteurTest(o) { _lecteur = o; }

/* Un pas : un lot de LOT epochs manquants, du plus récent vers le plancher. */
async function pasRemplissage() {
  const R = J.rem;
  if (!J.pret) await indexe();
  if (!R.cible) {
    const cur = await lecteur().epoch();
    R.cible = cur - 2; R.curseur = cur - 2; R.plancher = Math.max(1, cur - 2 - REMPLIT_JOURS * ROUNDS_PAR_JOUR);
  }
  const eps = [];
  while (R.curseur > R.plancher && eps.length < REMPLIT_LOT) { if (!J.vus.has(R.curseur)) eps.push(R.curseur); R.curseur--; }
  if (!eps.length) { R.fini = true; return false; }
  let rounds;
  try { rounds = await lecteur().rounds(eps); }
  catch (e) { R.curseur = Math.max(R.curseur, eps[0]); throw e; }   /* le lot sera relu : rien de perdu */
  const nowS = Math.floor(Date.now() / 1000);
  rounds.forEach((r, k) => { if (regle(r, nowS) && ajouteRound(eps[k], r, 'chaine')) R.ecrits++; });
  R.lots++; R.maj = Date.now();
  return true;
}
function demarreRemplissage() {
  if (!REMPLIT || J.rem.actif || J.rem.fini) return false;
  J.rem.actif = true;
  const planifie = (ms) => { J.minuterie = setTimeout(boucle, ms); if (J.minuterie.unref) J.minuterie.unref(); };
  let recul = 0;
  async function boucle() {
    if (!J.rem.actif) return;
    try { const encore = await pasRemplissage(); recul = 0; if (encore && J.rem.actif) planifie(REMPLIT_PAS_MS); else J.rem.actif = false; }
    catch (e) {
      J.rem.erreurs++; J.rem.derniereErreur = masqueUrl(String((e && e.message) || e)).slice(0, 120);
      recul = Math.min(recul + 1, 5);
      if (J.rem.actif) planifie(Math.min(300000, Math.max(1000, REMPLIT_PAS_MS) * Math.pow(2, recul)));
    }
  }
  planifie(0);
  return true;
}
function arreteRemplissage() { J.rem.actif = false; if (J.minuterie) { clearTimeout(J.minuterie); J.minuterie = null; } }

/* ==================== LA CARTE DES OMBRES ==================== */
function wilson(k, n, z) {
  z = z || 1.96; if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
const r2 = (x, d) => (x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d)) / Math.pow(10, d));
function statsSerie(s) {
  const L = s.slice().sort((a, b) => a[0] - b[0]);
  const n = L.length;
  if (!n) return { n: 0, gagnes: 0, taux: null, wilson: [null, null], ev: null, se: null, t: null, moitie1: null, moitie2: null };
  let som = 0, som2 = 0, g = 0;
  for (const x of L) { som += x[1]; som2 += x[1] * x[1]; g += x[2]; }
  const m = som / n, sd = n > 1 ? Math.sqrt(Math.max(0, (som2 - n * m * m) / (n - 1))) : null, se = sd != null ? sd / Math.sqrt(n) : null;
  const h = n >> 1, moy = (a) => (a.length ? a.reduce((x, y) => x + y[1], 0) / a.length : null);
  const w = wilson(g, n);
  return { n, gagnes: g, taux: r2(100 * g / n, 1), wilson: [r2(100 * w[0], 1), r2(100 * w[1], 1)],
           ev: r2(100 * m, 2), se: se != null ? r2(100 * se, 2) : null, t: se ? r2(m / se, 2) : null,
           moitie1: n >= 2 ? r2(100 * moy(L.slice(0, h)), 2) : null, moitie2: n >= 2 ? r2(100 * moy(L.slice(h)), 2) : null };
}
function verdict(st) {
  if (st.n < OMBRE_MIN) return { conclut: false, texte: 'not judgeable yet (' + st.n + '/' + OMBRE_MIN + ')' };
  if (st.t != null && st.t >= OMBRE_T && st.moitie1 > 0 && st.moitie2 > 0) return { conclut: true, texte: 'edge measured: t ≥ ' + OMBRE_T + ', both halves positive' };
  return { conclut: false, texte: st.ev < 0 ? 'no edge: loses ' + Math.abs(st.ev).toFixed(2) + '% per bet' : 'no measured edge (t < ' + OMBRE_T + ' or a half ≤ 0)' };
}
function ombres() {
  if (J.cache) return J.cache;
  const lignes = CANDIDATS.map((c) => { const st = statsSerie(J.series[c.id]); return Object.assign({ id: c.id, nom: c.nom, texte: c.texte }, st, { verdict: verdict(st) }); });
  J.cache = { candidats: lignes, nCandidats: CANDIDATS.length, min: OMBRE_MIN, tMin: OMBRE_T, annules: J.annules,
              enAttente: J.enAttente.size, gazReel: OMBRE_GAZ,
              regle: 'One paper bet per candidate on every round, paid at the real final odds with our stake diluted in its side, 3% pool fee and ~1% real gas. A lock = close tie counts as LOST (the contract sends the whole pool to the treasury); a cancelled round is refunded and not counted. A verdict needs n ≥ ' + OMBRE_MIN + ', t ≥ ' + OMBRE_T + ' and both halves positive. These shadows never touch the paper bank, which stays at 0 bets on purpose.' };
  return J.cache;
}

function etat() {
  const R = J.rem;
  return { pret: J.pret, rounds: J.lignesRounds, decisions: J.lignesDecisions, plusBas: J.plusBas || null, plusHaut: J.plusHaut || null,
           remplissage: { on: REMPLIT, actif: R.actif, fini: R.fini, jours: REMPLIT_JOURS, cible: R.cible || null, plancher: R.plancher || null,
                          curseur: R.curseur || null, ecrits: R.ecrits, lots: R.lots, erreurs: R.erreurs, derniereErreur: R.derniereErreur,
                          reste: R.cible ? Math.max(0, R.curseur - R.plancher) : null, pasMs: REMPLIT_PAS_MS, lot: REMPLIT_LOT } };
}

function _reset() { arreteRemplissage(); J = neuf(); }
function _vidange() { return J.file; }

module.exports = { indexe, ajouteRound, ajouteDecision, aDecide, regleRecents, regle, annule, gagnantDe, rendement,
                   demarreRemplissage, arreteRemplissage, pasRemplissage, ombres, statsSerie, verdict, wilson, etat,
                   fichierRounds, fichierDecisions, ligneRound,
                   BUFFER_S, OMBRE_MIN, OMBRE_T, OMBRE_GAZ, CANDIDATS, REMPLIT, REMPLIT_JOURS, REMPLIT_LOT, REMPLIT_PAS_MS, RPCS,
                   _lecteurTest, _lecteurReel: lecteurReel, _masqueUrl: masqueUrl, _reset, _vidange, _J: () => J };
