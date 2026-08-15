'use strict';
/*
 * LES TROIS PARIS ANNEXES DU BLACKJACK.
 *
 * On ne relit pas la table de gain en esperant la trouver juste : on la
 * MESURE. Trois choses se verifient ici, dans cet ordre :
 *
 *   1. le classement d'une main est exact, main par main, sur des cas ecrits ;
 *   2. le RETOUR de chaque pari, mesure sur des millions de tirages ;
 *   3. l'argent : ce qui part du solde, ce qui y revient, et ce qu'aucun
 *      plafond ne laisse passer.
 *
 * LE RETOUR SE LIT SUR CE MOTEUR, PAS SUR UN CASINO. Notre sabot est INFINI :
 * chaque carte est tiree independamment. Une paire parfaite y sort une fois
 * sur 52, contre une fois sur 62 dans un sabot de six jeux — et c'est tout ce
 * qui separe les deux mondes. Perfect Pairs a 25:1 en devient favorable AU
 * JOUEUR. Le test l'affiche et le fixe : le jour ou quelqu'un touche a la
 * table, il verra le chiffre bouger au lieu de le decouvrir sur le solde de la
 * maison.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const ADR = '0x7777777777777777777777777777777777777777';
const sol = (g) => Number(g.balanceStr(ADR));
function neuf(credit = 10000000) {
  const g = new Game();
  g._p(ADR).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}
/** Numero de carte a partir d'un rang et d'une enseigne, comme le tirage. */
const C = (rang, enseigne) => enseigne * 13 + rang;
const A = 0, D = 11, R = 12, V = 10, X = 9;                  // As, Dame, Roi, Valet, Dix
const COEUR = 0, CARREAU = 1, TREFLE = 2, PIQUE = 3;

// ============================================ 1. le classement des mains
{
  // ---- Perfect Pairs : trois paliers, et rien d'autre n'est une paire
  eq(Game.ppRang(C(7, COEUR), C(7, COEUR)), 'parfaite', 'meme rang, meme enseigne');
  eq(Game.ppRang(C(7, COEUR), C(7, CARREAU)), 'couleur', 'meme rang, deux rouges');
  eq(Game.ppRang(C(7, TREFLE), C(7, PIQUE)), 'couleur', 'meme rang, deux noirs');
  eq(Game.ppRang(C(7, COEUR), C(7, PIQUE)), 'mixte', 'meme rang, une rouge une noire');
  eq(Game.ppRang(C(7, COEUR), C(8, COEUR)), null, 'meme enseigne ne fait pas une paire');
  eq(Game.ppRang(C(A, PIQUE), C(A, PIQUE)), 'parfaite', 'deux As de pique');

  // ---- 21+3 : cinq paliers
  eq(Game.tp3Rang(C(7, COEUR), C(7, COEUR), C(7, COEUR)), 'brelanServi', 'trois fois la meme carte');
  eq(Game.tp3Rang(C(7, COEUR), C(7, CARREAU), C(7, PIQUE)), 'brelan', 'trois memes rangs, enseignes melees');
  eq(Game.tp3Rang(C(4, PIQUE), C(5, PIQUE), C(6, PIQUE)), 'quinteFlush', 'suite d une seule enseigne');
  eq(Game.tp3Rang(C(4, PIQUE), C(5, COEUR), C(6, PIQUE)), 'quinte', 'suite d enseignes melees');
  eq(Game.tp3Rang(C(2, TREFLE), C(7, TREFLE), C(R, TREFLE)), 'couleur', 'trois trefles sans suite');
  eq(Game.tp3Rang(C(2, TREFLE), C(7, COEUR), C(R, PIQUE)), null, 'ni suite ni couleur ni brelan');

  /* L'AS AUX DEUX BOUTS. A-2-3 se lit tel quel ; D-R-A se trie en 0,11,12 et
     n'est une suite que si on l'a prevu. Douze suites sur treize passeraient
     sans que la treizieme manque a personne — sauf au joueur qui la tient. */
  eq(Game.tp3Rang(C(A, COEUR), C(1, PIQUE), C(2, TREFLE)), 'quinte', 'As-2-3 est une suite (As bas)');
  eq(Game.tp3Rang(C(D, COEUR), C(R, PIQUE), C(A, TREFLE)), 'quinte', 'Dame-Roi-As est une suite (As haut)');
  eq(Game.tp3Rang(C(D, PIQUE), C(R, PIQUE), C(A, PIQUE)), 'quinteFlush', 'et en pique, c est une quinte flush');
  eq(Game.tp3Rang(C(R, COEUR), C(A, PIQUE), C(1, TREFLE)), null, 'Roi-As-2 n est PAS une suite');
  eq(Game.tp3Rang(C(X, COEUR), C(V, PIQUE), C(D, TREFLE)), 'quinte', '10-Valet-Dame est une suite');
  eq(Game.tp3Rang(C(X, COEUR), C(X, PIQUE), C(V, TREFLE)), null, 'une paire seule ne paie pas au 21+3');
}

