'use strict';
/*
 * LE SECOND CRAN DU FAMILIER : LES POUVOIRS DE ZONE.
 *
 * Chaque espece apprend un second geste au niveau vingt-cinq — la ou sa
 * recharge tombe a dix secondes, donc la ou le compagnon devient jouable. Il
 * frappe LARGE au lieu de frapper UNE cible.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. IL N'EN FAIT QU'UN PAR RECHARGE. La promesse du systeme est que le
 *    niveau achete de la FREQUENCE, pas de la puissance. Enchainer les deux
 *    gestes aurait double sa force le jour de l ouverture du second cran.
 * 2. IL CHOISIT, ET LE SEUIL EST UNE REGLE. Chaque creature touchee par une
 *    zone prend environ la moitie de ce qu elle aurait pris seule : c est a
 *    partir de `zoneMini` qu il vaut mieux frapper large. Le chiffre vit dans
 *    le monde, pas dans le code du choix.
 * 3. UN GESTE DANS LE VIDE FAIT RETOMBER SUR L AUTRE. Le second cran d un
 *    legendaire ne soigne personne si tout le monde est plein : il vaut mieux
 *    qu il retombe sur son soin que de perdre son tour.
 * 4. AVANT LE NIVEAU, LE SECOND GESTE N EXISTE PAS. Un pouvoir qui
 *    s appliquerait avant son cran rendrait le cran decoratif.
 * 5. ET CHACUN FAIT CE QU IL DIT. Six pouvoirs, six verifications : ce qui
 *    brule brule, ce qui fige fige, ce qui vole ne vole que ce qu il a
 *    reellement pris.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/famzone-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const fiche = (fam, niv, nom) => ({ skin: 'andy', nom: nom || 'Alice',
  stats: { att: 40, def: 10, spd: 30, dex: 30, vit: 30, wis: 20, hp: 500, mp: 100 },
  famille: 'lame', degats: [40, 60], fam: fam || null, famNiv: niv || 1 });

/* Une scene vide : un joueur, aucune creature. Mesurer un pouvoir de zone au
   milieu d'un monde peuple reviendrait a mesurer le monde. */
function scene(fam, niv) {
  const R = new Realm({});
  const A = '0xaaa';
  R.rejoint(A, fiche(fam, niv));
  const j = R.joueurs.get(A);
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  return { R, A, j };
}
function poseMonstre(R, j, dx, dy, pv) {
  const espece = Object.keys(monde.MONSTRES)[0];
  const m = { id: R._nouvelId(), espece, biome: null, x: j.x + dx, y: j.y + dy,
              ancreX: j.x + dx, ancreY: j.y + dy,
              pv: pv || 100000, pvMax: pv || 100000, dir: 'down', cible: null,
              recharge: 999, rechargeT: 999, stase: 0,
              feu: 0, feuReste: 0, feuTaux: 0, feuPar: null,
              errX: 0, errY: 0, errChrono: 0 };
  R.monstres.push(m);
  return m;
}
function avance(R, secondes) {
  const evs = [];
  for (let t = 0; t < secondes; t += 0.1) evs.push(R.pas(0.1));
  return evs;
}
const gestes = (evs, quoi) => evs.flatMap((e) => (e.fam || []))
  .filter((f) => !quoi || f.quoi === quoi);

/* Le niveau d'ouverture vient du MONDE. L'ecrire ici en dur ferait passer
   l'essai le jour ou l'on decale les crans — et c'est justement ce jour-la
   qu'on veut qu'il parle. */
const CRAN = monde.POUVOIRS_PAR_ESPECE.normal[1].niveau;
const MINI = monde.FAMILIERS.zoneMini;
const RAYON = monde.FAMILIERS.zoneRayon;
console.log(`\n(le second cran s'ouvre au niveau ${CRAN}, la zone porte a ${RAYON}, ` +
            `et il en faut ${MINI} pour qu'elle passe devant)`);

/* ================== 1. AVANT LE CRAN, IL N'EXISTE PAS ================== */
console.log('\n-- au niveau juste en dessous, rien de neuf --');
{
  const { R, j } = scene('normal', CRAN - 1);
  for (let i = 0; i < MINI + 2; i++) poseMonstre(R, j, 40 + i * 10, 0);
  const evs = avance(R, 1.0);
  eq(gestes(evs, 'meute').length, 0, 'aucune morsure de groupe');
  ok(gestes(evs, 'mord').length > 0, 'il mord une cible, comme avant');
}
console.log('\n-- au niveau du cran, la zone existe --');
{
  const { R, j } = scene('normal', CRAN);
  for (let i = 0; i < MINI + 2; i++) poseMonstre(R, j, 40 + i * 10, 0);
  const evs = avance(R, 1.0);
  ok(gestes(evs, 'meute').length > 0, 'il ameute');
}

