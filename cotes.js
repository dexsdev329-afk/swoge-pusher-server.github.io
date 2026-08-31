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
 * `NUL_MAX` est sa probabilite quand les deux equipes se valent exactement.
 * `NUL_PENTE` dit a quelle vitesse il s'efface avec l'ecart de force. La
 * forme exponentielle est choisie parce qu'elle ne peut jamais rendre une
 * valeur negative, ce qu'une droite ferait au-dela d'un certain ecart, en
 * silence.
 *
 * ---- CES DEUX NOMBRES DECIDENT DU NOMBRE DE BUTS, ET ON NE LE VOYAIT PAS ----
 *
 * Ils valaient 0,28 et 0,0021, choisis pour le nul seul. Mais le nul n'est
 * pas seul : `ajusteButs` cherche le nombre de buts qui le REPRODUIT, et un
 * nul trop bas ne se reproduit qu'en ajoutant des buts. Releve avec ces
 * valeurs-la, sur un match equilibre : nul 24 % — deux points sous la
 * realite — et 3,48 buts attendus, alors qu'un match de championnat en
 * produit 2,7. Sur un gros favori, 4,6 buts. Le modele n'ecrivait plus un
 * match de football.
 *
 * Et TOUT ce qui descend de la grille suivait : « plus de 2,5 buts » offert a
 * 1,12 quand il vaut 1,9, un 2-0 a 12,86 la ou le marche affiche 7,5. La
 * maison ne perdait pas en moyenne — elle affichait des prix faux, et un
 * parieur qui compare prend exactement le cote qui paie.
 *
 * Recalibres sur deux points observes plutot que sur un seul :
 *
 *     ecart      nul     total de buts
 *     equilibre  28 %    2,74
 *     255        22 %    3,13
 *     423        18 %    2,94
 *     565        14 %    2,74
 *
 * Le nul reste dans ce qu'on observe (25-28 % a l'equilibre, 14-17 % sur un
 * gros favori) ET le total de buts tombe dans la fourchette d'un vrai match.
 * Deux contraintes valent mieux qu'une : une courbe qui satisfait le nul seul
 * peut etre absurde partout ailleurs, et elle l'etait.
 */
const NUL_MAX = 0.31;
const NUL_PENTE = 0.00135;

/* La marge par defaut. Un bookmaker tourne entre 5 et 12 % selon le marche.
   On se place volontairement au-dessus : ces cotes sortent d'un modele qui
   ignore les blessures et la forme du moment, et cette ignorance se paie. */
const MARGE_DEFAUT = 0.10;
/* On ne descend jamais sous ca, meme si l'appelant le demande : le validateur
   du catalogue refuse en dessous de 2 %, et un catalogue refuse empeche le
   serveur de demarrer. On garde un cran de securite au-dessus du plancher. */
const MARGE_PLANCHER = 0.04;

/* ==================== LE PLANCHER DE MARGE PAR ISSUE ====================
 *
 * LA MARGE DU LIVRE N'EST PAS LA MARGE D'UN PARI. La methode de l'exposant
 * — `c = 1 / p^k` — repartit la marge « naturellement sur les outsiders,
 * exactement comme dans un vrai livre ». C'est vrai, et c'est justement le
 * probleme ici : elle laisse le FAVORI presque au prix juste, et le favori
 * est la selection que tout le monde prend.
 *
 * Mesure sur nos propres cotes, avant ce plancher — de combien de points de
 * probabilite le modele peut-il se tromper sur le favori avant que le pari
 * devienne gagnant pour le parieur :
 *
 *     PSG v Angers        cote 1,14   modele 85,2 %   bascule a 87,7 %   +2,6 pt
 *     Real Madrid v Malaga cote 1,10  modele 88,7 %   bascule a 90,9 %   +2,2 pt
 *     Arsenal v Bolton    cote 1,09   modele 89,5 %   bascule a 91,7 %   +2,2 pt
 *
 * Deux points et demi. Or ce modele est un Elo : il ignore les blessures, la
 * forme, un gardien suspendu, et le fait qu'une equipe comme celles-la joue
 * a domicile contre le dix-septieme. Se tromper de deux points sur un tel
 * match n'est pas un accident rare, c'est l'ordinaire — et l'erreur va
 * toujours dans le meme sens, parce que ces equipes-la gagnent plus souvent
 * que ce qu'un Elo generaliste leur accorde.
 *
 * Le livre affichait 10 % de marge et n'en portait que 2,6 la ou tout
 * l'argent se pose. C'est ca, « se mettre dans la sauce » : pas une cote
 * fausse, une marge posee au mauvais endroit.
 *
 * ON RABOTE DONC CHAQUE ISSUE SEPAREMENT. Aucune cote ne peut impliquer
 * moins que `p x (1 + MARGE_ISSUE_MIN)`. Raccourcir une cote ne peut
 * qu'AUGMENTER la marge du livre, donc ce rabot ne peut jamais faire tomber
 * un marche sous le plancher du validateur — il ne cree pas de nouveau cas
 * a gerer. */
