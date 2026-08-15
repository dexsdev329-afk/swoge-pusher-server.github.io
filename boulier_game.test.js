'use strict';
/*
 * Le moteur du Boulier est verifie a part (boulier.test.js). Ici on verifie le
 * RACCORDEMENT : le solde, la cagnotte, et la sauvegarde.
 *
 * La cagnotte est ce qui rend ce jeu different de tous les autres du casino.
 * C'est un montant PARTAGE qui traverse les manches, les joueurs et les
 * redeploiements. Trois facons de le casser, une par section ci-dessous :
 *
 *   • l'alimenter apres l'avoir distribuee (un plein du premier coup emporte
 *     alors un pot auquel sa propre mise n'a pas contribue) ;
 *   • la remettre a l'amorce a la relecture (la maison offre le million a
 *     chaque deploiement) ;
 *   • la vider entierement au gain (le pot repart de zero et plus personne
 *     ne le regarde pendant six mois).
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');
const B = require('./boulier');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const ADR = '0x4444444444444444444444444444444444444444';
const sol = (g) => Number(g.balanceStr(ADR));
const pot = (g) => Number(g.boulierPotStr());

function neuf(credit = 100000) {
  const g = new Game();
  g._p(ADR).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}
/** Une grille quelconque, valide. */
const G = (a) => a || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Force le tirage de la manche suivante : on remplace la fonction du module
 *  le temps d'un appel. C'est la seule facon d'atteindre un 10/10, qui tombe
 *  une fois sur 190 402 et ne s'obtiendra jamais par la force brute. */
function avecTirage(sortie, f) {
  const vrai = B.tirage;
  B.tirage = () => sortie.slice();
  try { return f(); } finally { B.tirage = vrai; }
}

/* ---- une manche entiere, en un appel ----
 *
 * Le jeu est passe d'un tirage a la demande a une SALLE : on s'inscrit pendant
 * dix secondes, puis le serveur tire pour tout le monde. Les verifications
 * d'argent ci-dessous n'ont pas change de nature pour autant — c'est toujours
 * la meme mise, le meme bareme et la meme cagnotte. Cet adaptateur ouvre la
 * salle, inscrit, force l'echeance et rend le resultat du joueur dans la forme
 * que les tests attendent. Tout ce qui suit teste donc l'ARGENT ; les phases,
 * elles, sont verifiees dans boulier_salle.test.js. */
function ouvre(g) {
  g.boulierSalle.phase = 'apres';
  g.boulierSalle.jusqua = 0;
  g.boulierTick(Date.now());
}
function joue(g, grilles, adr) {
  const a = adr || ADR;
  if (g.boulierSalle.phase !== 'attente') ouvre(g);
  g.boulierInscrit(a, grilles, Date.now());
  return g;
}
/** Ferme l'attente et tire. Rend le resultat du joueur demande. */
function tire(g, adr) {
  g.boulierSalle.jusqua = 0;
  const evs = g.boulierTick(Date.now());
  const ev = evs.filter((e) => e.type === 'boulierTirage')[0];
  if (!ev) throw new Error('pas de tirage');
  const r = (ev.resultats || []).filter((x) => x.addr === (adr || ADR))[0];
  return Object.assign({ prix: cfg.BOULIER_PRIX, sortie: ev.sortie },
                       r || { mise: 0, lignes: [], payout: 0, net: 0, cagnotteGagnee: 0 },
                       { cagnotte: g.boulierPotStr(), pleins: g.boulierPleins.slice(0, 10) });
}
/** Inscription + tirage force, l'equivalent exact de l'ancien boulierJoue. */
function manche(g, grilles, sortie, adr) {
  joue(g, grilles, adr);
  return sortie ? avecTirage(sortie, () => tire(g, adr)) : tire(g, adr);
}
/** 30 boules dont les 10 premieres sont celles de la grille. */
function sortiePleine(grille) {
  const s = grille.slice();
  for (let x = 1; x <= 90 && s.length < 30; x++) if (s.indexOf(x) < 0) s.push(x);
  return s;
}
/** 30 boules qui n'en contiennent AUCUNE des grilles passees. Prend la
 *  REUNION : avec une seule grille exclue, les 30 boules attrapaient
 *  integralement la grille suivante — et le test comptait deux pleins la ou il
 *  croyait n'en compter aucun. */
function sortieVide() {
  const pris = new Set();
  for (const g of arguments) for (const x of g) pris.add(x);
  const s = [];
  for (let x = 1; x <= 90 && s.length < 30; x++) if (!pris.has(x)) s.push(x);
  if (s.length < 30) throw new Error('pas assez de boules libres pour ce test');
  return s;
}

