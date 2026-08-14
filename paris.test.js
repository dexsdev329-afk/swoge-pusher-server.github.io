'use strict';
/*
 * Les paris sportifs.
 *
 * ---- pourquoi ce fichier est le plus severe du lot ----
 *
 * Partout ailleurs dans ce serveur, une manche se regle dans la seconde : la
 * maison ne doit jamais rien a personne pendant plus d'un instant. Ici la mise
 * part le vendredi et le resultat tombe le samedi. Entre les deux, la maison
 * porte un ENGAGEMENT, et trois choses peuvent mal tourner sans que personne
 * ne le voie avant le moment de payer :
 *
 *   • une COTE qui change entre la prise du pari et le reglement. Corriger une
 *     faute de frappe dans le catalogue ne doit pas toucher ce qu'un joueur a
 *     deja accepte ;
 *   • un ENGAGEMENT qui depasse ce que le coffre peut porter. Le plafond
 *     compte l'issue la PIRE, pas la somme des mises — c'est la seule mesure
 *     qui dit ce qu'on devra vraiment sortir ;
 *   • un match REGLE DEUX FOIS, qui cree de l'argent en silence.
 *
 * Et une quatrieme, qui ne se voit qu'apres un redeploiement : des paris qui
 * ne survivent pas au redemarrage. Le vendredi soir, ca efface tout ce qui a
 * ete pose pour le samedi.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const paris = require('./paris');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const sol = (g, a) => Number(g.balanceStr(a));
const AVANT = Date.parse('2026-08-15T09:00:00Z');   // avant tous les coups d'envoi
const APRES = Date.parse('2026-08-15T20:00:00Z');   // apres tous
const M = 'efl-20260815-bol-pre';                    // Bolton-Preston, 2.12 / 3.22 / 3.17

function jeu(credit) {
  const g = new Game();
  for (const a of [A, B]) g._p(a).balance = W(credit || 1000000);
  return g;
}

// ============================ LE CATALOGUE PORTE UNE VRAIE MARGE
/* C'est ce qui rend tout le systeme viable : on recopie les cotes d'un
   bookmaker, et son benefice devient le notre. Sans marge, on offrirait un
   pari equitable a des gens qui savent compter. */
{
  const c = paris.catalogue();
  eq(c.matchs.length, 8, 'les huit rencontres du 15 aout sont chargees');
  let mini = 1;
  for (const m of c.matchs) {
    ok(m.marge >= paris.MARGE_MIN, `${m.domicile}-${m.exterieur} : marge ${(m.marge * 100).toFixed(2)} %`);
    mini = Math.min(mini, m.marge);
  }
  ok(mini > 0.05, `la plus faible marge du lot vaut ${(mini * 100).toFixed(2)} % — ` +
     'l avantage de la maison est trois fois celui du casino');
  eq(c.sports.filter((s) => s.actif).map((s) => s.cle).join(','), 'foot',
     'seul le football est ouvert pour l instant');
}

// ============================ un catalogue de travers NE SE CHARGE PAS
/* Le seul endroit du serveur ou une faute de frappe devient directement de
   l'argent. Un fichier refuse arrete le serveur, ce qui se voit ; une cote
   absurde acceptee ne se voit qu'au moment de payer. */
{
  const bon = { sports: [{ cle: 'foot', nom: 'Football', actif: true }],
                matchs: [{ id: 'essai-un', sport: 'foot', debut: '2026-09-01T12:00:00Z',
                           domicile: 'A', exterieur: 'B', cotes: { 1: 2.1, N: 3.2, 2: 3.2 } }] };
  ok(paris.valide(JSON.parse(JSON.stringify(bon))), 'un catalogue correct passe');

  const casse = (f, re, quoi) => {
    const c = JSON.parse(JSON.stringify(bon)); f(c);
    jete(() => paris.valide(c), re, quoi);
  };
  casse((c) => { c.matchs[0].cotes['1'] = 21; }, /marge/i,
        'une cote a 21 au lieu de 2,1 : la marge devient negative, on refuse');
  casse((c) => { c.matchs[0].cotes['1'] = 1.001; }, /hors bornes/,
        'une cote sous 1,01 ne rapporte rien');
  casse((c) => { c.matchs[0].cotes['1'] = 500; }, /hors bornes/,
        'une cote a 500 engagerait la maison pour cinquante millions');
  casse((c) => { delete c.matchs[0].cotes.N; }, /cote/, 'une issue manquante');
  casse((c) => { c.matchs[0].debut = 'samedi'; }, /date/, 'une date illisible');
  casse((c) => { c.matchs[0].sport = 'curling'; }, /sport inconnu/, 'un sport hors liste');
  casse((c) => { c.matchs.push(JSON.parse(JSON.stringify(c.matchs[0]))); }, /en double/,
        'DEUX MATCHS DE MEME IDENTIFIANT : ils partageraient paris et reglement');
}

