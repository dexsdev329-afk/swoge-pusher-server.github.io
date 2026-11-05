'use strict';
/*
 * SWOGE Roulette — la LOGIQUE d'argent reel (game.rouletteSpin), 05/11/2026.
 *
 * Roue europeenne : 37 cases (0-36) equiprobables, le seul avantage maison est
 * le 0 (RTP = 36/37 sur tout pari standard). L'intention de cet essai :
 *   1. CONSERVATION : apres chaque manche, solde == avant - miseTotale + payout ;
 *      sur des milliers de tours, aucun jeton ne se cree ni ne se perd.
 *   2. BAREME : le gain d'un pari gagnant = mise x (cote+1), cote deduite du
 *      NOMBRE de cases (35/17/11/8/5/2/1) ; un pari perdant rend 0.
 *   3. SECURITE : le serveur refuse tout pari dont les cases ne forment pas un
 *      pari LEGAL (cheval non adjacent, 18 cases qui ne sont pas une chance
 *      simple, case > 36, doublon) ; un refus ne debite RIEN.
 *   4. COFFRE : le bon coffre ($SWOGE vs $SWOGEBET) est debite ET credite, jamais
 *      un pont entre les deux.
 *   5. PROVABLY-FAIR : le resultat ne contient ni graine ni nonce ; le numero se
 *      recalcule a l'identique depuis (serverSeed, clientSeed, nonce) ; le nonce
 *      avance a chaque manche (deux manches ne rejouent pas le meme numero).
 *
 * On REIMPLEMENTE le tirage et le bareme independamment, et on verifie que le
 * moteur rend EXACTEMENT la meme chose, sur beaucoup de tours.
 */
const assert = require('assert');
const crypto = require('crypto');
const ethers = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const ADR = '0x4444444444444444444444444444444444444444';
const sol = (g) => Number(g.balanceStr(ADR));
const solBet = (g) => Number(g.betBalanceStr(ADR));

// --- reimplementation independante (la verite de reference) ---
const ROUGE = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const PAIE = { 1: 35, 2: 17, 3: 11, 4: 8, 6: 5, 12: 2, 18: 1 };
function tire(serverSeed, clientSeed, nonce) {
  const h = crypto.createHmac('sha256', serverSeed).update(clientSeed + ':' + nonce).digest('hex');
  return Number(BigInt('0x' + h.slice(0, 15)) % 37n);
}
// quelques paris LEGAUX connus (verifies a la main sur la grille 3x12)
const col1 = []; for (let k = 0; k < 12; k++) col1.push(3 * k + 1);        // colonne basse : 1,4,...,34
const douze1 = []; for (let i = 1; i <= 12; i++) douze1.push(i);           // 1re douzaine
const rouge = []; for (let i = 1; i <= 36; i++) if (ROUGE.has(i)) rouge.push(i);
const pair = []; for (let i = 2; i <= 36; i += 2) pair.push(i);
const bas = []; for (let i = 1; i <= 18; i++) bas.push(i);

function neuf(credit = 1000000, seed = 'a'.repeat(64), client = 'test') {
  const g = new Game();
  g._p(ADR).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  g.serverSeed = seed;
  g.serverSeedHash = crypto.createHash('sha256').update(seed).digest('hex');
  g._p(ADR).clientSeed = client;
  g._p(ADR).nonce = 0;
  return g;
}

console.log('-- 1. le numero est provably-fair, recalculable, et uniforme 0-36 --');
{
  const g = neuf();
  for (let i = 0; i < 50; i++) {
    const attendu = tire(g.serverSeed, g._p(ADR).clientSeed, g._p(ADR).nonce);
    const r = g.rouletteSpin(ADR, [{ numeros: [0], bet: 1 }], 'swoge');
    eq(r.numero, attendu, 'le numero se recalcule depuis (serverSeed, clientSeed, nonce)');
    ok(r.numero >= 0 && r.numero <= 36, 'numero dans 0-36');
  }
  const cles = Object.keys(g.rouletteSpin(ADR, [{ numeros: [0], bet: 1 }], 'swoge')).join(' ');
  ok(!/serverSeed|graine/i.test(cles) && !/(^|\b)nonce(\b|$)/.test(cles), 'aucune graine ni nonce brut dans le resultat');
  // dispersion : 200 tours couvrent une bonne partie des 37 cases
  const vus = new Set();
  for (let i = 0; i < 200; i++) vus.add(g.rouletteSpin(ADR, [{ numeros: [0], bet: 1 }], 'swoge').numero);
  ok(vus.size >= 30, `200 tours donnent ${vus.size} cases distinctes (le nonce avance)`);
}

