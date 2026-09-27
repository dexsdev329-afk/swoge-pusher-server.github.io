'use strict';
/* ==========================================================================
 * LE REJEU LONG DE LA COLONIE PERP — LA PORTE DE TOUT CHANGEMENT DE REGLE
 *
 * ---- POURQUOI IL EXISTE (rapport du 26 septembre 2026) ----
 *
 * En direct, la colonie ferme ~17,9 trades par jour. L ecart-type d un trade
 * net vaut 1,44 % : detecter +0,11 % par trade demande ~1 060 trades, soit
 * 59 jours, et ~300 jours par marche. Chaque regle ou geometrie changee
 * jusqu ici l a ete sur un test qui ne mesurait pas la regle en service :
 * `perp_edge.js` rejouait `trend` SEUL, une entree a CHAQUE bougie (trades
 * qui se chevauchent : n = 13 923 pour ~500 independants), financement et
 * carnet a null. Son « +0,110 % net maker » avait t ≈ 1,1 une fois groupe par
 * jour. La regle en service, rejouee sans chevauchement sur 31 jours
 * (n = 330) : −0,075 ± 0,068 net aux frais reels.
 *
 * Ce script rejoue donc la VRAIE colonie — `ai_perp.tour()` lui-meme, pas une
 * copie : note entiere (Trend, Funding, Range, Session, memoire), vetos,
 * soupape, un creneau par marche, deux au plus dans un sens, ombres et
 * memoire qui apprennent en route — sur 12 a 24 mois de bougies Bitget
 * 15 min, avec les frais REELS par type d ordre et le financement reel.
 *
 * ---- LA METHODE, ET CE QU ELLE REFUSE ----
 *   - SANS CHEVAUCHEMENT : c est la colonie qui decide, avec ses creneaux ;
 *     un trade n existe que si une position etait libre pour le prendre.
 *   - REGLER SUR L ANCIEN, JUGER SUR LE RECENT : les `--garde` derniers mois
 *     (3 par defaut, 6 au plus) sont mis a part. Les variantes se classent
 *     sur l ancien ; la meilleure, et le service, se jugent sur la garde.
 *   - n, net ± erreur-type GROUPEE PAR JOUR (les 5 cryptos bougent ensemble :
 *     ρ = 0,76 a 4 h, mesure du 26/09), les deux moities de chaque periode,
 *     et le NOMBRE DE VARIANTES essayees — sur ce lancement ET en cumul sur
 *     la meme fenetre de garde (`essais.ndjson`) : une garde qu on a
 *     consultee vingt fois n est plus une garde.
 *   - AUCUNE CONCLUSION si la borne basse (net − 1,96 × se) est ≤ 0.
 *
 * ---- LA PORTE ----
 * Aucun seuil, poids, veto ou geometrie de `ai_perp.js` ne change sans une
 * ligne de ce rejeu dans le commentaire qui le change : variante, n sur la
 * garde, net ± se, borne basse, moities, nombre de variantes. Et le rejeu doit
 * CONCLURE (borne basse > 0) — sinon on ne change rien. C est la meme
 * discipline que l audit de la colonie de jetons, appliquee a l avance.
 *
 * ---- CE QUE LE REJEU NE SAIT PAS (dit, pas cache) ----
 *   - Book (le carnet en tete, ±6 points) n a pas d historique : il se tait.
 *   - Le financement Bitget n est servi que ~90 jours en arriere (verifie le
 *     27/09/2026 : 3 pages de 100, jusqu au 29/06/2026). Avant, le rejeu
 *     prend Hyperliquid (`fundingHistory`, horaire, somme sur 8 h) comme
 *     approximation, et MESURE l accord des deux sur la periode commune. La
 *     garde de 3 mois tombe entierement dans le financement Bitget reel.
 *   - Le taux lu a l instant T est le dernier REGLE (pas le taux predit que
 *     montre le ticker) : aucune fuite du futur, un leger retard.
 *   - Decision toutes les 15 min (5 en service) : la soupape est portee a
 *     4 tours (1 h, comme 12 × 5 min). Stops et cibles jugés sur les plus
 *     hauts et plus bas 15 min, stop d abord si les deux sont dans la bougie.
 *
 *   node outils/perp_rejeu.js                     # 24 mois, garde 3, grille
 *   node outils/perp_rejeu.js --mois 12 --garde 6
 *   node outils/perp_rejeu.js --variantes service
 *   node outils/perp_rejeu.js --essaie PERP_STOP_VOL=3,PERP_CIBLE_VOL=5
 *   node outils/perp_rejeu.js --json               # et le resultat en JSON
 *
 * Lecture seule, API publiques, aucune cle, aucun ordre. Le cache
 * (`data/perp_rejeu/`, hors depot : `data/` est dans .gitignore) garde les
 * mois complets ; seul le mois en cours se relit.
 * ======================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const BITGET = 'https://api.bitget.com/api/v2/mix/market';
const PRODUIT = 'USDT-FUTURES';
const HL = 'https://api.hyperliquid.xyz/info';
const M15 = 15 * 60000, H4 = 4 * 3600000, H8 = 8 * 3600000, JOUR = 86400000;
const Z95 = 1.959964;

/* Ce qui est commun a toutes les variantes : la soupape a l echelle de 15 min
   (4 tours = 1 h, comme 12 × 5 min en service), aucun journal, un DATA_DIR
   jetable. */