/* ================== 2. IL CHOISIT, ET IL N'EN FAIT QU'UN ================== */
console.log('\n-- en dessous du seuil, il vise une seule cible --');
{
  const { R, j } = scene('normal', 100);
  for (let i = 0; i < MINI - 1; i++) poseMonstre(R, j, 40 + i * 10, 0);
  const evs = avance(R, 0.5);
  ok(gestes(evs, 'mord').length > 0, `avec ${MINI - 1} creatures, il mord`);
  eq(gestes(evs, 'meute').length, 0, 'et il n ameute pas');
}
console.log('\n-- au seuil, il frappe large --');
{
  const { R, j } = scene('normal', 100);
  const ms = [];
  for (let i = 0; i < MINI; i++) ms.push(poseMonstre(R, j, 40 + i * 10, 0));
  const evs = avance(R, 0.5);
  ok(gestes(evs, 'meute').length > 0, `avec ${MINI}, il ameute`);
  eq(gestes(evs, 'mord').length, 0, 'et il ne mord plus une seule cible');
  /* UN SEUL GESTE PAR RECHARGE : c'est toute la promesse du systeme. */
  const total = gestes(evs).length;
  eq(total, 1, 'un seul geste sur la fenetre, pas deux');
  ok(ms.every((m) => m.pv < m.pvMax), 'les trois ont pris des degats');
}
console.log('\n-- hors du rayon, elles ne comptent pas --');
{
  /* Le seuil se mesure dans le rayon de la ZONE, pas dans la portee du
     pouvoir a cible unique : compter dans les 260 aurait fait choisir la zone
     pour des creatures qu'elle n'atteint pas. */
  const { R, j } = scene('normal', 100);
  for (let i = 0; i < MINI; i++) poseMonstre(R, j, RAYON + 20 + i * 5, 0);
  poseMonstre(R, j, 40, 0);
  const evs = avance(R, 0.5);
  ok(gestes(evs, 'mord').length > 0,
     `${MINI} creatures au-dela de ${RAYON} ne declenchent pas la zone`);
  eq(gestes(evs, 'meute').length, 0, 'il mord celle qui est vraiment pres');
}

/* ================== 3. CHACUN FAIT CE QU'IL DIT ================== */
console.log('\n-- le feu embrase tout ce qui est autour --');
{
  const { R, j } = scene('feu', 100);
  const ms = [];
  for (let i = 0; i < MINI; i++) ms.push(poseMonstre(R, j, 40 + i * 10, 0));
  const evs = avance(R, 0.5);
  ok(gestes(evs, 'brasier').length > 0, 'il embrase');
  ok(ms.every((m) => m.feu > 0), 'les trois brulent');
  ok(ms.every((m) => m.feuPar === '0xaaa'), 'et la brulure porte le nom du maitre');
}
console.log('\n-- la glace fige tout ce qui est autour --');
{
  const { R, j } = scene('glace', 100);
  const ms = [];
  for (let i = 0; i < MINI; i++) ms.push(poseMonstre(R, j, 40 + i * 10, 0));
  const evs = avance(R, 0.5);
  ok(gestes(evs, 'gresil').length > 0, 'il grele');
  ok(ms.every((m) => m.stase > 0), 'les trois sont figees');
  /* Elle ne PROLONGE pas : un groupe fige une fois se reprolongerait a chaque
     recharge, et la glace serait une suppression, pas une aide. */
  const restes = ms.map((m) => m.stase);
  avance(R, 3.5);
  ok(ms.every((m, i) => m.stase < restes[i] + 0.01),
     'et une seconde passe ne les reprolonge pas');
}
console.log('\n-- la terre repousse ET arrete --');
{
  const { R, j } = scene('terre', 100);
  const ms = [];
  for (let i = 0; i < MINI; i++) ms.push(poseMonstre(R, j, 40 + i * 10, 0));
  const avant = ms.map((m) => Math.hypot(m.x - j.x, m.y - j.y));
  const evs = avance(R, 0.5);
  ok(gestes(evs, 'secousse').length > 0, 'il secoue');
  const apres = ms.map((m) => Math.hypot(m.x - j.x, m.y - j.y));
  ok(apres.every((d, i) => d > avant[i]), 'les trois sont plus loin qu avant');
  ok(ms.every((m) => m.stase > 0), 'et toutes les trois sont arretees');
}
console.log('\n-- l ombre devore, et se nourrit --');
{
  const { R, j } = scene('tenebre', 100);
  const ms = [];
  for (let i = 0; i < MINI; i++) ms.push(poseMonstre(R, j, 40 + i * 10, 0));
  j.pv = 100;                                   // blesse, pour voir le vol
  const evs = avance(R, 0.5);
  const g = gestes(evs, 'abysse');
  ok(g.length > 0, 'il devore');
  ok(ms.every((m) => m.pv < m.pvMax), 'les trois ont pris des degats');
  ok(g[0].gain > 0, `et le maitre en recupere (${g[0].gain})`);
  eq(j.pv, 100 + g[0].gain, 'exactement ce que l evenement annonce');
}
console.log('\n-- et il ne vole que ce qu il a VRAIMENT pris --');
{
  /* Une creature a trois points de vie n'en rend que trois. Voler sur le
     montant annonce aurait soigne le maitre pour des degats qui n'ont pas eu
     lieu — la faute est invisible tant qu on ne tue pas de petites choses. */
  const { R, j } = scene('tenebre', 100);
  for (let i = 0; i < MINI; i++) poseMonstre(R, j, 40 + i * 10, 0, 3);
  j.pv = 100;
  const E = monde.familierEffet('abysse', 100);
  const evs = avance(R, 0.5);
  const g = gestes(evs, 'abysse')[0];
  ok(!!g, 'il devore le groupe');
  const plafond = Math.round(MINI * 3 * E.vol) + 1;
  ok(g.gain <= plafond,
     `le vol ne depasse pas ce que trois creatures a 3 pv pouvaient rendre (${g.gain} <= ${plafond})`);
}
console.log('\n-- la relique soigne les autres --');
{
  const R = new Realm({});
  R.rejoint('0xaaa', fiche('legendaire', 100, 'Alice'));
  R.rejoint('0xbbb', fiche(null, 1, 'Bob'));
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  const a = R.joueurs.get('0xaaa'), b = R.joueurs.get('0xbbb');
  b.x = a.x + 60; b.y = a.y;
  a.pv = 100; b.pv = 100;
  for (let i = 0; i < MINI; i++) poseMonstre(R, a, 40 + i * 10, 0);
  const evs = avance(R, 0.5);
  const g = gestes(evs, 'aura');
  ok(g.length > 0, 'elle rayonne');
  ok(a.pv > 100, `le maitre est soigne (${a.pv})`);
  ok(b.pv > 100, `et son voisin AUSSI (${b.pv}) — la seule chose du jeu qui aide quelqu un d autre`);
  eq(g[0].soignes.length, 2, 'les deux figurent au bilan');
}
console.log('\n-- mais pas ceux qui sont loin --');
{
  const R = new Realm({});
  R.rejoint('0xaaa', fiche('legendaire', 100, 'Alice'));
  R.rejoint('0xbbb', fiche(null, 1, 'Bob'));
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  const a = R.joueurs.get('0xaaa'), b = R.joueurs.get('0xbbb');
  b.x = a.x + RAYON + 100; b.y = a.y;
  a.pv = 100; b.pv = 100;
  for (let i = 0; i < MINI; i++) poseMonstre(R, a, 40 + i * 10, 0);
  avance(R, 0.5);
  ok(a.pv > 100, 'le maitre est soigne');
  eq(b.pv, 100, 'le joueur hors du rayon ne recoit rien');
}

