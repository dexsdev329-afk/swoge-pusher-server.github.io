'use strict';
/*
 * CE QUE LE PILOTE APPREND D'UNE TABLE (pilote_tables.js) :
 *   1. la clé = hôte + chemin, sans requête ni fragment, en minuscules ;
 *   2. on garde les repères, les plus récents d'abord, bornés ;
 *   3. un quasi-doublon (l'un contient l'autre) n'est pas re-noté ;
 *   4. durable : relu depuis le fichier.
 */
const fs = require('fs');
const path = require('path');
const T = require('./pilote_tables');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- 1. la cle d une table --');
ok(T.cleDe('https://1win.com/fr-CI/casino/play/v_1wingames:blackjack?x=1#y') === '1win.com/fr-ci/casino/play/v_1wingames:blackjack', 'hote + chemin, sans requete ni fragment, minuscules');
ok(T.cleDe('https://1win.com/fr-CI/casino/') === '1win.com/fr-ci/casino', 'le / final tombe');
ok(T.cleDe('pas une url') === null && T.cleDe('ftp://x/y') === null, 'une non-URL ou un schema non http(s) : null');

const dir = fs.mkdtempSync('/tmp/ptab-');
const fichier = path.join(dir, 'tables.json');
let t = 100;
const M = T.cree({ fichier, max: 3, maintenant: () => ++t });

console.log('\n-- 2. apprend, rappelle, borne, dedoublonne --');
const CLE = '1win.com/blackjack';
M.apprend(CLE, 'Deal button bottom-left ~150,700');
M.apprend(CLE, 'result shows top-right after ~2s');
ok(JSON.stringify(M.notes(CLE, 10)) === JSON.stringify(['result shows top-right after ~2s', 'Deal button bottom-left ~150,700']), 'les repères reviennent, le plus récent d abord');
const avant = M.notes(CLE, 10).length;
M.apprend(CLE, 'Deal button bottom-left ~150,700');            /* exact doublon */
M.apprend(CLE, 'the Deal button bottom-left ~150,700 is blue'); /* contient l ancien... en fait l ancien le contient ? non : on teste l inclusion */
ok(M.notes(CLE, 10).length === avant, 'un repère déjà connu (ou qui en contient un) n est pas re-noté');
ok(M.apprend(CLE, 'ab').ok === false, 'un repère trop court est refusé');

M.apprend(CLE, 'bet field is in the middle');
M.apprend(CLE, 'x2 button doubles the bet');
ok(M.notes(CLE, 10).length === 3, 'borné à max=3 : on ne garde que les plus récents');
ok(M.notes('autre.com/x', 10).length === 0, 'une table inconnue : aucun repère');

console.log('\n-- 3. durable (relu du fichier) --');
const M2 = T.cree({ fichier, max: 3 });
ok(M2.notes(CLE, 10).length === 3 && /x2 button/.test(M2.notes(CLE, 1)[0]), 'un nouveau lecteur retrouve les repères sur le disque');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
process.exit(rates ? 1 : 0);