const MARGE_ISSUE_MIN = 0.06;

/* ---- ET IL MORD PLUS FORT SUR LES ISSUES RARES ----
 * Une marge de 6 % protege d'une erreur de 6 % sur la probabilite. Or
 * l'erreur du modele n'est pas la meme partout : sur un favori a 85 % il se
 * trompe de deux ou trois points, soit 3 % en relatif ; sur un 0-1 a 0,9 %
 * il peut se tromper d'un tiers de la valeur sans que rien ne le signale,
 * parce qu'une case rare ne pese presque rien dans l'ajustement qui a produit
 * la grille.
 *
 * Mesure de ce que ca coutait : sur deux affiches, le 0-1 sortait a la cote
 * PLAFOND de 100 et rendait 113 % au parieur des que la correction de
 * Dixon-Coles s'annulait. La cote maximale n'est pas une protection — c'est
 * une borne d'affichage, et elle tombait du mauvais cote.
 *
 * Le plancher monte donc quand la probabilite descend : 6 % au-dessus d'une
 * chance sur dix, 50 % en dessous d'une chance sur cinquante, en pente entre
 * les deux. Ce n'est pas de la gourmandise, c'est le prix de l'ignorance —
 * la meme raison qui fait que la marge generale est deja plus haute ici que
 * chez un bookmaker qui, lui, sait. */
const MARGE_ISSUE_QUEUE = 0.50;
const P_HAUTE = 0.10;          // au-dessus, le plancher ordinaire suffit
const P_BASSE = 0.02;          // en dessous, le plancher de queue s'applique

function plancherDe(pi) {
  if (!(pi > 0)) return MARGE_ISSUE_MIN;
  if (pi >= P_HAUTE) return MARGE_ISSUE_MIN;
  if (pi <= P_BASSE) return MARGE_ISSUE_QUEUE;
  const u = (P_HAUTE - pi) / (P_HAUTE - P_BASSE);
  return MARGE_ISSUE_MIN + u * (MARGE_ISSUE_QUEUE - MARGE_ISSUE_MIN);
}

/* Le rabot. Il ne touche que ce qui depasse : une cote deja assez chere pour
   la maison ressort inchangee.
 *
 * `gradue` n'est vrai que pour le score exact — la seule liste ou une issue
 * peut etre une case RARE d'une grille, mal estimee parce qu'elle ne pese
 * presque rien dans l'ajustement qui a produit cette grille. L'outsider d'un
 * match de NBA a 5 % n'est pas dans ce cas : il sort directement de l'Elo,
 * qui l'estime aussi bien que le favori.
 *
 * ---- ET LE PLANCHER NE PEUT PAS TOUJOURS ETRE TENU ----
 * A 94,7 % — un ecart banal en NBA — exiger 6 % de marge demanderait une
 * probabilite implicite de 100,4 %. Ca n'existe pas : la marge maximale
 * atteignable sur un favori a p vaut 1/p - 1, soit 5,6 % ici. La premiere
 * version ne le voyait pas, tombait sous la cote minimale, et le match
 * entier etait ECARTE — quatre affiches de NBA a 340-400 points d'ecart
 * perdues pour avoir voulu trop les proteger.
 *
 * On prend donc ce que le prix PERMET : le plancher quand il est
 * atteignable, la cote la plus courte affichable quand il ne l'est pas.
 * Un marche a 2,5 % de marge vaut mieux qu'un marche absent, et de toute
 * facon un favori a 95 % ne trouve pas beaucoup de preneurs. */
