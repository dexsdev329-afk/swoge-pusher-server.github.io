'use strict';
/*
 * LA BOUTIQUE, VERIFIEE.
 *
 * Un coffre coute de l'argent et ne rend rien de monnayable : le seul chose
 * qu'un joueur recoit en echange, c'est la CHANCE annoncee. Si elle est
 * fausse, il n'a aucun moyen de s'en apercevoir — pas de solde qui baisse
 * anormalement, pas de partie perdue de travers. C'est pour ca que ce fichier
 * est long : ici, le test EST la garantie.
 *
 * Ce qui est verifie, dans l'ordre de ce que ca protege :
 *
 *  1. LE CATALOGUE. Identifiants uniques, dans le bloc de leur rarete, aucun
 *     coffre ne promet une rarete vide, et chaque table somme a 10 000.
 *
 *  2. LES CHANCES ANNONCEES SONT LES CHANCES REELLES. On tire cent mille
 *     coffres et on compte. Une table qui sommerait a 9 999 passerait tous
 *     les tests d'affichage du monde ; elle ne passe pas celui-la.
 *
 *  3. L'UNIFORMITE DANS LA RARETE. C'est le piege de ce tirage. Reutiliser la
 *     tranche d'empreinte qui a choisi la rarete pour choisir ensuite l'objet
 *     lie les deux : le premier objet de chaque rarete sortirait beaucoup plus
 *     souvent, et rien ne le montrerait a l'ecran. On mesure objet par objet.
 *
 *  4. LA SEPARATION DES TIRAGES. Un coffre et un lancer du Coin Pusher au
 *     meme numero doivent donner des empreintes differentes.
 *
 *  5. L'ARGENT. Le prix exact est debite, un solde insuffisant ne debite RIEN
 *     et ne range RIEN, l'inventaire s'empile et survit au disque.
 *
 *  6. CE QU'UN COFFRE NE DOIT PAS FAIRE. Il n'avance aucune quete, il ne
 *     compte pas comme mise. Sinon on remplirait les quetes sans jouer.
 */
