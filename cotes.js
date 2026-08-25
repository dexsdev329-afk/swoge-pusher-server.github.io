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
/* ---- L'AVANTAGE DU TERRAIN VIENT DU REGISTRE DES SPORTS ----
 * Il vivait ici, dans sa propre table, a cote de la liste des issues qui
 * vivait dans `paris.js` et du nom d'affichage qui vivait dans l'import.
 * Ajouter un sport demandait donc de penser a trois fichiers — et l'oubli le
 * plus probable etait justement celui-ci : sans avantage du terrain, il vaut
 * ZERO, le favori a domicile est sous-cote a chaque match, et rien ne casse.
 * Chaque valeur est commentee la-bas, avec le reste du sport. */
const TERRAIN = {};
for (const c of Object.keys(paris.SPORTS)) TERRAIN[c] = paris.SPORTS[c].terrain;

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

/**
 * L'exposant qui donne exactement la marge voulue.
 *
 * `couverture` est le nombre de fois que les reponses couvrent l'espace des
 * resultats — un partout, sauf la double chance dont les trois reponses se
 * recouvrent deux a deux. A `k = 1` la somme des probabilites vaut exactement
 * cette couverture ; c'est de la qu'on part, et c'est pour ca qu'elle doit
 * entrer dans la cible plutot que d'y etre supposee valoir un.
 */
function exposant(p, iss, marge, couverture) {
  const cible = (Number(couverture) || 1) + marge;
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
  /* ---- « DEJA COTE » SE LIT DANS LES DEUX FORMES ----
   * Ce qu'on ECRIT porte des marches ; ce qu'on RELIT peut encore porter des
   * cotes a plat — les catalogues deja sur le volume ne se reecrivent pas
   * tout seuls. Ne regarder que l'une des deux ferait refabriquer, a chaque
   * passage, des cotes relevees a la main. */
  const lot = (m.marches && m.marches[paris.MARCHE_BASE]
               && m.marches[paris.MARCHE_BASE].cotes) || m.cotes;
  const deja = lot && iss.every((i) => isFinite(Number(lot[i])));
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
  /* Une rencontre COMMENCEE ne bouge plus, rien du tout. C'est le seul retour
     anticipe, et il vient en premier : lui en ajouter d'autres au-dessus le
     contournerait sans qu'on s'en apercoive. */
  if (deja && commence) return m;

  /* ---- UNE COTE RELEVEE EST INTOUCHABLE, LES CINQ AUTRES MARCHES NON ----
   * `if (deja && !cotesGenerees) return m` protegeait bien le 1-N-2 releve a
   * la main — et privait la rencontre des cinq marches, puisqu'il rendait
   * l'objet avant de les construire. Or l'import RELEVE ses cotes chez le
   * fournisseur : `cotesGenerees` y est faux sur tout le calendrier reel, et
   * les cinq nouveaux marches ne seraient apparus sur RIEN. Mesure sur une
   * rencontre cotee 1,30 / 5,50 / 9,00 : « marches : AUCUN ».
   * On garde donc le lot releve tel quel, et l'on batit les autres DESSUS. */
  const garde = deja && !m.cotesGenerees;
  const marches = marchesDe(m.sport, m.domicile, m.exterieur, margeVoulue,
                            garde ? lot : null);
  /* ---- ET SEULEMENT ALORS, ON GARDE CE QUI ETAIT DEJA ECRIT ----
   * Un marche deja la n'est pas remplace, pour la meme raison que le 1-N-2 :
   * s'il a ete releve, il vaut mieux que le notre.
   * SOUS `garde` UNIQUEMENT. Sans cette condition, les anciens marches
   * recouvraient les neufs sur une rencontre FABRIQUEE — et les cotes ne se
   * refaisaient plus jamais quand une force Elo changeait. C'est l'essai
   * « la cote se refait quand la force change » qui l'a dit, en rendant
   * « 2,08 → 2,08 » : deux fois le meme chiffre la ou l'on attendait un
   * ecart. */
  if (garde && m.marches && typeof m.marches === 'object') Object.assign(marches, m.marches);
  /* Rien a refaire : le lot est fige et tous les marches sont deja la. On rend
     l'objet TEL QUEL — l'appelant compare parfois les deux par identite pour
     savoir s'il doit reecrire le fichier. */
  if (garde && paris.marchesDuSport(m.sport).every((k) => m.marches && m.marches[k])) return m;
  const sortie = Object.assign({}, m, {
    /* ---- TOUS LES MARCHES, ET PLUS DE COTES A PLAT ----
     * `cotes` disparait de ce qu'on ECRIT : le 1-N-2 vit dans `marches`
     * comme les cinq autres. La lecture, elle, accepte encore l'ancienne
     * forme — les catalogues deja sur le volume ne se reecrivent pas — mais
     * un fichier ne doit pas porter les deux, sans quoi il y aurait deux
     * endroits ou lire la cote du « 1 » et un jour pour les voir differer. */
    marches,
    /* Une cote fabriquee se dit. Le jour ou un pari se conteste, on veut
       savoir d'ou venait le chiffre.
       LE DRAPEAU PORTE SUR LE 1-N-2, et sur lui seul : c'est celui sur lequel
       on discutera. Un lot releve chez un bookmaker reste releve meme si les
       cinq autres marches, eux, sont toujours fabriques — le marquer
       « fabrique » ferait croire qu'on a invente une cote qu'on a recopiee. */
    cotesGenerees: garde ? !!m.cotesGenerees : true,
  });
  delete sortie.cotes;
  return sortie;
}

