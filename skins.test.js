'use strict';
/*
 * LES SKINS DE PERSONNAGE.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. RIEN A VOIR AVEC LES SAISONS. Le catalogue ne prend aucun parametre de
 *    saison, il ne verifie aucune ligne, et il ne se ferme jamais.
 * 2. LE PRIX SUIT LA PUISSANCE. Six skins, six prix, une progression
 *    stricte — pas six nombres tapes au hasard.
 * 3. L'ACHAT EST UNE DEPENSE REELLE : le solde baisse exactement du prix
 *    affiche, et la ligne part en RECETTE ('boutique'), comme un coffre.
 * 4. ON NE PEUT PAS RACHETER CE QU'ON A DEJA. Et acheter un second skin ne
 *    fait pas disparaitre le premier — seul celui qu'on PORTE change.
 * 5. UN SKIN SURVIT AU REDEMARRAGE, et une fiche qui n'a qu'un skin n'est
 *    pas purgee comme si elle etait vide.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const S = require('./skins');
const P = require('./personnages');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const sol = (g, a) => Number(g.balanceStr(a));
const A = '0x' + 'a1'.repeat(20);

const pose = (g, addr, credit) => {
  const p = g._p(addr);
  p.balance = WEI(credit === undefined ? 1000000 : credit);
  p.hasDeposited = true;
  return p;
};

// ================== 1. LE CATALOGUE — SIX SKINS, RIEN DE SAISONNIER
{
  const c = S.catalogue();
  eq(c.length, 6, 'six skins');
  eq(new Set(c.map((s) => s.id)).size, 6, 'six identifiants distincts');
  ok(c.every((s) => !('saison' in s)), 'aucun skin ne porte de saison');
  /* ---- CELUI QU'ON DONNE ----
   * Andy est offert : tout le monde en a un, sans avoir rien depose. Il n'y a
   * donc plus « un prix pour chaque skin », il y a « un prix pour chaque skin
   * qu'on vend » — et un seul qui ne se vend pas.
   * On verifie les DEUX cotes, sinon un jour toute la boutique passe a zero
   * sans que rien ne le dise. */
  const offerts = c.filter((s) => s.offert);
  eq(offerts.length, 1, `un seul skin est offert (${offerts.map((s) => s.id).join(', ')})`);
  eq(offerts[0].id, 'andy', 'et c est Andy — la decision est d ACCUEIL, pas de puissance');
  eq(offerts[0].prix, 0, 'il ne coute rien');
  ok(c.filter((s) => !s.offert).every((s) => s.prix > 0),
     'et tous les autres ont un prix');
  /* Le drapeau le DIT au lieu de laisser deviner « prix a zero donc
     gratuit » : un prix a zero peut aussi vouloir dire « prix inconnu », et
     les deux ne s'affichent pas pareil. */
  ok(c.every((s) => typeof s.offert === 'boolean'), 'chaque fiche dit si elle est offerte');
  ok(c.every((s) => s.puissance >= 1 && s.puissance <= 6), 'puissance entre 1 et 6');
  eq(new Set(c.map((s) => s.puissance)).size, 6, 'six puissances distinctes — un classement, pas des ex-aequo');
}

// ================== 1b. LA PUISSANCE SUIT LES VRAIES STATS, PAS UN CHIFFRE POSE A COTE
{
  /* Si un skin possede plus de stats brutes qu'un autre, il DOIT couter
     plus cher — sinon un joueur qui regarde sa fiche de personnage voit un
     skin plus fort moins cher qu'un skin plus faible, et le prix ment. */
  const force = (id) => P.STATS.reduce((t, k) => t + (P.BASE[id][k] || 0), 0);
  const c = S.catalogue();
  eq(new Set(c.map((s) => force(s.id))).size, 6, 'les six sommes de stats sont distinctes — sinon le classement serait arbitraire entre deux ex-aequo');
  const parForce = c.slice().sort((a, b) => force(a.id) - force(b.id));
  const parPuissance = c.slice().sort((a, b) => a.puissance - b.puissance);
  eq(parForce.map((s) => s.id).join(','), parPuissance.map((s) => s.id).join(','),
     'le classement par puissance (et donc par prix) est EXACTEMENT le classement par force reelle');
}

// ================== 2. LE PRIX SUIT LA PUISSANCE, EN PROGRESSION STRICTE
{
  const c = S.catalogue().slice().sort((a, b) => a.puissance - b.puissance);
  for (let i = 1; i < c.length; i++) {
    ok(c[i].prix > c[i - 1].prix,
       `puissance ${c[i].puissance} (${c[i].nom}) coute plus que puissance ${c[i - 1].puissance} (${c[i - 1].nom})`);
  }
  /* Le barème n'est pas invente sur la fiche : il vient d'une seule table
     (PUISSANCE_PRIX), donc prixDe() et catalogue() ne peuvent pas diverger. */
  c.forEach((s) => eq(s.prix, S.prixDe(s.id), `${s.id} : meme prix par les deux chemins`));
}

