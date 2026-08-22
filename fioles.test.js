'use strict';
/*
 * LES FIOLES DE STAT SE GARDENT.
 *
 * Une fiole trouvee etait bue sur place, tout de suite, sans qu'on ait rien
 * demande. Deux consequences, et les deux sont mauvaises :
 *
 *   - a son plafond, elle etait REFUSEE et restait par terre jusqu'a la fin de
 *     sa minute. Une potion trouvee dans la lave se perdait parce qu'on avait
 *     deja bu six defenses ;
 *   - et rien ne permettait d'en garder une pour le personnage suivant. Elles
 *     meurent avec celui qui les boit — c'est voulu — mais il n'existait aucun
 *     moyen de les mettre a l'abri AVANT de boire.
 *
 * ---- ce que ce fichier protege, dans l'ordre ----
 *
 * 1. CE QU'ON RANGE SURVIT A LA MORT. C'est toute la raison d'etre du coffre,
 *    et la seule propriete dont l'echec se remarque une partie trop tard.
 * 2. CE QU'ON PORTE MEURT. Sinon le sac serait un second coffre gratuit.
 * 3. UN REFUS NE DETRUIT RIEN. Boire au plafond doit laisser la fiole en
 *    place, pas la consommer pour rien.
 * 4. ELLE NE PREND AUCUNE PLACE DU SAC. Elle en prenait une, et c'etait le
 *    travail laisse a mi-chemin : une PILE ne coutait plus qu'une case au
 *    lieu de trois, mais le nombre de STATS differentes qu'on pouvait porter
 *    restait borne par ce qui restait de sac. Avec quatre pieces
 *    d'equipement, on portait quatre sortes de fioles et pas une de plus.
 *    Elles ont desormais leur reserve, plafonnee a `monde.FIOLE_PILE`.
 */
const assert = require('assert');
const { Game } = require('./game');
const B = require('./boutique');
const P = require('./personnages');
const monde = require('./monde');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const neuf = () => {
  const g = new Game();
  const p = g._p(A);
  p.skins = { andy: true }; p.skinActif = 'andy';
  g.gagneXpCombat(A, 'andy', 100);
  return { g, p };
};
const compte = (g, stat) => {
  const l = g.fiolesPour(A).find((x) => x.cle === stat);
  return l ? { coffre: l.coffre, sac: l.sac } : { coffre: 0, sac: 0 };
};

// ================== 1. RAMASSER NE BOIT PLUS
{
  const { g } = neuf();
  const avant = g.personnageEtat(A, 'andy').stats.def;
  g.prendFiole(A, 'def');
  eq(g.personnageEtat(A, 'andy').stats.def, avant,
     'ramasser une fiole ne change AUCUNE stat : elle attend dans le sac');
  eq(compte(g, 'def').sac, 1, 'elle est dans le sac');
  /* ---- ET ELLE NE PREND AUCUNE DES HUIT PLACES ----
   * Elle en prenait une. Le commentaire de `_casesDuSac` disait pourtant deja
   * qu une fiole « n est pas du butin qu on choisit de garder, c est une
   * reserve, comme les potions de soin qui ont deja leur pile » — et le
   * travail s etait arrete a mi-chemin : une PILE ne coutait plus qu une case
   * au lieu de trois, mais le nombre de STATS differentes qu on pouvait
   * porter restait borne par ce qui restait de sac. Avec quatre pieces
   * d equipement, on portait quatre sortes de fioles et pas une de plus. */
  eq(g.sacRempli(A), 0, 'et elle ne prend AUCUNE des huit places du butin');
}