const ENV_BANC = { PERP_FAMINE_TOURS: '4', PERP_JOURNAL: '0', PERP_COLONIES: '0' };

/* La grille par defaut : le service, les geometries deja discutees, et
   Funding muet — MESURE seulement : le poids de Funding est une decision du
   proprietaire, ce script ne le change nulle part. */
const GRILLE = [
  { nom: 'service', env: {} },
  { nom: 'geometrie 3σ/5σ', env: { PERP_STOP_VOL: '3', PERP_CIBLE_VOL: '5' } },
  { nom: 'geometrie 4σ/8σ', env: { PERP_STOP_VOL: '4', PERP_CIBLE_VOL: '8' } },
  { nom: 'geometrie 6σ/9σ', env: { PERP_STOP_VOL: '6', PERP_CIBLE_VOL: '9' } },
  { nom: 'Funding muet (mesure)', env: {}, muets: ['financement'] },
];

// ----------------------------------------------------------------- reseau

const dort = (ms) => new Promise((r) => setTimeout(r, ms));
let dernierAppel = 0;
/* 8 appels par seconde au plus : Bitget en tolere 20 sur ses routes de
   marche. Trois essais, puis on abandonne en le disant. */
async function prend(u, init) {
  for (let essai = 0; essai < 3; essai++) {
    const attente = dernierAppel + 125 - Date.now();
    if (attente > 0) await dort(attente);
    dernierAppel = Date.now();
    try {
      const r = await fetch(u, Object.assign({ signal: AbortSignal.timeout(20000) }, init || {}));
      const j = await r.json();
      if (r.ok) return j;
      if (r.status !== 429 && r.status < 500) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 120));
    } catch (e) { if (essai === 2) throw e; }
    await dort(1000 * (essai + 1));
  }
  throw new Error('reseau : ' + u);
}
async function bitget(chemin, params) {
  const u = new URL(BITGET + chemin);
  for (const k in params) u.searchParams.set(k, String(params[k]));
  const j = await prend(u.toString());
  if (String(j.code) !== '00000') throw new Error('bitget ' + chemin + ' : ' + j.msg);
  return j.data;
}

// ----------------------------------------------------------------- cache

function dossierCache(o) { return o.cache || process.env.PERP_REJEU_CACHE || path.join(RACINE, 'data', 'perp_rejeu'); }
function litJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function ecritJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); }
const moisDe = (t) => new Date(t).toISOString().slice(0, 7);
function debutMois(m) { return Date.parse(m + '-01T00:00:00Z'); }
function moisSuivant(m) { const d = new Date(debutMois(m)); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); }
function listeMois(debut, fin) {
  const out = []; let m = moisDe(debut);
  while (debutMois(m) < fin) { out.push(m); m = moisDe(moisSuivant(m)); }
  return out;
}

/* Les bougies 15 min d un mois : `history-candles` rend 200 bougies FERMEES
   avant `endTime` (verifie le 27/09/2026 : la bougie en cours est exclue), et
   remonte au moins 900 jours. On pagine vers le passe. */
