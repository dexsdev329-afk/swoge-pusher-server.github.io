'use strict';
/*
 * LE BILAN DES PARIS D'UN JOUEUR.
 *
 * ---- pourquoi ce fichier existe ----
 *
 * Les compteurs du profil et du panneau lisaient `p.jeux`, ecrit par
 * `_manche` — c'est-a-dire A LA FIN d'une manche. Un pari sportif n'a pas de
 * fin le jour ou il est pose : il se regle le lendemain, ou jamais si le match
 * quitte le calendrier. Un joueur qui avait engage trois mille jetons le
 * samedi affichait donc « aucune manche enregistree » et zero partout.
 *
 * Le compteur n'etait pas casse au sens ou il se serait trompe : il comptait
 * autre chose que ce qu'on lui demandait. La reparation consiste a repartir
 * de `this.paris`, la seule source ou un pari existe des sa pose.
 *
 * ---- ce que chaque chiffre doit dire, et surtout ce qu'il ne doit PAS dire
 *
 *   • le TAUX porte sur les paris tranches, remboursements EXCLUS. Un match
 *     annule n'est ni gagne ni perdu ;
 *   • le RESULTAT ne compte que les paris regles. Un pari en cours inscrit en
 *     perte afficherait un joueur perdant le samedi soir, redevenu gagnant le
 *     dimanche sans avoir rien fait ;
 *   • sans un seul pari tranche, le taux n'existe pas. « 0 % » serait faux.
 */
const assert = require('assert');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/bilan-paris-test-');

const { ethers } = require('ethers');
const { Game } = require('./game');
const paris = require('./paris');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

const A = ('0x' + 'a1'.repeat(20)).toLowerCase();
const B = ('0x' + 'b2'.repeat(20)).toLowerCase();
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const AVANT = Date.parse('2026-08-15T09:00:00Z');

/* Quatre matchs de foot du catalogue : de quoi gagner, perdre, se faire
   rembourser et laisser courir, sans jamais deux jambes sur le meme match. */
const M = paris.catalogue().matchs.filter((x) => x.sport === 'foot').slice(0, 4).map((x) => x.id);
ok(M.length === 4, 'quatre matchs de foot au catalogue pour ce test');

function jeu() {
  const g = new Game();
  for (const a of [A, B]) { g._p(a).balance = W(1000000); g._p(a).betBalance = W(1000000); }
  return g;
}

// ============================ 1. UN PARIEUR QUI N A RIEN VU SE REGLER
/* Le cas exact du signalement : des paris poses, aucun tranche. Ce n'est pas
   « rien » — c'est de l'argent engage, et ca doit se compter. */
{
  const g = jeu();
  g.parie(A, M[0], '1', 2000, AVANT);
  g.parie(A, M[1], 'N', 1000, AVANT);

  const b = g.statsParis(A);
  eq(b.total, 2, 'les deux paris sont comptes des la pose');
  eq(b.ouverts, 2, 'les deux courent encore');
  eq(b.mise, 3000, 'et les trois mille jetons engages se voient');
  eq(b.enJeu, 3000, 'ils sont en jeu');
  ok(b.aGagner > 3000, `et rapporteraient ${b.aGagner} s ils passaient`);
  eq(b.taux, null, 'aucun taux : rien n est tranche, et « 0 % » serait faux');
  eq(b.net, 0, 'aucun resultat non plus : rien n est ni gagne ni perdu');

  /* Le profil du joueur porte le bilan, la ou il ne portait que des zeros. */
  const s = g.stats(A);
  ok(s.paris && s.paris.total === 2, 'le profil du joueur porte le bilan');
  eq(s.manches, 0, 'et ne pretend toujours pas qu une manche a ete jouee');
}

