'use strict';
/*
 * PORTER N'EST PAS POSSEDER.
 *
 * `p.objets` est le stock ; les quatre champs d'un personnage ne sont que des
 * DESIGNATIONS — porter, c'est etre pointe par quelqu'un qui peut mourir. Rien
 * ne reliait les deux, et il en sortait deux pannes qui touchent l'argent.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. UN EXEMPLAIRE, UN PORTEUR. Une piece unique ne peut pas habiller six
 *    personnages : la rarete annoncee — dix mythiques pour toute une saison —
 *    ne voudrait plus rien dire, et la mort n'en detruirait qu'une copie sur
 *    six.
 * 2. CE QU'ON PORTE NE SORT PAS DU COFFRE. Ni au marche, ni au rachat, ni au
 *    sac. Les deux premieres RAPPORTENT DE L'ARGENT : sans cette regle, on
 *    encaisse des $SWOGE reels et on garde l'arme, qui continue de frapper.
 *    Sur le rachat, c'est la maison qui paie.
 * 3. UN REFUS NE COUTE RIEN. Solde, stock et registre intacts.
 * 4. ON COMPTE LES EXEMPLAIRES, PAS LES OCCURRENCES. Celui qui en possede
 *    trois et en porte un doit pouvoir disposer des deux autres — la version
 *    d'avant refusait les trois.
 * 5. LES FICHES DEJA ECRITES SE REPARENT AU CHARGEMENT. Une garde qui ne
 *    regarde que l'avenir laisse en faute pour toujours les comptes qui le
 *    sont deja.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/equistock-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0x' + 'a1'.repeat(20);
const C = '0x' + 'c3'.repeat(20);

/* On DEMANDE l'objet au catalogue au lieu d'ecrire un identifiant : une piece
   renumerotee ne doit pas faire tomber un essai qui ne parle pas d'elle. */
const ARME = B.itemsDeSaison(2)[0];
const FRUIT = B.itemsDeSaison(1)[0];

/* Deux skins qu'on possede vraiment, par le chemin du jeu — `p.skins` pose a
   la main sauterait `possedeSkin`, qui est ce que les gardes interrogent. */
const prepare = (g, addr, combien) => {
  const p = g._p(addr);
  p.balance = WEI(100000000);
  p.hasDeposited = true;
  g.acheteSkin(addr, 'pepe');
  g.acheteSkin(addr, 'brett');
  p.objets = p.objets || {};
  if (combien) p.objets[ARME.id] = combien;
  return p;
};

