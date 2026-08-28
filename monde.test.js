'use strict';
/*
 * LE MONDE DE COMBAT — la carte, les monstres, les degats.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LA CARTE EST EN ANNEAUX, ET LE CENTRE EST LE PLUS DUR. Un joueur doit
 *    pouvoir lire sa position au sol : lave = coeur, terre = bord.
 * 2. LES DEGATS SUIVENT LA FORMULE DE ROTMG, PLANCHER COMPRIS. Une defense
 *    enorme ralentit, elle ne rend jamais invulnerable — dans un jeu ou la
 *    mort est definitive, la difference est tout.
 * 3. LES MONSTRES SONT TUABLES AU NIVEAU 1 ET TRIVIAUX AU NIVEAU 20. C'est
 *    la seule facon de SENTIR les niveaux.
 * 4. ON N'APPARAIT QUE DANS SON PROPRE ANNEAU, ET JAMAIS DEUX FOIS AU MEME
 *    ENDROIT PAR PARESSE DE TIRAGE.
 * 5. LE MODULE EST PUR : deux appels identiques donnent le meme resultat.
 */
const assert = require('assert');
const M = require('./monde');
const P = require('./personnages');
const B = require('./boutique');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* Un tirage REPRODUCTIBLE : les fonctions du module prennent leur hasard en
   parametre, ce qui rend tout ce fichier deterministe. */
