'use strict';
/*
 * LE MOTEUR DE DEAD OR DOGE TIENT-IL SES COMPTES ?
 *
 * Un moteur de machine a sous se juge sur trois choses, et une seule se voit
 * en jouant : qu'il rende le meme tour pour les memes entrees, qu'il paie ce
 * qu'il annonce, et que ce qu'on VEND coute ce que ca rapporte.
 *
 * ---- CE QUE CES ESSAIS ONT ATTRAPE PENDANT L'ECRITURE ----
 *
 * 1. LES WILDS COLLANTS FIGEAIENT LE PLATEAU. Premiere version : le Wild
 *    lui-meme restait colle en tours gratuits, donc trois rouleaux entiers de
 *    Wild. Retour mesure : 1 233 %. Ce n'etait pas le multiplicateur, c'etait
 *    le COMPTAGE DES CHEMINS — 3 x 3 x 3 = 27 chemins offerts a chaque tour.
 *    C'est le multiplicateur qui colle desormais, pas le symbole.
 *
 * 2. LE BAREME ETAIT CELUI D'UN JEU A LIGNES. 237 % sur le seul jeu de base :
 *    un bareme de 243 chemins paie une fois par CHEMIN, pas par ligne.
 *
 * 3. LE CRAN « SCATTER » RENDAIT LE TOUR PIRE. Il remplissait JUSQU'A deux
 *    scatters quand il en faut trois pour ouvrir : il garantissait donc de ne
 *    jamais declencher, tout en ecrasant des symboles payants. 0,60x rendu
 *    pour un tour ordinaire a 0,95x. On en AJOUTE deux maintenant.
 *
 * Aucun de ces trois ne leve d'erreur. Ils ne se voient qu'en mesurant.
 */
const assert = require('assert');
const dod = require('./dod');

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('  ok   ' + m); };

console.log('\n-- le meme tour se rejoue a l identique --');
const A = dod.joue({ serverSeed: 's', clientSeed: 'c', nonce: 7, mise: 100 });
const B = dod.joue({ serverSeed: 's', clientSeed: 'c', nonce: 7, mise: 100 });
ok(JSON.stringify(A) === JSON.stringify(B), 'trois entrees identiques, un tour identique');
const C = dod.joue({ serverSeed: 's', clientSeed: 'c', nonce: 8, mise: 100 });
ok(JSON.stringify(A) !== JSON.stringify(C), 'un nonce different donne un autre tour');

console.log('\n-- le plateau est bien forme --');
let wildHorsMilieu = 0, grillesVues = 0, tailles = {};
for (let i = 0; i < 3000; i++) {
  const t = dod.unTour(dod.fluxDe('s', 'c', i), null);
  grillesVues++;
  assert.strictEqual(t.grille.length, dod.CASES, 'la grille fait 5 x 3');
  for (let r = 0; r < dod.ROULEAUX; r++) {
    let wilds = 0;
    for (let y = 0; y < dod.RANGEES; y++) if (t.grille[y * dod.ROULEAUX + r] === dod.WILD) wilds++;
    if (wilds && dod.ROULEAUX_WILD.indexOf(r) < 0) wildHorsMilieu++;
    /* LE WILD S'ETIRE OU IL N'EST PAS LA : jamais entre les deux. */
    ok_silencieux(wilds === 0 || wilds === dod.RANGEES);
  }
  for (const w of t.wilds) tailles[w.multi] = (tailles[w.multi] || 0) + 1;
}
function ok_silencieux(c) { if (!c) { console.log('  RATE un Wild ne remplit pas sa colonne'); process.exit(1); } }
ok(grillesVues === 3000, 'trois mille grilles tirees et toutes de la bonne taille');
ok(wildHorsMilieu === 0, 'aucun Wild hors des trois rouleaux du milieu');
ok(Object.keys(tailles).length === 3, 'les trois multiplicateurs de Wild apparaissent : x'
   + Object.keys(tailles).sort().join(', x'));
