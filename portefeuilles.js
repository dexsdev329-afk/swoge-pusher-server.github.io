'use strict';
/* ==================================================================
 * LES PORTEFEUILLES QUI ACHETENT TOT — MESURES, PAS SUPPOSES (28 septembre 2026)
 * ==================================================================
 *
 * Pourquoi : dans l'analyse des services x402 les plus payes (x402scan,
 * 30 jours, releve du 26/09), la « smart money » de Nansen est la seule case
 * crypto qu'on ne couvrait pas. Nansen etiquette des portefeuilles ; nous,
 * on a mieux sur Robinhood Chain : la colonie JUGE chaque jeton qu'elle
 * examine, a trente minutes, au prix qu'on pourrait vraiment en sortir
 * (`rendementVendable`). Il suffit de relier ce jugement a ceux qui avaient
 * achete ce jeton AVANT que la colonie le regarde.
 *
 * Ce qu'on garde : pour chaque jeton examine (jeune, hors observation) dont
 * les trades ont ete lus, les acheteurs distincts vus dans ces trades — au
 * plus ACHETEURS_MAX, les plus anciens d'abord. GeckoTerminal rend les 300
 * derniers trades, les plus recents d'abord (verifie le 28/09 sur un pool
 * actif : 300 trades couvraient 11 minutes) : sur un jeton tres actif, ce ne
 * sont donc pas les tout premiers acheteurs, mais ceux d'avant le regard.
 * A l'echeance de reference (30 min), le rendement du jeton est credite a
 * chacun, UNE fois par jeton.
 *
 * Ce qu'on en dit : un portefeuille ne recoit un verdict qu'a partir de
 * PORTEFEUILLE_ASSEZ jetons juges. Au-dessus, sa part de montees (>= +20 % a
 * 30 min) et sa part d'effondrements (<= -30 %) — les definitions de l'audit
 * — sont comparees a celles de TOUS les couples (portefeuille, jeton), ce
 * qu'obtient un acheteur pris au hasard, par un ecart en ecarts-types
 * binomiaux. Sous 2 : aucun avantage mesurable ; plus de montees ET plus
 * d'effondrements : « mixed ». En dessous du seuil de
 * jetons : le nombre, et le refus de conclure.
 *
 * Rien dans la colonie ne DECIDE sur ces chiffres : c'est une mesure, vendue
 * comme telle (outil `smart_money`). Si un jour elle doit devenir un trait,
 * l'audit la jugera d'abord.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const ACHETEURS_MAX = 60;          /* par jeton : ~2,6 Ko, et un jeton actif en montre ~85 dans 300 trades */
const PORTEFEUILLE_ASSEZ = 10;     /* jetons juges avant tout verdict sur un portefeuille */
const Z_VERDICT = 2;               /* ~95 % : en dessous, l'ecart est de la chance */
const MONTEE = 20, EFFONDRE = -30; /* comme noteAudit (ai_colonie.js) */
const PORTEFEUILLES_MAX = 40000;   /* ~5 Mo sur le disque ; au-dela, les moins revus partent */
const ATTENTE_MS = 4 * 3600e3;     /* un jeton non juge en 4 h (ombre partie) est oublie */
const SAUVE_MS = 10 * 60e3;
const DERNIERS = 3;                /* les derniers jetons d'un portefeuille, montres tels quels */

const adresse = (a) => /^0x[0-9a-f]{40}$/.test(a);

