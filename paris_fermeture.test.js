'use strict';
/*
 * LE PARI FERME QUAND LE MATCH COMMENCE VRAIMENT — ET QUAND IL A BOUGE.
 *
 * ---- pourquoi (08/10/2026) ----
 *
 * Deux trous, tous deux verifies dans le code ce jour-la, aucun ne touche a
 * une cote :
 *
 *  1. Le seul verrou etait l'heure du catalogue (`commence_time` de The Odds
 *     API, relu toutes les 12 h). En NHL elle tombait 9 a 10 min APRES celle
 *     d'ESPN sur 10 rencontres sur 11, et sur 12 matchs des 06-07/10 la mise
 *     en jeu reelle est tombee de +1,5 a +17,1 min apres l'heure d'ESPN —
 *     jusqu'a environ 2 min AVANT l'heure du catalogue. Et un match avance
 *     d'un jour entre deux imports restait pariable apres le vrai match.
 *  2. Une rencontre AVANCEE gardait son ancienne entree (l'identifiant porte
 *     la date) ouverte jusqu'a son ancienne heure, apres le vrai match.
 *
 * `paris.ouvert` est desormais le SEUL endroit qui dit si un pari est
 * acceptable : la vente (game.parieCombine), la liste des rencontres ouvertes
 * et la page le lisent. Cet essai le tient dans les deux sens — ce qui doit
 * fermer ferme, ce qui doit rester ouvert reste ouvert.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paris-ferme-'));
const ethers = require('ethers');
const { Game } = require('./game');
const paris = require('./paris');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const sol = (g) => Number(g.betBalanceStr(A));
const jeu = () => { const g = new Game(); g._p(A).betBalance = W(1000000); return g; };

const T0 = Date.parse('2026-10-10T23:00:00Z');
const NHL = 'nhl-20261010-bos-tor', AVANCE = 'laliga-20261011-rea-vil', OUVERT = 'laliga-20261012-bar-get';
const brut = {
  sports: [{ cle: 'foot', nom: 'Football', actif: true }, { cle: 'nhl', nom: 'NHL', actif: true }],
  matchs: [
    { id: NHL, sport: 'nhl', competition: 'NHL', domicile: 'Boston Bruins', exterieur: 'Toronto Maple Leafs',
      debut: new Date(T0).toISOString(), marches: { '1n2': { cotes: { 1: 1.85, 2: 1.95 } } } },
    /* Avancee du dimanche au samedi : l'import l'a fermee une heure avant T0. */
    { id: AVANCE, sport: 'foot', competition: 'La Liga', domicile: 'Real Madrid', exterieur: 'Villarreal',
      debut: new Date(T0 + 86400000).toISOString(), ferme: new Date(T0 - 3600000).toISOString(),
      fermeRaison: 'avancee au 2026-10-10T14:00:00.000Z',
      marches: { '1n2': { cotes: { 1: 1.45, N: 4.2, 2: 6.5 } } } },
    { id: OUVERT, sport: 'foot', competition: 'La Liga', domicile: 'Barcelona', exterieur: 'Getafe',
      debut: new Date(T0 + 2 * 86400000).toISOString(), marches: { '1n2': { cotes: { 1: 1.2, N: 6.0, 2: 12.0 } } } },
  ],
};
const f = path.join(process.env.DATA_DIR, 'cat.json');
fs.writeFileSync(f, JSON.stringify(brut));
paris.charge(f);

console.log('\n-- le validateur garde la fermeture --');
{
  const m = paris.match(AVANCE);
  eq(m.ferme, T0 - 3600000, 'la date de fermeture survit a la lecture du catalogue');
  ok(/avancee/.test(m.fermeRaison), 'et sa raison : ' + m.fermeRaison);
  eq(paris.match(OUVERT).ferme, null, 'une rencontre jamais fermee n en porte pas');
}

