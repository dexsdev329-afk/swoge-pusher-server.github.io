'use strict';
/*
 * LE CASINO A DEUX COFFRES — l'essai qui garde l'argent a sa place.
 *
 * Depuis le 08/10/2026, une manche de casino peut etre misee depuis le coffre
 * principal ($SWOGE) OU depuis le coffre des paris ($SWOGEBET) — le meme que le
 * sport. La regle qui tient tout : MEME jeton a l'entree et a la sortie. Une
 * manche ouverte en $SWOGEBET se paie en $SWOGEBET, jamais en $SWOGE — sinon le
 * casino devient une passerelle de conversion entre deux coffres qui ne doivent
 * jamais se parler.
 *
 * Ce que l'essai PROUVE, et pourquoi chaque ligne compte :
 *
 *   • Conservation. Sur des centaines de manches $SWOGEBET, le coffre $SWOGE ne
 *     bouge pas d'un wei — et le coffre des paris finit exactement a
 *     `depart - mises + rendus`. Si un seul gain avait fui vers $SWOGE, le solde
 *     $SWOGE changerait et cette egalite casserait. C'est l'assertion la plus
 *     forte : elle attrape une fuite sans avoir besoin de forcer un gain.
 *
 *   • Aucune economie $SWOGE touchee par le $SWOGEBET : ni net du jour
 *     (classement), ni jackpot, ni revenu maison ($SWOGE), ni volume du mois,
 *     ni record, ni stats par jeu. Comme un pari sportif.
 *
 *   • Comme un pari, le $SWOGEBET compte quand meme comme de l'ACTIVITE :
 *     `dropsToday` avance. Le sport fait pareil (voir le commentaire de `poseParis`
 *     dans game.js) : les missions mesurent l'activite, pas le coffre.
 *
 *   • Le Boulier reste $SWOGE-only : sa cagnotte est partagee et libellee en
 *     $SWOGE ; un $SWOGEBET qui l'alimenterait ou y puiserait serait une
 *     passerelle. On garde donc le Boulier hors du choix de coffre.
 *
 * L'invariant « les paris sportifs sont en $SWOGEBET uniquement » a son propre
 * essai (vault_swogebet.test.js) ; ici on verifie le CASINO.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');
const C = require('./crash');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const sol = (g, a) => Number(g.balanceStr(a));
const bet = (g, a) => Number(g.betBalanceStr(a));

/** Un joueur avec les deux coffres bien garnis. */
function neuf(credit = 1000000000) {
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(credit);
  p.betBalance = WEI(credit);
  return g;
}

/** Instantane de TOUT ce que le $SWOGE possede et qu'un $SWOGEBET ne doit jamais toucher. */
function snapSwoge(g, a) {
  const p = g._p(a);
  const m = g._mois();
  return {
    balance: g.balanceStr(a),
    dayNet: p.dayNet.toString(),
    moisMise: p.moisMise || 0,
    record: JSON.stringify(p.record || null),
    jeux: JSON.stringify(p.jeux || {}),
    jackpot: g.jackpotPot.toString(),
    mises: Number((g._mois().mises || 0).toFixed(6)),
    rendus: Number((g._mois().rendus || 0).toFixed(6)),
    manches: g._mois().manches || 0,
  };
}
function memeSwoge(g, a, s0, label) {
  const s1 = snapSwoge(g, a);
  for (const k of Object.keys(s0)) eq(s1[k], s0[k], label + ' : ' + k + ' inchange');
}

/* ----------------------------------------------------------------------------
 * 1. Les jeux a un coup : conservation sur beaucoup de manches $SWOGEBET.
 *    (smash, volcano, plinko, bonanza, chenil, dod — debit ET credit dans le
 *    meme appel, donc une boucle couvre les gains comme les pertes.)
 * -------------------------------------------------------------------------- */
function boucleSwogebet(g, label, uneManche, tours) {
  const s0 = snapSwoge(g, A);
  const betAvant = bet(g, A);
  const mb0 = Number((g._mois().misesBet || 0).toFixed(6));
  const rb0 = Number((g._mois().rendusBet || 0).toFixed(6));
  let mise = 0, rendu = 0;
  for (let i = 0; i < tours; i++) { const o = uneManche(); mise += o.mise; rendu += o.payout; }

  memeSwoge(g, A, s0, label + ' $SWOGEBET');
  eq(bet(g, A).toFixed(6), (betAvant - mise + rendu).toFixed(6), label + ' : conservation du coffre des paris');
  eq(Number((Number((g._mois().misesBet || 0).toFixed(6)) - mb0).toFixed(6)), mise, label + ' : misesBet = total mise');
  eq(Number((Number((g._mois().rendusBet || 0).toFixed(6)) - rb0).toFixed(6)), rendu, label + ' : rendusBet = total rendu');
}

