"use strict";
/* ==========================================================================
 * SWOGE PREDICT — LE MOTEUR
 *
 * Un simulateur de marches de prediction (UP/DOWN) sur de VRAIES donnees de
 * marche. Il ne bouge aucun argent reel : PAPIER par defaut, l execution
 * reelle n est qu une architecture (ProtocolAdapter), jamais branchee sans
 * confirmation explicite.
 *
 * ---- L HONNETETE, AVANT TOUT LE RESTE ----
 * La direction d un prix a court terme est quasi aleatoire. Le « moteur de
 * prediction » ci-dessous est une HEURISTIQUE d indicateurs techniques : il
 * n a AUCUN avantage prouve sur un tirage a pile ou face, et le backtest sur
 * donnees reelles le montre (la precision tourne autour de 50 %). On affiche
 * une probabilite parce que le cahier des charges la demande, mais jamais
 * comme une certitude, et le mot « garanti » n existe nulle part ici.
 *
 * ---- LA MARTINGALE ----
 * Elle est fournie parce qu elle est demandee, et elle est presentee pour ce
 * qu elle est : une gestion de mise a TRES HAUT RISQUE qui finit par ruiner
 * la bankroll sur des tirages ~50/50. Le visualiseur et le backtest le
 * MONTRENT plutot que de le cacher. Ce n est pas une methode de profit.
 * ======================================================================== */

/* ==================================================================
 * 1. LES INDICATEURS TECHNIQUES
 * ================================================================== */
var TA = {
  sma: function (v, n) { if (v.length < n) return null; var s = 0; for (var i = v.length - n; i < v.length; i++) s += v[i]; return s / n; },
  ema: function (v, n) {
    if (v.length < n) return null;
    var k = 2 / (n + 1), e = 0;
    for (var i = 0; i < n; i++) e += v[i]; e /= n;
    for (var j = n; j < v.length; j++) e = v[j] * k + e * (1 - k);
    return e;
  },
  stddev: function (v, n) {
    if (v.length < n) return null;
    var seg = v.slice(v.length - n), m = 0, i;
    for (i = 0; i < n; i++) m += seg[i]; m /= n;
    var s = 0; for (i = 0; i < n; i++) s += (seg[i] - m) * (seg[i] - m);
    return Math.sqrt(s / n);
  },
  rsi: function (v, n) {
    if (v.length < n + 1) return null;
    var g = 0, p = 0;
    for (var i = v.length - n; i < v.length; i++) { var d = v[i] - v[i - 1]; if (d >= 0) g += d; else p -= d; }
    if (p === 0) return 100;
    var rs = (g / n) / (p / n);
    return 100 - 100 / (1 + rs);
  },
  macd: function (v) {
    var e12 = TA.ema(v, 12), e26 = TA.ema(v, 26);
    if (e12 == null || e26 == null) return null;
    return e12 - e26;   /* la ligne MACD ; positif = momentum haussier */
  },
  bollinger: function (v, n) {
    var m = TA.sma(v, n), sd = TA.stddev(v, n);
    if (m == null || sd == null) return null;
    return { moyenne: m, haut: m + 2 * sd, bas: m - 2 * sd, largeur: (4 * sd) / m };
  },
  atr: function (candles, n) {
    if (candles.length < n + 1) return null;
    var s = 0;
    for (var i = candles.length - n; i < candles.length; i++) {
      var c = candles[i], p = candles[i - 1];
      var tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
      s += tr;
    }
    return s / n;
  },
  momentum: function (v, n) { if (v.length < n + 1) return null; return (v[v.length - 1] - v[v.length - 1 - n]) / v[v.length - 1 - n]; },
};

/* ==================================================================
 * 2. LE MOTEUR DE PREDICTION — une heuristique, pas un oracle
 * ================================================================== */