console.log('-- 2. deux parties, memes graines+nonce => meme numero (determinisme) --');
{
  const a = neuf(); const b = neuf();
  for (let i = 0; i < 10; i++) {
    const ra = a.rouletteSpin(ADR, [{ numeros: [0], bet: 1 }], 'swoge');
    const rb = b.rouletteSpin(ADR, [{ numeros: [0], bet: 1 }], 'swoge');
    eq(ra.numero, rb.numero, 'meme (serverSeed, clientSeed, nonce) => meme numero');
  }
}

console.log('-- 3. CONSERVATION + BAREME : le moteur egale la reference sur 2000 tours --');
{
  const g = neuf(1000000);
  const PARIS = [
    { numeros: [7], bet: 5 },            // plein 35:1
    { numeros: [1, 2], bet: 3 },         // cheval 17:1
    { numeros: [1, 2, 3], bet: 2 },      // transversale 11:1
    { numeros: [1, 2, 4, 5], bet: 4 },   // carre 8:1
    { numeros: [1, 2, 3, 4, 5, 6], bet: 6 }, // sixain 5:1
    { numeros: col1, bet: 7 },           // colonne 2:1
    { numeros: douze1, bet: 8 },         // douzaine 2:1
    { numeros: rouge, bet: 10 },         // rouge 1:1
    { numeros: pair, bet: 9 },           // pair 1:1
    { numeros: bas, bet: 11 },           // manque 1:1
  ];
  const total = PARIS.reduce((s, b) => s + b.bet, 0);
  let depart = sol(g), misEnJeu = 0, rendu = 0, nbGagne = 0;
  for (let i = 0; i < 2000; i++) {
    const avant = sol(g);
    const attenduNum = tire(g.serverSeed, g._p(ADR).clientSeed, g._p(ADR).nonce);
    const r = g.rouletteSpin(ADR, PARIS, 'swoge');
    eq(r.numero, attenduNum, 'numero conforme a la reference');
    // bareme independant
    let payAttendu = 0;
    for (const b of PARIS) if (b.numeros.includes(r.numero)) payAttendu += b.bet * (PAIE[b.numeros.length] + 1);
    eq(r.payout, payAttendu, 'payout = somme des paris gagnants x (cote+1)');
    eq(r.totalBet, total, 'mise totale = somme des mises');
    eq(sol(g), avant - total + payAttendu, 'le solde bouge EXACTEMENT du net de la manche');
    // les drapeaux gagne/perd sont corrects
    ok(r.paris.every((b) => b.gagne === b.numeros.includes(r.numero)), 'chaque pari marque gagne/perd justement');
    misEnJeu += total; rendu += payAttendu; if (payAttendu > 0) nbGagne++;
  }
  eq(sol(g), depart - misEnJeu + rendu, 'sur 2000 tours : aucun jeton cree ni perdu');
  const rtp = rendu / misEnJeu;
  ok(rtp > 0.80 && rtp < 1.15, `RTP mesure ~${(rtp * 100).toFixed(1)}% (attendu ~97,3%, 2000 tours)`);
}