// ================================ poser un pari, et ce qu il coute
{
  const g = jeu();
  const p = g.parie(A, M, '1', 1000, AVANT);
  eq(sol(g, A), 999000, 'la mise quitte le solde tout de suite');
  eq(p.cote, 2.12, 'la cote du catalogue est recopiee DANS le pari');
  eq(p.rapport, 2120, 'et le rapport est calcule une fois pour toutes');
  eq(g.engagementMatch(M), 2120, 'la maison porte cet engagement jusqu au reglement');

  const mien = g.mesParis(A);
  eq(mien.length, 1, 'le joueur retrouve son pari');
  eq(mien[0].domicile, 'Bolton', 'avec le nom des equipes, pas juste un identifiant');
}

// ==================== LA COTE NE BOUGE PLUS, MEME SI LE CATALOGUE CHANGE
/* Le defaut le plus insidieux : on corrige une coquille dans le catalogue le
   samedi matin, et les paris du vendredi se reglent au nouveau tarif. */
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);
  const m = paris.match(M);
  const vraie = m.cotes['1'];
  m.cotes['1'] = 1.10;                       // quelqu un « corrige » le catalogue
  try {
    const r = g.regleMatch(M, '1');
    eq(r.paye, 2120, 'le pari est paye a la cote ACCEPTEE (2,12), pas a la nouvelle');
  } finally { m.cotes['1'] = vraie; }
}

// ================================ LE PLAFOND D ENGAGEMENT
/* Il ne compte pas les mises : il compte ce qu il faudra SORTIR si la pire
   issue tombe. C est la seule mesure qui dit la verite. */
{
  const g = jeu(100000000);
  const plafond = cfg.PARI_ENGAGEMENT_MAX;
  let pose = 0;
  /* On empile sur la meme issue jusqu a saturer. */
  for (let i = 0; i < 200; i++) {
    try { g.parie(A, M, '2', cfg.PARI_MAX, AVANT); pose++; }
    catch (e) { ok(/full/.test(e.message), 'passe le plafond, on refuse en le disant : ' + e.message); break; }
  }
  ok(pose > 0, `${pose} paris au plafond de mise ont ete acceptes`);
  ok(g.engagementMatch(M) <= plafond,
     `l engagement reste sous la borne (${g.engagementMatch(M)} <= ${plafond})`);
  /* Et l autre issue reste ouverte : le plafond est PAR ISSUE au pire, pas
     une fermeture du match. */
  const p = g.parie(A, M, '1', 1000, AVANT);
  ok(p, 'une autre issue reste pariable — le plafond vise le risque, pas le volume');
}

// ================================ ce qui est refuse
{
  const g = jeu();
  jete(() => g.parie(A, 'inconnu', '1', 1000, AVANT), /unknown match/, 'un match qui n existe pas');
  jete(() => g.parie(A, M, 'X', 1000, AVANT), /1, N or 2/, 'une issue hors des trois');
  jete(() => g.parie(A, M, '1', 1, AVANT), /minimum/, 'sous le minimum');
  jete(() => g.parie(A, M, '1', cfg.PARI_MAX + 1, AVANT), /maximum/,
       `au-dessus du plafond de ${cfg.PARI_MAX}`);
  jete(() => g.parie(A, M, '1', 1000, APRES), /closed/,
       'APRES LE COUP D ENVOI : parier sur un match commence, c est parier en regardant le score');
  const pauvre = '0x' + 'cc'.repeat(20);
  jete(() => g.parie(pauvre, M, '1', 1000, AVANT), /not enough/, 'sans les jetons');
}

