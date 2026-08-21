'use strict';
/*
 * L'ETAL DES POTIONS : LE STOCK VIENT DES JOUEURS.
 *
 * La boutique tirait ses potions de nulle part et gardait les dix $SWOGE. Le
 * stock vient desormais des joueurs : on met ses potions en vente, quelqu'un
 * les achete, et la moitie du prix revient au vendeur.
 *
 * ---- ce qui doit tenir, et comment chaque chose se casse ----
 *
 * 1. RIEN NE SE CREE. La maison ne peut jamais reverser plus qu'elle n'a
 *    encaisse. C'est LA verification qui compte : une part mal arrondie ou un
 *    prix ecrit deux fois se lit comme une fuite de tresorerie, pas comme un
 *    caractere de travers. On compte donc les soldes AVANT et APRES.
 * 2. LA MISE EN VENTE SEQUESTRE. Sinon on affiche quatre-vingt-dix-neuf
 *    potions, on les boit, et l'acheteur paie pour du vide.
 * 3. ON REPREND CE QU'ON A MIS. Une potion bloquee parce que personne
 *    n'achete serait une confiscation.
 * 4. LES JOUEURS PASSENT AVANT LA MAISON. Servir le fond d'abord rendrait les
 *    annonces invisibles : personne ne vendrait jamais rien.
 * 5. UNE FIOLE DE STAT N'A PAS DE FOND. Son prix tient entierement au fait
 *    qu'aucune n'existe hors de celles qu'un joueur est alle chercher.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/marchepot-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const cfg = require('./config');
const ethers = require('./node_modules/ethers');
const { Game } = require('./game');
const P = require('./personnages');
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const C = '0x' + 'c3'.repeat(20);

function neuf() {
  const g = new Game();
  for (const a of [A, B, C]) {
    const p = g._p(a);
    p.hasDeposited = true;
    p.balance = WEI(100000);
  }
  return g;
}
const solde = (g, a) => Number(g.balanceStr(a));
const ligne = (g, a, cle) => g.potionsMarche(a).lignes.find((l) => l.cle === cle);

// ================== 1. METTRE EN VENTE SEQUESTRE
console.log('\n-- mettre en vente --');
{
  const g = neuf();
  g._p(A).potions = { vie: 20 };
  const av = solde(g, A);
  g.metPotionEnVente(A, 'vie', 8);
  eq(g._p(A).potions.vie, 12, 'les potions mises en vente QUITTENT l inventaire');
  eq(ligne(g, A, 'vie').enVente, 8, 'et se comptent comme en vente (8)');
  eq(ligne(g, B, 'vie').stock, 8, 'un autre joueur voit le stock (8)');
  eq(solde(g, A), av, 'et le vendeur n a RIEN touche : on paie a la vente, pas a la mise');
  /* On ne peut pas vendre ce qu'on n'a pas — y compris ce qu'on a deja mis
     en vente, qui n'est plus a soi. */
  g.metPotionEnVente(A, 'vie', 99);
  eq(g._p(A).potions.vie, undefined, 'tout mettre en vente vide la pile');
  eq(ligne(g, A, 'vie').enVente, 20, 'et l annonce porte les vingt');
  assert.throws(() => g.metPotionEnVente(A, 'vie', 1), /no Health Potion/i);
  n++; console.log('  ok   et on ne peut plus en vendre : il n en reste aucune');
}

// ================== 2. ACHETER : RIEN NE SE CREE
console.log('\n-- acheter, et ou va l argent --');
{
  const g = neuf();
  g._p(A).potions = { vie: 10 };
  g.metPotionEnVente(A, 'vie', 10);
  const avA = solde(g, A), avB = solde(g, B);
  const r = g.achetePotion(B, 'vie', 4);
  eq(r.desJoueurs, 4, 'les quatre potions viennent des JOUEURS');
  eq(r.deLaMaison, 0, 'et aucune de la maison : la file passe en premier');
  eq(g._p(B).potions.vie, 4, 'l acheteur les a');
  eq(ligne(g, A, 'vie').enVente, 6, 'et il en reste six en vente');

  const paye = avB - solde(g, B), recu = solde(g, A) - avA;
  eq(paye, 40, `l acheteur a paye 10 par potion (${paye})`);
  eq(recu, 20, `le vendeur en a touche 5 (${recu})`);
  /* ---- LA VERIFICATION QUI COMPTE ----
   * La maison encaisse la difference, jamais l'inverse. Un arrondi au mauvais
   * sens, et elle reverse plus qu'elle n'a pris — a chaque vente, pour
   * toujours, sans que rien ne s'affiche. */
  ok(recu < paye && paye - recu === 20,
     `et la maison garde exactement la moitie (${paye - recu} sur ${paye})`);
  eq(recu * 2, paye, 'la part du vendeur est la MOITIE, pas un chiffre voisin');
}

