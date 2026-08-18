'use strict';
/*
 * LE RACHAT INSTANTANE.
 *
 * ---- ce qu'on cherche, dans l'ordre ----
 *
 * 1. PAS DE MACHINE A BILLETS. C'est la seule chose qui puisse tuer le jeton.
 *    Un coffre coute un prix connu et rend un objet dont le prix de rachat est
 *    connu : si le rachat d'un objet paie plus que le coffre le moins cher qui
 *    peut le sortir, on peut faire tourner la boucle a l'infini. Le test ne
 *    raisonne pas sur le bareme — il ENUMERE tous les coffres de toutes les
 *    saisons et tous les objets qu'ils peuvent tirer, et refuse le premier
 *    couple qui rapporte.
 *
 * 2. LE REGISTRE NE PASSE JAMAIS SOUS ZERO. Un `emis` negatif afficherait
 *    plus d'exemplaires restants qu'il n'en existe, et le plafond — le seul
 *    argument de rarete du site — ne voudrait plus rien dire.
 *
 * 3. UN OBJET EPUISE REDEVIENT TIRABLE. C'est la raison d'etre du recyclage :
 *    sans elle, revendre reviendrait a bruler, et les communs — les moins bien
 *    payes donc les plus revendus — disparaitraient en premier. Le jour ou ils
 *    sont partis, plus personne ne peut completer une famille.
 *
 * 4. L'XP NE SE REFARME PAS. Tirer, revendre, retirer : le cout est un coffre,
 *    le gain serait une XP deja touchee. C'est le trou que le rachat ouvre
 *    dans un systeme ou « neuf » voulait dire « pas dans l'inventaire ».
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

/* Un joueur qui a franchi la porte du rachat : du volume DEJA JOUE. Les tests
   de la mecanique ne sont pas les tests de la porte — celle-ci a sa propre
   section, et elle verifie qu'on ne passe pas sans. */
const pose = (g, addr, credit) => {
  const p = g._p(addr);
  p.balance = WEI(credit === undefined ? 10000000 : credit);
  p.hasDeposited = true;
  p.wagered = WEI(cfg.RACHAT_VOLUME_MIN);
  p.objets = p.objets || {};
  return p;
};

// ================== 1. LE BAREME
{
  /* Il descend avec le plafond, et il n'est pas ecrit a la main : c'est
     RACHAT_BASE x 1000 / plafond, le meme poids que le classement. Un bareme
     tape au clavier serait a refaire — et a oublier — a chaque plafond. */
  const p = (cle) => B.prixRachat(cle, cfg.RACHAT_BASE);
  const l = B.RARETES.map((r) => p(r.cle));
  for (let i = 1; i < l.length; i++) {
    ok(l[i] > l[i - 1], `${B.RARETES[i].cle} paie plus que ${B.RARETES[i - 1].cle}`);
  }
  eq(p('commun'), cfg.RACHAT_BASE, 'le commun vaut la base');
  eq(p('inconnu'), 0, 'une rarete inconnue ne paie rien');
  ok(l.every((x) => x > 0 && x % 10 === 0), 'des sommes rondes, lisibles sur un bouton');
}

