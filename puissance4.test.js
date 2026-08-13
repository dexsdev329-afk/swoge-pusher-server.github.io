'use strict';
/*
 * Verification du Connect 4.
 *
 * La detection d'alignement se verifie EXHAUSTIVEMENT : on enumere les 69
 * alignements possibles d'une grille 7x6 — 24 horizontaux, 21 verticaux, 12 par
 * diagonale — on les pose un par un et on verifie que chacun est trouve. Puis
 * on fait l'inverse : on verifie qu'AUCUN alignement fantome n'est trouve la ou
 * il n'y en a pas, ce qui est le vrai piege d'une grille rangee a plat (un pas
 * de +1 depuis la derniere colonne arrive sur la premiere de la rangee
 * suivante, et fabrique un alignement qui n'existe pas).
 *
 * Le partage du pot est verifie sur toute la plage de mises, pas sur trois
 * exemples : de l'argent en sort.
 */
const assert = require('assert');
const cfg = require('./config');
const P = require('./puissance4');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

// ------------------------------------------------- la grille et la gravite
{
  const g = P.nouvelle();
  eq(g.length, 42, 'sept colonnes sur six rangees');
  ok(g.every((x) => x === 0), 'la grille part vide');
  eq(P.jouables(g).length, 7, 'les sept colonnes sont jouables');

  // un jeton tombe au fond, le suivant se pose dessus
  eq(P.poser(g, 3, 1), P.idx(3, 0), 'le premier jeton touche le fond');
  eq(P.poser(g, 3, 2), P.idx(3, 1), 'le second se pose dessus');
  eq(P.creux(g, 3), 2, 'le creux a monte de deux');

  // une colonne se remplit et sort des jouables
  for (let k = 0; k < 4; k++) P.poser(g, 3, k % 2 ? 1 : 2);
  eq(P.creux(g, 3), -1, 'la colonne est pleine');
  ok(P.jouables(g).indexOf(3) < 0, 'une colonne pleine n est plus jouable');
  jete(() => P.poser(g, 3, 1), /column full/, 'on ne pose pas dans une colonne pleine');
  eq(P.creux(g, -1), -1, 'colonne hors grille');
  eq(P.creux(g, 7), -1, 'colonne hors grille');
}

// ------------------------------- TOUS les alignements gagnants de la grille
/* On les construit par direction en verifiant que les quatre cases tiennent
   dans la grille, puis on pose exactement ces quatre cases et on demande la
   detection depuis CHACUNE d'elles — un alignement doit etre trouve quel que
   soit le jeton par lequel on arrive dessus. */
{
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];   // colonne, rangee
  let total = 0;
  for (const [dc, dr] of DIRS) {
    for (let c = 0; c < P.COLONNES; c++) {
      for (let r = 0; r < P.RANGEES; r++) {
        const cases = [];
        for (let k = 0; k < 4; k++) {
          const cc = c + dc * k, rr = r + dr * k;
          if (cc < 0 || cc >= P.COLONNES || rr < 0 || rr >= P.RANGEES) { cases.length = 0; break; }
          cases.push(P.idx(cc, rr));
        }
        if (cases.length !== 4) continue;
        total++;
        for (const depuis of cases) {
          const g = P.nouvelle();
          for (const i of cases) g[i] = 1;
          const trouve = P.gagne(g, depuis);
          if (!trouve) { ok(false, `alignement non detecte : ${cases} depuis ${depuis}`); break; }
          for (const i of cases)
            if (trouve.indexOf(i) < 0) { ok(false, `case ${i} manquante dans ${trouve}`); break; }
        }
      }
    }
  }
  n++;   // les deux boucles valent une verification
  eq(total, 69, 'une grille 7x6 compte exactement 69 alignements de quatre');
}

// --------------------------------------- AUCUN alignement fantome au bord
/* Le piege du tableau plat : quatre cases consecutives qui traversent un bord
   se suivent dans le tableau mais pas sur la grille. On pose ces quatre-la et
   on exige que RIEN ne soit detecte. */
{
  let pieges = 0;
  for (let depart = 0; depart + 3 < P.CASES; depart++) {
    const cases = [depart, depart + 1, depart + 2, depart + 3];
    // vraiment alignees ? seulement si elles restent sur la meme rangee
    const memeRangee = cases.every((i) => Math.floor(i / P.COLONNES) === Math.floor(depart / P.COLONNES));
    if (memeRangee) continue;
    pieges++;
    const g = P.nouvelle();
    for (const i of cases) g[i] = 1;
    for (const depuis of cases) {
      const t = P.gagne(g, depuis);
      // un alignement PEUT exister par une autre direction : on verifie
      // seulement qu'aucun ne reprend les quatre cases du piege
      if (t && cases.every((i) => t.indexOf(i) >= 0)) {
        ok(false, `alignement fantome par-dessus un bord : ${cases}`); break;
      }
    }
  }
  n++;
  ok(pieges > 0, `${pieges} suites traversant un bord ont ete eprouvees`);
}

