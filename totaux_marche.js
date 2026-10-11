'use strict';
/*
 * LE PLUS/MOINS 2,5 AU PRIX DES TOTAUX DU MARCHE — releve, carnet, mesure
 * (lot 5 de la cle 20K, 10/10/2026). OBSERVATION SEULEMENT dans ce lot.
 *
 * ---- pourquoi ----
 *
 * Les marches de buts (plus/moins 2,5, btts, score exact, handicap)
 * descendent d'une grille dont le TOTAL vient aujourd'hui du championnat et
 * du nul du 1-N-2 vendu (`cotes.totalDe`, 8.8ter) : sur le banc commun du
 * modele de buts (football-data, TEST 2023/24-2026/27, 15 986 rencontres),
 * 3,6 % des issues plus/moins restent battables contre la cloture (1 144 sur
 * 31 972) ; au chemin du marche des cinq grands, 1,4 %. Le total pris au
 * plus/moins des livres (prototype D2_match_rho40) : 42 sur 31 972, 0,13
 * +-0,04 %. Voir `cotes.totalDuMarche` et EXPLOITATION 8.8decies.
 *
 * ---- d'ou vient le total ----
 *
 * De la reponse `/odds` de The Odds API, marche `totals`, region eu : UN
 * credit par championnat et par releve, toutes ses rencontres d'un coup
 * (« cost = [number of markets specified] x [number of regions specified] »,
 * https://the-odds-api.com/liveapi/guides/v4/, relu le 09/10/2026 ; « If no
 * events are returned, the request will not count against the usage quota »,
 * meme page). Les spreads (handicap -1,5) ne sont PAS demandes : hors de ce
 * lot (une sonde de 1 credit sera faite plus tard par le proprietaire).
 * Pour chaque livre : la paire Over / Under sur la MEME ligne en x,5, marge
 * retiree par la puissance (`cotes.probasImplicites`), puis le total T de la
 * Poisson qui donne cette probabilite (`cotes.totalDuMarche`). Les lignes
 * entieres et en quart (2 ; 2,25 ; 2,75 ; 3) ne sont PAS lues : un
 * remboursement partiel ne se retire pas comme une marge.
 *
 * ---- CE QUE LA DOC NE DIT PAS (et que l'observation mesure) ----
 *  - si un livre rend UNE ligne (« The totals market as featured by a
 *    bookmaker », https://the-odds-api.com/sports-odds-data/betting-markets.html)
 *    ou plusieurs : `lignes` (histogramme) et `livresParLigneMax` ;
 *  - si les livres eu cotent les totaux hors EPL (« spreads and totals
 *    markets are mainly available for US sports and bookmakers at this
 *    time », meme page) : la couverture par championnat (porte 1) ;
 *  - les noms d'issues : « Over »/« Under » n'apparaissent que dans
 *    l'exemple des props joueurs du guide v4 ; tout autre nom est ignore et
 *    compte (`nomsInconnus`) ;
 *  - la facturation d'une reponse qui porte des rencontres sans aucun livre
 *    de totaux : la formule documentee (marches DEMANDES x regions) la
 *    facture ; x-requests-last le dira (`credits` du carnet).
 *
 * ---- la reference ----
 *
 * Dans l'ordre de prix_marche.js : la bourse Betfair (somme des inverses
 * 1,00-1,06), sinon Pinnacle (1,00-1,08), sinon la MEDIANE d'au moins trois
 * livres. Garde : si la bourse ou Pinnacle s'ecarte de plus de 0,25 but de la
 * mediane, c'est un prix fige ou un marche mince : on prend la mediane. Sans
 * mediane (moins de trois livres), la garde ne s'applique pas : la
 * reference est dite `seul` et la couverture compte `betfairSeul` a part.
 * La mediane prend les livres a la ligne 2,5 quand ils sont au moins trois
 * (ligne 2,5) ; sinon tous (ligne null : extrapolee, jamais vendue tant que
 * la strate n'est pas mesuree, paris_import.avecButs).
 *
 * ---- le carnet et le journal ----
 *
 * DATA_DIR/paris_totaux.json (le volume) : `evenements` (le total servi a la
 * vente, avec le p h2h du prix du marche au moment du releve), `ligues`
 * (derniere releve de la regle), `cloture` (derniere releve de cloture),
 * `essais` (releves sans reference a 48 h ou moins du coup d'envoi),
 * `couverture` (dernier compte par championnat), `credits` (somme des
 * x-requests-last par mois, championnat et type).
 * DATA_DIR/paris_totaux_obs.json : une entree par rencontre — couverture,
 * dernier total releve, cloture, cote vendue, cote de l'ombre — bornee a 60
 * jours et 5 000 entrees, ecrite en deux temps. La mesure (`mesure`) la lit.
 *
 * Ce module ne vend rien : il dit ce que le marche attend. La porte de
 * vente est `paris_import.avecButs` (PARIS_TOTAUX_LIGUES, vide par defaut).
 */
const fs = require('fs');
const path = require('path');
const cotes = require('./cotes');
const prixLigues = require('./prix_ligues');

const BOURSE = 'betfair_ex_eu', PINNACLE = 'pinnacle';
/* Les bornes de somme des inverses : celles de prix_marche.js (bourse 1,06,
   Pinnacle 1,08), pour la meme raison — au-dela, ce n'est pas un prix de
   reference mais un livre a marge ordinaire. */