async function bougiesMois(sym, m, o) {
  const f = path.join(dossierCache(o), sym + '_15m_' + m + '.json');
  const fin = Math.min(moisSuivant(m), o.maintenant);
  const complet = moisSuivant(m) <= o.maintenant;
  const vu = litJson(f);
  if (vu && (vu.complet || Date.now() - vu.lu < 15 * 60000)) return vu.bougies;
  const debut = debutMois(m);
  const par = new Map();
  let fin2 = fin;
  for (let k = 0; k < 400; k++) {
    const l = await bitget('/history-candles', { symbol: sym, productType: PRODUIT, granularity: '15m', endTime: fin2, limit: 200 });
    if (!l || !l.length) break;
    let plusVieux = Infinity;
    for (const c of l) {
      const t = Number(c[0]);
      plusVieux = Math.min(plusVieux, t);
      if (t >= debut && t < fin) par.set(t, [t, +c[1], +c[2], +c[3], +c[4]]);
    }
    if (plusVieux <= debut || plusVieux >= fin2) break;
    fin2 = plusVieux;
  }
  const bg = [...par.values()].sort((a, b) => a[0] - b[0]);
  ecritJson(f, { sym, mois: m, complet, lu: Date.now(), bougies: bg });
  return bg;
}

/* Le financement Bitget : ~90 jours seulement (verifie le 27/09/2026 :
   pageNo 1-3 de 100, vide au-dela). */
async function financementBitget(sym, o) {
  const f = path.join(dossierCache(o), sym + '_fin_bitget.json');
  const vu = litJson(f);
  if (vu && Date.now() - vu.lu < 8 * 3600000) return vu.l;
  const l = [];
  for (let p = 1; p <= 20; p++) {
    const d = await bitget('/history-fund-rate', { symbol: sym, productType: PRODUIT, pageSize: 100, pageNo: p });
    if (!d || !d.length) break;
    for (const x of d) l.push([Number(x.fundingTime), Number(x.fundingRate)]);
  }
  l.sort((a, b) => a[0] - b[0]);
  /* on garde l ancien cache s il remonte plus loin : ce qui a ete lu ne
     disparait pas parce que Bitget ne le sert plus */
  const par = new Map((vu ? vu.l : []).map((x) => [x[0], x]));
  for (const x of l) par.set(x[0], x);
  const tout = [...par.values()].sort((a, b) => a[0] - b[0]);
  ecritJson(f, { sym, lu: Date.now(), l: tout });
  return tout;
}

/* Hyperliquid, pour ce que Bitget ne sert plus : taux HORAIRES, 500 par
   appel. Une autre plateforme — approximation, et mesuree comme telle. */
