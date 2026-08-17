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
      ok(B.itemsDe(rar, c.saison).length > 0,
         `« ${c.nom} » promet du ${rar}, et il en existe en saison ${c.saison}`);
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
  ok(true, 'les cases de chaque planche sont occupees, une fois chacune');
  /* Et chaque SAISON porte sa propre grille pleine. Le controle global
     ci-dessus se laisserait tromper par une saison a sept familles et une
     autre a cinq : les totaux se compensent. */
  for (const s of B.SAISONS) {
    eq(B.famillesDe(s.n).length, 6, `saison ${s.n} : six familles`);
    eq(B.itemsDeSaison(s.n).length, 30, `saison ${s.n} : trente objets`);
    ok(B.coffresDe(s.n).length > 0, `saison ${s.n} : au moins un coffre`);
  }

  /* Chaque famille garde SA silhouette a travers ses cinq etats : c'est ce qui
     fait qu'on la reconnait dans la rangee. On ne peut pas mesurer un dessin,
     mais on peut verifier que le catalogue expose bien de quoi grouper. */
  const cat = B.catalogue({}, 1);
  eq(cat.familles.length, 6, 'le catalogue d une saison expose ses six familles');
  ok(cat.items.every((o) => !!o.famille), 'et chaque objet dit a quelle famille il appartient');

  /* Un coffre plus cher doit etre MEILLEUR. Sans ce controle, une inversion de
     deux lignes ferait payer dix fois plus pour moins de chances, et il
     faudrait qu'un joueur ouvre des centaines de coffres pour s'en douter. */
  const rangs = B.RARETES.map((r) => r.cle);
  const esperance = (c) => B.coffre(c).table
    .reduce((a, [rar, p]) => a + p * rangs.indexOf(rar), 0) / B.TOTAL;
  const tries = B.coffresDe(1).slice().sort((a, b) => a.prix - b.prix);
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
    const lot = B.itemsDe(rar, 1);
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

// ================================================ 7. LES PLAFONDS

/*
 * Sans plafond, « mythique 0,01 % » ne dit rien du nombre qui existera : les
 * coffres sont illimites, donc l'offre monte tant que les gens jouent. Ces
 * controles sont ce qui separe une rarete affichee d'une rarete reelle.
 */
{
  /* Chaque rarete a un plafond, et il DECROIT avec la rarete. Une inversion
     rendrait les mythiques plus nombreux que les communs sans qu'aucun
     affichage ne bronche. */
  for (const r of B.RARETES) ok(r.plafond > 0, `${r.nom} a un plafond (${r.plafond})`);
  for (let i = 1; i < B.RARETES.length; i++)
    ok(B.RARETES[i].plafond < B.RARETES[i - 1].plafond,
       `${B.RARETES[i].nom} est plus rare que ${B.RARETES[i - 1].nom}`);

  /* PAR SAISON. Une edition qui additionne les deux collections ne dit plus
     rien : c'est le chiffre d'UNE saison qu'on annonce aux joueurs. */
  for (const sa of B.SAISONS) {
    const fams = B.famillesDe(sa.n).length;
    const edition = B.RARETES.reduce((a, r) => a + r.plafond * fams, 0);
    console.log(`  saison ${sa.n} : ${edition} pieces, ` +
      B.RARETES.map((r) => `${r.nom} ${r.plafond}x${fams}`).join(', '));
    eq(edition, 9600, `l edition de la saison ${sa.n} fait 9 600 pieces`);
  }

  /* `restant` compte juste, et ne descend jamais sous zero meme si le
     registre porte plus que le plafond — ce qui ne devrait pas arriver, mais
     un nombre negatif se propagerait en silence dans l'affichage. */
  const m = B.itemsDe('mythique', 1)[0];
  eq(B.restant(m.id, {}), B.rarete('mythique').plafond, 'un objet neuf est entier');
  eq(B.restant(m.id, { [m.id]: 3 }), B.rarete('mythique').plafond - 3, 'trois sortis, trois de moins');
  eq(B.restant(m.id, { [m.id]: 999999 }), 0, 'un registre incoherent rend zero, pas un negatif');
}

