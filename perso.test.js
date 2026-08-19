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
  eq(eq1.fruits[0].bonus, P.bonusDe(fruit.rarete, P.FAMILLE_STAT[fruit.famille]),
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

// ================== 14. L'ARMURE VA AU SLOT ARMURE, LA BAGUE AU SLOT BAGUE
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'claude');
  const armure = B.itemsDeSaison(3)[0];
  const bague = B.itemsDeSaison(4)[0];
  p.objets[armure.id] = 1; p.objets[bague.id] = 1;

  assert.throws(() => g.equipeArmure(A, 'claude', bague.id), /not an armor/,
                'le slot armure refuse une bague');
  n++;
  assert.throws(() => g.equipeBague(A, 'claude', armure.id), /not a ring/,
                'le slot bague refuse une armure');
  n++;

  const r1 = g.equipeArmure(A, 'claude', armure.id);
  eq(r1.equipArmure.item, armure.id, 'la bonne piece d armure est equipee');
  const r2 = g.equipeBague(A, 'claude', bague.id);
  eq(r2.equipBague.item, bague.id, 'la bonne bague est equipee');
  eq(r1.equipArmure.rarete, armure.rarete);
  eq(r2.equipBague.rarete, bague.rarete);
}

// ================== 15. LES QUATRE EMPLACEMENTS TIENNENT ENSEMBLE, ET SEPAREMENT
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'pepe');
  const avant = g.personnageEtat(A, 'pepe').stats;

  const armure = B.itemsDeSaison(3).find((o) => o.rarete === 'mythique');
  p.objets[armure.id] = 1;
  const stat = P.FAMILLE_STAT[armure.famille];
  const apres = g.equipeArmure(A, 'pepe', armure.id).stats;

  P.STATS.forEach((s) => {
    if (s === stat) ok(apres[s] > avant[s], `${s} (la stat visee par l armure) a bien augmente`);
    else eq(apres[s], avant[s], `${s} n a pas bouge — ce n est pas la stat visee`);
  });

  // et le desequipement rend le slot vide sans toucher aux trois autres
  const bague = B.itemsDeSaison(4)[0];
  p.objets[bague.id] = 1;
  g.equipeBague(A, 'pepe', bague.id);
  const r = g.equipeArmure(A, 'pepe', null);
  eq(r.equipArmure, null, 'desequipe l armure avec null');
  ok(r.equipBague, 'la bague, elle, reste en place');
}

// ================== 16. TOUT SURVIT AU REDEMARRAGE, LES QUATRE EMPLACEMENTS COMPRIS
{
  const g = new Game();
  const p = pose(g, A);
  g.acheteSkin(A, 'brett');
  const fruit = B.itemsDeSaison(1)[0], arme = B.itemsDeSaison(2)[0];
  const armure = B.itemsDeSaison(3)[0], bague = B.itemsDeSaison(4)[0];
  [fruit, arme, armure, bague].forEach((o) => { p.objets[o.id] = 1; });
  g.equipeFruit(A, 'brett', fruit.id);
  g.equipeArme(A, 'brett', arme.id);
  g.equipeArmure(A, 'brett', armure.id);
  g.equipeBague(A, 'brett', bague.id);
  const avant = g.personnageEtat(A, 'brett');

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  const apres = g2.personnageEtat(A, 'brett');

  eq(apres.equipFruit.item, fruit.id);
  eq(apres.equipArme.item, arme.id);
  eq(apres.equipArmure.item, armure.id, 'l armure traverse le redemarrage');
  eq(apres.equipBague.item, bague.id, 'la bague aussi');
  eq(JSON.stringify(apres.stats), JSON.stringify(avant.stats), 'les stats recalculees sont identiques');
}

// ================== 17. equipablesPour() COUVRE LES QUATRE SAISONS A LA FOIS
{
  const g = new Game();
  const p = pose(g, A);
  eq(g.equipablesPour(A).armures.length, 0);
  eq(g.equipablesPour(A).bagues.length, 0);

  const armure = B.itemsDeSaison(3)[0], bague = B.itemsDeSaison(4)[0];
  p.objets[armure.id] = 3; p.objets[bague.id] = 1;
  const r = g.equipablesPour(A);
  eq(r.armures.length, 1, 'la piece d armure possedee apparait');
  eq(r.bagues.length, 1, 'la bague possedee apparait');
  eq(r.armures[0].quantite, 3);
  eq(r.armures[0].stat, P.FAMILLE_STAT[armure.famille]);
}

