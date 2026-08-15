'use strict';
/*
 * FABRIQUER LES COTES.
 *
 * ---- pourquoi ce fichier existe ----
 *
 * Le calendrier est ecrit a la main. Recopier des rencontres est fastidieux
 * mais sans risque ; recopier des COTES ne l'est pas. Une cote a 25 au lieu de
 * 2,5 se transforme directement en argent, et rien dans une liste de chiffres
 * ne signale la faute de frappe. Or les cotes sont aussi la partie la plus
 * penible a trouver : elles vivent chez des bookmakers qui les vendent, et les
 * fournisseurs de calendrier — ceux qui donnent gratuitement les rencontres,
 * les logos et les competitions — ne les donnent pas.
 *
 * D'ou ce module : on prend une rencontre SANS cote et on en fabrique une.
 * Pas pour concurrencer un bookmaker — pour que le calendrier puisse
 * s'alimenter tout seul sans qu'une seule cote soit recopiee a la main.
 *
 * ---- comment ----
 *
 * Trois etapes, et chacune peut se relire separement.
 *
 *  1. UNE FORCE PAR EQUIPE. C'est un Elo : un nombre, 1500 au depart, qui
 *     monte quand on gagne et descend quand on perd. Cent points d'ecart
 *     valent a peu pres 64 % de chances. Les forces vivent dans
 *     `paris_notes.json`, un fichier plat qu'on peut ouvrir et corriger.
 *
 *  2. DES PROBABILITES. Deux issues (tennis, NBA), c'est la formule Elo
 *     directe. Trois issues (football), il faut placer le nul : il est le plus
 *     probable quand les deux equipes se valent, et s'efface a mesure que
 *     l'ecart grandit. On modelise ca explicitement plutot que de le bricoler.
 *
 *  3. UNE MARGE. Une cote juste — 1/p — fait gagner la maison zero a la
 *     longue, ce qui n'est pas un modele economique, et le validateur du
 *     catalogue la refuse d'ailleurs sous 2 %. On applique donc une marge, et
 *     on VERIFIE apres arrondi qu'elle y est encore : arrondir au centieme
 *     peut la faire passer sous le plancher, et le catalogue serait alors
 *     rejete au chargement — c'est-a-dire au demarrage du serveur.
 *
 * ---- ce que ce module ne fait PAS ----
 *
 * Il ne pretend pas savoir mieux qu'un bookmaker. Un Elo ignore les blessures,
 * la meteo, un gardien suspendu et une equipe qui joue sa saison. Il ignore
 * aussi tout ce qui distingue un match de tennis sur terre battue d'un match
 * sur dur. La marge est la pour absorber cette ignorance : c'est pour ca
 * qu'elle est reglee plus haut ici que chez un bookmaker qui, lui, sait.
 */

const fs = require('fs');
const path = require('path');
const paris = require('./paris');

/* La force de depart d'une equipe inconnue. Toutes les equipes inconnues se
   valent donc — c'est exact, en un sens : on n'en sait rien. */
const NOTE_DEFAUT = 1500;

/* L'avantage du terrain, en points Elo, PAR SPORT.
   Au football il est mesure autour de 60 a 70 points dans les championnats
   europeens. En NBA il est plus fort — le deplacement coute, les rotations
   sont courtes. Au tennis il n'existe pas : le « domicile » n'est qu'une
   convention d'affichage, les deux joueurs sont sur le meme court. */
const TERRAIN = {
  foot: 65, nba: 100, tennis: 0,
  /* NFL : l'avantage du terrain vaut environ 2 points sur un ecart type de
     score de 13, soit une cinquantaine de points Elo. Il a nettement baisse
     depuis vingt ans, on ne le surestime pas. */
  nfl: 55,
  /* Cricket en format limite : l'avantage est reel — conditions locales,
     rosee, public — mais plus faible qu'au football. */
  cricket: 40,
};

/* Le nul, au football.
 *
 * `NUL_MAX` est sa probabilite quand les deux equipes se valent exactement ;
 * 28 % est ce qu'on observe dans les grands championnats. `NUL_PENTE` dit a
 * quelle vitesse il s'efface : a 400 points d'ecart — un ecart enorme — il
 * tombe autour de 12 %. La forme exponentielle est choisie parce qu'elle ne
 * peut jamais rendre une valeur negative, ce qu'une droite ferait au-dela
 * d'un certain ecart, en silence.
 */