/* L'EPUISEMENT NE FAIT JAMAIS SORTIR UN OBJET QUI N'EXISTE PLUS. On epuise
   toute une rarete et on tire des milliers de fois : elle ne doit plus
   apparaitre, et le tirage doit descendre — jamais monter. */
{
  const emis = {};
  for (const o of B.itemsDe('mythique', 1)) emis[o.id] = B.rarete('mythique').plafond;
  let mythiques = 0, montes = 0;
  const rangs = B.RARETES.map((r) => r.cle);
  for (let i = 0; i < 5000; i++) {
    const h = crypto.createHash('sha256').update('epuise:' + i).digest('hex');
    const t = B.tire(h, 'mythe', emis);
    if (t.rarete === 'mythique') mythiques++;
    if (t.epuise && rangs.indexOf(t.rarete) > rangs.indexOf(t.epuise[0])) montes++;
  }
  eq(mythiques, 0, 'une rarete epuisee ne sort plus jamais');
  eq(montes, 0, 'un tirage epuise DESCEND, il ne monte jamais');
}

/* Et l'objet epuise dans une rarete NON epuisee : les autres le remplacent,
   lui seul disparait. */
{
  const lot = B.itemsDe('legendaire', 1);
  const emis = { [lot[0].id]: B.rarete('legendaire').plafond };
  let vu = 0, autres = 0;
  for (let i = 0; i < 20000; i++) {
    const t = B.tire(crypto.createHash('sha256').update('un:' + i).digest('hex'), 'mythe', emis);
    if (t.item.id === lot[0].id) vu++;
    else if (t.rarete === 'legendaire') autres++;
  }
  eq(vu, 0, `« ${lot[0].nom} » epuise ne sort plus`);
  ok(autres > 100, `mais les ${lot.length - 1} autres legendaires sortent toujours (${autres})`);
}

/* Tout epuise : la collection est complete et le tirage JETTE. Il ne doit
   surtout pas rendre un objet inexistant, ni `null` — un coffre debite qui
   rend null serait de l'argent pris pour rien. */
{
  const emis = {};
  for (const o of B.ITEMS) emis[o.id] = B.rarete(o.rarete).plafond;
  assert.throws(() => B.tire(crypto.createHash('sha256').update('fin').digest('hex'), 'bois', emis),
                /fully minted/); n++;
}

// =========================== 8. LE COMPTEUR GLOBAL SURVIT AU DISQUE

/*
 * C'est le defaut le plus dangereux du lot, parce qu'il est INVISIBLE : un
 * registre perdu au redemarrage remet tous les compteurs a zero, les
 * plafonds cessent de borner quoi que ce soit, et la boutique continue de
 * fonctionner normalement. Personne ne s'en apercoit avant qu'il existe
 * trois cents mythiques au lieu de cinquante.
 */
{
  const g = new Game();
  const p = g._p(A);
  for (let i = 0; i < 40; i++) { p.balance = WEI(10000000); g.boutiqueAchat(A, 'or'); }
  const total = Object.values(g.boutiqueEmis).reduce((a, b) => a + b, 0);
  eq(total, 40, 'quarante coffres ouverts, quarante emissions comptees');

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(JSON.stringify(g2.boutiqueEmis), JSON.stringify(g.boutiqueEmis),
     'le registre des emis survit a une sauvegarde et une relecture');

  /* Le compteur global et la somme des inventaires disent la meme chose.
     Ils montent sur deux lignes voisines ; s'ils divergeaient, l'un des deux
     mentirait et rien ne dirait lequel. */
  const inv = Object.values(g._p(A).objets).reduce((a, b) => a + b, 0);
  eq(inv, total, 'l inventaire du joueur et le registre global concordent');
}