const SOMME_BOURSE = 1.06, SOMME_PINNACLE = 1.08;
const ECART_MAX = 0.25;                 // buts, garde face a la mediane
const MEDIANE_MIN = 3;                  // livres
/* ---- LA GARDE DU 1-N-2 QUI A BOUGE (relecture du 09/10, bloquant 1) ----
 * Le total du plus/moins est releve au plus toutes les 12 h ; le 1-N-2 vendu,
 * toutes les 2 h. Apres une nouvelle (blessure, composition), le 1-N-2 bouge
 * et le vieux total, lui, non : le parieur qui suit le marche prendrait
 * l'issue restee au vieux prix. Le carnet note donc le p h2h du prix du
 * marche au moment du releve des totaux ; a la vente, si une issue a bouge
 * de plus de 5 points depuis, le total n'est PAS servi (repli : le total du
 * championnat, comme avant) et la releve est redemandee (au plus une par
 * 12 h). 5 points = ECART_MAX de prix_marche.js (la garde d'une reference
 * face a la mediane des livres) : c'est l'ecart au-dela duquel on cesse deja
 * de croire un prix de reference. Ce n'est PAS une mesure, et la porte 2 ne la
 * juge pas d'elle-meme : ses strates (age x ligne) ne voient que les totaux
 * ACCEPTES. Sa ligne d'audit (relecture du 10/10/2026) : a la cloture, chaque
 * rencontre jugee porte son `dp`, et une rencontre REFUSEE par la garde porte
 * l'ombre qu'on aurait vendue (`ombreRefusee`, `refusePar: 'dp'`) ; `mesure`
 * rend `garde` — part battable des refusees, et des acceptees par tranche de
 * dp ([0 ; 0,02[ et [0,02 ; 0,05]) — et refuse de conclure sous 100
 * rencontres. Lecture ecrite d'avance (EXPLOITATION 8.8decies) : trop large
 * si la tranche [0,02 ; 0,05] laisse plus de 0,5 % d'issues battables ; trop
 * stricte si les refusees tiennent (<= 0,5 % et sous le vendu). */
const DP_MAX = 0.05;
const DP_TRANCHE = 0.02;
/* Une rencontre compte un essai sans reference seulement si elle commence
   dans les 48 h (correction de la relecture du 09/10 : a J+6, les livres
   n'ont pas encore ouvert les totaux). Meme valeur que la fenetre de la
   regle (paris_import.TOTAUX_AVANT_MS). */
const ESSAI_FENETRE_MS = 48 * 3600000;

// ------------------------------------------------------------ un livre

function estX5(l) { return isFinite(l) && l >= 0 && Math.abs(l - Math.floor(l) - 0.5) < 1e-9; }

/** Le total d'un livre, ou null. `stats` (facultatif) recoit les lignes vues,
 *  les noms inconnus et `quart` (des totaux sans aucune ligne x,5). */
function totalDuLivre(b, stats) {
  const m = ((b && b.markets) || []).find((x) => x && x.key === 'totals');
  if (!m || !Array.isArray(m.outcomes) || !m.outcomes.length) return null;
  const parLigne = new Map();
  const vues = new Set();
  for (const o of m.outcomes) {
    if (!o) continue;
    const l = Number(o.point), c = Number(o.price);
    if (o.name !== 'Over' && o.name !== 'Under') { if (stats) stats.nomsInconnus = (stats.nomsInconnus || 0) + 1; continue; }
    if (!isFinite(l) || !(c > 1)) continue;
    vues.add(l);
    /* x,5 seulement : 2,5 l'est, 2,25 / 2,75 / 3 ne le sont pas */
    if (!estX5(l)) continue;
    const e = parLigne.get(l) || {};
    if (o.name === 'Over') e.plus = c; else e.moins = c;
    parLigne.set(l, e);
  }
  if (stats) {
    stats.lignes = stats.lignes || {};
    for (const l of vues) stats.lignes[String(l)] = (stats.lignes[String(l)] || 0) + 1;
    stats.livresParLigneMax = Math.max(stats.livresParLigneMax || 0, vues.size);
  }
  /* la ligne la plus proche de 2,5 qui porte les deux prix */
  const lignes = [...parLigne.entries()].filter(([, e]) => e.plus && e.moins)
    .sort((a, b) => Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5) || a[0] - b[0]);
  if (!lignes.length) { if (stats && vues.size) stats.quart = true; return null; }
  const [ligne, c] = lignes[0];
  const somme = 1 / c.plus + 1 / c.moins;
  if (!(somme >= 1.0)) return null;
  const p = cotes.probasImplicites(c, ['plus', 'moins'], 1);
  if (!p) return null;
  const total = cotes.totalDuMarche(p.plus, ligne);
  return total === null ? null : { total, ligne, somme, pLigne: p.plus };
}

/** La reference d'une rencontre de la reponse `/odds?markets=totals`, ou null.
 *  Rend { ref, total, ligne, livres, livres25, ecart, seul, pPlus25 }.
 *  `stats` (facultatif) : voir `totalDuLivre`, plus `quartSeul` (des totaux
 *  existent mais aucune ligne x,5). */
