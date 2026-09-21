'use strict';
/* ============================================================================
 * PREDICT PANCAKE — LA CÔTE DÉCIDE, ET TOUT EST PAPIER
 *
 * On lit les VRAIS rounds PancakeSwap et on ne « miserait » (papier) que si
 * l'espérance bat le coût. Le piège des côtes est le cœur du test : une
 * prédiction juste sur un camp surchargé (côte 1,16×) est −EV → on SAUTE.
 * Aucun appel réseau, aucune chaîne : le lecteur est injecté.
 *
 *   1. La côte parimutuel, notre mise incluse.
 *   2. La décision : bonne côte → on miserait ; côte pourrie → on saute.
 *   3. La résolution : un pari gagnant monte la caisse, un perdant la baisse,
 *      un saut ne touche rien.
 *   4. Bout en bout : un round se décide près du lock, un round fermé se résout.
 *   5. Papier : aucune clé, aucune signature, aucun ordre dans le module.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-'));
process.env.PREDICT_PANCAKE_STAKE = '0.01';
process.env.PREDICT_PANCAKE_GAZ = '0.0006';
process.env.PREDICT_PANCAKE_MARGE = '0.05';
process.env.PREDICT_PANCAKE_BANK = '1';
process.env.PREDICT_PANCAKE_LEAD_S = '45';
const P = require('./predict_pancake');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const near = (a, b, e, m) => ok(Math.abs(a - b) <= e, m + ' [' + a + ']');

(async () => {
  console.log('-- 1. la côte parimutuel (notre mise diluée dedans) --');
  {
    /* pool 0.55, bull 0.23, bear 0.32, fee 3 %, mise 0.01 */
    near(P.cote(0.23, 0.55, 0.03), 2.26, 0.05, 'BULL ~2,26×');
    near(P.cote(0.32, 0.55, 0.03), 1.69, 0.05, 'BEAR ~1,69×');
    ok(P.cote(0, 0, 0.03) !== null, 'un camp vide se calcule quand même (notre mise seule)');
  }

  console.log('\n-- 2. la décision : la côte peut tuer une prédiction juste --');
  {
    const predUp = { sens: 'UP', prob: 55, assez: true };
    /* Bonne côte : peu de monde sur BULL → 5×+ → EV largement positif. */
    const bon = P.decide(predUp, { bull: 0.1, bear: 0.5, total: 0.6 }, 0.03);
    ok(bon.side === 'BULL' && bon.wouldBet && bon.ev > 0, 'BULL sur une côte grasse : on miserait [' + bon.cote + '×, EV ' + bon.ev + ']');
    /* Côte pourrie : la foule est sur BULL → ~1,16× → −EV → on SAUTE. */
    const mauvais = P.decide(predUp, { bull: 0.5, bear: 0.1, total: 0.6 }, 0.03);
    ok(mauvais.side === 'BULL' && !mauvais.wouldBet && mauvais.ev < 0,
       'même prédiction, côte pourrie : on saute [' + mauvais.cote + '×, EV ' + mauvais.ev + ']');
    ok(/not worth it/.test(mauvais.raison), 'et la raison le dit : le payout ne vaut pas le coup');
    /* Sans prédiction sûre, jamais de pari. */
    ok(!P.decide({ sens: 'NEUTRAL', prob: 50, assez: false }, { bull: 0.1, bear: 0.5, total: 0.6 }, 0.03).wouldBet,
       'pas de prédiction sûre → aucun pari');
  }

  console.log('\n-- 3. la résolution : gagné / perdu / sauté --');
  {
    P._reset(); const S = P._S();
    /* Un pari BULL retenu, le prix MONTE → gagné. */
    S.enAttente[100] = { side: 'BULL', wouldBet: true, cote: 5.4, ev: 1.9, prob: 55 };
    P.resous(100, { lockPrice: '100', closePrice: '110', bull: 0.1, bear: 0.5, total: 0.6, oracleCalled: true }, 0.03);
    ok(S.wins === 1 && S.bank > 1, 'BULL + hausse = gagné, la caisse monte [' + S.bank.toFixed(4) + ' BNB]');
    /* Un pari BULL retenu, le prix BAISSE → perdu (mise + gaz). */
    S.enAttente[101] = { side: 'BULL', wouldBet: true, cote: 5.4, ev: 1.9, prob: 55 };
    const avant = S.bank;
    P.resous(101, { lockPrice: '100', closePrice: '90', bull: 0.1, bear: 0.5, total: 0.6, oracleCalled: true }, 0.03);
    ok(S.losses === 1 && S.bank < avant, 'BULL + baisse = perdu, la caisse baisse [' + S.bank.toFixed(4) + ']');
    near(avant - S.bank, 0.0106, 0.0001, 'la perte = mise 0,01 + gaz 0,0006 BNB');
    /* Un SAUT (côte pourrie) ne touche pas la caisse. */
    S.enAttente[102] = { side: 'BEAR', wouldBet: false, cote: 1.1, ev: -0.4, prob: 55 };
    const b2 = S.bank;
    P.resous(102, { lockPrice: '100', closePrice: '90', bull: 0.1, bear: 0.5, total: 0.6, oracleCalled: true }, 0.03);
    ok(S.skips === 1 && S.bank === b2, 'un saut ne touche pas la caisse, mais il est compté');
  }

  console.log('\n-- 4. bout en bout : décider près du lock, résoudre au close --');
  {
    P._reset();
    P._reseau(async () => { const a = []; let p = 100; for (let i = 0; i < 60; i++) { p += 1; a.push({ o: p - 0.5, c: p, h: p + 0.3, l: p - 0.7, v: 100 + i }); } return a; });
    const nowS = Math.floor(Date.now() / 1000);
    const rounds = {
      200: { epoch: '200', lock: nowS + 10, close: nowS + 310, lockPrice: '0', closePrice: '0', bull: 0.1, bear: 0.6, total: 0.7, oracleCalled: false }, /* en cours de mise, proche du lock */
      199: { epoch: '199', lock: nowS - 290, close: nowS + 10, lockPrice: '0', closePrice: '0', bull: 0.3, bear: 0.3, total: 0.6, oracleCalled: false }, /* verrouillé, pas fermé */
    };
    P._chaineTest({ epoch: async () => 200, fee: async () => 0.03, round: async (e) => rounds[Number(e)] });
    await P.tic();
    const e1 = P.etat();
    ok(e1.round && e1.round.epoch === 200 && e1.round.decision, 'un round en cours a une décision');
    ok(e1.round.coteBull > e1.round.coteBear, 'BULL paie plus que BEAR ici (peu de monde sur BULL)');
    /* Le round 200 ferme, BULL gagne (prix monté) : on résout. */
    rounds[201] = { epoch: '201', lock: nowS + 310, close: nowS + 610, lockPrice: '0', closePrice: '0', bull: 0, bear: 0, total: 0, oracleCalled: false };
    rounds[200] = Object.assign({}, rounds[200], { lockPrice: '100', closePrice: '120', oracleCalled: true });
    P._chaineTest({ epoch: async () => 202, fee: async () => 0.03, round: async (e) => rounds[Number(e)] || { epoch: String(e), lock: 0, close: 0, lockPrice: '0', closePrice: '0', bull: 0, bear: 0, total: 0, oracleCalled: false } });
    await P.tic();
    const e2 = P.etat();
    ok(e2.dernier.length >= 1, 'le round fermé est passé dans l historique [' + e2.dernier.length + ']');
    ok(e2.banque.wins + e2.banque.losses + e2.banque.skips >= 1, 'et il a été jugé (gagné/perdu/sauté)');
  }

  console.log('\n-- 5. papier : aucune clé, aucune signature, aucun ordre --');
  {
    const e = P.etat();
    ok(e.paper === true && e.marche === 'BNB', 'tout est papier, marché BNB');
    ok(/not worth it|skips/i.test(JSON.stringify(e)) || e.banque.skips >= 0, 'l état porte le compteur de sauts');
    const src = fs.readFileSync(path.join(__dirname, 'predict_pancake.js'), 'utf8');
    ok(!/privateKey|sendTransaction|signTransaction|betBull|betBear|Wallet\(|signer/i.test(src),
       'aucune signature, aucun betBull/betBear, aucun wallet dans l étage 1');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
