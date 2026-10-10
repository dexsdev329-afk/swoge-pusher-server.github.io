#!/usr/bin/env node
'use strict';
/*
 * L'AGE DU PRIX VENDU — la mesure du journal des releves (lot 1 de la cle
 * 20K, 10/10/2026).
 *
 *   node outils/age_prix.js --telecharge          fige les jours COMPLETS du journal (hier et avant)
 *                                                 absents de _releves/prix_journal/, plus les paris
 *   node outils/age_prix.js                       mesure sur _releves/prix_journal/
 *   node outils/age_prix.js --dossier DIR         mesure sur un autre dossier de .jsonl
 *     --url BASE        le serveur (defaut : celui de releve.js)
 *     --ages 0,1,3,6,12,13,36   les tranches d'age, en heures (voir « tranches »)
 *     --paris FICHIER   les paris (defaut : paris.json du dossier, ecrit par --telecharge)
 *     --json            la mesure entiere en JSON
 *
 * ADMIN_KEY est lue dans le shell du proprietaire, envoyee dans l'en-tete
 * x-admin-key, jamais affichee ni ecrite. Chaque mesure garde un instantane
 * dans _releves/prix_age/ (hors depot, .gitignore : _releves/). AUCUN credit
 * The Odds API : le journal est fait des reponses DEJA payees.
 *
 * ---- pourquoi la mesure est ici, et pas dans le serveur ----
 *
 * Le plan d'origine calculait un bilan quotidien dans le processus qui vend,
 * en sommes cumulees sur 180 jours, avec un brut purge a 10 jours. La critique
 * du 09/10 l'a refuse : une definition fausse (les tranches, voir plus bas) ne
 * se serait plus jamais recalculee sur les jours passes, et treize essais
 * de plus sur un chemin d'argent pour une mesure qui se fait hors serveur. Le
 * serveur ne fait donc qu'ecrire (prix_journal.js) ; tout se recalcule ici, sur
 * le brut fige, si une definition change.
 *
 * ---- la regle des paires ----
 *
 * Pour chaque rencontre d'un championnat VENDU (lignes sans o), et chaque
 * releve j avant son coup d'envoi (debut > t_j) avec une reference : pour
 * chaque tranche d'age, la releve k la PLUS RECENTE avant j, avec une
 * reference, dont l'age Δ = t_j - t_k tombe dans la tranche. Une paire au plus
 * par (j, tranche). La question posee : « si l'on avait vendu a t_j le prix de
 * k, combien d'issues le parieur aurait-il battues, juge contre le prix de j ? »
 *   - Δ > AGE_PRIX_MS (36 h) : exclue, ce prix ne se vend jamais (paris.ouvert) ;
 *   - debut - t_j < PRES_MS et Δ > FRAIS_MS (3 h / 3 h) : exclue et comptee
 *     dans `refuses`, la porte de paris.prixTropVieux la refuse a la vente ;
 *   - cotes de k : `cotes.habilleUnMarche`, exactement comme
 *     `marchesDuMarche` (1-N-2 marge par defaut ; double chance sur
 *     {1X, 12, X2}). L'essai T8 les compare au VRAI chemin de vente,
 *     cotes.habille(avecPrix(m)). `marchesDuMarche` entier est interdit ici :
 *     ~7 ms par prix contre ~30 µs (chrono du plan, 1 000 tirages) ;
 *   - une issue est battable si cote(k) x p(j) > 1.
 * Deux calculs :
 *   - « vente » : p(k) et p(j) sont les prix VENDUS (la reference du moment) ;
 *   - « meme source » : la source vendue a k (betfair, pinnacle ou mediane),
 *     relue a j dans la MEME source. Un passage betfair -> mediane entre k et j
 *     peut faire paraitre battable un prix que le marche n'a pas bouge
 *     (critique du 09/10) : la porte ne decide que si les deux calculs disent
 *     la meme chose, sinon « non decide ».
 *
 * L'intervalle est robuste par RENCONTRE (une rencontre donne plusieurs
 * paires, correlees) : r = Σb/Σn, var = m/(m-1) (Σb² - 2rΣbn + r²Σn²)/(Σn)².
 * Les rencontres d'une meme releve (le samedi a 15 h) restent correlees entre
 * elles : l'intervalle peut etre optimiste, d'ou une puissance ecrite d'avance
 * et des portes qui glissent plutot que de conclure trop tot.
 *
 * ---- les tranches ----
 *
 * Age (Δ) : 0-1 h, 1-3 h (l'age VENDU aujourd'hui, borne par FRAIS_MS = 3 h),
 * 3-6 h, 6-12 h, 12-13 h (le pire cas reel d'une cadence de 12 h sur le tic de
 * 30 min), 13-36 h. Ce sont les tranches PROPOSEES du plan corrige : la
 * cadence reelle est d'environ 2 h 30 (note() date la releve au retour du
 * fetch, prixPerimes exige 2 h a chaque tic de 30 min), et l'ancienne
 * frontiere 2 h 30 tombait pile sur elle. Elles se FIGENT apres une semaine
 * de journal, d'apres l'histogramme des ecarts reels que rend cet outil
 * (« cadence reelle ») : --ages permet de les redefinir et de tout recalculer.
 * Delai (debut - t_j) : <3 h (= paris.PRES_MS), 3-6 h, 6-24 h, 24-48 h, 48 h+.
 *
 * ---- les portes, ecrites d'avance (EXPLOITATION 8.8septies) ----
 *
 * Seuil commun τ = 1,0 % d'issues 1-N-2 battables, puissance visee 80 %.
 * Seulement les jours de coup d'envoi COMPLETS et >= j0 + 3, j0 etant le
 * premier jour de la derniere serie a REGIME constant (champs c, av, am :
 * PARIS_PRIX_RELEVE_H, PARIS_PRIX_AVANT_TOUS, PARIS_PRIX_AGE_MAX_H, ecrits par
 * le serveur) ; au plus tot j0 + 14. Un jour D est complet si D-3..D ont tous
 * des lignes, si aucun trou de plus de 4 h ne coupe [D-3 00:00 ; D+1 00:00)
 * et si le journal va au-dela de D (4 h : la cadence reelle de 2 h 30 plus le
 * tic de 30 min et une marge ; une treve qui vide les releves rend le jour
 * incomplet, prudent).
 *   G2 (pres du coup d'envoi, depense) : delai <3 h x age 1-3 h, m >= 150 ;
 *     « oui » si la part >= τ, ou si sa borne basse a 95 % > 0 ; sans la
 *     puissance A τ (effet detectable a 80 %, erreur type calculee SOUS τ,
 *     > τ) avant j0 + 28 : « prolonger », jamais « non » ; l'ecart [3 h ; 6 h)
 *     - [1 h ; 3 h) au delai 3-6 h est RAPPORTE avec son intervalle (il
 *     remplace la condition de croissance point contre point du plan
 *     d'origine, un pile ou face), n/a sous 30 rencontres.
 *   G1 (loin du coup d'envoi, economie) : test d'EQUIVALENCE, delai 48 h+ ;
 *     borne haute de [12 h ; 13 h) <= τ (la plus prudente de Wald et de la
 *     borne exacte de Poisson) ET borne haute de l'ecart avec [1 h ; 3 h) <=
 *     τ/2 (variance de l'ecart = somme des deux : les rencontres etant les
 *     memes, la covariance est positive, donc prudent), m >= 200 dans
 *     chacune. N'est CONSTRUIT que si la projection du mois depasse 16 000
 *     (sa conclusion, `depasse`, jamais avant le 7 du mois) : le forfait est
 *     un prix fixe, economiser n'y rapporte rien (EXPLOITATION 8.8quater et
 *     8.8sexies).
 * Rapporte, sans etre une porte : sev/m (esperance moyenne des issues
 * battables par rencontre), la part des retraits de marche (k avec reference
 * -> j sans reference ou absente, et combien de temps p(k) s'est vendu avant
 * l'effacement), la part des mises reelles par delai (pari.t, jambe.debut),
 * par groupe (six grands, secondaires, MLS et Liga MX), et pour G1 la
 * moyenne ponderee par le temps sur 0-12 h 30 d'age (correction du
 * sceptique). Le poids des mises n'entre PAS dans le verdict : le 08/10, deux
 * rencontres seulement portaient des paris (8.8bis), un poids tire d'une
 * poignee de tickets serait de la chance (CLAUDE.md du site, BANCS_ASSEZ).
 * L'age du prix des paris REELS ne se lit pas ici : la jambe ne garde ni la
 * cle du championnat ni l'evenement (game.js, jambe), seulement debut ; le
 * lot 2 (CLV) lui donne `clv.tv`, la date du prix vendu, et l'age exact
 * pari.t - tv.
 *
 * Commentaires sans accents (convention de outils/).
 */