async function financementHl(coin, debut, fin, o) {
  const out = [];
  for (const m of listeMois(debut, fin)) {
    const f = path.join(dossierCache(o), coin + '_fin_hl_' + m + '.json');
    const complet = moisSuivant(m) <= o.maintenant;
    let vu = litJson(f);
    if (!vu || (!vu.complet && Date.now() - vu.lu > 3600000)) {
      const l = [];
      let t = debutMois(m);
      const b = Math.min(moisSuivant(m), o.maintenant);
      for (let k = 0; k < 20 && t < b; k++) {
        const d = await prend(HL, { method: 'POST', headers: { 'content-type': 'application/json' },
                                    body: JSON.stringify({ type: 'fundingHistory', coin, startTime: t, endTime: b }) });
        if (!Array.isArray(d) || !d.length) break;
        for (const x of d) l.push([Number(x.time), Number(x.fundingRate)]);
        const der = Number(d[d.length - 1].time);
        if (der <= t) break;
        t = der + 1;
      }
      vu = { coin, mois: m, complet, lu: Date.now(), l };
      ecritJson(f, vu);
    }
    out.push(...vu.l);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

async function contrat(sym, o) {
  const f = path.join(dossierCache(o), sym + '_contrat.json');
  const vu = litJson(f);
  if (vu && Date.now() - vu.lu < JOUR) return vu.c;
  const c = ((await bitget('/contracts', { symbol: sym, productType: PRODUIT })) || [])[0] || {};
  const v = { fundInterval: Number(c.fundInterval) || null, maker: Number(c.makerFeeRate), taker: Number(c.takerFeeRate) };
  ecritJson(f, { lu: Date.now(), c: v });
  return v;
}

/** Tout ce qu il faut pour un symbole, telecharge ou relu du cache. */
async function charge(o) {
  const donnees = {};
  /* 11 jours de chauffe avant la fenetre : 60 bougies 4 h pour `fond`. */
  const debut = o.debut - 11 * JOUR;
  for (const sym of o.symboles) {
    const c15 = [];
    for (const m of listeMois(debut, o.maintenant)) {
      const l = await bougiesMois(sym, m, o);
      for (const c of l) if (c[0] >= debut) c15.push(c);
      process.stderr.write('.');
    }
    const fb = await financementBitget(sym, o);
    const coin = sym.replace(/USDT$/, '');
    let fh = [];
    try { fh = await financementHl(coin, debut, o.maintenant, o); }
    catch (e) { process.stderr.write('\n[rejeu] ' + coin + ' : Hyperliquid illisible (' + e.message + ') — financement nul avant Bitget\n'); }
    const ct = await contrat(sym, o);
    donnees[sym] = { c15, finBitget: fb, finHl: fh, contrat: ct };
  }
  process.stderr.write('\n');
  return donnees;
}

// ----------------------------------------------------------------- marche

/* Le financement vu a l instant T : le dernier taux Bitget REGLE ; avant le
   premier, la somme des taux Hyperliquid sur la periode de 8 h qui s est
   close au dernier reglement. */
function preparerFinancement(d) {
  const fb = d.finBitget, fh = d.finHl;
  const cum = [0];
  for (let i = 0; i < fh.length; i++) cum.push(cum[i] + fh[i][1]);
  const idx = (l, t) => { let lo = 0, hi = l.length; while (lo < hi) { const m = (lo + hi) >> 1; if (l[m][0] <= t) lo = m + 1; else hi = m; } return lo; };
  const debutBitget = fb.length ? fb[0][0] : Infinity;
  const hl = (t) => {
    const s = Math.floor(t / H8) * H8;
    const a = idx(fh, s - H8), b = idx(fh, s);
    return b > a ? cum[b] - cum[a] : null;
  };
  return {
    debutBitget,
    taux(t) {
      if (t >= debutBitget) { const i = idx(fb, t); return i ? { v: fb[i - 1][1], src: 'bitget' } : null; }
      const v = hl(t);
      return v === null ? null : { v, src: 'hl' };
    },
    bitget(t) { const i = idx(fb, t); return (t >= debutBitget && i) ? fb[i - 1][1] : null; },
    hl,
  };
}

/* Les bougies 4 h depuis les 15 min, alignees sur minuit UTC. A l instant T,
   seules les bougies FERMEES entrent, plus celle en cours avec pour cloture
   le prix du moment — exactement ce que le service lit. */
function marchePour(sym, c15, i, fin, periodeFin, bougies4) {
  const T = c15[i][0] + M15;
  const m15 = [];
  for (let k = Math.max(0, i - 99); k <= i; k++) { const c = c15[k]; m15.push({ t: c[0], o: c[1], h: c[2], b: c[3], c: c[4], v: null }); }
  const prix = c15[i][4];
  const h4 = bougies4.fermees(T, 59);
  const cours = bougies4.enCours(i, T);
  if (cours) h4.push(cours);
  const il96 = i >= 96 ? c15[i - 96][4] : null;
  const f = fin.taux(T);
  return { sym, t: T, prix, marque: null, index: null, financement: f ? f.v : null, interet: null,
           bid: null, ask: null, haut24: null, bas24: null, var24: il96 ? (prix - il96) / il96 : null,
           volume: null, m15, h4, periodeFin, _src: f ? f.src : null };
}
function preparer4h(c15) {
  const buckets = [];                       /* {t, o, h, b, c, dernier: index} */
  const parIndex = new Array(c15.length);
  for (let i = 0; i < c15.length; i++) {
    const c = c15[i], t = Math.floor(c[0] / H4) * H4;
    let b = buckets[buckets.length - 1];
    if (!b || b.t !== t) { b = { t, o: c[1], h: c[2], b: c[3], c: c[4], premier: i, dernier: i }; buckets.push(b); }
    else { b.h = Math.max(b.h, c[2]); b.b = Math.min(b.b, c[3]); b.c = c[4]; b.dernier = i; }
    parIndex[i] = buckets.length - 1;
  }
  return {
    fermees(T, n) {
      /* une bougie 4 h est fermee si elle finit avant T */
      let lo = 0, hi = buckets.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (buckets[m].t + H4 <= T) lo = m + 1; else hi = m; }
      const out = [];
      for (let k = Math.max(0, lo - n); k < lo; k++) { const b = buckets[k]; out.push({ t: b.t, o: b.o, h: b.h, b: b.b, c: b.c, v: null }); }
      return out;
    },
    enCours(i, T) {
      const b = buckets[parIndex[i]];
      if (b.t + H4 <= T) return null;       /* la bougie 4 h vient de se fermer */
      let h = -Infinity, lo = Infinity;
      for (let k = b.premier; k <= i; k++) { h = Math.max(h, c15[k][2]); lo = Math.min(lo, c15[k][3]); }
      return { t: b.t, o: b.o, h, b: lo, c: c15[i][4], v: null };
    },
  };
}

// ----------------------------------------------------------------- simulation

/**
 * Rejoue la colonie sur `donnees` ({sym: {c15, finBitget, finHl, contrat}})
 * entre `debut` et `fin`, avec une variante ({env, muets}). Rend la liste
 * des trades fermes, chacun avec son entree, sa sortie et son net aux frais
 * reels.
 */
async function simule(donnees, variante, o) {
  const envAvant = {};
  const env = Object.assign({}, ENV_BANC, variante.env || {}, { DATA_DIR: o.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'perp-rejeu-')) });
  for (const k in env) { envAvant[k] = process.env[k]; process.env[k] = env[k]; }
  for (const m of ['../ai_perp', '../perp_journal', '../config']) { try { delete require.cache[require.resolve(m)]; } catch (e) { /* absent */ } }
  const vraiNow = Date.now;
  const trades = [];
  let P = null;
  try {
    P = require('../ai_perp');
    P._pose(P.etatNeuf());
    const S = P.etat();
    /* La ligne du temps : toutes les clotures de bougie 15 min. */
    const syms = Object.keys(donnees);
    const prep = {};
    const temps = new Set();
    for (const sym of syms) {
      const d = donnees[sym];
      const idx = new Map();
      d.c15.forEach((c, i) => { idx.set(c[0] + M15, i); if (c[0] + M15 >= o.debut && c[0] + M15 <= o.fin) temps.add(c[0] + M15); });
      const pf = d.contrat && d.contrat.fundInterval > 0 ? d.contrat.fundInterval * 60 : P.PERIODE_FIN_MIN;
      prep[sym] = { idx, fin: preparerFinancement(d), pf, h4: preparer4h(d.c15) };
    }
    const ligne = [...temps].sort((a, b) => a - b);
    let vus = 0;
    for (const T of ligne) {
      Date.now = () => T;
      const marches = {}, fines = {};
      for (const sym of syms) {
        const p = prep[sym], i = p.idx.get(T);
        if (i === undefined || i < 100) continue;
        const c15 = donnees[sym].c15;
        marches[sym] = marchePour(sym, c15, i, p.fin, p.pf, p.h4);
        const c = c15[i];
        fines[sym] = [{ t: c[0], o: c[1], h: c[2], b: c[3], c: c[4] }];
      }
      if (!Object.keys(marches).length) continue;
      await P.tour({ marches, fines, muets: variante.muets, sansSauver: true });
      /* Les trades fermes ce tour : en tete du carnet. */
      const neufs = S.trades - vus;
      for (let k = neufs - 1; k >= 0; k--) {
        const c = S.carnet[k];
        trades.push({ sym: c.sym, sens: c.sens, entree: c.ouvert || (c.t - c.minutes * 60000), sortie: c.t,
                      pourquoi: c.pourquoi, brut: c.brut, financement: c.financement, r: c.r,
                      rReel: c.rReel, minutes: c.minutes, soupape: c.soupape, score: c.score });
      }
      vus = S.trades;
    }
  } finally {
    Date.now = vraiNow;
    for (const k in envAvant) { if (envAvant[k] === undefined) delete process.env[k]; else process.env[k] = envAvant[k]; }
    for (const m of ['../ai_perp', '../perp_journal', '../config']) { try { delete require.cache[require.resolve(m)]; } catch (e) { /* absent */ } }
  }
  return trades;
}

