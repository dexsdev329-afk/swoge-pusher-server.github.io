'use strict';
/*
 * VENDRE UN OEUF, VENDRE UN FAMILIER.
 *
 * Le marche des pieces existait deja : meme liste, meme sequestre, meme
 * chemin pour l'argent, memes cinq pour cent pour la maison. Ce fichier
 * verifie que les animaux y entrent sans casser la seule propriete qui
 * compte vraiment sur un marche.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. RIEN NE SE FABRIQUE, RIEN NE DISPARAIT. Une vente deplace un animal ;
 *    elle n'en cree pas un second et n'en perd pas. C'est la premiere chose
 *    qu'on verifie et la seule qui soit vraiment chere a rater : l'oeuf tombe
 *    une fois sur mille deux cents.
 * 2. LE SEQUESTRE. La chose quitte le vendeur AU MOMENT de l'annonce. Sinon
 *    on met son familier en vente, on le nourrit, et l'acheteur paie pour un
 *    animal qui a change.
 * 3. L'ANNULATION REND TOUT. Une annonce retiree qui ne rendrait rien serait
 *    une confiscation.
 * 4. LE FAMILIER PART AVEC SON XP. Vendre une copie serait fabriquer un
 *    familier ; c'est CELUI qu'on a nourri qui change de main.
 * 5. ON N'ACHETE PAS UN FAMILIER QU'ON A DEJA. Un compte ne tient qu'un
 *    exemplaire par espece : l'achat ecraserait le premier, donc detruirait
 *    une progression payee ailleurs.
 * 6. LA MAISON PREND CINQ POUR CENT, et jamais plus que ce qui a ete verse.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/marchan-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Game } = require('./game');
const monde = require('./monde');
const cfg = require('./config');
const ethers = require('./node_modules/ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const g = new Game();
const A = '0x' + 'a'.repeat(40);   // le vendeur
const B = '0x' + 'b'.repeat(40);   // l acheteur

/* Deux comptes qui ont depose : le marche l'exige, et c'est une regle du
   marche existant qu'on ne contourne pas parce qu'on ajoute un bien. */
const pa = g._p(A), pb = g._p(B);
pa.hasDeposited = true; pb.hasDeposited = true;
pa.name = 'Alice'; pb.name = 'Bob';
pb.balance = ethers.utils.parseUnits('1000000', cfg.DECIMALS);

/* Un oeuf au coffre et un familier nourri, par les chemins du jeu. */
pa.sacOeufs = { tenebre: 1, feu: 1 };
g.ouvreOeuf(A, 'tenebre');                       // -> familier tenebre
pa.familiers.tenebre.xp = 3 * 40 * 41;           // niveau 41
g.rangeOeuf(A, 'feu');                           // -> oeuf de feu au coffre

console.log('\n-- l oeuf part en vitrine --');
{
  const avant = g.oeufsDuCoffre(A).length;
  eq(avant, 1, 'il est au coffre avant la vente');
  const ann = g.marcheVendOeuf(A, 'feu', '5000');
  ok(ann && ann.id > 0, `l annonce existe (#${ann.id})`);
  eq(ann.oeuf, 'feu', 'et elle porte l espece');
  eq(ann.prix, 5000, 'au prix qu on a fixe — il est LIBRE, pas impose');
  /* LE SEQUESTRE. Sans lui, on vend un oeuf et on le range ailleurs. */
  eq(g.oeufsDuCoffre(A).length, 0, 'et il a QUITTE le coffre du vendeur');

  /* On ne vend pas ce qu'on n a plus. */
  let err = null;
  try { g.marcheVendOeuf(A, 'feu', '5000'); } catch (e) { err = e.message; }
  ok(/not in your vault/.test(err || ''), `le vendre deux fois est refuse (${err})`);

  /* ET L ANNULATION REND. */
  g.marcheAnnule(A, ann.id);
  eq(g.oeufsDuCoffre(A).length, 1, 'annuler le rend au coffre');
  eq((g.marche || []).length, 0, 'et retire l annonce');
}