// ================== 1bis. LA RESERVE, ET SON PLAFOND
{
  const { g } = neuf();
  /* Le sac PLEIN d equipement : c est la situation exacte ou le refus tombait.
     On la reproduit plutot que de la supposer. */
  const p = g._p(A);
  const piece = B.ITEMS.find((o) => o.rarete === 'commun');
  p.sac = {}; p.sac[piece.id] = monde.SAC.cases;
  eq(g.sacRempli(A), monde.SAC.cases, 'le sac est plein de butin');
  /* Toutes les stats, jusqu au plafond de chacune. Le plafond vient du MONDE :
     l ecrire ici ferait passer l essai le jour ou on le change. */
  for (const st of P.STATS) {
    for (let i = 0; i < monde.FIOLE_PILE; i++) g.prendFiole(A, st);
    eq(compte(g, st).sac, monde.FIOLE_PILE,
       `« ${st} » : la reserve monte a ${monde.FIOLE_PILE} malgre le sac plein`);
  }
  eq(g.sacRempli(A), monde.SAC.cases,
     'et le butin occupe toujours exactement ses huit cases, pas une de plus');
  /* Le plafond EXISTE quand meme : un compteur sans borne finit par ecrire un
     nombre qui ne tient pas dans sa case. */
  let refus = null;
  try { g.prendFiole(A, P.STATS[0]); } catch (e) { refus = e.message; }
  ok(refus && refus.indexOf(String(monde.FIOLE_PILE)) >= 0,
     `au-dela, le refus dit le plafond (${refus})`);
  /* Et il ne DETRUIT rien : le refus arrive avant que quoi que ce soit bouge. */
  eq(compte(g, P.STATS[0]).sac, monde.FIOLE_PILE, 'et la reserve est intacte');
}

// ================== 2. BOIRE EST UN GESTE
{
  const { g } = neuf();
  g.prendFiole(A, 'def');
  const avant = g.personnageEtat(A, 'andy').stats.def;
  const r = g.boitFiole(A, 'andy', 'def');
  ok(g.personnageEtat(A, 'andy').stats.def > avant,
     `boire monte la stat (${avant} -> ${g.personnageEtat(A, 'andy').stats.def})`);
  eq(r.ou, 'sac', 'on boit d abord ce qu on porte');
  eq(compte(g, 'def').sac, 0, 'et la fiole est consommee');

  /* On ne boit pas ce qu'on n'a pas. */
  let refus = null;
  try { g.boitFiole(A, 'andy', 'def'); } catch (e) { refus = e.message; }
  ok(refus, 'boire sans fiole est refuse : ' + refus);
}

// ================== 3. LE COFFRE SURVIT A LA MORT, LE SAC NON
//
// La propriete pour laquelle le coffre existe.
{
  const { g } = neuf();
  g.prendFiole(A, 'def'); g.prendFiole(A, 'def'); g.prendFiole(A, 'att');
  g.rangeFiole(A, 'def');
  eq(compte(g, 'def').coffre, 1, 'une defense est rangee');
  eq(compte(g, 'def').sac, 1, 'une autre reste dans le sac');
  eq(compte(g, 'att').sac, 1, 'et l attaque aussi');
  /* Ranger ne libere plus de PLACE — il n'y en avait plus a prendre — mais il
     change ce qui survit, et c'est la seule chose qui comptait vraiment. */
  eq(g.sacRempli(A), 0, 'et le butin, lui, n a jamais bouge');

  const bilan = g.meurt(A, 'andy');
  eq(compte(g, 'def').coffre, 1, 'ce qui est RANGE survit a la mort');
  eq(compte(g, 'def').sac, 0, 'ce qui est PORTE meurt');
  eq(compte(g, 'att').sac, 0, 'tout ce qui est porte, pas seulement une');
  eq(JSON.stringify(bilan.fiolesPerdues), JSON.stringify({ def: 1, att: 1 }),
     'et l ecran de fin les nomme — sinon on decouvre la perte trois parties plus tard');
}