const NUL_MAX = 0.28;
const NUL_PENTE = 0.0021;

/* La marge par defaut. Un bookmaker tourne entre 5 et 12 % selon le marche.
   On se place volontairement au-dessus : ces cotes sortent d'un modele qui
   ignore les blessures et la forme du moment, et cette ignorance se paie. */
const MARGE_DEFAUT = 0.10;
/* On ne descend jamais sous ca, meme si l'appelant le demande : le validateur
   du catalogue refuse en dessous de 2 %, et un catalogue refuse empeche le
   serveur de demarrer. On garde un cran de securite au-dessus du plancher. */
const MARGE_PLANCHER = 0.04;

const FICHIER_NOTES = path.join(__dirname, 'paris_notes.json');

// ------------------------------------------------------------- les forces

let NOTES = null;

/** Relit le fichier des forces. Un fichier absent n'est pas une erreur : on
 *  part alors de zero, et toutes les equipes valent 1500. */
function chargeNotes(fichier) {
  const f = fichier || FICHIER_NOTES;
  try {
    NOTES = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    NOTES = {};
  }
  return NOTES;
}
function notes() { return NOTES || chargeNotes(); }

/* Une cle stable pour une equipe. « Paris SG », « paris sg » et « PARIS  SG »
   doivent tomber sur la meme force : sinon un espace en trop cree une equipe
   fantome a 1500 et la cote change sans raison. */
