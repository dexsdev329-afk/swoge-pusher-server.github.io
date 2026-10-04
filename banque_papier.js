'use strict';
/* ==========================================================================
 * LA BANQUE PAPIER DES NOUVELLES CHAINES (03/10/2026) — etape 2 de l'observatoire
 * ==========================================================================
 *
 * Demande du proprietaire : « achete en papier pour commencer a simuler une banque, et
 * ameliore le logiciel au fur et a mesure ». L'observatoire (etape 1) lit chaque nouveau
 * jeton a son PREMIER PRIX OBSERVE puis 30 min apres ; ce prix n'est pas celui d'un
 * acheteur. Releve du 03/10 : sur Robinhood, « tous les jetons » font +9,4 % a 30 min
 * (12 310 jetons) quand la colonie papier, aux vrais devis, y perd 4,4 % par trade.
 * Ici, chaque achat est chiffre comme un vrai ordre — et rien n'est jamais signe :
 *
 *   - ACHAT : un devis d'achat (combien de jetons pour la mise), PUIS un devis de revente
 *     immediate de ces jetons. Pas de route de revente → pas d'achat (« cannot sell »).
 *     Essai du 03/10 sur KyberSwap, Ethereum, 0,01 ETH : 4 jetons neufs sur 6 s'achetent
 *     mais ne se revendent pas (« route not found », code 4008) — exactement les cases
 *     « sell unknown » que l'observatoire voyait monter (+5,6 %, 1 242 jetons).
 *   - L'aller-retour a l'entree est garde : Jupiter, 0,2 SOL sur 4 jetons pump.fun neufs,
 *     96,3 % rendus (3,7 % de cout) ; KyberSwap, 0,01 ETH, 92,2 % et 87,6 %, plus 0,25 a
 *     0,40 $ de gaz par echange. Au-dela de RETOUR_MIN, personne ne trade ca : refus compte.
 *   - SORTIES : un devis de vente a 10, 30 et 60 min, sur LE MEME achat (banc apparie).
 *     La banque se regle a 30 min, l'horizon de l'observatoire ; 10 et 60 disent si une
 *     autre tenue ferait mieux, sans biais de selection.
 *   - DEUX FACONS D'ACHETER : un TEMOIN (le premier jeton venu apres chaque quart
 *     d'heure, sans regarder ses traits — ce que donne « acheter n'importe quoi ») et des
 *     BRAS, un par case que l'observatoire voit sortir du lot (meme regle que la page :
 *     moyenne bornee > 0, t au-dessus de la barre de Bonferroni). Un bras perdant au-dela
 *     du hasard (n ≥ BRAS_RETRAIT_N, t ≤ BRAS_RETRAIT_T) est retire ; un bras qui passe la
 *     barre sur n ≥ BRAS_PREUVE_N avec ses deux moities positives est dit « holds in paper ».
 *     C'est TOUT ce que la banque decide : rien n'atteint l'argent reel.
 *
 * Aucune cle, aucune signature, aucun ordre : les quoteurs repondent a des lectures.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

const HORIZONS = [10, 30, 60];        /* minutes apres l'achat ; un devis de vente a chacune */
const HORIZON_BANQUE = 30;            /* la banque se regle ici : l'horizon de l'observatoire et de la colonie */
const DEPART_USD = 1000;
/* La mise : l'ordre d'un joueur. Ethereum a 50 $ : a 25 $, 0,25-0,40 $ de gaz par echange (devis
   KyberSwap du 03/10) mangeraient 2 a 3 points a eux seuls. */
const MISES = { solana: 25, eth: 50, robinhood: 25 };
const RETOUR_MIN = 0.85;              /* moins de 85 % rendus a l'entree (15 % de cout) : aucun trader ne prend ca */
const TEMOIN_MIN = 15;                /* le temoin : le premier jeton venu apres chaque quart d'heure */
const BRAS_ECART_MIN = 20;            /* un bras n'achete pas plus d'une fois toutes les 20 min */
const BRAS_MAX = 6;                   /* bras actifs a la fois, par chaine */
const BRAS_RETRAIT_N = 60, BRAS_RETRAIT_T = -2;
const BRAS_PREUVE_N = 100;
/* Devis par tour de 3 min et par chaine. Jupiter et KyberSwap ne demandent pas de cle (essai du
   03/10) ; on reste tres en dessous de ce qu'un service gratuit tolere. Robinhood : chaque devis
   est une poignee d'eth_call sur le noeud du miroir. */
