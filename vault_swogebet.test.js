'use strict';
/*
 * LES PARIS SE JOUENT EN $SWOGEBET, ET RIEN D'AUTRE
 *
 * « Il faudrait faire le contrat vault SWOGEBET pour qu'on puisse jouer aux
 *   paris qu'avec du SWOGEBET. »
 *
 * Le contrat est dans le depot du site (contrats/SwogeBetVault.sol) et son
 * banc y tourne sur une machine virtuelle. Ici, c'est le SERVEUR qu'on
 * mesure : un second solde par joueur, credite par le coffre des paris,
 * debite par les paris, rendu par un bon signe pour CE coffre — et le $SWOGE
 * qui ne bouge pas d'un jeton pendant tout ca.
 *
 * Ce qui est verifie :
 *   1. un depot dans le coffre des paris credite le solde des paris, pas le
 *      $SWOGE, et une meme transaction n'est creditee qu'une fois ;
 *   2. un pari ne peut pas se payer en $SWOGE ; il debite le solde des paris,
 *      et le gain comme le remboursement y reviennent ;
 *   3. un retrait autorise un cumul propre au coffre des paris, avec le
 *      frais du serveur, et le « du » se rattrape sur ce que la chaine dit ;
 *   4. les champs survivent a une sauvegarde relue, et une fiche qui ne
 *      porte que du $SWOGEBET n'est pas jetee comme vide ;
 *   5. la colle de chaine signe dans le domaine « SwogeBetVault » : un bon
 *      signe pour le coffre des paris ne se verifie pas dans le domaine du
 *      coffre $SWOGE, et reciproquement.
 */
const assert = require('assert');
const { ethers } = require('ethers');

process.env.SIGNER_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.BET_VAULT_ADDRESS = '0x' + 'be'.repeat(20);
process.env.VAULT_ADDRESS = '0x' + 'ca'.repeat(20);

const { Game } = require('./game');
const { Chain } = require('./chain');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; console.log('  ok   ' + m); };

const A = '0x' + 'a1'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const AVANT = Date.parse('2026-08-15T09:00:00Z');
const M = 'efl-20260815-bol-pre';

console.log('\n-- un depot dans le coffre des paris --');
{
  const g = new Game();
  const p = g._p(A);
  ok(g.creditBetDeposit({ player: A, amount: W(500), tx: '0xt1' }), 'le depot est credite');
  eq(g.betBalanceStr(A), '500.0', 'sur le solde des PARIS');
  eq(g.balanceStr(A), '0.0', 'et pas un jeton sur le solde $SWOGE');
  ok(!g.creditBetDeposit({ player: A, amount: W(500), tx: '0xt1' }), 'la meme transaction ne credite pas deux fois');
  eq(p.betDeposited.toString(), W(500).toString(), 'le total depose en $SWOGEBET est retenu a part');
  ok(!p.hasDeposited, 'et il n ouvre pas les missions du $SWOGE : ce n est pas un depot de $SWOGE');
}

console.log('\n-- un pari se paie en $SWOGEBET, jamais en $SWOGE --');
{
  const g = new Game();
  g._p(A).balance = W(1000000);
  jete(() => g.parie(A, M, '1', 1000, AVANT), /not enough \$SWOGEBET/,
       'un million de $SWOGE ne paie pas un pari de mille : « ' + (() => { try { g.parie(A, M, '1', 1000, AVANT); } catch (e) { return e.message; } })() + ' »');
  g.creditBetDeposit({ player: A, amount: W(5000), tx: '0xt2' });
  const pari = g.parie(A, M, '1', 1000, AVANT);
  eq(g.betBalanceStr(A), '4000.0', 'la mise part du solde des paris');
  eq(g.balanceStr(A), '1000000.0', 'et le $SWOGE n a pas bouge');
  g.regleMatch(M, '1');
  const gain = Number(g.betBalanceStr(A)) - 4000;
  ok(Math.abs(gain - pari.rapport) < 1e-6, 'le gain revient au solde des paris (+' + gain + ' pour un rapport de ' + pari.rapport + ')');
  eq(g.balanceStr(A), '1000000.0', 'toujours pas un jeton de $SWOGE');
  const g2 = new Game();
  g2.creditBetDeposit({ player: A, amount: W(5000), tx: '0xt3' });
  g2.parie(A, M, '2', 1000, AVANT);
  g2.rembourseMatch(M);
  eq(g2.betBalanceStr(A), '5000.0', 'un match rembourse rend la mise au solde des paris');
}