const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const cotes = require(path.join(RACINE, 'cotes'));
const paris = require(path.join(RACINE, 'paris'));
const pj = require(path.join(RACINE, 'prix_journal'));
const { LIGUES_DEFAUT } = require(path.join(RACINE, 'prix_ligues'));

const MIN = 60000, H = 3600000, JOUR = 86400000;
const Z95 = 1.959964, Z80 = 0.841621;
const AGES_DEFAUT = [0, 1, 3, 6, 12, 13, 36];
const DELAIS = [{ cle: '<3h', de: 0, a: paris.PRES_MS }, { cle: '3-6h', de: 3 * H, a: 6 * H }, { cle: '6-24h', de: 6 * H, a: 24 * H },
                { cle: '24-48h', de: 24 * H, a: 48 * H }, { cle: '48h+', de: 48 * H, a: Infinity }];
/* Les portes. τ et la puissance : decision du plan corrige (09/10), pas une
   mesure — un seul seuil pour les deux decisions, la ou le plan d'origine
   tolerait 2,0 % de fuite pour economiser (G1) et exigeait une borne basse
   de 0,5 % pour depenser (G2), une porte G2 qui ne disait presque jamais oui
   sous 2 % de fuite (simulation du sceptique : 3 % de « oui » a m = 150 pour
   une fuite vraie de 1 %). mMin : 150 / 200 du plan ; le prototype prevoyait
   ~248 rencontres par cellule a j0 + 14 (prix simules, cadence de 2 h) ; une
   treve fait glisser la date, jamais le seuil. */
const PORTE = {
  tau: 0.01, puissance: 0.80, joursMin: 14, joursProlonge: 28, joursAvantJ0: 3, trouMaxMs: 4 * H,
  g2: { delai: '<3h', age: [1, 3], mMin: 150, ecart: { delai: '3-6h', haut: [3, 6], bas: [1, 3] } },
  /* le seuil de projection (16 000) n'est pas recopie ici : la construction
     lit la conclusion du socle (`projection.depasse`, PROJECTION_SEUIL) */
  g1: { delai: '48h+', age: [12, 13], ref: [1, 3], mMin: 200, moyenneH: 12.5 },
};
/* Sous 30 rencontres, une part ne s'affiche pas : l'intervalle robuste par
   rencontre repose sur l'approximation normale, qui ne tient pas sur une
   poignee de grappes (regle d'usage, pas une mesure). Les portes ont leurs
   propres minimums (150 / 200). */
const AFFICHE_MIN = 30;
const MISES_MIN = 30;   /* idem pour la part des mises : sous 30 jambes, « n/a » */
const GRANDS = new Set(LIGUES_DEFAUT);
const AMERIQUES = new Set(['soccer_usa_mls', 'soccer_mexico_ligamx']);
const groupeDe = (l) => (GRANDS.has(l) ? 'grands' : AMERIQUES.has(l) ? 'mls_ligamx' : 'secondaires');
const GROUPES = ['tous', 'grands', 'secondaires', 'mls_ligamx'];
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
const debutDuJour = (j) => Date.parse(j + 'T00:00:00Z');
const plusJours = (j, n) => jourDe(debutDuJour(j) + n * JOUR);

// --------------------------------------------------------------- les cotes

/** Les cotes VENDUES d'un prix [p1, pN, p2] : 1-N-2 et double chance, comme
 *  `cotes.marchesDuMarche` (marge par defaut). null quand le marche ne se cote
 *  pas (trop desequilibre : la rencontre n'est alors pas vendue). */
function cotesVendues(p) {
  if (!Array.isArray(p) || !p.every((x) => Number(x) > 0 && Number(x) < 1)) return null;
  const q = { 1: Number(p[0]), N: Number(p[1]), 2: Number(p[2]) };
  const base = cotes.habilleUnMarche(q, paris.issues('foot'), 1);
  if (!base) return null;
  const M = paris.MARCHES.dc;
  const lot = cotes.habilleUnMarche({ '1X': q[1] + q.N, 12: q[1] + q[2], X2: q.N + q[2] }, M.issues('foot'), M.couverture);
  return { '1n2': base.cotes, dc: lot ? lot.cotes : null };
}
const probas = (p) => ({ '1n2': { 1: p[0], N: p[1], 2: p[2] }, dc: { '1X': p[0] + p[1], 12: p[0] + p[2], X2: p[1] + p[2] } });
/** Une paire jugee : par marche, { n, b, sev }. */
function juge(ck, pj_) {
  const out = {};
  const pr = probas(pj_);
  for (const mk of ['1n2', 'dc']) {
    const c = ck[mk];
    if (!c) continue;
    let n = 0, b = 0, sev = 0;
    for (const i of Object.keys(c)) {
      const e = Number(c[i]) * pr[mk][i] - 1;
      n++;
      if (e > 0) { b++; sev += e; }
    }
    out[mk] = { n, b, sev };
  }
  return out;
}