// ================== 2. AUCUN COFFRE NE SE RACHETE A PROFIT
{
  /*
   * ---- ce qu'il faut mesurer, et ce qu'il ne faut PAS mesurer ----
   *
   * La premiere version de ce test comparait le MEILLEUR objet du coffre a son
   * prix, et elle echouait : un coffre de bois a 4 000 peut sortir un mythique
   * qui se rachete 50 000. Ce n'est pas une machine a billets, c'est le lot.
   * Un joueur ne peut pas acheter le mythique tout seul — il achete un tirage,
   * et le tirage est ce qu'il faut peser.
   *
   * On calcule donc l'ESPERANCE de rachat d'un coffre a partir de sa propre
   * table de poids : somme des (probabilite x prix de rachat). Si elle
   * depassait le prix du coffre, ouvrir-et-revendre en boucle rapporterait, et
   * le jeton serait mort en quelques jours. Elle est calculee sur la table
   * reelle, pas recopiee : changer un poids refait le test tout seul.
   */
  const ratios = [];
  for (const c of B.COFFRES) {
    const t = c.table || [];
    const somme = t.reduce((a, x) => a + x[1], 0);
    ok(somme > 0, `${c.cle} a une table de tirage`);
    const esp = t.reduce((a, x) => a + (x[1] / somme) * B.prixRachat(x[0], cfg.RACHAT_BASE), 0);
    ok(esp < c.prix,
       `${c.cle} : esperance de rachat ${Math.round(esp)} < prix ${c.prix}`);
    ratios.push({ cle: c.cle, r: esp / c.prix });
  }
  /*
   * Et la marge n'est pas mince. Un rapport de 90 % passerait ce test tout en
   * devenant une machine a billets au premier ajustement de plafond. On veut
   * le voir tenir largement, pour que la prochaine main qui touche au bareme
   * ait de la place devant elle.
   */
  const pire = ratios.reduce((a, b) => (b.r > a.r ? b : a));
  ok(pire.r < 0.45,
     `le coffre le plus genereux (${pire.cle}) ne rend que ` +
     `${(pire.r * 100).toFixed(1)} % de son prix en rachat`);

  /*
   * Le lot reste un lot : le meilleur objet paie plus que le coffre, et c'est
   * VOULU — sans ca, personne n'aurait de raison d'ouvrir. On verifie
   * seulement qu'on ne peut pas le viser : sa probabilite doit rester
   * derisoire, sinon l'esperance ci-dessus basculerait au premier coup de
   * pouce sur les poids.
   */
  for (const c of B.COFFRES) {
    const t = c.table || [];
    const somme = t.reduce((a, x) => a + x[1], 0);
    const gagnantes = t.filter((x) => B.prixRachat(x[0], cfg.RACHAT_BASE) > c.prix);
    const pGagne = gagnantes.reduce((a, x) => a + x[1], 0) / somme;
    ok(pGagne < 0.05,
       `${c.cle} : ${(pGagne * 100).toFixed(2)} % des tirages valent plus que le coffre`);
  }
}

// ================== 3. LE RACHAT PAIE, RETIRE, ET NE DUPLIQUE PAS
{
  const g = new Game();
  const p = pose(g, A, 1000);
  const o = B.itemsDeSaison(1)[0];
  p.objets[o.id] = 3;
  g.boutiqueEmis = { [o.id]: 3 };
  const u = g.prixRachatDe(o.id);

  const r = g.boutiqueRachat(A, o.id, 2);
  eq(r.qte, 2, 'deux vendus');
  eq(r.unite, u, 'au prix du bareme');
  eq(r.total, u * 2, 'et le total suit');
  eq(sol(g, A), 1000 + u * 2, 'le solde monte d exactement ce montant');
  eq(p.objets[o.id], 1, 'il lui en reste un');
  eq(g.boutiqueEmis[o.id], 1, 'et le registre est redescendu d autant');
}

// ================== 4. ON NE VEND PAS CE QU'ON N'A PAS
{
  const g = new Game();
  const p = pose(g, A);
  const o = B.itemsDeSaison(1)[0];
  const avant = sol(g, A);

  assert.throws(() => g.boutiqueRachat(A, o.id, 1), /do not own/, 'rien en main');
  n++;
  p.objets[o.id] = 1;
  assert.throws(() => g.boutiqueRachat(A, o.id, 2), /only own 1/, 'plus que ce qu on a');
  n++;
  assert.throws(() => g.boutiqueRachat(A, 999999, 1), /unknown item/, 'objet inexistant');
  n++;
  eq(sol(g, A), avant, 'aucun de ces refus n a touche au solde');
  eq(p.objets[o.id], 1, 'ni a l inventaire');
}

// ================== 5. LE REGISTRE NE PASSE JAMAIS SOUS ZERO
{
  /* Le cas ou le registre et l'inventaire ne sont pas d'accord — une
     restauration partielle, un import. Le rachat doit rester une operation
     sure : il plafonne a zero au lieu de creuser. */
  const g = new Game();
  const p = pose(g, A);
  const o = B.itemsDeSaison(1)[0];
  p.objets[o.id] = 5;
  g.boutiqueEmis = { [o.id]: 2 };          // moins que ce qu'il possede
  g.boutiqueRachat(A, o.id, 5);
  eq(g.boutiqueEmis[o.id], 0, 'plancher a zero');
  ok(g.boutiqueEmis[o.id] >= 0, 'jamais negatif');
  eq(p.objets[o.id], undefined, 'et l inventaire est vide, pas a zero');
}