// ----------------------------------------------------------------- mesures

/**
 * Le bilan d une liste de trades : n, par jour, part gagnante (Wilson),
 * brut et net aux frais reels, erreur-type GROUPEE PAR JOUR d entree, borne
 * basse a 95 %, et les deux moities dans le temps.
 */
function bilan(trades, jours) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const moy = (k) => trades.reduce((a, t) => a + t[k], 0) / n;
  const m = moy('rReel');
  const parJour = new Map();
  for (const t of trades) {
    const j = new Date(t.entree).toISOString().slice(0, 10);
    const d = parJour.get(j) || { n: 0, s: 0 };
    d.n++; d.s += t.rReel; parJour.set(j, d);
  }
  let v = 0;
  for (const d of parJour.values()) { const e = d.s - m * d.n; v += e * e; }
  const k = parJour.size;
  const se = k > 1 ? Math.sqrt(v * k / (k - 1)) / n : null;
  const g = trades.filter((t) => t.rReel > 0).length;
  const w = wilson(g, n);
  const out = { n, jours: jours || k, parJour: jours ? n / jours : null,
                part: g / n, wilson: w, brut: moy('brut'), netPapier: moy('r'), netReel: m, se,
                borneBasse: se === null ? null : m - Z95 * se, borneHaute: se === null ? null : m + Z95 * se,
                parSortie: {} };
  for (const t of trades) {
    const s = out.parSortie[t.pourquoi] || (out.parSortie[t.pourquoi] = { n: 0, s: 0 });
    s.n++; s.s += t.rReel;
  }
  for (const s in out.parSortie) out.parSortie[s].moyenne = out.parSortie[s].s / out.parSortie[s].n;
  return out;
}
function wilson(k, n) {
  if (!n) return null;
  const z = Z95, p = k / n, z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function moities(trades, a, b) {
  const mil = a + (b - a) / 2;
  return [bilan(trades.filter((t) => t.entree < mil), (mil - a) / JOUR),
          bilan(trades.filter((t) => t.entree >= mil), (b - mil) / JOUR)];
}
/* LE verdict. Il ne conclut que si la borne basse du net aux frais reels est
   au-dessus de zero ; il dit aussi si les deux moities vont dans le meme sens. */
function verdict(b, mo) {
  if (!b || !b.n) return { conclut: false, pourquoi: 'aucun trade' };
  if (b.se === null) return { conclut: false, pourquoi: 'pas assez de jours pour une erreur-type' };
  if (!(b.borneBasse > 0)) return { conclut: false, pourquoi: 'borne basse ' + pct(b.borneBasse) + ' ≤ 0 : on ne conclut pas' };
  const deux = mo && mo.every((x) => x.n && x.netReel > 0);
  return { conclut: true, pourquoi: 'borne basse ' + pct(b.borneBasse) + ' > 0' + (deux ? ', les deux moities positives' : ', MAIS une moitie ≤ 0 : fragile') };
}
const pct = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 3 : d) + ' %';

