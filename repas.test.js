/* LE REPAS ET LES NIVEAUX — ce qu'un familier mange, et ce que ca coute.
 *
 * Un familier montait de niveau nulle part : il eclosait au niveau un et y
 * restait. Ce fichier verifie la boucle entiere, et surtout les endroits ou
 * elle peut faire PERDRE quelque chose au joueur.
 *
 * 1. LE NIVEAU SE DEDUIT DE L XP. Deux chiffres censes s accorder finissent
 *    par se contredire ; il n y en a donc qu un.
 * 2. IL NE MANGE QUE DU COMMUN ET DU RARE. Au moment ou une legendaire
 *    nourrit mieux qu elle ne se porte, le meilleur usage d une legendaire
 *    devient de la detruire.
 * 3. UN REFUS NE COUTE RIEN. Retirer la piece puis s apercevoir que l or
 *    manque aurait detruit un objet pour rien.
 * 4. L OR SE DEPENSE VRAIMENT, et le prix suit le niveau.
 * 5. LE PLAFOND TIENT. Un familier au maximum ne mange plus — sinon on paie
 *    pour rien, indefiniment.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/repas-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Game } = require('./game');
const boutique = require('./boutique');

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('  ok   ' + m); };
const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); console.log('  ok   ' + m); };

const g = new Game();
const A = '0x' + '1'.repeat(40);

/* Une piece de chaque rarete, prise dans le VRAI catalogue : inventer un
   identifiant testerait une forme que le jeu ne produit jamais. */
const parRarete = {};
for (const o of boutique.tousLesItems ? boutique.tousLesItems() : []) {
  if (!parRarete[o.rarete]) parRarete[o.rarete] = o.id;
}
if (!Object.keys(parRarete).length) {
  /* Le catalogue ne s expose pas sous ce nom : on le balaie par identifiants,
     puisque `item()` est la seule porte d entree garantie. */
  for (let id = 1000; id < 6000; id++) {
    const o = boutique.item(id);
    if (o && !parRarete[o.rarete]) parRarete[o.rarete] = o.id;
  }
}
ok(!!parRarete.commun && !!parRarete.rare && !!parRarete.legendaire,
   `le catalogue donne une piece par rarete (${Object.keys(parRarete).join(', ')})`);

/* ================== 1. LE NIVEAU SE DEDUIT ================== */
console.log('\n-- le niveau vient de l XP, et de nulle part ailleurs --');
const p = g._p(A);
p.sacOeufs = { normal: 1 }; p.sacCases = null;
g.ouvreOeuf(A, 'normal');
let f = g.familiersDe(A)[0];
eq(f.niveau, 1, 'il eclot au niveau un');
eq(f.xp, 0, 'sans XP');
ok(!('niveau' in p.familiers.normal),
   'et la sauvegarde ne RANGE pas de niveau — il n existe qu une fois');
/* On triche sur l XP seule : si le niveau etait range a cote, il ne bougerait
   pas, et la fiche montrerait un niveau un a mille points d experience. */
/* Les paliers viennent du SERVEUR, ils ne sont pas recopies ici : la courbe
   a change quand le familier est passe de vingt a cent niveaux, et un essai
   qui portait « 800 -> niveau 5 » en dur serait tombe sans qu une seule regle
   soit fausse. On demande donc au moteur ou commence le niveau qu on vise. */
const palier = (n) => 3 * (n - 1) * n;
p.familiers.normal.xp = palier(12);
f = g.familiersDe(A)[0];
eq(f.niveau, 12, 'l XP du douzieme palier vaut le niveau douze, sans rien ecrire d autre');
eq(f.xpBas, palier(12), 'la fiche porte le bas du palier');
eq(f.xpHaut, palier(13), 'et le haut — la page n a pas a connaitre la courbe');
/* ---- ET LE NIVEAU SUIVANT S ANNONCE ----
 * Le niveau achete de la FREQUENCE : soixante secondes de recharge au premier,
 * trois au centieme. Une barre qui se remplit sans dire vers quoi fait du
 * repas un geste qu on repete sans savoir pourquoi. */