// ================== 3. LA FILE : PREMIER ARRIVE, PREMIER PAYE
console.log('\n-- la file --');
{
  const g = neuf();
  g._p(A).potions = { vie: 5 };
  g._p(B).potions = { vie: 5 };
  g.metPotionEnVente(A, 'vie', 5);
  /* Le temps avance : sans ca les deux annonces portent la meme date et
     l'ordre depend de l'ordre d'insertion, ce qui n'est pas une regle. */
  g.marche.find((x) => x.vendeur === A.toLowerCase()).t -= 1000;
  g.metPotionEnVente(B, 'vie', 5);
  const avA = solde(g, A), avB = solde(g, B);
  g.achetePotion(C, 'vie', 5);
  ok(solde(g, A) - avA === 25 && solde(g, B) === avB,
     'les cinq premieres viennent du premier arrive, et lui seul est paye');
  g.achetePotion(C, 'vie', 3);
  eq(solde(g, B) - avB, 15, 'puis c est au tour du suivant');
  eq(ligne(g, C, 'vie').stock, 2, 'et il reste ce qui reste (2)');
}

// ================== 4. ON NE S ACHETE PAS A SOI-MEME
console.log('\n-- ses propres annonces --');
{
  const g = neuf();
  g._p(A).potions = { vie: 10 };
  g.metPotionEnVente(A, 'vie', 10);
  const av = solde(g, A);
  /* Se racheter ses propres potions serait perdre la moitie du prix a chaque
     tour, pour rien. On saute donc ses annonces — et comme la maison ne vend
     plus de sa poche, il ne reste rien a acheter : le refus est le bon
     resultat, pas un accident. Ce qu il veut, c est les REPRENDRE. */
  assert.throws(() => g.achetePotion(A, 'vie', 3), /for sale right now/i);
  n++; console.log('  ok   on ne se rachete pas a soi-meme');
  eq(ligne(g, A, 'vie').enVente, 10, 'son annonce est intacte');
  eq(solde(g, A), av, 'et rien n a bouge sur son solde');
  /* Un AUTRE joueur, lui, achete sans probleme. */
  g._p(B).potions = {};
  const r = g.achetePotion(B, 'vie', 3);
  eq(r.desJoueurs, 3, 'un autre joueur, lui, est servi');
}

// ================== 5. REPRENDRE SON STOCK
console.log('\n-- reprendre --');
{
  const g = neuf();
  g._p(A).potions = { vie: 10 };
  g.metPotionEnVente(A, 'vie', 10);
  g.retirePotionDeLaVente(A, 'vie', 4);
  eq(g._p(A).potions.vie, 4, 'on recupere ce qu on reprend');
  eq(ligne(g, A, 'vie').enVente, 6, 'et l annonce maigrit d autant');
  g.retirePotionDeLaVente(A, 'vie', 99);
  eq(ligne(g, A, 'vie').enVente, 0, 'tout reprendre fait disparaitre l annonce');
  eq(g._p(A).potions.vie, 10, 'et rend TOUT : rien ne se perd en chemin');
  assert.throws(() => g.retirePotionDeLaVente(A, 'vie', 1), /none of those for sale/i);
  n++; console.log('  ok   reprendre ce qu on n a pas mis en vente est refuse');

  /* ---- LE PLAFOND DE PORT NE DOIT PAS DETRUIRE ----
   * Quatre-vingt-dix-neuf en poche et une annonce en cours : la reprise ne
   * peut rien rendre. Elle doit REFUSER, pas retirer l'annonce dans le vide. */
  g._p(B).potions = { vie: 99 };
  g._p(B).potions.vie = 5;
  g.metPotionEnVente(B, 'vie', 5);
  g._p(B).potions.vie = 99;
  assert.throws(() => g.retirePotionDeLaVente(B, 'vie', 5), /already carry/i);
  eq(ligne(g, B, 'vie').enVente, 5, 'refusee par le plafond, l annonce reste entiere');
}