/* L accord du financement Hyperliquid avec Bitget, sur leur periode commune :
   ce que l agent Funding lirait de l un et de l autre (son vote, borne a ±1). */
function accordFinancement(donnees) {
  const out = {};
  for (const sym in donnees) {
    const f = preparerFinancement(donnees[sym]);
    const fb = donnees[sym].finBitget;
    let n = 0, memeSigne = 0, ecart = 0, plancher = 0;
    for (const [t] of fb) {
      const b = f.bitget(t + 1), h = f.hl(t + 1);
      if (b === null || h === null) continue;
      const vb = Math.max(-1, Math.min(1, b * 100 / 0.01)), vh = Math.max(-1, Math.min(1, h * 100 / 0.01));
      n++; ecart += Math.abs(vb - vh); if (Math.sign(vb) === Math.sign(vh)) memeSigne++;
      if (Math.abs(b - 0.0001) < 1e-9) plancher++;
    }
    out[sym] = { n, memeSigne: n ? memeSigne / n : null, ecartVote: n ? ecart / n : null, bitgetA001: n ? plancher / n : null,
                 debutBitget: fb.length ? new Date(fb[0][0]).toISOString().slice(0, 10) : null };
  }
  return out;
}

// ----------------------------------------------------------------- journal des essais

/* Chaque lancement note ses variantes contre SA fenetre de garde. Le cumul
   dit combien de fois la garde a ete regardee : au-dela de quelques-unes,
   elle ne protege plus du surajustement, et le rapport le dit. */