console.log('\n-- un ticket pose en $SWOGE hier est paye en $SWOGE --');
{
  /* « Des gens ont mise en $SWOGE hier : toutes les mises en $SWOGE devront
     etre payees en $SWOGE. » Un ticket d'avant le coffre des paris n'a pas de
     monnaie ecrite : sa mise est partie du $SWOGE, son gain y revient. */
  const g = new Game();
  g.creditBetDeposit({ player: A, amount: W(5000), tx: '0xt7' });
  const neuf = g.parie(A, M, '1', 1000, AVANT);
  eq(neuf.jeton, 'swogebet', 'un ticket pose maintenant porte sa monnaie : $SWOGEBET');
  const st = JSON.parse(JSON.stringify(g.serialize()));
  /* Le meme ticket, tel qu'il etait ecrit hier : sans `jeton`. */
  const ancien = st.paris.find((x) => x.id === neuf.id);
  delete ancien.jeton;
  const h = new Game();
  h.hydrate(st);
  h._p(A).balance = W(100);
  eq(Game.jetonDuTicket(h.mesParis(A)[0]), 'swoge', 'relu sans monnaie, il est en $SWOGE');
  h.regleMatch(M, '1');
  eq(Number(h.balanceStr(A)), 100 + neuf.rapport, 'et son gain est verse en $SWOGE (' + h.balanceStr(A) + ')');
  eq(h.betBalanceStr(A), '4000.0', 'pas un jeton de plus sur le solde des paris');
  const g2 = new Game();
  g2.creditBetDeposit({ player: A, amount: W(5000), tx: '0xt8' });
  const t2 = g2.parie(A, M, '2', 1000, AVANT);
  const st2 = JSON.parse(JSON.stringify(g2.serialize()));
  delete st2.paris.find((x) => x.id === t2.id).jeton;
  const h2 = new Game();
  h2.hydrate(st2);
  h2.rembourseMatch(M);
  eq(h2.balanceStr(A), '1000.0', 'un ticket d hier rembourse l est en $SWOGE');
  eq(h2.betBalanceStr(A), '4000.0', 'et le solde des paris n y gagne rien');
}

console.log('\n-- le retrait autorise un cumul propre au coffre des paris --');
{
  const g = new Game();
  g.creditBetDeposit({ player: A, amount: W(1000), tx: '0xt4' });
  g._p(A).balance = W(10);
  jete(() => g.requestBetWithdraw(A, '10'), /below minimum/, 'sous le minimum du coffre des paris, refuse');
  jete(() => g.requestBetWithdraw(A, '5000'), /exceeds/, 'au-dessus du solde des paris, refuse — le $SWOGE ne compte pas');
  const cumul = g.requestBetWithdraw(A, '200');
  const frais = W(200).mul(cfg.WITHDRAW_FEE_BPS).div(10000);
  eq(cumul.toString(), W(200).sub(frais).toString(), 'le cumul autorise est le NET, frais du serveur deduit');
  eq(g.betBalanceStr(A), '800.0', 'le solde des paris baisse du brut');
  eq(g._p(A).cumulativeAuthorized.toString(), '0', 'le cumul du coffre $SWOGE, lui, reste a zero');
  const b = g.bonBetEnAttente(A);
  eq(b.du.toString(), cumul.toString(), 'tout est encore du tant que la chaine n a rien verse');
  g.noteBetRetireOnChain(A, cumul);
  eq(g.bonBetEnAttente(A).du.toString(), '0', 'et plus rien une fois que le coffre a paye');
  eq(g.balanceStr(A), '10.0', 'le $SWOGE n a pas bouge pendant tout ca');
}

console.log('\n-- les champs survivent a une sauvegarde relue --');
{
  const g = new Game();
  g.creditBetDeposit({ player: A, amount: W(300), tx: '0xt5' });
  g.requestBetWithdraw(A, '100');
  g.betLastBlock = 4242;
  const st = JSON.parse(JSON.stringify(g.serialize()));
  const h = new Game();
  h.hydrate(st);
  eq(h.betBalanceStr(A), g.betBalanceStr(A), 'le solde des paris est relu tel quel (' + h.betBalanceStr(A) + ')');
  eq(h._p(A).betCumulativeAuthorized.toString(), g._p(A).betCumulativeAuthorized.toString(), 'le cumul aussi');
  eq(h._p(A).betBonDu.toString(), g._p(A).betBonDu.toString(), 'et le du');
  eq(h.betLastBlock, 4242, 'le repere de bloc du coffre des paris est a part, et relu');
  const seul = new Game();
  seul.creditBetDeposit({ player: A, amount: W(1), tx: '0xt6' });
  ok(!!seul.fiche(A), 'une fiche qui ne porte QUE du $SWOGEBET n est pas jetee comme vide');
}