console.log('-- 1. jeux a un coup : conservation $SWOGEBET --');
{
  const g = neuf();
  boucleSwogebet(g, 'smash', () => { const r = g.spin(A, 10, 'swogebet'); return { mise: 10, payout: r ? r.payout : 0 }; }, 150);
  boucleSwogebet(g, 'volcano', () => { const r = g.volcanoSpin(A, 10, 'swogebet'); return { mise: 10, payout: r.payout }; }, 120);
  boucleSwogebet(g, 'plinko', () => { const r = g.plinkoDrop(A, 20, 8, 'low', 'swogebet'); return { mise: r.mise, payout: r.payout }; }, 120);
  boucleSwogebet(g, 'bonanza', () => { const r = g.bonanzaSpin(A, 10, 'swogebet'); return { mise: r.mise, payout: r.payout }; }, 120);
  boucleSwogebet(g, 'chenil', () => { const r = g.chenilSpin(A, 10, 'swogebet'); return { mise: r.mise, payout: r.payout }; }, 120);
  boucleSwogebet(g, 'dod', () => { const r = g.dodSpin(A, 10, 'swogebet'); return { mise: r.mise, payout: r.payout }; }, 120);
  ok(g._p(A).dropsToday >= 150, 'le $SWOGEBET compte comme de l activite (dropsToday avance, comme un pari)');
  console.log('  ok   aucun wei de $SWOGE touche, coffre des paris conserve, misesBet/rendusBet a part');
}

/* ----------------------------------------------------------------------------
 * 2. Le meme jeu en $SWOGE : comportement d'avant, a l'identique.
 * -------------------------------------------------------------------------- */
console.log('-- 2. le $SWOGE, inchange --');
{
  const g = neuf();
  const betAvant = bet(g, A);
  const balAvant = sol(g, A);
  let mise = 0, rendu = 0;
  for (let i = 0; i < 150; i++) { const r = g.spin(A, 10, 'swoge'); mise += 10; rendu += r ? r.payout : 0; }
  eq(bet(g, A), betAvant, 'le coffre des paris ne bouge pas quand on joue en $SWOGE');
  eq(sol(g, A).toFixed(6), (balAvant - mise + rendu).toFixed(6), 'conservation du coffre $SWOGE');
  eq(Number((g._mois().mises || 0).toFixed(6)), mise, 'le revenu maison compte bien les mises $SWOGE');
  eq((g._p(A).moisMise || 0), mise, 'le volume du mois avance en $SWOGE');
  ok(g._p(A).jeux && g._p(A).jeux.smash, 'les stats par jeu existent en $SWOGE');
  eq((g._mois().misesBet || 0), 0, 'aucune mise $SWOGEBET notee : on a joue en $SWOGE');
  console.log('  ok   $SWOGE : solde, net du jour, revenu, volume, stats — tout bouge comme avant');
}

/* ----------------------------------------------------------------------------
 * 3. Les jeux a plusieurs temps : la mise part du bon coffre, le gain y revient,
 *    et rien de $SWOGE ne bouge. Un tour representatif par jeu.
 * -------------------------------------------------------------------------- */
console.log('-- 3. jeux a plusieurs temps : debit et reglement isoles --');

// mines : ouverture, un pick, encaissement si sur
{
  const g = neuf();
  const s0 = snapSwoge(g, A);
  const b0 = bet(g, A);
  g.minesStart(A, 50, 1, 'swogebet');
  eq(bet(g, A), b0 - 50, 'mines : la mise part du coffre des paris');
  memeSwoge(g, A, s0, 'mines ouverture');
  let payout = 0;
  const st = g.minesPick(A, 0);
  if (!st.perdu) { const v = g.minesCashOut(A); payout = v.payout; }
  memeSwoge(g, A, s0, 'mines fin');
  eq(bet(g, A).toFixed(6), (b0 - 50 + payout).toFixed(6), 'mines : conservation du coffre des paris');
  ok(true, 'mines OK');
}

// hi-lo : ouverture, un pas, encaissement si pas perdu
{
  const g = neuf();
  const s0 = snapSwoge(g, A);
  const b0 = bet(g, A);
  let st = g.hiloStart(A, 50, 'swogebet');
  eq(bet(g, A), b0 - 50, 'hi-lo : la mise part du coffre des paris');
  memeSwoge(g, A, s0, 'hi-lo ouverture');
  let payout = 0;
  const sens = st.peutMonter ? 'higher' : 'lower';
  st = g.hiloStep(A, sens);
  if (!st.perdu && !st.fini) { const v = g.hiloCashOut(A); payout = v.payout; }
  else if (st.encaisse) { payout = st.payout || 0; }
  memeSwoge(g, A, s0, 'hi-lo fin');
  eq(bet(g, A).toFixed(6), (b0 - 50 + payout).toFixed(6), 'hi-lo : conservation du coffre des paris');
  ok(true, 'hi-lo OK');
}

