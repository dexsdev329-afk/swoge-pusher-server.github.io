'use strict';
/*
 * LA MARTINGALE DU MODE BLACKJACK (blackjack.js) — déterministe, tenue par le
 * serveur pour que le modèle n'oublie jamais de doubler après une perte ni de
 * revenir à la base après un gain (le manque signalé) :
 *   1. départ à la base ; perte -> double ; gain/blackjack -> base ; push -> rien ;
 *   2. le plafond : doubler au-delà casse la progression -> retour à la base ;
 *   3. les issues se lisent dans plusieurs formulations (win/won, lose/bust…).
 */
const BJ = require('./blackjack');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- 1. la progression de base --');
ok(BJ.premiereMise({ base: 1 }) === 1, 'la premiere mise est la base');
ok(BJ.prochaineMise({ base: 1, cap: 100, mise: 1, issue: 'lose' }) === 2, 'perte : on double (1 -> 2)');
ok(BJ.prochaineMise({ base: 1, cap: 100, mise: 2, issue: 'lose' }) === 4, 'perte encore : 2 -> 4');
ok(BJ.prochaineMise({ base: 1, cap: 100, mise: 8, issue: 'win' }) === 1, 'gain : retour a la base (8 -> 1)');
ok(BJ.prochaineMise({ base: 1, cap: 100, mise: 8, issue: 'blackjack' }) === 1, 'blackjack : retour a la base aussi');
ok(BJ.prochaineMise({ base: 1, cap: 100, mise: 4, issue: 'push' }) === 4, 'egalite (push) : la mise ne bouge pas');
ok(BJ.prochaineMise({ base: 1, cap: 100, mise: 4, issue: null }) === 4, 'rien de rapporte : la mise ne bouge pas');

console.log('\n-- 2. le plafond casse la progression (retour base) --');
ok(BJ.prochaineMise({ base: 1, cap: 50, mise: 32, issue: 'lose' }) === 1, '32 -> 64 depasse 50 : on repart de la base');
ok(BJ.prochaineMise({ base: 1, cap: 64, mise: 32, issue: 'lose' }) === 64, '32 -> 64 tient dans un plafond de 64');
ok(BJ.prochaineMise({ base: 5, cap: 1000, mise: 5, issue: 'lose' }) === 10, 'une base a 5 : 5 -> 10');
ok(BJ.prochaineMise({ base: 5, cap: 1000, mise: 40, issue: 'win' }) === 5, 'base 5, gain : retour a 5');

console.log('\n-- 3. les mots du modele --');
ok(BJ.litIssue('won') === 'win' && BJ.litIssue('WIN') === 'win' && BJ.litIssue('gagné') === 'win', 'win/won/gagné -> win');
ok(BJ.litIssue('bust') === 'lose' && BJ.litIssue('lost') === 'lose' && BJ.litIssue('perdu') === 'lose', 'bust/lost/perdu -> lose');
ok(BJ.litIssue('tie') === 'push' && BJ.litIssue('draw') === 'push', 'tie/draw -> push');
ok(BJ.litIssue('maybe') === null, 'un mot inconnu -> null (on ne bouge pas la mise)');

console.log('\n-- 4. une vraie série (départ, 3 pertes, 1 gain, reprise) --');
{
  let mise = BJ.premiereMise({ base: 1 });
  const suite = [];
  for (const issue of ['lose', 'lose', 'lose', 'win', 'lose']) { suite.push(mise); mise = BJ.prochaineMise({ base: 1, cap: 100, mise, issue }); }
  suite.push(mise);
  ok(JSON.stringify(suite) === JSON.stringify([1, 2, 4, 8, 1, 2]), 'série 1,2,4,8 puis gain -> 1 puis perte -> 2 : ' + suite.join(','));
}

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
process.exit(rates ? 1 : 0);
