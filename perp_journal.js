'use strict';
/* ==========================================================================
 * LE JOURNAL BRUT DES PERPETUELS — POUR POUVOIR POSER LES QUESTIONS PLUS TARD
 *
 * ---- POURQUOI IL EXISTE ----
 *
 * La colonie garde des compteurs : combien d ombres jugees, quelle part de
 * gagnantes par regle, quelle esperance par case. C est ce qu il faut pour
 * DECIDER en direct, et c est inutilisable pour COMPRENDRE plus tard — une
 * fois additionne, un chiffre ne repond plus qu a la question qu on avait
 * prevue. « Le financement paie-t-il mieux le mardi ? », « la tendance de
 * fond compte-t-elle plus quand l interet ouvert monte ? » : ces questions
 * n ont pas de reponse dans une somme.
 *
 * Ce fichier ecrit donc la LIGNE BRUTE, une par marche et par tour, avec
 * tout ce qui a ete mesure au moment de la decision — puis, plus tard, ce que
 * cette situation a REELLEMENT donne a quinze minutes, une heure, quatre,
 * douze et vingt-quatre. Le rapprochement des deux est la seule chose qui
 * reponde a « comment gagne-t-on sur la duree ».
 *
 * ---- CE QU IL N EST PAS ----
 *
 * Il ne decide RIEN. Aucune ligne d ici n entre dans une note, un veto ou une
 * mise. C est la meme frontiere que `OBS_VIEUX_PAR_TOUR` dans la colonie de
 * jetons : on rend une chose mesurable AVANT de lui faire acheter quoi que ce
 * soit. Un signal qu on enregistre ne coute rien ; un signal qui decide sans
 * mesure coute de l argent.
 *
 * ---- LE FORMAT, ET POURQUOI PAS UNE VRAIE BASE ----
 *
 * NDJSON, un fichier par jour, sur le volume. Pas de SQLite : ce depot est en
 * JavaScript nu, sans dependance native, et une base qu on ne peut pas ouvrir
 * avec `grep` sur un conteneur Railway est une base qu on n ouvrira pas. Les
 * cles sont courtes parce qu elles sont repetees des millions de fois.
 *
 * ---- LA TAILLE, CALCULEE ET NON ESPEREE ----
 *
 * Cinq marches, un tour toutes les cinq minutes : 288 tours par jour, donc
 * 1 440 lignes d observation quotidiennes. MESURE, pas estimee — l essai la
 * refait a chaque fois sur des lignes completes : **328 octets** par ligne,
 * soit **461 Ko par jour**, ~14 Mo par mois. La retention par defaut est de
 * 180 jours — six mois, de quoi voir une saison — et les fichiers plus vieux
 * sont effaces au premier ecrit du jour. A 180 jours : **81 Mo**.
 *
 * Les lignes de resultat s ajoutent a ca, et elles sont bien moins nombreuses :
 * une ombre par regle, par sens et par marche toutes les quatre heures, fois
 * cinq echeances.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

const ACTIF = String(process.env.PERP_JOURNAL || '1') === '1';
const JOURS_GARDES = Math.max(7, Number(process.env.PERP_JOURNAL_JOURS || 180));

function dossier() {
  const base = process.env.DATA_DIR || path.join(__dirname, '_donnees');
  return path.join(base, 'perp_journal');
}
function jourDe(t) { return new Date(t).toISOString().slice(0, 10); }
function fichier(t) { return path.join(dossier(), jourDe(t) + '.ndjson'); }

/* ---- L IDENTIFIANT D UNE OBSERVATION ----
 * Il relie la ligne de decision a ce qu elle a donne plus tard. Il porte le
 * jour et le tour : lisible a l oeil dans le fichier, et il ne peut pas
 * entrer en collision entre deux marches du meme tour. */
function idObs(t, sym, tour) {
  return jourDe(t).replace(/-/g, '') + '-' + String(tour) + '-' + String(sym).replace(/USDT$/, '');
}

let dernierJourVu = null;
/**
 * Efface les fichiers plus vieux que la retention. Appele au PREMIER ecrit
 * d un jour, jamais a chaque ligne : lister un dossier mille fois par jour
 * pour n y rien trouver est du travail pur.
 */
function purge(t) {
  const j = jourDe(t);
  if (j === dernierJourVu) return 0;
  dernierJourVu = j;
  let n = 0;
  try {
    const limite = new Date(t - JOURS_GARDES * 86400000).toISOString().slice(0, 10);
    for (const f of fs.readdirSync(dossier())) {
      const m = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
      if (m && m[1] < limite) { fs.unlinkSync(path.join(dossier(), f)); n++; }
    }
  } catch (e) { if (e.code !== 'ENOENT') console.error('[perp/journal] purge : ' + e.message); }
  return n;
}

