'use strict';
/*
 * LE PERSONNAGE — l'integration dans game.js.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. ON NE PROGRESSE QUE LE SKIN QU'ON PORTE. Jouer avec Landwolf actif ne
 *    fait pas monter Pepe — c'est la promesse de « progression par classe »,
 *    et c'est le test qui la garantit.
 * 2. ON NE PEUT NI LIRE NI EQUIPER UN SKIN QU'ON NE POSSEDE PAS.
 * 3. LE FRUIT VA DANS LE SLOT FRUIT, L'ARME DANS LE SLOT ARME — jamais
 *    l'inverse, meme si l'appelant se trompe de methode.
 * 4. LE BONUS D'EQUIPEMENT NE TOUCHE QUE SA PROPRE STAT.
 * 5. TOUT survit au redemarrage : volume, niveau, equipement.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const P = require('./personnages');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0x' + 'a1'.repeat(20);

const pose = (g, addr, credit) => {
  const p = g._p(addr);
  p.balance = WEI(credit === undefined ? 100000000 : credit);
  p.hasDeposited = true;
  return p;
};
const mise = (g, p, montant, jeu) => g._markWager(p, WEI(montant), jeu || 'plinko');

// ================== 1. UN SKIN NON POSSEDE N'A PAS DE FICHE
{
  const g = new Game();
  pose(g, A);
  eq(g.personnageEtat(A, 'pepe'), null, 'aucune fiche pour un skin jamais achete');
}

// ================== 2. LE NIVEAU SUIT LE VOLUME MISE SOUS CE SKIN
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'landwolf');       // devient actif
  const av = g.personnageEtat(A, 'landwolf');
  eq(av.niveau, 0, 'niveau 0 sans avoir mise sous ce skin');
  eq(av.volume, 0);

  mise(g, p, P.volumePour(10));      // exactement de quoi atteindre le niveau 10
  const ap = g.personnageEtat(A, 'landwolf');
  eq(ap.niveau, 10, 'le niveau attendu, exactement');
}

// ================== 3. ISOLATION STRICTE ENTRE LES SKINS
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'andy');           // actif = andy
  g.acheteSkin(A, 'pepe');           // actif = pepe

  mise(g, p, P.volumePour(15));      // sous pepe, l actif du moment
  eq(g.personnageEtat(A, 'pepe').niveau, 15, 'pepe (actif) a bien progresse');
  eq(g.personnageEtat(A, 'andy').niveau, 0, 'andy (pas actif) n a pas bouge d un niveau');

  g.choisitSkin(A, 'andy');          // on change d actif
  mise(g, p, P.volumePour(5));
  eq(g.personnageEtat(A, 'andy').niveau, 5, 'andy progresse maintenant qu il est porte');
  eq(g.personnageEtat(A, 'pepe').niveau, 15, 'pepe n a pas bouge pendant ce temps');
}

// ================== 4. UNE MISE SANS SKIN ACTIF NE CASSE RIEN
{
  const g = new Game();
  const p = pose(g, A);
  eq(p.skinActif || null, null, 'personne ne porte rien');
  mise(g, p, 500000);                // ne doit pas jeter
  ok(true, 'une mise sans skin actif ne leve aucune exception');
  eq(Object.keys(p.persos || {}).length, 0, 'et ne cree aucune fiche de personnage');
}

// ================== 5. EQUIPER CE QU'ON NE POSSEDE PAS EST REFUSE
{
  const g = new Game();
  pose(g, A);
  g.acheteSkin(A, 'claude');
  const fruit = B.itemsDeSaison(1)[0];
  assert.throws(() => g.equipeFruit(A, 'claude', fruit.id), /do not own this item/,
                'refuse un fruit qu on ne possede pas');
  n++;
}

// ================== 6. UN SKIN NON POSSEDE NE S'EQUIPE PAS NON PLUS
{
  const g = new Game();
  const p = pose(g, A);
  const fruit = B.itemsDeSaison(1)[0];
  p.objets[fruit.id] = 1;
  assert.throws(() => g.equipeFruit(A, 'ogswoge', fruit.id), /do not own this skin/,
                'refuse d equiper un skin jamais achete');
  n++;
}

// ================== 7. LE FRUIT VA AU SLOT FRUIT, L'ARME AU SLOT ARME
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'brett');
  const fruit = B.itemsDeSaison(1)[0];
  const arme = B.itemsDeSaison(2)[0];
  p.objets[fruit.id] = 1; p.objets[arme.id] = 1;

  assert.throws(() => g.equipeFruit(A, 'brett', arme.id), /not a fruit/,
                'le slot fruit refuse une arme');
  n++;
  assert.throws(() => g.equipeArme(A, 'brett', fruit.id), /not a weapon/,
                'le slot arme refuse un fruit');
  n++;

  const r1 = g.equipeFruit(A, 'brett', fruit.id);
  eq(r1.equipFruit.item, fruit.id, 'le bon fruit est equipe');
  const r2 = g.equipeArme(A, 'brett', arme.id);
  eq(r2.equipArme.item, arme.id, 'la bonne arme est equipee');

  /* La couleur de la case d'equipement vient de la MEME rarete que le
     catalogue — sinon un legendaire s'affiche avec la bordure d'un
     commun, et la page ment sur ce qu'on porte. */
  const raretF = B.rarete(fruit.rarete), raretA = B.rarete(arme.rarete);
  eq(r1.equipFruit.rarete, fruit.rarete, 'la rarete du fruit equipe est rendue');
  eq(r1.equipFruit.couleur, raretF.couleur, 'et sa couleur suit celle du catalogue');
  eq(r2.equipArme.rarete, arme.rarete);
  eq(r2.equipArme.couleur, raretA.couleur);
}