function PredictionEngine() {}
PredictionEngine.prototype.evalue = function (candles) {
  var closes = candles.map(function (c) { return c.c; });
  var vols = candles.map(function (c) { return c.v; });
  if (closes.length < 30) {
    return { sens: 'NEUTRAL', prob: 50, confiance: 'LOW', assez: false,
             raisons: [{ ok: false, texte: 'Not enough candles yet (' + closes.length + '/30)' }], scores: {} };
  }
  var raisons = [];
  var signaux = [];   /* chaque signal : -1 (baissier) a +1 (haussier) */

  var ema9 = TA.ema(closes, 9), ema21 = TA.ema(closes, 21);
  var croix = ema9 > ema21;
  signaux.push(croix ? 0.5 : -0.5);
  raisons.push({ ok: croix, texte: croix ? 'EMA9 above EMA21 (short-term up)' : 'EMA9 below EMA21 (short-term down)' });

  var mom = TA.momentum(closes, 5) || 0;
  signaux.push(Math.max(-1, Math.min(1, mom * 40)));
  raisons.push({ ok: mom >= 0, texte: (mom >= 0 ? 'Positive' : 'Negative') + ' 5-candle momentum (' + (mom * 100).toFixed(2) + '%)' });

  var rsi = TA.rsi(closes, 14);
  if (rsi != null) {
    var sr = rsi > 70 ? -0.4 : rsi < 30 ? 0.4 : (rsi - 50) / 50 * 0.3;
    signaux.push(sr);
    raisons.push({ ok: rsi >= 50, texte: 'RSI ' + rsi.toFixed(0) + (rsi > 70 ? ' (overbought)' : rsi < 30 ? ' (oversold)' : ' (neutral)') });
  }
  var macd = TA.macd(closes);
  if (macd != null) { signaux.push(macd > 0 ? 0.4 : -0.4); raisons.push({ ok: macd > 0, texte: 'MACD ' + (macd > 0 ? 'bullish' : 'bearish') }); }

  var bb = TA.bollinger(closes, 20);
  var vola = bb ? bb.largeur : 0;
  var volaHaute = vola > 0.03;
  if (volaHaute) raisons.push({ ok: false, texte: 'High volatility — direction less reliable', avert: true });

  var vAvg = TA.sma(vols, 20), vDer = vols[vols.length - 1];
  var volMonte = vAvg != null && vDer > vAvg;
  raisons.push({ ok: volMonte, texte: volMonte ? 'Volume rising' : 'Volume flat/falling' });

  /* Le score agrege, ramene a une probabilite. On BRIDE volontairement
     l ecart a 50 % : pretendre 90 % sur un tirage court terme serait
     mentir. Le maximum affichable est ~68 %, et c est deja optimiste. */
  var somme = 0; for (var i = 0; i < signaux.length; i++) somme += signaux[i];
  var moy = somme / signaux.length;                 /* -1..+1 */
  var ecart = Math.max(-0.18, Math.min(0.18, moy * 0.35));  /* bride volontaire : max ~68%, jamais une fausse certitude */
  var probUp = Math.round((0.5 + ecart) * 1000) / 10;
  var sens = probUp >= 50 ? 'UP' : 'DOWN';
  var prob = sens === 'UP' ? probUp : Math.round((100 - probUp) * 10) / 10;

  /* La confiance vient de la CONVERGENCE des signaux et de la volatilite,
     pas de l amplitude du pari. */
  var accord = signaux.filter(function (s) { return (s > 0) === (moy > 0); }).length / signaux.length;
  var confiance = 'LOW';
  if (accord >= 0.8 && !volaHaute) confiance = 'HIGH';
  else if (accord >= 0.6) confiance = 'MEDIUM';

  return { sens: sens, prob: prob, confiance: confiance, assez: true,
           volatilite: vola, raisons: raisons,
           scores: { momentum: mom, ema9: ema9, ema21: ema21, rsi: rsi, macd: macd, volatilite: vola } };
};

/* Signal multi-horizons : le meme moteur sur 1m/5m/15m/1h, plus un verdict
   global. Un desaccord entre horizons ABAISSE la confiance — c est une
   information, pas un defaut. */
PredictionEngine.prototype.multiHorizons = function (parIntervalle) {
  var out = {}, votes = [];
  for (var iv in parIntervalle) {
    var r = this.evalue(parIntervalle[iv]);
    out[iv] = r;
    if (r.assez) votes.push(r.sens === 'UP' ? 1 : r.sens === 'DOWN' ? -1 : 0);
  }
  var s = votes.reduce(function (a, b) { return a + b; }, 0);
  var global = s > 0 ? 'UP' : s < 0 ? 'DOWN' : 'NEUTRAL';
  var unanime = votes.length > 1 && Math.abs(s) === votes.length;
  out.global = { sens: global, unanime: unanime, votes: votes.length };
  return out;
};