// ================== 6. LES FIOLES DE STAT
console.log('\n-- les fioles de stat --');
{
  const g = neuf();
  g._p(A).fioles = { def: 3 };
  g.metPotionEnVente(A, 'st:def', 2);
  eq(g._p(A).fioles.def, 1, 'la fiole part du COFFRE, pas du sac');
  eq(ligne(g, A, 'st:def').prix, 5000, 'elle vaut 5000 $SWOGE');
  eq(ligne(g, A, 'st:def').gain, 2500, 'et le vendeur en touche 2500');

  const avA = solde(g, A), avB = solde(g, B);
  g.acheteFioleAuMarche(B, 'def', 1);
  eq(g._p(B).fioles.def, 1, 'l acheteur la recoit dans son coffre');
  eq(avB - solde(g, B), 5000, 'il a paye 5000');
  eq(solde(g, A) - avA, 2500, 'le vendeur a touche 2500');
  eq(ligne(g, A, 'st:def').enVente, 1, 'et il en reste une en vente');

  /* PAS DE FOND DE LA MAISON. Une fiole de stat est un acquis permanent :
     en vendre a volonte reviendrait a vendre des statistiques. */
  g.retirePotionDeLaVente(A, 'st:def', 1);
  assert.throws(() => g.acheteFioleAuMarche(B, 'def', 1), /for sale right now/i);
  n++; console.log('  ok   file vide : la maison n en fabrique AUCUNE');
  /* Et la potion de soin est logee a la meme enseigne depuis que le fond de
     la maison est ferme : rien en vente, rien a acheter. Le message le dit,
     au lieu de laisser croire a une panne. */
  assert.throws(() => g.achetePotion(C, 'vie', 2), /players stock the shop/i);
  n++; console.log('  ok   et la potion de soin non plus ne sort pas de nulle part');
}

// ================== 7. LES DEUX ETALS NE SE MELANGENT PAS
console.log('\n-- l etal des pieces reste l etal des pieces --');
{
  const g = neuf();
  g._p(A).potions = { vie: 5 };
  g.metPotionEnVente(A, 'vie', 5);
  const vitrine = g.marcheListe(B, null);
  eq(vitrine.annonces.length, 0,
     'une annonce de potion n apparait PAS dans la vitrine des pieces');
  const mienne = g.marche.find((x) => x.pot === 'vie');
  assert.throws(() => g.marcheAchete(B, mienne.id), /not by listing/i);
  n++; console.log('  ok   et ne s achete pas par le chemin des pieces');
  assert.throws(() => g.marcheAnnule(A, mienne.id), /potion counter/i);
  n++; console.log('  ok   ni ne s annule par celui-la');
}

// ================== 8. PAS A CREDIT, ET PAS A MOITIE
console.log('\n-- ce qu on ne peut pas payer --');
{
  const g = neuf();
  g._p(A).potions = { vie: 10 };
  g.metPotionEnVente(A, 'vie', 10);
  const p = g._p(B);
  p.balance = WEI(25);
  /* ---- LA REGLE EXISTAIT AVANT LE MARCHE, ET ELLE TIENT ----
   *
   * `potions.test.js` la pose depuis le premier jour : un solde insuffisant
   * refuse l achat EN ENTIER. Livrer « ce qu on peut payer » serait une
   * surprise — on demande dix potions, on en recoit deux, et le compte est
   * vide sans qu on ait rien decide.
   *
   * Le marche ne l a pas changee, et cet essai est la pour qu il ne la change
   * jamais : c est exactement le genre de regle qu une nouvelle
   * fonctionnalite emporte sans s en apercevoir. */
  assert.throws(() => g.achetePotion(B, 'vie', 10), /Not enough/i);
  n++; console.log('  ok   dix potions pour vingt-cinq jetons : refuse en entier');
  eq(solde(g, B), 25, 'et rien n a ete debite');
  eq(ligne(g, B, 'vie').stock, 10, 'ni retire du stock du vendeur');
  /* Ce qu on peut payer passe, evidemment. */
  const r = g.achetePotion(B, 'vie', 2);
  eq(r.livre, 2, 'deux potions, elles, passent');
  eq(solde(g, B), 5, 'et il reste la monnaie');

  /* ---- LE STOCK QUI MANQUE N EST PAS UN CREDIT ----
   * Demander dix potions quand il n en existe que trois n est pas acheter a
   * credit : c est demander plus qu il n y en a. On livre les trois, comme le
   * plafond de port livre ce qui tient. */
  const g3 = neuf();
  g3._p(A).potions = { vie: 3 };
  g3.metPotionEnVente(A, 'vie', 3);
  const r3 = g3.achetePotion(B, 'vie', 10);
  eq(r3.desJoueurs, 3, 'les trois du joueur partent');
  eq(r3.deLaMaison, 0, 'et la maison n en fabrique aucune');
  eq(r3.livre, 3, 'on livre les trois qui existaient, et on n en facture pas plus');
}