function referenceDe(ev, stats) {
  const lots = [];
  let bourse = null, pin = null;
  const s = stats || {};
  let quart = false, vus = 0;
  for (const b of (ev && ev.bookmakers) || []) {
    const st = { lignes: s.lignes || (s.lignes = {}), nomsInconnus: 0, livresParLigneMax: s.livresParLigneMax || 0 };
    const t = totalDuLivre(b, st);
    s.nomsInconnus = (s.nomsInconnus || 0) + st.nomsInconnus;
    s.livresParLigneMax = st.livresParLigneMax;
    if (st.quart) quart = true;
    if (!t) continue;
    vus++;
    if (b.key === BOURSE) { if (t.somme <= SOMME_BOURSE) bourse = t; continue; }
    if (b.key === PINNACLE && t.somme <= SOMME_PINNACLE) pin = t;
    lots.push(t);
  }
  if (!vus && quart) s.quartSeul = true;
  const a25 = lots.filter((t) => t.ligne === 2.5);
  const mediane = (v) => { const w = v.slice().sort((a, b) => a - b), k = Math.floor(w.length / 2); return w.length % 2 ? w[k] : (w[k - 1] + w[k]) / 2; };
  let med = null, ligneMed = null;
  if (a25.length >= MEDIANE_MIN) { med = mediane(a25.map((t) => t.total)); ligneMed = 2.5; }
  else if (lots.length >= MEDIANE_MIN) med = mediane(lots.map((t) => t.total));
  const livres = lots.length + (bourse ? 1 : 0);
  const livres25 = a25.length + (bourse && bourse.ligne === 2.5 ? 1 : 0);
  for (const [ref, t] of [['betfair', bourse], ['pinnacle', pin]]) {
    if (!t) continue;
    const e = med === null ? 0 : Math.abs(t.total - med);
    if (e <= ECART_MAX) {
      return { ref, total: t.total, ligne: t.ligne, livres, livres25, ecart: Math.round(e * 1000) / 1000, seul: med === null,
               pPlus25: t.ligne === 2.5 ? t.pLigne : cotes.plusDeLigne(t.total, 2.5) };
    }
  }
  if (med !== null) return { ref: 'mediane', total: med, ligne: ligneMed, livres: lots.length, livres25: a25.length, ecart: 0, seul: false,
                             pPlus25: cotes.plusDeLigne(med, 2.5) };
  return null;
}

// ------------------------------------------------------------ le carnet

const DOSSIER = (process.env.DATA_DIR || './data').trim();
function fichier() { return path.join(DOSSIER, 'paris_totaux.json'); }
function fichierObs() { return path.join(DOSSIER, 'paris_totaux_obs.json'); }
/* `j0` : la premiere releve de la regle, tous championnats ; `j0Ligues` : la
   premiere de CHAQUE championnat (un championnat ajoute plus tard a
   PARIS_TOTAUX_OBSERVE se juge sur SES semaines d'observation, relecture du
   10/10/2026). */
const VIDE = () => ({ evenements: {}, ligues: {}, cloture: {}, essais: {}, couverture: {}, credits: {}, j0: null, j0Ligues: {} });
function lisOuLeve() {
  const j = JSON.parse(fs.readFileSync(fichier(), 'utf8'));
  const c = VIDE();
  for (const k of Object.keys(c)) if (j && j[k] !== undefined && j[k] !== null) c[k] = j[k];
  return c;
}
function lis() { try { return lisOuLeve(); } catch (e) { return VIDE(); } }
/* ---- LA LECTURE DE VENTE, GARDEE (copie de prix_marche.luPourVendre) ----
 * `pour` est appele pour chaque rencontre de football de chaque import et par
 * la regle (toutes les 30 min) : sans lecture gardee, on revivrait les 580 ms
 * de serveur bloque mesurees le 09/10 sur paris_prix.json (400 lectures d'un
 * carnet de 750 rencontres). Les deux regles de la relecture du 09/10 :
 * une lecture RATEE ne se garde pas ; un fichier ecrit il y a moins de 2 s
 * se relit a chaque fois. */
const RECENT_MS = 2000;
let VU = null;
function luPourVendre() {
  let sig = 'absent', mtime = 0;
  try { const st = fs.statSync(fichier()); mtime = st.mtimeMs; sig = mtime + ':' + st.size; } catch (e) { /* pas encore de carnet */ }
  if (VU && VU.sig === sig && VU.lu - mtime > RECENT_MS) return VU.c;
  const lu = Date.now();
  let c;
  try { c = lisOuLeve(); } catch (e) { VU = null; return VIDE(); }
  VU = { sig, c, lu };
  return c;
}
/* Ecrit en deux temps ; rend false en cas d'echec : l'appelant garde alors la
   date en memoire, pour ne pas repayer la meme releve a chaque minuterie. */
const MEMOIRE = {};
function ecrisFichier(f, c) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c) + '\n');
    fs.renameSync(tmp, f);
    return true;
  } catch (e) {
    console.log('[odds] carnet des totaux illisible ou plein (' + path.basename(f) + ') : ' + (e.message || e));
    return false;
  }
}
function ecris(c) { const ok = ecrisFichier(fichier(), c); if (ok) VU = null; return ok; }

const moisDe = (t) => new Date(t).toISOString().slice(0, 7);

/**
 * Noter la reponse `/odds?markets=totals` d'un championnat. Rend le compte.
 * `o` : { cloture, credits, coutAttendu, pH2hDe(ev) }.
 *  - Releve de la regle (cloture faux) : le total de chaque rencontre ecrit
 *    dans `evenements`, avec le p h2h du moment (`pH2hDe`) ; une rencontre
 *    sans reference a 48 h ou moins fait `essais[id]++` ; un marche retire
 *    (sans reference, ou absent d'une reponse non vide) perd son total.
 *  - Releve de cloture : n'ECRIT JAMAIS un total (la cloture ne nourrit pas
 *    la vente, elle la juge) ; elle peut en EFFACER un, comme un marche
 *    retire (meme regle que prix_marche.note). Rend aussi `refs` (id ->
 *    reference de cloture) pour la mesure.
 */