// ------------------------------------------------------------- le bareme
{
  const g = neuf();
  const b = g.boulierBareme();
  eq(b.boules, 90, '90 boules annoncees');
  eq(b.tirees, 30, '30 boules tirees annoncees');
  eq(b.grille, 10, 'grille de 10 annoncee');
  eq(b.prix, cfg.BOULIER_PRIX, 'le prix vient de la configuration');
  eq(b.table.length, 11, 'onze paliers, de 0 a 10');
  eq(b.table[10].cagnotte, true, 'le plein est marque comme cagnotte');
  eq(b.table[10].unSur, 190402, 'la cote du plein est annoncee');
  ok(Math.abs(b.retourTotal - 0.9002) < 0.0005, 'le retour annonce est le vrai');
  /* La page ne doit avoir aucune formule a elle : tout ce qu'elle affiche est
     dans ce message. */
  ok(b.table.every((l) => l.unSur > 0 && l.chance > 0), 'chaque palier porte sa cote');
}

// ----------------------------------------------------- la mise et le gain
{
  const g = neuf();
  const avant = sol(g);
  const p0 = pot(g);
  const r = manche(g, [G()], sortieVide(G()));
  eq(r.mise, cfg.BOULIER_PRIX, 'une grille coute le prix affiche');
  eq(r.lignes.length, 1, 'une ligne par grille');
  eq(r.lignes[0].n, 0, '0 touche sur une sortie choisie sans aucun numero');
  eq(r.lignes[0].lot, cfg.BOULIER_PRIX, '0/10 rend la mise');
  eq(r.payout, cfg.BOULIER_PRIX, 'le rendu est le lot');
  eq(r.net, 0, 'zero touche : on rentre dans ses frais');
  eq(sol(g), avant, 'le solde revient a son point de depart');
  /* La part cagnotte est prise sur la MISE, pas sur le gain : elle part meme
     quand la grille est remboursee. */
  eq(pot(g), p0 + B.partCagnotte(cfg.BOULIER_PRIX), 'la cagnotte a encaisse sa part');
}

