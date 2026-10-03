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
const J = require('./predict_pancake_journal');   /* le journal durable des rounds, les ombres, le remplissage */
const STRAT = require('./predict_pancake_strategies');   /* stratégies paramétriques (milliers de variations) */
const TOURNOI = require('./predict_tournoi');   /* le tournoi sur les vrais rounds du journal (30/09) */

const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const ADDR = process.env.PANCAKE_PREDICTION || '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const HL = 'https://api.hyperliquid.xyz/info';
const TIC_MS = Math.max(10, Number(process.env.PREDICT_PANCAKE_TIC_S || 20)) * 1000;
/* Mise de base abaissee de 0,01 a 0,002 BNB le 23 septembre 2026, a la demande
 * du proprietaire, avec la remise a zero (gen 2). Raison mesuree : a 0,01 avec
 * martingale ×2 sur 6 paliers, l'echelle totale risquee vaut 0,01+0,02+…+0,32 =
 * 0,63 BNB, soit 63 % d'une caisse de 1 BNB — c'est pour ca que 5 pertes l'ont
 * mise a -29 %. A 0,002, l'echelle totale fait 0,126 BNB (~13 % de la caisse) et
 * chaque palier reste petit devant les piscines minces de PancakeSwap. */
const STAKE = Math.max(0.0001, Number(process.env.PREDICT_PANCAKE_STAKE || 0.002));   /* mise papier, en BNB */
/* Le gaz, MESURE le 24 septembre 2026 sur les recus du contrat (bloc
 * 123 777 537) : pari BULL 99 k, pari BEAR 119 k (max 136 k), claim 94 k de gaz
 * (medianes, n = 9 / 11 / 8), a 0,05–0,1 gwei (max vu 1 gwei). L'aller-retour
 * pari + claim coute donc ~0,00002 BNB. L'ancien defaut, 0,0006, le comptait
 * VINGT-SIX fois : 30 % d'une mise de 0,002 partait en gaz imaginaire. 0,0001
 * garde une marge ×5 (tient jusqu'a ~0,45 gwei). */
const GAZ = Math.max(0, Number(process.env.PREDICT_PANCAKE_GAZ || 0.0001));           /* aller-retour bet+claim, en BNB */
const MARGE = Number(process.env.PREDICT_PANCAKE_MARGE || 0.05);                      /* EV mini pour miser (papier) */
const BANK0 = Math.max(0.001, Number(process.env.PREDICT_PANCAKE_BANK || 1));         /* caisse papier, en BNB */
const DECISION_LEAD = Math.max(10, Number(process.env.PREDICT_PANCAKE_LEAD_S || 45)); /* on décide N s avant le lock — les pools n'y sont PAS finaux, voir plus bas */

/* ---- LA CÔTE FINALE, PAS CELLE DU MOMENT ----
 * MESURE le 24 septembre 2026, 13 rounds consecutifs (epochs 518504–518516,
 * journaux d'evenements des paris du contrat) : 45 s avant le lock, il n'y a que 32 %
 * du pool final (mediane) ; 53 % a 20 s ; 68 % a 8 s. Un tiers de l'argent
 * arrive dans les HUIT dernieres secondes. La cote lue a la decision n'est donc
 * pas celle qu'on touche : sur les 13 paris papier des 40 derniers rounds, la
 * cote de decision moyenne etait 13,04× et la cote finale 2,03× — un « EV
 * +3 761 % a 85,52× » a paye 2,22×. L'ancienne porte EV triait sur du bruit.
 * On decide donc sur la cote finale ATTENDUE : la mediane des cotes finales du
 * camp sur les derniers rounds, et jamais plus que la cote visible (une foule
 * deja la ne repart pas). Sous FINALES_MIN rounds observes, on ne conclut pas. */
const FINALES_MAX = 60;
const FINALES_MIN = 12;

/* ---- LE MODE INVERSE (papier, mesuré) ----
 * « Fais l'inverse de ce que tu veux miser pour que ce soit rentable. » Idée
 * juste QUAND le signal est à contresens — c'est ce qui a sauvé le perp. Mais
 * mesuré hors ligne le 23 septembre 2026 (predict_moteur sur 28 j de BNB 5 min,
 * n=7876) : le moteur fait 49,1 %, donc l'inverse 50,9 % — sous le point mort
 * de PancakeSwap à la côte moyenne (1,94× → 51,5 %). La direction 5 min est une
 * PIÈCE, pas un contresens : inverser une pièce reste une pièce. On ne le croit
 * donc pas — on le MESURE sur les vrais rounds : éteint par défaut, `=1` fait
 * miser l'inverse (et la prob du camp inversé = 100 − prob), l'état le dit, et
 * on lira dans quelques jours si la caisse monte. Papier. */
