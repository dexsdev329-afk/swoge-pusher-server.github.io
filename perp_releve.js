'use strict';
/* ==========================================================================
 * LIRE LE JOURNAL — ET LE PIEGE QUI REND CETTE LECTURE DANGEREUSE
 *
 *   node perp_releve.js                 les 30 derniers jours
 *   node perp_releve.js --jours 90      les 90 derniers
 *   node perp_releve.js --horizon 60    une autre echeance que les 4 h
 *   node perp_releve.js --json          pour recracher dans autre chose
 *
 * ---- CE QU IL FAIT ----
 *
 * Il rapproche chaque ligne d observation (ce qui etait mesure au moment de
 * la decision) de ce que cette situation a REELLEMENT donne a l echeance
 * demandee, puis il decoupe en tranches : par marche, par heure, par
 * financement, par regime, par couloir, par interet ouvert… et il dit, pour
 * chaque tranche, l esperance et le nombre d observations.
 *
 * ---- LE PIEGE, ET C EST LE COEUR DE CE FICHIER ----
 *
 * Avec quinze decoupages de cinq tranches, on examine soixante-quinze cases.
 * Sur des donnees PUREMENT ALEATOIRES, la meilleure de soixante-quinze cases
 * a l air excellente : c est arithmetique, pas de la chance. Un releve qui se
 * contente de trier par esperance et de montrer le haut du tableau trouvera
 * TOUJOURS une regle gagnante, y compris dans du bruit — et c est comme ca
 * qu on met de l argent reel sur rien.
 *
 * Ce releve refuse de faire ca. Pour chaque decoupage, il rend :
 *
 *   - le nombre de cases examinees (`cases`) ;
 *   - ce a quoi ressemblerait LA MEILLEURE case si tout etait du bruit
 *     (`hasard`), calcule par melange : on garde les tranches, on redistribue
 *     les resultats au hasard, mille fois, et on regarde le meilleur obtenu ;
 *   - le verdict, qui n est « remarquable » que si la vraie meilleure case
 *     DEPASSE ce que le hasard produit.
 *
 * C est la version mesurable de « ne pas changer un seuil parce qu il semble
 * trop strict ». Rien ici ne decide : c est un outil de lecture.
 * ======================================================================== */

const journal = require('./perp_journal');

const HORIZON_DEFAUT = 240;
const MIN_CASE = 30;              /* sous ca, une case n est pas une case */
const MELANGES = 1000;            /* assez pour que le plafond du hasard soit stable */

/* ---- LES DECOUPAGES ----
 * Chacun est une question. Les bornes sont celles des traits de la colonie
 * quand elles existent, pour que le releve parle le meme langage qu elle. */
const tranche = (v, bornes, noms) => {
  if (v === null || v === undefined || !isFinite(v)) return null;
  for (let i = 0; i < bornes.length; i++) if (v < bornes[i]) return noms[i];
  return noms[noms.length - 1];
};
/* ---- UN SIGNAL DIRECTIONNEL NE SE LIT PAS SANS SON SENS ----
 *
 * Defaut trouve par l essai, et il etait dans l OUTIL. Le releve decoupait
 * sur le financement brut : « +0,01 % par 8 h ». Mais un financement positif
 * n est pas bon ou mauvais dans l absolu — il est PAYE par les longs et
 * ENCAISSE par les shorts. Dans une tranche « financement positif », la
 * moitie des situations sont des longs qui paient et l autre des shorts qui
 * encaissent : l effet s annule exactement, et un signal parfait se lit comme
 * du bruit. L essai l a montre en fabriquant un signal certain que l outil
 * n a pas vu.
 *
 * Toutes les mesures directionnelles sont donc ORIENTEES par le sens de la
 * situation, comme le fait deja le moteur (`coutFinancement` vaut
 * `-sens * taux`, `note()` multiplie par `sens`). La question devient « ce
 * que CE sens encaisse », et non « ce que le marche affiche ».
 *
 * Les mesures non directionnelles — la volatilite, le volume, l heure — ne
 * sont pas orientees : elles n ont pas de camp. */