function note(evs, ligue, now, o) {
  const t = now || Date.now();
  const L = String(ligue || '');
  const opt = o || {};
  const cloture = !!opt.cloture;
  const c = lis();
  const stats = { lignes: {}, nomsInconnus: 0, livresParLigneMax: 0 };
  const compte = { rencontres: 0, betfair: 0, pinnacle: 0, mediane: 0, aucun: 0, retires: 0, betfairSeul: 0, quartSeul: 0, ligne25: 0, essais: 0 };
  const refs = {};
  const vus = new Set();
  const couv = [];
  for (const ev of evs || []) {
    if (!ev || !ev.id) continue;
    const k = String(ev.id);
    vus.add(k);
    compte.rencontres++;
    const st = { lignes: stats.lignes, nomsInconnus: 0, livresParLigneMax: stats.livresParLigneMax };
    const r = referenceDe(ev, st);
    stats.nomsInconnus += st.nomsInconnus; stats.livresParLigneMax = st.livresParLigneMax;
    if (st.quartSeul) compte.quartSeul++;
    const debut = Date.parse(ev.commence_time) || 0;
    const dans48 = debut > t && debut - t <= ESSAI_FENETRE_MS;
    if (!r) {
      compte.aucun++;
      if (c.evenements[k]) { delete c.evenements[k]; compte.retires++; }
      if (!cloture && dans48) { const e = c.essais[k] || { n: 0, debut }; e.n++; e.debut = debut; c.essais[k] = e; compte.essais++; }
      if (!cloture && dans48) couv.push({ id: k, ligue: L, dom: String(ev.home_team || ''), ext: String(ev.away_team || ''), debut, r: null, quartSeul: !!st.quartSeul });
      continue;
    }
    compte[r.ref]++;
    if (r.ref === 'betfair' && r.seul) compte.betfairSeul++;
    if (r.ligne === 2.5) compte.ligne25++;
    if (cloture) { refs[k] = Object.assign({}, r, { t, dom: String(ev.home_team || ''), ext: String(ev.away_team || ''), debut }); continue; }
    let pH2h = null;
    try { pH2h = typeof opt.pH2hDe === 'function' ? opt.pH2hDe(ev) : null; } catch (e) { pH2h = null; }
    c.evenements[k] = { t, ref: r.ref, total: Math.round(r.total * 1e4) / 1e4, ligne: r.ligne, livres: r.livres, livres25: r.livres25,
                        seul: r.seul, pPlus25: Math.round(r.pPlus25 * 1e6) / 1e6, pH2h: pH2h || null,
                        ligue: L, dom: String(ev.home_team || ''), ext: String(ev.away_team || ''), debut };
    delete c.essais[k];
    if (dans48) couv.push({ id: k, ligue: L, dom: c.evenements[k].dom, ext: c.evenements[k].ext, debut, r, quartSeul: false });
  }
  /* Une rencontre a venir de ce championnat ABSENTE d'une reponse non vide :
     son marche a ete retire — elle perd son total (la cloture aussi : un
     marche retire n'a plus de prix). */
  if (vus.size) {
    for (const [k, e] of Object.entries(c.evenements)) {
      if (e.ligue === L && !vus.has(k) && e.debut > t) { delete c.evenements[k]; compte.retires++; }
    }
  }
  if (cloture) c.cloture[L] = t;
  else {
    c.ligues[L] = t;
    c.couverture[L] = Object.assign({ t: new Date(t).toISOString() }, compte,
      { lignes: stats.lignes, livresParLigneMax: stats.livresParLigneMax, nomsInconnus: stats.nomsInconnus });
    if (!c.j0) c.j0 = new Date(t).toISOString();
    if (!c.j0Ligues[L]) c.j0Ligues[L] = new Date(t).toISOString();
  }
  /* les credits : x-requests-last, ou le cout attendu s'il manque (compte par
     prudence : le plafond du mois ne doit pas se percer sur un en-tete absent) */
  {
    const m = moisDe(t);
    const parMois = c.credits[m] || (c.credits[m] = {});
    const x = parMois[L] || (parMois[L] = { regle: 0, cloture: 0, inconnus: 0 });
    const v = Number(opt.credits);
    if (isFinite(v) && v >= 0 && opt.credits !== null && opt.credits !== undefined) x[cloture ? 'cloture' : 'regle'] += v;
    else { x[cloture ? 'cloture' : 'regle'] += Number(opt.coutAttendu) || 1; x.inconnus++; }
    for (const k of Object.keys(c.credits).sort().slice(0, -3)) delete c.credits[k];
  }
  for (const [k, e] of Object.entries(c.evenements)) if (t - e.t > 10 * 86400000) delete c.evenements[k];
  for (const [k, e] of Object.entries(c.essais)) if (!(e && e.debut > t - 86400000)) delete c.essais[k];
  const cleMem = (cloture ? 'cloture:' : '') + L;
  if (ecris(c)) delete MEMOIRE[cleMem]; else MEMOIRE[cleMem] = t;
  if (couv.length) noteCouverture(couv, t);
  return Object.assign(compte, { refs: cloture ? refs : undefined });
}

