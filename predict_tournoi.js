'use strict';
/* ==========================================================================
 * PREDICT — LE TOURNOI DES STRATEGIES SUR LES VRAIS ROUNDS PANCAKESWAP (30/09/2026)
 *
 * Demande du proprietaire, apres le tournoi de Polymarket AI : « sur SWOGE
 * Predict, on ne peut pas faire pareil ? ». La meme regle : une strategie
 * encore en perte apres SEUIL paris est retiree, une en gain est rejugee
 * SEUIL plus loin ; tout ce qui a ete essaye est garde.
 *
 * ---- CE QUI CHANGE ICI : L HISTOIRE EST DEJA LA ----
 * Le journal garde chaque round regle du contrat (pancake_rounds.jsonl) :
 * 30 783 rounds sur 104 jours le 30/09. Sur PancakeSwap, le gain d un pari se
 * lit EXACTEMENT apres coup : la cote payee est celle des pools FINAUX, notre
 * mise diluee dans notre camp, 3 % de frais, gaz reel (rendement() du journal).
 * Tout ce qui manque a l histoire, c est le pool VISIBLE au moment de decider.
 * Les strategies d ici ne lisent donc que ce qui etait CONNU a la decision
 * (≥ 45 s avant le lock du round e) :
 *   - l issue des rounds ≤ e − 2 (fermes) ;
 *   - les pools finaux et le prix de lock des rounds ≤ e − 1 (le round e − 1 est
 *     verrouille : ses pools ne bougent plus, son lockPrice est publie) ;
 *   - l heure.
 * Jamais l issue de e − 1, jamais le pool de e. Un essai le verifie.
 *
 * ---- DEUX TEMPS ----
 * 1. L HISTOIRE (rounds avant `depuisEp`, fixe au premier demarrage) : toutes
 *    les strategies y passent d un coup, dans l ordre des rounds, et la regle
 *    des 500 elimine au fil de l eau. C est de l exploration : ces rounds ont
 *    deja ete vus (le releve du 26/09 y a essaye ~40 regles).
 * 2. LE DIRECT (rounds ≥ `depuisEp`, jamais vus) : les survivantes continuent ;
 *    SEULS ces rounds jugent. Un « edge » exige, en direct : n ≥ SEUIL, t au-dessus
 *    de la barre du nombre de regles essayees (Bonferroni, 5 %), et les deux
 *    moities positives — la regle des ombres (predict_pancake_journal.js), a la
 *    barre du nombre essaye au lieu de 2,7.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');
const J = require('./predict_pancake_journal');

const SEUIL = 500;                 /* la regle du proprietaire (30/09) */
const MISE = 0.002, FEE = 0.03;    /* la mise papier de production, les frais du contrat (treasuryFee 300, lu le 27/09) */
/* Deja essayees sur ces memes rounds avant ce tournoi : ~40 regles (releve du 26/09, §5) et
   les 5 ombres. Elles comptent dans la barre : chercher plus fait monter la barre. */
const DEJA_ESSAYEES = 45;

/* ---- les strategies : une famille = une idee, des reglages pris a l avance ---- */
const HEURES = [null, [0, 8], [8, 16], [16, 24]];
function creeStrategies() {
  const L = [];
  const pousse = (famille, p, nom) => {
    for (const h of HEURES) {
      const c = Object.assign({ famille }, p, h ? { h } : {});
      L.push({ id: famille + ':' + Object.values(p).join(':') + (h ? ':h' + h[0] : ''), nom: nom + (h ? ' · ' + h[0] + '–' + h[1] + ' h UTC' : ''), config: c });
    }
  };
  for (const k of [1, 2, 3, 4, 5, 6]) for (const sens of ['suit', 'contre'])
    pousse('serie', { k, sens }, (sens === 'suit' ? 'Follow' : 'Fade') + ' a streak of ' + k);
  for (const s of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8]) for (const sens of ['suit', 'contre'])
    pousse('foule', { s, sens }, (sens === 'suit' ? 'With' : 'Against') + ' last round\'s crowd ≥ ' + Math.round(s * 100) + '%');
  for (const k of [1, 2, 3, 6, 12]) for (const x of [0.0005, 0.001, 0.002, 0.003, 0.005]) for (const sens of ['suit', 'contre'])
    pousse('elan', { k, x, sens }, (sens === 'suit' ? 'With' : 'Against') + ' a ' + (x * 100).toFixed(2) + '% move over ' + k * 5 + ' min');
  /* Les temoins : aucun signal. Jamais retires. */
  L.push({ id: 'bull', nom: 'Always BULL (control)', config: { famille: 'bull' }, temoin: true });
  L.push({ id: 'bear', nom: 'Always BEAR (control)', config: { famille: 'bear' }, temoin: true });
  L.push({ id: 'piece', nom: 'Coin flip (control)', config: { famille: 'piece' }, temoin: true });
  return L;
}
const STRATEGIES = creeStrategies();