const DEVIS_PAR_TOUR = { solana: 16, eth: 10, robinhood: 10 };
const ESSAIS_SORTIE = 3;              /* une vente sans route trois tours de suite : la position vaut 0 a cet horizon */
const FILE_MAX = 40, FILE_AGE_MIN = 5;
const FERMEES_MAX = 4000, RECENTS = 15;

const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
function phi(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2); return x >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
/** La barre unilaterale a 5 % pour k essais (Bonferroni). */
function barre(k) { const c = 0.05 / Math.max(1, k); let a = 0, b = 10; for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (1 - phi(m) > c) a = m; else b = m; } return r2(b); }
/** Une serie de rendements (%, dans l'ordre du temps) : n, moyenne, t, moities, part gagnante. */
function serie(v) {
  const n = v.length; if (!n) return { n: 0, net: null, t: null, moitie1: null, moitie2: null, gagnants: null };
  const m = v.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - m) * (x - m), 0) / (n - 1)) : null;
  const h = n >> 1, moy = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return { n, net: r1(m), t: sd ? r2(m / (sd / Math.sqrt(n))) : null, moitie1: r1(moy(v.slice(0, h))), moitie2: r1(moy(v.slice(h))),
           gagnants: Math.round(v.filter((x) => x > 0).length / n * 100) };
}

/* Par JETON distinct : un jeton rachete trois fois n'est pas trois observations (diagnostic du
   03/10 : la colonie, fenetre E, 25 achats sur 16 jetons — les rachats gonflent t). Chaque jeton
   compte une fois, pour la moyenne de ses achats, dans l'ordre de son premier achat. */
function serieParJeton(positions) {
  const par = new Map();
  for (const p of positions.slice().sort((a, b) => a.t0 - b.t0)) {
    if (!par.has(p.addr)) par.set(p.addr, []);
    par.get(p.addr).push(p.r30);
  }
  const s = serie([...par.values()].map((v) => v.reduce((a, x) => a + x, 0) / v.length));
  s.buys = positions.length;
  return s;
}

/* ======================= LES QUOTEURS =======================
 * Interface commune, en dollars :
 *   achat(adresse, miseUsd, o)  → { ok:true, recu:'<unites du jeton>', fraisUsd } | { ok:false, raison }
 *   vente(adresse, montant, p)  → { ok:true, usd, fraisUsd }                      | { ok:false, raison }
 * Une erreur de quota (429) LEVE (e.quota) : elle ne compte pas comme « pas de route ». */
function erreurQuota() { const e = new Error('429'); e.quota = true; return e; }

/** Solana : Jupiter (lite-api, puis api.jup.ag ; sans cle, essai du 03/10). Les frais pump.fun /
 *  PumpSwap sont dans le devis ; pas les frais de reseau : FRAIS_SOL par echange (base + priorite). */