const INVERSE = process.env.PREDICT_PANCAKE_INVERSE === '1';

/* ---- L'INTERRUPTEUR DES PARIS (défaut : ÉTEINT) ----
 * Mesuré et retranché le 23 septembre 2026 : la direction 5 min de PancakeSwap
 * est une PIÈCE. Moteur 49,1 % sur 28 j (n=7876) ; l'inverse 50,9 % (sous le
 * point mort de 51,5 % à la côte moyenne) ; le momentum près du lock 48,6–50,2 %
 * sur toutes les fenêtres (1 à 30 min, BNB 1 min) ; le live inverse 0/5 à −29 %,
 * la martingale crevant sa propre côte sur des pools minces. Aucun angle ne bat
 * les 3 % de frais + le gaz. On garde la LECTURE des vrais rounds/côtes (la carte
 * reste vivante), mais on ne mise plus — ni papier, ni réel — tant que
 * `PREDICT_PANCAKE_PARIE=1` n'est pas posé. C'est le juge : le jeu n'est pas
 * gagnable avec ce qu'on sait, et on refuse d'y risquer un centime. */
const PARIE = process.env.PREDICT_PANCAKE_PARIE === '1';
/* Renverse une prédiction : l'autre camp, avec la probabilité de CE camp. Pur. */
function inverse(p) {
  if (p && (p.sens === 'UP' || p.sens === 'DOWN')) {
    return Object.assign({}, p, { sens: p.sens === 'UP' ? 'DOWN' : 'UP',
      prob: (typeof p.prob === 'number') ? 100 - p.prob : p.prob, inverse: true });
  }
  return p;
}

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
  'function oracle() view returns (address)',
  'function rounds(uint256) view returns (uint256 epoch,uint256 startTimestamp,uint256 lockTimestamp,uint256 closeTimestamp,int256 lockPrice,int256 closePrice,uint256 lockOracleId,uint256 closeOracleId,uint256 totalAmount,uint256 bullAmount,uint256 bearAmount,uint256 rewardBaseCalAmount,uint256 rewardAmount,bool oracleCalled)',
];

/* ---- Le lecteur de chaîne, injectable pour les essais (aucun appel réel) ---- */
let _chaine = null;
/** La reponse oracle CONNUE a l'instant t : on part de la reponse devenue lockPrice (loid) et on
 *  remonte les rounds Chainlink (consecutifs dans une phase) tant qu'ils sont publies apres t.
 *  `lire(id)` → { prix, maj }. `rafraichi` : une reponse plus recente est arrivee apres t (connu
 *  APRES coup : pour le compte rendu, jamais pour choisir). null si rien n'etait connu. Pur, a lire injecte. */
async function oracleConnuA(lire, loid, t) {
  /* Un round Chainlink qui n'existe pas (debut de phase) revert : on s'arrete, rien de connu. */
  const lis = async (id) => { try { const d = await lire(id); return d && typeof d.maj === 'number' ? d : null; } catch (e) { return null; } };
  let id = BigInt(String(loid)), d = await lis(id);
  if (!d) return null;
  const rafraichi = d.maj > t;
  for (let pas = 0; pas < 6 && d && d.maj > t; pas++) { id -= 1n; d = await lis(id); }
  if (!d || !(d.maj <= t) || !(d.prix > 0)) return null;
  return { prix: d.prix, maj: d.maj, rafraichi };
}
/** La cloture de la derniere bougie d'une seconde FERMEE a t (ouverte a t − 1 au plus tard) — la
 *  bougie ouverte a t se ferme a t + 1 : la prendre, c'est lire une seconde du futur. Pur. */
function clotureFermeeA(klines, t) {
  const f = (Array.isArray(klines) ? klines : []).filter((x) => Math.floor(Number(x[0]) / 1000) + 1 <= t);
  return f.length ? Number(f[f.length - 1][4]) : null;
}