/*
 * Le plafond tient POUR DE VRAI a travers le jeu, pas seulement dans le
 * module : on laisse UN seul mythique en stock et on achete jusqu'a le voir
 * sortir, puis on continue.
 *
 * ---- pourquoi la graine est fixee ----
 *
 * `new Game()` tire une graine de serveur au hasard, donc la suite des achats
 * change a chaque execution. Avec l'ancien plafond de cinquante, trois mille
 * coffres mythiques n'entamaient qu'une partie du stock et le test passait
 * toujours ; a dix, ils consomment TOUT — et le resultat se mettait a
 * dependre du hasard du jour. Un test qui passe une fois sur deux ne prouve
 * rien, et pire, il apprend a ignorer un rouge. On fixe donc la graine : le
 * plafond, lui, doit tenir quelle qu'elle soit.
 */
{
  const g = new Game();
  g.serverSeed = 'graine-fixe-pour-ce-test';
  const p = g._p(A);
  const cible = B.itemsDe('mythique', 1)[0];
  const max = B.rarete('mythique').plafond;
  /* Tous les autres mythiques epuises ; la cible a un seul exemplaire. */
  for (const o of B.itemsDe('mythique', 1)) g.boutiqueEmis[o.id] = max;
  g.boutiqueEmis[cible.id] = max - 1;
  let sortis = 0;
  for (let i = 0; i < 2000; i++) {
    p.balance = WEI(10000000);
    if (g.boutiqueAchat(A, 'mythe').item.id === cible.id) sortis++;
  }
  eq(sortis, 1, `le dernier exemplaire sort une fois, et une seule (${max} au plafond)`);
  eq(g.boutiqueEmis[cible.id], max, 'le registre s arrete pile au plafond');
  ok(B.restant(cible.id, g.boutiqueEmis) === 0, 'et il n en reste zero');

  /* Deux mille achats de plus, avec tous les mythiques a sec : aucun ne doit
     sortir, et aucun achat ne doit echouer — il reste des raretes en dessous. */
  let apres = 0;
  for (let i = 0; i < 2000; i++) {
    p.balance = WEI(10000000);
    if (g.boutiqueAchat(A, 'mythe').rarete === 'mythique') apres++;
  }
  eq(apres, 0, 'la rarete epuisee ne ressort jamais, meme apres deux mille coffres');
}

/* La reponse d'achat porte de quoi afficher la rarete reelle. */
{
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(10000000);
  const r = g.boutiqueAchat(A, 'bois');
  eq(r.emis, 1, 'la reponse dit le numero d emission');
  eq(r.plafond, B.rarete(r.item.rarete).plafond, 'et le plafond de sa rarete');
  ok(r.emis <= r.plafond, `« ${r.item.nom} » n ${r.emis} sur ${r.plafond}`);
}

// ============================== 9. LA COURSE AUX TROIS PREMIERES LIGNES

/*
 * Quatre-vingt-dix millions de jetons se jouent ici, une seule fois dans la
 * vie de l'edition. Chaque regle est donc verrouillee par un controle.
 */
{
  const g = new Game();
  const chaos = B.ITEMS.filter((o) => o.famille === 'chaos');
  const adr = (i) => '0x' + String(i).repeat(40).slice(0, 40);

  /* Quatre joueurs completent la meme famille, l'un apres l'autre. */
  const rangs = [];
  for (let i = 1; i <= 4; i++) {
    const p = g._p(adr(i)); p.name = 'J' + i;
    for (const o of chaos) p.objets[o.id] = 1;
    const r = g._boutiqueLigne(p, chaos[4], 1000 + i);
    rangs.push(r ? r.prix : null);
  }
  eq(rangs[0], B.PRIX_LIGNE[0], 'le premier touche 50 M');
  eq(rangs[1], B.PRIX_LIGNE[1], 'le deuxieme touche 30 M');
  eq(rangs[2], B.PRIX_LIGNE[2], 'le troisieme touche 10 M');
  eq(rangs[3], null, 'le quatrieme ne touche rien — la course est finie');
  eq(g.boutiqueCourse().restant, 0, 'et il ne reste aucune place');

  /* Le solde a REELLEMENT bouge. Un prix annonce mais pas credite serait le
     pire des deux mondes. */
  eq(jetons(g._p(adr(1))), B.PRIX_LIGNE[0] / 1, 'le solde du premier a bien monte de 50 M');
}

/* UN SEUL PRIX PAR JOUEUR. Sans cette regle, celui qui complete trois
   familles rafle les trois places et la course n'oppose personne. */
{
  const g = new Game();
  const p = g._p(A); p.name = 'Solo';
  let payes = 0;
  for (const f of B.FAMILLES.slice(0, 3)) {
    const lot = B.ITEMS.filter((o) => o.famille === f.cle);
    for (const o of lot) p.objets[o.id] = 1;
    if (g._boutiqueLigne(p, lot[4], 1000)) payes++;
  }
  eq(payes, 1, 'trois familles completees par le meme joueur ne paient qu une fois');
  eq(g.boutiqueCourse().restant, 2, 'et les deux autres places restent ouvertes');
}

