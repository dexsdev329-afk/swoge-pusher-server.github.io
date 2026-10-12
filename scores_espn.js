'use strict';
/*
 * LES SCORES, EN DIRECT ET GRATUITEMENT.
 *
 * ---- pourquoi ce fichier existe ----
 *
 * The Odds API donne les rencontres pour zero credit et les SCORES pour deux
 * credits par sport et par appel. Le forfait en donne cinq cents par mois.
 * Interroger cinq sports toutes les minutes — c'est ce que demande un score
 * en direct — coute quatorze mille quatre cents credits par jour : le quota
 * part en une heure. Le direct n'etait donc pas un choix de style, il etait
 * hors budget.
 *
 * Les tableaux de scores publics d'ESPN repondent sans cle, sans quota, et
 * portent l'etat en cours (« 14:52 - 3rd Quarter ») avec le score. Mesure
 * depuis ce serveur : NFL, NBA, les cinq championnats de football et le
 * cricket repondent. On prend donc les scores la, et l'on garde The Odds API
 * pour ce qu'elle seule sait faire.
 *
 * ---- LE TENNIS : CE QUI ETAIT VRAI, ET CE QUI L'EST AUJOURD'HUI ----
 *
 * Au 18/09/2026, son tableau ne rendait que des TOURNOIS — « US Open », zero
 * rencontre dedans — et le tennis restait sur The Odds API pour son reglement.
 * Ce n'est plus vrai : releve du 11/10/2026, `tennis/atp/scoreboard` et
 * `tennis/wta/scoreboard` repondent 200 (~0,9 et ~1,3 Mo, ~82 et ~104 Ko
 * compresses) et chaque tournoi porte ses rencontres dans
 * `groupings[].competitions[]` — Shanghai : 162 rencontres (125 finies, 37 a
 * venir), avec l'etat pre/in/post, l'heure et les deux joueurs nommes. C'est
 * le verrou d'heure reelle du tennis (`releveTennisTableau`, plus bas). Le
 * reglement du tennis, lui, n'a pas change : `releveTennis` (API interne).
 *
 * ---- ET POURQUOI AUCUN RAPPROCHEMENT FLOU ----
 *
 * Les deux sources ne nomment pas les equipes pareil. Mesure sur les
 * quatre-vingt-seize equipes du calendrier : quatre-vingt-deux tombent juste
 * apres normalisation, quatorze non.
 *
 * J'ai essaye le rapprochement par ressemblance sur ces quatorze. Il a propose
 * « Inter Milan » -> « AC Milan », et « Rennes » -> « Lens ». Deux equipes de
 * la meme ville, deux clubs a quatre lettres : la ressemblance de chaines ne
 * sait pas que ce sont des adversaires. Une seule de ces erreurs paie les
 * mauvaises personnes, et personne ne s'en apercoit — le score annonce est
 * plausible.
 *
 * Il n'y a donc AUCUN repli flou ici. Un nom se reconnait exactement apres
 * normalisation, ou par une correspondance ECRITE A LA MAIN dans `ALIAS`, ou
 * il ne se reconnait pas — et la rencontre repart vers The Odds API, puis vers
 * le reglement manuel. Ne rien rendre est toujours moins cher que rendre faux.
 */

const CHEMINS = {
  /* La clef est celle de The Odds API — c'est elle que porte `m.source.ligue`,
     donc le seul identifiant qu'une rencontre de chez nous transporte. */
  soccer_epl: 'soccer/eng.1',
  soccer_france_ligue_one: 'soccer/fra.1',
  soccer_spain_la_liga: 'soccer/esp.1',
  soccer_italy_serie_a: 'soccer/ita.1',
  soccer_germany_bundesliga: 'soccer/ger.1',
  soccer_uefa_champs_league: 'soccer/uefa.champions',
  basketball_nba: 'basketball/nba',
  americanfootball_nfl: 'football/nfl',
  /* ---- PLUS AUCUNE CLE CRICKET ICI (12/10/2026) ----
   * `cricket_international_t20` lisait 'cricket/8039' : c'est la Coupe du
   * monde ODI 2027, 0 rencontre avant 10/2027 (releve du 12/10). Les T20I et
   * ODI bilateraux ont un id PAR TOURNEE (24707, 24289) : aucun tableau fixe
   * ne couvre une cle cricket. Le cricket se lit dans l'EN-TETE d'ESPN, jour
   * par jour (`releveCricket`, plus bas) ; `releve` ne le lit jamais. */
  /* Les treize du 18 septembre 2026. Chacune a repondu depuis ce serveur ce
     jour-la, jour par jour — le tableau REFUSE une fenetre de dix jours
     (400, « Failed to get events endpoint ») ; depuis le 08/10 il refuse
     toute fenetre : `tableau` demande des jours ou des mois, voir `requetes`. */
  soccer_efl_champ: 'soccer/eng.2',
  soccer_france_ligue_two: 'soccer/fra.2',
  soccer_germany_bundesliga2: 'soccer/ger.2',
  soccer_spain_segunda_division: 'soccer/esp.2',
  soccer_italy_serie_b: 'soccer/ita.2',
  soccer_netherlands_eredivisie: 'soccer/ned.1',
  soccer_portugal_primeira_liga: 'soccer/por.1',
  soccer_belgium_first_div: 'soccer/bel.1',
  soccer_turkey_super_league: 'soccer/tur.1',
  soccer_usa_mls: 'soccer/usa.1',
  soccer_mexico_ligamx: 'soccer/mex.1',
  icehockey_nhl: 'hockey/nhl',
  baseball_mlb: 'baseball/mlb',
  /* ---- LES HUIT COUPES (lot 6, 11/10/2026) ----
   * Chacune a repondu HTTP 200 depuis ce depot le 11/10/2026 (mois 202610 et
   * 202611, `dates=AAAAMM&limit=1000`), deja verifiees le 09/10 par le plan.
   * Lues le 11/10 : Europa League 15, 22/10, 05 et 26/11 (18 rencontres
   * chacune), Conference League aux memes dates (18 chacune), Carabao Cup
   * 27-29/10 (8), DFB-Pokal 27-28/10 (16), Copa del Rey 03-04/10 (7 en
   * STATUS_FULL_TIME, 1 en STATUS_FINAL_PEN) et 11/10 (2) ; FA Cup, Coppa
   * Italia et Coupe de France : rien en octobre ni en novembre. Aucune
   * rencontre de coupe n'est au catalogue dans ce lot : ces chemins ne
   * servent qu'a l'appariement de l'inventaire (coupes.apparieEspn), qui
   * passe par `releve` — le MEME code que le reglement. */
  soccer_uefa_europa_league: 'soccer/uefa.europa',
  soccer_uefa_europa_conference_league: 'soccer/uefa.europa.conf',
  soccer_fa_cup: 'soccer/eng.fa',
  soccer_england_efl_cup: 'soccer/eng.league_cup',
  soccer_germany_dfb_pokal: 'soccer/ger.dfb_pokal',
  soccer_spain_copa_del_rey: 'soccer/esp.copa_del_rey',
  soccer_italy_coppa_italia: 'soccer/ita.coppa_italia',
  soccer_france_coupe_de_france: 'soccer/fra.coupe_de_france',
};

/* ---- LES ECARTS, ECRITS (quatorze au depart, puis ceux de chaque ligue ajoutee) ----
 * A gauche le nom normalise tel que The Odds API le donne, a droite celui
 * d'ESPN. Ils ont ete releves en comparant les deux calendriers, pas devines.
 * Une ligne de plus se constate de la meme facon : une rencontre qui ne se
 * regle pas toute seule et dont les deux noms sont, a l'oeil, la meme equipe. */
const ALIAS = {
  'atalanta bc': 'atalanta',
  'athletic bilbao': 'athletic',
  'auxerre': 'aj auxerre',
  'mainz 05': 'mainz',
  'hamburger': 'hamburg',
  'paderborn': 'paderborn 07',
  'real racing santander': 'racing santander',
  'union berlin': '1 union berlin',
  /* Le nom italien contre le nom courant. « Inter » seul aurait suffi et
     aurait ete dangereux : il est dans « Inter Miami » comme dans
     « Internazionale ». On ecrit les deux en entier. */
  'inter milan': 'internazionale',
  /* ESPN dit « Deportivo » tout court. Ce n'est PAS ambigu avec le Deportivo
     Alaves, qui reste « deportivo alaves » de son cote — c'est aussi pourquoi
     « deportivo » ne peut pas entrer dans la liste des mots de bruit. */
  'deportivo la coruna': 'deportivo',
  /* ---- LES ECARTS DES TREIZE LIGUES AJOUTEES, RELEVES LE 18 SEPTEMBRE 2026 ----
   * Meme methode : les deux calendriers cote a cote, ligue par ligue, et une
   * ligne par paire qui ne tombe pas juste. NHL et MLB : 62 clubs, zero ecart.
   * Championship : 24 clubs, zero ecart. Les autres sont ici. */
  // Ligue 2 (11/18 exacts)
  'dijon': 'dijon fco',
  'clermont': 'clermont foot',
  'rodez af': 'rodez aveyron',
  'nancy': 'nancy lorraine',
  'usl dunkerque': 'dunkerque',
  'stade lavallois': 'stade laval',
  'red star': 'red star 93',
  // 2. Bundesliga (15/18)
  'greuther furth': 'spvgg greuther furth',
  '1 kaiserslautern': 'kaiserslautern',
  '1 heidenheim': '1 heidenheim 1846',
  // Segunda (15/22)
  'real sociedad b': 'real sociedad ii',
  'cd castellon': 'castellon',
  'cd eldense': 'eldense',
  'sd eibar': 'eibar',
  'sabadell': 'cd sabadell',
  'oviedo': 'real oviedo',
  'ad ceuta': 'ceuta',
  // Serie B (19/20)
  'catanzaro 1929': 'catanzaro',
  // Eredivisie (14/18)
  'zwolle': 'pec zwolle',
  'ajax': 'ajax amsterdam',
  'feyenoord': 'feyenoord rotterdam',
  'twente enschede': 'twente',
  // Primeira Liga (14/18)
  'cs maritimo': 'maritimo',
  'nacional': 'c d nacional',
  'sporting lisbon': 'sporting cp',
  'vitoria': 'vitoria guimaraes',
  // Belgique (9/18)
  'gent': 'kaa gent',
  'leuven': 'oh leuven',
  'charleroi': 'royal charleroi',
  'royal antwerp': 'antwerp',
  'union saint gilloise': 'union st gilloise',
  'sint truiden': 'sint truidense',
  'westerlo': 'kvc westerlo',
  'genk': 'racing genk',
  'sk beveren': 'waasland beveren',
  // Turquie (11/18)
  'kasimpasa sk': 'kasimpasa',
  'torku konyaspor': 'konyaspor',
  'gazisehir gaziantep': 'gaziantep fk',
  'basaksehir': 'istanbul basaksehir',
  'genclerbirligi sk': 'genclerbirligi',
  'amed sk': 'amed sfk',
  'besiktas jk': 'besiktas',
  // MLS (28/30)
  'new york red bulls': 'red bull new york',
  'los angeles': 'lafc',
  // Liga MX (15/18)
  'tigres': 'tigres uanl',
  'pumas': 'pumas unam',
  'santos laguna': 'santos',
  /* ---- LIGUE DES CHAMPIONS (lot 7, 11/10/2026) : DEUX ADVERSAIRES DES CLUBS SUIVIS EN JEU ----
   * Releves cote a cote, la meme rencontre le meme jour : le calendrier public
   * du 09/10 (noms The Odds API, /paris/calendrier) dit « LASK - Liverpool » et
   * « Bodø/Glimt - Borussia Dortmund » le 14/10 a 16:45 et 19:00 UTC ; le
   * tableau uefa.champions d'ESPN du 14/10 (relu le 10/10) dit « LASK Linz »
   * et « Bodo/Glimt » aux memes heures, a domicile tous les deux. Sans ces
   * lignes, LASK - Liverpool n'etait pas appariee : ni reglee gratuitement, ni
   * observable en jeu (sceptique du 09/10). « ø » n'est pas un accent (NFKD ne
   * le decompose pas) : normalise rend « bod glimt ». « Viking FK » tombe juste. */
  'lask': 'lask linz',
  'bod glimt': 'bodo glimt',
  /* ---- LES COUPES (lot 6) : RELEVES SUR coupes_inventaire.json, JAMAIS DEVINES ----
   * Aucune ligne au 11/10/2026. Les noms The Odds API d'une coupe ne se lisent
   * qu'avec la cle (/events), que seul le serveur porte : l'inventaire
   * ($DATA_DIR/coupes_inventaire.json, `/paris/import` -> coupes, ou
   * `node paris_import.js --coupes`) ecrit chaque rencontre NON appariee avec
   * les noms qu'ESPN donne le meme jour. Une ligne s'ajoute ici, avec sa date
   * de releve, seulement quand les deux noms sont, a l'oeil, la meme equipe
   * le meme jour — comme les ligues du 18/09. Jamais par ressemblance : voir
   * l'en-tete (« Inter Milan » -> « AC Milan »). Une rencontre non appariee
   * part a /scores (2 credits par ligue) puis a la main ; la porte A
   * d'EXPLOITATION 8.11 (>= 95 % appariees) attend ces lignes. */
};