const oriente = (v, sd) => (v === null || v === undefined || !isFinite(v)) ? null : v * sd;

const DECOUPAGES = {
  marche:      (o) => o.s ? String(o.s).replace(/USDT$/, '') : null,
  sens:        (o, r) => r.sd > 0 ? 'long' : 'short',
  heure:       (o) => 'h' + String(new Date(o.t).getUTCHours()).padStart(2, '0'),
  jour:        (o) => ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'][new Date(o.t).getUTCDay()],
  /* Ce que CE sens encaisse toutes les huit heures : positif, il est paye. */
  financement: (o, r) => tranche(o.f === null ? null : oriente(-o.f * 100, r.sd), [-0.01, -0.002, 0.002, 0.01],
                              ['paie fort', 'paie', 'neutre', 'encaisse', 'encaisse fort']),
  regime:      (o) => tranche(o.v1, [0.08, 0.18, 0.35], ['calme', 'normal', 'agite', 'tempete']),
  /* Le couloir vu de ce sens : un long qui entre bas, un short qui entre haut. */
  couloir:     (o, r) => tranche(o.cl === null ? null : oriente((0.5 - o.cl) * 100, r.sd), [-30, -10, 10, 30],
                              ['a contre-couloir', 'plutot contre', 'milieu', 'plutot pour', 'avec le couloir']),
  /* La tendance courte dans le sens de la position, ou contre elle. */
  tendance:    (o, r) => tranche(oriente(o.ee, r.sd), [-0.6, -0.15, 0.15, 0.6],
                              ['fort contre', 'contre', 'plate', 'pour', 'fort pour']),
  fond:        (o, r) => tranche(oriente(o.fo, r.sd), [-4, -1, 1, 4],
                              ['fond fort contre', 'fond contre', 'neutre', 'fond pour', 'fond fort pour']),
  carnet:      (o, r) => tranche(o.cb === null ? null : oriente(o.cb * 100, r.sd), [-30, -8, 8, 30],
                              ['carnet contre', 'carnet plutot contre', 'equilibre', 'carnet plutot pour', 'carnet pour']),
  /* Les trois qui sont enregistres et ne decident rien : c est ICI qu on
     saura s ils meritent de devenir des traits. */
  interetVar:  (o) => tranche(o.doi, [-1, -0.2, 0.2, 1], ['OI chute', 'OI baisse', 'OI plat', 'OI monte', 'OI bondit']),
  /* La prime sur l index, vue de ce sens : le contrat au-dessus du comptant
     est une foule longue, donc elle favorise le short. */
  base:        (o, r) => tranche(o.ba === null ? null : oriente(-o.ba, r.sd), [-0.02, -0.005, 0.005, 0.02],
                              ['prime contre', 'prime plutot contre', 'au pair', 'prime plutot pour', 'prime pour']),
  volume:      (o) => tranche(o.vo, [5e7, 2e8, 1e9], ['volume bas', 'volume moyen', 'volume haut', 'volume enorme']),
  note:        (o, r) => { const i = r.sd > 0 ? 0 : 1; const v = (o.sc || [])[i];
                           return tranche(v, [40, 50, 60, 70], ['<40', '40/50', '50/60', '60/70', '>70']); },
  refus:       (o, r) => { const i = r.sd > 0 ? 0 : 1; return (o.rf || [])[i] || 'pris'; },
};

const moy = (l) => l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
const arr = (v, n) => Math.round(v * Math.pow(10, n === undefined ? 3 : n)) / Math.pow(10, n === undefined ? 3 : n);

/**
 * LE PLAFOND DU HASARD. On garde les tranches telles quelles et on
 * redistribue les resultats au hasard. La meilleure case obtenue, mille fois
 * de suite, dit ce qu on trouverait SANS aucun signal. Une vraie meilleure
 * case qui ne depasse pas ce plafond n apprend rien.
 */