// ================== 3. UN IDENTIFIANT INCONNU NE CASSE RIEN
{
  eq(S.skin('n-existe-pas'), null, 'skin() rend null');
  eq(S.prixDe('n-existe-pas'), 0, 'prixDe() rend zero, pas une exception');
}

// ================== 4. L'ACHAT DEBITE EXACTEMENT LE PRIX AFFICHE
{
  const g = new Game();
  pose(g, A, 1000000);
  const avant = sol(g, A);
  const prixAndy = S.prixDe('andy');
  const r = g.acheteSkin(A, 'andy');
  eq(r.prix, prixAndy, 'le prix rendu est celui du catalogue');
  eq(sol(g, A), avant - prixAndy, 'le solde baisse exactement de ce prix');
  eq(r.actif, 'andy', 'le skin achete devient actif');
}

// ================== 5. LE PREMIER ACHAT DEVIENT LE SKIN PORTE
{
  const g = new Game();
  const p = pose(g, A, 1000000);
  eq(p.skinActif || null, null, 'personne ne porte rien au depart');
  g.acheteSkin(A, 'claude');
  eq(p.skinActif, 'claude', 'porte des l achat, sans second geste');
}

// ================== 6. ON NE RACHETE PAS CE QU'ON A DEJA
{
  const g = new Game();
  pose(g, A, 1000000);
  g.acheteSkin(A, 'pepe');
  const avant = sol(g, A);
  assert.throws(() => g.acheteSkin(A, 'pepe'), /already own/, 'refuse le doublon');
  n++;
  eq(sol(g, A), avant, 'et rien n a ete debite pour le refus');
}

// ================== 7. PAS D'ARGENT, PAS DE SKIN — SAUF CELUI QU'ON DONNE
{
  const g = new Game();
  const p = pose(g, A, 100);        // bien moins que le moins cher qui se vende
  assert.throws(() => g.acheteSkin(A, 'pepe'), /not enough/, 'refuse sans assez de solde');
  n++;
  eq(sol(g, A), 100, 'le solde n a pas bouge');
  ok(!(p.skins || {}).pepe, 'et rien n a ete accorde');

  /* ---- MAIS ANDY, OUI ----
   * Cent jetons ne paient rien, et pourtant on repart avec un personnage.
   * C'est tout le changement : il n'existe pas de version du jeu ou l'on
   * regarde sans pouvoir jouer. */
  const r = g.acheteSkin(A, 'andy');
  ok(r.offert, 'Andy se prend sans payer');
  eq(r.prix, 0, 'il ne coute rien');
  eq(sol(g, A), 100, 'et le solde n a toujours pas bouge');
  eq(r.actif, 'andy', 'on le porte tout de suite');
}

// ================== 7 bis. ET ON L'A DEJA AVANT MEME DE LE PRENDRE
//
// Posseder Andy est une REPONSE, pas une donnee. La difference n'est pas
// theorique : une fiche qui possede un skin n'est plus vide, donc plus
// elaguable, donc ECRITE SUR LE DISQUE. Chaque visiteur qui charge la page —
// y compris celui qui repart aussitot — serait devenu une ligne permanente du
// fichier de sauvegarde.
{
  const g = new Game();
  const p = g._p(A);
  ok(g.possedeSkin(p, 'andy'), 'un compte neuf possede Andy');
  ok(!g.possedeSkin(p, 'pepe'), 'et pas les autres');
  eq(g.skinActifDe(p), 'andy', 'et il le porte, sans avoir rien choisi');
  eq(Object.keys(p.skins || {}).length, 0,
     'sans que RIEN ne soit ecrit sur sa fiche');
  eq(g.fiche(A), null, 'qui reste vide, donc absente du disque');

  /* Et la page le voit comme possede, pas comme a vendre. */
  const cat = g.skinsEtat(A).catalogue;
  const andy = cat.find((s) => s.id === 'andy');
  ok(andy.possede, 'le catalogue le montre possede');
  ok(andy.offert, 'et offert');
  eq(g.skinsEtat(A).actif, 'andy', 'et porte');
}

// ================== 8. UN IDENTIFIANT INCONNU EST REFUSE, PAS ACCEPTE EN SILENCE
{
  const g = new Game();
  pose(g, A, 1000000);
  assert.throws(() => g.acheteSkin(A, 'zorglub'), /unknown skin/, 'refuse un identifiant qui n existe pas');
  n++;
}

// ================== 9. DEUX ACHATS N'EFFACENT PAS LE PREMIER
{
  const g = new Game();
  const p = pose(g, A, 1000000);
  g.acheteSkin(A, 'andy');
  g.acheteSkin(A, 'claude');
  ok(p.skins.andy, 'andy toujours possede');
  ok(p.skins.claude, 'claude toujours possede aussi');
  eq(p.skinActif, 'claude', 'seul le PORTE a change, pas la possession');
}