/**
 * Une releve PARTIE mais ratee (erreur du fournisseur, delai) : la date est
 * ecrite comme pour une releve reussie, et le cout aussi (x-requests-last, ou
 * le cout attendu s'il manque, par prudence). Sans cela, une cle que le
 * fournisseur refuse (un marche `totals` non servi pour ce sport, une panne)
 * serait redemandee toutes les 30 min, sans ecart de 12 h ni plafond du mois.
 * Un appel REFUSE par le garde-fou (rien n'est parti) ne passe pas ici : il
 * se redemande au tic suivant, gratuitement.
 */
function noteEchec(ligue, now, o) {
  const t = now || Date.now();
  const L = String(ligue || '');
  const opt = o || {};
  const cloture = !!opt.cloture;
  const c = lis();
  if (cloture) c.cloture[L] = t; else c.ligues[L] = t;
  const m = moisDe(t);
  const parMois = c.credits[m] || (c.credits[m] = {});
  const x = parMois[L] || (parMois[L] = { regle: 0, cloture: 0, inconnus: 0 });
  const v = Number(opt.credits);
  if (opt.credits !== null && opt.credits !== undefined && isFinite(v) && v >= 0) x[cloture ? 'cloture' : 'regle'] += v;
  else { x[cloture ? 'cloture' : 'regle'] += Number(opt.coutAttendu) || 1; x.inconnus++; }
  x.echecs = (Number(x.echecs) || 0) + 1;
  const cleMem = (cloture ? 'cloture:' : '') + L;
  if (ecris(c)) delete MEMOIRE[cleMem]; else MEMOIRE[cleMem] = t;
}

/** Le total d'un evenement s'il a au plus PARIS_TOTAUX_AGE_MAX_H (ou `ageMs`,
 *  facultatif : la regle de releve passe le sien quand la vente est coupee a
 *  0 h) et que ses equipes sont celles de la rencontre (dans un sens ou dans
 *  l'autre : le total ne depend pas du sens), sinon null. Une COPIE.
 *  Un age maximal de 0 (PARIS_TOTAUX_AGE_MAX_H=0) : rien n'est servi. */
function pour(evenement, dom, ext, now, ageMs) {
  const e = luPourVendre().evenements[String(evenement || '')];
  if (!e) return null;
  const age = ageMs === undefined ? prixLigues.totauxAgeMaxMs() : Number(ageMs);
  if (!(age > 0) || !((now || Date.now()) - e.t <= age)) return null;
  /* un releve dont les equipes ne sont pas celles de la rencontre est celui
     d'un AUTRE match */
  if (!((e.dom === dom && e.ext === ext) || (e.dom === ext && e.ext === dom))) return null;
  return Object.assign({}, e, { pH2h: e.pH2h ? Object.assign({}, e.pH2h) : null });
}
/** Le 1-N-2 a-t-il bouge de plus de DP_MAX depuis le releve du total ?
 *  `pNow` : le p du prix du marche servi a la vente. Rend la plus grande
 *  variation, ou null si l'un des deux manque (on ne sait pas : pas servi). */
function ecartH2h(e, pNow) {
  if (!e || !e.pH2h || !pNow) return null;
  let m = 0;
  for (const i of ['1', 'N', '2']) {
    const a = Number(e.pH2h[i]), b = Number(pNow[i]);
    if (!(a > 0 && a < 1 && b > 0 && b < 1)) return null;
    m = Math.max(m, Math.abs(a - b));
  }
  return m;
}
function servable(e, pNow) { const d = ecartH2h(e, pNow); return d !== null && d <= DP_MAX; }
function derniere(ligue) { const L = String(ligue || ''); return Math.max(Number(luPourVendre().ligues[L]) || 0, MEMOIRE[L] || 0); }
function derniereCloture(ligue) { const L = String(ligue || ''); return Math.max(Number(luPourVendre().cloture[L]) || 0, MEMOIRE['cloture:' + L] || 0); }
function essaisDe(evenement) { const e = luPourVendre().essais[String(evenement || '')]; return e ? Number(e.n) || 0 : 0; }
/** Les credits de la REGLE de ce championnat ce mois-ci (le plafond mensuel). */
function creditsDuMois(ligue, now) {
  const x = ((luPourVendre().credits || {})[moisDe(now || Date.now())] || {})[String(ligue || '')];
  return x ? Number(x.regle) || 0 : 0;
}

// ------------------------------------------------------------ le journal d'observation

const OBS_JOURS = 60, OBS_MAX = 5000;
function lisObs() {
  try {
    const j = JSON.parse(fs.readFileSync(fichierObs(), 'utf8'));
    return { entrees: (j && j.entrees && typeof j.entrees === 'object') ? j.entrees : {} };
  } catch (e) { return { entrees: {} }; }
}
function borneObs(o, t) {
  for (const [k, e] of Object.entries(o.entrees)) if (!(e && e.debut > t - OBS_JOURS * 86400000)) delete o.entrees[k];
  const ks = Object.keys(o.entrees);
  if (ks.length > OBS_MAX) {
    ks.sort((a, b) => (o.entrees[a].debut || 0) - (o.entrees[b].debut || 0));
    for (const k of ks.slice(0, ks.length - OBS_MAX)) delete o.entrees[k];
  }
}
/* La couverture se compte PAR RENCONTRE, a chaque releve de la regle qui la
   voit a 48 h ou moins (porte 1) : couverte si une reference x,5 a ete vue au
   moins une fois. */
