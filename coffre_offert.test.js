'use strict';
/*
 * LE COFFRE DU JOUR.
 *
 * Trois regles a tenir, et elles ne se valent pas :
 *   — un par jour : evidente, et c'est celle qu'un test attrape le plus mal
 *     parce qu'il faut faire passer minuit ;
 *   — il NE S'ACCUMULE PAS : trois jours manques ne font pas trois coffres ;
 *   — manquer un jour NE PUNIT PAS : celui d'aujourd'hui est la quand meme.
 *
 * Les deux dernieres sont des regles de PRODUIT, pas de code : elles ne se
 * lisent nulle part dans une signature, et rien ne les protege a part ce
 * fichier. C'est exactement ce qu'un test doit tenir.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const A = '0x' + 'f1'.repeat(20);

/* Faire passer les jours : `_today` est le seul point qui les decide, on le
   deplace plutot que d'attendre minuit. */
const jour = (g, d) => { g._today = () => d; };

// ---- 1. il s'ouvre sans un jeton, et il ne coute rien
{
  const g = new Game(); jour(g, '2026-01-01');
  const p = g._p(A);
  eq(p.balance.toString(), '0', 'le joueur n a rien');
  ok(g.coffreOffert(A).dispo, 'le coffre du jour est la');
  const r = g.ouvreCoffreOffert(A);
  ok(!!r.item, `il rend un objet (${r.item.nom})`);
  eq(r.gratuit, true, 'et il est marque gratuit');
  eq(p.balance.toString(), '0', 'RIEN n a ete debite — un solde a zero suffit');
  eq(B.item(r.item.id).saison, 1, 'c est un fruit de la saison 1');
  ok(r.xp > 0, `et il fait monter l XP (${r.xp})`);
}

// ---- 2. un par jour
{
  const g = new Game(); jour(g, '2026-01-01');
  g.ouvreCoffreOffert(A);
  eq(g.coffreOffert(A).dispo, false, 'il n est plus disponible aujourd hui');
  assert.throws(() => g.ouvreCoffreOffert(A), /already open/); n++;
}

// ---- 3. IL NE S'ACCUMULE PAS, ET MANQUER NE PUNIT PAS
{
  const g = new Game(); jour(g, '2026-01-01');
  g.ouvreCoffreOffert(A);
  const inv1 = Object.values(g._p(A).objets).reduce((a, b) => a + b, 0);

  /* Trois jours d'absence. */
  jour(g, '2026-01-05');
  ok(g.coffreOffert(A).dispo, 'apres trois jours manques, celui du jour est la — l absence ne punit pas');
  g.ouvreCoffreOffert(A);
  const inv2 = Object.values(g._p(A).objets).reduce((a, b) => a + b, 0);
  eq(inv2 - inv1, 1,
     'UN SEUL coffre, pas quatre : les jours manques ne se rattrapent pas');
  eq(g.coffreOffert(A).dispo, false, 'et il est repris pour la journee');

  jour(g, '2026-01-06');
  ok(g.coffreOffert(A).dispo, 'et le lendemain il y en a un autre, comme tous les jours');
}

// ---- 4. il compte dans les plafonds comme n'importe quel coffre
{
  const g = new Game(); jour(g, '2026-01-01');
  const avant = Object.values(g.boutiqueEmis || {}).reduce((a, b) => a + b, 0);
  const r = g.ouvreCoffreOffert(A);
  const apres = Object.values(g.boutiqueEmis).reduce((a, b) => a + b, 0);
  eq(apres - avant, 1, 'le registre global monte : un objet offert sort de l edition comme un autre');
  eq(g.boutiqueEmis[r.item.id], 1, 'et c est bien celui-la qui a ete emis');
}

// ---- 5. il n'est PAS compte comme du revenu
{
  const g = new Game(); jour(g, '2026-01-01');
  const avant = JSON.stringify(g.revenus || {});
  g.ouvreCoffreOffert(A);
  eq(JSON.stringify(g.revenus || {}), avant,
     'un cadeau n est pas un revenu — sinon il gonfle le chiffre d affaires et le prix du classement qui en est une part');
}

// ---- 6. la marque survit au redemarrage
{
  const g = new Game(); jour(g, '2026-01-01');
  g.ouvreCoffreOffert(A);
  const g2 = new Game(); jour(g2, '2026-01-01');
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.coffreOffert(A).dispo, false,
     'apres un redemarrage il reste pris — sans ca, redemarrer le serveur redistribue un coffre a tout le monde');
  jour(g2, '2026-01-02');
  eq(g2.coffreOffert(A).dispo, true, 'et le lendemain il revient');
}

// ---- 7. la pastille compte ce qui se reclame, et rien d'autre
{
  const g = new Game(); jour(g, '2026-01-01');
  const a1 = g.enAttente(A);
  ok(a1.coffre, 'le coffre du jour allume la pastille');
  ok(a1.total >= 1, `total ${a1.total}`);
  g.ouvreCoffreOffert(A);
  eq(g.enAttente(A).coffre, false, 'une fois pris, il ne l allume plus');
  const a2 = g.enAttente(A);
  eq(typeof a2.total, 'number', 'le total reste un nombre');
  ok(a2.total < a1.total, 'et il a baisse');
}

console.log(`coffre_offert.test.js : ${n} verifications OK`);
