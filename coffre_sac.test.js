'use strict';
/*
 * RANGER AU COFFRE, ET REPRENDRE.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE SAC MEURT AVEC LE PERSONNAGE, LE COFFRE NON. Passer de l'un a
 *    l'autre est donc le seul geste qui change le RISQUE d'un objet — c'est
 *    tout le sujet de ce fichier.
 * 2. ON NE REPREND PAS CE QU'ON PORTE. L'equipement se lit dans le coffre :
 *    l'en sortir desequiperait le personnage tout seul, sans que personne
 *    comprenne pourquoi.
 * 3. RIEN NE SE CREE NI NE DISPARAIT. Un aller-retour rend exactement ce
 *    qu'on avait.
 * 4. ON NE RANGE PAS CE QU'ON N'A PAS.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const leve = (f, motif, m) => { assert.throws(f, motif, m); n++; };
const A = '0x' + 'a1'.repeat(20);

const arme = B.ITEMS.filter((o) => o.saison === 2)[0];
const fruit = B.ITEMS.filter((o) => o.saison === 1)[0];

function pose() {
  const g = new Game();
  const p = g._p(A);
  p.balance = ethers.utils.parseUnits('9999999', cfg.DECIMALS);
  p.hasDeposited = true;
  p.skins = { andy: true }; p.skinActif = 'andy';
  return { g, p };
}

// ================== 1. DU SAC AU COFFRE, ET RETOUR
{
  const { g, p } = pose();
  p.sac = { [arme.id]: 2 };
  p.objets = {};

  const r = g.rangeAuCoffre(A, arme.id);
  eq(r.item, arme.id, 'on range bien l objet demande');
  eq(p.sac[arme.id], 1, 'le sac en a un de moins');
  eq(p.objets[arme.id], 1, 'le coffre en a un de plus');

  g.rangeAuCoffre(A, arme.id);
  eq(p.sac[arme.id], undefined, 'a zero, la ligne quitte le sac');
  eq(p.objets[arme.id], 2, 'et les deux sont au coffre');

  g.sortDuCoffre(A, arme.id);
  eq(p.objets[arme.id], 1, 'reprendre en retire un du coffre');
  eq(p.sac[arme.id], 1, 'et le remet au sac');

  /* RIEN NE SE CREE. Le total sur les deux tas ne bouge jamais : c'est la
     seule garantie qui compte quand un objet vaut du vrai $SWOGE. */
  eq((p.sac[arme.id] || 0) + (p.objets[arme.id] || 0), 2,
    'apres trois mouvements, on a toujours exactement deux exemplaires');
}

// ================== 2. ON NE REPREND PAS CE QU'ON PORTE
{
  const { g, p } = pose();
  p.objets = { [arme.id]: 1, [fruit.id]: 1 };
  g.equipeArme(A, 'andy', arme.id);

  leve(() => g.sortDuCoffre(A, arme.id), /worn/i,
    'sortir l arme portee est refuse');
  eq(p.objets[arme.id], 1, 'et elle est toujours au coffre');
  eq(Object.keys(p.sac || {}).length, 0, 'rien n est passe au sac');

  // une fois retiree, elle sort
  g.equipeArme(A, 'andy', null);
  g.sortDuCoffre(A, arme.id);
  eq(p.sac[arme.id], 1, 'apres l avoir enlevee, on peut la reprendre');

  /* Porte par un AUTRE personnage, c'est porte quand meme : on ne joue qu'un
     skin a la fois, mais l'objet est reellement pris. */
  const { g: g2, p: p2 } = pose();
  p2.skins = { andy: true, pepe: true };
  p2.objets = { [arme.id]: 1 };
  g2.equipeArme(A, 'pepe', arme.id);
  p2.skinActif = 'andy';
  leve(() => g2.sortDuCoffre(A, arme.id), /worn/i,
    'portee par un personnage qu on ne joue pas, elle reste bloquee');
}