function cree(o) {
  o = o || {};
  const maintenant = o.maintenant || Date.now;
  const fichier = o.fichier || null;
  let P = neuf();
  let sauveA = 0;

  function neuf() {
    return { v: 1, w: {}, attente: {}, ref: { n: 0, montes: 0, effondres: 0, s: 0 }, jetons: { n: 0, montes: 0 }, mesure: { notes: 0, credites: 0, oublies: 0, elagues: 0 } };
  }

  /** Les acheteurs distincts d'une liste de trades GeckoTerminal, les plus anciens d'abord. */
  function acheteursDe(trades) {
    const l = (trades || []).filter((a) => String(a.kind) === 'buy' && adresse(String(a.tx_from_address || '').toLowerCase()));
    l.sort((a, b) => (Date.parse(a.block_timestamp) || 0) - (Date.parse(b.block_timestamp) || 0));
    const vus = [];
    for (const a of l) {
      const w = String(a.tx_from_address).toLowerCase();
      if (vus.indexOf(w) < 0) vus.push(w);
      if (vus.length >= ACHETEURS_MAX) break;
    }
    return vus;
  }

  /** Un jeton regarde : ses acheteurs attendent son jugement. Le premier regard seul compte. */
  function note(jeton, sym, acheteurs) {
    const j = String(jeton || '').toLowerCase();
    if (!adresse(j) || !Array.isArray(acheteurs) || !acheteurs.length || P.attente[j]) return false;
    P.attente[j] = { t: maintenant(), sym: String(sym || '?').slice(0, 12), w: acheteurs.slice(0, ACHETEURS_MAX) };
    P.mesure.notes++;
    return true;
  }

  /** Le jeton est juge (rendement vendable a l'echeance de reference) : chaque acheteur est credite, une fois.
   *  `tOmbre` : quand l'ombre jugee a ete posee. Une ombre plus ANCIENNE que la liste d'acheteurs
   *  (un premier refus, avant que les trades soient lus) mesure une fenetre ou certains n'etaient
   *  pas encore entres : elle ne credite personne, et la liste attend l'ombre de son propre regard. */
  function juge(jeton, r, tOmbre) {
    const j = String(jeton || '').toLowerCase();
    const a = P.attente[j];
    if (!a || !isFinite(r)) return 0;
    if (tOmbre !== undefined && tOmbre < a.t - 60e3) return 0;
    delete P.attente[j];
    const t = maintenant();
    const monte = r >= MONTEE, effondre = r <= EFFONDRE;
    P.jetons.n++; if (monte) P.jetons.montes++;
    for (const w of a.w) {
      const x = P.w[w] || (P.w[w] = { n: 0, montes: 0, effondres: 0, s: 0, t0: t, t: t, d: [] });
      x.n++; x.s += r; x.t = t;
      if (monte) x.montes++;
      if (effondre) x.effondres++;
      x.d.unshift([a.sym, Math.round(r * 10) / 10, j]);
      if (x.d.length > DERNIERS) x.d.length = DERNIERS;
      P.ref.n++; P.ref.s += r;
      if (monte) P.ref.montes++;
      if (effondre) P.ref.effondres++;
    }
    P.mesure.credites++;
    elague();
    return a.w.length;
  }

  function elague() {
    const t = maintenant();
    for (const j of Object.keys(P.attente)) if (t - P.attente[j].t > ATTENTE_MS) { delete P.attente[j]; P.mesure.oublies++; }
    const cles = Object.keys(P.w);
    if (cles.length <= PORTEFEUILLES_MAX) return;
    /* Ceux qui ont le moins de jetons juges, puis les moins recemment revus, partent d'abord :
       un portefeuille a un seul jeton ne dira jamais rien, un a douze est une mesure. */
    cles.sort((a, b) => (P.w[a].n - P.w[b].n) || (P.w[a].t - P.w[b].t));
    const n = cles.length - Math.floor(PORTEFEUILLES_MAX * 0.9);
    for (let i = 0; i < n; i++) delete P.w[cles[i]];
    P.mesure.elagues += n;
  }

  /** La part de montees d'un acheteur pris au hasard : la reference contre laquelle chacun se juge. */
  function reference() {
    const R = P.ref;
    return { pairs: R.n, risePct: R.n ? Math.round(R.montes / R.n * 1000) / 10 : null,
             collapsePct: R.n ? Math.round(R.effondres / R.n * 1000) / 10 : null,
             meanPct: R.n ? Math.round(R.s / R.n * 10) / 10 : null, tokens: P.jetons.n };
  }

  /** Ce qu'on sait d'un portefeuille, en anglais (c'est vendu tel quel). */
  function fiche(adr) {
    const w = String(adr || '').toLowerCase();
    const x = P.w[w];
    if (!x) return { address: w, tokensJudged: 0, verdict: 'unknown', note: 'never seen buying a token the colony judged' };
    const out = { address: w, tokensJudged: x.n, risePct: Math.round(x.montes / x.n * 1000) / 10,
      collapsePct: Math.round(x.effondres / x.n * 1000) / 10, meanPct: Math.round(x.s / x.n * 10) / 10,
      firstSeen: new Date(x.t0).toISOString(), lastSeen: new Date(x.t).toISOString(),
      recent: x.d.map((d) => ({ symbol: d[0], change30mPct: d[1], token: d[2] })) };
    if (x.n < PORTEFEUILLE_ASSEZ) return Object.assign(out, { verdict: 'not_enough_data', z: null, zCollapse: null,
      note: x.n + ' judged token(s); no verdict under ' + PORTEFEUILLE_ASSEZ + ' — a few tokens are luck, not skill' });
    const R = P.ref;
    const p0 = R.n ? R.montes / R.n : 0, q0 = R.n ? R.effondres / R.n : 0;
    if (!(p0 > 0 && p0 < 1 && q0 > 0 && q0 < 1) || R.n < 200) return Object.assign(out, { verdict: 'not_enough_data', z: null, zCollapse: null, note: 'the reference itself is too thin (' + R.n + ' wallet-token pairs)' });
    /* Deux faces, comme l'audit (montes / effondres) : sur douze jetons, zero montee
       contre 20 % ne s'ecarte pas assez (z -1,8) — douze effondrements sur douze,
       si. Bat le hasard : plus de montees, SANS plus d'effondrements. */
    const z = (x.montes / x.n - p0) / Math.sqrt(p0 * (1 - p0) / x.n);
    const zc = (x.effondres / x.n - q0) / Math.sqrt(q0 * (1 - q0) / x.n);
    out.z = Math.round(z * 100) / 100;
    out.zCollapse = Math.round(zc * 100) / 100;
    /* Plus de montees ET plus d'effondrements : un joueur de loterie, ni meilleur ni pire — on le dit. */
    out.verdict = (z >= Z_VERDICT && zc >= Z_VERDICT) ? 'mixed' : (zc >= Z_VERDICT || z <= -Z_VERDICT) ? 'worse_than_random_buyers'
      : z >= Z_VERDICT ? 'beats_random_buyers' : 'no_measurable_edge';
    out.note = 'rises (>= +20% at 30 min) ' + out.risePct + '% and collapses (<= -30%) ' + out.collapsePct + '% of ' + x.n + ' tokens, vs '
      + Math.round(p0 * 1000) / 10 + '% and ' + Math.round(q0 * 1000) / 10 + '% for a random buyer';
    return out;
  }

  /** Les acheteurs d'un jeton, chacun avec sa fiche : les mesures d'abord, puis le reste. */
  function lit(acheteurs) {
    const f = (acheteurs || []).map(fiche);
    const rang = { beats_random_buyers: 0, worse_than_random_buyers: 1, mixed: 2, no_measurable_edge: 3, not_enough_data: 4, unknown: 5 };
    f.sort((a, b) => (rang[a.verdict] - rang[b.verdict]) || (b.tokensJudged - a.tokensJudged));
    const c = (v) => f.filter((x) => x.verdict === v).length;
    return { buyers: f.length, measured: f.filter((x) => x.z !== null && x.z !== undefined).length,
      beatRandom: c('beats_random_buyers'), worseThanRandom: c('worse_than_random_buyers'), mixed: c('mixed'), noEdge: c('no_measurable_edge'), wallets: f };
  }

  /** Les portefeuilles mesures qui battent le hasard, les plus nets d'abord. */
  function meilleurs(limite) {
    const l = [];
    for (const w of Object.keys(P.w)) if (P.w[w].n >= PORTEFEUILLE_ASSEZ) l.push(fiche(w));
    return l.filter((x) => x.verdict === 'beats_random_buyers').sort((a, b) => b.z - a.z).slice(0, limite || 20);
  }

  function resume() {
    let mesures = 0;
    for (const w of Object.keys(P.w)) if (P.w[w].n >= PORTEFEUILLE_ASSEZ) mesures++;
    return { wallets: Object.keys(P.w).length, measured: mesures, waiting: Object.keys(P.attente).length, reference: reference(), mesure: Object.assign({}, P.mesure) };
  }

  function sauve(force) {
    if (!fichier) return;
    const t = maintenant();
    if (!force && t - sauveA < SAUVE_MS) return;
    sauveA = t;
    try {
      fs.mkdirSync(path.dirname(fichier), { recursive: true });
      fs.writeFileSync(fichier + '.tmp', JSON.stringify(P));
      fs.renameSync(fichier + '.tmp', fichier);
    } catch (e) { /* disque plein : la mesure continue en memoire */ }
  }
  function charge() {
    if (!fichier) return;
    try {
      const x = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      if (x && x.v === 1 && x.w && x.ref) P = Object.assign(neuf(), x);
    } catch (e) { /* premier demarrage */ }
  }
  function vide() { P = neuf(); }

  return { acheteursDe, note, juge, fiche, lit, meilleurs, reference, resume, sauve, charge, vide, _etat: () => P };
}

module.exports = { cree, ACHETEURS_MAX, PORTEFEUILLE_ASSEZ, Z_VERDICT, PORTEFEUILLES_MAX, MONTEE, EFFONDRE };
