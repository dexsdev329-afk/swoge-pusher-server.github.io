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
 *     avec `daysFrom=1`, qui rattrape les rencontres finies depuis la veille.
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
const paris = require('./paris');

const BASE = 'https://api.the-odds-api.com/v4';
const CLE = process.env.ODDS_API_KEY || '';

/* Les competitions suivies, par sport DE CE SITE. Les clefs a droite sont
   celles de The Odds API ; `GET /v4/sports` les liste toutes, gratuitement.
   On les met dans une variable d'environnement pour pouvoir en ajouter une
   sans redeployer le code. */
const LIGUES = (process.env.ODDS_API_LIGUES || [
  'foot=soccer_epl',
  'foot=soccer_france_ligue_one',
  'foot=soccer_spain_la_liga',
  'foot=soccer_italy_serie_a',
  'foot=soccer_germany_bundesliga',
  'foot=soccer_uefa_champs_league',
  'tennis=tennis_atp_us_open',
  'tennis=tennis_wta_us_open',
  'nba=basketball_nba',
].join(',')).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const [sport, clef] = x.split('=');
  return { sport: (sport || '').trim(), clef: (clef || '').trim() };
}).filter((x) => x.sport && x.clef);

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
const FICHIER_CAT = path.join(__dirname, 'paris_catalogue.json');

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
     c'est la seule mesure fiable, la notre n'est qu'une prevision. */
  const reste = Number(rep.headers.get('x-requests-remaining'));
  const dernier = Number(rep.headers.get('x-requests-last'));
  if (isFinite(reste)) q.reste = reste;
  if (isFinite(Number(rep.headers.get('x-requests-used')))) q.utilise = Number(rep.headers.get('x-requests-used'));
  if (isFinite(dernier) && dernier > 0) q.depenseDuJour += dernier;
  q.vu = new Date().toISOString();
  ecritQuota(q);

  if (!rep.ok) {
    const t = await rep.text();
    throw new Error(`[odds] ${rep.status} sur ${chemin} : ${t.slice(0, 200)}`);
  }
  const j = await rep.json();
  if (paye) {
    console.log(`[odds] ${quoi} : ${isFinite(dernier) ? dernier : '?'} credit(s), ` +
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

  const echouees = new Set();
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
        competition: NOM_COMPET(l.clef), pays: '',
        domicile: ev.home_team, exterieur: ev.away_team,
        debut: new Date(t).toISOString(),
        source: { fournisseur: 'the-odds-api', ligue: l.clef, evenement: ev.id },
      });
      sports.add(l.sport);
      pris++;
    }
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
                    domicile: h.domicile, exterieur: h.exterieur, debut: h.debut,
                    cotes: h.cotes, cotesGenerees: !!h.cotesGenerees, source: h.source });
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
    return 0;
  }

  /* Une ligue qui a echoue toute seule — un 502 passager, une competition qui
     rend 404 le temps d'une intersaison — ne doit pas faire disparaitre ses
     rencontres deja au calendrier. On reprend les siennes telles quelles. */
  if (echouees.size) {
    let repris = 0;
    try {
      const avant = JSON.parse(fs.readFileSync(FICHIER_CAT, 'utf8'));
      for (const m of avant.matchs || []) {
        const lg = m.source && m.source.ligue;
        if (!lg || !echouees.has(lg)) continue;
        if (Date.parse(m.debut) <= Date.now()) continue;
        if (vus.has(m.id)) continue;
        habilles.push(m); repris++;
      }
    } catch (e) { /* pas de catalogue precedent : rien a reprendre */ }
    if (repris) console.log(`[odds] ${repris} rencontre(s) conservee(s) des ligues en echec`);
  }

  if (!habilles.length) {
    console.error('[odds] aucune rencontre retenue — le calendrier existant est CONSERVE');
    return 0;
  }

  habilles.sort((a, b) => Date.parse(a.debut) - Date.parse(b.debut));
  const NOMS = { foot: 'Football', tennis: 'Tennis', nba: 'NBA' };
  const retenus = new Set(habilles.map((m) => m.sport));
  const catalogue = {
    sports: ['foot', 'tennis', 'nba'].map((c) => ({ cle: c, nom: NOMS[c], actif: retenus.has(c) })),
    matchs: habilles,
  };

  /* On le fait relire par le VALIDATEUR du serveur avant de l'ecrire : un
     catalogue refuse empeche le serveur de demarrer, et on prefere l'apprendre
     ici que dans les journaux d'un dimanche soir. */
  paris.valide(catalogue);
  fs.writeFileSync(FICHIER_CAT, JSON.stringify(catalogue, null, 1) + '\n');
  console.log(`[odds] catalogue ecrit : ${habilles.length} rencontre(s), 0 credit depense`);
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
async function importeScores() {
  paris.charge(FICHIER_CAT);
  const ouverts = new Set(paris.catalogue().matchs.map((m) => m.id));

  /* On n'interroge QUE les ligues qui ont une rencontre finie a rattraper.
     Demander les scores des neuf ligues chaque jour couterait 18 credits —
     846 d'ici la fin, pour un forfait de 500. La plupart des jours, deux
     ligues jouent : la depense reelle tombe a 4.
     La fenetre s'arrete a trois jours parce que `daysFrom` ne remonte pas
     plus loin ; au-dela, le reglement se fait a la main de toute facon. */
  const t = Date.now();
  const FENETRE = 3 * 86400000;
  const parLigue = new Map();
  for (const m of paris.catalogue().matchs) {
    const l = m.source && m.source.ligue;
    if (!l) continue;
    if (m.debut > t) continue;                  // pas encore joue
    if (t - m.debut > FENETRE) continue;        // trop vieux pour cet endpoint
    if (!parLigue.has(l)) parLigue.set(l, m.sport);
  }
  if (!parLigue.size) {
    const total = paris.catalogue().matchs.length;
    console.log(total
      ? `[odds] aucune rencontre finie dans les 3 derniers jours sur ${total} au calendrier — 0 credit depense`
      : '[odds] catalogue vide — lancez d abord --matchs');
    return [];
  }
  console.log(`[odds] ${parLigue.size} ligue(s) a interroger → ${parLigue.size * 2} credit(s)`);

  const finis = [];
  for (const [clef] of parLigue) {
    let sc;
    try { sc = await appel(`/sports/${clef}/scores`, { daysFrom: 1 }, 2, 'scores ' + clef); }
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
      finis.push({ id: cible.id, sport: cible.sport, domicile: ev.home_team,
                   exterieur: ev.away_team, score: `${a}-${b}`, resultat });
    }
  }

  if (!finis.length) { console.log('[odds] aucune rencontre finie a regler'); return finis; }
  console.log('\n[odds] a REGLER — verifiez le score avant d appeler :');
  for (const f of finis) {
    console.log(`  ${f.domicile} ${f.score} ${f.exterieur}  →  resultat=${f.resultat}`);
    console.log(`    curl -H "x-admin-key: $ADMIN_KEY" ` +
                `"$URL/paris/regle?match=${f.id}&resultat=${f.resultat}"`);
  }
  return finis;
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
function planifie(signale) {
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
    paris.charge(FICHIER_CAT);
    console.log('[odds] calendrier recharge en memoire');
  });

  const releve = () => sur('scores', async () => {
    const finis = await importeScores();
    if (finis.length && typeof signale === 'function') signale(finis);
  });

  /* On laisse le serveur finir de demarrer avant de sortir sur le reseau :
     un import qui echoue ne doit pas se confondre avec un demarrage rate. */
  const minuteries = [
    setTimeout(rafraichit, 30000),
    setInterval(rafraichit, 12 * H),
    setTimeout(releve, 5 * 60000),
    setInterval(releve, 24 * H),
  ];
  console.log(`[odds] alimentation automatique : rencontres toutes les 12 h (0 credit), ` +
              `scores une fois par jour. ${etatQuota().reste} credit(s), ` +
              `part du jour ${partDuJour(etatQuota().reste)} jusqu au ${FIN}`);
  /* On rend les minuteries : une minuterie oubliee garde le processus en
     vie a l arret et peut refaire un appel reseau en plein redeploiement. */
  return { rafraichit, releve, minuteries, arrete() { minuteries.forEach(clearTimeout); minuteries.forEach(clearInterval); } };
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

module.exports = { LIGUES, importeMatchs, importeScores, calibre, montreQuota, listeSports, planifie,
                   partDuJour, joursRestants, autorise, identifiant, etatQuota };
