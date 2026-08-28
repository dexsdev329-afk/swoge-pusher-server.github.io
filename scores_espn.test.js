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

    // ================== 6. UNE SOURCE QUI TOMBE NE CASSE RIEN
    console.log('\n-- ESPN injoignable --');
    const mort = async () => { throw new Error('reseau coupe'); };
    const vide = await e.releve(m, { prendre: mort });
    eq(vide.size, 0, 'une panne rend une liste vide');
    const refus = await e.releve(m, { prendre: async () => ({ ok: false, status: 503 }) });
    eq(refus.size, 0, 'un 503 aussi — et aucun des deux ne jette');

    // ================== 7. UNE LIGUE QU'ON NE SUIT PAS
    const inconnue = await e.releve([{ id: 'y', sport: 'tennis', domicile: 'A', exterieur: 'B',
                                       debut: T, source: { ligue: 'tennis_atp_us_open' } }],
                                    { prendre: prendre({ events: [] }) });
    eq(inconnue.size, 0,
       'le tennis n est pas demande : le tableau d ESPN ne rend que des tournois');

    console.log(`\nscores_espn.test.js : ${n} verifications OK`);
  });
}