// --------------------------------------------------------------- la preparation

/** Les tranches d'age a partir de bornes en heures. */
function tranchesAge(bornes) {
  const b = (bornes || AGES_DEFAUT).map(Number);
  const out = [];
  for (let i = 0; i + 1 < b.length; i++) out.push({ cle: b[i] + '-' + b[i + 1] + 'h', de: b[i] * H, a: b[i + 1] * H, h: [b[i], b[i + 1]] });
  return out;
}
const trancheDe = (tr, x) => { for (let i = 0; i < tr.length; i++) if (x >= tr[i].de && x < tr[i].a) return i; return -1; };
const trancheDelai = (d) => { for (let i = 0; i < DELAIS.length; i++) if (d >= DELAIS[i].de && d < DELAIS[i].a) return i; return -1; };

/* Le regime d'une ligne : la cadence (c), l'avant-match pour tous (av) et
   l'age maximal de vente (am), ecrits par le serveur a chaque ligne. */
const regimeDe = (x) => [x.c, x.av === undefined ? '' : x.av, x.am === undefined ? '' : x.am].join('|');
/** Les lignes utiles, triees, et la derniere serie a regime constant (c, av,
 *  am) : un changement de PARIS_PRIX_RELEVE_H, PARIS_PRIX_AVANT_TOUS ou
 *  PARIS_PRIX_AGE_MAX_H remet j0 au jour du changement. */
function serie(lignes) {
  const l = (lignes || []).filter((x) => x && x.v === 1 && x.m === 'h2h' && Number.isFinite(x.t) && Array.isArray(x.e)).sort((a, b) => a.t - b.t);
  let debut = 0, changements = 0;
  for (let i = 1; i < l.length; i++) if (regimeDe(l[i]) !== regimeDe(l[i - 1])) { debut = i; changements++; }
  const run = l.slice(debut);
  const r0 = run.length ? run[0] : null;
  return { toutes: l, run, j0: r0 ? jourDe(r0.t) : null, c: r0 ? r0.c : null,
           av: r0 && r0.av !== undefined ? r0.av : null, am: r0 && Number.isFinite(r0.am) ? r0.am : null,
           changements, dernier: run.length ? run[run.length - 1].t : null };
}

/** Un jour de coup d'envoi D est-il complet ? (voir l'en-tete) */
function completeur(run, o) {
  const trou = (o && o.trouMaxMs) || PORTE.trouMaxMs;
  const ts = run.map((x) => x.t);
  const jours = new Set(ts.map(jourDe));
  const memo = new Map();
  return function complet(D) {
    if (memo.has(D)) return memo.get(D);
    let ok = true;
    for (let k = 3; k >= 0 && ok; k--) if (!jours.has(plusJours(D, -k))) ok = false;
    const W0 = debutDuJour(plusJours(D, -3)), W1 = debutDuJour(D) + JOUR;
    if (ok && !(ts.length && ts[ts.length - 1] >= W1)) ok = false;
    if (ok) {
      let prec = W0;
      for (const t of ts) {
        if (t < W0) { prec = t; continue; }
        if (t - prec > trou) { ok = false; break; }
        prec = t;
        if (t >= W1) break;
      }
    }
    memo.set(D, ok);
    return ok;
  };
}

// --------------------------------------------------------------- la mesure

function cellule() { return { m: 0, n: 0, b: 0, sbb: 0, snn: 0, sbn: 0, sev: 0, nRef: 0, bRef: 0, refuses: 0, paires: 0 }; }

/**
 * La mesure entiere. `lignes` : celles du journal (prix_journal.lisJournal).
 * o : { ages: [h...], sansFiltreJours: bool (essais) }.
 * Rend { serie, cellules: { 'groupe|regle|marche|age|delai': cellule }, ... }.
 */
function mesure(lignes, o) {
  const opt = o || {};
  const tr = tranchesAge(opt.ages);
  const S = serie(lignes);
  const complet = completeur(S.run, opt);
  const jMin = S.j0 ? plusJours(S.j0, PORTE.joursAvantJ0) : null;
  const cellules = {};
  const cel = (k) => cellules[k] || (cellules[k] = cellule());
  const exclus = { observes: 0, enJeu: 0, sansReference: 0, invendables: 0, joursIncomplets: 0, avantJ0: 0 };
  /* l'age maximal de vente du SERVEUR (champ am de la serie), pas celui de
     la machine qui mesure ; a defaut (lignes sans am), paris.AGE_PRIX_MS */
  const ageMax = S.am !== null ? S.am * MIN : paris.AGE_PRIX_MS;
  const cache = new Map();
  const cotesDe = (p) => { const k = p.join(','); if (!cache.has(k)) cache.set(k, cotesVendues(p)); return cache.get(k); };

  /* les observations par rencontre (championnats VENDUS seulement) */
  const evs = new Map();
  for (const x of S.run) {
    if (x.o) { exclus.observes += x.e.length; continue; }
    for (const e of x.e) {
      const id = String(e[0]);
      let a = evs.get(id);
      if (!a) evs.set(id, a = []);
      a.push({ t: x.t, q: x.q, l: x.l, ko: !!x.ko, debut: Number(e[1]) || 0, ref: e[2], pv: e[3] || null,
               src: { b: e[4] || null, p: e[5] || null, m: e[6] || null } });
    }
  }
  const joursRetenus = new Set();
  for (const [, obs] of evs) {
    obs.sort((a, b) => a.t - b.t);
    const dernier = obs[obs.length - 1];
    const D = jourDe(dernier.debut);
    if (!opt.sansFiltreJours) {
      if (!jMin || D < jMin) { exclus.avantJ0++; continue; }
      if (!complet(D)) { exclus.joursIncomplets++; continue; }
    }
    joursRetenus.add(D);
    const g = groupeDe(dernier.l);
    const acc = new Map();   // cle -> { n, b, sev } pour CETTE rencontre
    const ajoute = (cle, r, pair) => {
      let a = acc.get(cle);
      if (!a) acc.set(cle, a = { n: 0, b: 0, sev: 0 });
      a.n += r.n; a.b += r.b; a.sev += r.sev;
      const c = cel(cle);
      c.paires++;
      if (pair.refChange) { c.nRef++; if (r.b) c.bRef++; }
    };
    for (let j = 0; j < obs.length; j++) {
      const J = obs[j];
      if (!(J.debut > J.t)) { exclus.enJeu++; continue; }
      if (J.ref === 'x' || !J.pv) { exclus.sansReference++; continue; }
      const dI = trancheDelai(J.debut - J.t);
      if (dI < 0) continue;
      const pris = new Array(tr.length).fill(-1);
      for (let i = j - 1; i >= 0; i--) {
        const K = obs[i], delta = J.t - K.t;
        if (delta > ageMax) break;   // jamais vendu (paris.ouvert) : ni paire, ni plus vieux
        /* k doit avoir ete VENDU : une reference, et un carnet ecrit (ko : le
           volume a refuse, l'ancien prix est reste en vente) */
        if (K.ref === 'x' || !K.pv || K.ko || !(delta > 0)) continue;
        const a = trancheDe(tr, delta);
        if (a >= 0 && pris[a] < 0) pris[a] = i;
      }
      for (let a = 0; a < tr.length; a++) {
        if (pris[a] < 0) continue;
        const K = obs[pris[a]], delta = J.t - K.t;
        const suffixe = '|' + tr[a].cle + '|' + DELAIS[dI].cle;
        if (J.debut - J.t < paris.PRES_MS && delta > paris.FRAIS_MS) {
          for (const gg of ['tous', g]) for (const rg of ['vente', 'source']) cel(gg + '|' + rg + '|1n2' + suffixe).refuses++;
          continue;
        }
        const ck = cotesDe(K.pv);
        if (!ck) { exclus.invendables++; continue; }
        const pair = { refChange: K.ref !== J.ref };
        const rv = juge(ck, J.pv);
        for (const mk of Object.keys(rv)) for (const gg of ['tous', g]) ajoute(gg + '|vente|' + mk + suffixe, rv[mk], pair);
        /* meme source : la source vendue a k, relue a j */
        const s = K.ref, pk = K.src[s], pjs = J.src[s];
        if (pk && pjs) {
          const cs = cotesDe(pk);
          if (cs) {
            const rs = juge(cs, pjs);
            for (const mk of Object.keys(rs)) for (const gg of ['tous', g]) ajoute(gg + '|source|' + mk + suffixe, rs[mk], { refChange: false });
          }
        }
      }
    }
    for (const [cle, a] of acc) {
      const c = cel(cle);
      c.m++; c.n += a.n; c.b += a.b; c.sbb += a.b * a.b; c.snn += a.n * a.n; c.sbn += a.b * a.n; c.sev += a.sev;
    }
  }
  return { serie: { j0: S.j0, c: S.c, av: S.av, am: S.am, ageMaxMs: ageMax, changements: S.changements, lignes: S.toutes.length, lignesSerie: S.run.length,
                    premier: S.toutes.length ? S.toutes[0].t : null, dernier: S.dernier },
           tranches: tr.map((x) => x.cle), delais: DELAIS.map((x) => x.cle), cellules, exclus,
           joursRetenus: [...joursRetenus].sort(), retraits: retraits(S.run), cadence: cadence(S.toutes), causes: causes(S.toutes) };
}