/* ---- ce qu on savait avant le round e : les lignes STRICTEMENT anterieures ----
 * `passe` : les lignes des rounds ≤ e − 1, du plus recent au plus ancien. On n y lit
 * l issue (lp→cp) qu a partir de e − 2. Pur. */
const cote = (l) => (l && l.oc ? (l._g || (l._g = J.gagnantDe(l))) : null);
function camp(cfg, e, passe, lockE) {
  if (cfg.h) { const h = new Date(lockE * 1000).getUTCHours(); if (h < cfg.h[0] || h >= cfg.h[1]) return null; }
  const inv = (x) => (x === 'BULL' ? 'BEAR' : x === 'BEAR' ? 'BULL' : null);
  const oriente = (x) => (cfg.sens === 'contre' ? inv(x) : x);
  switch (cfg.famille) {
    case 'bull': return 'BULL';
    case 'bear': return 'BEAR';
    case 'piece': return (Math.imul(e, 2654435761) >>> 16) & 1 ? 'BULL' : 'BEAR';
    case 'serie': {
      /* e − 1 n a pas d issue connue : la serie commence a e − 2. */
      let g0 = null;
      for (let i = 0; i < cfg.k; i++) {
        const l = passe[i] && passe[i].ep === e - 1 ? passe[i + 1] : passe[i];   /* passe[0] est e − 1 s il est la */
        if (!l || l.ep !== e - 2 - i) return null;
        const g = cote(l);
        if (g !== 'BULL' && g !== 'BEAR') return null;
        if (g0 === null) g0 = g; else if (g !== g0) return null;
      }
      return oriente(g0);
    }
    case 'foule': {
      const l = passe[0];
      if (!l || l.ep !== e - 1 || !(l.tot > 0)) return null;
      const part = l.bull / l.tot;
      if (Math.max(part, 1 - part) < cfg.s) return null;
      return oriente(part >= 0.5 ? 'BULL' : 'BEAR');
    }
    case 'elan': {
      const a = passe[0], b = passe[cfg.k];
      if (!a || !b || a.ep !== e - 1 || b.ep !== e - 1 - cfg.k) return null;
      const pa = Number(a.lp), pb = Number(b.lp);
      if (!(pa > 0) || !(pb > 0)) return null;
      const r = pa / pb - 1;
      if (Math.abs(r) < cfg.x) return null;
      return oriente(r > 0 ? 'BULL' : 'BEAR');
    }
  }
  return null;
}

/* ---- la barre : Bonferroni 5 % unilateral sur le nombre de regles essayees ---- */
function phi(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2); return x >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
function barre(n) { const c = 0.05 / Math.max(1, n); let a = 0, b = 10; for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (1 - phi(m) > c) a = m; else b = m; } return b; }

/* ---- le tournoi : un passage, dans l ordre des rounds ----
 * `lignes` : les rounds regles (forme du journal), dans n importe quel ordre.
 * `depuisEp` : premier round du DIRECT. Pur : meme entree, meme sortie. */
function joue(lignes, depuisEp, liste) {
  const it = etapes(lignes, depuisEp, liste);
  let r = it.next(); while (!r.done) r = it.next();
  return r.value;
}
/* La meme chose, rendue a la boucle d evenements tous les TRANCHE rounds : mesure du 30/09, un
   passage de 31 000 rounds × 299 strategies prend ~2 s de calcul — d un bloc, il gelerait le
   serveur de jeu (WebSocket, paris) pendant tout ce temps. */