console.log('\n-- le prix est libre, mais borne --');
{
  let err = null;
  try { g.marcheVendOeuf(A, 'feu', '1'); } catch (e) { err = e.message; }
  ok(/minimum price/.test(err || ''), `un prix sous le plancher est refuse (${err})`);
  err = null;
  try { g.marcheVendOeuf(A, 'feu', String(cfg.MARCHE_PRIX_MAX + 1)); } catch (e) { err = e.message; }
  ok(/maximum price/.test(err || ''), `et au-dessus du plafond aussi (${err})`);
  eq(g.oeufsDuCoffre(A).length, 1, 'aucun refus n a mange l oeuf');
}

console.log('\n-- on l achete --');
{
  const ann = g.marcheVendOeuf(A, 'feu', '10000');
  const soldeB = Number(g.balanceStr(B));
  const soldeA = Number(g.balanceStr(A));
  /* ON N ACHETE PAS SA PROPRE ANNONCE : c est ainsi qu on fabrique un faux
     prix de reference, en se vendant a soi-meme devant tout le monde. */
  let err = null;
  try { g.marcheAchete(A, ann.id); } catch (e) { err = e.message; }
  ok(/your own listing/.test(err || ''), `acheter sa propre annonce est refuse (${err})`);

  g.marcheAchete(B, ann.id);
  eq(g.oeufsDuCoffre(B).length, 1, 'l oeuf arrive au coffre de l acheteur');
  eq(g.oeufsDuCoffre(B)[0].espece, 'feu', 'de la bonne espece');
  eq(g.oeufsDuCoffre(A).length, 0, 'et le vendeur ne l a plus');

  /* ---- CINQ POUR CENT, ET JAMAIS PLUS QUE CE QUI A ETE VERSE ---- */
  const paye = soldeB - Number(g.balanceStr(B));
  const recu = Number(g.balanceStr(A)) - soldeA;
  eq(Math.round(paye), 10000, 'l acheteur paie le prix affiche');
  eq(Math.round(recu), 9500, 'le vendeur touche 95 % — la maison prend cinq');
  ok(recu < paye, 'et la maison ne reverse jamais plus qu elle n a encaisse');
  eq(cfg.MARCHE_FRAIS_BPS, 500, 'les cinq pour cent sont ceux du marche existant');
}

console.log('\n-- et le familier, avec sa progression --');
{
  const f = g.familiersDe(A)[0];
  eq(f.espece, 'tenebre', 'le vendeur a son familier');
  const niveau = f.niveau, xp = f.xp;
  ok(niveau > 20, `nourri jusqu au niveau ${niveau}`);

  /* On le SORT avant de le vendre : sans ca, « il rentre de l enclos » est
     vrai sans rien prouver — il n y etait pas. */
  g.sortFamilier(A, 'tenebre');
  eq(g.familierActifDe(A), 'tenebre', 'il est dehors avant la vente');
  const ann = g.marcheVendFamilier(A, 'tenebre', '50000');
  eq(g.familiersDe(A).length, 0, 'il QUITTE le compte du vendeur');
  ok(!g._p(A).familierActif, 'et il rentre de l enclos s il etait dehors');
  ok(ann.fam && ann.fam.niveau === niveau,
     `l annonce montre son niveau (${ann.fam && ann.fam.niveau})`);

  /* L annulation rend le MEME animal, pas un neuf. */
  g.marcheAnnule(A, ann.id);
  eq(g.familiersDe(A)[0].xp, xp, 'annuler rend le familier avec son XP intacte');

  const ann2 = g.marcheVendFamilier(A, 'tenebre', '50000');
  const soldeA = Number(g.balanceStr(A));
  g.marcheAchete(B, ann2.id);
  const chezB = g.familiersDe(B).filter((x) => x.espece === 'tenebre')[0];
  ok(!!chezB, 'l acheteur recoit le familier');
  eq(chezB.xp, xp, 'AVEC son XP — c est celui qu on a nourri, pas un neuf');
  eq(chezB.niveau, niveau, `donc au meme niveau (${chezB.niveau})`);
  eq(g.familiersDe(A).length, 0, 'et le vendeur ne l a plus : rien ne s est duplique');
  eq(Math.round(Number(g.balanceStr(A)) - soldeA), 47500, 'le vendeur touche 95 % de 50 000');
}

