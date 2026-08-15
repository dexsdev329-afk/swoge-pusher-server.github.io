'use strict';
/*
 * Les paris sportifs — le catalogue, et rien d'autre.
 *
 * ---- ce que ce fichier est, et ce qu'il n'est pas ----
 *
 * Il lit paris_catalogue.json, le valide durement, et repond a « quels matchs
 * sont ouverts » et « ce pari rapporte combien ». Il ne connait aucun solde,
 * ne debite personne et ne garde aucun pari : tout ce qui touche a l'argent
 * vit dans Game, ou il est deja sauvegarde, plafonne et journalise.
 *
 * ---- pourquoi la validation est severe ----
 *
 * Le catalogue est le SEUL endroit du serveur ou une faute de frappe se
 * transforme directement en argent. Une cote a 25 au lieu de 2,5 sur un match
 * ou tout le monde parie, et la maison doit dix fois ce qu'elle croyait. Un
 * fichier qui refuse de se charger arrete le serveur au demarrage, ce qui se
 * voit tout de suite ; une cote absurde acceptee en silence ne se voit qu'au
 * moment de payer.
 *
 * ---- la marge, et pourquoi elle est verifiee ----
 *
 * Sur un 1-N-2, la somme des probabilites implicites (1/cote) vaut plus que 1
 * chez un bookmaker : ce surplus EST son benefice, et donc le notre puisqu'on
 * recopie ses cotes. Un lot sans marge — ou pire, a marge negative — voudrait
 * dire qu'on offre un pari perdant pour la maison a quelqu'un qui sait
 * compter. On le mesure a la lecture, et on refuse en dessous d'un plancher.
 */

const fs = require('fs');
const path = require('path');

/* Les issues, PAR SPORT. Une liste fermee : ce qui traverse le reseau ne peut
   etre que l'une d'elles.
   Le tennis n'a pas de match nul — proposer un « N » a 0 % serait offrir un
   pari qui ne peut jamais passer, et le validateur de marge s'en etranglerait
   a juste titre. */
const ISSUES_PAR_SPORT = { foot: ['1', 'N', '2'], tennis: ['1', '2'], nba: ['1', '2'] };
const ISSUES = ISSUES_PAR_SPORT.foot;
function issues(sport) { return ISSUES_PAR_SPORT[sport] || ISSUES; }

/* Bornes de bon sens sur une cote. En dessous de 1,01 le pari ne rapporte
   rien et ressemble a une erreur ; au-dessus de 100 une mise au plafond
   engage la maison pour dix millions sur une faute de frappe. */
const COTE_MIN = 1.01;
const COTE_MAX = 100;
/* La marge minimale acceptee sur un match. Un lot recopie chez un bookmaker
   tourne autour de 8 a 12 %. En dessous de 2 %, soit on s'est trompe en
   recopiant, soit on offre un pari que la maison n'a aucune raison de tenir. */
const MARGE_MIN = 0.02;

function nombre(x, quoi, id) {
  const v = Number(x);
  if (!isFinite(v)) throw new Error(`paris : ${quoi} invalide sur « ${id} »`);
  return v;
}

/** La marge du bookmaker sur un match, en fraction (0,099 = 9,9 %). */
function marge(cotes, sport) {
  let s = 0;
  for (const i of issues(sport)) s += 1 / cotes[i];
  return s - 1;
}

