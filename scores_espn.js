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
 * ---- CE QU'ELLE NE COUVRE PAS, ET IL FAUT LE DIRE ----
 *
 * LE TENNIS. Son tableau ne rend que des TOURNOIS — « US Open », zero
 * rencontre dedans. Or le tennis est notre plus gros sport : quatre-vingt-
 * treize rencontres contre quarante-huit au football. Le tennis reste donc
 * sur The Odds API pour son reglement, et c'est tres bien : deux credits pour
 * UN sport au lieu de cinq, la depense est divisee par cinq quand meme.
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
  cricket_international_t20: 'cricket/8039',
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
function compte(u, refus, pourquoi) {
  const m = /sports\/(.+?)\/scoreboard/.exec(String(u));
  const cle = new Date().toISOString().slice(0, 10) + '|' + (m ? m[1] : '?');
  const e = REFUS.get(cle) || { requetes: 0, refus: 0, dernier: '' };
  e.requetes++;
  if (refus) {
    if (!e.refus) console.log(`[espn] refus sur ${m ? m[1] : u} : ${pourquoi} — ${String(u).split('?')[1] || ''}`);
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

async function uneRequete(u, prendre) {
  const f = prendre || fetch;
  /* Un tableau de scores n'est JAMAIS une raison de faire attendre le serveur.
     Huit secondes, puis on s'en passe : le calendrier vaut sans le direct, le
     direct ne vaut rien sans le calendrier. */
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const minuterie = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
  try {
    const rep = await f(u, ctl ? { signal: ctl.signal } : undefined);
    if (!rep || !rep.ok) { compte(u, true, 'statut ' + ((rep && rep.status) || '?')); return []; }
    const j = await rep.json();
    compte(u, false);
    return Array.isArray(j && j.events) ? j.events : [];
  } catch (e) {
    compte(u, true, (e && e.name === 'AbortError') ? 'abandon a 8 s' : String((e && e.message) || e).slice(0, 80));
    return [];
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
  const camp = (x) => ({
    nom: (x.team && (x.team.displayName || x.team.name)) || '',
    points: Number(x.score),
  });
  const a = camp(c.competitors[0]), b = camp(c.competitors[1]);
  if (!a.nom || !b.nom) return null;
  const st = (ev.status && ev.status.type) || {};
  /* `statut` : le nom exact (STATUS_FULL_TIME, STATUS_FINAL_AET,
     STATUS_FINAL_PEN...). `fini` ne distingue pas un match regle a 90 minutes
     d'un match prolonge, et le score rendu compte la prolongation. */
  return { a, b, quand: Date.parse(ev.date) || 0,
           etat: st.state || 'pre', fini: !!st.completed, statut: String(st.name || ''),
           detail: st.shortDetail || st.detail || st.description || '' };
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
    if (!parLigue.has(l)) parLigue.set(l, []);
    parLigue.get(l).push(m);
  }
  for (const [ligue, lot] of parLigue) {
    const debuts = lot.map((m) => m.debut).filter((x) => isFinite(x));
    if (!debuts.length) continue;
    const evs = await tableau(CHEMINS[ligue],
                              Math.min(...debuts) - 86400000,
                              Math.max(...debuts) + 86400000, o.prendre);
    const lus = evs.map(lis).filter(Boolean);
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
      if (isFinite(dom.points) && isFinite(ext.points)) {
        su.score = `${dom.points}-${ext.points}`;
        su.resultat = dom.points > ext.points ? '1'
                    : ext.points > dom.points ? '2' : 'N';
      }
      out.set(m.id, su);
    }
  }
  return out;
}

/*
 * ==================== LE TENNIS ====================
 *
 * Le tableau de scores d'ESPN ne rend que des TOURNOIS pour le tennis, sans
 * les rencontres — c'est ecrit en tete de ce fichier, et c'etait exact. Son
 * API INTERNE, elle, les porte : un tournoi y arrive avec ses trois cent
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

/** Les rencontres FINIES, au format que `reglementAuto` attend deja. */
async function finies(matchs, opts) {
  const vus = await releve(matchs, opts);
  const out = [];
  for (const m of matchs || []) {
    const s = vus.get(m.id);
    if (!s || !s.fini || !s.score) continue;
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

module.exports = { CHEMINS, ALIAS, normalise, meme, lis, tableau, requetes, JOURS_MAX, FOOT_REGLEMENTAIRE, refusDuJour,
                   releve, finies, reprise,
                   releveTennis, tourDe };