/* UNE FAMILLE INCOMPLETE NE PAIE PAS. Le controle porte sur les cinq cases,
   pas sur « il vient d'en gagner une de cette famille ». */
{
  const g = new Game();
  const p = g._p(A);
  const lot = B.ITEMS.filter((o) => o.famille === 'chaos');
  for (const o of lot.slice(0, 4)) p.objets[o.id] = 1;   // quatre sur cinq
  eq(g._boutiqueLigne(p, lot[0], 1000), null, 'quatre cases sur cinq ne paient pas');
  eq(g.boutiqueCourse().restant, 3, 'et aucune place n est consommee');
}

/*
 * LA LISTE DES GAGNANTS SURVIT AU DISQUE.
 *
 * C'est le defaut le plus cher du fichier : un registre perdu au redemarrage
 * ROUVRE la course et repaie quatre-vingt-dix millions, sans rien afficher
 * d'anormal. La boutique continuerait de fonctionner parfaitement.
 */
{
  const g = new Game();
  const chaos = B.ITEMS.filter((o) => o.famille === 'chaos');
  const p = g._p(A); p.name = 'Enzo';
  for (const o of chaos) p.objets[o.id] = 1;
  g._boutiqueLigne(p, chaos[4], 1000);
  eq(g.boutiqueCourse().restant, 2, 'une place prise avant sauvegarde');

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.boutiqueCourse().restant, 2, 'et toujours deux places apres relecture');
  eq(g2.boutiqueCourse().gagnants[0].nom, 'Enzo', 'le gagnant est retrouve par son nom');

  /* Et il ne peut pas regagner apres le redemarrage. */
  const p2 = g2._p(A);
  const luck = B.ITEMS.filter((o) => o.famille === 'chance');
  for (const o of luck) p2.objets[o.id] = 1;
  eq(g2._boutiqueLigne(p2, luck[4], 2000), null,
     'un gagnant d avant le redemarrage ne regagne pas apres');
}

/*
 * L'achat REEL porte bien la ligne dans sa reponse : sans ca, ni l'annonce
 * Telegram ni la page ne sauraient qu'il s'est passe quelque chose.
 *
 * Premiere version de ce controle : on epuisait tout SAUF le mythique voulu,
 * pour le forcer a sortir. Elle heurtait la regle d'epuisement — qui DESCEND
 * et ne remonte jamais : un tirage tombant sur une rarete basse n'avait plus
 * rien en dessous et jetait. Le test etait faux, pas la regle. On epuise donc
 * seulement les cinq AUTRES mythiques et on achete jusqu'a en voir un.
 */
{
  const g = new Game();
  const p = g._p(A); p.balance = WEI(100000000000);
  const chaos = B.ITEMS.filter((o) => o.famille === 'chaos');
  for (const o of chaos.slice(0, 4)) p.objets[o.id] = 1;
  for (const o of B.itemsDe('mythique', 1))
    if (o.id !== chaos[4].id) g.boutiqueEmis[o.id] = B.rarete('mythique').plafond;

  let r = null;
  for (let i = 0; i < 3000 && !(r && r.ligne); i++) {
    p.balance = WEI(100000000000);
    r = g.boutiqueAchat(A, 'mythe');
  }
  ok(!!(r && r.ligne), 'la reponse d achat porte la ligne completee');
  eq(r.item.id, chaos[4].id, 'et c est bien le mythique manquant qui l a fermee');
  eq(r.ligne.prix, B.PRIX_LIGNE[0], 'avec le premier prix');
  eq(r.ligne.familleNom, 'Chaos', 'et le nom de la famille, pour l annonce');
}