// ---------------------------------------------------- plusieurs grilles
{
  const g = neuf();
  const avant = sol(g);
  const p0 = pot(g);
  const grilles = [G(), G([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
                   G([21, 22, 23, 24, 25, 26, 27, 28, 29, 30])];
  const r = manche(g, grilles, sortieVide.apply(null, grilles));
  eq(r.mise, cfg.BOULIER_PRIX * 3, 'trois grilles coutent trois fois le prix');
  eq(r.lignes.length, 3, 'trois lignes');
  eq(pot(g), p0 + B.partCagnotte(cfg.BOULIER_PRIX) * 3, 'la cagnotte encaisse par grille');
  /* Les grilles d'une meme manche partagent LE MEME tirage : un boulier ne
     tourne qu'une fois. */
  eq(r.sortie.length, 30, 'un seul tirage de 30 boules pour toute la manche');
  eq(sol(g), avant - r.mise + r.payout, 'le solde suit mise et rendu');
}

// ------------------------------------------------------- les refus
{
  const g = neuf();
  /* La salle refuse tout hors de la fenetre d'inscription, et ce refus-la
     passe AVANT la lecture des grilles : sans l'ouvrir, tous les tests qui
     suivent verifieraient le mauvais message. */
  jete(() => g.boulierInscrit(ADR, [G()], Date.now()), /closed/, 'inscription hors fenetre');
  eq(sol(g), 100000, 'un refus de phase ne debite pas');
  ouvre(g);
  jete(() => g.boulierInscrit(ADR, [], Date.now()), /at least one grid/, 'zero grille');
  jete(() => g.boulierInscrit(ADR, 'grille', Date.now()), /at least one grid/, 'pas une liste');
  const trop = [];
  for (let i = 0; i <= cfg.BOULIER_GRILLES_MAX; i++) trop.push(G());
  jete(() => g.boulierInscrit(ADR, trop, Date.now()), /at most/, 'trop de grilles');
  jete(() => g.boulierInscrit(ADR, [[1, 2, 3]], Date.now()), /exactly 10/, 'grille incomplete');
  jete(() => g.boulierInscrit(ADR, [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9]], Date.now()), /twice/, 'doublon');
  jete(() => g.boulierInscrit(ADR, [[0, 2, 3, 4, 5, 6, 7, 8, 9, 10]], Date.now()), /between 1 and 90/, 'hors bornes');
  /* Une manche refusee ne doit RIEN avoir touche. */
  eq(sol(g), 100000, 'un refus ne debite pas');
  eq(pot(g), Number(cfg.BOULIER_CAGNOTTE_AMORCE), 'un refus n alimente pas la cagnotte');
}
{
  /* Solde insuffisant : le prix etant fixe, c'est le NOMBRE de grilles qui
     doit etre refuse, et le refus doit arriver avant tout debit. */
  const g = neuf(250);
  ouvre(g);
  jete(() => g.boulierInscrit(ADR, [G(), G([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
                                    G([21, 22, 23, 24, 25, 26, 27, 28, 29, 30])], Date.now()),
       /not enough/, 'trois grilles a 250 de solde');
  eq(sol(g), 250, 'le solde n a pas bouge');
  const deux = [G(), G([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])];
  const r = manche(g, deux, sortieVide.apply(null, deux));
  eq(r.mise, 200, 'deux grilles passent');
}

// ------------------------------------------------------ tous les paliers
/* On force une sortie qui donne exactement k touches, pour k de 0 a 9, et on
   verifie le lot contre le bareme. C'est la jonction entre le moteur et le
   solde : une erreur ici paie le mauvais montant sans qu'aucun test de
   probabilite ne s'en apercoive. */
{
  for (let k = 0; k <= 9; k++) {
    const g = neuf();
    const grille = G();
    const s = grille.slice(0, k);
    for (let x = 11; x <= 90 && s.length < 30; x++) s.push(x);
    const avant = sol(g);
    const r = manche(g, [grille], s);
    eq(r.lignes[0].n, k, `${k} touches forcees`);
    eq(r.lignes[0].lot, B.lot(k, cfg.BOULIER_PRIX), `lot de ${k} touches`);
    eq(r.lignes[0].plein, false, `${k} touches n est pas un plein`);
    eq(sol(g), avant - cfg.BOULIER_PRIX + r.payout, `solde apres ${k} touches`);
  }
}

// ------------------------------------------------------------ le plein
{
  const g = neuf();
  const grille = G();
  const p0 = pot(g);
  const avant = sol(g);
  const r = manche(g, [grille], sortiePleine(grille));
  eq(r.lignes[0].n, 10, 'dix touches');
  eq(r.lignes[0].plein, true, 'la ligne est marquee pleine');
  eq(r.lignes[0].lot, 0, 'le bareme ne paie rien : c est la cagnotte qui paie');

  /* L'ORDRE COMPTE. La part de la manche entre dans le pot AVANT que le
     gagnant y prenne ses 80 % : sinon il emporterait un pot auquel sa propre
     mise n'a pas encore contribue. */
  const potAlimente = p0 + B.partCagnotte(cfg.BOULIER_PRIX);
  eq(r.cagnotteGagnee, Math.floor(potAlimente * 0.8), 'le gagnant prend 80 % du pot alimente');
  eq(r.payout, r.cagnotteGagnee, 'le rendu est la cagnotte');
  eq(sol(g), avant - cfg.BOULIER_PRIX + r.cagnotteGagnee, 'la cagnotte est creditee');

  /* Le pot ne repart PAS de zero : les 20 % restants amorcent le cycle. */
  eq(pot(g), potAlimente - r.cagnotteGagnee, 'les 20 % restent dans le pot');
  ok(pot(g) > 0, 'le pot ne s eteint jamais');
  eq(Number(r.cagnotte), pot(g), 'le montant annonce est le montant reel');

  /* Le plein est inscrit au tableau, pour la page et pour l'admin. */
  eq(g.boulierPleins.length, 1, 'le plein est enregistre');
  eq(g.boulierPleins[0].gain, r.cagnotteGagnee, 'avec son montant');
  eq(g.boulierPleins[0].addr, ADR, 'et son gagnant');
}

// ------------------------------------------ deux pleins dans la meme manche
/* Absurde en pratique, possible en droit : deux grilles identiques. Le pot
   doit se vider DEUX FOIS de 80 % de ce qu'il reste, pas deux fois de 80 % de
   ce qu'il valait — sinon la maison paie 160 % d'un pot qu'elle n'a pas. */
{
  const g = neuf();
  const grille = G();
  const p0 = pot(g);
  const r = manche(g, [grille, grille.slice()], sortiePleine(grille));
  const alimente = p0 + B.partCagnotte(cfg.BOULIER_PRIX) * 2;
  const un = Math.floor(alimente * 0.8);
  const reste = alimente - un;
  const deux = Math.floor(reste * 0.8);
  eq(r.cagnotteGagnee, un + deux, 'chaque plein prend 80 % de ce qui RESTE');
  ok(r.cagnotteGagnee < alimente, 'la maison ne paie jamais plus que le pot');
  eq(pot(g), reste - deux, 'le pot survit aux deux');
  ok(pot(g) > 0, 'et reste positif');
}

// ----------------------------------------------------- equite verifiable
{
  const g = neuf();
  ouvre(g);
  g.boulierInscrit(ADR, [G()], Date.now());
  g.boulierSalle.jusqua = 0;
  const ev = g.boulierTick(Date.now()).filter((e) => e.type === 'boulierTirage')[0];
  const r = { sortie: ev.sortie };
  /* LE TIRAGE VIENT DU MAILLON, plus de la graine du joueur. Une manche
     partagee n'appartient a personne : elle se verifie avec l'engagement
     public annonce avant que quiconque ait mise, et le maillon revele avec les
     boules. C'est le meme melange, la meme fonction — seule la graine change
     de proprietaire. */
  assert.deepStrictEqual(r.sortie, B.tirage(ev.maillon, ev.sel, ev.manche)); n++;
  ok(ev.maillon && /^[0-9a-f]{64}$/.test(ev.maillon), 'le maillon est revele avec les boules');
  eq(r.sortie.length, 30, 'les 30 boules sont rendues');
  eq(new Set(r.sortie).size, 30, 'toutes distinctes');
  /* Rendues DANS L'ORDRE de sortie, pas triees : l'animation les lache une par
     une, et un tirage trie serait invérifiable. */
  ok(r.sortie.some((x, i) => i > 0 && x < r.sortie[i - 1]), 'l ordre du boulier est conserve');
}

// ------------------------------------------------- comptabilite et journal
{
  const g = neuf();
  const deux = [G(), G([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])];
  const r = manche(g, deux, sortieVide.apply(null, deux));
  const j = g._p(ADR).jeux.boulier;
  ok(j, 'le jeu est compte sous son nom');
  eq(j.n, 1, 'une manche, pas une par grille');
  eq(j.mise, r.mise, 'la mise totale est comptee');
  eq(j.rendu, r.payout, 'le rendu total est compte');
  /* Le revenu de la maison passe par _manche comme pour tous les autres jeux :
     un jeu qui ne l'appelle pas ne compte pas dans les statistiques. */
  const mois = g._mois();
  ok(mois.mises >= r.mise, 'la mise entre dans la comptabilite du mois');
  ok(mois.rendus >= r.payout, 'le rendu aussi');
}

// ------------------------------------------------- la cagnotte se sauvegarde
{
  const g = neuf();
  manche(g, [G()], sortieVide(G()));
  const attendu = pot(g);
  ok(attendu > Number(cfg.BOULIER_CAGNOTTE_AMORCE), 'le pot a monte');

  const relu = new Game();
  relu.hydrate(g.serialize());
  eq(Number(relu.boulierPotStr()), attendu, 'le pot survit a un redemarrage');

  /* LE PIEGE : un pot vide relu avec `if (st.boulierPot)` repartirait a
     l'amorce, et la maison offrirait le million a chaque deploiement suivant
     un gros gain. */
  g.boulierPot = ethers.BigNumber.from(0);
  const vide = new Game();
  vide.hydrate(g.serialize());
  eq(Number(vide.boulierPotStr()), 0, 'un pot a zero se relit a zero');

  /* Les pleins aussi : c'est l'historique que la page affiche. */
  const g2 = neuf();
  manche(g2, [G()], sortiePleine(G()));
  const relu2 = new Game();
  relu2.hydrate(g2.serialize());
  eq(relu2.boulierPleins.length, 1, 'les pleins survivent au redemarrage');
  eq(relu2.boulierEtat().pleins[0].gain, g2.boulierPleins[0].gain, 'avec leur montant');
}

// ------------------------------------------------- la cagnotte est partagee
/* Deux joueurs, un seul pot. C'est ce qui fait la difference avec un lot fixe :
   ce que l'un perd grossit ce que l'autre peut gagner. */
{
  const g = neuf();
  const AUTRE = '0x5555555555555555555555555555555555555555';
  g._p(AUTRE).balance = ethers.utils.parseUnits('100000', cfg.DECIMALS);
  const p0 = pot(g);
  manche(g, [G()], sortieVide(G()));
  manche(g, [G()], sortieVide(G()), AUTRE);
  eq(pot(g), p0 + B.partCagnotte(cfg.BOULIER_PRIX) * 2, 'les deux joueurs alimentent le meme pot');
}

// --------------------------------------- le jeu tourne vraiment en benefice
/* Le controle final : 60 000 manches contre le VRAI tirage, cagnotte comprise,
   et on compte l'argent au lieu des probabilites. Une erreur de raccordement —
   double credit, mauvais arrondi, part cagnotte oubliee — se verrait ici et
   nulle part ailleurs.
 *
 * LE PLEIN EST SEPARE DU RESTE, et ce n'est pas un detail : il tombe une fois
 * sur 190 402, donc sur 60 000 manches il arrive une fois sur trois. Melange
 * aux lots fixes, il faisait deux degats a la fois — l'identite comptable
 * comparait un rendu contenant la cagnotte a un bareme qui ne la paie pas, et
 * la bande de tolerance de la marge, calculee sur le seul bareme, sautait de
 * dix-sept points le jour ou il sortait. Le test echouait une execution sur
 * trois sans qu'aucun bug n'existe.
 *
 * Les trois premieres verifications sont des IDENTITES : vraies a l'unite pres
 * quelle que soit la chance du tirage, donc elles ne peuvent pas echouer par
 * hasard. C'est ce qu'on veut d'un test de comptabilite.
 *
 * La marge, elle, ne se verifie que dans une bande, et la bande est LARGE :
 * l'ecart-type du retour d'une grille vaut 15,1 fois la mise (le 9/10 paie
 * 1200 et tombe une fois sur 6 664). On calcule donc la tolerance a partir du
 * bareme lui-meme au lieu d'ecrire un chiffre au juge. */
{
  const g = neuf(1e9);
  const TOURS = 60000;
  let mise = 0, rendu = 0, cagnotte = 0;
  const hist = new Array(11).fill(0);
  const p0 = pot(g);
  for (let i = 0; i < TOURS; i++) {
    const r = manche(g, [G()]);
    mise += r.mise; rendu += r.payout; cagnotte += r.cagnotteGagnee;
    hist[r.lignes[0].n]++;
  }
  const fixe = rendu - cagnotte;            // ce que le BAREME a paye

  /* 1. Le bareme a paye EXACTEMENT ce qu'il annonce pour les resultats
        reellement sortis. Un lot mal branche se voit tout de suite. */
  let attendu = 0;
  for (let k = 0; k <= 10; k++) attendu += hist[k] * B.lot(k, cfg.BOULIER_PRIX);
  eq(fixe, attendu, 'chaque manche a paye ce que le bareme annonce');

  /* 2. La cagnotte : elle a recu 5 % de tout, et ce qu'elle a verse en est
        sorti. Le pot d'arrivee est donc entierement determine — y compris les
        manches ou un plein l'a vide. */
  const verse = B.partCagnotte(cfg.BOULIER_PRIX) * TOURS;
  eq(pot(g) - p0, verse - cagnotte, 'pot final = pot initial + 5 % de tout - ce qui a ete gagne');
  if (cagnotte > 0) ok(hist[10] > 0, 'une cagnotte gagnee vient bien d un plein');
  eq(hist[10] > 0, cagnotte > 0, 'un plein paie la cagnotte, et rien d autre ne la paie');

  /* 3. Aucun jeton n'est apparu ni disparu. */
  eq(sol(g), 1e9 - mise + rendu, 'le solde est exactement mise - rendu');

  /* 4. La marge du BAREME, dans la bande que sa variance autorise. La cagnotte
        en est exclue des deux cotes : ce qu'elle encaisse ne reste pas a la
        maison, et ce qu'elle verse ne lui coute rien de plus. */
  const garde = (mise - fixe - verse) / mise;
  let e1 = 0, e2 = 0;
  for (let k = 0; k <= 10; k++) { const m = B.BAREME[k]; e1 += m * B.chance(k); e2 += m * m * B.chance(k); }
  const sigma = Math.sqrt(e2 - e1 * e1) / Math.sqrt(TOURS);
  const vise = 1 - B.retourTotal();
  ok(Math.abs(garde - vise) < 4 * sigma,
     `marge ${(garde * 100).toFixed(2)} % · visee ${(vise * 100).toFixed(2)} % · tolerance ${(4 * sigma * 100).toFixed(1)} pts`);
  ok(vise > 0.09 && vise < 0.11, `la maison garde ${(vise * 100).toFixed(2)} % en esperance`);
}

console.log(`boulier_game.test.js : ${n} verifications OK`);