function quoteurSolana(o) {
  o = o || {};
  const chercher = o.fetch || ((u) => fetch(u, { signal: AbortSignal.timeout(12000) }));
  const BASES = o.bases || ['https://lite-api.jup.ag/swap/v1/quote', 'https://api.jup.ag/swap/v1/quote'];
  const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  /* 0,0005 SOL par echange : 5 000 lamports de base et une priorite de ~0,0005 SOL, l'ordre de grandeur
     d'un ordre qui veut entrer dans le bloc sans payer un pourboire Jito. Une hypothese, dite telle. */
  const FRAIS_SOL = o.fraisSol != null ? o.fraisSol : 0.0005;
  let cours = { v: 0, t: 0 };
  async function devis(entree, sortie, montant) {
    let derniere = null;
    for (const b of BASES) {
      let r;
      try { r = await chercher(b + '?inputMint=' + entree + '&outputMint=' + sortie + '&amount=' + montant + '&slippageBps=300'); }
      catch (e) { derniere = e; continue; }
      if (r.status === 429) { derniere = erreurQuota(); continue; }
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      if (r.status === 400 || (j && (j.errorCode || j.error))) return { ok: false, raison: 'no route (' + String((j && (j.errorCode || j.error)) || r.status).slice(0, 60) + ')' };
      if (!r.ok || !j || !(Number(j.outAmount) > 0)) { derniere = new Error('HTTP ' + r.status); continue; }
      return { ok: true, out: String(j.outAmount), via: (j.routePlan || []).map((x) => x.swapInfo && x.swapInfo.label).filter(Boolean).join('+') };
    }
    throw derniere || new Error('jupiter');
  }
  async function solUsd() {
    if (cours.v > 0 && Date.now() - cours.t < 5 * 60e3) return cours.v;
    const d = await devis(SOL, USDC, 1e9);
    if (!d.ok) throw new Error('SOL price: ' + d.raison);
    cours = { v: Number(d.out) / 1e6, t: Date.now() };
    return cours.v;
  }
  return {
    nom: 'Jupiter',
    async achat(adr, usd) {
      const c = await solUsd();
      const d = await devis(SOL, adr, Math.round(usd / c * 1e9));
      return d.ok ? { ok: true, recu: d.out, fraisUsd: FRAIS_SOL * c, via: d.via } : d;
    },
    async vente(adr, montant) {
      const c = await solUsd();
      const d = await devis(adr, SOL, montant);
      return d.ok ? { ok: true, usd: Number(d.out) / 1e9 * c, fraisUsd: FRAIS_SOL * c, via: d.via } : d;
    },
  };
}

/** Ethereum : l'agregateur KyberSwap (sans cle, x-client-id ; essai du 03/10). Son devis rend le gaz
 *  de la route en dollars (gasUsd) : il est compte a chaque jambe. */
function quoteurEth(o) {
  o = o || {};
  const chercher = o.fetch || ((u, x) => fetch(u, Object.assign({ signal: AbortSignal.timeout(12000) }, x || {})));
  const BASE = o.base || 'https://aggregator-api.kyberswap.com/ethereum/api/v1/routes';
  const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  let cours = { v: 0, t: 0 };
  async function devis(entree, sortie, montant) {
    let r;
    r = await chercher(BASE + '?tokenIn=' + entree + '&tokenOut=' + sortie + '&amountIn=' + montant, { headers: { 'x-client-id': 'swoge' } });
    if (r.status === 429) throw erreurQuota();
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    const rs = j && j.data && j.data.routeSummary;
    /* « Pas de route » seulement quand le service le DIT (code 4008, « route not found ») ; le reste
       (« service temporarily overloaded », vu le 03/10, une 5xx) est une panne passagere : elle leve,
       et le jeton n'est pas refuse pour une absence de route qu'on n'a pas constatee. */
    const msg = String((j && j.message) || '');
    if (j && (j.code === 4008 || /route not found|no route/i.test(msg))) return { ok: false, raison: 'no route (' + (msg || j.code) + ')' };
    if (!r.ok || !rs || (j && j.code && j.code !== 0)) throw new Error('KyberSwap ' + r.status + ' ' + msg.slice(0, 60));
    if (!(Number(rs.amountOut) > 0)) return { ok: false, raison: 'no route (zero out)' };
    const via = [...new Set([].concat(...(rs.route || [])).map((x) => x && x.exchange).filter(Boolean))].join('+');
    return { ok: true, out: String(rs.amountOut), gasUsd: Number(rs.gasUsd) || 0, inUsd: Number(rs.amountInUsd) || 0, via };
  }
  async function ethUsd() {
    if (cours.v > 0 && Date.now() - cours.t < 5 * 60e3) return cours.v;
    const d = await devis(ETH, USDC, '10000000000000000');
    if (!d.ok) throw new Error('ETH price: ' + d.raison);
    cours = { v: Number(d.out) / 1e6 / 0.01, t: Date.now() };
    return cours.v;
  }
  const wei = (eth) => BigInt(Math.round(eth * 1e9)) * 1000000000n;
  return {
    nom: 'KyberSwap',
    async achat(adr, usd) {
      const c = await ethUsd();
      const d = await devis(ETH, adr, wei(usd / c).toString());
      return d.ok ? { ok: true, recu: d.out, fraisUsd: d.gasUsd, via: d.via } : d;
    },
    async vente(adr, montant) {
      const c = await ethUsd();
      const d = await devis(adr, ETH, montant);
      return d.ok ? { ok: true, usd: Number(d.out) / 1e18 * c, fraisUsd: d.gasUsd } : d;
    },
  };
}