function raboteIssues(c, p, iss, marge, gradue) {
  const out = {};
  for (const i of iss) {
    const pi = Number(p[i]);
    let v = c[i];
    if (isFinite(pi) && pi > 0) {
      const e = (marge === undefined) ? (gradue ? plancherDe(pi) : MARGE_ISSUE_MIN) : marge;
      let plafond = 1 / (pi * (1 + e));
      /* on ne descend pas sous ce qui s'affiche : sinon on n'a plus de
         marche du tout, ce qui n'est pas une protection */
      if (plafond < COTE_PLANCHER) plafond = COTE_PLANCHER;
      if (v > plafond) v = Math.round(plafond * 100) / 100;
    }
    out[i] = Math.max(paris.COTE_MIN, v);
  }
  return out;
}

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

/* ==================== RETROUVER UNE EQUIPE ====================
 *
 * ---- CE QUE CETTE PARTIE A COUTE ----
 *
 * Un soir, tous les bookmakers donnaient Monaco a 2,2 et Marseille a 3. Nous
 * affichions Monaco a 5. Des joueurs ont mise dessus.
 *
 * Le modele n'y etait pour rien : sur les vraies forces — Monaco 1820,
 * Marseille 1810 — il rend 2,02 / 3,68 / 3,00, ce qui colle au marche. Le
 * fournisseur, lui, ecrit « AS Monaco ». La clef cherchee etait donc
 * `foot:as monaco`, elle n'existait pas, et `note()` rendait 1500 SANS RIEN
 * DIRE. Monaco valait soudain trois cent dix points de moins que la verite,
 * et la cote suivait : 5,04. Reproduit a l'identique.
 *
 * Un defaut silencieux est le pire de tous ici : il ne casse rien, il ne
 * leve rien, il fabrique un chiffre confiant et faux, et ce chiffre est de
 * l'argent.
 *
 * ---- LA REGLE, EN QUATRE TEMPS ----
 *
 *  1. la clef exacte ;
 *  2. un ALIAS declare a la main dans `paris_notes.json` — c'est la seule
 *     facon honnete de relier « Olympique de Marseille » a « marseille » :
 *     aucune regle mecanique ne peut deviner ca sans casser autre chose ;
 *  3. la forme REDUITE — le nom sans ses abreviations de club (as, fc, sc…) —
 *     si elle designe une equipe et une seule ;
 *  4. sinon : INCONNUE. Et une equipe inconnue ne se cote pas.
 *
 * ---- POURQUOI ON NE RABOTE QUE LES ABREVIATIONS ----
 *
 * Mesure sur les 163 equipes de foot du fichier : raboter « real » et
 * « atletico » fait tomber `real madrid` et `atletico madrid` sur le meme
 * nom. Deux clubs de la meme ville, l'un a 1900 et l'autre a 1800 — les
 * confondre serait exactement le defaut qu'on repare, en pire, parce qu'il
 * paraitrait juste. Ces mots-la font partie du nom ; `fc` et `as` non.
 *
 * Le meme releve a montre cinq DOUBLONS — `augsburg` et `fc augsburg`,
 * `barcelona` et `fc barcelona`… — deux forces pour un seul club, qui
 * divergent a chaque resultat. La regle 3 les resout sans rien effacer : la
 * forme reduite est elle-meme une clef, donc c'est celle-la qu'on prend.
 */