// ================== 18. LA MORT : CE QU'ON PORTAIT EST PERDU, LE COFFRE RESTE
//
// C'est la regle qui DETRUIT des objets payes en $SWOGE. Elle merite donc
// d'etre tenue par les deux bouts : ce qui doit disparaitre disparait
// vraiment, et surtout ce qui doit rester ne bouge pas d'un exemplaire.
// Un test qui ne verifierait que la perte laisserait passer le bug le plus
// couteux — celui qui vide le coffre en meme temps que l'equipement.
{
  const g = new Game();
  const p = pose(g, A);
  p.skins = { pepe: true, andy: true };

  const fruit = B.itemsDeSaison(1)[0], arme = B.itemsDeSaison(2)[0];
  const armure = B.itemsDeSaison(3)[0], bague = B.itemsDeSaison(4)[0];
  const range = B.itemsDeSaison(1)[1];          // jamais porte : temoin du coffre

  /* Le fruit est possede en TROIS exemplaires et un seul est porte : c'est
     le cas qui distingue « retirer un exemplaire » de « effacer la ligne ». */
  p.objets[fruit.id] = 3;
  p.objets[arme.id] = 1;
  p.objets[armure.id] = 1;
  p.objets[bague.id] = 1;
  p.objets[range.id] = 2;

  g.equipeFruit(A, 'pepe', fruit.id);
  g.equipeArme(A, 'pepe', arme.id);
  g.equipeArmure(A, 'pepe', armure.id);
  g.equipeBague(A, 'pepe', bague.id);
  /* Le volume mise s'accumule sur le skin PORTE : il faut donc le poser
     avant de miser, sinon la mise ne compte pour aucun personnage et le
     test « il retombe a 0 » ne prouverait rien — il partirait deja de 0. */
  p.skinActif = 'pepe';
  mise(g, p, P.volumePour(12));
  ok(g.personnageEtat(A, 'pepe').niveau > 0, 'le personnage a bien un niveau avant de mourir');

  const r = g.meurt(A, 'pepe');

  eq(r.perdus.length, 4, 'les quatre objets portes sont annonces perdus');
  ok(r.perdus.every((o) => o.nom), 'et chacun est nomme, pour pouvoir le dire au joueur');

  const etat = g.personnageEtat(A, 'pepe');
  eq(etat.niveau, 0, 'le personnage repart au niveau 0');
  eq(etat.equipFruit, null, 'l emplacement du fruit est vide');
  eq(etat.equipArme, null, 'celui de l arme aussi');
  eq(etat.equipArmure, null, 'celui de l armure aussi');
  eq(etat.equipBague, null, 'celui de la bague aussi');

  // ---- CE QUI RESTE : le coeur de la regle
  eq(p.objets[fruit.id], 2, 'le fruit en triple n en perd QU UN : il en reste deux au coffre');
  eq(p.objets[arme.id], undefined, 'l arme unique portee disparait du coffre');
  eq(p.objets[armure.id], undefined, 'l armure unique portee aussi');
  eq(p.objets[bague.id], undefined, 'la bague unique portee aussi');
  eq(p.objets[range.id], 2, 'et l objet JAMAIS porte n a pas bouge d un exemplaire');

  // ---- la mort d'un personnage ne touche pas les autres
  const g2 = new Game();
  const p2 = pose(g2, A);
  p2.skins = { pepe: true, andy: true };
  p2.objets[fruit.id] = 1;
  const autre = B.itemsDeSaison(1)[2];
  p2.objets[autre.id] = 1;
  g2.equipeFruit(A, 'pepe', fruit.id);
  g2.equipeFruit(A, 'andy', autre.id);
  g2.meurt(A, 'pepe');
  eq(g2.personnageEtat(A, 'andy').equipFruit.item, autre.id,
     'le fruit de l AUTRE personnage est toujours equipe');
  eq(p2.objets[autre.id], 1, 'et toujours au coffre');

  // ---- mourir sans rien porter, et mourir deux fois
  const g3 = new Game();
  const p3 = pose(g3, A);
  p3.skins = { pepe: true };
  const r3 = g3.meurt(A, 'pepe');
  eq(r3.perdus.length, 0, 'un personnage jamais joue ne perd rien');
  const r4 = g3.meurt(A, 'pepe');
  eq(r4.perdus.length, 0, 'et mourir une seconde fois ne perd rien non plus');

  let err = null;
  try { g3.meurt(A, 'brett'); } catch (e) { err = e.message; }
  ok(/do not own this skin/.test(err || ''), 'on ne peut pas faire mourir un skin qu on ne possede pas');
}