/** Robinhood Chain : les quoteurs du miroir (v2/v3/v4, ponts), en lecture seule — les memes devis
 *  que la colonie et le miroir, la meilleure place nette de gaz. Le gaz de la place (autorisations,
 *  aller ET retour) est compte en entier a l'achat. */
function quoteurRobinhood(o) {
  const M = o.miroir;
  const { BigNumber } = require('ethers');
  async function cours() { const c = (M.coursEth && M.coursEth()) || (M.litEthUsd && await M.litEthUsd()) || 0; if (!(c > 0)) throw new Error('no ETH price'); return c; }
  const versEth = (bn) => Number(BigNumber.from(bn).toString()) / 1e18;
  const sansRoute = (e) => /no venue|no pool|route|pool against ETH|revert|execution reverted|not found/i.test(String((e && e.message) || e));
  return {
    nom: 'Robinhood quoters',
    async achat(adr, usd, x) {
      const c = await cours();
      const mise = BigNumber.from(BigInt(Math.round(usd / c * 1e9)) * 1000000000n + '');
      let r;
      try { r = await M._meilleurePlace(adr, x && x.pool, mise); }
      catch (e) { if (sansRoute(e)) return { ok: false, raison: 'no route (' + String(e.message).slice(0, 60) + ')' }; throw e; }
      const ch = r.choix;
      return { ok: true, recu: ch.sortie.toString(), fraisUsd: versEth(ch.gaz) * c, pool: ch.pool,
               venteUsd: versEth(ch.retour) * c };
    },
    async vente(adr, montant, p) {
      const c = await cours();
      let out;
      try { const route = await M._routeDe(adr, p.pool); out = await M._devisRoute(route, 'vente', adr, BigNumber.from(montant)); }
      catch (e) { if (sansRoute(e)) return { ok: false, raison: 'no route (' + String(e.message).slice(0, 60) + ')' }; throw e; }
      return { ok: true, usd: versEth(out) * c, fraisUsd: 0 };
    },
  };
}

