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
 *
 * Les variables d'environnement sont decrites dans EXPLOITATION.md.
 */

const fs = require('fs');
const path = require('path');
const cotes = require('./cotes');
const espn = require('./scores_espn');
const paris = require('./paris');

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
  'tennis=tennis_atp_us_open',
  'tennis=tennis_wta_us_open',
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
];

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
  if (paris.sportConnu(x.sport)) return true;
  console.error(`[odds] LIGUE IGNOREE « ${x.sport}=${x.clef} » : le sport `
    + `« ${x.sport} » n'est pas declare. Ajoutez-le a SPORTS dans paris.js — `
    + `ses issues, son nom et son avantage du terrain tiennent en une ligne. `
    + `Connus : ${Object.keys(paris.SPORTS).join(', ')}`);
  return false;
});

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
  soccer_usa_mls: 'US', basketball_nba: 'US', americanfootball_nfl: 'US',
  cricket_t20_blast: 'GB', cricket_the_hundred: 'GB',
};
/* Le nom du pays, pour le champ `pays` de la rencontre. */
const NOM_PAYS = {
  GB: 'England', FR: 'France', ES: 'Spain', IT: 'Italy', DE: 'Germany',
  NL: 'Netherlands', PT: 'Portugal', BE: 'Belgium', TR: 'Turkey', US: 'USA',
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
const FIN = process.env.ODDS_API_FIN || '2026-09-30';
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

function litQuota() {
  try { return JSON.parse(fs.readFileSync(FICHIER_QUOTA, 'utf8')); }
  catch (e) { return { reste: TOTAL, utilise: 0, vu: null, depenseDuJour: 0, jour: null }; }
}
function ecritQuota(q) {
  try { fs.writeFileSync(FICHIER_QUOTA, JSON.stringify(q, null, 2) + '\n'); }
  catch (e) { console.error('[odds] impossible d ecrire le compteur :', e.message); }
}
function jourCourant() { return new Date().toISOString().slice(0, 10); }
function joursRestants() {
  const fin = Date.parse(FIN + 'T23:59:59Z');
  return Math.max(1, Math.ceil((fin - Date.now()) / 86400000));
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

/* Avant chaque appel PAYANT. On refuse plutot que de depasser : un quota
   epuise le 5 septembre ne se recharge pas, et le calendrier se figerait
   jusqu'a la fin du mois. */
function autorise(cout, quoi) {
  const q = etatQuota();
  const part = partDuJour(q.reste);
  if (cout > q.reste) {
    throw new Error(`[odds] REFUSE ${quoi} : ${cout} credit(s) demande(s), ` +
                    `${q.reste} restant(s) en tout`);
  }
  if (q.depenseDuJour + cout > part) {
    throw new Error(`[odds] REFUSE ${quoi} : ${cout} credit(s) demande(s), ` +
      `${q.depenseDuJour} deja depense(s) aujourd hui, part du jour = ${part} ` +
      `(${q.reste} restants pour ${joursRestants()} jour(s) jusqu au ${FIN})`);
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

/** Tout ce qu'il faut pour comprendre l'etat de l'alimentation, sans journaux. */
function etatImport() {
  const q = etatQuota();
  return {
    /* Jamais la cle — seulement si elle est la. */
    cle: !!CLE,
    ligues: LIGUES.map((l) => l.sport + '=' + l.clef),
    horizonJours: HORIZON_JOURS,
    fin: FIN,
    joursRestants: joursRestants(),
    quota: { reste: q.reste, utilise: q.utilise, depenseDuJour: q.depenseDuJour,
             partDuJour: partDuJour(q.reste), vu: q.vu },
    auto: { actif: AUTO_ACTIF, plafond: AUTO_PLAFOND, delaiMin: AUTO_DELAI_MIN },
    dernier: litDernier(),
  };
}

// ------------------------------------------------------------- les appels

async function appel(chemin, params, coutAttendu, quoi) {
  if (!CLE) throw new Error('[odds] ODDS_API_KEY absente — rien ne peut etre demande');
  const paye = coutAttendu > 0;
  const q = paye ? autorise(coutAttendu, quoi) : etatQuota();

  const u = new URL(BASE + chemin);
  u.searchParams.set('apiKey', CLE);
  for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, String(v));

  const rep = await fetch(u.toString());
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
  if (reste !== null) q.reste = reste;
  if (utilise !== null) q.utilise = utilise;
  if (dernier !== null && dernier > 0) q.depenseDuJour += dernier;
  q.vu = new Date().toISOString();
  ecritQuota(q);

  if (!rep.ok) {
    const t = await rep.text();
    throw new Error(`[odds] ${rep.status} sur ${chemin} : ${t.slice(0, 200)}`);
  }
  const j = await rep.json();
  if (paye) {
    console.log(`[odds] ${quoi} : ${dernier === null ? '?' : dernier} credit(s), ` +
                `${q.reste} restant(s), part du jour ${partDuJour(q.reste)}`);
  }
  return j;
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

const NOM_COMPET = (clef) => clef.replace(/^soccer_|^tennis_|^basketball_/, '')
  .replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------ les actions

/** Les rencontres. GRATUIT — c'est tout l'interet de ce chemin. */
async function importeMatchs() {
  const limite = Date.now() + HORIZON_JOURS * 86400000;
  const matchs = [];
  const sports = new Set();

  const echouees = new Set(), erreurs = [], parLigueCompte = {};
  let repondues = 0;
  for (const l of LIGUES) {
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
  const vus = new Map();
  for (const m of matchs) {
    if (!vus.has(m.id)) { vus.set(m.id, m); continue; }
    let n = 2, cand;
    do { cand = (m.id + '-' + n).slice(0, 64); n++; } while (vus.has(cand));
    m.id = cand; vus.set(cand, m);
  }

  /* Les cotes sont FABRIQUEES ici. Une rencontre trop desequilibree n'est pas
     cotable : on l'ECARTE en le disant, plutot que de laisser `cotesDe` jeter
     et de perdre tout l'import pour un match. Un seul Alcaraz contre un
     qualifie suffirait sinon a vider le calendrier. */
  const habilles = [], ecartes = [];
  for (const m of [...vus.values()].sort((a, b) => Date.parse(a.debut) - Date.parse(b.debut))) {
    let h;
    try { h = cotes.habille(m); }
    catch (e) { ecartes.push(`${m.domicile} – ${m.exterieur} : ${e.message.split('— ')[1] || e.message}`); continue; }
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
                    cotesGenerees: !!h.cotesGenerees, source: h.source });
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
    try {
      /* On relit le calendrier EN SERVICE, pas la cible d'ecriture : au
         premier import qui suit la bascule sur le volume, le fichier du
         volume n'existe pas encore et c'est l'amorce du depot qu'il faut
         reprendre — sinon ses rencontres seraient perdues. */
      const avant = JSON.parse(fs.readFileSync(paris.fichier(), 'utf8'));
      const limiteBasse = Date.now() - RETENTION_JOURS * 86400000;
      for (const m of avant.matchs || []) {
        if (vus.has(m.id)) continue;                 // remplacee par la version fraiche
        const t = Date.parse(m.debut);
        if (!isFinite(t)) continue;
        if (t < limiteBasse) { vieilles++; continue; }
        /* Une rencontre conservee dont la cote est FABRIQUEE se retarife :
           les forces ont pu changer depuis. Celle qui a commence, non — les
           paris y sont poses a la cote affichee. */
        let g = m;
        if (m.cotesGenerees && t > Date.now()) {
          try { g = cotes.habille(m); }
          catch (e) { /* devenue incotable : on la garde telle quelle plutot
                         que de la faire disparaitre avec ses paris */ }
        }
        habilles.push(g); repris++;
      }
    } catch (e) { /* pas de catalogue precedent : rien a reprendre */ }
    if (repris) console.log(`[odds] ${repris} rencontre(s) precedente(s) conservee(s)` +
      (vieilles ? `, ${vieilles} trop ancienne(s) retiree(s)` : ''));
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
  noteDernier('matchs', { ok: true, ecrit: true, rencontres: habilles.length,
    importees: vus.size, repondues, parLigue: parLigueCompte,
    echouees: [...echouees], erreurs: erreurs.slice(0, 12),
    ecartees: ecartes.slice(0, 12) });
  return habilles.length;
}

/**
 * Les rencontres FINIES, pour le reglement. 2 credits par sport.
 *
 * On ne regle rien automatiquement : le reglement reste a la main, et c'est
 * assume ailleurs dans ce code — un service de resultats qui se trompe paie
 * les mauvaises personnes sans que personne ne le sache. Ce qu'on rend ici est
 * une LISTE A VERIFIER, avec l'adresse exacte a appeler pour chaque match.
 */
async function importeScores(aRegler) {
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
  const candidats = paris.catalogue().matchs.filter((m) =>
    m.debut <= tGratuit && tGratuit - m.debut <= FEN_ESPN
    && (typeof aRegler !== 'function' || aRegler(m.id)));
  let gratuites = [];
  try { gratuites = await espn.finies(candidats); }
  catch (e) { console.log('[espn] injoignable : ' + (e.message || e)); }
  const dejaVues = new Set(gratuites.map((f) => f.id));
  if (gratuites.length) {
    console.log(`[espn] ${gratuites.length} rencontre(s) reglee(s) sans depenser un credit`);
  }

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
  let sansEnjeu = 0;
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
    if (!parLigue.has(l)) parLigue.set(l, m.sport);
  }
  if (sansEnjeu) {
    /* On le DIT. Une economie silencieuse se lit comme une panne le jour ou
       une rencontre ne remonte pas, et l'on cherche du cote du reseau. */
    console.log(`[odds] ${sansEnjeu} rencontre(s) finie(s) sans pari en attente —`
                + ' pas de score demande pour elles');
  }
  if (!parLigue.size) {
    const total = paris.catalogue().matchs.length;
    console.log(total
      ? `[odds] aucune rencontre finie dans les 3 derniers jours sur ${total} au calendrier — 0 credit depense`
      : '[odds] catalogue vide — lancez d abord --matchs');
    /* Et l'on rend quand meme ce qu'ESPN a trouve : sortir ici les aurait
       jetees, et c'est le cas le PLUS frequent — le jour ou tout se regle
       gratuitement, il ne reste plus une seule ligue a interroger. */
    return gratuites.filter((f) => ouverts.has(f.id));
  }
  console.log(`[odds] ${parLigue.size} ligue(s) a interroger → ${parLigue.size * 2} credit(s)`);

  const finis = gratuites.filter((f) => ouverts.has(f.id));
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
    try { sc = await appel(`/sports/${clef}/scores`, { daysFrom: 3 }, 2, 'scores ' + clef); }
    catch (e) { console.log('[odds] ' + e.message); continue; }
    for (const ev of sc || []) {
      if (!ev.completed || !Array.isArray(ev.scores)) continue;
      const dom = ev.scores.find((s) => s.name === ev.home_team);
      const ext = ev.scores.find((s) => s.name === ev.away_team);
      if (!dom || !ext) continue;
      const a = Number(dom.score), b = Number(ext.score);
      if (!isFinite(a) || !isFinite(b)) continue;
      const resultat = a > b ? '1' : b > a ? '2' : 'N';
      const cible = paris.catalogue().matchs.find((m) =>
        m.source && m.source.evenement === ev.id);
      if (!cible || !ouverts.has(cible.id)) continue;
      if (dejaVues.has(cible.id)) continue;      // ESPN l'a deja tranchee
      finis.push({ id: cible.id, sport: cible.sport, domicile: ev.home_team,
                   exterieur: ev.away_team, score: `${a}-${b}`, resultat });
    }
  }

  if (!finis.length) { console.log('[odds] aucune rencontre finie a regler'); return finis; }
  console.log('\n[odds] a REGLER — verifiez le score avant d appeler :');
  for (const f of finis) {
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

    if (!AUTO_ACTIF) { mains.push(Object.assign({ raison: 'reglement automatique desactive' }, f)); continue; }
    if (depuis === null) { mains.push(Object.assign({ raison: 'rencontre absente du calendrier' }, f)); continue; }
    /* Le delai se compte depuis le COUP D'ENVOI, faute de mieux : le
       fournisseur ne dit pas quand la rencontre s'est terminee. On y ajoute
       donc la duree d'un match, genereusement. */
    if (depuis < AUTO_DELAI_MIN + 110) {
      mains.push(Object.assign({ raison: `finie depuis trop peu (${Math.round(depuis)} min)` }, f));
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
  const cibles = ligueDemandee ? LIGUES.filter((l) => l.clef === ligueDemandee) : LIGUES;
  if (!cibles.length) throw new Error('[odds] ligue inconnue : ' + ligueDemandee);
  let bouges = 0;

  for (const l of cibles) {
    let evs;
    try {
      evs = await appel(`/sports/${l.clef}/odds`,
        { regions: REGION, markets: MARCHE, oddsFormat: 'decimal' }, 1, 'odds ' + l.clef);
    } catch (e) { console.log('[odds] ' + e.message); continue; }

    for (const ev of evs || []) {
      const bk = (ev.bookmakers || [])[0];
      const mk = bk && (bk.markets || []).find((x) => x.key === 'h2h');
      if (!mk || !Array.isArray(mk.outcomes)) continue;
      const cDom = mk.outcomes.find((o) => o.name === ev.home_team);
      const cExt = mk.outcomes.find((o) => o.name === ev.away_team);
      if (!cDom || !cExt) continue;
      const nul = mk.outcomes.find((o) => o.name === 'Draw');

      /* On enleve la marge : les inverses des cotes somment a 1 + marge, on
         ramene la somme a 1. */
      const inv = [1 / cDom.price, 1 / cExt.price].concat(nul ? [1 / nul.price] : []);
      const somme = inv.reduce((a, b) => a + b, 0);
      const pDom = inv[0] / somme, pExt = inv[1] / somme;
      /* La force relative se lit sur le rapport victoire/victoire, nul mis de
         cote : c'est exactement la grandeur que modelise l'Elo. */
      const e = pDom / (pDom + pExt);
      if (!(e > 0.001 && e < 0.999)) continue;
      const ecartVu = -400 * Math.log10(1 / e - 1) - (cotes.TERRAIN[l.sport] || 0);
      const ecartNotre = cotes.note(l.sport, ev.home_team) - cotes.note(l.sport, ev.away_team);
      const delta = (ecartVu - ecartNotre) * 0.25;      // un quart du chemin
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
  console.log(`[odds] ${j} jour(s) jusqu au ${FIN} → part du jour = ${partDuJour(q.reste)}`);
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
function planifie(signale, aRegler) {
  if (!CLE) {
    console.log('[odds] ODDS_API_KEY absente : le calendrier reste celui du depot');
    return null;
  }
  const H = 3600000;
  const sur = (quoi, f) => f().catch((e) => console.error('[odds] ' + quoi + ' : ' + (e.message || e)));

  const rafraichit = () => sur('matchs', async () => {
    await importeMatchs();
    /* Le module `paris` garde le catalogue en memoire : sans cette relecture,
       le serveur continuerait de servir l'ancien jusqu'au prochain
       redemarrage, et l'import n'aurait servi a rien. */
    paris.charge();
    console.log('[odds] calendrier recharge en memoire');
  });

  const releve = () => sur('scores', async () => {
    const finis = await importeScores(aRegler);
    if (finis.length && typeof signale === 'function') signale(finis);
  });

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

  const minuteries = [
    setTimeout(rafraichit, 30000),
    setInterval(rafraichit, 12 * H),
    setTimeout(releve, 5 * 60000),
    setInterval(releve, 24 * H),
    /* Pas au demarrage : un redeploiement ne doit pas couter de credits.
       Le premier etalonnage a lieu une heure apres, puis chaque semaine. */
    setTimeout(etalonne, H),
    setInterval(etalonne, 7 * 24 * H),
  ];
  console.log(`[odds] alimentation automatique : rencontres toutes les 12 h (0 credit), ` +
              `scores une fois par jour, etalonnage une fois par semaine. ` +
              `${etatQuota().reste} credit(s), ` +
              `part du jour ${partDuJour(etatQuota().reste)} jusqu au ${FIN}`);
  /* On rend les minuteries : une minuterie oubliee garde le processus en
     vie a l arret et peut refaire un appel reseau en plein redeploiement. */
  return { rafraichit, releve, etalonne, minuteries, arrete() { minuteries.forEach(clearTimeout); minuteries.forEach(clearInterval); } };
}

// ---------------------------------------------------------------- l'appel

if (require.main === module) {
  const a = process.argv.slice(2);
  const quoi = a.find((x) => x.startsWith('--')) || '--quota';
  const suite = { '--matchs': importeMatchs, '--scores': importeScores,
                  '--calibre': () => calibre(a.find((x) => !x.startsWith('--'))),
                  '--sports': () => listeSports(a.find((x) => !x.startsWith('--'))),
                  '--quota': async () => montreQuota() }[quoi];
  if (!suite) {
    console.error('usage : --quota | --sports [filtre] | --matchs | --scores | --calibre [ligue]');
    process.exit(2);
  }
  suite().then(() => process.exit(0))
         .catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

module.exports = { LIGUES, LIGUES_DEFAUT, importeMatchs, importeScores, calibre, montreQuota, listeSports, planifie,
                   etatImport, noteDernier,
                   trieReglements, AUTO_PLAFOND, AUTO_DELAI_MIN, AUTO_ACTIF,
                   PAYS_LIGUE, NOM_PAYS, chargePays, clePays, paysDe,
                   partDuJour, joursRestants, autorise, identifiant, etatQuota };