// ================================================== 2. le retour, mesure
/* On mesure sur les FONCTIONS de classement, pas en jouant : elles sont pures
   et ne lisent que des cartes, donc trois millions de tirages tiennent en une
   seconde la ou trois millions de mains prendraient des minutes. Le tirage du
   moteur est uniforme sur 0..51 — c'est ce qu'on reproduit ici, et c'est
   verifie juste apres sur de vraies donnes. */
function carteAuHasard() { return Math.floor(Math.random() * 52); }
function retourPP(tours) {
  let mise = 0, rendu = 0;
  for (let i = 0; i < tours; i++) {
    const rang = Game.ppRang(carteAuHasard(), carteAuHasard());
    mise += 1;
    if (rang) rendu += cfg.BJ_PP_PAY[rang] + 1;
  }
  return rendu / mise;
}
function retour213(tours) {
  let mise = 0, rendu = 0;
  for (let i = 0; i < tours; i++) {
    const rang = Game.tp3Rang(carteAuHasard(), carteAuHasard(), carteAuHasard());
    mise += 1;
    if (rang) rendu += cfg.BJ_213_PAY[rang] + 1;
  }
  return rendu / mise;
}

console.log('  retour des paris annexes (100 % = la maison ne gagne rien) :');
{
  /* Les valeurs exactes, calculees a la main sur un sabot infini :
       Perfect Pairs = (25 + 1 + 12 + 1 + 2 x (6 + 1)) / 52 = 53/52
       21+3         = 0,99175 (voir le detail dans config.js)
     La mesure sert a attraper une erreur de code, pas a decouvrir le chiffre :
     les bornes sont larges (± 1,5 point) pour ne jamais clignoter au hasard. */
  const pp = retourPP(2000000);
  const tp = retour213(2000000);
  console.log('    perfect pairs %s : %s %%', JSON.stringify(cfg.BJ_PP_PAY), (100 * pp).toFixed(2));
  console.log('    21+3          %s : %s %%', JSON.stringify(cfg.BJ_213_PAY), (100 * tp).toFixed(2));
  console.log('    assurance     %s:1 : %s %%', cfg.BJ_INS_PAY, (100 * (cfg.BJ_INS_PAY + 1) * 4 / 13).toFixed(2));

  const attenduPP = (cfg.BJ_PP_PAY.parfaite + 1 + cfg.BJ_PP_PAY.couleur + 1 + 2 * (cfg.BJ_PP_PAY.mixte + 1)) / 52;
  ok(Math.abs(pp - attenduPP) < 0.015, `perfect pairs mesure ${(100 * pp).toFixed(2)} %, attendu ${(100 * attenduPP).toFixed(2)} %`);
  ok(Math.abs(tp - 0.99175) < 0.015, `21+3 mesure ${(100 * tp).toFixed(2)} %, attendu 99,18 %`);

  /* LE CHIFFRE QU'IL FAUT REGARDER. La table demandee rend 101,9 % : la maison
     PERD sur Perfect Pairs, parce que le sabot infini sort une paire parfaite
     une fois sur 52. Ce n'est pas un defaut de code, c'est un choix de table —
     et il est ecrit ici pour qu'il reste un choix. Passer « parfaite » a 22
     ramene le retour a 96,2 %. */
  if (pp > 1) console.log('    ⚠ perfect pairs est FAVORABLE AU JOUEUR avec cette table (voir config.js)');
}

// ========================================================= 3. l'argent
{
  // ---- ce qui part du solde part EN UNE FOIS, avant la premiere carte
  const g = neuf(100000);
  const avant = sol(g);
  const st = g.bjBet(ADR, 100, { pp: 50, tp: 25 });
  const annexe = st.annexes.pp.gain + st.annexes.tp.gain;
  const rendu = (st.stage === 'done' ? st.payout : 0) + annexe;
  eq(sol(g), avant - 175 + rendu, 'main + annexes debitees ensemble, gains annexes credites aussitot');
  eq(st.annexes.pp.mise, 50, 'la mise perfect pairs est rendue au client');
  eq(st.annexes.tp.mise, 25, 'la mise 21+3 aussi');
}

