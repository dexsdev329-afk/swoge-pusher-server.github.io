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
const ISSUES_PAR_SPORT = {
  foot: ['1', 'N', '2'],
  tennis: ['1', '2'],
  nba: ['1', '2'],
  /* Le football americain peut finir a egalite, mais c'est assez rare pour
     que tous les livres cotent en deux issues. On fait pareil : proposer un
     « nul » a 0,3 % serait un pari que personne ne prend et que le
     validateur de marge refuserait a juste titre. */
  nfl: ['1', '2'],
  /* Le cricket EN FORMAT LIMITE — Hundred, T20, ODI — se decide toujours.
     Le format TEST, lui, se termine reellement par un nul une fois sur
     trois : il n'est deliberement pas suivi, faute d'une troisieme issue
     ici. Ajouter `cricket_test_match` au calendrier sans ajouter le nul
     paierait le mauvais camp une fois sur trois. */
  cricket: ['1', '2'],
};
/* Les sports ou les deux cotes sont des EQUIPES. La distinction n'est pas
   cosmetique : « Player 1 » a la place de « Home » sur un match de NFL fait
   douter de ce sur quoi on parie, et c'est au moment de miser. */
const SPORTS_EQUIPE = ['foot', 'nba', 'nfl', 'cricket'];
const ISSUES = ISSUES_PAR_SPORT.foot;
function issues(sport) { return ISSUES_PAR_SPORT[sport] || ISSUES; }

/* ================== LES MARCHES ==================
 *
 * ---- CE QU'UN MARCHE EST ----
 *
 * Une question posee sur une rencontre, et la liste FERMEE de ses reponses.
 * « Qui gagne » en est une ; « les deux equipes marquent-elles » en est une
 * autre, posee sur le meme match et payee a d'autres gens.
 *
 * ---- POURQUOI UNE TABLE, ET UNE SEULE ----
 *
 * Chaque marche doit dire trois choses qui ne peuvent pas se contredire :
 * quelles reponses il accepte, comment il se REGLE a partir du score, et
 * combien de fois ses reponses couvrent l'espace des resultats. Eparpillees —
 * la liste ici, le reglement dans `game.js`, la marge ailleurs — elles
 * finiraient par ne plus parler du meme marche, et c'est celle qu'on oublie
 * qui paie les mauvaises personnes.
 *
 * ---- LA COUVERTURE, ET POURQUOI ELLE N'EST PAS TOUJOURS UN ----
 *
 * La marge se mesure par « somme des 1/cote, moins un ». Ce « moins un »
 * suppose que les reponses PARTAGENT l'espace : exactement une tombe. C'est
 * vrai du 1-N-2, du oui-non, du plus-moins.
 *
 * C'est FAUX de la double chance : « 1X », « 12 » et « X2 » se recouvrent —
 * chacun des trois resultats appartient a deux d'entre elles. La somme des
 * vraies probabilites vaut donc DEUX, pas un. Mesurer sa marge avec « moins
 * un » l'annoncerait a 105 % : le validateur accepterait n'importe quoi, y
 * compris un lot ou la maison perd a coup sur. Chaque marche porte donc sa
 * couverture, et la formule s'en sert.
 *
 * ---- LES LIGNES SONT DEMI-ENTIERES, ET C'EST DELIBERE ----
 *
 * Deux buts et demi, un but et demi de handicap : un total ne peut jamais
 * tomber dessus. Une ligne entiere — « plus de 2 buts » avec un match a 2 —
 * demanderait de REMBOURSER ce pari-la et lui seul, alors que le
 * remboursement ne sait aujourd'hui annuler qu'une rencontre entiere. Une
 * demi-ligne supprime le cas au lieu de le gerer.
 */

/* Les scores exacts proposes. Au-dela de trois buts par equipe on tombe sous
   le pour-cent, et seize cases plus un « autre » tiennent deja mal a l'ecran.
   « autre » est ce qui rend le marche complet : sans lui, un 4-0 ne paierait
   personne ET ne perdrait personne, ce qui n'est pas un pari. */
const SCORES = [];
for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) SCORES.push(a + '-' + b);
SCORES.push('autre');

