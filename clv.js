'use strict';
/*
 * LA VALEUR DE CLOTURE (CLV) PAR PARIEUR — COLLECTE SEULE (lot 2 de la cle 20K,
 * 10/10/2026).
 *
 * ---- pourquoi ----
 *
 * Un parieur qui prend notre prix AVANT que le marche ne bouge dans son sens
 * nous bat, quelle que soit l'issue du match : c'est la seule mesure du talent
 * qui ne demande pas des centaines de resultats. Elle demande deux chiffres
 * que personne ne gardait :
 *  - la jambe vendue au prix du marche ne retenait ni la probabilite du marche
 *    dont sa cote descend, ni l'heure de ce prix (`paris.valide` jetait meme
 *    `prixMarche.p`, que l'import ecrit pourtant) ;
 *  - la cloture (le dernier prix d'avant-match) etait ecrasee par
 *    `prix_marche.note` des la releve suivante, matchs en cours compris.
 * Le lot 1 garde desormais chaque releve payee et tient l'INDEX DE CLOTURE
 * (`prix_journal`, derniere et avant-derniere observation a plus de 5 min du
 * coup d'envoi). Ce module ne fait que COLLECTER et DECRIRE :
 *  - a la vente (`aLaVente`), la jambe recopie { ev, pv, tv, ref, pm } ;
 *  - au reglement (`figeJambe`, appele par `game.regleMatch`), la cloture de
 *    l'index est figee sur la jambe : { pc, tc, refc, sans, ori, ctl? } ;
 *  - `bilan` decrit, pour le panneau du proprietaire (route /paris/clv).
 * AUCUNE action automatique sur une adresse : ni plafond, ni marge, ni refus.
 * Aucune releve de plus (0 credit) : tout vient de reponses deja payees.
 *
 * ---- les grandeurs ----
 *
 *   CLV d'une jambe    = cote x pc - 1   (le verdict d'ARGENT : nous bat-il
 *                                          malgre notre marge ?)
 *   r                  = pc / pv - 1     (le TALENT, sans la marge)
 *   evVente            = cote x pv - 1   (la marge reellement vendue)
 *   derive             = pc - pv         (en points de proba vers l'issue)
 * Une OBSERVATION = la moyenne des jambes d'UNE adresse sur UNE rencontre
 * (l'evenement du fournisseur) : quarante paris identiques sur un match
 * comptent pour un. Seules comptent les jambes qui ont BOUGE (tc > tv).
 *
 * ---- pourquoi le talent se juge sur r, et par categorie ----
 *
 * La CLV contient notre marge, et cette marge depend de l'issue : puissance
 * puis rabot de 6 % issue par issue (cotes.js raboteIssues, habilleUnMarche).
 * Mesure du sceptique (09/10, football-data, 12 305 rencontres, cotes de
 * production) : evVente favori -6,84 %... -5,38 % a p = 0,83, outsider
 * -15,07 % (-34,84 % au plus loin) ; « borne basse de CLV > moyenne de la
 * population » signalait un parieur SANS talent qui ne joue que le favori
 * 97,1 fois sur 100 a n = 40. D'ou r, sans marge.
 * Mesure du 10/10 (outils hors depot, meme proxy : Pinnacle d'ouverture,
 * 2,5 a 3,8 jours avant, contre Pinnacle de cloture, marge retiree par la
 * puissance comme en production ; graine fixe) : r d'une jambe au hasard
 * +0,02 %, ecart-type 9,21 points (demi-IC95 2,86 a n = 40, 1,81 a n = 100) ;
 * MAIS r derive selon la categorie d'issue : nul +1,52 % (e.-t. 6,68),
 * outsider -1,11 % (12,47), favori -0,21 % (7,26), double chance du favori
 * +0,35 % (3,64). Juge contre la moyenne de toute la foule, un parieur sans
 * talent qui ne joue que le nul passait « sharper » 31,5 fois sur 100 a
 * n = 40 (63,7 a n = 100), la double chance du favori 10,9. Contre la foule
 * DE SA CATEGORIE (300 jambes, son incertitude comptee dans l'erreur type) :
 * 2,1 a 3,5 % pour z = 1,96, 0,1 a 0,4 % avec Bonferroni a 10 adresses. Le
 * verdict « sharper » porte donc sur r MOINS la moyenne de la foule dans la
 * meme categorie (`categorie`). Le proxy est a 3 jours ; nos prix ont au
 * plus ~2 h 30 : derive et dispersion reelles inconnues, d'ou un seuil
 * PROVISOIRE.
 *
 * ---- les portes, ecrites d'avance (EXPLOITATION 8.8octies) ----
 *
 * Aucune bascule : une porte dit quand un CHIFFRE ou un VERDICT peut
 * s'afficher, ou quand une action peut etre PROPOSEE au proprietaire.
 *  1. Instrument valide (avant tout verdict) : 14 jours depuis la premiere
 *     jambe collectee ; 100 observations AVEC mouvement ; couverture >= 90 %
 *     (jambes 1-N-2 / double chance reglees, non remboursees, avec une
 *     cloture figee et sans panne) ; CONTROLE EXACT : sur au moins 60 jambes
 *     dont la releve de vente est encore dans l'index, le vecteur vendu
 *     (pm, ref) est celui que l'index a note a la meme milliseconde, pour
 *     99 % d'entre elles au moins (voir CONTROLE_N_MIN).
 *     ---- ecart au plan corrige, 10/10 (relecture du lot) ----
 *     Le plan disait (d) « |moyenne de r| <= 1 point ET evVente a 1 point de
 *     la marge recalculee par cotes.js ». Deux defauts, verifies :
 *      - la moyenne de r est celle des PARIEURS : un parieur fin qui pese une
 *        part s de la foule la pousse de s x son avance. Simulation (clv.bilan
 *        d'avant ce changement, e.-t. de r 7 points, graine fixe) : avance
 *        +8 points a 50 % de 400 observations -> moyenne de r +3,7 %,
 *        instrument JAMAIS valide, aucun verdict ; la meme a 10 % de 2 000 ->
 *        valide, « beats », « sharper ». L'instrument etait aveugle
 *        exactement quand la maison se fait battre par un gros parieur ; et
 *        le sceptique mesurait deja 28,1 % d'echecs pour une foule SANS
 *        talent a n = 100 (EXPLOITATION 8.8octies) ;
 *      - la marge recalculee est la cote vendue elle-meme : la vente habille
 *        deja le vecteur pm par cotes.habilleUnMarche, la recote refaisait le
 *        meme calcul sur le meme pm et le meme choix (l'essai tenait
 *        l'identite jambe par jambe). Toujours 0, sauf apres un changement de
 *        marge dans cotes.js, ou toute l'histoire tombait en fausse panne.
 *     Le controle exact compare deux enregistrements du MEME prix au MEME
 *     instant (le carnet a la vente, le journal a la releve) : le choix des
 *     parieurs ne le touche pas, et il tombe pour les vraies raisons (mauvais
 *     evenement, orientation, index corrompu, source melangee). La moyenne
 *     de r reste rapportee (diagnostic), jamais comme porte.
 *  2. Verdict d'une adresse : 40 rencontres distinctes AVEC mouvement
 *     (PROVISOIRE : a remesurer apres deux semaines de journal), porte 1
 *     franchie, Bonferroni sur le nombre d'adresses jugees. « Sharper » se
 *     juge contre la foule de la categorie SANS l'adresse jugee (relecture du
 *     10/10 : avec elle, l'ecart mesure vaut (1 - s) x l'ecart vrai, et une
 *     adresse seule dans sa categorie n'avait jamais d'ecart) ; une categorie
 *     dont la foule, sans elle, a moins de 40 jambes ne se compare pas.
 *  3. Action a PROPOSER (jamais codee) : « beats » (borne basse corrigee de la
 *     CLV > 0) ET valeur concedee (somme mise x CLV) > 0.
 *  4. Releve T-10 a PROPOSER (jamais codee, ~536 credits par mois au plus) :
 *     voir PORTE4.
 *
 * ---- limites ----
 *
 * - Le football au prix du marche seulement, 1-N-2 et double chance : les
 *   derives (btts, ou25, score, hand) demandent la proba du modele, que
 *   cotes.js n'expose pas ; les sports a l'Elo n'ont pas de marche.
 * - « tc <= tv » : un pari pose apres la derniere releve d'avant-match a pour
 *   cloture le prix vendu lui-meme. Simulation du sceptique (minuteries de
 *   paris_import) : 82,6 % des jambes posees dans la derniere heure, 57,4 %
 *   dans les 2 dernieres, 38,2 % dans les 3 dernieres. Elles sont EXCLUES du
 *   compte et rapportees en nombre ET en part de mise (porte 4).
 * - Un marche retire par ABSENCE d'une reponse (prix_marche.note, rencontre a
 *   venir absente) n'ecrit aucune ligne au journal : sa cloture reste le
 *   dernier prix vu, sans la mention « retiree ».
 * - La porte 4 compare la derive au 90e centile (max des trois issues, donc
 *   souvent l'outsider) a la plus petite marge par issue (celle du favori) :
 *   deux grandeurs de nature differente (relecture du 10/10). Elle n'est
 *   qu'une PROPOSITION, jamais codee ; a rechiffrer issue par issue (derive
 *   de l'issue contre la marge de cette issue) apres deux semaines d'index.
 * - L'orientation se verifie sur le carnet (equipes du fournisseur) quand il
 *   garde la rencontre ; sinon la jambe porte ori = 0 (non verifiee, comptee).
 * - La cloture se lit sur la MEME source que la vente (betfair, pinnacle ou
 *   mediane : les trois prix que chaque observation garde) ; si la releve de
 *   cloture ne l'a plus, la jambe est 'refChangee', comptee A PART : un saut
 *   de source n'est pas un mouvement du marche (relecture du 10/10).
 * - Une jambe vendue a moins de 5 min du coup d'envoi a un prix que l'index ne
 *   peut pas garder (prix_journal.AVANT_CLOTURE_MS) : sa cloture est son prix
 *   vendu (sans mouvement), ce n'est PAS une panne de l'instrument.
 */