// ================== 6. UN OBJET EPUISE REDEVIENT TIRABLE
{
  const g = new Game();
  const p = pose(g, A);
  const o = B.itemsDeSaison(1)[0];
  const plafond = B.rarete(o.rarete).plafond;
  p.objets[o.id] = 1;
  g.boutiqueEmis = { [o.id]: plafond };    // edition fermee sur ce dessin

  /* « Epuise » n'est pas un drapeau range quelque part : c'est emis >= plafond,
     lu au moment ou on regarde. Le test pose donc la meme question que la page
     et que le tirage, et pas une troisieme. */
  const vu = () => B.catalogue(g.boutiqueEmis, 1, cfg.RACHAT_BASE).items.find((x) => x.id === o.id);
  eq(vu().emis >= vu().plafond, true, 'le catalogue le donne epuise');

  g.boutiqueRachat(A, o.id, 1);
  eq(vu().emis >= vu().plafond, false, 'apres le rachat il est de nouveau disponible');
  eq(vu().emis, plafond - 1, 'un exemplaire de moins en circulation');
  /* C'est TOUT l'interet : la piece qu'un joueur revend est celle qui manque
     a un autre pour finir sa famille. */
  eq(vu().plafond - vu().emis, 1, 'exactement une place rouverte');
}

// ================== 7. LE CATALOGUE PORTE LE PRIX
{
  const c = B.catalogue({}, 1, cfg.RACHAT_BASE);
  ok(c.items.every((o) => o.rachat > 0), 'chaque objet sait a combien il se revend');
  ok(c.items.every((o) => o.rachat === B.prixRachat(o.rarete, cfg.RACHAT_BASE)),
     'et c est le meme bareme que le serveur applique');
  /* La page lit ce champ pour peindre le bouton. S'il manquait, elle
     afficherait « Sell instantly for 0 » sans que rien ne casse. */
  const g = new Game(); pose(g, A);
  ok(g.boutiqueEtat(A, 1).catalogue.items.every((o) => o.rachat > 0),
     'et il traverse boutiqueEtat jusqu a la page');
}

// ================== 8. LE RACHAT EST UNE DEPENSE, PAS UNE RECETTE
{
  /*
   * L'achat d'un coffre monte la ligne `boutique`. Le rachat NE DOIT PAS la
   * faire monter : sinon vendre-puis-racheter gonflerait le chiffre d'affaires
   * du mois sans qu'un jeton entre, et le prix du classement — qui en est une
   * part — suivrait ce chiffre imaginaire. Il a sa propre ligne, negative.
   */
  const g = new Game();
  const p = pose(g, A);
  const o = B.itemsDeSaison(1)[0];
  p.objets[o.id] = 1;
  const u = g.prixRachatDe(o.id);

  const m0 = g._mois();
  const bAvant = m0.boutique || 0;
  g.boutiqueRachat(A, o.id, 1);
  const m1 = g._mois();
  eq(m1.boutique || 0, bAvant, 'la ligne des ventes de coffres n a pas bouge');
  eq(m1.rachat, -u, 'le rachat est pose en negatif, sur sa propre ligne');

  /* Deux rachats s additionnent, toujours vers le bas. */
  p.objets[o.id] = 1;
  g.boutiqueRachat(A, o.id, 1);
  eq(g._mois().rachat, -u * 2, 'et il s accumule dans le bon sens');
}

// ================== 9. L'XP NE SE REFARME PAS
{
  /*
   * La boucle : j'ouvre un coffre, l'objet est neuf, je touche l'XP de
   * collection. Je le revends. Je le retire un jour. Sans registre permanent,
   * il est « neuf » une deuxieme fois et l'XP retombe.
   */
  const g = new Game();
  const p = pose(g, A);
  const o = B.itemsDeSaison(1)[0];

  /* On simule le premier tirage en passant par le chemin reel : on marque
     l'objet comme deja paye, puis on verifie que le rachat n'efface pas la
     marque. */
  p.objets[o.id] = 1;
  p.xpObjets = { [o.id]: 1 };
  g.boutiqueEmis = { [o.id]: 1 };
  g.boutiqueRachat(A, o.id, 1);
  eq(p.objets[o.id], undefined, 'l objet est parti de l inventaire');
  eq(p.xpObjets[o.id], 1, 'mais la marque « deja paye » reste');
}

// ================== 10. LA MARQUE SURVIT AU REDEMARRAGE
{
  const g = new Game();
  const p = pose(g, A);
  const o = B.itemsDeSaison(1)[0];
  p.objets[o.id] = 1;
  p.xpObjets = { [o.id]: 1 };
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2._p(A).xpObjets[o.id], 1, 'le registre part au fichier et en revient');
}