/* Les abreviations de club, et rien d'autre. Une seule regle a retenir : si
   le mot pourrait distinguer deux clubs de la meme ville, il n'est pas ici. */
const AFFIXES = new Set([
  'ac', 'afc', 'as', 'bk', 'bsc', 'cd', 'cf', 'fc', 'fsv', 'if', 'rc', 'rcd',
  'sc', 'sd', 'sk', 'ss', 'ssc', 'sv', 'tsg', 'ud', 'us', 'vfb', 'vfl',
]);

/** Le nom reduit : la clef normalisee, moins ses abreviations de club. */
function reduit(sport, equipe) {
  const k = cle(sport, equipe);
  const i = k.indexOf(':');
  const mots = k.slice(i + 1).split(' ').filter((m) => m && !AFFIXES.has(m));
  /* Un nom qui ne serait QUE des abreviations n'est pas un nom : on rend la
     forme d'origine plutot qu'une chaine vide, qui tomberait sur n'importe
     quoi. */
  return k.slice(0, i + 1) + (mots.length ? mots.join(' ') : k.slice(i + 1));
}

/* L'index des formes reduites, construit une fois par lot de notes. Les clefs
   de service — celles qui commencent par un souligne, comme `_alias` — n'en
   font pas partie : ce ne sont pas des equipes. */
let INDEX_REDUIT = null, INDEX_POUR = null;
function indexReduit() {
  const n = notes();
  if (INDEX_REDUIT && INDEX_POUR === n) return INDEX_REDUIT;
  const idx = Object.create(null);
  for (const k of Object.keys(n)) {
    if (k.charAt(0) === '_') continue;
    const i = k.indexOf(':');
    if (i < 0) continue;
    const r = reduit(k.slice(0, i), k.slice(i + 1));
    (idx[r] || (idx[r] = [])).push(k);
  }
  INDEX_REDUIT = idx; INDEX_POUR = n;
  return idx;
}

/**
 * La force d'une equipe, ET si on la CONNAIT.
 *
 * `connue` est la seule information qui compte au moment de coter : une force
 * par defaut n'est pas une force faible, c'est une absence d'avis, et un
 * modele sans avis ne doit pas en exprimer un.
 */
function noteDe(sport, equipe) {
  const n = notes();
  const k = cle(sport, equipe);
  if (isFinite(Number(n[k]))) return { note: Number(n[k]), connue: true, via: 'clef' };

  const alias = n._alias && n._alias[k];
  if (alias && isFinite(Number(n[alias])))
    return { note: Number(n[alias]), connue: true, via: 'alias' };

  const r = reduit(sport, equipe);
  if (isFinite(Number(n[r]))) return { note: Number(n[r]), connue: true, via: 'reduit' };

  const cands = indexReduit()[r] || [];
  /* UNE SEULE. Deux candidats veut dire qu'on ne sait pas laquelle des deux
     equipes on regarde — et deviner, ici, coute de l'argent. */
  if (cands.length === 1 && isFinite(Number(n[cands[0]])))
    return { note: Number(n[cands[0]]), connue: true, via: 'reduit' };

  return { note: NOTE_DEFAUT, connue: false,
           via: cands.length > 1 ? 'ambigu' : 'inconnue', candidats: cands };
}

/** La force d'une equipe. Inconnue vaut 1500 — voir `noteDe` pour le savoir. */
function note(sport, equipe) {
  return noteDe(sport, equipe).note;
}

/**
 * Les deux equipes sont-elles connues ? Rend `null` si oui, et sinon la
 * raison, en clair, prete a etre lue dans un journal d'import.
 */