// ------------------------------------------------ trois ne suffisent pas
{
  for (const dir of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const g = P.nouvelle();
    const cases = [];
    for (let k = 0; k < 3; k++) cases.push(P.idx(2 + dir[0] * k, 2 + dir[1] * k));
    for (const i of cases) g[i] = 1;
    for (const i of cases) ok(!P.gagne(g, i), `trois jetons ne gagnent pas (${dir})`);
  }
  // et quatre coupes par l'adversaire non plus
  const g = P.nouvelle();
  g[P.idx(0, 0)] = 1; g[P.idx(1, 0)] = 1; g[P.idx(2, 0)] = 2; g[P.idx(3, 0)] = 1;
  ok(!P.gagne(g, P.idx(1, 0)), 'un jeton adverse au milieu casse l alignement');
}

// -------------------------------------------------- le deroule d'une partie
{
  const A = '0xAAA', B = '0xBBB';
  const p = new P.Partie({ id: 'm1', mise: 100, createur: A, now: 1000, coupMs: 30000 });
  eq(p.phase, P.ATTENTE, 'une partie creee attend un adversaire');
  jete(() => p.jouer(A, 3, 1000), /not running/, 'on ne joue pas avant que l adversaire soit la');
  jete(() => p.rejoindre(A, 1000), /your own match/, 'on ne rejoint pas sa propre partie');

  p.rejoindre(B, 2000);
  eq(p.phase, P.EN_COURS, 'la partie demarre a l arrivee du second');
  eq(p.jeton(A), 1, 'le createur a le jeton 1');
  eq(p.jeton(B), 2, 'l adversaire a le jeton 2');
  eq(p.jeton('0xCCC'), 0, 'un tiers n a pas de jeton');
  eq(p.tour, 1, 'le createur commence');
  eq(p.echeance, 2000 + 30000, 'le premier coup a son echeance');

  jete(() => p.jouer(B, 3, 2100), /not your turn/, 'on ne joue pas hors de son tour');
  jete(() => p.jouer('0xCCC', 3, 2100), /not in this match/, 'un tiers ne joue pas');
  jete(() => p.jouer(A, 9, 2100), /invalid column/, 'colonne hors grille');

  p.jouer(A, 3, 2100);
  eq(p.tour, 2, 'le tour passe');
  eq(p.echeance, 2100 + 30000, 'l echeance repart au coup suivant');

  // A aligne quatre en bas, B repond ailleurs
  p.jouer(B, 0, 2200); p.jouer(A, 4, 2300);
  p.jouer(B, 0, 2400); p.jouer(A, 5, 2500);
  p.jouer(B, 0, 2600);
  eq(p.phase, P.EN_COURS, 'toujours en cours');
  p.jouer(A, 6, 2700);
  eq(p.phase, P.FINIE, 'quatre alignes finissent la partie');
  eq(p.gagnant, 1, 'le createur gagne');
  eq(p.raison, 'aligne', 'la raison est l alignement');
  eq(p.adresseGagnante(), A, 'l adresse gagnante est la bonne');
  eq(p.ligne.length, 4, 'quatre cases sont renvoyees');
  jete(() => p.jouer(B, 1, 2800), /not running/, 'on ne joue plus apres la fin');
}

// ------------------------------------------------------- le temps qui file
{
  const p = new P.Partie({ id: 'm2', mise: 50, createur: '0xA', now: 0, coupMs: 20000 });
  p.rejoindre('0xB', 0);
  eq(p.tick(19999), null, 'avant l echeance, rien');
  eq(p.phase, P.EN_COURS, 'toujours en cours');
  ok(p.tick(20001), 'passe l echeance, la partie se termine');
  eq(p.gagnant, 2, 'celui qui devait jouer perd');
  eq(p.raison, 'temps', 'la raison est le temps');
  // et un coup arrive trop tard est refuse
  const q = new P.Partie({ id: 'm3', mise: 50, createur: '0xA', now: 0, coupMs: 20000 });
  q.rejoindre('0xB', 0);
  jete(() => q.jouer('0xA', 3, 20001), /time is up/, 'un coup hors delai est refuse');
}