// ================================ le reglement paie, et une seule fois
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);       // 2.12 -> 2120
  g.parie(B, M, '2', 1000, AVANT);       // perdant
  const avant = sol(g, A) + sol(g, B);

  const r = g.regleMatch(M, '1');
  eq(r.gagnants, 1, 'un seul gagnant');
  eq(r.paye, 2120, 'paye au rapport fige');
  eq(r.mise, 2000, 'sur deux mille mises');
  eq(Number(r.net.toFixed(6)), -120, 'la maison perd 120 sur CE match — un lot n est pas une moyenne');
  eq(sol(g, A), 1000000 - 1000 + 2120, 'le gagnant est credite');
  eq(sol(g, B), 1000000 - 1000, 'le perdant ne recupere rien');
  eq(sol(g, A) + sol(g, B) - avant, 2120, 'et rien d autre n a bouge');

  jete(() => g.regleMatch(M, '1'), /already settled/,
       'UN MATCH NE SE REGLE PAS DEUX FOIS : ce serait de l argent cree');
  jete(() => g.regleMatch(M, 'N'), /already settled/, 'meme avec un autre resultat');
  eq(g.engagementMatch(M), 0, 'et l engagement retombe a zero');
}

// ================================ le remboursement
{
  const g = jeu();
  g.parie(A, M, '1', 5000, AVANT);
  g.parie(B, M, 'N', 3000, AVANT);
  const r = g.rembourseMatch(M);
  eq(r.rendu, 8000, 'tout est rendu : un match qui ne se joue pas n a produit aucun resultat');
  eq(sol(g, A), 1000000, 'chacun retrouve exactement sa mise');
  eq(sol(g, B), 1000000, 'les deux');
  jete(() => g.regleMatch(M, '1'), /already settled/, 'et on ne peut plus le regler ensuite');
}

// ============ LES PARIS SURVIVENT AU REDEMARRAGE
/* Sans ca, un redeploiement le vendredi soir efface tout ce qui a ete pose
   pour le samedi — et l argent est deja parti des soldes. */
{
  const g = jeu();
  g.parie(A, M, '1', 4000, AVANT);
  const instantane = JSON.parse(JSON.stringify(g.serialize()));

  const g2 = new Game();
  g2.hydrate(instantane);
  eq(g2.mesParis(A).length, 1, 'le pari est toujours la apres relecture');
  eq(g2.mesParis(A)[0].cote, 2.12, 'avec sa cote');
  eq(g2.engagementMatch(M), 8480, 'et l engagement de la maison aussi');

  const r = g2.regleMatch(M, '1');
  eq(r.paye, 8480, 'il se regle normalement de l autre cote du redemarrage');
  eq(Math.round(sol(g2, A)), 1000000 - 4000 + 8480, 'et le joueur est paye');
}

// ============ LE PARI PASSE PAR LE POINT DE REGLAGE COMMUN
/* Sinon il serait invisible au classement du mois, au revenu et a la mesure
   d usage — exactement comme l etaient le pusher et le poker ce matin. */
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);
  g.parie(B, M, '2', 1000, AVANT);
  eq(g.comptes().mises, 0, 'rien n est comptabilise tant que le match n est pas joue');
  g.regleMatch(M, '2');
  const c = g.comptes();
  eq(c.mises, 2000, 'au reglement, les deux mises entrent dans la comptabilite');
  eq(c.rendus, 3170, 'et ce qui a ete rendu');
  eq(g._p(B).moisMise, 1000, 'le volume du MOIS compte, donc le classement aussi');
  const u = g.usageJour(new Date().toISOString().slice(0, 10)).find((x) => x.jeu === 'paris');
  ok(u, 'et les paris apparaissent dans la mesure d usage');
  eq(u.joueurs, 2, 'avec leurs deux joueurs');
}

console.log(`paris.test.js : ${n} verifications OK`);