/** Completer un catalogue entier, puis le VALIDER comme le fera le serveur. */
function habilleCatalogue(brut, margeVoulue) {
  const sortie = Object.assign({}, brut, {
    matchs: (brut.matchs || []).map((m) => habille(m, margeVoulue)),
  });
  paris.valide(sortie);        // jette ici plutot qu'au demarrage du serveur
  return sortie;
}

/* ================== LE MODELE DE BUTS ==================
 *
 * ---- POURQUOI IL FAUT UN MODELE, ET PAS SEULEMENT DES PROBABILITES ----
 *
 * L'Elo repond a une seule question : qui gagne. « Les deux equipes
 * marquent-elles », « y aura-t-il plus de deux buts et demi », « quel score
 * exact » sont des questions sur les BUTS, et un 1-0 et un 3-2 donnent la meme
 * reponse a l'Elo en donnant des reponses opposees a celles-la.
 *
 * ---- LE MODELE ----
 *
 * Chaque equipe marque selon une loi de Poisson, de moyenne `lh` et `la`. Le
 * couple de nombres qu'elles marquent suit donc le produit des deux lois, et
 * TOUS les marches se lisent dans cette grille : « les deux marquent » est la
 * somme des cases ou les deux indices sont non nuls, « plus de 2,5 » la somme
 * de celles dont les indices totalisent trois ou plus, le score exact une case.
 * Un seul modele, six marches — ils ne peuvent pas se contredire.
 *
 * ---- ET SES DEUX MOYENNES SE DEDUISENT DE L'ELO ----
 *
 * On ne les invente pas : on cherche le couple qui REPRODUIT les probabilites
 * 1-N-2 deja calculees. Deux inconnues, deux cibles — le total de buts et la
 * part de l'equipe a domicile — et chacune est monotone dans la cible qui lui
 * revient, donc deux dichotomies imbriquees suffisent et convergent toujours.
 *
 * Le nouveau marche est ainsi ACCROCHE a l'ancien : impossible d'afficher un
 * « plus de 2,5 » qui contredise le « 1 » affiche a cote, puisque les deux
 * sortent du meme couple de nombres.
 *
 * ---- CE QUE LE MODELE IGNORE ----
 *
 * Deux lois de Poisson independantes sous-estiment les tres petits scores :
 * dans la vraie vie, 0-0 et 1-1 arrivent un peu plus souvent que le produit ne
 * le dit. La correction usuelle — Dixon-Coles — n'est pas appliquee ici : elle
 * demande un parametre de plus, estime sur des milliers de matchs qu'on n'a
 * pas. L'ajustement du TOTAL sur la probabilite de nul la compense en partie,
 * et la marge — plus haute que celle d'un bookmaker, deliberement — absorbe le
 * reste. C'est le meme aveu que pour l'Elo : le modele ne sait pas tout, et
 * c'est la marge qui paie son ignorance.
 */

