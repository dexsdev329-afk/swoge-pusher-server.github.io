'use strict';
/*
 * ALIMENTER LE CALENDRIER DEPUIS THE ODDS API — SANS BRULER LE QUOTA.
 *
 * ---- le probleme, chiffre ----
 *
 * Le forfait gratuit donne 500 credits. Il faut tenir jusqu'a une date fixe.
 * Une seule erreur de conception — appeler l'endpoint des cotes a chaque
 * rafraichissement — vide le compteur en une semaine, et le calendrier se fige
 * sans que personne ne s'en apercoive avant qu'un joueur ne le signale.
 *
 * ---- ce qui coute, et ce qui ne coute rien ----
 *
 * The Odds API facture par ENDPOINT, et deux d'entre eux sont GRATUITS :
 *
 *   GET /v4/sports                          0 credit
 *   GET /v4/sports/{sport}/events           0 credit   <- les rencontres !
 *   GET /v4/sports/{sport}/odds             [marches] x [regions] credits
 *   GET /v4/sports/{sport}/scores           1, ou 2 avec `daysFrom`
 *   /v4/historical/...                      10 x [marches] x [regions]
 *
 * La ligne qui change tout est la deuxieme. Les RENCONTRES ne coutent rien :
 * equipes, competition, coup d'envoi, identifiant. C'est exactement ce dont ce
 * site a besoin, et c'est justement ce qui a ete demande — « je ne veux pas
 * forcement les cotes, juste les matchs ». Les cotes, on les FABRIQUE, dans
 * `cotes.js`, a partir d'un Elo par equipe.
 *
 * Il reste donc deux depenses, et deux seulement :
 *
 *   • les SCORES, pour regler les paris. 2 credits par sport et par passage
 *     avec `daysFrom=3`, le maximum de cet endpoint — et la MEME fenetre que
 *     celle qu'on filtre. En demander moins pour le meme prix laissait des
 *     paris en attente indefiniment.
 *   • l'ETALONNAGE, facultatif. Une fois par semaine, on releve les vraies
 *     cotes d'un sport (1 credit) et on s'en sert pour recaler les forces Elo.
 *     Sans ca, le modele ne se corrige jamais.
 *
 * ---- le garde-fou ----
 *
 * Chaque reponse porte `x-requests-remaining`. On la lit, on la garde, et
 * avant CHAQUE appel payant on compare ce qui reste au nombre de jours qui
 * restent. Si la depense du jour depasse la part du jour, on refuse et on le
 * dit. Un quota qui s'epuise doit s'arreter tout seul : compter sur quelqu'un
 * pour surveiller un compteur, c'est le laisser filer.
 *
 * ---- comment on s'en sert ----
 *
 *   node paris_import.js --quota      ce qui reste, et la part quotidienne
 *   node paris_import.js --sports     les competitions disponibles (0 credit)
 *   node paris_import.js --matchs     recharge le calendrier   (0 credit)
 *   node paris_import.js --scores     les rencontres finies    (2 / sport)
 *   node paris_import.js --calibre    recale les forces Elo    (1 / sport)
 *   node paris_import.js --reglement  l'ombre et les /scores payes (0 credit)
 *
 * Les variables d'environnement sont decrites dans EXPLOITATION.md.
 */

const fs = require('fs');
const path = require('path');
const cotes = require('./cotes');
const espn = require('./scores_espn');
const prixMarche = require('./prix_marche');
/* La liste seule (joker du tennis, cricket refuse) : lot 3, 10/10/2026. */
const prixLigues = require('./prix_ligues');
/* Le journal des releves deja payees (lot 1 de la cle 20K, 10/10/2026) :
   abonne au crochet `apresNote`, il garde chaque reponse /odds notee, a 0
   credit, sans rien changer a ce qui se vend (prix_journal.js, EXPLOITATION
   8.8septies). Branche ici : toute releve payee passe par ce module
   (rafraichitPrix, calibre, `--prix`). PARIS_PRIX_JOURNAL=0 le coupe. */
const prixJournal = require('./prix_journal');
prixJournal.branche();
const AlerteSolde = require('./alerte_solde');   /* credits bas : alerte privee au proprietaire */
const paris = require('./paris');
/* Le carnet d'observation des sports a deux issues (lot 3, 10/10/2026) :
   chaque releve d'une cle OBSERVEE y laisse son historique (ok / refuse /
   erreur, et sa couverture) et ses prix eu avec nos cotes Elo du meme instant.
   0 credit de plus : il relit ce que la releve a deja paye. */
const prixObserve = require('./prix_observe');
/* Le journal du reglement (lot 4, 10/10/2026) : l'ombre ESPN de 2 h (ce
   qu'une passe frequente aurait regle, et quand) et le compte de chaque
   /scores paye. Il ne decide rien ; chaque note est isolee (try) : il ne peut
   jamais faire perdre un reglement (reglement_journal.js, EXPLOITATION 8.10). */
const regJournal = require('./reglement_journal');
/* Le plus/moins 2,5 au prix des totaux du marche (lot 5, 10/10/2026) :
   OBSERVATION par defaut — PARIS_TOTAUX_OBSERVE et PARIS_TOTAUX_LIGUES vides,
   aucun releve, aucun credit, rien de vendu ne change (totaux_marche.js,
   EXPLOITATION 8.8decies). */
const totauxMarche = require('./totaux_marche');

const BASE = 'https://api.the-odds-api.com/v4';
const CLE = process.env.ODDS_API_KEY || '';

/* Les competitions suivies, par sport DE CE SITE. Les clefs a droite sont
   celles de The Odds API ; `GET /v4/sports` les liste toutes, gratuitement.
   On les met dans une variable d'environnement pour pouvoir en ajouter une
   sans redeployer le code. */
/* ---- LA LISTE PAR DEFAUT, NOMMEE ----
 * Elle etait ecrite dans l'expression qui lit la variable d'environnement,
 * donc invisible des qu'on pose la variable — y compris pour un essai, qui la
 * pose toujours. Les decisions qui vivent ICI (la presaison qu'on n'ouvre pas,
 * le format Test du cricket qu'on ecarte) n'etaient donc verifiables nulle
 * part. On la nomme, et on l'expose. */
const LIGUES_DEFAUT = [
  'foot=soccer_epl',
  'foot=soccer_france_ligue_one',
  'foot=soccer_spain_la_liga',
  'foot=soccer_italy_serie_a',
  'foot=soccer_germany_bundesliga',
  'foot=soccer_uefa_champs_league',
  /* ---- LE TENNIS SUIT LES TOURNOIS TOUT SEUL ----
   * Ses cles sont par TOURNOI et meurent avec lui. Le 18 septembre 2026, les
   * deux cles de l US Open ecrites ici etaient inactives depuis dix jours :
   * le tennis — notre plus gros sport — etait vide, et rien ne le disait.
   * « * » veut dire : toutes les cles ATP et WTA actives, lues sur `/sports`
   * (0 credit) au moment de l import et relues toutes les douze heures. Les
   * cles de classement (`_winner`) sont ecartees : pas de rencontres dedans.
   * Voir `liguesEnService`. */
  'tennis=*',
  'nba=basketball_nba',
  /* ---- LA NFL, ET PAS SA PRESAISON ----
   * `americanfootball_nfl` ne porte QUE la saison reguliere. C'est un choix,
   * pas un oubli : en aout, seize matchs de presaison se jouent — mesure faite
   * — et The Odds API les range sous une clef separee qu'on pourrait ajouter
   * en une ligne.
   * On ne l'ajoute pas. Les titulaires y jouent un quart-temps, et nos cotes
   * sortent d'un Elo bati sur des equipes COMPLETES : elles n'y veulent rien
   * dire. Ouvrir un marche dont on sait que le prix est faux, c'est offrir de
   * l'argent a qui le remarque. La NFL arrive donc a la semaine 1. */
  'nfl=americanfootball_nfl',
  /* Cricket : uniquement les formats LIMITES, qui se decident toujours. Le
     format Test finit reellement par un nul une fois sur trois et n'a pas
     de troisieme issue ici — l'ajouter paierait le mauvais camp. */
  'cricket=cricket_the_hundred',
  'cricket=cricket_international_t20',
  'cricket=cricket_t20_blast',
  'cricket=cricket_odi',
  /* ---- LES TREIZE AJOUTEES LE 18 SEPTEMBRE 2026 ----
   * Choisies parmi les 84 competitions actives ce jour-la (`--sports`, 0
   * credit) sur deux criteres mesures : ESPN sert leurs scores gratuitement
   * (chemin dans `scores_espn.js`), et leurs noms d equipe se rapprochent
   * de ceux de The Odds API — exactement, ou par un ALIAS releve ce jour-la.
   * Ce qui ne remplit pas ces deux conditions n est pas suivi : un score qui
   * ne se lit pas coute 2 credits par ligue et par jour, puis un reglement a
   * la main. Ecartes pour cela : Ecosse (pas de code de pays pour le drapeau),
   * Conference League (36 clubs, 15 noms differents, six journees par an),
   * MMA (ESPN ne rend que la soiree, pas les combats).
   * Une ligue nouvelle n ouvre RIEN avant son premier etalonnage : une equipe
   * sans force n est pas cotee (`cotes.pourquoiPasCotable`), la rencontre est
   * ecartee de l import. Donc pas de cote plate a 1500 contre 1500 sur
   * Ajax – Telstar en attendant. */
  'foot=soccer_efl_champ',
  'foot=soccer_france_ligue_two',
  'foot=soccer_germany_bundesliga2',
  'foot=soccer_spain_segunda_division',
  'foot=soccer_italy_serie_b',
  'foot=soccer_netherlands_eredivisie',
  'foot=soccer_portugal_primeira_liga',
  'foot=soccer_belgium_first_div',
  'foot=soccer_turkey_super_league',
  'foot=soccer_usa_mls',
  'foot=soccer_mexico_ligamx',
  /* La NHL : `icehockey_nhl` ne porte pas la presaison, contrairement a ce
     qu on pouvait craindre apres la NFL. Mesure le 18 septembre 2026 : ses
     premieres rencontres sont du 29 septembre, et ESPN classe ce jour-la en
     saison reguliere (type 2), la presaison (type 1) s arretant le 25. */
  'nhl=icehockey_nhl',
  'mlb=baseball_mlb',
];

/* ---- LE JOKER, ET POUR QUI ----
 * « sport=* » suit toutes les cles actives du sport. Seul le tennis en a le
 * droit : ses cles tournent chaque semaine, et l on ne peut pas les ecrire.
 * Un joker au football suivrait quarante championnats d un coup, a un credit
 * d etalonnage par ligue et par semaine — c est un choix, il s ecrit ligne
 * par ligne. Les cles de classement (`_winner`) ne portent pas de
 * rencontres : ecartees. */
const JOKERS = {
  tennis: (s) => /^tennis_(atp|wta)_/.test(String(s.key)) && !/_winner$/.test(String(s.key)),
};
const LIGUES = (process.env.ODDS_API_LIGUES || LIGUES_DEFAUT.join(','))
  .split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const [sport, clef] = x.split('=');
  return { sport: (sport || '').trim(), clef: (clef || '').trim() };
}).filter((x) => x.sport && x.clef).filter((x) => {
  /* ---- UN SPORT NON DECLARE EST REFUSE ICI, ET NULLE PART PLUS LOIN ----
   * `ODDS_API_LIGUES` est une variable d'environnement : c'est la porte la
   * plus large du module, et la seule que quelqu'un ouvre pour elargir le
   * calendrier. Une ligne « hockey=icehockey_nhl » passait sans un mot, et la
   * faute ressortait bien plus tard — a la validation du catalogue, sur un
   * message qui parlait d'un identifiant de match et non de la ligne qu'on
   * venait d'ecrire.
   * On refuse donc au plus pres de la cause, en disant quoi faire. La ligue
   * est ECARTEE, pas fatale : les autres continuent d'alimenter le
   * calendrier, ce qui vaut mieux qu'un import qui refuse tout. */
  if (x.clef === '*' && !JOKERS[x.sport]) {
    console.error(`[odds] LIGUE IGNOREE « ${x.sport}=* » : le joker n existe que pour `
      + `${Object.keys(JOKERS).join(', ')} — les autres sports s ecrivent ligue par ligue.`);
    return false;
  }
  if (paris.sportConnu(x.sport)) return true;
  console.error(`[odds] LIGUE IGNOREE « ${x.sport}=${x.clef} » : le sport `
    + `« ${x.sport} » n'est pas declare. Ajoutez-le a SPORTS dans paris.js — `
    + `ses issues, son nom et son avantage du terrain tiennent en une ligne. `
    + `Connus : ${Object.keys(paris.SPORTS).join(', ')}`);
  return false;
});

/* ---- LES LIGUES REELLEMENT INTERROGEES ----
 * `LIGUES` est la liste ECRITE ; celle-ci est la liste EN SERVICE : la meme,
 * ou chaque joker est remplace par les cles actives de son sport chez The
 * Odds API. La liste des sports est gratuite ; on la relit toutes les douze
 * heures, et si elle ne repond pas on garde la derniere lue plutot que de
 * vider le tennis pour un 502 passager. */
const JOKER_TTL = 12 * 3600000;
let jokerCache = { t: 0, cles: null };
async function liguesEnService() {
  const fixes = LIGUES.filter((l) => l.clef !== '*');
  const jokers = LIGUES.filter((l) => l.clef === '*');
  if (!jokers.length) return fixes;
  if (!jokerCache.cles || Date.now() - jokerCache.t > JOKER_TTL) {
    try {
      const tous = await appel('/sports', { all: 'true' }, 0, 'sports');
      jokerCache = { t: Date.now(), cles: (tous || []).filter((s) => s && s.active && s.key) };
    } catch (e) {
      console.error('[odds] liste des sports injoignable — '
        + (jokerCache.cles ? 'on garde la derniere lue' : 'les jokers attendront') + ' : ' + e.message);
      if (!jokerCache.cles) return fixes;
    }
  }
  const deja = new Set(fixes.map((l) => l.clef));
  const out = fixes.slice();
  for (const j of jokers) {
    for (const s of jokerCache.cles) {
      if (!JOKERS[j.sport](s) || deja.has(s.key)) continue;
      deja.add(s.key);
      out.push({ sport: j.sport, clef: s.key });
    }
  }
  return out;
}

/*
 * ---- LES DRAPEAUX ----
 *
 * `/events` ne rend que des NOMS d'equipe : ni pays, ni code, ni logo. Or la
 * page affiche un drapeau a cote de chaque nom, et au tennis c'est souvent lui
 * qu'on reconnait en premier — les noms arrivent abreges, « Etcheverry T. M. »
 * ne dit rien a personne, « AR » si.
 *
 * Deux sources, dans cet ordre :
 *
 *  1. LA LIGUE. Un championnat national se joue entre clubs de son pays :
 *     tout ce qui est en Ligue 1 est francais, sans exception. C'est exact
 *     pour les cinq championnats suivis, et ca ne demande aucune saisie.
 *
 *  2. UNE TABLE, pour le reste. La Ligue des champions melange les pays, et
 *     le tennis n'a pas de « pays de la competition » qui vaille pour les
 *     joueurs. `paris_pays.json` fait la correspondance nom → code ISO, et
 *     s'edite a la main : une ligne par joueur ou par club, ajoutee quand on
 *     la croise.
 *
 * Un pays inconnu vaut `null`, PAS un drapeau au hasard. La page n'affiche
 * alors rien — ce qui est honnete — la ou un mauvais drapeau serait pris pour
 * une information.
 */
/* Les competitions dont TOUS les participants sont d'un meme pays. */
const PAYS_LIGUE = {
  soccer_epl: 'GB', soccer_efl_champ: 'GB', soccer_england_league1: 'GB',
  soccer_france_ligue_one: 'FR', soccer_france_ligue_two: 'FR',
  soccer_spain_la_liga: 'ES', soccer_spain_segunda_division: 'ES',
  soccer_italy_serie_a: 'IT', soccer_italy_serie_b: 'IT',
  soccer_germany_bundesliga: 'DE', soccer_germany_bundesliga2: 'DE',
  soccer_netherlands_eredivisie: 'NL', soccer_portugal_primeira_liga: 'PT',
  soccer_belgium_first_div: 'BE', soccer_turkey_super_league: 'TR',
  soccer_usa_mls: 'US', soccer_mexico_ligamx: 'MX',
  basketball_nba: 'US', americanfootball_nfl: 'US',
  /* NHL et MLB : la ligue est americaine, sept clubs de hockey et un de
     baseball sont canadiens — ceux-la sont dans `paris_pays.json`, qui
     passe avant la ligue. */
  icehockey_nhl: 'US', baseball_mlb: 'US',
  cricket_t20_blast: 'GB', cricket_the_hundred: 'GB',
};
/* Le nom du pays, pour le champ `pays` de la rencontre. */
const NOM_PAYS = {
  GB: 'England', FR: 'France', ES: 'Spain', IT: 'Italy', DE: 'Germany',
  NL: 'Netherlands', PT: 'Portugal', BE: 'Belgium', TR: 'Turkey', US: 'USA',
  MX: 'Mexico',
};