// ================== 10. CHOISIR PARMI CE QU'ON POSSEDE
{
  const g = new Game();
  pose(g, A, 1000000);
  g.acheteSkin(A, 'andy');
  g.acheteSkin(A, 'claude');       // actif = claude
  const r = g.choisitSkin(A, 'andy');
  eq(r.actif, 'andy', 'on peut revenir a un skin deja possede');
  eq(g._p(A).skinActif, 'andy', 'et c est bien lui qui est porte');
}

// ================== 11. ON NE PORTE PAS CE QU'ON N'A PAS ACHETE
{
  const g = new Game();
  pose(g, A, 1000000);
  g.acheteSkin(A, 'andy');
  assert.throws(() => g.choisitSkin(A, 'ogswoge'), /do not own/, 'refuse un skin jamais achete');
  n++;
  eq(g._p(A).skinActif, 'andy', 'le skin porte n a pas bouge');
}

// ================== 12. skinsEtat() : LE CATALOGUE PLUS CE QU'ON PORTE
{
  const g = new Game();
  pose(g, A, 1000000);
  const avant = g.skinsEtat(A);
  /* Au depart on porte CELUI QU'ON DONNE, et lui seul est possede. C'etait
     « rien de porte, rien de possede » avant qu'Andy soit offert. */
  eq(avant.actif, 'andy', 'on porte Andy au depart');
  eq(avant.catalogue.filter((s) => s.possede).length, 1, 'et lui seul est possede');

  g.acheteSkin(A, 'landwolf');
  const apres = g.skinsEtat(A);
  eq(apres.actif, 'landwolf', 'acheter en porte un autre');
  const l = apres.catalogue.find((s) => s.id === 'landwolf');
  ok(l.possede, 'landwolf marque possede');
  eq(apres.catalogue.filter((s) => s.possede).length, 2,
     'et on a maintenant les deux — l offert ne disparait pas quand on achete');
}

// ================== 13. LA DEPENSE EST COMPTEE COMME UNE RECETTE, PAS UN CADEAU
{
  const g = new Game();
  pose(g, A, 1000000);
  const m0 = g._mois();
  const avantBoutique = m0.boutique || 0;
  const prix = S.prixDe('ogswoge');
  g.acheteSkin(A, 'ogswoge');
  const m1 = g._mois();
  eq(m1.boutique || 0, avantBoutique + prix,
     'le prix du skin s ajoute a la meme ligne que les coffres — c est un achat, pas un don');
}

// ================== 14. UNE FICHE QUI N'A QU'UN SKIN N'EST PAS PURGEE
{
  const g = new Game();
  pose(g, A, 1000000);
  g.acheteSkin(A, 'andy');
  const p = g._p(A);
  p.balance = ethers.BigNumber.from(0);   // plus rien d autre qui la retiendrait
  p.hasDeposited = false;
  eq(Game.estVide(p), false, 'un skin possede suffit a garder la fiche');
}

// ================== 15. LE SKIN SURVIT AU REDEMARRAGE
{
  const g = new Game();
  pose(g, A, 1000000);
  g.acheteSkin(A, 'andy');
  g.acheteSkin(A, 'pepe');
  g.choisitSkin(A, 'pepe');

  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  const p2 = g2._p(A);
  ok(p2.skins.andy, 'andy toujours possede apres redemarrage');
  ok(p2.skins.pepe, 'pepe toujours possede apres redemarrage');
  eq(p2.skinActif, 'pepe', 'et le skin porte a traverse le redemarrage');
}

// ================== 16. LES SIX SKINS SONT ACHETABLES DE BOUT EN BOUT
{
  const g = new Game();
  pose(g, A, 100000000);
  let depense = 0;
  S.catalogue().forEach((s) => {
    const avant = sol(g, A);
    const r = g.acheteSkin(A, s.id);
    depense += avant - sol(g, A);
    eq(r.prix, s.prix, `${s.id} : le prix debite correspond au catalogue`);
  });
  eq(g._p(A).skinActif, S.catalogue()[S.catalogue().length - 1].id,
     'le dernier achete est celui qu on porte');
  eq(Object.keys(g._p(A).skins).length, 6, 'les six sont possedes');
  ok(depense > 0, 'et l ensemble a bien coute quelque chose');
}

// ================== 17. LE CADEAU PIXEL EST DECLARE, PAS SUPPOSE
{
  const c = S.catalogue();
  ok(c.every((s) => typeof s.pixel === 'boolean'), 'chaque skin dit s il a un cadeau pixel');
  ok(c.every((s) => s.pixel === S.CADEAU_PIXEL.has(s.id)),
     'le champ suit exactement le registre — pas de skin qui pretend en avoir un sans y etre');
}

console.log(`skins.test.js : ${n} verifications OK`);