/* ================== 4. RETOMBER SUR L'AUTRE ================== */
console.log('\n-- un geste dans le vide fait retomber sur le premier --');
{
  /* Trois creatures autour, mais PERSONNE de blesse : l'aura ne soignerait
     personne. Le compagnon doit retomber sur son soin — qui ne fera rien non
     plus — et surtout ne pas consommer sa recharge pour un geste vide. */
  const { R, j } = scene('legendaire', 100);
  for (let i = 0; i < MINI; i++) poseMonstre(R, j, 40 + i * 10, 0);
  j.pv = j.pvMax;
  const evs = avance(R, 1.0);
  eq(gestes(evs).length, 0, 'aucun geste : il n y avait rien a soigner');
  ok(j.famR <= 0.4, `et sa recharge n a pas ete consommee (${j.famR.toFixed(2)}s)`);
}
console.log('\n-- et il choisit celui qui SERT --');
{
  /* Le maitre est blesse et il y a du monde : l'aura passe devant, et elle
     sert. Sans le repli, un compagnon qui prefere la zone perdrait son tour
     des que la zone ne s'applique pas. */
  const { R, j } = scene('legendaire', 100);
  for (let i = 0; i < MINI; i++) poseMonstre(R, j, 40 + i * 10, 0);
  j.pv = 100;
  const evs = avance(R, 0.5);
  eq(gestes(evs).length, 1, 'un seul geste');
  eq(gestes(evs)[0].quoi, 'aura', 'et c est celui qui sert');
}

/* ================== 5. LE RAYON EST LE MEME POUR LES SIX ================== */
console.log('\n-- une seule distance a apprendre --');
{
  const zones = ['meute', 'brasier', 'gresil', 'secousse', 'abysse', 'aura'];
  const rayons = zones.map((c) => monde.familierEffet(c, 50).rayon);
  eq(new Set(rayons).size, 1, `les six portent le meme rayon (${rayons[0]})`);
  eq(rayons[0], RAYON, 'et c est celui du monde, pas une copie');
  ok(RAYON < monde.FAMILIERS.portee,
     `il est plus court que la portee a cible unique (${RAYON} < ${monde.FAMILIERS.portee})`);
}

console.log(`\nfamilier_zone.test.js : ${n} verifications OK`);
