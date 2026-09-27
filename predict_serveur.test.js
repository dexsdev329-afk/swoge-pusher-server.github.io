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
 *   6. Une égalité : « egal », P/L 0, hors du win rate ; hors de l'équivalent
 *      PancakeSwap aussi (artefact du pas de prix papier, 0 égalité on-chain
 *      sur 29 959 rounds), comptée à côté (point mort 51,5 %).
 *   7. La martingale ne bouge pas sur une égalité.
 *   8. Une ruine : le cumul toutes caisses, la mise plate et la liste des
 *      ruines survivent (disque compris) ; le journal en ajout seul porte les
 *      labels exacts, les mises réelles et la ruine.
 *   9. Un fichier d'avant le journal : les ruines passées sont comptées.
 *  10. Le taux par niveau de confiance, avec n, et son verdict (1 700 minimum).
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

  console.log('\n-- 6. une ÉGALITÉ : « egal », P/L 0, hors du win rate --');
  {
    P._reset(); spot = 100;
    await P.tic();                               /* round UP ouvert a 100 */
    P._ref().round.tFerme = 0; spot = 100;       /* il ferme au MEME prix */
    await P.tic();
    const e = P.etat(), d = e.dernier[0];
    ok(d.issue === 'egal' && d.egal === true && d.gagne === false && d.pl === 0, 'le round est note « egal », P/L 0 [' + d.issue + ']');
    eq(e.banque.trades, 0, 'il n entre pas dans le win rate (ni win ni loss)');
    eq(e.banque.solde, 1000, 'la banque ne bouge pas');
    eq(e.toutesCaisses.egal, 1, 'le cumul toutes caisses compte l egalite a part');
    /* Une égalité papier (pas de 0,005 du prix médian) n'est pas une égalité
       on-chain (0 sur 29 959 rounds, 8 décimales Chainlink) : l'équivalent
       PancakeSwap ne la compte pas, et dit combien il en laisse de côté. */
    eq(e.pancakeEquivalent.plPlat, 0, 'l equivalent PancakeSwap (plat) ne bouge pas sur une egalite papier');
    eq(e.pancakeEquivalent.plMartingale, 0, 'ni celui de la martingale');
    eq(e.pancakeEquivalent.egalitesExclues, 1, 'l egalite exclue est comptee a cote du chiffre');
    eq(e.pancakeEquivalent.jugees, 0, 'et le chiffre porte sur 0 round juge');
    /* Puis un round gagné : +0,94 × mise, sans reste de l'égalité. */
    await P.tic(); P._ref().round.tFerme = 0; spot = 101; await P.tic();
    const e2 = P.etat();
    ok(e2.dernier[0].issue === 'gagne', 'le round suivant (UP, 100 -> 101) gagne [' + e2.dernier[0].issue + ']');
    eq(e2.pancakeEquivalent.plPlat, 9.4, 'l equivalent PancakeSwap = +0,94 x 10 exactement : l egalite n y a rien laisse');
    eq(e2.pancakeEquivalent.jugees, 1, 'sur 1 round juge, 1 egalite a cote');
    ok(!/lose the whole stake/.test(e2.note) && /29,959/.test(e2.note), 'la note dit d ou viennent les egalites papier');
    eq(e.pancakeEquivalent.pointMort, 51.5, 'le point mort PancakeSwap est dit : 51,5 %');
  }

  console.log('\n-- 7. la martingale ne bouge pas sur une egalite --');
  {
    delete require.cache[require.resolve('./predict_serveur')];
    delete process.env.PREDICT_MART;
    const M = require('./predict_serveur');
    M._reseau(async (body) => {
      if (body.type === 'allMids') return { BNB: String(spot) };
      if (body.type === 'candleSnapshot') return bougiesHausse(60);
      return {};
    });
    M._reset(); spot = 100;
    await M.tic();                                   /* UP a 100, mise 10 */
    M._ref().round.tFerme = 0; spot = 99; await M.tic();   /* perdu -> 20 */
    eq(M._ref().round.mise, 20, 'apres une perte, la martingale double : 20');
    M._ref().round.tFerme = 0; await M.tic();        /* ferme a 99 = ouverture : egalite */
    eq(M.etat().dernier[0].issue, 'egal', 'egalite notee');
    eq(M._ref().round.mise, 20, 'et la mise suivante reste 20 : l egalite ne fait ni monter ni redescendre l echelle');
    eq(M._mart().pertesDaffilee, 1, 'la serie de pertes n a pas bouge');

    console.log('\n-- 8. une ruine : le cumul toutes caisses et la mise plate SURVIVENT --');
    M._reset(); spot = 1000;
    let tours = 0;
    await M.tic();
    while (M.etat().sessions === 1 && tours < 60) { M._ref().round.tFerme = 0; spot -= 1; await M.tic(); tours++; }
    const e = M.etat();
    eq(e.sessions, 2, 'la caisse martingale a ete ruinee apres ' + tours + ' pertes, une caisse neuve repart');
    eq(e.ruines.length, 1, 'la ruine est dans la liste');
    ok(e.ruines[0].trades === tours && e.ruines[0].pl <= -990, 'avec son nombre de trades et sa perte [' + e.ruines[0].trades + ' trades, ' + e.ruines[0].pl + ']');
    eq(e.banque.trades, 0, 'la caisse du moment est neuve (0 trade)…');
    eq(e.toutesCaisses.trades, tours, '…mais le cumul toutes caisses garde tous les trades');
    ok(e.toutesCaisses.pl <= -990 && e.toutesCaisses.ruines === 1, 'et la perte de la caisse ruinee [' + e.toutesCaisses.pl + ']');
    eq(e.plat.pl, -10 * tours, 'la mise plate de 10 sur les MEMES appels : ' + (-10 * tours));
    ok(e.toutesCaisses.mise > e.plat.mise * 3, 'la martingale a mise bien plus que la plate (' + e.toutesCaisses.mise + ' contre ' + e.plat.mise + ')');
    /* Le cumul est sur le disque (sauve) : il survit a un redemarrage. */
    M._reset(); M.charge();
    eq(M.etat().toutesCaisses.trades, tours, 'relu sur disque, le cumul toutes caisses est intact');
    eq(M.etat().ruines.length, 1, 'et la liste des ruines aussi');
    /* Le journal en ajout seul : une ligne par round, une par ruine. */
    const J = fs.readFileSync(M.JOURNAL, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    ok(J.some((l) => l.type === 'ruine' && l.trades === tours), 'le journal porte la ligne de ruine');
    const r = J.filter((l) => l.type === 'round');
    ok(r.length >= tours + 3 && r.every((l) => ['gagne', 'perdu', 'egal'].indexOf(l.issue) >= 0), 'une ligne par round, label exact (gagne / perdu / egal) [' + r.length + ']');
    ok(r.some((l) => l.issue === 'egal') && r.every((l) => typeof l.mise === 'number' && typeof l.session === 'number' && 'confiance' in l),
       'avec les egalites, la mise reelle, la session et la confiance');
  }

  console.log('\n-- 9. un fichier d avant le 27/09 : les ruines passees sont COMPTEES, pas inventees --');
  {
    const F = path.join(BAC, 'predict.json');
    const o = JSON.parse(fs.readFileSync(F, 'utf8'));
    delete o.cumul; delete o.plat; delete o.ruines; delete o.ruinesAvantJournal; delete o.parConfiance; o.sessions = 3;
    fs.writeFileSync(F, JSON.stringify(o));
    P._reset(); P.charge();
    const e = P.etat();
    eq(e.toutesCaisses.ruinesAvantJournal, 2, 'sessions 3 sans liste : 2 ruines d avant le journal');
    eq(e.toutesCaisses.ruines, 2, 'le total des ruines les inclut');
    eq(e.ruines.length, 0, 'sans inventer leurs montants');
  }

  console.log('\n-- 10. le taux mesure par niveau de confiance, avec son n --');
  {
    P._reset();
    const S = P._ref();
    S.parConfiance.HIGH = { n: 312, justes: 150, egal: 4 };
    let c = P.etat().parConfiance;
    ok(/not enough rounds \(312\/1,700\)/.test(c.niveaux.HIGH.verdict) && c.niveaux.HIGH.conclut === false, 'sous 1 700 : « not enough rounds (312/1,700) » [' + c.niveaux.HIGH.verdict + ']');
    eq(c.niveaux.HIGH.taux, 48.1, 'mais le taux mesure est donne, avec n');
    S.parConfiance.HIGH = { n: 2000, justes: 920, egal: 0 };
    c = P.etat().parConfiance;
    ok(c.niveaux.HIGH.verdict === 'worse than a coin flip' && c.niveaux.HIGH.wilson[1] < 50, '46 % sur 2 000 : pire qu une piece [' + c.niveaux.HIGH.wilson + ']');
    S.parConfiance.HIGH = { n: 2000, justes: 1010, egal: 0 };
    eq(P.etat().parConfiance.niveaux.HIGH.verdict, 'coin flip', '50,5 % sur 2 000 : une piece');
    S.parConfiance.HIGH = { n: 2000, justes: 1100, egal: 0 };
    ok(/^edge/.test(P.etat().parConfiance.niveaux.HIGH.verdict), '55 % sur 2 000 : borne basse au-dessus de 51,5 % → edge');
    S.parConfiance.HIGH = { n: 2000, justes: 1040, egal: 0 };
    eq(P.etat().parConfiance.niveaux.HIGH.verdict, 'coin flip', '52 % sur 2 000 : borne basse sous le point mort → pas d edge');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