const TRANCHE = 300;   /* mesure du 30/09 (31 000 rounds) : 1 000 par tranche bloquaient jusqu a 103 ms d affilee ; 300, 47 ms */
async function joueParTranches(lignes, depuisEp, liste) {
  const it = etapes(lignes, depuisEp, liste);
  let r = it.next();
  while (!r.done) { await new Promise((ok) => setImmediate(ok)); r = it.next(); }
  return r.value;
}
function* etapes(lignes, depuisEp, liste) {
  const LISTE = liste || STRATEGIES;
  const R = lignes.filter((l) => l && l.ep > 0).sort((a, b) => a.ep - b.ep);
  /* `c` : sommes courantes sur tout (histoire + direct) — 30 000 rounds × 300 strategies ne
     tiennent pas en memoire une observation a la fois ; `direct` : les observations du direct,
     peu nombreuses, gardees une par une (les deux moities en ont besoin). */
  const S = new Map(LISTE.map((s) => [s.id, { c: { n: 0, g: 0, s: 0, s2: 0 }, direct: [], palier: SEUIL, retiree: null }]));
  const passe = [];   /* du plus recent au plus ancien, borne */
  const PASSE_MAX = 16;
  let k = 0;
  for (const l of R) {
    if (++k % TRANCHE === 0) yield k;
    const e = l.ep;
    /* le round e se decide AVANT son lock : `passe` ne contient que ≤ e − 1 */
    while (passe.length && passe[0].ep >= e) passe.shift();
    for (const s of LISTE) {
      const st = S.get(s.id);
      if (st.retiree) continue;
      const cc = camp(s.config, e, passe, l.lock);
      if (!cc) continue;
      const x = J.rendement(cc, l, FEE, MISE);
      if (!x) continue;                                   /* annule : rembourse, ne compte pas */
      const c = st.c; c.n++; c.g += x.g ? 1 : 0; c.s += x.r; c.s2 += x.r * x.r;
      if (depuisEp && e >= depuisEp) st.direct.push([e, x.r, x.g ? 1 : 0]);
      if (!s.temoin && c.n >= st.palier) {
        if (c.s < 0) st.retiree = { ep: e, n: c.n, ev: Math.round(c.s / c.n * 10000) / 100, direct: !!(depuisEp && e >= depuisEp) };
        else st.palier += SEUIL;
      }
    }
    passe.unshift(l); if (passe.length > PASSE_MAX) passe.pop();
  }
  return S;
}

/* ---- la vue ---- */
function sommes(c) {
  if (!c.n) return { n: 0, taux: null, ev: null, t: null };
  const m = c.s / c.n, v = c.n > 1 ? Math.max(0, (c.s2 - c.n * m * m) / (c.n - 1)) : 0, se = Math.sqrt(v / c.n);
  return { n: c.n, taux: Math.round(1000 * c.g / c.n) / 10, ev: Math.round(m * 10000) / 100, t: se > 0 ? Math.round(m / se * 100) / 100 : null };
}
function vue(S, depuisEp, nRounds, liste) {
  const LISTE = liste || STRATEGIES;
  const essayees = LISTE.length + DEJA_ESSAYEES, b = barre(essayees);
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const lignes = LISTE.map((s) => {
    const st = S.get(s.id), T = sommes(st.c), D = J.statsSerie(st.direct);
    const prouve = D.n >= SEUIL && D.t != null && D.t >= b && D.moitie1 > 0 && D.moitie2 > 0;
    return { id: s.id, name: s.nom, control: !!s.temoin, family: s.config.famille,
             history: { n: T.n, winRate: T.taux, ev: T.ev, t: T.t },
             live: { n: D.n, winRate: D.taux, ev: D.ev, se: D.se, t: D.t, half1: D.moitie1, half2: D.moitie2 },
             retired: st.retiree ? { atRound: st.retiree.ep, bets: st.retiree.n, ev: st.retiree.ev, live: st.retiree.direct } : null,
             nextJudgedAt: s.temoin || st.retiree ? null : st.palier, proven: prouve };
  });
  const enCourse = lignes.filter((l) => !l.retired && !l.control);
  /* Celles qui ont passe au moins un jugement d abord : un t sur 2 paris ne veut rien dire
     (sur 7 500 vrais rounds le 30/09, une strategie a 2 paris sortait en tete a t = 5,3). */
  const parT = (x, y) => (y.history.n >= SEUIL) - (x.history.n >= SEUIL) || (y.history.t || -99) - (x.history.t || -99);
  return {
    threshold: SEUIL, stakeBnb: MISE, fee: FEE, liveSinceEpoch: depuisEp || null, roundsRead: nRounds,
    tested: essayees, testedHere: LISTE.length, testedBefore: DEJA_ESSAYEES, bar: r2(b),
    running: enCourse.length, retired: lignes.filter((l) => l.retired).length, retiredLive: lignes.filter((l) => l.retired && l.retired.live).length,
    proven: lignes.filter((l) => l.proven).length,
    liveJudgeable: enCourse.filter((l) => l.live.n >= SEUIL).length,
    controls: lignes.filter((l) => l.control),
    survivors: enCourse.slice().sort(parT).slice(0, 15),
    bestRetired: lignes.filter((l) => l.retired).sort(parT).slice(0, 5),
    rule: 'Every strategy reads only what was known before the round locks (results up to two rounds back, the last round\'s final pools and lock price, the hour) and is paid at the real final odds with our stake diluted, the 3% fee and real gas. A strategy still in the red after ' + SEUIL +
      ' bets is retired; one in profit is judged again ' + SEUIL + ' bets later. The past rounds were already seen, so they only explore: an edge needs ' + SEUIL + '+ LIVE rounds, a t above the ' + r2(b) + ' bar set by the ' + essayees + ' rules tried on these rounds, and both halves in profit.',
  };
}