// ================== 11. LES FICHES D'AVANT NE REGAGNENT PAS LE BONUS FAMILLE
{
  /*
   * Personne n'a de `xpFamilles` dans les fichiers ecrits avant ce jour. Si on
   * se contentait de lire un objet vide, il aurait suffi de revendre une piece
   * d'une famille complete et de la retirer pour encaisser une deuxieme fois
   * les deux mille points. La marque se reconstitue donc a la lecture : qui
   * possede la famille entiere a forcement deja ete paye.
   */
  const fam = B.FAMILLES.find((f) => f.saison === 1);
  const l = B.ITEMS.filter((o) => o.famille === fam.cle);
  ok(l.length > 0, 'la famille a des pieces');

  const g = new Game();
  const p = pose(g, A);
  l.forEach((o) => { p.objets[o.id] = 1; });

  const brut = JSON.parse(JSON.stringify(g.serialize()));
  /* On efface le champ, comme un vieux fichier. */
  brut.players.forEach((e) => { delete e[1].xfa; });
  const g2 = new Game();
  g2.hydrate(brut);
  eq(g2._p(A).xpFamilles[fam.cle], 1, 'la famille complete est marquee payee');

  /* Une famille incomplete, elle, n'est pas marquee : le joueur doit encore
     pouvoir gagner son bonus. */
  const g3 = new Game();
  const q = pose(g3, C);
  l.slice(0, l.length - 1).forEach((o) => { q.objets[o.id] = 1; });
  const b3 = JSON.parse(JSON.stringify(g3.serialize()));
  b3.players.forEach((e) => { delete e[1].xfa; });
  const g4 = new Game();
  g4.hydrate(b3);
  eq(g4._p(C).xpFamilles[fam.cle], undefined, 'une famille incomplete reste a gagner');
}

// ================== 12. LA PORTE : IL FAUT AVOIR JOUE
{
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(1000); p.hasDeposited = true; p.objets = {};
  const o = B.itemsDeSaison(1)[0];
  p.objets[o.id] = 1;
  const req = cfg.RACHAT_VOLUME_MIN;

  /* A zero de volume : refuse, et le message porte le chiffre qui manque. */
  eq(g.rachatVerrou(A).ouvert, false, 'un compte qui n a rien joue est ferme');
  eq(g.rachatVerrou(A).reste, req, 'il lui manque tout');
  assert.throws(() => g.boutiqueRachat(A, o.id, 1), /unlock instant sell/, 'le rachat est refuse');
  n++;
  eq(sol(g, A), 1000, 'et rien n a bouge sur le solde');
  eq(p.objets[o.id], 1, 'ni sur l inventaire');

  /* Juste en dessous : toujours ferme. Une porte qui s'ouvre a 99 % n'est pas
     une porte, c'est un arrondi. */
  p.wagered = WEI(req - 1);
  eq(g.rachatVerrou(A).ouvert, false, 'a un jeton pres, c est encore ferme');
  eq(g.rachatVerrou(A).reste, 1, 'et il reste exactement un jeton a jouer');
  assert.throws(() => g.boutiqueRachat(A, o.id, 1), /unlock instant sell/, 'toujours refuse');
  n++;

  /* Pile dessus : ouvert. */
  p.wagered = WEI(req);
  eq(g.rachatVerrou(A).ouvert, true, 'au seuil exact, c est ouvert');
  eq(g.rachatVerrou(A).reste, 0, 'plus rien a jouer');
  const r = g.boutiqueRachat(A, o.id, 1);
  ok(r.total > 0, 'et le rachat passe');
}

// ================== 13. LE DEPOT NE SUFFIT PAS
{
  /*
   * C'est le coeur du choix. Un depot SE RETIRE : deposer, debloquer, retirer,
   * recommencer sur l'adresse suivante — la porte s'ouvrirait avec de l'argent
   * qu'on recupere, donc gratuitement. Le volume est depense, lui.
   *
   * Le test le dit dans les deux sens, parce que c'est la confusion qu'on
   * cherche a rendre impossible.
   */
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(10000000); p.hasDeposited = true;
  p.deposited = WEI(10000000);            // il a depose GROS
  p.wagered = WEI(0);                     // et n'a rien joue
  p.objets = {};
  const o = B.itemsDeSaison(1)[0];
  p.objets[o.id] = 1;
  assert.throws(() => g.boutiqueRachat(A, o.id, 1), /unlock instant sell/,
                'un gros depot sans une seule mise n ouvre rien');
  n++;

  /* L'inverse : rien depose, mais du volume joue. La porte s'ouvre — c'est
     bien le volume qu'on demande, pas la fortune. */
  const g2 = new Game();
  const q = g2._p(C);
  q.balance = WEI(1000); q.hasDeposited = false;
  q.wagered = WEI(cfg.RACHAT_VOLUME_MIN);
  q.objets = { [o.id]: 1 };
  const r = g2.boutiqueRachat(C, o.id, 1);
  ok(r.total > 0, 'du volume joue ouvre la porte, meme sans depot enregistre');
}