function alea(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ================== 1. LES ANNEAUX
{
  eq(M.biomeEn(M.CENTRE.x, M.CENTRE.y), 'lave', 'le coeur du monde est de la lave');
  eq(M.biomeEn(4, 4), 'terre', 'le coin de la carte est de la terre');

  /* On balaie une ligne du centre vers le bord : le biome doit changer dans
     CET ordre et jamais revenir en arriere. Un anneau qui reapparaitrait
     plus loin voudrait dire que la carte ment sur la difficulte. */
  const vus = [];
  for (let d = 0; d < M.MONDE.w / 2; d += 16) {
    const b = M.biomeEn(M.CENTRE.x + d, M.CENTRE.y);
    if (vus[vus.length - 1] !== b) vus.push(b);
  }
  /* L'ordre vient de la TABLE, pas d'une liste recopiee ici : ajouter un
     anneau ne doit pas demander de venir corriger ce test, seulement de le
     voir passer. Ce qu'on verifie, c'est qu'on traverse les anneaux dans
     l'ordre declare et qu'aucun ne revient plus loin — une carte qui
     repasserait par la neige apres la terre mentirait sur la difficulte. */
  const ordre = M.ANNEAUX.map((a) => a.biome);
  assert.deepStrictEqual(vus, ordre,
    'du centre au bord, on traverse les anneaux dans l ordre : ' + ordre.join(', '));
  eq(new Set(vus).size, vus.length, 'et aucun anneau ne reapparait plus loin');
  n++;

  // le biome ne depend que de la DISTANCE : quatre directions, meme reponse
  const d = M.MONDE.w * 0.2;
  const quatre = [
    M.biomeEn(M.CENTRE.x + d, M.CENTRE.y), M.biomeEn(M.CENTRE.x - d, M.CENTRE.y),
    M.biomeEn(M.CENTRE.x, M.CENTRE.y + d), M.biomeEn(M.CENTRE.x, M.CENTRE.y - d),
  ];
  ok(quatre.every((b) => b === quatre[0]), 'la carte est symetrique : meme distance, meme biome');
}

// ================== 2. LA FORMULE DE DEGATS
{
  /* Le multiplicateur est (0.5 + ATT/50) : a ATT 0 on frappe a moitie, a
     ATT 25 a plein, et a ATT 75 — le plafond de RotMG — au double. */
  eq(M.degatsInfliges(0, 100, 0), 50, 'ATT 0 : la moitie des degats de l arme');
  eq(M.degatsInfliges(25, 100, 0), 100, 'ATT 25 : les degats de l arme, exactement');
  eq(M.degatsInfliges(50, 100, 0), 150, 'ATT 50 : une fois et demie');
  eq(M.degatsInfliges(75, 100, 0), 200, 'ATT 75, le plafond : le double');

  // la defense se SOUSTRAIT du coup deja multiplie
  eq(M.degatsInfliges(25, 100, 30), 70, 'la defense se retire du coup');

  /* LE PLANCHER. Une defense superieure au coup ne protege pas
     completement : il reste 15 %. Sans ce plancher, un monstre bien defendu
     serait strictement invulnerable a une arme faible — le joueur taperait
     dessus sans fin, sans jamais comprendre pourquoi rien ne bouge. */
  eq(M.degatsInfliges(25, 100, 500), 15, 'defense enorme : il reste 15 % du coup');
  eq(M.degatsInfliges(25, 100, 95), 15, 'sous le plancher, c est le plancher qui gagne');
  ok(M.degatsInfliges(25, 100, 80) > 15, 'juste au-dessus du plancher, le calcul normal reprend');

  // jamais de degats negatifs, quoi qu'on passe
  ok(M.degatsInfliges(-5, -5, 999) >= 0, 'aucune entree ne produit de degats negatifs');
  eq(M.degatsInfliges(25, 0, 0), 0, 'une arme sans degats n en fait aucun');

  // ce que le joueur SUBIT suit la meme regle
  eq(M.degatsSubis(100, 40), 60, 'la defense du joueur retire autant');
  eq(M.degatsSubis(100, 999), 15, 'meme sur-defendu, le joueur prend 15 %');
}

// ================== 3. LES MONSTRES SONT TUABLES, PUIS TRIVIAUX
{
  const base = P.BASE.andy;
  const stat = (k, niv) => P.statAuNiveau(base[k], niv);
  const arme = (r) => P.DEGATS_ARME[r];

  // coups moyens qu'il faut pour abattre chaque monstre, au debut et a la fin
  const coups = (niveau, rarete, m) => {
    const att = stat('att', niveau);
    const moy = (arme(rarete)[0] + arme(rarete)[1]) / 2;
    const d = M.degatsInfliges(att, moy, m.def);
    return Math.ceil(m.pv / d);
  };

  const l1Lime = coups(1, 'commun', M.MONSTRES.lime);
  const l1Squelette = coups(1, 'commun', M.MONSTRES.skeleton);
  const l20Lime = coups(20, 'mythique', M.MONSTRES.lime);
  const l20Squelette = coups(20, 'mythique', M.MONSTRES.skeleton);

  ok(l1Lime <= 3, 'niveau 1, arme commune : le lime tombe en 3 coups au plus (a ' + l1Lime + ')');
  ok(l1Squelette >= 5 && l1Squelette <= 16,
    'niveau 1 : le squelette est dur mais faisable (a ' + l1Squelette + ' coups)');
  ok(l20Lime === 1, 'niveau 20 : le lime tombe d un seul coup');
  ok(l20Squelette <= 2, 'niveau 20 : le squelette tombe en 2 coups au plus (a ' + l20Squelette + ')');
  ok(l1Squelette > l20Squelette * 3,
    'le meme monstre est au moins trois fois plus long a tuer au niveau 1 : les niveaux se SENTENT');

  // combien de coups le joueur encaisse — le danger doit exister sans etre absurde
  const encaisse = (niveau, m) => Math.ceil(stat('hp', niveau) / M.degatsSubis(m.att, stat('def', niveau)));
  ok(encaisse(1, M.MONSTRES.lime) >= 15,
    'un lime seul ne tue pas un debutant en quelques secondes');
  ok(encaisse(1, M.MONSTRES.skeleton) <= 12,
    'un squelette est une vraie menace au niveau 1 (a ' + encaisse(1, M.MONSTRES.skeleton) + ' coups)');
  ok(encaisse(20, M.MONSTRES.skeleton) > encaisse(1, M.MONSTRES.skeleton),
    'monter en niveau rend plus resistant, pas seulement plus fort');
}

// ================== 4. LE PEUPLEMENT
{
  const liste = M.peuplement(alea(7));
  const attendu = Object.keys(M.PEUPLEMENT).reduce((s, b) => s + M.PEUPLEMENT[b].nombre, 0);
  eq(liste.length, attendu, 'on fait naitre exactement le nombre annonce');

  // CHAQUE monstre est dans SON anneau — sinon un squelette pourrait
  // apparaitre sur la plage de depart et tuer un joueur niveau 1 a l arrivee
  const egares = liste.filter((m) => M.biomeEn(m.x, m.y) !== m.biome);
  eq(egares.length, 0, 'aucun monstre ne nait hors de son anneau');

  // et chaque espece n apparait que dans les biomes qui la listent
  const interdits = liste.filter((m) => M.MONSTRES[m.espece].biomes.indexOf(m.biome) < 0);
  eq(interdits.length, 0, 'aucune espece ne nait dans un biome qui ne la prevoit pas');

  // tous dans la carte, avec une marge
  const dehors = liste.filter((m) => m.x < 0 || m.y < 0 || m.x > M.MONDE.w || m.y > M.MONDE.h);
  eq(dehors.length, 0, 'aucun monstre ne nait hors de la carte');

  /* ILS SONT REELLEMENT EPARPILLES. Un tirage bugge qui renverrait toujours
     le meme point passerait tous les tests ci-dessus sans en avoir l air. */
  const distincts = new Set(liste.map((m) => Math.round(m.x) + ':' + Math.round(m.y)));
  eq(distincts.size, liste.length, 'deux monstres ne naissent jamais au meme point');
  const etendueX = Math.max(...liste.map((m) => m.x)) - Math.min(...liste.map((m) => m.x));
  ok(etendueX > M.MONDE.w * 0.5, 'ils occupent vraiment la largeur de la carte');
}

// ================== 5. LA PURETE
{
  const a = M.peuplement(alea(42));
  const b = M.peuplement(alea(42));
  assert.deepStrictEqual(a, b, 'meme graine, meme monde : le module ne garde rien');
  n++;

  const c = M.peuplement(alea(43));
  ok(JSON.stringify(a) !== JSON.stringify(c), 'une autre graine donne un autre monde');

  // le tirage d arme reste dans ses bornes
  const r = alea(3);
  for (let i = 0; i < 200; i++) {
    const v = M.tirageArme([90, 120], r);
    ok(v >= 90 && v <= 120, 'le tirage d arme reste entre son min et son max');
  }
  eq(M.tirageArme(null, r), 0, 'une arme sans table de degats ne fait rien');
}

// ================== LA REGENERATION
//
// Le coefficient est celui de RotMG : (stat + 1) x 0.12 par seconde, double
// au repos. Ce qui se verifie ici, ce sont les PROPRIETES qui doivent tenir
// meme si le coefficient bouge un jour.
{
  /* Le « + 1 » compte : sans lui, un personnage a 0 de vitalite ne se
     soignerait JAMAIS, ce qui n'est pas la meme chose que « tres lentement ». */
  ok(M.regenParSeconde(0, false) > 0, 'a 0 de vitalite, on se soigne quand meme');

  /* Elle CROIT avec la stat, sur toute la plage utile. Une regeneration qui
     plafonnerait ferait de la vitalite une stat morte apres un certain point. */
  let prec = -1;
  for (let v = 0; v <= 80; v += 5) {
    const r = M.regenParSeconde(v, false);
    ok(r > prec, `la vitalite ${v} regenere plus que ${v - 5}`);
    prec = r;
  }

  /* Le repos DOUBLE, exactement. */
  for (const v of [0, 10, 40, 75]) {
    ok(Math.abs(M.regenParSeconde(v, true) - M.regenParSeconde(v, false) * M.REGEN_REPOS) < 1e-9,
       `le repos double le debit a ${v} de vitalite`);
  }

  /* ---- L'ORDRE DE GRANDEUR ----
   * C'est la seule chose qui decide si le systeme est jouable. Trop rapide,
   * les monstres deviennent inoffensifs ; trop lent, la stat ne se voit pas.
   * On borne donc le temps qu'il faut pour remplir une barre VIDE, au repos,
   * avec les valeurs reelles du jeu — jamais moins de vingt secondes, jamais
   * plus de cinq minutes. */
  const hpMax = Math.max(...Object.keys(P.BASE).map((k) => P.BASE[k].hp));
  const vitMax = Math.max(...Object.keys(P.BASE).map((k) => P.BASE[k].vit));
  const secondes = hpMax / M.regenParSeconde(vitMax, true);
  ok(secondes > 20, `remplir ${hpMax} PV au repos prend plus de 20 s (${Math.round(secondes)} s)`);
  ok(secondes < 300, `et moins de cinq minutes (${Math.round(secondes)} s)`);

  /* ---- ET SURTOUT : LE MONSTRE LE PLUS FAIBLE RESTE DANGEREUX ----
   *
   * C'est LA verification qui a fait descendre le coefficient de 0.12 (celui
   * de RotMG) a 0.05. Si la regeneration au combat depasse ce qu'un lime
   * enleve, tout l'anneau exterieur devient decoratif : on traverse la terre
   * sans jamais perdre un point.
   *
   * On la fait PERSONNAGE PAR PERSONNAGE, avec ses vraies statistiques au
   * niveau maximum. Une moyenne, ou pire un croisement de la meilleure
   * vitalite avec la meilleure defense (deux personnages differents), ne
   * dirait rien de ce qui se passe reellement en jeu. */
  const t = M.MONSTRES.lime;
  Object.keys(P.BASE).forEach((k) => {
    const b = P.BASE[k];
    const recu = M.degatsSubis(t.att, b.def) * t.cadence;
    const soin = M.regenParSeconde(b.vit, false);
    ok(recu > soin,
       `« ${k} » (def ${b.def}, vit ${b.vit}) perd encore de la vie face a un lime ` +
       `(${recu.toFixed(1)}/s contre ${soin.toFixed(1)}/s)`);
  });

  /* Le repos, lui, a le DROIT de depasser : c'est tout l'interet de
     decrocher. Ce qu'on verifie alors, c'est qu'il ne rende pas la fuite
     gratuite face a un vrai monstre — un squelette doit rester plus rapide
     que la barre qui remonte, meme au calme. */
  const sq = M.MONSTRES.skeleton;
  Object.keys(P.BASE).forEach((k) => {
    const b = P.BASE[k];
    ok(M.degatsSubis(sq.att, b.def) * sq.cadence > M.regenParSeconde(b.vit, true),
       `« ${k} » ne peut pas encaisser un squelette en restant plante la`);
  });
}

// ================== LES POUVOIRS DU FRUIT
//
// Celui qu'on obtient se DEDUIT de la stat que le fruit favorise deja. La
// regle vaut mieux qu'une table ecrite a la main : un septieme fruit ajoute
// demain recoit automatiquement le bon pouvoir.
{
  /* ---- ON NE COMPTE PLUS, ON VERIFIE LA REGLE ----
   * « il y a trois pouvoirs » etait ecrit ici, et l'essai est tombe le jour
   * ou l'egide est arrivee — en accusant le monde alors que c'est LUI qui
   * portait l'ancien chiffre. Ce qu'il doit prouver n'est pas combien il y en
   * a : c'est que chacun est atteignable et que chaque fruit en a un. */
  ok(Object.keys(M.POUVOIRS).length >= 3,
     `${Object.keys(M.POUVOIRS).length} pouvoirs au catalogue`);

  /* CHAQUE FRUIT DU CATALOGUE EN A UN. C'est le lien entre les deux modules,
     et c'est exactement la ou une divergence passerait inapercue : un fruit
     dont la stat principale ne serait pas dans la table repartirait sans
     pouvoir, en silence, et le joueur ne saurait jamais pourquoi sa barre
     d'espace ne fait rien. */
  const fruits = Object.keys(P.PROFIL_FAMILLE)
    .filter((f) => (B.ITEMS.filter((x) => x.famille === f)[0] || {}).saison === 1);
  ok(fruits.length > 0, 'le catalogue a bien des fruits');
  fruits.forEach((f) => {
    const p = M.pouvoirDeStat(P.FAMILLE_STAT[f]);
    ok(p && M.POUVOIRS[p], `le fruit « ${f} » (${P.FAMILLE_STAT[f]}) donne le pouvoir « ${p} »`);
  });

  /* TOUS SONT ATTEIGNABLES. Un pouvoir qu'aucun fruit ne donne serait du
     code mort qui a l'air vivant. */
  const donnes = new Set(fruits.map((f) => M.pouvoirDeStat(P.FAMILLE_STAT[f])));
  /* Chaque pouvoir DECLARE doit etre donne par un fruit reel — on compare les
     deux ensembles plutot qu'un compte, ce qui nomme le fautif au lieu de dire
     seulement qu'il y en a un. */
  for (const cle of Object.keys(M.POUVOIRS)) {
    ok(donnes.has(cle), `« ${cle} » est donne par un fruit du catalogue`);
  }
  eq(donnes.size, Object.keys(M.POUVOIRS).length,
     'et aucun fruit ne donne un pouvoir qui n existe pas');

  /* Le pouvoir prolonge le fruit au lieu de le contredire. C'est la SEULE
     chose qu'on verifie en nommant les deux cotes — le lien entre une stat et
     ce qu'elle evoque est le sujet, pas une valeur a deduire. */
  eq(M.pouvoirDeStat('att'), 'foudre', 'la force frappe fort');
  eq(M.pouvoirDeStat('dex'), 'rafale', 'la vitesse tire vite');
  eq(M.pouvoirDeStat('wis'), 'stase', 'le savoir arrete le monde');
  eq(M.pouvoirDeStat('def'), 'egide', 'et la garde protege');

  /* Sans fruit, rien. Le poing nu ne lance pas d'eclair. */
  eq(M.pouvoirDeStat(null), null, 'sans fruit, aucun pouvoir');
  eq(M.pouvoirDeStat('stat_inexistante'), null, 'une stat inconnue ne donne pas de pouvoir');

  /* ---- LES COUTS SONT CALES SUR LA REGENERATION ----
   * Un pouvoir qui couterait plus que la reserve ne partirait jamais ; un
   * pouvoir qui couterait trois fois rien se lancerait en continu et
   * remplacerait l'arme. On borne donc la part de la reserve qu'il consomme. */
  const mpMax = Math.max(...Object.keys(P.BASE).map((k) => P.BASE[k].mp));
  const wisMax = Math.max(...Object.keys(P.BASE).map((k) => P.BASE[k].wis));
  Object.keys(M.POUVOIRS).forEach((k) => {
    const P2 = M.POUVOIRS[k];
    ok(P2.cout < mpMax * 0.5, `« ${k} » coute moins de la moitie de la reserve (${P2.cout}/${mpMax})`);
    ok(P2.cout > mpMax * 0.1, `« ${k} » coute quand meme quelque chose (${P2.cout}/${mpMax})`);
    /* Le MANA doit etre la vraie limite, pas la recharge : sinon la sagesse
       ne servirait a rien et tout le monde lancerait au meme rythme. */
    const secondesDeMana = P2.cout / M.regenParSeconde(wisMax, false);
    ok(secondesDeMana > P2.recharge,
       `« ${k} » : c'est le mana qui limite (${secondesDeMana.toFixed(1)} s) et non la recharge (${P2.recharge} s)`);
  });

  /* La stase dure les cinq secondes demandees. */
  eq(M.POUVOIRS.stase.duree, 5, 'la stase fige cinq secondes');

  /* ---- UN DEBUTANT PEUT LANCER SON POUVOIR ----
   * On entre dans le monde au NIVEAU 0, avec une reserve de mana bien plus
   * petite qu'au niveau 20. Un pouvoir qui couterait plus que cette reserve
   * serait annonce sur le bouton, refuse a chaque appui, et le joueur
   * n'aurait aucun moyen de comprendre qu'il lui manque quinze niveaux. */
  Object.keys(P.BASE).forEach((k) => {
    const mp0 = P.statAuNiveau(P.BASE[k].mp, 0);
    Object.keys(M.POUVOIRS).forEach((c) => {
      ok(M.POUVOIRS[c].cout <= mp0,
         `« ${k} » au niveau 0 (${mp0} MP) peut lancer « ${c} » (${M.POUVOIRS[c].cout} MP)`);
    });
  });
}

// ================== 8. LES TAILLES, ET LA RARETE
/*
 * Deux choses ne se voient pas dans un chiffre isole et se paient a l'ecran :
 * une creature dessinee a la meme taille que toutes les autres, et un boss
 * qui sort aussi souvent qu'un lime.
 */
{
  /* ---- LE DESSIN DECOULE DU RAYON, ET DE RIEN D'AUTRE ----
   * La page dessine chaque creature a `rayon x 3`. Ce n'est ecrit nulle part
   * ailleurs, et c'est exactement le but : une table de tailles a cote
   * finirait par ne plus dire la meme chose que les collisions, et le
   * desaccord se verrait — on tirerait a cote de ce qu'on voit.
   * Ce qu'on verifie ici, c'est que les rayons SEPARENT vraiment les
   * creatures : trois tailles indistinguables ne valent pas mieux qu'une. */
  const r = (k) => M.MONSTRES[k].rayon;
  ok(r('nuee') * 2 < r('lime'),
     `la nuee (${r('nuee')}) fait moins de la moitie du lime (${r('lime')})`);
  ok(r('colosse') > r('lave') * 1.5,
     `le colosse (${r('colosse')}) depasse de moitie le golem (${r('lave')})`);
  ok(r('gardien') > r('colosse'),
     `le gardien (${r('gardien')}) est la plus grosse chose du monde`);
  /* Le rayon sert AUX COLLISIONS. Une creature aussi large qu'un anneau
     entier serait touchable depuis l'anneau voisin. */
  const demi = M.MONDE.w / 2;
  Object.keys(M.MONSTRES).forEach((k) => {
    ok(M.MONSTRES[k].rayon < demi * 0.20 * 0.5,
       `« ${M.MONSTRES[k].nom} » tient dans le plus petit des anneaux`);
  });

  /* ---- LES DEUX GERBES DEMANDENT LE GESTE INVERSE ----
   * Le squelette et le gardien tirent tous deux en eventail. Si leurs ecarts
   * se ressemblaient, la deuxieme creature n'apprendrait rien : c'est
   * l'ANGLE qui decide si l'on esquive sur le cote ou en fermant la
   * distance. */
  const sq = M.MONSTRES.skeleton.tir, ga = M.MONSTRES.gardien.tir;
  ok(ga.ecart > sq.ecart * 2,
     `l'eventail du gardien (${ga.ecart}) est plus du double de celui du squelette (${sq.ecart})`);

  /* ---- UN BOSS RESTE RARE ----
   * `poids` n'existe que pour ca. Sans lui le tirage est uniforme : six
   * especes dans la lave, dix-huit places, donc TROIS brasiers a chaque
   * passage — et trois boss ne sont plus un boss.
   * On compte sur mille tirages, pas sur un : un seul dirait le hasard, pas
   * la regle.
   * C'etait le gardien qui tenait ce role ici ; il ne vit plus que dans les
   * salles, et le brasier a pris sa place AVEC son poids. Le test suit le
   * role, pas le nom : ce qu'on protege, c'est « le boss de la lave est
   * rare », quelle que soit la creature qui l'incarne. */
  {
    const r1 = alea(4242);
    const p = M.PEUPLEMENT.lave;
    const compte = {};
    for (let i = 0; i < 1000; i++) {
      const e = M.choisitEspece(p, r1);
      compte[e] = (compte[e] || 0) + 1;
    }
    const part = (compte.brasier || 0) / 1000;
    ok(part > 0.02 && part < 0.09,
       `le brasier sort dans ${(part * 100).toFixed(1)} % des tirages de lave (vise 5 %)`);
    /* Le rapport theorique vaut exactement 4 (poids 1 contre 0,25). Exiger
       « plus de 4 fois » posait le seuil PILE sur l'attendu : un tirage sur
       deux echoue alors, sans que rien ne soit casse. On demande donc ce
       qu'on veut vraiment dire — un ordre de grandeur d'ecart. */
    ok((compte.brasier || 0) * 3 <= (compte.lave || 0),
       `on croise bien plus de golems (${compte.lave}) que de brasiers (${compte.brasier})`);
    /* Sur dix-huit places, cela doit faire environ UN brasier. */
    const attendus = part * p.nombre;
    ok(attendus >= 0.4 && attendus <= 1.6,
       `l'anneau de lave porte ${attendus.toFixed(2)} brasier en moyenne`);
  }

  /* ---- ET A L'INVERSE, UNE NUEE EST UNE NUEE ----
   * Elle n'a d'interet qu'au pluriel. Si elle sortait comme les autres, elle
   * serait juste un lime rapide et fragile. */
  {
    const r2 = alea(777);
    const p = M.PEUPLEMENT.marais;
    let nuees = 0;
    for (let i = 0; i < 1000; i++) if (M.choisitEspece(p, r2) === 'nuee') nuees++;
    const attendues = (nuees / 1000) * p.nombre;
    ok(attendues > 12,
       `le marais porte ${attendues.toFixed(0)} nuees a la fois — assez pour en etre une`);
  }

  /* ---- LA REGLE DES POIDS N'EST PAS OPTIONNELLE ----
   * Un biome sans `poids` doit continuer a tirer uniformement : ajouter la
   * colonne ne devait rien changer la ou on ne l'a pas remplie. */
  {
    const r3 = alea(31337);
    const p = M.PEUPLEMENT.cendres;
    const compte = {};
    for (let i = 0; i < 4000; i++) {
      const e = M.choisitEspece(p, r3);
      compte[e] = (compte[e] || 0) + 1;
    }
    /* La part attendue se CALCULE : une espece sans poids vaut 1 sur le total
       des poids du biome. L'ecrire en dur — « entre 15 et 24 % » — c'etait
       vrai avec six especes et faux des la septieme, et l'essai tombait alors
       en annoncant un defaut qui n'existait pas. Ce qu'on veut dire, c'est
       « toutes celles qui n'ont pas de poids ont la MEME part », et ca se dit
       en une division. */
    const total = p.especes.reduce((t, k) => t + ((p.poids || {})[k] || 1), 0);
    const attendu = 1 / total;
    p.especes.filter((k) => !(p.poids || {})[k]).forEach((k) => {
      const part = compte[k] / 4000;
      ok(Math.abs(part - attendu) < attendu * 0.22,
         `« ${k} », sans poids, tire sa part uniforme dans les cendres ` +
         `(${(part * 100).toFixed(1)} % pour ${(attendu * 100).toFixed(1)} % attendus)`);
    });
  }

  /* ---- AUCUNE ESPECE N'EST INJOIGNABLE ----
   * Une creature listee dans PEUPLEMENT avec un poids de zero, ou oubliee de
   * toutes les listes, existerait dans la table sans jamais apparaitre.
   * Il existe DEUX portes vers le monde, pas une : les anneaux, et les
   * salles gardees. Le gardien ne passe plus que par la seconde. On les
   * compte donc toutes les deux — sinon le test dirait « injoignable »
   * d'une creature qu'on croise a chaque relique. */
  {
    const vus = {};
    Object.keys(M.PEUPLEMENT).forEach((b) => {
      const p = M.PEUPLEMENT[b];
      const r4 = alea(90210);
      for (let i = 0; i < 3000; i++) vus[M.choisitEspece(p, r4)] = true;
    });
    vus[M.SALLE.espece] = true;
    /* TROIS portes, et la troisieme est une TABLE. On parcourt tous les
       donjons declares plutot que le seul premier : ecrire `M.DONJON` ici
       revenait a dire « les creatures de la Fonderie sont joignables » et a
       declarer injoignables celles de tous les donjons suivants — ce que cet
       essai a effectivement fait le jour ou la cave est arrivee. */
    Object.keys(M.DONJONS).forEach((d) => {
      M.DONJONS[d].especes.forEach((k) => { vus[k] = true; });
      vus[M.DONJONS[d].boss] = true;
    });
    /* QUATRIEME porte : ce qu'un boss APPELLE. Elles n'apparaissent dans
       aucune table de peuplement — c'est le propre d'une invocation — et cet
       essai les aurait declarees injoignables alors qu'on en croise huit a la
       fois au fond du Sanctuaire.
       On lit les PHASES du monde plutot qu'une liste ecrite ici : le jour ou
       un boss appelle une espece de plus, elle est couverte sans que personne
       n'y pense. */
    Object.keys(M.MONSTRES).forEach((k) => {
      const n = M.nbPhases(k);
      if (!n) { if (M.MONSTRES[k].appel) vus[M.MONSTRES[k].appel.espece] = true; return; }
      const pvMax = M.MONSTRES[k].pv;
      for (let i = 0; i < n; i++) {
        for (let q = 1000; q >= 0; q--) {
          const pv = pvMax * (q / 1000);
          if (M.phaseMonstre(k, pv, pvMax) !== i) continue;
          const t = M.statsMonstre(k, pv, pvMax);
          if (t.appel) vus[t.appel.espece] = true;
          break;
        }
      }
    });
    Object.keys(M.MONSTRES).forEach((k) => {
      ok(vus[k], `« ${M.MONSTRES[k].nom} » apparait vraiment quelque part`);
    });

    /* ET L'INVERSE : `biomes` vide veut dire « celle-la ne naît pas dans un
       anneau ». Il y a maintenant TROIS portes vers le monde — les anneaux,
       les salles gardees, les donjons — et une espece sans biome doit passer
       par l'une des deux dernieres. Si une AUTRE se retrouvait avec une liste
       vide, parce qu'on l'a retiree d'un anneau sans lui donner de role, elle
       serait dans la table sans porte d'entree ; et la ligne ci-dessus ne le
       verrait pas — elle ne regarde que ce qui sort du tirage, pas ce qui
       aurait du en sortir. */
    const roles = new Set([M.SALLE.espece]);
    /* TOUS les donjons, pas le premier. Meme raison que dix lignes plus haut :
       nommer `M.DONJON` revenait a declarer orphelines les creatures de tous
       les donjons suivants — ce que cet essai a fait des l arrivee de la
       cave, en accusant ses quatre pirates de n avoir aucune porte d entree
       alors qu ils en ont une. */
    Object.keys(M.DONJONS).forEach((d) => {
      roles.add(M.DONJONS[d].boss);
      M.DONJONS[d].especes.forEach((e) => roles.add(e));
    });
    /* ETRE APPELE PAR UN BOSS EST UN ROLE. C'en est meme un tres precis : la
       creature n'existe QUE pendant son combat, ce qui est plus qu'un anneau
       ne promet. Sans cette porte, l'essai declarait orphelines les deux
       especes du Sanctuaire alors qu'on en croise huit a la fois au fond.
       On lit les phases du monde, jamais une liste recopiee ici. */
    Object.keys(M.MONSTRES).forEach((k) => {
      const n = M.nbPhases(k);
      if (!n) { if (M.MONSTRES[k].appel) roles.add(M.MONSTRES[k].appel.espece); return; }
      const pvMax = M.MONSTRES[k].pv;
      for (let i = 0; i < n; i++) {
        for (let q = 1000; q >= 0; q--) {
          const pv = pvMax * (q / 1000);
          if (M.phaseMonstre(k, pv, pvMax) !== i) continue;
          const t = M.statsMonstre(k, pv, pvMax);
          if (t.appel) roles.add(t.appel.espece);
          break;
        }
      }
    });
    const sansBiome = Object.keys(M.MONSTRES).filter((k) => M.MONSTRES[k].biomes.length === 0);
    const orphelines = sansBiome.filter((k) => !roles.has(k));
    eq(orphelines.length, 0,
       `aucune espece n est sans anneau ET sans role (${orphelines.join(', ') || 'aucune'})`);
    /* Et l'inverse de l'inverse : une espece a qui l'on a donne un role de
       donjon ne doit PAS errer dehors aussi. La meme creature dans deux roles,
       c'est un role qui n'existe pas — c'est ce qui avait fait sortir le
       gardien de la lave. */
    const deuxRoles = [...roles].filter((k) => M.MONSTRES[k] && M.MONSTRES[k].biomes.length > 0);
    eq(deuxRoles.length, 0,
       `aucune espece de salle ou de donjon n erre aussi dehors (${deuxRoles.join(', ') || 'aucune'})`);
  }
}

/* ================== UNE CARTE DE JOUEUR DEVIENT UN PLAN ================== */
{
  /* Les objets vivent dans leur propre liste depuis les couches. */
  const carte = (cases, dep, cote, objets) => ({ id: 1, nom: 'Essai', cote: cote || 16,
                                                 depart: dep || { c: 8, l: 8 },
                                                 cases, objets: objets || [] });
  const p = M.planDeCarte(carte(
    [{ c: 1, l: 1, s: 'grass' }, { c: 2, l: 1, s: 'grass' }, { c: 3, l: 1, s: 'cave' }],
    null, null, [{ c: 1, l: 5, k: 'boxe', z: 0 }]));
  /* ---- LES SOLS VOYAGENT EN PALETTE ----
   * Le troisieme nombre d'une tuile est un INDICE, pas un nom : repeter
   * « ground_cave » deux mille trois cents fois pese plus que la carte. */
  eq(p.sols.length, 2, 'deux sols distincts font une palette de deux');
  eq(p.tuiles.length, 3, 'et trois cases de sol font trois tuiles');
  eq(p.tuiles[0][2], 0, 'la premiere tuile pointe le premier sol');
  eq(p.tuiles[2][2], 1, 'et la troisieme le second');
  eq(p.sols[p.tuiles[2][2]], 'cave', 'ce qui redonne bien son nom');
  /* Un objet devient un bloc qui PORTE SON NOM : la page sait dessiner une
     planche nommee, elle n'a pas a deviner un indice. */
  eq(p.obstacles.length, 1, 'un objet pose fait un bloc');
  eq(p.obstacles[0].bat, 'boxe', 'qui porte son nom');
  ok(p.obstacles[0].r > 0, 'et un rayon qui bloque');
  /* ---- AUCUNE CREATURE, ET C'EST UNE REGLE ----
   * Des creatures placees par n'importe qui, c'est le butin place par
   * n'importe qui. */
  eq(p.peuplement.length, 0, 'et aucune creature : une carte est un endroit ou l on marche');
  eq(p.sortie, null, 'pas de porte de retour : on sort par la touche du Nexus');
  eq(p.entree.x, 8.5 * M.DONJON_TUILE, 'on arrive au centre de la case du depart');

  /* ---- UN BLOC NE PEUT PAS AVALER LE POINT D'ARRIVEE ----
   * Depuis qu'un element peut couvrir la carte entiere, un fond pose sur le
   * depart y ferait NAITRE le visiteur dans la pierre. */
  const gros = M.planDeCarte(carte([], { c: 8, l: 8 }, null,
    [{ c: 8, l: 9, k: 'iso_hotel', n: 20, z: 0 }]));
  /* ---- « CESSE DE BLOQUER » N'EST PAS « DISPARAIT » ----
   * Cet essai comptait les blocs et attendait ZERO. C'est ce compte-la qui a
   * laisse passer le defaut : le decor sortait de la liste que la page
   * DESSINE, et une carte dont le fond couvre le depart s'ouvrait sur son sol
   * nu. Signale en jouant le Nexus en 2,5D — « on voit les batiments mais pas
   * la maps ». On mesure donc ce qui etait promis, et non ce qui etait fait :
   * il reste, il ne bloque plus. */
  eq(gros.obstacles.length, 1,
     'un decor assez grand pour recouvrir le depart RESTE dans le plan');
  eq(gros.obstacles[0].r, 0, 'mais son rayon est nul : il cesse de bloquer');
  ok(!M.bloque(gros.obstacles, gros.entree.x, gros.entree.y, 24),
     'et l on nait dessus sans y etre pris');
  eq(gros.obstacles[0].larg, 20 * M.DONJON_TUILE,
     'il garde sa largeur : c est ce que la page dessine');
  const petit = M.planDeCarte(carte([], { c: 1, l: 1 }, null,
    [{ c: 8, l: 9, k: 'iso_hotel', n: 2, z: 0 }]));
  eq(petit.obstacles.length, 1, 'un decor qui ne le touche pas bloque comme avant');
  /* Et le rayon suit l'emprise : c'est ce qui fait que ce qu'on traverse est
     ce qu'on voit. */
  const large = M.planDeCarte(carte([], { c: 14, l: 14 }, null,
    [{ c: 2, l: 2, k: 'iso_hotel', n: 4, z: 0 }]));
  const etroit = M.planDeCarte(carte([], { c: 14, l: 14 }, null,
    [{ c: 2, l: 2, k: 'iso_hotel', n: 2, z: 0 }]));
  ok(large.obstacles[0].r > etroit.obstacles[0].r,
     'une emprise plus grande bloque plus large');
  eq(large.obstacles[0].larg, 4 * M.DONJON_TUILE,
     'et la largeur dessinee vaut son emprise en tuiles');
  /* ---- L EMPRISE FRACTIONNAIRE ARRIVE JUSQU AU BLOC ----
   * Elle etait arrondie a UNE case au minimum : une demi-case aurait alors
   * bloque quatre fois la surface de ce qu on voit, et l on se serait cogne
   * dans du vide tout autour. */
  const demi = M.planDeCarte(carte([], { c: 14, l: 14 }, null,
    [{ c: 2, l: 2, k: 'iso_hotel', n: 0.5, z: 0 }]));
  eq(demi.obstacles[0].larg, 0.5 * M.DONJON_TUILE,
     'une demi-case se dessine sur une demi-tuile, et non sur une entiere');
  const troisQuarts = M.planDeCarte(carte([], { c: 14, l: 14 }, null,
    [{ c: 2, l: 2, k: 'iso_hotel', n: 2.75, z: 0 }]));
  eq(troisQuarts.obstacles[0].larg, 2.75 * M.DONJON_TUILE,
     'et deux cases trois quarts, sur deux tuiles trois quarts');
  ok(troisQuarts.obstacles[0].r > large.obstacles[0].r * 0.6
     && troisQuarts.obstacles[0].r < large.obstacles[0].r,
     `le rayon suit, entre les deux : ${troisQuarts.obstacles[0].r} pour`
     + ` ${etroit.obstacles[0].r} et ${large.obstacles[0].r}`);

  /* ---- ET LE MIROIR PART AVEC LE BLOC ----
   * La page le dessine, elle ne le devine pas : un miroir laisse au serveur
   * et jamais transmis retournerait l element dans l editeur et pas dans le
   * monde, ce qui est la pire facon de se tromper — les deux dessins se
   * contrediraient sans que rien ne plante. */
  const retourne = M.planDeCarte(carte([], { c: 14, l: 14 }, null,
    [{ c: 2, l: 2, k: 'iso_hotel', m: 3, g: 47, z: 0 }]));
  eq(retourne.obstacles[0].m, 3, 'le miroir voyage jusqu au bloc');
  eq(retourne.obstacles[0].g, 47, 'et l angle avec lui');
  eq(large.obstacles[0].m, 0, 'un element droit porte zero, et non rien du tout :'
                              + ' une page qui lit un champ absent dessinerait au hasard');

  /* ---- LA COUCHE DEVIENT UN ORDRE, UNE FOIS POUR TOUTES ----
   * Un plan n'a pas de couches : il a une liste de blocs que la page dessine
   * dans l'ordre recu. Sans ce tri, un toit passerait sous sa maison. */
  const empile = M.planDeCarte(carte([], { c: 1, l: 1 }, null, [
    { c: 8, l: 8, k: 'toit', z: 3 },
    { c: 8, l: 9, k: 'maison', z: 1 },
    { c: 2, l: 9, k: 'chemin', z: 0 },
  ]));
  eq(empile.obstacles.map((o) => o.bat).join(','), 'chemin,maison,toit',
     'les blocs sortent dans l ordre des couches, quelle que soit la pose');
  const memeCouche = M.planDeCarte(carte([], { c: 1, l: 1 }, null, [
    { c: 5, l: 9, k: 'devant', z: 2 },
    { c: 5, l: 3, k: 'derriere', z: 2 },
  ]));
  eq(memeCouche.obstacles.map((o) => o.bat).join(','), 'derriere,devant',
     'et sur une meme couche, du fond vers l avant');
}

console.log('monde.test.js : ' + n + ' verifications OK');
