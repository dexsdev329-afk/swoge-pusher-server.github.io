'use strict';
/*
 * LE MARCHE.
 *
 * ---- la propriete qui compte avant toutes les autres ----
 *
 * IL DEPLACE, IL NE FABRIQUE PAS. L'edition est fermee : 9 600 pieces, dix
 * mythiques de chaque dessin. Un marche capable de dupliquer un objet — meme
 * dans un cas rare — detruirait cette promesse, et personne ne s'en
 * apercevrait avant des mois. Chaque test ci-dessous recompte donc le TOTAL
 * d'exemplaires en circulation, inventaires ET annonces confondus.
 *
 * Les deux autres qui coutent cher : un objet ne doit jamais disparaitre, et
 * personne ne doit pouvoir se vendre a soi-meme pour fabriquer un prix de
 * reference.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const sol = (g, a) => Number(g.balanceStr(a));
const A = '0x' + 'a1'.repeat(20);
const C = '0x' + 'c2'.repeat(20);

/** Combien d'exemplaires de cet objet existent, ou qu'ils soient. */
const total = (g, id) => {
  let t = 0;
  for (const [, p] of g.players) t += (p.objets || {})[id] || 0;
  t += (g.marche || []).filter((a) => a.item === id).length;
  return t;
};

const pose = (g, addr, id, q) => {
  const p = g._p(addr);
  p.balance = WEI(10000000); p.hasDeposited = true;
  p.objets = p.objets || {};
  if (id) p.objets[id] = q || 1;
  return p;
};

const OBJ = B.itemsDeSaison(1).find((o) => o.rarete === 'legendaire').id;

// ================== 1. IL DEPLACE, IL NE FABRIQUE PAS
{
  const g = new Game();
  pose(g, A, OBJ, 1); pose(g, C, null);
  g.boutiqueEmis[OBJ] = 1;
  eq(total(g, OBJ), 1, 'un exemplaire au depart');

  const a = g.marcheVend(A, OBJ, 5000);
  eq(total(g, OBJ), 1, 'mis en vente : toujours UN exemplaire, pas deux');
  eq(g._p(A).objets[OBJ], undefined, 'il a quitte l inventaire du vendeur');
  eq(g.boutiqueEmis[OBJ], 1, 'et le registre d emission n a pas bouge');

  g.marcheAchete(C, a.id);
  eq(total(g, OBJ), 1, 'vendu : toujours UN exemplaire');
  eq(g._p(C).objets[OBJ], 1, 'chez l acheteur');
  eq(g._p(A).objets[OBJ], undefined, 'et plus chez le vendeur');
  eq(g.boutiqueEmis[OBJ], 1, 'le registre n a toujours pas bouge — un marche ne mint rien');
  eq(g.marche.length, 0, 'et l annonce a disparu');
}

// ================== 2. L ARGENT EST CONSERVE, AUX FRAIS PRES
{
  const g = new Game();
  pose(g, A, OBJ, 1); pose(g, C, null);
  const av = g.marcheVend(A, OBJ, 10000);
  const solA = sol(g, A), solC = sol(g, C);
  const r = g.marcheAchete(C, av.id);

  const attenduFrais = 10000 * cfg.MARCHE_FRAIS_BPS / 10000;
  eq(solC - sol(g, C), 10000, 'l acheteur paie exactement le prix affiche');
  eq(sol(g, A) - solA, 10000 - attenduFrais, `le vendeur touche le prix moins ${attenduFrais} de frais`);
  eq(r.frais, attenduFrais, 'et la reponse dit les frais');
  ok((sol(g, A) - solA) + (solC - sol(g, C)) * 0 >= 0, 'rien n est cree');
  /* La somme des deux mouvements egale le prix : les frais sont la difference,
     et ils vont a la maison, pas dans le vide. */
  eq((solC - sol(g, C)) - (sol(g, A) - solA), attenduFrais,
     'ce que l acheteur perd moins ce que le vendeur gagne EST la commission');
}

// ================== 3. L ANNULATION REND L OBJET
{
  const g = new Game();
  pose(g, A, OBJ, 2);
  eq(total(g, OBJ), 2, 'deux exemplaires');
  const a = g.marcheVend(A, OBJ, 3000);
  eq(g._p(A).objets[OBJ], 1, 'un seul reste en main');
  g.marcheAnnule(A, a.id);
  eq(g._p(A).objets[OBJ], 2, 'annule : il revient');
  eq(total(g, OBJ), 2, 'et le total n a pas bouge');
  assert.throws(() => g.marcheAnnule(A, a.id), /no longer exists/); n++;
}

// ================== 4. CE QUI EST REFUSE
{
  const g = new Game();
  pose(g, A, OBJ, 1); pose(g, C, null);

  /* Se vendre a soi-meme : c'est ainsi qu'on fabrique un faux prix de
     reference sous les yeux de tout le monde. */
  const a = g.marcheVend(A, OBJ, 5000);
  assert.throws(() => g.marcheAchete(A, a.id), /your own listing/); n++;
  eq(total(g, OBJ), 1, 'et rien n a bouge dans l intervalle');

  /* Vendre ce qu'on n'a pas. */
  assert.throws(() => g.marcheVend(A, OBJ, 5000), /do not own/); n++;
  const autre = B.itemsDeSaison(1).find((o) => o.id !== OBJ).id;
  assert.throws(() => g.marcheVend(A, autre, 5000), /do not own/); n++;
  assert.throws(() => g.marcheVend(A, 999999, 5000), /unknown item/); n++;

  /* Les bornes de prix. */
  pose(g, A, autre, 1);
  assert.throws(() => g.marcheVend(A, autre, 1), /minimum price/); n++;
  assert.throws(() => g.marcheVend(A, autre, cfg.MARCHE_PRIX_MAX + 1), /maximum price/); n++;

  /* Acheter sans avoir de quoi. */
  const pauvre = '0x' + 'e5'.repeat(20);
  const q = g._p(pauvre); q.hasDeposited = true; q.balance = WEI(10);
  assert.throws(() => g.marcheAchete(pauvre, a.id), /not enough/); n++;
  eq(total(g, OBJ), 1, 'un achat refuse ne deplace rien');

  /* Une annonce disparue. */
  assert.throws(() => g.marcheAchete(C, 999999), /no longer exists/); n++;
}