/* ==================================================================
 * 3. BANKROLL, MARTINGALE, RISQUE
 * ================================================================== */
function BankrollManager(depart) {
  this.depart = depart; this.solde = depart;
  this.haut = depart; this.bas = depart;
  this.gains = 0; this.pertes = 0; this.wins = 0; this.losses = 0;
  this.serie = 0;                 /* + = serie de gains, - = serie de pertes */
  this.histo = [];
}
BankrollManager.prototype.applique = function (pl, meta) {
  this.solde += pl;
  if (pl > 0) { this.gains += pl; this.wins++; this.serie = this.serie >= 0 ? this.serie + 1 : 1; }
  else if (pl < 0) { this.pertes += -pl; this.losses++; this.serie = this.serie <= 0 ? this.serie - 1 : -1; }
  this.haut = Math.max(this.haut, this.solde);
  this.bas = Math.min(this.bas, this.solde);
  this.histo.push({ solde: this.solde, pl: pl, meta: meta || null });
  return this.solde;
};
BankrollManager.prototype.stats = function () {
  var n = this.wins + this.losses;
  var dd = 0, pic = this.depart;
  for (var i = 0; i < this.histo.length; i++) { pic = Math.max(pic, this.histo[i].solde);
    dd = Math.max(dd, (pic - this.histo[i].solde) / pic); }
  return {
    depart: this.depart, solde: this.solde, pl: this.solde - this.depart,
    roi: this.depart ? (this.solde - this.depart) / this.depart * 100 : 0,
    winRate: n ? this.wins / n * 100 : 0, lossRate: n ? this.losses / n * 100 : 0,
    trades: n, wins: this.wins, losses: this.losses,
    serie: this.serie, haut: this.haut, bas: this.bas, drawdownMax: dd * 100,
  };
};

/* La martingale. Elle DOUBLE apres une perte, revient au pari initial apres
   un gain, et — garde non negociable — ne mise JAMAIS plus que la bankroll
   disponible, ni plus que le plafond. */
function MartingaleEngine(cfg) {
  this.initial = cfg.initial; this.mult = cfg.mult || 2;
  this.maxBet = cfg.maxBet || Infinity;
  this.maxPertes = cfg.maxPertes || Infinity;
  this.miseCour = cfg.initial; this.pertesDaffilee = 0;
}
MartingaleEngine.prototype.prochaine = function (soldeDispo) {
  var m = Math.min(this.miseCour, this.maxBet);
  /* On ne mise jamais plus que ce qu on a : c est la garde qui empeche la
     martingale de demander l impossible. */
  return Math.max(0, Math.min(m, soldeDispo));
};
MartingaleEngine.prototype.resultat = function (gagne) {
  if (gagne) { this.miseCour = this.initial; this.pertesDaffilee = 0; }
  else { this.miseCour = this.miseCour * this.mult; this.pertesDaffilee++; }
  return this.pertesDaffilee;
};
/* La martingale a-t-elle atteint sa limite de securite (trop de pertes
   d affilee) — le moment ou elle DOIT s arreter avant la ruine. */
MartingaleEngine.prototype.bloquee = function () { return this.pertesDaffilee >= this.maxPertes; };

/* Le gestionnaire de risque : il PEUT dire non. Risque max par round,
   plafond de mise, perte quotidienne max. Quand une limite tombe, il met en
   pause et ne genere plus de mise — la protection demandee. */