/* ======================= LA BANQUE ======================= */
/**
 * deps : { dossier, quoteurs: { solana?, eth?, robinhood? }, maintenant?, mises?, devisParTour? }
 * Par chaine : propose(c, o, cases) a chaque premier prix ; tour(c, sortants) a chaque cycle.
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const mises = Object.assign({}, MISES, deps.mises || {});
  const budget = Object.assign({}, DEVIS_PAR_TOUR, deps.devisParTour || {});
  const B = {};
  const fichier = (c) => path.join(deps.dossier, 'banque_' + c + '.json');
  function neuve(c) {
    return { chaine: c, depuis: maintenant(), depart: DEPART_USD, cash: DEPART_USD, mise: mises[c], ouvertes: [], fermees: [],
             bras: {}, temoinDernier: 0, file: [], fileImposee: [],
             compte: { proposes: 0, achats: 0, temoins: 0, refus: {}, devis: 0, quota: 0, erreurs: 0, derniereErreur: null } };
  }
  function etat(c) {
    if (B[c]) return B[c];
    let s = null;
    try { s = JSON.parse(fs.readFileSync(fichier(c), 'utf8')); } catch (e) { s = null; }
    B[c] = Object.assign(neuve(c), s || {});
    B[c].file = []; B[c].fileImposee = [];   /* les files ne survivent pas a un redemarrage : leurs premiers prix seraient perimes */
    return B[c];
  }
  function sauve(c) {
    try { fs.mkdirSync(deps.dossier, { recursive: true }); const f = fichier(c); fs.writeFileSync(f + '.tmp', JSON.stringify(B[c])); fs.renameSync(f + '.tmp', f); }
    catch (e) { /* un disque plein ne fait pas tomber l'observatoire */ }
  }
  /* Le refus, et les derniers refus avec leur place : « cannot sell » sur Ethereum, le 03/10, c'etait
     surtout des pools Uniswap v4 a crochet de frais (« uniswap-v4-fee » chez KyberSwap) que honeypot.is
     ne connait pas (404) — un motif a confirmer, pas a supposer. */
  const refus = (S, k, x, via) => {
    S.compte.refus[k] = (S.compte.refus[k] || 0) + 1;
    if (x) { (S.refusRecents || (S.refusRecents = [])).unshift({ addr: x.addr, raison: k, via: via || null, dex: x.dex || null, t: maintenant() }); S.refusRecents.length = Math.min(S.refusRecents.length, 30); }
    if (via) { const m = S.refusParPlace || (S.refusParPlace = {}); const c = k + ' · ' + via; m[c] = (m[c] || 0) + 1; }
  };

  /** Au premier prix d'un jeton : le garder pour le tour. `cases` : ses « trait = valeur ».
   *  `x.bras` : un bras IMPOSE par l'appelant (la colonie, 03/10) — file a part, jamais le temoin,
   *  hors du plafond BRAS_MAX ; `x.controle` : le bras temoin de l'appelant, jamais retire. */
  function propose(c, o, cases, x) {
    if (!deps.quoteurs || !deps.quoteurs[c] || !o || !o.addr) return;
    const S = etat(c);
    S.compte.proposes++;
    const item = { addr: o.addr, pool: o.pool || null, dex: o.dexId || null, cases: cases || [], vu: maintenant() };
    if (x && x.bras) {
      item.bras = String(x.bras); item.controle = !!x.controle;
      S.fileImposee.push(item);
      if (S.fileImposee.length > FILE_MAX) S.fileImposee.splice(0, S.fileImposee.length - FILE_MAX);
      return;
    }
    S.file.push(item);
    if (S.file.length > FILE_MAX) S.file.splice(0, S.file.length - FILE_MAX);
  }

  /** Les bras du tour : les cases qui sortent du lot, plus ceux deja ouverts (tant qu'ils ne sont pas retires). */
  function arme(S, sortants) {
    const t = maintenant();
    for (const s of sortants || []) {
      if (S.bras[s]) continue;
      const actifs = Object.values(S.bras).filter((b) => b.etat === 'actif' && !b.impose).length;
      if (actifs >= BRAS_MAX) break;
      S.bras[s] = { etat: 'actif', depuis: t, dernier: 0 };
    }
  }

  function statsBras(S, cle) {
    const b = cle === null ? null : S.bras[cle];
    /* Un bras impose ne compte que SES achats ; un bras de l'observatoire, tout achat de sa case
       (temoin compris : il a ete pris sans regarder ses traits, c'est un echantillon de la case). */
    const l = S.fermees.concat(S.ouvertes).filter((p) => p.r30 != null
      && (cle === null ? p.temoin : b && b.impose ? p.bras === cle : (p.cases || []).includes(cle)));
    return serieParJeton(l);
  }
  function juge(S) {
    for (const [k, b] of Object.entries(S.bras)) {
      if (b.etat !== 'actif' || b.controle) continue;
      const s = statsBras(S, k);
      if (s.n >= BRAS_RETRAIT_N && s.t != null && s.t <= BRAS_RETRAIT_T) { b.etat = 'retire'; b.retireLe = maintenant(); b.raison = 'losing beyond chance: ' + s.net + '% net over ' + s.n + ' buys, t ' + s.t; }
    }
  }

  /** Un achat papier, chiffre comme un ordre. */
  async function achete(c, S, x, temoin, brasCle) {
    const Q = deps.quoteurs[c];
    const a = await Q.achat(x.addr, S.mise, x);
    S.compte.devis++;
    if (!a.ok) { refus(S, 'no buy route', x); return false; }
    let venteUsd = a.venteUsd;
    if (venteUsd == null) {
      const v = await Q.vente(x.addr, a.recu, { pool: a.pool || x.pool });
      S.compte.devis++;
      if (!v.ok) { refus(S, 'cannot sell', x, a.via); return false; }
      venteUsd = v.usd - (v.fraisUsd || 0);
    }
    const depense = S.mise + (a.fraisUsd || 0);
    const rt0 = venteUsd / depense;
    if (!(rt0 >= RETOUR_MIN)) { refus(S, 'round trip too costly', x, a.via); (S.rtRefuses || (S.rtRefuses = [])).push(r1((1 - rt0) * 100)); if (S.rtRefuses.length > 200) S.rtRefuses.shift(); return false; }
    /* Caisse a sec : on RECHARGE, on ne s'arrete pas. Releve du 04/10, 6 h apres l'ouverture : Solana
       de 1 000 a 20 $ (52 jetons, -71,8 % net par jeton, t -10,68), Robinhood a 57 $ (64 jetons,
       -58,8 %, t -3,32) — des piscines videes en moins de 30 min, pas un defaut de devis (Jupiter
       relu a la main : 3e-9 SOL dans la piscine PumpSwap, 1 922 achats pour 212 ventes en 1 h). Sur
       « bank empty », plus aucun achat : les bras restaient a n < 60, ni retirables ni jugeables. Une
       recharge est comptee et montree, et le resultat reste cumule sur toutes les recharges. */
    if (S.cash < depense) {
      S.cash += S.depart;
      S.recharges = (S.recharges || 0) + 1;
      (S.rechargesLe || (S.rechargesLe = [])).push(maintenant());
      if (S.rechargesLe.length > 50) S.rechargesLe.shift();
    }
    S.cash -= depense;
    S.ouvertes.push({ addr: x.addr, pool: a.pool || x.pool, dex: x.dex, cases: x.cases, temoin: !!temoin, bras: brasCle || null,
                      t0: maintenant(), mise: S.mise, depense, recu: a.recu, rt0: r1((1 - rt0) * 100), via: a.via || null,
                      valeurs: {}, essais: {}, r30: null });
    S.compte.achats++; if (temoin) S.compte.temoins++;
    return true;
  }

  /** Un tour : les ventes d'abord (une lecture en retard fausse la mesure), puis les achats. */
  async function tour(c, sortants) {
    if (!deps.quoteurs || !deps.quoteurs[c]) return;
    const S = etat(c), Q = deps.quoteurs[c];
    let reste = budget[c] || 10;
    const t = maintenant();
    arme(S, sortants);
    try {
      /* 1. les sorties echues, la plus en retard d'abord */
      const dues = [];
      for (const p of S.ouvertes) for (const h of HORIZONS) if (p.valeurs[h] === undefined && t >= p.t0 + h * 60e3) dues.push({ p, h });
      dues.sort((a, b) => (a.p.t0 + a.h * 60e3) - (b.p.t0 + b.h * 60e3));
      for (const { p, h } of dues) {
        if (reste <= 0) break;
        if (p.valeurs[h] !== undefined) continue;
        reste--; S.compte.devis++;
        let v;
        try { v = await Q.vente(p.addr, p.recu, p); }
        catch (e) { if (e && e.quota) throw e; S.compte.erreurs++; S.compte.derniereErreur = String((e && e.message) || e).slice(0, 160); continue; }
        if (v.ok) p.valeurs[h] = { usd: r2(v.usd - (v.fraisUsd || 0)), min: r1((t - p.t0) / 60e3) };
        else {
          p.essais[h] = (p.essais[h] || 0) + 1;
          /* Trois tours sans route : on ne peut plus vendre, la position vaut zero a cet horizon. */
          if (p.essais[h] >= ESSAIS_SORTIE) p.valeurs[h] = { usd: 0, min: r1((t - p.t0) / 60e3), invendable: true };
        }
        if (h === HORIZON_BANQUE && p.valeurs[h] !== undefined) {
          S.cash += p.valeurs[h].usd;
          p.r30 = r2((p.valeurs[h].usd / p.depense - 1) * 100);
        }
      }
      /* 2. les positions dont tous les horizons sont lus sortent du livre */
      const finies = S.ouvertes.filter((p) => HORIZONS.every((h) => p.valeurs[h] !== undefined));
      if (finies.length) {
        S.ouvertes = S.ouvertes.filter((p) => !finies.includes(p));
        S.fermees.push(...finies);
        if (S.fermees.length > FERMEES_MAX) S.fermees.splice(0, S.fermees.length - FERMEES_MAX);
      }
      juge(S);
      /* 3. les achats : le temoin d'abord, puis les bras */
      const actifs = Object.entries(S.bras).filter(([, b]) => b.etat === 'actif');
      while (S.file.length && reste >= 2) {
        const x = S.file.shift();
        if (t - x.vu > FILE_AGE_MIN * 60e3) { refus(S, 'too late after first price', x); continue; }
        if (S.ouvertes.some((p) => p.addr === x.addr)) continue;
        let temoin = false, cle = null;
        if (t - (S.temoinDernier || 0) >= TEMOIN_MIN * 60e3) temoin = true;
        else {
          const b = actifs.find(([k, bb]) => x.cases.includes(k) && t - (bb.dernier || 0) >= BRAS_ECART_MIN * 60e3);
          if (!b) continue;
          cle = b[0];
        }
        reste -= 2;
        let ok = false;
        try { ok = await achete(c, S, x, temoin, cle); }
        catch (e) { if (e && e.quota) throw e; S.compte.erreurs++; S.compte.derniereErreur = String((e && e.message) || e).slice(0, 160); }
        if (temoin) S.temoinDernier = t;     /* tente ou non : le temoin ne choisit pas le suivant */
        if (ok && cle) S.bras[cle].dernier = t;
      }
      /* 4. les bras imposes (la colonie) : leur propre file, leur propre cadence */
      while (S.fileImposee.length && reste >= 2) {
        const x = S.fileImposee.shift();
        if (t - x.vu > FILE_AGE_MIN * 60e3) { refus(S, 'too late after first price', x); continue; }
        if (S.ouvertes.some((p) => p.addr === x.addr)) continue;
        const b = S.bras[x.bras] || (S.bras[x.bras] = { etat: 'actif', depuis: t, dernier: 0, impose: true, controle: x.controle });
        if (b.etat !== 'actif') continue;
        if (!b.controle && t - (b.dernier || 0) < BRAS_ECART_MIN * 60e3) continue;
        reste -= 2;
        let ok = false;
        try { ok = await achete(c, S, x, false, x.bras); }
        catch (e) { if (e && e.quota) throw e; S.compte.erreurs++; S.compte.derniereErreur = String((e && e.message) || e).slice(0, 160); }
        if (ok) b.dernier = t;
      }
    } catch (e) {
      if (e && e.quota) S.compte.quota++;
      else { S.compte.erreurs++; S.compte.derniereErreur = String((e && e.message) || e).slice(0, 160); }
    }
    sauve(c);
  }

  /** La vue d'une chaine : la banque, le temoin, chaque bras, le banc des horizons. */
  function vue(c) {
    if (!deps.quoteurs || !deps.quoteurs[c]) return null;
    const S = etat(c);
    const enCours = S.ouvertes.reduce((a, p) => a + (p.valeurs[HORIZON_BANQUE] ? 0 : (p.valeurs[10] ? p.valeurs[10].usd : p.depense)), 0);
    const toutes = S.fermees.concat(S.ouvertes).filter((p) => p.r30 != null).sort((a, b) => a.t0 - b.t0);
    const nBras = Object.keys(S.bras).length;
    const b = barre(nBras + 1);
    const bras = Object.entries(S.bras).map(([k, x]) => {
      const s = statsBras(S, k);
      const tient = s.n >= BRAS_PREUVE_N && s.t != null && s.t >= b && s.moitie1 > 0 && s.moitie2 > 0;
      return Object.assign({ case: k, source: x.impose ? 'colony' : 'observatory', control: !!x.controle,
                             state: x.etat === 'retire' ? 'retired' : x.controle ? 'control' : tient ? 'holds in paper' : 'testing', since: new Date(x.depuis).toISOString(),
                             retiredBecause: x.raison || null }, s);
    }).sort((x, y) => (y.n || 0) - (x.n || 0));
    /* Le banc : les memes achats lus a 10, 30 et 60 min — l'ecart apparie, pas deux echantillons. */
    const complets = S.fermees.filter((p) => HORIZONS.every((h) => p.valeurs[h])).sort((a, b) => a.t0 - b.t0);
    const rr = (p, h) => (p.valeurs[h].usd / p.depense - 1) * 100;
    const banc = { n: complets.length };
    for (const h of HORIZONS) banc['at' + h] = serie(complets.map((p) => rr(p, h)));
    banc.min60vs30 = serie(complets.map((p) => rr(p, 60) - rr(p, 30)));
    banc.min10vs30 = serie(complets.map((p) => rr(p, 10) - rr(p, 30)));
    const rts = toutes.map((p) => p.rt0).filter((x) => x != null).sort((a, b) => a - b);
    const apporte = S.depart * (1 + (S.recharges || 0));
    return {
      quoter: deps.quoteurs[c].nom, since: new Date(S.depuis).toISOString(), stakeUsd: S.mise, startUsd: S.depart,
      refills: S.recharges || 0, lastRefill: S.rechargesLe && S.rechargesLe.length ? new Date(S.rechargesLe[S.rechargesLe.length - 1]).toISOString() : null,
      investedUsd: r2(apporte),
      cashUsd: r2(S.cash), openUsd: r2(enCours), valueUsd: r2(S.cash + enCours), pnlUsd: r2(S.cash + enCours - apporte),
      open: S.ouvertes.length, closed: S.fermees.length, all: serieParJeton(toutes), control: statsBras(S, null),
      bar: b, arms: bras, bench: banc,
      entryCost: { n: rts.length, medianPct: rts.length ? rts[rts.length >> 1] : null, refusedMedianPct: S.rtRefuses && S.rtRefuses.length ? S.rtRefuses.slice().sort((a, b) => a - b)[S.rtRefuses.length >> 1] : null },
      refusedByVenue: S.refusParPlace || {}, recentRefusals: (S.refusRecents || []).slice(0, 12),
      counts: { proposed: S.compte.proposes, bought: S.compte.achats, control: S.compte.temoins, refused: S.compte.refus, quotes: S.compte.devis,
                rateLimited: S.compte.quota, errors: S.compte.erreurs, lastError: S.compte.derniereErreur },
      recent: toutes.slice(-RECENTS).reverse().map((p) => ({ addr: p.addr, dex: p.dex, control: p.temoin, arm: p.bras, entryCostPct: p.rt0,
        r30: p.r30, unsellable: !!(p.valeurs[HORIZON_BANQUE] && p.valeurs[HORIZON_BANQUE].invendable), t: p.t0 })),
    };
  }

  return { propose, tour, vue, _etat: etat };
}