const MARCHES = {
  '1n2': {
    nom: 'Match result', court: '1N2', couverture: 1, sports: null,
    issues: (sport) => issues(sport),
    gagne: (i, a, b) => i === resultatDuScore({ a, b }),
  },
  /* La double chance n'a de sens que la ou il y a TROIS issues : sur un sport
     qui n'en a que deux, « 12 » couvre tout et se paierait a coup sur. */
  dc: {
    nom: 'Double chance', court: 'DC', couverture: 2, sports: ['foot'],
    issues: () => ['1X', '12', 'X2'],
    gagne: (i, a, b) => {
      const r = resultatDuScore({ a, b });
      return i === '1X' ? (r === '1' || r === 'N')
           : i === '12' ? (r === '1' || r === '2')
                        : (r === 'N' || r === '2');
    },
  },
  btts: {
    nom: 'Both teams to score', court: 'BTTS', couverture: 1, sports: ['foot'],
    issues: () => ['oui', 'non'],
    gagne: (i, a, b) => ((a > 0 && b > 0) === (i === 'oui')),
  },
  ou25: {
    nom: 'Total goals', court: 'O/U 2.5', couverture: 1, sports: ['foot'], ligne: 2.5,
    issues: () => ['plus', 'moins'],
    gagne: (i, a, b) => ((a + b > 2.5) === (i === 'plus')),
  },
  score: {
    nom: 'Correct score', court: 'Score', couverture: 1, sports: ['foot'],
    issues: () => SCORES.slice(),
    gagne: (i, a, b) => {
      const s = a + '-' + b;
      return i === 'autre' ? SCORES.indexOf(s) < 0 : i === s;
    },
  },
  /* Le handicap porte TOUJOURS sur l'equipe a domicile, moins un but et demi.
     Une ligne qui suivrait le favori demanderait de dire de quel cote elle
     penche, en plus de sa valeur : deux champs a tenir d'accord pour une
     question qui a une reponse fixe. Quand le domicile est l'outsider, la
     cote le dit toute seule. */
  hand: {
    nom: 'Handicap', court: 'H -1.5', couverture: 1, sports: ['foot'], ligne: 1.5,
    issues: () => ['1', '2'],
    gagne: (i, a, b) => (i === '1' ? (a - b) >= 2 : (a - b) <= 1),
  },
};
const MARCHE_BASE = '1n2';

/** Les marches proposables sur ce sport. Le 1-N-2 vient toujours en tete. */
function marchesDuSport(sport) {
  return Object.keys(MARCHES).filter((k) => {
    const M = MARCHES[k];
    return !M.sports || M.sports.indexOf(String(sport)) >= 0;
  });
}

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

/**
 * LA MARGE D'UN LOT DE COTES, en fraction (0,099 = 9,9 %).
 *
 * `couverture` est le nombre de fois que les reponses couvrent l'espace des
 * resultats : un pour un marche ou exactement une reponse tombe, deux pour la
 * double chance dont les reponses se recouvrent. Le prendre pour un
 * systematiquement annoncerait la double chance a 105 % de marge et laisserait
 * passer un lot ou la maison perd a coup sur.
 */
function margeDe(cotes, iss, couverture) {
  let s = 0;
  for (const i of iss) s += 1 / cotes[i];
  return s - (Number(couverture) || 1);
}

/** La marge du 1-N-2 d'un sport. Un raccourci sur `margeDe`, pas un second
 *  calcul : deux formules de marge finiraient par ne plus rendre le meme
 *  chiffre, et c'est celle qu'on ne relit pas qui laisse passer le mauvais lot. */