function chaineReelle() {
  const { ethers } = require('ethers');
  const prov = new ethers.providers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(ADDR, ABI, prov);
  let oracleC = null;
  return {
    epoch: async () => (await c.currentEpoch()).toNumber(),
    fee: async () => (await c.treasuryFee()).toNumber() / 10000,   /* 300 -> 0.03 */
    round: async (ep) => {
      const r = await c.rounds(ep);
      return {
        epoch: r.epoch.toString(), start: r.startTimestamp.toNumber(), lock: r.lockTimestamp.toNumber(), close: r.closeTimestamp.toNumber(),
        lockPrice: r.lockPrice.toString(), closePrice: r.closePrice.toString(),
        bull: Number(ethers.utils.formatEther(r.bullAmount)),
        bear: Number(ethers.utils.formatEther(r.bearAmount)),
        total: Number(ethers.utils.formatEther(r.totalAmount)),
        rb: Number(ethers.utils.formatEther(r.rewardBaseCalAmount)),
        rw: Number(ethers.utils.formatEther(r.rewardAmount)),
        oracleCalled: r.oracleCalled,
        loid: r.lockOracleId.toString(),
      };
    },
    /* Le retard de l'oracle (predict_pancake_journal, 5e candidat) : l'heure ou Chainlink a publie le
       lockPrice, et le dernier prix Binance BNBUSDT a lock − L (bougies d'une seconde, miroir public
       data-api.binance.vision, verifie le 29/09 ; api.binance.com repond 451 hors de certains pays). */
    /* 03/10/2026 — DEUX INFORMATIONS VENUES DU FUTUR, retirees (recherche du 03/10, verifiee dans ce
       code) : (1) l'heure de publication lue etait celle de la reponse DEVENUE lockPrice, et le journal
       ne gardait que les rounds ou elle etait deja publiee a lock − L — un conditionnement sur « pas de
       rafraichissement avant l'execution », connu seulement apres, et plus rare justement quand l'ecart
       est grand ; (2) la bougie d'une seconde etait prise par son heure d'OUVERTURE avec son prix de
       CLOTURE : le « prix a lock − L » etait celui de lock − L + 1 s. Desormais, a t = lock − L : la
       derniere reponse oracle publiee a t (on remonte getRoundData depuis lockOracleId), et la cloture de
       la derniere bougie FERMEE a t. Le rafraichissement eventuel est garde pour le compte rendu, jamais
       pour choisir le round. v: 2 marque ces lignes ; les anciennes ne jugent plus rien. */
    oracleSignal: async (r, L) => {
      if (!oracleC) oracleC = new ethers.Contract(await c.oracle(), ['function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)'], prov);
      const t = r.lock - L;
      const o = await oracleConnuA(async (id) => { const d = await oracleC.getRoundData(id); return { prix: Number(d[1].toString()) / 1e8, maj: d[3].toNumber() }; }, r.loid, t);
      if (!o) return null;
      const k = await fetch('https://data-api.binance.vision/api/v3/klines?symbol=BNBUSDT&interval=1s&startTime=' + (t - 10) * 1000 + '&endTime=' + t * 1000 + '&limit=20',
        { signal: AbortSignal.timeout(10000) }).then((x) => { if (!x.ok) throw new Error('HTTP ' + x.status); return x.json(); });
      const px = clotureFermeeA(k, t);
      if (px == null) return null;
      return { v: 2, L, px, connu: o.prix, majConnu: o.maj, rafraichi: o.rafraichi };
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

/* La note BRUTE du moteur (horizon 5 min), sans le mode inverse : les ombres
 * notent le moteur ET son inverse, la porte prend l'un ou l'autre. */
async function preditMoteur() {
  const moteur = new E.PredictionEngine();
  const parIv = {};
  for (const iv of ['1m', '5m', '15m', '1h']) { try { parIv[iv] = await _bougies(iv); } catch (e) { parIv[iv] = []; } }
  const multi = moteur.multiHorizons(parIv);
  return (multi['5m'] && multi['5m'].assez) ? multi['5m'] : moteur.evalue(parIv['5m'] || []);
}
async function predit() { const p = await preditMoteur(); return INVERSE ? inverse(p) : p; }

/* ---- L'état, persistant ---- */
/* La « génération » de la caisse : bumper `PREDICT_PANCAKE_GEN` (ex. de 1 à 2)
 * remet la caisse papier à zéro UNE fois au prochain démarrage — pour repartir
 * propre quand on change de stratégie (ex. le mode inverse). Idempotent : une
 * fois la nouvelle génération enregistrée, un redémarrage ne réinitialise plus.
 * Génération 2 le 23 septembre 2026 : caisse repartie à zéro (l'ancienne était
 * à −29,3 % sur 5 paris) pour observer proprement le mode inverse en papier, à
 * la demande du propriétaire — voir si l'on bat vraiment le pile ou face. Paris
 * papier restés actifs (PREDICT_PANCAKE_PARIE=1), aucun argent réel. */
/* Génération 3 le 24 septembre 2026 : la porte EV passe de la cote du moment
 * à la cote finale attendue (voir LA CÔTE FINALE). La génération 2 finissait a
 * +3,03 % (63 paris, 33–30, 52,4 %) — mais a mise fixe, les 13 paris des 40
 * derniers rounds perdaient (−0,0106 BNB avec le gaz d'alors, −0,0028 sans) :
 * le gain venait de la martingale, pas de la porte. On ne mele pas les deux. */
const GEN = String(process.env.PREDICT_PANCAKE_GEN || '3');
let S = etatNeuf();
/* `porte` : ce que la porte EV a jugé sur CHAQUE round (paris allumés ou non),
 * pour dire au joueur la vraie raison du « 0 bet » : prob × cote attendue
 * contre les 1,10 exigés. `dernierEpDecide` : l'epoch déjà jugé (une fois). */
function etatNeuf() {
  return { bank: BANK0, wins: 0, losses: 0, skips: 0, mises: 0, pl: 0, refunds: 0,
           enAttente: {}, dernier: [], depuis: Date.now(), maj: 0, fee: 0.03,
           round: null, service: { ok: null, quand: 0, message: null },
           miseCourante: STAKE, mart: { palier: 0, palierMax: 0, busts: 0 }, gen: GEN,
           finales: { BULL: [], BEAR: [], dernierEp: 0 },
           porte: { evaluees: 0, passees: 0, maxProduit: null, derniere: null }, dernierEpDecide: 0,
           strategies: null,
           strategieStats: {},
           roundCount: 0 };
}
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
  /* Bump de génération → caisse neuve, une seule fois. */
  if (S.gen !== GEN) { _reset(); S.gen = GEN; sauve(); console.log('[pancake] caisse remise à zéro (génération ' + GEN + ')'); }
  if (!S.finales) S.finales = { BULL: [], BEAR: [], dernierEp: 0 };
  if (!S.porte) S.porte = { evaluees: 0, passees: 0, maxProduit: null, derniere: null };
  if (!S.dernierEpDecide) S.dernierEpDecide = 0;
  if (!S.refunds) S.refunds = 0;
  if (!S.strategies) { S.strategies = STRAT.creeStrategies(); console.log('[pancake] généré ' + S.strategies.length + ' stratégies'); }
  if (!S.strategieStats) S.strategieStats = {};
  if (!S.roundCount) S.roundCount = 0;
  J.indexe();   /* le journal durable : relu en flux, sans bloquer */
}
function note(ok, m) { S.service = { ok, quand: Date.now(), message: m || null }; }

/* La côte parimutuel d'un camp, NOTRE mise incluse (elle dilue la côte).
 * `stake` par défaut à la mise de base : la martingale passe une mise plus grosse. */
function cote(sideAmt, total, fee, stake) {
  const s = stake > 0 ? stake : STAKE;
  const a = sideAmt + s, t = total + s;
  return a > 0 ? (t * (1 - fee)) / a : null;
}

/* Retient la cote finale des DEUX camps d'un round ferme (sans notre mise :
 * c'est la foule seule), une fois par epoch. Pur sur `fin`. */
function noteFinale(fin, ep, r, fee) {
  if (!fin || !r || !r.oracleCalled || !(r.total > 0) || ep <= fin.dernierEp) return;
  fin.dernierEp = ep;
  for (const side of ['BULL', 'BEAR']) {
    const a = side === 'BULL' ? r.bull : r.bear;
    if (a > 0) { fin[side].push({ c: r.total * (1 - fee) / a, t: r.total }); if (fin[side].length > FINALES_MAX) fin[side].shift(); }
  }
}
const mediane = (a) => { const b = a.slice().sort((x, y) => x - y); const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };

/* La cote finale attendue d'un camp, NOTRE mise diluee dedans : pool median,
 * part du camp tiree de la cote mediane. null sous FINALES_MIN observations. */
function coteEstimee(side, fee, stake, fin, finMin) {
  const L = fin && fin[side];
  const minObs = finMin || FINALES_MIN;
  if (!L || L.length < minObs) return null;
  const c = mediane(L.map((o) => o.c)), T = mediane(L.map((o) => o.t));
  const partCamp = T * (1 - fee) / c;
  return { cote: cote(partCamp, T, fee, stake), n: L.length };
}

/* La décision, sur un round en cours de mise. `stake` = la mise (martingale
 * incluse) ; `fin` = les cotes finales observees (par defaut, celles de l'état).
 * `cfg` = config stratégie (optionnel : utilise les globales si absent). */
function decide(pred, r, fee, stake, fin, cfg) {
  const s = stake > 0 ? stake : (cfg && cfg.stake) || STAKE;
  const marge = (cfg && cfg.marge) || MARGE;
  const gaz = (cfg && cfg.gaz) || GAZ;
  const finMin = (cfg && cfg.finalesMin) || FINALES_MIN;
  const side = pred.sens === 'UP' ? 'BULL' : pred.sens === 'DOWN' ? 'BEAR' : null;
  if (!side || !pred.assez) return { side: side, wouldBet: false, cote: null, ev: null, mise: s, raison: 'no clear prediction' };
  const vue = cote(side === 'BULL' ? r.bull : r.bear, r.total, fee, s);
  if (vue == null) return { side, wouldBet: false, cote: null, ev: null, mise: s, raison: 'empty side' };
  const est = coteEstimee(side, fee, s, fin || S.finales, finMin);
  const coteVue = Math.round(vue * 100) / 100;
  if (!est) {
    const n = ((fin || S.finales || {})[side] || []).length;
    return { side, cote: null, coteVue, ev: null, prob: pred.prob, mise: Math.round(s * 1e6) / 1e6, wouldBet: false,
             raison: 'learning the final payouts (' + n + '/' + finMin + ' rounds) — the pool before lock is not the final one' };
  }
  const m = Math.min(vue, est.cote);
  const p = pred.prob / 100;
  const ev = p * m - 1 - gaz / s;
  return { side, cote: Math.round(m * 100) / 100, coteVue, coteEstimee: Math.round(est.cote * 100) / 100, nFinales: est.n,
           ev: Math.round(ev * 1000) / 1000, prob: pred.prob, mise: Math.round(s * 1e6) / 1e6,
           wouldBet: ev > marge,
           raison: ev > marge ? 'EV +' + Math.round(ev * 100) + '% at an expected ' + m.toFixed(2) + 'x final payout'
                              : 'skip: EV ' + Math.round(ev * 100) + '% — the expected ' + m.toFixed(2) + 'x final payout is not worth it' };
}

/* Rejouer LA porte actuelle — `decide`, `noteFinale`, `inverse`, le code même —
 * sur des rounds stockés, dans l'ordre des epochs. Chaque ligne :
 * { ep, bull, bear, tot?, oc, pred: { sens, prob } | null } (pred = la note du
 * moteur à la décision). La cote finale d'un round n'est connue que deux
 * rounds plus tard, comme dans `tic`. La cote VISIBLE de l'époque est perdue :
 * on la prend la plus favorable (notre camp vide), ce qui retire le
 * min(cote vue, …) — il ne peut que baisser la cote retenue. Le rejeu compte
 * donc AU MOINS autant de paris que la porte n'en aurait faits. Pur. */
function rejouePorte(lignes, o) {
  o = o || {};
  const inv = o.inverse != null ? !!o.inverse : INVERSE;
  const fee = o.fee != null ? o.fee : 0.03, stake = o.stake > 0 ? o.stake : STAKE;
  const L = lignes.slice().sort((a, b) => a.ep - b.ep);
  const parEp = new Map(L.map((l) => [l.ep, l]));
  const fin = { BULL: [], BEAR: [], dernierEp: 0 };
  const out = { rounds: L.length, jugees: 0, paris: 0, maxEv: null, maxProb: null, maxProduit: null };
  for (const l of L) {
    const f = parEp.get(l.ep - 2);
    if (f) noteFinale(fin, f.ep, { oracleCalled: !!f.oc, bull: f.bull, bear: f.bear, total: f.tot != null ? f.tot : f.bull + f.bear }, fee);
    if (!l.pred || (l.pred.sens !== 'UP' && l.pred.sens !== 'DOWN')) continue;
    let p = { sens: l.pred.sens, prob: l.pred.prob, assez: true };
    if (inv) p = inverse(p);
    const vis = p.sens === 'UP' ? { bull: 0, bear: 1e6, total: 1e6 } : { bull: 1e6, bear: 0, total: 1e6 };
    const d = decide(p, vis, fee, stake, fin);
    if (d.ev == null) continue;
    out.jugees++;
    if (d.wouldBet) out.paris++;
    if (out.maxEv == null || d.ev > out.maxEv) out.maxEv = d.ev;
    if (out.maxProb == null || p.prob > out.maxProb) out.maxProb = p.prob;
    const pr = p.prob / 100 * d.cote;
    if (out.maxProduit == null || pr > out.maxProduit) out.maxProduit = Math.round(pr * 1000) / 1000;
  }
  return out;
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

/* Résoudre un round fermé pour lequel on avait décidé.
 *
 * ÉGALITÉ lock = close : PERDU. Vérifié sur la source publiée du contrat V2
 * (PancakePredictionV2.sol) le 26 septembre 2026 : `_calculateRewards`, branche
 * « House wins », met rewardAmount = 0 et envoie tout le pool à la trésorerie ;
 * `claimable` renvoie false quand lockPrice == closePrice. L'ancien code la
 * comptait en remboursement — faux, sans effet mesurable aujourd'hui (0 égalité
 * sur 29 959 rounds résolus du 12/06 au 26/09) mais faux.
 * ANNULÉ (oracle non appelé, close + bufferSeconds dépassé) : REMBOURSÉ par le
 * contrat (`refundable`, puis `claim`). 45 rounds sur 30 004 dans le même
 * relevé ; l'ancien code ne les résolvait jamais — ils restaient en attente
 * pour toujours. La mise revient, le gaz non ; la martingale ne bouge pas. */
function resous(ep, r, fee) {
  const d = S.enAttente[ep];
  if (!d) return;
  delete S.enAttente[ep];
  const stake = d.mise > 0 ? d.mise : STAKE;   /* la mise réellement engagée (martingale) */
  const lp = Number(r.lockPrice), cp = Number(r.closePrice);
  const gagnant = !r.oracleCalled ? 'CANCELLED' : cp > lp ? 'BULL' : cp < lp ? 'BEAR' : 'TIE';
  let issue = 'skip', pl = 0;
  if (d.wouldBet) {
    const mFinal = cote(d.side === 'BULL' ? r.bull : r.bear, r.total, fee, stake);
    if (gagnant === 'CANCELLED') { issue = 'refund'; pl = -GAZ; S.refunds++; }
    else if (gagnant === d.side) { issue = 'win'; pl = (mFinal - 1) * stake - GAZ; S.wins++; }
    else { issue = 'loss'; pl = -stake - GAZ; S.losses++; }   /* camp adverse OU égalité : le pool part au trésor */
    if (issue !== 'refund') S.mises++;
    S.bank += pl; S.pl += pl;
    escalade(issue);   /* la martingale monte/redescend selon l'issue ; un remboursement ne la bouge pas */
  } else { S.skips++; }
  /* Mise à jour des stats par stratégie. */
  if (d.strategyId != null && S.strategieStats != null) {
    const sId = String(d.strategyId);
    if (!S.strategieStats[sId]) S.strategieStats[sId] = { n_trades: 0, pnl_total: 0, pnl_pct: 0, edge: 0, busts: 0 };
    if (d.wouldBet) {
      S.strategieStats[sId].n_trades++;
      S.strategieStats[sId].pnl_total += pl;
    }
  }
  S.dernier.unshift({ epoch: ep, side: d.side, cote: d.cote, ev: d.ev, prob: d.prob, mise: Math.round(stake * 1e6) / 1e6,
    gagnant, issue, pl: Math.round(pl * 1e6) / 1e6, coteFinale: gagnant === 'CANCELLED' ? null : cote(d.side === 'BULL' ? r.bull : r.bear, r.total, fee, stake),
    bank: Math.round(S.bank * 1e6) / 1e6, palier: S.mart.palier, t: Date.now(), strategyId: d.strategyId });
  if (S.dernier.length > HISTO_MAX) S.dernier.pop();
}

/* Round annulé pour de bon : oracle non appelé, close + bufferSeconds passé.
 * Partagé avec l'étage 2 (même règle que `refundable` du contrat). */
function annule(r, nowS) { return J.annule(r, nowS); }

/* Ce que la porte dit d'un jugement, pour l'écran : prob × cote attendue
 * contre le seuil exigé (1 + gaz/mise + marge = 1,10 aux réglages du 26/09). */
function resumePorte(d, stake) {
  const s = stake > 0 ? stake : STAKE;
  const requis = Math.round((1 + GAZ / s + MARGE) * 1000) / 1000;
  const produit = (d && typeof d.prob === 'number' && d.cote != null) ? Math.round(d.prob / 100 * d.cote * 1000) / 1000 : null;
  return { side: d ? d.side : null, prob: d ? d.prob : null, cote: d ? d.cote : null, coteVue: d ? d.coteVue : null,
           coteEstimee: d ? (d.coteEstimee != null ? d.coteEstimee : null) : null, nFinales: d ? (d.nFinales || null) : null,
           produit, requis, gaz: Math.round(GAZ / s * 1000) / 1000, marge: MARGE, passe: !!(d && d.wouldBet), raison: d ? d.raison : null };
}

/* Le jugement d'un round, UNE fois, près du lock : pour les ombres TOUJOURS,
 * pour le pari papier seulement si PARIE. La ligne de décision est écrite au
 * journal AVANT que l'issue existe. */
async function jugeRound(e, r, now) {
  S.dernierEpDecide = e;
  const brut = await preditMoteur();
  const pred = INVERSE ? inverse(brut) : brut;
  /* Sélection de stratégie : rotation simple sur les milliers. */
  const strat = S.strategies && PARIE ? STRAT.selectStrategy(S.strategies, S.roundCount) : null;
  const d = decide(pred, r, S.fee, S.miseCourante, null, strat && strat.config);
  d.strategyId = strat && strat.id;
  d.strategyName = strat && strat.name;
  const pt = resumePorte(d, S.miseCourante);
  S.porte.evaluees++;
  if (pt.passe) S.porte.passees++;
  if (pt.produit != null && (S.porte.maxProduit == null || pt.produit > S.porte.maxProduit)) S.porte.maxProduit = pt.produit;
  S.porte.derniere = Object.assign({ epoch: e }, pt);
  const sideMot = brut && brut.assez ? (brut.sens === 'UP' ? 'BULL' : brut.sens === 'DOWN' ? 'BEAR' : null) : null;
  J.ajouteDecision({
    ep: e, t: Date.now(), lock: r.lock, avantLock: r.lock - now, fee: S.fee, mise: STAKE,
    vu: { bull: r.bull, bear: r.bear, total: r.total },
    moteur: brut && brut.assez ? { sens: brut.sens, prob: brut.prob, confiance: brut.confiance } : null,
    cand: { moteur: sideMot, inverse: sideMot ? (sideMot === 'BULL' ? 'BEAR' : 'BULL') : null,
            outsider: r.bull < r.bear ? 'BULL' : r.bear < r.bull ? 'BEAR' : null, bull: 'BULL' },
    porte: Object.assign({}, pt, { raison: undefined }), parie: PARIE, modeInverse: INVERSE,   /* la raison se relit de ses chiffres */
  });
  S.roundCount++;
  return d;
}

async function tic() {
  try {
    const ch = chaine();
    const now = Math.floor(Date.now() / 1000);
    S.fee = await ch.fee();
    const e = await ch.epoch();
    /* Le round en cours de MISE est `e` : on décide une fois, près du lock. */
    const rEnCours = await ch.round(e);
    /* La cote finale du dernier round ferme, qu'on parie ou non : c'est elle
       qui apprend a la porte EV ce qu'un camp paie vraiment. */
    if (e - 2 > S.finales.dernierEp) {
      try { const rf = await ch.round(e - 2); noteFinale(S.finales, e - 2, rf, S.fee); } catch (x) {}
    }
    S.round = { epoch: e, lock: rEnCours.lock, bull: rEnCours.bull, bear: rEnCours.bear,
                total: rEnCours.total, coteBull: cote(rEnCours.bull, rEnCours.total, S.fee),
                coteBear: cote(rEnCours.bear, rEnCours.total, S.fee) };
    /* Chaque round est JUGÉ (ombres + raison du « 0 bet »), qu'on parie ou non. */
    const fenetre = rEnCours.lock && now >= rEnCours.lock - DECISION_LEAD && now < rEnCours.lock;
    if (fenetre && S.dernierEpDecide !== e && !S.enAttente[e]) {
      const d = await jugeRound(e, rEnCours, now);
      /* Les paris sont éteints (défaut) : on LIT, on JUGE, on ne mise pas. */
      if (PARIE) { S.enAttente[e] = d; S.round.decision = d; }
    } else if (PARIE && S.enAttente[e]) {
      S.round.decision = S.enAttente[e];
    }
    if (S.porte.derniere && S.porte.derniere.epoch === e) S.round.porte = S.porte.derniere;
    if (PARIE) {
      /* Les rounds fermés récents : on résout ceux qu'on avait décidés — réglés
         par l'oracle, ou annulés pour de bon (remboursés). */
      for (const ep of Object.keys(S.enAttente)) {
        const n = Number(ep);
        if (n >= e - 1) continue;                 /* pas encore fermé */
        try { const rc = await ch.round(n); if (rc && (rc.oracleCalled || annule(rc, now))) resous(n, rc, S.fee); } catch (x) {}
      }
    }
    /* Le journal durable : chaque round réglé, une ligne (et ses ombres). */
    await J.regleRecents(ch, e, now);
    TOURNOI.tic();   /* au plus un recalcul par round, en tache de fond */
    S.maj = Date.now(); note(true); sauve();
  } catch (e) {
    /* Une erreur ethers v5 cite l'URL du fournisseur (url="…") : BSC_RPC peut
     * porter une clé, et service.message est servi sans authentification. */
    note(false, J._masqueUrl(String((e && e.message) || e), RPC, 'rpc').slice(0, 90));
  }
}

function etat() {
  const n = S.wins + S.losses;
  return {
    marche: 'BNB', contrat: ADDR, roundSec: 300, paper: true, fee: S.fee,
    mise: STAKE, gaz: GAZ, marge: MARGE, depuis: S.depuis, maj: S.maj, inverse: INVERSE, parie: PARIE,
    enPause: process.env.PREDICT_PANCAKE !== '1',
    service: S.service,
    round: S.round,
    banque: { depart: BANK0, solde: Math.round(S.bank * 1e6) / 1e6, pl: Math.round(S.pl * 1e6) / 1e6,
              roi: Math.round((S.bank / BANK0 - 1) * 1000) / 10, unite: 'BNB',
              wins: S.wins, losses: S.losses, skips: S.skips, mises: S.mises, refunds: S.refunds || 0,
              winRate: n ? Math.round(S.wins / n * 1000) / 10 : 0 },
    /* La VRAIE raison du « 0 bet » : sur chaque round jugé, prob × cote finale
       attendue contre le seuil exigé. En mode inverse la prob du camp misé est
       ≤ 50 % (moteur bridé 50–68 %) et la cote attendue ~1,95× : le produit
       reste sous 1,10. Rejoué sur 29 472 rounds (26/09) : 0 pari. */
    porte: Object.assign({ evaluees: S.porte.evaluees, passees: S.porte.passees, maxProduit: S.porte.maxProduit,
                           requis: Math.round((1 + GAZ / STAKE + MARGE) * 1000) / 1000 },
                         { derniere: S.porte.derniere }),
    /* Les ombres (A3) et le journal durable (A2). */
    ombres: J.ombres(),
    journal: J.etat(),
    martingale: { on: MART, facteur: MART_FACTEUR, paliers: MART_PALIERS,
                  palier: S.mart.palier, palierMax: S.mart.palierMax, busts: S.mart.busts,
                  miseCourante: Math.round(S.miseCourante * 1e6) / 1e6 },
    dernier: S.dernier.slice(0, 40),
    /* Ce que la porte EV croit qu'un camp paie, et sur combien de rounds. */
    finales: ['BULL', 'BEAR'].reduce((o, side) => {
      const L = (S.finales && S.finales[side]) || [];
      o[side] = { n: L.length, mediane: L.length ? Math.round(mediane(L.map((x) => x.c)) * 100) / 100 : null, min: FINALES_MIN };
      return o;
    }, {}),
    /* Le tournoi des stratégies sur les vrais rounds (predict_tournoi.js). */
    tournament: TOURNOI.etat(),
    /* Top 20 stratégies par edge, calculé à la volée. */
    topStrategies: S.strategies && S.strategieStats ? (() => {
      const ranked = S.strategies.filter((s) => {
        const st = S.strategieStats[String(s.id)];
        return st && st.n_trades > 0;
      }).map((s) => {
        const st = S.strategieStats[String(s.id)];
        const edge = st.n_trades > 0 ? st.pnl_total / st.n_trades : 0;
        const pnl_pct = st.n_trades > 0 ? (st.pnl_total / (STAKE * st.n_trades) * 100) : 0;
        return Object.assign({}, s, { stats: { n_trades: st.n_trades, pnl_total: Math.round(st.pnl_total * 1e6) / 1e6, edge: Math.round(edge * 1e6) / 1e6, pnl_pct: Math.round(pnl_pct * 100) / 100 } });
      }).sort((a, b) => (b.stats.edge || 0) - (a.stats.edge || 0)).slice(0, 20);
      return ranked;
    })() : [],
    note: !PARIE
      ? 'Betting is OFF. The card reads the real PancakeSwap rounds and odds, but places no bet — paper or real. Measured verdict: 5-min direction is a coin flip (49%), the inverse and near-lock momentum do not beat the 3% fee, and a martingale craters its own odds on thin pools. Set PREDICT_PANCAKE_PARIE=1 only to re-open a paper measurement.'
      : MART
      ? 'Paper only. Each bet is judged on the EXPECTED FINAL payout (median of recent rounds), not the thin pool 45 s before lock — measured: two thirds of the money lands in the last 45 s. Martingale on: after a losing bet the stake ×' + MART_FACTEUR + ', reset after a win, capped at ' + MART_PALIERS + ' steps (past that the ladder busts — counted). It does NOT guarantee recovery: a long streak, or the bank capping the stake, breaks it, and PancakeSwap often pays under 2× so a win recovers less than a full double. Kept paper to measure whether it survives before any real BNB.'
      : 'Paper only — reads the real PancakeSwap rounds and payouts, bets nothing. It skips a round when the payout (côte) makes the bet negative-EV.',
  };
}

function demarre() {
  charge(); if (boucle) return; tic(); boucle = setInterval(tic, TIC_MS); if (boucle.unref) boucle.unref();
  J.indexe().then(() => J.demarreRemplissage()).catch(() => {});   /* 104 jours depuis la chaîne, lentement, une fois */
}
function arrete() { if (boucle) { clearInterval(boucle); boucle = null; } J.arreteRemplissage(); }
function _reset() { S = etatNeuf(); }

module.exports = { oracleConnuA, clotureFermeeA, demarre, arrete, charge, etat, tic, decide, cote, resous, predit, preditMoteur, prochaineMise, inverse,
                   noteFinale, coteEstimee, FINALES_MIN, annule, resumePorte, rejouePorte,
                   ADDR, RPC, STAKE, GAZ, MARGE, MART, MART_FACTEUR, MART_PALIERS, INVERSE, PARIE,
                   _chaineTest, _reseau, _reset, _S: () => S };