/* Douze buts par equipe. La queue au-dela pese moins d'un millionieme meme
   pour une moyenne de quatre, et il faut bien s'arreter : une grille infinie
   ne se somme pas. */
const BUTS_MAX = 12;

function poisson(lam, k) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p = p * lam / i;
  return p;
}

/** La grille des scores : `g[i][j]` = probabilite de i buts a j. */
function grilleDesScores(lh, la) {
  const ph = [], pa = [];
  for (let i = 0; i <= BUTS_MAX; i++) { ph.push(poisson(lh, i)); pa.push(poisson(la, i)); }
  const g = [];
  for (let i = 0; i <= BUTS_MAX; i++) {
    const r = [];
    for (let j = 0; j <= BUTS_MAX; j++) r.push(ph[i] * pa[j]);
    g.push(r);
  }
  return g;
}

/** Les trois issues, lues dans la grille. */
function issuesDeLaGrille(g) {
  let un = 0, nul = 0, deux = 0;
  for (let i = 0; i <= BUTS_MAX; i++)
    for (let j = 0; j <= BUTS_MAX; j++) {
      if (i > j) un += g[i][j]; else if (i < j) deux += g[i][j]; else nul += g[i][j];
    }
  return { 1: un, N: nul, 2: deux };
}

/**
 * LES DEUX MOYENNES DE BUTS QUI REPRODUISENT CES PROBABILITES.
 *
 * Dichotomie imbriquee : le TOTAL au-dehors — plus il monte, moins le nul est
 * probable — et la PART du domicile au-dedans — plus elle monte, plus le
 * rapport entre les deux victoires penche de son cote. Chacune est strictement
 * monotone dans sa cible, donc chacune converge, et la boucle interieure
 * retablit exactement le rapport a chaque essai de l'exterieure.
 */
function ajusteButs(p1, pN, p2) {
  const rapportVoulu = p1 / Math.max(1e-9, p1 + p2);
  const partPour = (total) => {
    let bas = 0.05, haut = 0.95;
    for (let t = 0; t < 40; t++) {
      const x = (bas + haut) / 2;
      const q = issuesDeLaGrille(grilleDesScores(total * x, total * (1 - x)));
      if (q[1] / Math.max(1e-9, q[1] + q[2]) < rapportVoulu) bas = x; else haut = x;
    }
    return (bas + haut) / 2;
  };
  /* Entre un but et demi et six : en dessous le football n'existe pas, au-dessus
     non plus. Les bornes ne sont pas un reglage, elles empechent la dichotomie
     de partir chercher une solution absurde quand la cible est inatteignable —
     un nul a 45 %, par exemple, qu'aucun couple de Poisson ne produit. */
  let bas = 1.5, haut = 6.0;
  for (let t = 0; t < 40; t++) {
    const T = (bas + haut) / 2;
    const q = issuesDeLaGrille(grilleDesScores(T * partPour(T), T * (1 - partPour(T))));
    if (q.N > pN) bas = T; else haut = T;      // plus de buts, moins de nuls
  }
  const T = (bas + haut) / 2, x = partPour(T);
  return { lh: T * x, la: T * (1 - x), total: T };
}

/**
 * LES PROBABILITES DE CHAQUE MARCHE, toutes lues dans la meme grille.
 *
 * C'est ce qui garantit qu'ils ne peuvent pas se contredire : « les deux
 * marquent » et « plus de 2,5 buts » ne sont pas deux estimations separees,
 * ce sont deux facons de sommer les memes cases.
 */