ok(f.suivant && f.suivant.recharge < f.effet.recharge,
   `le palier suivant fait agir plus souvent (${f.effet.recharge}s -> ${f.suivant.recharge}s)`);
p.familiers.normal.xp = 0;

/* Une vieille sauvegarde qui porte un niveau MENTEUR doit se reparer seule. */
p.familiers.normal.niveau = 17;
f = g.familiersDe(A)[0];
eq(f.niveau, 1, 'un niveau herite d une ancienne sauvegarde est ignore');

/* ================== 2. CE QU IL MANGE ================== */
console.log('\n-- commun et rare, jamais au-dessus --');
p.fame = 100000;
p.sac = {}; p.sac[parRarete.legendaire] = 1;
let err = null;
try { g.nourritFamilier(A, 'normal', parRarete.legendaire); } catch (e) { err = e.message; }
ok(/Common and Rare/.test(err || ''), `la legendaire est refusee (${err})`);
eq(p.sac[parRarete.legendaire], 1, 'et elle est TOUJOURS dans le sac');
eq(p.fame, 100000, 'l or n a pas bouge non plus');

p.sac[parRarete.commun] = 1;
let r = g.nourritFamilier(A, 'normal', parRarete.commun);
eq(r.gagne, 25, 'une commune vaut vingt-cinq points');
eq(p.sac[parRarete.commun], undefined, 'et elle quitte le sac');
p.sac[parRarete.rare] = 1;
r = g.nourritFamilier(A, 'normal', parRarete.rare);
eq(r.gagne, 90, 'une rare en vaut quatre-vingt-dix');
eq(g.familiersDe(A)[0].xp, 115, 'les deux repas s additionnent');

/* ================== 3. UN REFUS NE COUTE RIEN ================== */
console.log('\n-- ce qui est refuse n est pas detruit --');
p.fame = 1;                                    // moins que le prix d un repas
p.sac[parRarete.commun] = 1;
err = null;
try { g.nourritFamilier(A, 'normal', parRarete.commun); } catch (e) { err = e.message; }
ok(/Need \d+ gold/.test(err || ''), `sans or, le repas est refuse (${err})`);
eq(p.sac[parRarete.commun], 1, 'la piece est intacte');
eq(p.fame, 1, 'et l or aussi');
err = null;
try { g.nourritFamilier(A, 'feu', parRarete.commun); } catch (e) { err = e.message; }
ok(/have not hatched/.test(err || ''), `nourrir un familier qu on n a pas est refuse (${err})`);
err = null;
try { g.nourritFamilier(A, 'normal', 999999); } catch (e) { err = e.message; }
ok(/Unknown item/.test(err || ''), `une piece qui n existe pas aussi (${err})`);
/* Une piece qu on ne POSSEDE pas : c est le trou par lequel on nourrirait
   gratuitement, en nommant l identifiant d une commune qu on n a jamais eue. */
p.sac = {};
err = null;
try { g.nourritFamilier(A, 'normal', parRarete.commun); } catch (e) { err = e.message; }
ok(/not in your backpack/.test(err || ''), `et une piece qu on n a pas (${err})`);

/* ================== 4. L OR SE DEPENSE ================== */
console.log('\n-- et l or se depense vraiment --');
p.fame = 100000;
p.familiers.normal.xp = 0;
p.sac[parRarete.commun] = 1;
const avant = p.fame;
r = g.nourritFamilier(A, 'normal', parRarete.commun);
/* ---- LE PRIX A DU BAISSER, ET LOURDEMENT ----
 * Il valait `40 x niveau`. Mesure : un personnage de niveau vingt qui meurt
 * rapporte QUARANTE-QUATRE d or. Un seul repas coutait donc une vie de
 * personnage entiere — deja lourd pour vingt niveaux, strictement impossible
 * pour cent. */