const assert = require('assert');
const crypto = require('crypto');
const ethers = require('ethers');
const B = require('./boutique');
const { Game } = require('./game');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} : ${a} vs ${b} (ecart ${Math.abs(a - b).toFixed(4)} > ${e})`); n++; };

const A = '0x' + '11'.repeat(20);
const WEI = (x) => ethers.utils.parseUnits(String(x), 18);
const jetons = (p) => Number(ethers.utils.formatUnits(p.balance, 18));

// ============================================================ 1. le catalogue

{
  const vu = new Set();
  for (const o of B.ITEMS) {
    ok(!vu.has(o.id), 'identifiant unique : ' + o.id);
    vu.add(o.id);
    const r = B.rarete(o.rarete);
    ok(!!r, o.id + ' a une rarete connue');
    ok(o.id >= r.bloc && o.id < r.bloc + 1000, o.id + ' est dans le bloc ' + r.bloc);
    ok(/^[a-z0-9_]+$/.test(o.cle), o.cle + ' donne un nom de fichier sur');
    n -= 4;                       // ne pas compter trente fois les memes quatre
  }
  n += 4;
  ok(vu.size === B.ITEMS.length, `${vu.size} objets, tous distincts`);

  /* Les clefs servent de nom de fichier image : deux objets qui la partagent
     partageraient le dessin, sans que rien ne le signale. */
  const clefs = new Set(B.ITEMS.map((o) => o.cle));
  eq(clefs.size, B.ITEMS.length, 'aucune clef d image en double');

  for (const c of B.COFFRES) {
    const somme = c.table.reduce((a, [, p]) => a + p, 0);
    eq(somme, B.TOTAL, `la table du coffre « ${c.nom} » somme a ${B.TOTAL}`);
    for (const [rar] of c.table)
      ok(B.itemsDe(rar).length > 0, `« ${c.nom} » promet du ${rar}, et il en existe`);
    ok(c.prix > 0, `« ${c.nom} » a un prix`);
    n -= 5 + 1;
  }
  n += 6;
  ok(true, `les ${B.COFFRES.length} coffres sont coherents`);

  /* LA GRILLE EST PLEINE : six familles, cinq raretes, trente cases occupees
     une fois chacune. C'est la promesse faite au joueur — « il te manque la
     Clef d'or » n'a de sens que si elle existe. Un trou ne se verrait nulle
     part : la case resterait vide a l'ecran, exactement comme un objet qu'on
     n'a pas encore trouve. */
  eq(B.FAMILLES.length * B.RARETES.length, B.ITEMS.length,
     `${B.FAMILLES.length} familles x ${B.RARETES.length} raretes = ${B.ITEMS.length} objets`);
  for (const f of B.FAMILLES) {
    for (const r of B.RARETES) {
      const c = B.ITEMS.filter((o) => o.famille === f.cle && o.rarete === r.cle).length;
      ok(c === 1, `« ${f.nom} » existe une fois en ${r.nom}`);
      n -= 1;
    }
  }
  n += 1;
  ok(true, 'les trente cases de la planche sont occupees, une fois chacune');

  /* Chaque famille garde SA silhouette a travers ses cinq etats : c'est ce qui
     fait qu'on la reconnait dans la rangee. On ne peut pas mesurer un dessin,
     mais on peut verifier que le catalogue expose bien de quoi grouper. */
  const cat = B.catalogue();
  eq(cat.familles.length, B.FAMILLES.length, 'le catalogue expose les familles');
  ok(cat.items.every((o) => !!o.famille), 'et chaque objet dit a quelle famille il appartient');

  /* Un coffre plus cher doit etre MEILLEUR. Sans ce controle, une inversion de
     deux lignes ferait payer dix fois plus pour moins de chances, et il
     faudrait qu'un joueur ouvre des centaines de coffres pour s'en douter. */
  const rangs = B.RARETES.map((r) => r.cle);
  const esperance = (c) => B.coffre(c).table
    .reduce((a, [rar, p]) => a + p * rangs.indexOf(rar), 0) / B.TOTAL;
  const tries = B.COFFRES.slice().sort((a, b) => a.prix - b.prix);
  for (let i = 1; i < tries.length; i++)
    ok(esperance(tries[i].cle) > esperance(tries[i - 1].cle),
       `« ${tries[i].nom} » est meilleur que « ${tries[i - 1].nom} »`);
}

// ================================ 2. les chances annoncees sont les vraies

/* On tire directement sur le module, avec des empreintes tirees au hasard :
   c'est la table qu'on mesure, pas le generateur du serveur. */
function serie(cle, tours) {
  const parRarete = {}, parObjet = {};
  for (let i = 0; i < tours; i++) {
    const h = crypto.createHash('sha256').update(cle + ':' + i).digest('hex');
    const t = B.tire(h, cle);
    parRarete[t.rarete] = (parRarete[t.rarete] || 0) + 1;
    parObjet[t.item.id] = (parObjet[t.item.id] || 0) + 1;
  }
  return { parRarete, parObjet };
}

const TOURS = 100000;
for (const c of B.COFFRES) {
  const { parRarete } = serie(c.cle, TOURS);
  const lignes = [];
  for (const [rar, poids] of c.table) {
    const attendu = poids / B.TOTAL;
    const obtenu = (parRarete[rar] || 0) / TOURS;
    lignes.push(`${rar} ${(obtenu * 100).toFixed(2)}%`);
    /* Tolerance : quatre ecarts-types binomiaux, plancher a 0,001. A cent
       mille tirages, un legendaire a 0,19 % a un ecart-type de 0,014 % ;
       quatre ecarts-types font 0,055 %. Une table fausse de 0,2 point est
       donc attrapee, et un tirage honnete ne fait pratiquement jamais
       sonner l'alarme. */
    const sigma = Math.sqrt(attendu * (1 - attendu) / TOURS);
    pres(obtenu, attendu, Math.max(4 * sigma, 0.001),
         `« ${c.nom} » sort ${rar} a la frequence annoncee`);
  }
  console.log(`  ${c.nom.padEnd(14)} ${lignes.join('  ')}`);
}

// ========================== 3. l'uniformite des objets DANS une rarete

/*
 * LE PIEGE DE CE TIRAGE. La rarete est choisie sur les bits 0..59 ; si l'objet
 * l'etait sur les memes, les deux choix seraient lies et le premier objet de
 * chaque rarete raflerait tout. On mesure les communs du coffre de bois :
 * dix objets, 76 % des tirages, donc environ 7 600 par objet sur cent mille.
 */
{
  const { parObjet } = serie('bois', TOURS);
  for (const rar of ['commun', 'rare']) {
    const lot = B.itemsDe(rar);
    const total = lot.reduce((a, o) => a + (parObjet[o.id] || 0), 0);
    const attendu = total / lot.length;
    let pire = 0, quel = null;
    for (const o of lot) {
      const e = Math.abs((parObjet[o.id] || 0) - attendu) / attendu;
      if (e > pire) { pire = e; quel = o.cle; }
    }
    console.log(`  ${rar.padEnd(8)} ${lot.length} objets · ${total} tirages · ` +
                `plus gros ecart ${(pire * 100).toFixed(1)} % (${quel})`);
    /* A 7 600 tirages par objet, l'ecart-type relatif est de 1,15 % ; on
       laisse cinq fois cela. Un tirage lie donnerait des ecarts de 100 %. */
    ok(pire < 0.06, `les ${rar}s sortent uniformement (pire ecart ${(pire * 100).toFixed(1)} %)`);
  }
}

/* Et le tirage est REPRODUCTIBLE : meme empreinte, meme objet. Sans cela, un
   joueur ne pourrait rien refaire une fois la graine revelee. */
{
  const h = crypto.createHash('sha256').update('temoin').digest('hex');
  const a = B.tire(h, 'or'), b = B.tire(h, 'or');
  eq(a.item.id, b.item.id, 'la meme empreinte rend le meme objet');
  eq(a.r1, b.r1, 'et le meme tirage de rarete');
  ok(B.tire(h, 'bois').r1 === a.r1, 'le tirage de rarete ne depend pas du coffre, seule la table change');
  assert.throws(() => B.tire(h, 'inconnu'), /unknown chest/); n++;
}

// ===================================== 4. les tirages ne se melangent pas

{
  const g = new Game();
  g.serverSeed = 'graine-de-test';
  const p = g._p(A);
  p.clientSeed = 'joueur';
  const shop = crypto.createHmac('sha256', g.serverSeed).update(p.clientSeed + ':shop:0').digest('hex');
  const autre = crypto.createHmac('sha256', g.serverSeed).update(p.clientSeed + ':0').digest('hex');
  ok(shop !== autre, 'un coffre et un lancer au meme numero ont des empreintes differentes');
}

// ================================================== 5. l'argent et l'inventaire

{
  const g = new Game();
  const p = g._p(A);
  const bois = B.coffre('bois');

  // ---- solde insuffisant : rien ne bouge
  p.balance = WEI(bois.prix - 1);
  assert.throws(() => g.boutiqueAchat(A, 'bois'), /not enough/); n++;
  eq(jetons(p), bois.prix - 1, 'un achat refuse ne debite rien');
  eq(Object.keys(p.objets).length, 0, 'et ne range rien');
  eq(p.nonce, 0, 'et ne consomme pas de numero de tirage');

  // ---- coffre inconnu
  p.balance = WEI(10000000);
  assert.throws(() => g.boutiqueAchat(A, 'coffre-fantome'), /unknown chest/); n++;
  eq(jetons(p), 10000000, 'un coffre inconnu ne debite rien');

  // ---- l'achat qui passe
  const avant = jetons(p);
  const r = g.boutiqueAchat(A, 'bois');
  eq(jetons(p), avant - bois.prix, 'le prix exact est debite');
  eq(p.nonce, 1, 'un numero de tirage est consomme');
  ok(!!B.item(r.item.id), 'l objet rendu est au catalogue');
  eq(p.objets[r.item.id], 1, 'et il est range dans l inventaire');
  eq(r.quantite, 1, 'la reponse annonce la quantite detenue');
  eq(r.preuve.sh, g.serverSeedHash, 'la preuve porte l empreinte de la graine');
  eq(r.preuve.n, 0, 'et le numero utilise');

  /* La preuve doit REELLEMENT permettre de refaire le calcul. On le fait, avec
     la graine revelee — c'est la seule facon de savoir qu'elle n'est pas
     decorative. */
  const refait = B.tire(
    crypto.createHmac('sha256', g.serverSeed).update(r.preuve.cs + ':shop:' + r.preuve.n).digest('hex'),
    'bois');
  eq(refait.item.id, r.item.id, 'la preuve permet de refaire le tirage a l identique');

  // ---- l'inventaire s'empile
  const cible = r.item.id;
  let coups = 0;
  while (p.objets[cible] < 3 && coups < 5000) { p.balance = WEI(10000000); g.boutiqueAchat(A, 'bois'); coups++; }
  eq(p.objets[cible], 3, `le meme objet s empile (${coups} coffres pour en avoir trois)`);

  // ---- et survit au disque
  const etat = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(etat);
  const p2 = g2._p(A);
  eq(JSON.stringify(p2.objets), JSON.stringify(p.objets), 'l inventaire survit a une sauvegarde et une relecture');
}

// ============================= 6. ce qu'un coffre ne doit PAS declencher

/*
 * Les quetes du jour paient en jetons. Si acheter un coffre les faisait
 * avancer, on les remplirait sans jouer une seule manche — et le retour par
 * jeu, publie, compterait un jeu qui ne rend jamais rien.
 */
{
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(10000000);
  const avant = { drops: p.dropsToday, wins: p.winsToday,
                  mise: JSON.stringify(p.miseJour), wagered: (p.wagered || WEI(0)).toString() };
  for (let i = 0; i < 20; i++) { p.balance = WEI(10000000); g.boutiqueAchat(A, 'bois'); }
  eq(p.dropsToday, avant.drops, 'vingt coffres n avancent aucune quete du jour');
  eq(p.winsToday, avant.wins, 'et ne comptent aucune victoire');
  eq(JSON.stringify(p.miseJour), avant.mise, 'et ne comptent pas comme mise du jour');
  eq((p.wagered || WEI(0)).toString(), avant.wagered, 'et ne gonflent pas le volume mise');

  /* L'argent, lui, EST compte — du cote de la maison. */
  const mois = g._mois();
  eq(mois.boutique, 20 * B.coffre('bois').prix, 'les vingt achats sont portes au compte du mois');
}

console.log(`boutique.test.js : ${n} verifications OK`);