function marge(cotes, sport) {
  return margeDe(cotes, issues(sport), 1);
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

    /* ---- LES MARCHES ----
     * Un match en portait UN, ecrit a plat sous `cotes`. Il en porte
     * plusieurs, et le 1-N-2 n'est que le premier d'entre eux.
     * L'ANCIENNE FORME EST RELUE : un catalogue qui porte `cotes` a plat
     * decrit son 1-N-2, et rien d'autre. Aucune migration a lancer, aucun
     * fichier a reecrire — le jour ou l'import ecrira des marches, ils seront
     * lus tels quels.
     * Une seule forme VIT ensuite : `cotes` a plat ne survit pas a la lecture.
     * Deux endroits ou lire la cote du « 1 », c'est un endroit de trop. */
    const brutMarches = (m.marches && typeof m.marches === 'object')
      ? m.marches
      : { [MARCHE_BASE]: { cotes: m.cotes } };
    const marches = {};
    for (const cle of Object.keys(brutMarches)) {
      const M = MARCHES[cle];
      if (!M) throw new Error(`paris : marche inconnu « ${cle} » sur « ${id} »`);
      if (M.sports && M.sports.indexOf(m.sport) < 0)
        throw new Error(`paris : le marche « ${cle} » n existe pas en ${m.sport} (« ${id} »)`);
      const iss = M.issues(m.sport);
      const brut = brutMarches[cle] || {};
      const src = brut.cotes || brut;
      const cotes = {};
      for (const i of iss) {
        const c = nombre(src && src[i], `cote « ${cle}.${i} »`, id);
        if (c < COTE_MIN || c > COTE_MAX)
          throw new Error(`paris : cote « ${cle}.${i} » hors bornes sur « ${id} » (${c})`);
        cotes[i] = c;
      }
      const mgm = margeDe(cotes, iss, M.couverture);
      if (mgm < MARGE_MIN)
        throw new Error(`paris : marge trop faible sur « ${id} » marche « ${cle} » ` +
                        `(${(mgm * 100).toFixed(2)} %) — une cote a probablement ete ` +
                        'recopiee de travers');
      marches[cle] = { cotes, marge: mgm, issues: iss, couverture: M.couverture };
    }
    /* Le 1-N-2 est OBLIGATOIRE. C'est le seul marche que tout sport porte, et
       c'est celui dont le reglement deduit tous les autres : un match sans lui
       serait affichable et impossible a trancher. */
    if (!marches[MARCHE_BASE])
      throw new Error(`paris : « ${id} » n a pas de marche « ${MARCHE_BASE} »`);
    const mg = marches[MARCHE_BASE].marge;

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
      debut, marches, marge: mg, issues: issues(m.sport),
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

/* ---- OU VIT LE CATALOGUE ----
 *
 * Deux fichiers, et la distinction porte de l'argent.
 *
 *   • celui du DEPOT est une amorce : les rencontres ecrites a la main, celles
 *     qui partent dans l'image Docker. Il ne bouge qu'avec un commit.
 *   • celui du VOLUME est le vrai calendrier : c'est la que l'import ecrit,
 *     et c'est le seul qui survive a un redeploiement.
 *
 * L'import ecrivait dans le dossier de l'application — donc dans le systeme de
 * fichiers du conteneur, efface a chaque redemarrage. Le calendrier revenait
 * alors a l'amorce du depot, et TOUTE rencontre importee disparaissait avec.
 * Une rencontre disparue n'est pas une gene d'affichage : un pari porte
 * l'identifiant de son match, `regleMatch` jette « unknown match », la
 * rencontre ne remonte plus dans « a regler » — et le gagnant ne peut plus
 * etre paye. C'est exactement ce qui est arrive a la Liga du 17 aout.
 *
 * On lit donc le volume des qu'il existe, l'amorce sinon. La bascule se fait
 * toute seule au premier import reussi.
 */
const FICHIER_DEPOT = path.join(__dirname, 'paris_catalogue.json');
const DOSSIER_DONNEES = (process.env.DATA_DIR || './data').trim();
const FICHIER_VOLUME = path.join(DOSSIER_DONNEES, 'paris_catalogue.json');
/** Le fichier a LIRE : le volume s'il est deja ecrit, l'amorce du depot sinon. */
function fichier() {
  try { if (fs.existsSync(FICHIER_VOLUME)) return FICHIER_VOLUME; } catch (e) {}
  return FICHIER_DEPOT;
}

let CAT = null;
function charge(f0) {
  const f = f0 || fichier();
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

/* ================== LE SCORE, ET CE QU'ON EN DEDUIT ==================
 *
 * ---- POURQUOI LE SCORE ET NON LE RESULTAT ----
 *
 * Le reglement recevait « 1 », « N » ou « 2 ». C'etait suffisant tant qu'un
 * match ne portait qu'un seul pari possible — celui-la meme. Des qu'on veut
 * proposer « les deux equipes marquent » ou « plus de deux buts et demi », le
 * resultat ne suffit plus : un 1-0 et un 3-2 donnent tous deux « 1 » et ne
 * paient pas les memes gens.
 *
 * Le score, lui, decide de TOUT. Le resultat s'en deduit, jamais l'inverse —
 * c'est la seule facon d'avoir un unique endroit ou l'on dit ce qui s'est
 * passé sur le terrain. Deux champs independants finiraient par se
 * contredire, et le jour ou ils se contrediraient l'un des deux paierait les
 * mauvaises personnes.
 *
 * ---- ET LA DONNEE EST DEJA LA ----
 *
 * Le fournisseur de scores rend le score exact depuis le premier jour :
 * `paris_import.js` le lit, l'affiche — « Arsenal 2-1 Chelsea » — puis
 * n'en garde que la lettre. On arrete de le jeter.
 */

/** Un score « 2-1 » en `{a, b}`, ou `null` si ce n'en est pas un. */
function scoreLu(x) {
  const m = /^\s*(\d{1,3})\s*-\s*(\d{1,3})\s*$/.exec(String(x == null ? '' : x));
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  /* Trois chiffres suffisent au cricket et debordent partout ailleurs. Un
     score a quatre chiffres est une faute de frappe, pas un match. */
  if (!isFinite(a) || !isFinite(b)) return null;
  return { a, b };
}

/** Le 1-N-2 d'un score. C'est une DEDUCTION, jamais une donnee a part. */
function resultatDuScore(s) {
  return s.a > s.b ? '1' : s.b > s.a ? '2' : 'N';
}

/** Ce qu'une mise rapporterait, mise comprise. */
function rapport(cote, mise) {
  return Math.floor(Number(cote) * Number(mise) * 1e6) / 1e6;
}

/**
 * LA COTE D'UNE REPONSE, ou `null` si le match ne porte pas ce marche.
 *
 * Passer par ici plutot que de fouiller `m.marches[c].cotes[i]` a chaque
 * endroit : le jour ou la structure bouge, elle ne bouge qu'ici.
 */
function coteDe(m, cle, issue) {
  const M = m && m.marches && m.marches[cle || MARCHE_BASE];
  const c = M && M.cotes[issue];
  return isFinite(c) ? c : null;
}

/**
 * CETTE REPONSE GAGNE-T-ELLE SUR CE SCORE ?
 *
 * Le seul juge, et il ne connait que le score. C'est ce qui garantit que deux
 * marches ne peuvent pas se contredire sur la meme rencontre : ils lisent le
 * meme couple de nombres.
 */
function gagne(cle, issue, score) {
  const M = MARCHES[cle || MARCHE_BASE];
  if (!M || !score) return false;
  return !!M.gagne(String(issue), Number(score.a), Number(score.b));
}

/** La vue publique d'un match, pour la page. */
function vue(m, now) {
  return {
    id: m.id, sport: m.sport, competition: m.competition, pays: m.pays,
    domicile: m.domicile, exterieur: m.exterieur,
    paysDomicile: m.paysDomicile, paysExterieur: m.paysExterieur,
    debut: m.debut, issues: m.issues,
    /* Les marches partent EN ENTIER : la page en affiche autant qu'elle en
       sait dessiner, et celle qui n'en connait qu'un ignore le reste sans
       rien casser. */
    marches: m.marches,
    ouvert: m.debut > (now || Date.now()),
  };
}

module.exports = {
  ISSUES, ISSUES_PAR_SPORT, SPORTS_EQUIPE, issues, COTE_MIN, COTE_MAX, MARGE_MIN,
  charge, catalogue, match, ouverts, rapport, vue, marge, margeDe, valide,
  scoreLu, resultatDuScore,
  MARCHES, MARCHE_BASE, SCORES, marchesDuSport, coteDe, gagne,
  FICHIER_DEPOT, FICHIER_VOLUME, fichier,
};