function ecrit(ligne, t) {
  if (!ACTIF) return false;
  try {
    fs.mkdirSync(dossier(), { recursive: true });
    purge(t);
    fs.appendFileSync(fichier(t), JSON.stringify(ligne) + '\n');
    return true;
  } catch (e) {
    /* Un journal qui tombe ne doit JAMAIS arreter la colonie : il observe,
       il ne commande pas. */
    console.error('[perp/journal] ' + (e.message || e));
    return false;
  }
}

/* ---- ARRONDIR, MAIS PAS TROP ----
 * Un prix a quinze decimales gonfle le fichier sans rien apprendre ; un
 * financement arrondi a deux decimales vaut zero pour tout le monde. Chaque
 * champ a donc sa precision, choisie sur son ordre de grandeur. */
const a = (v, n) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * Math.pow(10, n)) / Math.pow(10, n);

/**
 * UNE LIGNE PAR MARCHE ET PAR TOUR : tout ce qui a ete mesure au moment ou la
 * decision a ete prise, plus la decision elle-meme.
 *
 * `x`       les mesures du marche (voir `mesures()` dans ai_perp.js)
 * `sides`   [{sens, score, refus, qui}, …] — les deux sens examines
 * `prise`   le sens retenu, ou null si rien n a ete pris sur ce marche
 */
function noteObservation(o) {
  const x = o.x || {};
  const l = {
    k: 'o', i: o.id, t: o.t, s: x.sym,
    /* le prix et ce qui l entoure */
    p: a(x.prix, 6), ee: a(x.ecartEma, 4), fo: a(x.fond, 4),
    v1: a(x.vol15, 4), v4: a(x.vol4, 4), cl: a(x.couloir, 4),
    h1: a(x.var1h, 4), h4: a(x.var4h, 4), h24: a(x.var24, 3),
    /* ce qui n existe que sur un perpetuel */
    f: a(x.financement, 8), oi: a(x.interet, 2), doi: a(x.varInteret, 4),
    ba: a(x.base, 5), cb: a(x.carnet, 4), vo: a(x.volume, 0),
    /* la decision, les deux sens */
    sc: (o.sides || []).map((v) => a(v.score, 0)),
    rf: (o.sides || []).map((v) => v.refus || null),
    qi: (o.sides || []).map((v) => v.qui || null),
    pr: o.prise === undefined ? null : o.prise,
  };
  return ecrit(l, o.t) ? l : null;
}

/**
 * CE QUE LA SITUATION A DONNE, une ligne par echeance atteinte. C est le
 * rapprochement avec la ligne d observation qui repond a la vraie question :
 * ce qu on a refuse, l aurait-on regrette ?
 */
function noteResultat(o) {
  const l = {
    k: 'r', i: o.id, t: o.t, s: o.sym, sd: o.sens, h: o.horizon,
    r: a(o.rendement, 4), b: a(o.brut, 4), fc: a(o.financement, 4),
    cl: o.cle || null,
  };
  return ecrit(l, o.t) ? l : null;
}

/** Les jours presents, du plus ancien au plus recent. */
function jours() {
  try {
    return fs.readdirSync(dossier())
      .map((f) => /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f))
      .filter(Boolean).map((m) => m[1]).sort();
  } catch (e) { return []; }
}

/**
 * Relit le journal. `depuis` est un jour (AAAA-MM-JJ) ou un nombre de jours
 * en arriere. Rend {obs, res} — les lignes illisibles sont comptees, jamais
 * devinees : un fichier tronque par un redemarrage ne doit pas se lire comme
 * une observation valable.
 */
function relit(depuis, jusqua) {
  const tous = jours();
  const borne = typeof depuis === 'number'
    ? new Date(Date.now() - depuis * 86400000).toISOString().slice(0, 10)
    : (depuis || '0000-00-00');
  const fin = jusqua || '9999-99-99';
  const obs = [], res = [];
  let cassees = 0;
  for (const j of tous) {
    if (j < borne || j > fin) continue;
    let brut = '';
    try { brut = fs.readFileSync(path.join(dossier(), j + '.ndjson'), 'utf8'); } catch (e) { continue; }
    for (const ligne of brut.split('\n')) {
      if (!ligne) continue;
      let v = null;
      try { v = JSON.parse(ligne); } catch (e) { cassees++; continue; }
      if (v.k === 'o') obs.push(v); else if (v.k === 'r') res.push(v);
    }
  }
  return { obs, res, cassees, jours: tous.filter((j) => j >= borne && j <= fin) };
}

/** De quoi dire, sur la page et en ligne de commande, ce que le journal porte. */
function etat() {
  const l = jours();
  let octets = 0;
  for (const j of l) {
    try { octets += fs.statSync(path.join(dossier(), j + '.ndjson')).size; } catch (e) { /* efface entre-temps */ }
  }
  return { actif: ACTIF, jours: l.length, premier: l[0] || null, dernier: l[l.length - 1] || null,
           octets, garde: JOURS_GARDES, dossier: dossier() };
}

module.exports = { noteObservation, noteResultat, relit, jours, etat, idObs, dossier, purge,
                   ACTIF, JOURS_GARDES };