function RiskManager(cfg) {
  this.maxRisquePct = cfg.maxRisquePct || 1;      /* % de la bankroll par round */
  this.maxBet = cfg.maxBet || Infinity;
  this.perteJourMax = cfg.perteJourMax || Infinity;
  this.drawdownMaxPct = cfg.drawdownMaxPct || Infinity;
  this.perteJour = 0; this.pause = false; this.pourquoi = null;
}
RiskManager.prototype.plafondMise = function (bankroll) {
  return Math.min(this.maxBet, bankroll.solde * this.maxRisquePct / 100);
};
RiskManager.prototype.autorise = function (mise, bankroll) {
  if (this.pause) return { ok: false, raison: this.pourquoi };
  if (this.perteJour >= this.perteJourMax) { this.pause = true; this.pourquoi = 'daily loss limit reached'; return { ok: false, raison: this.pourquoi }; }
  var dd = (bankroll.haut - bankroll.solde) / bankroll.haut * 100;
  if (dd >= this.drawdownMaxPct) { this.pause = true; this.pourquoi = 'max drawdown reached'; return { ok: false, raison: this.pourquoi }; }
  if (mise > bankroll.solde) return { ok: false, raison: 'bet exceeds bankroll' };
  return { ok: true, plafond: this.plafondMise(bankroll) };
};
RiskManager.prototype.noteResultat = function (pl) { if (pl < 0) this.perteJour += -pl; };

/* ==================================================================
 * 4. LE BACKTEST — il rejoue de VRAIES bougies et DIT la verite
 * ==================================================================
 * On rejoue les bougies historiques comme des rounds : le moteur predit sur
 * la fenetre passee, le round se resout par le mouvement REEL de la bougie
 * suivante. La precision qui en sort est reelle — et elle montre honnetement
 * que l heuristique ne bat pas le hasard. */
function backtest(candles, cfg) {
  cfg = cfg || {};
  var moteur = new PredictionEngine();
  var bank = new BankrollManager(cfg.bankroll || 1000);
  var mart = new MartingaleEngine({ initial: cfg.miseInitiale || 10, mult: cfg.mult || 2, maxBet: cfg.maxBet || Infinity, maxPertes: cfg.maxPertes || Infinity });
  var risk = new RiskManager({ maxRisquePct: cfg.maxRisquePct || 100, maxBet: cfg.maxBet || Infinity, perteJourMax: cfg.perteJourMax || Infinity });
  var fenetre = cfg.fenetre || 30;
  var justes = 0, rounds = 0, miseMax = 0, pertesAffilee = 0, pireSerie = 0;
  for (var i = fenetre; i < candles.length - 1; i++) {
    var vue = candles.slice(0, i + 1);
    var pred = moteur.evalue(vue);
    if (!pred.assez || pred.sens === 'NEUTRAL') continue;
    var mise = mart.prochaine(bank.solde);
    var aut = risk.autorise(mise, bank);
    if (!aut.ok || mise <= 0) break;            /* le risque a dit stop : on arrete, comme en vrai */
    var ouvre = candles[i].c, ferme = candles[i + 1].c;
    var monte = ferme > ouvre;
    var gagne = (pred.sens === 'UP') === monte;
    rounds++; if (gagne) justes++;
    var pl = gagne ? mise : -mise;              /* binaire simplifie : paye 1:1 */
    bank.applique(pl, { sens: pred.sens, mise: mise, gagne: gagne });
    risk.noteResultat(pl);
    mart.resultat(gagne);
    miseMax = Math.max(miseMax, mise);
    pertesAffilee = gagne ? 0 : pertesAffilee + 1;
    pireSerie = Math.max(pireSerie, pertesAffilee);
  }
  var st = bank.stats();
  return {
    rounds: rounds, precision: rounds ? justes / rounds * 100 : 0,
    depart: st.depart, fin: st.solde, roi: st.roi, drawdownMax: st.drawdownMax,
    miseMax: miseMax, pireSeriePertes: pireSerie, ruine: bank.solde < (cfg.miseInitiale || 10),
    /* La ligne honnete : la precision reelle du moteur sur ces donnees. */
    note: 'Real accuracy on this data. A heuristic on short-term direction sits near 50% — this is not an edge.',
  };
}

if (typeof window !== 'undefined') {
  window.SwogePredict = { TA: TA, PredictionEngine: PredictionEngine, BankrollManager: BankrollManager,
    MartingaleEngine: MartingaleEngine, RiskManager: RiskManager, backtest: backtest };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TA: TA, PredictionEngine: PredictionEngine, BankrollManager: BankrollManager,
    MartingaleEngine: MartingaleEngine, RiskManager: RiskManager, backtest: backtest };
}
