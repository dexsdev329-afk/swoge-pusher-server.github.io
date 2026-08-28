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
};

/* ---- LES QUATORZE ECARTS, ECRITS ----
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

async function tableau(chemin, deb, fin, prendre) {
  const u = `${BASE}/${chemin}/scoreboard?dates=${jour(deb)}-${jour(fin)}`;
  const f = prendre || fetch;
  /* Un tableau de scores n'est JAMAIS une raison de faire attendre le serveur.
     Trois secondes, puis on s'en passe : le calendrier vaut sans le direct, le
     direct ne vaut rien sans le calendrier. */
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const minuterie = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
  try {
    const rep = await f(u, ctl ? { signal: ctl.signal } : undefined);
    if (!rep || !rep.ok) return [];
    const j = await rep.json();
    return Array.isArray(j && j.events) ? j.events : [];
  } catch (e) {
    return [];
  } finally { if (minuterie) clearTimeout(minuterie); }
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
  return { a, b, quand: Date.parse(ev.date) || 0,
           etat: st.state || 'pre', fini: !!st.completed,
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
      for (const e of lus) {
        /* La MEME rencontre, c'est les deux memes noms ET la meme journee.
           Deux clubs se rencontrent deux fois par saison : sans la date, on
           reglerait le match aller avec le score du retour. Trente-six heures
           de tolerance — un report de quelques heures reste la meme
           rencontre, un match aller-retour en est a des mois. */
        if (Math.abs(e.quand - m.debut) > 36 * 3600000) continue;
        let dom, ext;
        if (meme(m.domicile, e.a.nom) && meme(m.exterieur, e.b.nom)) { dom = e.a; ext = e.b; }
        else if (meme(m.domicile, e.b.nom) && meme(m.exterieur, e.a.nom)) { dom = e.b; ext = e.a; }
        else continue;
        const su = { fini: e.fini, etat: e.etat, detail: e.detail,
                     dom: m.domicile, ext: m.exterieur };
        if (isFinite(dom.points) && isFinite(ext.points)) {
          su.score = `${dom.points}-${ext.points}`;
          su.resultat = dom.points > ext.points ? '1'
                      : ext.points > dom.points ? '2' : 'N';
        }
        out.set(m.id, su);
        break;
      }
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
    out.push({ id: m.id, sport: m.sport, domicile: m.domicile, exterieur: m.exterieur,
               score: s.score, resultat: s.resultat, source: 'espn' });
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

module.exports = { CHEMINS, ALIAS, normalise, meme, lis, tableau, releve, finies, reprise,
                   releveTennis, tourDe };