// ================== 3. ON NE RANGE PAS CE QU'ON N'A PAS
{
  const { g, p } = pose();
  p.sac = {}; p.objets = {};
  leve(() => g.rangeAuCoffre(A, arme.id), /do not have/i, 'ranger sans l avoir est refuse');
  leve(() => g.sortDuCoffre(A, arme.id), /do not have/i, 'reprendre sans l avoir aussi');
  leve(() => g.rangeAuCoffre(A, 999999), /Unknown item/i, 'un objet inexistant est refuse');
  eq(Object.keys(p.sac).length, 0, 'et rien n a ete invente au passage');
  eq(Object.keys(p.objets).length, 0, 'ni d un cote ni de l autre');
}

// ================== 4. LE SAC MEURT, LE COFFRE SURVIT
{
  const { g, p } = pose();
  p.sac = { [arme.id]: 1 };
  p.objets = { [fruit.id]: 1 };
  p.persos = { andy: { w: ethers.BigNumber.from(0), ef: null, ea: null, ar: null, ba: null, xc: 0 } };

  g.meurt(A, 'andy');
  eq(Object.keys(p.sac).length, 0, 'le sac est vide apres la mort');
  eq(p.objets[fruit.id], 1, 'le coffre, lui, a tout garde');

  /* Et c'est bien le RANGEMENT qui sauve : le meme objet, range avant de
     mourir, survit. */
  const { g: g3, p: p3 } = pose();
  p3.sac = { [arme.id]: 1 };
  p3.persos = { andy: { w: ethers.BigNumber.from(0), ef: null, ea: null, ar: null, ba: null, xc: 0 } };
  g3.rangeAuCoffre(A, arme.id);
  g3.meurt(A, 'andy');
  eq(p3.objets[arme.id], 1, 'range avant la mort, l objet est encore la');
  eq(Object.keys(p3.sac).length, 0, 'et le sac est vide');
}

// ================== 5. LE VOYAGE PAR LE DISQUE
{
  const { g, p } = pose();
  p.sac = { [arme.id]: 3 };
  g.rangeAuCoffre(A, arme.id);
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  const q = g2.players.get(A.toLowerCase());
  eq(q.sac[arme.id], 2, 'le sac revient tel quel du fichier');
  eq(q.objets[arme.id], 1, 'et le coffre aussi');
}

// ================== 6. UNE PLACE PAR OBJET, HUIT PLACES
{
  const { g, p } = pose();
  /* Trois exemplaires du MEME objet : le coffre en fait une ligne « x3 »,
     le sac doit en faire TROIS places. Un sac qui empile n'a pas de fond. */
  p.sac = { [arme.id]: 3 };
  const vu = g.sacPour(A);
  eq(vu.length, 3, 'trois exemplaires identiques prennent trois places');
  eq(vu[0].id, vu[2].id, 'et ce sont bien les memes objets');
  ok(vu[0].place !== vu[2].place, 'chaque place a son propre numero');

  // le compte total, toutes lignes confondues
  p.sac = { [arme.id]: 3, [fruit.id]: 2 };
  eq(g.sacRempli(A), 5, 'le sac compte les exemplaires, pas les lignes');

  /* PLEIN, on ne sort plus rien du coffre. Sans ce refus, reprendre vingt
     fois de suite donnerait un sac sans fond par la petite porte. */
  p.sac = { [arme.id]: 8 };
  p.objets = { [fruit.id]: 1 };
  leve(() => g.sortDuCoffre(A, fruit.id), /full/i, 'sac plein : on ne reprend plus rien');
  eq(p.objets[fruit.id], 1, 'et l objet est reste au coffre');

  // une place se libere, ca repasse
  p.sac = { [arme.id]: 7 };
  g.sortDuCoffre(A, fruit.id);
  eq(g.sacRempli(A), 8, 'une place libre suffit');
  eq(p.objets[fruit.id], undefined, 'et l objet a bien quitte le coffre');

  /* RANGER, en revanche, n'est JAMAIS bloque : on vide son sac, on ne le
     remplit pas. Le coffre n'a pas de limite. */
  for (let i = 0; i < 8; i++) {
    const id = Object.keys(g._p(A).sac)[0];
    g.rangeAuCoffre(A, Number(id));
  }
  eq(g.sacRempli(A), 0, 'on peut toujours tout ranger, quel que soit le remplissage');
}

console.log('coffre_sac.test.js : ' + n + ' verifications OK');
