'use strict';
/* LE MUR D'UN AGENT DE JETON.
 *
 * Intention : chaque post est ecrit sur le mur de son jeton (qu il parte sur X
 * ou non) ; le plus recent en tete ; le mur est borne ; un texte vide ou une
 * adresse invalide n ecrit rien ; tout survit a un redemarrage.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('./agent_feed');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T1 = '0x' + '1'.repeat(40), T2 = '0x' + '2'.repeat(40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-'));
let horloge = 1000;
const S = F.cree({ fichier: path.join(dir, 'f.json'), maintenant: () => horloge, max: 3 });

console.log('-- 1. ajoute : le plus recent en tete, id et date poses --');
let e = S.ajoute(T1, { texte: 'first', via: 'modele', surX: true, url: 'https://x.com/x/status/1', faits: ['liquidity $5K'] });
ok(e && e.id && e.quand === 1000 && e.surX === true && e.url, 'une entree porte un id, une date, surX et l url');
horloge = 2000; S.ajoute(T1, { texte: 'second' });
ok(S.recent(T1, 10)[0].texte === 'second', 'le plus recent est en tete');

console.log('\n-- 2. refus propres --');
ok(S.ajoute(T1, { texte: '   ' }) === null, 'un texte vide n ecrit rien');
ok(S.ajoute('pas-0x', { texte: 'x' }) === null, 'une adresse invalide n ecrit rien');

console.log('\n-- 3. le mur est borne (max 3) --');
S.ajoute(T1, { texte: 'third' }); S.ajoute(T1, { texte: 'fourth' });
ok(S.recent(T1, 10).length === 3 && S.recent(T1, 10)[0].texte === 'fourth', 'au-dela du max, les plus anciens tombent');

console.log('\n-- 4. mur global et compte --');
horloge = 3000; S.ajoute(T2, { texte: 'other token' });
ok(S.tout(10).some((x) => x.token === T2.toLowerCase()) && S.tout(10)[0].token === T2.toLowerCase(), 'le mur global melange les jetons, plus recent en tete, avec le token');
ok(S.compte(T1) === 3 && S.compte() === 2, 'compte par jeton, et nombre de jetons avec un mur');

console.log('\n-- 5. persistance --');
const relu = F.cree({ fichier: path.join(dir, 'f.json'), maintenant: () => horloge, max: 3 });
ok(relu.recent(T1, 10).length === 3 && relu.recent(T1, 10)[0].texte === 'fourth', 'le mur survit a un redemarrage');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