function plafondHasard(etiquettes, valeurs, minCase) {
  const v = valeurs.slice();
  let pire = 0;
  const tailles = {};
  for (const e of etiquettes) tailles[e] = (tailles[e] || 0) + 1;
  const cles = Object.keys(tailles).filter((k) => tailles[k] >= minCase);
  if (!cles.length) return null;
  for (let m = 0; m < MELANGES; m++) {
    /* Fisher-Yates : melanger les resultats, pas les tranches. */
    for (let i = v.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = v[i]; v[i] = v[j]; v[j] = t;
    }
    const s = {}, n = {};
    for (let i = 0; i < etiquettes.length; i++) {
      const e = etiquettes[i];
      s[e] = (s[e] || 0) + v[i]; n[e] = (n[e] || 0) + 1;
    }
    let best = -Infinity;
    for (const k of cles) if (n[k] >= minCase) best = Math.max(best, s[k] / n[k]);
    if (best > pire) pire = best;
  }
  return pire;
}

/** Le releve d un decoupage : ses cases, et ce que le hasard aurait donne. */
function decoupe(nom, paires, minCase) {
  const f = DECOUPAGES[nom];
  const etiquettes = [], valeurs = [];
  for (const p of paires) {
    const e = f(p.o, p.r);
    if (e === null || e === undefined) continue;
    etiquettes.push(e); valeurs.push(p.r.r);
  }
  const s = {}, n = {}, g = {};
  for (let i = 0; i < etiquettes.length; i++) {
    const e = etiquettes[i];
    s[e] = (s[e] || 0) + valeurs[i]; n[e] = (n[e] || 0) + 1;
    if (valeurs[i] > 0) g[e] = (g[e] || 0) + 1;
  }
  const cases = Object.keys(n).filter((k) => n[k] >= minCase)
    .map((k) => ({ case: k, n: n[k], moyenne: arr(s[k] / n[k]), gagnantes: Math.round((g[k] || 0) / n[k] * 100) }))
    .sort((a, b) => b.moyenne - a.moyenne);
  const hasard = plafondHasard(etiquettes, valeurs, minCase);
  const meilleure = cases[0] || null;
  /* ---- UNE SEULE CASE NE SE JUGE PAS ----
   * Melanger les resultats a l interieur d une tranche unique ne change rien :
   * le « plafond du hasard » vaut alors exactement la moyenne d ensemble, et
   * la comparaison se joue sur une erreur d arrondi. Un decoupage qui ne
   * separe rien n a pas de verdict a rendre. */
  if (cases.length < 2) {
    return { decoupage: nom, observations: etiquettes.length, cases, examinees: cases.length,
             hasard: hasard === null ? null : arr(hasard), verdict: 'pas assez' };
  }
  return {
    decoupage: nom, observations: etiquettes.length, cases,
    examinees: cases.length,
    hasard: hasard === null ? null : arr(hasard),
    /* ---- LE VERDICT ----
     * « remarquable » seulement si la meilleure case DEPASSE ce que mille
     * melanges produisent sur les memes donnees. Sinon : « dans le bruit »,
     * quelle que soit la beaute du chiffre. */
    verdict: (!meilleure || hasard === null) ? 'pas assez'
           : meilleure.moyenne > hasard ? 'remarquable' : 'dans le bruit',
  };
}

/** Le rapprochement : chaque resultat retrouve la ligne qui l a produit. */
function rapproche(v, horizon) {
  const par = {};
  for (const o of v.obs) par[o.i] = o;
  const paires = [];
  let orphelins = 0;
  for (const r of v.res) {
    if (r.h !== horizon) continue;
    const o = par[r.i];
    /* Un resultat dont l observation est hors fenetre — elle date d avant le
       premier jour relu. On le COMPTE, on ne l invente pas. */
    if (!o) { orphelins++; continue; }
    paires.push({ o, r });
  }
  return { paires, orphelins };
}