function probasDesMarches(lh, la) {
  const g = grilleDesScores(lh, la);
  const iss = issuesDeLaGrille(g);
  let btts = 0, plus = 0, hand1 = 0;
  const exact = {};
  for (const s of paris.SCORES) exact[s] = 0;
  for (let i = 0; i <= BUTS_MAX; i++)
    for (let j = 0; j <= BUTS_MAX; j++) {
      const q = g[i][j];
      if (i > 0 && j > 0) btts += q;
      if (i + j > 2.5) plus += q;
      if (i - j >= 2) hand1 += q;
      const cle = i + '-' + j;
      if (exact[cle] !== undefined) exact[cle] += q; else exact.autre += q;
    }
  return {
    '1n2': iss,
    dc: { '1X': iss[1] + iss.N, 12: iss[1] + iss[2], X2: iss.N + iss[2] },
    btts: { oui: btts, non: 1 - btts },
    ou25: { plus, moins: 1 - plus },
    score: exact,
    hand: { 1: hand1, 2: 1 - hand1 },
  };
}

/**
 * HABILLER UN LOT DE PROBABILITES EN COTES.
 *
 * La meme methode par puissance que le 1-N-2, et le meme controle apres
 * arrondi : c'est la marge REELLE, celle qui sera relue dans le catalogue, qui
 * doit tenir — pas celle qu'on croyait appliquer.
 * Rend `null` quand le marche ne tient pas : une reponse a 99 % ne se cote pas
 * sans descendre sous la borne du validateur. On l'ECARTE plutot que de
 * proposer un pari a 1,01 sur lequel la maison ne gagne rien.
 */
function habilleUnMarche(p, iss, couverture, margeVoulue) {
  let m = Math.max(MARGE_PLANCHER, Number(margeVoulue) || MARGE_DEFAUT);
  for (let essai = 0; essai < 60; essai++) {
    const k = exposant(p, iss, m, couverture);
    const c = {};
    let plusCourte = Infinity;
    for (const i of iss) {
      const v = Math.min(paris.COTE_MAX, Math.max(paris.COTE_MIN, 1 / Math.pow(p[i], k)));
      c[i] = Math.round(v * 100) / 100;
      plusCourte = Math.min(plusCourte, c[i]);
    }
    const reelle = paris.margeDe(c, iss, couverture);
    if (reelle >= paris.MARGE_MIN && plusCourte >= COTE_PLANCHER) return { cotes: c, marge: reelle };
    if (plusCourte < COTE_PLANCHER) return null;   // aucune marge ne sauvera ca
    m += 0.005;
  }
  return null;
}

/**
 * LES PROBABILITES QU'UN LOT DE COTES IMPLIQUE — la marge retiree.
 *
 * C'est l'INVERSE EXACT de `habilleUnMarche` : celui-ci pose `c = 1 / p^k`, on
 * cherche donc le `k` tel que la somme des `(1/c)^(1/k)` retombe sur la
 * couverture. Un aller-retour rend les probabilites de depart, a l'arrondi
 * pres.
 *
 * On aurait pu simplement normaliser les inverses — diviser chaque 1/c par
 * leur somme. C'est ce que fait tout le monde, c'est plus court, et c'est
 * BIAISE : la marge n'est pas repartie a proportion egale, elle pese plus sur
 * les outsiders — c'est meme pour cela que la methode par puissance a ete
 * choisie plus haut. Normaliser rendrait donc le favori trop probable, et
 * tout ce qu'on en deduit avec.
 */