/* ---- le service : relit le journal au plus une fois par round ---- */
const ETAT = { depuisEp: null, calcule: 0, vue: null, enCours: false, rounds: 0, erreur: null };
function fichierEtat() { return path.join(process.env.DATA_DIR || require('./config').DATA_DIR, 'predict_tournoi.json'); }
function chargeEtat() { try { const o = JSON.parse(fs.readFileSync(fichierEtat(), 'utf8')); if (o && o.depuisEp > 0) ETAT.depuisEp = o.depuisEp; } catch (e) { /* premier demarrage */ } }
async function recalcule(maintenantMs) {
  if (ETAT.enCours) return;
  ETAT.enCours = true;
  try {
    const lignes = [];
    await lisRounds((l) => lignes.push({ ep: Number(l.ep), lock: l.lock, lp: l.lp, cp: l.cp, tot: l.tot, bull: l.bull, bear: l.bear, oc: l.oc }));
    if (!ETAT.depuisEp && lignes.length) {
      /* Le direct commence au round qui suit le plus recent deja lu : fixe une fois, garde sur le disque. */
      ETAT.depuisEp = lignes.reduce((m, l) => Math.max(m, l.ep), 0) + 1;
      try { fs.mkdirSync(path.dirname(fichierEtat()), { recursive: true }); fs.writeFileSync(fichierEtat(), JSON.stringify({ depuisEp: ETAT.depuisEp, fixeLe: new Date(maintenantMs || Date.now()).toISOString() })); } catch (e) { /* on recalculera */ }
    }
    ETAT.rounds = lignes.length;
    ETAT.vue = vue(await joueParTranches(lignes, ETAT.depuisEp), ETAT.depuisEp, lignes.length);
    ETAT.calcule = maintenantMs || Date.now(); ETAT.erreur = null;
  } catch (e) { ETAT.erreur = String(e && e.message || e).slice(0, 120); }
  finally { ETAT.enCours = false; }
}
async function lisRounds(fn) {
  const f = J.fichierRounds();
  if (!fs.existsSync(f)) return;
  const rl = require('readline').createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
  const vus = new Set();
  for await (const s of rl) { if (!s) continue; let o; try { o = JSON.parse(s); } catch (e) { continue; } if (vus.has(o.ep)) continue; vus.add(o.ep); fn(o); }
}
/* Appele a chaque tic du moteur Pancake : un recalcul par round de 300 s, en tache de fond. */
function tic(maintenantMs) {
  const t = maintenantMs || Date.now();
  if (!ETAT.depuisEp && !ETAT.calcule) chargeEtat();
  if (t - ETAT.calcule >= 300000) recalcule(t).catch(() => {});
}
function etat() { return ETAT.vue ? Object.assign({ computedAt: new Date(ETAT.calcule).toISOString() }, ETAT.vue) : { pending: true, error: ETAT.erreur }; }

module.exports = { STRATEGIES, creeStrategies, camp, joue, joueParTranches, vue, TRANCHE, barre, tic, etat, recalcule, SEUIL, DEJA_ESSAYEES, MISE, FEE,
                   _etat: () => ETAT, _reset: () => { ETAT.depuisEp = null; ETAT.calcule = 0; ETAT.vue = null; ETAT.rounds = 0; ETAT.erreur = null; } };