function releve(opts) {
  const o = opts || {};
  const horizon = o.horizon || HORIZON_DEFAUT;
  const minCase = o.minCase || MIN_CASE;
  const v = journal.relit(o.jours === undefined ? 30 : o.jours);
  const { paires, orphelins } = rapproche(v, horizon);
  const tous = paires.map((p) => p.r.r);
  const sortie = {
    horizon, jours: v.jours, observations: v.obs.length, resultats: v.res.length,
    lignesCassees: v.cassees, orphelins, apparies: paires.length,
    minCase,
    /* La reference : l esperance de TOUT, toutes tranches confondues. Une
       case ne vaut que comparee a elle. */
    ensemble: paires.length ? { n: paires.length, moyenne: arr(moy(tous)),
                                gagnantes: Math.round(tous.filter((x) => x > 0).length / tous.length * 100) } : null,
    decoupages: [],
  };
  if (!paires.length) return sortie;
  for (const nom of Object.keys(DECOUPAGES)) sortie.decoupages.push(decoupe(nom, paires, minCase));
  /* Les decoupages qui disent quelque chose d abord ; le bruit ensuite. */
  sortie.decoupages.sort((a, b) => (a.verdict === b.verdict ? b.observations - a.observations
                                    : a.verdict === 'remarquable' ? -1 : b.verdict === 'remarquable' ? 1 : 0));
  return sortie;
}

module.exports = { releve, decoupe, rapproche, plafondHasard, DECOUPAGES, MIN_CASE, HORIZON_DEFAUT };

// ------------------------------------------------------------ en ligne de commande

if (require.main === module) {
  const a = process.argv.slice(2);
  const val = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? Number(a[i + 1]) : d; };
  const r = releve({ jours: val('--jours', 30), horizon: val('--horizon', HORIZON_DEFAUT),
                     minCase: val('--min', MIN_CASE) });
  if (a.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }

  const e = journal.etat();
  console.log('\nJOURNAL   ' + e.jours + ' jour(s), ' + Math.round(e.octets / 1024) + ' Ko, garde ' + e.garde + ' j');
  console.log('RELEVE    echeance ' + r.horizon + ' min · ' + r.apparies + ' situations appariees'
              + (r.orphelins ? ' · ' + r.orphelins + ' resultats sans observation relue' : '')
              + (r.lignesCassees ? ' · ' + r.lignesCassees + ' lignes illisibles' : ''));
  if (!r.ensemble) {
    console.log('\nRien a lire encore. Le journal se remplit a chaque tour, et une situation\n'
                + 'n est jugeable qu une fois son echeance atteinte — ' + r.horizon + ' minutes.\n');
    process.exit(0);
  }
  console.log('ENSEMBLE  ' + r.ensemble.moyenne + ' % en moyenne, ' + r.ensemble.gagnantes
              + ' % de gagnantes, sur ' + r.ensemble.n + ' situations');
  console.log('\nUne case n est retenue qu a partir de ' + r.minCase + ' observations.');
  console.log('« hasard » = la meilleure case obtenue en redistribuant les resultats au');
  console.log('hasard ' + MELANGES + ' fois. Une meilleure case qui ne le depasse pas n apprend RIEN.\n');
  for (const d of r.decoupages) {
    const t = d.verdict === 'remarquable' ? '***' : d.verdict === 'dans le bruit' ? '   ' : ' ? ';
    console.log(t + ' ' + d.decoupage.padEnd(12)
                + String(d.examinees).padStart(2) + ' cases · '
                + (d.hasard === null ? 'hasard ?    ' : 'hasard ' + String(d.hasard).padStart(6) + ' %')
                + ' · ' + d.verdict);
    for (const c of d.cases.slice(0, 3)) {
      console.log('      ' + String(c.case).slice(0, 26).padEnd(28)
                  + String(c.moyenne).padStart(7) + ' %  '
                  + String(c.gagnantes).padStart(3) + ' % gagn.  n=' + c.n);
    }
  }
  console.log('');
}