/* ---- LA BORNE HAUTE EXACTE (Garwood), POUR LES PARTS PRES DE ZERO ----
 * L'intervalle de Wald s'effondre pres de 0 : aucune issue battable, erreur
 * type nulle, borne haute 0 ; 2 sur 600 donnent 0,79 %. Or c'est la que
 * vivent les parts de ce journal (8.8bis : 0 a 2 issues battables sur 471 au
 * prix frais). Borne haute exacte d'un compte de Poisson x, au niveau 97,5 %
 * unilateral (le pendant de ±1,96 se) : λ tel que P(X <= x ; λ) = 2,5 %, soit
 * P(x + 1, λ) = 97,5 % (gamma incomplete regularisee, x non entier compris).
 * Poisson pour une binomiale : plus large, donc prudent. Gonflee par la
 * grappe (Kish) : x et n deviennent Σb/deff et Σn/deff. Reperes : 0 sur 600
 * -> 0,61 % ; 2 sur 600 -> 1,20 % (relecture du lot 1, 10/10 : la borne de
 * Wald laissait G1 conclure « equivalent » a 0,79 %). */
const ALPHA_HAUT = 0.025;
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
                 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lnGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const y = z - 1;
  let s = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) s += LANCZOS[i] / (y + i);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(s);
}
/** P(a, x), la gamma incomplete inferieure regularisee (serie, ou fraction
 *  continue de Lentz pour x >= a + 1). */
function gammaP(a, x) {
  if (!(x > 0)) return 0;
  const lnPre = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let ap = a, del = 1 / a, sum = del;
    for (let i = 0; i < 1000; i++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return Math.min(1, sum * Math.exp(lnPre));
  }
  const TINY = 1e-300;
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(lnPre) * h);
}
/** La borne haute exacte de Poisson d'un compte x (non entier admis). */
function borneHautePoisson(x, alpha) {
  const a = Math.max(0, x) + 1, cible = 1 - (alpha === undefined ? ALPHA_HAUT : alpha);
  let lo = 0, hi = 2 * a + 10;
  while (gammaP(a, hi) < cible) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) { const mi = (lo + hi) / 2; if (gammaP(a, mi) < cible) lo = mi; else hi = mi; }
  return (lo + hi) / 2;
}

/** L'intervalle robuste par rencontre d'une cellule. m < 2 : non defini.
 *  - lo, hi : Wald robuste par rencontre (±1,96 se) ;
 *  - hiSur : la plus haute de hi et de la borne exacte (hiExact) — c'est elle
 *    que lit G1 ; seSur l'erreur type qui la redonne (pour l'ecart) ;
 *  - mde80 : l'effet detectable a 80 % SOUS τ, (1,96 + 0,84) x seTau avec
 *    seTau = √(τ(1-τ) deff / Σn). A la part OBSERVEE, l'erreur type tombait
 *    a 0 avec les issues battables, et G2 disait « non » sans la puissance
 *    voulue : 18 % de « non » sur 4 000 tirages a fuite vraie = τ, m = 150
 *    (relecture du lot 1, 10/10). deff (Kish) = se² Σn / (p(1-p)), au moins
 *    1, et 1 quand la part vaut 0 ou 1. */
function stats(c) {
  const out = { m: c ? c.m : 0, n: c ? c.n : 0, b: c ? c.b : 0, part: null, se: null, lo: null, hi: null,
                deff: null, seTau: null, mde80: null, hiExact: null, hiSur: null, seSur: null,
                sevParM: null, partRef: null, refuses: c ? c.refuses : 0 };
  if (!c || !c.m || !c.n) return out;
  const r = c.b / c.n;
  out.part = r;
  out.sevParM = c.sev / c.m;
  out.partRef = c.b ? c.bRef / c.b : 0;
  if (c.m >= 2) {
    const v = (c.m / (c.m - 1)) * (c.sbb - 2 * r * c.sbn + r * r * c.snn) / (c.n * c.n);
    out.se = Math.sqrt(Math.max(0, v));
    out.lo = r - Z95 * out.se; out.hi = r + Z95 * out.se;
    out.deff = r > 0 && r < 1 ? Math.max(1, out.se * out.se * c.n / (r * (1 - r))) : 1;
    out.seTau = Math.sqrt(PORTE.tau * (1 - PORTE.tau) * out.deff / c.n);
    out.mde80 = (Z95 + Z80) * out.seTau;
    out.hiExact = Math.min(1, borneHautePoisson(c.b / out.deff) / (c.n / out.deff));
    out.hiSur = Math.max(out.hi, out.hiExact);
    out.seSur = Math.max(out.se, (out.hiSur - r) / Z95);
  }
  return out;
}
const cleDe = (g, regle, mk, ageH, delai) => g + '|' + regle + '|' + mk + '|' + ageH[0] + '-' + ageH[1] + 'h|' + delai;

