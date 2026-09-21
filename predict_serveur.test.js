'use strict';
/* ============================================================================
 * PREDICT SERVEUR — LE RELEVE PARTAGE QUI PERSISTE
 *
 * Ce qui se joue ici : un round s'ouvre, se resout sur le mouvement REEL du
 * prix, et le releve — win / raté, gains / pertes de la banque — s'accumule et
 * SURVIT a un redemarrage. Aucun appel sortant : le reseau (Hyperliquid) est
 * injecte. Tout est papier — le module n'a aucun chemin vers une cle ou un
 * ordre, et l'essai le tient.
 *
 *   1. Un round s'ouvre avec une prediction (UP sur une tendance haussiere).
 *   2. Il gagne quand le prix monte, il rate quand il baisse — et la banque
 *      bouge du bon signe.
 *   3. Le releve PERSISTE : relu apres un redemarrage, il garde ses comptes.
 *   4. Pas assez de bougies : aucun round, aucun pari inventé.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-'));
process.env.DATA_DIR = BAC;
process.env.PREDICT_ROUND_S = '300';
process.env.PREDICT_BANK = '1000';
process.env.PREDICT_BET = '10';
process.env.PREDICT_MART = '0';
const P = require('./predict_serveur');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

/* Un monde factice : un prix pilotable, et des bougies clairement haussieres
   (moteur -> UP, assez). `assez=false` rend une serie trop courte. */
let spot = 100, assez = true;
function bougiesHausse(nb) { const a = []; let p = 100; for (let i = 0; i < nb; i++) { p += 1; a.push({ t: i, T: i, o: p - 0.5, c: p, h: p + 0.3, l: p - 0.7, v: 100 + i }); } return a; }
P._reseau(async (body) => {
  if (body.type === 'allMids') return { BNB: String(spot) };
  if (body.type === 'candleSnapshot') return bougiesHausse(assez ? 60 : 10);
  return {};
});

(async () => {
  console.log('-- 1. un round s ouvre avec une prediction --');
  {
    P._reset(); spot = 100;
    await P.tic();
    const r = P._ref().round;
    ok(r && r.sens === 'UP', 'la tendance haussiere ouvre un round UP');
    eq(r && r.ouvre, 100, 'a l ouverture, il note le prix du moment');
    eq(r && r.mise, 10, 'et la mise a plat');
    eq(P.etat().banque.trades, 0, 'aucun trade encore : le round n est pas resolu');
  }

  console.log('\n-- 2. il gagne si ca monte, il rate si ca baisse --');
  {
    /* Le prix monte : UP gagne. */
    P._ref().round.tFerme = 0; spot = 105;
    await P.tic();
    var s = P.etat().banque;
    eq(s.wins, 1, 'un win');
    eq(s.solde, 1010, 'la banque a pris la mise : 1000 -> 1010');
    var d = P.etat().dernier[0];
    ok(d.gagne === true && d.pl === 10 && d.ouvre === 100 && d.ferme === 105, 'le releve note le win, la mise, l ouverture et la fermeture');
    /* Le prix baisse sous l ouverture du nouveau round : UP rate. */
    P._ref().round.tFerme = 0; spot = 100;   /* le round ouvert en 2 avait ouvre=105 */
    await P.tic();
    s = P.etat().banque;
    eq(s.losses, 1, 'un raté');
    eq(s.solde, 1000, 'la banque a rendu la mise : 1010 -> 1000');
    eq(P.etat().dernier[0].gagne, false, 'et le releve note le raté');
    eq(s.trades, 2, 'deux rounds resolus au total');
    ok(/^\d/.test(String(s.winRate)) && s.winRate === 50, 'le taux de reussite est calcule [' + s.winRate + '%]');
  }

  console.log('\n-- 3. le releve PERSISTE a un redemarrage --');
  {
    /* Un nouveau processus lirait le disque : on simule par reset + charge. */
    P._reset();
    eq(P.etat().banque.trades, 0, 'apres reset memoire, tout est a zero');
    P.charge();
    var s = P.etat().banque;
    eq(s.trades, 2, 'relu sur disque, les deux rounds sont la');
    eq(s.solde, 1000, 'et le solde exact');
    eq(s.wins + s.losses, 2, 'win et raté compris');
  }

  console.log('\n-- 4. pas assez de bougies : aucun pari inventé --');
  {
    P._reset(); assez = false; spot = 100;
    await P.tic();
    ok(P._ref().round === null, 'sans prediction sûre, aucun round ne s ouvre');
    eq(P.etat().banque.trades, 0, 'et aucun trade');
    assez = true;
  }

  console.log('\n-- 5. l etat servi a la page est complet et papier --');
  {
    P._reset(); P.charge();
    const e = P.etat();
    eq(e.coin, 'BNB', 'le marché est BNB (PancakeSwap)');
    ok(e.paper === true, 'tout est papier');
    eq(e.roundSec, 300, 'la durée d un round est dite');
    ok(e.banque && typeof e.banque.winRate === 'number' && typeof e.banque.pl === 'number', 'la banque porte win rate et P/L');
    ok(Array.isArray(e.dernier) && Array.isArray(e.courbe), 'les derniers rounds et la courbe sont là');
    var src = fs.readFileSync(path.join(__dirname, 'predict_serveur.js'), 'utf8');
    ok(!/privateKey|sendTransaction|signTransaction|MIROIR_CLE|wallet/i.test(src), 'aucune clé, aucune signature, aucun ordre dans le module');
    /* Le moteur est vendu depuis le depot du site : les deux copies doivent
       rester identiques, sinon le serveur note un win que la page ne verrait
       pas de la meme facon. Garde active seulement quand le site est la. */
    var siteMoteur = '/home/user/SWOGE.github.io/predict_moteur.js';
    if (fs.existsSync(siteMoteur)) {
      var a = fs.readFileSync(siteMoteur, 'utf8'), b = fs.readFileSync(path.join(__dirname, 'predict_moteur.js'), 'utf8');
      ok(a === b, 'le moteur vendu est identique a celui du site (pas de derive entre les deux depots)');
    } else { console.log('  --   (site absent : garde de derive du moteur non evaluee)'); }
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
