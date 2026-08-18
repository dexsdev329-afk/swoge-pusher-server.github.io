'use strict';
/*
 * LES SKINS DE PERSONNAGE.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. RIEN A VOIR AVEC LES SAISONS. Le catalogue ne prend aucun parametre de
 *    saison, il ne verifie aucune ligne, et il ne se ferme jamais.
 * 2. LE PRIX SUIT LA PUISSANCE. Cinq skins, cinq prix, une progression
 *    stricte — pas cinq nombres tapes au hasard.
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

// ================== 1. LE CATALOGUE — CINQ SKINS, RIEN DE SAISONNIER
{
  const c = S.catalogue();
  eq(c.length, 5, 'cinq skins');
  eq(new Set(c.map((s) => s.id)).size, 5, 'cinq identifiants distincts');
  ok(c.every((s) => !('saison' in s)), 'aucun skin ne porte de saison');
  ok(c.every((s) => s.prix > 0), 'chaque skin a un prix');
  ok(c.every((s) => s.puissance >= 1 && s.puissance <= 5), 'puissance entre 1 et 5');
  eq(new Set(c.map((s) => s.puissance)).size, 5, 'cinq puissances distinctes — un classement, pas des ex-aequo');
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

// ================== 7. PAS D'ARGENT, PAS DE SKIN
{
  const g = new Game();
  const p = pose(g, A, 100);        // bien moins que le moins cher (andy, 15 000)
  assert.throws(() => g.acheteSkin(A, 'andy'), /not enough/, 'refuse sans assez de solde');
  n++;
  eq(sol(g, A), 100, 'le solde n a pas bouge');
  eq(Object.keys(p.skins || {}).length, 0, 'et rien n a ete accorde');
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
  eq(avant.actif, null, 'rien de porte au debut');
  ok(avant.catalogue.every((s) => !s.possede), 'rien de possede au debut');

  g.acheteSkin(A, 'landwolf');
  const apres = g.skinsEtat(A);
  eq(apres.actif, 'landwolf');
  const l = apres.catalogue.find((s) => s.id === 'landwolf');
  ok(l.possede, 'landwolf marque possede');
  eq(apres.catalogue.filter((s) => s.possede).length, 1, 'et lui seul');
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

// ================== 16. LES CINQ SKINS SONT ACHETABLES DE BOUT EN BOUT
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
  eq(Object.keys(g._p(A).skins).length, 5, 'les cinq sont possedes');
  ok(depense > 0, 'et l ensemble a bien coute quelque chose');
}

console.log(`skins.test.js : ${n} verifications OK`);