function cle(sport, equipe) {
  return String(sport) + ':' + String(equipe || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** La force d'une equipe. Inconnue vaut 1500. */
function note(sport, equipe) {
  const v = Number(notes()[cle(sport, equipe)]);
  return isFinite(v) ? v : NOTE_DEFAUT;
}

/** Poser une force a la main. N'ecrit rien sur le disque — voir `sauveNotes`. */
function poseNote(sport, equipe, valeur) {
  const v = Number(valeur);
  if (!isFinite(v)) throw new Error('cotes : force invalide pour ' + equipe);
  notes()[cle(sport, equipe)] = Math.round(v);
  return v;
}

function sauveNotes(fichier) {
  fs.writeFileSync(fichier || FICHIER_NOTES, JSON.stringify(notes(), null, 2) + '\n');
}

/**
 * Mettre a jour les forces apres un resultat.
 *
 * C'est la seule facon pour que les cotes s'ameliorent : sans ca elles restent
 * a jamais celles du premier jour. Le facteur K dit combien un match deplace
 * une force — 20 est la valeur usuelle en football, et un nul deplace les deux
 * equipes vers le milieu.
 */
function apprend(sport, domicile, exterieur, resultat, K) {
  const k = Number(K) || 20;
  const a = note(sport, domicile), b = note(sport, exterieur);
  const attendu = 1 / (1 + Math.pow(10, -((a - b + (TERRAIN[sport] || 0)) / 400)));
  const marque = resultat === '1' ? 1 : resultat === '2' ? 0 : 0.5;
  poseNote(sport, domicile, a + k * (marque - attendu));
  poseNote(sport, exterieur, b + k * ((1 - marque) - (1 - attendu)));
  return { domicile: note(sport, domicile), exterieur: note(sport, exterieur) };
}

// -------------------------------------------------------- les probabilites

/**
 * Les probabilites d'un match, avant marge. Elles somment a 1 exactement.
 *
 * `ecart` est la difference de force, avantage du terrain compris. Pour deux
 * issues c'est la formule Elo telle quelle. Pour trois, on retire d'abord le
 * nul, puis on partage le reste dans le rapport que donne l'Elo : une equipe
 * deux fois plus forte que l'autre garde un espoir de victoire deux fois plus
 * grand, nul mis a part.
 */
function probabilites(sport, domicile, exterieur) {
  const iss = paris.issues(sport);
  const ecart = note(sport, domicile) - note(sport, exterieur) + (TERRAIN[sport] || 0);
  const e = 1 / (1 + Math.pow(10, -ecart / 400));      // « domicile l'emporte »

  if (iss.length === 2) return { 1: e, 2: 1 - e };

  const pn = NUL_MAX * Math.exp(-NUL_PENTE * Math.abs(ecart));
  const reste = 1 - pn;
  return { 1: reste * e, N: pn, 2: reste * (1 - e) };
}

// -------------------------------------------------------------- les cotes

/*
 * ---- comment la marge est repartie, et pourquoi pas au prorata ----
 *
 * La facon evidente d'ajouter 10 % de marge est de multiplier chaque
 * probabilite par 1,10 et d'inverser. Elle est evidente, simple a relire, et
 * FAUSSE aux extremes — d'une facon qui ne se voit qu'a l'usage :
 *
 *   un favori a 90 % donne 1 / (0,90 x 1,10) = 1,01.
 *
 * Or 1,01 est la borne basse du validateur, et 1/1,01 vaut 0,990 : la somme
 * des inverses retombe a 1,00 et LA MARGE DISPARAIT. Augmenter la marge
 * demandee n'y change rien, la cote est collee a sa borne. On se retrouve donc
 * a proposer un pari sur lequel la maison ne gagne rien — sur le cote,
 * justement, ou les mises vont aller.
 *
 * Le prorata a un second defaut, moins spectaculaire mais permanent : il fait
 * porter la marge en proportion egale, alors qu'un vrai livre en met plus sur
 * l'outsider que sur le favori. C'est pour ca que 1,01 chez un bookmaker
 * s'affiche 1,08.
 *
 * On utilise donc la METHODE PAR PUISSANCE : on cherche l'exposant k tel que
 *
 *     somme( p_i ^ k ) = 1 + marge,     avec 0 < k <= 1
 *
 * puis cote_i = 1 / p_i^k. Elever a une puissance inferieure a 1 remonte les
 * petites probabilites beaucoup plus que les grandes : la marge se concentre
 * naturellement sur les outsiders, exactement comme dans un vrai livre, et le
 * favori garde un prix presentable. Sur l'exemple ci-dessus, 90 % ne donne
 * plus 1,01 mais 1,08.
 *
 * k se trouve par dichotomie. La somme est strictement decroissante en k
 * (chaque p_i < 1), donc la dichotomie converge toujours, et quarante tours
 * suffisent largement au centieme pres.
 */

/* La cote la plus courte qu'on accepte d'afficher. En dessous, on est si pres
   de la borne du validateur que la marge devient fragile. */
const COTE_PLANCHER = 1.03;

/** L'exposant qui donne exactement la marge voulue. */
function exposant(p, iss, marge) {
  const cible = 1 + marge;
  const somme = (k) => iss.reduce((t, i) => t + Math.pow(p[i], k), 0);
  let bas = 0.01, haut = 1;
  /* A k = 1 la somme vaut 1, donc toujours en dessous de la cible : c'est le
     bon cote de la dichotomie. A k tres petit elle tend vers le nombre
     d'issues, donc au-dessus. */
  if (somme(bas) < cible) return bas;
  for (let t = 0; t < 60; t++) {
    const m = (bas + haut) / 2;
    if (somme(m) > cible) bas = m; else haut = m;
  }
  return (bas + haut) / 2;
}

/**
 * Le calcul complet, sans jeter : rend `{ cotes, marge, plusCourte }`.
 * `cotable()` et `cotesDe()` s'appuient dessus pour ne jamais diverger.
 */
function tarife(sport, domicile, exterieur, margeVoulue) {
  const iss = paris.issues(sport);
  let m = Number(margeVoulue);
  if (!isFinite(m)) m = MARGE_DEFAUT;
  m = Math.max(MARGE_PLANCHER, m);

  const p = probabilites(sport, domicile, exterieur);

  for (let essai = 0; essai < 60; essai++) {
    const k = exposant(p, iss, m);
    const c = {};
    let plusCourte = Infinity;
    for (const i of iss) {
      /* La borne haute reste utile : sur un outsider a 0,5 %, la cote
         depasserait 100 et le validateur la refuserait. Payer moins que le
         juste de ce cote-la ne coute rien a la maison. */
      const v = Math.min(paris.COTE_MAX, Math.max(paris.COTE_MIN, 1 / Math.pow(p[i], k)));
      c[i] = Math.round(v * 100) / 100;
      plusCourte = Math.min(plusCourte, c[i]);
    }
    /* On mesure la marge REELLE, celle qui sera lue dans le catalogue, pas
       celle qu'on croyait appliquer : arrondir au centieme la deplace. */
    const reelle = paris.marge(c, sport);
    if (reelle >= Math.max(paris.MARGE_MIN, MARGE_PLANCHER * 0.75)) {
      return { cotes: c, marge: reelle, plusCourte };
    }
    m += 0.005;
  }
  return null;
}

/**
 * Ce match peut-il etre cote ?
 *
 * Il y a un point ou plus aucune methode ne sauve la mise : un favori a 97 %
 * vaut 1,03 juste, et il n'existe pas de facon de prendre 10 % dessus sans
 * soit descendre sous la borne du validateur, soit payer plus que le juste.
 * Un tel match n'est de toute facon pas un marche — personne ne mise a 1,02,
 * et la maison n'a rien a y gagner. On l'ECARTE, en le disant.
 */
function cotable(sport, domicile, exterieur, margeVoulue) {
  const t = tarife(sport, domicile, exterieur, margeVoulue);
  const p = probabilites(sport, domicile, exterieur);
  const iss = paris.issues(sport);
  let favori = iss[0];
  for (const i of iss) if (p[i] > p[favori]) favori = i;
  return {
    cotable: !!t && t.plusCourte >= COTE_PLANCHER,
    favori, proba: p[favori],
    plusCourte: t ? t.plusCourte : null,
    plancher: COTE_PLANCHER,
  };
}

function cotesDe(sport, domicile, exterieur, margeVoulue) {
  const t = tarife(sport, domicile, exterieur, margeVoulue);
  if (!t || t.plusCourte < COTE_PLANCHER) {
    const q = cotable(sport, domicile, exterieur, margeVoulue);
    throw new Error(`cotes : ${domicile} v ${exterieur} trop desequilibre — ` +
      `issue « ${q.favori} » a ${(q.proba * 100).toFixed(1)} %, ` +
      `la cote sortirait a ${q.plusCourte === null ? '?' : q.plusCourte} ` +
      `et le plancher est ${COTE_PLANCHER}`);
  }
  return t.cotes;
}

/**
 * Completer un match. Une cote DEJA PRESENTE n'est jamais remplacee : si
 * quelqu'un a pris la peine d'en relever une chez un bookmaker, elle vaut
 * mieux que la notre, et l'ecraser serait une mauvaise surprise.
 */
function habille(m, margeVoulue, now) {
  if (!m || !m.sport) throw new Error('cotes : match sans sport');
  const iss = paris.issues(m.sport);
  const deja = m.cotes && iss.every((i) => isFinite(Number(m.cotes[i])));
  /* Une cote FABRIQUEE se refait tant que la rencontre n'a pas commence.
     C'est ce qui permet aux cotes de s'ameliorer : les forces Elo changent —
     un etalonnage, un resultat — et sans ce refus de se figer, tout le
     calendrier resterait a jamais sur les cotes du premier jour, celles ou
     toutes les equipes valaient 1500 et ou chaque match affichait
     2,08 / 3,61 / 2,92.
     Une cote RELEVEE A LA MAIN n'est jamais touchee : quelqu'un a pris la
     peine de la chercher, elle vaut mieux que la notre.
     Et une rencontre COMMENCEE ne bouge plus, evidemment : les paris y sont
     deja poses a la cote affichee. */
  const t = Number(now) || Date.now();
  const commence = isFinite(Date.parse(m.debut)) && Date.parse(m.debut) <= t;
  if (deja && (!m.cotesGenerees || commence)) return m;
  return Object.assign({}, m, {
    cotes: cotesDe(m.sport, m.domicile, m.exterieur, margeVoulue),
    /* Une cote fabriquee se dit. Le jour ou un pari se conteste, on veut
       savoir d'ou venait le chiffre. */
    cotesGenerees: true,
  });
}

/** Completer un catalogue entier, puis le VALIDER comme le fera le serveur. */
function habilleCatalogue(brut, margeVoulue) {
  const sortie = Object.assign({}, brut, {
    matchs: (brut.matchs || []).map((m) => habille(m, margeVoulue)),
  });
  paris.valide(sortie);        // jette ici plutot qu'au demarrage du serveur
  return sortie;
}

module.exports = {
  NOTE_DEFAUT, TERRAIN, NUL_MAX, NUL_PENTE, MARGE_DEFAUT, MARGE_PLANCHER, COTE_PLANCHER, exposant, tarife, cotable,
  chargeNotes, notes, cle, note, poseNote, sauveNotes, apprend,
  probabilites, cotesDe, habille, habilleCatalogue,
};
