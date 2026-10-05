'use strict';
/* LA MÉMOIRE D'UN AGENT (agent_memoire.js, 05/10/2026).
 *
 * Intention : l'agent se souvient (continuité) et ne se répète pas. On tient :
 * note/rappel durables et bornés par jeton ; estRedondant refuse un texte trop
 * proche d'un post récent (mots en commun) mais laisse passer un vrai nouveau
 * message. Hors-ligne : fichier temporaire, horloge injectée. */

const fs = require('fs'), os = require('os'), path = require('path');
const mem = require('./agent_memoire');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'agmem-'));
const T = '0x' + 'a'.repeat(40);
let t = 1000;
const M = mem.cree({ fichier: path.join(BAC, 'm.json'), maintenant: () => t, max: 5 });

console.log('-- note + rappel, du plus recent au plus ancien, borne --');
M.note(T, { quoi: 'post', texte: 'gm, the dog is awake and the throne is warm' }); t++;
M.note(T, { quoi: 'event', meta: { type: 'price_up', pct: 12 } }); t++;
let r = M.rappel(T, 8);
ok(r.length === 2 && r[0].quoi === 'event' && r[1].quoi === 'post', 'le plus recent en tete');
ok(r[0].meta && r[0].meta.pct === 12, 'la meta est gardee');
for (let i = 0; i < 10; i++) { M.note(T, { quoi: 'post', texte: 'filler post number ' + i + ' about volume and liquidity today' }); t++; }
ok(M.rappel(T, 50).length === 5, 'borne a max=5 par jeton (rien ne gonfle sans fin)');

console.log('\n-- persistance : un second lecteur relit le meme fichier --');
const M2 = mem.cree({ fichier: path.join(BAC, 'm.json'), maintenant: () => t });
ok(M2.rappel(T, 50).length === 5, 'la memoire survit (tmp+fsync+rename)');

console.log('\n-- anti-repetition : refuse le quasi-identique, laisse passer le neuf --');
const M3 = mem.cree({ fichier: path.join(BAC, 'n.json'), maintenant: () => t });
M3.note(T, { quoi: 'post', texte: 'Liquidity is deep and the 24h volume keeps climbing on Robinhood Chain' });
ok(M3.estRedondant(T, 'liquidity is deep and the 24h volume keeps climbing on robinhood chain!!') === true, 'un quasi-doublon (meme mots) est redondant');
ok(M3.estRedondant(T, 'The 24h volume keeps climbing — liquidity is deep on Robinhood Chain') === true, 'meme contenu, autre ordre : toujours redondant (mesure par mots)');
ok(M3.estRedondant(T, 'New holders are joining every hour, the community is growing fast today') === false, 'un message vraiment different passe');
ok(M3.estRedondant(T, 'gm 🐕') === false, 'trop court pour juger : on laisse passer');

console.log('\n-- seulement les POSTS comptent pour la redondance, pas les events --');
const M4 = mem.cree({ fichier: path.join(BAC, 'o.json'), maintenant: () => t });
M4.note(T, { quoi: 'event', texte: 'price_up twelve percent over the last hour on the pool' });
ok(M4.estRedondant(T, 'price_up twelve percent over the last hour on the pool') === false, 'un event memorise ne bloque pas un post qui le raconte');
ok(M4.textes(T, 8).length === 0, 'textes() ne rend que les posts, jamais les events');

console.log('\n-- jaccard : borne [0,1], symetrique --');
const a = mem.motsDe('alpha beta gamma delta'), b = mem.motsDe('beta gamma');
ok(mem.jaccard(a, b) > 0 && mem.jaccard(a, b) < 1 && Math.abs(mem.jaccard(a, b) - mem.jaccard(b, a)) < 1e-9, 'jaccard dans ]0,1[ et symetrique');
ok(mem.jaccard(a, a) === 1 && mem.jaccard(a, mem.motsDe('rien de commun xyz')) === 0, '1 pour identique, 0 pour disjoint');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