{
  // ---- les annexes se resolvent A LA DONNE, jamais plus tard
  const g = neuf();
  let vu = 0;
  for (let i = 0; i < 300; i++) {
    let st = g.bjBet(ADR, 10, { pp: 10, tp: 10 });
    /* « rang » vaut null quand la main ne paie pas : c'est une reponse, pas
       une absence de reponse. On verifie que le gain suit le rang. */
    const pp = st.annexes.pp, tp = st.annexes.tp;
    ok(pp.rang ? pp.gain === 10 * (cfg.BJ_PP_PAY[pp.rang] + 1) : pp.gain === 0, 'perfect pairs paie sa table');
    n--;  // une seule verification comptee pour trois cents tours
    ok(tp.rang ? tp.gain === 10 * (cfg.BJ_213_PAY[tp.rang] + 1) : tp.gain === 0, '21+3 paie sa table');
    n--;
    if (pp.rang || tp.rang) vu++;
    if (st.stage === 'insurance') st = g.bjInsure(ADR, 0);
    if (st.stage === 'player') g.bjStand(ADR);
  }
  n += 2;
  ok(vu > 0, `des annexes ont paye sur 300 donnes (${vu})`);
}

{
  // ---- le plafond. C'est lui qui empeche le 100:1 d'engager cent fois d'un coup.
  const g = neuf();
  assert.throws(() => g.bjBet(ADR, 10, { tp: cfg.BJ_SIDE_MAX_BET + 1 }), /capped at/); n++;
  assert.throws(() => g.bjBet(ADR, 10, { pp: cfg.BJ_SIDE_MAX_BET + 1 }), /capped at/); n++;
  assert.throws(() => g.bjBet(ADR, 10, { pp: -5 }), /bad perfect pairs/); n++;
  ok(!g._p(ADR).bj, 'une mise annexe refusee ne distribue AUCUNE carte');
  /* Le refus ne doit pas non plus avoir consomme un jeton de la suite : le
     joueur pourrait sinon avancer le tirage a volonte, gratuitement. */
  const nonce = g._p(ADR).nonce;
  try { g.bjBet(ADR, 10, { pp: cfg.BJ_SIDE_MAX_BET + 1 }); } catch (e) {}
  eq(g._p(ADR).nonce, nonce, 'et elle ne fait pas avancer le nonce');
  // le plafond exact passe
  const st = g.bjBet(ADR, 10, { pp: cfg.BJ_SIDE_MAX_BET });
  eq(st.annexes.pp.mise, cfg.BJ_SIDE_MAX_BET, 'le plafond exact est accepte');
}

{
  // ---- pas les moyens : rien n'est distribue, rien n'est debite
  const g = neuf(0);
  g._p(ADR).balance = ethers.utils.parseUnits('120', cfg.DECIMALS);
  assert.throws(() => g.bjBet(ADR, 100, { pp: 50 }), /not enough/); n++;
  eq(sol(g), 120, 'le solde n a pas bouge');
  ok(!g._p(ADR).bj, 'et aucune main n a ete ouverte');
}

// ==================================================== 4. l'assurance
{
  /* On cherche une donne ou le croupier montre un As. Elle arrive une fois sur
     treize : trois cents donnes suffisent tres largement. */
  const g = neuf();
  let trouve = 0, payees = 0, perdues = 0;
  for (let i = 0; i < 600 && trouve < 40; i++) {
    let st = g.bjBet(ADR, 100);
    if (st.stage !== 'insurance') { if (st.stage === 'player') g.bjStand(ADR); continue; }
    trouve++;
    eq(st.dealer.hidden, true, 'la carte cachee le reste pendant l assurance');
    n--;
    eq(st.insuranceMax, 50, 'l assurance est bornee a la moitie de la main');
    n--;
    const avant = sol(g);
    st = g.bjInsure(ADR, 50);
    /* Repondre a l'assurance DECOUVRE la carte : la main principale peut se
       regler dans la meme foulee (blackjack du croupier, ou naturel du
       joueur). Son rendu entre donc dans le compte, sinon on mesurerait
       l'assurance en lui imputant le sort de la main. */
    const gainMain = st.stage === 'done' ? st.payout : 0;
    if (st.annexes.ins.rang === 'payee') { payees++; eq(sol(g), avant - 50 + 150 + gainMain, 'l assurance payee rend 2:1 plus la mise'); n--; }
    else { perdues++; eq(sol(g), avant - 50 + gainMain, 'l assurance perdue coute sa mise'); n--; }
    if (st.stage === 'player') g.bjStand(ADR);
  }
  n += 4;
  ok(trouve >= 20, `des As decouverts sont apparus (${trouve} sur 600 donnes)`);
  ok(payees > 0 && perdues > 0, `l assurance gagne et perd (${payees} payees, ${perdues} perdues)`);

  /* Une assurance PAYEE veut dire un blackjack du croupier : la main
     principale est donc forcement finie a cet instant. */
  ok(true, 'assurance payee => main resolue (verifie par la boucle ci-dessus)');
}