const FICHIER_PAYS = path.join(__dirname, 'paris_pays.json');
let PAYS = null;
function chargePays(fichier) {
  try { PAYS = JSON.parse(fs.readFileSync(fichier || FICHIER_PAYS, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; PAYS = {}; }
  return PAYS;
}
/* La meme normalisation que pour les forces Elo : « Paris SG » et
   « PARIS  sg » doivent tomber sur la meme entree. */
function clePays(nom) {
  return String(nom || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
/** Le code ISO d'une equipe ou d'un joueur, ou null. */
function paysDe(nom, ligue) {
  if (!PAYS) chargePays();
  const t = PAYS[clePays(nom)];
  if (/^[A-Z]{2}$/.test(String(t || ''))) return t;
  const l = PAYS_LIGUE[ligue];
  return /^[A-Z]{2}$/.test(String(l || '')) ? l : null;
}

/* La region et le marche pour l'etalonnage. UN de chaque : le cout est le
   produit des deux, donc deux regions coutent deux fois plus cher pour une
   information qu'on utilise a peine. */
const REGION = process.env.ODDS_API_REGION || 'eu';
const MARCHE = 'h2h';                       // 1 x 2 — le seul marche du site

/* Le budget. `ODDS_API_FIN` est la date jusqu'a laquelle le quota doit tenir ;
   `ODDS_API_TOTAL` n'est la que pour le premier appel, avant qu'on ait lu un
   `x-requests-remaining` du serveur. */
/* ---- ET CETTE DATE NE PEUT PAS ETRE UN JOUR ECRIT EN DUR ----
 *
 * Elle valait `2026-09-30`. Le forfait, lui, se recharge au premier du mois :
 * le 1er octobre, `joursRestants()` serait retombe a son plancher de 1, et
 * `partDuJour` — 90 % de ce qui reste divise par le nombre de jours — aurait
 * autorise QUATRE CENT CINQUANTE credits dans la journee. Le garde-fou ne
 * refuse rien de faux dans ce cas : il cesse simplement de garder, en silence,
 * et le premier mois ou une ligue s'ajoute il laisse tout partir en un jour.
 *
 * Ce fichier dit lui-meme, vingt lignes plus haut, pourquoi c'est inacceptable
 * ici : « un quota qui s'epuise doit s'arreter tout seul ; compter sur
 * quelqu'un pour surveiller un compteur, c'est le laisser filer. » Une date
 * qu'il faut repousser a la main chaque mois est exactement ce compteur-la.
 *
 * Elle se calcule donc, et sur la meme horloge que le fournisseur : la fin du
 * mois EN COURS, en temps universel, relue a chaque appel. `ODDS_API_FIN`
 * reste prioritaire pour qui veut viser une autre date — un tournoi, un essai
 * — mais plus rien n'expire tout seul quand personne ne regarde. */
function finDuMois(t) {
  const d = new Date(t === undefined ? Date.now() : t);
  /* Le jour 0 du mois SUIVANT est le dernier du mois courant, y compris en
     fevrier et les annees bissextiles : c'est le calendrier qui compte, pas
     une table. */
  const f = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return f.toISOString().slice(0, 10);
}
/* ---- ET UNE DATE POSEE QUI EST DEJA PASSEE NE COMPTE PAS (08/10/2026) ----
 * Le code calculait la fin du mois, mais la VARIABLE etait restee posee sur
 * Railway : le journal du 08/10 disait « 469 credit(s), part du jour 422
 * jusqu au 2026-09-30 ». Exactement la panne decrite au-dessus, arrivee par
 * l'autre porte — 90 % du solde autorise en un jour, sans un mot. Une echeance
 * passee (ou illisible) ne vise plus rien : on retombe sur la fin du mois, et
 * on le dit une fois au journal pour que quelqu'un retire la variable. */
let finIgnoreeDite = null;
function fin() {
  const posee = process.env.ODDS_API_FIN;
  if (!posee) return finDuMois();
  const aujourdhui = new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(posee) && isFinite(Date.parse(posee + 'T23:59:59Z')) && posee >= aujourdhui) return posee;
  if (finIgnoreeDite !== posee) {
    finIgnoreeDite = posee;
    console.log(`[odds] ODDS_API_FIN=${posee} est passee ou illisible : ignoree, le quota se rationne jusqu a la fin du mois (${finDuMois()}). Retirer la variable.`);
  }
  return finDuMois();
}
const TOTAL = Number(process.env.ODDS_API_TOTAL || 500);
/* Combien de jours a l'avance on regarde. Au-dela, les rencontres bougent
   encore et la moitie n'a pas d'adversaire connu (tennis). */
const HORIZON_JOURS = Number(process.env.ODDS_API_HORIZON || 7);

const FICHIER_QUOTA = path.join(process.env.DATA_DIR || __dirname, 'odds_quota.json');
/* On ECRIT sur le volume, on LIT ce qui existe. Ecrire dans le dossier de
   l'application revenait a jeter le calendrier a chaque redeploiement : les
   rencontres importees disparaissaient, et avec elles la possibilite de
   REGLER les paris poses dessus. Voir le commentaire de `paris.js`. */
const FICHIER_CAT = paris.FICHIER_VOLUME;

// ------------------------------------------------------------- le compteur

/* ---- UN COMPTEUR ILLISIBLE SE DIT (socle, 10/10/2026) ----
 * Absent (premier demarrage), le compteur repart de zero sans un mot : c'est
 * normal. ILLISIBLE (JSON coupe), il repart aussi de zero — la part du jour se
 * rouvre jusqu'a minuit — mais on le dit une fois au journal : c'est une
 * panne, pas un debut (relecture du socle). */
let quotaIlisibleDit = null;
function litQuota() {
  const neuf = () => ({ reste: TOTAL, utilise: 0, vu: null, depenseDuJour: 0, jour: null });
  let brut;
  try { brut = fs.readFileSync(FICHIER_QUOTA, 'utf8'); } catch (e) { return neuf(); }
  try { return JSON.parse(brut); }
  catch (e) {
    if (quotaIlisibleDit !== brut) {
      quotaIlisibleDit = brut;
      console.log(`[odds] compteur illisible (${FICHIER_QUOTA}, ${brut.length} octet(s)) : repart de zero, la part du jour se rouvre jusqu a la prochaine reponse du fournisseur`);
    }
    return neuf();
  }
}
/* ---- ECRIT EN DEUX TEMPS (socle, 10/10/2026) ----
 * Le socle reecrit ce fichier a chaque appel, gratuit compris, et tout le
 * garde-fou repose sur lui. Ecrit directement, un redeploiement pendant
 * l'ecriture (118 en 17 jours en septembre, voir « QUAND RELEVER ») laissait un JSON
 * coupe, relu comme un compteur neuf : depenseDuJour = 0, la part du jour
 * rouverte. Fichier temporaire puis renommage, comme le carnet des prix
 * (`prix_marche.ecris`) : le compteur est entier, l'ancien ou le nouveau. Le
 * contenu ecrit est le meme octet pour octet (essais/reference). */
function ecritQuota(q) {
  const tmp = FICHIER_QUOTA + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n'); fs.renameSync(tmp, FICHIER_QUOTA); }
  catch (e) { console.error('[odds] impossible d ecrire le compteur :', e.message); }
}
function jourCourant() { return new Date().toISOString().slice(0, 10); }
function joursRestants() {
  const t = Date.parse(fin() + 'T23:59:59Z');
  return Math.max(1, Math.ceil((t - Date.now()) / 86400000));
}
/** La part du jour : ce qu'on peut depenser aujourd'hui sans compromettre la
 *  suite. On garde 10 % de reserve pour les jours ou il faut reessayer. */
function partDuJour(reste) {
  return Math.max(1, Math.floor((reste * 0.9) / joursRestants()));
}

function etatQuota() {
  const q = litQuota();
  if (q.jour !== jourCourant()) { q.jour = jourCourant(); q.depenseDuJour = 0; }
  return q;
}

/* ---- LES QUATRE CLASSES DU GARDE-FOU (socle, 10/10/2026) ----
 *
 * Avec la cle 20K, d'autres depenses que le prix du marche arrivent (totaux,
 * deux issues, coupes, reglement, direct). Elles ne doivent JAMAIS passer
 * avant le prix de ce qui est vendu, et l'observation ne doit jamais manger
 * ce que le reglement et l'etalonnage attendent. D'ou une classe par appel,
 * passee dans `info.classe` d'`appel` :
 *   0  le prix de ce qui est VENDU : passe au-dela de la part du jour tant
 *      qu'il reste `prioritaire` x jours restants (regle du 08/10, ci-dessous) ;
 *      son refus previent le proprietaire ;
 *   1  reglement et etalonnage (/scores de repli, calibre, totaux d'une cle
 *      vendue) : jusqu'a la part du jour, comme tout appel d'avant le socle ;
 *   2  mesures datees (clotures des totaux, releve T-45 des coupes, direct) :
 *      jusqu'a la part moins 80 ;
 *   3  observation a basse cadence : jusqu'a la part moins 160.
 * Sans classe dite, rien ne change : `prioritaire` vrai = classe 0, sinon 1.
 * Un refus hors classe 0 n'alerte pas (un etalonnage refuse n'en est pas une).
 *
 * D'ou viennent 80 et 160 : plan du 09/10 (budget, « ORDRE DANS autorise() »),
 * sur la part du jour d'un debut de mois a 20 000 credits, ~600
 * (0,9 x 20 000 / 30). Les 80 laissent passer l'etalonnage (~23 credits une
 * fois par semaine) et le /scores de repli (jusqu'a ~48 par jour : il part a
 * chaque demarrage) quand la classe 2 a deja pris sa part ; la classe 3 en
 * laisse 80 de plus a la classe 2. Un samedi de vente coute ~545 (h2h ~163,
 * avant-match 43, deux issues ~29, totaux 17 au plus, direct ~290 pour trois
 * rencontres). CE NE SONT PAS ENCORE DES MESURES : aucune ligne par cause
 * n'existe avant le journal du lot 1. Les revoir sur lui (EXPLOITATION
 * 8.8sexies), jamais a l'oeil. */
const RESERVES_CLASSE = Object.freeze([0, 0, 80, 160]);
/* Une classe ecrite de travers (« 2 » en chaine, 4, -1) est un REFUS, pas une
   devinette : prise pour 0 elle passerait devant le prix vendu, prise pour 3
   elle se tairait. Le refus ne coute rien et l'essai qui l'ecrit tombe. */
function classeDe(prioritaire, classe) {
  if (classe === undefined || classe === null) return prioritaire ? 0 : 1;
  return Number.isInteger(classe) && classe >= 0 && classe < RESERVES_CLASSE.length ? classe : -1;
}

/* ---- CE QUE CHAQUE CLASSE DEPENSE, ET CE QU'ON LUI REFUSE (socle, 10/10/2026) ----
 * Les reserves 80 / 160 ne se jugent que si l'on sait, jour par jour, QUELLE
 * classe a depense et QUELLE classe a ete refusee (porte 3 d'EXPLOITATION
 * 8.8sexies : « aucun appel de classe 1 refuse un jour ou les classes 2 ou 3
 * ont depense »). Le journal du lot 1 ne voit que les reponses `/odds` notees :
 * ni un refus, ni un `/scores`, ni la classe d'un appel (relecture du socle).
 * Et apres le socle plus aucun lot ne retouche `appel` ni `autorise` : ce
 * compte ne peut naitre qu'ici. Par jour (UTC) et par classe :
 *   appels  appels payants revenus (une reponse recue, erreur comprise) ;
 *   depense credits ajoutes a `depenseDuJour` (x-requests-last, ou le cout
 *           attendu d'un appel abandonne au delai, compte par prudence) ;
 *   refus   appels payants refuses par le garde-fou (rien n'est parti) ;
 *   delais  appels abandonnes au bout de DELAI_APPEL_MS.
 * Fichier A PART (`odds_classes.json`) : `odds_quota.json` fait partie de la
 * reference octet pour octet. Ecrit en deux temps, garde 40 jours (un mois
 * entier plus la fenetre de 14 jours de la porte, sans grossir sans fin). */
const FICHIER_CLASSES = path.join(process.env.DATA_DIR || __dirname, 'odds_classes.json');
const CLASSES_JOURS = 40;
function litClasses() {
  try {
    const c = JSON.parse(fs.readFileSync(FICHIER_CLASSES, 'utf8'));
    if (c && typeof c === 'object' && c.jours && typeof c.jours === 'object') return c;
  } catch (e) { /* absent ou illisible : un compte neuf, rien de plus a faire */ }
  return { jours: {} };
}
function compteClasse(k, ajout) {
  if (!(k >= 0)) return;
  const c = litClasses();
  const j = jourCourant();
  const jour = c.jours[j] || (c.jours[j] = {});
  const ligne = jour[k] || (jour[k] = { appels: 0, depense: 0, refus: 0, delais: 0 });
  for (const [champ, n] of Object.entries(ajout)) if (n) ligne[champ] = (Number(ligne[champ]) || 0) + n;
  const gardes = new Set(Object.keys(c.jours).sort().slice(-CLASSES_JOURS));
  for (const d of Object.keys(c.jours)) if (!gardes.has(d)) delete c.jours[d];
  const tmp = FICHIER_CLASSES + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(c) + '\n'); fs.renameSync(tmp, FICHIER_CLASSES); }
  catch (e) { console.error('[odds] impossible d ecrire le compte par classe :', e.message); }
}
/* La porte 3, calculee pour ne pas la refaire a la main : les jours ou la
   classe 1 a ete refusee alors que les classes 2 ou 3 avaient depense. Elle
   ne conclut rien sous 14 jours de compte (la fenetre ecrite de la porte). */
const PORTE_RESERVES_JOURS = 14;
function etatClasses() {
  const jours = litClasses().jours;
  const n = (j, k, champ) => Number(((jours[j] || {})[k] || {})[champ]) || 0;
  const dates = Object.keys(jours).sort();
  const conflits = dates.filter((j) => n(j, 1, 'refus') > 0 && (n(j, 2, 'depense') > 0 || n(j, 3, 'depense') > 0));
  return { jours, joursComptes: dates.length, joursMin: PORTE_RESERVES_JOURS,
           classe1RefuseeQuand23Depensent: conflits,
           tiennent: dates.length < PORTE_RESERVES_JOURS ? null : conflits.length === 0 };
}

/* ---- LES CREDITS EN VOL (socle, 10/10/2026) ----
 * `autorise` lit `depenseDuJour` AVANT le `fetch`, et le cout n'y entre qu'au
 * retour. N appels partis ensemble a la limite passaient donc tous (sonde de
 * la relecture du socle : 3 en vol a limite - 1, la depense finit a
 * limite + 2). Aujourd'hui c'est borne (filePrix serialise les prix, calibre
 * et les scores sont des boucles), mais le direct (lot 7) reverifie sa
 * classe a chaque releve et compte sur ce controle. Le cout attendu d'un
 * appel accepte est donc tenu ici jusqu'a ce que sa reponse soit comptee (ou
 * qu'il echoue), et `autorise` le compte comme deja depense. Appels un par un
 * (le cas de la reference) : toujours 0, rien ne change. */
let enVolCredits = 0;

/* Avant chaque appel PAYANT. On refuse plutot que de depasser : un quota
   epuise le 5 septembre ne se recharge pas, et le calendrier se figerait
   jusqu'a la fin du mois. */
function autorise(cout, quoi, prioritaire, classe) {
  const k = classeDe(prioritaire, classe);
  if (k < 0) throw new Error(`[odds] REFUSE ${quoi} : classe ${JSON.stringify(classe)} inconnue (0 a 3)`);
  const q = etatQuota();
  const part = partDuJour(q.reste);
  if (cout > q.reste) {
    compteClasse(k, { refus: 1 });
    AlerteSolde.oddsEvenement('vide', `${quoi} refusé : ${q.reste} crédit(s) restant(s) en tout`);
    throw new Error(`[odds] REFUSE ${quoi} : ${cout} credit(s) demande(s), ` +
                    `${q.reste} restant(s) en tout (classe ${k})`);
  }
  /* ---- LE PRIX DU MARCHE PASSE EN PRIORITE (08/10/2026) ----
   * L'etalonnage hebdomadaire (~23 ligues) epuise la part du jour : la releve
   * des prix etait alors refusee jusqu'a minuit — au premier demarrage, les six
   * grands championnats restaient suspendus le reste de la journee. Une releve
   * de prix passe donc au-dela de la part tant qu'il reste de quoi en faire une
   * par grand championnat et par jour jusqu'a la fin de la periode. Simulation
   * de la relecture : le mois finit avec au moins 95 credits.
   * Socle (10/10) : seule la classe 0 y a droit — une classe 1 a 3 qui
   * passerait un `prioritaire` ne passe pas pour autant. */
  if (k === 0 && prioritaire && q.reste - enVolCredits - cout >= prioritaire * joursRestants()) return q;
  const reserve = RESERVES_CLASSE[k];
  if (q.depenseDuJour + enVolCredits + cout > part - reserve) {
    compteClasse(k, { refus: 1 });
    /* Une releve de PRIX refusee : les championnats vendus au marche vont vers
       la suspension — le proprietaire est prevenu en prive (09/10/2026). Un
       etalonnage refuse, lui, n'est pas une alerte. */
    if (k === 0) AlerteSolde.oddsEvenement('refus', `${quoi} — ${q.reste} restants, part du jour ${part}`);
    throw new Error(`[odds] REFUSE ${quoi} : ${cout} credit(s) demande(s), ` +
      `${q.depenseDuJour} deja depense(s) aujourd hui` + (enVolCredits ? ` (+ ${enVolCredits} en vol)` : '') +
      `, part du jour = ${part}` +
      (reserve ? ` moins ${reserve} reserve(s) aux classes 0 a ${k - 1}` : '') + ` (classe ${k}) ` +
      `(${q.reste} restants pour ${joursRestants()} jour(s) jusqu au ${fin()})`);
  }
  return q;
}

// --------------------------------------------------- ce qui s'est passe

/*
 * Le compte rendu du DERNIER import.
 *
 * Sans lui, « pourquoi n'y a-t-il pas plus de matchs ? » n'a pas de reponse
 * accessible : il faut ouvrir les journaux de l'hebergeur, et les trois causes
 * possibles — pas de cle, cle invalide, ligues hors saison — y produisent des
 * lignes differentes qu'il faut savoir chercher. Or c'est exactement la
 * question qu'on se pose quand le calendrier ne bouge pas.
 *
 * On garde donc le resultat de chaque passage, et le panneau l'affiche. La
 * cle elle-meme n'y figure JAMAIS — seulement le fait qu'elle soit posee.
 */
const FICHIER_ETAT = path.join(process.env.DATA_DIR || __dirname, 'odds_dernier.json');
let DERNIER = null;
function litDernier() {
  if (DERNIER) return DERNIER;
  try { DERNIER = JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8')); }
  catch (e) { DERNIER = {}; }
  return DERNIER;
}
function noteDernier(quoi, info) {
  const d = litDernier();
  d[quoi] = Object.assign({ quand: new Date().toISOString() }, info);
  try { fs.writeFileSync(FICHIER_ETAT, JSON.stringify(d, null, 2) + '\n'); } catch (e) {}
  return d[quoi];
}

/* ---- LA PROJECTION DU MOIS (socle, 10/10/2026) ----
 * La porte du budget (EXPLOITATION 8.8sexies) : x-requests-used x 30 / jour
 * du mois. Au-dela de 16 000 sur le forfait de 20 000, on coupe dans l'ordre
 * ecrit la-bas. Calculee ici pour ne pas la refaire a la main, avec le jour
 * sur lequel elle porte. null tant que le fournisseur n'a rien dit (`vu`), ou
 * si sa derniere reponse date d'un autre mois (le compteur repart le 1er).
 * `vu` n'avance qu'avec un en-tete de compteur (voir `appel`) : une erreur sans
 * en-tete, le 1er du mois, ne projette plus le compteur du mois d'avant.
 * D'ou vient 16 000 : le plan du 09/10 (budget), PAS une mesure — 80 % du
 * forfait de 20 000, sous le pire cas de la phase de vente (~17 500) et
 * au-dessus du realiste (~12 800) ; c'est le seuil ou le garde-fou se relit.
 * Et elle ne CONCLUT pas avant le 7 du mois (`depasse` null) : une semaine
 * complete porte son samedi de vente (~545 credits, meme plan) et ses jours
 * sans grand match ; avant, un seul samedi pese d'un sixieme a la totalite
 * de l'echantillon, et le 1er il suffisait d'un samedi charge pour « couper »
 * (relecture du socle : 700 utilises le 1er = 21 000, depasse). Le chiffre
 * reste lisible, avec son jour ; c'est la conclusion qui attend. */
const PROJECTION_SEUIL = 16000;
const PROJECTION_JOURS_MIN = 7;
function projectionMois(q, now) {
  if (!q || !q.vu || q.utilise === null || q.utilise === undefined || q.utilise === '' || !(Number(q.utilise) >= 0)) return null;
  const vu = new Date(q.vu), d = new Date(now || Date.now());
  if (!isFinite(vu.getTime()) || vu.getUTCFullYear() !== d.getUTCFullYear() || vu.getUTCMonth() !== d.getUTCMonth()) return null;
  const jour = vu.getUTCDate();
  return { credits: Math.round(Number(q.utilise) * 30 / jour), utilise: Number(q.utilise), jourDuMois: jour,
           seuil: PROJECTION_SEUIL, joursMin: PROJECTION_JOURS_MIN,
           depasse: jour < PROJECTION_JOURS_MIN ? null : Number(q.utilise) * 30 / jour > PROJECTION_SEUIL };
}

/** Tout ce qu'il faut pour comprendre l'etat de l'alimentation, sans journaux. */
function etatImport() {
  const q = etatQuota();
  return {
    /* Jamais la cle — seulement si elle est la. */
    cle: !!CLE,
    ligues: LIGUES.map((l) => l.sport + '=' + l.clef),
    /* Ce que le joker a donne a la derniere lecture — null tant qu il n a
       pas ete lu. C est la ligne a regarder quand le tennis est vide. */
    jokers: jokerCache.cles
      ? { lu: new Date(jokerCache.t).toISOString(),
          cles: LIGUES.filter((l) => l.clef === '*')
            .map((j) => j.sport + '=' + jokerCache.cles.filter(JOKERS[j.sport]).map((s) => s.key).join('+')) }
      : null,
    horizonJours: HORIZON_JOURS,
    fin: fin(),
    joursRestants: joursRestants(),
    quota: { reste: q.reste, utilise: q.utilise, depenseDuJour: q.depenseDuJour,
             partDuJour: partDuJour(q.reste), vu: q.vu, projection: projectionMois(q),
             /* socle (10/10/2026) : les credits partis sans reponse encore,
                et ce que chaque classe a depense ou s'est vu refuser par jour
                (la porte 3 des reserves, EXPLOITATION 8.8sexies) */
             enVol: enVolCredits, parClasse: etatClasses() },
    auto: { actif: AUTO_ACTIF, plafond: AUTO_PLAFOND, delaiMin: AUTO_DELAI_MIN },
    /* Le reglement (lot 4, 10/10/2026) : la passe ESPN frequente, l'ombre,
       le compte des /scores payes et les portes A et B calculees
       (EXPLOITATION 8.10). Rien n'y decide. */
    reglement: (() => { try { return bilanReglement(); } catch (e) { return { erreur: String(e.message || e) }; } })(),
    /* Les refus du tableau d'ESPN aujourd'hui, par tableau : une panne qui ne
       se lit que dans le journal ne se voit pas (08/10/2026). */
    espnRefus: espn.refusDuJour(),
    /* Le prix du marche, championnat par championnat : derniere releve, et
       combien de rencontres a venir sont au prix ou SUSPENDUES — une
       suspension ne se voit pas sur la page, qui n'affiche que l'ouvert. */
    prix: etatPrix(),
    /* L'observation des sports a deux issues (lot 3, 10/10/2026) : par sport,
       la mesure et la porte P1-P5 ecrite d'avance (EXPLOITATION 8.8nonies).
       Aucune decision : la bascule reste une variable (PARIS_PRIX_LIGUES). */
    observation: (() => { try { return prixObserve.bilan(); } catch (e) { return { erreur: String(e.message || e) }; } })(),
    /* Le plafond d'engagement des rencontres cotees a l'Elo (vide = rien ne change). */
    eloEngagement: paris.eloEngagementMax(),
    /* Le journal des releves payees (lot 1, 10/10/2026) : fichiers, octets,
       lignes par cause LUES SUR LE DISQUE, echecs, illisibles. Aucun verdict :
       la mesure se fait hors serveur (outils/age_prix.js). */
    journalPrix: prixJournal.etat(),
    /* Le total de buts par championnat (09/10/2026) : l'age de la table
       paris_buts.json, et ce que le modele en a fait depuis le demarrage —
       nul de l'Elo manque, total cede au marche, championnat inconnu. */
    buts: cotes.etatButs(),
    /* Le plus/moins au prix des totaux du marche (lot 5, 10/10/2026) :
       reglage, credits du mois, couverture (porte 1) et mesure stratifiee
       (porte 2) par championnat, ecrites d'avance (EXPLOITATION 8.8decies).
       Rien n'y decide : la bascule reste une variable (PARIS_TOTAUX_LIGUES). */
    totaux: (() => { try { return etatTotaux(); } catch (e) { return { erreur: String(e.message || e) }; } })(),
    dernier: litDernier(),
  };
}

// ------------------------------------------------------------- les appels

/* ---- LE DELAI D'UN APPEL (socle, 10/10/2026) ----
 * `fetch` partait sans delai. Relecture du 09/10 : une releve bloquee (totaux,
 * cloture, direct) tient la file `filePrix`, donc retarde la releve h2h
 * d'avant-match, et `paris.js` refuse alors les paris faute de prix frais
 * (« the odds are being refreshed »). Le delai couvre la reponse ET la lecture
 * du corps. 15 s : la valeur du plan, tres au-dessus d'une reponse normale et
 * tres en dessous du tic de 10 min d'avant-match. Aucune latence du
 * fournisseur n'est mesuree dans ce depot : le journal (lot 1) et le compte
 * par classe (`delais`) diront si des appels l'atteignent (`info.code ===
 * 'DELAI'`, ligne `[odds] ... (delai)`).
 * CE QUE LE DELAI COUTE. Avant le socle, une reponse arrivee entre 15 s et le
 * delai de Node (~300 s) etait lue et comptee ; desormais elle est abandonnee.
 * Le fournisseur a pu facturer la requete (il l'a recue ; ce que sa doc en
 * dit n'est pas verifie ici) et la cle, non notee, est redemandee au tic suivant (10 min
 * avant-match, 30 min periodique). Un appel PAYANT abandonne avant ses
 * en-tetes est donc compte PAR PRUDENCE dans `depenseDuJour`, a son cout
 * attendu (x-requests-last est inconnu) : sinon un fournisseur durablement
 * lent percait la part du jour d'un credit par delai, sans un mot et sans
 * qu'aucun en-tete ne remette le reste a jour (relecture du socle : 5 appels
 * abandonnes, depenseDuJour = 0). Un appel abandonne APRES ses en-tetes est
 * deja compte par eux. Un gratuit ne compte rien. Une erreur reseau
 * immediate (« fetch failed » : la connexion n'a pas abouti) n'est ni un
 * delai ni un credit. */
const DELAI_APPEL_MS = 15000;

/* Le code d'erreur du fournisseur dans un corps d'erreur. D'abord le champ
   `error_code` d'un corps JSON (OUT_OF_USAGE_CREDITS, DEACTIVATED_KEY…) ; a
   defaut, le premier mot en MAJUSCULES_SOULIGNEES d'un corps qui n'est pas une
   page HTML. Avant : le premier mot en majuscules, n'importe ou — « DOCTYPE »
   sur la page d'une passerelle en 502, un mot du message place avant
   error_code (relecture du socle). Le reglement (lot 9) range ses causes sur
   ce code. */
function codeDuCorps(t) {
  const brut = String(t || '');
  try {
    const j = JSON.parse(brut);
    if (j && typeof j === 'object' && typeof j.error_code === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(j.error_code)) return j.error_code;
  } catch (e) { /* pas du JSON : on lit le texte, comme avant */ }
  if (/^\s*</.test(brut)) return null;
  const c = brut.match(/[A-Z][A-Z_]{5,}/);
  return c ? c[0] : null;
}

/**
 * Un appel a The Odds API. `info` (facultatif, 6e argument, socle du 10/10) :
 *  - en ENTREE `info.classe` (0 a 3, voir `autorise`) ;
 *  - en SORTIE, remis a null a chaque appel puis rempli :
 *      dernier = cout = x-requests-last (null si l'en-tete manque, JAMAIS 0
 *                par defaut : une erreur n'en porte pas) ;
 *      reste = x-requests-remaining, utilise = x-requests-used ;
 *      statut = statut HTTP (null sans reponse) ;
 *      code = le code d'erreur du fournisseur lu dans le corps (`codeDuCorps`),
 *             'REFUSE' si le garde-fou a refuse (rien n'est parti),
 *             'DELAI' si la reponse n'est pas venue en DELAI_APPEL_MS ;
 *      comptePrudent = credits comptes par prudence sur un delai (0 sinon).
 * L'URL, qui porte la cle, n'y est jamais mise.
 */
async function appel(chemin, params, coutAttendu, quoi, prioritaire, info) {
  const sortie = info && typeof info === 'object' ? info : null;
  if (sortie) Object.assign(sortie, { dernier: null, cout: null, reste: null, utilise: null, statut: null, code: null, comptePrudent: 0 });
  if (!CLE) throw new Error('[odds] ODDS_API_KEY absente — rien ne peut etre demande');
  const paye = coutAttendu > 0;
  const classe = sortie ? sortie.classe : undefined;
  const k = classeDe(prioritaire, classe);
  if (paye) {
    try { autorise(coutAttendu, quoi, prioritaire, classe); }
    catch (e) { if (sortie) sortie.code = 'REFUSE'; throw e; }
  }

  const u = new URL(BASE + chemin);
  u.searchParams.set('apiKey', CLE);
  for (const [cle, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(cle, String(v));

  const coupe = new AbortController();
  const minuterie = setTimeout(() => coupe.abort(), DELAI_APPEL_MS);
  /* Le cout attendu est tenu « en vol » des l'accord — rien n'est attendu
     depuis `autorise`, et le `try` qui le rend commence juste dessous (voir
     `enVolCredits`) — puis rendu une seule fois : quand la reponse est
     comptee, ou quand l'appel echoue. */
  let tenu = paye ? coutAttendu : 0;
  enVolCredits += tenu;
  const rends = () => { enVolCredits -= tenu; tenu = 0; };
  let compte = false;   // vrai des que la reponse a ete comptee (en-tetes lus)
  /* Toute erreur levee APRES la coupure (reponse ou lecture du corps) se dit
     comme un delai : c'est la seule cause qu'on connaisse a ce moment. Un
     appel payant coupe avant ses en-tetes est compte par prudence (voir
     DELAI_APPEL_MS) ; relu juste avant d'etre ecrit, comme a la reponse. */
  const delai = (e) => {
    if (!coupe.signal.aborted) return e;
    if (sortie) sortie.code = 'DELAI';
    let prudence = 0;
    if (!compte && paye) {
      const q = etatQuota();
      q.depenseDuJour += coutAttendu;
      rends();
      ecritQuota(q);
      prudence = coutAttendu;
      if (sortie) sortie.comptePrudent = prudence;
    }
    compteClasse(k, { depense: prudence, delais: 1 });
    return new Error(`[odds] ${quoi || chemin} : pas de reponse en ${DELAI_APPEL_MS / 1000} s sur ${chemin} — abandonne` +
                     (prudence ? `, ${prudence} credit(s) compte(s) par prudence` : '') + ' (delai)');
  };
  try {
    let rep;
    try { rep = await fetch(u.toString(), { signal: coupe.signal }); }
    catch (e) { throw delai(e); }
    /* Les compteurs sont dans les EN-TETES, y compris sur les appels gratuits :
       c'est la seule mesure fiable, la notre n'est qu'une prevision.
       ATTENTION au piege : une reponse d'ERREUR — 401 sur une cle invalide,
       502 passager — ne porte AUCUN de ces en-tetes. Or `Number(null)` vaut
       ZERO, et zero est fini : on ecrivait donc « 0 credit restant » a la
       premiere erreur venue. Le garde-fou refusait ensuite tout appel payant,
       et plus rien ne se reglait — pour une cle mal recopiee. On exige donc
       que l'en-tete SOIT LA avant de lire quoi que ce soit. */
    const lis = (nom) => {
      const brut = rep.headers.get(nom);
      if (brut === null || brut === undefined || brut === '') return null;
      const v = Number(brut);
      return isFinite(v) ? v : null;
    };
    const reste = lis('x-requests-remaining');
    const utilise = lis('x-requests-used');
    const dernier = lis('x-requests-last');
    /* ---- LE COMPTEUR SE RELIT JUSTE AVANT D'ETRE ECRIT (socle, 10/10/2026) ----
     * Il etait lu AVANT le `fetch` et reecrit apres : deux appels en vol en meme
     * temps (une releve de prix et l'import gratuit, l'etalonnage et le /scores
     * de repli) ecrivaient chacun leur copie, et le second effacait l'increment
     * de `depenseDuJour` du premier. Le garde-fou de la part du jour se percait
     * d'un credit par collision, sans un mot (relecture du 09/10). On relit
     * donc le fichier ici, apres la reponse, et on n'y AJOUTE que le cout de
     * CET appel ; `reste` et `utilise` restent ceux du fournisseur. Rien n'est
     * attendu entre la relecture et l'ecriture : Node ne peut pas s'y glisser.
     * `vu` (la derniere lecture du compteur du fournisseur) n'avance que si un
     * en-tete de compteur est la : une erreur sans en-tete ne dit rien du
     * compteur, et le 1er du mois elle faisait projeter celui du mois d'avant
     * sur un seul jour (`projectionMois`, relecture du socle). */
    const q = etatQuota();
    if (reste !== null) q.reste = reste;
    if (utilise !== null) q.utilise = utilise;
    if (dernier !== null && dernier > 0) q.depenseDuJour += dernier;
    if (reste !== null || utilise !== null || dernier !== null) q.vu = new Date().toISOString();
    compte = true;
    rends();
    ecritQuota(q);
    if (paye || (dernier !== null && dernier > 0)) compteClasse(k, { appels: paye ? 1 : 0, depense: dernier !== null && dernier > 0 ? dernier : 0 });
    if (sortie) Object.assign(sortie, { dernier, cout: dernier, reste, utilise, statut: rep.status });

    if (!rep.ok) {
      let t;
      try { t = await rep.text(); } catch (e) { throw delai(e); }
      /* Le code du fournisseur, pour qui l'attend (`info.code`), lu avant de lever. */
      if (sortie) sortie.code = codeDuCorps(t);
      /* Cle refusee (401), desactivee (DEACTIVATED_KEY) ou forfait epuise
         (OUT_OF_USAGE_CREDITS, statut non documente) : alerte privee (09/10).
         Seul `chemin` est ecrit : l'URL porte la cle. */
      if (/OUT_OF_USAGE_CREDITS/.test(t)) AlerteSolde.oddsEvenement('vide', `${rep.status} OUT_OF_USAGE_CREDITS sur ${chemin}`);
      else if (rep.status === 401 || /DEACTIVATED_KEY/.test(t)) AlerteSolde.oddsEvenement('cle', `${rep.status}${/DEACTIVATED_KEY/.test(t) ? ' DEACTIVATED_KEY' : ''} sur ${chemin}`);
      throw new Error(`[odds] ${rep.status} sur ${chemin} : ${t.slice(0, 200)}`);
    }
    let j;
    try { j = await rep.json(); } catch (e) { throw delai(e); }
    if (paye) {
      console.log(`[odds] ${quoi} : ${dernier === null ? '?' : dernier} credit(s), ` +
                  `${q.reste} restant(s), part du jour ${partDuJour(q.reste)} (classe ${k})`);
    }
    return j;
  } finally { clearTimeout(minuterie); rends(); }
}

// ------------------------------------------------------- les identifiants

/* Un identifiant lisible et STABLE. Le validateur du catalogue impose
   [a-z0-9-]{4,64}, et un identifiant qui changerait d'un import a l'autre
   ferait apparaitre le meme match deux fois — donc deux paris qui ne se
   reglent pas ensemble. On le derive donc du contenu, jamais d'un compteur. */
function abrege(nom) {
  return String(nom || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '').slice(0, 3) || 'xxx';
}
function identifiant(ligue, ev) {
  const d = new Date(ev.commence_time);
  const jour = d.toISOString().slice(0, 10).replace(/-/g, '');
  const court = ligue.clef.replace(/^soccer_|^tennis_|^basketball_/, '').replace(/[^a-z0-9]+/g, '').slice(0, 12);
  return `${court}-${jour}-${abrege(ev.home_team)}-${abrege(ev.away_team)}`.slice(0, 64);
}

/* ---- LE NOM QUE LA PAGE TITRE ----
 * La cle de The Odds API, decoupee, donnait « Spain La Liga » a cote d un
 * pays qui dit deja « Spain », « Usa Mls », « Germany Bundesliga2 ». C est le
 * titre du bloc que le joueur deplie : il porte le nom courant de la
 * competition, et rien d autre — le pays est un champ a part. Une cle absente
 * de la table (un tournoi de tennis, qui change chaque semaine) garde le
 * decoupage, avec ses sigles en capitales. */
const NOMS_COMPET = {
  soccer_epl: 'Premier League', soccer_efl_champ: 'Championship',
  soccer_france_ligue_one: 'Ligue 1', soccer_france_ligue_two: 'Ligue 2',
  soccer_spain_la_liga: 'La Liga', soccer_spain_segunda_division: 'La Liga 2',
  soccer_italy_serie_a: 'Serie A', soccer_italy_serie_b: 'Serie B',
  soccer_germany_bundesliga: 'Bundesliga', soccer_germany_bundesliga2: '2. Bundesliga',
  soccer_netherlands_eredivisie: 'Eredivisie', soccer_portugal_primeira_liga: 'Primeira Liga',
  soccer_belgium_first_div: 'Pro League', soccer_turkey_super_league: 'Süper Lig',
  soccer_usa_mls: 'MLS', soccer_mexico_ligamx: 'Liga MX',
  soccer_uefa_champs_league: 'Champions League',
  basketball_nba: 'NBA', americanfootball_nfl: 'NFL', icehockey_nhl: 'NHL', baseball_mlb: 'MLB',
  cricket_the_hundred: 'The Hundred', cricket_international_t20: 'International T20',
  cricket_t20_blast: 'T20 Blast', cricket_odi: 'One Day Internationals',
};
const SIGLES = /^(nhl|mlb|nfl|nba|mls|epl|efl|odi|t20|atp|wta|uefa)$/i;
const NOM_COMPET = (clef) => NOMS_COMPET[clef]
  || clef.replace(/^soccer_|^tennis_|^basketball_|^icehockey_|^baseball_|^americanfootball_/, '')
    .replace(/_/g, ' ').replace(/\b\w+/g, (m) => SIGLES.test(m) ? m.toUpperCase() : m[0].toUpperCase() + m.slice(1));

// ------------------------------------------------------------ les actions

/** Les rencontres. GRATUIT — c'est tout l'interet de ce chemin. */
async function importeMatchs() {
  const limite = Date.now() + HORIZON_JOURS * 86400000;
  const matchs = [];
  const sports = new Set();

  const echouees = new Set(), erreurs = [], parLigueCompte = {};
  /* Tout ce que le fournisseur rend, COMMENCE OU NON, par identifiant
     d'evenement : c'est ce qui dit qu'une rencontre deja au calendrier a ete
     deplacee (voir plus bas). Seules les ligues qui ont rendu au moins une
     rencontre comptent : une reponse vide ne prouve rien. */
  const parEvenement = new Map(), liguesVues = new Set();
  let repondues = 0;
  for (const l of await liguesEnService()) {
    let evs;
    try {
      evs = await appel(`/sports/${l.clef}/events`, {}, 0, 'events ' + l.clef);
      repondues++;
    } catch (e) {
      /* Une ligue hors saison rend 404. Ce n'est pas une panne — la NBA ne
         joue pas en aout — et ca ne doit pas arreter les autres. Une cle
         invalide ou une coupure reseau, en revanche, font echouer TOUTES les
         ligues : on le retient pour ne pas ecraser le calendrier avec du
         vide. */
      echouees.add(l.clef);
      erreurs.push(l.clef + ' : ' + String(e.message).slice(0, 120));
      console.log('[odds] ' + l.clef + ' ignore : ' + e.message.slice(0, 90));
      continue;
    }
    let pris = 0;
    for (const ev of evs || []) {
      const tv = Date.parse(ev.commence_time);
      if (ev && ev.id && isFinite(tv)) { parEvenement.set(String(ev.id), tv); liguesVues.add(l.clef); }
    }
    for (const ev of evs || []) {
      const t = Date.parse(ev.commence_time);
      if (!isFinite(t) || t <= Date.now() || t > limite) continue;
      if (!ev.home_team || !ev.away_team) continue;      // tennis : adversaire inconnu
      matchs.push({
        id: identifiant(l, ev), sport: l.sport,
        competition: NOM_COMPET(l.clef), pays: NOM_PAYS[PAYS_LIGUE[l.clef]] || '',
        domicile: ev.home_team, exterieur: ev.away_team,
        paysDomicile: paysDe(ev.home_team, l.clef),
        paysExterieur: paysDe(ev.away_team, l.clef),
        debut: new Date(t).toISOString(),
        source: { fournisseur: 'the-odds-api', ligue: l.clef, evenement: ev.id },
      });
      sports.add(l.sport);
      pris++;
    }
    parLigueCompte[l.clef] = { vues: (evs || []).length, retenues: pris };
    console.log(`[odds] ${l.clef} : ${pris} rencontre(s) retenue(s) sur ${(evs || []).length}`);
  }

  /* Un identifiant en double ferait exploser le validateur. Deux rencontres du
     meme jour entre deux equipes dont les trois premieres lettres coincident,
     ca arrive — on desambigue plutot que de perdre le match. */
  /* ---- ET UN IDENTIFIANT RESTE A SON EVENEMENT (08/10/2026) ----
   * Le suffixe « -2 » suivait l'ORDRE de la reponse. Programme double reel,
   * TOR@BAL du 23/09 (17:35Z et 22:35Z) : match 1 = bal-tor, match 2 =
   * bal-tor-2. L'import suivant tombe pendant le match 1, qui n'est plus
   * importe puisque commence : le match 2 prenait « bal-tor » et ECRASAIT
   * l'entree du match 1 — ses paris se seraient regles avec le score du
   * match 2. Une rencontre reprend donc l'identifiant qu'elle portait deja (meme
   * evenement du fournisseur, meme base), et un suffixe n'est jamais donne a un
   * identifiant deja porte par un AUTRE evenement de l'ancien calendrier. */
  const anciens = new Map(), anciensParEv = new Map(), anciensBruts = new Map();
  try {
    for (const a of (JSON.parse(fs.readFileSync(paris.fichier(), 'utf8')).matchs || [])) {
      anciensBruts.set(a.id, a);
      const ev = String((a.source && a.source.evenement) || '');
      anciens.set(a.id, ev);
      if (ev) anciensParEv.set(ev, a.id);
    }
  } catch (e) { /* pas d'ancien calendrier */ }
  const vus = new Map();
  for (const m of matchs) {
    const ev = String(m.source.evenement || ''), base = m.id;
    const sien = anciensParEv.get(ev);
    if (sien && (sien === base || sien.startsWith(base + '-')) && !vus.has(sien)) { m.id = sien; vus.set(sien, m); continue; }
    const libre = (id) => !vus.has(id) && (!anciens.has(id) || anciens.get(id) === ev);
    let cand = base, n = 2;
    while (!libre(cand)) { cand = (base + '-' + n).slice(0, 64); n++; }
    m.id = cand; vus.set(cand, m);
  }

  /* Les cotes sont FABRIQUEES ici. Une rencontre trop desequilibree n'est pas
     cotable : on l'ECARTE en le disant, plutot que de laisser `cotesDe` jeter
     et de perdre tout l'import pour un match. Un seul Alcaraz contre un
     qualifie suffirait sinon a vider le calendrier. */
  const habilles = [], ecartes = [];
  for (const m of [...vus.values()].sort((a, b) => Date.parse(a.debut) - Date.parse(b.debut))) {
    let h;
    try { h = cotes.habille(avecButs(avecPrix(m))); }
    catch (e) {
      /* ---- UNE RENCONTRE DEJA AU CALENDRIER N'EN SORT PAS ----
       * Une rencontre cotee par le seul marche (equipe que l'Elo ne connait
       * pas, favori a 97 %) qui perd son prix ne se cote plus a l'Elo. L'ecarter
       * la faisait sortir du calendrier AVEC ses paris : ni ESPN ni /scores ne
       * la reglaient plus. On garde son ancienne entree, SUSPENDUE (relecture du
       * 08/10). */
      const ancien = anciensBruts.get(m.id);
      if (ancien && prixMarche.vendue(m.source && m.source.ligue)) {
        habilles.push(Object.assign({}, ancien, { debut: m.debut, prixMarche: undefined, suspendu: true,
          suspenduRaison: (e.message.split('— ')[1] || e.message).slice(0, 120) }));
        continue;
      }
      ecartes.push(`${m.domicile} – ${m.exterieur} : ${e.message.split('— ')[1] || e.message}`); continue;
    }
    habilles.push({ id: h.id, sport: h.sport, competition: h.competition, pays: h.pays,
                    domicile: h.domicile, exterieur: h.exterieur,
                    paysDomicile: h.paysDomicile || null, paysExterieur: h.paysExterieur || null,
                    debut: h.debut,
                    /* ---- LES MARCHES, ET NON PLUS LES COTES A PLAT ----
                       Six questions par rencontre au lieu d'une, toutes
                       descendues du MEME couple de moyennes de buts. `habille`
                       rend l'une ou l'autre forme selon ce qu'il a recu : une
                       cote relevee a la main reste ou elle est, on ne la
                       reecrit pas pour le plaisir de la ranger. */
                    marches: h.marches, cotes: h.marches ? undefined : h.cotes,
                    cotesGenerees: !!h.cotesGenerees, source: h.source,
                    prixMarche: h.prixMarche || undefined,
                    /* lot 5 : le total du marche des totaux, seulement s'il a fait le prix
                       (cotes.avecTotalServi ; jamais pose par defaut) */
                    butsMarche: h.butsMarche || undefined,
                    suspendu: h.suspendu || undefined, suspenduRaison: h.suspendu ? h.suspenduRaison : undefined });
  }
  if (ecartes.length) {
    /* On NOMME ce qui a ete jete. Un import qui rogne en silence se lit comme
       un import complet, et on cherche ensuite pourquoi un match manque. */
    console.log(`[odds] ${ecartes.length} rencontre(s) ecartee(s), trop desequilibree(s) :`);
    for (const e of ecartes) console.log('   · ' + e);
  }

  /* ---- LE GARDE-FOU QUI COMPTE ----
   *
   * Une cle invalide fait echouer les neuf ligues d'un coup. Sans ce test, on
   * ecrivait alors un catalogue VIDE par-dessus le bon : la page des paris se
   * retrouvait sans une seule rencontre, sans erreur nulle part, et le seul
   * signe etait une ligne « catalogue ecrit : 0 rencontre(s) » perdue dans les
   * journaux. Un import qui n'a rien obtenu ne doit RIEN ecrire.
   */
  if (!repondues) {
    console.error(`[odds] AUCUNE ligue n a repondu (${echouees.size} en echec) — ` +
                  'le calendrier existant est CONSERVE, rien n a ete ecrit');
    ditLaPorte('import sans reponse');
    noteDernier('matchs', { ok: false, ecrit: false, repondues: 0,
      echouees: [...echouees], erreurs: erreurs.slice(0, 12),
      pourquoi: 'no league answered — the existing calendar was kept' });
    return 0;
  }

  /* ---- ON COMPLETE, ON NE REMPLACE PAS ----
   *
   * Le premier import reel a efface vingt et une rencontres du calendrier —
   * sept de Championship et quatorze de tennis, ecrites a la main — parce
   * qu'aucune ligue suivie ne les rendait. Des paris etaient poses dessus.
   *
   * Ce n'est pas une perte cosmetique. Un pari porte l'identifiant de son
   * match ; si le match quitte le catalogue, `regleMatch` jette « unknown
   * match ». La rencontre ne peut plus etre REGLEE — seulement remboursee.
   * Autrement dit : celui qui avait gagne ne peut plus etre paye.
   *
   * On reprend donc TOUTE rencontre precedente qui pourrait encore porter un
   * pari : celles a venir, et celles jouees recemment qui attendent peut-etre
   * leur resultat. Une rencontre importee du meme identifiant remplace
   * l'ancienne — c'est la seule chose qu'on ecrase, et c'est voulu : les
   * cotes et l'horaire d'un match qui n'a pas commence peuvent bouger.
   *
   * Le module ne connait pas le moteur et ne peut donc pas demander « ce
   * match a-t-il des paris ? ». On garde donc sur un critere de TEMPS, plus
   * large que necessaire : garder une rencontre de trop ne coute rien, en
   * perdre une bloque de l'argent.
   */
  const RETENTION_JOURS = Number(process.env.ODDS_API_RETENTION || 45);
  {
    let repris = 0, vieilles = 0;
    const fermees = [];
    try {
      /* On relit le calendrier EN SERVICE, pas la cible d'ecriture : au
         premier import qui suit la bascule sur le volume, le fichier du
         volume n'existe pas encore et c'est l'amorce du depot qu'il faut
         reprendre — sinon ses rencontres seraient perdues. */
      const avant = JSON.parse(fs.readFileSync(paris.fichier(), 'utf8'));
      const limiteBasse = Date.now() - RETENTION_JOURS * 86400000;
      const fraisParEvenement = new Map();
      for (const f of vus.values()) if (f.source && f.source.evenement) fraisParEvenement.set(String(f.source.evenement), f.id);
      for (const m0 of avant.matchs || []) {
        if (vus.has(m0.id)) continue;                // remplacee par la version fraiche
        const t = Date.parse(m0.debut);
        if (!isFinite(t)) continue;
        if (t < limiteBasse) { vieilles++; continue; }
        /* ---- UNE RENCONTRE DEPLACEE NE RESTE PAS OUVERTE (08/10/2026) ----
         * L'identifiant porte la DATE (voir `identifiant`). Quand le
         * fournisseur deplace une rencontre d'un jour, la version fraiche
         * arrive sous un AUTRE identifiant, et l'ancienne etait conservee ici,
         * ouverte jusqu'a son ancienne heure et retarifee a chaque import. Si
         * le match etait AVANCE, elle acceptait encore des paris apres le vrai
         * coup de sifflet final, puis ESPN (qui apparie a 36 h pres) la
         * reglait avec le vrai score : un pari sur un resultat connu. Rejoue
         * sur un Real–Villarreal avance du dimanche au samedi 14:00 : ouvert
         * le samedi a 18:00, match joue, a 1,45 / 3,97 / 6,03.
         * Desormais, si le meme evenement du fournisseur est rendu sous une
         * autre heure, sous un autre identifiant, ou n'est plus rendu du tout
         * par une ligue qui a repondu, l'ancienne entree est FERMEE : plus
         * aucun pari, ses tickets restent affichables, et son reglement passe
         * a la main (`trieReglements`) — c'est au proprietaire de dire si les
         * paris d'avant le deplacement tiennent. Elle prend la VRAIE heure
         * quand on la connait, pour qu'ESPN la retrouve et que le ticket dise
         * la verite. Aucune cote n'est touchee. */
        /* ---- L'HEURE NE FAIT QUE RECULER ----
         * Avancee, l'entree prend la vraie heure : ESPN la retrouve, le ticket
         * dit vrai, et « a regler » la montre des que le match est joue.
         * Reportee, elle GARDE la sienne : si le report est annule et que le
         * match se joue a son heure, ses gagnants doivent remonter dans « a
         * regler » ce jour-la — une heure annoncee plus tard les en sortait
         * jusqu'a une date ou ni ESPN (36 h) ni /scores (3 jours) ne les
         * retrouvaient plus. Et une entree DEJA fermee suit encore les
         * avances du fournisseur, jamais ses reports. */
        let m = m0;
        const src = m0.source || {};
        if (src.fournisseur === 'the-odds-api' && src.evenement && liguesVues.has(src.ligue)) {
          const vrai = parEvenement.get(String(src.evenement));
          const autre = fraisParEvenement.get(String(src.evenement));
          const avance = vrai !== undefined && vrai <= t - 60000;
          if (isFinite(Date.parse(m0.ferme))) {
            if (avance) m = Object.assign({}, m0, { debut: new Date(vrai).toISOString() });
          } else if (t > Date.now()) {
            let raison = null;
            if (vrai === undefined) raison = 'plus rendue par le fournisseur du calendrier';
            else if (Math.abs(vrai - t) >= 60000) raison = (vrai < t ? 'avancee au ' : 'reportee au ') + new Date(vrai).toISOString();
            else if (autre && autre !== m0.id) raison = 'reprise sous l identifiant ' + autre;
            if (raison) {
              m = Object.assign({}, m0, { debut: avance ? new Date(vrai).toISOString() : m0.debut,
                                          ferme: new Date().toISOString(), fermeRaison: raison });
              fermees.push(`${m0.domicile} – ${m0.exterieur} (${m0.id}) : ${raison}`);
            }
          }
        }
        /* Une rencontre conservee dont la cote est FABRIQUEE se retarife :
           les forces ont pu changer depuis. Celle qui a commence, non — les
           paris y sont poses a la cote affichee. */
        let g = m;
        if (t > Date.now() && !isFinite(Date.parse(m.ferme))) {
          /* Le prix du marche se repose a chaque import (frais, ou suspendue) ;
             le total des totaux aussi (lot 5 : reconsidere a chaque import). */
          const mp = avecButs(avecPrix(m));
          /* le total du marche n'est dit (butsMarche) que s'il a fait le prix :
             seul `habille` le repose (cotes.avecTotalServi) ; une cote non
             refaite, ou devenue incotable, ne le porte pas */
          g = sansButs(mp);
          if (mp.cotesGenerees) {
            try { g = cotes.habille(mp); }
            catch (e) {
              /* devenue incotable : on la garde telle quelle plutot que de la
                 faire disparaitre avec ses paris — mais SUSPENDUE si elle est
                 au prix du marche : ses anciennes cotes ne valent plus rien. */
              if (mp.prixMarche) g = Object.assign({}, g, { prixMarche: undefined, suspendu: true,
                suspenduRaison: 'trop desequilibre au prix du marche' });
            }
          }
        }
        habilles.push(g); repris++;
      }
    } catch (e) { /* pas de catalogue precedent : rien a reprendre */ }
    if (repris) console.log(`[odds] ${repris} rencontre(s) precedente(s) conservee(s)` +
      (vieilles ? `, ${vieilles} trop ancienne(s) retiree(s)` : ''));
    if (fermees.length) {
      /* On le DIT, rencontre par rencontre : une fermeture silencieuse se lit
         comme une panne de la page le jour ou un joueur ne trouve plus son
         match. */
      console.log(`[odds] ${fermees.length} rencontre(s) FERMEE(S) aux paris, deplacee(s) ou retiree(s) par le fournisseur :`);
      for (const f of fermees) console.log('   · ' + f);
    }
  }

  if (!habilles.length) {
    console.error('[odds] aucune rencontre retenue — le calendrier existant est CONSERVE');
    noteDernier('matchs', { ok: false, ecrit: false, repondues, parLigue: parLigueCompte,
      echouees: [...echouees], erreurs: erreurs.slice(0, 12),
      pourquoi: 'no fixture within the horizon — the existing calendar was kept' });
    return 0;
  }

  habilles.sort((a, b) => Date.parse(a.debut) - Date.parse(b.debut));
  /* Les noms viennent du registre : ils y sont declares avec les issues et
     l'avantage du terrain, en une ligne par sport. Recopies ici, ils
     manquaient au premier sport ajoute et la page affichait « undefined ». */
  const NOMS = {};
  for (const c of Object.keys(paris.SPORTS)) NOMS[c] = paris.SPORTS[c].nom;
  const retenus = new Set(habilles.map((m) => m.sport));
  /* Tous les sports connus figurent au catalogue, meme sans rencontre : la
     page les montre alors grises avec « soon », ce qui annonce ce qui arrive
     au lieu de le faire apparaitre un matin sans prevenir. */
  const catalogue = {
    sports: Object.keys(paris.SPORTS)
      .map((c) => ({ cle: c, nom: NOMS[c], actif: retenus.has(c) })),
    matchs: habilles,
  };

  /* On le fait relire par le VALIDATEUR du serveur avant de l'ecrire : un
     catalogue refuse empeche le serveur de demarrer, et on prefere l'apprendre
     ici que dans les journaux d'un dimanche soir. */
  paris.valide(catalogue);
  /* Le dossier du volume peut etre vide au premier demarrage : `state.json`
     est ecrit par le moteur, pas par nous, et rien ne garantit qu'il soit
     deja passe. */
  try { fs.mkdirSync(path.dirname(FICHIER_CAT), { recursive: true }); } catch (e) {}
  fs.writeFileSync(FICHIER_CAT, JSON.stringify(catalogue, null, 1) + '\n');
  console.log(`[odds] catalogue ecrit : ${habilles.length} rencontre(s), 0 credit depense`);
  /* Les suspensions se DISENT : par championnat, et fort quand il l'est en
     entier — la page n'affiche que l'ouvert, la Premier League disparaitrait
     sans un mot. */
  const suspendues = {}, aVenir = {};
  for (const m of habilles) {
    const l = m.source && m.source.ligue;
    if (!l || !prixMarche.vendue(l) || !(Date.parse(m.debut) > Date.now())) continue;
    aVenir[l] = (aVenir[l] || 0) + 1;
    if (m.suspendu) suspendues[l] = (suspendues[l] || 0) + 1;
  }
  for (const [l, k] of Object.entries(suspendues)) {
    console.log(`[odds] ${k === aVenir[l] ? 'CHAMPIONNAT ENTIER SUSPENDU' : 'suspendue(s)'} — ${l} : ${k}/${aVenir[l]} rencontre(s) sans prix du marche frais`);
  }
  noteDernier('matchs', { ok: true, ecrit: true, rencontres: habilles.length,
    importees: vus.size, repondues, parLigue: parLigueCompte,
    echouees: [...echouees], erreurs: erreurs.slice(0, 12),
    ecartees: ecartes.slice(0, 12), suspendues });
  return habilles.length;
}

/* ---- LE COMPTE DE CHAQUE /scores PAYE (lot 4, 10/10/2026) ----
 * La porte B se juge cle par cle sur ce que le fournisseur a REELLEMENT
 * facture : x-requests-last, jamais une supposition. Le cout d'une reponse
 * /scores VIDE, ou d'une erreur, n'est pas documente (la phrase « If no events
 * are returned, the request will not count against the usage quota »
 * n'existe que pour GET odds ; api-error-codes.html ne dit rien du cout, guide
 * v4 relu le 09/10). Une erreur ne porte pas d'en-tete (voir `appel`) : son
 * cout se DEDUIT de x-requests-used, seulement quand c'est PROUVABLE : l'appel
 * /scores qui la precede dans la meme passe a lu le compteur, rien n'a ete
 * facture entre lui et l'erreur (le compte par classe du jour n'a pas bouge),
 * et l'appel /scores qui la suit lit le compteur avec, entre les deux,
 * exactement deux appels et sa seule depense. Sinon : « indecidable » — un
 * compteur lu une heure plus tot aurait absorbe les erreurs d'autres passes
 * (essai B3 de paris_import.test.js). Un appel est « inutile » s'il
 * a coute, n'a rien apparie, ET a ete paye pour une rencontre de plus de
 * AUTO_DELAI_MIN + 110 min : paye pour un match en cours, il est « precoce »
 * (c'est l'economie de PARIS_SCORES_SAUTE_ENCOURS, pas celle de la coupe). */
function instantaneQuota() {
  const jour = jourCourant();
  const c = (litClasses().jours || {})[jour] || {};
  let appels = 0, depense = 0;
  for (const k of Object.keys(c)) { appels += Number(c[k] && c[k].appels) || 0; depense += Number(c[k] && c[k].depense) || 0; }
  /* `vol` : les credits d'appels payants partis et pas encore comptes
     (`enVolCredits`, socle). Lu, jamais modifie ici. */
  return { u: null, jour, appels, depense, vol: enVolCredits };
}
/* Peut LEVER (journal en panne) : l'appelant l'isole, la ligne de journal
   est ecrite avant toute note. */
function compteScores(clef, x, suspens) {
  const info = x.info || {};
  const cout = info.cout === undefined ? null : info.cout;
  const refuse = info.code === 'REFUSE';
  if (!refuse) {
    let ligne = `[odds] scores ${clef} : ${cout === null ? '?' : cout} credit(s), ${x.rendus} rendue(s), ` +
                `${x.finies} finie(s), ${x.appariees} appariee(s)`;
    if (x.appariees === 0 && cout > 0) ligne += x.vieux ? ' — INUTILE' : ` — precoce (payee pour une rencontre de moins de ${AUTO_DELAI_MIN + 110} min)`;
    if (cout === null && info.statut !== null) ligne += ` — cout inconnu (statut ${info.statut}${info.code ? ' ' + info.code : ''})`;
    console.log(ligne);
  }
  const entree = regJournal.noteAppelScores(clef, { t: x.t, cout, statut: info.statut, code: info.code,
    rendus: x.rendus, finies: x.finies, appariees: x.appariees, vieux: x.vieux,
    declencheurs: x.declencheurs, ageMaxMin: x.ageMaxMin });
  /* L'appel d'avant etait sans en-tete : celui-ci dit-il ce qu'il a coute ? */
  if (suspens) {
    const apres = instantaneQuota();
    let deduit = null;
    /* `apres.vol === 0` (relecture du lot 4) : un appel payant concurrent
       (une releve de prix) peut etre facture chez le fournisseur avant CET
       appel — il est alors dans x-requests-used — et compte chez nous apres
       lui : les deux appels comptes seraient bien deux, et son cout irait a
       l'erreur. Encore en vol a cet instant : indecidable. Parti et revenu
       entre les deux : il est compte, la condition « exactement deux » le
       refuse deja.
       `apres.jour === suspens.avant.jour` est inatteignable aujourd'hui (la
       condition « exactement deux appels » couvre deja le passage de minuit,
       le compte du jour repart de zero) : garde si un await se glisse entre
       les lectures. */
    if (cout !== null && info.utilise !== null && info.utilise !== undefined && suspens.avant.u !== null
        && apres.vol === 0
        && apres.jour === suspens.avant.jour && apres.appels - suspens.avant.appels === 2
        && apres.depense - suspens.avant.depense === (cout > 0 ? cout : 0)) {
      const v = Number(info.utilise) - cout - suspens.avant.u;
      if (v >= 0 && isFinite(v)) deduit = v;
    }
    if (deduit !== null) console.log(`[odds] scores ${suspens.clef} : ${deduit} credit(s) deduit(s) de x-requests-used`);
    regJournal.deduitCout(suspens.entree, deduit, deduit === null ? '' : 'x-requests-used');
  }
  /* Celui-ci est sans en-tete mais a recu une reponse (ou a ete coupe au
     delai) : il attend l'appel suivant. Un refus du garde-fou ne coute rien,
     une erreur reseau immediate non plus (la connexion n'a pas abouti). */
  if (!refuse && cout === null && (info.statut !== null || info.code === 'DELAI') && entree) return { entree, avant: x.avant, clef };
  return null;
}
/* ---- QUAND UNE RENCONTRE D'UNE CLE COUPEE PART « A LA MAIN » (relecture du lot 4) ----
 * Coupee, la cle n'a plus de /scores pour dire « completed ». Ses rencontres
 * ne partaient a la main qu'au mur du football (AUTO_DELAI_MIN + 110 min,
 * 200) : la quotidienne aurait annonce sur le canal PUBLIC « resultat a
 * saisir » un ODI ou un test encore en cours, a chaque demarrage. Elles
 * attendent donc la duree de leur FORMAT, marge comprise : un test se joue
 * sur cinq jours, un ODI dure ~8 h (deux manches de 50 overs et la pause),
 * T20 et Hundred moins de 4 h, un tennis en cinq sets peut depasser 5 h. Des
 * DECISIONS, pas des mesures : la coupe est eteinte, et ces durees se
 * remesurent sur les heures de fin reelles avant de l'armer (porte B). Un
 * format plus court attend plus que necessaire : c'est le prix de la coupe,
 * jamais un gagnant paye trop tot. */
const COUPE_ATTENTE_H = Object.freeze({ cricket_test_match: 5 * 24, cricket: 10, tennis: 6 });
function attenteCoupeMs(clef) {
  const k = String(clef || '');
  const h = COUPE_ATTENTE_H[k] || (/^tennis_/.test(k) ? COUPE_ATTENTE_H.tennis : COUPE_ATTENTE_H.cricket);
  return Math.max(h * 3600000, (AUTO_DELAI_MIN + 110) * 60000);
}
/* La coupe : une raison si la cle est coupee, null sinon (voir les drapeaux). */
function clefCoupee(clef, t) {
  if (!scoresCoupe() || !SCORES_NON_COCHEES.has(clef)) return null;
  let b = null;
  try { b = regJournal.bilanScores(t, SCORES_COUPE_JOURS)[clef]; } catch (e) { return null; }
  if (!b || b.appariees > 0) return null;
  const n = scoresCoupeN();
  return b.inutiles >= n ? `jamais appariee sur ${b.inutiles} appel(s) paye(s) inutile(s) en ${SCORES_COUPE_JOURS} jours` : null;
}

/**
 * Les rencontres FINIES, pour le reglement. 2 credits par sport.
 *
 * On ne regle rien automatiquement : le reglement reste a la main, et c'est
 * assume ailleurs dans ce code — un service de resultats qui se trompe paie
 * les mauvaises personnes sans que personne ne le sache. Ce qu'on rend ici est
 * une LISTE A VERIFIER, avec l'adresse exacte a appeler pour chaque match.
 */
/*
 * `opts` (lot 4, 10/10/2026), facultatif — sans lui, rien ne change :
 *   payant          false : la passe frequente ESPN, qui ne paie JAMAIS de
 *                   /scores (rend ce qu'ESPN a tranche, et rien d'autre) ;
 *   fenetreEspnMs   la fenetre de la source gratuite, jamais plus large que
 *                   FEN_ESPN (la passe frequente demande 3 jours, pas 30).
 */
async function importeScores(aRegler, opts) {
  const o = opts || {};
  paris.charge();
  const ouverts = new Set(paris.catalogue().matchs.map((m) => m.id));

  /* ---- ESPN D'ABORD, ET GRATUITEMENT ----
   *
   * Ses tableaux de scores repondent sans cle et sans quota. Tout ce qu'il
   * sait trancher ne coute donc rien, et ne descend pas plus bas. Mesure sur
   * le calendrier reel : quarante-six rencontres de football sur quarante-
   * huit, plus la NFL et la NBA. Les deux qui restaient etaient des matchs de
   * COUPE ranges sous une ligue par The Odds API — ils sont absents du tableau
   * de cette ligue, et ils repartent donc payer leurs deux credits, ce qui est
   * exactement ce qu'on veut.
   *
   * Le tennis n'est pas couvert : le tableau d'ESPN ne rend que des tournois,
   * sans les rencontres. Il reste sur The Odds API — deux credits pour UN
   * sport au lieu de cinq.
   *
   * Une panne d'ESPN ne casse rien : `finies` rend une liste vide et tout
   * repasse par le chemin d'avant. C'est le meme raisonnement que partout
   * ailleurs ici — une source gratuite qui s'ajoute ne doit jamais pouvoir
   * empecher celle qui marchait. */
  const tGratuit = Date.now();
  /* ---- LA SOURCE GRATUITE N'A PAS DE FENETRE, DONC ON NE LUI EN IMPOSE PAS ----
   * `/scores` de The Odds API s'arrete a trois jours — c'est son endpoint qui
   * le decide. ESPN, lui, se demande PAR DATE : la semaine derniere se demande
   * aussi bien qu'aujourd'hui. Lui appliquer la borne de l'autre aurait laisse
   * bloque tout ce qui a rate son creneau, c'est-a-dire exactement l'arriere
   * qu'on essaie de rattraper.
   * Trente jours : de quoi reprendre un mois de retard, et pas de quoi
   * parcourir un catalogue entier a chaque passage. */
  const FEN_ESPN = 30 * 86400000;
  /* La passe frequente (lot 4) lit 3 jours : au-dela de 7 journees,
     `espn.releve` demande des MOIS (7 Mo pour un mois de MLB), toutes les 2 h.
     Jamais plus large que FEN_ESPN. */
  const fenEspn = Number(o.fenetreEspnMs) > 0 ? Math.min(Number(o.fenetreEspnMs), FEN_ESPN) : FEN_ESPN;
  const candidats = paris.catalogue().matchs.filter((m) =>
    m.debut <= tGratuit && tGratuit - m.debut <= fenEspn
    && (typeof aRegler !== 'function' || aRegler(m.id)));
  let gratuites = [];
  try { gratuites = await espn.finies(candidats); }
  catch (e) { console.log('[espn] injoignable : ' + (e.message || e)); }
  const dejaVues = new Set(gratuites.map((f) => f.id));
  if (gratuites.length) {
    console.log(`[espn] ${gratuites.length} rencontre(s) reglee(s) sans depenser un credit`);
  }
  /* ---- LA PASSE FREQUENTE NE PAIE JAMAIS (lot 4, 10/10/2026) ----
   * Elle tourne toutes les 2 h : le /scores de repli (2 credits par ligue)
   * y couterait douze fois par jour ce que la quotidienne paie une fois. Elle
   * rend donc ce qu'ESPN a tranche, et s'arrete la ; le repli payant reste a
   * la quotidienne (et a chaque demarrage). reglement_cadence.test.js (b) le
   * tient avec un cricket parie qu'ESPN ne couvre pas : 0 credit. */
  if (o.payant === false) return gratuites.filter((f) => ouverts.has(f.id));

  /* On n'interroge QUE les ligues qui ont une rencontre finie a rattraper.
     Demander les scores des neuf ligues chaque jour couterait 18 credits —
     846 d'ici la fin, pour un forfait de 500. La plupart des jours, deux
     ligues jouent : la depense reelle tombe a 4.
     La fenetre s'arrete a trois jours parce que `daysFrom` ne remonte pas
     plus loin ; au-dela, le reglement se fait a la main de toute facon. */
  const t = Date.now();
  const FENETRE = 3 * 86400000;
  const parLigue = new Map();
  /* ---- ET SEULEMENT CELLES OU DE L'ARGENT ATTEND ----
   *
   * Un score ne sert QU'A regler des paris. Les forces Elo, elles, se recalent
   * par `--calibre`, qui est un autre appel. Une rencontre finie sur laquelle
   * personne n'a mise n'a donc rien a nous apprendre — et on la payait deux
   * credits par jour pendant trois jours, par ligue.
   *
   * Le meme calcul vaut pour une rencontre DEJA REGLEE : la releve tourne
   * chaque jour et repassait sur les memes rencontres jusqu'a ce qu'elles
   * sortent de la fenetre. Depuis que le reglement automatique fonctionne,
   * elles sont tranchees des la premiere passe, et les deux suivantes ne
   * servaient plus a rien.
   *
   * `aRegler` vient du serveur, qui seul connait les paris — ce module ne
   * connait pas le moteur, et c'est voulu. Sans rappel, on garde l'ancien
   * comportement : demander pour tout. Mieux vaut depenser un credit de trop
   * que laisser un gagnant impaye.
   */
  const filtre = typeof aRegler === 'function' ? aRegler : null;
  let sansEnjeu = 0, sautees = 0;
  /* L'age minimal d'une rencontre reglable (`trieReglements`) : en dessous,
     le /scores paye pour elle est « precoce », pas « inutile » (lot 4). */
  const mur = (AUTO_DELAI_MIN + 110) * 60000;
  const sauteEnCours = scoresSauteEnCours();
  /* Les rencontres qui font payer chaque ligue : le compte (lot 4) dit si
     l'appel a ete paye pour une rencontre assez vieille pour etre reglee. */
  const declencheurs = new Map();
  for (const m of paris.catalogue().matchs) {
    const l = m.source && m.source.ligue;
    if (!l) continue;
    if (m.debut > t) continue;                  // pas encore joue
    if (t - m.debut > FENETRE) continue;        // trop vieux pour cet endpoint
    if (filtre && !filtre(m.id)) { sansEnjeu++; continue; }
    /* Deja tranchee par ESPN : sa ligue n'a plus rien a nous apprendre par
       cette rencontre-la. Si une AUTRE rencontre de la meme ligue attend, la
       ligue reste dans la liste — c'est pour ca que le test porte sur la
       rencontre et non sur la ligue. */
    if (dejaVues.has(m.id)) continue;
    /* Commencee depuis moins de AUTO_DELAI_MIN + 110 min : le tri la
       renverrait en « finie depuis trop peu ». PARIS_SCORES_SAUTE_ENCOURS=1
       seulement (eteint par defaut, lot 4) : on ne la paie pas. */
    if (sauteEnCours && t - m.debut < mur) { sautees++; continue; }
    if (!parLigue.has(l)) parLigue.set(l, m.sport);
    if (!declencheurs.has(l)) declencheurs.set(l, []);
    declencheurs.get(l).push(m);
  }
  if (sansEnjeu) {
    /* On le DIT. Une economie silencieuse se lit comme une panne le jour ou
       une rencontre ne remonte pas, et l'on cherche du cote du reseau. */
    console.log(`[odds] ${sansEnjeu} rencontre(s) finie(s) sans pari en attente —`
                + ' pas de score demande pour elles');
  }
  if (sautees) {
    console.log(`[odds] ${sautees} rencontre(s) commencee(s) depuis moins de ${AUTO_DELAI_MIN + 110} min —`
                + ' pas de score paye pour elles (PARIS_SCORES_SAUTE_ENCOURS=1)');
  }

  const finis = gratuites.filter((f) => ouverts.has(f.id));
  /* ---- LA COUPE D'UNE CLE JAMAIS APPARIEE (lot 4, ETEINTE par defaut) ----
   * PARIS_SCORES_COUPE=1 seulement, et seulement une cle NON cochee « Scores &
   * Results » qui n'a rien apparie sur ses PARIS_SCORES_COUPE_N derniers
   * appels payes inutiles (30 jours glissants). Ses rencontres ne se perdent
   * pas : elles partent dans la liste « a la main », avec leur raison, des
   * qu'elles ont l'age d'etre reglees. */
  for (const clef of [...parLigue.keys()]) {
    const raison = clefCoupee(clef, t);
    if (!raison) continue;
    parLigue.delete(clef);
    console.log(`[odds] scores ${clef} : ${raison} — plus demandee, a regler a la main`);
    const attente = attenteCoupeMs(clef);
    for (const m of declencheurs.get(clef) || []) {
      /* pas avant la duree de son format (voir `attenteCoupeMs`) : jusque-la,
         elle n'est nulle part, comme une rencontre que /scores ne dit pas
         encore finie */
      if (t - m.debut < attente) continue;
      finis.push({ id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur, coupe: true,
                   aMain: `scores plus demandes pour ${clef} (${raison}) : verifier que la rencontre est finie, puis regler a la main` });
    }
  }
  if (!parLigue.size) {
    const total = paris.catalogue().matchs.length;
    console.log(total
      ? `[odds] aucune rencontre finie dans les 3 derniers jours sur ${total} au calendrier — 0 credit depense`
      : '[odds] catalogue vide — lancez d abord --matchs');
    /* Et l'on rend quand meme ce qu'ESPN a trouve : sortir ici les aurait
       jetees, et c'est le cas le PLUS frequent — le jour ou tout se regle
       gratuitement, il ne reste plus une seule ligue a interroger. */
    return finis;
  }
  console.log(`[odds] ${parLigue.size} ligue(s) a interroger → ${parLigue.size * 2} credit(s)`);

  /* Un appel sans en-tete (erreur) dont le cout se deduira peut-etre de
     l'appel suivant, et le compteur lu juste apres le dernier appel a en-tete
     de CETTE passe (lot 4, voir `compteScores`). */
  let suspens = null, lu = null;
  for (const [clef] of parLigue) {
    let sc;
    /* ---- TROIS JOURS DEMANDES, TROIS JOURS FILTRES ----
     * On demandait `daysFrom: 1` — les rencontres finies depuis la veille —
     * alors que la boucle du dessus retient tout ce qui a moins de TROIS
     * jours. Une rencontre de deux jours etait donc mise dans la liste des
     * ligues a interroger, payee deux credits, et absente de la reponse.
     * Elle glissait ensuite hors des trois jours, ou plus rien ne la
     * regardait : elle restait « a regler » POUR TOUJOURS. C'est ce qu'on
     * voyait dans le panneau — des paris tennis en attente depuis trois cents
     * heures.
     * Le cout ne change pas : `daysFrom` vaut deux credits, quelle que soit sa
     * valeur. On demandait moins pour le meme prix. */
    /* `info` (socle) rend le cout lu, le statut et le code : le compte du
       lot 4 en vit. Sans classe dite : classe 1, comme avant. */
    const info = {};
    const decl = declencheurs.get(clef) || [];
    const avant = instantaneQuota();
    /* Le compteur d'avant cet appel n'est connu que si rien n'a ete facture
       depuis la derniere lecture de cette passe. (`lu.jour === avant.jour` :
       inatteignable aujourd'hui — aucun await entre ces deux lectures —,
       garde si un await s'y glisse.) */
    avant.u = lu && lu.jour === avant.jour && lu.appels === avant.appels && lu.depense === avant.depense ? lu.u : null;
    let rate = false, rendus = 0, finiesN = 0, appariees = 0;
    try { sc = await appel(`/sports/${clef}/scores`, { daysFrom: 3 }, 2, 'scores ' + clef, undefined, info); }
    catch (e) { console.log('[odds] ' + e.message); rate = true; }
    if (!rate) rendus = Array.isArray(sc) ? sc.length : 0;
    for (const ev of rate ? [] : sc || []) {
      if (ev && ev.completed) finiesN++;
      if (!ev.completed || !Array.isArray(ev.scores)) continue;
      const dom = ev.scores.find((s) => s.name === ev.home_team);
      const ext = ev.scores.find((s) => s.name === ev.away_team);
      if (!dom || !ext) continue;
      const a = Number(dom.score), b = Number(ext.score);
      if (!isFinite(a) || !isFinite(b)) continue;
      const resultat = a > b ? '1' : b > a ? '2' : 'N';
      /* TOUTES les entrees de cet evenement, pas la premiere : une rencontre
         deplacee laisse une ancienne entree (fermee) a cote de la nouvelle, et
         `find` ne reglait que l'une des deux. */
      const cibles = paris.catalogue().matchs.filter((m) =>
        m.source && m.source.evenement === ev.id);
      for (const cible of cibles) {
        if (!ouverts.has(cible.id)) continue;
        if (dejaVues.has(cible.id)) continue;    // ESPN l'a deja tranchee
        const f = { id: cible.id, sport: cible.sport, domicile: ev.home_team,
                    exterieur: ev.away_team, score: `${a}-${b}`, resultat };
        /* ---- LE FOOTBALL A 90 MINUTES (08/10/2026) ----
         * `/scores` rend le score FINAL, prolongation comprise, sans dire s'il
         * y en a eu une. Nos marches de football se reglent a 90 minutes : sur
         * la finale de la Coupe du Roi 2025, 3-2 apres prolongation, 2-2 a 90',
         * le 1-N-2 aurait paye « 1 » au lieu de « N ». ESPN, lui, le dit
         * (STATUS_FULL_TIME / STATUS_FINAL_AET / STATUS_FINAL_PEN). Un score
         * de football qui n'a pas pu passer par ESPN part donc a la main, MAIS
         * seulement la ou une prolongation peut exister : en championnat il
         * n'y en a jamais, et tout envoyer a la main aurait mis a la main des
         * saisons entieres d'equipes qu'ESPN nomme autrement (Rennes, Koln,
         * Slavia Praha… — relecture du 08/10). */
        if (cible.sport === 'foot' && prolongationPossible(cible))
          f.aMain = 'score de football venu de The Odds API : il peut compter la prolongation, regler sur le score a 90 minutes';
        finis.push(f);
        appariees++;
      }
    }
    /* Le compte ne peut pas faire perdre ce qui vient d'etre lu : un journal
       en panne (note qui leve) est isole ici, et la boucle continue. */
    try {
      suspens = compteScores(clef, { info, avant, rendus, finies: finiesN, appariees, t: Date.now(),
        vieux: decl.some((m) => t - m.debut >= mur), declencheurs: decl.length,
        ageMaxMin: decl.length ? Math.round(Math.max(...decl.map((m) => t - m.debut)) / 60000) : null }, suspens);
    } catch (e) { suspens = null; console.log('[odds] compte des scores : ' + (e.message || e)); }
    try {
      if (info.utilise !== null && info.utilise !== undefined && isFinite(Number(info.utilise))) {
        const s = instantaneQuota();
        lu = { u: Number(info.utilise), jour: s.jour, appels: s.appels, depense: s.depense };
      } else lu = null;
    } catch (e) { lu = null; }
  }
  /* Le dernier appel sans en-tete n'a pas de suivant : son cout reste inconnu. */
  if (suspens) { try { regJournal.deduitCout(suspens.entree, null); } catch (e) { /* jamais bloquant */ } }

  if (!finis.length) { console.log('[odds] aucune rencontre finie a regler'); return finis; }
  console.log('\n[odds] a REGLER — verifiez le score avant d appeler :');
  for (const f of finis) {
    if (f.aMain) {
      /* Le score rendu peut compter la prolongation : on ne propose PAS de
         commande qui le paierait tel quel. */
      console.log(`  ${f.domicile} ${f.score || '?'} ${f.exterieur}  →  A LA MAIN : ${f.aMain}`);
      console.log(`    curl -H "x-admin-key: $ADMIN_KEY" "$URL/paris/regle?match=${f.id}&score=<score a 90 minutes>"`);
      continue;
    }
    console.log(`  ${f.domicile} ${f.score} ${f.exterieur}  →  resultat=${f.resultat}`);
    /* ---- ON ENVOIE LE SCORE, PLUS LA LETTRE ----
     * Il etait lu, affiche sur la ligne du dessus, puis jete. Le serveur en
     * deduit le 1-N-2 lui-meme, et le GARDE : c'est lui qui rend reglables
     * « les deux equipes marquent » et les autres marches. Une rencontre
     * reglee a la lettre ne le sera jamais, meme plus tard — on ne deduit pas
     * un score d'un « 1 ». */
    console.log(`    curl -H "x-admin-key: $ADMIN_KEY" ` +
                `"$URL/paris/regle?match=${f.id}&score=${f.score}"`);
  }
  return finis;
}

/*
 * ======================= LE REGLEMENT AUTOMATIQUE =======================
 *
 * Regler a la main etait un choix, pas un oubli : un service de resultats qui
 * se trompe paie les mauvaises personnes, et un reglement ne se defait pas —
 * l'argent est parti. Le calendrier ne comptait que quelques rencontres par
 * semaine, la verification tenait en deux minutes.
 *
 * Avec un calendrier qui s'alimente tout seul, ce n'est plus tenable : des
 * dizaines de rencontres par semaine, et des paris qui restent ouverts parce
 * que personne n'a eu le temps. Un pari gagnant non paye est pire qu'une
 * erreur de paiement : le joueur voit qu'il a gagne, et ne recoit rien.
 *
 * On automatise donc, avec quatre verrous. Aucun n'est decoratif :
 *
 *  1. LA SOURCE DOIT ETRE NETTE. `completed` vrai, les deux scores presents
 *     et numeriques, les deux noms retrouves. Au moindre doute on ne touche
 *     a rien et on signale.
 *
 *  2. UN PLAFOND D'EXPOSITION. Au-dessus, on ne regle pas tout seul. C'est
 *     le verrou qui compte : une erreur sur une rencontre a faible enjeu se
 *     repare a la main, la meme sur une rencontre ou la maison doit deux
 *     millions ne se repare pas. Le seuil se regle, et il est volontairement
 *     bas par defaut.
 *
 *  3. UN DELAI. On attend que la rencontre soit finie depuis un moment
 *     avant de payer. Un score « final » publie a la 90e minute peut encore
 *     bouger — prolongations, tirs au but, match arrete puis repris, et
 *     surtout la correction d'une saisie fausse. Ce delai ne coute rien a
 *     personne et evite la seule erreur qu'on ne peut pas defaire.
 *
 *  4. TOUT EST DIT. Chaque reglement automatique part sur Telegram avec le
 *     score, la source et ce qui a ete paye. Un automate silencieux est un
 *     automate que personne ne surveille.
 */

/* Au-dessus de cette exposition, la rencontre attend une main humaine. */
/* ---- LE PLAFOND DU REGLEMENT AUTOMATIQUE ----
 * Au-dessus, la rencontre attend une main humaine. Porte a cinq millions sur
 * demande du proprietaire.
 *
 * IL FAUT DIRE CE QUE CELA CHANGE VRAIMENT. L'engagement d'une rencontre est
 * lui-meme borne a `PARI_ENGAGEMENT_MAX` — deux millions — au moment ou le
 * pari est accepte. Un plafond de cinq millions ne peut donc JAMAIS etre
 * atteint : le filet qui retenait les grosses affiches pour verification ne
 * se declenchera plus, et tout se reglera seul.
 * C'est le reglage demande, et il est coherent avec lui-meme ; il n'est
 * simplement plus un filet. Le remettre en service demanderait un chiffre
 * SOUS deux millions. */
const AUTO_PLAFOND = Number(process.env.PARIS_AUTO_PLAFOND || 5000000);
/* Depuis combien de temps la rencontre doit etre finie. */
const AUTO_DELAI_MIN = Number(process.env.PARIS_AUTO_DELAI_MIN || 90);
/* Le coupe-circuit. `0` remet tout a la main, sans redeployer. */
const AUTO_ACTIF = String(process.env.PARIS_AUTO || '1') !== '0';

/* ==================== LE REGLEMENT : L'OMBRE ET LE COMPTE (lot 4, 10/10/2026) ====================
 *
 * Deux mesures, a 0 credit, qui ne changent RIEN de ce qui se regle ni de ce
 * qui se paie tant que leurs drapeaux sont a leur defaut (EXPLOITATION 8.10).
 *
 * A. L'OMBRE. Une rencontre devient reglable 200 min apres son coup d'envoi
 *    (AUTO_DELAI_MIN + 110, `trieReglements`) ; la seule passe qui regle est
 *    la quotidienne, qui part aussi 5 min apres CHAQUE demarrage (118
 *    redeploiements en 17 jours, EXPLOITATION 8.3). Sans redeploiement elle
 *    attend jusqu'a 24 h (12 h en moyenne) ; une passe de 2 h la reglerait en
 *    1 h en moyenne. Mais regler plus tot laisse moins de temps a une
 *    correction de score. L'ombre lit donc ESPN (gratuit) toutes les 2 h, sur
 *    TOUTES les rencontres des tableaux ESPN finies depuis moins de 36 h —
 *    pariees ou non : 2 rencontres seulement portaient un pari le 09/10, 20 en
 *    14 jours ne s'atteindraient pas — et note ce qu'une passe de 2 h AURAIT
 *    regle, quand, et toute correction vue dans les 24 h suivantes (score,
 *    statut, retour a un etat non fini, disparition d'un tableau qui a
 *    repondu). Elle ne regle rien et ne publie rien.
 * B. LE COMPTE. Chaque /scores paye est note par cle : credits lus
 *    (x-requests-last), statut, code, rendues, finies, appariees. Rien ne
 *    limite ce /scores a un appel par jour : il part a chaque demarrage (~8
 *    fois par jour au rythme de septembre). La coupe d'une cle jamais
 *    appariee existe mais reste ETEINTE.
 */

/* La passe ESPN frequente. « observe » (defaut) : l'ombre seule, rien n'est
   regle ni publie, 0 credit. « regle » : la passe de 2 h regle aussi ce
   qu'ESPN tranche (0 credit, jamais de /scores paye) — c'est la bascule A,
   au plus tot J0 + 14, porte ecrite d'avance en EXPLOITATION 8.10. « 0 » :
   ni ombre ni passe, l'etat d'avant ce lot. Toute autre valeur vaut
   « observe » et se dit au demarrage : une faute de frappe ne regle rien. */
function modeEspn() {
  const v = String(process.env.PARIS_SCORES_ESPN || '').trim().toLowerCase();
  return v === 'regle' || v === '0' ? v : 'observe';
}
function modeEspnInvalide() {
  const v = String(process.env.PARIS_SCORES_ESPN || '').trim().toLowerCase();
  return v && v !== 'regle' && v !== '0' && v !== 'observe' ? String(process.env.PARIS_SCORES_ESPN) : null;
}
function entierEnv(nom, defaut, min, max) {
  const v = Number(process.env[nom]);
  return String(process.env[nom] || '').trim() && Number.isInteger(v) && v >= min && v <= max ? v : defaut;
}
/* La cadence : 2 h, decision du proprietaire du 09/10 (3 h donnait ~1 h 30
   d'attente moyenne au lieu d'1 h). Bornee 1 a 24 h. La charge ESPN : ~22
   tableaux x 4 journees par passe x 12 passes = ~1 050 requetes par jour
   (au plus 6 journees par tableau au suivi de 24 h : ~1 580),
   contre ~7 680 deja faites par le verrou de fermeture (~80 par passe large,
   toutes les 15 min, EXPLOITATION 8.7). Les refus se comptent dans
   espn.refusDuJour, comme ceux du verrou. */
const scoresEspnH = () => entierEnv('PARIS_SCORES_ESPN_H', 2, 1, 24);
/* La fenetre de la passe frequente en mode « regle » (la quotidienne garde
   ses 30 jours, FEN_ESPN). 4 jours au plus : `espn.releve` demande
   [plus tot - 1 j ; plus tard + 1 j] et passe au MOIS au-dela de 7 journees
   (scores_espn.js, JOURS_MAX) — un mois de MLB pese 7 Mo (mesure du 08/10). */
const scoresEspnFenJ = () => entierEnv('PARIS_SCORES_ESPN_FEN_J', 3, 1, 4);
/* La duree de suivi d'une rencontre apres sa premiere lecture reglable, pour
   y compter les corrections. 24 h : au-dela, une correction n'est plus le
   risque d'un reglement a 2 h plutot qu'a 24 h. Bornee 1 a 48 h (relecture
   du lot 4 : 72 etait accepte) : une rencontre en suivi a au plus 36 h (age
   d'entree) + OMBRE_H + 6 h (grace de `suivisEnCours`) ; `espn.releve`
   ajoute un jour de chaque cote. A 48 h : 90 h + 2 j ≈ 5,75 jours, 7
   journees UTC au plus, sous JOURS_MAX ; a 72 h : 7,75 jours, donc des
   MOIS toutes les 2 h (balayage de `espn.requetes` du 10/10 : 6 journees a
   24 h, 7 a 48 h, le mois a 72 h). */
const ombreH = () => entierEnv('PARIS_SCORES_OMBRE_H', 24, 1, 48);
/* L'ombre lit les rencontres commencees depuis moins de 36 h — la tolerance
   d'appariement d'ESPN (scores_espn.releve) et la passe large du verrou —, et
   celles encore dans leur fenetre de suivi. Une rencontre pariee vieille de 20
   jours n'y entre pas : elle ferait demander des mois toutes les 2 h. */
const OMBRE_FENETRE_MS = 36 * 3600000;

/* B. La coupe du /scores paye d'une cle jamais appariee. « 1 » l'arme ;
   defaut ETEINTE : on compte d'abord (porte B, au plus tot J0 + 30). */
const scoresCoupe = () => String(process.env.PARIS_SCORES_COUPE || '').trim() === '1';
/* L'echantillon minimal : 5 appels payes INUTILES (x-requests-last > 0, payes
   pour une rencontre de plus de AUTO_DELAI_MIN + 110 min, 0 appariee) sur 30
   jours glissants. Cinq : un mois de rencontres de cricket a une par semaine,
   decision du plan du 09/10 (pas une mesure : la porte B la fait). */
const scoresCoupeN = () => entierEnv('PARIS_SCORES_COUPE_N', 5, 1, 1000);
const SCORES_COUPE_JOURS = 30;
/* La coupe ne vise QUE les cles NON cochees « Scores & Results » sur la page
   des sports de The Odds API (https://the-odds-api.com/sports-odds-data/sports-apis.html,
   lue le 09/10/2026) : les 16 cles de cricket, et 32 tournois de tennis sur
   47. Une cle cochee — la Liga, la NBA… — n'est JAMAIS coupee : son /scores
   n'apparie presque jamais (ESPN tranche d'abord, puis il part pendant le
   match a chaque demarrage) mais c'est la seule defense si ESPN tombe. Une
   cle absente de la liste (un tournoi pas encore sur la page) n'est pas
   coupee non plus : mieux vaut payer deux credits que laisser un gagnant. */
const SCORES_NON_COCHEES = new Set([
  'cricket_asia_cup', 'cricket_big_bash', 'cricket_caribbean_premier_league', 'cricket_icc_trophy',
  'cricket_icc_world_cup', 'cricket_icc_world_cup_womens', 'cricket_international_t20', 'cricket_ipl',
  'cricket_odi', 'cricket_psl', 'cricket_t20_blast', 'cricket_t20_world_cup', 'cricket_t20_world_cup_womens',
  'cricket_test_match', 'cricket_the_hundred', 'cricket_the_hundred_womens',
  'tennis_atp_aus_open_singles', 'tennis_atp_barcelona_open', 'tennis_atp_dubai', 'tennis_atp_french_open',
  'tennis_atp_hamburg_open', 'tennis_atp_halle_open', 'tennis_atp_indian_wells', 'tennis_atp_italian_open',
  'tennis_atp_madrid_open', 'tennis_atp_miami_open', 'tennis_atp_monte_carlo_masters', 'tennis_atp_munich',
  'tennis_atp_paris_masters', 'tennis_atp_qatar_open', 'tennis_atp_queens_club_champ', 'tennis_atp_wimbledon',
  'tennis_wta_aus_open_singles', 'tennis_wta_bad_homburg_open', 'tennis_wta_charleston_open', 'tennis_wta_dubai',
  'tennis_wta_french_open', 'tennis_wta_german_open', 'tennis_wta_indian_wells', 'tennis_wta_italian_open',
  'tennis_wta_madrid_open', 'tennis_wta_miami_open', 'tennis_wta_qatar_open', 'tennis_wta_queens_club_champ',
  'tennis_wta_strasbourg', 'tennis_wta_stuttgart_open', 'tennis_wta_wimbledon', 'tennis_wta_wuhan_open',
]);
/* L'economie sure, d'abord comptee : « 1 » ne paie plus de /scores pour une
   rencontre commencee depuis moins de AUTO_DELAI_MIN + 110 min — que
   `trieReglements` renverrait de toute facon en « finie depuis trop peu ».
   Defaut ETEINTE : le compte (`precoces`) dit d'abord combien elle
   economiserait (porte en EXPLOITATION 8.10). */
const scoresSauteEnCours = () => String(process.env.PARIS_SCORES_SAUTE_ENCOURS || '').trim() === '1';

/* ---- LES PORTES, ECRITES D'AVANCE (EXPLOITATION 8.10) ----
 * A (PARIS_SCORES_ESPN=regle) : au plus tot 14 jours d'ombre ; au moins 300
 * rencontres suivies 24 h SANS TROU (aucune lecture a plus de 3 cadences de
 * la precedente), 0 correction (retours et disparitions compris : 0 sur 300
 * borne le taux sous 1 % a 95 %, regle de trois), et un gain median BAS
 * (prochaine passe reelle moins la premiere lecture reglable, 0 si une passe
 * reelle a pu la regler avant) d'au moins 1 h sur toutes les rencontres de
 * l'ombre. Les rencontres pariees sont un controle, jamais un seuil.
 * B (PARIS_SCORES_COUPE=1) : au plus tot 30 jours de compte, cle par cle,
 * seulement les cles NON cochees. */
const PORTE_A = Object.freeze({ joursMin: 14, suiviesMin: 300, correctionsMax: 0, gainMinH: 1 });
const PORTE_B = Object.freeze({ joursMin: 30 });

/* ======================= LE PRIX DU MARCHE (08/10/2026) =======================
 *
 * Sur les grands championnats (prix_marche.ligues()), chaque rencontre a venir
 * prend le prix du marche s'il a moins de 36 h ; sinon elle est SUSPENDUE —
 * jamais rendue a l'Elo en silence. Les autres championnats restent a l'Elo.
 * Une rencontre commencee ne bouge plus (ses paris sont poses).
 */
function avecPrix(m, now) {
  const t = now || Date.now();
  const l = m && m.source && m.source.ligue;
  const sortie = Object.assign({}, m);
  delete sortie.prixMarche; delete sortie.suspendu; delete sortie.suspenduRaison;
  if (!l || !prixMarche.vendue(l) || !(Date.parse(m.debut) > t)) return sortie;
  /* Le tennis « vendu » (lot 3) : jamais au prix du marche sans verrou d'heure
     reelle, meme si le carnet garde un prix de son observation — SUSPENDU,
     jamais rendu a l'Elo (prix_ligues.venteImpossible). */
  if (prixMarche.venteImpossible(l)) return Object.assign(sortie, { cotesGenerees: true, suspendu: true,
    suspenduRaison: 'pas de vente au prix du marche sans verrou d heure reelle (tennis)' });
  const r = prixMarche.pour(m.source.evenement, t);
  if (!r) return Object.assign(sortie, { cotesGenerees: true, suspendu: true,
    suspenduRaison: 'pas de prix du marche de moins de ' + Math.round(prixMarche.AGE_MAX_MS / 3600000) + ' h' });
  /* Le prix est range sur les equipes du releve : si le fournisseur a inverse
     domicile et exterieur depuis, le « 1 » du marche n'est plus le notre. */
  if (r.dom && (r.dom !== m.domicile || r.ext !== m.exterieur)) return Object.assign(sortie, { cotesGenerees: true,
    suspendu: true, suspenduRaison: 'prix releve dans l autre orientation' });
  return Object.assign(sortie, { cotesGenerees: true,
    prixMarche: { ref: r.ref, t: new Date(r.t).toISOString(), livres: r.livres, p: r.p } });
}

/* Relever le prix d'une liste de championnats : 1 credit chacun, sous le
   garde-fou de la part du jour (`appel`). Rend le nombre de championnats
   VENDUS releves : c'est lui qui decide de refaire le calendrier (`planifie`). */
/* UNE releve a la fois : les minuteries de 30 et de 10 min tombent au meme
   instant toutes les demi-heures, et deux releves paralleles payaient deux
   fois le meme championnat (relecture du 08/10). Chaque championnat est
   relu juste avant l'appel : releve depuis moins de `ageMin`, il passe. */
/* ---- LA PRIORITE EST POUR CE QUI EST VENDU (socle, 10/10/2026) ----
 * Toute cle relevee passait en priorite, observee comprise, avec
 * `aRelever().size` pour reserve : une observation (deux issues, coupes)
 * pouvait passer au-dela de la part du jour et entamer ce qui garantit une
 * releve par championnat VENDU jusqu'a la fin du mois. Desormais : une cle
 * vendue est en classe 0, prioritaire avec `ligues().size` (une releve par
 * championnat vendu et par jour) ; une cle observee est en classe 3, jamais
 * prioritaire, refusee sans alerte quand le jour est charge. Et le
 * calendrier ne se refait plus apres une releve qui n'a rien change a ce qui
 * se vend (le prix d'une cle observee n'entre pas dans les cotes). */
/* ---- UNE CLE DONT ON NE SAIT PAS LE NOMBRE D'ISSUES NE COUTE RIEN (lot 3, 10/10/2026) ----
 * `prix_marche.note` ne note rien sans sport connu (on ne devine pas un nombre
 * d'issues) : la date de releve n'etait donc jamais ecrite, et prixPerimes la
 * redemandait a chaque passage de 30 min — jusqu'a 48 credits par jour et par
 * cle, ~336 sur l'horizon de 7 jours (relecture du 09/10 : le catalogue garde
 * les rencontres d'une ligue retiree d'ODDS_API_LIGUES). Une telle cle, ou
 * une cle refusee (cricket), n'est donc JAMAIS payee, et c'est dit une fois
 * par processus. Une cle soccer_* garde les trois issues du football, comme
 * avant ce lot. */
const SANS_SPORT_DIT = new Set();
let filePrix = Promise.resolve();
function rafraichitPrix(clefs, pourquoi, ageMin) {
  const tour = filePrix.then(async () => {
    let vendues = 0;
    for (const clef of clefs) {
      if (Date.now() - prixMarche.derniere(clef) < (ageMin || 0)) continue;
      /* `vendue` et non plus `ligues().has` : le joker du tennis (lot 3) */
      const vendue = prixMarche.vendue(clef);
      const sport = sportDeLaCle(clef);
      if (!prixMarche.issuesDe(sport, clef)) {
        if (!SANS_SPORT_DIT.has(clef)) {
          SANS_SPORT_DIT.add(clef);
          console.log(`[odds] prix ${clef} : ` + (prixMarche.refusee(clef) ? 'cle refusee (cricket)'
            : prixMarche.venteImpossible(clef) ? 'vendue sans verrou d heure reelle (tennis) : ses rencontres restent suspendues'
            : 'sport inconnu (absente d ODDS_API_LIGUES et de ses jokers)') + ' — jamais relevee, 0 credit');
        }
        continue;
      }
      const info = { classe: vendue ? 0 : 3 };
      try {
        const evs = await appel(`/sports/${clef}/odds`, { regions: REGION, markets: MARCHE, oddsFormat: 'decimal' },
                                1, 'prix ' + clef, vendue ? prixMarche.ligues().size : undefined, info);
        const c = prixMarche.note(evs, clef, undefined, { quoi: pourquoi, sport });
        console.log(`[odds] prix du marche ${clef} (${pourquoi}) : ${JSON.stringify(c)}`);
        /* un championnat OBSERVE : on dit tout de suite ce que notre Elo y laisse,
           et le carnet d'observation garde la releve (lot 3) */
        if (!vendue) {
          console.log(`[odds] observe ${clef} : ${JSON.stringify(ecartAuMarche(clef))}`);
          try { prixObserve.noteEu(clef, sport, c, Date.now(), 'ok'); } catch (x) { console.log('[obs] ' + clef + ' : ' + (x.message || x)); }
        } else vendues++;
      } catch (e) {
        console.log('[odds] prix ' + clef + ' : ' + (e.message || e));
        /* Le refus d'une cle observee est VOULU (classe 3, jamais prioritaire) :
           garde a l'historique, il ne compte pas contre la porte P3 ; une
           erreur du fournisseur, si (EXPLOITATION 8.8nonies). */
        if (!vendue) {
          try { prixObserve.noteEu(clef, sport, null, Date.now(), info.code === 'REFUSE' ? 'refuse' : 'erreur'); } catch (x) { /* jamais bloquant */ }
        }
      }
    }
    return vendues;
  });
  filePrix = tour.catch(() => 0);
  return tour;
}

/* ---- QUAND RELEVER ----
 * Une fois par jour et par championnat (22 h d'ecart), date ecrite sur le
 * volume : un redeploiement ne repaie rien (118 redeploiements en 17 jours en
 * septembre). Et avant le coup d'envoi — 15 min a 2 h — pour un championnat
 * dont une rencontre PORTE DES PARIS, si son dernier releve a plus de 3 h :
 * c'est la que l'argent se pose, et qu'un prix d'un jour peut avoir bouge
 * (blessure, composition). Budget mesure sur le forfait gratuit : 6 credits
 * par jour pour les six championnats, ~186 par mois, plus les passages
 * d'avant-match (rares : 2 rencontres portaient des paris le 08/10). */
const PRIX_JOUR_MS = 22 * 3600000, PRIX_AVANT_MS = 2 * 3600000, PRIX_DEMANDE_MS = 3600000;
/* Seulement les championnats qui ont une rencontre a venir au calendrier : en
   treve internationale, six credits par jour partaient pour rien — et une cle
   mal ecrite dans PARIS_PRIX_LIGUES n'est jamais payee. */
function liguesAvecRencontre(now) {
  const t = now || Date.now(), out = new Set();
  for (const m of paris.catalogue().matchs) if (m.debut > t && m.source && m.source.ligue) out.add(m.source.ligue);
  return out;
}
/* ---- LE SPORT D'UNE CLE (lot 3, 10/10/2026) ----
 * Celui de sa ligne d'ODDS_API_LIGUES, sinon celui du joker qui la suit
 * (`tennis=*` : tennis_atp_… / tennis_wta_…, jamais un `_winner`). null
 * sinon : le nombre d'issues vient du sport, et une cle sans sport n'est
 * jamais payee (`rafraichitPrix`). */
function sportDeLaCle(clef) {
  const k = String(clef || '');
  const l = LIGUES.find((x) => x.clef === k);
  if (l) return l.sport;
  const j = LIGUES.find((x) => x.clef === '*' && JOKERS[x.sport] && JOKERS[x.sport]({ key: k }));
  return j ? j.sport : null;
}
/* ---- CE QUE NOTRE 1-N-2 LAISSE AU MARCHE, EN DIRECT (09/10/2026) ----
 * Pour un championnat OBSERVE (ou vendu) : chaque rencontre a venir du
 * catalogue, ouverte, dont le prix du marche est frais et dans le bon sens ;
 * une issue est « battable » quand notre cote x la proba du marche (marge
 * retiree) depasse 1. C'est la mesure qui decide d'un basculement : sur le
 * banc, 20 % des issues 1-N-2 Elo l'etaient (test 2023-26). */
function ecartAuMarche(ligue, now) {
  const t = now || Date.now();
  const out = { rencontres: 0, avecPrix: 0, issues: 0, battables: 0, esperanceMoyenne: null, pire: null };
  let somme = 0;
  try {
    for (const m of paris.catalogue().matchs) {
      if (!m.source || m.source.ligue !== ligue || !paris.ouvert(m, t)) continue;
      out.rencontres++;
      const r = prixMarche.pour(m.source.evenement, t);
      if (!r || !r.p || (r.dom && (r.dom !== m.domicile || r.ext !== m.exterieur))) continue;
      const c = (m.marches && m.marches[paris.MARCHE_BASE] && m.marches[paris.MARCHE_BASE].cotes) || m.cotes;
      if (!c) continue;
      out.avecPrix++;
      let meilleure = -1;
      /* les issues du SPORT (lot 3) : deux au hockey, a la NFL, a la NBA, au tennis */
      for (const i of (paris.sportConnu(m.sport) ? paris.issues(m.sport) : ['1', 'N', '2'])) {
        if (!(Number(c[i]) > 1) || !(r.p[i] > 0)) continue;
        const e = Number(c[i]) * r.p[i] - 1;
        out.issues++;
        if (e > 0) out.battables++;
        if (e > meilleure) meilleure = e;
        if (!out.pire || e > out.pire.esperance) out.pire = { rencontre: m.domicile + ' v ' + m.exterieur, issue: i, cote: Number(c[i]), marche: Math.round(r.p[i] * 1000) / 1000, esperance: Math.round(e * 1000) / 1000 };
      }
      somme += meilleure;
    }
  } catch (e) { /* catalogue illisible */ }
  if (out.avecPrix) out.esperanceMoyenne = Math.round(somme / out.avecPrix * 1000) / 1000;
  return out;
}
/* ---- UNE CLE MAL ECRITE SE DIT, MEME AVEC LE JOKER (09/10/2026) ----
 * Les cles de PARIS_PRIX_LIGUES / PARIS_PRIX_OBSERVE absentes des ligues
 * importees : jamais relevees, donc jamais vendues au marche. Le joker
 * `tennis=*` (liste par defaut) taisait TOUT avertissement — une cle mal
 * recopiee renvoyait son championnat a l'Elo sans un mot (relecture
 * contradictoire du 09/10). Une cle n'est excusee que si le joker la suivra
 * vraiment. */
function prixInconnues() {
  const connues = new Set(LIGUES.map((l) => l.clef));
  /* exactement ce que le joker suivra : `tennis_atp_…` / `tennis_wta_…`, sans
     les classements `_winner` (JOKERS) */
  const jokers = LIGUES.filter((l) => l.clef === '*' && JOKERS[l.sport]).map((l) => JOKERS[l.sport]);
  const out = [...prixMarche.aRelever()].filter((c) => !connues.has(c) && !jokers.some((j) => j({ key: c })));
  /* Un joker des deux listes (lot 3) : `tennis_atp_*` ne releve rien si
     ODDS_API_LIGUES ne suit pas le tennis par son propre joker. */
  for (const e of [...prixMarche.ligues(), ...prixMarche.observees()]) {
    if (e.indexOf('*') < 0 || !prixLigues.JOKER_PERMIS.test(e) || out.includes(e)) continue;
    if (!jokers.some((j) => j({ key: e.slice(0, -1) + 'x' }))) out.push(e);
  }
  return out;
}
/* ---- LA PORTE DE VENTE SE DIT (09/10/2026) ----
 * `paris.ouvert` ferme une rencontre FABRIQUEE d'un championnat vendu qui n'a
 * pas de prix du marche — le catalogue d'avant une bascule, tant que l'import
 * ne l'a pas refait. Relecture du 09/10 : rien ne l'ecrivait, et une ligue
 * entiere pouvait disparaitre de la page douze heures si l'import du
 * demarrage echouait. Compte par championnat, ecrit au demarrage et apres un
 * import qui n'a rien obtenu. */
function fermeesParLaPorte(now) {
  const t = now || Date.now(), out = {};
  try {
    for (const m of paris.catalogue().matchs) {
      const l = m.source && m.source.ligue;
      if (!l || !prixMarche.vendue(l) || !(m.debut > t) || m.suspendu || m.prixMarche || !m.cotesGenerees) continue;
      out[l] = (out[l] || 0) + 1;
    }
  } catch (e) { /* catalogue illisible */ }
  return out;
}
function ditLaPorte(quand) {
  const f = fermeesParLaPorte();
  const n = Object.values(f).reduce((a, b) => a + b, 0);
  if (n) console.log(`[odds] porte de vente (${quand}) : ${n} rencontre(s) fermee(s), catalogue sans prix du marche — `
    + Object.entries(f).map(([k, v]) => k + ' ' + v).join(', '));
  return n;
}
function etatPrix(now) {
  const t = now || Date.now(), out = {};
  const couv = prixMarche.lis().couverture || {};
  let avec = new Set();
  try { avec = liguesAvecRencontre(t); } catch (e) { /* catalogue illisible : les cles ecrites en clair */ }
  /* les cles ecrites, plus celles du calendrier que couvre un joker (lot 3) */
  for (const c of prixMarche.aRelever(avec)) {
    const d = prixMarche.derniere(c);
    out[c] = { releve: d ? new Date(d).toISOString() : null, auPrix: 0, suspendues: 0, fermeesSansPrix: 0,
               couverture: couv[c] || null };
    if (!prixMarche.vendue(c)) Object.assign(out[c], { observe: true, cadenceH: Math.round(prixMarche.cadenceDe(c) / 360000) / 10, ecart: ecartAuMarche(c, t) });
  }
  try {
    for (const m of paris.catalogue().matchs) {
      const l = m.source && m.source.ligue;
      if (!out[l] || !(m.debut > t)) continue;
      if (m.suspendu) out[l].suspendues++; else if (m.prixMarche) out[l].auPrix++;
      else if (m.cotesGenerees && prixMarche.vendue(l)) out[l].fermeesSansPrix++;
    }
  } catch (e) { /* catalogue illisible : les dates suffisent */ }
  return out;
}
/* ---- QUI EST PERIME, CLE PAR CLE (lot 3, 10/10/2026) ----
 * Une cle VENDUE suit `releveMs` (PARIS_PRIX_RELEVE_H) ; une cle OBSERVEE
 * suit `observeMs` (PARIS_PRIX_OBSERVE_H, 12 h par defaut) : `cadenceDe`.
 * Le joker du tennis ne developpe que les cles du calendrier : une cle sans
 * rencontre a venir ne coute jamais un credit. */
function prixPerimes(now) {
  const t = now || Date.now(), avec = liguesAvecRencontre(t);
  return [...prixMarche.aRelever(avec)].filter((c) => avec.has(c) && t - prixMarche.derniere(c) >= prixMarche.cadenceDe(c));
}
/* Les cles de `--prix` (a la main) : les cles ecrites, plus celles du
   calendrier que couvre un joker (lot 3). Nommee pour qu'un essai la tienne :
   ecrite dans le bloc `require.main`, aucune verification ne la voyait
   (mutations du 10/10/2026). */
function clefsALaMain(now) { return [...prixMarche.aRelever(liguesAvecRencontre(now))]; }
/* Avant le coup d'envoi : de 75 a 20 min avant (les compositions tombent
   environ une heure avant), pour un championnat dont une rencontre porte des
   paris et dont le dernier releve a plus de 2 h. Avec un forfait paye,
   `PARIS_PRIX_AVANT_TOUS=1` releve avant CHAQUE coup d'envoi, paris ou non :
   c'est la que le prix bouge le plus (compositions, blessures). */
function prixAvantMatch(aDesParis, now) {
  const t = now || Date.now();
  const out = new Set();
  if (typeof aDesParis !== 'function') return [];
  if (process.env.PARIS_PRIX_AVANT_TOUS === '1') aDesParis = () => true;
  for (const m of paris.catalogue().matchs) {
    const l = m.source && m.source.ligue;
    /* `vendue` (lot 3) : un tournoi vendu par joker a aussi son avant-match */
    if (!l || !prixMarche.vendue(l) || out.has(l)) continue;
    if (!(m.debut >= t + 20 * 60000 && m.debut <= t + 75 * 60000)) continue;
    if (t - prixMarche.derniere(l) < PRIX_AVANT_MS) continue;
    if (aDesParis(m.id)) out.add(l);
  }
  return [...out];
}
/* ---- LE TIC DE 10 MIN, CAUSE PAR CAUSE (lot 1, 10/10/2026) ----
 * Il relevait `[...new Set(prixAvantMatch(...).concat(paris.prixDemandes()))]`
 * sous une seule cause, « avant le coup d envoi » : le journal ne pouvait pas
 * dire combien de releves viennent de l'avant-match (PARIS_PRIX_AVANT_TOUS)
 * et combien des paris refuses faute de prix frais (`paris.prixDemandes`).
 * La recherche estimait les premieres a 506-520 par mois et jugeait ce
 * chiffre surestime : c'est lui qu'il faut lire avant de toucher a la cadence
 * pres du coup d'envoi. Deux lots : `avant`, puis `demande` SANS ce que
 * `avant` releve deja — exactement l'ordre et le contenu de l'ancien
 * ensemble ; `planifie` les met dans la file `filePrix` au meme instant, rien
 * ne s'intercale, et un championnat n'est jamais paye deux fois (essai T2
 * de prix_journal.test.js). `prixDemandes` vide la liste, comme avant. */
function causesAvantMatch(aDesParis, now) {
  const avant = prixAvantMatch(aDesParis, now);
  const demande = paris.prixDemandes().filter((c) => !avant.includes(c));
  return [{ quoi: 'avant', clefs: avant }, { quoi: 'demande', clefs: demande }].filter((x) => x.clefs.length);
}

/* ============ LE PLUS/MOINS 2,5 AU PRIX DES TOTAUX DU MARCHE (lot 5, 10/10/2026) ============
 *
 * OBSERVATION SEULEMENT dans ce lot. Trois variables, VIDES ou eteintes par
 * defaut (prix_ligues.js) : un deploiement ne releve rien, ne paie rien et
 * ne change rien de ce qui est vendu (socle.test.js, essais/reference, et
 * totaux_marche.test.js §5 le tiennent octet pour octet).
 *   PARIS_TOTAUX_OBSERVE  cles releves sans rien vendre (classe 3) ;
 *   PARIS_TOTAUX_LIGUES   cles ou la grille prend le total du marche (classe 1)
 *                         — rien avant les portes 0, 1 et 2 d'EXPLOITATION
 *                         8.8decies ;
 *   PARIS_TOTAUX_CLOTURE  '1' : une releve de cloture (classe 2) pour la
 *                         MESURE de la porte 2, jamais pour la vente.
 * Les spreads (handicap -1,5) ne sont jamais demandes : hors de ce lot.
 * Jamais prioritaire (5e argument d'`appel` absent) : si le jour se tend, les
 * totaux sont refuses avant le prix de ce qui est vendu. */

/* ---- LA PORTE DE VENTE DU TOTAL ----
 * Pose `butsMarche` = { total, t, ref, ligne } sur une rencontre de football
 * a venir d'une cle de PARIS_TOTAUX_LIGUES dont le total du carnet :
 *   - a au plus PARIS_TOTAUX_AGE_MAX_H (48 h : l'age du banc, prix_ligues) ;
 *   - est celui de ces deux equipes (`totaux_marche.pour`) ;
 *   - a une ligne de reference 2,5 : tant que la strate « ligne 1,5 ou 3,5
 *     extrapolee » n'est pas mesuree (porte 2), on ne vend que la ligne que
 *     le banc a jugee ;
 *   - a ete releve quand le 1-N-2 du marche etait celui d'aujourd'hui a 5
 *     points pres (`totaux_marche.servable`, DP_MAX) — sans prix du marche
 *     servi a la vente (`m.prixMarche`), on ne sait pas : pas servi.
 * Sinon on le RETIRE : la grille reprend le total du championnat, exactement
 * comme avant ; le 1-N-2 ne change pas. En observation (cle absente de
 * PARIS_TOTAUX_LIGUES), rien n'est pose : c'est la porte de l'observation.
 * Une rencontre commencee ne bouge plus (`habille` la rend telle quelle). */
function avecButs(m, now) {
  const t = now || Date.now();
  const sortie = Object.assign({}, m);
  delete sortie.butsMarche;
  const l = m && m.source && m.source.ligue;
  if (!m || m.sport !== 'foot' || !l || !(Date.parse(m.debut) > t)) return sortie;
  if (!prixLigues.totalVendu(l)) return sortie;
  const r = totauxMarche.pour(m.source.evenement, m.domicile, m.exterieur, t);
  if (!r || r.ligne !== 2.5) return sortie;
  if (!totauxMarche.servable(r, m.prixMarche && m.prixMarche.p)) return sortie;
  sortie.butsMarche = { total: r.total, t: new Date(r.t).toISOString(), ref: r.ref, ligne: r.ligne };
  return sortie;
}
/* Une copie sans `butsMarche` : ce qui n'est pas repasse par `habille` ne
   peut pas dire qu'un total du marche a fait son prix. */
function sansButs(m) { const s = Object.assign({}, m); delete s.butsMarche; return s; }

/* ---- QUAND RELEVER LES TOTAUX : LA REGLE 48 h / 48 h / 12 h ----
 * Un championnat de football (cle de PARIS_TOTAUX_OBSERVE ou de
 * PARIS_TOTAUX_LIGUES, presente dans ODDS_API_LIGUES) est releve quand une de
 * ses rencontres commence dans 0 a 48 h sans total servable (absent, plus
 * vieux que 48 h, ou releve sur un 1-N-2 qui a bouge de plus de 5 points) et
 * sans avoir deja epuise ses TOTAUX_ESSAIS_MAX releves sans reference ; et
 * jamais deux fois en 12 h. La reponse porte toute la journee d'un coup.
 * Simule (sim_regle.js, calendrier du 09/10 repete, 17 championnats) : 186
 * releves par mois, age du total au coup d'envoi median 1,0 j, p90 2,0 j, 0
 * rencontre sur 609 sans total ; le plus cher, le Championship, 14,3 par
 * mois. C'est l'age du banc (cotes « pre-closing » de football-data : median
 * 1,13 j, p90 2,19 j, age_fd.js). La regle 48 h / 7 j / 12 h du prototype en
 * coutait 73, pour un age median de 3,0 j que rien ne mesure.
 * Les essais (relecture du 09/10) : une rencontre ne compte une releve sans
 * reference que si elle commence dans les 48 h — a J+6 les livres n'ont pas
 * encore ouvert les totaux. Sans plafond, une rencontre que personne ne cote
 * redeclencherait une releve toutes les 12 h ; deux essais, puis plus rien.
 * Le plafond du MOIS par championnat : la seule borne dure de la regle est
 * l'ecart de 12 h, 60 releves par championnat et par mois (1 020 sur 17) ;
 * 30 = 2,1 fois le maximum simule (14,3), la moitie de la borne dure : au
 * plus 510 credits par mois sur 17 championnats. Lu dans les credits du
 * carnet (x-requests-last). */
const TOTAUX_AVANT_MS = 48 * 3600000, TOTAUX_ECART_MS = 12 * 3600000, TOTAUX_ESSAIS_MAX = 2, TOTAUX_PLAFOND_MOIS = 30;
/* ---- LA CLOTURE ----
 * Meme fenetre que l'avant-match du prix (`prixAvantMatch`) : de 75 a 20 min
 * avant un coup d'envoi, une releve par championnat et par 2 h au plus. Elle
 * MESURE seulement (la porte 2) : elle n'ecrit jamais un total vendu. Un
 * creneau (championnat, 2 h) par releve : 116 par semaine au calendrier du
 * 09/10, ~500 credits par mois, a couper apres la decision. */
const TOTAUX_CLOTURE_ECART_MS = 2 * 3600000;
/* Les minuteries (voir `planifie`) : la regle a 20 + 30k min, la cloture a
   7 min puis toutes les 10 (17 + 10k), jamais en meme temps que l'avant-match
   des prix (5 + 10k) ni que leur periodique (30k). */
const TOTAUX_TIC_PREMIER_MS = 20 * 60000, CLOTURE_TIC_DECALAGE_MS = 7 * 60000;
const CLOTURE_AVANT = [20 * 60000, 75 * 60000];
function totauxFoot() { return new Set(LIGUES.filter((l) => l.sport === 'foot').map((l) => l.clef)); }
/* Ce qui ne declenche PAS de releve (relecture du 10/10/2026) : une rencontre
   FERMEE (absente de la reponse des totaux : elle aurait relance une releve
   toutes les 12 h jusqu'au coup d'envoi, hors du compteur d'essais), et le
   1-N-2 qui a bouge quand on n'a PAS de p h2h aujourd'hui (rencontre
   suspendue, championnat observe sans prix du marche) : sans pNow on ne sait
   pas s'il a bouge, seule l'absence d'un total frais declenche. L'age d'un
   total « frais » est celui de la vente (PARIS_TOTAUX_AGE_MAX_H) ; quand la
   vente est coupee a 0 h, celui de la regle (48 h) : l'observation continue
   sans relever a chaque ecart de 12 h. */
function totauxAReleve(now) {
  const t = now || Date.now(), out = new Set();
  const cles = prixLigues.totauxARelever();
  if (!cles.size) return [];
  const foot = totauxFoot();
  const age = prixLigues.totauxAgeMaxMs() || TOTAUX_AVANT_MS;
  for (const m of paris.catalogue().matchs) {
    const l = m.source && m.source.ligue;
    if (!l || !cles.has(l) || !foot.has(l) || out.has(l)) continue;
    if (!(m.debut > t && m.debut - t <= TOTAUX_AVANT_MS)) continue;
    const ferme = typeof m.ferme === 'number' ? m.ferme : Date.parse(m.ferme);
    if (isFinite(ferme) && ferme <= t) continue;
    if (t - totauxMarche.derniere(l) < TOTAUX_ECART_MS) continue;
    if (totauxMarche.creditsDuMois(l, t) + 1 > TOTAUX_PLAFOND_MOIS) continue;
    const ev = m.source.evenement;
    if (totauxMarche.essaisDe(ev) >= TOTAUX_ESSAIS_MAX) continue;
    const r = totauxMarche.pour(ev, m.domicile, m.exterieur, t, age);
    const pNow = m.prixMarche ? m.prixMarche.p : ((prixMarche.pour(ev, t) || {}).p || null);
    if (!r || (pNow && !totauxMarche.servable(r, pNow))) out.add(l);
  }
  return [...out];
}
function totauxCloture(now) {
  if (process.env.PARIS_TOTAUX_CLOTURE !== '1') return [];
  const t = now || Date.now(), out = new Set();
  const cles = prixLigues.totauxARelever();
  if (!cles.size) return [];
  const foot = totauxFoot();
  for (const m of paris.catalogue().matchs) {
    const l = m.source && m.source.ligue;
    if (!l || !cles.has(l) || !foot.has(l) || out.has(l)) continue;
    if (!(m.debut >= t + CLOTURE_AVANT[0] && m.debut <= t + CLOTURE_AVANT[1])) continue;
    if (t - totauxMarche.derniereCloture(l) < TOTAUX_CLOTURE_ECART_MS) continue;
    out.add(l);
  }
  return [...out];
}

/* ---- LA MESURE A LA CLOTURE, RENCONTRE PAR RENCONTRE ----
 * Pour chaque rencontre de ce championnat qui commence dans les 2 h, ouverte,
 * au prix du marche frais et dans le bon sens :
 *   clo    la reference de cloture (ligne 2,5 seulement : Betfair ou Pinnacle
 *          a 2,5, ou la mediane d'au moins 3 livres a 2,5) ;
 *   vente  la reference du total du CARNET, celui qu'on vendrait (ref, seul,
 *          livres25, ligne, t) : c'est elle que la porte 2 range par type de
 *          reference — « Betfair seul » sur un championnat mince se juge sur
 *          ce qu'il a fait VENDRE, pas sur la reference de cloture qui le
 *          juge (relecture du 10/10/2026) ;
 *   vendu  la cote ou25 du catalogue a cet instant ;
 *   ombre  la cote ou25 qu'on vendrait au total du carnet (`marchesDuMarche`
 *          avec `ombre` : compteurs a part), par la MEME porte que la vente
 *          (age, 1-N-2 qui a bouge) mais toutes lignes : la strate dit si la
 *          ligne etait 2,5 ou extrapolee ;
 *   dp     le plus grand ecart du 1-N-2 depuis le releve du total (DP_MAX),
 *          ecrit sur CHAQUE rencontre ou il se calcule ;
 *   ombreRefusee, refusePar  la cote qu'on aurait vendue si la porte n'avait
 *          pas refuse le total (`dp` : 1-N-2 qui a bouge ; `age` : plus de
 *          48 h ; `sansPh2h` : pas de p h2h au releve) — HORS des strates de
 *          vente : c'est la ligne d'audit de DP_MAX et de l'age, sans quoi
 *          on ne saurait jamais si ces gardes servent (relecture du 10/10) ;
 *   garde  vrai si la garde de coherence a rendu l'ombre au chemin d'avant.
 * L'age juge est celui de la REGLE (48 h, prix_ligues.TOTAUX_AGE_MAX_H), pas
 * le reglage de vente : les deux strates d'age restent mesurees quel que soit
 * PARIS_TOTAUX_AGE_MAX_H.
 * `avant` : le carnet lu AVANT la releve de cloture (ce qui se vendait). */
function mesureCloture(clef, refs, avant, t) {
  const ageMesure = prixLigues.TOTAUX_AGE_MAX_H * 3600000;
  let notees = 0;
  for (const m of paris.catalogue().matchs) {
    if (!m.source || m.source.ligue !== clef || m.sport !== 'foot') continue;
    if (!(m.debut > t && m.debut - t <= TOTAUX_CLOTURE_ECART_MS) || !paris.ouvert(m, t)) continue;
    const ev = m.source.evenement;
    const pm = prixMarche.pour(ev, t);
    const base = { ligue: clef, dom: m.domicile, ext: m.exterieur, debut: m.debut };
    if (!pm || !pm.p || (pm.dom && (pm.dom !== m.domicile || pm.ext !== m.exterieur))) {
      totauxMarche.noteCloture(ev, Object.assign(base, { raison: 'pas de prix du marche frais' }), t); notees++; continue;
    }
    const r = refs[ev];
    const ouCat = m.marches && m.marches.ou25 && m.marches.ou25.cotes;
    const vendu = ouCat ? { plus: Number(ouCat.plus), moins: Number(ouCat.moins) } : null;
    if (!r || r.ligne !== 2.5) {
      totauxMarche.noteCloture(ev, Object.assign(base, { vendu, raison: r ? 'cloture hors ligne 2,5' : 'pas de reference de cloture' }), t); notees++; continue;
    }
    const clo = { t, ref: r.ref, seul: !!r.seul, ligne: r.ligne, livres25: r.livres25, total: Math.round(r.total * 1e4) / 1e4, pPlus25: Math.round(r.pPlus25 * 1e6) / 1e6 };
    const e = avant[ev];
    let ombre = null, strate = null, raison = null, vente = null, dp = null, ageH = null, refusePar = null, ombreRefusee = null, garde = false;
    if (!e || !((e.dom === m.domicile && e.ext === m.exterieur) || (e.dom === m.exterieur && e.ext === m.domicile))) raison = 'pas de total au carnet';
    else {
      vente = { ref: e.ref, seul: !!e.seul, livres25: Number.isFinite(e.livres25) ? e.livres25 : null,
                ligne: Number.isFinite(e.ligne) ? e.ligne : null, t: new Date(e.t).toISOString() };
      ageH = Math.round((t - e.t) / 36000) / 100;
      dp = totauxMarche.ecartH2h(e, pm.p);
      if (dp !== null) dp = Math.round(dp * 1e4) / 1e4;
      if (!(t - e.t <= ageMesure)) { raison = 'total trop vieux'; refusePar = 'age'; }
      else if (dp === null) { raison = 'sans p h2h au releve'; refusePar = 'sansPh2h'; }
      else if (!totauxMarche.servable(e, pm.p)) { raison = '1-N-2 qui a bouge'; refusePar = 'dp'; }
      const x = { total: e.total, ombre: true };
      const mm = cotes.marchesDuMarche(m.sport, pm.p, undefined, clef, x);
      const o = mm && mm.ou25 && mm.ou25.cotes;
      garde = !!x.ecarte;
      if (!o) { if (!raison) raison = 'plus/moins ecarte au total du marche'; }
      else if (refusePar) ombreRefusee = { plus: o.plus, moins: o.moins };
      else {
        ombre = { plus: o.plus, moins: o.moins };
        strate = (t - e.t < 24 * 3600000 ? '<24h' : '24-48h') + '|' + (e.ligne === 2.5 ? '2,5' : 'extrapolee');
      }
    }
    if (!vendu && !raison) raison = 'plus/moins absent du catalogue';
    totauxMarche.noteCloture(ev, Object.assign(base, { clo, vente, vendu, ombre: vendu ? ombre : null, strate: vendu ? strate : null, raison,
      dp, ageH, refusePar, ombreRefusee: vendu ? ombreRefusee : null, garde }), t);
    notees++;
  }
  return notees;
}

/* Une releve a la fois, dans la MEME file que les prix : jamais deux appels
   payants ensemble. 1 credit par championnat (markets=totals, region eu).
   Rend le nombre de releves de la REGLE reussies d'un championnat VENDU :
   c'est lui qui decide de refaire le calendrier (`planifie`). */
function rafraichitTotaux(clefs, pourquoi, opts) {
  const cloture = !!(opts && opts.cloture);
  const tour = filePrix.then(async () => {
    let vendus = 0;
    const permises = prixLigues.totauxARelever(), foot = totauxFoot();
    for (const clef of clefs || []) {
      /* un championnat non liste, ou pas du football importe : aucun appel */
      if (!permises.has(clef) || !foot.has(clef)) continue;
      const t0 = Date.now();
      if (cloture) { if (t0 - totauxMarche.derniereCloture(clef) < TOTAUX_CLOTURE_ECART_MS) continue; }
      else {
        if (t0 - totauxMarche.derniere(clef) < TOTAUX_ECART_MS) continue;
        if (totauxMarche.creditsDuMois(clef, t0) + 1 > TOTAUX_PLAFOND_MOIS) {
          console.log(`[odds] totaux ${clef} : plafond du mois atteint (${TOTAUX_PLAFOND_MOIS} credits) — pas de releve`);
          continue;
        }
      }
      const vendu = prixLigues.totalVendu(clef);
      /* classe : cloture 2 (mesure datee) ; regle 1 si la cle VEND le total,
         3 si elle est seulement observee. Jamais prioritaire. */
      const info = { classe: cloture ? 2 : (vendu ? 1 : 3) };
      try {
        const evs = await appel(`/sports/${clef}/odds`, { regions: REGION, markets: 'totals', oddsFormat: 'decimal' },
                                1, (cloture ? 'cloture totaux ' : 'totaux ') + clef, undefined, info);
        const t = Date.now();
        const avant = cloture ? totauxMarche.lis().evenements : null;
        const c = totauxMarche.note(evs, clef, t, { cloture, credits: info.dernier, coutAttendu: 1,
          pH2hDe: (ev) => {
            const r = prixMarche.pour(ev.id, t);
            return r && r.p && (!r.dom || (r.dom === ev.home_team && r.ext === ev.away_team)) ? r.p : null;
          } });
        const refs = c.refs || {};
        delete c.refs;
        console.log(`[odds] totaux ${clef} (${pourquoi}) : ${JSON.stringify(c)}`);
        if (cloture) {
          const n = mesureCloture(clef, refs, avant || {}, t);
          console.log(`[odds] cloture totaux ${clef} : ${n} rencontre(s) notee(s)`);
        } else if (vendu) vendus++;
        if (!vendu) {
          const ms = totauxMarche.mesure(clef, t);
          console.log(`[odds] observe totaux ${clef} : ${JSON.stringify({ couverture: { n: ms.couverture.rencontres, part: ms.couverture.part, porte: ms.couverture.porte },
            cloture: { n: ms.mesure.n, battOmbre: ms.mesure.battOmbre, battVendu: ms.mesure.battVendu } })}`);
        }
      } catch (e) {
        console.log('[odds] ' + (cloture ? 'cloture ' : '') + 'totaux ' + clef + ' : ' + (e.message || e));
        /* partie mais ratee (statut recu, ou delai) : date et cout ecrits, l'ecart
           de 12 h et le plafond du mois tiennent ; refusee (rien n'est parti) :
           rien, le tic suivant redemande gratuitement */
        if (info.code === 'DELAI' || (info.statut !== null && info.statut !== undefined)) {
          try { totauxMarche.noteEchec(clef, Date.now(), { cloture, credits: info.dernier, coutAttendu: 1 }); } catch (x) { /* jamais bloquant */ }
        }
      }
    }
    return vendus;
  });
  filePrix = tour.catch(() => 0);
  return tour;
}

/* Les cles de totaux absentes des ligues importees : jamais relevees. */
function totauxInconnues() {
  const foot = totauxFoot();
  return [...prixLigues.totauxARelever()].filter((c) => !foot.has(c));
}
/* La ligne de demarrage : toujours ecrite, c'est la seule qui dit, apres un
   changement de variable, ce qui est releve et ce qui est vendu. */
function ligneTotaux() {
  const v = [...prixLigues.totauxLigues()].filter((c) => prixLigues.TOTAUX_PERMIS.test(c));
  const o = [...prixLigues.totauxObservees()].filter((c) => prixLigues.TOTAUX_PERMIS.test(c) && !prixLigues.totalVendu(c));
  const brut = process.env.PARIS_TOTAUX_AGE_MAX_H;
  const age = prixLigues.totauxAgeMaxH();
  let l = '[odds] totaux du marche : vendu sur ' + v.length + (v.length ? ' (' + v.join(', ') + ')' : '')
    + ', observe sur ' + o.length + (o.length ? ' (' + o.join(', ') + ')' : '')
    + ', cloture ' + (process.env.PARIS_TOTAUX_CLOTURE === '1' ? 'OUI (classe 2, mesure seule)' : 'non')
    + ', age max ' + age + ' h' + (age === 0 ? ' (AUCUN total servi)' : '')
    + (brut !== undefined && String(brut).trim() !== '' && Number(brut) !== age ? ` (PARIS_TOTAUX_AGE_MAX_H « ${brut} » ramene a ${age})` : '')
    + ', plafond ' + TOTAUX_PLAFOND_MOIS + ' credits par championnat et par mois, spreads jamais demandes';
  const refus = prixLigues.totauxRefusees();
  if (refus.length) l += ' — IGNORE(S) : ' + refus.join(' ; ');
  const inc = totauxInconnues();
  if (inc.length) l += ' — absente(s) des ligues importees, jamais relevee(s) : ' + inc.join(', ');
  return l;
}

/* ---- CE QUE LE PLUS/MOINS VENDU LAISSE AU MARCHE DES TOTAUX, EN DIRECT ----
 * Comme `ecartAuMarche` pour le 1-N-2 : chaque rencontre ouverte du
 * championnat dont le total du carnet est frais et dans le bon sens ; une
 * issue est battable quand la cote ou25 vendue x P(plus/moins de 2,5) du
 * marche (marge retiree) depasse 1. « Frais » : 48 h au plus, l'age de la
 * regle (le reglage de vente ne change pas ce que le marche dit). */
function ecartTotaux(ligue, now, carnet) {
  const t = now || Date.now();
  const out = { rencontres: 0, avecTotal: 0, issues: 0, battables: 0, pire: null };
  const E = (carnet || totauxMarche.lis()).evenements;
  const ageMax = prixLigues.TOTAUX_AGE_MAX_H * 3600000;
  try {
    for (const m of paris.catalogue().matchs) {
      if (!m.source || m.source.ligue !== ligue || m.sport !== 'foot' || !paris.ouvert(m, t)) continue;
      out.rencontres++;
      const e = E[m.source.evenement];
      if (!e || !(t - e.t <= ageMax) || !((e.dom === m.domicile && e.ext === m.exterieur) || (e.dom === m.exterieur && e.ext === m.domicile))) continue;
      const c = m.marches && m.marches.ou25 && m.marches.ou25.cotes;
      if (!c || !(e.pPlus25 > 0 && e.pPlus25 < 1)) continue;
      out.avecTotal++;
      for (const [i, p] of [['plus', e.pPlus25], ['moins', 1 - e.pPlus25]]) {
        if (!(Number(c[i]) > 1)) continue;
        const x = Number(c[i]) * p - 1;
        out.issues++;
        if (x > 0) out.battables++;
        if (!out.pire || x > out.pire.esperance) out.pire = { rencontre: m.domicile + ' v ' + m.exterieur, issue: i, cote: Number(c[i]), marche: Math.round(p * 1000) / 1000, esperance: Math.round(x * 1000) / 1000 };
      }
    }
  } catch (e) { /* catalogue illisible */ }
  out.pourquoi = out.avecTotal < 20 ? `${out.avecTotal} rencontre(s) avec un total frais, moins de 20 : ne conclut pas` : null;
  return out;
}
/** etatImport().totaux : le reglage, les credits du mois, et par championnat
 *  la couverture (porte 1), la mesure stratifiee (porte 2) et l'ecart du
 *  moment. Le journal d'observation est lu UNE fois (relecture du 09/10 : 17
 *  lectures par GET sinon). */
function etatTotaux(now) {
  const t = now || Date.now();
  const carnet = totauxMarche.lis();
  const obs = totauxMarche.lisObs();
  const mois = new Date(t).toISOString().slice(0, 7);
  const cm = carnet.credits[mois] || {};
  let total = 0;
  for (const x of Object.values(cm)) total += (Number(x.regle) || 0) + (Number(x.cloture) || 0);
  const out = {
    reglage: { vendu: [...prixLigues.totauxLigues()], observe: [...prixLigues.totauxObservees()],
               cloture: process.env.PARIS_TOTAUX_CLOTURE === '1', ageMaxH: prixLigues.totauxAgeMaxH(),
               plafondMois: TOTAUX_PLAFOND_MOIS, essaisMax: TOTAUX_ESSAIS_MAX, dpMax: totauxMarche.DP_MAX,
               refusees: prixLigues.totauxRefusees(), inconnues: totauxInconnues(), j0: carnet.j0, j0Ligues: carnet.j0Ligues || {} },
    credits: { mois, total, parLigue: cm },
    total: totauxMarche.mesure(null, t, obs, carnet),
    ligues: {},
  };
  for (const clef of prixLigues.totauxARelever()) {
    const d = Number(carnet.ligues[clef]) || 0, dc = Number(carnet.cloture[clef]) || 0;
    out.ligues[clef] = Object.assign({ observe: !prixLigues.totalVendu(clef), vendu: prixLigues.totalVendu(clef),
      releve: d ? new Date(d).toISOString() : null, cloture: dc ? new Date(dc).toISOString() : null,
      dernierCompte: carnet.couverture[clef] || null, ecartMaintenant: ecartTotaux(clef, t, carnet) },
      totauxMarche.mesure(clef, t, obs, carnet));
  }
  return out;
}

/* Les competitions ou un match de football peut aller en prolongation : la C1
   (barrages et elimination directe), les series MLS (meme cle que la saison
   reguliere), et toute coupe. Une liste, pas une devinette : une cle inconnue
   qui ressemble a une coupe compte comme une coupe. */
const PROLONGATION_LIGUES = new Set(['soccer_uefa_champs_league', 'soccer_uefa_europa_league',
  'soccer_uefa_europa_conference_league', 'soccer_usa_mls']);
function prolongationPossible(m) {
  const l = String((m && m.source && m.source.ligue) || '');
  return PROLONGATION_LIGUES.has(l) || /cup|copa|coupe|pokal|coppa|trophy|playoff|knockout|_fa_|super_?cup/i.test(l);
}

/**
 * Trier les rencontres finies : celles qu'on regle, celles qui attendent.
 *
 * `expositionDe` est fourni par l'appelant — le module d'import ne connait
 * pas le moteur, et c'est voulu : il ne doit pas pouvoir payer tout seul.
 */
function trieReglements(finis, expositionDe, now) {
  const t = Number(now) || Date.now();
  const auto = [], mains = [];
  for (const f of finis) {
    const m = paris.match(f.id);
    const depuis = m && m.debut ? (t - m.debut) / 60000 : null;
    const expo = Number(expositionDe(f.id)) || 0;

    /* ---- CE QUE LA SOURCE OU L'IMPORT ONT MARQUE « A LA MAIN » (08/10/2026) ----
     * Une rencontre FERMEE par l'import a ete deplacee ou retiree : ses paris
     * ont pu etre poses sous une heure fausse, c'est au proprietaire de dire
     * s'ils tiennent. Et `aMain` vient de la releve des scores : un football
     * fini apres prolongation ou tirs au but (le score rendu les compte, nos
     * marches se reglent a 90 minutes), ou un score de football de The Odds
     * API dans une competition ou la prolongation existe.
     * Teste AVANT les autres raisons : avec PARIS_AUTO=0, « reglement
     * automatique desactive » cachait l'avertissement sur la prolongation, et
     * le proprietaire aurait regle a la main sur le score prolonge. */
    if (m && m.ferme) { mains.push(Object.assign({}, f, { raison: 'rencontre fermee par l import : ' + (m.fermeRaison || 'deplacee') })); continue; }
    if (f.aMain) { mains.push(Object.assign({}, f, { raison: String(f.aMain) })); continue; }
    if (!AUTO_ACTIF) { mains.push(Object.assign({ raison: 'reglement automatique desactive' }, f)); continue; }
    if (depuis === null) { mains.push(Object.assign({ raison: 'rencontre absente du calendrier' }, f)); continue; }
    /* Le delai se compte depuis le COUP D'ENVOI, faute de mieux : le
       fournisseur ne dit pas quand la rencontre s'est terminee. On y ajoute
       donc la duree d'un match, genereusement. */
    if (depuis < AUTO_DELAI_MIN + 110) {
      /* `attente` (lot 4) : ce n'est pas « a la main », c'est « pas encore ».
         La passe frequente ne la publie pas : sinon le canal public recevrait
         « finie depuis trop peu » toutes les 2 h. La raison ne change pas. */
      mains.push(Object.assign({ raison: `finie depuis trop peu (${Math.round(depuis)} min)` }, f, { attente: true }));
      continue;
    }
    if (expo > AUTO_PLAFOND) {
      mains.push(Object.assign({ raison: `exposition ${Math.round(expo)} > plafond ${AUTO_PLAFOND}` }, f));
      continue;
    }
    auto.push(f);
  }
  return { auto, mains };
}

/*
 * ==================== L'OMBRE : CE QU'UNE PASSE DE 2 H AURAIT REGLE (lot 4) ====================
 *
 * 0 credit, et elle ne regle rien : elle LIT ESPN et NOTE (reglement_journal).
 *
 *  - Les candidates : les rencontres des tableaux ESPN (`espn.CHEMINS`)
 *    commencees depuis moins de 36 h, pariees ou non ; le tennis seulement
 *    avec un pari (son API core est lourde : un appel par tournoi) ; et celles
 *    encore dans leur fenetre de suivi. Une rencontre sans tableau gratuit
 *    (cricket hors T20 international) ne se lit pas : elle n'entre pas.
 *  - Elle lit `espn.releve`, qui rend TOUS les etats, et non `espn.finies`,
 *    qui ecarte ce qui n'est pas fini : une rencontre deja reglable qui
 *    revient a un etat non fini (reprise, abandon) est la correction la plus
 *    dangereuse, et `finies` la faisait disparaitre sans un mot.
 *  - Une rencontre absente d'un tableau qui a REPONDU (toutes ses requetes en
 *    200 lisible) est une disparition, donc une correction ; absente d'un
 *    tableau en panne, rien ne se conclut (le trou se compte).
 *  - « Reglable » = la meme decision que la vraie passe : `trieReglements`
 *    (football a 90 minutes, fermee, delai, plafond). Quand la seconde source
 *    existera (lot 9), l'ombre triera SANS son blocage : sinon le premier
 *    instant reglable serait retarde par le verrou qu'on mesure.
 */
function lectureOmbre(m, s, estTennis) {
  if (!s || !s.fini || !(s.score || (estTennis && s.resultat))) return null;
  const f = { id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur, resultat: s.resultat, source: 'espn' };
  if (s.score) f.score = s.score;
  /* la regle de espn.finies : le football ne se regle seul que sur un temps
     reglementaire declare (STATUS_FULL_TIME) */
  if (m.sport === 'foot' && espn.FOOT_REGLEMENTAIRE.indexOf(s.statut) < 0)
    f.aMain = `football fini en ${s.statut || 'statut inconnu'} (ESPN) : regler sur le score a 90 minutes`;
  return f;
}
/* ---- L'OMBRE CEDE LA PLACE AU VERROU (relecture du lot 4) ----
 * `verrouFrais` (server.js) lit les memes tableaux toutes les 15 min pour
 * fermer les paris d'un match commence, et une requete refusee ne lui
 * apprend rien : sous les refus, il s'ouvre. L'ombre ne doit donc pas
 * ajouter sa rafale a un tableau qui refuse deja. Un tableau dont les refus
 * du jour (`espn.refusDuJour`, ceux du verrou comme ceux de l'ombre) ont
 * augmente depuis la passe d'ombre precedente n'est pas lu a celle-ci : ses
 * rencontres comptent une lecture muette (le trou grandit, rien ne se
 * conclut). Des que les refus cessent, la lecture reprend a la passe
 * suivante. `REFUS_OMBRE` : les refus vus au debut de la derniere passe. */
let REFUS_OMBRE = null;
function tableauxSautes() {
  const jour = new Date().toISOString().slice(0, 10);
  const maintenant = espn.refusDuJour(jour) || {};
  const vus = REFUS_OMBRE && REFUS_OMBRE.jour === jour ? REFUS_OMBRE.parTableau : {};
  const sautes = new Set(), parTableau = {};
  for (const [ch, x] of Object.entries(maintenant)) {
    const n = Number(x && x.refus) || 0;
    parTableau[ch] = n;
    if (n > (Number(vus[ch]) || 0)) sautes.add(ch);
  }
  REFUS_OMBRE = { jour, parTableau };
  return sautes;
}
/** Pour les essais : les refus du jour sont tenus pour vus (comme apres une passe). */
function refusOmbreVus() { REFUS_OMBRE = null; tableauxSautes(); }

async function ombreReglement(aRegler, expositionDe, now) {
  const t = Number(now) || Date.now();
  const oh = ombreH();
  let sautes = new Set();
  try { sautes = tableauxSautes(); } catch (e) { sautes = new Set(); }
  const avecParis = (id) => { try { return typeof aRegler === 'function' && !!aRegler(id); } catch (e) { return false; } };
  let suivis = new Set();
  try { suivis = new Set(regJournal.suivisEnCours(t, { ombreH: oh })); } catch (e) { /* journal illisible : 36 h seules */ }
  const cands = [];
  for (const m of paris.catalogue().matchs) {
    const l = m.source && m.source.ligue;
    if (!l || !isFinite(m.debut) || m.debut > t) continue;
    const estTennis = !!espn.tourDe(l);
    if (!espn.CHEMINS[l] && !estTennis) continue;
    if (suivis.has(m.id)) { cands.push(m); continue; }
    if (t - m.debut > OMBRE_FENETRE_MS) continue;
    if (estTennis && !avecParis(m.id)) continue;
    cands.push(m);
  }
  /* Ce que chaque tableau a repondu, compte par la fonction de lecture
     elle-meme : 200 lisible = repondu ; statut d'erreur, corps illisible,
     abandon = en panne. */
  const repond = new Map();
  const marque = (k, bon) => { const r = repond.get(k) || { ok: 0, ko: 0 }; if (bon) r.ok++; else r.ko++; repond.set(k, r); };
  const tableauDe = (u) => {
    const x = /sports\/(.+?)\/scoreboard/.exec(String(u));
    return x ? x[1] : (/sports\.core\.api\.espn\.com/.test(String(u)) ? 'tennis' : '?');
  };
  const prendre = async (u, op) => {
    const k = tableauDe(u);
    let rep;
    try { rep = await fetch(u, op); } catch (e) { marque(k, false); throw e; }
    if (!rep || !rep.ok) { marque(k, false); return rep; }
    return { ok: rep.ok, status: rep.status, headers: rep.headers,
             json: async () => { try { const j = await rep.json(); marque(k, true); return j; } catch (e) { marque(k, false); throw e; } } };
  };
  const equipes = cands.filter((m) => espn.CHEMINS[m.source.ligue] && !sautes.has(espn.CHEMINS[m.source.ligue]));
  const tennis = cands.filter((m) => espn.tourDe(m.source.ligue));
  let vus = new Map(), parTennis = new Map();
  try { if (equipes.length) vus = await espn.releve(equipes, { prendre, maintenant: t }); }
  catch (e) { console.log('[reglement] ombre : ESPN injoignable — ' + (e.message || e)); }
  try { if (tennis.length) parTennis = await espn.releveTennis(tennis, { prendre }); }
  catch (e) { console.log('[reglement] ombre : tennis ESPN injoignable — ' + (e.message || e)); }

  const lectures = [], finis = [];
  for (const m of cands) {
    const l = m.source.ligue;
    const estTennis = !!espn.tourDe(l);
    const s = estTennis ? parTennis.get(m.id) : vus.get(m.id);
    const r = repond.get(estTennis ? 'tennis' : espn.CHEMINS[l]);
    const lec = { id: m.id, sport: m.sport, ligue: l, debut: m.debut, avecParis: avecParis(m.id),
                  lu: !!s, repondu: !!r && r.ko === 0 && r.ok > 0, fini: false, score: null, resultat: null,
                  aMain: false, statut: s ? (s.statut || s.etat || null) : null, reglable: false };
    const f = lectureOmbre(m, s, estTennis);
    if (f) { Object.assign(lec, { fini: true, score: f.score || null, resultat: f.resultat || null, aMain: !!f.aMain }); finis.push(f); }
    lectures.push(lec);
  }
  let auto = new Set();
  try {
    const expo = (id) => { try { return typeof expositionDe === 'function' ? expositionDe(id) : 0; } catch (e) { return 0; } };
    auto = new Set(trieReglements(finis, expo, t).auto.map((f) => f.id));
  } catch (e) { console.log('[reglement] ombre : tri impossible — ' + (e.message || e)); }
  for (const lec of lectures) lec.reglable = auto.has(lec.id);

  let r = null;
  try { r = regJournal.noteOmbre(lectures, t, { ombreH: oh, murMin: AUTO_DELAI_MIN + 110 }); } catch (e) { r = null; }
  let enSuivi = 0;
  try { enSuivi = regJournal.suivisEnCours(t, { ombreH: oh }).length; } catch (e) { enSuivi = 0; }
  const rendu = { lues: lectures.length, trouvees: lectures.filter((x) => x.lu).length, finies: finis.length,
                  reglables: auto.size, nouvelles: r ? r.nouvelles : 0, enSuivi,
                  corrections: r ? r.corrections : [], closes: r ? r.closes : 0, note: !!r,
                  sautes: [...sautes].filter((ch) => cands.some((m) => espn.CHEMINS[m.source.ligue] === ch)).sort() };
  console.log(`[reglement] ombre : ${rendu.lues} rencontre(s) lue(s), ${rendu.trouvees} trouvee(s) sur ESPN, ` +
              `${rendu.reglables} reglable(s) maintenant (${rendu.nouvelles} nouvelle(s)), ${enSuivi} en suivi ${oh} h, ` +
              `${rendu.corrections.length} correction(s)` +
              (rendu.sautes.length ? ` — ${rendu.sautes.length} tableau(x) non lu(s), refus ESPN depuis la passe d avant : ${rendu.sautes.join(', ')}` : '') +
              (r ? '' : ' — JOURNAL NON ECRIT'));
  for (const c of rendu.corrections) {
    console.log(`[reglement] CORRECTION ${c.id} : ${c.cause} (${c.avant.etat || '?'} ${c.avant.score || ''}${c.avant.aMain ? ' a la main' : ''}` +
                ` -> ${c.apres.etat} ${c.apres.score || ''}${c.apres.aMain ? ' a la main' : ''})`);
  }
  return rendu;
}

/*
 * Le bilan du reglement, portes calculees (EXPLOITATION 8.10) : pour
 * /paris/import, la carte « Settlement » et `--reglement`. Rien n'y decide :
 * chaque bascule reste une variable.
 */
function bilanReglement(now) {
  const t = Number(now) || Date.now();
  const r = regJournal.resume(t, { ombreH: ombreH(), cadenceH: scoresEspnH(), fenetreJours: SCORES_COUPE_JOURS,
                                    murMin: AUTO_DELAI_MIN + 110 });
  const out = {
    espn: { mode: modeEspn(), invalide: modeEspnInvalide(), heures: scoresEspnH(), fenetreJours: scoresEspnFenJ(), ombreH: ombreH() },
    coupe: { active: scoresCoupe(), n: scoresCoupeN(), jours: SCORES_COUPE_JOURS },
    sauteEnCours: scoresSauteEnCours(),
    journal: r,
  };
  if (!r || !r.lisible) return out;
  /* PORTE A. Une correction suffit pour conclure NON, a tout echantillon.
     `raisons` sont des CODES (la carte les dit en anglais, la ligne de
     commande en francais) : jours, echantillon, correction, gain. Elle ne
     juge que les rencontres lues au mur COURANT, et ses jours partent de
     son dernier changement (`o.jours`) : relever PARIS_AUTO_DELAI_MIN apres
     une correction ouvre une nouvelle mesure. */
  const o = r.ombre, g = o.gain.tous;
  const raisons = [];
  if (o.avecCorrection > PORTE_A.correctionsMax) raisons.push('correction');
  if (o.jours < PORTE_A.joursMin) raisons.push('jours');
  if (o.suiviesSansTrou < PORTE_A.suiviesMin) raisons.push('echantillon');
  let passe = null;
  if (o.avecCorrection > PORTE_A.correctionsMax) passe = false;
  else if (!raisons.length) {
    passe = g.medianeBasH !== null && g.medianeBasH >= PORTE_A.gainMinH;
    if (!passe) raisons.push('gain');
  }
  out.porteA = Object.assign({}, PORTE_A, { jours: o.jours, murMin: o.murMin, autreMur: o.autreMur, suivies: o.suiviesSansTrou, corrections: o.avecCorrection,
    gainMedianBasH: g.medianeBasH, gainN: g.n, passe, raisons });
  /* PORTE B, cle par cle. Une cle cochee n'est jamais jugee : elle n'est
     jamais coupee. `motif` : cochee, appariee, inutiles, gratuit,
     indecidable, echantillon ; `verdict` : garder, couper, rien, ou null.
     « Rien a economiser » exige des couts LUS a 0 (x-requests-last) sur au
     moins N reponses, et aucun cout inconnu : six 422 au cout indecidable
     etaient declarees « x-requests-last a 0 » (relecture du lot 4). Un cout
     inconnu se dit « indecidable », et l'on attend des appels decidables
     (EXPLOITATION 8.10). Des inutiles prouves (cout lu > 0) concluent, eux,
     quoi qu'il en soit des autres : un cout inconnu ne peut qu'ajouter. */
  out.porteB = {};
  for (const [k, b] of Object.entries(r.scores.parClef || {})) {
    const cochee = !SCORES_NON_COCHEES.has(k);
    let verdict = null, motif = 'echantillon';
    if (cochee) motif = 'cochee';
    else if (b.appariees > 0) { verdict = 'garder'; motif = 'appariee'; }
    else if (b.inutiles >= scoresCoupeN()) { motif = 'inutiles'; verdict = r.jours >= PORTE_B.joursMin ? 'couper' : null; }
    else if (b.indecidables + b.inconnus > 0) motif = 'indecidable';
    else if (b.payes === 0 && b.gratuits >= scoresCoupeN()) { motif = 'gratuit'; verdict = r.jours >= PORTE_B.joursMin ? 'rien' : null; }
    out.porteB[k] = { cochee, verdict, motif, inutiles: b.inutiles, n: scoresCoupeN(), jours: r.jours, joursMin: PORTE_B.joursMin,
                      coupee: !!clefCoupee(k, t) };
  }
  /* L'economie sure (PARIS_SCORES_SAUTE_ENCOURS) : au plus tot 14 jours, au
     moins 10 appels precoces payes sur 30 jours. Une DECISION du lot 4, pas
     une mesure : dix appels, c'est 20 credits sur 30 jours (0,1 % du forfait
     de 20 000) — en dessous, l'economie ne vaut pas un changement du chemin
     payant ; quatorze jours, la duree de la porte A. Le compte (`precoces`)
     dira ce qu'elle vaut. */
  let precoces = 0, creditsPrecoces = 0;
  for (const b of Object.values(r.scores.parClef || {})) { precoces += b.precoces; creditsPrecoces += b.creditsPrecoces || 0; }
  out.porteSaute = { precoces, credits: creditsPrecoces, min: 10, joursMin: 14,
                     passe: r.jours < 14 ? null : precoces >= 10 };
  return out;
}

/** Le bilan en lignes de texte (la commande --reglement, 0 credit). */
function lignesReglement(b) {
  const L = [];
  const j = b.journal || {};
  L.push(`[reglement] passe ESPN frequente : ${b.espn.mode}${b.espn.invalide ? ` (PARIS_SCORES_ESPN « ${b.espn.invalide} » IGNORE)` : ''}, toutes les ${b.espn.heures} h, suivi ${b.espn.ombreH} h`);
  if (!j.lisible) { L.push(`[reglement] journal ${j.fichier || ''} illisible ou absent`); return L; }
  L.push(`[reglement] journal depuis ${j.depuis || 'jamais'} (${j.jours} jour(s)), ${j.passes.n} passe(s) reelle(s) notee(s), ` +
         `${j.regles.n} reglement(s) note(s) : ${j.regles.auto.espn} auto par ESPN, ${j.regles.auto.scores} auto par /scores paye, ${j.regles.main} a la main`);
  const o = j.ombre;
  L.push(`[reglement] ombre : ${o.suivies} rencontre(s) suivie(s) jusqu au bout (${o.suiviesSansTrou} sans trou), ${o.enCours} en cours, ${o.abandonnees} abandonnee(s), ${o.avecCorrection} corrigee(s)` +
         (o.murMin !== null && o.murMin !== undefined ? `, mur ${o.murMin} min depuis ${o.jours} jour(s)` : '') +
         (o.autreMur ? ` — ${o.autreMur} lue(s) a un autre mur, hors porte A` : ''));
  for (const c of o.corrections) L.push(`  correction ${c.id} (${c.ligue}) le ${new Date(c.t).toISOString()} : ${c.cause}, ${c.avant.score || c.avant.etat} -> ${c.apres.score || c.apres.etat}`);
  const g = o.gain.tous;
  L.push(`[reglement] gain d une passe de ${b.espn.heures} h : ${g.n} rencontre(s) jugee(s), ${g.enAttente} sans passe reelle apres` +
         (g.n ? ` — mediane basse ${g.medianeBasH} h (p90 ${g.p90BasH} h), haute ${g.medianeHautH} h (p90 ${g.p90HautH} h)` : ''));
  for (const [s, x] of Object.entries(o.gain.parSport)) if (x.n) L.push(`  ${s} : ${x.n} rencontre(s), mediane basse ${x.medianeBasH} h, p90 ${x.p90BasH} h`);
  L.push(`[reglement] controle (rencontres pariees) : auto ${o.controle.auto.n}${o.controle.auto.n ? `, mediane ${o.controle.auto.medianeH} h` : ''} ; main ${o.controle.main.n}${o.controle.main.n ? `, mediane ${o.controle.main.medianeH} h` : ''}`);
  if (b.porteA) {
    const pa = b.porteA;
    const dits = { correction: `${pa.corrections} rencontre(s) corrigee(s) apres leur premiere lecture reglable`,
                   jours: `${pa.jours} jour(s) d ombre sur ${pa.joursMin}`,
                   echantillon: `${pa.suivies} rencontre(s) suivie(s) sans trou sur ${pa.suiviesMin}`,
                   gain: `gain median bas ${pa.gainMedianBasH === null ? '?' : pa.gainMedianBasH} h sous ${pa.gainMinH} h` };
    L.push(`[reglement] PORTE A : ${pa.passe === true ? 'PASSEE' : pa.passe === false ? 'FERMEE' : 'pas encore jugeable'}` +
           (pa.raisons.length ? ' — ' + pa.raisons.map((x) => dits[x] || x).join(' ; ') : ''));
  }
  L.push(`[reglement] /scores payes, ${j.scores.fenetreJours} jours glissants (coupe ${b.coupe.active ? 'ARMEE' : 'eteinte'}, ${b.coupe.n} inutiles) :`);
  const pc = j.scores.parClef || {};
  if (!Object.keys(pc).length) L.push('  aucun');
  for (const [k, x] of Object.entries(pc).sort()) {
    const p = (b.porteB || {})[k] || {};
    L.push(`  ${k}${p.cochee === false ? ' (non cochee)' : ''} : ${x.appels} appel(s), ${x.credits} credit(s), ${x.appariees} appariee(s), ` +
           `${(j.scores.regleesParClef || {})[k] || 0} reglee(s) par ce chemin, ${x.inutiles} inutile(s), ` +
           `${x.precoces} precoce(s), ${x.indecidables + x.inconnus} au cout inconnu, ${x.refuses} refuse(s)` +
           (p.verdict ? ` — ${({ garder: 'A GARDER', couper: 'A COUPER', rien: 'RIEN A ECONOMISER' })[p.verdict]}` : '') +
           (p.coupee ? ' — COUPEE' : '') + (p.motif ? ` (${({ cochee: 'cochee : jamais coupee', appariee: 'au moins une appariee',
             inutiles: `${p.inutiles} inutile(s) sur ${p.n}` + (p.verdict ? '' : `, ${p.jours} jour(s) de compte sur ${p.joursMin}`),
             gratuit: 'x-requests-last a 0', indecidable: 'cout indecidable', echantillon: `${p.inutiles} inutile(s) sur ${p.n}` })[p.motif] || p.motif})` : ''));
  }
  const pm = j.scores.parMois || {};
  for (const [k, x] of Object.entries(pm).sort()) L.push(`  ${k.replace('|', ' ')} : ${x.appels} appel(s), ${x.credits} credit(s), ${x.appariees} appariee(s), ${x.inutiles} inutile(s)`);
  if (b.porteSaute) L.push(`[reglement] PARIS_SCORES_SAUTE_ENCOURS ${b.sauteEnCours ? 'ARME' : 'eteint'} : ${b.porteSaute.precoces} appel(s) precoce(s), ${b.porteSaute.credits} credit(s) sur ${j.scores.fenetreJours} jours`);
  return L;
}


/**
 * Recaler les forces Elo sur de vraies cotes. 1 credit par ligue.
 *
 * Le principe : on retire la marge des cotes du bookmaker pour retrouver ses
 * probabilites, on en deduit l'ecart de force qu'il pense voir, et on deplace
 * nos forces d'une fraction de cet ecart. Une fraction, pas la totalite : une
 * cote est une opinion, pas une mesure, et recopier l'opinion d'un seul
 * bookmaker sur un seul match ferait sauter nos forces a chaque releve.
 */
async function calibre(ligueDemandee) {
  const enService = await liguesEnService();
  const cibles = ligueDemandee ? enService.filter((l) => l.clef === ligueDemandee) : enService;
  if (!cibles.length) throw new Error('[odds] ligue inconnue : ' + ligueDemandee);
  let bouges = 0;

  for (const l of cibles) {
    /* Un grand championnat au prix du marche frais n'a rien a apprendre a
       l'Elo (on ne vend plus son Elo) : son credit sert aux ligues qui
       vendent encore l'Elo, que la part du jour coupait (08/10/2026). */
    if (!ligueDemandee && prixMarche.vendue(l.clef) && Date.now() - prixMarche.derniere(l.clef) < PRIX_JOUR_MS) continue;
    let evs;
    try {
      evs = await appel(`/sports/${l.clef}/odds`,
        { regions: REGION, markets: MARCHE, oddsFormat: 'decimal' }, 1, 'odds ' + l.clef);
    } catch (e) { console.log('[odds] ' + e.message); continue; }
    /* La meme reponse porte le prix du marche des grands championnats : on le
       note au passage, sans un credit de plus (08/10/2026). Lot 3 : `vendue` ou
       `observee` (le joker du tennis), avec le SPORT de la ligne (deux issues
       au hockey, a la NFL, a la NBA, au tennis) ; une cle observee laisse aussi
       sa releve au carnet d'observation. */
    if (prixMarche.vendue(l.clef) || prixMarche.observee(l.clef)) {
      try {
        const c = prixMarche.note(evs, l.clef, undefined, { quoi: 'etalonnage', sport: l.sport });
        console.log(`[odds] prix du marche ${l.clef} (etalonnage) : ${JSON.stringify(c)}`);
        if (!prixMarche.vendue(l.clef) && !c.sportInconnu && !c.venteImpossible) prixObserve.noteEu(l.clef, l.sport, c, Date.now(), 'ok');
      } catch (e) { console.log('[odds] prix du marche ' + l.clef + ' illisible : ' + (e.message || e)); }
    }

    for (const ev of evs || []) {
      /* ---- LA MEDIANE DES BOOKMAKERS, PAS LE PREMIER ----
       * On lisait `bookmakers[0]` — celui que l'API renvoie en tete, sans
       * raison particuliere. Un seul cotant large, une cote saisie de travers,
       * un livre qui n'a pas encore ouvert : et c'etait lui qui deplacait nos
       * forces, sur un match ou vingt autres maisons etaient d'accord entre
       * elles. Une force fausse ne se voit nulle part — elle ressort plus tard
       * en une cote de travers sur une affiche, et on cherche le defaut
       * ailleurs.
       * La mediane resiste a un aberrant, la moyenne non : il suffit d'un
       * livre a 3,00 sur un favori a 1,40 pour tirer la moyenne. */
      const prix = (nom) => {
        const l = [];
        for (const b of (ev.bookmakers || [])) {
          const m = (b.markets || []).find((x) => x.key === 'h2h');
          const o = m && Array.isArray(m.outcomes) && m.outcomes.find((y) => y.name === nom);
          if (o && Number(o.price) > 1) l.push(Number(o.price));
        }
        if (!l.length) return null;
        l.sort((a, b) => a - b);
        const i = Math.floor(l.length / 2);
        return { prix: l.length % 2 ? l[i] : (l[i - 1] + l[i]) / 2, livres: l.length };
      };
      const cDom = prix(ev.home_team);
      const cExt = prix(ev.away_team);
      if (!cDom || !cExt) continue;
      const nul = prix('Draw');
      /* Un seul livre n'est pas une mediane : on l'accepte faute de mieux, mais
         il ne pese qu'un quart de ce que pesent plusieurs livres d'accord. */
      const confiance = Math.min(1, (cDom.livres + cExt.livres) / 6);

      /* On enleve la marge : les inverses des cotes somment a 1 + marge, on
         ramene la somme a 1. */
      const inv = [1 / cDom.prix, 1 / cExt.prix].concat(nul ? [1 / nul.prix] : []);
      const somme = inv.reduce((a, b) => a + b, 0);
      const pDom = inv[0] / somme, pExt = inv[1] / somme;
      /* La force relative se lit sur le rapport victoire/victoire, nul mis de
         cote : c'est exactement la grandeur que modelise l'Elo. */
      const e = pDom / (pDom + pExt);
      if (!(e > 0.001 && e < 0.999)) continue;
      const ecartVu = -400 * Math.log10(1 / e - 1) - (cotes.TERRAIN[l.sport] || 0);
      const ecartNotre = cotes.note(l.sport, ev.home_team) - cotes.note(l.sport, ev.away_team);
      /* Un quart du chemin, module par le nombre de livres d'accord : une
         mediane sur six maisons vaut mieux qu'un prix isole, et le pas doit
         le dire. */
      /* ---- UNE EQUIPE JAMAIS VUE PREND D UN COUP LA FORCE DES LIVRES ----
       * Le quart de chemin est fait pour une force qui EXISTE : il amortit un
       * releve. Une equipe inconnue vaut 1500 par convention, pas par mesure ;
       * lui appliquer un quart laisserait une ligue nouvelle a des cotes
       * presque plates pendant un mois (0,25 par semaine) — un prix qu on
       * SAIT faux. Elle prend donc la force que la mediane des livres lui
       * donne, en entier ; la semaine d apres elle est connue, et le quart
       * s applique. Regle posee le 18 septembre 2026 avec les treize ligues
       * ajoutees, dont aucune equipe n avait de force. */
      const neuve = !!cotes.pourquoiPasCotable(l.sport, ev.home_team, ev.away_team);
      const delta = (ecartVu - ecartNotre) * (neuve ? 1 : 0.25 * confiance);
      cotes.poseNote(l.sport, ev.home_team, cotes.note(l.sport, ev.home_team) + delta / 2);
      cotes.poseNote(l.sport, ev.away_team, cotes.note(l.sport, ev.away_team) - delta / 2);
      bouges++;
    }
  }
  cotes.sauveNotes();
  console.log(`[odds] ${bouges} rencontre(s) ont recale les forces — paris_notes.json ecrit`);
  noteDernier('calibre', { rencontres: bouges, ligues: cibles.map((l) => l.clef) });
  return bouges;
}

/**
 * Lister les competitions disponibles. GRATUIT.
 *
 * Indispensable au tennis : les cles sont par TOURNOI, pas par circuit —
 * `tennis_atp_us_open` n'existe plus une fois l'US Open fini, et le
 * calendrier se viderait sans qu'on comprenne pourquoi. On regarde donc ce
 * qui est actif, et on met a jour ODDS_API_LIGUES.
 */
async function listeSports(filtre) {
  const tous = await appel('/sports', { all: 'true' }, 0, 'sports');
  const f = String(filtre || '').toLowerCase();
  const gardes = (tous || []).filter((s) => !f || (s.key + ' ' + s.group + ' ' + s.title).toLowerCase().includes(f));
  const actifs = gardes.filter((s) => s.active);
  console.log(`[odds] ${gardes.length} competition(s), dont ${actifs.length} active(s) — 0 credit`);
  for (const s of gardes.sort((a, b) => (b.active - a.active) || a.key.localeCompare(b.key))) {
    console.log(`  ${s.active ? '●' : '○'} ${s.key.padEnd(34)} ${s.title}`);
  }
  console.log('\nA reporter dans ODDS_API_LIGUES, sous la forme sport=cle :');
  console.log('  foot=... pour le football, tennis=... pour le tennis, nba=... pour la NBA');
  return gardes;
}

function montreQuota() {
  const q = etatQuota();
  const j = joursRestants();
  console.log(`[odds] ${q.reste} credit(s) restant(s), ${q.utilise} utilise(s)`);
  console.log(`[odds] ${j} jour(s) jusqu au ${fin()} → part du jour = ${partDuJour(q.reste)}`);
  console.log(`[odds] depense aujourd hui : ${q.depenseDuJour}`);
  console.log(`[odds] releve du serveur : ${q.vu || 'jamais — les chiffres ci-dessus sont une prevision'}`);
  console.log(`[odds] rappel : --matchs ne coute RIEN (endpoint /events).`);
  console.log(`[odds]          --scores coute 2 par ligue, --calibre 1 par ligue.`);
}

// ------------------------------------------------------- l'automatisation

/**
 * Faire tourner l'import DANS le serveur, sans deuxieme service a deployer.
 *
 * Le rythme n'est pas un reglage esthetique, il decoule du cout :
 *
 *   • les rencontres ne coutent RIEN, donc on peut les reprendre souvent.
 *     Deux fois par jour suffit — un calendrier a sept jours ne change pas
 *     d'heure en heure.
 *   • les scores coutent, donc une fois par jour, et seulement pour les
 *     ligues qui ont une rencontre finie.
 *
 * `signale` recoit la liste des rencontres a regler. Le serveur la pousse sur
 * Telegram : sans ca, elle serait ecrite dans un journal que personne ne lit,
 * et les paris resteraient ouverts.
 */
const H = 3600000;
const SEMAINE = 7 * 24 * H;

/* ---- LE PREMIER ETALONNAGE NE SE PAIE PAS A CHAQUE DEMARRAGE ----
 *
 * Il etait pose une heure apres CHAQUE demarrage, et le commentaire au-dessus
 * de la minuterie promettait qu'un redeploiement ne coute rien. Mesure du
 * 18 septembre 2026 : 118 deploiements Railway sur 17 jours, un etalonnage a
 * neuf ligues actives chaque fois que le processus a vecu plus d'une heure,
 * et 211 credits partis dans le mois quand les scores en coutent quatre par
 * jour (relevé de `odds_quota.json` : 289 restants sur 500 le 17). La date
 * du dernier etalonnage est deja sur le volume, `calibre.quand` dans
 * `odds_dernier.json` : on repart d'elle. Moins de sept jours, on attend le
 * reste ; sept jours ou plus, ou jamais etalonne, une heure comme avant.
 * Jamais moins d'une heure : un serveur qui redemarre en boucle ne doit pas
 * etalonner en boucle. */
function delaiAvantEtalonnage(maintenant) {
  const d = litDernier().calibre;
  const t = d ? Date.parse(d.quand) : NaN;
  if (!isFinite(t)) return H;
  return Math.max(H, SEMAINE - ((maintenant || Date.now()) - t));
}

/* `expositionDe` (lot 4, facultatif) : l'engagement d'une rencontre, pour que
   l'ombre trie avec le meme plafond que la vraie passe. */
function planifie(signale, aRegler, expositionDe) {
  if (!CLE) {
    console.log('[odds] ODDS_API_KEY absente : le calendrier reste celui du depot');
    return null;
  }
  const sur = (quoi, f) => f().catch((e) => console.error('[odds] ' + quoi + ' : ' + (e.message || e)));
  /* ---- UNE SEULE RELEVE DE SCORES A LA FOIS (lot 4, 10/10/2026) ----
   * La quotidienne et la frequente (2 h) passent par cette file, comme les
   * prix par `filePrix` : deux passes en parallele liraient les memes
   * rencontres avant que l'une les ait reglees, et la seconde ferait refuser
   * « already settled » sur le canal public. La file avance meme si une
   * passe echoue. */
  let fileScores = Promise.resolve();
  const enFile = (f) => {
    const p = fileScores.then(f, f);
    fileScores = p.catch(() => {});
    return p;
  };

  const rafraichit = () => sur('matchs', async () => {
    await importeMatchs();
    /* Le module `paris` garde le catalogue en memoire : sans cette relecture,
       le serveur continuerait de servir l'ancien jusqu'au prochain
       redemarrage, et l'import n'aurait servi a rien. */
    paris.charge();
    console.log('[odds] calendrier recharge en memoire');
  });

  const releve = () => enFile(() => sur('scores', async () => {
    /* La ligne `[obs]` du jour, par sport (lot 3) : ce que le carnet
       d'observation mesure, avant les scores — une releve de scores qui leve
       ne doit pas la taire. Jamais bloquante. */
    try { for (const x of prixObserve.lignes()) console.log(x); } catch (e) { console.log('[obs] bilan illisible : ' + (e.message || e)); }
    /* L'heure de cette passe REELLE, sur le volume : le gain de l'ombre se
       mesure contre elle (lot 4). Jamais bloquant. */
    try { regJournal.notePasse(Date.now()); } catch (e) { /* jamais bloquant */ }
    const finis = await importeScores(aRegler);
    if (finis.length && typeof signale === 'function') signale(finis, { passe: 'quotidienne' });
  }));

  /* ---- LA PASSE ESPN FREQUENTE (lot 4, 10/10/2026) ----
   * Toutes les PARIS_SCORES_ESPN_H heures (2), 0 credit. « observe » (defaut) :
   * l'ombre SEULE — rien n'est remis a `signale`, donc rien n'est regle ni
   * publie. « regle » (bascule A, porte en EXPLOITATION 8.10) : en plus, ce
   * qu'ESPN tranche sur 3 jours est remis a `signale` ({ passe: 'frequente' }),
   * sans jamais payer de /scores. « 0 » : rien. Le mode se relit a chaque
   * passe. */
  const frequente = () => enFile(() => sur('scores frequents', async () => {
    const mode = modeEspn();
    if (mode === '0') return;
    await ombreReglement(aRegler, expositionDe, Date.now());
    if (mode !== 'regle') return;
    const finis = await importeScores(aRegler, { payant: false, fenetreEspnMs: scoresEspnFenJ() * 86400000 });
    if (finis.length && typeof signale === 'function') signale(finis, { passe: 'frequente' });
  }));

  /* On laisse le serveur finir de demarrer avant de sortir sur le reseau :
     un import qui echoue ne doit pas se confondre avec un demarrage rate. */
  /* L'ETALONNAGE. Il etait documente et jamais programme — l'oubli le plus
     couteux du lot, parce qu'il ne se voit pas : les cotes restent valides,
     avec la bonne marge, simplement fausses. Sans forces a jour, toutes les
     rencontres sortaient a 2,08 / 3,61 / 2,92, et « Hull City – Manchester
     United » donnait Hull favori. Une marge de 10 % sur un prix faux perd de
     l'argent contre quiconque connait le sport.
     Une fois par semaine, un credit par ligue. */
  const etalonne = () => sur('calibre', async () => {
    await calibre();
    await rafraichit();     // les cotes se refont avec les forces corrigees
  });

  /* Le prix du marche : releve ce qui est perime, puis refait le calendrier
     (0 credit) pour que les cotes en descendent — seulement si un championnat
     VENDU a ete releve (`rafraichitPrix` ne compte que ceux-la, socle du
     10/10) : le prix d'un observe n'entre dans aucune cote. */
  const prix = (clefs, pourquoi, ageMin) => sur('prix', async () => {
    if (!clefs.length) return;
    if (await rafraichitPrix(clefs, pourquoi, ageMin)) await rafraichit();
  });
  /* Le tic de 10 min, cause par cause (`causesAvantMatch`). Les deux tours
     entrent dans `filePrix` au meme instant (rien ne s'intercale), et le
     calendrier ne se refait qu'UNE fois, comme avant, si un vendu a bouge. */
  const avantMatch = () => sur('prix', async () => {
    const tours = causesAvantMatch(aRegler).map((x) => rafraichitPrix(x.clefs, x.quoi, PRIX_DEMANDE_MS));
    const vendues = (await Promise.all(tours)).reduce((a, b) => a + b, 0);
    if (vendues) await rafraichit();
  });
  /* Les totaux du marche (lot 5) : la regle 48 h / 48 h / 12 h, puis le
     calendrier qui en descend (0 credit) — seulement si un championnat VENDU
     a ete releve : un total observe n'entre dans aucune cote. La cloture
     (PARIS_TOTAUX_CLOTURE=1) mesure seulement : elle ne refait rien. */
  const totaux = () => sur('totaux', async () => {
    const clefs = totauxAReleve();
    if (!clefs.length) return;
    if (await rafraichitTotaux(clefs, 'avant la journee')) await rafraichit();
  });
  const clotureTotaux = () => sur('cloture totaux', async () => {
    const clefs = totauxCloture();
    if (clefs.length) await rafraichitTotaux(clefs, 'cloture', { cloture: true });
  });
  {
    const inconnues = prixInconnues();
    if (inconnues.length) console.log('[odds] PARIS_PRIX_LIGUES / PARIS_PRIX_OBSERVE : ' + inconnues.join(', ') + ' absente(s) des ligues importees — jamais relevee(s)');
    /* Toujours ecrit : c'est la seule ligne qui dit, apres un changement de
       variable, ce qui se vend vraiment au prix du marche. */
    console.log('[odds] prix du marche : vendu sur ' + prixMarche.ligues().size + ' (' + [...prixMarche.ligues()].join(', ') + ')'
      + ', observe sur ' + prixMarche.observees().size + ', releve toutes les ' + Math.round(prixMarche.releveMs() / 3600000) + ' h'
      /* lot 3 : la cadence d'une cle observee, toujours dite */
      + ', observe toutes les ' + Math.round(prixMarche.observeMs() / 3600000) + ' h');
    /* Ce qui est ecrit et ne sera jamais releve : un joker autre que le tennis,
       une cle cricket (lot 3). */
    const refus = prixLigues.refusees();
    if (refus.length) console.log('[odds] IGNORE(S) : ' + refus.join(' ; '));
    /* Le plafond d'engagement des rencontres cotees a l'Elo (lot 3) : vide =
       rien ne change ; une valeur invalide est IGNOREE et dite ici. */
    const pe = paris.eloEngagementMax();
    console.log('[paris] PARIS_ELO_ENGAGEMENT_MAX : ' + (pe.valeur !== null ? pe.valeur + ' $SWOGEBET par rencontre cotee a l Elo'
      : pe.invalide ? 'IGNORE (« ' + pe.brut + ' » n est pas un nombre strictement positif) — plafond global seul' : 'vide — plafond global seul'));
    try { console.log(prixObserve.ligneDemarrage()); } catch (e) { /* jamais bloquant */ }
    ditLaPorte('demarrage');
    /* Le journal des releves : actif ou coupe, ce qu'il garde. Lire son etat
       ici remplit aussi le compte par fichier (une fois par processus). */
    try { console.log(prixJournal.ligneDemarrage()); } catch (e) { /* jamais bloquant */ }
    /* Les totaux du marche (lot 5) : toujours dit, meme vide. */
    try { console.log(ligneTotaux()); } catch (e) { /* jamais bloquant */ }
  }
  const premier = delaiAvantEtalonnage();
  const minuteries = [
    /* Au demarrage : d'abord les prix perimes, puis le calendrier — sinon le
       premier import suspendrait les grands championnats le temps du releve. */
    setTimeout(() => sur('demarrage', async () => {
      /* Le calendrier d'abord s'il est vide (premier demarrage : prixPerimes
         lit les rencontres a venir), les prix perimes, puis le calendrier qui
         en descend — dans un finally : un releve qui echoue ne doit pas
         priver TOUS les sports de leur import. */
      try {
        if (!paris.catalogue().matchs.some((m) => m.debut > Date.now())) await importeMatchs();
        const p = prixPerimes();
        if (p.length) await rafraichitPrix(p, 'demarrage', prixMarche.releveMs());
      } finally { await rafraichit(); }
    }), 30000),
    setInterval(rafraichit, 12 * H),
    setInterval(() => prix(prixPerimes(), 'periodique', prixMarche.releveMs()), 30 * 60000),
    /* Decalee de 5 min : elle ne tombe plus en meme temps que la quotidienne. */
    setTimeout(() => minuteries.push(setInterval(avantMatch, 10 * 60000)), 5 * 60000),
    setTimeout(releve, 5 * 60000),
    setInterval(releve, 24 * H),
    /* La passe ESPN frequente (lot 4) : 20 min apres le demarrage — decalee
       des 5 min de la quotidienne —, puis toutes les PARIS_SCORES_ESPN_H
       heures. Elle passe dans `fileScores` : jamais en meme temps qu'elle. */
    setTimeout(() => { frequente(); minuteries.push(setInterval(frequente, scoresEspnH() * H)); }, 20 * 60000),
    /* Le premier etalonnage attend ce qui reste des sept jours depuis le
       dernier (voir `delaiAvantEtalonnage`), et c'est LUI qui pose la
       cadence hebdomadaire : un intervalle compte depuis le demarrage aurait
       refait un etalonnage sept jours apres le boot, soit un jour apres le
       premier quand celui-ci en attendait six. */
    setTimeout(function () {
      etalonne();
      minuteries.push(setInterval(etalonne, SEMAINE));
    }, premier),
  ];
  /* Les totaux (lot 5) : AUCUNE minuterie quand les deux listes sont vides
     (le defaut) — un deploiement ne fait rien de plus. Elles passent dans la
     MEME file que les prix (`filePrix`) : un tic des totaux qui tombe en meme
     temps que l'avant-match (5 + 10k min apres le demarrage) pouvait faire
     entrer jusqu'a 17 releves DEVANT la releve h2h de ce qui est vendu (au
     pire 17 x 15 s de delai, et les paris refuses faute de prix frais ;
     relecture du 10/10/2026). Donc :
       - la regle toutes les 30 min a partir de 20 min (20, 50, 80...) : ni
         sur l'avant-match (5 + 10k), ni sur la periodique des prix (30k) ;
         son plus long tour (17 x 15 s, 4 min 15 s) finit avant l'avant-match
         suivant, 5 min plus tard ;
       - la cloture toutes les 10 min a partir de 17 min (17, 27, 37...) :
         2 min APRES chaque avant-match, qui est donc deja dans la file ;
         seulement si PARIS_TOTAUX_CLOTURE=1 (relu au demarrage). */
  if (prixLigues.totauxARelever().size) {
    minuteries.push(setTimeout(() => { totaux(); minuteries.push(setInterval(totaux, 30 * 60000)); }, TOTAUX_TIC_PREMIER_MS));
    if (process.env.PARIS_TOTAUX_CLOTURE === '1')
      minuteries.push(setTimeout(() => minuteries.push(setInterval(clotureTotaux, 10 * 60000)), CLOTURE_TIC_DECALAGE_MS));
  }
  console.log(`[odds] alimentation automatique : rencontres toutes les 12 h (0 credit), ` +
              `scores payes une fois par jour et a chaque demarrage, etalonnage une fois par semaine ` +
              `(le prochain dans ${Math.round(premier / H)} h). ` +
              `${etatQuota().reste} credit(s), ` +
              `part du jour ${partDuJour(etatQuota().reste)} jusqu au ${fin()}`);
  /* La cadence et le mode REELS du reglement (lot 4) : la seule ligne qui dit,
     apres un changement de variable, si la passe de 2 h regle ou observe. */
  {
    const mode = modeEspn(), inv = modeEspnInvalide();
    console.log('[reglement] scores : ' + (mode === '0' ? 'passe ESPN frequente COUPEE (PARIS_SCORES_ESPN=0)'
      : `ESPN toutes les ${scoresEspnH()} h (${mode === 'regle' ? 'REGLE, 0 credit, fenetre ' + scoresEspnFenJ() + ' j' : 'observe : ombre seule, rien n est regle ni publie'})`)
      + (inv ? ` — PARIS_SCORES_ESPN « ${inv} » IGNORE` : '')
      + ', repli payant /scores une fois par jour et a chaque demarrage'
      + `, coupe des cles jamais appariees ${scoresCoupe() ? 'ARMEE (' + scoresCoupeN() + ' appels inutiles)' : 'eteinte'}`
      + `, rencontres en cours ${scoresSauteEnCours() ? 'SAUTEES' : 'payees comme avant'}`);
  }
  /* On rend les minuteries : une minuterie oubliee garde le processus en
     vie a l arret et peut refaire un appel reseau en plein redeploiement. */
  return { rafraichit, releve, frequente, etalonne, prix, avantMatch, totaux, clotureTotaux, minuteries, arrete() { minuteries.forEach(clearTimeout); minuteries.forEach(clearInterval); } };
}

// ---------------------------------------------------------------- l'appel

if (require.main === module) {
  const a = process.argv.slice(2);
  const quoi = a.find((x) => x.startsWith('--')) || '--quota';
  const suite = { '--matchs': importeMatchs, '--scores': importeScores,
                  '--calibre': () => calibre(a.find((x) => !x.startsWith('--'))),
                  /* Le prix du marche des grands championnats (1 credit chacun),
                     puis le calendrier qui en descend (0 credit). */
                  '--prix': async () => { await rafraichitPrix(clefsALaMain(), 'a la main'); await importeMatchs(); },
                  '--sports': () => listeSports(a.find((x) => !x.startsWith('--'))),
                  /* Le journal du reglement (lot 4) : l'ombre, le gain, les
                     /scores payes, les portes A et B. 0 credit, aucun appel
                     reseau : il lit DATA_DIR/reglement_journal.json. */
                  '--reglement': async () => { for (const x of lignesReglement(bilanReglement())) console.log(x); },
                  /* Les totaux du marche (lot 5) : `--totaux <cle>` releve UN
                     championnat liste (PARIS_TOTAUX_OBSERVE ou _LIGUES : 1
                     credit), puis le calendrier ; `--totaux` seul ecrit l'etat
                     (couverture, mesure, credits) — 0 credit, aucun appel. */
                  '--totaux': async () => {
                    const l = a.find((x) => !x.startsWith('--'));
                    if (!l) { console.log(JSON.stringify(etatTotaux(), null, 1)); return; }
                    if (!prixLigues.totauxARelever().has(l)) throw new Error(`--totaux ${l} : absente de PARIS_TOTAUX_OBSERVE et de PARIS_TOTAUX_LIGUES — aucun appel`);
                    await rafraichitTotaux([l], 'a la main'); await importeMatchs();
                  },
                  '--quota': async () => montreQuota() }[quoi];
  if (!suite) {
    console.error('usage : --quota | --sports [filtre] | --matchs | --scores | --calibre [ligue] | --prix | --reglement | --totaux [ligue]');
    process.exit(2);
  }
  suite().then(() => process.exit(0))
         .catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

module.exports = { LIGUES, LIGUES_DEFAUT, liguesEnService, importeMatchs, importeScores, calibre, montreQuota, listeSports, planifie, delaiAvantEtalonnage,
                   finDuMois, fin,
                   etatImport, noteDernier,
                   trieReglements, prolongationPossible, avecPrix, rafraichitPrix, prixPerimes, prixAvantMatch, causesAvantMatch, etatPrix, ecartAuMarche, prixInconnues, fermeesParLaPorte, ditLaPorte, PRIX_JOUR_MS,
                   sportDeLaCle, liguesAvecRencontre, clefsALaMain,
                   AUTO_PLAFOND, AUTO_DELAI_MIN, AUTO_ACTIF,
                   PAYS_LIGUE, NOM_PAYS, chargePays, clePays, paysDe,
                   partDuJour, joursRestants, autorise, identifiant, etatQuota,
                   /* le socle (10/10/2026) : le seul chemin d'un credit, ses classes, son delai */
                   appel, RESERVES_CLASSE, DELAI_APPEL_MS, projectionMois, PROJECTION_SEUIL, PROJECTION_JOURS_MIN,
                   etatClasses, codeDuCorps,
                   /* le reglement (lot 4, 10/10/2026) : l'ombre, le compte, les portes */
                   ombreReglement, bilanReglement, lignesReglement, clefCoupee, modeEspn, scoresEspnH, scoresEspnFenJ, ombreH,
                   SCORES_NON_COCHEES, PORTE_A, PORTE_B, OMBRE_FENETRE_MS, attenteCoupeMs, COUPE_ATTENTE_H, refusOmbreVus,
                   /* les totaux du marche (lot 5, 10/10/2026) : observation, cloture, porte de vente */
                   avecButs, totauxAReleve, totauxCloture, rafraichitTotaux, mesureCloture, etatTotaux, ecartTotaux, ligneTotaux, totauxInconnues,
                   TOTAUX_AVANT_MS, TOTAUX_ECART_MS, TOTAUX_ESSAIS_MAX, TOTAUX_PLAFOND_MOIS, TOTAUX_CLOTURE_ECART_MS, CLOTURE_AVANT,
                   TOTAUX_TIC_PREMIER_MS, CLOTURE_TIC_DECALAGE_MS, sansButs };
