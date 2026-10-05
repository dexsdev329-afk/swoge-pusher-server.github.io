'use strict';
/* L'ORDONNANCEUR DES AGENTS DE JETON.
 *
 * Intention : un tour ne touche QUE les agents dus (cadence) ; chaque post est
 * ecrit sur le mur, qu il parte sur X ou non ; si un compte X est relie (poste
 * injecte) le post est marque surX avec son url, sinon il reste mur-seul ; un
 * agent qui echoue n arrete pas les autres ; les posts precedents sont passes
 * au compositeur (non-repetition) ; planifie ne demarre rien sans actif.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const AJ = require('./agent_jeton'), AF = require('./agent_feed'), H = require('./agent_horloge');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T1 = '0x' + '1'.repeat(40), T2 = '0x' + '2'.repeat(40), C = '0x' + 'a'.repeat(40);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-horloge-'));
  let horloge = Date.parse('2026-10-05T12:00:00Z');
  const reg = AJ.cree({ fichier: path.join(dir, 'r.json'), maintenant: () => horloge });
  const feed = AF.cree({ fichier: path.join(dir, 'f.json'), maintenant: () => horloge });
  reg.attache({ token: T1, createur: C, persona: 'builder', symbole: 'FOO', cadenceMin: 30 });
  reg.attache({ token: T2, createur: C, persona: 'hype', symbole: 'BAR', cadenceMin: 30 });

  const compose = async (o) => ({ texte: '[' + o.persona + '] $' + o.symbole + (o.precedents.length ? ' (not ' + o.precedents.length + ')' : ''), via: 'modele' });

  console.log('-- 1. premier tour : les deux agents sont dus, postes sur le mur --');
  let r = await H.tour({ registre: reg, feed, compose, maintenant: () => horloge });
  ok(r.agis === 2 && r.faits.length === 2, 'deux agents dus, deux posts');
  ok(feed.recent(T1, 5).length === 1 && /\$FOO/.test(feed.recent(T1, 5)[0].texte), 'le post de FOO est sur son mur');
  ok(feed.recent(T1, 5)[0].surX === false, 'sans compte X relie : le post reste mur-seul (jamais le compte maison)');

  console.log('\n-- 2. juste apres : plus personne n est du --');
  r = await H.tour({ registre: reg, feed, compose, maintenant: () => horloge });
  ok(r.agis === 0, 'cadence pas ecoulee : aucun post');

  console.log('\n-- 3. cadence ecoulee : on repasse, et les precedents sont transmis --');
  horloge += 31 * 60000;
  r = await H.tour({ registre: reg, feed, compose, maintenant: () => horloge });
  ok(r.agis === 2, 'apres 31 min : les deux repassent');
  ok(/not 1/.test(feed.recent(T1, 5)[0].texte), 'le compositeur a recu le post precedent (non-repetition)');

  console.log('\n-- 4. compte X relie : le post est marque surX avec son url --');
  horloge += 31 * 60000;
  const posteX = async (a, post) => (a.token === T1 ? { surX: true, url: 'https://x.com/foo/status/42' } : { surX: false });
  r = await H.tour({ registre: reg, feed, compose, poste: posteX, maintenant: () => horloge });
  const f1 = feed.recent(T1, 5)[0], f2 = feed.recent(T2, 5)[0];
  ok(f1.surX === true && /status\/42/.test(f1.url), 'FOO a un compte X : post marque surX avec son url');
  ok(f2.surX === false, 'BAR n a pas de compte : mur-seul');

  console.log('\n-- 5. un agent qui echoue n arrete pas les autres --');
  horloge += 31 * 60000;
  let appels = 0;
  const composeCapricieux = async (o) => { appels++; if (o.symbole === 'FOO') throw new Error('modele HS'); return { texte: 'ok', via: 'modele' }; };
  r = await H.tour({ registre: reg, feed, compose: composeCapricieux, maintenant: () => horloge });
  ok(appels === 2 && r.agis === 1 && r.faits.some((x) => x.erreur), 'FOO echoue, BAR passe quand meme : 1 agi, 1 erreur');

  console.log('\n-- 5b. le carburant : l agent dort a sec, et on debite apres un post --');
  const AFuel = require('./agent_fuel');
  const fuel = AFuel.cree({ fichier: path.join(dir, 'fuel.json'), maintenant: () => horloge, grantInitialUsd: 0 });
  fuel.credite(T1, 0.01, 'topup');   /* FOO a de quoi penser une fois a 0,005 $ */
  /* BAR reste a 0 → il dort */
  horloge += 31 * 60000;
  const compterSimple = async (o) => ({ texte: 'ok $' + (o.symbole || ''), via: 'modele' });
  r = await H.tour({ registre: reg, feed, compose: compterSimple, fuel, coutPostUsd: 0.005, maintenant: () => horloge });
  ok(r.agis === 1 && r.dorment === 1, 'un seul agent finance agit, l autre dort');
  ok(fuel.solde(T1) < 0.01 && fuel.solde(T2) === 0, 'FOO a ete debite apres son post ; BAR, a sec, n a rien depense');
  ok(r.faits.some((f) => f.token === T2.toLowerCase() && f.dort), 'BAR est marque « dort », sans post ecrit');

  console.log('\n-- 5c. le budget de posts du jour (regle du createur) : atteint → dort --');
  const reg2 = AJ.cree({ fichier: path.join(dir, 'r2.json'), maintenant: () => horloge });
  const feed2 = AF.cree({ fichier: path.join(dir, 'f2.json'), maintenant: () => horloge });
  const T3 = '0x' + '3'.repeat(40);
  reg2.attache({ token: T3, createur: C, persona: 'hype', cadenceMin: 5, postsParJourMax: 1 });
  r = await H.tour({ registre: reg2, feed: feed2, compose: compterSimple, maintenant: () => horloge });
  ok(r.agis === 1 && feed2.depuis(T3, 86400000, horloge) === 1, 'premier post : 1 geste, 1 au mur');
  horloge += 6 * 60000;   /* la cadence est passee, mais le budget du jour (1) est atteint */
  r = await H.tour({ registre: reg2, feed: feed2, compose: compterSimple, maintenant: () => horloge });
  ok(r.agis === 0 && r.faits.some((f) => f.dort && /daily post budget/.test(f.raison || '')), 'budget du jour atteint : l agent dort, raison claire');

  console.log('\n-- 5d. l ordonnanceur lance l ESPRIT quand il est branche --');
  const reg3 = AJ.cree({ fichier: path.join(dir, 'r3.json'), maintenant: () => horloge });
  const feed3 = AF.cree({ fichier: path.join(dir, 'f3.json'), maintenant: () => horloge });
  const A1 = '0x' + 'd'.repeat(40), A2 = '0x' + 'e'.repeat(40);
  reg3.attache({ token: A1, createur: C, persona: 'hype', cadenceMin: 5 });
  reg3.attache({ token: A2, createur: C, persona: 'stoic', cadenceMin: 5 });
  horloge += 10 * 60000;
  const espritFaux = async (a) => (a.token === A1 ? { actions: [{ action: 'post', surX: false }] } : { dort: true, raison: 'out of fuel' });
  r = await H.tour({ registre: reg3, feed: feed3, pense: espritFaux, maintenant: () => horloge });
  ok(r.faits.find((f) => f.token === A1 && f.pense), 'l esprit a tourne pour A1 (branche deps.pense)');
  ok(reg3.parJeton(A1).dernierGeste && reg3.parJeton(A1).dernierGeste.quoi === 'post', 'un post de l esprit note le geste (cadence)');
  ok(r.faits.find((f) => f.token === A2 && f.dort), 'A2 : l esprit a dit qu il dort, rapporte tel quel');

  console.log('\n-- 5e. un pulse SANS post (reponse / attente) avance quand meme la cadence --');
  /* Correctif audit 05/10 : penser coute du carburant ; un agent qui repond ou attend ne doit pas
     se redeclencher a chaque tour. Le geste avance (quoi « pulse »), donc il n est plus du tout de suite. */
  const B1 = '0x' + 'f'.repeat(40);
  const reg4 = AJ.cree({ fichier: path.join(dir, 'r4.json'), maintenant: () => horloge });
  const feed4 = AF.cree({ fichier: path.join(dir, 'f4.json'), maintenant: () => horloge });
  reg4.attache({ token: B1, createur: C, persona: 'stoic', cadenceMin: 5 });
  horloge += 10 * 60000;
  const repondSeul = async () => ({ actions: [{ action: 'reply' }] });
  r = await H.tour({ registre: reg4, feed: feed4, pense: repondSeul, maintenant: () => horloge });
  ok(reg4.parJeton(B1).dernierGeste && reg4.parJeton(B1).dernierGeste.quoi === 'pulse', 'une reponse seule note le geste « pulse » (la cadence avance)');
  ok(reg4.dus(horloge).length === 0, 'et l agent n est plus du tout de suite : la cadence le protege du re-pulse');

  console.log('\n-- 6. planifie ne demarre rien sans actif --');
  const h = H.planifie({ registre: reg, feed, compose }, { actif: false });
  ok(typeof h.arrete === 'function', 'sans actif : aucune minuterie, un arrete() inoffensif');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