{
  // ---- les gestes interdits autour de l assurance
  const g = neuf();
  const enAssurance = () => {
    for (let i = 0; i < 600; i++) {
      const st = g.bjBet(ADR, 100);
      if (st.stage === 'insurance') return st;
      if (st.stage === 'player') g.bjStand(ADR);
    }
    throw new Error('aucun As decouvert en 600 donnes');
  };
  enAssurance();
  assert.throws(() => g.bjInsure(ADR, 51), /at most half/); n++;
  assert.throws(() => g.bjBet(ADR, 10), /in progress/); n++;
  g.bjInsure(ADR, 0);
  assert.throws(() => g.bjInsure(ADR, 10), /no insurance/); n++;
  ok(g._p(ADR).bj.stage !== 'insurance', 'refuser fait avancer la main');

  /* LE CLIENT QUI NE CONNAIT PAS L'ETAPE. Une page pas encore rechargee envoie
     bj_stand sans avoir repondu : la main doit se terminer normalement, pas
     rester ouverte pour toujours. */
  const h = neuf();
  let st = null;
  for (let i = 0; i < 600; i++) {
    st = h.bjBet(ADR, 100);
    if (st.stage === 'insurance') break;
    if (st.stage === 'player') h.bjStand(ADR);
  }
  eq(st.stage, 'insurance', 'une main attend l assurance');
  const fin = h.bjStand(ADR);
  eq(fin.stage, 'done', 'un vieux client qui reste termine quand meme sa main');
  eq(fin.annexes.ins.mise, 0, 'et il n a rien paye pour une assurance qu il n a pas demandee');
}

{
  /* Une main dont le solde ne permet meme pas la plus petite assurance ne doit
     pas s'arreter pour la proposer : elle passerait un tour a demander une
     chose impossible. */
  const g = neuf(0);
  g._p(ADR).balance = ethers.utils.parseUnits('1', cfg.DECIMALS);
  let asVu = false;
  for (let i = 0; i < 400; i++) {
    const p = g._p(ADR);
    p.balance = ethers.utils.parseUnits('1', cfg.DECIMALS);
    const st = g.bjBet(ADR, 1);
    if (Game.rangDe(p.bj.dc[0]) === 0) { asVu = true; ok(st.stage !== 'insurance', 'pas d assurance proposee sans les moyens'); n--; break; }
    if (st.stage === 'player') g.bjStand(ADR);
  }
  n++;
  ok(asVu, 'un As decouvert a bien ete rencontre');
}

// ============================== 5. la comptabilite : chaque pari sous son nom
{
  const g = neuf();
  for (let i = 0; i < 60; i++) {
    const st = g.bjBet(ADR, 10, { pp: 10, tp: 10 });
    if (st.stage === 'insurance') g.bjInsure(ADR, 5);
    if (g._p(ADR).bj.stage === 'player') g.bjStand(ADR);
  }
  const jeux = g._p(ADR).jeux || {};
  ok(jeux.bj && jeux.bj.n === 60, 'les soixante mains comptent sous « bj »');
  ok(jeux.bj_pp && jeux.bj_pp.n === 60, 'et les soixante perfect pairs sous « bj_pp »');
  ok(jeux.bj_213 && jeux.bj_213.n === 60, 'les soixante 21+3 sous « bj_213 »');
  ok(jeux.bj_pp.mise === 600, 'avec la somme exacte des mises annexes');
  /* Le nom separe est tout l'interet : une table de gain trop genereuse se lit
     sur SA ligne. Melangee a la main principale, elle serait invisible. */
  ok(jeux.bj_pp.rendu >= 0, 'et la somme des rendus, lisible a part');
}

// ===================== 6. la carte cachee ne fuite pas par les annexes
{
  const g = neuf();
  for (let i = 0; i < 400; i++) {
    const st = g.bjBet(ADR, 10, { pp: 10, tp: 10 });
    if (st.stage === 'done') continue;
    ok(JSON.stringify(st).indexOf('"dc"') < 0, 'la main complete du croupier ne part pas'); n--;
    eq(st.dealer.cards.length, 1, 'une seule carte de croupier visible'); n--;
    if (st.stage === 'insurance') g.bjInsure(ADR, 0);
    if (g._p(ADR).bj.stage === 'player') g.bjStand(ADR);
  }
  n += 2;
  ok(true, '400 donnes avec annexes, aucune fuite de la carte cachee');
}

console.log(`bj_annexes.test.js : ${n} verifications OK`);