console.log('\n-- ce que le panneau et le canal disent du coffre des paris --');
{
  /* « Le bot Telegram ne doit plus marquer 100K SWOGE : mettez 100k de
     SWOGEBET. » Et pour le panneau : « qu'on sache combien il y a de paris en
     cours, qui, combien, et combien il y a dans le vault en tout ». */
  const B = '0x' + 'b2'.repeat(20);
  const g = new Game();
  g.creditBetDeposit({ player: A, amount: W(5000), tx: '0xt9' });
  g.creditBetDeposit({ player: B, amount: W(300), tx: '0xt10' });
  g._p(A).name = 'Alice';
  const neuf = g.parie(A, M, '1', 1000, AVANT);
  const petit = g.parie(B, M, '2', 100, AVANT);
  /* Un ticket d'hier, en $SWOGE, sur le meme match. */
  const st = JSON.parse(JSON.stringify(g.serialize()));
  const vieux = g.parie(A, M, '1', 200, AVANT);
  const st2 = JSON.parse(JSON.stringify(g.serialize()));
  delete st2.paris.find((x) => x.id === vieux.id).jeton;
  const h = new Game(); h.hydrate(st2);
  h.requestBetWithdraw(B, '100');
  const d = h.betOwedBreakdown();
  eq(d.balances.toString(), W(3800 + 100).toString(), 'le du du coffre des paris = les soldes des paris (3 800 + 100)');
  eq(d.bons.toString(), h._p(B).betBonDu.toString(), 'plus le bon signe que la chaine n a pas encore paye');
  eq(d.joueurs, 2, 'sur deux fiches');
  const ec = h.parisEnCours(10);
  eq(ec.n, 3, 'trois paris en cours');
  eq(ec.joueurs, 2, 'poses par deux joueurs');
  eq(ec.parJeton.swogebet.n, 2, 'deux en $SWOGEBET');
  eq(ec.parJeton.swogebet.mise, 1100, 'pour 1 100 $SWOGEBET de mises');
  eq(ec.parJeton.swogebet.engage, Math.round(neuf.rapport + petit.rapport), 'et ce qu ils rendraient tous gagnants (' + ec.parJeton.swogebet.engage + ')');
  eq(ec.parJeton.swoge.n, 1, 'un ticket d hier en $SWOGE, compte a part');
  eq(ec.liste[0].jeton, 'swogebet', 'la liste porte la monnaie de chaque ticket');
  eq(ec.liste[0].nom, 'Alice', 'et QUI l a pose');
  ok(ec.liste[0].rapport >= ec.liste[1].rapport, 'le plus gros rapport en premier');
  ok(/Bolton|–/.test(ec.liste[0].affiche) || ec.liste[0].affiche.length > 0, 'avec l affiche de la rencontre (' + ec.liste[0].affiche + ')');
  const tp = h.tousParis({ etat: 'ouvert' });
  ok(tp.paris.every((p) => p.jeton === 'swogebet' || p.jeton === 'swoge'), 'la liste du panneau porte aussi la monnaie');
  eq(tp.paris.filter((p) => p.jeton === 'swoge').length, 1, 'et retrouve le ticket en $SWOGE');
  /* Le reglement compte par monnaie : c est ce que le canal annonce. */
  const r = h.regleMatch(M, '1');
  ok(Math.abs(r.payeBet - neuf.rapport) < 1e-6, 'verse en $SWOGEBET : le rapport du ticket neuf (' + r.payeBet + ')');
  ok(Math.abs(r.payeSwoge - vieux.rapport) < 1e-6, 'verse en $SWOGE : celui du ticket d hier (' + r.payeSwoge + ')');
  ok(Math.abs(r.paye - r.payeBet - r.payeSwoge) < 1e-6, 'et les deux font le total');
  eq(r.top.jeton, 'swogebet', 'le plus gros gagnant sait dans quelle monnaie il est paye');
  const h2 = new Game(); h2.hydrate(st);
  const r2 = h2.regleMatch(M, '1');
  eq(r2.payeSwoge, 0, 'sans ticket d hier, rien n est verse en $SWOGE');
  ok(r2.payeBet > 0, 'tout l est en $SWOGEBET');
}

console.log('\n-- la colle de chaine signe dans le bon domaine --');
(async () => {
  const swoge = new Chain();
  const bet = new Chain({ vault: cfg.BET_VAULT_ADDRESS, token: cfg.SWOGEBET_TOKEN, domainName: 'SwogeBetVault' });
  eq(swoge.domain.name, 'SwogePusherVault', 'sans argument, c est le coffre $SWOGE, comme avant');
  eq(bet.domain.name, 'SwogeBetVault', 'avec, c est le coffre des paris');
  eq(bet.domain.verifyingContract, cfg.BET_VAULT_ADDRESS, 'a l adresse du coffre des paris');
  ok(bet.suitLesRetraits(), 'et il suit ses retraits des que l adresse est posee');
  const v = await bet.signVoucher(A, W(100));
  const types = { Withdraw: [{ name: 'player', type: 'address' }, { name: 'cumulative', type: 'uint256' },
                             { name: 'deadline', type: 'uint256' }] };
  const valeur = { player: A, cumulative: v.cumulative, deadline: v.deadline };
  const sig = ethers.utils.joinSignature({ v: v.v, r: v.r, s: v.s });
  const qui = (dom) => ethers.utils.verifyTypedData(dom, types, valeur, sig).toLowerCase();
  eq(qui(bet.domain), bet.signerAddress.toLowerCase(), 'le bon se verifie dans le domaine SwogeBetVault');
  ok(qui(swoge.domain) !== bet.signerAddress.toLowerCase(), 'et PAS dans le domaine du coffre $SWOGE : un bon ne vaut que pour son coffre');
  const sans = new Chain({ vault: '', token: cfg.SWOGEBET_TOKEN, domainName: 'SwogeBetVault' });
  ok(!sans.suitLesRetraits(), 'sans adresse, il ne suit rien — et ne pretend pas le contraire');
  console.log('\nvault_swogebet.test.js : ' + n + ' verifications OK');
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exitCode = 1; });