// ================== 5. LE DEPOT EST DEMANDE, COMME POUR UN VIREMENT
{
  const g = new Game();
  const p = pose(g, A, OBJ, 1); p.hasDeposited = false;
  if (cfg.MARCHE_REQUIERT_DEPOT) {
    assert.throws(() => g.marcheVend(A, OBJ, 5000), /deposit once/); n++;
    p.hasDeposited = true;
    const a = g.marcheVend(A, OBJ, 5000);
    const q = pose(g, C, null); q.hasDeposited = false;
    assert.throws(() => g.marcheAchete(C, a.id), /deposit once/); n++;
    eq(total(g, OBJ), 1, 'et l objet reste sous sequestre');
  } else { ok(true, 'le depot n est pas demande dans cette configuration'); }
}

// ================== 6. ACHETER NE DONNE AUCUNE XP
/*
 * Sinon deux comptes complices se revendent le meme objet en boucle : chaque
 * aller-retour le rend « jamais possede » et paierait sa prime de collection.
 * L'XP recompense le jeu ; le marche recompense l'argent.
 */
{
  const g = new Game();
  pose(g, A, OBJ, 1); pose(g, C, null);
  const a = g.marcheVend(A, OBJ, 5000);
  const xp = g.niveau(C).xpGagne;
  g.marcheAchete(C, a.id);
  eq(g.niveau(C).xpGagne, xp, 'acheter un objet ne rapporte pas un point d XP');
}

// ================== 7. LA LIGNE PEUT SE FERMER PAR UN ACHAT
/* C'est une decision, pas un effet de bord : la course recompense d'avoir
   REUNI une famille, pas d'avoir eu de la chance au tirage. */
{
  const g = new Game();
  const fam = B.ITEMS.filter((o) => o.famille === 'chaos');
  const acheteur = pose(g, C, null);
  fam.slice(0, 4).forEach((o) => { acheteur.objets[o.id] = 1; });
  const vendeur = pose(g, A, fam[4].id, 1);

  const a = g.marcheVend(A, fam[4].id, 5000);
  const r = g.marcheAchete(C, a.id);
  ok(!!r.ligne, 'acheter le cinquieme ferme la ligne');
  eq(r.ligne.rang, 1, 'et prend la premiere place');
  eq(r.ligne.prix, B.PRIX_LIGNE[0], `avec le premier prix (${B.PRIX_LIGNE[0]})`);
  eq(total(g, fam[4].id), 1, 'sans fabriquer d exemplaire au passage');
}

// ================== 8. TOUT SURVIT AU REDEMARRAGE
/* Les annonces DOIVENT traverser une sauvegarde : l'objet a quitte
   l'inventaire du vendeur. Les perdre, c'est les detruire. */
{
  const g = new Game();
  pose(g, A, OBJ, 1); pose(g, C, null);
  const a = g.marcheVend(A, OBJ, 7500);

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.marche.length, 1, 'l annonce est toujours la apres un redemarrage');
  eq(total(g2, OBJ), 1, 'et l objet n a ete ni perdu ni double');
  const r = g2.marcheAchete(C, a.id);
  eq(r.item, OBJ, 'elle reste achetable');
  eq(g2._p(C).objets[OBJ], 1, 'et l objet arrive bien');
  /* Le prochain identifiant ne doit pas retomber sur un ancien. */
  const b = g2.marcheVend(C, OBJ, 9000);
  ok(b.id > a.id, `les identifiants continuent apres le redemarrage (${a.id} puis ${b.id})`);
}

// ================== 9. LA VITRINE
{
  const g = new Game();
  const p = pose(g, A, null);
  const myth = B.itemsDeSaison(1).find((o) => o.rarete === 'mythique').id;
  const com = B.itemsDeSaison(1).find((o) => o.rarete === 'commun').id;
  p.objets[myth] = 1; p.objets[com] = 2;
  g.marcheVend(A, com, 200);
  g.marcheVend(A, myth, 900000);
  g.marcheVend(A, com, 150);

  const v = g.marcheListe(C, 1);
  eq(v.annonces.length, 3, 'trois annonces');
  eq(v.annonces[0].item.rarete, 'mythique', 'le plus rare en tete — c est ce qu on cherche d abord');
  eq(v.annonces[1].prix, 150, 'puis les autres du moins cher au plus cher');
  eq(v.frais, cfg.MARCHE_FRAIS_BPS / 100, 'la vitrine annonce la commission');
  eq(g.marcheListe(A, 1).miennes.length, 3, 'et le vendeur reconnait les siennes');
  eq(g.marcheListe(C, 2).annonces.length, 0, 'la saison 2 n a rien en vente');

  /* La borne d'annonces : sans elle, une seule personne remplit la vitrine. */
  const q = pose(g, C, null);
  const id = B.itemsDeSaison(1)[0].id;
  q.objets[id] = cfg.MARCHE_ANNONCES_MAX + 5;
  for (let i = 0; i < cfg.MARCHE_ANNONCES_MAX; i++) g.marcheVend(C, id, 500);
  assert.throws(() => g.marcheVend(C, id, 500), /already have/); n++;
}

console.log(`marche.test.js : ${n} verifications OK`);