function probasImplicites(cotes, iss, couverture) {
  const cv = Number(couverture) || 1;
  const inv = iss.map((i) => 1 / Number(cotes[i]));
  if (!inv.every((v) => isFinite(v) && v > 0)) return null;
  const somme = (k) => inv.reduce((t, v) => t + Math.pow(v, 1 / k), 0);
  let bas = 0.05, haut = 1;
  /* A k = 1 la somme vaut couverture + marge, donc au-dessus de la cible ; a k
     petit elle s'effondre. La dichotomie a toujours ses deux cotes — sauf si
     le lot ne porte aucune marge, ou l'on rend null plutot que de diverger. */
  if (somme(bas) > cv) return null;
  for (let t = 0; t < 60; t++) {
    const m = (bas + haut) / 2;
    if (somme(m) < cv) bas = m; else haut = m;
  }
  const k = (bas + haut) / 2;
  const out = {};
  iss.forEach((i, q) => { out[i] = Math.pow(inv[q], 1 / k); });
  return out;
}

/**
 * TOUS LES MARCHES D'UNE RENCONTRE, cotes.
 *
 * Le 1-N-2 reste celui que `tarife` produit — on ne le refait pas depuis la
 * grille : il est deja calcule, deja eprouve, et le recalculer autrement le
 * ferait diverger de lui-meme au troisieme chiffre. Les autres en descendent.
 */
function marchesDe(sport, domicile, exterieur, margeVoulue, cotesBase) {
  const iss1 = paris.issues(sport);
  /* ---- LE 1-N-2 RELEVE PREND LE PAS SUR LE NOTRE ----
   * `cotesBase` est le lot qui sera AFFICHE quand il vient d'un bookmaker.
   * Faute de quoi on fabrique le notre, comme avant. */
  const base = (cotesBase && iss1.every((i) => isFinite(Number(cotesBase[i]))))
    ? cotesBase : cotesDe(sport, domicile, exterieur, margeVoulue);
  const sortie = { [paris.MARCHE_BASE]: { cotes: base } };
  const dispo = paris.marchesDuSport(sport).filter((k) => k !== paris.MARCHE_BASE);
  if (!dispo.length) return sortie;
  /* ---- ET LES CINQ AUTRES DESCENDENT DE CELUI-LA, PAS DE L'ELO ----
   * Sur une rencontre dont le 1-N-2 vient d'un bookmaker, un « les deux
   * marquent » calcule sur notre Elo exprimerait un AUTRE avis que celui
   * affiche juste a cote. Les deux se contrediraient — et l'ecart entre deux
   * prix du meme evenement sur la meme page est exactement l'arbitrage qu'on
   * offre a qui sait compter.
   * Faute de pouvoir remonter aux probabilites — un lot sans marge, ce qui ne
   * devrait pas passer le validateur — on retombe sur l'Elo plutot que de ne
   * rien proposer. */
  const p = probasImplicites(base, iss1, 1) || probabilites(sport, domicile, exterieur);
  if (!isFinite(p.N)) return sortie;             // deux issues : pas de buts a modeliser
  const { lh, la } = ajusteButs(p[1], p.N, p[2]);
  const tout = probasDesMarches(lh, la);
  for (const k of dispo) {
    const M = paris.MARCHES[k];
    const iss = M.issues(sport);
    const lot = habilleUnMarche(tout[k], iss, M.couverture, margeVoulue);
    /* Un marche qui ne tient pas est ECARTE, pas force. La rencontre garde les
       autres — refuser tout le match parce qu'un handicap sort des bornes
       priverait de pari une affiche parfaitement cotable. */
    if (lot) sortie[k] = { cotes: lot.cotes };
  }
  return sortie;
}

module.exports = {
  NOTE_DEFAUT, TERRAIN, NUL_MAX, NUL_PENTE, MARGE_DEFAUT, MARGE_PLANCHER, COTE_PLANCHER, exposant, tarife, cotable,
  chargeNotes, notes, cle, note, poseNote, sauveNotes, apprend,
  probabilites, cotesDe, habille, habilleCatalogue,
  BUTS_MAX, poisson, grilleDesScores, issuesDeLaGrille, ajusteButs,
  probasDesMarches, habilleUnMarche, marchesDe, probasImplicites,
};