function noteCouverture(lignes, t) {
  const o = lisObs();
  for (const x of lignes) {
    const e = o.entrees[x.id] || (o.entrees[x.id] = { ligue: x.ligue, dom: x.dom, ext: x.ext, debut: x.debut });
    e.debut = x.debut;
    const cv = e.couv || (e.couv = { releves: 0, avecRef: false, ref: null, ligne: null, seul: false, quartSeul: false });
    cv.releves++;
    if (x.r) {
      cv.avecRef = true; cv.ref = x.r.ref; cv.ligne = x.r.ligne; cv.seul = !!x.r.seul;
      e.ouv = { t, ref: x.r.ref, ligne: x.r.ligne, total: Math.round(x.r.total * 1e4) / 1e4, pPlus25: Math.round(x.r.pPlus25 * 1e6) / 1e6 };
    } else if (x.quartSeul) cv.quartSeul = true;
  }
  borneObs(o, t);
  ecrisFichier(fichierObs(), o);
}
/** La cloture d'une rencontre : `x` = { ligue, dom, ext, debut, clo, vente,
 *  vendu, ombre, strate, raison, dp, ageH, refusePar, ombreRefusee, garde }
 *  (voir paris_import.mesureCloture). `raison` dit pourquoi elle n'est pas
 *  jugeable (pas de reference de cloture a 2,5, pas de total servable...).
 *  Ecrit dans le journal seulement. */
function noteCloture(id, x, now) {
  const t = now || Date.now();
  const o = lisObs();
  const e = o.entrees[String(id)] || (o.entrees[String(id)] = { ligue: x.ligue, dom: x.dom, ext: x.ext, debut: x.debut });
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  Object.assign(e, { clo: x.clo || null, vente: x.vente || null, vendu: x.vendu || null, ombre: x.ombre || null, strate: x.strate || null,
                     raison: x.raison || null, dp: num(x.dp), ageH: num(x.ageH), refusePar: x.refusePar || null,
                     ombreRefusee: x.ombreRefusee || null, garde: !!x.garde, tCloture: t });
  borneObs(o, t);
  return ecrisFichier(fichierObs(), o);
}

// ------------------------------------------------------------ la mesure

/* ---- LES PORTES, ECRITES AVANT J0 (EXPLOITATION 8.8decies) ----
 * Porte 1 (couverture, par championnat) : au moins 20 rencontres vues a 48 h
 * ou moins ; au moins 70 % avec une reference x,5 : passe ; 30 a 70 % :
 * decision du proprietaire ; sous 30 % apres 4 semaines D'OBSERVATION DE CE
 * CHAMPIONNAT (son J0 a lui, `j0Ligues`) : retirer.
 * Porte 2 (efficacite, avec PARIS_TOTAUX_CLOTURE=1), STRATIFIEE par age du
 * total a la cloture (< 24 h ; 24-48 h) x ligne de vente (2,5 directe ;
 * extrapolee) : au moins 100 rencontres par strate pour conclure ; par
 * strate, partOmbre <= 0,5 %, partOmbre < partVendu et gainFuteOmbre <=
 * gainFuteVendu ; au plus tot J0 + 14 et jamais avant le 26/10/2026.
 * Le type de reference se range sur la reference du total VENDU (`vente`),
 * pour ecarter une reference defaillante ; celle de la cloture est un second
 * axe du rapport (relecture du 10/10/2026 : rangee sur la cloture, la mesure
 * n'aurait jamais pu dire si « Betfair seul » vend de mauvais totaux).
 * Par championnat : rapporte ; `fuite` vrai si la borne basse de Wilson de sa
 * part battable (ombre) depasse 0,5 % (au moins 20 rencontres pour le dire) :
 * une fuite PROUVEE, ce championnat ne bascule pas. `fuite` faux ne prouve PAS
 * l'absence de fuite : a 20 rencontres (40 issues) il faut 2 issues battables
 * pour depasser 0,5 % (Wilson 1/40 = 0,44 %, 2/40 = 1,38 %), et une vraie
 * fuite de 3 % n'est vue que 34 % du temps (80 % vers 50 rencontres) — la
 * puissance est rendue a cote (`puissance3`). Avant le 10/10, ce champ
 * s'appelait `retenu` et se lisait a l'envers (« retenu » = selectionne,
 * dans ce depot).
 * Une porte non atteinte fait glisser la date, jamais le seuil. */
const PORTE1 = Object.freeze({ rencontresMin: 20, partPasse: 0.70, partRetire: 0.30, semainesRetire: 4 });
const PORTE2 = Object.freeze({ parStrateMin: 100, partMax: 0.005, joursMin: 14, pasAvant: '2026-10-26', ligueMin: 20, wilsonMax: 0.005 });
const STRATES = ['<24h|2,5', '<24h|extrapolee', '24-48h|2,5', '24-48h|extrapolee'];
/* la fuite de reference pour la puissance du verdict par championnat */
const FUITE_REFERENCE = 0.03;

/* borne basse de Wilson a 95 % */
function wilsonBas(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  return Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d);
}
/* La probabilite que la borne de Wilson depasse `seuil` sur n issues quand la
   vraie part battable vaut `p` (binomiale exacte, en logarithmes). */
function puissance(n, p, seuil) {
  if (!(n > 0) || !(p > 0 && p < 1)) return null;
  let s = 0, lc = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) lc += Math.log((n - k + 1) / k);
    if (wilsonBas(k, n) > seuil) s += Math.exp(lc + k * Math.log(p) + (n - k) * Math.log(1 - p));
  }
  return Math.min(1, s);
}
/* Une issue est battable si cote x p de cloture > 1 ; le gain fute est
   l'esperance, au prix de cloture, de qui prend toutes les issues battables
   d'une rencontre (somme de cote x p - 1). Ce n'est pas un resultat joue :
   aucun score n'est attendu pour le dire. */