console.log('\n-- on n en tient qu un par espece --');
{
  /* B a maintenant le tenebre. A lui en revend un autre : impossible, il n en
     a plus. On fabrique donc le cas par le chemin du jeu — A ouvre un oeuf. */
  const pa2 = g._p(A);
  pa2.sacOeufs = { tenebre: 1 };
  g.ouvreOeuf(A, 'tenebre');
  const ann = g.marcheVendFamilier(A, 'tenebre', '20000');
  let err = null;
  try { g.marcheAchete(B, ann.id); } catch (e) { err = e.message; }
  ok(/already have that pet/.test(err || ''),
     `acheter un familier qu on a deja est refuse (${err})`);
  /* ET LE REFUS N A RIEN PRIS. Il arrive avant que l argent ne bouge. */
  eq((g.marche || []).filter((x) => x.id === ann.id).length, 1,
     'l annonce est toujours la — le refus n a rien consomme');
  const avantB = g.familiersDe(B).filter((x) => x.espece === 'tenebre')[0];
  ok(avantB && avantB.xp > 0, 'et le familier de l acheteur est intact');
}

console.log('\n-- la vitrine les montre --');
{
  const v = g.marcheListe(B);
  const animaux = v.annonces.filter((a) => a.oeuf || a.fam);
  ok(animaux.length > 0, `la vitrine porte ${animaux.length} annonce(s) d animal`);
  /* Ils passent DEVANT : c est ce qu on vient chercher, et les noyer entre
     deux epees communes reviendrait a ne pas les vendre. */
  ok(v.annonces[0].oeuf || v.annonces[0].fam, 'et ils sont en tete de liste');
  const a0 = animaux[0];
  ok(a0.item && a0.item.nom, `chaque ligne a un nom (${a0.item.nom})`);
  ok(a0.item.couleur, 'et une couleur — sans elles la ligne serait vide');
  /* `jaiDeja` repond a « je ne PEUX pas l acheter » pour un familier. */
  const dejaVu = animaux.filter((a) => a.fam && a.jaiDeja);
  ok(dejaVu.length > 0,
     'et la vitrine dit a l acheteur qu il a deja cette espece');
  eq(v.frais, 5, 'elle annonce les cinq pour cent');
}

console.log('\n-- rien ne se fabrique --');
{
  /* Le compte de tous les familiers de tous les comptes, plus ceux en
     vitrine, doit etre constant. C est la seule mesure qui attrape une
     duplication ou qu elle se cache. */
  let vivants = 0;
  for (const [, p] of g.players) vivants += Object.keys(p.familiers || {}).length;
  const enVente = (g.marche || []).filter((a) => a.fam).length;
  eq(vivants + enVente, 2,
     `deux familiers au monde : ${vivants} chez les joueurs, ${enVente} en vitrine`);
  let oeufs = 0;
  for (const [, p] of g.players) {
    for (const k of Object.keys(p.coffreOeufs || {})) oeufs += p.coffreOeufs[k] | 0;
    for (const k of Object.keys(p.sacOeufs || {})) oeufs += p.sacOeufs[k] | 0;
  }
  eq(oeufs + (g.marche || []).filter((a) => a.oeuf).length, 1,
     'et un seul oeuf, celui qui a change de main');
}

console.log(`\nmarche_animaux.test.js : ${n} verifications OK`);