const { AVANT_CLOTURE_MS } = require('./prix_journal');
const MINUTE = 60000, HEURE = 3600000, JOUR = 86400000;

/* ---- LES SEUILS : DES CONSTANTES, PAS DES VARIABLES ----
 * Les changer passe par une nouvelle mesure et un commit (en-tete). */
/* 40 rencontres distinctes AVEC mouvement par adresse, PROVISOIRE : demi-IC95
   de r a n = 40, 2,86 points sur une jambe au hasard (proxy a 3 jours) ; a
   remesurer sur le journal apres deux semaines (derive de r selon l'age). */
const SEUIL_RENCONTRES = 40;
/* Porte 1(b) : a n = 100, demi-IC95 de r ~1,81 point (proxy). */
const POP_MIN = 100;
/* Porte 1(a) : deux semaines de collecte, deux week-ends de championnat. */
const JOURS_MIN = 14;
/* Porte 1(c) : en dessous, c'est une panne (index, orientation, journal coupe). */
const COUVERTURE_MIN = 0.90;
/* Porte 1(d), le CONTROLE EXACT (voir l'en-tete : il remplace « |moyenne de
   r| <= 1 point » et la marge recalculee, 10/10). Sans bruit : dans un
   instrument sain, le vecteur vendu et celui de l'index a la meme date sont
   le meme arrondi du meme calcul (prix_marche.note -> carnet et journal), et
   tout ecart est une faute. 60 jambes controlees : une faute qui touche 5 %
   des jambes y laisse au moins une trace 95 fois sur 100 (0,95^60 = 4,6 %).
   99 % : une faute isolee dans toute l'histoire ne ferme pas la porte pour
   toujours (a 60 jambes, aucune n'est admise ; a 100, une). Decisions de ce
   lot, ecrites avant le premier jour de collecte. */