function juge(cotesOu, pPlus) {
  if (!cotesOu || !(pPlus > 0 && pPlus < 1)) return null;
  let batt = 0, gain = 0;
  for (const [c, p] of [[Number(cotesOu.plus), pPlus], [Number(cotesOu.moins), 1 - pPlus]]) {
    if (!(c > 1)) return null;
    const e = c * p - 1;
    if (e > 0) { batt++; gain += e; }
  }
  return { issues: 2, batt, gain };
}
/* `cle` : la cote jugee contre le vendu — `ombre` (ce qu'on vendrait), ou
   `ombreRefusee` (ce qu'on aurait vendu sans la garde : l'audit de DP_MAX). */
function agrege(E, cle) {
  const k = cle || 'ombre';
  const out = { n: 0, issuesVendu: 0, battVendu: 0, partVendu: null, issuesOmbre: 0, battOmbre: 0, partOmbre: null,
                gainFuteVendu: null, gainFuteOmbre: null };
  let gv = 0, go = 0, nv = 0, no = 0;
  for (const e of E) {
    const p = e.clo && e.clo.pPlus25;
    const v = juge(e.vendu, p), o = juge(e[k], p);
    if (!v || !o) continue;
    out.n++;
    out.issuesVendu += v.issues; out.battVendu += v.batt; gv += v.gain; nv++;
    out.issuesOmbre += o.issues; out.battOmbre += o.batt; go += o.gain; no++;
  }
  if (out.issuesVendu) out.partVendu = out.battVendu / out.issuesVendu;
  if (out.issuesOmbre) out.partOmbre = out.battOmbre / out.issuesOmbre;
  if (nv) out.gainFuteVendu = gv / nv;
  if (no) out.gainFuteOmbre = go / no;
  return out;
}
/* Le meme echantillon et la meme date que la porte 2, ou « ne conclut pas ». */
function conclusion(a, dateOk) {
  a.conclut = a.n >= PORTE2.parStrateMin && dateOk;
  if (!a.conclut) a.pourquoi = a.n < PORTE2.parStrateMin ? `n = ${a.n} < ${PORTE2.parStrateMin} rencontres avec cloture : ne conclut pas`
    : `avant J0 + ${PORTE2.joursMin} ou le ${PORTE2.pasAvant} : ne conclut pas`;
  return a;
}
/** La mesure : couverture (porte 1) et efficacite (porte 2), pour un
 *  championnat (`ligue`) ou toutes (`null`). `obs` : le journal deja lu
 *  (etatImport le lit UNE fois par GET). J0 : celui du championnat
 *  (`j0Ligues`) quand `ligue` est donne, le premier de tous sinon. */