// --------------------------------------------------------------- les portes

/** Les dates d'une porte : au plus tot j0 + 14, et la prolongation j0 + 28. */
function dates(r) {
  const j0 = r.serie.j0;
  const fin = r.serie.dernier ? jourDe(r.serie.dernier) : null;
  return { j0, fin, auPlusTot: j0 ? plusJours(j0, PORTE.joursMin) : null, prolonge: j0 ? plusJours(j0, PORTE.joursProlonge) : null };
}
const pct = (x, d) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(d === undefined ? 2 : d) + ' %');

/** G2 sur une cellule (stats) : le verdict et son motif. */
function verdictG2(s, d) {
  const P = PORTE;
  if (!s) return { verdict: 'tranches redefinies', motif: 'la cellule de G2 (delai <3 h, age 1-3 h) n existe pas' };
  if (!d.j0 || !d.fin || d.fin < d.auPlusTot) return { verdict: 'trop tot', motif: 'au plus tot le ' + (d.auPlusTot || 'j0 + 14') };
  if (s.m < P.g2.mMin) return { verdict: 'echantillon insuffisant', motif: 'm=' + s.m + '/' + P.g2.mMin };
  if (s.part >= P.tau) return { verdict: 'oui', motif: 'part ' + pct(s.part) + ' >= τ ' + pct(P.tau, 1) };
  if (s.lo !== null && s.lo > 0) return { verdict: 'oui', motif: 'borne basse ' + pct(s.lo) + ' > 0' };
  /* « non » seulement avec la puissance A τ (mde80 sous τ, voir `stats`) ;
     sans elle, on prolonge jusqu'a j0 + 28, ou la porte conclut (plan
     corrige : « on prolonge a J0 + 28 au lieu de dire non »). */
  const puissant = s.mde80 !== null && s.mde80 <= P.tau;
  if (!puissant && d.fin < d.prolonge)
    return { verdict: 'prolonger', motif: 'puissance insuffisante sous τ : effet detectable a 80 % = ' + pct(s.mde80) + ' > τ ; remesurer le ' + d.prolonge };
  return { verdict: 'non', motif: 'part ' + pct(s.part) + ' < τ, borne basse ' + pct(s.lo) + ' <= 0'
    + (puissant ? ', effet detectable a 80 % sous τ ' + pct(s.mde80) + ' <= τ' : ', SANS la puissance a j0 + 28 (effet detectable ' + pct(s.mde80) + ')') };
}
/** G1 (equivalence) sur deux cellules : [12 h ; 13 h) et [1 h ; 3 h). La
 *  borne haute de [12 h ; 13 h) est la plus prudente de Wald et de la borne
 *  exacte (`hiSur`) ; l'ecart prend les erreurs types qui les redonnent
 *  (`seSur`) : pres de 0 de part et d'autre, Wald donnait un ecart sans
 *  largeur (se nulles) et « equivalent » sur 2 issues battables contre 0. */
function verdictG1(sLoin, sRef, d) {
  const P = PORTE;
  if (!sLoin || !sRef) return { verdict: 'tranches redefinies', motif: 'les cellules de G1 (delai 48 h+, ages 12-13 h et 1-3 h) n existent pas' };
  if (!d.j0 || !d.fin || d.fin < d.auPlusTot) return { verdict: 'trop tot', motif: 'au plus tot le ' + (d.auPlusTot || 'j0 + 14') };
  if (sLoin.m < P.g1.mMin || sRef.m < P.g1.mMin) return { verdict: 'echantillon insuffisant', motif: 'm=' + Math.min(sLoin.m, sRef.m) + '/' + P.g1.mMin };
  if (sLoin.hiSur === null || sRef.seSur === null || sLoin.hiSur === undefined || sRef.seSur === undefined)
    return { verdict: 'echantillon insuffisant', motif: 'intervalle non defini' };
  const ecart = sLoin.part - sRef.part, seE = Math.sqrt(sLoin.seSur * sLoin.seSur + sRef.seSur * sRef.seSur), hiE = ecart + Z95 * seE;
  const motif = 'borne haute 12-13 h ' + pct(sLoin.hiSur) + ' (τ ' + pct(P.tau, 1) + '), borne haute de l ecart ' + pct(hiE) + ' (τ/2 ' + pct(P.tau / 2) + ')';
  return { verdict: sLoin.hiSur <= P.tau && hiE <= P.tau / 2 ? 'oui' : 'non', motif, ecart, hiEcart: hiE };
}
/* La construction de G1 lit la conclusion du socle (`projection.depasse`),
   pas le chiffre brut : avant le 7 du mois, la projection ne conclut pas
   (PROJECTION_JOURS_MIN, paris_import.js : un samedi pese d'un sixieme a la
   totalite de l'echantillon), et G1 ne peut pas se dire constructible sur
   un ou deux jours de compteur. */
function construction(proj) {
  if (!proj || !Number.isFinite(proj.credits))
    return 'projection du mois inconnue (--telecharge la lit) : G1 ne se construit pas tant qu elle reste sous 16 000';
  const jour = Number.isFinite(proj.jourDuMois) ? ' (jour ' + proj.jourDuMois + ' du mois)' : '';
  const seuil = Number.isFinite(proj.seuil) ? proj.seuil : 16000;
  if (proj.depasse === undefined)
    return 'projection ' + proj.credits + jour + ' sans la conclusion du socle (depasse) : G1 ne se construit pas';
  if (proj.depasse === null)
    return 'projection ' + proj.credits + jour + ' pas encore concluante (avant le ' + (proj.joursMin || 7) + ' du mois) : G1 ne se construit pas';
  return proj.depasse ? 'projection ' + proj.credits + jour + ' > ' + seuil + ' : G1 peut se construire si elle dit oui'
                      : 'projection ' + proj.credits + jour + ' <= ' + seuil + ' : G1 NE SE CONSTRUIT PAS (forfait fixe, rien a economiser)';
}
/* La moyenne PONDEREE PAR LE TEMPS de la part battable sur [0 ; H) heures
   d'age, a un delai donne (correction du sceptique, rapportee sans etre une
   porte) : sous une cadence de 12 h sur le tic de 30 min, l'age du prix en
   vente est uniforme sur [0 ; 12 h 30), et la fuite moyenne vendue est la
   moyenne des parts par tranche, ponderee par la largeur de chaque tranche
   coupee a H. n/a si les tranches ne couvrent pas [0 ; H) ou si une cellule a
   moins de AFFICHE_MIN rencontres. */