const CONTROLE_N_MIN = 60;
const CONTROLE_MIN = 0.99;
/* deux arrondis a 1e-5 du meme nombre sont egaux ; la moitie du pas suffit */
const CONTROLE_TOL = 5e-6;
/* Un coup d'envoi deplace de plus de 3 h n'a plus de cloture comparable. */
const DEPLACEE_MS = 3 * HEURE;
const ALPHA = 0.05;
const Z95 = 1.959963984540054;
/* ---- PORTE 4 (releve T-10 a PROPOSER, jamais codee) ----
 * Plan corrige : la part de MISE des jambes sans mouvement, sur au moins 100
 * rencontres pariees, et la derive entre les deux dernieres releves
 * d'avant-match (index du journal) — et non la part des clotures de plus de
 * 90 min, que la minuterie produit d'elle-meme (25,3 % simules).
 * Seuils : DECISIONS de ce lot, pas des mesures (le plan corrige n'en donne
 * pas) — un quart de l'argent hors de vue ; et une derive relative au 90e
 * centile au moins egale a la plus petite marge par issue que nous vendons
 * (cotes.MARGE_ISSUE_MIN = 6 %, verifie par l'essai) : en dessous, un prix qui
 * bouge entre deux releves ne peut pas battre notre marge. */
const PORTE4 = { RENCONTRES_MIN: 100, PART_MISE_MIN: 0.25, DERIVE_P90_MIN: 0.06 };
const MARCHES_MESURES = ['1n2', 'dc'];
const ISSUES = ['1', 'N', '2'];
/* La source du prix vendu, en lettre de l'index (prix_journal.REF_COURTE), et
   la colonne de l'observation qui garde le prix de cette source seule :
   [t, q, ref, pv, b, p, md, ...] (prix_journal.ligneDe). */
const LETTRE = { betfair: 'b', pinnacle: 'p', mediane: 'm' };
const COLONNE = { b: 4, p: 5, m: 6 };
const ISSUES_DC = { '1X': ['1', 'N'], 12: ['1', '2'], X2: ['N', '2'] };
const CATEGORIES = ['fav', 'nul', 'out', 'dcFav', 'dcOut', 'dc12'];
const LIMITES = 'Football at market price only, match result and double chance: other markets need our model\'s own probability, and sports still priced by our rating model have no market price.';

/** La collecte tourne sauf PARIS_CLV=0 (retour arriere). Lu a chaque appel. */
function actif() { return String(process.env.PARIS_CLV === undefined ? '' : process.env.PARIS_CLV).trim() !== '0'; }

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const p01 = (x) => { const v = Number(x); return v > 0 && v < 1 ? v : null; };

/** Le vecteur {1,N,2} du marche, arrondi a 1e-5, ou null s'il n'est pas sain. */
function vecteur(p) {
  if (!p || typeof p !== 'object') return null;
  const v = {};
  for (const i of ISSUES) { const x = p01(p[i]); if (x === null) return null; v[i] = r5(x); }
  return v;
}
/**
 * La proba sans marge de l'issue choisie : 1-N-2 -> p[choix] ; double chance
 * -> la somme de ses deux issues (la formule de cotes.marchesDuMarche, verifiee
 * par l'essai sur ses cotes, pas recopiee de son texte) ; sinon null.
 */
function probaIssue(marche, choix, p) {
  if (!p || typeof p !== 'object') return null;
  const m = String(marche || '1n2'), c = String(choix);
  if (m === '1n2') return ISSUES.indexOf(c) >= 0 ? p01(p[c]) : null;
  if (m === 'dc') {
    const d = Object.prototype.hasOwnProperty.call(ISSUES_DC, c) ? ISSUES_DC[c] : null;
    if (!d) return null;
    const a = p01(p[d[0]]), b = p01(p[d[1]]);
    return a !== null && b !== null && a + b < 1 ? a + b : null;
  }
  return null;
}
/** La categorie d'issue, sur le vecteur du marche A LA VENTE. A egalite, le
    domicile est le favori (une convention, sans effet sur la moyenne). */
function categorie(marche, choix, pm) {
  const v = Array.isArray(pm) ? { 1: pm[0], N: pm[1], 2: pm[2] } : pm;
  if (!v) return null;
  const fav = Number(v[1]) >= Number(v[2]) ? '1' : '2';
  const m = String(marche || '1n2'), c = String(choix);
  if (m === '1n2') return c === 'N' ? 'nul' : (c === fav ? 'fav' : (c === '1' || c === '2' ? 'out' : null));
  if (m === 'dc') return c === '12' ? 'dc12' : (c === (fav === '1' ? '1X' : 'X2') ? 'dcFav' : (c === '1X' || c === 'X2' ? 'dcOut' : null));
  return null;
}

/**
 * A LA VENTE : ce que la jambe garde du prix dont sa cote descend.
 *   ev  l'evenement du fournisseur (source.evenement) ;
 *   pv  la proba sans marge de l'issue choisie, ou null (marche derive, prix
 *       illisible) ; tv la date du prix (celle du carnet, ms) ; ref sa source ;
 *   pm  le vecteur [1, N, 2] du marche (marches mesures seulement) : le
 *       controle exact (porte 1(d)) le compare a l'index a la date tv ; la
 *       categorie d'issue se lit sur lui.
 * null si la collecte est coupee ou si la rencontre n'est pas au prix du
 * marche. Ne leve JAMAIS : la vente ne depend pas de la collecte.
 */