function noteEssais(o, noms) {
  const f = path.join(dossierCache(o), 'essais.ndjson');
  const cle = new Date(o.debutGarde).toISOString().slice(0, 10) + '→' + new Date(o.fin).toISOString().slice(0, 10);
  let avant = 0;
  try {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue;
      try { const v = JSON.parse(l); if (v.garde === cle) avant += v.variantes.length; } catch (e) { /* ligne cassee */ }
    }
  } catch (e) { /* premier lancement */ }
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ t: Date.now(), garde: cle, variantes: noms }) + '\n'); } catch (e) { /* lecture seule */ }
  return { garde: cle, ceLancement: noms.length, cumul: avant + noms.length };
}

// ----------------------------------------------------------------- rapport

function ecritBilan(nom, b, mo) {
  if (!b.n) return '  ' + nom + ' : aucun trade';
  const w = b.wilson ? (b.wilson[0] * 100).toFixed(0) + '–' + (b.wilson[1] * 100).toFixed(0) + ' %' : '—';
  let s = '  ' + nom.padEnd(30) + ' n=' + String(b.n).padStart(5) + (b.parJour ? ' (' + b.parJour.toFixed(1) + '/j)' : '')
    + '  gagnants ' + (b.part * 100).toFixed(1) + ' % [' + w + ']'
    + '  brut ' + pct(b.brut) + '  net reel ' + pct(b.netReel) + ' ± ' + (b.se === null ? '—' : b.se.toFixed(3))
    + '  IC95 [' + pct(b.borneBasse) + ', ' + pct(b.borneHaute) + ']';
  if (mo) s += '\n  ' + ' '.repeat(30) + ' moities : ' + mo.map((x) => x.n ? pct(x.netReel) + ' (n=' + x.n + ')' : '—').join(' / ');
  if (b.parSortie) s += '\n  ' + ' '.repeat(30) + ' sorties : ' + Object.keys(b.parSortie).sort().map((k) => k + ' ' + b.parSortie[k].n + ' ' + pct(b.parSortie[k].moyenne, 2)).join(' · ');
  return s;
}

function args(argv) {
  const o = { mois: 24, garde: 3, variantes: 'grille', essaie: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mois') o.mois = Math.max(6, Math.min(30, Number(argv[++i])));
    else if (a === '--garde') o.garde = Math.max(3, Math.min(6, Number(argv[++i])));
    else if (a === '--variantes') o.variantes = argv[++i];
    else if (a === '--essaie') o.essaie.push(argv[++i]);
    else if (a === '--symboles') o.symboles = argv[++i].split(',').map((x) => x.trim().toUpperCase());
    else if (a === '--json') o.json = true;
    else if (a === '--cache') o.cache = argv[++i];
  }
  return o;
}