function moyenneTemps(r, regle, delai, H) {
  const out = { regle, delai, heures: H, part: null, mMin: null, raison: null };
  let poids = 0, somme = 0, mMin = Infinity;
  for (const a of r.tranches) {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)h$/.exec(a);
    if (!m) continue;
    const w = Math.max(0, Math.min(Number(m[2]), H) - Math.max(Number(m[1]), 0));
    if (!w) continue;
    const s = stats(r.cellules['tous|' + regle + '|1n2|' + a + '|' + delai]);
    mMin = Math.min(mMin, s.m);
    if (s.part === null) { out.raison = 'tranche ' + a + ' vide'; continue; }
    poids += w; somme += w * s.part;
  }
  out.mMin = mMin === Infinity ? 0 : mMin;
  if (!out.raison && Math.abs(poids - H) > 1e-9) out.raison = 'les tranches ne couvrent pas 0-' + H + ' h';
  if (!out.raison && out.mMin < AFFICHE_MIN) out.raison = 'm=' + out.mMin + '<' + AFFICHE_MIN;
  if (!out.raison) out.part = somme / poids;
  return out;
}
/** Les deux regles doivent dire la meme chose, sinon « non decide ». */
function accorde(v, s) {
  if (v.verdict === s.verdict) return { verdict: v.verdict, motif: v.motif, vente: v, source: s };
  return { verdict: 'non decide', motif: 'vente : ' + v.verdict + ' ; meme source : ' + s.verdict, vente: v, source: s };
}
/** Les verdicts des deux portes, sans bascule : le proprietaire pose la
 *  variable du lot B, rien ne change ici. */
function portes(r, o) {
  const d = dates(r);
  const st = (regle, ageH, delai) => {
    const c = r.cellules[cleDe('tous', regle, '1n2', ageH, delai)];
    return r.tranches.indexOf(ageH[0] + '-' + ageH[1] + 'h') < 0 ? null : stats(c);
  };
  const G2 = PORTE.g2, G1 = PORTE.g1;
  const g2 = accorde(verdictG2(st('vente', G2.age, G2.delai), d), verdictG2(st('source', G2.age, G2.delai), d));
  const hautE = st('vente', G2.ecart.haut, G2.ecart.delai), basE = st('vente', G2.ecart.bas, G2.ecart.delai);
  let ecartG2 = null;
  if (hautE && basE && hautE.part !== null && basE.part !== null) {
    const e = hautE.part - basE.part, se = hautE.seSur !== null && basE.seSur !== null ? Math.sqrt(hautE.seSur * hautE.seSur + basE.seSur * basE.seSur) : null;
    const m = Math.min(hautE.m, basE.m);
    /* rapporte, jamais une porte ; sous AFFICHE_MIN rencontres, le rapport
       ne l'affiche pas (`assez`) */
    ecartG2 = { delai: G2.ecart.delai, ecart: e, lo: se === null ? null : e - Z95 * se, hi: se === null ? null : e + Z95 * se, m, assez: m >= AFFICHE_MIN };
  }
  const g1 = accorde(verdictG1(st('vente', G1.age, G1.delai), st('vente', G1.ref, G1.delai), d),
                     verdictG1(st('source', G1.age, G1.delai), st('source', G1.ref, G1.delai), d));
  g1.construction = construction(o && o.projection);
  return { dates: d, tau: PORTE.tau, g2, g1, ecartG2, moyenneG1: moyenneTemps(r, 'vente', G1.delai, G1.moyenneH),
           cellulesG2: { vente: st('vente', G2.age, G2.delai), source: st('source', G2.age, G2.delai) },
           cellulesG1: { loin: st('vente', G1.age, G1.delai), ref: st('vente', G1.ref, G1.delai) } };
}

// --------------------------------------------------------------- les rapports

/* Les retraits : une rencontre avec reference a la ligne k de son
   championnat, sans reference ou ABSENTE a la ligne suivante (non vide), alors
   qu'elle n'avait pas commence. p(k) s'est vendu de t_k a t_j : c'est
   precisement quand un parieur informe le bat le plus surement (une nouvelle
   fait retirer le marche). La regle des paires les ecarte par construction ;
   on les compte donc a part, par delai. */
function retraits(run) {
  const parLigue = new Map();
  for (const x of run) { if (x.o) continue; if (!parLigue.has(x.l)) parLigue.set(x.l, []); parLigue.get(x.l).push(x); }
  const out = {};
  for (const d of DELAIS) out[d.cle] = { suivies: 0, retirees: 0, absentes: 0, durees: [] };
  for (const [, L] of parLigue) {
    for (let i = 0; i + 1 < L.length; i++) {
      const A = L[i], B = L[i + 1];
      if (!B.n || B.ko) continue;
      const dansB = new Map(B.e.map((e) => [String(e[0]), e]));
      for (const e of A.e) {
        if (e[2] === 'x' || !(Number(e[1]) > B.t)) continue;
        const dI = trancheDelai(Number(e[1]) - B.t);
        if (dI < 0) continue;
        const r = out[DELAIS[dI].cle];
        r.suivies++;
        const eb = dansB.get(String(e[0]));
        if (!eb) { r.absentes++; r.durees.push(B.t - A.t); } else if (eb[2] === 'x') { r.retirees++; r.durees.push(B.t - A.t); }
      }
    }
  }
  for (const k of Object.keys(out)) {
    const r = out[k], d = r.durees.sort((a, b) => a - b);
    r.dureeMedianeMin = d.length ? Math.round(d[Math.floor(d.length / 2)] / MIN) : null;
    delete r.durees;
  }
  return out;
}
/* La cadence reelle : l'ecart entre deux lignes successives d'un meme
   championnat, par cause de la seconde. C'est l'histogramme qui fige les
   tranches apres une semaine. */
function cadence(toutes) {
  const der = new Map(), ecarts = [];
  const parQ = {};
  for (const x of toutes) {
    const p = der.get(x.l);
    if (p !== undefined) {
      const e = (x.t - p) / MIN;
      ecarts.push(e);
      (parQ[x.q || '?'] = parQ[x.q || '?'] || []).push(e);
    }
    der.set(x.l, x.t);
  }
  const bornes = [0, 15, 30, 45, 60, 90, 120, 135, 150, 165, 180, 240, 360, 720, 780, 1440, Infinity];
  const histo = [];
  for (let i = 0; i + 1 < bornes.length; i++) {
    const n = ecarts.filter((e) => e >= bornes[i] && e < bornes[i + 1]).length;
    histo.push({ de: bornes[i], a: bornes[i + 1] === Infinity ? null : bornes[i + 1], n });
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)] * 10) / 10 : null; };
  const parCause = {};
  for (const [q, a] of Object.entries(parQ)) parCause[q] = { n: a.length, medianeMin: med(a) };
  return { n: ecarts.length, medianeMin: med(ecarts), histo, parCause };
}
function causes(toutes) {
  const out = {};
  for (const x of toutes) { const j = jourDe(x.t); (out[j] = out[j] || {})[x.q || '?'] = ((out[j] || {})[x.q || '?'] || 0) + 1; }
  return out;
}
/** La part des mises reelles par delai (pari.t, jambe.debut) : rapportee,
 *  jamais une porte. Une jambe d'un combine pese mise / nombre de jambes. */