function aLaVente(m, marche, choix) {
  try {
    if (!actif() || !m || !m.prixMarche || typeof m.prixMarche !== 'object' || !m.source || !m.source.evenement) return null;
    const mk = String(marche || '1n2');
    const pm = MARCHES_MESURES.indexOf(mk) >= 0 ? vecteur(m.prixMarche.p) : null;
    const pv = pm ? probaIssue(mk, choix, pm) : null;
    const tv = Date.parse(m.prixMarche.t);
    return { ev: String(m.source.evenement), pv: pv === null ? null : r5(pv), tv: isFinite(tv) ? tv : null,
             ref: String(m.prixMarche.ref || ''), pm: pm && pv !== null ? [pm[1], pm.N, pm[2]] : null };
  } catch (e) { return null; }
}

/* Une observation de l'index : [t, q, ref, pv[3], ...] avec un prix sain. */
function obsValide(o) {
  return Array.isArray(o) && Number.isFinite(o[0]) && typeof o[2] === 'string' && o[2] !== 'x'
    && Array.isArray(o[3]) && o[3].length === 3 && o[3].every((x) => p01(x) !== null);
}
const vecteurSain = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => p01(x) !== null);
/* Le vecteur de la source `l` dans l'observation `o` : la reference vendue
   (o[3]) si c'etait elle, sinon la colonne de cette source seule ; null si la
   releve ne l'avait pas. */
function vecteurDe(o, l) {
  if (!l) return null;
  if (o[2] === l) return o[3];
  const v = COLONNE[l] ? o[COLONNE[l]] : null;
  return vecteurSain(v) ? v : null;
}
/**
 * LE CONTROLE EXACT (porte 1(d)) : l'observation de l'index prise a la
 * MILLISECONDE du prix vendu (tv = la date du carnet = celle de la ligne du
 * journal, prix_marche.note), s'il la garde encore (derniere ou
 * avant-derniere). 1 si la source et le vecteur [1, N, 2] sont ceux de la
 * vente, 0 sinon, undefined si l'index n'a plus cette releve. Ni la cote, ni
 * le choix du parieur n'y entrent.
 */
function controle(c, rec) {
  if (!c || !Number.isFinite(c.tv) || !Array.isArray(c.pm) || !rec) return undefined;
  for (const o of [rec.d, rec.a]) {
    if (!Array.isArray(o) || o[0] !== c.tv) continue;
    return obsValide(o) && o[2] === LETTRE[c.ref] && [0, 1, 2].every((i) => Math.abs(o[3][i] - Number(c.pm[i])) < CONTROLE_TOL) ? 1 : 0;
  }
  return undefined;
}

/**
 * AU REGLEMENT : la cloture figee sur la jambe. `rec` = l'entree de l'index de
 * cloture (prix_journal) pour j.clv.ev ; `regle` = parisRegles[match] ;
 * `equipes` = { dom, ext } du carnet s'il garde la rencontre, sinon null.
 * Rend { pc, tc, refc, sans, ori, ctl? } ; sans, dans cet ordre :
 *   'rembourse'     match rembourse ;
 *   'absente'       aucune cloture (index purge, journal coupe, panne) ;
 *   'orientation'   le fournisseur a inverse domicile et exterieur : la
 *                   cloture n'est pas rangee comme la vente ;
 *   'reportee'      coup d'envoi deplace de plus de 3 h : pas comparable ;
 *   'retiree'       la derniere observation est un retrait : pc = le dernier
 *                   prix valide avant lui (l'avant-derniere), compte A PART ;
 *   'deplacee'      coup d'envoi deplace de moins de 3 h : pc garde, A PART ;
 *   'sansMouvement' tc <= tv : la cloture EST le prix vendu (tc < tv : panne,
 *                   l'index a manque la releve de vente — sauf vente a moins
 *                   de 5 min du coup d'envoi, que l'index ne garde pas) ;
 *   'refChangee'    la releve de cloture n'a plus la source de la vente : pc
 *                   lu sur sa reference a elle (refc), compte A PART ;
 *   null            mesuree.
 * pc se lit sur la MEME source que la vente (refc = c.ref en lettre) ; ctl,
 * le controle exact, quand l'index garde la releve de vente.
 */
function figeJambe(j, rec, regle, equipes) {
  const out = { pc: null, tc: null, refc: null, sans: null };
  const c = (j && j.clv) || {};
  if (regle && regle.rembourse) { out.sans = 'rembourse'; return out; }
  if (!rec || typeof rec !== 'object' || (!Array.isArray(rec.d))) { out.sans = 'absente'; return out; }
  if (equipes && (String(equipes.dom) !== String(j.domicile) || String(equipes.ext) !== String(j.exterieur))) {
    out.sans = 'orientation'; return out;
  }
  const ecart = Math.abs(Number(rec.debut) - Number(j.debut));
  if (!(ecart <= DEPLACEE_MS)) { out.sans = 'reportee'; return out; }
  let o = rec.d, retiree = false;
  if (!obsValide(o)) { retiree = true; o = obsValide(rec.a) ? rec.a : null; }
  if (!o) { out.sans = retiree ? 'retiree' : 'absente'; return out; }
  const l = LETTRE[c.ref];
  let v = vecteurDe(o, l), refChangee = false;
  if (!v) { v = o[3]; refChangee = true; }
  const pc = probaIssue(j.marche || '1n2', j.choix, { 1: v[0], N: v[1], 2: v[2] });
  if (pc === null) { out.sans = 'absente'; return out; }
  out.pc = r5(pc); out.tc = o[0]; out.refc = refChangee ? o[2] : l;
  const bouge = Number.isFinite(c.tv) && o[0] > c.tv;
  out.sans = retiree ? 'retiree' : ecart > 0 ? 'deplacee' : !bouge ? 'sansMouvement' : refChangee ? 'refChangee' : null;
  out.ori = equipes ? 1 : 0;
  const k = controle(c, rec);
  if (k !== undefined) out.ctl = k;
  return out;
}