// ================== 4. UN REFUS NE DETRUIT RIEN
//
// Boire au plafond doit laisser la fiole en place. C'est le seul defaut de
// cette fonction qui couterait quelque chose au joueur.
{
  const { g } = neuf();
  const mx = P.supMaxDe('def', P.BASE.andy.def);
  for (let i = 0; i < mx; i++) { g.prendFiole(A, 'def'); g.boitFiole(A, 'andy', 'def'); }
  ok(mx > 0, `le plafond de defense d andy vaut ${mx}`);
  g.prendFiole(A, 'def');
  eq(compte(g, 'def').sac, 1, 'on en tient une de plus');
  let refus = null;
  try { g.boitFiole(A, 'andy', 'def'); } catch (e) { refus = e.message; }
  ok(refus && /Already at/.test(refus), 'boire au plafond est refuse : ' + refus);
  eq(compte(g, 'def').sac, 1, 'ET LA FIOLE EST TOUJOURS LA — le refus ne consomme rien');
  /* On peut donc la ranger pour le personnage suivant. C'est exactement ce
     qu'on ne pouvait pas faire avant : elle finissait par terre. */
  g.rangeFiole(A, 'def');
  eq(compte(g, 'def').coffre, 1, 'et la mettre a l abri');
}

// ================== 5. LE BUTIN ET LA RESERVE NE SE DISPUTENT RIEN
//
// C'est la propriete neuve, et celle qui se casse le plus silencieusement :
// un seul compteur partage entre deux choses qui n'ont rien a voir.
{
  const { g } = neuf();
  /* Le sac REMPLI de butin, jusqu'a la derniere case. */
  const combien = monde.SAC.cases;
  B.ITEMS_DROP.slice(0, combien).forEach((o) => { g.prendDuSol(A, o.id); });
  eq(g.sacRempli(A), combien, `${combien} pieces remplissent les ${combien} cases`);
  let plein = null;
  try { g.prendDuSol(A, B.ITEMS_DROP[combien].id); } catch (e) { plein = e.message; }
  ok(plein && /full/.test(plein), 'la piece suivante est refusee : ' + plein);

  /* ---- ET LES FIOLES PASSENT QUAND MEME ----
   * C'est exactement le refus que le joueur rencontrait : sac plein
   * d'equipement, donc plus aucune fiole ramassable, y compris d'une stat
   * qu'il portait deja. */
  for (const st of P.STATS) {
    g.prendFiole(A, st);
    eq(compte(g, st).sac, 1, `« ${st} » se ramasse malgre le sac plein`);
  }
  eq(g.sacRempli(A), combien,
     'et le butin occupe toujours exactement ses cases, pas une de plus');

  /* Les cases du sac sont distinctes et ne portent QUE du butin. */
  const l = g.sacPour(A);
  eq(l.length, combien, 'le sac rend une ligne par case');
  eq(new Set(l.map((x) => x.place)).size, combien, 'a des places differentes');
  eq(l.filter((x) => x.fiole).length, 0,
     'et plus aucune fiole n y figure — elles ont leur reserve');
  /* La reserve, elle, se lit ailleurs, et elle est complete. */
  eq(g.fiolesPour(A).filter((x) => x.sac > 0).length, P.STATS.length,
     'la reserve porte les huit stats en meme temps');
}

// ================== 6. TOUT CA SURVIT A UN REDEMARRAGE
{
  const { g } = neuf();
  g.prendFiole(A, 'def'); g.rangeFiole(A, 'def');
  g.prendFiole(A, 'wis');
  g.prendDuSol(A, B.ITEMS_DROP[0].id);
  const placesAvant = g.sacPour(A).map((x) => [x.place, x.fiole || x.id]);

  const etat = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(etat);
  const l2 = g2.fiolesPour(A);
  eq(JSON.stringify(l2), JSON.stringify(g.fiolesPour(A)),
     'les fioles reviennent identiques, coffre et sac');
  eq(JSON.stringify(g2.sacPour(A).map((x) => [x.place, x.fiole || x.id])),
     JSON.stringify(placesAvant),
     'et CHAQUE chose retrouve sa case — un redemarrage ne rebat pas le sac');
}

console.log('fioles.test.js : ' + n + ' verifications OK');