// ================== 9. TOUT SURVIT A UNE SAUVEGARDE
console.log('\n-- apres un redemarrage --');
{
  const g = neuf();
  g._p(A).potions = { vie: 7 };
  g._p(A).fioles = { att: 2 };
  g.metPotionEnVente(A, 'vie', 7);
  g.metPotionEnVente(A, 'st:att', 2);
  const st = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(st);
  /* Les annonces DOIVENT traverser : la potion a quitte l'inventaire du
     vendeur. Les perdre, c'est la detruire — et le vendeur ne peut meme pas
     s'en plaindre, puisqu'il n'a plus rien a montrer. */
  eq(ligne(g2, A, 'vie').enVente, 7, 'les annonces de potions traversent la sauvegarde');
  eq(ligne(g2, A, 'st:att').enVente, 2, 'les fioles aussi');
  g2.retirePotionDeLaVente(A, 'vie', 7);
  eq(g2._p(A).potions.vie, 7, 'et on les recupere de l autre cote');
}

// ================== 10. LES FIOLES DU SAC SE VENDENT AUSSI
console.log('\n-- la fiole qu on a SUR SOI --');
{
  /* « J ai pourtant une potion de defense sur moi mais je peux pas la mettre
     dans le stock du shop. » Le comptoir ne regardait que le COFFRE. Dire
     « tu n en as pas » a quelqu un qui l a dans son sac est la pire reponse
     possible : elle est fausse. */
  const g = neuf();
  g._p(A).sacFioles = { def: 2 };
  g._p(A).fioles = {};
  eq(ligne(g, A, 'st:def').jai, 2, 'le comptoir voit les fioles du SAC');
  g.metPotionEnVente(A, 'st:def', 1);
  eq(ligne(g, A, 'st:def').enVente, 1, 'et on peut les mettre en vente');
  eq(g._p(A).sacFioles.def, 1, 'elle est partie du sac');

  /* ---- ON PREND DU SAC D ABORD ----
   * Meme regle que pour la boire : ce qu on porte est ce qui peut se perdre,
   * donc ce dont on se defait en premier. Vider le coffre pendant qu une
   * fiole risque sa peau dans le sac serait exactement le contraire. */
  const g2 = neuf();
  g2._p(A).sacFioles = { att: 1 };
  g2._p(A).fioles = { att: 5 };
  g2.metPotionEnVente(A, 'st:att', 1);
  eq(g2._p(A).sacFioles.att, undefined, 'la fiole du sac part la premiere');
  eq(g2._p(A).fioles.att, 5, 'et le coffre n a pas bouge');
  /* Au-dela, on pioche dans le coffre : le compte est le total des deux. */
  g2.metPotionEnVente(A, 'st:att', 3);
  eq(g2._p(A).fioles.att, 2, 'ensuite seulement on entame le coffre');
}

// ================== 11. UNE PILE DE FIOLES NE MANGE QU UNE CASE
console.log('\n-- une case pour toute la pile --');
{
  const g = neuf();
  const p = g._p(A);
  p.sacFioles = { def: 3 };
  p.sac = {};
  p.sacCases = null;
  const sac = g.sacPour(A);
  eq(sac.length, 1, `trois fioles de defense tiennent sur UNE case (${sac.length})`);
  eq(sac[0].quantite, 3, 'et la case dit qu il y en a trois');
  eq(g.sacRempli(A), 1, 'le sac n est rempli que d une place');

  /* Deux STATS differentes restent deux cases : ce sont deux objets
     differents, et les empiler ensemble obligerait a lire un chiffre pour
     savoir laquelle on boit. */
  p.sacFioles = { def: 3, att: 2 };
  p.sacCases = null;
  eq(g.sacPour(A).length, 2, 'deux stats differentes font deux cases');
  eq(g.sacRempli(A), 2, 'soit deux places');

  /* ---- ET LE SAC NE SE DIT PLUS PLEIN POUR RIEN ----
   * Avant, neuf fioles mangeaient les huit places et le refus tombait alors
   * que l ecran montrait des cases vides. */
  p.sacFioles = { def: 9 };
  p.sacCases = null;
  eq(g.sacRempli(A), 1, 'neuf fioles de la meme stat : toujours une seule place');
  ok(g.sacPour(A).length === 1, 'et une seule case a l ecran');
  /* Le compte de `sacRempli` et celui de `_casesDuSac` doivent dire la MEME
     chose, sinon « sac plein » tombe devant des cases vides. */
  const cases = g._casesDuSac(p).filter((c) => c !== null).length;
  eq(cases, g.sacRempli(A), `les deux comptes concordent (${cases})`);
}

