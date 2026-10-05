'use strict';
/* LA MESURE D'UN AGENT (agent_mesure.js, 05/10/2026).
 *
 * Intention : agreger les metriques publiques des posts pour APPRENDRE ce qui marche,
 * sans conclure sous assez d'observations. On tient : totaux, meilleur post, et un
 * classement par format (texte/image/video) UNIQUEMENT quand il y a assez de posts.
 * Pur. */

const me = require('./agent_mesure');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const post = (texte, media, metrics, quand) => ({ texte, media, metrics, quand });
const M = (imp, like, rt, rep) => ({ impression_count: imp, like_count: like, retweet_count: rt, reply_count: rep });

console.log('-- totaux + meilleur post --');
let r = me.resume([
  post('a', 'none', M(1000, 10, 2, 1)), post('b', 'image', M(500, 50, 10, 5)), post('c', 'none', M(2000, 5, 0, 0)),
]);
ok(r.n === 3 && r.impressions === 3500 && r.likes === 65, 'totaux impressions + likes');
ok(r.meilleur && r.meilleur.texte === 'b', 'le meilleur post est celui au meilleur taux d engagement (b)');
ok(r.tauxMoyenPct !== null, 'un taux moyen est calcule quand il y a des impressions');

console.log('\n-- on ne conclut pas sous le seuil --');
ok(r.assez === false, '3 posts : pas assez pour conclure (assez=false)');
ok(Object.keys(r.parMedia).length === 0, 'pas de classement par format tant qu un format n a pas ASSEZ_FORMAT posts');

console.log('\n-- assez d observations : classement par format --');
const beaucoup = [];
for (let i = 0; i < 4; i++) beaucoup.push(post('img' + i, 'image', M(100, 20, 2, 1)));   /* image : fort engagement */
for (let i = 0; i < 3; i++) beaucoup.push(post('txt' + i, 'none', M(100, 2, 0, 0)));       /* texte : faible */
r = me.resume(beaucoup);
ok(r.n === 7 && r.assez === true, '7 posts mesures : assez pour conclure');
ok(r.parMedia.image && r.parMedia.none && r.parMedia.image.scoreMoyen > r.parMedia.none.scoreMoyen, 'le format image sort devant le texte (mesure, pas feeling)');

console.log('\n-- posts sans metriques ignores ; impressions absentes → engagement brut --');
r = me.resume([post('x', 'none', null), post('y', 'none', M(0, 7, 1, 0))]);
ok(r.n === 1, 'un post sans metrics n est pas compte');
ok(r.meilleur.texte === 'y' && r.tauxMoyenPct === null, 'sans impressions : pas de taux, mais l engagement brut classe quand meme');

console.log('\n-- phrase pour la memoire (seulement si assez) --');
ok(me.phrase(me.resume(beaucoup)) && /best post so far/.test(me.phrase(me.resume(beaucoup))), 'assez → une ligne « ce qui marche »');
ok(me.phrase(me.resume([post('a', 'none', M(10, 1, 0, 0))])) === null, 'pas assez → pas de phrase (on ne conclut pas)');

console.log('\n-- score/engagements --');
ok(me.engagements(M(100, 3, 2, 1)) === 6, 'engagements = likes+rt+reply+quote(+bookmark)');
ok(me.score(M(100, 10, 0, 0)) === 0.1 && me.score(M(0, 4, 0, 0)) === 4, 'score = taux si impressions, sinon brut');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
