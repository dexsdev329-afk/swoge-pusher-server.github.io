'use strict';
/*
 * CE QUE LES JOUEURS TOUCHENT.
 *
 * L'ordre des rangees du tiroir a ete decide au jugement. Ces compteurs le
 * remplacent par une mesure — mais ils viennent du CLIENT, et c'est la seule
 * chose qui compte ici : n'importe qui peut envoyer ce message a la main.
 *
 * Le degat serait faible (ils n'aident qu'a reordonner un menu), mais un
 * chiffre qu'on sait faux ne sert plus a rien du tout — et on ne le
 * decouvrirait que le jour ou l'on s'en sert. Ce fichier tient donc surtout
 * les BORNES.
 */
const assert = require('assert');
const { Game } = require('./game');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---- ce qui rentre
{
  const g = new Game();
  eq(g.noteTaps({ 'menu:lb': 4, 'bar:profil': 2, 'jeu:crash': 9 }), 15, 'les trois familles rentrent');
  eq(g.taps['menu:lb'], 4, 'et le compte est le bon');
  g.noteTaps({ 'menu:lb': 3 });
  eq(g.taps['menu:lb'], 7, 'les envois s additionnent');
}

// ---- ce qui NE rentre PAS
{
  const g = new Game();
  const pris = g.noteTaps({
    'MENU:MAJUSCULES': 5,          // la forme est fixee, majuscules comprises
    'autre:chose': 5,              // famille inconnue
    'menu:avec espace': 5,         // caracteres hors de la liste
    'sansfamille': 5,
    ['menu:' + 'x'.repeat(41)]: 5, // clef trop longue
    'menu:ok': 3,
  });
  eq(pris, 3, 'seule la clef bien formee est comptee');
  eq(Object.keys(g.taps).length, 1, 'et une seule clef existe');
  eq(g.taps['menu:ok'], 3, 'celle-la');
}

// ---- les bornes contre le mensonge
{
  const g = new Game();
  g.noteTaps({ 'menu:lb': 999999 });
  eq(g.taps['menu:lb'], 100, 'un million de touches annonce en vaut cent au plus');

  const gros = {};
  for (let i = 0; i < 200; i++) gros['menu:c' + i] = 50;
  const g2 = new Game();
  g2.noteTaps(gros);
  ok(Object.keys(g2.taps).length <= 60,
     `${Object.keys(g2.taps).length} clefs retenues sur deux cents envoyees`);

  /* Un negatif ne retire rien : sinon on efface les compteurs des autres. */
  const g3 = new Game();
  g3.noteTaps({ 'menu:lb': 10 });
  g3.noteTaps({ 'menu:lb': -1000 });
  eq(g3.taps['menu:lb'], 10, 'un compte negatif ne retire rien');

  /* Et rien de tout ca ne jette. */
  const g4 = new Game();
  [null, undefined, 'texte', 42, [], { 'menu:a': 'beaucoup' }].forEach((x) => g4.noteTaps(x));
  ok(true, 'les entrees absurdes sont ignorees sans lever');
}

// ---- le classement d'administration
{
  const g = new Game();
  g.noteTaps({ 'menu:sh': 30, 'menu:lb': 10, 'bar:profil': 8, 'jeu:crash': 5, 'jeu:plinko': 15 });
  const a = g.tapsAdmin();
  eq(a.menu.lignes[0].cle, 'sh', 'la rangee la plus touchee arrive en tete');
  eq(a.menu.total, 40, 'le total de la famille');
  eq(a.menu.lignes[0].pct, 75, 'et le pourcentage DANS SA FAMILLE');
  /* Le pourcentage est par famille et non sur l'ensemble : comparer une
     rangee de menu a une tuile de jeu n'a pas de sens, elles n'ont ni la meme
     surface ni le meme nombre d'occasions d'etre touchees. */
  eq(a.jeu.lignes[0].cle, 'plinko', 'et chaque famille se classe contre elle-meme');
  eq(a.jeu.lignes[0].pct, 75, 'avec son propre total');
}

// ---- ils survivent au redemarrage
{
  const g = new Game();
  g.noteTaps({ 'menu:lb': 12, 'jeu:crash': 3 });
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.taps['menu:lb'], 12,
     'les compteurs traversent une sauvegarde — sans ca, chaque redeploiement ' +
     'remettrait la mesure a zero et on n en aurait jamais assez pour decider');
  eq(g2.tapsAdmin().jeu.lignes[0].n, 3, 'et le classement se refait dessus');
}

// ---- AUCUNE ADRESSE la-dedans
{
  const g = new Game();
  g.noteTaps({ 'menu:lb': 5 });
  const json = JSON.stringify(g.taps);
  ok(!/0x[0-9a-f]{6,}/i.test(json),
     'les compteurs ne portent aucune adresse : la question est « quelle rangee sert », ' +
     'pas « que fait tel joueur »');
}

console.log(`taps.test.js : ${n} verifications OK`);