console.log('\n-- une rencontre fermee par l import --');
{
  const avant = T0 - 2 * 3600000, apres = T0 - 1800000;
  ok(paris.ouvert(paris.match(AVANCE), avant), 'avant sa fermeture, elle est encore ouverte');
  ok(!paris.ouvert(paris.match(AVANCE), apres), 'apres, elle est fermee — alors que son coup d envoi affiche est demain');
  ok(!paris.ouverts(apres).some((m) => m.id === AVANCE), 'elle sort de la liste des rencontres ouvertes');
  ok(paris.ouverts(apres).some((m) => m.id === OUVERT), 'sans emporter les autres');
  eq(paris.vue(paris.match(AVANCE), apres).ouvert, false, 'la page la voit fermee');
  const g = jeu(), s0 = sol(g);
  jete(() => g.parie(A, AVANCE, '1', 1000, apres), /betting is closed/, 'la vente la refuse');
  eq(sol(g), s0, 'et rien n est debite');
  jete(() => g.parieCombine(A, [{ match: OUVERT, choix: '1' }, { match: AVANCE, choix: '1' }], 1000, apres),
       /betting is closed/, 'un combine qui la contient est refuse en entier');
  g.parie(A, OUVERT, '1', 1000, apres);
  eq(sol(g), s0 - 1000, 'la rencontre voisine se parie normalement');
}

console.log('\n-- le second verrou : l heure reelle vue par ESPN --');
{
  const g = jeu();
  const NOW = T0 - 3600000;
  ok(paris.ouvert(paris.match(NHL), T0 - 12 * 60000), 'sans releve, seule compte l heure du catalogue');
  paris.poseHeuresReelles(new Map([[NHL, { quand: T0 - 10 * 60000, etat: 'pre' }]]), NOW);
  ok(paris.ouvert(paris.match(NHL), T0 - 12 * 60000), 'ESPN la prevoit 10 min plus tot : ouverte jusqu a une minute avant');
  ok(!paris.ouvert(paris.match(NHL), T0 - 11 * 60000 + 1000), 'puis fermee, 11 minutes avant l heure du catalogue');
  jete(() => g.parie(A, NHL, '1', 1000, T0 - 10 * 60000), /betting is closed/, 'la vente suit');

  /* ---- CE QUI EST FERME LE RESTE (relecture du 08/10) ----
     Une releve qui echoue rend une Map vide : elle rouvrait un match qu'ESPN
     avait vu commencer, a la cote d'avant-match, jusqu'a l'heure du catalogue. */
  paris.poseHeuresReelles(new Map([[NHL, { quand: T0 + 3600000, etat: 'in' }]]), NOW);
  ok(!paris.ouvert(paris.match(NHL), NOW), 'ESPN la voit COMMENCEE : fermee, quelle que soit l heure annoncee');
  paris.poseHeuresReelles(new Map(), NOW + 45000);
  ok(!paris.ouvert(paris.match(NHL), NOW + 50000), 'une releve qui echoue ne rouvre RIEN');
  paris.poseHeuresReelles(new Map([[NHL, { quand: T0 + 3600000, etat: 'pre' }]]), NOW + 90000);
  ok(!paris.ouvert(paris.match(NHL), NOW + 95000), 'et un match vu commence ne « redemarre » pas si ESPN repasse a pre');

  /* Une autre rencontre, une table neuve : douze heures plus tard, ce qui n'a
     plus ete relu est oublie. */
  paris.poseHeuresReelles(new Map(), T0 + 13 * 3600000);
  const LIGA = paris.match(OUVERT), TL = LIGA.debut;
  ok(paris.ouvert(LIGA, TL - 3600000), 'oubli apres douze heures : la table repart vide');
  paris.poseHeuresReelles(new Map([[OUVERT, { quand: TL + 3600000, etat: 'post' }]]), TL - 2 * 3600000);
  ok(!paris.ouvert(LIGA, TL - 2 * 3600000), 'ESPN la dit TERMINEE (avancee et jouee) : fermee, meme avec une heure future');
  paris.poseHeuresReelles(new Map(), TL + 30 * 3600000);
  paris.poseHeuresReelles(new Map([[OUVERT, { quand: TL + 3600000, etat: 'pre' }]]), TL - 3 * 3600000);
  ok(!paris.ouvert(LIGA, TL), 'une heure ESPN plus TARDIVE ne rouvre pas : on ferme au premier des deux');
  ok(paris.ouvert(LIGA, TL - 60000), 'et elle ne ferme pas plus tot que le catalogue');
  paris.poseHeuresReelles(new Map(), TL + 30 * 3600000);
  eq(paris.AVANCE_REELLE_MS, 60000, 'la marge du second verrou est d une minute');
}

console.log(`\nparis_fermeture.test.js : ${n} verifications OK`);