function valide(brut) {
  if (!brut || !Array.isArray(brut.matchs) || !Array.isArray(brut.sports))
    throw new Error('paris : le catalogue doit porter `sports` et `matchs`');

  const sports = brut.sports.map((s) => {
    if (!s.cle || !s.nom) throw new Error('paris : un sport sans cle ou sans nom');
    return { cle: String(s.cle), nom: String(s.nom), actif: !!s.actif };
  });
  const connus = sports.map((s) => s.cle);

  const vus = new Set();
  const matchs = brut.matchs.map((m) => {
    const id = String(m.id || '');
    if (!/^[a-z0-9-]{4,64}$/.test(id)) throw new Error(`paris : identifiant invalide « ${id} »`);
    /* Un identifiant en double, c'est deux matchs qui partagent leurs paris et
       leur reglement. Ca ne se rattrape pas apres coup. */
    if (vus.has(id)) throw new Error(`paris : identifiant en double « ${id} »`);
    vus.add(id);
    if (connus.indexOf(m.sport) < 0) throw new Error(`paris : sport inconnu sur « ${id} »`);

    const debut = Date.parse(m.debut);
    if (!isFinite(debut)) throw new Error(`paris : date de debut illisible sur « ${id} »`);

    const cotes = {};
    for (const i of issues(m.sport)) {
      const c = nombre(m.cotes && m.cotes[i], `cote « ${i} »`, id);
      if (c < COTE_MIN || c > COTE_MAX)
        throw new Error(`paris : cote « ${i} » hors bornes sur « ${id} » (${c})`);
      cotes[i] = c;
    }
    const mg = marge(cotes, m.sport);
    if (mg < MARGE_MIN)
      throw new Error(`paris : marge trop faible sur « ${id} » (${(mg * 100).toFixed(2)} %) — ` +
                      'une cote a probablement ete recopiee de travers');

    return {
      id, sport: String(m.sport),
      competition: String(m.competition || ''), pays: String(m.pays || ''),
      domicile: String(m.domicile || ''), exterieur: String(m.exterieur || ''),
      /* Le pays du joueur, en code ISO a deux lettres. La page en fait un
         drapeau : au tennis on reconnait souvent un joueur a son pays avant de
         lire son nom, et les noms arrivent abreges (« Etcheverry T. M. »).
         On valide le format ici — un code de travers donnerait deux lettres
         chinoises a l'ecran plutot qu'un drapeau. */
      paysDomicile: /^[A-Z]{2}$/.test(m.paysDomicile || '') ? m.paysDomicile : null,
      paysExterieur: /^[A-Z]{2}$/.test(m.paysExterieur || '') ? m.paysExterieur : null,
      debut, cotes, marge: mg, issues: issues(m.sport),
      /* D'ou vient la rencontre, quand elle a ete importee plutot qu'ecrite a
         la main. `paris_import.js --scores` s'en sert pour retrouver le match
         chez le fournisseur, et surtout pour n'interroger QUE les ligues qui
         ont une rencontre a regler — le reste du forfait en depend.
         Rien de tout ca ne descend dans la page : `vue()` ne le recopie pas.
         C'est deliberé — un identifiant de fournisseur n'apprend rien a un
         joueur et donne une prise de plus a qui regarde le trafic. */
      source: (m.source && typeof m.source === 'object') ? {
        fournisseur: String(m.source.fournisseur || ''),
        ligue: String(m.source.ligue || ''),
        evenement: String(m.source.evenement || ''),
      } : null,
      /* Une cote fabriquee se dit. Le jour ou un pari se conteste, on veut
         savoir si le chiffre venait d'un bookmaker ou de notre modele. */
      cotesGenerees: !!m.cotesGenerees,
    };
  });

  return { sports, matchs, parId: new Map(matchs.map((m) => [m.id, m])) };
}

let CAT = null;
function charge(fichier) {
  const f = fichier || path.join(__dirname, 'paris_catalogue.json');
  CAT = valide(JSON.parse(fs.readFileSync(f, 'utf8')));
  return CAT;
}
function catalogue() { return CAT || charge(); }

/** Un match par son identifiant, ou null. */
function match(id) { return catalogue().parId.get(String(id)) || null; }

/**
 * Les paris encore ACCEPTABLES a cet instant.
 *
 * On ferme au coup d'envoi. Accepter un pari sur un match commence, c'est
 * accepter le pari de quelqu'un qui regarde le score — et il n'existe aucune
 * cote qui rende ca rentable.
 */
function ouverts(now) {
  const t = now || Date.now();
  return catalogue().matchs.filter((m) => m.debut > t);
}

/** Ce qu'une mise rapporterait, mise comprise. */
function rapport(cote, mise) {
  return Math.floor(Number(cote) * Number(mise) * 1e6) / 1e6;
}

/** La vue publique d'un match, pour la page. */
function vue(m, now) {
  return {
    id: m.id, sport: m.sport, competition: m.competition, pays: m.pays,
    domicile: m.domicile, exterieur: m.exterieur,
    paysDomicile: m.paysDomicile, paysExterieur: m.paysExterieur,
    debut: m.debut, cotes: m.cotes, issues: m.issues,
    ouvert: m.debut > (now || Date.now()),
  };
}

module.exports = {
  ISSUES, ISSUES_PAR_SPORT, issues, COTE_MIN, COTE_MAX, MARGE_MIN,
  charge, catalogue, match, ouverts, rapport, vue, marge, valide,
};