// ================== 12. RUPTURE DE STOCK
console.log('\n-- rupture de stock --');
{
  const g = neuf();
  /* Le fond de la maison est ferme : la boutique ne fabrique plus rien. */
  eq(cfg.POTIONS_FOND_MAISON, false, 'la maison ne vend plus de sa poche');
  assert.throws(() => g.achetePotion(A, 'vie', 1), /No Health Potion for sale/i);
  n++; console.log('  ok   file vide : l achat est refuse, et le message le dit');
  eq(ligne(g, A, 'vie').stock, 0, 'le stock affiche zero');

  /* Et le compteur DESCEND a mesure qu on achete. */
  g._p(B).potions = { vie: 5 };
  g.metPotionEnVente(B, 'vie', 5);
  eq(ligne(g, A, 'vie').stock, 5, 'un joueur en met cinq : le stock monte a cinq');
  g.achetePotion(A, 'vie', 2);
  eq(ligne(g, A, 'vie').stock, 3, 'on en achete deux : il descend a trois');
  g.achetePotion(A, 'vie', 3);
  eq(ligne(g, A, 'vie').stock, 0, 'on prend le reste : il retombe a zero');
  assert.throws(() => g.achetePotion(A, 'vie', 1), /for sale right now/i);
  n++; console.log('  ok   et le rayon repasse en rupture');
}

// ================== 13. « EN STOCK » VEUT DIRE « QUE TU PEUX ACHETER »
/*
 * « Ya marque une potion de defense en stock mais quand je veux l acheter il
 * me dit qu il y en a pas. »
 *
 * Le compte incluait SES PROPRES annonces ; l achat, lui, les saute — on ne se
 * rachete pas a soi-meme. Un joueur seul a vendre lisait donc « 1 en stock »
 * et se faisait repondre « rupture de stock » en cliquant. Les deux phrases
 * etaient justes chacune de son cote, et ensemble elles decrivaient une panne.
 */
console.log('\n-- le rayon et la caisse disent la meme chose --');
{
  const g = neuf();
  g._p(A).fioles = { def: 2 };
  g.metPotionEnVente(A, 'st:def', 2);

  /* Le VENDEUR ne voit pas son propre stock au rayon : il ne peut pas
     l acheter. Il le voit dans « en vente », qui est l autre question. */
  eq(ligne(g, A, 'st:def').stock, 0, 'le vendeur voit 0 ACHETABLE : il ne peut rien acheter');
  eq(ligne(g, A, 'st:def').total, 2, 'mais la ligne EXISTE au rayon : total = 2');
  eq(ligne(g, A, 'st:def').enVente, 2, 'et il voit que les deux sont a lui');
  assert.throws(() => g.acheteFioleAuMarche(A, 'def', 1), /for sale right now/i);
  n++; console.log('  ok   et la caisse dit la meme chose que le rayon');

  /* L ACHETEUR, lui, les voit et les achete. */
  eq(ligne(g, B, 'st:def').stock, 2, 'un autre joueur voit les deux');
  eq(g.acheteFioleAuMarche(B, 'def', 1).achete, 1, 'et peut en acheter une');
  eq(ligne(g, B, 'st:def').stock, 1, 'il en reste une pour lui');
  eq(ligne(g, A, 'st:def').stock, 0, 'toujours zero pour le vendeur');

  /* Meme regle pour les potions de soin : ce qui est affiche est ce qui est
     achetable, sinon le bouton ment. */
  g._p(C).potions = { vie: 4 };
  g.metPotionEnVente(C, 'vie', 4);
  eq(ligne(g, C, 'vie').stock, 0, 'le vendeur de potions de soin voit 0 aussi');
  eq(ligne(g, A, 'vie').stock, 4, 'et les autres voient les quatre');
  assert.throws(() => g.achetePotion(C, 'vie', 1), /for sale right now/i);
  n++; console.log('  ok   et lui non plus ne se rachete pas a lui-meme');
}

