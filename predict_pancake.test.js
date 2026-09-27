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
 *   6. La martingale : monte après une perte, repart après un gain, plafonne
 *      (bust compté), et ne mise jamais plus que la caisse.
 *  10. Une égalité lock = close est PERDUE (contrat V2 : tout le pool au trésor).
 *  11. Un round annulé (oracle jamais appelé, close + 30 s passé) est remboursé
 *      ET résolu — il restait en attente pour toujours.
 *  12. Paris éteints : chaque round est quand même jugé (raison du « 0 bet »,
 *      prob × cote contre le seuil) et journalisé ; ses ombres se notent au
 *      règlement ; la caisse papier reste à 0 pari.
 * La porte rejouée sur 30 004 rounds stockés : predict_pancake_rejeu.test.js.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-'));
process.env.PREDICT_PANCAKE_STAKE = '0.01';
process.env.PREDICT_PANCAKE_GAZ = '0.0006';
process.env.PREDICT_PANCAKE_MARGE = '0.05';
process.env.PREDICT_PANCAKE_BANK = '1';
process.env.PREDICT_PANCAKE_LEAD_S = '45';
process.env.PREDICT_PANCAKE_MART_FACTEUR = '2';
process.env.PREDICT_PANCAKE_MART_PALIERS = '3';   /* petit, pour atteindre le bust dans le test */
process.env.PREDICT_PANCAKE_PARIE = '1';          /* on TESTE le chemin de pari ; défaut prod = off */
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
    /* Ce que les rounds fermés ont PAYÉ : l'historique de `noteFinale`. */
    const histo = (bull, bear, total, n) => { const f = { BULL: [], BEAR: [], dernierEp: 0 };
      for (let i = 1; i <= n; i++) P.noteFinale(f, i, { oracleCalled: true, bull, bear, total }, 0.03); return f; };
    const gras = histo(0.1, 0.5, 0.6, 12);     /* BULL a payé ~5,8× douze fois */
    /* Bonne côte, vue ET finale : peu de monde sur BULL → EV largement positif. */
    const bon = P.decide(predUp, { bull: 0.1, bear: 0.5, total: 0.6 }, 0.03, 0, gras);
    ok(bon.side === 'BULL' && bon.wouldBet && bon.ev > 0, 'BULL sur une côte grasse : on miserait [' + bon.cote + '×, EV ' + bon.ev + ']');
    /* Côte pourrie : la foule est DÉJÀ sur BULL → ~1,16× → −EV → on SAUTE,
       quoi qu'ait payé le passé : une foule déjà là ne repart pas. */
    const mauvais = P.decide(predUp, { bull: 0.5, bear: 0.1, total: 0.6 }, 0.03, 0, gras);
    ok(mauvais.side === 'BULL' && !mauvais.wouldBet && mauvais.ev < 0,
       'même prédiction, côte pourrie : on saute [' + mauvais.cote + '×, EV ' + mauvais.ev + ']');
    ok(/not worth it/.test(mauvais.raison), 'et la raison le dit : le payout ne vaut pas le coup');
    /* LE CAS MESURÉ le 24 septembre : 45 s avant le lock le pool est mince et
       affiche 5×, mais les rounds fermés paient ~1,9× — les deux tiers de
       l'argent arrivent après. On juge sur la cote FINALE attendue : on saute. */
    const fantome = P.decide(predUp, { bull: 0.1, bear: 0.5, total: 0.6 }, 0.03, 0, histo(0.3, 0.3, 0.6, 12));
    ok(fantome.coteVue > 4 && !fantome.wouldBet && fantome.cote < 2,
       'une côte vue de ' + fantome.coteVue + '× qui finit à ~' + fantome.cote + '× : on ne s y laisse pas prendre');
    /* Sous FINALES_MIN rounds observés, on ne conclut pas. */
    const tot = P.decide(predUp, { bull: 0.1, bear: 0.5, total: 0.6 }, 0.03, 0, histo(0.1, 0.5, 0.6, P.FINALES_MIN - 1));
    ok(!tot.wouldBet && /learning the final payouts/.test(tot.raison), 'trop peu de rounds observés : aucun pari [' + tot.raison + ']');
    /* L'historique retient chaque epoch UNE fois, les deux camps. */
    const f = histo(0.1, 0.5, 0.6, 3); P.noteFinale(f, 3, { oracleCalled: true, bull: 0.1, bear: 0.5, total: 0.6 }, 0.03);
    ok(f.BULL.length === 3 && f.BEAR.length === 3, 'une cote finale par camp et par round, jamais deux fois le même');
    /* Sans prédiction sûre, jamais de pari. */
    ok(!P.decide({ sens: 'NEUTRAL', prob: 50, assez: false }, { bull: 0.1, bear: 0.5, total: 0.6 }, 0.03, 0, gras).wouldBet,
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

  console.log('\n-- 6. la martingale : monte, repart, plafonne, bornée par la caisse --');
  {
    /* Une mise plus grosse DILUE la côte (elle s ajoute au pool de notre camp). */
    ok(P.cote(0.1, 0.6, 0.03, 0.5) < P.cote(0.1, 0.6, 0.03, 0.01),
       'une grosse mise dilue la côte de son camp');

    const predUp = { sens: 'UP', prob: 55, assez: true };
    const pool = { bull: 0.1, bear: 0.5, total: 0.6 };   /* BULL gras : on miserait */
    /* parie() relit l état FRAIS à chaque appel : P._reset() rebind l objet S,
     * une référence capturée deviendrait périmée. */
    /* L'échelle se teste sur des rounds qu'on JOUE : la porte EV a vu douze
       rounds fermés où BULL payait gras (`noteFinale`), comme le pool. */
    const nourrit = () => { const f = P._S().finales;
      for (let i = 1; i <= P.FINALES_MIN; i++) P.noteFinale(f, i, { oracleCalled: true, bull: pool.bull, bear: pool.bear, total: pool.total }, 0.03); };
    const parie = (ep, monte) => {
      const S = P._S();
      if (S.finales.BULL.length < P.FINALES_MIN) nourrit();
      S.enAttente[ep] = P.decide(predUp, pool, 0.03, S.miseCourante);
      P.resous(ep, { lockPrice: '100', closePrice: monte ? '120' : '90', bull: pool.bull, bear: pool.bear, total: pool.total, oracleCalled: true }, 0.03);
    };
    P._reset();

    ok(Math.abs(P.etat().martingale.miseCourante - 0.01) < 1e-9, 'on démarre à la mise de base');
    parie(300, false);   /* perte 1 */
    const m1 = P.etat().martingale;
    ok(m1.palier === 1 && m1.miseCourante > 0.01, 'après une perte : palier 1, mise ×2 [' + m1.miseCourante + ']');
    parie(301, false);   /* perte 2 */
    const m2 = P.etat().martingale;
    ok(m2.palier === 2 && m2.miseCourante > m1.miseCourante, 'deux pertes : palier 2, mise plus grosse [' + m2.miseCourante + ']');
    parie(302, true);    /* gain → reset */
    const m3 = P.etat().martingale;
    ok(m3.palier === 0 && Math.abs(m3.miseCourante - 0.01) < 1e-9, 'un gain remet à la base [palier ' + m3.palier + ']');

    /* Quatre pertes d affilée (MART_PALIERS=3) : la 4e casse l échelle → bust. */
    P._reset();
    for (let i = 0; i < 4; i++) parie(400 + i, false);
    const m4 = P.etat().martingale;
    ok(m4.busts >= 1, 'une série plus longue que le plafond casse l échelle (bust compté) [' + m4.busts + ']');
    ok(m4.palier === 0, 'et l échelle repart de zéro après le bust');
    ok(m4.miseCourante <= Math.max(0.01, P._S().bank) + 1e-9, 'la mise ne dépasse jamais la caisse [' + m4.miseCourante + ' vs ' + P._S().bank.toFixed(4) + ']');

    /* La mise réellement engagée est tracée dans l historique. */
    ok(P.etat().dernier.every((d) => typeof d.mise === 'number'), 'chaque ligne d historique porte sa mise');
  }

  console.log('\n-- 7. le mode inverse : l autre camp, avec la prob de ce camp --');
  {
    /* inverse() est pur : UP↔DOWN, prob → 100 − prob (la prob du camp choisi). */
    const up = P.inverse({ sens: 'UP', prob: 55, assez: true });
    ok(up.sens === 'DOWN' && up.prob === 45 && up.inverse === true, 'UP 55 % → DOWN 45 % [' + up.sens + ' ' + up.prob + ']');
    const dn = P.inverse({ sens: 'DOWN', prob: 60, assez: true });
    ok(dn.sens === 'UP' && dn.prob === 40, 'DOWN 60 % → UP 40 %');
    const neu = P.inverse({ sens: 'NEUTRAL', prob: 50, assez: false });
    ok(neu.sens === 'NEUTRAL', 'un neutre reste neutre (rien à inverser)');
    ok(P.etat().inverse === false, 'éteint par défaut (l état le dit)');
  }

  console.log('\n-- 8. la remise à zéro par génération (bump de PREDICT_PANCAKE_GEN) --');
  {
    P._reset(); const S = P._S();
    S.bank = 0.5; S.wins = 9; S.pl = -0.5;   /* S.gen vient de _reset : la génération courante du code */
    require('fs').writeFileSync(require('path').join(process.env.DATA_DIR, 'predict_pancake.json'), JSON.stringify(S));
    /* Recharger AVEC la même génération : rien ne bouge. */
    P.charge();
    ok(P._S().wins === 9, 'même génération : la caisse est relue telle quelle');
    /* Simuler un bump : le fichier porte gen 1, l env demande 2 → reset au chargement.
       On force via _S (GEN est figé au require) : on prouve la logique de charge(). */
    const g = P._S(); g.gen = '0';   /* fichier « ancienne génération » */
    require('fs').writeFileSync(require('path').join(process.env.DATA_DIR, 'predict_pancake.json'), JSON.stringify(g));
    P.charge();
    ok(P._S().gen !== '0' && P._S().wins === 0 && Math.abs(P._S().bank - 1) < 1e-9,
       'génération différente : caisse remise à zéro (bank 1, wins 0)');
  }

  console.log('\n-- 9. paris ÉTEINTS (défaut) : on lit les rounds/côtes, on ne mise pas --');
  {
    delete require.cache[require.resolve('./predict_pancake')];
    delete process.env.PREDICT_PANCAKE_PARIE;
    const P2 = require('./predict_pancake');
    ok(P2.PARIE === false, 'PARIE éteint par défaut');
    P2._reset();
    P2._reseau(async () => { const a = []; let p = 100; for (let i = 0; i < 60; i++) { p += 1; a.push({ o: p - 0.5, c: p, h: p + 0.3, l: p - 0.7, v: 100 + i }); } return a; });
    const nowS = Math.floor(Date.now() / 1000);
    const rounds = { 300: { epoch: '300', lock: nowS + 10, close: nowS + 310, lockPrice: '0', closePrice: '0', bull: 0.1, bear: 0.6, total: 0.7, oracleCalled: false } };
    P2._chaineTest({ epoch: async () => 300, fee: async () => 0.03, round: async (e) => rounds[Number(e)] });
    await P2.tic();
    const e = P2.etat();
    ok(e.round && e.round.epoch === 300 && e.round.coteBull > 0, 'la carte lit toujours le round et les côtes');
    ok(!e.round.decision, 'mais AUCUNE décision de pari');
    ok(Object.keys(P2._S().enAttente).length === 0 && e.banque.mises === 0, 'rien en attente, aucune mise');
    ok(/betting is off/i.test(e.note), 'l état dit que les paris sont éteints');
  }

  console.log('\n-- 10. égalité lock = close : PERDU (contrat V2 : tout le pool au trésor) --');
  {
    P._reset(); const S = P._S();
    S.enAttente[500] = { side: 'BULL', wouldBet: true, cote: 2, ev: 0.1, prob: 55, mise: 0.01 };
    P.resous(500, { lockPrice: '100', closePrice: '100', bull: 0.5, bear: 0.5, total: 1, oracleCalled: true }, 0.03);
    const d = P.etat().dernier[0];
    ok(S.losses === 1 && S.wins === 0 && d.gagnant === 'TIE' && d.issue === 'loss', 'une égalité est une PERTE, pas un remboursement [' + d.issue + ']');
    near(1 - S.bank, 0.0106, 1e-9, 'elle coûte la mise et le gaz, comme toute perte');
    ok(P.etat().martingale.palier === 1, 'la martingale papier la traite comme toute perte (palier 1)');
    const src = fs.readFileSync(path.join(__dirname, 'predict_pancake.js'), 'utf8');
    ok(!/gagnant === 'TIE'\)\s*\{\s*issue = 'refund'/.test(src), 'plus aucune branche « égalité = remboursement » dans le source');
  }

  console.log('\n-- 11. round annulé (oracle jamais appelé) : remboursé ET résolu --');
  {
    P._reset(); const S = P._S();
    const t = Math.floor(Date.now() / 1000);
    S.enAttente[600] = { side: 'BULL', wouldBet: true, cote: 2, ev: 0.1, prob: 55, mise: 0.02 };   /* palier 1 */
    S.enAttente[601] = { side: 'BEAR', wouldBet: true, cote: 2, ev: 0.1, prob: 55, mise: 0.01 };
    S.mart.palier = 1; S.miseCourante = 0.02;
    const rounds = {
      600: { epoch: '600', lock: t - 400, close: t - 100, lockPrice: '100', closePrice: '0', bull: 0.2, bear: 0.3, total: 0.5, oracleCalled: false },  /* annulé : close + 30 s passé */
      601: { epoch: '601', lock: t - 300, close: t - 10, lockPrice: '100', closePrice: '0', bull: 0.2, bear: 0.3, total: 0.5, oracleCalled: false },   /* encore dans le délai */
      603: { epoch: '603', lock: t + 250, close: t + 550, lockPrice: '0', closePrice: '0', bull: 0.1, bear: 0.1, total: 0.2, oracleCalled: false },
    };
    P._chaineTest({ epoch: async () => 603, fee: async () => 0.03, round: async (e) => rounds[Number(e)] });
    await P.tic();
    const e = P.etat();
    ok(!P._S().enAttente[600], 'le round annulé ne reste plus en attente pour toujours');
    ok(e.dernier[0].epoch === 600 && e.dernier[0].issue === 'refund' && e.dernier[0].gagnant === 'CANCELLED', 'il est résolu en REMBOURSEMENT');
    ok(e.banque.refunds === 1 && e.banque.losses === 0 && e.banque.wins === 0, 'compté à part : ni gagné ni perdu');
    near(1 - P._S().bank, 0.0006, 1e-9, 'la mise revient, le gaz non');
    ok(e.martingale.palier === 1 && Math.abs(e.martingale.miseCourante - 0.02) < 1e-9, 'la martingale ne bouge pas sur un remboursement');
    ok(!!P._S().enAttente[601], 'un round encore dans son délai d oracle (close + 30 s) attend');
  }

  console.log('\n-- 12. paris ÉTEINTS : chaque round est quand même JUGÉ et journalisé (ombres) --');
  {
    const J = require('./predict_pancake_journal');
    const P3 = require('./predict_pancake');   /* PARIE éteint (section 9) */
    P3._reset(); await J.indexe();   /* pas de charge() : le fichier d état est celui des sections précédentes */
    P3._reseau(async () => { const a = []; let p = 100; for (let i = 0; i < 60; i++) { p += 1; a.push({ o: p - 0.5, c: p, h: p + 0.3, l: p - 0.7, v: 100 + i }); } return a; });
    const t = Math.floor(Date.now() / 1000);
    const rounds = { 700: { epoch: '700', lock: t + 10, close: t + 310, lockPrice: '0', closePrice: '0', bull: 0.1, bear: 0.6, total: 0.7, oracleCalled: false } };
    P3._chaineTest({ epoch: async () => 700, fee: async () => 0.03, round: async (e) => rounds[Number(e)] });
    await P3.tic();
    const e = P3.etat();
    ok(!e.round.decision && Object.keys(P3._S().enAttente).length === 0 && e.banque.mises === 0, 'aucun pari, rien en attente (paris éteints)');
    ok(J.aDecide(700), 'mais le round 700 est JUGÉ et sa décision est au journal');
    const pt = e.porte.derniere;
    ok(pt && pt.epoch === 700 && e.round.porte && e.round.porte.epoch === 700, 'la porte du round est servie à la carte');
    near(e.porte.requis, 1 + P3.GAZ / P3.STAKE + P3.MARGE, 1e-9, 'le seuil exigé est dit : 1 + gaz/mise + marge');
    ok(pt.produit == null || Math.abs(pt.produit - pt.prob / 100 * pt.cote) < 0.002, 'et le produit prob × cote attendue [' + pt.produit + ' vs ' + e.porte.requis + ']');
    ok(e.porte.evaluees >= 1, 'le compteur de rounds jugés avance [' + e.porte.evaluees + ']');
    /* Le round 700 se règle, BULL gagne : les ombres le notent. */
    rounds[700] = Object.assign({}, rounds[700], { lockPrice: '100', closePrice: '120', oracleCalled: true, bull: 0.3, bear: 0.7, total: 1.0 });
    rounds[702] = { epoch: '702', lock: t + 610, close: t + 910, lockPrice: '0', closePrice: '0', bull: 0, bear: 0, total: 0, oracleCalled: false };
    P3._chaineTest({ epoch: async () => 702, fee: async () => 0.03, round: async (e2) => rounds[Number(e2)] });
    await P3.tic();
    await J._vidange();
    const o = P3.etat().ombres;
    const bull = o.candidats.find((x) => x.id === 'bull'), mot = o.candidats.find((x) => x.id === 'moteur');
    ok(bull.n >= 1 && bull.gagnes >= 1, 'le témoin « toujours BULL » a gagné ce round');
    ok(mot.n >= 1, 'le camp du moteur est noté aussi [n ' + mot.n + ']');
    ok(P3.etat().banque.mises === 0 && P3.etat().banque.solde === 1, 'la caisse papier reste à 0 pari, exprès');
    ok(P3.etat().journal.rounds >= 1 && P3.etat().journal.decisions >= 1, 'le journal compte ses lignes');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