// ================== 8. DESEQUIPER REND LE SLOT VIDE
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'ogswoge');
  const fruit = B.itemsDeSaison(1)[0];
  p.objets[fruit.id] = 1;
  g.equipeFruit(A, 'ogswoge', fruit.id);
  ok(g.personnageEtat(A, 'ogswoge').equipFruit, 'equipe');
  const r = g.equipeFruit(A, 'ogswoge', null);
  eq(r.equipFruit, null, 'desequipe avec null');
  eq(g.personnageEtat(A, 'ogswoge').equipFruit, null, 'et ca tient a la relecture');
}

// ================== 9. LE BONUS NE TOUCHE QUE SA PROPRE STAT
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'pepe');
  const avant = g.personnageEtat(A, 'pepe').stats;

  const fruit = B.itemsDeSaison(1).find((o) => o.rarete === 'mythique');
  p.objets[fruit.id] = 1;
  const stat = P.FAMILLE_STAT[fruit.famille];
  const apres = g.equipeFruit(A, 'pepe', fruit.id).stats;

  P.STATS.forEach((s) => {
    if (s === stat) ok(apres[s] > avant[s], `${s} (la stat visee) a bien augmente`);
    else eq(apres[s], avant[s], `${s} n a pas bouge — ce n est pas la stat visee`);
  });
}

// ================== 10. TOUT SURVIT AU REDEMARRAGE
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'landwolf');
  mise(g, p, P.volumePour(8));
  const fruit = B.itemsDeSaison(1)[0];
  const arme = B.itemsDeSaison(2)[0];
  p.objets[fruit.id] = 1; p.objets[arme.id] = 1;
  g.equipeFruit(A, 'landwolf', fruit.id);
  g.equipeArme(A, 'landwolf', arme.id);
  const avant = g.personnageEtat(A, 'landwolf');

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  const apres = g2.personnageEtat(A, 'landwolf');

  eq(apres.niveau, avant.niveau, 'le niveau traverse le redemarrage');
  eq(apres.volume, avant.volume, 'le volume aussi');
  eq(apres.equipFruit.item, fruit.id, 'le fruit equipe aussi');
  eq(apres.equipArme.item, arme.id, 'et l arme aussi');
  eq(JSON.stringify(apres.stats), JSON.stringify(avant.stats), 'les stats recalculees sont identiques');
}

// ================== 11. LES SIX SKINS SONT TOUS JOUABLES DE BOUT EN BOUT
{
  const g = new Game();
  const p = pose(g, A);
  const S = require('./skins');
  S.catalogue().forEach((s) => {
    g.acheteSkin(A, s.id);           // devient actif
    mise(g, p, P.volumePour(3));
    const e = g.personnageEtat(A, s.id);
    eq(e.niveau, 3, `${s.id} : niveau 3 atteint sous son propre volume`);
  });
}

// ================== 12. equipablesPour() : SEULEMENT CE QU'ON POSSEDE
{
  const g = new Game();
  const p = pose(g, A);
  eq(g.equipablesPour(A).fruits.length, 0, 'rien possede, rien a equiper');
  eq(g.equipablesPour(A).armes.length, 0);

  const fruit = B.itemsDeSaison(1)[0];
  const arme = B.itemsDeSaison(2)[0];
  p.objets[fruit.id] = 2; p.objets[arme.id] = 1;
  const eq1 = g.equipablesPour(A);
  eq(eq1.fruits.length, 1, 'le fruit possede apparait');
  eq(eq1.armes.length, 1, 'l arme possedee apparait');
  eq(eq1.fruits[0].id, fruit.id);
  eq(eq1.fruits[0].quantite, 2, 'la quantite possedee est rendue');
  eq(eq1.fruits[0].stat, P.FAMILLE_STAT[fruit.famille], 'la stat visee vient de la meme table que le bonus reel');
  eq(eq1.fruits[0].bonus, P.bonusDe(fruit.rarete, (r) => { const x = B.rarete(r); return x ? x.plafond : 0; }),
     'le bonus annonce est celui qui sera vraiment applique');
}

// ================== 13. equipablesPour() : ETANCHE A LA SAISON PARCOURUE
{
  /* La boutique peut etre ouverte sur n importe quelle saison au moment de
     l appel — equipablesPour() ne prend aucun parametre de saison et doit
     toujours rendre fruits ET armes possedes, les deux a la fois. */
  const g = new Game();
  const p = pose(g, A);
  const fruit = B.itemsDeSaison(1)[0];
  const arme = B.itemsDeSaison(2)[0];
  p.objets[fruit.id] = 1; p.objets[arme.id] = 1;
  const r = g.equipablesPour(A);
  ok(r.fruits.length === 1 && r.armes.length === 1, 'les deux saisons sont rendues ensemble, sans etre demandees');
}

console.log(`perso.test.js : ${n} verifications OK`);