console.log('\n-- un exemplaire, un porteur --');
{
  const g = new Game();
  const p = prepare(g, A, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  eq(g.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'le premier personnage la porte');

  let err = null;
  try { g.equipeArme(A, 'brett', ARME.id); } catch (e) { err = e.message; }
  ok(/already worn/.test(err || ''), `le second est refuse (${err})`);
  eq(g.personnageEtat(A, 'brett').equipArme, null, 'et il n a rien sur le dos');
  /* UN REFUS NE COUTE RIEN : le premier ne doit pas avoir ete deshabille au
     passage, ce qui serait la pire des reparations. */
  eq(g.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'le premier la porte toujours');
  eq(p.objets[ARME.id], 1, 'et le stock n a pas bouge');

  /* Deux exemplaires, deux porteurs : la regle compte, elle n'interdit pas. */
  p.objets[ARME.id] = 2;
  g.equipeArme(A, 'brett', ARME.id);
  eq(g.personnageEtat(A, 'brett').equipArme.item, ARME.id, 'avec deux exemplaires, les deux la portent');
  eq(g._portes(p, ARME.id), 2, 'le compte des portes suit');
  eq(g._libres(p, ARME.id), 0, 'et il n en reste aucune de libre');
}

console.log('\n-- remettre la meme piece dans la meme case n est pas un doublon --');
{
  /* Sans cette exception, re-cliquer sur l objet qu on a deja sur le dos se
     ferait refuser comme un doublon de soi-meme — un geste que la page fait
     a chaque reouverture de la fiche. */
  const g = new Game();
  prepare(g, A, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  g.equipeArme(A, 'pepe', ARME.id);
  eq(g.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'la case garde sa piece, sans refus');
}

console.log('\n-- on ne vend pas ce qu on porte --');
{
  const g = new Game();
  const p = prepare(g, A, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  const soldeAvant = g.balanceStr(A);

  let err = null;
  try { g.marcheVend(A, ARME.id, 50000, 1); } catch (e) { err = e.message; }
  ok(/being worn/.test(err || ''), `le marche refuse (${err})`);
  eq((g.marche || []).length, 0, 'aucune annonce n a ete posee');
  eq(p.objets[ARME.id], 1, 'la piece est toujours au coffre');
  eq(g.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'et toujours sur le dos');
  eq(g.balanceStr(A), soldeAvant, 'le solde est intact');

  /* Un exemplaire de plus, et la vente passe : c est l EXEMPLAIRE qui est
     bloque, pas la ligne du catalogue. */
  p.objets[ARME.id] = 2;
  const a = g.marcheVend(A, ARME.id, 50000, 1);
  ok(!!a && a.id !== undefined, 'avec un exemplaire libre, l annonce part');
  eq(p.objets[ARME.id], 1, 'le sequestre retire celui qui etait libre');
  eq(g.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'le porte reste porte');
}

console.log('\n-- ni au rachat, ou c est la MAISON qui paie --');
{
  const g = new Game();
  const p = prepare(g, A, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  /* La porte du rachat s ouvre au VOLUME : on la franchit par le vrai chemin,
     sinon l essai ne prouverait que l ordre des refus. */
  g._markWager(p, WEI(cfg.RACHAT_VOLUME_MIN + 1000), 'plinko');
  ok(g.rachatVerrou(A).ouvert, 'le verrou de rachat est ouvert');

  const emisAvant = (g.boutiqueEmis || {})[ARME.id] | 0;
  const soldeAvant = g.balanceStr(A);
  let err = null;
  try { g.boutiqueRachat(A, ARME.id, 1); } catch (e) { err = e.message; }
  ok(/being worn/.test(err || ''), `le rachat refuse (${err})`);
  eq(g.balanceStr(A), soldeAvant, 'la maison n a rien paye');
  eq((g.boutiqueEmis || {})[ARME.id] | 0, emisAvant,
     'et le registre n a pas redescendu — sinon la boutique reemettrait un exemplaire encore porte');
  eq(p.objets[ARME.id], 1, 'la piece est toujours la');
}

console.log('\n-- le coffre compte les exemplaires, pas les occurrences --');
{
  const g = new Game();
  const p = prepare(g, A, 3);
  g.equipeArme(A, 'pepe', ARME.id);
  /* Trois exemplaires, un porte : les deux autres doivent pouvoir sortir. La
     version d avant cherchait UNE occurrence et refusait les trois. */
  g.sortDuCoffre(A, ARME.id);
  eq(p.objets[ARME.id], 2, 'un exemplaire libre est sorti au sac');
  eq((p.sac || {})[ARME.id], 1, 'et il est bien dans le sac');
  g.sortDuCoffre(A, ARME.id);
  eq(p.objets[ARME.id], 1, 'le deuxieme aussi');

  let err = null;
  try { g.sortDuCoffre(A, ARME.id); } catch (e) { err = e.message; }
  ok(/being worn/.test(err || ''), `le dernier, celui qu on porte, est refuse (${err})`);
  eq(p.objets[ARME.id], 1, 'et il reste au coffre');
}

console.log('\n-- la mort deshabille aussi les AUTRES porteurs --');
{
  /* L etat de depart est celui d une fiche ecrite AVANT la garde : deux
     personnages designent le meme exemplaire unique. La mort en detruit un —
     il n en existe plus aucun, et personne ne doit plus l afficher. */
  const g = new Game();
  const p = prepare(g, A, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  /* On fabrique l'etat impossible A LA MAIN, puisque plus aucun chemin du
     moteur n'y mene — c'est bien le but. `equipeArme(..., '')` cree la fiche
     du personnage par le vrai chemin ; seule la designation est posee ensuite. */
  g.equipeArme(A, 'brett', '');
  p.persos.brett.ea = ARME.id;                  // le doublon d'avant la garde
  eq(g._portes(p, ARME.id), 2, 'deux porteurs pour un seul exemplaire');

  const bilan = g.meurt(A, 'pepe');
  eq(bilan.perdus.length, 1, 'le mort perd la piece qu il portait');
  eq(p.objets[ARME.id], undefined, 'il n en existe plus aucun exemplaire');
  eq(g.personnageEtat(A, 'brett').equipArme, null,
     'et l autre personnage ne la porte plus — il frappait avec un fantome');
  eq(bilan.desequipes.length, 1, 'le bilan le DIT, au lieu de le faire en silence');
  eq(bilan.desequipes[0].skin, 'brett', 'et il nomme qui a ete deshabille');
}

console.log('\n-- les fiches deja ecrites se reparent au chargement --');
{
  const g = new Game();
  const p = prepare(g, A, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  g.equipeArme(A, 'brett', '');
  p.persos.brett.ea = ARME.id;                  // l'etat impossible, tel quel
  /* Le personnage QU'ON PORTE est celui qui doit garder la piece : se la voir
     retirer sur la fiche qu'on a sous les yeux se lit comme un vol. */
  g.choisitSkin(A, 'pepe');

  /* On passe par la VRAIE sauvegarde et la VRAIE relecture : recopier le
     champ a la main verifierait qu un objet se copie, pas qu une fiche se
     repare au demarrage. */
  const etat = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(etat);
  const q = g2._p(A);
  eq(g2._portes(q, ARME.id), 1, 'au chargement, il ne reste qu un porteur');
  eq((q.objets || {})[ARME.id], 1, 'pour un exemplaire — les deux sont d accord');
  eq(g2.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'le premier garde la sienne');
  eq(g2.personnageEtat(A, 'brett').equipArme, null, 'le surnumeraire a ete retire');
}

console.log('\n-- et un compte sain traverse la sauvegarde sans etre touche --');
{
  const g = new Game();
  const p = prepare(g, A, 2);
  g.equipeArme(A, 'pepe', ARME.id);
  g.equipeArme(A, 'brett', ARME.id);
  p.objets[FRUIT.id] = 1;
  g.equipeFruit(A, 'pepe', FRUIT.id);
  const etat = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(etat);
  eq(g2.personnageEtat(A, 'pepe').equipArme.item, ARME.id, 'pepe garde son arme');
  eq(g2.personnageEtat(A, 'brett').equipArme.item, ARME.id, 'brett aussi');
  eq(g2.personnageEtat(A, 'pepe').equipFruit.item, FRUIT.id, 'et son fruit');
}

console.log('\n-- le voisin n est pas concerne --');
{
  /* Le compte des portes est PAR FICHE. Deux joueurs qui portent chacun leur
     exemplaire ne doivent pas se gener : une regle qui compterait globalement
     rendrait la deuxieme vente du jeu impossible. */
  const g = new Game();
  const pa = prepare(g, A, 1);
  const pc = prepare(g, C, 1);
  g.equipeArme(A, 'pepe', ARME.id);
  g.equipeArme(C, 'pepe', ARME.id);
  eq(g.personnageEtat(C, 'pepe').equipArme.item, ARME.id, 'chacun porte le sien');
  eq(g._libres(pa, ARME.id), 0, 'A n a rien de libre');
  eq(g._libres(pc, ARME.id), 0, 'C non plus');
}

console.log(`\nequipement_stock.test.js : ${n} verifications OK`);
