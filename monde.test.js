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
  assert.deepStrictEqual(vus, ['lave', 'neige', 'terre'],
    'du centre au bord : lave, puis neige, puis terre — et rien d autre');
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
// Trois pouvoirs, et celui qu'on obtient se DEDUIT de la stat que le fruit
// favorise deja. La regle vaut mieux qu'une table ecrite a la main : un
// septieme fruit ajoute demain recoit automatiquement le bon pouvoir.
{
  eq(Object.keys(M.POUVOIRS).length, 3, 'il y a trois pouvoirs');

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

  /* LES TROIS SONT ATTEIGNABLES. Un pouvoir qu'aucun fruit ne donne serait du
     code mort qui a l'air vivant. */
  const donnes = new Set(fruits.map((f) => M.pouvoirDeStat(P.FAMILLE_STAT[f])));
  eq(donnes.size, 3, 'les trois pouvoirs sont tous donnes par un fruit reel');

  /* Le pouvoir prolonge le fruit au lieu de le contredire. */
  eq(M.pouvoirDeStat('att'), 'foudre', 'la force frappe fort');
  eq(M.pouvoirDeStat('dex'), 'rafale', 'la vitesse tire vite');
  eq(M.pouvoirDeStat('def'), 'stase', 'la garde arrete le monde');

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

console.log('monde.test.js : ' + n + ' verifications OK');