function mesure(ligue, now, obs, carnet) {
  const t = now || Date.now();
  const o = obs || lisObs();
  const c = carnet || lis();
  const parLigue = ligue !== null && ligue !== undefined;
  const E = Object.values(o.entrees).filter((e) => e && (!parLigue || e.ligue === ligue));
  /* porte 1 */
  const C = E.filter((e) => e.couv);
  const couverture = { rencontres: C.length, avecRef: C.filter((e) => e.couv.avecRef).length, part: null,
    betfair: 0, pinnacle: 0, mediane: 0, betfairSeul: 0, quartSeul: 0, ligne25: 0 };
  for (const e of C) {
    if (e.couv.avecRef) { couverture[e.couv.ref] = (couverture[e.couv.ref] || 0) + 1; if (e.couv.ref === 'betfair' && e.couv.seul) couverture.betfairSeul++; if (e.couv.ligne === 2.5) couverture.ligne25++; }
    else if (e.couv.quartSeul) couverture.quartSeul++;
  }
  if (couverture.rencontres) couverture.part = couverture.avecRef / couverture.rencontres;
  const j0Brut = parLigue ? ((c.j0Ligues || {})[ligue] || null) : c.j0;
  const j0 = j0Brut && isFinite(Date.parse(j0Brut)) ? Date.parse(j0Brut) : null;
  const semaines = j0 ? (t - j0) / (7 * 86400000) : 0;
  couverture.j0 = j0 ? new Date(j0).toISOString() : null;
  if (couverture.rencontres < PORTE1.rencontresMin) {
    couverture.porte = 'ne conclut pas';
    couverture.pourquoi = `${couverture.rencontres} rencontre(s) vue(s) a 48 h, moins de ${PORTE1.rencontresMin} : ne conclut pas`;
  } else if (couverture.part >= PORTE1.partPasse) couverture.porte = 'passe';
  else if (couverture.part < PORTE1.partRetire && semaines >= PORTE1.semainesRetire) couverture.porte = 'retirer';
  else couverture.porte = 'decision du proprietaire';
  /* porte 2 */
  const J = E.filter((e) => e.clo && e.vendu && e.ombre && e.strate);
  const strates = {};
  const dateOk = j0 !== null && t >= Math.max(j0 + PORTE2.joursMin * 86400000, Date.parse(PORTE2.pasAvant + 'T00:00:00Z'));
  for (const s of STRATES) {
    const a = conclusion(agrege(J.filter((e) => e.strate === s)), dateOk);
    a.passe = a.conclut ? (a.partOmbre <= PORTE2.partMax && a.partOmbre < a.partVendu && a.gainFuteOmbre <= a.gainFuteVendu) : null;
    strates[s] = a;
  }
  /* le type de reference du total VENDU (pour ecarter une reference
     defaillante) ; celui de la cloture en second axe */
  const parRef = {}, parRefCloture = {};
  for (const r of ['betfair', 'pinnacle', 'mediane']) {
    parRef[r] = agrege(J.filter((e) => e.vente && e.vente.ref === r));
    parRefCloture[r] = agrege(J.filter((e) => e.clo.ref === r));
  }
  parRef.betfairSeul = agrege(J.filter((e) => e.vente && e.vente.ref === 'betfair' && e.vente.seul));
  parRefCloture.betfairSeul = agrege(J.filter((e) => e.clo.ref === 'betfair' && e.clo.seul));
  /* la ligne d'audit des gardes de vente (DP_MAX, age) : voir DP_MAX */
  const G = E.filter((e) => e.clo && e.vendu && e.tCloture);
  const garde = {
    dpMax: DP_MAX,
    refusees: {
      dp: conclusion(agrege(G.filter((e) => e.refusePar === 'dp'), 'ombreRefusee'), dateOk),
      age: conclusion(agrege(G.filter((e) => e.refusePar === 'age'), 'ombreRefusee'), dateOk),
      sansPh2h: conclusion(agrege(G.filter((e) => e.refusePar === 'sansPh2h'), 'ombreRefusee'), dateOk),
    },
    acceptees: {
      '[0 ; 0,02[': conclusion(agrege(J.filter((e) => typeof e.dp === 'number' && e.dp < DP_TRANCHE)), dateOk),
      '[0,02 ; 0,05]': conclusion(agrege(J.filter((e) => typeof e.dp === 'number' && e.dp >= DP_TRANCHE)), dateOk),
    },
    coherenceEcartees: G.filter((e) => e.garde).length,
    lecture: [],
  };
  {
    const large = garde.acceptees['[0,02 ; 0,05]'], dpR = garde.refusees.dp;
    if (large.conclut) garde.lecture.push(large.partOmbre > PORTE2.partMax
      ? `DP_MAX trop large : acceptes a 2-5 points, ${(100 * large.partOmbre).toFixed(2)} % d'issues battables (> 0,5 %, n = ${large.n})`
      : `acceptes a 2-5 points : ${(100 * large.partOmbre).toFixed(2)} % (<= 0,5 %, n = ${large.n}) — DP_MAX n'est pas trop large`);
    if (dpR.conclut) garde.lecture.push(dpR.partOmbre <= PORTE2.partMax && dpR.partOmbre < dpR.partVendu
      ? `DP_MAX trop strict : les refusees auraient tenu (${(100 * dpR.partOmbre).toFixed(2)} %, vendu ${(100 * dpR.partVendu).toFixed(2)} %, n = ${dpR.n})`
      : `les refusees n'auraient pas tenu (${(100 * dpR.partOmbre).toFixed(2)} %, n = ${dpR.n}) — la garde sert`);
    if (!garde.lecture.length) garde.lecture.push('ne conclut pas (moins de 100 rencontres par tranche, ou avant la date de la porte 2)');
  }
  const tout = agrege(J);
  const sansOmbre = {};
  for (const e of E) if (e.tCloture && e.raison) sansOmbre[e.raison] = (sansOmbre[e.raison] || 0) + 1;
  const res = { couverture, mesure: Object.assign(tout, { strates, parRef, parRefCloture, garde, sansOmbre, dateOk, j0: j0 ? new Date(j0).toISOString() : null }) };
  if (parLigue) {
    const wb = wilsonBas(tout.battOmbre, tout.issuesOmbre);
    res.mesure.wilsonBasOmbre = wb;
    res.mesure.puissance3 = tout.issuesOmbre ? puissance(tout.issuesOmbre, FUITE_REFERENCE, PORTE2.wilsonMax) : null;
    if (tout.n < PORTE2.ligueMin) { res.mesure.fuite = null; res.mesure.pourquoi = `n = ${tout.n} < ${PORTE2.ligueMin} rencontres avec cloture : ne conclut pas`; }
    else if (wb > PORTE2.wilsonMax) {
      res.mesure.fuite = true;
      res.mesure.pourquoi = `fuite prouvee : borne basse de Wilson ${(100 * wb).toFixed(2)} % > 0,5 % sur n = ${tout.n} : ce championnat ne bascule pas`;
    } else {
      res.mesure.fuite = false;
      res.mesure.pourquoi = `pas de fuite prouvee sur n = ${tout.n} rencontres, ce qui n'en prouve pas l'absence `
        + `(une fuite de 3 % n'y serait vue que ${Math.round(100 * res.mesure.puissance3)} % du temps)`;
    }
  }
  return res;
}

module.exports = { BOURSE, PINNACLE, SOMME_BOURSE, SOMME_PINNACLE, ECART_MAX, MEDIANE_MIN, DP_MAX, DP_TRANCHE, ESSAI_FENETRE_MS,
                   totalDuLivre, referenceDe, note, noteEchec, pour, ecartH2h, servable, derniere, derniereCloture, essaisDe, creditsDuMois,
                   noteCloture, lisObs, mesure, agrege, juge, wilsonBas, puissance, FUITE_REFERENCE, PORTE1, PORTE2, STRATES, OBS_JOURS, OBS_MAX,
                   fichier, fichierObs, lis };