// ------------------------------------------------------------ statistique

/* Quantile de la loi normale (Acklam, 2003 ; erreur relative < 1,15e-9 ;
   verifie par l'essai contre une integration de Simpson). */
function quantileNormal(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  if (!(p > 0 && p < 1)) return NaN;
  const bas = 0.02425;
  const queue = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < bas) return queue(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - bas) return -queue(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** Le z d'un IC bilatere a 95 % corrige de Bonferroni pour k adresses jugees. */
function zBonferroni(k) { return k > 1 ? quantileNormal(1 - ALPHA / (2 * k)) : Z95; }

const somme = (a) => a.reduce((t, x) => t + x, 0);
const moyenne = (a) => (a.length ? somme(a) / a.length : null);
function variance(a) {
  if (a.length < 2) return null;
  const m = moyenne(a);
  return a.reduce((t, x) => t + (x - m) * (x - m), 0) / (a.length - 1);
}
function quantile(a, q) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const r4 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
/* moyenne, erreur type et IC95 d'une liste ; null sous 2 valeurs */
function resume(a) {
  const n = a.length, m = moyenne(a), v = variance(a);
  if (v === null) return { n, moyenne: m, se: null, ic95: null };
  const se = Math.sqrt(v / n);
  return { n, moyenne: m, se, ic95: [m - Z95 * se, m + Z95 * se] };
}

/* ---- LA MARGE RECALCULEE PAR COTES.JS : RETIREE (10/10, relecture du lot) ----
 * Elle servait la seconde moitie de l'ancienne porte 1(d). La cote vendue est
 * deja cotes.habilleUnMarche du vecteur pm ; la refaire sur le meme pm et le
 * meme choix redonnait la meme cote (l'essai tenait l'identite jambe par
 * jambe) : un controle qui ne pouvait tomber qu'a tort, apres un changement de
 * marge dans cotes.js. Remplacee par le controle exact (`controle`). La marge
 * reellement vendue (evVente = cote x pv - 1) reste rapportee. */

/* L'index de cloture, decrit pour la sante de la releve (toutes les
   rencontres commencees qu'il garde, 7 jours ; championnats observes exclus) :
   age de la cloture au coup d'envoi, et derive entre les deux dernieres
   releves d'avant-match (max sur les trois issues de |d/a - 1|). */
function decritIndex(index, now) {
  const ages = [], derives = [], ecarts = [];
  const ev = index && index.ev && typeof index.ev === 'object' ? index.ev : {};
  for (const x of Object.values(ev)) {
    if (!x || x.o || !(Number(x.debut) <= now) || !obsValide(x.d)) continue;
    ages.push((Number(x.debut) - x.d[0]) / MINUTE);
    if (obsValide(x.a)) {
      derives.push(Math.max(...[0, 1, 2].map((i) => Math.abs(x.d[3][i] / x.a[3][i] - 1))));
      ecarts.push((x.d[0] - x.a[0]) / MINUTE);
    }
  }
  return { rencontres: ages.length, ageMedianMin: r1(quantile(ages, 0.5)), ageP90Min: r1(quantile(ages, 0.9)),
           derive: { rencontres: derives.length, mediane: r4(quantile(derives, 0.5)), p90: r4(quantile(derives, 0.9)),
                     ecartMedianMin: r1(quantile(ecarts, 0.5)) } };
}

const pct = (x) => (x === null || !Number.isFinite(x) ? '?' : (Math.round(x * 1000) / 10) + '%');
/* Les jambes mesurees mais comptees A PART (jamais dans n ni les verdicts). */
const A_PART = ['retiree', 'deplacee', 'refChangee'];
/* somme, somme des carres et nombre de r, par categorie d'issue */
function sommesParCat(ms) {
  const t = {};
  for (const m of ms) { const b = t[m.cat] || (t[m.cat] = { n: 0, s: 0, q: 0 }); b.n++; b.s += m.r; b.q += m.r * m.r; }
  return t;
}

/**
 * LE BILAN — la structure de GET /paris/clv. Ne decide rien, n'ecrit rien.
 * opt : { now, addr, index (l'index de cloture lu, ou null), nom(addr) }.
 */
function bilan(paris, regles, opt) {
  const o = opt || {};
  const now = Number(o.now) || Date.now();
  const R = regles || {};
  const nomDe = typeof o.nom === 'function' ? o.nom : () => null;
  const voulue = o.addr ? String(o.addr).toLowerCase() : null;
  const liste = Array.isArray(paris) ? paris : [];

  /* la premiere jambe collectee : le jour 0 de la porte 1(a) */
  let depuis = null;
  for (const p of liste) for (const j of (p && p.jambes) || []) {
    if (j && j.clv && Number.isFinite(p.t) && (depuis === null || p.t < depuis)) depuis = p.t;
  }

  const hors = { marche: { btts: 0, ou25: 0, score: 0, hand: 0 }, prixIllisible: 0, elo: 0, avantMesure: 0, enAttente: 0, rembourse: 0,
                 nonFigee: 0, absente: 0, orientation: 0, reportee: 0, retireeSansPrix: 0 };
  const aPartVide = () => ({ jambes: 0, mise: 0, clv: [] });
  const aPartNeuf = () => ({ retiree: aPartVide(), deplacee: aPartVide(), refChangee: aPartVide() });
  const pop = { eligibles: 0, couvertes: 0, pannes: 0, venteApresCloture: 0, orientationNonVerifiee: 0,
                controle: { jambes: 0, conformes: 0 },
                sansMouvement: { jambes: 0, mise: 0 }, miseAvecCloture: 0, aPart: aPartNeuf(), ev: [], ageVente: [] };
  const rencontresPariees = new Set();
  const adresses = new Map();
  const acc = (a) => {
    if (!adresses.has(a)) adresses.set(a, { jambesBrutes: 0, mesurees: [], sansMouvement: { jambes: 0, mise: 0 },
      miseAvecCloture: 0, aPart: aPartNeuf(), ageVente: [], ev: [] });
    return adresses.get(a);
  };
  const mesurees = [];
  const detail = [];

  for (const p of liste) {
    if (!p || !Array.isArray(p.jambes)) continue;
    const addr = String(p.addr || '').toLowerCase();
    const mise = Number(p.mise) || 0;
    const rembourseTicket = !!p.regle && p.gagne === null;
    for (const j of p.jambes) {
      if (!j) continue;
      const c = j.clv;
      if (!c) { if (depuis !== null && p.t >= depuis) hors.elo++; else hors.avantMesure++; continue; }
      const A = acc(addr);
      A.jambesBrutes++;
      const marche = String(j.marche || '1n2');
      const cote = Number(j.cote);
      const ligne = voulue === addr ? { pari: p.id, t: p.t, match: j.match, affiche: (j.domicile || '?') + ' v ' + (j.exterieur || '?'),
        marche, choix: j.choix, cote, mise, pv: c.pv, pc: 'pc' in c ? c.pc : null, sans: 'pc' in c ? c.sans : 'enAttente',
        clv: null, r: null, ref: c.ref, refc: c.refc || null, ctl: c.ctl === 0 || c.ctl === 1 ? c.ctl : null,
        ageVenteMin: Number.isFinite(c.tv) ? r1((p.t - c.tv) / MINUTE) : null,
        ageClotureMin: Number.isFinite(c.tc) ? r1((Number(j.debut) - c.tc) / MINUTE) : null } : null;
      if (ligne) detail.push(ligne);
      if (Number.isFinite(c.tv) && Number.isFinite(p.t)) { pop.ageVente.push((p.t - c.tv) / MINUTE); A.ageVente.push((p.t - c.tv) / MINUTE); }
      if (c.pv === null || c.pv === undefined) {
        if (MARCHES_MESURES.indexOf(marche) >= 0) hors.prixIllisible++; else hors.marche[marche] = (hors.marche[marche] || 0) + 1;
        if (ligne) ligne.sans = 'nonMesure';
        continue;
      }
      const regle = R[j.match];
      if (rembourseTicket || (regle && regle.rembourse)) { hors.rembourse++; if (ligne) ligne.sans = 'rembourse'; continue; }
      if (!regle) { hors.enAttente++; continue; }
      pop.eligibles++;
      /* la marge reellement vendue, rapportee (plus une porte : voir plus haut) */
      if (isFinite(cote)) { pop.ev.push(cote * c.pv - 1); A.ev.push(cote * c.pv - 1); }
      if (!('pc' in c)) { hors.nonFigee++; continue; }
      if (c.ctl === 0 || c.ctl === 1) { pop.controle.jambes++; pop.controle.conformes += c.ctl; }
      const s = c.sans || null;
      if (s === 'absente' || s === 'orientation' || s === 'reportee' || s === 'rembourse') { hors[s]++; continue; }
      if (c.pc === null || c.pc === undefined) { if (s === 'retiree') hors.retireeSansPrix++; else hors.absente++; continue; }
      const vclv = cote * c.pc - 1;
      if (ligne) { ligne.clv = r4(vclv); ligne.r = r4(c.pc / c.pv - 1); }
      if (c.ori === 0) pop.orientationNonVerifiee++;
      if (A_PART.indexOf(s) >= 0) {
        pop.couvertes++;
        for (const x of [pop.aPart[s], A.aPart[s]]) { x.jambes++; x.mise += mise; x.clv.push(vclv); }
        continue;
      }
      /* tc < tv : l'index a manque la releve de vente (une PANNE), sauf si la
         vente tombe a moins de 5 min du coup d'envoi, ou l'index ne garde rien
         par construction (prix_journal.AVANT_CLOTURE_MS) : sa cloture est son
         prix vendu, l'instrument n'a rien rate (relecture du 10/10). */
      if (Number.isFinite(c.tc) && Number.isFinite(c.tv) && c.tc < c.tv) {
        if (Number(j.debut) - c.tv <= AVANT_CLOTURE_MS) { pop.venteApresCloture++; pop.couvertes++; } else pop.pannes++;
      } else pop.couvertes++;
      rencontresPariees.add(String(c.ev));
      pop.miseAvecCloture += mise; A.miseAvecCloture += mise;
      if (s === 'sansMouvement' || !(Number.isFinite(c.tv) && c.tc > c.tv)) {
        pop.sansMouvement.jambes++; pop.sansMouvement.mise += mise;
        A.sansMouvement.jambes++; A.sansMouvement.mise += mise;
        continue;
      }
      const m = { addr, ev: String(c.ev), mise, clv: vclv, r: c.pc / c.pv - 1, derive: c.pc - c.pv,
                  cat: categorie(marche, j.choix, c.pm) || 'autre' };
      mesurees.push(m); A.mesurees.push(m);
    }
  }

  /* ---- la foule, par categorie d'issue (voir l'en-tete) ---- */
  const parCat = sommesParCat(mesurees);

  /* ---- les observations : une adresse x une rencontre ---- */
  const observationsDe = (ms) => {
    const g = new Map();
    for (const m of ms) {
      const k = m.addr + '\u0000' + m.ev;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(m);
    }
    return [...g.values()].map((l) => ({ clv: moyenne(l.map((x) => x.clv)), r: moyenne(l.map((x) => x.r)),
      derive: moyenne(l.map((x) => x.derive)) }));
  };
  const obsPop = observationsDe(mesurees);
  const nPop = obsPop.length;
  const popClv = resume(obsPop.map((x) => x.clv)), popR = resume(obsPop.map((x) => x.r));

  /* ---- porte 1 : l'instrument ---- */
  const raisons = [];
  const jours = depuis === null ? 0 : (now - depuis) / JOUR;
  if (!(jours >= JOURS_MIN)) raisons.push({ cle: 'jours', texte: 'Collecting for ' + (Math.floor(jours * 10) / 10) + ' day(s); ' + JOURS_MIN + ' needed.' });
  if (!(nPop >= POP_MIN)) raisons.push({ cle: 'observations', texte: nPop + ' fixture observation(s) with a price move; ' + POP_MIN + ' needed.' });
  const couverture = pop.eligibles ? pop.couvertes / pop.eligibles : null;
  if (!(couverture >= COUVERTURE_MIN)) raisons.push({ cle: 'couverture', texte: 'Closing price found for ' + pct(couverture) + ' of ' + pop.eligibles + ' settled leg(s); ' + pct(COUVERTURE_MIN) + ' needed.' });
  const ctl = pop.controle;
  const tauxCtl = ctl.jambes ? ctl.conformes / ctl.jambes : null;
  if (!(ctl.jambes >= CONTROLE_N_MIN)) {
    raisons.push({ cle: 'controle', texte: ctl.jambes + ' leg(s) could be checked against the price index at the moment of sale; ' + CONTROLE_N_MIN + ' needed.' });
  } else if (!(tauxCtl >= CONTROLE_MIN)) {
    raisons.push({ cle: 'ecart', texte: (ctl.jambes - ctl.conformes) + ' of ' + ctl.jambes + ' checked leg(s) were sold at a price the index recorded differently at the same moment (' + pct(1 - tauxCtl) + '); at most ' + pct(1 - CONTROLE_MIN) + ' allowed — check the instrument first.' });
  }
  const valide = raisons.length === 0;

  /* ---- « sharper » : contre la foule de la categorie SANS l'adresse ----
   * Relecture du 10/10 : la moyenne de categorie contenait l'adresse jugee,
   * l'ecart mesure valait (1 - s) x l'ecart vrai (s = sa part de la
   * categorie), et une adresse seule dans sa categorie n'avait aucun ecart.
   * La foule de chaque categorie est donc recalculee sans elle (moyenne ET
   * variance), et une categorie dont la foule, sans elle, a moins de
   * SEUIL_RENCONTRES jambes ne se compare pas (aucun chiffre sous 40). */
  const talentDe = (A) => {
    const propre = sommesParCat(A.mesurees), foule = {};
    for (const [k, b] of Object.entries(propre)) {
      const t = parCat[k], nf = t.n - b.n;
      if (!(nf >= SEUIL_RENCONTRES)) continue;
      const moy = (t.s - b.s) / nf;
      foule[k] = { n: nf, moyenne: moy, variance: Math.max(0, (t.q - b.q - nf * moy * moy) / (nf - 1)) };
    }
    const g = new Map(), parK = {};
    let nComp = 0;
    for (const m of A.mesurees) {
      const f = foule[m.cat];
      if (!f) continue;
      nComp++; parK[m.cat] = (parK[m.cat] || 0) + 1;
      if (!g.has(m.ev)) g.set(m.ev, []);
      g.get(m.ev).push(m.r - f.moyenne);
    }
    /* l'erreur type de l'ecart a la foule : la sienne, plus celle de la
       moyenne de chaque categorie qu'il joue (mesure du 10/10 : sans elle,
       2,7 a 4,7 % de « sharper » a tort a z = 1,96 sur une foule de 300) */
    let vb = 0;
    for (const [k, q] of Object.entries(parK)) { const w = q / nComp; vb += w * w * foule[k].variance / foule[k].n; }
    return { rx: [...g.values()].map(moyenne), vb };
  };

  /* ---- les adresses ---- */
  const lignes = [];
  for (const [addr, A] of adresses) {
    const obs = observationsDe(A.mesurees);
    const n = obs.length;
    const cl = resume(obs.map((x) => x.clv));
    lignes.push({ addr, A, obs, n, cl });
  }
  const jugees = valide ? lignes.filter((l) => l.n >= SEUIL_RENCONTRES).length : 0;
  const zk = zBonferroni(jugees);
  const sortieAdresses = lignes.map(({ addr, A, obs, n, cl }) => {
    const sm = A.sansMouvement, tot = A.miseAvecCloture;
    const l = { addr, nom: nomDe(addr) || null, jambesBrutes: A.jambesBrutes, rencontres: n,
                manque: Math.max(0, SEUIL_RENCONTRES - n),
                /* sa part des observations de la foule : un gros parieur pese
                   sur toute moyenne de population (relecture du 10/10) */
                partFoule: nPop ? r4(n / nPop) : null,
                /* la demi-largeur se montre des 2 rencontres : elle dit de combien on est loin de conclure */
                demiLargeur: cl.se === null ? null : r4(Z95 * cl.se),
                sansMouvement: { jambes: sm.jambes, mise: Math.round(sm.mise), partMise: tot ? r4(sm.mise / tot) : null },
                aPart: Object.fromEntries(A_PART.map((k) => [k, { jambes: A.aPart[k].jambes, mise: Math.round(A.aPart[k].mise) }])),
                ageVenteMedianMin: r1(quantile(A.ageVente, 0.5)),
                moyenne: null, ic95: null, moyenneR: null, ic95R: null, clvPonderee: null, valeurConcedee: null,
                evVente: null, derive: null, ecartFoule: null, rencontresComparees: null, verdict: null };
    if (valide && n >= SEUIL_RENCONTRES) {
      const rr = resume(obs.map((x) => x.r));
      const { rx, vb } = talentDe(A);
      let talent = null, mrx = null;
      if (rx.length >= SEUIL_RENCONTRES) {
        mrx = moyenne(rx);
        const se = Math.sqrt((variance(rx) || 0) / rx.length + vb);
        talent = mrx - zk * se > 0 ? 'sharper' : 'inline';
      }
      const miseM = somme(A.mesurees.map((x) => x.mise));
      const conc = somme(A.mesurees.map((x) => x.mise * x.clv));
      const argent = cl.moyenne - zk * cl.se > 0 ? 'beats' : null;
      Object.assign(l, { moyenne: r4(cl.moyenne), ic95: cl.ic95.map(r4), moyenneR: r4(rr.moyenne), ic95R: rr.ic95.map(r4),
                         ecartFoule: r4(mrx), rencontresComparees: rx.length,
                         clvPonderee: miseM ? r4(conc / miseM) : null, valeurConcedee: Math.round(conc),
                         evVente: r4(moyenne(A.ev)), derive: r4(moyenne(obs.map((x) => x.derive))),
                         verdict: { argent, talent, aProposer: argent === 'beats' && conc > 0 } });
    }
    return l;
  }).sort((x, y) => y.rencontres - x.rencontres || y.jambesBrutes - x.jambesBrutes);

  /* ---- la population ---- */
  const montre = nPop >= POP_MIN;
  const partSM = pop.miseAvecCloture ? pop.sansMouvement.mise / pop.miseAvecCloture : null;
  const idx = o.index ? decritIndex(o.index, now) : null;
  const porte4Manque = [];
  if (!(jours >= JOURS_MIN)) porte4Manque.push('days');
  if (!(rencontresPariees.size >= PORTE4.RENCONTRES_MIN)) porte4Manque.push('fixtures');
  if (!(partSM >= PORTE4.PART_MISE_MIN)) porte4Manque.push('stake without move');
  if (!(idx && idx.derive.p90 >= PORTE4.DERIVE_P90_MIN)) porte4Manque.push('price drift');
  const aPartSortie = (x) => ({ jambes: x.jambes, mise: Math.round(x.mise), moyenneClv: x.jambes >= SEUIL_RENCONTRES ? r4(moyenne(x.clv)) : null });

  const sortie = {
    actif: actif(), seuil: SEUIL_RENCONTRES, seuilProvisoire: true, t: now,
    instrument: { valide, raisons, depuis, jours: r1(jours), observations: nPop, eligibles: pop.eligibles,
                  couvertes: pop.couvertes, couverture: r4(couverture), pannes: pop.pannes, venteApresCloture: pop.venteApresCloture,
                  orientationNonVerifiee: pop.orientationNonVerifiee,
                  controle: { jambes: ctl.jambes, conformes: ctl.conformes, taux: ctl.jambes >= CONTROLE_N_MIN ? r4(tauxCtl) : null },
                  /* diagnostics, plus des portes : sous 100, aucun chiffre */
                  moyenneR: montre ? r4(popR.moyenne) : null, evVente: pop.ev.length >= POP_MIN ? r4(moyenne(pop.ev)) : null,
                  porte: { JOURS_MIN, POP_MIN, COUVERTURE_MIN, CONTROLE_N_MIN, CONTROLE_MIN } },
    population: { observations: nPop, rencontres: new Set(mesurees.map((m) => m.ev)).size, adresses: adresses.size,
                  moyenne: montre ? r4(popClv.moyenne) : null, ic95: montre && popClv.ic95 ? popClv.ic95.map(r4) : null,
                  moyenneR: montre ? r4(popR.moyenne) : null, ic95R: montre && popR.ic95 ? popR.ic95.map(r4) : null,
                  parCategorie: Object.fromEntries(CATEGORIES.concat(['autre']).filter((k) => parCat[k]).map((k) =>
                    [k, { jambes: parCat[k].n, moyenneR: parCat[k].n >= SEUIL_RENCONTRES ? r4(parCat[k].s / parCat[k].n) : null }])),
                  sansMouvement: { jambes: pop.sansMouvement.jambes, mise: Math.round(pop.sansMouvement.mise), partMise: r4(partSM) },
                  aPart: Object.fromEntries(A_PART.map((k) => [k, aPartSortie(pop.aPart[k])])),
                  ageVenteMedianMin: r1(quantile(pop.ageVente, 0.5)), ageVenteP90Min: r1(quantile(pop.ageVente, 0.9)),
                  manque: Math.max(0, POP_MIN - nPop) },
    comparaisons: { adressesJugees: jugees, z: r4(zk), alpha: ALPHA,
                    /* sans correction, chaque verdict sortirait a tort pour ~2,5 % des adresses jugees */
                    fauxPositifsSansCorrection: r4(jugees * ALPHA / 2), risqueFamille: ALPHA / 2 },
    clotures: idx,
    porte4: { rencontresPariees: rencontresPariees.size, partMiseSansMouvement: r4(partSM),
              deriveP90: idx ? idx.derive.p90 : null, seuils: PORTE4, atteinte: porte4Manque.length === 0, manque: porte4Manque },
    adresses: sortieAdresses,
    horsMesure: hors,
    limites: LIMITES,
  };
  if (voulue) sortie.detail = { addr: voulue, jambes: detail.sort((x, y) => y.t - x.t) };
  return sortie;
}

module.exports = {
  SEUIL_RENCONTRES, POP_MIN, JOURS_MIN, COUVERTURE_MIN, CONTROLE_N_MIN, CONTROLE_MIN, DEPLACEE_MS, ALPHA, Z95, PORTE4,
  MARCHES_MESURES, ISSUES_DC, CATEGORIES, LIMITES, LETTRE, AVANT_CLOTURE_MS,
  actif, vecteur, probaIssue, categorie, aLaVente, obsValide, controle, figeJambe,
  quantileNormal, zBonferroni, resume, decritIndex, bilan,
};
