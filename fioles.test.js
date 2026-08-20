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
 * 4. Elle prend UNE PLACE du sac, et les huit places restent huit.
 */
const assert = require('assert');
const { Game } = require('./game');
const B = require('./boutique');
const P = require('./personnages');
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
  eq(g.sacRempli(A), 1, 'et elle occupe une des huit places');
  /* Et le sac la MONTRE, a sa place, avec ce qu'elle donne. */
  const l = g.sacPour(A)[0];
  eq(l.fiole, 'def', 'le sac la nomme');
  eq(l.place, 0, 'a sa case');
  eq(l.bonus.def, P.supPas('def'), 'et dit ce qu elle donnera');
  ok(typeof l.col === 'number', 'avec sa colonne de dessin, comptee par le serveur');
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
  eq(g.sacRempli(A), 0, 'la place se libere');

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
  eq(g.sacRempli(A), 2, 'ranger LIBERE une place du sac');

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

// ================== 5. LES HUIT PLACES RESTENT HUIT
{
  const { g, p } = neuf();
  B.ITEMS_DROP.slice(0, 6).forEach((o) => { g.prendDuSol(A, o.id); });
  g.prendFiole(A, 'def'); g.prendFiole(A, 'att');
  eq(g.sacRempli(A), 8, 'six pieces et deux fioles font huit');
  let plein = null;
  try { g.prendFiole(A, 'wis'); } catch (e) { plein = e.message; }
  ok(plein && /full/.test(plein), 'la neuvieme est refusee : ' + plein);
  let plein2 = null;
  try { g.prendDuSol(A, B.ITEMS_DROP[7].id); } catch (e) { plein2 = e.message; }
  ok(plein2, 'et une piece aussi — les fioles comptent dans les memes huit places');

  /* Les huit cases sont distinctes et couvrent tout ce qu'on porte. */
  const l = g.sacPour(A);
  eq(l.length, 8, 'le sac rend huit lignes');
  eq(new Set(l.map((x) => x.place)).size, 8, 'a huit places differentes');
  eq(l.filter((x) => x.fiole).length, 2, 'dont deux fioles');

  /* Sortir une fiole du coffre demande de la place, comme tout le reste. */
  g.rangeFiole(A, 'def');
  eq(g.sacRempli(A), 7, 'ranger libere');
  g.prendDuSol(A, B.ITEMS_DROP[7].id);
  eq(g.sacRempli(A), 8, 'la place reprise');
  let sort = null;
  try { g.sortFiole(A, 'def'); } catch (e) { sort = e.message; }
  ok(sort && /full/.test(sort), 'et ressortir dans un sac plein est refuse : ' + sort);
  eq(compte(g, 'def').coffre, 1, 'la fiole reste au coffre — le refus ne la perd pas');
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