// ================================= 2. GAGNE, PERDU, REMBOURSE, EN COURS
{
  const g = jeu();
  const p1 = g.parie(A, M[0], '1', 1000, AVANT);   // gagnant
  g.parie(A, M[1], '1', 1000, AVANT);              // perdant
  g.parie(A, M[2], '1', 1000, AVANT);              // rembourse
  g.parie(A, M[3], '1', 1000, AVANT);              // laisse courir
  g.parie(B, M[0], '2', 500, AVANT);               // un autre joueur, ignore ici

  g.regleMatch(M[0], '1');
  g.regleMatch(M[1], '2');
  g.rembourseMatch(M[2]);

  const b = g.statsParis(A);
  eq(b.total, 4, 'quatre paris');
  eq(b.gagnes, 1, 'un gagne');
  eq(b.perdus, 1, 'un perdu');
  eq(b.rembourses, 1, 'un rembourse');
  eq(b.ouverts, 1, 'un en cours');
  eq(b.juges, 2, 'deux paris seulement ont ete TRANCHES');
  eq(b.taux, 50, 'le taux porte sur ces deux-la — 50 %, pas 25 %');
  eq(b.miseJugee, 2000, 'et le resultat ne porte que sur eux');
  eq(b.rendu, Math.round(p1.rapport * 1e6) / 1e6, 'ce qui est revenu, c est le pari gagnant');
  eq(b.net, Number((p1.rapport - 2000).toFixed(6)), 'le resultat est rendu moins mise jugee');
  eq(b.mise, 4000, 'la mise totale, elle, compte les quatre');
  eq(b.enJeu, 1000, 'le pari qui court est chiffre a part');
  ok(b.plusGros && b.plusGros.id === p1.id, 'le plus gros gain est retenu');

  /* Le remboursement ne doit peser NULLE PART dans le resultat : la mise est
     revenue, l affaire est close a zero. */
  const sansRemb = b.rendu - b.miseJugee;
  eq(b.net, Number(sansRemb.toFixed(6)), 'un rembourse ne change pas le resultat');

  /* Et le bilan de l autre joueur est bien le sien. */
  const b2 = g.statsParis(B);
  eq(b2.total, 1, 'le second joueur a son propre bilan');
  eq(b2.perdus, 1, 'son pari est perdu');
  eq(b2.taux, 0, 'et son taux vaut zero — la, c est vrai');
}

// ============================ 3. LE PANNEAU VOIT LA MEME CHOSE
/* Une seule passe pour tous les joueurs : le panneau se rafraichit toutes les
   quinze secondes, et une boucle par joueur sur tous les paris couterait des
   millions de comparaisons. */
{
  const g = jeu();
  g.parie(A, M[0], '1', 2000, AVANT);
  g.parie(A, M[1], 'N', 1000, AVANT);
  g.parie(B, M[0], '2', 700, AVANT);
  g.regleMatch(M[0], '1');

  const par = new Map(g.playersReport().map((r) => [r.address, r]));
  const a = par.get(A), b = par.get(B);
  ok(a.paris && b.paris, 'chaque joueur porte son bilan dans le rapport');
  eq(a.paris.total, 2, 'le premier a deux paris');
  eq(a.paris.gagnes, 1, 'dont un gagne');
  eq(a.paris.ouverts, 1, 'et un qui court encore');
  eq(b.paris.total, 1, 'le second en a un');
  eq(b.paris.taux, 0, 'perdu');

  /* Le bilan par joueur et le bilan groupe doivent tomber d accord — sinon
     le profil et le panneau afficheraient deux verites. */
  for (const addr of [A, B]) {
    const un = g.statsParis(addr), tous = par.get(addr).paris;
    eq(JSON.stringify(un), JSON.stringify(tous),
       `le profil et le panneau disent la meme chose pour ${addr.slice(0, 8)}`);
  }

  /* Un joueur qui n a jamais parie n a pas de bilan — pas un bilan a zero
     qu il faudrait afficher. */
  const C = ('0x' + 'c3'.repeat(20)).toLowerCase();
  g._p(C);
  const c = g.playersReport().find((r) => r.address === C);
  eq(c.paris, null, 'un joueur sans pari n a pas de bilan a montrer');
  eq(g.statsParis(C).total, 0, 'et son bilan individuel est vide');
}

// ================== 4. UN COMBINE COMPTE POUR UN, PAS POUR SES JAMBES
{
  const g = jeu();
  g.parieCombine(A, [{ match: M[0], choix: '1' }, { match: M[1], choix: '1' }], 500, AVANT);
  eq(g.statsParis(A).total, 1, 'un combine est UN pari');
  eq(g.statsParis(A).mise, 500, 'et une seule mise');

  /* Une jambe fausse suffit : le combine tombe entier des la premiere. */
  g.regleMatch(M[1], '2');
  const b = g.statsParis(A);
  eq(b.perdus, 1, 'le combine est perdu des qu une jambe tombe');
  eq(b.ouverts, 0, 'il ne court plus');
  eq(b.taux, 0, 'et le taux le sait');
}

console.log(`\nbilan_paris.test.js : ${n} verifications OK\n`);