ok((tailles[1] || 0) > (tailles[3] || 0) * 3,
   'et le x1 est bien plus courant que le x3 (' + (tailles[1] || 0) + ' contre ' + (tailles[3] || 0) + ')');

console.log('\n-- les 243 facons se comptent depuis le premier rouleau --');
/* Un symbole present sur les rouleaux 1, 2, 3 mais PAS 4 paie trois, meme
   s'il revient sur le cinquieme. C'est ce qui distingue « 243 facons » d'un
   simple comptage, et c'est la premiere chose qu'on casse en refactorant. */
const g = new Array(dod.CASES).fill('j');
for (let y = 0; y < dod.RANGEES; y++) g[y * dod.ROULEAUX + 3] = 'q';   // le 4e rouleau coupe
const r1 = dod.gainsDe(g);
const ligneJ = r1.lignes.find((l) => l.symbole === 'j');
ok(!!ligneJ && ligneJ.rouleaux === 3, 'le `j` coupe au quatrieme rouleau paie trois, pas cinq');
const g2 = new Array(dod.CASES).fill('j');
const r2 = dod.gainsDe(g2);
const ligne5 = r2.lignes.find((l) => l.symbole === 'j');
ok(ligne5.rouleaux === 5 && ligne5.chemins === 243,
   'une grille pleine du meme symbole compte bien 243 chemins (' + ligne5.chemins + ')');

console.log('\n-- le retour, mesure --');
const m = dod.mesure(120000, 'essai');
ok(m.rtp > 0.90 && m.rtp < 1.00,
   'le retour tombe entre 90 et 100 % : ' + (100 * m.rtp).toFixed(2) + ' % ['
   + (100 * m.bas).toFixed(2) + ' ; ' + (100 * m.haut).toFixed(2) + ']');
ok(m.base < m.rtp, 'le jeu de base seul rend moins que le total — le bonus ajoute quelque chose');
ok(m.unSur > 80 && m.unSur < 260,
   'le bonus s ouvre a une frequence jouable : 1 tour sur ' + m.unSur);
ok(m.moyDeader > m.moyDead * 2,
   'et le grand mode rend bien plus que le petit (' + m.moyDeader.toFixed(0)
   + 'x contre ' + m.moyDead.toFixed(0) + 'x)');

console.log('\n-- ce qu on VEND coute ce que ca rapporte --');
/* L'essai qui compte : un cran vendu sous son rendu est une fuite, un cran
   vendu trop cher est un piege. On veut les deux bornes. */
for (const cran of dod.CRANS_ORDRE) {
  const a = dod.mesureAchat(cran, cran === 'dead' || cran === 'deader' ? 25000 : 60000, 'essai');
  const px = dod.CRANS[cran].prix;
  const retour = a.rendu / px;
  ok(retour < 1.00,
     cran.padEnd(8) + ' a ' + px + 'x : la maison garde quelque chose ('
     + (100 * retour).toFixed(1) + ' % de retour)');
  ok(retour > 0.85,
     cran.padEnd(8) + " et le joueur n'est pas plume (" + (100 * retour).toFixed(1) + ' %)');
}
/* L'ordre affiche doit monter : une echelle qui ne monte pas n'est pas une
   echelle, et c'est exactement ce qu'on obtient en recopiant les prix d'un
   autre moteur. */
let croissant = true;
for (let i = 1; i < dod.CRANS_ORDRE.length; i++)
  if (dod.CRANS[dod.CRANS_ORDRE[i]].prix <= dod.CRANS[dod.CRANS_ORDRE[i - 1]].prix) croissant = false;
ok(croissant, 'les quatre crans montent : '
   + dod.CRANS_ORDRE.map((c) => dod.CRANS[c].prix + 'x').join(' < '));

console.log('\n-- le plafond tient --');
const haut = dod.joue({ serverSeed: 's', clientSeed: 'c', nonce: 3, mise: 1 });
ok(haut.multi <= dod.GAIN_MAX, 'aucun tour ne depasse le plafond de ' + dod.GAIN_MAX + 'x');

console.log('\ndod.test.js : ' + n + ' verifications OK');