async function principal() {
  const o = args(process.argv.slice(2));
  o.maintenant = Math.floor(Date.now() / M15) * M15;
  o.fin = o.maintenant;
  const d0 = new Date(o.fin); d0.setUTCMonth(d0.getUTCMonth() - o.mois); o.debut = d0.getTime();
  const dg = new Date(o.fin); dg.setUTCMonth(dg.getUTCMonth() - o.garde); o.debutGarde = dg.getTime();
  o.symboles = o.symboles || String(process.env.PERP_SYMBOLES || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT').split(',').map((s) => s.trim());
  let variantes = o.variantes === 'service' ? GRILLE.slice(0, 1) : GRILLE.slice();
  for (const e of o.essaie) {
    const env = {};
    for (const kv of e.split(',')) { const [k, v] = kv.split('='); if (/^PERP_[A-Z_]+$/.test(k || '')) env[k] = v; }
    variantes.push({ nom: 'essai ' + e, env });
  }
  process.stderr.write('[rejeu] ' + o.symboles.join(',') + ' · ' + o.mois + ' mois · garde ' + o.garde + ' mois · telechargement');
  const donnees = await charge(o);
  const contrats = {};
  for (const s in donnees) contrats[s] = donnees[s].contrat;
  const accord = accordFinancement(donnees);
  const essais = noteEssais(o, variantes.map((v) => v.nom));
  const res = [];
  for (const v of variantes) {
    const t0 = Date.now();
    const tr = await simule(donnees, v, o);
    const regle = tr.filter((t) => t.entree < o.debutGarde);
    const garde = tr.filter((t) => t.entree >= o.debutGarde);
    const bR = bilan(regle, (o.debutGarde - o.debut) / JOUR), bG = bilan(garde, (o.fin - o.debutGarde) / JOUR);
    res.push({ nom: v.nom, env: v.env, muets: v.muets || null, secondes: Math.round((Date.now() - t0) / 1000),
               regle: bR, regleMoities: moities(regle, o.debut, o.debutGarde),
               garde: bG, gardeMoities: moities(garde, o.debutGarde, o.fin) });
    process.stderr.write('[rejeu] ' + v.nom + ' : ' + tr.length + ' trades en ' + Math.round((Date.now() - t0) / 1000) + ' s\n');
  }
  /* Le choix se fait sur l ANCIEN seulement ; la garde juge. */
  const choisie = res.slice().sort((a, b) => (b.regle.netReel || -9) - (a.regle.netReel || -9))[0];
  const service = res.find((r) => r.nom === 'service');
  const sortie = {
    date: new Date().toISOString(), symboles: o.symboles, mois: o.mois, garde: o.garde,
    fenetre: { debut: new Date(o.debut).toISOString(), debutGarde: new Date(o.debutGarde).toISOString(), fin: new Date(o.fin).toISOString() },
    contrats, accordFinancement: accord, essais, variantes: res,
    choisie: choisie.nom, verdictChoisie: verdict(choisie.garde, choisie.gardeMoities),
    verdictService: service ? verdict(service.garde, service.gardeMoities) : null,
  };
  console.log('\nREJEU PERP — ' + o.symboles.map((s) => s.replace(/USDT$/, '')).join(', ') + ' — ' + sortie.fenetre.debut.slice(0, 10) + ' → ' + sortie.fenetre.fin.slice(0, 10));
  console.log('garde (juge) : ' + sortie.fenetre.debutGarde.slice(0, 10) + ' → ' + sortie.fenetre.fin.slice(0, 10)
              + ' · variantes essayees : ' + essais.ceLancement + ' ce lancement, ' + essais.cumul + ' en cumul sur cette garde');
  console.log('frais reels (/contracts) : ' + o.symboles.map((s) => s.replace(/USDT$/, '') + ' maker ' + (contrats[s].maker * 100) + ' % taker ' + (contrats[s].taker * 100) + ' % fin ' + contrats[s].fundInterval + ' h').join(' · '));
  console.log('financement : Bitget depuis ' + Object.values(accord).map((a) => a.debutBitget).filter(Boolean).sort()[0]
              + ', Hyperliquid avant. Accord sur la periode commune (vote Funding) : '
              + Object.keys(accord).map((s) => s.replace(/USDT$/, '') + ' meme signe ' + (accord[s].memeSigne === null ? '—' : (accord[s].memeSigne * 100).toFixed(0) + ' %') + ', ecart ' + (accord[s].ecartVote === null ? '—' : accord[s].ecartVote.toFixed(2))).join(' · '));
  console.log('\n— sur l ANCIEN (reglage) —');
  for (const r of res) console.log(ecritBilan(r.nom, r.regle, r.regleMoities));
  console.log('\n— sur la GARDE (jugement) —');
  for (const r of res) console.log(ecritBilan(r.nom, r.garde, r.gardeMoities));
  console.log('\nchoisie sur l ancien : ' + choisie.nom + ' → ' + (sortie.verdictChoisie.conclut ? 'CONCLUT' : 'NE CONCLUT PAS') + ' (' + sortie.verdictChoisie.pourquoi + ')');
  if (service) console.log('regle en service      : ' + (sortie.verdictService.conclut ? 'CONCLUT' : 'NE CONCLUT PAS') + ' (' + sortie.verdictService.pourquoi + ')');
  if (o.json) {
    const f = path.join(dossierCache(o), 'resultat_' + sortie.date.slice(0, 16).replace(/[:T]/g, '-') + '.json');
    ecritJson(f, sortie);
    console.log('\n' + f);
  }
  return sortie;
}

if (require.main === module) principal().catch((e) => { console.error('ECHEC : ' + (e && e.stack || e)); process.exit(1); });
module.exports = { simule, bilan, verdict, moities, wilson, preparerFinancement, preparer4h, marchePour,
                   accordFinancement, noteEssais, GRILLE, ENV_BANC };