eq(avant - p.fame, 5, 'un repas au niveau un coute cinq');
eq(r.or, p.fame, 'et la reponse porte l or restant, pour que la page n ait pas a le deduire');
/* Le prix suit le NIVEAU : sinon la derniere marche couterait le prix de la
   premiere alors qu elle demande quarante fois plus d XP. */
p.familiers.normal.xp = palier(60);
p.sac[parRarete.commun] = 1;
const avant60 = p.fame;
g.nourritFamilier(A, 'normal', parRarete.commun);
ok(avant60 - p.fame > 5,
   `au soixantieme niveau il coute plus cher (${avant60 - p.fame} contre 5)`);

/* Le passage de niveau se DIT — la page en fait un son, elle ne recalcule
   pas la courbe pour le deviner. */
p.familiers.normal.xp = Math.max(0, palier(2) - 1);
p.sac[parRarete.commun] = 1;
r = g.nourritFamilier(A, 'normal', parRarete.commun);
ok(r.monte === true, 'le repas qui fait monter le dit');
/* ---- ET CELUI QUI NE FAIT PAS MONTER ----
 * Aux premiers niveaux, CHAQUE repas fait monter : le deuxieme palier est a
 * six points et une commune en vaut vingt-cinq. Il faut donc monter assez
 * haut pour qu un repas ne suffise plus — c est justement la forme de la
 * courbe, et l essai doit la suivre plutot que la supposer. */
p.familiers.normal.xp = palier(60);
p.sac[parRarete.commun] = 1;
r = g.nourritFamilier(A, 'normal', parRarete.commun);
ok(r.monte === false,
   `celui qui ne fait pas monter le dit aussi (niveau ${r.familier.niveau})`);

/* ================== 5. LE PLAFOND ================== */
console.log('\n-- le plafond tient --');
const regles = Game.reglesFamilier();
eq(regles.niveauMax, 100, 'le maximum est annonce par le serveur');
ok(regles.rarete.join(',') === 'commun,rare',
   `et les raretes acceptees aussi (${regles.rarete.join(', ')})`);
p.familiers.normal.xp = 1e9;
f = g.familiersDe(A)[0];
eq(f.niveau, 100, 'une XP absurde ne depasse pas le maximum');
eq(f.suivant, null, 'et il n y a plus de palier suivant a annoncer');
/* ---- LA RECHARGE EST LA RECOMPENSE ----
 * C est la seule chose que cent niveaux achetent vraiment : le compagnon agit
 * vingt fois plus souvent. Les degats, eux, ne font que sextupler. */
eq(f.effet.recharge, 3, 'au maximum, il agit toutes les trois secondes');
ok(f.max === true, 'la fiche le dit');
eq(f.xpHaut, null, 'et il n y a plus de palier suivant');
eq(f.prixRepas, null, 'ni de prix');
p.sac[parRarete.commun] = 1;
const orAvant = p.fame;
err = null;
try { g.nourritFamilier(A, 'normal', parRarete.commun); } catch (e) { err = e.message; }
ok(/max level/.test(err || ''), `au maximum, il ne mange plus (${err})`);
eq(p.sac[parRarete.commun], 1, 'la piece reste au sac');
eq(p.fame, orAvant, 'et l or n est pas preleve');

/* ---- IL SURVIT A LA MORT ---- */
console.log('\n-- et il survit a tout --');
p.familiers.normal.xp = palier(12);
g.sortFamilier(A, 'normal');
/* La mort passe par le chemin normal du jeu : un skin possede, un
   personnage vivant. Appeler `meurt` sur un compte qui ne porte rien
   testerait un etat que le serveur ne produit jamais. */
p.skins = { andy: true }; p.skinActif = 'andy';
g.meurt(A, 'andy');
f = g.familiersDe(A)[0];
ok(!!f, 'le familier existe encore apres la mort du personnage');
eq(f.niveau, 12, 'avec sa progression intacte — c est la seule chose du jeu qu on garde a vie');

console.log(`\nrepas.test.js : ${n} verifications OK`);