function mises(liste) {
  const out = { tickets: 0, jambes: 0, parDelai: {} };
  for (const d of DELAIS) out.parDelai[d.cle] = { jambes: 0, mise: 0 };
  let total = 0;
  for (const p of liste || []) {
    const t = Number(p && p.t), j = (p && p.jambes) || [];
    if (!Number.isFinite(t) || !j.length) continue;
    out.tickets++;
    const poids = (Number(p.mise) || 0) / j.length;
    for (const x of j) {
      const debut = typeof x.debut === 'number' ? x.debut : Date.parse(x.debut);
      if (!Number.isFinite(debut)) continue;
      const dI = trancheDelai(debut - t);
      if (dI < 0) continue;
      out.jambes++;
      out.parDelai[DELAIS[dI].cle].jambes++;
      out.parDelai[DELAIS[dI].cle].mise += poids;
      total += poids;
    }
  }
  for (const k of Object.keys(out.parDelai)) {
    const r = out.parDelai[k];
    r.part = out.jambes >= MISES_MIN && total > 0 ? r.mise / total : null;
  }
  out.assez = out.jambes >= MISES_MIN;
  return out;
}

/** Le texte du rapport. Aucune part sous AFFICHE_MIN rencontres. */
function rapport(r, P, extra) {
  const L = [];
  const s = r.serie;
  const d = P.dates;
  L.push(`AGE DU PRIX VENDU · ${s.lignes} ligne(s) de journal, serie a regime constant (c=${s.c} min, avant-match pour tous ${s.av === null ? '?' : s.av}, `
    + `age max ${s.am === null ? 'inconnu, ' + Math.round(s.ageMaxMs / MIN) + ' min local' : s.am + ' min'}) depuis ${s.j0 || '—'} (${s.changements} changement(s) de regime)`);
  L.push(`jours de coup d envoi retenus (complets, >= j0 + 3) : ${r.joursRetenus.length ? r.joursRetenus[0] + ' .. ' + r.joursRetenus[r.joursRetenus.length - 1] + ' (' + r.joursRetenus.length + ')' : 'aucun'}`);
  L.push(`exclus : ${Object.entries(r.exclus).map(([k, v]) => k + ' ' + v).join(' · ')}`);
  L.push('');
  L.push(`CADENCE REELLE (ecart entre deux lignes d un championnat, ${r.cadence.n} ecarts, mediane ${r.cadence.medianeMin} min) :`);
  L.push('  ' + r.cadence.histo.filter((h) => h.n).map((h) => `${h.de}-${h.a === null ? '…' : h.a} min: ${h.n}`).join(' · '));
  L.push('  par cause : ' + Object.entries(r.cadence.parCause).map(([q, x]) => `${q} n=${x.n} med ${x.medianeMin} min`).join(' · '));
  L.push('');
  L.push(`1-N-2, REGLE DE VENTE — part d issues battables, IC 95 % robuste par rencontre ; n/a sous ${AFFICHE_MIN} rencontres`);
  L.push('  age \\ delai'.padEnd(14) + r.delais.map((x) => x.padEnd(34)).join(''));
  for (const a of r.tranches) {
    let ligne = ('  ' + a).padEnd(14);
    for (const dl of r.delais) {
      const c = r.cellules['tous|vente|1n2|' + a + '|' + dl];
      const st = stats(c);
      let txt;
      if (!c || !st.m) txt = c && c.refuses ? `refusees ${c.refuses}` : '—';
      else if (st.m < AFFICHE_MIN) txt = `n/a (m=${st.m}<${AFFICHE_MIN})`;
      else txt = `m=${st.m} ${pct(st.part)} [${pct(st.lo)}–${pct(st.hi)}]`;
      ligne += txt.padEnd(34);
    }
    L.push(ligne);
  }
  L.push('');
  const v2 = P.cellulesG2.vente, s2 = P.cellulesG2.source;
  const dit = (x) => (!x ? '—' : x.m < AFFICHE_MIN ? `n/a (m=${x.m})` : `m=${x.m} ${pct(x.part)} [${pct(x.lo)}–${pct(x.hi)}] haute exacte ${pct(x.hiSur)} `
    + `effet detectable 80 % sous τ ${pct(x.mde80)} sev/m ${x.sevParM === null ? 'n/a' : (x.sevParM * 100).toFixed(2) + ' %'} part bRef ${pct(x.partRef, 0)}`);
  L.push(`PORTES (τ = ${pct(P.tau, 1)}, puissance 80 %, au plus tot le ${d.auPlusTot || '—'}, derniere ligne le ${d.fin || '—'})`);
  L.push(`  G2 pres du coup d envoi (delai <3 h, age 1-3 h, m >= ${PORTE.g2.mMin}) : ${P.g2.verdict.toUpperCase()} — ${P.g2.motif}`);
  L.push(`     vente : ${dit(v2)}`);
  L.push(`     meme source : ${dit(s2)}`);
  if (P.ecartG2) L.push('     ecart 3-6 h moins 1-3 h au delai 3-6 h (rapporte) : ' + (P.ecartG2.assez
    ? `${pct(P.ecartG2.ecart)} [${pct(P.ecartG2.lo)}–${pct(P.ecartG2.hi)}] m=${P.ecartG2.m}` : `n/a (m=${P.ecartG2.m}<${AFFICHE_MIN})`));
  L.push(`  G1 loin du coup d envoi (delai 48 h+, 12-13 h contre 1-3 h, m >= ${PORTE.g1.mMin}) : ${P.g1.verdict.toUpperCase()} — ${P.g1.motif}`);
  L.push(`     12-13 h : ${dit(P.cellulesG1.loin)}`);
  L.push(`     1-3 h  : ${dit(P.cellulesG1.ref)}`);
  if (P.moyenneG1) L.push(`     moyenne ponderee par le temps sur 0-${P.moyenneG1.heures} h d age, delai ${P.moyenneG1.delai} (rapportee) : `
    + (P.moyenneG1.part === null ? `n/a (${P.moyenneG1.raison})` : `${pct(P.moyenneG1.part)} (m >= ${P.moyenneG1.mMin} par tranche)`));
  L.push(`     ${P.g1.construction}`);
  L.push('');
  L.push('PAR GROUPE (vente, rapporte) :');
  for (const g of GROUPES.slice(1)) {
    const a = stats(r.cellules[cleDe(g, 'vente', '1n2', PORTE.g2.age, PORTE.g2.delai)]);
    const b = stats(r.cellules[cleDe(g, 'vente', '1n2', PORTE.g1.age, PORTE.g1.delai)]);
    L.push(`  ${g.padEnd(12)} G2 ${dit(a)} | G1 ${dit(b)}`);
  }
  L.push('');
  L.push('RETRAITS DE MARCHE (k avec reference -> j retiree ou absente, avant le coup d envoi) :');
  L.push('  ' + Object.entries(r.retraits).map(([k, x]) => `${k}: ${x.retirees + x.absentes}/${x.suivies}${x.dureeMedianeMin !== null ? ' (vendu ~' + x.dureeMedianeMin + ' min avant)' : ''}`).join(' · '));
  if (extra && extra.mises) {
    const m = extra.mises;
    L.push(`MISES REELLES PAR DELAI (${m.tickets} ticket(s), ${m.jambes} jambe(s)${m.assez ? '' : ', n/a sous ' + MISES_MIN + ' jambes'}) : `
      + Object.entries(m.parDelai).map(([k, x]) => `${k} ${x.part === null ? 'n/a' : pct(x.part, 0)} (${x.jambes})`).join(' · '));
  }
  return L.join('\n');
}

