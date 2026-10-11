'use strict';
/*
 * LES SCORES GRATUITS — CE QU'ILS ONT LE DROIT DE TRANCHER.
 *
 * ---- pourquoi cet essai compte plus que la moyenne ----
 *
 * Ce module dit au serveur qui a gagne. Une erreur ici ne fait pas une page
 * de travers : elle PAIE les mauvaises personnes, et personne ne s'en apercoit
 * — le score annonce est plausible, le pari se ferme, l'argent part.
 *
 * Il verrouille donc quatre choses, et trois d'entre elles sont des REFUS :
 *
 *  1. Le score sort dans NOTRE orientation, lu sur le camp qui porte le nom de
 *     notre equipe a domicile — jamais sur sa position dans le tableau.
 *  2. Deux noms differents ne se rapprochent JAMAIS tout seuls. Le
 *     rapprochement par ressemblance, essaye sur les vraies donnees, a propose
 *     « Inter Milan » -> « AC Milan » et « Rennes » -> « Lens ».
 *  3. La meme affiche a une autre date n'est pas la meme rencontre : deux
 *     clubs se rencontrent deux fois par saison.
 *  4. Une rencontre en cours n'est pas une rencontre finie.
 *
 * Les enregistrements de `bancs_espn.json` sont de VRAIES reponses d'ESPN,
 * reduites aux champs que le module lit.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const e = require('./scores_espn');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const BANCS = JSON.parse(fs.readFileSync(path.join(__dirname, 'bancs_espn.json'), 'utf8'));
const prendre = (quoi) => async (u) => {
  const p = /sports\/(.+?)\/scoreboard/.exec(String(u))[1];
  const clef = { 'soccer/ger.1': 'ger', 'soccer/ita.1': 'ita', 'football/nfl': 'nfl' }[p];
  const d = quoi || (clef && BANCS[clef]) || { events: [] };
  return { ok: true, json: async () => d };
};

// ================== 1. LES NOMS : CE QU'ON ACCEPTE, CE QU'ON REFUSE
console.log('\n-- deux sources, deux facons de nommer --');
{
  ok(e.meme('Atalanta BC', 'Atalanta'), 'Atalanta BC est Atalanta');
  ok(e.meme('Athletic Bilbao', 'Athletic Club'), 'Athletic Bilbao est Athletic Club');
  ok(e.meme('Brighton and Hove Albion', 'Brighton & Hove Albion'), '« and » et « & »');
  ok(e.meme('FSV Mainz 05', 'Mainz'), 'FSV Mainz 05 est Mainz');
  ok(e.meme('Inter Milan', 'Internazionale'), 'Inter Milan est Internazionale');
  ok(e.meme('Real Racing Club de Santander', 'Racing Santander'), 'le Racing de Santander');
  ok(e.meme('Union Berlin', '1. FC Union Berlin'), 'l Union Berlin');

  /* ---- ET LES REFUS, QUI SONT LE VRAI SUJET ---- */
  ok(!e.meme('Inter Milan', 'AC Milan'),
     'Inter Milan n est PAS l AC Milan — la ressemblance de chaines le proposait');
  ok(!e.meme('Rennes', 'Lens'), 'Rennes n est PAS Lens — elle le proposait aussi');
  ok(!e.meme('Deportivo La Coruña', 'Deportivo Alavés'),
     'le Deportivo La Corogne n est PAS le Deportivo Alaves');
  ok(!e.meme('Manchester United', 'Manchester City'), 'les deux Manchester ne se confondent pas');
  ok(!e.meme('', 'Arsenal'), 'un nom vide ne vaut personne');
}