// ================== 14. LA FERME DU COFFRE GRATUIT EST FERMEE
{
  /*
   * LE test. C'est la seule ferme que le rachat ouvrait, et c'est pour elle
   * que la porte existe : une adresse jetable prend le coffre offert chaque
   * jour et le revend. Sans porte, mille adresses emettent trois quarts de
   * million de jetons par jour sans qu'un seul soit entre.
   *
   * On la joue en vrai : cent adresses neuves, chacune prend son coffre
   * gratuit et essaie de revendre tout ce qu'elle en tire.
   */
  const g = new Game();
  const N = 60;                            // sous le contingent du jour, voir plus bas
  let emis = 0, refuses = 0, servis = 0;
  const adr = (i) => '0x' + (i + 16).toString(16).padStart(2, '0').repeat(20);
  for (let i = 0; i < N; i++) {
    const a = adr(i);
    g.grantWelcome(a);
    const p = g._p(a);
    const avant = sol(g, a);
    g.ouvreCoffreOffert(a);               // gratuit, sans depot, sans volume
    servis++;
    for (const id of Object.keys(p.objets || {})) {
      try { g.boutiqueRachat(a, Number(id), p.objets[id]); }
      catch (e) { refuses++; }
    }
    emis += sol(g, a) - avant;
  }
  eq(servis, N, 'les soixante adresses ont bien recu leur coffre');
  eq(refuses, N, 'et les soixante tentatives de revente sont refusees');
  eq(Math.round(emis), 0, 'zero jeton emis par la ferme');
  ok(Object.keys(g._p(adr(0)).objets).length > 0,
     'ils ont bien recu un objet — c est la REVENTE qui est fermee, pas le cadeau');

  /* ---- LE DEUXIEME FREIN, QUI EXISTAIT DEJA ----
   *
   * Le contingent quotidien de coffres offerts. Meme si la porte du rachat
   * sautait un jour, la ferme buterait sur lui : elle ne peut pas servir plus
   * de COFFRES_GRATUITS_JOUR adresses par jour. Les deux freins sont
   * INDEPENDANTS — c'est ce qui fait qu'une erreur sur l'un ne suffit pas.
   * Trouve en ecrivant ce test : la ferme a cent adresses butait dessus avant
   * meme d'atteindre le rachat. */
  let sert = 0, bute = 0;
  for (let i = N; i < N + 60; i++) {
    try { g.grantWelcome(adr(i)); g.ouvreCoffreOffert(adr(i)); sert++; }
    catch (e) { bute++; }
  }
  eq(sert + N, cfg.COFFRES_GRATUITS_JOUR,
     `le contingent du jour s arrete a ${cfg.COFFRES_GRATUITS_JOUR}`);
  ok(bute > 0, 'et les suivantes butent dessus');
}

// ================== 15. LA BOUCLE COMPLETE, EN VRAI
{
  /*
   * Le test qui vaut les onze autres : on achete des coffres pour de vrai, on
   * revend TOUT, et on regarde le solde. Il doit avoir baisse. Si un jour un
   * bareme, un plafond ou un poids de tirage change de travers, c'est ici que
   * ca se verra — sans qu'on ait a refaire le raisonnement.
   */
  const g = new Game();
  const p = pose(g, A, 1000000);
  const depart = sol(g, A);
  const c = B.COFFRES.find((x) => x.saison === 1);

  for (let i = 0; i < 200; i++) g.boutiqueAchat(A, c.cle);
  /* On revend l'inventaire entier, piece par piece. */
  for (const id of Object.keys(p.objets)) {
    g.boutiqueRachat(A, Number(id), p.objets[id]);
  }
  ok(sol(g, A) < depart,
     `200 coffres ouverts puis tout revendu : ${nb(depart)} -> ${nb(sol(g, A))}`);
  eq(Object.keys(p.objets).length, 0, 'et il ne lui reste rien');
  /* Le registre, lui, est revenu a son point de depart : tout ce qui est sorti
     est rentre. C'est la promesse du recyclage, verifiee de bout en bout. */
  const reste = Object.values(g.boutiqueEmis || {}).reduce((a, b) => a + b, 0);
  eq(reste, 0, 'le registre est revenu a zero — rien n a fuit');
}
function nb(x) { return Math.round(x).toLocaleString('en-US'); }

console.log(`rachat.test.js : ${n} verifications OK`);