function pourquoiPasCotable(sport, domicile, exterieur) {
  const a = noteDe(sport, domicile), b = noteDe(sport, exterieur);
  const manque = [];
  if (!a.connue) manque.push(`${domicile} (${a.via}${a.candidats && a.candidats.length ? ' : ' + a.candidats.join(', ') : ''})`);
  if (!b.connue) manque.push(`${exterieur} (${b.via}${b.candidats && b.candidats.length ? ' : ' + b.candidats.join(', ') : ''})`);
  if (!manque.length) return null;
  return `force inconnue pour ${manque.join(' et ')} — sans force, une cote`
       + ' fabriquee serait un chiffre invente';
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
      /* ---- LE RABOT PASSE APRES, ET C'EST TOUT L'ORDRE QUI COMPTE ----
         Pose AVANT la mesure, il fournissait de la marge a bon compte sur
         deux ou trois issues, la boucle s'arretait des le premier essai avec
         `m` encore a sa valeur de depart, et TOUTES les autres cotes
         restaient longues. Mesure de cette version ratee : 24 scores exacts
         devenus perdants pour la maison, le pire a 125 %. Le rabot n'est pas
         une source de marge, c'est un garde-fou : l'exposant fait son travail
         d'abord, le rabot ne coupe que ce qui depasse encore. */
      const fin = raboteIssues(c, p, iss);
      let courte = Infinity;
      for (const i of iss) courte = Math.min(courte, fin[i]);
      return { cotes: fin, marge: paris.marge(fin, sport), plusCourte: courte };
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
  /* ---- ON NE COTE PAS CE QU'ON NE CONNAIT PAS ----
   * C'est la porte par laquelle « AS Monaco » est sorti a 5,04 alors que le
   * marche entier le donnait a 2,2 : le nom ne tombait sur aucune force, la
   * valeur par defaut prenait sa place, et plus rien ne distinguait « equipe
   * moyenne » de « equipe qu'on ne sait pas lire ». */
  const refus = pourquoiPasCotable(sport, domicile, exterieur);
  if (refus) throw new Error(`cotes : ${domicile} v ${exterieur} — ${refus}`);
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
  /* ---- ET SURTOUT PAS QUAND ON S'APPRETE A LA FABRIQUER ----
   * Une cote RELEVEE chez un fournisseur reste valable meme si l'on ne sait
   * rien des deux equipes : c'est quelqu'un d'autre qui l'a etablie, et les
   * marches derives se calent alors sur elle. Ce qu'on refuse, c'est
   * d'INVENTER un 1-N-2 a partir d'une force qu'on n'a pas. */
  if (!garde) {
    const refus = pourquoiPasCotable(m.sport, m.domicile, m.exterieur);
    if (refus) throw new Error(`cotes : ${m.domicile} v ${m.exterieur} — ${refus}`);
  }
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

/**
 * Les rencontres d'un catalogue dont une equipe n'a pas de force.
 *
 * Sert a l'audit : c'est la liste des noms a ajouter dans `paris_notes.json`,
 * ou a relier par un alias. Une rencontre DEJA cotee a la main y figure aussi
 * — sa cote est bonne, mais ses marches derives, eux, sortent du modele.
 */
function sansForce(cat) {
  const out = [];
  for (const m of (cat && cat.matchs) || []) {
    const r = pourquoiPasCotable(m.sport, m.domicile, m.exterieur);
    if (r) out.push({ id: m.id, sport: m.sport, domicile: m.domicile,
                      exterieur: m.exterieur, raison: r });
  }
  return out;
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
 * ---- LA CORRECTION DE DIXON-COLES, ET POURQUOI ELLE EST LA MAINTENANT ----
 *
 * Deux lois de Poisson independantes sous-estiment les tres petits scores :
 * dans la vraie vie, 0-0 et 1-1 arrivent plus souvent que le produit ne le
 * dit. Ce fichier a longtemps porte l'aveu que la correction usuelle —
 * Dixon-Coles — n'etait pas appliquee « parce qu'elle demande un parametre
 * estime sur des milliers de matchs qu'on n'a pas ».
 *
 * C'ETAIT UN RAISONNEMENT FAUX, ET IL COUTAIT DE L'ARGENT. Ne pas appliquer
 * la correction n'est pas s'abstenir de choisir un parametre : c'est en
 * choisir un, `rho = 0`, et c'est le seul dont on sache avec certitude qu'il
 * est faux. La mesure, faite sur nos propres cotes :
 *
 *     PSG v Angers      0-0 offert a 40,80   retour du parieur  109,8 %
 *     Barcelona v Alaves 0-0 offert a 45,63  retour du parieur  114,4 %
 *     Bayern v Augsburg  0-0 offert a 47,36  retour du parieur  115,3 %
 *
 * Autrement dit : sur toute affiche a gros favori, le 0-0 etait un pari que
 * la maison PERD a la longue, et de dix a quinze pour cent. Plus le favori
 * etait ecrasant, plus la fuite etait large — parce que le produit de deux
 * Poisson tres desequilibrees ecrase le 0-0 encore plus que d'habitude.
 *
 * On applique donc `rho = -0,13`, la valeur publiee par Dixon et Coles et
 * retrouvee depuis sur d'autres championnats et d'autres epoques. Elle n'est
 * pas estimee sur NOS matchs — on n'en a pas — mais une valeur de la
 * litterature vaut mieux qu'une valeur dont on sait qu'elle est fausse.
 *
 * La correction ne touche QUE quatre cases : 0-0 et 1-1 montent, 0-1 et 1-0
 * baissent, et on renormalise. Elle est posee dans la grille elle-meme, donc
 * les six marches en heritent ensemble et ne peuvent toujours pas se
 * contredire — c'est la propriete a laquelle il ne faut pas toucher.
 *
 * ---- CE QUE LE MODELE IGNORE ENCORE ----
 *
 * Un Elo ignore les blessures, la forme, un gardien suspendu. La marge est la
 * pour absorber cette ignorance. Mais elle ne l'absorbait pas la ou il
 * fallait : voir `MARGE_ISSUE_MIN` plus bas.
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

/* Le parametre de Dixon-Coles. Negatif : il REMONTE 0-0 et 1-1 et abaisse
   0-1 et 1-0. La valeur publiee tourne autour de -0,13 selon le championnat
   et l'epoque ; on prend celle-la. */
const RHO = -0.13;

/* ---- ON NE PARIE PAS SUR LA VALEUR DE RHO ----
 * Prendre -0,13 corrige le 0-0, qui etait la grosse fuite. Mais si la verite
 * etait rho = 0, la correction rendrait le 0-1 et le 1-0 trop longs a leur
 * tour : mesure, 113 % de retour au parieur sur un 0-1 offert a la cote
 * plafond. Choisir une valeur, c'est se tromper d'un cote ou de l'autre.
 *
 * On ne choisit donc pas pour le GARDE-FOU. Le marche reste construit sur
 * -0,13 — il faut bien une grille, et c'est la meilleure estimation — mais
 * aucune cote ne depasse ce que le rho le plus defavorable de la plage
 * autoriserait. Le prix est prudent contre toute la plage, pas juste contre
 * un pari sur son milieu. */
const RHO_PLAGE = [0, -0.08, -0.13, -0.18];

/** Pour chaque score, la probabilite la PLUS FORTE sur toute la plage de rho.
 *  C'est la borne contre laquelle le rabot travaille : si aucun rho plausible
 *  ne rend ce score plus probable que ca, aucun ne rend la cote perdante. */
function scoresPrudents(lh, la) {
  const out = {};
  for (const s of paris.SCORES) out[s] = 0;
  for (const r of RHO_PLAGE) {
    const g = grilleDesScores(lh, la, r);
    const e = {};
    for (const s of paris.SCORES) e[s] = 0;
    for (let i = 0; i <= BUTS_MAX; i++)
      for (let j = 0; j <= BUTS_MAX; j++) {
        const cle = i + '-' + j;
        if (e[cle] !== undefined) e[cle] += g[i][j]; else e.autre += g[i][j];
      }
    for (const s of paris.SCORES) if (e[s] > out[s]) out[s] = e[s];
  }
  return out;
}

/** La grille des scores : `g[i][j]` = probabilite de i buts a j. */
function grilleDesScores(lh, la, rho) {
  const r = (rho === undefined) ? RHO : Number(rho) || 0;
  const ph = [], pa = [];
  for (let i = 0; i <= BUTS_MAX; i++) { ph.push(poisson(lh, i)); pa.push(poisson(la, i)); }
  const g = [];
  for (let i = 0; i <= BUTS_MAX; i++) {
    const t = [];
    for (let j = 0; j <= BUTS_MAX; j++) t.push(ph[i] * pa[j]);
    g.push(t);
  }
  if (r) {
    /* Les quatre cases de Dixon-Coles. Le facteur est BORNE a rester
       positif : au-dela de lh = 1/|rho|, soit 7,7 buts attendus, la formule
       rendrait une probabilite negative. `ajusteButs` ne monte jamais si
       haut (son plafond est 6 buts au total), mais une borne qui ne sert
       jamais coute moins cher qu'une probabilite negative qui sort une fois. */
    const bornee = (x) => Math.max(0.05, x);
    g[0][0] *= bornee(1 - lh * la * r);
    g[0][1] *= bornee(1 + lh * r);
    g[1][0] *= bornee(1 + la * r);
    g[1][1] *= bornee(1 - r);
    let s = 0;
    for (let i = 0; i <= BUTS_MAX; i++) for (let j = 0; j <= BUTS_MAX; j++) s += g[i][j];
    if (s > 0) for (let i = 0; i <= BUTS_MAX; i++) for (let j = 0; j <= BUTS_MAX; j++) g[i][j] /= s;
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
  let T = (bas + haut) / 2;
  /* ==================== LE TOTAL NE PEUT PAS ETRE N'IMPORTE QUOI ====================
   *
   * « Tous les bookmakers proposaient Barcelone a 1,1, nous 1,5 » et « les
   * cotes du score exact beaucoup trop hautes. » Les deux avaient la meme
   * cause, et elle est ici.
   *
   * Cette dichotomie cherche le nombre de buts qui reproduit NOTRE nul. Quand
   * ce nul est un peu trop bas — et il l'est, la courbe decroit trop vite —
   * le seul moyen de le reproduire est d'ajouter des buts. Releve avant
   * correction, sur six affiches :
   *
   *     Getafe - Alaves          3,74 buts attendus   « plus de 2,5 » a 72 %
   *     Malaga - Bolton          3,97                                  76 %
   *     Arsenal - Ajax           4,69                                  85 %
   *     Barcelone - Alaves       4,62                                  84 %
   *
   * Un match de football en produit 2,7 en moyenne, et 4,0 sur les affiches
   * les plus desequilibrees. A 4,6, le modele n'ecrit plus un match : il
   * ecrit un handball. Et TOUT ce qui descend de la grille suit — « plus de
   * 2,5 » offert a 1,12 quand il vaut 1,9, un « moins de 2,5 » a 4,34 qui
   * rapporte, et un 2-0 a 12,86 la ou le marche affiche 7,5. La maison ne
   * perdait pas en moyenne : elle affichait des prix faux, et un parieur qui
   * compare prend exactement le cote qui paie.
   *
   * On borne donc le total a ce qu'un match produit vraiment, en gardant le
   * RAPPORT trouve — c'est-a-dire en gardant qui est favori, et de combien.
   * Ce que l'on perd : la grille ne reproduit plus exactement notre nul. Ce
   * que l'on gagne : elle decrit un match qui existe. Entre un modele qui
   * colle a un chiffre et un modele qui decrit la realite, c'est la realite
   * qui paie les factures.
   *
   * Les bornes ne sont pas choisies au doigt : 1,9 et 3,6 encadrent ce qu'on
   * observe en championnat, moyenne 2,7. */
  const TOTAL_PLANCHER = 1.9, TOTAL_PLAFOND = 3.6;
  if (T > TOTAL_PLAFOND) T = TOTAL_PLAFOND;
  else if (T < TOTAL_PLANCHER) T = TOTAL_PLANCHER;
  const x = partPour(T);
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
/* `pPrudent` — quand il est fourni — ne sert QU'au rabot : le marche reste
   construit sur `p`, donc il continue de dire la meme chose que les cinq
   autres, mais aucune cote ne depasse ce que la version la plus pessimiste du
   modele autoriserait. Voir `scoresPrudents`. */
function habilleUnMarche(p, iss, couverture, margeVoulue, pPrudent) {
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
    if (reelle >= paris.MARGE_MIN && plusCourte >= COTE_PLANCHER) {
      /* Le rabot APRES l'acceptation — voir `tarife` pour ce que coute
         l'ordre inverse. Il ne fait que raccourcir, donc la marge du lot ne
         peut que monter : le marche reste valide. Mais raccourcir peut faire
         passer la plus courte sous le plancher, et ca, il faut le revoir. */
      const fin = raboteIssues(c, pPrudent || p, iss, undefined, !!pPrudent);
      let courte = Infinity;
      for (const i of iss) courte = Math.min(courte, fin[i]);
      if (courte < COTE_PLANCHER) return null;
      return { cotes: fin, marge: paris.margeDe(fin, iss, couverture) };
    }
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
  /* ---- ON N'INVERSE QUE CE QUI VIENT DE DEHORS ----
   * Cette ligne inversait TOUJOURS les cotes affichees pour retrouver des
   * probabilites — y compris quand c'est nous qui venions de les fabriquer.
   * Un aller-retour sur nos propres chiffres, alors qu'on a l'original sous
   * la main.
   *
   * Tant que la pose de marge etait un pur exposant, l'aller-retour etait
   * exact et ca ne se voyait pas. Le rabot par issue l'a casse : il
   * raccourcit certaines cotes et pas d'autres, donc l'inversion ne rend plus
   * les probabilites de depart. Le modele de buts partait alors d'un 1-N-2
   * legerement faux, `ajusteButs` convergeait ailleurs, et le score exact
   * sortait a 65,87 la ou il valait 46,58 — soit un prix que la maison PERD.
   * Un garde-fou pose sur un marche avait deregle les cinq autres.
   *
   * On garde donc l'original quand il est a nous, et on n'inverse que le lot
   * releve chez un bookmaker, pour qui on n'a rien d'autre. */
  const p = (cotesBase && base === cotesBase)
    ? (probasImplicites(base, iss1, 1) || probabilites(sport, domicile, exterieur))
    : probabilites(sport, domicile, exterieur);
  if (!isFinite(p.N)) return sortie;             // deux issues : pas de buts a modeliser
  const { lh, la } = ajusteButs(p[1], p.N, p[2]);
  const tout = probasDesMarches(lh, la);
  for (const k of dispo) {
    const M = paris.MARCHES[k];
    const iss = M.issues(sport);
    const lot = habilleUnMarche(tout[k], iss, M.couverture, margeVoulue,
                                k === 'score' ? scoresPrudents(lh, la) : null);
    /* Un marche qui ne tient pas est ECARTE, pas force. La rencontre garde les
       autres — refuser tout le match parce qu'un handicap sort des bornes
       priverait de pari une affiche parfaitement cotable. */
    if (lot) sortie[k] = { cotes: lot.cotes };
  }
  return sortie;
}

module.exports = {
  noteDe, reduit, pourquoiPasCotable, sansForce,
  NOTE_DEFAUT, TERRAIN, NUL_MAX, NUL_PENTE, MARGE_DEFAUT, MARGE_PLANCHER, COTE_PLANCHER,
  MARGE_ISSUE_MIN, MARGE_ISSUE_QUEUE, plancherDe, raboteIssues, exposant, tarife, cotable,
  chargeNotes, notes, cle, note, poseNote, sauveNotes, apprend,
  probabilites, cotesDe, habille, habilleCatalogue,
  BUTS_MAX, RHO, RHO_PLAGE, scoresPrudents, poisson, grilleDesScores, issuesDeLaGrille, ajusteButs,
  probasDesMarches, habilleUnMarche, marchesDe, probasImplicites,
};