// ================== 19. LA FAME : ELLE NE SE TOUCHE QU'EN MOURANT
//
// Deux taux, cassure au plafond de niveau, et un seul moment ou elle passe
// du personnage au compte. Le piege qu'on cherche en priorite : que la Fame
// AFFICHEE sur la fiche ne soit pas celle qui est VERSEE a la mort — deux
// calculs qui divergent, et le joueur recoit autre chose que ce qu'il voyait.
{
  const plafond = P.xpPour(P.NIVEAU_MAX);

  // ---- la courbe elle-meme
  eq(P.fameDeXp(0), 0, 'aucune XP, aucune Fame');
  eq(P.fameDeXp(P.XP_PAR_FAME - 1), 0, 'juste sous le premier point, toujours zero');
  eq(P.fameDeXp(P.XP_PAR_FAME), 1, 'le premier point tombe au premier palier');
  eq(P.fameDeXp(plafond), Math.floor(plafond / P.XP_PAR_FAME),
     'au plafond, tout a ete compte au premier taux');
  /* LA CASSURE NE DOIT PAS FAIRE CHUTER LA FAME. Repartir de zero au-dela
     punirait d'avoir progresse — c'est l'erreur classique d'un bareme a
     deux taux, et elle ne se voit qu'au passage exact du seuil. */
  ok(P.fameDeXp(plafond + 1) >= P.fameDeXp(plafond),
     'franchir le plafond ne fait JAMAIS reculer la Fame');
  eq(P.fameDeXp(plafond + P.XP_PAR_FAME_APRES), P.fameDeXp(plafond) + 1,
     'au-dela, il faut le second taux pour gagner un point');
  ok(P.XP_PAR_FAME_APRES > P.XP_PAR_FAME,
     'et ce second taux est bien plus lent que le premier');
  /* Monotone : plus d'XP ne doit jamais rendre moins de Fame, nulle part. */
  let precedent = -1, monotone = true;
  for (let x = 0; x < plafond * 3; x += 617) {
    const f = P.fameDeXp(x);
    if (f < precedent) monotone = false;
    precedent = f;
  }
  ok(monotone, 'la Fame ne recule sur aucun palier de la courbe');

  // ---- du personnage au compte
  const g = new Game();
  const p = pose(g, A);
  p.skins = { pepe: true };
  p.skinActif = 'pepe';
  mise(g, p, P.volumePour(15));

  const avant = g.personnageEtat(A, 'pepe');
  ok(avant.fame > 0, `le personnage vivant a accumule de la Fame (${avant.fame})`);
  eq(avant.fameCompte, 0, 'mais le compte, lui, n en a encore aucune');

  const r = g.meurt(A, 'pepe');
  eq(r.fameGagnee, avant.fame,
     'la Fame VERSEE est exactement celle qui etait AFFICHEE sur la fiche');
  eq(r.fameTotale, avant.fame, 'et elle atterrit au total du compte');
  eq(p.fame, avant.fame, 'qui est bien stocke sur la fiche du joueur');

  const apres = g.personnageEtat(A, 'pepe');
  eq(apres.fame, 0, 'le personnage repart sans Fame');
  eq(apres.fameCompte, avant.fame, 'pendant que le compte garde la sienne');

  // ---- elle S'ACCUMULE : deux vies, deux versements
  mise(g, p, P.volumePour(10));
  const deuxieme = g.personnageEtat(A, 'pepe').fame;
  ok(deuxieme > 0, 'la nouvelle vie regagne de la Fame');
  const r2 = g.meurt(A, 'pepe');
  eq(r2.fameTotale, avant.fame + deuxieme,
     'la seconde mort AJOUTE au total, elle ne le remplace pas');

  // ---- mourir sans rien n'invente pas de Fame
  const g2 = new Game();
  const p2 = pose(g2, A);
  p2.skins = { pepe: true };
  eq(g2.meurt(A, 'pepe').fameGagnee, 0, 'un personnage jamais joue ne verse rien');
  eq(p2.fame || 0, 0, 'et le compte reste a zero');

  /* ---- ELLE SURVIT AU REDEMARRAGE ----
   *
   * La Fame du compte ne se deduit de RIEN : c'est la somme de morts
   * passees. Si elle ne part pas au fichier, elle s'evapore au premier
   * redemarrage — et personne ne s'en apercevrait avant d'avoir perdu des
   * mois de jeu. C'est le seul chiffre de ce systeme qui doit etre ecrit. */
  const g3 = new Game();
  g3.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g3._p(A).fame, p.fame, 'le total de Fame du compte traverse le redemarrage');
  eq(g3.personnageEtat(A, 'pepe').fameCompte, p.fame,
     'et la fiche le rend toujours apres relecture');
}

console.log(`perso.test.js : ${n} verifications OK`);
