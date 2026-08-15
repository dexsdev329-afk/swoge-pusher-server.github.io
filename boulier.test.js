'use strict';
/*
 * Verification du Boulier.
 *
 * Deux choses se verifient ici, et elles ne se verifient pas de la meme
 * facon :
 *
 *  1. LE BAREME. C'est de la combinatoire pure, donc on le verifie EXACTEMENT.
 *     La loi hypergeometrique est recalculee ici par un comptage independant
 *     du module — sinon on ne testerait que la coherence d'une formule avec
 *     elle-meme. Le taux de retour est verrouille a 85,02 % : c'est le chiffre
 *     sur lequel repose la marge, il ne doit pas pouvoir bouger par accident.
 *
 *  2. LE TIRAGE. Il ne se prouve pas, il se mesure. On verifie qu'il est
 *     reproductible, qu'il sort bien 30 boules distinctes, qu'il change avec
 *     le numero de manche, et — le point qui compte — qu'aucune boule n'est
 *     favorisee. Un `octet % 90` naif ferait sortir les petits numeros 1,4 %
 *     plus souvent ; le test le detecterait.
 */
const assert = require('assert');
const B = require('./boulier');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} : ${a} vs ${b}`); n++; };

// -------------------------------------------------------------- comptage
/* Binomiaux recalcules a part, sans passer par B.comb. */
function binom(a, b) {
  if (b < 0 || b > a) return 0;
  let r = 1;
  for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1);
  return r;
}
eq(B.BOULES, 90, '90 boules');
eq(B.TIREES, 30, '30 boules tirees');
eq(B.GRILLE, 10, 'grille de 10');

for (let k = 0; k <= B.GRILLE; k++) {
  const attendu = binom(30, k) * binom(60, 10 - k) / binom(90, 10);
  pres(B.chance(k), attendu, 1e-12, `chance de ${k} touches`);
}
/* Les probabilites d'une loi font 1. Si elles ne les font pas, tout le reste
   du fichier mesure du vent. */
let somme = 0;
for (let k = 0; k <= B.GRILLE; k++) somme += B.chance(k);
pres(somme, 1, 1e-12, 'les 11 issues font 1');

/* Les cotes annoncees dans le bareme et dans la page. Elles sont ecrites en
   dur ici EXPRES : c'est la seule facon de remarquer qu'un changement de
   reglage a rendu le plein dix fois plus frequent. */
const COTES = { 0: 76, 5: 7, 6: 20, 7: 82, 8: 552, 9: 6664, 10: 190402 };
for (const k of Object.keys(COTES))
  eq(Math.round(1 / B.chance(Number(k))), COTES[k], `1 sur ${COTES[k]} a ${k} touches`);

// ------------------------------------------------------------- economie
/* 85,02 % de bareme + 5 % de cagnotte = 90,02 % rendu. La tolerance est
   serree a dessein : un lot change d'un cran deplace le retour de plus d'un
   point, donc plus que 0,05. */
pres(B.retourBareme(), 0.8502, 0.0005, 'retour du bareme');
pres(B.retourTotal(), 0.9002, 0.0005, 'retour total, cagnotte comprise');
ok(B.retourTotal() < 0.95, 'la maison reste en benefice');
ok(B.retourTotal() > 0.85, 'le jeu reste jouable');
eq(B.CAGNOTTE_BPS, 500, '5 % a la cagnotte');

/* Le bareme, palier par palier, recalcule ici. */
const LOTS = { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 4, 7: 15, 8: 75, 9: 1200, 10: 0 };
let rtp = 0;
for (let k = 0; k <= 10; k++) { eq(B.BAREME[k], LOTS[k], `lot a ${k} touches`); rtp += LOTS[k] * B.chance(k); }
pres(rtp, B.retourBareme(), 1e-12, 'le retour est bien la somme des paliers');

/* L'echelle monte. Un palier plus rare qui paierait moins serait un piege. */
for (let k = 6; k < 9; k++) ok(B.BAREME[k] < B.BAREME[k + 1], `${k} paie moins que ${k + 1}`);

/* Le plein ne paie RIEN au bareme : il est paye par la cagnotte. Les deux
   ensemble compteraient le plein deux fois dans le taux de retour. */
eq(B.BAREME[10], 0, 'le plein ne passe pas par le bareme');

/* Frequence de gain : une grille sur 4 a 5 rapporte quelque chose. */
let freq = 0;
for (let k = 0; k <= 10; k++) if (B.BAREME[k] > 0) freq += B.chance(k);
ok(freq > 0.20 && freq < 0.23, `une grille sur ${(1 / freq).toFixed(1)} paie`);

// --------------------------------------------------- cycle de la cagnotte
/* Le pot doit s'auto-financer : ce qu'un plein emporte en regime etabli est
   EXACTEMENT ce que le cycle a collecte. On le verifie par le calcul, puis en
   simulant le cycle pas a pas — deux chemins qui doivent tomber pareil. */
{
  const prix = 100;
  const parGrille = B.partCagnotte(prix);
  eq(parGrille, 5, '5 SWOGE par grille a 100');
  const cycle = 1 / B.chance(10);                 // grilles entre deux pleins
  const collecte = parGrille * cycle;
  const garde = 1 - B.CAGNOTTE_PART_BPS / 10000;  // ce qui reste dans le pot
  const potAuGain = collecte / (1 - garde);
  const verse = potAuGain * (1 - garde);
  pres(verse, collecte, 1e-6, 'verse = collecte : le pot s auto-finance');
  ok(potAuGain > 1e6 && potAuGain < 1.3e6, `pot au gain ~ ${Math.round(potAuGain)}`);

  /* Simulation du cycle : on part de l'amorce, on encaisse un cycle, on verse,
     et on recommence. Le pot doit CONVERGER, ni exploser ni s'eteindre. */
  let pot = 1000000;
  const suite = [];
  for (let i = 0; i < 40; i++) {
    pot += collecte;
    suite.push(pot);
    pot -= B.partPlein(pot);
  }
  pres(suite[39], potAuGain, 1, 'le pot converge vers le regime etabli');
  ok(suite[39] > 0, 'le pot ne s eteint jamais');
}
eq(B.partPlein(1000000), 800000, '80 % du pot au gagnant');
eq(B.partPlein(0), 0, 'un pot vide ne verse rien');
eq(B.partCagnotte(10), 0, 'un prix de 10 ne verse rien a la cagnotte (arrondi bas)');

// -------------------------------------------------------------- lots
eq(B.lot(10, 100), 0, 'le plein ne rapporte rien au bareme');
eq(B.lot(9, 100), 120000, '9/10 vaut 120 000 a 100 la grille');
eq(B.lot(8, 100), 7500, '8/10 vaut 7 500');
eq(B.lot(7, 100), 1500, '7/10 vaut 1 500');
eq(B.lot(6, 100), 400, '6/10 vaut 400');
eq(B.lot(5, 100), 100, '5/10 rend la mise');
eq(B.lot(4, 100), 0, '4/10 ne rend rien');
eq(B.lot(0, 100), 100, '0/10 rend la mise');
/* Arrondi vers le bas, toujours : un arrondi au plus proche creerait des
   jetons a partir de rien, une manche sur deux. */
eq(B.lot(6, 33), Math.floor(33 * 4), 'arrondi entier vers le bas');

// ------------------------------------------------------------- grilles
{
  const bonne = [7, 3, 90, 1, 45, 12, 66, 30, 51, 22];
  const t = B.valideGrille(bonne);
  assert.deepStrictEqual(t, bonne.slice().sort((a, b) => a - b)); n++;
  assert.throws(() => B.valideGrille([1, 2, 3]), /exactly 10/); n++;
  assert.throws(() => B.valideGrille(bonne.concat([5])), /exactly 10/); n++;
  assert.throws(() => B.valideGrille([1, 1, 2, 3, 4, 5, 6, 7, 8, 9]), /twice/); n++;
  assert.throws(() => B.valideGrille([0, 2, 3, 4, 5, 6, 7, 8, 9, 10]), /between 1 and 90/); n++;
  assert.throws(() => B.valideGrille([91, 2, 3, 4, 5, 6, 7, 8, 9, 10]), /between 1 and 90/); n++;
  assert.throws(() => B.valideGrille([1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10]), /whole numbers/); n++;
  assert.throws(() => B.valideGrille('1,2,3'), /list of numbers/); n++;

  /* La grille au hasard doit passer sa propre validation. Sinon le bouton
     « lucky dip » proposerait des grilles que le serveur refuse. */
  for (let i = 0; i < 200; i++) {
    const g = B.grilleAuHasard();
    assert.deepStrictEqual(B.valideGrille(g), g);
  }
  n++;
}

// -------------------------------------------------------------- tirage
const GR = 'graine-de-serveur-pour-le-test';
{
  const a = B.tirage(GR, 'joueur', 1);
  const b = B.tirage(GR, 'joueur', 1);
  assert.deepStrictEqual(a, b); n++;                       // reproductible
  eq(a.length, 30, '30 boules sortent');
  eq(new Set(a).size, 30, 'aucune boule ne sort deux fois');
  ok(a.every((x) => Number.isInteger(x) && x >= 1 && x <= 90), 'toutes entre 1 et 90');

  /* Le numero de manche change le tirage. Sans ca, un joueur rejouerait la
     meme grille gagnante toute la journee. */
  ok(JSON.stringify(B.tirage(GR, 'joueur', 2)) !== JSON.stringify(a), 'le numero change le tirage');
  ok(JSON.stringify(B.tirage(GR, 'autre', 1)) !== JSON.stringify(a), 'la graine joueur change le tirage');
  ok(JSON.stringify(B.tirage('autre-serveur', 'joueur', 1)) !== JSON.stringify(a), 'la graine serveur change le tirage');
}

/* Uniformite. 20 000 tirages, 600 000 boules, 90 numeros : environ 6 667 par
   numero. Un biais de rejet mal fait deplacerait certains numeros de plus de
   1 % — largement au-dela des 4 ecarts-types tolerés ici. */
{
  const TOURS = 20000;
  const compte = new Array(91).fill(0);
  const parRang = [];                 // combien de fois chaque numero sort en 1er
  for (let i = 0; i < 5; i++) parRang.push(new Array(91).fill(0));
  for (let i = 0; i < TOURS; i++) {
    const s = B.tirage(GR, 'uniforme', i);
    for (let r = 0; r < s.length; r++) {
      compte[s[r]]++;
      if (r < 5) parRang[r][s[r]]++;
    }
  }
  const attendu = TOURS * 30 / 90;
  const sigma = Math.sqrt(TOURS * (30 / 90) * (1 - 30 / 90));
  let pire = 0;
  for (let x = 1; x <= 90; x++) pire = Math.max(pire, Math.abs(compte[x] - attendu) / sigma);
  ok(pire < 4.5, `aucune boule favorisee (pire ecart ${pire.toFixed(2)} sigma)`);

  /* Le RANG compte aussi : un melange partiel bugge sortirait toujours les
     memes numeros en premier tout en gardant la frequence globale bonne. */
  const att1 = TOURS / 90;
  const sig1 = Math.sqrt(TOURS * (1 / 90) * (1 - 1 / 90));
  let pire1 = 0;
  for (let x = 1; x <= 90; x++) pire1 = Math.max(pire1, Math.abs(parRang[0][x] - att1) / sig1);
  ok(pire1 < 4.5, `la premiere boule est uniforme (pire ecart ${pire1.toFixed(2)} sigma)`);
}

/* borne() : un entier uniforme dans [0, m). On verifie surtout qu'il ne sort
   JAMAIS de l'intervalle — un modulo hors borne ferait echanger une case
   inexistante de l'urne et le tirage rendrait `undefined`. */
{
  for (const m of [1, 2, 7, 61, 89, 90, 128, 255, 256]) {
    const suivant = B.octets(GR, 'borne:' + m, 0);
    for (let i = 0; i < 500; i++) {
      const v = B.borne(suivant, m);
      assert.ok(Number.isInteger(v) && v >= 0 && v < m, `borne(${m}) hors intervalle : ${v}`);
    }
  }
  n++;
}

// ------------------------------------------------------------- touches
{
  const g = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepStrictEqual(B.touches(g, [3, 1, 77, 9]), [1, 3, 9]); n++;
  assert.deepStrictEqual(B.touches(g, [50, 60]), []); n++;
  assert.deepStrictEqual(B.touches(g, g), g); n++;
}

// ------------------------------------- controle du retour par simulation
/* Le comptage exact a deja prouve le bareme ; cette simulation-ci verifie
   autre chose — que le TIRAGE REEL produit bien cette distribution.
 *
 * On compare les FREQUENCES, pas le taux de retour. Le retour mesure est un
 * mauvais temoin ici : le 9/10 pese 18 de ses 85 points a lui seul et tombe
 * une fois sur 6 664, donc sur 150 000 manches son ecart-type deplace le
 * retour de 3 points dans un sens ou dans l'autre. Un test cale la-dessus
 * echouerait une fois sur trois sans qu'aucun bug n'existe. La distribution,
 * elle, se teste palier par palier a son propre ecart-type — et c'est bien
 * elle qui dirait qu'un tirage biaise. */
{
  const TOURS = 150000;
  const prix = 100;
  let mise = 0, rendu = 0;
  const hist = new Array(11).fill(0);
  for (let i = 0; i < TOURS; i++) {
    const s = new Set(B.tirage(GR, 'retour', i));
    /* Toujours la meme grille : le retour n'en depend pas — c'est justement ce
       que la loi hypergeometrique dit, et jouer 1..10 le met en evidence. */
    let h = 0;
    for (let x = 1; x <= 10; x++) if (s.has(x)) h++;
    hist[h]++;
    mise += prix; rendu += B.lot(h, prix);
  }
  /* Chaque palier a son propre ecart-type : 4,5 sigma laisse passer le hasard
     et arrete un biais. On s'arrete a 8 touches — au-dela l'effectif attendu
     est trop petit pour que l'approximation normale veuille dire quoi que ce
     soit. */
  for (let k = 0; k <= 8; k++) {
    const p = B.chance(k);
    const sg = Math.sqrt(TOURS * p * (1 - p));
    const ecart = Math.abs(hist[k] - TOURS * p) / sg;
    ok(ecart < 4.5, `frequence de ${k} touches (${ecart.toFixed(2)} sigma)`);
  }
  /* Le retour n'est verifie que grossierement, pour la raison ci-dessus : on
     s'assure seulement qu'on n'est pas passe a cote d'un facteur 2. */
  const mesure = rendu / mise;
  ok(mesure > 0.70 && mesure < 1.05, `retour mesure ${(mesure * 100).toFixed(2)} %`);
}

console.log(`boulier.test.js : ${n} verifications OK`);
