'use strict';
/*
 * Le moteur est verifie a part (mines.test.js). Ici on verifie le RACCORDEMENT
 * au solde, et surtout ce qu'un joueur ne doit pas pouvoir apprendre : la
 * position des bombes avant la fin de la partie. C'est la couche ou une erreur
 * donne soit des jetons gratuits, soit la solution.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const M = require('./mines');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const ADR = '0x3333333333333333333333333333333333333333';
const sol = (g) => Number(g.balanceStr(ADR));

const ethers = require('ethers');
function neuf(credit = 100000) {
  const g = new Game();
  const p = g._p(ADR);
  p.balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}
/** Les bombes ne sont pas exposees : on les lit dans l'etat interne, cote test. */
const bombesDe = (g) => g._p(ADR).mines.etat.bombes;
const premiereSure = (g) => [...Array(25).keys()].find((c) => bombesDe(g).indexOf(c) < 0);

// ---------------------------------------------------------- la mise part
{
  const g = neuf();
  const avant = sol(g);
  const s = g.minesStart(ADR, 500, 3);
  eq(sol(g), avant - 500, 'la mise est debitee des le depart');
  eq(s.mise, 500, 'la mise est retenue');
  eq(s.nbMines, 3, 'le nombre de bombes est retenu');
  eq(s.multi, 1, 'multiplicateur a 1');
  eq(s.fini, false, 'partie ouverte');
  eq(s.ouvertes.length, 0, 'aucune case ouverte');
  ok(s.multiSuivant > 1, 'la prochaine case a un multiplicateur annonce');
  ok(s.maximum > s.multiSuivant, 'le maximum est annonce et depasse le premier pas');
}

// ------------------------------------------- LES BOMBES NE FUITENT PAS
/* Le controle le plus important du fichier : tout ce que le serveur envoie est
   lisible par le joueur, quoi que fasse l'affichage. */
{
  const g = neuf();
  const s = g.minesStart(ADR, 100, 5);
  eq(s.bombes, undefined, 'aucune bombe dans l etat d ouverture');
  eq(JSON.stringify(s).indexOf('bombes'), -1, 'le mot n apparait meme pas');
  const apres = g.minesPick(ADR, premiereSure(g));
  eq(apres.bombes, undefined, 'aucune bombe apres une case sure');
  const lu = g.minesState(ADR);
  eq(lu.bombes, undefined, 'aucune bombe dans l etat relu');
  // ... jusqu'a la fin, ou elles doivent au contraire etre montrees
  const fin = g.minesPick(ADR, bombesDe(g)[0]);
  eq(fin.bombes.length, 5, 'la grille se decouvre a la fin');
  eq(fin.touchee, g._p(ADR).mines.etat.bombes[0], 'la bombe touchee est designee');
}

// ---------------------------------------------------------- limites
{
  const g = neuf();
  jete(() => g.minesStart(ADR, cfg.CASINO_MIN_BET - 1, 3), /too small/, 'mise trop petite refusee');
  jete(() => g.minesStart(ADR, cfg.CASINO_MAX_BET + 1, 3), /max bet/, 'mise trop grande refusee');
  jete(() => g.minesStart(ADR, 100, 0), /mines must be/, 'zero bombe refuse');
  jete(() => g.minesStart(ADR, 100, 25), /mines must be/, '25 bombes refusees');
  jete(() => g.minesStart(ADR, 100, 2.5), /mines must be/, 'nombre non entier refuse');
  const pauvre = neuf(5);
  jete(() => pauvre.minesStart(ADR, 1000, 3), /not enough/, 'solde insuffisant refuse');
}

// ---------------------------------------------------------- une seule partie
{
  const g = neuf();
  g.minesStart(ADR, 100, 3);
  jete(() => g.minesStart(ADR, 100, 3), /in progress/, 'pas deux parties a la fois');
}

// ------------------------------------------------- pas de coup sans partie
{
  const g = neuf();
  jete(() => g.minesPick(ADR, 0), /no game/, 'pas de case sans partie');
  jete(() => g.minesCashOut(ADR), /no game/, 'pas d encaissement sans partie');
}

// ---------------------------------------- une case ne coute rien de plus
{
  const g = neuf();
  g.minesStart(ADR, 200, 3);
  const avant = sol(g);
  const s = g.minesPick(ADR, premiereSure(g));
  eq(sol(g), avant, 'une case ne debite rien : la mise est deja partie');
  eq(s.ouvertes.length, 1, 'le compteur avance');
  eq(s.dernier.sure, true, 'le dernier coup est expose');
  ok(s.multi > 1, 'le multiplicateur a monte');
  eq(s.multi, M.multiplicateur(3, 1, cfg.MINES_EDGE_BPS), 'le multiplicateur suit le bareme');
}

