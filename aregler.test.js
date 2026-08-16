/* La liste « en attente de resultat » doit montrer TOUTES les rencontres
   jouees et non tranchees, pas seulement celles sur lesquelles on a mise. */
const assert = require('assert');
const path = require('path').join(__dirname, '/');
const paris = require(path + 'paris.js');

const cat = paris.catalogue();
const t = Date.parse('2026-08-16T09:00:00Z');       // le lendemain des matchs
const joues = cat.matchs.filter((m) => m.debut <= t);

/* On rejoue la fonction sur un moteur minimal : ce qu'on teste est le TRI,
   pas le moteur. On lui donne un seul pari, sur un seul match. */
const { Game } = require(path + 'game.js');
const g = Object.create(Game.prototype);
g.parisRegles = {};
g.paris = [{ addr: '0xaaa', mise: 100, rapport: 250, regle: false,
             jambes: [{ match: joues[0].id, choix: '1' }] }];

const liste = g.parisAregler(t);
console.log('  rencontres jouees au catalogue :', joues.length);
console.log('  rendues par parisAregler       :', liste.length);
const avecParis = liste.filter((x) => x.paris > 0);
const sansParis = liste.filter((x) => x.paris === 0);
console.log('  dont avec paris :', avecParis.length, '| sans paris :', sansParis.length);

assert.strictEqual(liste.length, joues.length,
  'toutes les rencontres jouees doivent etre listees');
assert.strictEqual(avecParis.length, 1, 'une seule porte un pari');
assert.strictEqual(avecParis[0].id, joues[0].id, 'et c est la bonne');
assert.ok(sansParis.every((x) => x.joueurs === 0 && x.mise === 0),
  'celles sans pari s affichent a zero');

/* Une rencontre tranchee sort de la liste. */
g.parisRegles[joues[3].id] = { t: t, resultat: '1' };
assert.strictEqual(g.parisAregler(t).length, joues.length - 1,
  'une rencontre tranchee ne revient pas');

/* Une rencontre pas encore jouee n'y entre pas. */
const avant = g.parisAregler(Date.parse('2026-08-15T14:00:00Z'));
assert.ok(avant.length < joues.length, 'avant le coup d envoi, rien');
console.log('  a 14h le 15/08 (avant les premiers matchs) :', avant.length);

console.log('\nTout passe.\n');