console.log('-- 4. le 0 : les chances simples et douzaines/colonnes PERDENT, le plein 0 GAGNE --');
{
  // on avance le nonce jusqu'a tomber sur 0, puis on verifie le reglement de CE tour
  const g = neuf(1000000);
  let garde = 0;
  while (tire(g.serverSeed, g._p(ADR).clientSeed, g._p(ADR).nonce) !== 0 && garde < 5000) {
    g.rouletteSpin(ADR, [{ numeros: [0], bet: 1 }], 'swoge'); garde++;
  }
  ok(garde < 5000, 'un tour tombe sur 0');
  const avant = sol(g);
  const r = g.rouletteSpin(ADR, [
    { numeros: rouge, bet: 10 },     // perd
    { numeros: pair, bet: 10 },      // perd (0 n'est pas pair ici)
    { numeros: douze1, bet: 10 },    // perd
    { numeros: col1, bet: 10 },      // perd
    { numeros: [0], bet: 5 },        // plein 0 : gagne 36x
  ], 'swoge');
  eq(r.numero, 0, 'le tour tombe bien sur 0');
  eq(r.payout, 5 * 36, 'seul le plein 0 paie (36x) ; rouge/pair/douzaine/colonne perdent');
  eq(sol(g), avant - (10 + 10 + 10 + 10 + 5) + 5 * 36, 'conservation sur le tour du 0');
}

console.log('-- 5. SECURITE : paris illegaux refuses, rien debite --');
{
  const g = neuf(1000);
  const avant = sol(g);
  const refus = (paris, re, label) => { const r = g.rouletteSpin(ADR, paris, 'swoge'); ok(r && r.error && re.test(r.error), label + ' -> ' + (r && r.error)); };
  refus([{ numeros: [1, 36], bet: 5 }], /illegal/, 'cheval non adjacent 1-36');
  refus([{ numeros: [1, 2, 3, 4], bet: 5 }], /illegal/, '4 cases en ligne (pas un carre)');
  const faux18 = []; for (let i = 1; i <= 17; i++) faux18.push(i); faux18.push(19); // 18 cases mais pas une chance simple
  refus([{ numeros: faux18, bet: 5 }], /illegal/, '18 cases qui ne sont pas rouge/noir/pair/impair/manque/passe');
  refus([{ numeros: [37], bet: 5 }], /bad bet/, 'case hors 0-36');
  refus([{ numeros: [1, 1], bet: 5 }], /illegal/, 'doublon de case');
  refus([{ numeros: [1], bet: 0 }], /bad bet/, 'mise nulle');
  refus([], /no bets/, 'aucun pari');
  eq(sol(g), avant, 'apres tous les refus, le solde n a pas bouge d un jeton');
}

console.log('-- 6. bornes de mise et fonds insuffisants --');
{
  const g = neuf(1000);
  const avant = sol(g);
  const trop = g.rouletteSpin(ADR, [{ numeros: [7], bet: cfg.ROULETTE_MAX_BET + 1 }], 'swoge');
  ok(trop && /max bet/.test(trop.error), 'somme des mises au-dessus du plafond refusee');
  eq(sol(g), avant, 'un refus de plafond ne debite rien');
  // fonds insuffisants -> null (need_deposit cote serveur)
  const pauvre = neuf(3);
  eq(pauvre.rouletteSpin(ADR, [{ numeros: [7], bet: 100 }], 'swoge'), null, 'solde trop juste -> null');
  eq(sol(pauvre), 3, 'un null ne debite rien');
}

console.log('-- 7. COFFRE $SWOGEBET : debite et credite le bon coffre, jamais l autre --');
{
  const g = neuf(1000);
  g._p(ADR).betBalance = ethers.utils.parseUnits('500', cfg.DECIMALS);
  const soldeSwoge = sol(g), avantBet = solBet(g);
  // on tombe sur un plein gagnant pour verifier le credit sur le MEME coffre
  let garde = 0, cible = tire(g.serverSeed, g._p(ADR).clientSeed, g._p(ADR).nonce);
  const r = g.rouletteSpin(ADR, [{ numeros: [cible], bet: 10 }], 'swogebet');
  eq(r.jeton, 'swogebet', 'la manche retient le coffre $SWOGEBET');
  eq(r.numero, cible, 'numero attendu');
  eq(r.payout, 10 * 36, 'plein gagnant paie 36x');
  eq(solBet(g), avantBet - 10 + 360, '$SWOGEBET : debite la mise, credite le gain');
  eq(sol(g), soldeSwoge, 'le coffre $SWOGE n a pas bouge');
}

console.log(n + ' verifications OK');