// ================== 14. SON ANNONCE SE VOIT, MEME SEUL A VENDRE
/*
 * « Quand je mets a vendre des potions je dois les voir moi aussi dans le
 * shop ; la rien ne s affiche, le shop est vide. »
 *
 * Consequence directe de la correction precedente : « en stock » etant devenu
 * « ce que TU peux acheter », un vendeur unique voyait zero partout — et donc
 * un magasin vide, sans aucun moyen de verifier que son annonce existait.
 *
 * Deux chiffres, deux questions : `total` decide si la LIGNE existe, `stock`
 * decide si le BOUTON marche. N'en garder qu'un cassait l'une ou l'autre.
 */
console.log('\n-- seul a vendre, et pourtant visible --');
{
  const g = neuf();
  g._p(A).potions = { vie: 3 };
  g.metPotionEnVente(A, 'vie', 3);
  const l = ligne(g, A, 'vie');
  ok(l.total > 0, `le rayon a de quoi afficher la ligne (total ${l.total})`);
  eq(l.stock, 0, 'mais rien d achetable pour lui');
  eq(l.enVente, 3, 'et il lit que les trois sont les siennes');
  /* Un autre joueur, lui, voit du stock ET peut acheter. */
  const lb = ligne(g, B, 'vie');
  eq(lb.total, 3, 'un autre voit le meme total');
  eq(lb.stock, 3, 'et peut tout acheter');
  eq(lb.enVente, 0, 'sans rien avoir a lui');
}

// ================== 15. REPRENDRE LA REND LA OU ON LA VOIT
console.log('\n-- reprendre une fiole --');
{
  /* « Quand je fais take back je devrais la voir apparaitre dans mes
     equipements. » Elle revenait toujours au COFFRE : celui qui l avait mise
     en vente depuis son sac ne la retrouvait nulle part ou il l avait
     laissee. */
  const g = neuf();
  const p = g._p(A);
  p.sacFioles = { def: 1 }; p.sac = {}; p.sacCases = null;
  g.metPotionEnVente(A, 'st:def', 1);
  eq(g.sacPour(A).length, 0, 'mise en vente, elle a quitte le sac');
  g.retirePotionDeLaVente(A, 'st:def', 1);
  eq((p.sacFioles || {}).def, 1, 'reprise, elle revient DANS LE SAC');
  eq((p.fioles || {}).def, undefined, 'et pas au coffre, ou il faudrait deviner d aller la chercher');
  ok(g.sacPour(A).some((o) => o.fiole === 'def'), 'elle se voit dans le sac');

  /* Sac PLEIN : elle va au coffre plutot que de se perdre. Le refus serait
     pire — l annonce resterait et la fiole avec. */
  const g2 = neuf();
  const q = g2._p(A);
  q.sacFioles = { att: 1 }; q.sacCases = null;
  g2.metPotionEnVente(A, 'st:att', 1);
  const B0 = require('./boutique');
  q.sac = {};
  for (const o of B0.ITEMS.slice(0, 8)) q.sac[o.id] = 1;
  q.sacCases = null;
  eq(g2.sacRempli(A), 8, 'le sac est plein');
  g2.retirePotionDeLaVente(A, 'st:att', 1);
  eq((q.fioles || {}).att, 1, 'elle va au coffre plutot que de se perdre');

  /* Un ACHAT, lui, va toujours au coffre : on ne vient pas d acheter pour
     risquer tout de suite. */
  const g3 = neuf();
  g3._p(B).fioles = { wis: 1 };
  g3.metPotionEnVente(B, 'st:wis', 1);
  g3.acheteFioleAuMarche(A, 'wis', 1);
  eq((g3._p(A).fioles || {}).wis, 1, 'ce qu on achete va au coffre');
  eq((g3._p(A).sacFioles || {}).wis, undefined, 'pas dans le sac');
}

console.log(`\nmarche_potions.test.js — ${n} verifications, 0 echec(s)`);