// ================== 2. LE SCORE SORT DANS NOTRE ORIENTATION
console.log('\n-- qui recoit quel score --');
{
  const ev = (dom, ext, sd, se, quand, etat, fini) => ({
    date: quand, status: { type: { state: etat, completed: fini, shortDetail: 'x' } },
    competitions: [{ competitors: [
      { team: { displayName: dom }, score: sd }, { team: { displayName: ext }, score: se }] }],
  });
  const T = Date.parse('2026-08-29T18:00Z');
  const notre = (dom, ext) => ({ id: 'x', sport: 'foot', domicile: dom, exterieur: ext,
                                 debut: T, source: { ligue: 'soccer_ger.1' } });

  /* ESPN range Bayern en PREMIER, nous l'avons a l'exterieur. Le score doit
     sortir « Dortmund-Bayern » et non l'inverse. */
  return Promise.resolve().then(async () => {
    const inverse = { events: [ev('Bayern Munich', 'Borussia Dortmund', '3', '1',
                                  '2026-08-29T18:00Z', 'post', true)] };
    const v = await e.releve([Object.assign(notre('Borussia Dortmund', 'Bayern Munich'),
                                            { source: { ligue: 'soccer_germany_bundesliga' } })],
                             { prendre: prendre(inverse) });
    const s = v.get('x');
    ok(!!s, 'la rencontre est reconnue meme rangee a l envers');
    eq(s.score, '1-3', 'et le score sort dans NOTRE ordre : domicile d abord');
    eq(s.resultat, '2', 'donc l exterieur gagne');

    // ================== 3. LA MEME AFFICHE, UNE AUTRE DATE
    console.log('\n-- le match aller n est pas le retour --');
    const retour = { events: [ev('Borussia Dortmund', 'Bayern Munich', '0', '4',
                                 '2027-02-14T18:00Z', 'post', true)] };
    const rien = await e.releve([Object.assign(notre('Borussia Dortmund', 'Bayern Munich'),
                                               { source: { ligue: 'soccer_germany_bundesliga' } })],
                                { prendre: prendre(retour) });
    eq(rien.size, 0, 'une rencontre a six mois d ecart n est pas la notre');

    // ================== 4. EN COURS N'EST PAS FINIE
    console.log('\n-- en cours, et finie --');
    const direct = { events: [ev('Borussia Dortmund', 'Bayern Munich', '1', '1',
                                 '2026-08-29T18:00Z', 'in', false)] };
    const m = [Object.assign(notre('Borussia Dortmund', 'Bayern Munich'),
                             { source: { ligue: 'soccer_germany_bundesliga' } })];
    const enCours = await e.releve(m, { prendre: prendre(direct) });
    eq(enCours.get('x').etat, 'in', 'le direct est vu comme en cours');
    eq(enCours.get('x').score, '1-1', 'avec son score du moment');
    const paye = await e.finies(m, { prendre: prendre(direct) });
    eq(paye.length, 0, 'mais une rencontre en cours ne se REGLE pas');
    const fini = await e.finies([Object.assign(notre('Borussia Dortmund', 'Bayern Munich'),
                                               { source: { ligue: 'soccer_germany_bundesliga' } })],
                                { prendre: prendre(inverse) });
    eq(fini.length, 1, 'une rencontre finie, oui');
    eq(fini[0].score, '1-3', 'avec le meme score, dans le meme ordre');

    // ================== 5. SUR DE VRAIES REPONSES D'ESPN
    console.log('\n-- sur des reponses reelles --');
    const nfl = BANCS.nfl.events.map(e.lis).filter(Boolean);
    ok(nfl.length >= 3, `la NFL se lit (${nfl.length} rencontres)`);
    ok(nfl.some((x) => x.etat === 'in'),
       'et l une d elles est EN COURS — c est ce qu on est venu chercher');
    ok(nfl.every((x) => x.a.nom && x.b.nom), 'chacune porte ses deux camps nommes');
    const ita = BANCS.ita.events.map(e.lis).filter(Boolean);
    ok(ita.length >= 3, `la Serie A aussi (${ita.length})`);

    // ================== 6. LE TENNIS : UN VAINQUEUR, PAS UN SCORE
    console.log('\n-- le tennis, par l API interne --');
    /* Le tableau public d'ESPN ne rend que des tournois pour le tennis. Son API
     * INTERNE porte les rencontres, chacune avec ses deux joueurs nommes et un
     * `winner`. C'est ce qui debloque notre plus gros sport — et surtout, cette
     * source-la se demande PAR DATE : elle n'a pas la fenetre de trois jours qui
     * laissait des paris en attente indefiniment. */
    const TEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'bancs_espn_tennis.json'), 'utf8'));
    const prendreTennis = async (u) => ({ ok: true, json: async () =>
      (/\/events\?/.test(String(u)) ? TEN.index : TEN.tournoi) });
    const joueur = (id, dom, ext, quand) => ({
      id, sport: 'tennis', domicile: dom, exterieur: ext, debut: Date.parse(quand),
      source: { ligue: 'tennis_atp_us_open' } });
    const lot = [
      joueur('t1', 'Pierre-Hugues Herbert', 'Kenta Miyoshi', '2026-08-22T15:00Z'),
      joueur('t2', 'Luca Pow', 'Felix Balshaw', '2026-08-22T15:00Z'),   // range a l envers
      joueur('t3', 'Arthur Fery', 'Aleksandar Kovacevic', '2026-08-28T00:20Z'), // en cours
      joueur('t4', 'Zhang Shuai', 'Kenta Miyoshi', '2026-08-22T15:00Z'), // nom inconnu ici
    ];
    const vt = await e.releveTennis(lot, { prendre: prendreTennis });
    eq(vt.get('t1') && vt.get('t1').resultat, '1',
       'le joueur a domicile a gagne : resultat 1');
    eq(vt.get('t2') && vt.get('t2').resultat, '2',
       'et range a l envers, le resultat suit NOS noms, pas l ordre du tableau');
    ok(vt.get('t3') && !vt.get('t3').fini,
       'une rencontre sans vainqueur n est pas finie — on ne tranche pas');
    ok(!vt.has('t4'),
       'un joueur qu on ne reconnait pas ne se rapproche de personne');
    const payables = await e.finies(lot, { prendre: prendreTennis });
    eq(payables.length, 2, 'deux rencontres seulement sont reglables');
    ok(payables.every((x) => x.resultat && !x.score),
       'et elles portent une LETTRE, pas un score : un tennis se compte en sets');

    eq(e.tourDe('tennis_wta_us_open'), 'wta', 'le tour se lit sur la ligue');
    eq(e.tourDe('soccer_epl'), null, 'et le football n en a pas');

    // ================== 7. UNE SOURCE QUI TOMBE NE CASSE RIEN
    console.log('\n-- ESPN injoignable --');
    const mort = async () => { throw new Error('reseau coupe'); };
    const vide = await e.releve(m, { prendre: mort });
    eq(vide.size, 0, 'une panne rend une liste vide');
    const refus = await e.releve(m, { prendre: async () => ({ ok: false, status: 503 }) });
    eq(refus.size, 0, 'un 503 aussi — et aucun des deux ne jette');

    // ================== 8. UNE LIGUE QU'ON NE SUIT PAS
    const inconnue = await e.releve([{ id: 'y', sport: 'tennis', domicile: 'A', exterieur: 'B',
                                       debut: T, source: { ligue: 'tennis_atp_us_open' } }],
                                    { prendre: prendre({ events: [] }) });
    eq(inconnue.size, 0,
       'le tennis n est pas demande : le tableau d ESPN ne rend que des tournois');

    // ================== 9. ESPN REFUSE TOUTE FENETRE (08/10/2026)
    /* Le vrai tableau, relu le 08/10 : `dates=A-B` rend 400 « Failed to get
     * events endpoint. », meme A-A ; un jour AAAAMMJJ et un mois AAAAMM
     * passent. Le 400 etait avale en liste vide : plus de direct, plus de
     * reglement gratuit, plus de dates de reprise, sans un mot au journal.
     * Ce faux ESPN se comporte comme le vrai, et l'on regarde les trois
     * chemins rendre quelque chose. */
    console.log('\n-- ESPN refuse les fenetres de dates --');
    const urls = [];
    const commeLeVrai = (evs) => async (u) => {
      urls.push(String(u));
      const q = /dates=([^&]+)/.exec(String(u))[1];
      if (/^\d{8}-\d{8}$/.test(q)) return { ok: false, status: 400 };
      const garde = evs.filter((x) => (q.length === 8 ? x.date.slice(0, 10).replace(/-/g, '') === q
                                                        : x.date.slice(0, 7).replace('-', '') === q));
      return { ok: true, json: async () => ({ events: garde }) };
    };
    const evId = (id, dom, ext, sd, se, quand, etat, fini) =>
      Object.assign(ev(dom, ext, sd, se, quand, etat, fini), { id });
    const D = (dom, ext, quand, id) => ({ id, sport: 'foot', domicile: dom, exterieur: ext, debut: Date.parse(quand),
                                           source: { ligue: 'soccer_germany_bundesliga' } });
    const finis = [evId('1', 'Borussia Dortmund', 'Bayern Munich', '0', '2', '2026-09-12T16:30Z', 'post', true),
                   evId('2', 'FC Augsburg', 'SC Freiburg', '1', '1', '2026-10-04T13:30Z', 'post', true),
                   evId('3', 'Werder Bremen', 'VfB Stuttgart', '2', '2', '2026-10-08T18:30Z', 'in', false)];

    const lu = await e.releve([D('Werder Bremen', 'VfB Stuttgart', '2026-10-08T18:30Z', 'w')],
                              { prendre: commeLeVrai(finis) });
    eq(lu.get('w') && lu.get('w').score, '2-2', 'le direct revient : la rencontre en cours est vue, avec son score');
    ok(urls.every((u) => !/dates=\d{8}-\d{8}/.test(u)), 'et plus aucune fenetre n est demandee (' + urls.length + ' requetes)');
    ok(urls.every((u) => /dates=\d{8}$/.test(u)), 'le direct (trois jours) se demande JOUR par jour, jamais un mois de 7 Mo');

    urls.length = 0;
    const regles = await e.finies([D('Borussia Dortmund', 'Bayern Munich', '2026-09-12T16:30Z', 'a'),
                                   D('FC Augsburg', 'SC Freiburg', '2026-10-04T13:30Z', 'b'),
                                   D('Werder Bremen', 'VfB Stuttgart', '2026-10-08T18:30Z', 'c')],
                                  { prendre: commeLeVrai(finis) });
    eq(regles.map((x) => x.id).sort().join(','), 'a,b',
       'le reglement gratuit revient sur un mois d ecart : les deux finies, pas celle en cours');
    ok(urls.length && urls.every((u) => /dates=\d{6}&limit=1000$/.test(u)),
       'une fenetre de plus de ' + e.JOURS_MAX + ' jours se demande MOIS par mois, sans plafond de 25 rencontres');

    const quand = await e.reprise(['soccer_germany_bundesliga'], { maintenant: Date.parse('2026-10-08T12:00Z'),
      prendre: commeLeVrai([evId('9', 'Hamburger SV', 'Union Berlin', '0', '0', '2026-11-21T14:30Z', 'pre', false)]) });
    eq(quand, Date.parse('2026-11-21T14:30Z'), 'la date de reprise revient, six semaines plus loin');

    eq(e.requetes(Date.parse('2026-10-07T22:00Z'), Date.parse('2026-10-09T01:00Z')).join(' '), '20261007 20261008 20261009',
       'trois jours, trois requetes');
    eq(e.requetes(Date.parse('2026-10-31T23:00Z'), Date.parse('2026-12-02T00:00Z')).join(' '),
       '202610&limit=1000 202611&limit=1000 202612&limit=1000', 'a cheval sur trois mois, trois mois');
    const doublon = await e.tableau('soccer/ger.1', Date.parse('2026-10-07T00:00Z'), Date.parse('2026-10-09T00:00Z'),
      async () => ({ ok: true, json: async () => ({ events: [finis[2]] }) }));
    eq(doublon.length, 1, 'une rencontre rendue par trois journees qui se recouvrent n est gardee qu une fois');
    const troue = await e.tableau('soccer/ger.1', Date.parse('2026-10-07T00:00Z'), Date.parse('2026-10-09T00:00Z'),
      async (u) => (/20261008/.test(u) ? { ok: false, status: 503 } : { ok: true, json: async () => ({ events: [finis[2]] }) }));
    eq(troue.length, 1, 'une journee qui tombe n emporte qu elle-meme, pas les autres');

    // ================== 10. LE FOOTBALL SE REGLE A 90 MINUTES (08/10/2026)
    /* Statuts relus le 08/10 sur de vraies reponses : finale de la Coupe du Roi
     * 2025, Barcelona 3-2 Real Madrid, STATUS_FINAL_AET (2-2 a 90') ; C1 du
     * 11/03/2025, Liverpool–PSG et Atletico–Real, STATUS_FINAL_PEN ; tout le
     * reste STATUS_FULL_TIME. Le score rendu compte la prolongation. */
    console.log('\n-- le football se regle a 90 minutes --');
    const avecStatut = (x, nom) => Object.assign(x, { status: { type: Object.assign({}, x.status.type, { name: nom }) } });
    const finale = [avecStatut(evId('cdr', 'Barcelona', 'Real Madrid', '3', '2', '2025-04-26T20:00Z', 'post', true), 'STATUS_FINAL_AET')];
    const nous = (dom, ext, quand, id, sport, ligue) => ({ id, sport: sport || 'foot', domicile: dom, exterieur: ext,
      debut: Date.parse(quand), source: { ligue: ligue || 'soccer_spain_la_liga' } });
    const aet = await e.finies([nous('Barcelona', 'Real Madrid', '2025-04-26T20:00Z', 'cdr')], { prendre: commeLeVrai(finale) });
    eq(aet.length, 1, 'la finale prolongee RESTE dans la liste — sinon The Odds API la reprendrait, prolongation comprise');
    ok(aet[0].aMain && /STATUS_FINAL_AET/.test(aet[0].aMain), 'mais marquee a regler a la main : ' + (aet[0].aMain || 'rien'));
    const tab = [avecStatut(evId('pen', 'Atletico Madrid', 'Real Madrid', '1', '0', '2025-03-12T20:00Z', 'post', true), 'STATUS_FINAL_PEN')];
    const pen = await e.finies([nous('Atletico Madrid', 'Real Madrid', '2025-03-12T20:00Z', 'pen', 'foot', 'soccer_uefa_champs_league')],
                               { prendre: commeLeVrai(tab) });
    ok(pen[0] && /STATUS_FINAL_PEN/.test(pen[0].aMain || ''), 'les tirs au but aussi');
    const ft = [avecStatut(evId('ft', 'Barcelona', 'Getafe', '2', '0', '2026-10-10T19:00Z', 'post', true), 'STATUS_FULL_TIME')];
    const net = await e.finies([nous('Barcelona', 'Getafe', '2026-10-10T19:00Z', 'ft')], { prendre: commeLeVrai(ft) });
    ok(net[0] && !net[0].aMain && net[0].score === '2-0', 'un temps reglementaire declare se regle seul, comme avant');
    const sansNom = await e.finies([nous('Barcelona', 'Getafe', '2026-10-10T19:00Z', 'sn')],
      { prendre: commeLeVrai([evId('sn', 'Barcelona', 'Getafe', '2', '0', '2026-10-10T19:00Z', 'post', true)]) });
    ok(sansNom[0] && sansNom[0].aMain, 'un football fini SANS statut lisible part a la main (liste blanche, pas liste noire)');
    const nhl = await e.finies([nous('Boston Bruins', 'Toronto Maple Leafs', '2026-10-10T23:00Z', 'h', 'nhl', 'icehockey_nhl')],
      { prendre: commeLeVrai([avecStatut(evId('h', 'Boston Bruins', 'Toronto Maple Leafs', '3', '2', '2026-10-10T23:00Z', 'post', true), 'STATUS_FINAL_OT')]) });
    ok(nhl[0] && !nhl[0].aMain, 'la NHL n est pas concernee : son vainqueur se regle prolongation comprise, comme tous les livres');

    // ================== 10bis. LES HUIT COUPES (lot 6, 11/10/2026)
    /* Les huit chemins, chacun HTTP 200 le 11/10/2026 depuis ce depot (mois
     * 202610 et 202611). Et la regle des 90 minutes vaut pour une coupe : la
     * rencontre ci-dessous est REELLE, Copa del Rey du 04/10/2026, 0-0 en
     * STATUS_FINAL_PEN (tableau ESPN relu le 11/10, champs reduits). */
    console.log('\n-- les huit coupes --');
    const CHEMINS_COUPES = { soccer_uefa_europa_league: 'soccer/uefa.europa', soccer_uefa_europa_conference_league: 'soccer/uefa.europa.conf',
      soccer_fa_cup: 'soccer/eng.fa', soccer_england_efl_cup: 'soccer/eng.league_cup', soccer_germany_dfb_pokal: 'soccer/ger.dfb_pokal',
      soccer_spain_copa_del_rey: 'soccer/esp.copa_del_rey', soccer_italy_coppa_italia: 'soccer/ita.coppa_italia',
      soccer_france_coupe_de_france: 'soccer/fra.coupe_de_france' };
    for (const [k, v] of Object.entries(CHEMINS_COUPES)) eq(e.CHEMINS[k], v, 'le tableau ESPN de ' + k + ' : ' + v);
    eq(Object.keys(CHEMINS_COUPES).length, 8, 'huit coupes, ni plus ni moins');
    const tir = [avecStatut(evId('401918761', 'Tavernes de la Valldigna', 'Maracena', '0', '0', '2026-10-04T16:00Z', 'post', true), 'STATUS_FINAL_PEN')];
    const cdr = await e.finies([nous('Tavernes de la Valldigna', 'Maracena', '2026-10-04T16:00Z', 'tav', 'foot', 'soccer_spain_copa_del_rey')],
                               { prendre: commeLeVrai(tir) });
    ok(cdr.length === 1 && /STATUS_FINAL_PEN/.test(cdr[0].aMain || ''), 'une coupe aux tirs au but part a la main, le football reste regle a 90 minutes : ' + ((cdr[0] && cdr[0].aMain) || 'rien'));
    /* Un VAINQUEUR a 90 minutes (1-0 en STATUS_FULL_TIME) : le score est celui
     * des 90 minutes, il se lit. CONSTAT DATE, NON TENU ICI (relecture du
     * 11/10/2026) : ESPN rend aussi un NUL en STATUS_FULL_TIME sur un tour a
     * elimination directe (SD Noja 1-1 Ribadesella, Copa del Rey du
     * 04/10/2026, EXPLOITATION 8.11) — un tel match ne finit pas sur un nul,
     * le statut des tours amateurs n'est pas sur. Rien n'est vendu dans ce
     * lot ; le lot 10 doit envoyer a la main un nul en STATUS_FULL_TIME d'un
     * tour a elimination directe (pas la phase de ligue des coupes
     * europeennes, ni une manche aller) avant de vendre une coupe nationale.
     * Aucun essai ne fige le comportement actuel sur ce nul. */
    const ftCoupe = [avecStatut(evId('401918757', 'Sporting de Alcazar', 'CP Talayuela', '1', '0', '2026-10-04T15:30Z', 'post', true), 'STATUS_FULL_TIME')];
    const cdr2 = await e.finies([nous('Sporting de Alcazar', 'CP Talayuela', '2026-10-04T15:30Z', 'spa', 'foot', 'soccer_spain_copa_del_rey')],
                                { prendre: commeLeVrai(ftCoupe) });
    ok(cdr2.length === 1 && !cdr2[0].aMain && cdr2[0].score === '1-0', 'une coupe gagnee a 90 minutes (1-0, STATUS_FULL_TIME) donne son score : aucune prolongation n a pu le changer');
    ok(!Object.keys(e.ALIAS).some((k) => /maracena|tavernes|alcazar|talayuela|copenhagen|kobenhavn/.test(k)), 'aucun alias de coupe ecrit d avance (releves sur l inventaire, jamais devines)');

    // ================== 11. UNE SERIE : LE MATCH LE PLUS PROCHE, PAS LE PREMIER
    /* MLB en octobre : les memes equipes jouent trois jours de suite. Le
     * match 1 est a 24 h du match 2, dans la tolerance de 36 h. On prenait le
     * premier venu : le match 2 du catalogue se serait regle avec le score de
     * la veille. */
    console.log('\n-- une serie de matchs consecutifs --');
    const serie = [
      avecStatut(evId('g1', 'New York Yankees', 'Boston Red Sox', '7', '1', '2026-10-09T23:08Z', 'post', true), 'STATUS_FINAL'),
      evId('g2', 'New York Yankees', 'Boston Red Sox', '0', '0', '2026-10-10T23:08Z', 'pre', false),
    ];
    const deux = await e.releve([nous('New York Yankees', 'Boston Red Sox', '2026-10-10T23:08Z', 'm2', 'mlb', 'baseball_mlb')],
                                { prendre: commeLeVrai(serie) });
    eq(deux.get('m2') && deux.get('m2').etat, 'pre', 'le match 2 est apparie au match 2 d ESPN, pas au match 1 deja fini');
    const regle2 = await e.finies([nous('New York Yankees', 'Boston Red Sox', '2026-10-10T23:08Z', 'm2', 'mlb', 'baseball_mlb')],
                                  { prendre: commeLeVrai(serie) });
    eq(regle2.length, 0, 'et il ne se regle PAS avec le 7-1 de la veille');
    const double = [
      evId('d1', 'New York Yankees', 'Boston Red Sox', '3', '1', '2026-10-11T17:05Z', 'post', true),
      evId('d2', 'New York Yankees', 'Boston Red Sox', '0', '0', '2026-10-11T18:20Z', 'pre', false),
    ];
    const ambigu = await e.releve([nous('New York Yankees', 'Boston Red Sox', '2026-10-11T17:40Z', 'dd', 'mlb', 'baseball_mlb')],
                                  { prendre: commeLeVrai(double) });
    eq(ambigu.size, 0, 'deux candidats a moins de deux heures l un de l autre : on n apparie PAS, la main tranchera');
    ok(deux.get('m2').quand === Date.parse('2026-10-10T23:08Z'), 'la releve rend l heure prevue par ESPN (le second verrou la lit)');
    /* La journee du match 2 ne repond pas (503) : le match 1, a 24 h, restait
       seul candidat — donc « le plus proche ». Hors football, 12 h de tolerance. */
    const troueSerie = async (u) => (/dates=20261010/.test(String(u)) ? { ok: false, status: 503 } : commeLeVrai(serie)(u));
    const seul = await e.finies([nous('New York Yankees', 'Boston Red Sox', '2026-10-10T23:08Z', 'm2', 'mlb', 'baseball_mlb')],
                                { prendre: troueSerie });
    eq(seul.length, 0, 'journee du match 2 tombee : le match 2 ne se regle PAS avec le score du match 1');
    /* Programme double : 13:05 (fini) et 17:10 (a venir), 4 h 05 d'ecart ; le
       catalogue dit 15:30. Les deux candidats sont bien distincts : on prend le
       plus proche (17:10), on ne refuse pas. */
    const asym = [
      evId('a1', 'New York Yankees', 'Boston Red Sox', '4', '2', '2026-10-12T13:05Z', 'post', true),
      evId('a2', 'New York Yankees', 'Boston Red Sox', '0', '0', '2026-10-12T17:10Z', 'pre', false),
    ];
    const pris = await e.releve([nous('New York Yankees', 'Boston Red Sox', '2026-10-12T15:30Z', 'as', 'mlb', 'baseball_mlb')],
                                { prendre: commeLeVrai(asym) });
    eq(pris.get('as') && pris.get('as').quand, Date.parse('2026-10-12T17:10Z'),
       'deux candidats a plus de 2 h l un de l autre : le plus proche, meme s il n est pas a moins de 2 h de nous');

    // ================== 12. UN REFUS SE COMPTE
    console.log('\n-- un refus se compte --');
    const avantRefus = (e.refusDuJour()['soccer/esp.1'] || { refus: 0 }).refus;
    await e.tableau('soccer/esp.1', Date.parse('2026-10-08T00:00Z'), Date.parse('2026-10-08T00:00Z'),
                    async () => ({ ok: false, status: 400 }));
    const apresRefus = e.refusDuJour()['soccer/esp.1'];
    ok(apresRefus && apresRefus.refus === avantRefus + 1 && /400/.test(apresRefus.dernier),
       'un 400 d ESPN est compte et garde sa raison : ' + JSON.stringify(apresRefus));
    await e.tableau('soccer/esp.1', Date.parse('2026-10-08T00:00Z'), Date.parse('2026-10-08T00:00Z'),
                    async () => { throw new Error('reseau coupe'); });
    eq(e.refusDuJour()['soccer/esp.1'].refus, avantRefus + 2, 'une coupure aussi');

    // ================== 13. DEUX ISSUES : LE TIR AU BUT, ET LE MONEYLINE DRAFTKINGS (lot 3, 10/10/2026)
    /* Reponses ESPN REELLES reduites (bancs_espn_deux_issues.json) : EDM 3 -
     * LA 4 du 10/01/2026, Final/SO, cinq periodes — le tir au but vainqueur
     * compte un but, le score n'est jamais egal (52 matchs NHL du 10 au
     * 15/01 : 12 au-dela du temps reglementaire, 0 egal) ; et BOS - PHI du
     * 10/10/2026 avant le coup d'envoi, moneyline DraftKings close -135 / +114,
     * open -130 / +110. */
    console.log('\n-- deux issues : tir au but, moneyline DraftKings --');
    const B2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'bancs_espn_deux_issues.json'), 'utf8'));
    const so = B2.nhl_so.events[0], pre = B2.nhl_pre.events[0];
    const nhlNous = (dom, ext, quand, id) => ({ id, sport: 'nhl', domicile: dom, exterieur: ext, debut: Date.parse(quand), source: { ligue: 'icehockey_nhl' } });
    const regleSo = await e.finies([nhlNous('Edmonton Oilers', 'Los Angeles Kings', '2026-01-11T03:00Z', 'so1')], { prendre: commeLeVrai([so]) });
    eq(regleSo.length, 1, 'le match fini aux tirs au but se regle');
    eq(regleSo[0] && regleSo[0].score, '3-4', 'avec le score ESPN, tir au but compris (3-4)');
    eq(regleSo[0] && regleSo[0].resultat, '2', 'donc l exterieur gagne : jamais un nul au hockey');
    ok(regleSo[0] && !regleSo[0].aMain, 'et sans passer a la main (la regle des 90 minutes ne touche que le football)');
    /* lis : les champs d'avant ne bougent pas, le moneyline s'ajoute par camp */
    const l = e.lis(pre);
    eq(JSON.stringify({ a: l.a.nom, b: l.b.nom, pa: l.a.points, pb: l.b.points, quand: l.quand, etat: l.etat, fini: l.fini, statut: l.statut, detail: l.detail }),
       JSON.stringify({ a: 'Boston Bruins', b: 'Philadelphia Flyers', pa: 0, pb: 0, quand: Date.parse('2026-10-10T17:00Z'), etat: 'pre', fini: false, statut: 'STATUS_SCHEDULED', detail: '10/10 - 1:00 PM EDT' }),
       'lis : noms, points, heure, etat, statut, detail inchanges');
    ok(Math.abs(l.a.ml - (1 + 100 / 135)) < 1e-9 && Math.abs(l.b.ml - 2.14) < 1e-9, `lis expose le moneyline CLOSE par camp (${l.a.ml.toFixed(4)} / ${l.b.ml})`);
    eq(l.fournisseur, 'DraftKings', 'et son fournisseur');
    ok(Math.abs(e.americaine('-142') - 1.704225) < 1e-6 && e.americaine('+120') === 2.2, 'cote americaine : -142 -> 1,7042 ; +120 -> 2,20');
    ok(e.americaine('EVEN') === null && e.americaine('-50') === null && e.americaine('') === null, 'rien de devine : EVEN, -50, vide -> null');
    /* releve : orientee sur NOTRE domicile, lue sur le homeAway du camp — jamais sur sa position dans le tableau */
    const dkDe = async (evx, dom, ext, sport, ligue) => (await e.releve([Object.assign(nhlNous(dom, ext, '2026-10-10T17:00Z', 'k'), { sport: sport || 'nhl', source: { ligue: ligue || 'icehockey_nhl' } })],
                                                         { prendre: commeLeVrai([evx]) })).get('k');
    const droit = await dkDe(pre, 'Boston Bruins', 'Philadelphia Flyers');
    ok(droit && droit.dk && Math.abs(droit.dk[1] - (1 + 100 / 135)) < 1e-9 && Math.abs(droit.dk[2] - 2.14) < 1e-9 && droit.dk.fournisseur === 'DraftKings',
       'notre domicile = celui d ESPN : dk = { 1: 1,7407, 2: 2,14, DraftKings }');
    const envers = await dkDe(pre, 'Philadelphia Flyers', 'Boston Bruins');
    ok(envers && envers.dk && Math.abs(envers.dk[1] - 2.14) < 1e-9 && Math.abs(envers.dk[2] - (1 + 100 / 135)) < 1e-9,
       'notre domicile = l exterieur d ESPN : les cotes suivent les equipes (1 = Philadelphie, +114)');
    const permute = JSON.parse(JSON.stringify(pre));
    permute.competitions[0].competitors.reverse();
    const perm = await dkDe(permute, 'Philadelphia Flyers', 'Boston Bruins');
    ok(perm && perm.dk && Math.abs(perm.dk[1] - 2.14) < 1e-9,
       'le tableau range l exterieur EN PREMIER : la cote se lit sur homeAway, pas sur la position (G7)');
    eq(JSON.stringify([droit.score, droit.resultat, droit.fini, droit.etat, droit.statut]), JSON.stringify(['0-0', 'N', false, 'pre', 'STATUS_SCHEDULED']),
       'releve : score, resultat, fini, etat, statut inchanges');
    /* close seulement : un lot qui n'a que `open` ne donne AUCUNE cote */
    const ouvert = JSON.parse(JSON.stringify(pre));
    for (const side of ['home', 'away']) delete ouvert.competitions[0].odds[0].moneyline[side].close;
    const sansClose = await dkDe(ouvert, 'Boston Bruins', 'Philadelphia Flyers');
    ok(sansClose && !sansClose.dk && sansClose.dkSansClose === true, 'open sans close : aucune cote (jamais de repli sur open), et c est dit (dkSansClose)');
    /* un objet odds bancal ne fait pas perdre le score */
    const bancal = JSON.parse(JSON.stringify(so));
    bancal.competitions[0].odds = [{ provider: null, moneyline: { home: { close: { odds: { pas: 'un nombre' } } }, away: 7 } }];
    const lb = e.lis(bancal);
    ok(lb && lb.a.points === 3 && lb.b.points === 4 && lb.a.ml === null && lb.b.ml === null, 'un objet odds bancal : le score reste lu, aucune cote');
    /* le football ne porte jamais de dk (trois issues) */
    const foot = JSON.parse(JSON.stringify(pre));
    foot.competitions[0].competitors[0].team.displayName = 'Borussia Dortmund';
    foot.competitions[0].competitors[1].team.displayName = 'Bayern Munich';
    const vf = await dkDe(foot, 'Borussia Dortmund', 'Bayern Munich', 'foot', 'soccer_germany_bundesliga');
    ok(vf && !('dk' in vf) && !('dkSansClose' in vf), 'un match de football ne porte pas de dk');

    console.log(`\nscores_espn.test.js : ${n} verifications OK`);
  });
}