// ------------------------------------- perdu : rien ne revient, tout se ferme
{
  const g = neuf();
  g.minesStart(ADR, 100, 3);
  const avant = sol(g);
  const s = g.minesPick(ADR, bombesDe(g)[0]);
  eq(sol(g), avant, 'une perte ne rend rien');
  eq(s.multi, 0, 'multiplicateur a zero');
  eq(s.perdu, true, 'partie perdue');
  eq(s.fini, true, 'partie close');
  jete(() => g.minesPick(ADR, 0), /no game/, 'on ne rejoue pas apres avoir perdu');
  jete(() => g.minesCashOut(ADR), /no game/, 'on n encaisse pas une partie perdue');
}

// ------------------------------- gagne puis encaisse : le compte est juste
{
  const g = neuf();
  const depart = sol(g);
  g.minesStart(ADR, 300, 4);
  const sures = [...Array(25).keys()].filter((c) => bombesDe(g).indexOf(c) < 0).slice(0, 3);
  let s;
  for (const c of sures) s = g.minesPick(ADR, c);
  const attendu = Math.floor(300 * s.multi);
  const r = g.minesCashOut(ADR);
  eq(r.payout, attendu, 'le paiement suit le multiplicateur affiche');
  eq(sol(g), depart - 300 + attendu, 'le solde final est exact');
  eq(r.net, attendu - 300, 'le net est la difference avec la mise');
  eq(r.encaisse, true, 'partie marquee encaissee');
  jete(() => g.minesCashOut(ADR), /no game/, 'on n encaisse pas deux fois');
  jete(() => g.minesPick(ADR, sures[0] + 10), /no game/, 'on ne rejoue pas apres encaissement');
}

// ---------------------------------------- la meme case deux fois
{
  const g = neuf();
  g.minesStart(ADR, 100, 3);
  const c = premiereSure(g);
  const a = g.minesPick(ADR, c);
  jete(() => g.minesPick(ADR, c), /deja ouverte/, 'une case ne se rouvre pas');
  eq(g.minesState(ADR).multi, a.multi, 'le multiplicateur n a pas bouge');
  jete(() => g.minesPick(ADR, 99), /hors grille/, 'case hors grille refusee');
}

// ------------------------------- grille entierement decouverte
{
  const g = neuf();
  g.minesStart(ADR, 100, 24);            // une seule case sure
  const sure = premiereSure(g);
  const s = g.minesPick(ADR, sure);
  eq(s.complet, true, 'la grille est finie');
  eq(s.fini, true, 'la partie se ferme d elle-meme');
  eq(s.multi, M.maximum(24, cfg.MINES_EDGE_BPS), 'multiplicateur maximum');
  const r = g.minesCashOut(ADR);          // une grille finie s'encaisse quand meme
  eq(r.payout, Math.floor(100 * M.maximum(24, cfg.MINES_EDGE_BPS)), 'la grille finie est payee');
}

// ------------------------- conservation des jetons sur beaucoup de parties
/* Le seul controle qui attrape une fuite : on additionne tout ce qui sort du
   solde et tout ce qui y rentre, et on compare au solde reel. */
{
  const g = neuf(1000000);
  const depart = sol(g);
  let sorti = 0, rentre = 0, parties = 0, gagnees = 0;
  for (let i = 0; i < 3000; i++) {
    const mise = 50, nb = 1 + (i % 8);
    if (sol(g) < mise) break;
    g.minesStart(ADR, mise, nb); sorti += mise; parties++;
    let etat = g.minesState(ADR);
    // on ouvre des cases dans un ordre arrete, sans regarder les bombes
    for (let c = 0; c < 4 && !etat.fini; c++) etat = g.minesPick(ADR, c);
    if (!etat.perdu && etat.ouvertes.length && !etat.encaisse) {
      const r = g.minesCashOut(ADR); rentre += r.payout; gagnees++;
    }
  }
  eq(sol(g), depart - sorti + rentre, 'aucun jeton ne se perd ni ne se cree');
  ok(parties > 2000, 'assez de parties jouees');
  ok(rentre < sorti, `la maison garde un avantage (${sorti} mise, ${rentre} rendu)`);
  console.log('  %d parties, %d encaissees, retour %s %',
              parties, gagnees, (100 * rentre / sorti).toFixed(2));
}

// ------------------------------------- l'etat public ne fuite aucun secret
{
  const g = neuf();
  const s = g.minesStart(ADR, 100, 3);
  const cles = Object.keys(s).join(' ');
  ok(!/seed|graine|serverSeed/i.test(cles), 'aucune graine dans l etat public');
  ok(!/bombe/i.test(cles), 'aucune bombe dans l etat public');
}

console.log(`mines_game.test.js : ${n} verifications OK`);
