'use strict';
/* STUDIO — LA REPRISE D'UNE RÉPONSE : gardée par ADRESSE DE SESSION et
   identifiant, lisible par elle seule, oubliée après GARDE_MS. */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const R = require('./reprises');

ok(!R.ridOk('') && !R.ridOk('abc') && !R.ridOk('a b c d e f') && !R.ridOk('x'.repeat(41)) && R.ridOk('k3j2h1-ab'), 'un identifiant se controle : 6 a 40 caracteres simples');
R.note('0xAAA', 'rid-000001', { status: 'pending', texte: '' }, 1000);
R.ajoute('0xaaa', 'rid-000001', 'Bon'); R.ajoute('0xaaa', 'rid-000001', 'jour');
ok(R.lit('0xaaa', 'rid-000001', 2000).texte === 'Bonjour', 'le texte recu s accumule pendant la reponse (casse d adresse indifferente)');
ok(R.lit('0xbbb', 'rid-000001', 2000) === null, 'une autre adresse ne lit rien avec le meme identifiant');
R.note('0xaaa', 'rid-000001', { status: 'done', texte: 'Bonjour.', factureSwoge: '12' }, 3000);
ok(R.lit('0xaaa', 'rid-000001', 4000).status === 'done', 'la reponse finie remplace l en-cours');
R.ajoute('0xaaa', 'rid-000001', 'XXX');
ok(R.lit('0xaaa', 'rid-000001', 4000).texte === 'Bonjour.', 'rien ne s ajoute a une reponse finie');
ok(R.lit('0xaaa', 'rid-000001', 3000 + R.GARDE_MS + 1) === null, 'apres GARDE_MS, elle est oubliee');
ok(R.note('0xaaa', 'bad', { status: 'x' }) === null, 'sans identifiant valide, rien n est garde');

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
