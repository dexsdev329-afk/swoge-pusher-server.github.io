'use strict';
/*
 * LES POTIONS.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. ELLES NE SONT PAS DES OBJETS DE COFFRE. Pas de rarete, pas de plafond,
 *    pas de tirage — et surtout elles ne comptent PAS dans les exemplaires
 *    emis ni dans la collection. Les y mettre serait deux mensonges.
 * 2. ON PAIE CE QU'ON RECOIT. Ni plus, ni moins, et jamais a credit.
 * 3. QUATRE-VINGT-DIX-NEUF, PAS UNE DE PLUS. Et demander au-dela sert ce
 *    qu'il reste de place au lieu de tout refuser.
 * 4. BOIRE CONSOMME. Une potion bue n'est plus la.
 * 5. TOUT SURVIT AU REDEMARRAGE : elles sont payees en argent reel.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const leve = (f, motif, m) => { assert.throws(f, motif, m); n++; };
const A = '0x' + 'a1'.repeat(20);
const sol = (g) => Number(g.balanceStr(A));

function pose(credit) {
  const g = new Game();
  const p = g._p(A);
  p.balance = ethers.utils.parseUnits(String(credit === undefined ? 100000 : credit), cfg.DECIMALS);
  p.hasDeposited = true;
  return { g, p };
}

// ================== 1. LE CATALOGUE
{
  const { g } = pose();
  const l = g.potionsPour(A);
  eq(l.length, 2, 'deux potions, vie et mana');
  const vie = l.filter((x) => x.cle === 'vie')[0];
  eq(vie.prix, 10, 'dix $SWOGE');
  eq(vie.soigne, 100, 'cent points rendus');
  eq(vie.max, 99, 'quatre-vingt-dix-neuf au maximum');
  eq(vie.quantite, 0, 'on n en a aucune au depart');
  ok(l.every((x) => x.image), 'chacune a son dessin');
}

// ================== 2. ON PAIE CE QU'ON RECOIT
{
  const { g, p } = pose(1000);
  const avant = sol(g);
  const r = g.achetePotion(A, 'vie', 3);
  eq(r.livre, 3, 'trois potions livrees');
  eq(r.prix, 30, 'trente $SWOGE factures');
  eq(sol(g), avant - 30, 'et le solde a baisse d exactement trente');
  eq(p.potions.vie, 3, 'elles sont bien la');

  /* PAS A CREDIT. Un solde insuffisant refuse l achat en entier — on ne
     livre pas « ce qu on peut payer », ce serait une surprise. */
  const { g: g2, p: p2 } = pose(25);
  leve(() => g2.achetePotion(A, 'vie', 3), /Not enough/i, 'trois potions pour 25 $SWOGE : refuse');
  eq(sol(g2), 25, 'et le solde n a pas bouge');
  eq(Object.keys(p2.potions || {}).length, 0, 'aucune potion livree');
}

// ================== 3. LE PLAFOND SERT CE QU'IL RESTE
{
  const { g, p } = pose();
  g.achetePotion(A, 'vie', 95);
  const avant = sol(g);
  /* On en demande dix alors qu'il reste quatre places. On en livre QUATRE et
     on n en facture que quatre : refuser tout serait pedant, facturer dix
     serait du vol. */
  const r = g.achetePotion(A, 'vie', 10);
  eq(r.livre, 4, 'quatre livrees, pas dix');
  eq(r.prix, 40, 'et quarante factures, pas cent');
  eq(sol(g), avant - 40, 'le solde suit');
  eq(p.potions.vie, 99, 'on est au plafond');
  leve(() => g.achetePotion(A, 'vie', 1), /already carry 99/i, 'au plafond, on refuse');
}

// ================== 4. BOIRE CONSOMME
{
  const { g, p } = pose();
  g.achetePotion(A, 'vie', 2);
  const r = g.boitPotion(A, 'vie');
  eq(r.soigne, 100, 'la potion rend cent points');
  eq(r.quoi, 'hp', 'de vie');
  eq(p.potions.vie, 1, 'il en reste une');
  g.boitPotion(A, 'vie');
  eq(p.potions.vie, undefined, 'a zero, la ligne disparait');
  leve(() => g.boitPotion(A, 'vie'), /no Health Potion/i, 'et on ne boit pas ce qu on n a pas');
  leve(() => g.boitPotion(A, 'elixir'), /Unknown potion/i, 'une potion inexistante est refusee');
}

// ================== 5. ELLES NE TOUCHENT NI AU COFFRE NI AU PLAFOND
{
  const { g, p } = pose();
  g.achetePotion(A, 'vie', 5);
  g.achetePotion(A, 'mana', 5);
  eq(Object.keys(p.objets || {}).length, 0, 'rien n est entre au coffre');
  eq(Object.keys(p.sac || {}).length, 0, 'ni au sac');
  eq(Object.keys(g.boutiqueEmis || {}).length, 0,
    'et AUCUN exemplaire emis : une potion n a pas de plafond a manger');

  const eq2 = g.equipablesPour(A);
  ok(Array.isArray(eq2.potions), 'l inventaire porte les potions');
  eq(eq2.potions.filter((x) => x.cle === 'vie')[0].quantite, 5, 'avec leur nombre');
  eq(eq2.sac.length, 0, 'et le sac reste vide : ce sont deux places a part');
}

// ================== 6. LE VOYAGE PAR LE DISQUE
{
  const { g } = pose();
  g.achetePotion(A, 'vie', 7);
  g.achetePotion(A, 'mana', 3);
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  const l = g2.potionsPour(A);
  eq(l.filter((x) => x.cle === 'vie')[0].quantite, 7, 'les potions de vie reviennent du fichier');
  eq(l.filter((x) => x.cle === 'mana')[0].quantite, 3, 'celles de mana aussi');
}

console.log('potions.test.js : ' + n + ' verifications OK');