// Three Card : donne puis decision
{
  const g = neuf();
  const s0 = snapSwoge(g, A);
  const b0 = bet(g, A);
  g.casinoDeal(A, 'three', 50, 0, 'swogebet');
  ok(bet(g, A) < b0, 'cards : la mise part du coffre des paris');
  memeSwoge(g, A, s0, 'cards donne');
  const st = g.casinoDecide(A, true);
  const staked = st.result.staked, payout = st.result.payout;
  memeSwoge(g, A, s0, 'cards fin');
  eq(bet(g, A).toFixed(6), (b0 - staked + payout).toFixed(6), 'cards : conservation du coffre des paris');
  ok(true, 'cards OK');
}

// Blackjack : mise puis stand (ou naturel qui finit tout de suite)
{
  const g = neuf();
  const s0 = snapSwoge(g, A);
  const b0 = bet(g, A);
  let st = g.bjBet(A, 50, {}, 'swogebet');
  /* Un naturel se regle des la donne : ce qui est deja rendu revient au MEME coffre. */
  eq(bet(g, A).toFixed(6), (b0 - 50 + (st.stage === 'done' ? (st.payout || 0) : 0)).toFixed(6),
     'blackjack : la mise part du coffre des paris (et un naturel y revient)');
  if (st.stage !== 'done') st = g.bjStand(A);
  memeSwoge(g, A, s0, 'blackjack fin');
  eq(bet(g, A).toFixed(6), (b0 - 50 + (st.payout || 0)).toFixed(6), 'blackjack : conservation du coffre des paris');
  ok(st.jeton === 'swogebet', 'blackjack : l etat public porte le jeton misé');
  ok(true, 'blackjack OK');
}

// Blackjack avec annexes : la mise annexe part AUSSI du coffre des paris
{
  const g = neuf();
  const s0 = snapSwoge(g, A);
  const b0 = bet(g, A);
  let st = g.bjBet(A, 50, { pp: 10, tp: 10 }, 'swogebet');
  /* Les annexes se reglent A LA DONNE (elles ne lisent que les trois premieres
     cartes) : un 21+3 gagnant est deja paye quand bjBet rend la main. On
     verifie donc debit ET premiers reglements, tous sur le coffre des paris. */
  const a0 = st.annexes || {};
  const dejaRendu = ((a0.pp && a0.pp.gain) || 0) + ((a0.tp && a0.tp.gain) || 0) + (st.stage === 'done' ? (st.payout || 0) : 0);
  eq(bet(g, A).toFixed(6), (b0 - 70 + dejaRendu).toFixed(6),
     'blackjack+annexes : mise principale + 2 annexes debitees du coffre des paris, gains de la donne rendus au meme coffre');
  memeSwoge(g, A, s0, 'blackjack+annexes donne');
  if (st.stage !== 'done') st = g.bjStand(A);
  const a = st.annexes || {};
  const gainAnn = (a.pp.gain || 0) + (a.tp.gain || 0);
  memeSwoge(g, A, s0, 'blackjack+annexes fin');
  eq(bet(g, A).toFixed(6), (b0 - 70 + (st.payout || 0) + gainAnn).toFixed(6), 'blackjack+annexes : conservation (annexes comprises)');
  ok(true, 'blackjack annexes OK');
}

// Crash : la mise part, la manche casse sans encaissement -> perte, rien de $SWOGE
{
  const g = neuf();
  const s0 = snapSwoge(g, A);
  const b0 = bet(g, A);
  let t = 1000000;
  g.crashTick(t);
  if (g.crash.phase !== C.ATTENTE) g.crashTick(g.crash.jusqua + 1);
  g.crashMise(A, 50, 0, t, 'swogebet');
  eq(bet(g, A), b0 - 50, 'crash : la mise part du coffre des paris');
  memeSwoge(g, A, s0, 'crash mise');
  // on envoie la manche en vol puis on la laisse casser : aucun retrait => perte
  g.crashTick(g.crash.jusqua);
  let garde = 0;
  while (g.crash.phase !== C.ATTENTE && garde++ < 10000) g.crashTick(g.crash.jusqua + 1);
  memeSwoge(g, A, s0, 'crash apres le crash');
  eq(bet(g, A), b0 - 50, 'crash : mise perdue uniquement sur le coffre des paris');
  ok(true, 'crash OK');
}