// ---------------------------------------------------------- l abandon
{
  const p = new P.Partie({ id: 'm4', mise: 10, createur: '0xA', now: 0 });
  p.rejoindre('0xB', 0);
  p.abandonner('0xA', 500);
  eq(p.gagnant, 2, 'celui qui abandonne fait gagner l autre');
  eq(p.raison, 'abandon', 'la raison est l abandon');
}

// ------------------------------------------------------- la grille pleine
{
  /* On remplit sans jamais aligner quatre : colonne par colonne, en changeant
     de joueur toutes les deux rangees, ce qui donne un damier par paires. */
  const p = new P.Partie({ id: 'm5', mise: 10, createur: '0xA', now: 0, coupMs: 1e9 });
  p.rejoindre('0xB', 0);
  const ordre = [];
  for (let c = 0; c < P.COLONNES; c++)
    for (let r = 0; r < P.RANGEES; r++) ordre.push([c, r]);
  // motif sans alignement : on impose la couleur, donc on ecrit la grille a la
  // main puis on verifie qu'aucun alignement n'y dort
  const g = P.nouvelle();
  for (let c = 0; c < P.COLONNES; c++)
    for (let r = 0; r < P.RANGEES; r++)
      g[P.idx(c, r)] = ((c + Math.floor(r / 2) * 3) % 2) ? 1 : 2;
  let alignement = null;
  for (let i = 0; i < P.CASES && !alignement; i++) alignement = P.gagne(g, i);
  ok(P.pleine(g), 'la grille de reference est pleine');
  ok(!alignement, 'le motif de reference ne contient aucun alignement');
}

// -------------------------------------------------- le partage du pot
{
  const RAKE = 500;   // 5 %
  // toute la plage de mises annoncee, au pas de 10 : de l'argent en sort, on ne
  // se contente pas de trois exemples
  /* La borne vient de la CONFIGURATION, pas d'un nombre recopie ici : le jour
     ou la mise maximale monte, la verification monte avec elle au lieu de
     continuer a certifier une plage qui n'existe plus. */
  let pire = 0.05, souci = null;
  for (let mise = cfg.P4_MIN; mise <= cfg.P4_MAX && !souci; mise += 10) {
    const r = P.partage(mise, RAKE, false, false);
    if (r.pot !== mise * 2) souci = `pot faux pour ${mise}`;
    else if (r.gain + r.rake !== r.pot) souci = `le pot ne se conserve pas pour ${mise}`;
    else if (!(r.gain > mise)) souci = `le gagnant ne gagne rien pour ${mise}`;
    else if (r.rake > Math.ceil(r.pot * 0.05)) souci = `commission trop forte pour ${mise}`;
    const part = r.rake / r.pot;
    if (Math.abs(part - 0.05) > Math.abs(pire - 0.05)) pire = part;
  }
  ok(!souci, souci || `le pot se conserve de ${cfg.P4_MIN} a ${cfg.P4_MAX}`);
  ok(Math.abs(pire - 0.05) < 0.001,
     `la commission reste a 5 % sur toute la plage (pire ecart : ${(pire * 100).toFixed(3)} %)`);

  // le cas rond, verifiable a la main
  const r = P.partage(100, RAKE, false, false);
  eq(r.pot, 200, 'deux mises de 100 font un pot de 200');
  eq(r.rake, 10, '5 % de 200 font 10');
  eq(r.gain, 190, 'le gagnant repart avec 190');

  // partie nulle : chacun reprend sa mise, la maison ne prend rien
  const nul = P.partage(100, RAKE, true, false);
  eq(nul.rendu, 100, 'sur une nulle chacun reprend sa mise');
  eq(nul.rake, 0, 'et la maison ne prend rien');
  // sauf si on decide le contraire
  const nul2 = P.partage(100, RAKE, true, true);
  eq(nul2.rendu, 95, 'commission sur nulle : chacun reprend 95');
  eq(nul2.rendu * 2 + nul2.rake, 200, 'et le pot reste entier');
}

console.log(`puissance4.test.js : ${n} verifications OK`);