/* Les mots qui ne distinguent aucune equipe de sa voisine. « Deportivo » n'y
   est PAS : il distingue le Deportivo La Corogne du Deportivo Alaves, et le
   retirer confondrait les deux. */
const BRUIT = /\b(fc|afc|cf|sc|ac|as|ss|ssc|us|rc|sv|tsv|tsg|fsv|vfl|vfb|bsc|ca|calcio|club|de|the|1899)\b/g;

function normalise(nom) {
  return String(nom || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(BRUIT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Le meme nom, des deux cotes ? Exactement, ou par une ligne d'ALIAS. */
function meme(a, b) {
  const x = normalise(a), y = normalise(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return ALIAS[x] === y || ALIAS[y] === x;
}

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/* Une journee au format d'ESPN. On demande une FENETRE de deux jours autour de
   la rencontre : un match du soir en Europe tombe le lendemain en temps
   universel, et demander le seul jour du coup d'envoi le manquerait une fois
   sur trois. */
function jour(t) {
  const d = new Date(t);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0')
       + String(d.getUTCDate()).padStart(2, '0');
}

function mois(t) {
  const d = new Date(t);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/* ---- PLUS AUCUNE FENETRE : DES JOURS, OU DES MOIS (08/10/2026) ----
 *
 * ESPN refuse desormais TOUTE fenetre `dates=AAAAMMJJ-AAAAMMJJ`, meme d'un jour
 * sur lui-meme : 400 « Failed to get events endpoint. », 22 requetes sur 22 le
 * 08/10 (Liga, Premier League, NHL, NBA). Le 18/09, trois jours passaient
 * encore et dix etaient deja refuses. Un JOUR (AAAAMMJJ) et un MOIS (AAAAMM)
 * passent toujours, et rendent les memes rencontres (Liga du 19 et du 20/09,
 * relues des deux facons).
 *
 * Le 400 etait avale en liste vide, donc rien ne se voyait : le tableau LIVE
 * NOW restait vide, `finies` ne reglait plus rien gratuitement (sa fenetre
 * couvre jusqu'a trente jours : refusee des le 18/09) et les dates de reprise
 * des sports hors saison n'existaient plus.
 *
 * Jour par jour jusqu'a JOURS_MAX jours, mois par mois au-dela. Les poids
 * mesures le 08/10 decident de la frontiere : une journee de NHL pese 200 Ko,
 * un mois de MLB 7 Mo — le direct relit trois jours toutes les 45 s, il ne
 * doit jamais tirer un mois. Les requetes d'un jour se recouvrent (celle du
 * 08/10 rend aussi des rencontres datees du 09 en temps universel) : une
 * rencontre vue deux fois n'est gardee qu'une fois. */
const JOURS_MAX = 7;
/* Les statuts d'ESPN qui disent « fini a 90 minutes », et eux seuls (relu le
   08/10 sur la Liga, la C1 et la Coupe du Roi 2025). */
const FOOT_REGLEMENTAIRE = ['STATUS_FULL_TIME'];
function requetes(deb, fin) {
  const j0 = Date.parse(new Date(deb).toISOString().slice(0, 10) + 'T00:00:00Z');
  const jn = Date.parse(new Date(fin).toISOString().slice(0, 10) + 'T00:00:00Z');
  const n = Math.round((jn - j0) / 86400000) + 1;
  if (n <= JOURS_MAX) {
    const out = [];
    for (let i = 0; i < Math.max(1, n); i++) out.push(jour(j0 + i * 86400000));
    return out;
  }
  const out = [];
  for (let t = j0; mois(t) <= mois(jn); ) {
    out.push(mois(t) + '&limit=1000');
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

/* ---- UN REFUS SE COMPTE, ET SE DIT (08/10/2026) ----
 * Le 400 des fenetres de dates est reste invisible trois semaines : chaque
 * refus etait avale en liste vide, et une liste vide ressemble a une journee
 * sans match. On compte donc, par tableau et par jour (UTC), les requetes et
 * les refus (statut non-200, abandon a 8 s, reponse illisible), et l'on ecrit
 * une ligne au journal au PREMIER refus de chaque tableau et de chaque jour —
 * pas a chaque requete : le direct relit toutes les 45 s. */
const REFUS = new Map();
/* `nom` (12/10/2026) : le tableau, quand l'adresse n'en porte pas — l'en-tete
   du cricket (`cricket/entete`) n'a pas de `/scoreboard` dans son chemin. */
function compte(u, refus, pourquoi, nom) {
  const m = /sports\/(.+?)\/scoreboard/.exec(String(u));
  const tab = nom || (m ? m[1] : null);
  const cle = new Date().toISOString().slice(0, 10) + '|' + (tab || '?');
  const e = REFUS.get(cle) || { requetes: 0, refus: 0, dernier: '' };
  e.requetes++;
  if (refus) {
    if (!e.refus) console.log(`[espn] refus sur ${tab || u} : ${pourquoi} — ${String(u).split('?')[1] || ''}`);
    e.refus++; e.dernier = pourquoi;
  }
  REFUS.set(cle, e);
  if (REFUS.size > 400) REFUS.delete(REFUS.keys().next().value);
}
/** Les compteurs du jour (UTC) : { 'soccer/esp.1': { requetes, refus, dernier } }. */
function refusDuJour(jourIso) {
  const j = jourIso || new Date().toISOString().slice(0, 10);
  const out = {};
  for (const [cle, e] of REFUS) if (cle.startsWith(j + '|')) out[cle.slice(j.length + 1)] = Object.assign({}, e);
  return out;
}

/* ---- LES 403 ET 429, PAR TABLEAU, DEPUIS LE DEMARRAGE (relecture du 11/10/2026) ----
 * Le signe qu'ESPN limite. Le verrou du tennis (tennis_verrou.js) ajoute un
 * lecteur a 60 s, autant de requetes que la passe large du football : un 403
 * ou 429 PAR ADRESSE degraderait le second verrou du football (qui protege
 * l'argent vendu au marche) et le reglement gratuit — le risque qui a fait
 * ecarter un troisieme lecteur au lot 7 (server.js, directSuivies). Le tennis
 * lit donc ce compte, et recule des que N'IMPORTE QUEL tableau en prend un. */
const BLOCAGES = new Map();
/** { tableau: n } des 403/429 depuis le demarrage (ex. { 'soccer/esp.1': 1 }). */
function blocages() { return Object.fromEntries(BLOCAGES); }

/* `suivi` (facultatif, tennis du 11/10/2026) : ce que la requete a donne, pour
   un appelant qui doit distinguer « ESPN muet » d'« aucune rencontre » —
   { requetes, refus, illisibles, statuts: { 403: n }, dernier }. Sans lui, rien
   ne change : un refus rend une liste vide, comme avant. AVEC lui, une
   reponse sans `events` est aussi comptee comme un refus (illisible) : pour le
   verrou du tennis, une forme inattendue doit fermer, jamais ouvrir. */
async function uneRequete(u, prendre, suivi) {
  const f = prendre || fetch;
  const s = suivi && typeof suivi === 'object' ? suivi : null;
  const refuse = (pourquoi, statut) => {
    compte(u, true, pourquoi);
    if (statut === 403 || statut === 429) {
      const m = /sports\/(.+?)\/scoreboard/.exec(String(u));
      const k = m ? m[1] : '?';
      BLOCAGES.set(k, (BLOCAGES.get(k) || 0) + 1);
    }
    if (s) { s.refus = (s.refus || 0) + 1; s.dernier = pourquoi; if (statut !== undefined) { s.statuts = s.statuts || {}; s.statuts[statut] = (s.statuts[statut] || 0) + 1; } }
    return [];
  };
  if (s) s.requetes = (s.requetes || 0) + 1;
  /* Un tableau de scores n'est JAMAIS une raison de faire attendre le serveur.
     Huit secondes, puis on s'en passe : le calendrier vaut sans le direct, le
     direct ne vaut rien sans le calendrier. */
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const minuterie = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
  try {
    const rep = await f(u, ctl ? { signal: ctl.signal } : undefined);
    if (!rep || !rep.ok) return refuse('statut ' + ((rep && rep.status) || '?'), (rep && rep.status) || '?');
    const j = await rep.json();
    if (s && !Array.isArray(j && j.events)) { s.illisibles = (s.illisibles || 0) + 1; return refuse('reponse sans events'); }
    compte(u, false);
    return Array.isArray(j && j.events) ? j.events : [];
  } catch (e) {
    return refuse((e && e.name === 'AbortError') ? 'abandon a 8 s' : String((e && e.message) || e).slice(0, 80));
  } finally { if (minuterie) clearTimeout(minuterie); }
}

/* Une requete qui tombe n'emporte que sa journee (ou son mois) : on regle ce
   qu'on a vu, le reste repassera par The Odds API ou par la main, comme avant. */
async function tableau(chemin, deb, fin, prendre) {
  const lots = await Promise.all(requetes(deb, fin).map((q) =>
    uneRequete(`${BASE}/${chemin}/scoreboard?dates=${q}`, prendre)));
  const vus = new Set(), out = [];
  for (const ev of [].concat(...lots)) {
    const cle = ev && ev.id != null ? 'id:' + ev.id : JSON.stringify(ev);
    if (vus.has(cle)) continue;
    vus.add(cle); out.push(ev);
  }
  return out;
}

/* Ce qu'on retient d'un evenement ESPN : les deux camps NOMMES, leurs points,
   et l'etat. `state` vaut 'pre', 'in' ou 'post' — c'est lui qui dit si le
   score est un direct ou un resultat. */
function lis(ev) {
  const c = (ev && ev.competitions && ev.competitions[0]) || null;
  if (!c || !Array.isArray(c.competitors) || c.competitors.length !== 2) return null;
  /* ---- LE MONEYLINE DRAFTKINGS, PAR CAMP (lot 3, 10/10/2026) ----
   * `odds[0].moneyline.<home|away>.close.odds`, en cote americaine. Champ NON
   * documente par ESPN : observe le 09/10 sur 63 lots d'avant-match (NFL,
   * NHL, MLB), fournisseur « DraftKings » partout, `close` present partout et
   * qui bouge dans la journee (JAX -395 a 17:28 UTC, -380 a 23:47) ; absent
   * pendant le match. Lu sur le `homeAway` DU CAMP, jamais sur sa position :
   * releve oriente ensuite sur notre domicile comme le score. `close`
   * SEULEMENT, jamais `open` : ce sont des lignes d'anticipation (JAX +110 a
   * l'ouverture, -380 a la cloture) — sans `close`, pas de cote, et le lot le
   * dit (`dkSansClose`). Chaque lecture est dans un try/catch : un objet
   * odds bancal ne fait jamais perdre le score de la rencontre. */
  const o = Array.isArray(c.odds) ? c.odds[0] : null;
  let fournisseur = null, dkSansClose = false;
  try { fournisseur = (o && o.provider && o.provider.name) ? String(o.provider.name) : null; } catch (e) { fournisseur = null; }
  const ml = (x) => {
    try {
      const cote = o && o.moneyline && (x.homeAway === 'home' || x.homeAway === 'away') ? o.moneyline[x.homeAway] : null;
      if (!cote) return null;
      const v = cote.close && cote.close.odds;
      if (v === undefined || v === null || v === '') { dkSansClose = true; return null; }
      return americaine(v);
    } catch (e) { return null; }
  };
  const camp = (x) => ({
    nom: (x.team && (x.team.displayName || x.team.name)) || '',
    points: Number(x.score),
    ml: ml(x),
  });
  const a = camp(c.competitors[0]), b = camp(c.competitors[1]);
  if (!a.nom || !b.nom) return null;
  const st = (ev.status && ev.status.type) || {};
  /* ---- L'HORLOGE, LA PERIODE, LES BUTS ET LES ROUGES (lot 7, 11/10/2026) ----
   * Pour l'observation du direct en jeu (paris_en_jeu.js), rien d'autre :
   * `status.clock` (secondes de jeu, CUMULEES : 5400 a la fin de la 2e
   * periode), `status.period`, `status.displayClock`, et les faits de
   * `competitions[0].details[]` — `scoringPlay`, `redCard`, `clock.value`,
   * `team.id` rapproche de `competitors[].team.id`. Lus sur le vrai tableau
   * esp.1 du 09/10 (Espanyol at Malaga, STATUS_FULL_TIME, clock 5400 pour
   * « 90'+5' », period 2, 11 details) : un rouge reel et une horloge en cours
   * de jeu n'y figurent PAS (sceptique du 09/10) — l'observation les verra.
   * Une seance de tirs au but (`shootout`) n'est pas un but. Chaque lecture
   * est dans un try : un `details` bancal ne fait jamais perdre le score. */
  let horloge = null, periode = null, affiche = '', evenements = [];
  try {
    const s0 = ev.status || {};
    const h = Number(s0.clock), p = Number(s0.period);
    if (s0.clock !== undefined && s0.clock !== null && s0.clock !== '' && isFinite(h)) horloge = h;
    if (s0.period !== undefined && s0.period !== null && s0.period !== '' && isFinite(p)) periode = p;
    affiche = s0.displayClock ? String(s0.displayClock).slice(0, 20) : '';
  } catch (e) { horloge = null; periode = null; affiche = ''; }
  try { evenements = faitsDe(c); } catch (e) { evenements = []; }
  /* `statut` : le nom exact (STATUS_FULL_TIME, STATUS_FINAL_AET,
     STATUS_FINAL_PEN...). `fini` ne distingue pas un match regle a 90 minutes
     d'un match prolonge, et le score rendu compte la prolongation. */
  return { a, b, quand: Date.parse(ev.date) || 0,
           etat: st.state || 'pre', fini: !!st.completed, statut: String(st.name || ''),
           detail: st.shortDetail || st.detail || st.description || '',
           fournisseur, dkSansClose, horloge, periode, affiche, evenements };
}
/* Les buts et les rouges d'une rencontre, sur les camps du TABLEAU (`a` = le
   premier competiteur, `b` le second) : { camp, but, rouge, clock }. Un fait
   d'une equipe inconnue garde camp null. */
function faitsDe(c) {
  const ids = c.competitors.map((x) => (x && x.team && x.team.id !== undefined && x.team.id !== null) ? String(x.team.id) : null);
  const out = [];
  for (const d of Array.isArray(c.details) ? c.details : []) {
    try {
      if (!d || typeof d !== 'object') continue;
      const but = d.scoringPlay === true && d.shootout !== true;
      const rouge = d.redCard === true;
      if (!but && !rouge) continue;
      const tid = d.team && d.team.id !== undefined && d.team.id !== null ? String(d.team.id) : null;
      const camp = tid !== null && tid === ids[0] ? 'a' : tid !== null && tid === ids[1] ? 'b' : null;
      const v = Number(d.clock && d.clock.value);
      out.push({ camp, but, rouge, clock: d.clock && d.clock.value !== null && d.clock.value !== undefined && isFinite(v) ? v : null });
    } catch (e) { /* un fait illisible est saute, pas la rencontre */ }
  }
  return out;
}
/** Une cote americaine (« -142 », « +120 ») en cote decimale, ou null. */
function americaine(s) {
  const txt = String(s === undefined || s === null ? '' : s).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(txt)) return null;
  const v = Number(txt);
  /* au moins 100 en valeur absolue ; « EVEN » (+100) n'a jamais ete vu dans
     les 63 lots du 09/10 et n'est pas devine */
  if (!isFinite(v) || Math.abs(v) < 100) return null;
  return v > 0 ? 1 + v / 100 : 1 + 100 / -v;
}

/*
 * LA RELEVE.
 *
 * `matchs` sont les NOTRES — ceux du catalogue, avec leur `source.ligue`. On
 * ne demande a ESPN que les ligues qui en portent, et l'on ne rend que ce
 * qu'on a pu apparier sans le moindre doute.
 *
 * Rendu : une Map de l'identifiant de NOTRE rencontre vers
 *   { score:'2-1', resultat:'1'|'N'|'2', fini, etat, detail, dom, ext }
 * `score` est toujours dans NOTRE orientation — domicile d'abord — et il est
 * lu sur le camp qui porte le nom de notre equipe a domicile, jamais sur la
 * position dans le tableau. Deux sources peuvent ne pas ranger le meme camp en
 * premier, et un score inverse paie exactement les mauvaises personnes.
 */
async function releve(matchs, opts) {
  const o = opts || {};
  const t = o.maintenant || Date.now();
  const out = new Map();
  const parLigue = new Map();
  for (const m of matchs || []) {
    const l = m && m.source && m.source.ligue;
    if (!l || !CHEMINS[l]) continue;
    /* ---- LE CRICKET NE PASSE JAMAIS PAR ICI (12/10/2026) ----
     * `lis` lit un score de cricket « 215/3 » en NaN (rien), mais un abandon
     * ou un report en « 0-0 » et 'N' : `Number('')` vaut 0. Seul `!s.fini`
     * arretait ce faux nul dans `finies` — et `fini` ne doit pas devenir
     * `state === 'post'` (abandon, sans resultat et « Final » sans donnees
     * sont « post »). Meme si une cle cricket revenait dans CHEMINS, elle
     * resterait hors d'ici : le cricket se lit par `releveCricket`. */
    if (estCricket(m)) continue;
    if (!parLigue.has(l)) parLigue.set(l, []);
    parLigue.get(l).push(m);
  }
  for (const [ligue, lot] of parLigue) {
    const debuts = lot.map((m) => m.debut).filter((x) => isFinite(x));
    if (!debuts.length) continue;
    /* ---- LA MARGE AUTOUR DES COUPS D'ENVOI (lot 7, 11/10/2026) ----
     * Un jour de chaque cote par defaut (tous les appelants d'avant). Le
     * direct en jeu passe 6 h : UN jour pour un coup d'envoi de midi, DEUX
     * pour un coup d'envoi du soir (18:45 UTC demande aussi le lendemain,
     * `requetes`), au lieu de trois. Une marge illisible garde le defaut. */
    const marge = typeof o.marge === 'number' && isFinite(o.marge) && o.marge >= 0 ? o.marge : 86400000;
    const evs = await tableau(CHEMINS[ligue],
                              Math.min(...debuts) - marge,
                              Math.max(...debuts) + marge, o.prendre);
    /* Un evenement qui fait lever `lis` n'emporte que lui (lot 7) : avant, il
       emportait tout le championnat de la releve. */
    const lus = evs.map((ev) => { try { return lis(ev); } catch (e) { return null; } }).filter(Boolean);
    for (const m of lot) {
      /* La MEME rencontre, c'est les deux memes noms ET la meme journee.
         Deux clubs se rencontrent deux fois par saison : sans la date, on
         reglerait le match aller avec le score du retour. Trente-six heures
         de tolerance — un report de quelques heures reste la meme
         rencontre, un match aller-retour en est a des mois.
         ---- ET LA PLUS PROCHE, PAS LA PREMIERE (08/10/2026) ----
         En MLB et en NHL, les memes equipes jouent des jours CONSECUTIFS
         (series, playoffs MLB en ce moment) : le match 1 est a 24 h du match
         2, dans la tolerance. On prenait le premier venu dans l'ordre d'ESPN,
         donc le match 1 — et le match 2 du catalogue se serait regle avec le
         score de la veille, puis ferme des la veille par le second verrou.
         On garde donc le candidat le plus proche de notre heure, et si les
         deux plus proches se jouent a moins de deux heures l'un de l'autre (un
         programme double mal date), on n'apparie PAS : la rencontre part a la
         main. Ne rien rendre coute moins cher que rendre faux.
         Hors football et tennis, la tolerance tombe a DOUZE heures : si la
         journee du match 2 ne repond pas (503, abandon a 8 s), le match 1
         restait seul candidat a 24 h, donc « le plus proche », et se reglait
         a sa place (relecture du 08/10). Une heure ESPN « a fixer » (04:00Z
         en MLB) reste a moins de 12 h de la notre. */
      const tolerance = (m.sport === 'foot' || m.sport === 'tennis') ? 36 * 3600000 : 12 * 3600000;
      const cands = [];
      for (const e of lus) {
        const d = Math.abs(e.quand - m.debut);
        if (d > tolerance) continue;
        if (meme(m.domicile, e.a.nom) && meme(m.exterieur, e.b.nom)) cands.push({ d, e, dom: e.a, ext: e.b });
        else if (meme(m.domicile, e.b.nom) && meme(m.exterieur, e.a.nom)) cands.push({ d, e, dom: e.b, ext: e.a });
      }
      if (!cands.length) continue;
      cands.sort((x, y) => x.d - y.d);
      if (cands.length > 1 && Math.abs(cands[1].e.quand - cands[0].e.quand) < 2 * 3600000) continue;
      const { e, dom, ext } = cands[0];
      const su = { fini: e.fini, etat: e.etat, detail: e.detail, statut: e.statut, quand: e.quand,
                   dom: m.domicile, ext: m.exterieur };
      /* L'horloge et les faits dans NOTRE orientation (lot 7, football seul) :
         `rouges` = [domicile, exterieur], `evenements` = [[camp, 'b'|'r',
         clock]] avec camp 'd' (domicile) ou 'x' (exterieur), lus sur le camp
         qui porte le nom de notre domicile — jamais sur la position. */
      if (m.sport === 'foot') {
        su.horloge = e.horloge; su.periode = e.periode; su.affiche = e.affiche;
        const nous = (camp) => (camp === null ? null : ((camp === 'a') === (dom === e.a) ? 'd' : 'x'));
        su.evenements = [];
        su.rouges = [0, 0];
        for (const f of e.evenements || []) {
          const k = nous(f.camp);
          if (f.but) su.evenements.push([k, 'b', f.clock]);
          if (f.rouge) { su.evenements.push([k, 'r', f.clock]); if (k === 'd') su.rouges[0]++; else if (k === 'x') su.rouges[1]++; }
        }
      }
      if (isFinite(dom.points) && isFinite(ext.points)) {
        su.score = `${dom.points}-${ext.points}`;
        su.resultat = dom.points > ext.points ? '1'
                    : ext.points > dom.points ? '2' : 'N';
      }
      /* Le moneyline DraftKings dans NOTRE orientation (lot 3) : la cote du
         camp qui porte le nom de notre domicile. Jamais au football (trois
         issues, sa mesure est faite) ; seulement les deux cotes lues. Le
         carnet d'observation (prix_observe.noteDk) le relit ; rien d'autre. */
      if (m.sport !== 'foot') {
        if (dom.ml > 1 && ext.ml > 1) su.dk = { 1: dom.ml, 2: ext.ml, fournisseur: e.fournisseur };
        else if (e.dkSansClose) su.dkSansClose = true;
      }
      out.set(m.id, su);
    }
  }
  return out;
}

/*
 * ==================== LE TENNIS ====================
 *
 * Le tableau de scores d'ESPN ne rendait que des TOURNOIS pour le tennis, sans
 * les rencontres — c'etait exact au 18/09/2026 ; depuis (releve du 11/10), il
 * les porte, et le verrou d'heure reelle le lit (`releveTennisTableau`, apres
 * cette fonction). Le REGLEMENT reste ici, sur l'API INTERNE, qui les porte
 * aussi : un tournoi y arrive avec ses trois cent
 * vingt-trois rencontres, chacune avec ses deux joueurs NOMMES et un
 * `winner` — donc le resultat, sans une requete de plus.
 *
 * Pourquoi ca compte plus que le reste : le tennis est notre plus gros sport,
 * quatre-vingt-treize rencontres contre quarante-huit au football. Et surtout,
 * cette source-la n'a PAS de fenetre. `/scores` de The Odds API ne remonte pas
 * au-dela de trois jours : une rencontre ratee pendant ces trois jours ne se
 * reglait plus JAMAIS toute seule. Ici on demande une date, et une date de la
 * semaine derniere se demande aussi bien qu'aujourd'hui.
 *
 * ---- LE COUT EN REQUETES ----
 *
 * Un index par tour et par journee, puis un appel par tournoi — les tournois
 * se repetent d'un jour a l'autre, on ne les reprend pas. Mesure sur le
 * calendrier reel : sept requetes pour huit cent vingt-quatre rencontres.
 * C'est gratuit, mais ce n'est pas une raison pour etre grossier.
 *
 * ---- LES NOMS ----
 *
 * Mesure sur les cent quatre-vingt-six joueurs du calendrier : cent
 * soixante-dix-sept tombent juste, soit 95 %. Les neuf autres sont des ordres
 * de nom inverses ou des suffixes (« Shuai Zhang » contre « Zhang Shuai »,
 * « Martin Damm Jr. »). Ils ne sont PAS rattrapes par ressemblance, pour la
 * meme raison qu'au football : un joueur qui ressemble a un autre est un
 * adversaire, pas la meme personne. Ils repartent vers The Odds API, puis vers
 * le reglement a la main.
 */
const CORE = 'http://sports.core.api.espn.com/v2/sports/tennis/leagues';

/* Le tour, lu sur la ligue de The Odds API : `tennis_atp_us_open` -> `atp`. */
function tourDe(ligue) {
  const m = /^tennis_(atp|wta)_/.exec(String(ligue || ''));
  return m ? m[1] : null;
}

async function json(u, prendre) {
  const f = prendre || fetch;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const minuterie = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
  try {
    const rep = await f(u, ctl ? { signal: ctl.signal } : undefined);
    if (!rep || !rep.ok) return null;
    return await rep.json();
  } catch (e) { return null; }
  finally { if (minuterie) clearTimeout(minuterie); }
}

/*
 * Les rencontres de tennis d'un lot, appariees et tranchees.
 *
 * On ne rend QUE ce qui est fini et sans ambiguite. Une rencontre en cours n'a
 * pas de `winner` : elle sort d'ici sans resultat, ce qui est exact.
 */
async function releveTennis(matchs, opts) {
  const o = opts || {};
  const out = new Map();
  const parTourJour = new Map();
  for (const m of matchs || []) {
    const tour = tourDe(m && m.source && m.source.ligue);
    if (!tour || !isFinite(m.debut)) continue;
    const k = tour + '|' + jour(m.debut);
    if (!parTourJour.has(k)) parTourJour.set(k, []);
    parTourJour.get(k).push(m);
  }
  if (!parTourJour.size) return out;

  /* Les tournois, une seule fois chacun : le meme tournoi couvre quinze jours
     et reviendrait a chaque journee demandee. */
  const tournois = new Map();
  for (const [k] of parTourJour) {
    const [tour, j] = k.split('|');
    const idx = await json(`${CORE}/${tour}/events?dates=${j}&limit=25`, o.prendre);
    for (const it of (idx && idx.items) || []) {
      const ref = it && it.$ref;
      if (!ref || tournois.has(ref)) continue;
      tournois.set(ref, await json(ref, o.prendre));
    }
  }

  const rencontres = [];
  for (const ev of tournois.values()) {
    for (const c of (ev && ev.competitions) || []) {
      const j2 = (c.competitors || []).filter((x) => x && x.name);
      if (j2.length !== 2) continue;
      rencontres.push({ quand: Date.parse(c.date) || 0, a: j2[0], b: j2[1] });
    }
  }

  for (const m of matchs || []) {
    if (!tourDe(m && m.source && m.source.ligue)) continue;
    for (const r of rencontres) {
      if (Math.abs(r.quand - m.debut) > 36 * 3600000) continue;
      let dom, ext;
      if (meme(m.domicile, r.a.name) && meme(m.exterieur, r.b.name)) { dom = r.a; ext = r.b; }
      else if (meme(m.domicile, r.b.name) && meme(m.exterieur, r.a.name)) { dom = r.b; ext = r.a; }
      else continue;
      /* `winner` est un booleen SUR CHAQUE camp. Tant que la rencontre n'est
         pas finie, aucun des deux ne le porte — et l'on ne tranche pas. */
      const fini = dom.winner === true || ext.winner === true;
      out.set(m.id, { fini, etat: fini ? 'post' : 'in',
                      detail: fini ? 'Final' : '',
                      dom: m.domicile, ext: m.exterieur,
                      resultat: fini ? (dom.winner === true ? '1' : '2') : null });
      break;
    }
  }
  return out;
}

/*
 * ========== LE TENNIS AU TABLEAU PUBLIC : LE VERROU D'HEURE REELLE (11/10/2026) ==========
 *
 * ---- pourquoi ----
 * Le tennis ne se vend pas au prix du marche sans second verrou de fermeture
 * (prix_ligues.venteImpossible, decision du 09/10/2026) : l'heure annoncee d'un
 * match de tennis est approximative — les matchs s'enchainent sur un court —
 * et sans signal « commence » un parieur parierait sur un match deja en cours
 * au prix d'avant-match. Ce bloc lit ce signal ; tennis_verrou.js decide quand
 * le lire et ce qu'on en fait (eteint par defaut).
 *
 * ---- ce que le tableau rend (releve du 11/10/2026, copies reduites dans tennis_verrou.test.js) ----
 *  - `events[]` = les TOURNOIS ; chaque rencontre dans
 *    `events[].groupings[].competitions[]` (et `events[].competitions[]` est lu
 *    aussi : un tournoi qui les porterait a plat n'est pas perdu), avec
 *    `date`, `timeValid`, `status.type.state` (pre/in/post), `type.slug`
 *    (mens-singles, womens-doubles…) et `competitors[].athlete.displayName` ;
 *  - un tournoi MIXTE (China Open) est sur les DEUX tableaux, hommes et femmes :
 *    le circuit se lit donc sur le SIMPLE (`mens-singles` pour atp,
 *    `womens-singles` pour wta), jamais sur le tableau seul — et un double
 *    n'est jamais une rencontre de The Odds API ;
 *  - `timeValid: false` : 151 simples sur 151 a 04:00Z (copies du 11/10) —
 *    minuit a New York du jour LOCAL du tournoi (Wuhan, Chine : catalogue
 *    02:00Z le 13/10, ESPN 2026-10-13T04:00Z, cinq rencontres). C'est une
 *    DATE, pas une heure : elle sert a l'appariement, jamais au verrou ;
 *  - `dates=AAAAMMJJ` rend les tournois en cours ce jour-la, chacun AVEC TOUTES
 *    ses rencontres (Shanghai : 131 simples, avec ou sans `dates`). Une
 *    requete par jour et par circuit, comme les autres tableaux (`uneRequete` :
 *    abandon a 8 s, refus comptes par tableau). Poids releve le 11/10/2026 a
 *    17:15Z (en-tetes `content-length`, gzip) : une journee A VENIR ~36 Ko
 *    (atp 35 916, wta 36 738 octets) ; la journee EN COURS rend le tableau
 *    entier, tournois qui finissent compris : atp 81 961 et wta 104 345 octets
 *    (~0,9 et ~1,3 Mo de JSON). Une passe a trois journees par circuit pese
 *    donc ~330 Ko : a 60 s (verrou `actif`), ~8 640 requetes et ~480 Mo par
 *    jour — autant de requetes que la passe large du football (~80 par quart
 *    d'heure, server.js). D'ou le recul du tennis sur un 403/429 de N'IMPORTE
 *    QUEL tableau (`blocages`, plus haut ; tennis_verrou.js).
 */
const CHEMINS_TENNIS = Object.freeze({ atp: 'tennis/atp', wta: 'tennis/wta' });
const SIMPLE_DU_TOUR = Object.freeze({ atp: 'mens-singles', wta: 'womens-singles' });

/* ---- LES JOURS DEMANDES ----
 * ESPN range un tournoi sous des journees de New York (`date` a 04:00Z,
 * `endDate` a 03:59Z le lendemain de la finale). Une rencontre est donc sous le
 * jour de New York de son heure (UTC - 4 ou 5 h) ou sous son jour LOCAL (le
 * jour UTC pour l'Asie et l'Europe — Wuhan ci-dessus). On demande les deux :
 * jour(debut) et jour(debut - 6 h). La passe ne suit que les rencontres de
 * [-6 h ; +36 h] autour de maintenant (tennis_verrou : HORIZON_MS devant,
 * APRES_MS derriere, pour la mesure seule) : les jours demandes couvrent donc
 * au plus [maintenant - 12 h ; maintenant + 36 h], 48 h, soit TROIS journees
 * UTC au plus (il en faudrait plus de 48 h pour en toucher quatre). Exemple :
 * 01:00Z le 11 -> le 10, le 11, le 12 (verifie heure par heure dans
 * tennis_verrou.test.js). TENNIS_JOURS_MAX = 4 n'est qu'un plafond de garde,
 * jamais atteint par la passe ; s'il l'etait, les journees les plus lointaines
 * tomberaient (leurs rencontres non appariees : fermees, jamais ouvertes). */
const TENNIS_JOURS_MAX = 4;
function joursTennis(debuts) {
  const s = new Set();
  for (const d of debuts || []) {
    if (!isFinite(d)) continue;
    s.add(jour(d)); s.add(jour(d - 6 * 3600000));
  }
  return [...s].sort().slice(0, TENNIS_JOURS_MAX);
}

/* ---- LES NOMS DES JOUEURS ----
 * Sans les mots de bruit du football (BRUIT retire « de », « as »… : « Alex de
 * Minaur »). Accents par NFKD ; les lettres que NFKD ne decompose pas (ł, ø, đ,
 * æ, ß…) par une table FIXE de translitteration — ecrite, pas devinee. */
const TRANSLIT = { 'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'Th',
                   'æ': 'ae', 'Æ': 'Ae', 'œ': 'oe', 'Œ': 'Oe', 'ß': 'ss', 'ı': 'i' };
function normaliseJoueur(nom) {
  return String(nom || '')
    .replace(/[łŁøØđĐðÐþÞæÆœŒßı]/g, (c) => TRANSLIT[c] || c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
/* ---- LES ALIAS DU TENNIS : RELEVES, JAMAIS DEVINES ----
 * A gauche le nom normalise que donne The Odds API, a droite celui d'ESPN.
 * AUCUNE ligne au 11/10/2026 : les 11 rencontres de tennis ouvertes du
 * calendrier public (16:09 UTC, WTA Wuhan 9, ATP Shanghai 2) s'apparient
 * toutes sur les tableaux du meme instant, l'ordre inverse (« Qinwen Zheng »
 * contre « Zheng Qinwen ») compris. Une ligne s'ajoute ici, avec sa date,
 * seulement depuis `/paris/import` -> `tennis.passe.nonAppariees` (les noms
 * ESPN du meme jour qui partagent un joueur), quand les deux noms sont, a
 * l'oeil, la meme personne le meme jour. Jamais par ressemblance : « Wang
 * Xinyu » et « Wang Xiyu » sont deux joueuses, et elles se rencontraient a
 * Wuhan le 12/10 (rencontre ESPN 185334). */
const ALIAS_TENNIS = Object.freeze({});
const aliasTennis = (s) => (Object.prototype.hasOwnProperty.call(ALIAS_TENNIS, s) ? ALIAS_TENNIS[s] : null);
/* Les memes jetons, dans n'importe quel ordre (« Zheng Qinwen » = « Qinwen
   Zheng ») ; ou des INITIALES d'un cote (« C. Ruud » = « Casper Ruud ») : chaque
   jeton complet du nom court se retrouve tel quel dans le long, et les jetons
   restants du long sont exactement autant que les initiales, chacun commencant
   par l'une d'elles. Rien d'autre : un prenom manquant (« Joelle Steur » contre
   « Joelle Lilly Sophie Steur ») ne s'apparie pas — il passe par ALIAS_TENNIS. */
function parInitiales(court, long) {
  const ini = court.filter((x) => x.length === 1), pleins = court.filter((x) => x.length > 1);
  /* au moins un jeton complet (le nom) : une initiale seule ne vaut personne */
  if (!ini.length || !pleins.length) return false;
  const reste = long.slice();
  for (const p of pleins) { const i = reste.indexOf(p); if (i < 0) return false; reste.splice(i, 1); }
  /* autant de jetons restants que d'initiales, chacun par sa lettre (memes chaines triees) */
  return ini.slice().sort().join('') === reste.map((x) => x[0]).sort().join('');
}
function memesJetons(x, y) {
  if (!x.length || !y.length) return false;
  if (x.slice().sort().join(' ') === y.slice().sort().join(' ')) return true;
  return parInitiales(x, y) || parInitiales(y, x);
}
/** Le meme joueur, des deux cotes ? Memes jetons (ordre libre), initiales, ou une ligne d'ALIAS_TENNIS. */
function memeJoueur(a, b) {
  const x = normaliseJoueur(a), y = normaliseJoueur(b);
  if (!x || !y) return false;
  const vx = [x, aliasTennis(x)].filter(Boolean), vy = [y, aliasTennis(y)].filter(Boolean);
  for (const p of vx) for (const q of vy) if (memesJetons(p.split(' '), q.split(' '))) return true;
  return false;
}

/* Les jeux deja joues : la somme des `linescores[].value` des deux joueurs
   (jeux gagnes par manche), null s'il n'y en a aucun. Une rencontre « pre »
   n'en porte jamais (copies du 11/10/2026, ci-dessous) ; au premier « in »
   vu, c'est ce que la porte T3 lit (un jeu deja joue = ESPN en retard d'un jeu
   au moins). */
function jeuxJoues(competitors) {
  let n = null;
  for (const x of competitors || []) {
    for (const l of (x && Array.isArray(x.linescores)) ? x.linescores : []) {
      const v = l && typeof l.value === 'number' ? l.value : NaN;
      if (isFinite(v) && v >= 0) n = (n || 0) + v;
    }
  }
  return n;
}
/* Une rencontre de tennis du tableau : les deux joueurs NOMMES (un « TBD »
   n'est personne), le simple, l'etat, la date et si elle est une heure. Un
   etat qui n'est pas pre/in/post reste '' : jamais lu comme « pas commence ».
   ---- « pre » SEULEMENT QUAND RIEN NE DIT LE CONTRAIRE (relecture du 11/10/2026) ----
   `status.type.state` seul ne suffit pas : une rencontre interrompue (pluie)
   ou retardee pourrait revenir « pre » sous un autre statut, avec un score —
   et un redemarrage efface le « in » deja vu (HEURES_REELLES est en memoire) :
   elle se serait rouverte au prix d'avant-match. « pre » n'est donc lu que
   sous `STATUS_SCHEDULED`, sans aucun jeu au tableau (`linescores`) et sans
   `wasSuspended` ; sinon l'etat est '' — FERME pour le tennis vendu, sans
   effet sur l'Elo (paris.ouvert). Mesure : 13 copies des deux tableaux, prises
   a 16:04, 16:09, 17:15 et 17:19 UTC le 11/10, 1 585 lignes « pre » (258
   rencontres distinctes, dont 183 simples) : TOUTES sous STATUS_SCHEDULED,
   0 linescore, 0 wasSuspended — la regle ne ferme rien de ce qu'on a vu.
   `gagnant` : 'a' ou 'b' quand un seul joueur porte `winner: true` (a la fin),
   sinon null. */
function lisTennis(c, slugGroupe) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.competitors) || c.competitors.length !== 2) return null;
  const nom = (x) => {
    const a = x && x.athlete;
    const n = a && (a.displayName || a.fullName);
    return n ? String(n).trim() : '';
  };
  const a = nom(c.competitors[0]), b = nom(c.competitors[1]);
  if (!a || !b || /^tbd$/i.test(a) || /^tbd$/i.test(b)) return null;
  const st = (c.status && c.status.type) || {};
  const jeux = jeuxJoues(c.competitors);
  let etat = ['pre', 'in', 'post'].indexOf(st.state) >= 0 ? st.state : '';
  if (etat === 'pre' && (st.name !== 'STATUS_SCHEDULED' || c.wasSuspended === true || jeux !== null)) etat = '';
  const wa = c.competitors[0] && c.competitors[0].winner === true, wb = c.competitors[1] && c.competitors[1].winner === true;
  const quand = Date.parse(c.date);
  return { id: c.id !== undefined && c.id !== null ? String(c.id) : null,
           simple: String((c.type && c.type.slug) || slugGroupe || ''),
           a, b, quand: isFinite(quand) ? quand : 0, heureValide: c.timeValid === true && isFinite(quand),
           etat, statut: String(st.name || ''), detail: String(st.shortDetail || st.detail || ''),
           jeux, gagnant: wa && !wb ? 'a' : wb && !wa ? 'b' : null };
}
/* Le rang d'un etat : quand deux journees rendent la meme rencontre, la plus
   avancee gagne (un etat inconnu passe devant « pre ») — fermer, jamais ouvrir. */
const RANG_ETAT = { pre: 0, '': 1, in: 2, post: 3 };
/** Les simples du circuit `tour` (atp|wta) dans une liste de tournois, une fois chacun. */
function rencontresTennis(evs, tour) {
  const simple = SIMPLE_DU_TOUR[tour];
  const parCle = new Map();
  const prend = (c, slug, tournoi) => {
    let r = null;
    try { r = lisTennis(c, slug); } catch (e) { r = null; }
    if (!r || !simple || r.simple !== simple) return;
    r.tournoi = tournoi;
    const k = r.id !== null ? 'id:' + r.id : r.a + '|' + r.b + '|' + r.quand;
    const deja = parCle.get(k);
    if (!deja || RANG_ETAT[r.etat] > RANG_ETAT[deja.etat]) parCle.set(k, r);
  };
  for (const ev of Array.isArray(evs) ? evs : []) {
    try {
      const tournoi = String((ev && (ev.name || ev.shortName)) || '');
      for (const g of Array.isArray(ev && ev.groupings) ? ev.groupings : []) {
        const slug = g && g.grouping && g.grouping.slug;
        for (const c of Array.isArray(g && g.competitions) ? g.competitions : []) prend(c, slug, tournoi);
      }
      for (const c of Array.isArray(ev && ev.competitions) ? ev.competitions : []) prend(c, null, tournoi);
    } catch (e) { /* un tournoi illisible n'emporte que lui */ }
  }
  return [...parCle.values()];
}

/* ---- LE MEME JOUR ----
 * Heure valide : a 12 h pres. Mesure du 11/10/2026 sur Wuhan le 12/10, catalogue
 * contre ESPN : 0, 20, 40 et 40 min d'ecart ; 12 h est la tolerance de ce
 * fichier hors football et tennis, et un programme decale de plus d'une
 * demi-journee change de jour. Date seule (`timeValid: false`, minuit a New
 * York du jour local) : notre heure de [-8 h ; +30 h] autour d'elle — heure
 * locale de 10:00 a 01:00 le lendemain, decalage de UTC-7 (Indian Wells) a
 * UTC+11 (Melbourne), minuit de New York a 04:00Z ou 05:00Z, plus 2 h pour une
 * heure du catalogue elle-meme approximative. Wuhan, 13/10 : -2 h. Au-dela,
 * un autre jour : jamais apparie. */
const TENNIS_HEURE_MS = 12 * 3600000;
const TENNIS_DATE_AVANT_MS = 8 * 3600000, TENNIS_DATE_APRES_MS = 30 * 3600000;
function memeJourTennis(debut, r) {
  if (!isFinite(debut) || !r || !(r.quand > 0)) return false;
  const d = debut - r.quand;
  return r.heureValide ? Math.abs(d) <= TENNIS_HEURE_MS
                       : (d >= -TENNIS_DATE_AVANT_MS && d <= TENNIS_DATE_APRES_MS);
}
/**
 * Une rencontre de NOTRE catalogue contre les simples du tableau : les deux
 * joueurs, dans n'importe quel ordre, le meme jour. Un SEUL candidat, ou rien :
 * deux candidats (homonymes, initiales qui couvrent deux joueuses), ou une
 * rencontre qui s'apparie dans les deux sens, c'est `ambigu` — pas
 * d'appariement. Rend null, { ambigu, n } ou { r }.
 */
function apparieTennis(m, rencontres) {
  const cands = [];
  for (const r of rencontres || []) {
    if (!memeJourTennis(m.debut, r)) continue;
    const droit = memeJoueur(m.domicile, r.a) && memeJoueur(m.exterieur, r.b);
    const croise = memeJoueur(m.domicile, r.b) && memeJoueur(m.exterieur, r.a);
    if (droit && croise) return { ambigu: true, n: cands.length + 1 };
    if (droit || croise) cands.push(r);
  }
  if (!cands.length) return null;
  if (cands.length > 1) return { ambigu: true, n: cands.length };
  return { r: cands[0] };
}

/**
 * LA RELEVE DU VERROU. `matchs` : les rencontres de tennis du catalogue (cle
 * tennis_atp_* / tennis_wta_*). Pour chaque circuit, les journees utiles,
 * chacune une requete. Rendu :
 *   par        : Map id -> { quand (heure ESPN si elle est valide, sinon 0),
 *                etat, heureValide, dateEspn, statut, detail, espn, tournoi,
 *                jeux (deja joues, ou null), vainqueur ('1' notre domicile,
 *                '2' notre exterieur, null tant que rien n'est fini) }
 *                pour les SEULES rencontres appariees sans doute ;
 *   rencontres : une ligne par rencontre du lot : resultat 'apparie' |
 *                'ambigu' | 'sans' | 'panne', et pour 'sans' les rencontres
 *                ESPN du meme jour qui partagent un joueur (`proches`, pour
 *                relever un alias a l'oeil) ;
 *   tours      : par circuit, { jours, requetes, refus, illisibles, statuts, dernier, lues }.
 * ECHOUE FERME : une seule journee refusee (statut, abandon a 8 s, reponse
 * sans `events`) et TOUT le circuit est 'panne' pour cette passe — aucun
 * appariement : un candidat manquant ferait passer pour unique celui qui
 * reste.
 */
async function releveTennisTableau(matchs, opts) {
  const o = opts || {};
  const par = new Map(), lignes = [], tours = {};
  const parTour = { atp: [], wta: [] };
  for (const m of matchs || []) {
    const tour = tourDe(m && m.source && m.source.ligue);
    if (!tour || !isFinite(m.debut)) continue;
    parTour[tour].push(m);
  }
  for (const tour of ['atp', 'wta']) {
    const lot = parTour[tour];
    if (!lot.length) continue;
    const s = { jours: joursTennis(lot.map((m) => m.debut)), requetes: 0, refus: 0, illisibles: 0, statuts: {}, dernier: null, lues: 0 };
    tours[tour] = s;
    const lots = await Promise.all(s.jours.map((j) =>
      uneRequete(`${BASE}/${CHEMINS_TENNIS[tour]}/scoreboard?dates=${j}`, o.prendre, s)));
    const lus = s.refus ? [] : rencontresTennis([].concat(...lots), tour);
    s.lues = lus.length;
    for (const m of lot) {
      const l = { id: m.id, ligue: m.source.ligue, tour, debut: m.debut, dom: m.domicile, ext: m.exterieur };
      if (s.refus) { l.resultat = 'panne'; lignes.push(l); continue; }
      const x = apparieTennis(m, lus);
      if (!x) {
        l.resultat = 'sans';
        l.proches = lus.filter((r) => memeJourTennis(m.debut, r)
          && [r.a, r.b].some((n) => memeJoueur(m.domicile, n) || memeJoueur(m.exterieur, n)))
          .slice(0, 3).map((r) => r.a + ' v ' + r.b);
      } else if (x.ambigu) {
        l.resultat = 'ambigu'; l.candidats = x.n;
      } else {
        const r = x.r;
        l.resultat = 'apparie'; l.etat = r.etat; l.heureValide = r.heureValide;
        /* le sens de l'appariement (unique : les deux sens a la fois sont `ambigu`) */
        const droit = memeJoueur(m.domicile, r.a) && memeJoueur(m.exterieur, r.b);
        const vainqueur = r.gagnant === 'a' ? (droit ? '1' : '2') : r.gagnant === 'b' ? (droit ? '2' : '1') : null;
        par.set(m.id, { quand: r.heureValide ? r.quand : 0, etat: r.etat, heureValide: r.heureValide, dateEspn: r.quand,
                        statut: r.statut, detail: r.detail, espn: r.id, tournoi: r.tournoi, dom: m.domicile, ext: m.exterieur,
                        jeux: r.jeux, vainqueur });
      }
      lignes.push(l);
    }
  }
  return { par, rencontres: lignes, tours };
}

/*
 * ==================== LE CRICKET, PAR L'EN-TETE D'ESPN (12/10/2026) ====================
 *
 * ---- pourquoi pas un tableau par ligue, comme le football ----
 * La cle `cricket_international_t20` lisait 'cricket/8039' : la Coupe du monde
 * ODI 2027, 0 rencontre avant 10/2027. Les T20I et ODI bilateraux ont un id
 * PAR TOURNEE (24707 Sri Lanka au Pakistan, 24289 West Indies en Inde), la
 * Coupe du monde T20 le sien (8604), The Hundred 19601 (hommes) et 21376
 * (femmes), le Blast 8053, et l'ODI n'a pas de competition unique : aucun
 * chemin fixe ne couvre une cle. Le cricket ne s'est donc JAMAIS regle seul.
 *
 * Le seul index de toutes les ligues est l'EN-TETE :
 *   https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=cricket&lang=en&region=us&dates=AAAAMMJJ
 * Mesure du 12/10/2026, 17:30-17:45Z, 68 appels : 39 rencontres de 11
 * tableaux, 53 comparaisons avec les tableaux et les summaries, 0 ecart sur le
 * statut, le vainqueur, les noms et le score. Relu de 19:45 a 19:54Z (54
 * appels a l'en-tete, 48 journees lisibles du 18/07 au 15/10, 626 rencontres
 * distinctes) pour les copies des essais (essais/cricket/index.json).
 *
 * ---- ce que l'en-tete impose ----
 *  - `dates` est la date LOCALE du match : on demande J-1, J et J+1 autour du
 *    jour UTC de notre debut, UN JOUR PAR REQUETE (une fenetre
 *    AAAAMMJJ-AAAAMMJJ rend 404 ; le mois coupe a 300 evenements). Une
 *    rencontre limitee n'est en general que sous sa date (1 sur 626 sous deux
 *    jours : 1552312, les 12 et 13/09) : deux copies d'une rencontre doivent
 *    dire la meme chose, sinon rien n'est tranche.
 *  - les dates anciennes rendent des 502 intermittents (HTTP 502, corps
 *    {"code":2502}) : 14 sur 68 appels le 12/10 apres-midi, 5 sur 54 le soir
 *    (16/08 deux fois sur trois, 17/08 deux fois sur deux, 01/09). UN REFUS
 *    N'EST JAMAIS UNE LISTE VIDE : une seule des trois journees refusee, et la
 *    rencontre n'est pas tranchee a cette passe — un candidat manquant ferait
 *    passer pour unique celui qui reste. Une journee refusee est redemandee
 *    UNE fois en fin de passe ; la passe suivante redemande ; sinon, la main.
 *  - le resultat se lit sur `fullStatus.type.id`, ET SUR LUI SEUL :
 *    `description` vaut « Result » pour 1, 3 et 4, `detail` « Final » pour 1,
 *    3, 5, 6 et 0-post. Sur 626 rencontres distinctes : id 1 porte exactement
 *    un `winner` vrai 491 fois sur 491 (toutes « post »), aucun autre id n'en
 *    porte. Ce qu'on en fait (`verdictCricket`) :
 *      1    victoire (DLS comprise), « post », un seul vainqueur, deux scores
 *           qui commencent par des runs              -> '1' | '2'
 *      5    sans resultat (score partiel possible : « 104/3 (13/20 ov) »)
 *      6    abandon
 *      3    egalite, super over ou non (son vainqueur n'est que dans le texte :
 *           1551858) -> a la main : aucun remboursement automatique n'existe
 *           (game.rembourseMatch n'est appele que par la route d'admin
 *           /paris/rembourse, server.js), et nos deux issues ne disent pas qui
 *           gagne une egalite ; la raison est ecrite, la rencontre est annoncee
 *           et ne paie plus de /scores (The Odds API ne regle pas le cricket)
 *      4    nul (formats longs) ; 0 prevu, en cours, ou « Final » sans donnees
 *           (state post : 5 sur 626) ; 112 stumps ; 113 reporte (state post)
 *      et tout id inconnu              -> rien (la main ensuite)
 *  - `winner` est un BOOLEEN dans l'en-tete, une CHAINE "true"/"false" dans le
 *    tableau et le summary (tableau 19601 relu le 12/10 : "true") : les deux
 *    se lisent, rien d'autre (« TRUE », 1…) ne vaut vainqueur.
 *  - un id 1 avec vainqueur peut etre un FORFAIT sans balle jouee (1540298,
 *    releve du 12/10 apres-midi : scores '' et linescores []) : il faut un
 *    score DES DEUX COTES qui commence par des runs (/^\d+/), et des runs
 *    quelque part. Releve du soir : les 982 scores des 491 id 1 commencent
 *    tous par des runs (« 215/3 », « 84 (18.3/20 ov, target 216) »,
 *    « 312 & 140/4 »…), le plus petit est 13 (1554542) ; et les 491 sont
 *    « post » — un id 1 encore « in » ne se paie pas.
 *  - le texte du resultat n'emploie pas `displayName` (« U.S.A. won » pour
 *    « United States of America », « W Province ») : on n'apparie et ne
 *    tranche JAMAIS par le texte, seulement par les camps.
 *  - une tournee porte deux formats : 24289 joue l'ODI India v West Indies le
 *    03/10 puis des T20I les 06, 09, 11 et 14/10 ; 24707 les T20I puis les ODI
 *    a cinq jours. `class.generalClassCard` doit dire le format de la cle
 *    (FORMAT_CRICKET), sinon rien.
 *  - series de cinq matchs a deux ou trois jours, et DOUBLES PROGRAMMES a
 *    quatre heures, memes noms (quatre releves du 23/09 au 05/10 ; Bahamas v
 *    Cayman Islands le 24/09 : 15:30 gagne, 19:30 sans resultat) : on regarde
 *    les rencontres des memes noms a 12 h, on ne prend que la plus proche, a
 *    MOINS DE 2 H de notre heure, et a 2 h au moins de plus que la suivante
 *    (`apparieCricket`, mesure et raison au-dessus de CRICKET_ACCEPTE_MS) ; et
 *    deux de NOS rencontres ne prennent jamais la meme rencontre ESPN.
 *  - ESPN la fait commencer AVANT notre heure : elle a ete vendue pendant le
 *    jeu, la main (CRICKET_AVANCE_MS).
 *  - `timeValid: false` : 6 lignes sur 981 (une ligue feminine domestique,
 *    hors de nos formats) ; un candidat a l'heure non valide ne tranche rien.
 *  - un match non couvert peut rester « in », id 0, plus de 12 h : rien.
 *
 * ---- les noms ----
 * `meme` (normalise + ALIAS), comme partout. Les deux rencontres ouvertes du
 * 12/10 (Pakistan v Sri Lanka le 13/10 a 13:00Z, 1550710 ; India v West
 * Indies le 14/10 a 13:30Z, 1529233) portent les MEMES noms, la meme heure et
 * le meme domicile au catalogue public et a l'en-tete. The Hundred s'ecrit
 * « Trent Rockets (Men) » chez ESPN : sans ligne d'ALIAS relevee a la saison
 * prochaine (les noms The Odds API de 2026 n'ont pas ete vus), il ne
 * s'apparie pas — il part a la main, jamais par ressemblance.
 *
 * ---- le rythme ----
 * Une requete a la fois, une par seconde au plus (`CRICKET_PAUSE_MS`), en
 * file pour tout le module : la releve ne demande que les rencontres pariees
 * (`aRegler`) et leurs voisines du catalogue, trois jours chacune, une fois
 * par jour demande, dans un budget de 60 s par passe (CRICKET_BUDGET_MS).
 *
 * ---- ce qui se dit ----
 * Une ligne de journal par rencontre et par passe QUAND SON ISSUE CHANGE
 * (regle, main, rien, sans, ambigu, heure, loin, panne, avec la rencontre
 * ESPN, son id de statut et la raison), et le compte de la derniere passe
 * dans `etatCricket()` (etatImport().cricket) : un en-tete qui change de forme
 * se verrait sinon comme des paris qui restent, en silence, a regler.
 */
const ENTETE_CRICKET = 'https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=cricket&lang=en&region=us&dates=';
/* La cle The Odds API -> la seule `class.generalClassCard` qui la tranche.
   Releve dans l'en-tete le 12/10/2026 (626 rencontres) : « T20I » (120,
   international 3 ; les T20I feminins sont « Women T20 », 46) ; « ODI » (30,
   international 2 ; « Women's ODI » a part, 9) ; le Blast (8053 : 1512887 et
   1512889 le 18/07) et The Hundred masculin (19601 : 1521259 le 10/08,
   1521264 le 16/08) sont « Twenty20 » — The Hundred feminin (21376) est
   « Women's T20 ». Une cle absente d'ici n'est jamais lue. */
const FORMAT_CRICKET = Object.freeze({
  cricket_international_t20: 'T20I',
  cricket_odi: 'ODI',
  cricket_t20_blast: 'Twenty20',
  cricket_the_hundred: 'Twenty20',
});
/* La fenetre ou l'on REGARDE les rencontres des memes noms (pour voir une
   jumelle), pas celle ou l'on en accepte une. */
const CRICKET_TOLERANCE_MS = 12 * 3600000;
/* ---- ACCEPTER UNE RENCONTRE : A MOINS DE 2 H, ET NETTEMENT LA PLUS PROCHE (relecture du 12/10/2026) ----
 * Le plus petit ecart entre deux rencontres des MEMES noms est de 4 h (626
 * rencontres distinctes, 48 en-tetes du 18/07 au 15/10 : quatre doubles
 * programmes, 1552795/1552798, 1552796/1552799, 1555386/1552797,
 * 1555137/1555138 ; le suivant est a 20 h). L'ecart entre l'heure de The Odds
 * API et celle d'ESPN n'est mesure que sur 2 rencontres : 0 min (les deux
 * seules rencontres de cricket du catalogue public, relu le 12/10 a 20:20Z ;
 * aucun catalogue plus ancien n'en garde).
 *  - la plus proche doit etre a MOINS DE 2 H de notre heure, la moitie de
 *    4 h : si notre rencontre manque a l'en-tete, sa jumelle est a 4 h de sa
 *    vraie heure, donc a plus de 2 h de la notre tant que The Odds API et
 *    ESPN different de moins de 2 h. La tolerance etait de 12 h : « Cayman
 *    Islands v Bahamas » de 19:30 sans 1552798 prenait la victoire de 15:30
 *    (essai « jumelle absente ») — un paiement faux pour un match sans
 *    resultat.
 *  - la suivante doit etre a 2 h DE PLUS que la plus proche : ce sont les
 *    DISTANCES A NOTRE HEURE qui comptent, pas l'ecart entre les deux
 *    rencontres ESPN (qui valait toujours 4 h). Un debut a 17:20 ou 17:30
 *    entre 15:30 et 19:30 prenait l'une ou l'autre au hasard de l'ordre.
 *  - une rencontre des memes noms a la date illisible : rien (heure).
 * Ce qui tombe hors de ces bornes n'est pas tranche : la main, par
 * /paris/aregler. */
const CRICKET_ACCEPTE_MS = 2 * 3600000;
const CRICKET_DOUBLON_MS = 2 * 3600000;
/* ---- ESPN LA FAIT COMMENCER AVANT NOTRE HEURE : LA MAIN (relecture du 12/10/2026) ----
 * Les paris ferment a NOTRE heure (`paris.ouvert`), et pour le cricket aucun
 * verrou d'heure reelle ne la corrige : HEURES_REELLES ne lit que les
 * tableaux, et le cricket n'en a aucun. Une rencontre qu'ESPN fait commencer
 * plus tot a donc ete vendue PENDANT le jeu : un verdict ESPN sur elle ne se
 * paie pas seul, il part a la main avec l'heure ESPN, pour reperer les tickets
 * poses apres. Mesure : 0 min d'ecart sur les 2 rencontres de cricket du
 * catalogue (12/10). En NHL, The Odds API etait 9 a 10 min APRES ESPN sur 10
 * rencontres sur 11 (08/10, paris.js) : si le cricket le faisait aussi, chaque
 * minute serait une vente en jeu. La borne est la resolution de l'heure ESPN,
 * la minute. Un decalage systematique se lira dans le journal (une ligne par
 * rencontre) des le 13/10. */
const CRICKET_AVANCE_MS = 60000;
const CRICKET_PAUSE_MS = 1000;
/* ---- LE BUDGET D'UNE PASSE (relecture du 12/10/2026) ----
 * `finies` attend le cricket avant de rendre le football et le tennis deja
 * lus. Un ESPN lent (abandon a 8 s) sur 25 jours paries ferait ~4 min. Passe
 * 60 s, les journees restantes sont refusees : leurs rencontres sont « panne »
 * (rien rendu, la passe suivante redemande). Une journee refusee par ESPN est
 * redemandee UNE fois en fin de passe : le 502 de l'en-tete est intermittent
 * (le 16/08 a repondu une fois sur trois le 12/10 au soir). */
const CRICKET_BUDGET_MS = 60000;

/** Une rencontre de cricket ? Par le sport OU par la cle : l'un suffit. */
function estCricket(m) {
  return !!m && (m.sport === 'cricket' || /^cricket_/.test(String((m.source && m.source.ligue) || '')));
}
/** Les trois journees a demander : J-1, J, J+1 autour du jour UTC du debut. */
function joursCricket(debut) {
  if (!isFinite(debut)) return [];
  return [jour(debut - 86400000), jour(debut), jour(debut + 86400000)];
}

/* `winner` vrai : le booleen de l'en-tete, ou la chaine du tableau. */
const vainqueurCricket = (x) => !!x && (x.winner === true || x.winner === 'true');
/** Une rencontre de l'en-tete, reduite a ce qu'on lit. null si elle n'a pas deux camps nommes. */
function lisCricket(ev, ligue) {
  if (!ev || typeof ev !== 'object' || !Array.isArray(ev.competitors) || ev.competitors.length !== 2) return null;
  const camp = (x) => ({
    nom: String((x && x.displayName) || '').trim(),
    gagne: vainqueurCricket(x),
    score: x && x.score !== undefined && x.score !== null ? String(x.score).trim() : '',
  });
  const a = camp(ev.competitors[0]), b = camp(ev.competitors[1]);
  if (!a.nom || !b.nom) return null;
  const st = (ev.fullStatus && typeof ev.fullStatus === 'object') ? ev.fullStatus : {};
  const t = (st.type && typeof st.type === 'object') ? st.type : {};
  const quand = Date.parse(ev.date);
  return { id: ev.id !== undefined && ev.id !== null ? String(ev.id) : null,
           ligue: ligue !== undefined && ligue !== null ? String(ligue) : null,
           quand: isFinite(quand) ? quand : 0, heureValide: ev.timeValid !== false && isFinite(quand),
           carte: String((ev.class && ev.class.generalClassCard) || ''),
           statutId: t.id !== undefined && t.id !== null ? String(t.id) : '',
           etat: String(t.state || ''), statut: String(t.description || ''),
           resume: String(st.longSummary || '').slice(0, 120), a, b };
}
/* Ce qui doit etre identique entre deux copies d'une meme rencontre. */
const signatureCricket = (r) => [r.statutId, r.carte, r.quand, r.a.nom, r.a.gagne, r.a.score, r.b.nom, r.b.gagne, r.b.score].join('|');
/* Des runs en tete du score (« 215/3 », « 84 (18.3/20 ov, target 216) »). */
const runsCricket = (s) => { const x = /^(\d+)/.exec(String(s || '')); return x ? Number(x[1]) : null; };

/**
 * Le verdict d'une rencontre de l'en-tete, sur `fullStatus.type.id` seul :
 *   { gagnant: 'a' | 'b' }   id 1, « post », un seul vainqueur, deux scores
 *                            qui commencent par des runs, des runs quelque part ;
 *   { main: '...' }          id 3 (egalite), 5 (sans resultat), 6 (abandon) ;
 *   { rien: '...' }          tout le reste, forfait compris.
 * 'a'/'b' sont les camps DE L'EN-TETE (competitors[0]/[1]), jamais les notres.
 */
function verdictCricket(r) {
  if (!r) return { rien: 'rencontre illisible' };
  if (r.statutId === '1') {
    if (r.etat !== 'post') return { rien: `id 1 encore « ${r.etat || 'sans etat'} »` };
    const n = (r.a.gagne ? 1 : 0) + (r.b.gagne ? 1 : 0);
    if (n !== 1) return { rien: `id 1 avec ${n} vainqueur(s)` };
    const ra = runsCricket(r.a.score), rb = runsCricket(r.b.score);
    if (ra === null || rb === null || ra + rb === 0) return { rien: 'id 1 sans score joue des deux cotes (forfait sans balle jouee ?)' };
    return { gagnant: r.a.gagne ? 'a' : 'b' };
  }
  if (r.statutId === '3') return { main: 'egalite' };
  if (r.statutId === '5') return { main: 'sans resultat' };
  if (r.statutId === '6') return { main: 'abandon' };
  return { rien: `status.type.id ${r.statutId || 'absent'}${r.statut ? ' (' + r.statut + ')' : ''}` };
}

/* La file des requetes a l'en-tete : une a la fois pour tout le module, et
   CRICKET_PAUSE_MS entre deux departs (`pauseMs` pour les essais). */
let FILE_ENTETE = Promise.resolve();
let DERNIER_ENTETE = 0;
function enFileEntete(fn) {
  const p = FILE_ENTETE.then(fn, fn);
  FILE_ENTETE = p.catch(() => {});
  return p;
}
/**
 * Une journee de l'en-tete : { evs: [rencontres lues] } ou { refus: 'pourquoi' }.
 * Refus = statut non-200 (le 502 {"code":2502}), abandon a 8 s, corps sans
 * `sports[0].leagues` — jamais une liste vide. Compte dans `refusDuJour()`
 * sous 'cricket/entete'.
 */
function enteteCricket(j, opts) {
  const o = opts || {};
  return enFileEntete(async () => {
    const pause = typeof o.pauseMs === 'number' && o.pauseMs >= 0 ? o.pauseMs : CRICKET_PAUSE_MS;
    const attente = DERNIER_ENTETE + pause - Date.now();
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    DERNIER_ENTETE = Date.now();
    const u = ENTETE_CRICKET + j;
    const f = o.prendre || fetch;
    const refuse = (pourquoi) => { compte(u, true, pourquoi, 'cricket/entete'); return { refus: pourquoi }; };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const minuterie = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    try {
      const rep = await f(u, ctl ? { signal: ctl.signal } : undefined);
      if (!rep || !rep.ok) return refuse('statut ' + ((rep && rep.status) || '?'));
      const corps = await rep.json();
      const sp = corps && Array.isArray(corps.sports) ? corps.sports[0] : null;
      if (!sp || !Array.isArray(sp.leagues))
        return refuse('reponse sans sports[0].leagues' + (corps && corps.code ? ' (code ' + corps.code + ')' : ''));
      const evs = [];
      for (const l of sp.leagues) {
        for (const ev of Array.isArray(l && l.events) ? l.events : []) {
          try { const r = lisCricket(ev, l && l.id); if (r) evs.push(r); } catch (e) { /* une rencontre illisible n'emporte qu'elle */ }
        }
      }
      compte(u, false, null, 'cricket/entete');
      return { evs };
    } catch (e) {
      return refuse((e && e.name === 'AbortError') ? 'abandon a 8 s' : String((e && e.message) || e).slice(0, 80));
    } finally { if (minuterie) clearTimeout(minuterie); }
  });
}

/* Les deux memes camps, dans un sens ou dans l'autre : 'droit' (notre
   domicile est leur premier camp), 'envers', ou null. */
function sensCricket(dom, ext, a, b) {
  if (meme(dom, a) && meme(ext, b)) return 'droit';
  if (meme(dom, b) && meme(ext, a)) return 'envers';
  return null;
}

/**
 * Une rencontre de NOTRE catalogue contre les rencontres lues : les deux noms
 * (`meme`, dans un sens ou l'autre), vues a 12 h, la plus proche seulement si
 * elle est a moins de 2 h ET a 2 h de moins que la suivante. Rend
 * { sans } | { heure } | { ambigu: n } | { loin: ms } | { r, droit, d } —
 * `droit` : notre domicile est le premier camp de l'en-tete.
 */
function apparieCricket(m, rencontres) {
  const cands = [];
  let illisible = false;
  for (const r of rencontres || []) {
    const sens = sensCricket(m.domicile, m.exterieur, r.a.nom, r.b.nom);
    if (!sens) continue;
    if (!(r.quand > 0)) { illisible = true; continue; }
    const d = Math.abs(r.quand - m.debut);
    if (d > CRICKET_TOLERANCE_MS) continue;
    cands.push({ d, r, droit: sens === 'droit' });
  }
  /* une rencontre des memes noms sans date lisible peut etre la notre : on
     ne sait pas l'ecarter, donc rien n'est tranche */
  if (illisible || cands.some((c) => !c.r.heureValide)) return { heure: true };
  if (!cands.length) return { sans: true };
  cands.sort((x, y) => x.d - y.d);
  if (cands.length > 1 && cands[1].d - cands[0].d < CRICKET_DOUBLON_MS) return { ambigu: cands.length };
  if (cands[0].d >= CRICKET_ACCEPTE_MS) return { loin: cands[0].d };
  return cands[0];
}

/* ---- LE RESULTAT DOIT TENIR AUTO_DELAI_MIN (relecture du 12/10/2026) ----
 * Le delai du reglement (`trieReglements`, AUTO_DELAI_MIN + 110 = 200 min
 * depuis le coup d'envoi) laisse au football 90 min apres sa fin pour qu'une
 * saisie fausse soit corrigee. Un T20 dure ~3 h 20, un ODI ~8 h : compte
 * depuis le coup d'envoi, ce mur tombe avant la fin, et un id 1 se payait des
 * la premiere passe qui le lisait — 0 min de correction (essai « ODI a
 * 490 min »). La fin reelle n'est nulle part : `endDate` vaut le lendemain a
 * 23:59 (relu sur les 626 rencontres du 12/10), et le delai entre la fin et
 * le passage a id 1 n'est pas mesure. On retient donc l'heure de la PREMIERE
 * lecture du meme verdict (rencontre ESPN, id, vainqueur, scores, sens) :
 * `vuFini`, que trieReglements exige vieux d'AUTO_DELAI_MIN. Un verdict qui
 * change, ou qui disparait, repart de zero ; une passe en panne ne dit rien
 * et ne l'efface pas. En memoire : un redemarrage fait attendre une passe de
 * plus, jamais une de moins. */
const VU_FINI_CRICKET = new Map();
/* La derniere issue DITE par rencontre (une ligne de journal quand elle
   change), et le compte de la derniere passe (`etatCricket`). */
const ISSUE_CRICKET = new Map();
let ETAT_CRICKET = null;
const borne = (map) => { while (map.size > 2000) map.delete(map.keys().next().value); };
const isoMin = (t) => new Date(t).toISOString().slice(0, 16) + 'Z';

/**
 * LA RELEVE DU CRICKET. `matchs` : le lot de `finies` (seules les cles de
 * FORMAT_CRICKET sont lues). `opts.catalogue` (facultatif) : tout le
 * catalogue, pour voir nos AUTRES rencontres des memes noms a 12 h — deux des
 * notres ne prennent jamais la meme rencontre ESPN, meme quand une seule porte
 * un pari. Rendu :
 *   par    : Map id -> { espn, ligueEspn, carte, statutId, etat, quand,
 *            resultat ('1' notre domicile | '2' notre exterieur) et vuFini,
 *            OU aMain (la raison) OU raison (rien de tranche) } — les seules
 *            rencontres appariees sans doute ;
 *   lignes : une par rencontre : 'regle' | 'main' | 'rien' | 'sans' |
 *            'ambigu' | 'heure' | 'loin' | 'panne', avec sa raison ;
 *   jours  : { AAAAMMJJ: 'ok' | 'refus : pourquoi' }.
 */
async function releveCricket(matchs, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const maintenant = Number(o.maintenant) || Date.now();
  const par = new Map(), lignes = [], jours = {};
  const lisible = (m) => !!(m && m.source && FORMAT_CRICKET[m.source.ligue] && isFinite(m.debut));
  const lot = (matchs || []).filter(lisible);
  if (!lot.length) return { par, lignes, jours };
  /* les voisines : nos autres rencontres non fermees des memes noms a 12 h
     d'une rencontre du lot (fermees, elles partent a la main de toute facon) */
  const dansLot = new Set(lot.map((m) => m.id));
  const voisines = (Array.isArray(o.catalogue) ? o.catalogue : []).filter((v) => lisible(v) && !dansLot.has(v.id) && !v.ferme
    && lot.some((m) => Math.abs(v.debut - m.debut) <= CRICKET_TOLERANCE_MS && sensCricket(m.domicile, m.exterieur, v.domicile, v.exterieur)));
  const tous = lot.concat(voisines);

  const budget = typeof o.budgetMs === 'number' && o.budgetMs >= 0 ? o.budgetMs : CRICKET_BUDGET_MS;
  const demande = (j) => (Date.now() - t0 > budget
    ? Promise.resolve({ refus: `budget de la passe depasse (${Math.round(budget / 1000)} s)`, budget: true })
    : enteteCricket(j, o));
  const aDemander = [...new Set([].concat(...tous.map((m) => joursCricket(m.debut))))].sort();
  const lus = new Map();
  for (const j of aDemander) lus.set(j, await demande(j));
  for (const j of aDemander) {
    const x = lus.get(j);
    if (!x.refus || x.budget) continue;
    const y = await demande(j);
    lus.set(j, y.refus ? { refus: x.refus + ', puis ' + y.refus } : y);
  }
  for (const j of aDemander) jours[j] = lus.get(j).refus ? 'refus : ' + lus.get(j).refus : 'ok';

  /* l'appariement de chacune, voisines comprises */
  const choix = new Map();
  for (const m of tous) {
    const js = joursCricket(m.debut);
    const refuses = js.filter((j) => lus.get(j).refus);
    if (refuses.length) { choix.set(m.id, { panne: refuses.map((j) => j + ' (' + lus.get(j).refus + ')').join(', ') }); continue; }
    /* chaque rencontre une fois ; deux copies qui different : incoherente */
    const parId = new Map(), incoherents = new Set();
    const cle = (r) => (r.id !== null ? r.id : signatureCricket(r));
    for (const j of js) {
      for (const r of lus.get(j).evs) {
        const deja = parId.get(cle(r));
        if (!deja) parId.set(cle(r), r);
        else if (signatureCricket(deja) !== signatureCricket(r)) incoherents.add(cle(r));
      }
    }
    const x = apparieCricket(m, [...parId.values()]);
    if (x.r) x.incoherent = incoherents.has(cle(x.r));
    choix.set(m.id, x);
  }
  /* une rencontre ESPN -> lesquelles des notres (non fermees) la prennent */
  const preneurs = new Map();
  for (const m of tous) {
    const x = choix.get(m.id);
    if (!x.r || m.ferme) continue;
    const k = x.r.id !== null ? x.r.id : signatureCricket(x.r);
    if (!preneurs.has(k)) preneurs.set(k, []);
    preneurs.get(k).push(m.id);
  }

  /* une voisine qu'on n'a pas pu lire peut prendre la meme rencontre ESPN :
     on ne le sait pas, donc rien n'est tranche pour celle du lot non plus */
  const voisinesEnPanne = (m) => tous.filter((v) => v.id !== m.id && !v.ferme && choix.get(v.id).panne
    && Math.abs(v.debut - m.debut) <= CRICKET_TOLERANCE_MS && sensCricket(m.domicile, m.exterieur, v.domicile, v.exterieur));

  for (const m of lot) {
    const l = { id: m.id, ligue: m.source.ligue, debut: m.debut, dom: m.domicile, ext: m.exterieur };
    lignes.push(l);
    let x = choix.get(m.id);
    const vp = x.panne ? [] : voisinesEnPanne(m);
    if (vp.length) x = { panne: 'voisine(s) du catalogue illisible(s) : ' + vp.map((v) => v.id + ' — ' + choix.get(v.id).panne).join(' ; ') };
    if (!x.r) {
      /* une panne ne dit rien : la premiere lecture d'un verdict reste */
      if (x.panne) { l.resultat = 'panne'; l.raison = 'en-tete refuse : ' + x.panne; continue; }
      VU_FINI_CRICKET.delete(m.id);
      if (x.sans) { l.resultat = 'sans'; l.raison = 'aucune rencontre de ces deux noms a 12 h'; }
      else if (x.heure) { l.resultat = 'heure'; l.raison = 'une rencontre de ces noms a une heure ESPN non valide (timeValid false ou date illisible)'; }
      else if (x.ambigu) { l.resultat = 'ambigu'; l.raison = `${x.ambigu} rencontres de ces noms, la plus proche n est pas a 2 h de moins que la suivante`; }
      else { l.resultat = 'loin'; l.raison = `la plus proche des rencontres de ces noms est a ${Math.round(x.loin / 60000)} min de notre heure (moins de 2 h exigees)`; }
      continue;
    }
    const r = x.r;
    const s = { espn: r.id, ligueEspn: r.ligue, carte: r.carte, statutId: r.statutId, etat: r.etat, quand: r.quand,
                dom: m.domicile, ext: m.exterieur };
    par.set(m.id, s);
    Object.assign(l, { espn: r.id, ligueEspn: r.ligue, statutId: r.statutId, etat: r.etat });
    const autres = m.ferme ? [] : (preneurs.get(r.id !== null ? r.id : signatureCricket(r)) || []).filter((id) => id !== m.id);
    const avance = m.debut - r.quand;
    if (autres.length) {
      s.raison = `la rencontre ESPN ${r.id} est prise aussi par ${autres.join(', ')} : une rencontre ESPN pour ${autres.length + 1} des notres`;
    } else if (x.incoherent) {
      s.raison = 'deux copies de la rencontre different d un jour a l autre';
    } else if (r.carte !== FORMAT_CRICKET[m.source.ligue]) {
      s.raison = `format ${r.carte || 'inconnu'} chez ESPN, ${FORMAT_CRICKET[m.source.ligue]} attendu pour ${m.source.ligue}`;
    } else {
      const v = verdictCricket(r);
      /* ESPN la fait commencer avant notre heure : vendue pendant le jeu */
      const tot = avance > CRICKET_AVANCE_MS
        ? ` ; ESPN la fait commencer a ${isoMin(r.quand)}, ${Math.round(avance / 60000)} min avant notre heure (${isoMin(m.debut)}) : verifier les tickets poses apres ${isoMin(r.quand)}`
        : '';
      if (v.gagnant) {
        /* dans NOTRE orientation : le camp qui porte le nom de notre domicile */
        const lettre = ((v.gagnant === 'a') === x.droit) ? '1' : '2';
        if (tot) s.aMain = `cricket : ESPN donne ${lettre} (rencontre ${r.id})` + tot + ', puis regler a la main';
        else {
          s.resultat = lettre;
          const sig = [r.id, r.statutId, v.gagnant, r.a.score, r.b.score, x.droit].join('|');
          const deja = VU_FINI_CRICKET.get(m.id);
          if (!deja || deja.sig !== sig) VU_FINI_CRICKET.set(m.id, { sig, t: maintenant });
          borne(VU_FINI_CRICKET);
          s.vuFini = VU_FINI_CRICKET.get(m.id).t;
        }
      } else if (v.main) {
        s.aMain = `cricket : ${v.main} sur ESPN (rencontre ${r.id}, status.type.id ${r.statutId}) : aucun vainqueur dans nos deux issues, `
                + 'aucun remboursement automatique, a trancher a la main' + tot;
      } else s.raison = v.rien;
    }
    if (!s.resultat) VU_FINI_CRICKET.delete(m.id);
    l.resultat = s.resultat ? 'regle' : s.aMain ? 'main' : autres.length ? 'ambigu' : 'rien';
    if (s.resultat) l.lettre = s.resultat;
    if (s.raison || s.aMain) l.raison = s.raison || s.aMain;
  }

  /* ---- CE QUI SE DIT (relecture du 12/10/2026) ----
   * Une ligne par rencontre quand son issue change, et le compte de la passe.
   * Avant, 'sans', 'ambigu', 'rien' ou 'panne' ne laissaient aucune trace :
   * un en-tete qui change de forme aurait laisse les paris a regler en
   * silence, et le delai fin -> id 1 du 13/10 ne se serait pas lu. */
  const compteIssues = {};
  for (const l of lignes) {
    compteIssues[l.resultat] = (compteIssues[l.resultat] || 0) + 1;
    const dit = [l.resultat, l.lettre || '', l.espn || '', l.statutId || '', l.etat || '', l.raison || ''].join('|');
    if (ISSUE_CRICKET.get(l.id) === dit) continue;
    ISSUE_CRICKET.set(l.id, dit);
    borne(ISSUE_CRICKET);
    console.log(`[espn] cricket ${l.id} (${l.dom} v ${l.ext}, ${l.ligue}, ${isoMin(l.debut)}) : ${l.resultat}`
      + (l.lettre ? ' ' + l.lettre : '')
      + (l.espn ? ` — ESPN ${l.espn} (ligue ${l.ligueEspn}) id ${l.statutId || '?'} ${l.etat || '?'}` : '')
      + (l.raison ? ' — ' + l.raison : ''));
  }
  const refusees = Object.entries(jours).filter(([, v]) => v !== 'ok').map(([j, v]) => j + ' ' + v);
  ETAT_CRICKET = { t: new Date(maintenant).toISOString(), rencontres: lot.length, voisines: voisines.length,
                   issues: compteIssues, journees: aDemander.length, refusees, dureeMs: Date.now() - t0,
                   lignes: lignes.slice(0, 40).map((l) => ({ id: l.id, resultat: l.resultat, lettre: l.lettre || null,
                     espn: l.espn || null, statutId: l.statutId || null, raison: l.raison || null })) };
  return { par, lignes, jours };
}
/** La derniere passe du cricket : rencontres, compte par issue, journees refusees (null avant la premiere). */
function etatCricket() { return ETAT_CRICKET; }

/** Les rencontres FINIES, au format que `reglementAuto` attend deja. */
async function finies(matchs, opts) {
  const vus = await releve(matchs, opts);
  const out = [];
  for (const m of matchs || []) {
    const s = vus.get(m.id);
    if (!s || !s.fini || !s.score) continue;
    /* jamais un score de cricket par ce chemin (« 0-0 » et 'N' d'un abandon) */
    if (estCricket(m)) continue;
    const f = { id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur,
                score: s.score, resultat: s.resultat, source: 'espn' };
    /* ---- LE FOOTBALL SE REGLE A 90 MINUTES (08/10/2026) ----
     * Le score d'ESPN compte la prolongation : finale de la Coupe du Roi 2025,
     * « 3-2 », STATUS_FINAL_AET — 2-2 a 90 minutes, donc « N » pour nos
     * marches, pas « 1 ». En C1 le 11/03/2025, deux huitiemes finis aux tirs
     * au but rendaient STATUS_FINAL_PEN. Le football ne se regle donc SEUL
     * que sur un temps reglementaire declare (liste blanche) ; tout le reste
     * part a la main, avec sa raison. Il reste DANS la liste : sinon la
     * releve payante de The Odds API le reprendrait, prolongation comprise.
     * Echeance : les series MLS (prolongation des les demi-finales de
     * conference, 5-6/12/2026) entrent au calendrier vers le 28/11, la C1 a
     * elimination directe en fevrier. */
    if (m.sport === 'foot' && FOOT_REGLEMENTAIRE.indexOf(s.statut) < 0)
      f.aMain = `football fini en ${s.statut || 'statut inconnu'} (ESPN) : regler sur le score a 90 minutes`;
    out.push(f);
  }
  /* ---- ET LE TENNIS, QUI N'A PAS DE SCORE MAIS UN VAINQUEUR ----
   * Ses marches n'ont que deux issues — pas de « les deux marquent », pas de
   * total de buts — donc la LETTRE suffit a tout regler, et c'est heureux :
   * un score de tennis se compte en sets et ne se lit pas comme « 2-1 ». */
  const parTennis = await releveTennis(matchs, opts);
  for (const m of matchs || []) {
    const s = parTennis.get(m.id);
    if (!s || !s.fini || !s.resultat) continue;
    out.push({ id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur,
               resultat: s.resultat, source: 'espn' });
  }
  /* ---- LE CRICKET : UNE LETTRE, OU LA MAIN AVEC SA RAISON (12/10/2026) ----
   * Comme le tennis, deux issues et pas de score lisible comme « 2-1 » : la
   * LETTRE seule, dans notre orientation (`releveCricket`), avec `vuFini`,
   * l'heure de la premiere lecture du meme verdict : `trieReglements` exige
   * AUTO_DELAI_MIN depuis elle. Egalite, sans resultat, abandon, ou ESPN qui
   * la fait commencer avant notre heure : `aMain`, que `trieReglements`
   * envoie a la main avant toute autre raison, et qui retient le /scores paye
   * de The Odds API (il ne regle pas le cricket : « 215/3 » n'est pas un
   * nombre). Tout le reste n'est pas rendu. Dans son propre try : une panne
   * du cricket ne fait jamais perdre le football ni le tennis deja lus. */
  let cri = null;
  try { cri = await releveCricket(matchs, opts); }
  catch (e) { console.log('[espn] cricket : ' + ((e && e.message) || e)); cri = null; }
  for (const m of matchs || []) {
    const s = cri && cri.par.get(m.id);
    if (!s || !(s.resultat === '1' || s.resultat === '2' || s.aMain)) continue;
    const f = { id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur,
                resultat: s.resultat || null, source: 'espn' };
    if (!s.resultat) f.aMain = s.aMain;
    else f.vuFini = s.vuFini;
    out.push(f);
  }
  return out;
}

/*
 * QUAND CE SPORT REVIENT-IL ?
 *
 * Un onglet vide sans un mot se lit comme un site casse — c'est le signalement
 * exact : « nba affiche rien ». Or la NBA n'a rien a afficher parce que sa
 * saison reprend le 3 octobre, ce qui n'est pas une panne mais une DATE, et
 * une date se dit.
 *
 * Le meme tableau gratuit sait repondre : on lui demande une large fenetre a
 * venir et l'on garde la premiere rencontre encore a jouer. Rien d'invente —
 * si ESPN ne sait pas, on ne dit rien plutot que de promettre un retour.
 */
async function reprise(ligues, opts) {
  const o = opts || {};
  const t = o.maintenant || Date.now();
  let tot = null;
  for (const l of ligues || []) {
    if (!CHEMINS[l]) continue;
    const evs = await tableau(CHEMINS[l], t, t + 75 * 86400000, o.prendre);
    for (const ev of evs) {
      const v = lis(ev);
      if (!v || v.fini || v.etat !== 'pre') continue;
      if (v.quand <= t) continue;
      if (tot === null || v.quand < tot) tot = v.quand;
    }
  }
  return tot;
}

module.exports = { CHEMINS, ALIAS, normalise, meme, lis, faitsDe, tableau, requetes, JOURS_MAX, FOOT_REGLEMENTAIRE, refusDuJour, blocages,
                   releve, finies, reprise, americaine,
                   releveTennis, tourDe,
                   /* le verrou d'heure reelle du tennis (11/10/2026) : le tableau public atp/wta */
                   CHEMINS_TENNIS, SIMPLE_DU_TOUR, TENNIS_JOURS_MAX, joursTennis, normaliseJoueur, ALIAS_TENNIS, memeJoueur,
                   jeuxJoues, lisTennis, rencontresTennis, TENNIS_HEURE_MS, TENNIS_DATE_AVANT_MS, TENNIS_DATE_APRES_MS, memeJourTennis,
                   apparieTennis, releveTennisTableau,
                   /* le cricket par l'en-tete (12/10/2026) */
                   ENTETE_CRICKET, FORMAT_CRICKET, CRICKET_TOLERANCE_MS, CRICKET_ACCEPTE_MS, CRICKET_DOUBLON_MS, CRICKET_AVANCE_MS,
                   CRICKET_PAUSE_MS, CRICKET_BUDGET_MS,
                   estCricket, joursCricket, lisCricket, verdictCricket, apparieCricket, enteteCricket, releveCricket, etatCricket };