const NOTE = 'Paper only: no key, no signature, no order. Results count each token once (re-buys of the same token are averaged). Each buy is priced like a real order — a buy quote AND a sell-back quote for the tokens received (no sell route, no buy), '
  + 'then sell quotes at 10, 30 and 60 minutes on the same buy. The bank settles at 30 minutes, net of the quoted price impact, DEX fees and network costs. '
  + 'The control buys the first token after every 15 minutes without looking at it; each arm buys the tokens of one case the observatory sees standing out. '
  + 'When the bank runs dry it is refilled with another $' + DEPART_USD.toLocaleString('en-US') + ' so the measurement never stops; every refill is counted and the profit / loss covers all of them. '
  + 'An arm losing beyond chance (' + BRAS_RETRAIT_N + '+ buys, t ≤ ' + BRAS_RETRAIT_T + ') is retired; one only "holds in paper" with ' + BRAS_PREUVE_N + '+ buys, t above the bar and both halves positive.';

module.exports = { cree, quoteurSolana, quoteurEth, quoteurRobinhood, serie, serieParJeton, barre, NOTE,
  HORIZONS, HORIZON_BANQUE, DEPART_USD, MISES, RETOUR_MIN, TEMOIN_MIN, BRAS_ECART_MIN, BRAS_MAX, BRAS_RETRAIT_N, BRAS_RETRAIT_T, BRAS_PREUVE_N, ESSAIS_SORTIE };
