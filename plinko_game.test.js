'use strict';
/*
 * Le moteur est verifie a part (plinko.test.js). Ici on verifie le
 * RACCORDEMENT au solde. Une bille est un coup unique : la mise part et le gain
 * revient dans le meme geste, donc le controle qui compte est la conservation —
 * rien ne doit se perdre ni se creer entre les deux.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const P = require('./plinko');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const ADR = '0x4444444444444444444444444444444444444444';
const sol = (g) => Number(g.balanceStr(ADR));

const ethers = require('ethers');
function neuf(credit = 1000000) {
  const g = new Game();
  g._p(ADR).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}

// ---------------------------------------------------------- une bille
{
  const g = neuf();
  const avant = sol(g);
  const r = g.plinkoDrop(ADR, 500, 12, 'medium');
  eq(r.mise, 500, 'la mise est retenue');
  eq(r.rangees, 12, 'le plateau est retenu');
  eq(r.risque, 'medium', 'le risque est retenu');
  eq(r.chemin.length, 12, 'un choix par picot');
  eq(r.case, r.chemin.reduce((a, b) => a + b, 0), 'la case est la somme du chemin');
  eq(r.multi, r.table[r.case], 'le multiplicateur est celui de la case');
  eq(r.payout, Math.floor(500 * r.multi), 'payout = mise x multiplicateur');
  eq(r.net, r.payout - 500, 'net = payout - mise');
  eq(sol(g), avant - 500 + r.payout, 'le solde bouge exactement du net');
  eq(r.table.length, 13, 'le bareme complet accompagne le coup');
}

// ------------------------------- le chemin envoye MENE a la case annoncee
/* L'animation suit ce chemin : s'il ne menait pas la ou le gain est paye, la
   bille tomberait dans un godet et le joueur serait paye pour un autre. */
{
  const g = neuf();
  for (let i = 0; i < 300; i++) {
    const r = g.plinkoDrop(ADR, 10, P.RANGEES[i % 3], P.RISQUES[i % 3]);
    eq(P.caseDe(r.chemin), r.case, 'le chemin mene a la case payee');
    ok(r.case >= 0 && r.case <= r.rangees, 'case dans le plateau');
  }
}

// ---------------------------------------------------------- reglages
{
  const g = neuf();
  jete(() => g.plinkoDrop(ADR, cfg.CASINO_MIN_BET - 1, 12, 'low'), /too small/, 'mise trop petite refusee');
  jete(() => g.plinkoDrop(ADR, cfg.CASINO_MAX_BET + 1, 12, 'low'), /max bet/, 'mise trop grande refusee');
  jete(() => g.plinkoDrop(ADR, 100, 10, 'low'), /rows must be/, 'plateau inconnu refuse');
  jete(() => g.plinkoDrop(ADR, 100, 12.5, 'low'), /rows must be/, 'plateau non entier refuse');
  jete(() => g.plinkoDrop(ADR, 100, 12, 'extreme'), /risk must be/, 'risque inconnu refuse');
  jete(() => g.plinkoDrop(ADR, 100, 12, ''), /risk must be/, 'risque vide refuse');
  const pauvre = neuf(5);
  jete(() => pauvre.plinkoDrop(ADR, 1000, 12, 'low'), /not enough/, 'solde insuffisant refuse');
}

// ------------------------------- on ne peut pas miser ce qu'on n'a pas
/* Le gain revient dans le meme geste : il ne doit surtout pas servir a payer
   la mise. On vide le solde a un cheveu pres et on verifie le refus. */
{
  const g = neuf(0);
  g._p(ADR).balance = ethers.utils.parseUnits('99', cfg.DECIMALS);
  jete(() => g.plinkoDrop(ADR, 100, 12, 'high'), /not enough/, '99 ne paie pas une mise de 100');
  eq(sol(g), 99, 'le solde n a pas bouge apres un refus');
}

// ------------------------- conservation des jetons sur beaucoup de billes
{
  const g = neuf(2000000);
  const depart = sol(g);
  let sorti = 0, rentre = 0, billes = 0;
  for (let i = 0; i < 4000; i++) {
    const mise = 100;
    if (sol(g) < mise) break;
    const r = g.plinkoDrop(ADR, mise, 12, 'medium');
    sorti += mise; rentre += r.payout; billes++;
  }
  eq(sol(g), depart - sorti + rentre, 'aucun jeton ne se perd ni ne se cree');
  ok(billes > 3000, 'assez de billes lachees');
  console.log('  %d billes, retour %s %', billes, (100 * rentre / sorti).toFixed(2));
}

// ------------------------------- le bareme envoye est celui qui paie
{
  const g = neuf();
  const baremes = g.plinkoBaremes();
  eq(Object.keys(baremes).length, P.RANGEES.length * P.RISQUES.length, 'toutes les tables sont envoyees');
  for (const rangees of P.RANGEES) {
    for (const risque of P.RISQUES) {
      const t = baremes[rangees + ':' + risque];
      eq(t.length, rangees + 1, `${rangees}/${risque} : bonne longueur`);
      const r = g.plinkoDrop(ADR, 100, rangees, risque);
      eq(r.multi, t[r.case], `${rangees}/${risque} : le coup paie ce que le bareme annonce`);
      eq(JSON.stringify(r.table), JSON.stringify(t), `${rangees}/${risque} : meme table des deux cotes`);
    }
  }
}

// ------------------------------------- l'etat public ne fuite aucun secret
{
  const g = neuf();
  const r = g.plinkoDrop(ADR, 100, 12, 'low');
  const cles = Object.keys(r).join(' ');
  ok(!/seed|graine|serverSeed/i.test(cles), 'aucune graine dans le resultat');
  ok(!/nonce/i.test(cles), 'aucun numero d ordre interne');
}

// ------------------------------------- deux billes ne sont pas jumelles
/* Le numero d'ordre avance a chaque coup : deux billes de suite doivent suivre
   des chemins differents, sinon la graine serait rejouee. */
{
  const g = neuf();
  const vus = new Set();
  for (let i = 0; i < 40; i++) vus.add(g.plinkoDrop(ADR, 10, 16, 'medium').chemin.join(''));
  ok(vus.size >= 38, `40 billes donnent ${vus.size} chemins distincts`);
}

console.log(`plinko_game.test.js : ${n} verifications OK`);