// --------------------------------------------------------------- le telechargement

/* Fige les jours COMPLETS (avant aujourd'hui UTC) absents du dossier, plus
   les paris (sans adresse ni nom : t, mise, debut des jambes) et l'etat du
   journal (avec la projection du mois). La cle part dans l'en-tete, jamais
   dans un fichier ni a l'ecran. Rend le compte de ce qui a ete fait. */
async function telecharge(o) {
  const base = String(o.base).replace(/\/+$/, ''), cle = String(o.cle || ''), dir = o.dossier;
  const aujourdhui = o.aujourdhui || jourDe(Date.now());
  const f = o.fetch || fetch;
  const h = { 'x-admin-key': cle };
  const lit = async (chemin) => {
    const r = await f(base + chemin, { headers: h });
    if (!r.ok) throw new Error(chemin.split('?')[0] + ' : HTTP ' + r.status);
    return r;
  };
  fs.mkdirSync(dir, { recursive: true });
  const etat = await (await lit('/paris/import')).json();
  const jp = etat.journalPrix || {};
  fs.writeFileSync(path.join(dir, 'etat.json'), JSON.stringify({ lu: new Date().toISOString(), journalPrix: jp,
    projection: (etat.quota && etat.quota.projection) || null }) + '\n');
  const fait = { jours: [], deja: 0, aujourdhui: 0 };
  for (const j of jp.jours || []) {
    if (!pj.jourValide(j.jour)) continue;
    if (j.jour >= aujourdhui) { fait.aujourdhui++; continue; }
    const cible = path.join(dir, j.jour + '.jsonl');
    if (fs.existsSync(cible)) { fait.deja++; continue; }
    const txt = await (await lit('/paris/journal-prix?jour=' + j.jour)).text();
    fs.writeFileSync(cible + '.tmp', txt);
    fs.renameSync(cible + '.tmp', cible);
    fait.jours.push(j.jour);
  }
  const tickets = [];
  for (let debut = 0, tour = 0; tour < 500; tour++) {
    const page = await (await lit('/paris/liste?etat=tous&limite=200&debut=' + debut)).json();
    for (const p of page.paris || []) tickets.push({ t: p.t, mise: p.mise, jambes: (p.jambes || []).map((x) => ({ debut: x.debut })) });
    if (!page.encore || !(page.paris || []).length) break;
    debut += page.paris.length;
  }
  fs.writeFileSync(path.join(dir, 'paris.json'), JSON.stringify(tickets) + '\n');
  fait.tickets = tickets.length;
  return fait;
}

// --------------------------------------------------------------- la commande

async function principal(argv) {
  const args = argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const DIR = path.resolve(opt('dossier', path.join(RACINE, '_releves', 'prix_journal')));
  if (args.includes('--telecharge')) {
    const cle = process.env.ADMIN_KEY;
    if (!cle) { console.error('ADMIN_KEY absente du shell : rien telecharge'); return 2; }
    const base = opt('url', 'https://web-production-220a3.up.railway.app');
    const fait = await telecharge({ base, cle, dossier: DIR });
    console.log(`telecharge : ${fait.jours.length} jour(s) fige(s)${fait.jours.length ? ' (' + fait.jours.join(', ') + ')' : ''}, ${fait.deja} deja la, `
      + `${fait.aujourdhui} en cours (jamais fige), ${fait.tickets} ticket(s) -> ${DIR}`);
  }
  const ages = opt('ages', null);
  const lu = await pj.lisJournal({ dossier: DIR });
  if (!lu.lignes.length) { console.log('aucune ligne de journal dans ' + DIR + (args.includes('--telecharge') ? '' : ' (lancer --telecharge)')); return 0; }
  const r = mesure(lu.lignes, { ages: ages ? ages.split(',').map(Number) : undefined });
  let etat = null;
  try { etat = JSON.parse(fs.readFileSync(path.join(DIR, 'etat.json'), 'utf8')); } catch (e) { /* pas d'etat fige */ }
  const P = portes(r, { projection: etat && etat.projection });
  let ms = null;
  try { ms = mises(JSON.parse(fs.readFileSync(opt('paris', path.join(DIR, 'paris.json')), 'utf8'))); } catch (e) { /* pas de paris figes */ }
  const sortie = { quand: new Date().toISOString(), dossier: DIR, illisibles: lu.illisibles, fichiers: lu.fichiers, mesure: r, portes: P, mises: ms };
  fs.mkdirSync(path.join(RACINE, '_releves', 'prix_age'), { recursive: true });
  fs.writeFileSync(path.join(RACINE, '_releves', 'prix_age', sortie.quand.replace(/[:.]/g, '-') + '.json'), JSON.stringify(sortie));
  if (args.includes('--json')) console.log(JSON.stringify(sortie, null, 1));
  else {
    console.log(`${lu.fichiers.length} fichier(s), ${lu.illisibles} ligne(s) illisible(s)`);
    console.log(rapport(r, P, { mises: ms }));
  }
  return 0;
}

if (require.main === module) {
  principal(process.argv).then((c) => process.exit(c)).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}

module.exports = { PORTE, AGES_DEFAUT, DELAIS, AFFICHE_MIN, MISES_MIN, Z95, Z80, ALPHA_HAUT, groupeDe, cotesVendues, juge, tranchesAge, regimeDe, serie, completeur,
                   mesure, gammaP, borneHautePoisson, stats, cleDe, dates, verdictG2, verdictG1, construction, moyenneTemps, accorde, portes,
                   retraits, cadence, mises, rapport, telecharge, principal };
