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

    console.log(`\nscores_espn.test.js : ${n} verifications OK`);
  });
}