/*
 * ==================== 7. LA PORTE DE LA SAISON 2 ====================
 *
 * La regle : la saison 2 s'ouvre a tous quand la saison 1 a rendu ses trois
 * lignes ; les gagnants y entrent des leur propre ligne finie.
 *
 * ---- pourquoi ces controles-la et pas un seul ----
 *
 * Une porte a deux facons de se tromper, et elles ne coutent pas la meme
 * chose. Trop fermee, un gagnant reste dehors : il rale, on corrige. Trop
 * ouverte, tout le monde entre avant l'heure — et une edition entamee ne se
 * referme pas. On verifie donc les deux sens a chaque etape, et on verifie
 * surtout ce qui ne doit PAS arriver.
 *
 * Les lignes sont posees a la main dans `boutiqueLignes` : les faire gagner
 * pour de vrai demanderait des milliers d'achats par joueur et ne testerait
 * pas la porte, mais le tirage — qui a deja sa section.
 */
{
  const C = '0x' + '22'.repeat(20);
  const D = '0x' + '33'.repeat(20);
  const E = '0x' + '44'.repeat(20);
  const ligne = (addr, rang) => ({ addr: String(addr).toLowerCase(), nom: 'j' + rang,
                                   famille: 'chaos', familleNom: 'Chaos',
                                   rang, prix: B.PRIX_LIGNE[rang - 1], t: 1 });
  const achete = (g, addr, coffre) => {
    g._p(addr).balance = WEI(100000000);
    try { g.boutiqueAchat(addr, coffre); return null; } catch (e) { return e.message; }
  };

  // ---- rien de gagne : la saison 2 est fermee pour tout le monde
  {
    const g = new Game();
    eq(g.boutiqueSaisonOuverte(C, 1), true, 'la saison 1 est ouverte sans condition');
    eq(g.boutiqueSaisonOuverte(C, 2), false, 'la saison 2 est fermee tant que rien n est gagne');
    ok(/season 2 opens/.test(achete(g, C, 'armes_bois') || ''),
       'et le serveur REFUSE la caisse d armes, il ne se contente pas de la cacher');
    eq(achete(g, C, 'bois'), null, 'pendant que le coffre de la saison 1 s ouvre normalement');
    /* Le refus doit arriver AVANT le debit. Un joueur a qui l'on prend
       quatre mille jetons pour lui rendre une erreur ne le remarque pas tout
       de suite, et c'est le pire moment pour s'en apercevoir. */
    const p = g._p(D); p.balance = WEI(100000);
    try { g.boutiqueAchat(D, 'armes_bois'); } catch (e) {}
    eq(p.balance.toString(), WEI(100000).toString(), 'et RIEN n a ete debite au passage');
  }

  // ---- une seule ligne : le gagnant entre, personne d'autre
  {
    const g = new Game();
    g.boutiqueLignes = [ligne(C, 1)];
    eq(g.boutiqueSaisonOuverte(C, 2), true, 'le premier gagnant entre des sa ligne finie');
    eq(g.boutiqueSaisonOuverte(D, 2), false, 'les autres attendent encore');
    eq(achete(g, C, 'armes_bois'), null, 'le gagnant ouvre bien une caisse d armes');
    ok(!!achete(g, D, 'armes_bois'), 'et le voisin se fait refuser la meme caisse');
    /* La casse de l'adresse ne doit pas decider de l'acces. */
    eq(g.boutiqueSaisonOuverte(C.toUpperCase(), 2), true,
       'l adresse en majuscules ouvre la meme porte');
  }

  // ---- deux lignes : toujours seulement les deux gagnants
  {
    const g = new Game();
    g.boutiqueLignes = [ligne(C, 1), ligne(D, 2)];
    eq(g.boutiqueSaisonOuverte(C, 2), true, 'le premier est dedans');
    eq(g.boutiqueSaisonOuverte(D, 2), true, 'le deuxieme aussi');
    eq(g.boutiqueSaisonOuverte(E, 2), false, 'le reste du monde attend la troisieme ligne');
  }

  // ---- trois lignes : la saison s'ouvre a tous, gagnants ou non
  {
    const g = new Game();
    g.boutiqueLignes = [ligne(C, 1), ligne(D, 2), ligne(E, 3)];
    const inconnu = '0x' + '55'.repeat(20);
    eq(g.boutiqueSaisonOuverte(inconnu, 2), true,
       'la course finie ouvre la saison 2 a un joueur qui n a jamais rien achete');
    eq(achete(g, inconnu, 'armes_mythe'), null, 'et il peut ouvrir tout de suite');
  }

  // ---- ce que la page recoit, et pourquoi
  {
    const g = new Game();
    let s = g.boutiqueSaisons(C);
    eq(s.length, 2, 'la page recoit les deux saisons, pas seulement celles qu on peut ouvrir');
    eq(s[1].ouverte, false, 'la deuxieme est annoncee fermee');
    eq(s[1].faites + '/' + s[1].sur, '0/3', 'avec le compte qui dit ce qu il manque');

    g.boutiqueLignes = [ligne(C, 1)];
    s = g.boutiqueSaisons(C);
    eq(s[1].ouverte, true, 'le gagnant la voit ouverte');
    eq(s[1].avance, true, 'et sait qu il y est EN AVANCE');
    eq(s[1].rang, 1, 'avec son rang, pour le dire');
    eq(g.boutiqueSaisons(D)[1].avance, false, 'le voisin n a aucune avance a afficher');

    g.boutiqueLignes = [ligne(C, 1), ligne(D, 2), ligne(E, 3)];
    eq(g.boutiqueSaisons(C)[1].avance, false,
       'et l avance disparait quand la course est finie : plus personne n est en avance');
  }

  // ---- une saison fermee ne fuit pas par l'etat
  {
    const g = new Game();
    const e = g.boutiqueEtat(C, 2);
    eq(e.saison, 1, 'demander une saison fermee retombe sur la saison 1');
    ok(e.catalogue.items.every((o) => o.saison === undefined || o.saison === 1),
       'et le catalogue rendu ne contient aucun objet de la saison fermee');
    eq(e.catalogue.items.length, 30, 'trente objets, pas soixante');
    g.boutiqueLignes = [ligne(C, 1)];
    eq(g.boutiqueEtat(C, 2).saison, 2, 'le gagnant, lui, recoit bien la saison 2');
    eq(g.boutiqueEtat(D, 2).saison, 1, 'et le voisin retombe sur la premiere');
  }

  // ---- le classement compte PAR saison
  {
    const g = new Game();
    const p = g._p(C);
    for (const o of B.itemsDeSaison(1).slice(0, 7)) p.objets[o.id] = 1;
    const c1 = g.boutiqueClassement(C, 10, 1);
    const c2 = g.boutiqueClassement(C, 10, 2);
    eq(c1.sur, 30, 'le classement de la saison 1 porte sur trente objets');
    eq(c1.moi.sortes, 7, 'et compte les sept fruits');
    eq(c2.total, 0, 'celui de la saison 2 ne connait encore personne');
    eq(c2.sur, 30, 'mais sait deja sur combien il porte');
    eq(c1.moi.avoir.length, 30, 'la rangee allumee fait trente cases, pas soixante');
  }

  // ---- LA COURSE APPARTIENT A LA SAISON 1
  {
    const g = new Game();
    const p = g._p(C); p.balance = WEI(100000000000);
    /* On lui donne quatre armes Blade sur cinq, puis on epuise les autres
       mythiques d armes pour forcer la cinquieme a sortir. */
    const lame = B.ITEMS.filter((o) => o.famille === 'lame');
    for (const o of lame.slice(0, 4)) p.objets[o.id] = 1;
    for (const o of B.itemsDe('mythique', 2))
      if (o.id !== lame[4].id) g.boutiqueEmis[o.id] = B.rarete('mythique').plafond;
    g.boutiqueLignes = [ligne(D, 1)];        // une place encore libre, et C n a rien gagne
    /* C n'a pas acces... on l'ouvre en le faisant gagnant d'une ligne de la
       saison 1 sur une AUTRE adresse ? Non : on le rend gagnant lui-meme,
       c'est le seul chemin par lequel il pourrait toucher une deuxieme fois. */
    g.boutiqueLignes = [ligne(C, 1)];
    let r = null, ligneRendue = null;
    for (let i = 0; i < 3000 && !ligneRendue; i++) {
      p.balance = WEI(100000000000);
      r = g.boutiqueAchat(C, 'armes_mythe');
      if (r.ligne) ligneRendue = r.ligne;
      if (r.item.id === lame[4].id) break;
    }
    eq(ligneRendue, null,
       'completer une famille d ARMES ne prend aucune des trois places de la saison 1');
    eq(g.boutiqueLignes.length, 1, 'et la liste des gagnants n a pas bouge');
  }
}

console.log(`boutique.test.js : ${n} verifications OK`);
