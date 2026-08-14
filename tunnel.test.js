'use strict';
/*
 * Le tunnel de conversion, et le prix du classement.
 *
 * ---- le tunnel ----
 *
 * Savoir ce qu'on gagne ne dit pas OU CA COINCE. Quatre chiffres par jour y
 * repondent — pages ouvertes, portefeuilles branches, depots, premieres mises
 * — et les trois passages entre eux designent le probleme : le trafic, la
 * friction du portefeuille, ou le premier depot.
 *
 * ---- le prix ----
 *
 * Une PART du revenu du mois, jamais un montant fixe. C'est ce qui rend
 * impossible de distribuer de l'argent qu'on n'a pas gagne : un mois creux
 * paie peu, un mois vide ne paie rien. Et un prix ne se verse qu'UNE FOIS —
 * le verser deux fois serait de l'argent cree, et personne ne s'en
 * plaindrait assez vite pour qu'on le remarque.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-tunnel-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, m) => { ok(Math.abs(a - b) <= 1e-6, `${m} (${a} ≈ ${b})`); };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const adr = (i) => '0x' + i.toString(16).padStart(40, '0');

// ================================================== le tunnel
{
  const g = new Game();
  /* Dix visiteurs ouvrent une page ; quatre branchent un portefeuille ; deux
     deposent ; un seul finit par miser. */
  for (let i = 0; i < 10; i++) g.noteTunnel('pages');
  for (let i = 1; i <= 4; i++) g.noteTunnel('connexions', adr(i));
  for (let i = 1; i <= 2; i++) {
    g.creditDeposit({ player: adr(i), amount: WEI(20000), tx: '0xt' + i });
  }
  const p = g._p(adr(1)); p.addr = adr(1);
  g._markWager(p, WEI(100));

  const j = g.tunnelJours(1)[0];
  eq(j.pages, 10, 'dix pages ouvertes');
  eq(j.connexions, 4, 'quatre portefeuilles branches');
  eq(j.deposants, 2, 'deux deposants');
  eq(j.premieresMises, 1, 'une premiere mise');
  eq(j.tauxConnexion, 40, 'taux de connexion : 40 %');
  eq(j.tauxDepot, 50, 'taux de depot : 50 %');
  eq(j.tauxPremiereMise, 50, 'et taux de premiere mise : 50 %');
  pres(j.depose, 40000, 'avec le montant depose du jour');

  /* Le meme visiteur qui recharge la page dix fois ne fait pas dix
     connexions : sans cette regle, le tunnel dirait n'importe quoi des le
     premier joueur fidele. */
  for (let i = 0; i < 10; i++) g.noteTunnel('connexions', adr(1));
  eq(g.tunnelJours(1)[0].connexions, 4, 'une adresse ne compte qu UNE FOIS par jour');

  /* La deuxieme mise d'un joueur n'est pas une premiere mise. */
  g._markWager(p, WEI(100));
  eq(g.tunnelJours(1)[0].premieresMises, 1, 'et une premiere mise ne se compte qu une fois dans sa vie');

  /* Les adresses vues du jour ne doivent PAS finir dans le fichier : ce serait
     refaire le poids qu'on vient d'en retirer. */
  const ecrit = JSON.stringify(g.serialize());
  ok(!ecrit.includes('_vus'), 'les adresses vues du jour restent en memoire, hors du fichier');
  const g2 = new Game(); g2.hydrate(JSON.parse(ecrit));
  eq(g2.tunnelJours(1)[0].pages, 10, 'mais les compteurs, eux, survivent au redemarrage');
}

// ================================================== le prix du classement
{
  const g = new Game();
  for (let i = 1; i <= 15; i++) {
    const a = adr(i); const p = g._p(a);
    p.balance = WEI(1000000); p.hasDeposited = true;
    /* Chacun mise plus que le precedent, et rend 97 % : la maison garde 3 %,
       comme dans la vraie vie. */
    g._manche(p, 'plinko', i * 10000, i * 9700);
  }
  const revenu = g.comptes().revenu;
  const p = g.prixClassement();
  pres(p.cagnotte, revenu * cfg.PRIX_CLASSEMENT_BPS / 10000,
       `la cagnotte vaut ${cfg.PRIX_CLASSEMENT_BPS / 100} % du revenu du mois, ni plus ni moins`);
  ok(p.cagnotte < revenu, 'ELLE NE PEUT PAS DEPASSER CE QUE LE MOIS A RAPPORTE');

  eq(p.gagnants.length, cfg.PRIX_PARTS.length, 'les dix places ont un prix');
  eq(p.gagnants[0].address, adr(15), 'le plus gros volume est premier');
  ok(p.gagnants[0].prix > p.gagnants[1].prix, 'et gagne plus que le deuxieme');
  ok(p.gagnants[0].prix > p.gagnants[9].prix * 5,
     'la repartition decroit vite — un partage plat ne fait courir personne');
  pres(p.gagnants.reduce((s, x) => s + x.prix, 0), p.cagnotte,
       'et la somme des prix vaut EXACTEMENT la cagnotte : rien ne se perd en route');

  // ---- le versement
  const avant = Number(g.balanceStr(adr(15)));
  const r = g.verseClassement();
  pres(Number(g.balanceStr(adr(15))) - avant, p.gagnants[0].prix, 'le premier est credite de son prix');
  pres(r.total, p.cagnotte, 'le total verse vaut la cagnotte');

  /* UNE SEULE FOIS. Verser deux fois serait de l'argent cree, et cela
     passerait inapercu longtemps. */
  jete(() => g.verseClassement(), /already paid/, 'un prix deja verse ne se verse pas deux fois');
  const g2 = new Game(); g2.hydrate(g.serialize());
  jete(() => g2.verseClassement(), /already paid/, 'y compris apres un redemarrage');

  /* Et le prix est compte comme une DEPENSE : sans ca, le mois paraitrait
     plus rentable qu'il ne l'est. */
  ok(g.comptes().bonus >= p.cagnotte, 'la cagnotte pese dans les couts du mois');
}

// -------------------------------- un mois sans revenu ne paie rien
{
  const g = new Game();
  const a = adr(1); const p = g._p(a);
  p.balance = WEI(100000); p.hasDeposited = true;
  g._manche(p, 'plinko', 1000, 3000);        // le joueur a GAGNE : revenu negatif
  ok(g.comptes().revenu < 0, 'le mois est en perte');
  eq(g.cagnotte(), 0, 'la cagnotte vaut zero — on ne distribue pas ce qu on n a pas');
  jete(() => g.verseClassement(), /nothing to share/, 'et il n y a rien a verser');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`tunnel.test.js : ${n} verifications OK`);
});