/* ----------------------------------------------------------------------------
 * 3bis. La copie PUBLIQUE d'un encaissement Crash ne porte ni solde ni coffre.
 *    Le 08/10, `betBalance` partait a toute la table dans cette copie : le solde
 *    $SWOGEBET d'un joueur lisible par n'importe qui. On encaisse pour de vrai,
 *    en $SWOGEBET, et on verifie ce qui partirait a tout le monde.
 * -------------------------------------------------------------------------- */
console.log('-- 3bis. la copie publique d un encaissement Crash ne porte ni solde ni coffre --');
{
  const g = neuf();
  let t = 1000000;
  g.crashTick(t);
  if (g.crash.phase !== C.ATTENTE) g.crashTick(g.crash.jusqua + 1);
  g.crashMise(A, 50, 1.01, t, 'swogebet');            // retrait automatique a 1,01x
  let ev = null, garde = 0, now = g.crash.jusqua;
  while (!ev && garde++ < 20000) {
    for (const e of g.crashTick(now)) if (e.type === 'crashRetrait' && e.addr === A) ev = e;
    now += 50;
  }
  if (ev) {
    ok(ev.betBalance != null && ev.jeton === 'swogebet', 'le joueur, lui, recoit son solde $SWOGEBET et son coffre');
    const pub = C.retraitPublic(ev);
    for (const k of ['balance', 'betBalance', 'jeton', 'moi'])
      ok(!(k in pub), 'copie publique : pas de ' + k);
    for (const k of ['addr', 'mise', 'multi', 'payout', 'net'])
      ok(k in pub, 'copie publique : garde ' + k + ' (le spectacle de la table)');
  } else {
    /* La courbe a pu casser sous 1,01x : on verifie alors la fonction sur un
       evenement construit — elle ne doit rien laisser passer de personnel. */
    const pub = C.retraitPublic({ type: 'crashRetrait', addr: A, mise: 50, multi: 2, payout: 100, net: 50,
                                  balance: '1', betBalance: '2', jeton: 'swogebet', moi: true });
    for (const k of ['balance', 'betBalance', 'jeton', 'moi']) ok(!(k in pub), 'copie publique : pas de ' + k);
  }
  console.log('  ok   rien de personnel dans ce que voit la table');
}

/* ----------------------------------------------------------------------------
 * 4. Le Boulier reste $SWOGE-only (cagnotte partagee, libellee en $SWOGE).
 *    On verifie que la methode n'a PAS pris de parametre de coffre : si un jour
 *    quelqu'un la tokenise, cet essai tombe et oblige a decider la cagnotte.
 * -------------------------------------------------------------------------- */
console.log('-- 4. le Boulier reste $SWOGE-only --');
{
  const g = neuf();
  eq(g.boulierInscrit.length, 3, 'boulierInscrit(addr, grilles, now) : pas de parametre de coffre');
  console.log('  ok   le Boulier ne propose pas le choix de coffre (sa cagnotte est $SWOGE)');
}

/* ----------------------------------------------------------------------------
 * 5. Garde-fous d'arite : les jeux tokenises acceptent bien un jeton.
 * -------------------------------------------------------------------------- */
console.log('-- 5. les jeux tokenises prennent un jeton --');
{
  const g = neuf();
  ok(g.spin.length >= 3, 'smash : spin(addr, bet, jeton)');
  ok(g.volcanoSpin.length >= 3, 'volcano : volcanoSpin(addr, bet, jeton)');
  ok(g.plinkoDrop.length >= 5, 'plinko : plinkoDrop(addr, mise, rangees, risque, jeton)');
  ok(g.hiloStart.length >= 3, 'hi-lo : hiloStart(addr, mise, jeton)');
  ok(g.minesStart.length >= 4, 'mines : minesStart(addr, mise, nbMines, jeton)');
  ok(g.casinoDeal.length >= 5, 'cards : casinoDeal(addr, game, ante, side, jeton)');
  ok(g.bjBet.length >= 4, 'blackjack : bjBet(addr, amount, annexes, jeton)');
  ok(g.crashMise.length >= 5, 'crash : crashMise(addr, mise, auto, now, jeton)');
  ok(g.dodAchat.length >= 4, 'dod achat : dodAchat(addr, mise, cran, jeton)');
  ok(g.bonanzaAchat.length >= 3, 'bonanza achat : bonanzaAchat(addr, mise, jeton)');
  console.log('  ok   tous les jeux de mise acceptent le choix de coffre');
}

console.log('\ncasino_deux_coffres.test.js : ' + n + ' verifications OK');
